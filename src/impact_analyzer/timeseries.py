"""Aggregates over many ticks: percentiles, hour-of-day buckets, uptime, Phoenix activity.

Everything here is a pure function of the rows ``metrics.py`` produces (no
database, no plotting), so each one is easy to test with a handful of
hand-written rows.

The central idea is the *observation*: one measured number, tagged with what
it is. ``observations()`` flattens book metrics, quotes and round trips into a
single list of them, and every summary is then "group by key, summarise the
values". A key is ``(series, metric, side, param)``, for example:

    ("kraken", "spread_bps", None, None)
    ("phoenix", "depth_usd", "bid", 0.02)         # USD within 2% of mid, bid side
    ("jupiter:SolFi", "cost_bps", "buy", 10000.0)  # cost of a $10K buy vs ref
    ("coinbase", "round_trip_bps", None, 1e6)      # half round trip, $1M

We report medians and percentiles, not means: a single bad tick (one order
pulled from a thin book) can move a mean a long way, a median barely moves.
"""

from __future__ import annotations

import math
import time
from collections import Counter, defaultdict
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from typing import NamedTuple

from .metrics import BookMetrics, Fetch, QuoteMetrics, RoundTrip

Key = tuple[str, str, str | None, float | None]  # (series, metric, side, param)


class Obs(NamedTuple):
    tick_ts: float
    series: str  # "phoenix", "kraken", "coinbase", or "jupiter:<dex>"
    metric: str  # "spread_bps", "depth_usd", "cost_bps", "filled", ...
    side: str | None  # "buy"/"sell" for trades, "bid"/"ask" for depth, else None
    param: float | None  # trade size in USD, or the depth band, else None
    value: float

    @property
    def key(self) -> Key:
        return (self.series, self.metric, self.side, self.param)


@dataclass(frozen=True, slots=True)
class Summary:
    n: int
    mean: float  # used for 0/1 flags: the mean of "filled" is the fill rate
    p10: float
    p25: float
    median: float
    p75: float
    p90: float


def quantile(sorted_values: Sequence[float], q: float) -> float:
    """The ``q``-quantile (0..1) of already-sorted values, interpolating linearly.

    Position ``q * (n - 1)`` in the sorted list; between two neighbours we take
    the weighted average. This is numpy's default method, written out so it is
    obvious what "p90" means here.
    """
    if not sorted_values:
        raise ValueError("quantile of no values")
    pos = q * (len(sorted_values) - 1)
    lo = math.floor(pos)
    hi = min(lo + 1, len(sorted_values) - 1)
    frac = pos - lo
    return sorted_values[lo] + (sorted_values[hi] - sorted_values[lo]) * frac


def summarize(values: Iterable[float]) -> Summary | None:
    """Percentiles of ``values``; None when there are none (a venue that never answered)."""
    v = sorted(x for x in values if x is not None and math.isfinite(x))
    if not v:
        return None
    return Summary(
        n=len(v),
        mean=sum(v) / len(v),
        p10=quantile(v, 0.10),
        p25=quantile(v, 0.25),
        median=quantile(v, 0.50),
        p75=quantile(v, 0.75),
        p90=quantile(v, 0.90),
    )


# ---- flattening -------------------------------------------------------------------------


