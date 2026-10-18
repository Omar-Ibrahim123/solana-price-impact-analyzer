"""Average fill price and price impact (bps vs. mid) for simulated market orders.

The simulation runs the real matching engine: for each trade size we load the
snapshot into a fresh ``OrderBook``, send one market order, and measure the
fills it got back. Nothing here re-implements matching.

Impact is measured against the mid price before the trade and signed so that
it is a *cost* in both directions:

    buy:  impact_bps = (avg_fill - mid) / mid * 10_000
    sell: impact_bps = (mid - avg_fill) / mid * 10_000

It therefore includes the half-spread: even a tiny order pays it.

Every order carries price protection: it will not trade more than
``max_slippage`` (default 10%) away from mid. Without it, a large order on a
thin book would "fill" against junk quotes (Phoenix's book has asks at
$9,999,999,999 and bids at $0.001), and the average price would mean nothing.
Sizes that cannot fill inside the band are reported as partial fills.
"""

from __future__ import annotations

import math
from dataclasses import asdict, dataclass

from .convert import load_book
from .orderbook import Side
from .snapshot import BookSnapshot

DEFAULT_SIZES_USD = (1_000, 10_000, 100_000, 1_000_000)
DEFAULT_MAX_SLIPPAGE = 0.10  # 10% from mid


@dataclass(frozen=True, slots=True)
class ImpactResult:
    venue: str
    side: str  # "buy" or "sell"
    target_usd: float  # trade size we asked for
    filled_usd: float  # what the book could actually absorb
    filled_base: float  # SOL traded
    avg_price: float | None
    mid_price: float
    impact_bps: float | None  # None if nothing filled
    levels_swept: int  # distinct price levels touched
    fully_filled: bool

    def as_dict(self) -> dict:
        return asdict(self)


def protection_limit(snapshot: BookSnapshot, side: Side, mid: float, max_slippage: float) -> int:
    """The worst price, in ticks, a taker on ``side`` accepts: ``mid * (1 +/- max_slippage)``."""
    if side is Side.BID:
        return math.floor(mid * (1 + max_slippage) / float(snapshot.tick_size))
    return math.ceil(mid * (1 - max_slippage) / float(snapshot.tick_size))


def lots_for_notional(
    snapshot: BookSnapshot, side: Side, target_usd: float, limit_ticks: int | None = None
) -> int:
    """How many lots a taker on ``side`` must trade to spend (or raise) ``target_usd``.

    Walks the opposite side's levels from the best price, accumulating USD until
    the target is reached. The last level is taken partially, rounded up to a
    whole lot so the order spends at least ``target_usd``. If the whole side is
    worth less than the target, returns every lot on that side. Levels beyond
    ``limit_ticks`` are not counted.
    """
    levels = snapshot.asks if side is Side.BID else snapshot.bids
    remaining = target_usd
    lots = 0
    for o in levels:
        if limit_ticks is not None and (
            o.price_ticks > limit_ticks if side is Side.BID else o.price_ticks < limit_ticks
        ):
            break
        price = snapshot.price(o.price_ticks)
        level_usd = price * snapshot.size(o.size_lots)
        if level_usd >= remaining:
            usd_per_lot = price * float(snapshot.lot_size)
            needed = -(-remaining // usd_per_lot)  # ceiling division
            return lots + min(int(needed), o.size_lots)
        lots += o.size_lots
        remaining -= level_usd
    return lots


def simulate(
    snapshot: BookSnapshot,
    side: str,
    target_usd: float,
    max_slippage: float = DEFAULT_MAX_SLIPPAGE,
    anchor: float | None = None,
) -> ImpactResult:
    """Simulate one market order of ``target_usd`` on ``snapshot``.

    ``side`` is ``"buy"`` (lifts asks) or ``"sell"`` (hits bids). The order
    trades no further than ``max_slippage`` from ``anchor``, which defaults to
    the book's own mid. Pass another fair price (``metrics.py`` passes the
    exchanges' reference mid) when the book's own mid can't be trusted.
    Impact is always measured against the book's own mid.
    """
    if side not in ("buy", "sell"):
        raise ValueError(f"side must be 'buy' or 'sell', got {side!r}")
    if target_usd <= 0:
        raise ValueError("target_usd must be positive")
    mid = snapshot.mid_price()
    if mid is None:
        raise ValueError(f"{snapshot.venue}: cannot measure impact on a one-sided book")

    taker = Side.BID if side == "buy" else Side.ASK
    limit = protection_limit(snapshot, taker, mid if anchor is None else anchor, max_slippage)
    lots = lots_for_notional(snapshot, taker, target_usd, limit)
    fills = load_book(snapshot).market_order(taker, lots, limit) if lots > 0 else []

    filled_lots = sum(f.size_lots for f in fills)
    filled_usd = sum(snapshot.price(f.price_ticks) * snapshot.size(f.size_lots) for f in fills)
    filled_base = snapshot.size(filled_lots)
    avg = filled_usd / filled_base if filled_base else None
    if avg is None:
        impact = None
    elif side == "buy":
        impact = (avg - mid) / mid * 10_000
    else:
        impact = (mid - avg) / mid * 10_000

    return ImpactResult(
        venue=snapshot.venue,
        side=side,
        target_usd=float(target_usd),
        filled_usd=filled_usd,
        filled_base=filled_base,
        avg_price=avg,
        mid_price=mid,
        impact_bps=impact,
        levels_swept=len({f.price_ticks for f in fills}),
        # Within one lot of the target counts as full (lot rounding).
        fully_filled=filled_usd >= target_usd * 0.999,
    )


def impact_curve(
    snapshot: BookSnapshot,
    side: str = "buy",
    sizes_usd=DEFAULT_SIZES_USD,
    max_slippage: float = DEFAULT_MAX_SLIPPAGE,
) -> list[ImpactResult]:
    return [simulate(snapshot, side, s, max_slippage) for s in sizes_usd]


def log_spaced_sizes(lo: float = 1_000, hi: float = 1_000_000, per_decade: int = 8) -> list[float]:
    """Trade sizes evenly spaced on a log scale, for smooth chart curves."""
    import math

    n = round(math.log10(hi / lo) * per_decade)
    return [lo * (hi / lo) ** (i / n) for i in range(n + 1)]
