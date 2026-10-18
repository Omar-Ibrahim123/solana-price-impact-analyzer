"""Reproducible random order flow for benchmarking the matching engine.

The events are plain data, independent of the engine's API, so the same stream can be
replayed against any implementation. Prices are integer ticks and sizes are integer lots.
"""

from __future__ import annotations

import random
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Literal

Side = Literal["bid", "ask"]


@dataclass(frozen=True, slots=True)
class Add:
    order_id: int
    side: Side
    price_ticks: int
    size_lots: int


@dataclass(frozen=True, slots=True)
class Cancel:
    order_id: int


@dataclass(frozen=True, slots=True)
class Market:
    side: Side
    size_lots: int


Event = Add | Cancel | Market


def generate(
    n_events: int,
    *,
    seed: int = 0,
    mid_ticks: int = 15_000,
    max_offset_ticks: int = 50,
    p_add: float = 0.6,
    p_cancel: float = 0.3,
) -> Iterator[Event]:
    """Yield `n_events` random events; the remainder probability goes to market orders.

    Limit orders rest on their own side of `mid_ticks` (bids below, asks above), so they
    build a book rather than crossing immediately. Cancels target a random previously added
    id, which may already have been filled by a market order: the engine must treat a
    cancel of an unknown id as a no-op, exactly like a real exchange racing a fill.
    """
    rng = random.Random(seed)
    live: list[int] = []
    next_id = 1
    for _ in range(n_events):
        r = rng.random()
        if r < p_add or (not live and r < p_add + p_cancel):
            side: Side = "bid" if rng.random() < 0.5 else "ask"
            offset = rng.randint(1, max_offset_ticks)
            price = mid_ticks - offset if side == "bid" else mid_ticks + offset
            yield Add(next_id, side, price, rng.randint(1, 100))
            live.append(next_id)
            next_id += 1
        elif r < p_add + p_cancel:
            # Swap-remove keeps picking a random live id O(1).
            i = rng.randrange(len(live))
            live[i], live[-1] = live[-1], live[i]
            yield Cancel(live.pop())
        else:
            yield Market("bid" if rng.random() < 0.5 else "ask", rng.randint(1, 300))
