"""More realistic execution: IOC limit orders and TWAP over successive real snapshots.

IOC limit orders
----------------
``impact.simulate`` asks "what does one market order cost on this book?". A real
taker sends an **immediate-or-cancel (IOC) limit order** instead: trade what you
can right now at the limit price or better, cancel the rest, never rest in the
book. ``simulate_ioc`` does exactly that through the engine
(``OrderBook.add_order(..., tif=TimeInForce.IOC)``), with the limit
``limit_bps`` away from mid, and reports what filled, what didn't, the average
price, the cost against mid, the taker fee and the all-in cost.

The order's size is fixed in SOL *before* it is sent (``usd / price``), the way
a trader types a quantity into an order ticket. That way "unfilled" means what
it means on an exchange: lots the IOC asked for that the book couldn't give
inside the limit.

TWAP: splitting a parent order
------------------------------
A big "parent" order of ``total_usd`` is cut into ``n`` equal child orders (equal
in SOL). Child ``i`` is an IOC sent against snapshot ``i`` of a sequence of
**successive real snapshots** of one venue from the collector database (one
every ``k`` ticks, so with 5-minute ticks and ``k = 1`` the children are 5
minutes apart). We compare that with sending the whole parent as one IOC
against snapshot 0.

Everything is measured against the **arrival price** ``P0``: the price when
the decision to trade was made, i.e. at snapshot 0. That is called
*implementation shortfall*:

    shortfall_bps = sign * (avg_fill_price - P0) / P0 * 10_000    (sign +1 buy, -1 sell)

For a TWAP it splits exactly into two parts (weights w_i = child i's share of
the SOL filled, P_i = the price at child i's snapshot):

    shortfall = drift paid + impact
    drift paid = sum_i w_i * sign * (P_i - P0) / P0       what the market did meanwhile
    impact     = sum_i w_i * sign * (avg_i - P_i) / P0    what our own orders did

The one-shot order has no drift (it trades at snapshot 0), so splitting can only
help if the impact it saves is bigger than the drift it pays. Over an hour the
price usually moves more than a $1M order moves a deep exchange book, so on
deep books the drift term decides the answer, and it is a coin flip: drift is
as likely to help a buyer as hurt one. That is why the summary looks at
distributions over every start time in a run (rolling windows), not one
example, and why its conclusions pool buys and sells: a trend that hurts every
buy TWAP helps every sell TWAP, and says nothing about splitting itself.

``P0`` is the venue's own mid by default (``benchmark="own"``). With
``benchmark="ref"`` it is the tick's reference mid (mean of the Kraken and
Coinbase mids), the project's common yardstick. Use "ref" for Phoenix: when its
book is nearly empty its own mid can be dollars away from the market.

The resilience model (and its limits)
-------------------------------------
Successive snapshots are other people's books: we never really traded, so
snapshot ``i + 1`` cannot show the hole our child ``i`` would have left. We
have to *assume* how much of it would have come back. ``resilience`` in [0, 1]
is the fraction of the liquidity our earlier children consumed that has come
back by the time the next child trades:

- ``resilience = 1``: everything came back. Each snapshot is used as it is,
  as if makers refilled the book completely between children. This is the
  optimistic assumption you make by treating snapshots as independent.
- ``resilience = 0``: nothing came back. Before child ``i`` we remove all the
  lots children ``0 .. i-1`` filled from the best levels of the same side of
  snapshot ``i``. On identical snapshots this reproduces the one-shot order
  exactly, which is the best sanity check of the whole module.
- in between, we remove ``round((1 - resilience) * lots consumed so far)``.

What the model does **not** capture, in plain words:

- Resilience is an input, not something the data measures. The closest real
  evidence is ``book_unchanged_share``: how much of the liquidity near the
  touch is still at the same price, same size, in the next snapshot. A book
  that never changes (nobody requoting) gives no reason to expect refill.
- Refill comes back at the same prices it left. Real makers requote around a
  price that our buying may have pushed up (*permanent impact*); here the mid
  only moves with the real market, never because of us.
- Only the side we trade against is depleted; the other side and other traders
  don't react to us (no front-running, no information leakage).
- ``resilience`` is per child interval and doesn't decay with time: the same
  value means the same refill whether children are 5 or 50 minutes apart.
- A child that can't fill inside its limit is simply short (IOC); the cost is
  measured on what filled, and the fill ratio is reported next to it. The
  opportunity cost of the unfilled part is not added in.
- Snapshots are 5 minutes apart, so the shortest TWAP we can test lasts
  ``(n - 1) * 5`` minutes. Real algorithms slice in seconds.

Fees
----
Each child pays the venue's taker fee (``fees.taker_fee_bps``) on its own
notional. Splitting doesn't make fees smaller: n children of 1/n the size pay
n times 1/n of the fee, the same bps of the same total notional. Only maker
orders (resting, not IOC) or a higher volume tier lower the fee.
"""

from __future__ import annotations

import argparse
import math
import sys
from collections.abc import Callable, Sequence
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from typing import Literal

from .convert import load_book
from .fees import taker_fee_bps
from .impact import protection_limit
from .orderbook import Side, TimeInForce
from .snapshot import BookSnapshot, RestingOrder
from .store import Store

DEFAULT_LIMIT_BPS = 1_000.0  # 10% from mid: the same price protection impact.py uses
DEFAULT_SUMMARY_SIZES_USD = (100_000.0, 1_000_000.0)
Benchmark = Literal["own", "ref"]


# ---- small helpers ---------------------------------------------------------------


def _taker(side: str) -> Side:
    """``"buy"`` lifts asks (we are a bid), ``"sell"`` hits bids (we are an ask)."""
    if side == "buy":
        return Side.BID
    if side == "sell":
        return Side.ASK
    raise ValueError(f"side must be 'buy' or 'sell', got {side!r}")


def _sign(side: str) -> int:
    """+1 for a buy, -1 for a sell, so a positive number is always a *cost* to us."""
    return 1 if _taker(side) is Side.BID else -1


def cost_bps(side: str, price: float, reference: float) -> float:
    """How much worse ``price`` is than ``reference`` for this side, in bps of ``reference``."""
    return _sign(side) * (price - reference) / reference * 10_000


