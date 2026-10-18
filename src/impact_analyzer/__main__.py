"""Command line: ``python -m impact_analyzer <command>``.

fetch     pull live snapshots (Phoenix, Kraken, Coinbase) into data/
analyze   simulate market orders on saved snapshots; print a table,
          write results JSON, the chart, and a playground export
run       fetch, then analyze what was just fetched
demo      analyze made-up books (no network), to try everything offline
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import UTC, datetime
from pathlib import Path

from .amm import equivalent_pool
from .impact import ImpactResult, impact_curve, log_spaced_sizes
from .snapshot import BookSnapshot

VENUES = ("phoenix", "kraken", "coinbase")


def fetch_one(venue: str, rpc_url: str | None) -> BookSnapshot:
    if venue == "phoenix":
        from .phoenix import fetch_snapshot

        return fetch_snapshot(rpc_url)
    from . import cex

    return cex.fetch_kraken() if venue == "kraken" else cex.fetch_coinbase()


def cmd_fetch(args: argparse.Namespace) -> list[Path]:
    stamp = datetime.now(UTC).strftime("%Y%m%d-%H%M%S")
    paths = []
    for venue in args.venues:
        try:
            snap = fetch_one(venue, args.rpc)
        except Exception as e:  # one venue failing shouldn't lose the others
            print(f"  {venue:<9} FAILED: {type(e).__name__}: {e}", file=sys.stderr)
            continue
        path = Path(args.data_dir) / f"{venue}-{stamp}.json"
        snap.save(path)
        paths.append(path)
        print(
            f"  {venue:<9} mid ${snap.mid_price():,.4f}  spread {snap.spread_bps():.2f} bps  "
            f"{len(snap.bids)} bids / {len(snap.asks)} asks  "
            f"depth ${snap.notional('bid'):,.0f} / ${snap.notional('ask'):,.0f}  -> {path}"
        )
    return paths


def latest_snapshots(data_dir: Path) -> list[Path]:
    """The newest saved snapshot for each venue in ``data_dir``."""
    latest: dict[str, Path] = {}
    for p in sorted(Path(data_dir).glob("*-*-*.json")):  # names sort by timestamp
        venue = p.name.split("-")[0]
        if venue in VENUES:
            latest[venue] = p
    return list(latest.values())


def fmt_bps(r: ImpactResult) -> str:
    if r.impact_bps is None:
        return "—"
    return f"{r.impact_bps:.2f}" + ("" if r.fully_filled else "*")


def print_table(table: dict[str, dict[str, list[ImpactResult]]]) -> None:
    sizes = [r.target_usd for r in next(iter(table.values()))["buy"]]
    header = f"{'venue':<10}{'side':<6}" + "".join(f"{'$' + _short(s):>12}" for s in sizes)
    print(header)
    print("-" * len(header))
    for venue, by_side in table.items():
        for side in ("buy", "sell"):
            print(f"{venue:<10}{side:<6}" + "".join(f"{fmt_bps(r):>12}" for r in by_side[side]))
    print("impact in bps vs. mid, includes half the spread.  * = book exhausted (partial fill)")


def _short(usd: float) -> str:
    for div, suffix in ((1e6, "M"), (1e3, "K")):
        if usd >= div:
            return f"{usd / div:g}{suffix}"
    return f"{usd:g}"


def export_for_playground(
    snaps: list[BookSnapshot], curves: dict, amm_usd: float | None, max_levels: int = 400
) -> dict:
    """Aggregate each book by price level, in USD and SOL, for the web playground."""

    def levels(snap: BookSnapshot, orders) -> list[list[float]]:
        agg: dict[int, int] = {}
        for o in orders:  # dicts keep insertion order: best price first
            agg[o.price_ticks] = agg.get(o.price_ticks, 0) + o.size_lots
        items = list(agg.items())[:max_levels]
        return [[snap.price(p), snap.size(s)] for p, s in items]

    venues = []
    for snap in snaps:
        c = curves[snap.venue]
        venues.append(
            {
                "venue": snap.venue,
                "symbol": snap.symbol,
                "fetched_at": snap.fetched_at,
                "mid": snap.mid_price(),
                "spread_bps": snap.spread_bps(),
                "bids": levels(snap, snap.bids),
                "asks": levels(snap, snap.asks),
                "curve": {
                    side: [[r.target_usd, r.impact_bps, r.fully_filled] for r in c[side]]
                    for side in ("buy", "sell")
                },
                "meta": snap.meta,
            }
        )
    return {
        "kind": "impact-analyzer-export",
        "version": 1,
        "generated_at": time.time(),
        "venues": venues,
        "amm_usd_reserve": amm_usd,
    }


def analyze(snaps: list[BookSnapshot], out_dir: Path, chart_path: Path, prefix: str) -> None:
    if not snaps:
        sys.exit("no snapshots to analyze (run `python -m impact_analyzer fetch` first)")
    table = {s.venue: {side: impact_curve(s, side) for side in ("buy", "sell")} for s in snaps}
    print()
    print_table(table)

    # Smooth curves (8 sizes per decade) for the chart and playground.
    sizes = log_spaced_sizes(1_000, 1_000_000)
    curves = {
        s.venue: {side: impact_curve(s, side, sizes) for side in ("buy", "sell")} for s in snaps
    }

    # Benchmark AMM: as deep near the price as the first (on-chain) book.
    amm = equivalent_pool(snaps[0]) if snaps[0].mid_price() else None

    out_dir.mkdir(parents=True, exist_ok=True)
    results_path = out_dir / f"{prefix}results.json"
    results_path.write_text(
        json.dumps(
            {
                venue: {side: [r.as_dict() for r in rs] for side, rs in by_side.items()}
                for venue, by_side in table.items()
            },
            indent=2,
        )
    )
    export_path = out_dir / f"{prefix}playground.json"
    export_path.write_text(
        json.dumps(export_for_playground(snaps, curves, amm.usd_reserve if amm else None))
    )
    from .plot import plot_impact

    plot_impact(curves, chart_path, amm=amm)
    print()
    if amm:
        print(
            f"AMM benchmark: x*y=k pool with ${amm.usd_reserve:,.0f} per side "
            f"(as deep within 2% of mid as {snaps[0].venue})"
        )
    print(f"results     -> {results_path}")
    print(f"chart       -> {chart_path}")
    print(f"playground  -> {export_path}  (paste into the Order Book Playground)")


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(
        prog="python -m impact_analyzer",
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--data-dir", default="data", help="where snapshots and results go")
    sub = parser.add_subparsers(dest="command", required=True)

    for name in ("fetch", "run"):
        p = sub.add_parser(name)
        p.add_argument("--venues", nargs="+", choices=VENUES, default=list(VENUES))
        p.add_argument("--rpc", help="Solana RPC URL (default: $SOLANA_RPC_URL or mainnet-beta)")
        p.add_argument("--chart", default="docs/impact.png")
    p = sub.add_parser("analyze")
    p.add_argument("snapshots", nargs="*", help="snapshot files (default: newest per venue)")
    p.add_argument("--chart", default="docs/impact.png")
    p = sub.add_parser("demo")
    p.add_argument("--chart", default="data/demo-impact.png")

    args = parser.parse_args(argv)
    data_dir = Path(args.data_dir)

    if args.command == "fetch":
        cmd_fetch(args)
    elif args.command == "run":
        paths = cmd_fetch(args)
        analyze([BookSnapshot.load(p) for p in paths], data_dir, Path(args.chart), "")
    elif args.command == "analyze":
        paths = [Path(p) for p in args.snapshots] or latest_snapshots(data_dir)
        analyze([BookSnapshot.load(p) for p in paths], data_dir, Path(args.chart), "")
    elif args.command == "demo":
        from .synthetic import demo_books

        print("Synthetic books (not real data):")
        analyze(demo_books(), data_dir, Path(args.chart), "demo-")


if __name__ == "__main__":
    main()
