"""Command line: ``python -m impact_analyzer <command>``.

fetch     pull live snapshots (Phoenix, Kraken, Coinbase) into data/
analyze   simulate market orders on saved snapshots; print a table,
          write results JSON, the chart, and a playground export
run       fetch, then analyze what was just fetched
demo      analyze made-up books (no network), to try everything offline
collect   snapshot every venue + Jupiter quotes on a schedule into SQLite
status    progress and health of the newest collector run
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
import time
from datetime import UTC, datetime
from pathlib import Path

from .amm import depth_within, equivalent_pool
from .impact import (
    DEFAULT_MAX_SLIPPAGE,
    DEFAULT_SIZES_USD,
    ImpactResult,
    impact_curve,
    log_spaced_sizes,
)
from .snapshot import BookSnapshot
from .venues import FETCHERS, VENUES


def fetch_one(venue: str, rpc_url: str | None) -> BookSnapshot:
    from .net import Http

    with Http() as http:
        return FETCHERS[venue](http, rpc_url).snapshot


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
        bid2, ask2 = depth_within(snap, 0.02)
        print(
            f"  {venue:<9} mid ${snap.mid_price():,.4f}  spread {snap.spread_bps():.2f} bps  "
            f"{len(snap.bids)} bids / {len(snap.asks)} asks  "
            f"within 2%: ${bid2:,.0f} bid / ${ask2:,.0f} ask  -> {path}"
        )
    return paths


def latest_snapshots(data_dir: Path) -> list[Path]:
    """The newest saved snapshot for each venue in ``data_dir``."""
    latest: dict[str, Path] = {}
    for p in sorted(Path(data_dir).glob("*-*-*.json")):  # names sort by timestamp
        venue = p.name.split("-")[0]
        if venue in VENUES:
            latest[venue] = p
    return [latest[v] for v in VENUES if v in latest]


def fmt_bps(r: ImpactResult) -> str:
    if r.impact_bps is None:
        return "—"
    if r.fully_filled:
        return f"{r.impact_bps:.2f}"
    return f"{r.impact_bps:.1f}* (${_short(r.filled_usd)})"  # partial: show what filled


def print_table(table: dict[str, dict[str, list[ImpactResult]]], max_slippage: float) -> None:
    sizes = [r.target_usd for r in next(iter(table.values()))["buy"]]
    header = f"{'venue':<10}{'side':<6}" + "".join(f"{'$' + _short(s):>16}" for s in sizes)
    print(header)
    print("-" * len(header))
    for venue, by_side in table.items():
        for side in ("buy", "sell"):
            print(f"{venue:<10}{side:<6}" + "".join(f"{fmt_bps(r):>16}" for r in by_side[side]))
    print("impact in bps vs. mid, including half the spread.")
    print(
        f"* = partial fill (amount filled in brackets): too little within {max_slippage:.0%} of mid"
    )


def _short(usd: float) -> str:
    for div, suffix in ((1e6, "M"), (1e3, "K")):
        if usd >= div:
            return f"{float(f'{usd / div:.3g}'):g}{suffix}"
    return f"{usd:.0f}"


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


def analyze(
    snaps: list[BookSnapshot],
    out_dir: Path,
    chart_path: Path,
    prefix: str,
    max_slippage: float = DEFAULT_MAX_SLIPPAGE,
) -> None:
    if not snaps:
        sys.exit("no snapshots to analyze (run `python -m impact_analyzer fetch` first)")

    def curve(s: BookSnapshot, side: str, sizes=DEFAULT_SIZES_USD) -> list[ImpactResult]:
        return impact_curve(s, side, sizes, max_slippage)

    table = {s.venue: {side: curve(s, side) for side in ("buy", "sell")} for s in snaps}
    print()
    print_table(table, max_slippage)

    # Smooth curves (8 sizes per decade) for the chart and playground.
    sizes = log_spaced_sizes(1_000, 1_000_000)
    curves = {s.venue: {side: curve(s, side, sizes) for side in ("buy", "sell")} for s in snaps}

    # Benchmark AMM: as deep near the price as the on-chain book (Phoenix if we have it).
    base = next((s for s in snaps if s.venue == "phoenix"), snaps[0])
    amm = equivalent_pool(base) if base.mid_price() else None

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
            f"(as deep within 2% of mid as {base.venue})"
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
    for p in sub.choices.values():
        p.add_argument(
            "--max-slippage",
            type=float,
            default=DEFAULT_MAX_SLIPPAGE * 100,
            help="price protection: never trade more than this %% from mid (default 10)",
        )

    add_collect_parsers(sub)

    args = parser.parse_args(argv)
    if args.command in ("collect", "status"):
        return cmd_collect_or_status(args)
    data_dir = Path(args.data_dir)
    band = args.max_slippage / 100

    if args.command == "fetch":
        cmd_fetch(args)
    elif args.command == "run":
        paths = cmd_fetch(args)
        analyze([BookSnapshot.load(p) for p in paths], data_dir, Path(args.chart), "", band)
    elif args.command == "analyze":
        paths = [Path(p) for p in args.snapshots] or latest_snapshots(data_dir)
        analyze([BookSnapshot.load(p) for p in paths], data_dir, Path(args.chart), "", band)
    elif args.command == "demo":
        from .synthetic import demo_books

        print("Synthetic books (not real data):")
        analyze(demo_books(), data_dir, Path(args.chart), "demo-", band)


def add_collect_parsers(sub: argparse._SubParsersAction) -> None:
    from . import jupiter

    p = sub.add_parser(
        "collect",
        help="snapshot every venue on a schedule into SQLite",
        description="Take a snapshot of every venue (and Jupiter quotes) every --every, for "
        "--duration, into a SQLite database. Safe to stop with Ctrl+C and to --resume.",
    )
    p.add_argument("--every", default="5m", help="interval between ticks (default 5m)")
    p.add_argument("--duration", default="24h", help="how long to run (default 24h)")
    p.add_argument("--db", default="data/collect.sqlite", help="SQLite file (created if missing)")
    p.add_argument("--resume", action="store_true", help="continue the newest unfinished run")
    p.add_argument("--venues", nargs="+", choices=VENUES, default=list(VENUES))
    p.add_argument("--rpc", help="Solana RPC URL (default: $SOLANA_RPC_URL or mainnet-beta)")
    p.add_argument("--no-jupiter", action="store_true", help="skip Jupiter AMM quotes")
    p.add_argument(
        "--jupiter-dexes",
        nargs="+",
        choices=list(jupiter.DEX_FILTERS),
        default=list(jupiter.DEFAULT_DEXES),
        metavar="DEX",
        help="route filters to quote, from %(choices)s (default: all but HumidiFi)",
    )
    p.add_argument(
        "--jupiter-sizes",
        nargs="+",
        type=float,
        default=list(jupiter.DEFAULT_SIZES_USD),
        metavar="USD",
        help="trade sizes to quote (default: 1000 10000 100000 1000000)",
    )
    p.add_argument(
        "--jupiter-rps",
        type=float,
        default=jupiter.DEFAULT_RPS,
        help="max Jupiter requests per second (default %(default)s; the free tier allows 0.5)",
    )
    p.add_argument("--log", help="also append the log to this file")
    p.add_argument(
        "--allow-sleep",
        action="store_true",
        help="don't ask Windows to stay awake while collecting",
    )

    p = sub.add_parser("status", help="progress and health of the newest collector run")
    p.add_argument("--db", default="data/collect.sqlite")


def cmd_collect_or_status(args: argparse.Namespace) -> None:
    from .collector import CollectConfig, format_status, parse_duration, run_collector
    from .store import Store

    if args.command == "status":
        if not Path(args.db).exists():
            sys.exit(f"{args.db} does not exist yet (start one with: collect)")
        with Store(args.db) as store:
            print(format_status(store))
        return

    handlers: list[logging.Handler] = [logging.StreamHandler(sys.stdout)]
    if args.log:
        Path(args.log).parent.mkdir(parents=True, exist_ok=True)
        handlers.append(logging.FileHandler(args.log, encoding="utf-8"))
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)-7s %(message)s",
        datefmt="%H:%M:%S",
        handlers=handlers,
        force=True,
    )
    logging.getLogger("httpx").setLevel(logging.WARNING)  # a line per request is too noisy
    config = CollectConfig(
        interval_s=parse_duration(args.every),
        duration_s=parse_duration(args.duration),
        venues=args.venues,
        rpc=args.rpc,
        jupiter=not args.no_jupiter,
        jupiter_dexes=args.jupiter_dexes,
        jupiter_sizes=args.jupiter_sizes,
        jupiter_rps=args.jupiter_rps,
    )
    with Store(args.db) as store:
        run_collector(store, config, resume=args.resume, keep_awake=not args.allow_sleep)


if __name__ == "__main__":
    main()