def _beyond_limit(taker: Side, price_ticks: int, limit_ticks: int) -> bool:
    """True if a level is worse than the limit: above it for a buy, below it for a sell."""
    return price_ticks > limit_ticks if taker is Side.BID else price_ticks < limit_ticks


def _reachable(
    levels: Sequence[RestingOrder],
    taker: Side,
    limit_ticks: int,
    lots: int,
    removed_lots: int,
) -> list[RestingOrder]:
    """The part of one side of the book an IOC of ``lots`` can touch.

    First ``removed_lots`` are taken off the best levels (the resilience model:
    liquidity earlier children consumed that has not come back). Then levels are
    kept, best first, until they hold ``lots`` or the limit price is passed.
    Loading only these into the engine gives exactly the same fills as loading
    the whole book (the engine never looks further), and keeps a summary over
    hundreds of windows fast: Coinbase publishes thousands of levels.
    """
    out: list[RestingOrder] = []
    to_remove = removed_lots
    have = 0
    for o in levels:
        if _beyond_limit(taker, o.price_ticks, limit_ticks):
            break  # no IOC with this limit can trade here, depleted or not
        size = o.size_lots
        if to_remove > 0:
            taken = min(to_remove, size)
            to_remove -= taken
            size -= taken
            if size == 0:
                continue  # this order is gone entirely: we took it earlier
        out.append(o if size == o.size_lots else RestingOrder(o.price_ticks, size))
        have += size
        if have >= lots:
            break
    return out


# ---- one IOC order ----------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class IocResult:
    """What one IOC limit order did. Sizes in lots are exact; USD/SOL are for display."""

    venue: str
    side: str  # "buy" or "sell"
    reference_price: float  # costs are measured against this (mid, or a TWAP's arrival)
    limit_price: float  # USD; the IOC trades at this price or better, never worse
    requested_lots: int
    filled_lots: int
    requested_base: float  # SOL asked for
    filled_base: float  # SOL traded
    filled_usd: float  # USD notional traded
    levels_swept: int
    fee_bps: float  # taker fee rate charged on filled_usd
    removed_lots: int = 0  # liquidity missing from the best levels (resilience model)
    removed_base: float = 0.0  # the same, in SOL

    @property
    def avg_price(self) -> float | None:
        return self.filled_usd / self.filled_base if self.filled_base else None

    @property
    def unfilled_base(self) -> float:
        """SOL the IOC asked for but did not get: cancelled, never rested."""
        return self.requested_base - self.filled_base

    @property
    def fully_filled(self) -> bool:
        return self.filled_lots == self.requested_lots

    @property
    def fill_ratio(self) -> float:
        return self.filled_lots / self.requested_lots if self.requested_lots else 0.0

    @property
    def cost_bps(self) -> float | None:
        """Average fill vs ``reference_price``, as a cost. None if nothing filled."""
        avg = self.avg_price
        return None if avg is None else cost_bps(self.side, avg, self.reference_price)

    @property
    def fee_usd(self) -> float:
        return self.filled_usd * self.fee_bps / 10_000

    @property
    def all_in_bps(self) -> float | None:
        cost = self.cost_bps
        return None if cost is None else cost + self.fee_bps


def execute_ioc(
    snapshot: BookSnapshot,
    side: str,
    lots: int,
    limit_bps: float = DEFAULT_LIMIT_BPS,
    reference_price: float | None = None,
    removed_lots: int = 0,
) -> IocResult:
    """Send one IOC of ``lots`` against ``snapshot``, limit ``limit_bps`` from a price.

    The building block of both ``simulate_ioc`` and ``twap``. ``removed_lots``
    is liquidity taken off the best levels first (see the resilience model).
    The limit is centred on ``reference_price`` (default: the snapshot's own mid),
    fixed *before* that removal: it is price protection against junk quotes, set
    from the market we saw, and keeping it fixed is what makes resilience=0 on
    identical snapshots equal one order. Pass the reference mid for a lopsided
    book like Phoenix's, whose own mid can sit far from the market.
    """
    taker = _taker(side)
    if lots < 0 or removed_lots < 0:
        raise ValueError("lots and removed_lots must be non-negative")
    mid = snapshot.mid_price()
    if mid is None:
        raise ValueError(f"{snapshot.venue}: one-sided book, no mid to set a limit from")
    reference = mid if reference_price is None else reference_price
    limit_ticks = protection_limit(snapshot, taker, reference, limit_bps / 10_000)

    levels = snapshot.asks if taker is Side.BID else snapshot.bids
    reachable = _reachable(levels, taker, limit_ticks, lots, removed_lots)
    # A one-sided copy holding only what the order can reach; load_book replays it
    # into a fresh engine in the venue's own priority order.
    one_sided = replace(
        snapshot,
        bids=reachable if taker is Side.ASK else [],
        asks=reachable if taker is Side.BID else [],
    )
    book = load_book(one_sided)
    # load_book numbers makers 1..len(reachable), so this id is guaranteed unused.
    taker_id = len(reachable) + 1
    fills = book.add_order(taker_id, taker, limit_ticks, lots, tif=TimeInForce.IOC) if lots else []

    filled_lots = sum(f.size_lots for f in fills)
    return IocResult(
        venue=snapshot.venue,
        side=side,
        reference_price=reference,
        limit_price=snapshot.price(limit_ticks),
        requested_lots=lots,
        filled_lots=filled_lots,
        requested_base=snapshot.size(lots),
        filled_base=snapshot.size(filled_lots),
        filled_usd=sum(snapshot.price(f.price_ticks) * snapshot.size(f.size_lots) for f in fills),
        levels_swept=len({f.price_ticks for f in fills}),
        fee_bps=taker_fee_bps(snapshot.venue, snapshot),
        removed_lots=removed_lots,
        removed_base=snapshot.size(removed_lots),
    )


def lots_for_usd(snapshot: BookSnapshot, usd: float, price: float) -> int:
    """SOL quantity worth ``usd`` at ``price``, in whole lots (the order ticket's size)."""
    if usd <= 0 or price <= 0:
        raise ValueError("usd and price must be positive")
    return round(usd / price / float(snapshot.lot_size))


