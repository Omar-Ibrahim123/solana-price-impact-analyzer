"""The ``report`` command: a collector database in, ``REPORT.md`` and PNG charts out.

    python -m impact_analyzer report --db data/collect.sqlite --out docs/report

The pipeline is: ``metrics.load_dataset`` (per-snapshot numbers, cached) ->
``timeseries`` (percentiles, hours, health, Phoenix activity) -> ``charts`` and
the Markdown below. The headline findings are *generated from the numbers*,
never typed in by hand, so regenerating the report on new data can't leave a
stale claim behind.

Everything degrades gracefully: a venue that failed some ticks just has fewer
observations; a route with no liquidity at a size says so; a run of one tick
still produces a (short) report.
"""

from __future__ import annotations

import argparse
import sys
import time
from collections.abc import Sequence
from pathlib import Path

from . import charts
from .charts import label, short_usd
from .execution import twap_markdown
from .fees import BASE_TIER_TAKER_BPS
from .impact import DEFAULT_MAX_SLIPPAGE, DEFAULT_SIZES_USD
from .metrics import METRICS_VERSION, Dataset, load_dataset, series_name
from .store import Store
from .timeseries import (
    Activity,
    Health,
    Key,
    Summary,
    biggest_spread_jump,
    by_hour,
    health,
    observations,
    phoenix_activity,
    route_mix,
    summarize_by_key,
)

DEPTH_BAND = 0.02  # the band the headline and the depth chart use


# ---- number formatting --------------------------------------------------------------------


def fmt_bps(v: float | None) -> str:
    """Enough digits to compare 0.48 with 0.71, not so many that 1,584 reads as 1583.78."""
    if v is None:
        return "n/a"
    if abs(v) >= 100:
        return f"{v:,.0f}"
    if abs(v) >= 10:
        return f"{v:.1f}"
    return f"{v:.2f}"


def fmt_usd(v: float | None) -> str:
    return "n/a" if v is None else short_usd(v) if v >= 1_000 else f"${v:,.0f}"


def hhmm(ts: float) -> str:
    return time.strftime("%Y-%m-%d %H:%M", time.gmtime(ts))


def _median(summaries: dict[Key, Summary], key: Key) -> float | None:
    s = summaries.get(key)
    return s.median if s else None


def _fill_count(summaries: dict[Key, Summary], key: Key) -> tuple[int, int] | None:
    """(ticks that filled, ticks measured) from a 0/1 ``filled`` summary."""
    s = summaries.get(key)
    return (round(s.mean * s.n), s.n) if s else None


# ---- headline findings ---------------------------------------------------------------------


