"""Replay random order flow through the engine and report throughput.

    python -m benchmarks.bench_engine            # 1,000,000 events
    python -m benchmarks.bench_engine -n 100000  # quicker run

The event stream is generated up front so only the engine is timed.
"""

from __future__ import annotations

import argparse
import time

from benchmarks.order_flow import Add, Cancel, Event, Market, generate
from impact_analyzer.orderbook import OrderBook, Side

SIDES = {"bid": Side.BID, "ask": Side.ASK}


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


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("-n", "--events", type=int, default=1_000_000)
    parser.add_argument("--seed", type=int, default=0)
    args = parser.parse_args()

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