def simulate_ioc(
    snapshot: BookSnapshot, side: str, usd: float, limit_bps: float = DEFAULT_LIMIT_BPS
) -> IocResult:
    """An IOC for ``usd`` worth of SOL (at mid) with its limit ``limit_bps`` from mid.

    Example: ``simulate_ioc(book, "buy", 100_000, 20)`` buys up to $100K of SOL
    but never pays more than mid + 0.20%; whatever the book can't give inside
    that is cancelled and shows up as ``unfilled_base``.
    """
    mid = snapshot.mid_price()
    if mid is None:
        raise ValueError(f"{snapshot.venue}: one-sided book, no mid")
    return execute_ioc(snapshot, side, lots_for_usd(snapshot, usd, mid), limit_bps)


# ---- TWAP ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class Child:
    """One child order of a TWAP."""

    index: int
    at: float  # unix seconds of the snapshot it traded against
    price: float  # benchmark price at that snapshot (own or reference mid), before our footprint
    result: IocResult  # its cost_bps is this child's own impact, vs ``price``


@dataclass(frozen=True, slots=True)
class TwapResult:
    venue: str
    side: str
    total_usd: float
    resilience: float
    arrival_price: float  # P0: the benchmark price at snapshot 0
    total_lots: int  # the parent order, in lots
    one_shot: IocResult  # the whole parent as one IOC at snapshot 0 (reference = P0)
    children: tuple[Child, ...]

    # -- the TWAP as a whole --

    @property
    def n_children(self) -> int:
        return len(self.children)

    @property
    def start_ts(self) -> float:
        return self.children[0].at

    @property
    def window_s(self) -> float:
        """Time from the first child to the last."""
        return self.children[-1].at - self.children[0].at

    @property
    def filled_lots(self) -> int:
        return sum(c.result.filled_lots for c in self.children)

    @property
    def filled_base(self) -> float:
        return sum(c.result.filled_base for c in self.children)

    @property
    def filled_usd(self) -> float:
        return sum(c.result.filled_usd for c in self.children)

    @property
    def fill_ratio(self) -> float:
        return self.filled_lots / self.total_lots

    @property
    def fully_filled(self) -> bool:
        return self.filled_lots == self.total_lots

    @property
    def avg_price(self) -> float | None:
        base = self.filled_base
        return self.filled_usd / base if base else None

    @property
    def shortfall_bps(self) -> float | None:
        """Implementation shortfall: average fill vs the arrival price, as a cost."""
        avg = self.avg_price
        return None if avg is None else cost_bps(self.side, avg, self.arrival_price)

    def _weighted(self, term: Callable[[Child], float]) -> float | None:
        """Average of ``term(child)`` weighted by SOL filled; None if nothing filled."""
        base = self.filled_base
        if not base:
            return None
        return sum(c.result.filled_base * term(c) for c in self.children) / base

    @property
    def drift_paid_bps(self) -> float | None:
        """The part of the shortfall the market caused: each child's price vs P0, weighted."""
        return self._weighted(lambda c: cost_bps(self.side, c.price, self.arrival_price))

    @property
    def impact_bps(self) -> float | None:
        """The part we caused: each child's fill vs its own moment's price, in bps of P0.

        Dividing by P0 (not by the child's own price) is what makes
        ``shortfall = drift_paid + impact`` hold exactly.
        """

        def term(c: Child) -> float:
            avg = c.result.avg_price
            return 0.0 if avg is None else _sign(self.side) * (avg - c.price) / self.arrival_price

        weighted = self._weighted(term)
        return None if weighted is None else weighted * 10_000

    @property
    def window_drift_bps(self) -> float:
        """How far the price moved from the first child to the last, as a cost to this side."""
        return cost_bps(self.side, self.children[-1].price, self.arrival_price)

    @property
    def fee_usd(self) -> float:
        return sum(c.result.fee_usd for c in self.children)

    @property
    def fee_bps(self) -> float:
        """Total fee over total notional: the same rate as one order, however you split."""
        usd = self.filled_usd
        return self.fee_usd / usd * 10_000 if usd else 0.0

    @property
    def all_in_bps(self) -> float | None:
        s = self.shortfall_bps
        return None if s is None else s + self.fee_bps

    # -- comparison with the one-shot order --

    @property
    def saving_bps(self) -> float | None:
        """One-shot cost minus TWAP cost: positive means splitting was cheaper."""
        a, b = self.one_shot.cost_bps, self.shortfall_bps
        return None if a is None or b is None else a - b


def twap(
    snapshots: Sequence[BookSnapshot],
    side: str,
    total_usd: float,
    resilience: float = 1.0,
    limit_bps: float = DEFAULT_LIMIT_BPS,
    prices: Sequence[float] | None = None,
    times: Sequence[float] | None = None,
) -> TwapResult:
    """Split ``total_usd`` into ``len(snapshots)`` equal IOC children, child i on snapshot i.

    ``prices[i]`` is the benchmark price at snapshot i (default: its own mid);
    ``prices[0]`` is the arrival price everything is measured against. ``times``
    defaults to each snapshot's ``fetched_at``. See the module docstring for
    ``resilience``.
    """
    n = len(snapshots)
    if n == 0:
        raise ValueError("need at least one snapshot")
    if not 0.0 <= resilience <= 1.0:
        raise ValueError(f"resilience must be in [0, 1], got {resilience}")
    if total_usd <= 0:
        raise ValueError("total_usd must be positive")
    if prices is None:
        mids = [s.mid_price() for s in snapshots]
        if any(m is None for m in mids):
            raise ValueError("a snapshot is one-sided: pass prices explicitly")
        prices = [float(m) for m in mids if m is not None]
    if len(prices) != n or (times is not None and len(times) != n):
        raise ValueError("prices and times must have one entry per snapshot")
    times = [s.fetched_at for s in snapshots] if times is None else list(times)
    if len({s.lot_size for s in snapshots}) != 1:
        raise ValueError("snapshots disagree on lot size: not the same market")

    arrival = prices[0]
    total_lots = lots_for_usd(snapshots[0], total_usd, arrival)
    if total_lots < n:
        raise ValueError(f"${total_usd:,.0f} is fewer lots than {n} children")

    one_shot = execute_ioc(snapshots[0], side, total_lots, limit_bps, reference_price=arrival)

    # Equal children in lots; the first (total % n) get one extra lot, so the
    # children add up to exactly the parent order and compare like for like.
    base, extra = divmod(total_lots, n)
    children: list[Child] = []
    consumed = 0  # lots our earlier children actually filled
    for i, snap in enumerate(snapshots):
        child_lots = base + (1 if i < extra else 0)
        # The resilience model: of what we consumed so far, (1 - resilience) is still missing.
        removed = round((1.0 - resilience) * consumed)
        result = execute_ioc(
            snap, side, child_lots, limit_bps, reference_price=prices[i], removed_lots=removed
        )
        consumed += result.filled_lots
        children.append(Child(i, times[i], prices[i], result))

    return TwapResult(
        venue=snapshots[0].venue,
        side=side,
        total_usd=float(total_usd),
        resilience=resilience,
        arrival_price=arrival,
        total_lots=total_lots,
        one_shot=one_shot,
        children=tuple(children),
    )


