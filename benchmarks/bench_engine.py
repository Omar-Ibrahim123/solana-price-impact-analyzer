"""Replay random order flow through the engine and report throughput.

    python -m benchmarks.bench_engine              # 1,000,000 events
    python -m benchmarks.bench_engine -n 100000    # quicker run
    python -m benchmarks.bench_engine --markdown   # README table: throughput + per-op latency

The event stream is generated up front so only the engine is timed.
"""

from __future__ import annotations

import argparse
import gc
import math
import platform
import statistics
import time

from benchmarks.order_flow import Add, Cancel, Event, Market, generate
from impact_analyzer.orderbook import OrderBook, Side

SIDES = {"bid": Side.BID, "ask": Side.ASK}

# Row labels for --markdown, in table order.
ADD_EXISTING = "add, rests at an existing level"
ADD_NEW = "add, creates a new level"
CANCEL_HIT = "cancel, order is resting"
CANCEL_MISS = "cancel, order already filled (no-op)"
MARKET = "market order"
OPS = (ADD_EXISTING, ADD_NEW, CANCEL_HIT, CANCEL_MISS, MARKET)


def replay(book: OrderBook, events: list[Event]) -> float:
    """Apply every event to ``book``; return elapsed seconds."""
    add, cancel, market = book.add_order, book.cancel_order, book.market_order
    start = time.perf_counter()
    for e in events:
        if type(e) is Add:
            add(e.order_id, SIDES[e.side], e.price_ticks, e.size_lots)
        elif type(e) is Cancel:
            cancel(e.order_id)
        else:
            market(SIDES[e.side], e.size_lots)
    return time.perf_counter() - start


def replay_per_op(book: OrderBook, events: list[Event]) -> dict[str, list[int]]:
    """Apply every event, timing each engine call on its own. Returns ns samples per op type.

    Only the engine call sits between the two clock reads. Deciding which row an event belongs
    to (does its price level exist yet? is the order still resting?) happens before the first
    read, so it isn't timed.
    """
    add, cancel, market = book.add_order, book.cancel_order, book.market_order
    clock = time.perf_counter_ns
    samples: dict[str, list[int]] = {op: [] for op in OPS}
    for e in events:
        if type(e) is Add:
            side = SIDES[e.side]
            # order_flow never crosses (bids below mid, asks above), so every add rests.
            levels = book.bids if side is Side.BID else book.asks
            op = ADD_EXISTING if e.price_ticks in levels else ADD_NEW
            t0 = clock()
            add(e.order_id, side, e.price_ticks, e.size_lots)
            t1 = clock()
        elif type(e) is Cancel:
            # order_flow cancels ids that market orders may already have filled.
            op = CANCEL_HIT if e.order_id in book.orders else CANCEL_MISS
            t0 = clock()
            cancel(e.order_id)
            t1 = clock()
        else:
            op = MARKET
            side = SIDES[e.side]
            t0 = clock()
            market(side, e.size_lots)
            t1 = clock()
        samples[op].append(t1 - t0)
    return samples


def timer_overhead_ns(n: int = 100_000) -> int:
    """Median of two back-to-back clock reads: the floor under every per-op number."""
    clock = time.perf_counter_ns
    gaps = []
    for _ in range(n):
        t0 = clock()
        t1 = clock()
        gaps.append(t1 - t0)
    return int(statistics.median(gaps))


def percentile(sorted_ns: list[int], p: float) -> int:
    """Nearest-rank percentile of an already sorted list (p in 0..100]: the smallest sample
    that at least p% of samples are less than or equal to."""
    return sorted_ns[max(0, math.ceil(p / 100 * len(sorted_ns)) - 1)]


def markdown(n_events: int, seed: int) -> str:
    events = list(generate(n_events, seed=seed))  # generated before any timing starts
    warmup = list(generate(min(n_events, 100_000), seed=seed + 1))

    # timeit's convention: switch the cyclic garbage collector off while timing, so a collection
    # pass (triggered by allocation counts, not by the engine) can't land inside one op and
    # inflate its p99. The engine doesn't need it: unlinked nodes are freed by reference counting.
    gc.collect()
    gc.disable()
    try:
        # Warm-up: let CPython 3.11+ specialise the hot bytecode and fill its caches before
        # anything is measured. The warm-up book is thrown away.
        replay(OrderBook(), warmup)
        elapsed = replay(OrderBook(), events)  # throughput: one clock read pair for the lot
        replay_per_op(OrderBook(), warmup)
        samples = replay_per_op(OrderBook(), events)  # same stream again, each call timed
    finally:
        gc.enable()

    clock = time.get_clock_info("perf_counter")
    lines = [
        f"Machine: {platform.processor() or platform.machine()}, "
        f"Python {platform.python_version()} ({platform.system()}). "
        f"{len(events):,} events (seed {seed}). Timer resolution "
        f"{clock.resolution * 1e9:.0f} ns (percentiles are multiples of it); "
        f"two back-to-back timer reads: {timer_overhead_ns()} ns median.",
        "",
        f"Throughput: **{len(events) / elapsed:,.0f} events/s** "
        f"({elapsed / len(events) * 1e9:,.0f} ns/event mean).",
        "",
        "| Operation | Count | Mean (ns) | p50 (ns) | p99 (ns) |",
        "| --- | ---: | ---: | ---: | ---: |",
    ]
    for op in OPS:
        xs = sorted(samples[op])
        if not xs:
            continue
        lines.append(
            f"| {op} | {len(xs):,} | {statistics.fmean(xs):,.0f} | "
            f"{percentile(xs, 50):,} | {percentile(xs, 99):,} |"
        )
    lines += [
        "",
        "Throughput is a separate run with no per-op clock reads. Per-op times are single engine "
        "calls, so they include Python's method-call overhead and the timer reads. Garbage "
        "collector off while timing (as in timeit); warm-up run first.",
    ]
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("-n", "--events", type=int, default=1_000_000)
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument(
        "--markdown", action="store_true", help="print a Markdown table with per-op latency"
    )
    args = parser.parse_args()

    if args.markdown:
        print(markdown(args.events, args.seed))
        return

    events = list(generate(args.events, seed=args.seed))
    counts = {kind.__name__: sum(type(e) is kind for e in events) for kind in (Add, Cancel, Market)}
    book = OrderBook()
    elapsed = replay(book, events)

    print(f"events     {len(events):>12,}  {counts}")
    print(f"elapsed    {elapsed:>12.3f} s")
    print(f"throughput {len(events) / elapsed:>12,.0f} events/s")
    print(f"latency    {elapsed / len(events) * 1e6:>12.2f} us/event (mean)")
    print(
        f"resting    {len(book.orders):>12,} orders, "
        f"{len(book.bids)} bid / {len(book.asks)} ask levels"
    )


if __name__ == "__main__":
    main()
