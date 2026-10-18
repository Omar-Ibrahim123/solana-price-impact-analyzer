"""Constant-product AMM (x * y = k) for comparison with the order books.

A pool holds ``x`` USD and ``y`` SOL. A buyer adds ``dx`` USD and receives
``y - k / (x + dx)`` SOL; the price moves continuously along the curve. With
no fees, impact for small trades is about ``dx / x`` (in bps: ``dx / x * 1e4``),
so doubling the pool halves the impact.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from .snapshot import BookSnapshot


@dataclass(frozen=True, slots=True)
class AmmPool:
    usd_reserve: float
    sol_reserve: float
    fee_bps: float = 0.0

    @classmethod
    def at_price(cls, price: float, usd_reserve: float, fee_bps: float = 0.0) -> AmmPool:
        """A pool whose spot price is ``price`` and that holds ``usd_reserve`` per side."""
        return cls(usd_reserve, usd_reserve / price, fee_bps)

    @property
    def spot_price(self) -> float:
        return self.usd_reserve / self.sol_reserve

    def buy_impact_bps(self, usd_in: float) -> float:
        """Impact of spending ``usd_in`` on SOL, versus the spot price before the trade."""
        x, y = self.usd_reserve, self.sol_reserve
        dx = usd_in * (1 - self.fee_bps / 10_000)  # the fee stays in the pool
        sol_out = y - (x * y) / (x + dx)
        avg = usd_in / sol_out
        return (avg - self.spot_price) / self.spot_price * 10_000

    def sell_impact_bps(self, usd_out: float) -> float:
        """Impact of selling enough SOL to receive ``usd_out``, versus spot."""
        x, y = self.usd_reserve, self.sol_reserve
        if usd_out >= x:
            raise ValueError("cannot withdraw the whole USD reserve")
        # Solve (x - usd_out) * (y + dy) = x * y for dy (SOL sent in, before fee).
        dy_after_fee = x * y / (x - usd_out) - y
        dy = dy_after_fee / (1 - self.fee_bps / 10_000)
        avg = usd_out / dy
        return (self.spot_price - avg) / self.spot_price * 10_000


def depth_within(snapshot: BookSnapshot, band: float) -> tuple[float, float]:
    """USD resting within ``band`` (e.g. 0.02 = 2%) of mid, as ``(bid_usd, ask_usd)``."""
    mid = snapshot.mid_price()
    if mid is None:
        raise ValueError("one-sided book")
    bid_usd = sum(
        snapshot.price(o.price_ticks) * snapshot.size(o.size_lots)
        for o in snapshot.bids
        if snapshot.price(o.price_ticks) >= mid * (1 - band)
    )
    ask_usd = sum(
        snapshot.price(o.price_ticks) * snapshot.size(o.size_lots)
        for o in snapshot.asks
        if snapshot.price(o.price_ticks) <= mid * (1 + band)
    )
    return bid_usd, ask_usd


def equivalent_pool(snapshot: BookSnapshot, band: float = 0.02) -> AmmPool:
    """An AMM pool with the same liquidity near the price as ``snapshot``.

    In a constant-product pool the spot price is ``x / y``. Buying until the
    price rises by ``band`` takes ``x * (sqrt(1 + band) - 1)`` USD; selling until
    it falls by ``band`` raises ``x * (1 - sqrt(1 - band))``. Setting those equal
    to the order book's depth inside the band and solving for ``x`` gives a pool
    that is "as deep" as the book near mid; we average the two sides.
    """
    bid_usd, ask_usd = depth_within(snapshot, band)
    x_from_asks = ask_usd / (math.sqrt(1 + band) - 1)
    x_from_bids = bid_usd / (1 - math.sqrt(1 - band))
    return AmmPool.at_price(snapshot.mid_price(), (x_from_asks + x_from_bids) / 2)
