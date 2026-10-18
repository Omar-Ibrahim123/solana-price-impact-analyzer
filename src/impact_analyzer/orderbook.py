"""Limit order book and price-time priority matching engine.

Design
------
- ``bids`` / ``asks``: ``SortedDict`` mapping price (int ticks) -> ``PriceLevel``.
  Best ask is the smallest key, best bid is the largest key.
- ``PriceLevel``: a doubly linked list of ``Order`` nodes, oldest at the head,
  plus a running ``total_size`` so depth queries don't walk the list.
- ``orders``: dict mapping order_id -> ``Order`` node, so a cancel can jump
  straight to the node and unlink it in O(1).

All prices are integer ticks and all sizes are integer lots. Conversion to
dollars and SOL happens outside the engine (see ``snapshot.py``).

Time in force
-------------
Every limit order says what happens to the part that cannot trade at once:

- ``TimeInForce.GTC`` (good-til-cancelled, the default): the remainder rests
  in the book at its limit price and waits for a taker. This makes it a maker.
- ``TimeInForce.IOC`` (immediate-or-cancel): trade what you can right now, at
  the limit price or better, and cancel the rest. It never rests, so it can
  only ever be a taker. ``market_order`` is an IOC whose limit is optional.

Complexities (L = number of price levels on one side):
- add_order that rests at an existing level: O(1); at a new level: O(log L)
- add_order with IOC: only the matching cost below, never the resting step
- cancel_order: O(1), plus O(log L) if it empties its level
- reduce_order: O(1) (the order keeps its place in the queue)
- matching m orders across k levels: O(m + k log L)
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum

from sortedcontainers import SortedDict


class Side(Enum):
    BID = "bid"  # buy
    ASK = "ask"  # sell

    @property
    def opposite(self) -> Side:
        return Side.ASK if self is Side.BID else Side.BID


class TimeInForce(Enum):
    """What happens to the unfilled part of a limit order."""

    GTC = "gtc"  # good-til-cancelled: the remainder rests in the book (a maker order)
    IOC = "ioc"  # immediate-or-cancel: the remainder is cancelled, nothing ever rests


@dataclass(eq=False, slots=True)
class Order:
    """A resting limit order. Also serves as a node in its level's linked list.

    ``eq=False`` keeps identity comparison: two different orders with the same
    fields are still different nodes.
    """

    order_id: int
    side: Side
    price_ticks: int
    size_lots: int  # remaining (unfilled) size
    prev: Order | None = None  # toward the head (older)
    next: Order | None = None  # toward the tail (newer)


@dataclass(frozen=True, slots=True)
class Fill:
    """One match between an incoming (taker) order and a resting (maker) order."""

    maker_order_id: int
    price_ticks: int  # always the maker's price
    size_lots: int


class PriceLevel:
    """All resting orders at one price, in arrival order (FIFO)."""

    __slots__ = ("price_ticks", "head", "tail", "total_size", "count")

    def __init__(self, price_ticks: int) -> None:
        self.price_ticks = price_ticks
        self.head: Order | None = None  # oldest: matched first
        self.tail: Order | None = None  # newest: new orders join here
        self.total_size = 0  # sum of size_lots over all orders in the level
        self.count = 0  # number of orders in the level

    def __bool__(self) -> bool:
        return self.count > 0

    def append(self, order: Order) -> None:
        """Add ``order`` at the tail in O(1)."""
        order.prev = self.tail
        order.next = None
        if self.tail is None:
            # Empty level: the new order is both the oldest and the newest.
            self.head = order
        else:
            self.tail.next = order
        self.tail = order
        self.total_size += order.size_lots
        self.count += 1

    def remove(self, order: Order) -> None:
        """Unlink ``order`` from anywhere in the list (head, middle, tail) in O(1).

        Each side of the node is fixed independently: if there is a neighbour,
        point it past ``order``; if not, ``order`` was the head (or tail), so the
        level's head (or tail) moves instead.
        """
        if order.prev is None:
            self.head = order.next
        else:
            order.prev.next = order.next
        if order.next is None:
            self.tail = order.prev
        else:
            order.next.prev = order.prev
        # Clear the stale pointers so nobody can walk the list through a dead node.
        order.prev = order.next = None
        # Uses the *current* remaining size, which partial fills may have reduced.
        self.total_size -= order.size_lots
        self.count -= 1


class OrderBook:
    def __init__(self) -> None:
        self.bids: SortedDict[int, PriceLevel] = SortedDict()
        self.asks: SortedDict[int, PriceLevel] = SortedDict()
        self.orders: dict[int, Order] = {}

    def _book(self, side: Side) -> SortedDict:
        return self.bids if side is Side.BID else self.asks

    # ---- queries -----------------------------------------------------------

    def best_bid(self) -> int | None:
        """Highest bid price in ticks, or None if there are no bids."""
        return self.bids.peekitem(-1)[0] if self.bids else None

    def best_ask(self) -> int | None:
        """Lowest ask price in ticks, or None if there are no asks."""
        return self.asks.peekitem(0)[0] if self.asks else None

    def depth(self, side: Side) -> list[tuple[int, int]]:
        """``(price_ticks, total_size_lots)`` per level, best price first.

        The impact simulator reads the book through this, so it never needs to
        know about linked lists.
        """
        if side is Side.ASK:
            items = self.asks.items()  # ascending: lowest ask is best
        else:
            items = reversed(self.bids.items())  # descending: highest bid is best
        return [(price, level.total_size) for price, level in items]

    # ---- commands ----------------------------------------------------------

    def add_order(
        self,
        order_id: int,
        side: Side,
        price_ticks: int,
        size_lots: int,
        tif: TimeInForce = TimeInForce.GTC,
    ) -> list[Fill]:
        """Submit a limit order. Returns the fills it caused (possibly empty).

        If the order crosses the spread (a bid at or above the best ask, or an
        ask at or below the best bid), it first matches like a taker against the
        opposite side, but only at prices at least as good as ``price_ticks``.
        With ``tif=GTC`` any remaining size then rests in the book at
        ``price_ticks``; with ``tif=IOC`` it is dropped, and the unfilled size is
        ``size_lots - sum(f.size_lots for f in fills)``.

        Raises ValueError for a non-positive size or an order_id already resting
        (also for IOC: one id space for every order keeps fills unambiguous).
        """
        if size_lots <= 0:
            raise ValueError(f"size_lots must be positive, got {size_lots}")
        if order_id in self.orders:
            raise ValueError(f"order_id {order_id} is already resting")

        fills = self._match(side, size_lots, limit_price=price_ticks)
        remaining = size_lots - sum(f.size_lots for f in fills)
        # The only difference between GTC and IOC: whether the remainder rests.
        # An IOC's id is never stored, so a later cancel of it is a harmless no-op.
        if remaining > 0 and tif is TimeInForce.GTC:
            book = self._book(side)
            level = book.get(price_ticks)
            if level is None:
                # A new price: the only O(log L) step on the add path.
                level = book[price_ticks] = PriceLevel(price_ticks)
            order = Order(order_id, side, price_ticks, remaining)
            level.append(order)
            self.orders[order_id] = order
        return fills

    def cancel_order(self, order_id: int) -> bool:
        """Remove a resting order. Returns False if the id isn't resting.

        An unknown id is not an error: on a real exchange a cancel can race a
        fill, and the benchmark's order flow does exactly that.
        """
        order = self.orders.pop(order_id, None)
        if order is None:
            return False
        book = self._book(order.side)
        level = book[order.price_ticks]
        level.remove(order)
        if not level:
            del book[order.price_ticks]
        return True

    def reduce_order(self, order_id: int, new_size_lots: int) -> None:
        """Shrink a resting order to ``new_size_lots`` without losing its queue place.

        This is what a partial fill does to a maker, and what a "reduce size"
        instruction does on Phoenix: the order stays where it is in its level's
        FIFO list. (Making an order *bigger* would be unfair to the orders
        queued behind it, so exchanges treat that as cancel + new order at the
        back; this method refuses it.) O(1): the id map finds the node, and only
        its size and the level's running total change.

        Raises KeyError if the id isn't resting, ValueError unless
        ``0 < new_size_lots < current size`` (to remove an order, cancel it).
        """
        order = self.orders[order_id]
        if not 0 < new_size_lots < order.size_lots:
            raise ValueError(
                f"new size must be between 0 and {order.size_lots} (exclusive), "
                f"got {new_size_lots}"
            )
        level = self._book(order.side)[order.price_ticks]
        # Keep the level total in sync by hand, exactly like a partial fill in _match.
        level.total_size -= order.size_lots - new_size_lots
        order.size_lots = new_size_lots

    def market_order(
        self, side: Side, size_lots: int, limit_price: int | None = None
    ) -> list[Fill]:
        """Buy (``Side.BID``) or sell (``Side.ASK``) ``size_lots`` immediately.

        Sweeps the opposite side from the best price outward. If the book runs
        out, the remainder is simply unfilled: compare the fills' total size
        with ``size_lots`` to detect it. Market orders never rest.

        ``limit_price`` is optional price protection: the order stops at the
        first level worse than it instead of sweeping the whole side. Real takers
        almost always set one. With a limit this is exactly an IOC limit order
        (``add_order(..., tif=TimeInForce.IOC)``), minus the order id.
        """
        if size_lots <= 0:
            raise ValueError(f"size_lots must be positive, got {size_lots}")
        return self._match(side, size_lots, limit_price=limit_price)

    def _match(self, side: Side, size_lots: int, limit_price: int | None) -> list[Fill]:
        """The matching loop, shared by limit and market orders.

        ``side`` is the incoming (taker) side; it consumes the opposite book.
        ``limit_price=None`` means no price limit (market order).
        """
        opposite = self._book(side.opposite)
        # Index of the best level in the opposite SortedDict: asks are best at
        # the front (lowest), bids are best at the back (highest).
        best_index = 0 if side is Side.BID else -1
        fills: list[Fill] = []
        remaining = size_lots

        while remaining > 0 and opposite:
            # Re-read the best level every iteration instead of iterating over
            # the SortedDict, because we delete levels as they empty.
            price, level = opposite.peekitem(best_index)
            if limit_price is not None:
                too_expensive = side is Side.BID and price > limit_price
                too_cheap = side is Side.ASK and price < limit_price
                if too_expensive or too_cheap:
                    break

            # Time priority: always trade with the oldest order at this price.
            while remaining > 0 and level.head is not None:
                maker = level.head
                traded = min(remaining, maker.size_lots)
                fills.append(Fill(maker.order_id, price, traded))
                remaining -= traded
                if traded == maker.size_lots:
                    # Maker fully filled: gone from the level and from the id map.
                    level.remove(maker)
                    del self.orders[maker.order_id]
                else:
                    # Partial fill: the maker keeps its place at the head.
                    # remove() never ran, so keep the level total in sync by hand.
                    maker.size_lots -= traded
                    level.total_size -= traded

            if not level:
                del opposite[price]

        return fills
