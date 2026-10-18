"""Per-snapshot numbers: spread, depth, and what each trade size would cost.

Everything the report and the course show is computed here, once per stored
snapshot, then cached in the database (Coinbase books have thousands of
levels, and re-simulating every size on every tick is the slow part).

Two yardsticks, kept side by side (PLAN section 1.5):

- **impact vs own mid**: what v1 measured. Fair *within* one venue, but a
  venue whose mid is off (Phoenix's mid sat 7% below the exchanges' on
  2026-10-18, because one side of its book was nearly empty) looks cheap.
- **cost vs the reference mid**: the tick's ``ref_mid``, the mean of the
  Kraken and Coinbase mids. The same number for every venue at that moment,
  so venues that disagree on price, and AMM routes that have no mid at all,
  compare fairly::

      buy:  cost_bps = (avg_price - ref) / ref * 10_000
      sell: cost_bps = (ref - avg_price) / ref * 10_000

  Positive = worse than the reference. Negative is possible: a venue whose
  price sits below the reference sells you SOL cheaply.

And one more, robust to the price moving while we measure:

- **half round-trip cost**: buy $X and sell $X, and take half the gap
  between the two average prices, over ``ref``. Algebraically this is the
  mean of the buy and sell costs, and the reference *level* cancels out
  (only its scale remains), so if SOL drifts 5 bps during the minute the
  Jupiter grid takes, the buy cost rises and the sell cost falls by the same
  amount and the round trip barely moves.

Fees are never mixed in silently: every trade row has ``cost_bps``,
``fee_bps`` and ``all_in_bps = cost_bps + fee_bps``.

Where the 10% price protection band sits matters just as much. v1 centred
it on the book's own mid. That breaks when the mid itself is junk: on
2026-10-18 Phoenix's best bid was ~$89 and best ask ~$104.35 while the market
was ~$103.7, so its own mid was ~$96.7 and a band of +/-10% around it let a
"protected" sell fill at $89, 14% below the market. So every trade is
simulated twice:

- **band on the reference mid** (the headline numbers: ``filled_usd``,
  ``avg_price``, ``cost_bps``...): the order refuses anything more than 10%
  from the market price, which is what a real trader's limit would do;
- **band on the venue's own mid** (``own_band_*`` fields): v1's behaviour,
  kept as a secondary column so the two can be compared.

For the exchanges the two are nearly identical (their mid *is* the market);
for Phoenix they can differ completely.
"""

from __future__ import annotations

import json
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass, field
from typing import TypedDict

from .fees import taker_fee_bps
from .impact import DEFAULT_MAX_SLIPPAGE, DEFAULT_SIZES_USD, simulate
from .snapshot import BookSnapshot, RestingOrder
from .store import Run, Store

# Bump whenever a formula or a field below changes meaning: cached rows with an
# older version are then ignored and recomputed, instead of silently mixing.
METRICS_VERSION = 2  # 2: protection band anchored on the reference mid (own-mid kept too)
DEPTH_BANDS = (0.005, 0.01, 0.02)  # 0.5%, 1%, 2% of mid
# Jupiter's ways of saying "no pool can fill this": not an outage, a liquidity fact.
NO_ROUTE_MARKERS = ("NO_ROUTES_FOUND", "COULD_NOT_FIND_ANY_ROUTE")


def series_name(dex: str) -> str:
    """How a Jupiter route filter is named next to the order book venues."""
    return f"jupiter:{dex}"


def band_key(band: float) -> str:
    """``0.02 -> "0.02"``: JSON object keys must be strings (same keys as export v2)."""
    return f"{band:g}"


def size_key(usd: float) -> str:
    """``10000.0 -> "10000"``, ``1e6 -> "1000000"`` (not ``"1e+06"``, which is what :g gives)."""
    return str(int(usd)) if float(usd).is_integer() else repr(float(usd))


# ---- the formulas -------------------------------------------------------------------


def cost_bps(side: str, avg_price: float, ref: float) -> float:
    """Cost of a fill at ``avg_price`` against ``ref``, signed so that positive = worse."""
    if side == "buy":
        return (avg_price - ref) / ref * 10_000  # paid more than the fair price
    if side == "sell":
        return (ref - avg_price) / ref * 10_000  # received less than the fair price
    raise ValueError(f"side must be 'buy' or 'sell', got {side!r}")