# ---- reading successive snapshots from the collector DB ------------------------------


@dataclass(frozen=True, slots=True)
class Step:
    """One stored snapshot of one venue, with the tick's reference mid."""

    tick_ts: float
    snapshot: BookSnapshot
    ref_mid: float | None

    def price(self, benchmark: Benchmark) -> float | None:
        return self.snapshot.mid_price() if benchmark == "own" else self.ref_mid


@dataclass(frozen=True, slots=True)
class Series:
    """Every good snapshot of one venue in one run, in time order."""

    venue: str
    interval_s: float
    steps: list[Step]

    def windows(self, n: int, every: int = 1) -> list[list[Step]]:
        """Every run of ``n`` snapshots spaced exactly ``every`` ticks apart.

        Ticks sit on wall-clock multiples of the interval, so the tick number is
        ``tick_ts / interval``. A window is kept only if all ``n`` ticks exist:
        a failed fetch or a skipped (overrun) tick would otherwise silently
        stretch the time between two children.
        """
        if n < 1 or every < 1:
            raise ValueError("n and every must be at least 1")
        by_tick = {round(s.tick_ts / self.interval_s): s for s in self.steps}
        out = []
        for s in self.steps:
            k0 = round(s.tick_ts / self.interval_s)
            window = [by_tick.get(k0 + j * every) for j in range(n)]
            if all(w is not None for w in window):
                out.append([w for w in window if w is not None])
        return out


def _pick_run(store: Store, run_id: int | None):
    runs = store.runs()
    if not runs:
        raise ValueError(f"{store.path} has no collector runs")
    if run_id is None:
        return runs[-1]
    for r in runs:
        if r.run_id == run_id:
            return r
    raise ValueError(f"no run {run_id} in {store.path}")


def load_series(
    store: Store,
    venue: str,
    run_id: int | None = None,
    band: float | None = None,
) -> Series:
    """Decode every good snapshot of ``venue`` (newest run by default).

    ``band`` trims each book to that fraction of its mid. Pass something a bit
    wider than the IOC limit: nothing beyond the limit can fill, and trimming
    keeps hundreds of Coinbase books small in memory. The band is widened by the
    gap between the book's own mid and the reference mid, so it covers an IOC
    limit centred on either one.
    """
    run = _pick_run(store, run_id)
    ref = {t["tick_id"]: t["ref_mid"] for t in store.ticks(run.run_id)}
    steps = []
    for s in store.snapshots(venue=venue, run_id=run.run_id):
        book = s.book()
        ref_mid, mid = ref.get(s.tick_id), book.mid_price()
        if band and mid:
            gap = abs(mid - ref_mid) / mid if ref_mid else 0.0
            book = book.trimmed(band + gap)
        steps.append(Step(s.tick_ts, book, ref_mid))
    return Series(venue, run.interval_s, steps)


def run_window(
    window: Sequence[Step],
    side: str,
    total_usd: float,
    resilience: float = 1.0,
    limit_bps: float = DEFAULT_LIMIT_BPS,
    benchmark: Benchmark = "own",
) -> TwapResult:
    """One TWAP over one window of stored snapshots, priced with ``benchmark``."""
    prices = [s.price(benchmark) for s in window]
    if any(p is None for p in prices):
        raise ValueError(f"benchmark {benchmark!r} missing for a tick in this window")
    return twap(
        [s.snapshot for s in window],
        side,
        total_usd,
        resilience,
        limit_bps,
        prices=[p for p in prices if p is not None],
        times=[s.tick_ts for s in window],
    )


def not_enough_ticks(series: Series, n: int, every: int) -> str:
    """Why no window fits, in words: short runs are normal early in a collection."""
    need = (n - 1) * every + 1
    return (
        f"{series.venue} has {len(series.steps)} good snapshot(s); {n} children spaced "
        f"{every} tick(s) apart need {need} consecutive ticks."
    )


# ---- does the book refill? -------------------------------------------------------


def _levels_best_first(snapshot: BookSnapshot, taker: Side) -> dict[int, int]:
    """The side a taker consumes, aggregated by price; dicts keep best-first order."""
    agg: dict[int, int] = {}
    for o in snapshot.asks if taker is Side.BID else snapshot.bids:
        agg[o.price_ticks] = agg.get(o.price_ticks, 0) + o.size_lots
    return agg


def book_unchanged_share(a: BookSnapshot, b: BookSnapshot, side: str, usd: float) -> float | None:
    """Of the liquidity a ``usd`` order on ``side`` would take from ``a``, the share
    still sitting at the same price (up to the same size) in the later snapshot ``b``.

    1.0 means the book near the touch didn't change at all: nobody requoted
    and nobody traded there. That is evidence *against* refill, because a book
    whose makers never touch their quotes won't replace what a taker removes.
    Near 0 means the quotes were all replaced: an active book.
    """
    taker = _taker(side)
    later = _levels_best_first(b, taker)
    total = same = 0
    spent = 0.0
    for price, lots in _levels_best_first(a, taker).items():
        total += lots
        same += min(lots, later.get(price, 0))
        spent += a.price(price) * a.size(lots)
        if spent >= usd:
            break
    return same / total if total else None


# ---- summary over many start times ---------------------------------------------------


