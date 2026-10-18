"""Convert a fetched snapshot into a live engine ``OrderBook``."""

from __future__ import annotations

from .orderbook import OrderBook, Side
from .snapshot import BookSnapshot


def load_book(snapshot: BookSnapshot) -> OrderBook:
    """Replay every resting order of ``snapshot`` into a fresh ``OrderBook``.

    Orders are added in the snapshot's priority order (best price first, oldest
    first within a price). Because ``PriceLevel.append`` adds at the tail, the
    first order added at a price ends up at the head, so the engine reproduces
    the venue's own time priority.

    A valid snapshot is uncrossed, so none of these adds can trade: every order
    simply rests. We check that, because a fill here would mean the snapshot was
    corrupt and every number downstream would be wrong.
    """
    snapshot.validate()
    book = OrderBook()
    order_id = 0
    for side, orders in ((Side.BID, snapshot.bids), (Side.ASK, snapshot.asks)):
        for o in orders:
            order_id += 1
            fills = book.add_order(order_id, side, o.price_ticks, o.size_lots)
            if fills:
                raise ValueError("snapshot is crossed: loading it produced a trade")
    return book