def _cost_or_none(side: str, avg_price: float | None, ref: float | None) -> float | None:
    """``cost_bps``, or None when nothing filled or there is no reference mid."""
    return cost_bps(side, avg_price, ref) if avg_price and ref else None


def half_round_trip_bps(buy_avg: float, sell_avg: float, ref: float) -> float:
    """Half the buy/sell gap, in bps of ``ref``: ``(buy - sell) / 2 / ref * 1e4``.

    Equal to the mean of the buy and sell ``cost_bps``; ``ref`` itself cancels,
    which is what makes it robust to price drift between the two quotes.
    """
    return (buy_avg - sell_avg) / 2 / ref * 10_000


def depth_around(
    snapshot: BookSnapshot, center: float, bands: Iterable[float] = DEPTH_BANDS
) -> dict[str, list[float]]:
    """USD resting within each band of ``center``: ``{"0.02": [bid_usd, ask_usd], ...}``.

    The same rule as ``amm.depth_within`` (bounds inclusive), but around any
    price, so we can measure depth near the reference mid as well as near the
    venue's own mid, and every band in one pass over the book.
    """
    bands = tuple(bands)

    def usd_levels(orders: list[RestingOrder]) -> list[tuple[float, float]]:
        # (price, USD) per order, converted once: Coinbase has thousands of levels.
        out = []
        for o in orders:
            price = snapshot.price(o.price_ticks)
            out.append((price, price * snapshot.size(o.size_lots)))
        return out

    bids, asks = usd_levels(snapshot.bids), usd_levels(snapshot.asks)
    depth = {}
    for band in bands:
        bid = sum(usd for price, usd in bids if price >= center * (1 - band))
        ask = sum(usd for price, usd in asks if price <= center * (1 + band))
        depth[band_key(band)] = [bid, ask]
    return depth


def size_at_best(snapshot: BookSnapshot, orders: list[RestingOrder]) -> float:
    """SOL resting at the best price of one side (Phoenix lists orders, not levels)."""
    if not orders:
        return 0.0
    best = orders[0].price_ticks
    return snapshot.size(sum(o.size_lots for o in orders if o.price_ticks == best))


# ---- order book snapshots -----------------------------------------------------------


class Trade(TypedDict):
    """One simulated market order on one snapshot.

    The unprefixed fields use the protection band centred on the reference mid
    (``band_anchor == "ref"``; "own" only when the tick has no reference mid).
    The ``own_band_*`` fields repeat the order with v1's band, centred on the
    venue's own mid.
    """

    side: str  # "buy" or "sell" (SOL)
    usd: float  # size we asked for
    band_anchor: str  # "ref" or "own": where the 10% protection band was centred
    filled_usd: float  # what the book could absorb inside price protection
    fully_filled: bool
    levels_swept: int  # distinct prices touched
    avg_price: float | None
    impact_bps: float | None  # vs the venue's own mid (v1's number; includes half-spread)
    cost_bps: float | None  # vs the tick's reference mid
    fee_bps: float  # taker fee (base tier)
    all_in_bps: float | None  # cost_bps + fee_bps
    own_band_filled_usd: float  # the same order, band centred on the venue's own mid
    own_band_fully_filled: bool
    own_band_avg_price: float | None
    own_band_impact_bps: float | None
    own_band_cost_bps: float | None


class BookMetrics(TypedDict):
    """Everything we measure on one stored order book snapshot."""

    snapshot_id: int
    tick_id: int
    tick_ts: float  # the aligned 5-minute slot, so venues line up
    venue: str
    mid: float | None
    ref_mid: float | None
    mid_vs_ref_bps: float | None  # (mid - ref) / ref: how far this venue's price is off
    spread_bps: float | None
    best_bid: float | None
    best_ask: float | None
    best_bid_sol: float  # size at the best bid (shows when one order holds the top)
    best_ask_sol: float
    n_bids: int  # orders (Phoenix) or levels (exchanges) in the stored book
    n_asks: int
    fee_bps: float
    depth_usd: dict[str, list[float]]  # around own mid: {"0.02": [bid, ask]}
    depth_ref_usd: dict[str, list[float]]  # around the reference mid
    trades: list[Trade]
    round_trip_bps: dict[str, float | None]  # {"10000": half round trip vs ref}
    sequence_number: int | None  # Phoenix market_sequence_number; None elsewhere
    params: dict  # sizes and protection used, so a cache with other settings is not reused