def observations(
    books: Iterable[BookMetrics],
    quotes: Iterable[QuoteMetrics] = (),
    round_trips: Iterable[RoundTrip] = (),
) -> list[Obs]:
    """Every measured number as one ``Obs``.

    Partial fills are recorded as ``filled = 0`` and their costs are left out:
    the cost of a partial fill is the cost of a *smaller* trade, and averaging
    it in would make a thin book look cheaper the bigger the order.
    """
    out: list[Obs] = []

    def add(ts: float, series: str, metric: str, value, side=None, param=None) -> None:
        if value is not None:  # a missing number is not a zero: leave it out
            out.append(
                Obs(ts, series, metric, side, None if param is None else float(param), value)
            )

    for b in books:
        ts, venue = b["tick_ts"], b["venue"]
        add(ts, venue, "spread_bps", b["spread_bps"])
        add(ts, venue, "mid_vs_ref_bps", b["mid_vs_ref_bps"])
        add(ts, venue, "n_orders", b["n_bids"], "bid")
        add(ts, venue, "n_orders", b["n_asks"], "ask")
        for name in ("depth_usd", "depth_ref_usd"):
            for band, (bid, ask) in b[name].items():
                add(ts, venue, name, bid, "bid", band)
                add(ts, venue, name, ask, "ask", band)
        for t in b["trades"]:
            add(ts, venue, "filled", 1.0 if t["fully_filled"] else 0.0, t["side"], t["usd"])
            if t["fully_filled"]:
                add(ts, venue, "impact_bps", t["impact_bps"], t["side"], t["usd"])
                add(ts, venue, "cost_bps", t["cost_bps"], t["side"], t["usd"])
                add(ts, venue, "all_in_bps", t["all_in_bps"], t["side"], t["usd"])
            # The same order with v1's protection band (centred on the venue's own mid).
            own_full = t["own_band_fully_filled"]
            add(ts, venue, "own_band_filled", 1.0 if own_full else 0.0, t["side"], t["usd"])
            if own_full:
                add(ts, venue, "own_band_cost_bps", t["own_band_cost_bps"], t["side"], t["usd"])
    for q in quotes:
        ts, series = q["tick_ts"], q["series"]
        if q["ok"] or q["no_route"]:  # other errors (rate limits...) say nothing about liquidity
            add(ts, series, "filled", 1.0 if q["ok"] else 0.0, q["side"], q["usd"])
        add(ts, series, "cost_bps", q["cost_bps"], q["side"], q["usd"])
        add(ts, series, "all_in_bps", q["all_in_bps"], q["side"], q["usd"])
    for rt in round_trips:
        add(rt["tick_ts"], rt["series"], "round_trip_bps", rt["bps"], None, rt["usd"])
    return out


# ---- grouping -----------------------------------------------------------------------------


def summarize_by_key(obs: Iterable[Obs]) -> dict[Key, Summary]:
    """One ``Summary`` per (series, metric, side, param)."""
    groups: dict[Key, list[float]] = defaultdict(list)
    for o in obs:
        groups[o.key].append(o.value)
    return {k: s for k, values in groups.items() if (s := summarize(values)) is not None}


def hour_of_day(ts: float) -> int:
    """UTC hour 0..23. UTC on purpose: crypto trades around the clock, and the
    US/EU/Asia sessions are easiest to talk about in one fixed time zone."""
    return time.gmtime(ts).tm_hour


def by_hour(obs: Iterable[Obs]) -> dict[Key, dict[int, Summary]]:
    """Per key, a ``Summary`` per UTC hour of day (only hours that have data)."""
    groups: dict[Key, dict[int, list[float]]] = defaultdict(lambda: defaultdict(list))
    for o in obs:
        groups[o.key][hour_of_day(o.tick_ts)].append(o.value)
    out: dict[Key, dict[int, Summary]] = {}
    for key, hours in groups.items():
        out[key] = {h: s for h, v in sorted(hours.items()) if (s := summarize(v)) is not None}
    return out


def over_time(
    obs: Iterable[Obs], series: str, metric: str, side: str | None = None, param=None
) -> list[tuple[float, float]]:
    """``(tick_ts, value)`` points of one key, in time order: one line on a chart."""
    key = (series, metric, side, None if param is None else float(param))
    return sorted((o.tick_ts, o.value) for o in obs if o.key == key)


# ---- collector health -------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class Health:
    source: str
    attempted: int
    ok: int
    no_route: int  # Jupiter: no pool could fill it (a liquidity fact, not an outage)
    errors: int  # anything else: timeouts, HTTP errors, rate limits
    latency_p50_ms: float | None
    latency_p95_ms: float | None
    last_error: str | None

    @property
    def uptime(self) -> float:
        """Share of requests that returned a usable answer (ok / attempted)."""
        return self.ok / self.attempted if self.attempted else 0.0

    @property
    def answered(self) -> float:
        """Share that got *an* answer, counting "no route" as one: the API's availability."""
        return (self.ok + self.no_route) / self.attempted if self.attempted else 0.0