def _percentile(sorted_values: Sequence[float], q: float) -> float:
    """Linear-interpolation percentile (q in [0, 1]) of already-sorted values."""
    if not sorted_values:
        raise ValueError("no values")
    pos = q * (len(sorted_values) - 1)
    lo, hi = math.floor(pos), math.ceil(pos)
    return sorted_values[lo] + (sorted_values[hi] - sorted_values[lo]) * (pos - lo)


@dataclass(frozen=True, slots=True)
class Dist:
    """Median and the 10th/90th percentiles of a list of numbers."""

    p10: float
    median: float
    p90: float
    n: int

    @classmethod
    def of(cls, values: Sequence[float]) -> Dist | None:
        v = sorted(values)
        if not v:
            return None
        return cls(_percentile(v, 0.1), _percentile(v, 0.5), _percentile(v, 0.9), len(v))

    def fmt(self, digits: int = 1) -> str:
        if self.n == 1:
            return f"{self.median:.{digits}f}"
        return f"{self.median:.{digits}f} ({self.p10:.{digits}f} to {self.p90:.{digits}f})"


@dataclass(frozen=True, slots=True)
class SummaryRow:
    """TWAP vs one-shot for one venue, size and side, over every start time in a run."""

    venue: str
    usd: float
    side: str  # "buy", "sell", or "both" (the two pooled)
    resilience: float
    n_windows: int  # start times; with side="both" each contributes a buy and a sell
    gap_s: float  # time between two children
    window_s: float  # time from the first child to the last
    one_shot: Dist  # bps vs arrival
    twap: Dist  # bps vs arrival
    mid_change: Dist  # signed price move first child -> last child, bps (+ = price rose)
    abs_drift: Dist  # the same move, size only
    abs_drift_paid: Dist  # |drift part of the TWAP's cost|: ~half the window move, on average
    saving: Dist  # one-shot minus TWAP: > 0 means splitting was cheaper
    impact_saving: Dist  # one-shot minus the TWAP's impact part (drift taken out)
    twap_cheaper: float  # share of results where TWAP cost less
    one_shot_fill: float  # median fill ratio
    twap_fill: float
    fee_bps: float  # the same for both
    unchanged: Dist | None  # book_unchanged_share between consecutive children


def run_windows(
    series: Series,
    usd: float,
    side: str,
    n_children: int = 12,
    every: int = 1,
    resilience: float = 1.0,
    limit_bps: float = DEFAULT_LIMIT_BPS,
    benchmark: Benchmark = "ref",
) -> list[TwapResult]:
    """A TWAP from every possible start time (rolling, overlapping windows)."""
    results = []
    for window in series.windows(n_children, every):
        try:
            results.append(run_window(window, side, usd, resilience, limit_bps, benchmark))
        except ValueError:
            continue  # e.g. no reference price at that tick: skip it, don't guess
    return results


def summarize_results(
    series: Series,
    usd: float,
    results: Sequence[TwapResult],
    n_children: int,
    every: int,
) -> SummaryRow | None:
    """Distributions over ``results`` (one series, one size). None if nothing filled."""
    # A result where nothing filled has no cost to compare; it still counts in fill ratios.
    priced = [r for r in results if r.saving_bps is not None]
    if not priced:
        return None
    sides = sorted({r.side for r in results})

    # Refill evidence: how much of a child-sized slice near the touch is still
    # there, unchanged, one child later.
    unchanged: list[float] = []
    # Pair each tick with the one exactly `every` ticks later (one child apart), the
    # same way Series.windows does; a missing tick just drops that pair.
    by_tick = {round(s.tick_ts / series.interval_s): s for s in series.steps}
    for k, a in by_tick.items():
        b = by_tick.get(k + every)
        if b is None:
            continue
        for side in sides:
            share = book_unchanged_share(a.snapshot, b.snapshot, side, usd / n_children)
            if share is not None:
                unchanged.append(share)

    def dist(values: list[float | None]) -> Dist:
        d = Dist.of([v for v in values if v is not None])
        if d is None:
            raise ValueError("no values to summarize")
        return d

    def impact_saving(r: TwapResult) -> float | None:
        one, impact = r.one_shot.cost_bps, r.impact_bps
        return None if one is None or impact is None else one - impact

    def drift_paid(r: TwapResult) -> float | None:
        return None if r.drift_paid_bps is None else abs(r.drift_paid_bps)

    return SummaryRow(
        venue=series.venue,
        usd=usd,
        side=sides[0] if len(sides) == 1 else "both",
        resilience=priced[0].resilience,
        n_windows=len({r.start_ts for r in results}),
        gap_s=every * series.interval_s,
        window_s=(n_children - 1) * every * series.interval_s,
        one_shot=dist([r.one_shot.cost_bps for r in priced]),
        twap=dist([r.shortfall_bps for r in priced]),
        mid_change=dist([cost_bps("buy", r.children[-1].price, r.arrival_price) for r in priced]),
        abs_drift=dist([abs(r.window_drift_bps) for r in priced]),
        abs_drift_paid=dist([drift_paid(r) for r in priced]),
        saving=dist([r.saving_bps for r in priced]),
        impact_saving=dist([impact_saving(r) for r in priced]),
        twap_cheaper=sum((r.saving_bps or 0.0) > 0 for r in priced) / len(priced),
        one_shot_fill=dist([r.one_shot.fill_ratio for r in results]).median,
        twap_fill=dist([r.fill_ratio for r in results]).median,
        fee_bps=dist([r.fee_bps for r in priced]).median,
        unchanged=Dist.of(unchanged),
    )


def summarize(
    series: Series,
    usd: float,
    n_children: int = 12,
    every: int = 1,
    resilience: float = 1.0,
    sides: Sequence[str] = ("buy", "sell"),
    limit_bps: float = DEFAULT_LIMIT_BPS,
    benchmark: Benchmark = "ref",
) -> SummaryRow | None:
    """Run a TWAP from every start time, for each of ``sides``, and summarize them together.

    Pooling buys and sells cancels a trend: over a day where SOL rose, every
    buy TWAP pays drift and every sell TWAP gains it, and neither says anything
    about splitting itself.
    """
    results = [
        r
        for side in sides
        for r in run_windows(series, usd, side, n_children, every, resilience, limit_bps, benchmark)
    ]
    return summarize_results(series, usd, results, n_children, every)