def book_metrics(
    snapshot: BookSnapshot,
    ref_mid: float | None,
    *,
    snapshot_id: int = 0,
    tick_id: int = 0,
    tick_ts: float | None = None,
    sizes_usd: Iterable[float] = DEFAULT_SIZES_USD,
    max_slippage: float = DEFAULT_MAX_SLIPPAGE,
) -> BookMetrics:
    """Measure one snapshot. ``ref_mid`` may be None (both exchanges down): then the
    reference-based numbers are None and the own-mid ones are still there."""
    sizes = [float(s) for s in sizes_usd]
    mid = snapshot.mid_price()
    fee = taker_fee_bps(snapshot.venue, snapshot)
    seq = snapshot.meta.get("market_sequence_number")

    trades: list[Trade] = []
    round_trip: dict[str, float | None] = {}
    if mid is not None:  # a one-sided book has no mid: nothing to simulate against
        for usd in sizes:
            by_side = {}
            for side in ("buy", "sell"):
                # Headline: refuse fills more than max_slippage from the *market* price.
                r = simulate(snapshot, side, usd, max_slippage, anchor=ref_mid)
                # Secondary: v1's band around the venue's own mid (junk when the mid is).
                own = simulate(snapshot, side, usd, max_slippage) if ref_mid else r
                cost = _cost_or_none(side, r.avg_price, ref_mid)
                trades.append(
                    Trade(
                        side=side,
                        usd=usd,
                        band_anchor="ref" if ref_mid else "own",
                        filled_usd=r.filled_usd,
                        fully_filled=r.fully_filled,
                        levels_swept=r.levels_swept,
                        avg_price=r.avg_price,
                        impact_bps=r.impact_bps,
                        cost_bps=cost,
                        fee_bps=fee,
                        all_in_bps=cost + fee if cost is not None else None,
                        own_band_filled_usd=own.filled_usd,
                        own_band_fully_filled=own.fully_filled,
                        own_band_avg_price=own.avg_price,
                        own_band_impact_bps=own.impact_bps,
                        own_band_cost_bps=_cost_or_none(side, own.avg_price, ref_mid),
                    )
                )
                by_side[side] = r
            buy, sell = by_side["buy"], by_side["sell"]
            # Only a size that fills both ways has a round trip; a partial fill would
            # understate it (the book "ran out", it didn't get cheaper).
            if buy.fully_filled and sell.fully_filled and buy.avg_price and sell.avg_price:
                scale = ref_mid or mid  # ref cancels anyway; it only sets the bps scale
                round_trip[size_key(usd)] = half_round_trip_bps(
                    buy.avg_price, sell.avg_price, scale
                )
            else:
                round_trip[size_key(usd)] = None

    bid, ask = snapshot.best_bid(), snapshot.best_ask()
    return BookMetrics(
        snapshot_id=snapshot_id,
        tick_id=tick_id,
        tick_ts=snapshot.fetched_at if tick_ts is None else tick_ts,
        venue=snapshot.venue,
        mid=mid,
        ref_mid=ref_mid,
        mid_vs_ref_bps=(mid - ref_mid) / ref_mid * 10_000 if mid and ref_mid else None,
        spread_bps=snapshot.spread_bps(),
        best_bid=snapshot.price(bid) if bid is not None else None,
        best_ask=snapshot.price(ask) if ask is not None else None,
        best_bid_sol=size_at_best(snapshot, snapshot.bids),
        best_ask_sol=size_at_best(snapshot, snapshot.asks),
        n_bids=len(snapshot.bids),
        n_asks=len(snapshot.asks),
        fee_bps=fee,
        depth_usd=depth_around(snapshot, mid) if mid else {},
        depth_ref_usd=depth_around(snapshot, ref_mid) if ref_mid else {},
        trades=trades,
        round_trip_bps=round_trip,
        sequence_number=int(seq) if seq is not None else None,
        params={"sizes_usd": sizes, "max_slippage": max_slippage},
    )


