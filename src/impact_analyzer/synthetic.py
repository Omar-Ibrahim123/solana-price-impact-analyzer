"""Made-up but realistic-looking order books, for offline demos and tests.

``python -m impact_analyzer demo`` uses these so the whole pipeline (engine,
impact, chart, playground export) runs with no network at all. They are not
data: never put numbers from them in the README findings.
"""

from __future__ import annotations

import random
import time
from decimal import Decimal

from .snapshot import BookSnapshot, RestingOrder


def synthetic_book(
    venue: str,
    mid: float = 150.0,
    spread_bps: float = 2.0,
    levels: int = 200,
    level_step_bps: float = 1.0,
    base_size_sol: float = 20.0,
    growth: float = 1.03,
    orders_per_level: int = 3,
    seed: int = 0,
) -> BookSnapshot:
    """A book whose level sizes grow geometrically away from mid (as real books do).

    Ticks are $0.001 and lots 0.001 SOL, like Phoenix SOL/USDC.
    """
    rng = random.Random(seed)
    tick, lot = Decimal("0.001"), Decimal("0.001")
    to_ticks = lambda price: round(price / float(tick))  # noqa: E731
    half = spread_bps / 2 / 10_000

    def side(sign: int) -> list[RestingOrder]:
        out = []
        last = None
        for i in range(levels):
            price = mid * (1 + sign * (half + i * level_step_bps / 10_000))
            ticks = to_ticks(price)
            if ticks == last:
                continue
            last = ticks
            level_sol = base_size_sol * growth**i * rng.uniform(0.5, 1.5)
            for _ in range(rng.randint(1, orders_per_level)):
                lots = max(1, round(level_sol / orders_per_level / float(lot)))
                out.append(RestingOrder(ticks, lots))
        return out

    snap = BookSnapshot(
        venue=venue,
        symbol="SOL/USD (synthetic)",
        fetched_at=time.time(),
        tick_size=tick,
        lot_size=lot,
        bids=side(-1),
        asks=side(+1),
        meta={"synthetic": True, "seed": seed},
    )
    snap.validate()
    return snap


def demo_books() -> list[BookSnapshot]:
    """A thinner on-chain style book and a deeper exchange style book."""
    return [
        synthetic_book("demo-dex", spread_bps=4.0, base_size_sol=15.0, growth=1.02, seed=1),
        synthetic_book("demo-cex", spread_bps=0.7, base_size_sol=60.0, growth=1.03, seed=2),
    ]