def _venues(store: Store, run_id: int | None) -> list[str]:
    run = _pick_run(store, run_id)
    return [r["venue"] for r in store.venue_health(run.run_id) if r["n_ok"]]


def twap_summary(
    store: Store,
    venues: Sequence[str] | None = None,
    sizes: Sequence[float] = DEFAULT_SUMMARY_SIZES_USD,
    n_children: int = 12,
    every: int = 1,
    resilience: float = 1.0,
    limit_bps: float = DEFAULT_LIMIT_BPS,
    benchmark: Benchmark = "ref",
    run_id: int | None = None,
    sides: Sequence[str] = ("buy", "sell"),
) -> list[SummaryRow]:
    """``summarize`` (sides pooled) for every venue and size; rows with no window are omitted."""
    rows = []
    for venue in venues or _venues(store, run_id):
        series = load_series(store, venue, run_id, band=limit_bps / 10_000 + 0.01)
        for usd in sizes:
            row = summarize(series, usd, n_children, every, resilience, sides, limit_bps, benchmark)
            if row is not None:
                rows.append(row)
    return rows


# ---- the report section -----------------------------------------------------------


def _usd(x: float) -> str:
    return f"${x / 1e6:g}M" if x >= 1e6 else f"${x / 1e3:g}K"


def _pct(x: float) -> str:
    return f"{x:.0%}"