# ---- Jupiter quotes -------------------------------------------------------------------


class QuoteMetrics(TypedDict):
    """One Jupiter quote (ok or not), measured against the tick's reference mid."""

    tick_id: int
    tick_ts: float
    series: str  # "jupiter:<dex>"
    dex: str
    side: str
    usd: float
    ok: bool
    no_route: bool  # Jupiter found no pool that could fill this size
    error: str | None
    latency_ms: float | None
    avg_price: float | None
    ref_mid: float | None
    cost_bps: float | None
    fee_bps: float  # 0: AMM fees are already inside the quoted price
    all_in_bps: float | None
    route: list[str]  # pool labels the route goes through, in order
    context_slot: int | None


def is_no_route(error: str | None) -> bool:
    return bool(error) and any(m in error for m in NO_ROUTE_MARKERS)


def quote_metrics(row: Mapping) -> QuoteMetrics:
    """Measure one row of ``Store.quotes`` (which already joins the tick's ``ref_mid``)."""
    ref, avg = row["ref_mid"], row["avg_price"]
    ok = bool(row["ok"]) and avg is not None
    cost = cost_bps(row["side"], avg, ref) if ok and ref else None
    fee = taker_fee_bps("jupiter")
    labels: list[str] = []
    for step in json.loads(row["route_json"]) if row["route_json"] else []:
        label = step.get("label") or "?"
        if label not in labels:  # a route can pass through one pool type twice
            labels.append(label)
    return QuoteMetrics(
        tick_id=row["tick_id"],
        tick_ts=row["tick_ts"],
        series=series_name(row["dex"]),
        dex=row["dex"],
        side=row["side"],
        usd=float(row["usd_size"]),
        ok=ok,
        no_route=is_no_route(row["error"]),
        error=row["error"],
        latency_ms=row["latency_ms"],
        avg_price=avg,
        ref_mid=ref,
        cost_bps=cost,
        fee_bps=fee,
        all_in_bps=cost + fee if cost is not None else None,
        route=labels,
        context_slot=row["context_slot"],
    )


# ---- one yardstick for everyone --------------------------------------------------------


class RoundTrip(TypedDict):
    tick_ts: float
    series: str  # "phoenix", "kraken", ..., or "jupiter:<dex>"
    usd: float
    bps: float  # half round-trip cost vs the reference mid


def book_round_trips(books: Iterable[BookMetrics]) -> list[RoundTrip]:
    out = []
    for b in books:
        for usd, bps in b["round_trip_bps"].items():
            if bps is not None:
                out.append(
                    RoundTrip(tick_ts=b["tick_ts"], series=b["venue"], usd=float(usd), bps=bps)
                )
    return out


def quote_round_trips(quotes: Iterable[QuoteMetrics]) -> list[RoundTrip]:
    """Pair each (tick, dex, size)'s buy and sell quote; both must have succeeded."""
    pairs: dict[tuple[int, str, float], dict[str, QuoteMetrics]] = {}
    for q in quotes:
        if q["ok"]:
            pairs.setdefault((q["tick_id"], q["dex"], q["usd"]), {})[q["side"]] = q
    out = []
    for (_, dex, usd), sides in pairs.items():
        buy, sell = sides.get("buy"), sides.get("sell")
        if buy is None or sell is None or not buy["ref_mid"]:
            continue
        bps = half_round_trip_bps(buy["avg_price"], sell["avg_price"], buy["ref_mid"])
        out.append(RoundTrip(tick_ts=buy["tick_ts"], series=series_name(dex), usd=usd, bps=bps))
    return out


# ---- loading a whole database -----------------------------------------------------------


class Fetch(TypedDict):
    """One request the collector made, successful or not: the raw material of uptime."""

    tick_ts: float
    source: str  # venue, "jupiter:<dex>", or "solana-rpc" (getSlot)
    ok: bool
    no_route: bool
    latency_ms: float | None
    error: str | None


class TickInfo(TypedDict):
    tick_id: int
    tick_ts: float
    ref_mid: float | None
    slot: int | None