def health(fetches: Iterable[Fetch]) -> list[Health]:
    """Uptime and latency per source (venue, Jupiter route, Solana RPC)."""
    groups: dict[str, list[Fetch]] = defaultdict(list)
    for f in fetches:
        groups[f["source"]].append(f)
    out = []
    for source, rows in groups.items():
        latencies = sorted(r["latency_ms"] for r in rows if r["ok"] and r["latency_ms"] is not None)
        errors = [r for r in rows if not r["ok"] and not r["no_route"]]
        failed = [r for r in rows if not r["ok"]]
        out.append(
            Health(
                source=source,
                attempted=len(rows),
                ok=sum(r["ok"] for r in rows),
                no_route=sum(r["no_route"] for r in rows),
                errors=len(errors),
                latency_p50_ms=quantile(latencies, 0.5) if latencies else None,
                latency_p95_ms=quantile(latencies, 0.95) if latencies else None,
                last_error=max(failed, key=lambda r: r["tick_ts"])["error"] if failed else None,
            )
        )
    return out


# ---- Phoenix activity --------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class Activity:
    """Phoenix's state at one tick, and how much happened since the previous one."""

    tick_ts: float
    sequence_number: int
    events: int | None  # sequence number change since the previous Phoenix snapshot
    gap_s: float | None  # time since that snapshot (more than 5 min if ticks were missed)
    spread_bps: float | None
    best_bid: float | None
    best_ask: float | None
    best_bid_sol: float
    best_ask_sol: float
    mid_vs_ref_bps: float | None
    ref_mid: float | None


def phoenix_activity(books: Iterable[BookMetrics], venue: str = "phoenix") -> list[Activity]:
    """One ``Activity`` per Phoenix snapshot, in time order.

    The market account's ``market_sequence_number`` goes up by one for every
    instruction that changes the market (place, cancel, fill...), so its
    difference between two snapshots counts what happened in between. It is a
    lower bound on activity, not a trade count.
    """
    rows = sorted(
        (b for b in books if b["venue"] == venue and b["sequence_number"] is not None),
        key=lambda b: b["tick_ts"],
    )
    out: list[Activity] = []
    prev: BookMetrics | None = None
    for b in rows:
        out.append(
            Activity(
                tick_ts=b["tick_ts"],
                sequence_number=b["sequence_number"],
                events=b["sequence_number"] - prev["sequence_number"] if prev else None,
                gap_s=b["tick_ts"] - prev["tick_ts"] if prev else None,
                spread_bps=b["spread_bps"],
                best_bid=b["best_bid"],
                best_ask=b["best_ask"],
                best_bid_sol=b["best_bid_sol"],
                best_ask_sol=b["best_ask_sol"],
                mid_vs_ref_bps=b["mid_vs_ref_bps"],
                ref_mid=b["ref_mid"],
            )
        )
        prev = b
    return out


@dataclass(frozen=True, slots=True)
class SpreadJump:
    before: Activity
    after: Activity

    @property
    def ratio(self) -> float:
        return (self.after.spread_bps or 0) / (self.before.spread_bps or 1)


def biggest_spread_jump(activity: Sequence[Activity]) -> SpreadJump | None:
    """The consecutive pair of snapshots whose spread changed by the largest factor
    (up or down): usually one order appearing or disappearing at the top of the book."""
    best: SpreadJump | None = None
    best_factor = 1.0
    for a, b in zip(activity, activity[1:], strict=False):
        if not a.spread_bps or not b.spread_bps:
            continue
        factor = max(b.spread_bps / a.spread_bps, a.spread_bps / b.spread_bps)
        if factor > best_factor:
            best, best_factor = SpreadJump(a, b), factor
    return best


# ---- Jupiter route mix -------------------------------------------------------------------


def route_mix(quotes: Iterable[QuoteMetrics], dex: str = "best") -> list[tuple[str, int, int]]:
    """For one route filter: ``(pool label, quotes that used it, total ok quotes)``,
    most used first. Shows *where* Jupiter's best price actually came from."""
    used: Counter[str] = Counter()
    total = 0
    for q in quotes:
        if q["dex"] == dex and q["ok"]:
            total += 1
            # Each pool once per quote; dict.fromkeys (not set) keeps route order, so ties in
            # most_common() come out in a stable order.
            used.update(list(dict.fromkeys(q["route"])))
    return [(label, n, total) for label, n in used.most_common()]