def headlines(
    data: Dataset,
    summaries: dict[Key, Summary],
    activity: Sequence[Activity],
    healths: Sequence[Health],
    sizes: Sequence[float],
) -> list[str]:
    """Sentences stating what the numbers say, each one computed, none hand-written."""
    out: list[str] = []
    venues = data.venues
    routes = [series_name(d) for d in data.dexes]

    # 1. Spread
    parts = [
        f"{label(v)} {fmt_bps(m)} bps"
        for v in venues
        if (m := _median(summaries, (v, "spread_bps", None, None))) is not None
    ]
    if parts:
        out.append("Median quoted spread: " + _join_vs(parts) + ".")

    # 2. Venues whose own mid is off the reference price
    for v in venues:
        m = _median(summaries, (v, "mid_vs_ref_bps", None, None))
        if m is not None and abs(m) >= 10:
            out.append(
                f"{label(v)}'s own mid sat a median {fmt_bps(abs(m))} bps "
                f"{'below' if m < 0 else 'above'} the reference mid (mean of the Kraken and "
                f"Coinbase mids), so its impact vs its *own* mid is misleading; every cross-venue "
                f"number in this report uses the reference mid instead."
            )

    # 3. Depth
    parts = []
    for v in venues:
        bid = _median(summaries, (v, "depth_usd", "bid", DEPTH_BAND))
        ask = _median(summaries, (v, "depth_usd", "ask", DEPTH_BAND))
        if bid is not None and ask is not None:
            parts.append(f"{label(v)} {fmt_usd(bid)} bid / {fmt_usd(ask)} ask")
    if parts:
        out.append(f"Median depth within {DEPTH_BAND:.0%} of mid: " + "; ".join(parts) + ".")
    for v in venues:
        own = _median(summaries, (v, "depth_usd", "ask", DEPTH_BAND)) or 0
        own += _median(summaries, (v, "depth_usd", "bid", DEPTH_BAND)) or 0
        rb = _median(summaries, (v, "depth_ref_usd", "bid", DEPTH_BAND))
        ra = _median(summaries, (v, "depth_ref_usd", "ask", DEPTH_BAND))
        if rb is not None and ra is not None and abs((rb + ra) - own) > 0.5 * max(own, 1):
            out.append(
                f"Measured around the reference price instead, {label(v)} had a median "
                f"{fmt_usd(rb)} bid / {fmt_usd(ra)} ask within {DEPTH_BAND:.0%}."
            )

    # 4. One yardstick: half round trip, cheapest first
    for usd in [s for s in sizes if s in (10_000, 100_000)] or list(sizes[:1]):
        ranked = sorted(
            (m, s)
            for s in venues + routes
            if (m := _median(summaries, (s, "round_trip_bps", None, float(usd)))) is not None
        )
        missing = [
            label(s)
            for s in venues + routes
            if (s, "round_trip_bps", None, float(usd)) not in summaries
            and any(k[0] == s for k in summaries)
        ]
        if ranked:
            text = ", ".join(f"{label(s)} {fmt_bps(m)}" for m, s in ranked)
            out.append(
                f"Half round-trip cost at {short_usd(usd)} (buy and sell, median bps of the "
                f"reference mid), cheapest first: {text}."
                + (f" Never filled both ways: {', '.join(missing)}." if missing else "")
            )

    # 5. Fees change the ranking
    usd = 10_000.0 if 10_000 in sizes else float(sizes[0])
    parts, fee_dominated = [], []
    for s in venues + [r for r in routes if r == "jupiter:best"]:
        cost = _median(summaries, (s, "cost_bps", "buy", usd))
        allin = _median(summaries, (s, "all_in_bps", "buy", usd))
        if cost is None or allin is None:
            continue
        fee = allin - cost
        if fee > 5 * max(cost, 0):
            fee_dominated.append(label(s))
        detail = f" ({fmt_bps(cost)} + {fmt_bps(fee)} fee)" if fee > 0 else " (fees in the quote)"
        parts.append(f"{label(s)} {fmt_bps(allin)} bps{detail}")
    if parts:
        out.append(
            f"All-in cost of a {short_usd(usd)} buy with base-tier taker fees: "
            + "; ".join(parts)
            + "."
            + (
                f" For {', '.join(fee_dominated)} the fee is more than 5x the trading cost."
                if fee_dominated
                else ""
            )
        )

    # 5b. Decoder check: Jupiter quoting through Phoenix vs our engine on our decoded book.
    # Jupiter's price includes Phoenix's taker fee, so compare it with our all-in number.
    small = float(sizes[0])
    ours = _median(summaries, ("phoenix", "all_in_bps", "buy", small))
    theirs = _median(summaries, ("jupiter:Phoenix", "cost_bps", "buy", small))
    if ours is not None and theirs is not None:
        out.append(
            f"Decoder check: a {short_usd(small)} buy on Phoenix costs {fmt_bps(ours)} bps all-in "
            f"by our engine on our decoded book, and {fmt_bps(theirs)} bps as quoted by Jupiter "
            f"routing through Phoenix (median over ticks)."
        )

    # 5c. Where the protection band sits changes the answer (a venue with a junk own mid).
    for v in venues:
        for side in ("buy", "sell"):
            ref_fill = _fill_count(summaries, (v, "filled", side, small))
            own_fill = _fill_count(summaries, (v, "own_band_filled", side, small))
            if not ref_fill or not own_fill or ref_fill[0] >= own_fill[0]:
                continue
            own_cost = _median(summaries, (v, "own_band_cost_bps", side, small))
            out.append(
                f"Price protection matters on {label(v)}: a {short_usd(small)} {side} limited to "
                f"10% from the reference mid filled in {ref_fill[0]}/{ref_fill[1]} ticks; with "
                f"v1's band around {label(v)}'s own mid it would have filled in "
                f"{own_fill[0]}/{own_fill[1]}, at a median {fmt_bps(own_cost)} bps worse than the "
                f"market. This report uses the reference-mid band."
            )

    # 6. Where routes run out
    for dex in data.dexes:
        s = series_name(dex)
        dry = []
        for usd in sizes:
            counts = [
                _fill_count(summaries, (s, "filled", side, float(usd))) for side in ("buy", "sell")
            ]
            counts = [c for c in counts if c]
            ok = sum(c[0] for c in counts)
            n = sum(c[1] for c in counts)
            if n and ok < n:
                dry.append(f"{short_usd(usd)} ({n - ok}/{n} quotes)")
        if dry:
            out.append(f"{label(s)} found no route at: " + ", ".join(dry) + ".")

    # 7. Where Jupiter's best price came from
    mix = route_mix(data.quotes, "best")
    if mix:
        total = mix[0][2]
        top = ", ".join(f"{lab} ({n}/{total})" for lab, n, _ in mix[:5])
        out.append(f"Pools in Jupiter's best route (share of {total} ok quotes using each): {top}.")

    # 8. Phoenix activity
    events = [a.events for a in activity if a.events is not None]
    if events:
        hours = sum(a.gap_s for a in activity if a.gap_s) / 3600
        idle = sum(1 for e in events if e == 0)
        events_sorted = sorted(events)
        median = events_sorted[len(events_sorted) // 2]
        out.append(
            f"Phoenix activity: the market's sequence number advanced a median of {median:,} "
            f"events per tick ({sum(events):,} over {hours:.1f} h); it did not move at all in "
            f"{idle} of {len(events)} intervals."
        )
    jump = biggest_spread_jump(activity)
    if jump and jump.ratio and max(jump.ratio, 1 / jump.ratio) >= 2:
        a, b = jump.before, jump.after
        what = []
        if a.best_bid != b.best_bid:
            what.append(
                f"best bid {fmt_price(a.best_bid)} ({a.best_bid_sol:,.1f} SOL) -> "
                f"{fmt_price(b.best_bid)} ({b.best_bid_sol:,.1f} SOL)"
            )
        if a.best_ask != b.best_ask:
            what.append(
                f"best ask {fmt_price(a.best_ask)} ({a.best_ask_sol:,.1f} SOL) -> "
                f"{fmt_price(b.best_ask)} ({b.best_ask_sol:,.1f} SOL)"
            )
        ev = f", {b.events:,} events in between" if b.events is not None else ""
        out.append(
            f"Biggest Phoenix spread change: {fmt_bps(a.spread_bps)} -> {fmt_bps(b.spread_bps)} "
            f"bps between {hhmm(a.tick_ts)} and {hhmm(b.tick_ts)} UTC{ev}: "
            + ("; ".join(what) or "same top of book")
            + "."
        )

    # 9. Collector health
    books = [h for h in healths if h.source in venues]
    quotes = [h for h in healths if h.source.startswith("jupiter:")]
    parts = [f"{label(h.source)} {h.ok}/{h.attempted}" for h in books]
    if quotes:
        ok = sum(h.ok for h in quotes)
        n = sum(h.attempted for h in quotes)
        nr = sum(h.no_route for h in quotes)
        err = sum(h.errors for h in quotes)
        parts.append(f"Jupiter quotes {ok}/{n} ({nr} no route, {err} errors)")
    if parts:
        out.append("Collector health (ok / attempted): " + "; ".join(parts) + ".")
    return out


def fmt_price(p: float | None) -> str:
    return "n/a" if p is None else f"${p:,.3f}"


def _join_vs(parts: list[str]) -> str:
    """["A 1", "B 2", "C 3"] -> "A 1 vs B 2 and C 3"."""
    if len(parts) == 1:
        return parts[0]
    rest = parts[1:]
    return (
        parts[0]
        + " vs "
        + (", ".join(rest[:-1]) + " and " + rest[-1] if len(rest) > 1 else rest[0])
    )


# ---- tables ---------------------------------------------------------------------------------


def _table(header: list[str], rows: list[list[str]]) -> str:
    lines = ["| " + " | ".join(header) + " |", "|" + "|".join(" --- " for _ in header) + "|"]
    lines += ["| " + " | ".join(r) + " |" for r in rows]
    return "\n".join(lines)


def book_table(data: Dataset, summaries: dict[Key, Summary]) -> str:
    rows = []
    for v in data.venues:
        sp = summaries.get((v, "spread_bps", None, None))
        rows.append(
            [
                label(v),
                str(sp.n) if sp else "0",
                f"{fmt_bps(sp.median)} ({fmt_bps(sp.p10)}-{fmt_bps(sp.p90)})" if sp else "n/a",
                fmt_bps(_median(summaries, (v, "mid_vs_ref_bps", None, None))),
                f"{fmt_usd(_median(summaries, (v, 'depth_usd', 'bid', DEPTH_BAND)))} / "
                f"{fmt_usd(_median(summaries, (v, 'depth_usd', 'ask', DEPTH_BAND)))}",
                f"{fmt_usd(_median(summaries, (v, 'depth_ref_usd', 'bid', DEPTH_BAND)))} / "
                f"{fmt_usd(_median(summaries, (v, 'depth_ref_usd', 'ask', DEPTH_BAND)))}",
                fmt_bps(next((b["fee_bps"] for b in data.books if b["venue"] == v), None)),
            ]
        )
    return _table(
        [
            "venue",
            "ticks",
            "spread bps, median (p10-p90)",
            "mid vs ref, bps",
            f"depth +/-{DEPTH_BAND:.0%} of own mid, bid / ask",
            f"depth +/-{DEPTH_BAND:.0%} of ref mid, bid / ask",
            "taker fee, bps",
        ],
        rows,
    )


def cost_table(
    series: Sequence[str],
    summaries: dict[Key, Summary],
    sizes: Sequence[float],
    cost: str = "cost_bps",
    filled: str = "filled",
) -> str:
    """Median cost vs ref per size; a cell filled in only some ticks says how many.

    ``cost``/``filled`` pick the metrics: the headline (band on the reference mid)
    or ``own_band_cost_bps``/``own_band_filled`` (v1's band on the venue's own mid).
    """
    rows = []
    for s in series:
        for side in ("buy", "sell"):
            if not any((s, filled, side, float(u)) in summaries for u in sizes):
                continue
            cells = []
            for usd in sizes:
                med = _median(summaries, (s, cost, side, float(usd)))
                fc = _fill_count(summaries, (s, filled, side, float(usd)))
                cell = fmt_bps(med) if med is not None else "no fill"
                if fc and fc[0] < fc[1]:
                    cell += f" ({fc[0]}/{fc[1]} filled)"
                cells.append(cell)
            rows.append([label(s), side, *cells])
    return _table(["series", "side", *[short_usd(u) for u in sizes]], rows)


def round_trip_table(
    series: Sequence[str], summaries: dict[Key, Summary], sizes: Sequence[float]
) -> str:
    rows = []
    for s in series:
        cells = [fmt_bps(_median(summaries, (s, "round_trip_bps", None, float(u)))) for u in sizes]
        if any(c != "n/a" for c in cells):
            rows.append([label(s), *cells])
    return _table(["series", *[short_usd(u) for u in sizes]], rows)


def health_table(healths: Sequence[Health], order: Sequence[str] = ()) -> str:
    """One row per source, in ``order`` (RPC, venues, routes); unknown sources last."""
    rank = {s: i for i, s in enumerate(["solana-rpc", *order])}
    rows = []
    for h in sorted(healths, key=lambda h: (rank.get(h.source, len(rank)), h.source)):
        rows.append(
            [
                "Solana RPC getSlot" if h.source == "solana-rpc" else label(h.source),
                str(h.attempted),
                str(h.ok),
                str(h.no_route),
                str(h.errors),
                f"{h.uptime:.1%}",
                f"{h.latency_p50_ms:,.0f}" if h.latency_p50_ms is not None else "n/a",
                f"{h.latency_p95_ms:,.0f}" if h.latency_p95_ms is not None else "n/a",
                (h.last_error or "").replace("|", "/")[:60],
            ]
        )
    return _table(
        [
            "source",
            "attempted",
            "ok",
            "no route",
            "errors",
            "uptime",
            "median ms",
            "p95 ms",
            "last error",
        ],
        rows,
    )


# ---- the document ---------------------------------------------------------------------------


CHART_CAPTIONS = {
    "spread": "Quoted spread (best ask minus best bid, in bps of the venue's own mid) at every "
    "tick. Log scale, so a 1 bps exchange and a 1,000 bps on-chain book fit on one chart.",
    "depth": "USD resting within 2% of each venue's own mid. Exchange books are aggregated "
    "levels; Phoenix's are individual orders.",
    "cost_books": "What a market order would cost on each order book, against the reference mid, "
    "with 10% price protection. Fees excluded (see the tables).",
    "cost_jupiter": "Jupiter quotes per route filter, against the same reference mid. AMM fees "
    "are already inside the quoted price.",
    "round_trip": "The one yardstick for every venue and route: half the gap between the buy "
    "and sell average price of the same size. Robust to SOL moving during the minute the "
    "quote grid takes.",
    "hours": "Medians per UTC hour of day. With less than a day of data, each hour holds only "
    "a few ticks.",
    "phoenix": "Phoenix's best bid and ask against the reference mid (top), and how many "
    "market events happened between consecutive snapshots (bottom).",
}
CHART_TITLES = {
    "spread": "Spread over time",
    "depth": "Depth within 2% over time",
    "cost_books": "Cost vs size: order books",
    "cost_jupiter": "Cost vs size: Jupiter routes",
    "round_trip": "Half round-trip cost: every venue on one yardstick",
    "hours": "Hour of day",
    "phoenix": "Phoenix activity",
}


def render_markdown(
    data: Dataset,
    summaries: dict[Key, Summary],
    activity: Sequence[Activity],
    healths: Sequence[Health],
    chart_paths: dict[str, Path | None],
    sizes: Sequence[float],
    max_slippage: float,
    extra_sections: Sequence[str] = (),
) -> str:
    """The whole REPORT.md. ``extra_sections`` (Markdown, each starting with a ``##``
    heading, e.g. the TWAP section) go after the tables, before Method."""
    ticks = data.ticks
    venues, routes = data.venues, [series_name(d) for d in data.dexes]
    md = ["# SOL/USDC liquidity: Phoenix vs Kraken vs Coinbase vs Jupiter routes", ""]
    if ticks:
        first, last = ticks[0]["tick_ts"], ticks[-1]["tick_ts"]
        span_h = (last - first) / 3600
        runs = ", ".join(f"#{r.run_id}" for r in data.runs)
        planned = sum(max(1, round((r.ends_at - r.started_at) / r.interval_s)) for r in data.runs)
        md.append(
            f"Data: **{len(ticks)} ticks**, one every {data.interval_s / 60:g} min, from "
            f"{hhmm(first)} to {hhmm(last)} UTC ({span_h:.1f} h; collector run {runs}). "
            + (
                f"This is a partial run ({len(ticks)} of ~{planned} planned ticks); "
                "regenerate the report when it finishes. "
                if len(ticks) < planned * 0.95
                else ""
            )
            + f"Generated {hhmm(time.time())} UTC by `python -m impact_analyzer report` "
            f"(metrics v{METRICS_VERSION})."
        )
    else:
        md.append("The database holds no ticks yet.")
    md += ["", "## Headline findings", ""]
    md += [f"- {h}" for h in headlines(data, summaries, activity, healths, sizes)] or [
        "- (no data)"
    ]

    md += ["", "## Charts", ""]
    for key, path in chart_paths.items():
        md += [f"### {CHART_TITLES[key]}", ""]
        if path is None:
            md += ["_Not enough data for this chart yet._", ""]
            continue
        md += [f"![{CHART_TITLES[key]}]({path.name})", "", CHART_CAPTIONS[key], ""]

    md += ["## Tables", "", "### Order books (medians over ticks)", "", book_table(data, summaries)]
    md += [
        "",
        "### Cost vs the reference mid, by size (median bps, fees excluded)",
        "",
        "Positive = worse than the reference mid. A cell filled in only some ticks shows how many; "
        "its median is over the ticks that filled.",
        "",
        cost_table(venues + routes, summaries, sizes),
        "",
        f"### Order books with v1's protection band (+/-{max_slippage:.0%} of the venue's own mid)",
        "",
        "Secondary: the same orders, but protected around each venue's *own* mid, as v1 did. "
        "Identical to the table above when a venue's mid is the market price; very different "
        "when it isn't (see Caveats).",
        "",
        cost_table(venues, summaries, sizes, cost="own_band_cost_bps", filled="own_band_filled"),
        "",
        "### Half round-trip cost (median bps of the reference mid)",
        "",
        round_trip_table(venues + routes, summaries, sizes),
        "",
        "### Collector health",
        "",
        "Uptime = ok / attempted. For Jupiter, *no route* means no pool could fill that size "
        "(a fact about liquidity, not an outage); *errors* are timeouts, HTTP errors, rate limits.",
        "",
        health_table(healths, venues + routes),
        "",
    ]
    for section in extra_sections:
        md += [section.rstrip(), ""]
    fees = ", ".join(f"{k} {v:g} bps" for k, v in BASE_TIER_TAKER_BPS.items())
    md += [
        "## Method",
        "",
        "- **Ticks.** The collector snapshots every venue at the same moment on wall-clock-aligned "
        "5-minute slots, then asks Jupiter for quotes (each size bought and sold back to back, "
        "about 2 s apart). Everything is stored in SQLite; this report recomputes from it.",
        "- **Reference mid** = mean of the Kraken and Coinbase mids at the tick (the last known "
        "value if both failed). Cost vs ref: buy `(avg - ref) / ref * 1e4`, sell "
        "`(ref - avg) / ref * 1e4`, in bps; positive is worse.",
        "- **Impact vs own mid** is v1's measure, kept for continuity (`metrics.py`); it misleads "
        "when a venue's own mid is off the market, so the charts use the reference mid.",
        f"- **Order book costs** come from replaying each stored snapshot into the matching "
        f"engine and sending a market order, with price protection: no fill more than "
        f"{max_slippage:.0%} from the tick's reference mid. Sizes the book can't fill inside that "
        f"band are partial fills; they are counted, never charted as full. The same order with "
        f"the band around the venue's own mid (v1's rule) is kept as a secondary table.",
        "- **Half round trip** = `(buy avg - sell avg) / 2 / ref * 1e4` for the same size at the "
        "same tick. It equals the mean of buy and sell cost, and the reference level cancels out, "
        "so price drift between the buy and the sell quote mostly cancels too.",
        "- **Percentiles** use linear interpolation (numpy's default). Medians, not means: one "
        "pulled order on a thin book would move a mean a long way.",
        f"- **Fees** are base-tier taker fees ({fees}; Phoenix's is read from its market account), "
        "always reported next to cost, never mixed in silently (`all-in = cost + fee`).",
        "",
        "## Caveats",
        "",
        "- **Where the protection band sits.** A band around a venue's own mid is only as good "
        "as that mid. Phoenix's book can be lopsided (on 2026-10-18 its best bid sat near $89 "
        "while the market was near $103.7), which drags its mid far from the market, and a "
        "+/-10% band around that mid lets a 'protected' sell fill 14% below the market. So the "
        "headline numbers anchor the band on the reference mid (what a trader's limit price "
        "would do), and the own-mid version is shown separately so the difference is visible.",
        "- **Aggregated exchange levels.** Kraken (top 500 levels per side) and Coinbase publish "
        "price levels, not individual orders; Phoenix's book is every order. Hidden and iceberg "
        "liquidity on the exchanges is invisible here.",
        "- **Trimmed books.** Exchange books are stored only within 25% of mid (anything further "
        "is outside the 10% protection band anyway). Phoenix is stored whole, junk quotes "
        "included.",
        "- **Quotes aren't trades.** A Jupiter quote is what a route would pay at that slot; the "
        "real fill can differ (slippage, priority fees, the pool moving first). Jupiter quotes "
        "carry no price protection, so a thin route quotes whatever its pools would give.",
        "- **Fees are base tier.** Active traders pay a fraction of the exchange fees shown; "
        "Solana transaction and priority fees are not included for on-chain venues.",
        "- **Snapshots, not a feed.** Every 5 minutes we see one picture of each book; what "
        "happens in between (Phoenix's sequence number counts it) is not observed.",
        "- **Reference mid.** Kraken and Coinbase quote SOL/USD while Phoenix and Jupiter trade "
        "SOL/USDC; USDC is assumed to be worth exactly $1.",
        "",
    ]
    return "\n".join(md)


def build_report(
    store: Store,
    out_dir: Path,
    run_id: int | None = None,
    sizes_usd: Sequence[float] = DEFAULT_SIZES_USD,
    max_slippage: float = DEFAULT_MAX_SLIPPAGE,
    use_cache: bool = True,
) -> Path:
    """Write ``REPORT.md`` and its charts into ``out_dir``; return the Markdown's path."""
    sizes = [float(s) for s in sizes_usd]
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    data = load_dataset(store, run_id, sizes, max_slippage, use_cache)
    obs = observations(data.books, data.quotes, data.round_trips)
    summaries = summarize_by_key(obs)
    hourly = by_hour(obs)
    activity = phoenix_activity(data.books)
    healths = health(data.fetches)
    venues, routes = data.venues, [series_name(d) for d in data.dexes]

    chart_paths: dict[str, Path | None] = {
        "spread": charts.spread_over_time(
            obs, venues, out_dir / "spread_over_time.png", data.interval_s
        ),
        "depth": charts.depth_over_time(
            obs, venues, out_dir / "depth_2pct_over_time.png", DEPTH_BAND, data.interval_s
        ),
        "cost_books": charts.cost_vs_size(
            summaries,
            venues,
            sizes,
            out_dir / "cost_vs_size_books.png",
            "Order books: cost of a market order vs the reference mid",
        ),
        "cost_jupiter": charts.cost_vs_size(
            summaries,
            routes,
            sizes,
            out_dir / "cost_vs_size_jupiter.png",
            "Jupiter routes: quoted cost vs the reference mid",
        ),
        "round_trip": charts.round_trip_vs_size(
            summaries, venues + routes, sizes, out_dir / "round_trip_vs_size.png"
        ),
        "hours": charts.hour_of_day(
            hourly,
            venues,
            venues + [r for r in routes if r in ("jupiter:best", "jupiter:SolFi")],
            out_dir / "hour_of_day.png",
        ),
        "phoenix": charts.phoenix_activity(
            activity, out_dir / "phoenix_activity.png", data.interval_s
        ),
    }
    # "Does splitting a big order help?": execution.py replays TWAPs over the same snapshots.
    twap = twap_markdown(store, run_id=run_id)
    md = render_markdown(
        data, summaries, activity, healths, chart_paths, sizes, max_slippage, [twap]
    )
    path = out_dir / "REPORT.md"
    path.write_text(md, encoding="utf-8")
    return path


# ---- CLI --------------------------------------------------------------------------------------


def add_parser(sub: argparse._SubParsersAction) -> None:
    """Register ``report`` on the main parser (``__main__`` calls this)."""
    p = sub.add_parser(
        "report",
        help="REPORT.md + charts from a collector database",
        description="Measure every stored snapshot and quote, then write REPORT.md and PNG charts.",
    )
    p.add_argument("--db", default="data/collect.sqlite", help="collector SQLite file")
    p.add_argument("--out", default="docs/report", help="output folder (default docs/report)")
    p.add_argument("--run", type=int, help="only this run id (default: every run in the file)")
    p.add_argument(
        "--max-slippage",
        type=float,
        default=DEFAULT_MAX_SLIPPAGE * 100,
        help="price protection in %% of mid (default 10)",
    )
    p.add_argument("--no-cache", action="store_true", help="recompute every snapshot's metrics")
    p.set_defaults(handler=cmd_report)


def cmd_report(args: argparse.Namespace) -> None:
    if not Path(args.db).exists():
        sys.exit(f"{args.db} does not exist (collect some data first: collect)")
    # Read-only: the report may run against the live database while the collector writes
    # it, and SQLite then refuses every write (the metrics cache is simply skipped).
    with Store(args.db, readonly=True) as store:
        path = build_report(
            store,
            Path(args.out),
            run_id=args.run,
            max_slippage=args.max_slippage / 100,
            use_cache=not args.no_cache,
        )
    print(f"report -> {path}")