@dataclass(slots=True)
class Dataset:
    """Everything measured from one database, ready for ``timeseries`` and ``report``."""

    runs: list[Run]
    interval_s: float
    ticks: list[TickInfo]
    books: list[BookMetrics] = field(default_factory=list)
    quotes: list[QuoteMetrics] = field(default_factory=list)
    round_trips: list[RoundTrip] = field(default_factory=list)
    fetches: list[Fetch] = field(default_factory=list)

    @property
    def venues(self) -> list[str]:
        """Order book venues present, in a stable order (registry order first)."""
        from .venues import VENUES

        seen = {b["venue"] for b in self.books} | {
            f["source"] for f in self.fetches if ":" not in f["source"]
        }
        seen.discard("solana-rpc")
        return [v for v in VENUES if v in seen] + sorted(seen - set(VENUES))

    @property
    def dexes(self) -> list[str]:
        """Jupiter route filters present, in the collector's order."""
        from .jupiter import DEX_FILTERS

        seen = {q["dex"] for q in self.quotes}
        return [d for d in DEX_FILTERS if d in seen] + sorted(seen - set(DEX_FILTERS))


def load_dataset(
    store: Store,
    run_id: int | None = None,
    sizes_usd: Iterable[float] = DEFAULT_SIZES_USD,
    max_slippage: float = DEFAULT_MAX_SLIPPAGE,
    use_cache: bool = True,
    progress: Callable[[int, int], None] | None = None,
) -> Dataset:
    """Measure every snapshot and quote in ``store`` (one run, or all runs if None).

    Book metrics are read from the ``metrics`` cache when a row with this
    ``METRICS_VERSION`` and the same parameters exists, and computed (then
    cached) otherwise. ``progress(done, total)`` is called after each snapshot.
    """
    sizes = [float(s) for s in sizes_usd]
    params = {"sizes_usd": sizes, "max_slippage": max_slippage}
    runs = [r for r in store.runs() if run_id is None or r.run_id == run_id]
    tick_rows = store.ticks(run_id)
    ticks = [
        TickInfo(tick_id=t["tick_id"], tick_ts=t["tick_ts"], ref_mid=t["ref_mid"], slot=t["slot"])
        for t in tick_rows
    ]
    ref_by_tick = {t["tick_id"]: t["ref_mid"] for t in ticks}
    data = Dataset(runs=runs, interval_s=runs[-1].interval_s if runs else 300.0, ticks=ticks)

    for t in tick_rows:  # one getSlot per tick: the collector's own clock on the chain
        ok = t["slot"] is not None
        data.fetches.append(
            Fetch(
                tick_ts=t["tick_ts"],
                source="solana-rpc",
                ok=ok,
                no_route=False,
                latency_ms=t["slot_latency_ms"],
                error=None if ok else "getSlot failed",
            )
        )

    rows = list(store.snapshots(run_id=run_id, ok_only=False))
    for i, s in enumerate(rows):
        data.fetches.append(
            Fetch(
                tick_ts=s.tick_ts,
                source=s.venue,
                ok=s.ok,
                no_route=False,
                latency_ms=s.latency_ms,
                error=s.error,
            )
        )
        if s.ok:
            cached = store.cached_metrics(s.id, METRICS_VERSION) if use_cache else None
            if cached is None or cached.get("params") != params:
                cached = book_metrics(
                    s.book(),
                    ref_by_tick.get(s.tick_id),
                    snapshot_id=s.id,
                    tick_id=s.tick_id,
                    tick_ts=s.tick_ts,
                    sizes_usd=sizes,
                    max_slippage=max_slippage,
                )
                if use_cache:
                    store.cache_metrics(s.id, METRICS_VERSION, dict(cached))
            data.books.append(cached)  # type: ignore[arg-type]  # JSON round trip of BookMetrics
        if progress:
            progress(i + 1, len(rows))

    for row in store.quotes(run_id, ok_only=False):
        q = quote_metrics(row)
        data.quotes.append(q)
        data.fetches.append(
            Fetch(
                tick_ts=q["tick_ts"],
                source=q["series"],
                ok=q["ok"],
                no_route=q["no_route"],
                latency_ms=q["latency_ms"],
                error=q["error"],
            )
        )

    data.round_trips = book_round_trips(data.books) + quote_round_trips(data.quotes)
    return data