def twap_markdown(
    store: Store,
    venues: Sequence[str] | None = None,
    sizes: Sequence[float] = DEFAULT_SUMMARY_SIZES_USD,
    n_children: int = 12,
    every: int = 1,
    limit_bps: float = DEFAULT_LIMIT_BPS,
    benchmark: Benchmark = "ref",
    run_id: int | None = None,
) -> str:
    """The report section "Does splitting a big order help?", generated from the data.

    Every start time runs twice: full refill (resilience 1, the optimistic case)
    and no refill (resilience 0, the pessimistic case); the truth for a real
    order sits between those two columns. The table has one row per side,
    because a thin book can be very different on its bid and ask sides; the
    findings pool the sides, so a trend over the run doesn't decide them.
    """
    venues = list(venues or _venues(store, run_id))
    rows: list[tuple[SummaryRow, SummaryRow | None]] = []  # (full refill, no refill) per side
    pooled: list[SummaryRow] = []  # full refill, both sides: what the findings use
    pooled_none: dict[tuple[str, float], SummaryRow | None] = {}
    unfit: list[str] = []
    for venue in venues:
        series = load_series(store, venue, run_id, band=limit_bps / 10_000 + 0.01)
        if not series.windows(n_children, every):
            unfit.append(not_enough_ticks(series, n_children, every))
            continue
        for usd in sizes:
            full_all: list[TwapResult] = []
            none_all: list[TwapResult] = []
            for side in ("buy", "sell"):
                args = (series, usd, side, n_children, every)
                full = run_windows(*args, 1.0, limit_bps, benchmark)
                none = run_windows(*args, 0.0, limit_bps, benchmark)
                full_all += full
                none_all += none
                row = summarize_results(series, usd, full, n_children, every)
                if row is not None:
                    rows.append((row, summarize_results(series, usd, none, n_children, every)))
            both = summarize_results(series, usd, full_all, n_children, every)
            if both is not None:
                pooled.append(both)
                pooled_none[(venue, usd)] = summarize_results(
                    series, usd, none_all, n_children, every
                )

    lines = ["## Does splitting a big order help?", ""]
    if not rows:
        lines += ["Not enough data yet to answer this. " + " ".join(unfit), ""]
        return "\n".join(lines)

    first = rows[0][0]
    minutes, gap = first.window_s / 60, first.gap_s / 60
    bench = "the reference mid (Kraken/Coinbase)" if benchmark == "ref" else "the venue's own mid"
    lines += [
        f"A parent order is split into {n_children} equal IOC child orders, one every "
        f"{gap:g} minutes ({minutes:g} minutes from first to last), each executed against the "
        f"real snapshot of that moment, and compared with sending it all at once at the start. "
        f"Costs are implementation shortfall in bps against {bench} at arrival: medians, with "
        f"the 10th to 90th percentile over every start time in the run (the windows overlap). "
        f"Full refill assumes makers replace everything a child takes before the next one; no "
        f"refill assumes nothing comes back. Fees are left out of the cost columns and are the "
        f"same either way: splitting doesn't change the fee rate.",
        "",
        "| Venue | Size | Side | Start times | Filled (one-shot / TWAP) | One-shot cost "
        "| TWAP, full refill | TWAP, no refill | Mid change over window | TWAP cheaper "
        "(full refill) | Book unchanged between children | Fee (bps) |",
        "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ]
    for r, r0 in rows:
        unchanged = r.unchanged.fmt(2) if r.unchanged else "n/a"
        lines.append(
            f"| {r.venue} | {_usd(r.usd)} | {r.side} | {r.n_windows} | "
            f"{_pct(r.one_shot_fill)} / {_pct(r.twap_fill)} | {r.one_shot.fmt()} | "
            f"{r.twap.fmt()} | {r0.twap.fmt() if r0 else 'n/a'} | {r.mid_change.fmt()} | "
            f"{_pct(r.twap_cheaper)} | {unchanged} | {r.fee_bps:g} |"
        )
    if unfit:
        lines += ["", "Left out: " + " ".join(unfit)]
    lines += ["", " ".join(_findings(pooled, pooled_none)), ""]
    return "\n".join(lines)


def _each(rows: Sequence[SummaryRow], fmt: Callable[[SummaryRow], str]) -> str:
    """'a, b and c': one formatted value per row; a single value if they are all equal."""
    parts = [fmt(r) for r in rows]
    if len(set(parts)) == 1:
        return parts[0]
    return ", ".join(parts[:-1]) + " and " + parts[-1]


def _findings(full: list[SummaryRow], no_refill: dict) -> list[str]:
    """2-4 sentences, generated from the numbers, that say what the table means.

    ``full`` holds the pooled (buy + sell) full-refill rows. Only the largest
    size is discussed: that's where impact is big enough for splitting to have
    a chance. Pairwise numbers (TWAP minus one-shot on the same start time) are
    used rather than comparing two medians, because they stay meaningful when a
    venue's buy and sell sides are wildly different.
    """
    out = []
    biggest = max(r.usd for r in full)
    top = [r for r in full if r.usd == biggest]
    # Costs only compare like for like when both orders got (nearly) everything.
    filled = [r for r in top if r.one_shot_fill >= 0.99 and r.twap_fill >= 0.99]
    minutes = f"{top[0].window_s / 60:g} minutes"

    # 1. Where the drift a TWAP pays is bigger than the impact it saves, splitting is a bet.
    #    (A TWAP pays, on average, about half the start-to-end move: its children are
    #    spread over the window, not all at the end.)
    drift_bound = [r for r in filled if r.abs_drift_paid.median > r.impact_saving.median]
    if drift_bound:
        out.append(
            f"On {_each(drift_bound, lambda r: r.venue)}, the drift a TWAP pays over {minutes} "
            f"(typically {_each(drift_bound, lambda r: f'{r.abs_drift_paid.median:.1f}')} bps, "
            f"either way) is bigger than the impact that splitting {_usd(biggest)} saves even "
            f"with full refill ({_each(drift_bound, lambda r: f'{r.impact_saving.median:.1f}')} "
            f"bps), so the outcome is mostly luck: TWAP was cheaper in "
            f"{_each(drift_bound, lambda r: _pct(r.twap_cheaper))} of the results."
        )

    # 2. Where the impact saved beats the drift paid, splitting can genuinely help.
    impact_bound = [r for r in filled if r not in drift_bound]
    if impact_bound:
        out.append(
            f"On {_each(impact_bound, lambda r: r.venue)}, the impact saved at {_usd(biggest)} "
            f"({_each(impact_bound, lambda r: f'{r.impact_saving.median:.1f}')} bps) is bigger "
            f"than the typical drift paid "
            f"({_each(impact_bound, lambda r: f'{r.abs_drift_paid.median:.1f}')} bps), and with "
            f"full refill TWAP was cheaper in "
            f"{_each(impact_bound, lambda r: _pct(r.twap_cheaper))} of the results: splitting "
            f"helps there, but only if the book really refills."
        )

    # 3. Does it refill? A book nobody touches between snapshots gives no reason to think so.
    static = [r for r in top if r.unchanged is not None and r.unchanged.median >= 0.5]
    active = [r for r in top if r.unchanged is not None and r.unchanged.median < 0.5]
    if static:
        r = max(static, key=lambda r: r.unchanged.median if r.unchanged else 0.0)
        r0 = no_refill.get((r.venue, r.usd))
        moved = (
            f" even though the price moved a median {r.abs_drift.median:.1f} bps per window"
            if r.abs_drift.median >= 1.0
            else ""
        )
        sentence = (
            f"{r.venue}'s book near the touch was unchanged from one child to the next for a "
            f"median {r.unchanged.median:.0%} of the depth a child takes{moved}: its makers "
            f"hardly requote, so there is little reason to expect it to refill"
        )
        if r0 is not None:
            saved = r0.saving.median
            sentence += (
                f" (without refill, TWAP saved a median {saved:.1f} bps)"
                if saved >= 0
                else f" (without refill, TWAP cost a median {-saved:.1f} bps more)"
            )
        if r not in filled:
            sentence += (
                f", and inside the price limit it fills only {_pct(r.one_shot_fill)} of "
                f"{_usd(biggest)} in one order ({_pct(r.twap_fill)} as a TWAP with full refill)"
            )
        out.append(sentence + ".")
    elif active:
        worst = max(r.unchanged.median for r in active if r.unchanged)
        share = "none" if worst < 0.005 else f"at most {worst:.0%}"
        out.append(
            f"The books were requoted between children ({share} of the depth a child takes "
            f"was still there unchanged), which is consistent with refill but doesn't prove it."
        )

    # 4. Honesty about sample size.
    n = min(r.n_windows for r in full)
    if n < 30:
        times = "start time" if n == 1 else "start times"
        out.append(f"Only {n} {times} so far, so treat this as preliminary.")
    return out[:4]


# ---- CLI: python -m impact_analyzer twap ---------------------------------------------


def add_twap_parser(sub: argparse._SubParsersAction) -> None:
    """Register the ``twap`` command. ``__main__`` calls this once and dispatches on ``handler``."""
    p = sub.add_parser(
        "twap",
        help="split a big order into child orders over real snapshots (TWAP vs one-shot)",
        description="Execute a parent order as --children equal IOC child orders, one every "
        "--every collector ticks, against real successive snapshots, and compare with one "
        "order at the first snapshot. Costs are implementation shortfall vs the arrival price.",
    )
    p.add_argument("--db", default="data/collect.sqlite", help="collector SQLite file")
    p.add_argument("--venue", default="kraken", help="venue to trade on (default kraken)")
    p.add_argument("--side", choices=("buy", "sell"), default="buy")
    p.add_argument("--usd", type=float, default=1_000_000, help="parent order size in USD")
    p.add_argument("--children", type=int, default=12, help="number of child orders")
    p.add_argument("--every", type=int, default=1, help="ticks between children (default 1)")
    p.add_argument(
        "--resilience",
        type=float,
        default=1.0,
        help="share of liquidity we took that is back by the next child, 0..1 (default 1)",
    )
    p.add_argument(
        "--limit-bps",
        type=float,
        default=DEFAULT_LIMIT_BPS,
        help="each IOC's limit, in bps from that snapshot's mid (default 1000 = 10%%)",
    )
    p.add_argument(
        "--benchmark",
        choices=("own", "ref"),
        help="arrival price: the venue's own mid, or the Kraken/Coinbase reference mid "
        "(default: own for one TWAP, ref for --summary)",
    )
    p.add_argument("--start", type=int, default=0, help="which start time: 0 = first possible")
    p.add_argument("--run", type=int, help="collector run id (default: newest)")
    p.add_argument(
        "--summary",
        action="store_true",
        help="instead: every start time, every venue, as the report's Markdown section",
    )
    p.add_argument(
        "--sizes",
        nargs="+",
        type=float,
        default=list(DEFAULT_SUMMARY_SIZES_USD),
        metavar="USD",
        help="parent sizes for --summary (default: 100000 1000000)",
    )
    p.set_defaults(handler=cmd_twap)


def _hhmm(ts: float) -> str:
    return datetime.fromtimestamp(ts, UTC).strftime("%H:%MZ")


def _bps(x: float | None, width: int = 9) -> str:
    return f"{'-':>{width}}" if x is None else f"{x:>{width}.2f}"


def format_twap(r: TwapResult, benchmark: Benchmark = "own") -> str:
    """The ``twap`` command's table: one-shot vs TWAP, then every child."""
    what = "own mid" if benchmark == "own" else "reference mid"
    one, lines = r.one_shot, []
    if r.n_children == 1:
        how = "as 1 IOC (nothing to split)"
    else:
        gap = r.window_s / (r.n_children - 1) / 60
        how = f"as {r.n_children} IOC children, one every {gap:g} min"
    lines.append(
        f"{r.venue}: {r.side} {_usd(r.total_usd)} ({one.requested_base:,.3f} SOL) "
        f"{how}, resilience {r.resilience:g}"
    )
    lines.append(
        f"arrival price ${r.arrival_price:,.4f} ({what} at {_hhmm(r.start_ts)}); "
        f"price at the last child ${r.children[-1].price:,.4f}"
    )
    lines.append("")
    head = (
        f"{'':<20}{'filled':>10}{'avg price':>12}{'cost':>9}{'= drift':>9}{'+ impact':>9}"
        f"{'fee':>9}{'all-in':>9}"
    )
    lines += [head, "-" * len(head)]
    avg1 = f"{one.avg_price:,.4f}" if one.avg_price else "-"
    lines.append(
        f"{'one-shot at start':<20}{one.fill_ratio:>10.1%}{avg1:>12}{_bps(one.cost_bps)}"
        f"{_bps(0.0)}{_bps(one.cost_bps)}{_bps(one.fee_bps)}{_bps(one.all_in_bps)}"
    )
    avg = f"{r.avg_price:,.4f}" if r.avg_price else "-"
    lines.append(
        f"{f'TWAP x {r.n_children}':<20}{r.fill_ratio:>10.1%}{avg:>12}{_bps(r.shortfall_bps)}"
        f"{_bps(r.drift_paid_bps)}{_bps(r.impact_bps)}{_bps(r.fee_bps)}{_bps(r.all_in_bps)}"
    )
    lines.append("costs in bps vs the arrival price; cost = drift (the market) + impact (us)")
    lines.append("")
    lines.append(
        f"{'child':<7}{'time':<8}{'price':>11}{'removed SOL':>13}{'filled':>9}"
        f"{'avg price':>12}{'impact':>9}{'fee $':>11}"
    )
    for c in r.children:
        res = c.result
        a = f"{res.avg_price:,.4f}" if res.avg_price else "-"
        lines.append(
            f"{c.index:<7}{_hhmm(c.at):<8}{c.price:>11,.4f}{res.removed_base:>13,.3f}"
            f"{res.fill_ratio:>9.1%}{a:>12}{_bps(res.cost_bps)}{res.fee_usd:>11,.2f}"
        )
    lines.append("")
    drift = r.window_drift_bps
    direction = (
        "against" if drift > 0 else "in favour of" if drift < 0 else "neither for nor against"
    )
    lines.append(f"Price move over the window: {drift:+.2f} bps ({direction} a {r.side}er).")
    if r.saving_bps is not None:
        verdict = (
            f"{abs(r.saving_bps):.2f} bps cheaper than"
            if r.saving_bps > 0
            else f"{abs(r.saving_bps):.2f} bps more expensive than"
            if r.saving_bps < 0
            else "the same cost as"
        )
        lines.append(
            f"Splitting was {verdict} one order: it saved "
            f"{(one.cost_bps or 0) - (r.impact_bps or 0):.2f} bps of impact and paid "
            f"{r.drift_paid_bps or 0:+.2f} bps of drift."
        )
    lines.append(
        f"Fees: ${one.fee_usd:,.2f} one-shot vs ${r.fee_usd:,.2f} over {r.n_children} "
        f"child order(s), {r.fee_bps:g} bps either way: splitting doesn't shrink the fee rate."
    )
    if not (r.fully_filled and one.fully_filled):
        lines.append(
            f"Partial fills: one-shot {one.fill_ratio:.1%}, TWAP {r.fill_ratio:.1%}. IOC size "
            f"with nothing inside its limit was cancelled; costs are on what filled, so they "
            f"compare different amounts."
        )
    return "\n".join(lines)


def cmd_twap(args: argparse.Namespace) -> None:
    from pathlib import Path

    if not Path(args.db).exists():
        sys.exit(f"{args.db} does not exist (collect some data first: collect)")
    with Store(args.db, readonly=True) as store:
        if args.summary:
            print(
                twap_markdown(
                    store,
                    sizes=args.sizes,
                    n_children=args.children,
                    every=args.every,
                    limit_bps=args.limit_bps,
                    benchmark=args.benchmark or "ref",
                    run_id=args.run,
                )
            )
            return
        args.benchmark = args.benchmark or "own"
        series = load_series(store, args.venue, args.run)
        if not series.steps:
            sys.exit(f"no good {args.venue} snapshots in {args.db}")
        windows = series.windows(args.children, args.every)
        if not windows:
            sys.exit(not_enough_ticks(series, args.children, args.every))
        if not 0 <= args.start < len(windows):
            sys.exit(f"--start must be between 0 and {len(windows) - 1}")
        window = windows[args.start]
        try:
            result = run_window(
                window, args.side, args.usd, args.resilience, args.limit_bps, args.benchmark
            )
        except ValueError as e:
            sys.exit(str(e))
    print(format_twap(result, args.benchmark))
    spread = window[0].snapshot.spread_bps()
    if args.benchmark == "own" and spread is not None and spread > 100:
        print(
            f"\nnote: {args.venue}'s spread is {spread:,.0f} bps, so its own mid is not a "
            f"market price; rerun with --benchmark ref."
        )
