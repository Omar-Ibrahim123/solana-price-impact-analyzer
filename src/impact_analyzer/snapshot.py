"""A venue-neutral order book snapshot.

Every fetcher (Phoenix, Kraken, Coinbase) produces a ``BookSnapshot``, and
everything downstream (the engine, the impact simulator, the chart) only ever
sees this type. That is what makes the venue comparison fair: the same code
path runs for every venue.

Prices and sizes are stored as integers, exactly like the engine wants them:

    price in USD = price_ticks * tick_size
    size in SOL  = size_lots   * lot_size

``tick_size`` and ``lot_size`` are ``Decimal`` so the conversion is exact.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from decimal import Decimal
from pathlib import Path


@dataclass(frozen=True, slots=True)
class RestingOrder:
    """One resting order, or one aggregated level for venues that only publish levels."""

    price_ticks: int
    size_lots: int


@dataclass(slots=True)
class BookSnapshot:
    venue: str  # "phoenix", "kraken", "coinbase", ...
    symbol: str  # human label, e.g. "SOL/USDC"
    fetched_at: float  # unix seconds
    tick_size: Decimal  # USD per tick
    lot_size: Decimal  # SOL per lot
    # Priority order: best price first, and within a price, oldest first.
    bids: list[RestingOrder] = field(default_factory=list)
    asks: list[RestingOrder] = field(default_factory=list)
    meta: dict = field(default_factory=dict)  # venue-specific extras (slot, address, ...)

    # ---- unit conversion ----------------------------------------------------

    def price(self, ticks: int | float) -> float:
        return float(Decimal(str(ticks)) * self.tick_size)

    def size(self, lots: int | float) -> float:
        return float(Decimal(str(lots)) * self.lot_size)

    # ---- summary numbers ----------------------------------------------------

    def best_bid(self) -> int | None:
        return self.bids[0].price_ticks if self.bids else None

    def best_ask(self) -> int | None:
        return self.asks[0].price_ticks if self.asks else None

    def mid_price(self) -> float | None:
        """Mid in USD, or None if a side is empty."""
        bid, ask = self.best_bid(), self.best_ask()
        if bid is None or ask is None:
            return None
        return self.price(bid + ask) / 2

    def spread_bps(self) -> float | None:
        bid, ask, mid = self.best_bid(), self.best_ask(), self.mid_price()
        if mid is None:
            return None
        return (self.price(ask) - self.price(bid)) / mid * 10_000

    def notional(self, side: str) -> float:
        """Total USD resting on one side (``"bid"`` or ``"ask"``)."""
        orders = self.bids if side == "bid" else self.asks
        return sum(self.price(o.price_ticks) * self.size(o.size_lots) for o in orders)

    def validate(self) -> None:
        """Raise ValueError if the snapshot is not a sane, uncrossed book."""
        for name, orders, descending in (("bids", self.bids, True), ("asks", self.asks, False)):
            for a, b in zip(orders, orders[1:], strict=False):
                if (
                    (a.price_ticks < b.price_ticks)
                    if descending
                    else (a.price_ticks > b.price_ticks)
                ):
                    raise ValueError(f"{name} are not sorted best-first")
            if any(o.size_lots <= 0 or o.price_ticks <= 0 for o in orders):
                raise ValueError(f"{name} contain a non-positive price or size")
        bid, ask = self.best_bid(), self.best_ask()
        if bid is not None and ask is not None and bid >= ask:
            raise ValueError(f"book is crossed: best bid {bid} >= best ask {ask}")

    # ---- persistence ----------------------------------------------------------

    def to_dict(self) -> dict:
        return {
            "venue": self.venue,
            "symbol": self.symbol,
            "fetched_at": self.fetched_at,
            "tick_size": str(self.tick_size),
            "lot_size": str(self.lot_size),
            "bids": [[o.price_ticks, o.size_lots] for o in self.bids],
            "asks": [[o.price_ticks, o.size_lots] for o in self.asks],
            "meta": self.meta,
        }

    @classmethod
    def from_dict(cls, d: dict) -> BookSnapshot:
        return cls(
            venue=d["venue"],
            symbol=d["symbol"],
            fetched_at=float(d["fetched_at"]),
            tick_size=Decimal(d["tick_size"]),
            lot_size=Decimal(d["lot_size"]),
            bids=[RestingOrder(int(p), int(s)) for p, s in d["bids"]],
            asks=[RestingOrder(int(p), int(s)) for p, s in d["asks"]],
            meta=d.get("meta", {}),
        )

    def save(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(self.to_dict()))

    @classmethod
    def load(cls, path: Path) -> BookSnapshot:
        return cls.from_dict(json.loads(Path(path).read_text()))


def from_decimal_levels(
    venue: str,
    symbol: str,
    fetched_at: float,
    bids: list[tuple[str, str]],
    asks: list[tuple[str, str]],
    tick_size: Decimal,
    lot_size: Decimal,
    meta: dict | None = None,
) -> BookSnapshot:
    """Build a snapshot from venues that publish decimal strings (Kraken, Coinbase).

    Each price must be an exact multiple of ``tick_size``; sizes are rounded
    *down* to whole lots (so we never pretend there is more liquidity than there
    is) and levels that round to zero lots are dropped.
    """

    def convert(levels: list[tuple[str, str]], descending: bool) -> list[RestingOrder]:
        out = []
        for price_s, size_s in levels:
            ticks = Decimal(price_s) / tick_size
            if ticks != ticks.to_integral_value():
                raise ValueError(f"{venue}: price {price_s} is not a multiple of tick {tick_size}")
            lots = int(Decimal(size_s) / lot_size)  # int() truncates toward zero: rounds down
            if lots > 0:
                out.append(RestingOrder(int(ticks), lots))
        out.sort(key=lambda o: o.price_ticks, reverse=descending)
        return out

    snap = BookSnapshot(
        venue=venue,
        symbol=symbol,
        fetched_at=fetched_at,
        tick_size=tick_size,
        lot_size=lot_size,
        bids=convert(bids, descending=True),
        asks=convert(asks, descending=False),
        meta=meta or {},
    )
    snap.validate()
    return snap
