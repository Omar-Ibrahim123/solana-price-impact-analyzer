"""Tests for the matching engine. Prices are ticks of $0.01, so 15_000 == $150.00."""

import pytest

from impact_analyzer.orderbook import Fill, Order, OrderBook, PriceLevel, Side

BID, ASK = Side.BID, Side.ASK


def filled(fills: list[Fill]) -> int:
    return sum(f.size_lots for f in fills)


def level_ids(level: PriceLevel) -> list[int]:
    """Walk head -> tail, checking the back-pointers agree on the way."""
    ids, node, prev = [], level.head, None
    while node is not None:
        assert node.prev is prev
        ids.append(node.order_id)
        prev, node = node, node.next
    assert level.tail is prev
    return ids


@pytest.fixture
def book() -> OrderBook:
    return OrderBook()


# ---- PriceLevel ---------------------------------------------------------------


def make_level(*sizes: int) -> tuple[PriceLevel, list[Order]]:
    level = PriceLevel(15_000)
    orders = [Order(i, ASK, 15_000, s) for i, s in enumerate(sizes, start=1)]
    for o in orders:
        level.append(o)
    return level, orders


def test_level_append_keeps_fifo_and_totals():
    level, _ = make_level(4, 4, 2)
    assert level_ids(level) == [1, 2, 3]
    assert (level.total_size, level.count) == (10, 3)


@pytest.mark.parametrize(
    "remove_id, expected",
    [(1, [2, 3]), (2, [1, 3]), (3, [1, 2])],
    ids=["head", "middle", "tail"],
)
def test_level_remove_anywhere(remove_id, expected):
    level, orders = make_level(4, 4, 2)
    victim = orders[remove_id - 1]
    level.remove(victim)
    assert level_ids(level) == expected
    assert level.total_size == 10 - victim.size_lots
    assert victim.prev is None and victim.next is None


def test_level_remove_only_order_empties_it():
    level, (only,) = make_level(5)
    level.remove(only)
    assert level.head is None and level.tail is None
    assert not level
    assert level.total_size == 0


# ---- queries --------------------------------------------------------------------


def test_empty_book(book):
    assert book.best_bid() is None
    assert book.best_ask() is None
    assert book.depth(BID) == [] and book.depth(ASK) == []


def test_best_prices_and_depth_order(book):
    book.add_order(1, BID, 14_990, 5)
    book.add_order(2, BID, 14_980, 7)
    book.add_order(3, ASK, 15_010, 3)
    book.add_order(4, ASK, 15_000, 2)
    book.add_order(5, ASK, 15_000, 1)
    assert book.best_bid() == 14_990
    assert book.best_ask() == 15_000
    assert book.depth(BID) == [(14_990, 5), (14_980, 7)]
    assert book.depth(ASK) == [(15_000, 3), (15_010, 3)]


# ---- matching -------------------------------------------------------------------


def test_price_time_priority(book):
    """Alice then Bob at the same price: Alice fills first."""
    book.add_order(1, ASK, 15_000, 4)  # Alice
    book.add_order(2, ASK, 15_000, 4)  # Bob
    fills = book.market_order(BID, 5)
    assert fills == [Fill(1, 15_000, 4), Fill(2, 15_000, 1)]
    assert 1 not in book.orders
    assert book.orders[2].size_lots == 3
    assert book.depth(ASK) == [(15_000, 3)]


def test_partial_fill_keeps_queue_position(book):
    book.add_order(1, ASK, 15_000, 10)
    book.add_order(2, ASK, 15_000, 10)
    book.market_order(BID, 3)
    fills = book.market_order(BID, 8)
    assert fills == [Fill(1, 15_000, 7), Fill(2, 15_000, 1)]


def test_sweep_multiple_levels(book):
    """The worked example: 5 @ 150.00, 10 @ 150.10, 20 @ 150.30; buy 12."""
    book.add_order(1, ASK, 15_000, 5)
    book.add_order(2, ASK, 15_010, 10)
    book.add_order(3, ASK, 15_030, 20)
    fills = book.market_order(BID, 12)
    assert fills == [Fill(1, 15_000, 5), Fill(2, 15_010, 7)]
    assert book.best_ask() == 15_010
    assert book.depth(ASK) == [(15_010, 3), (15_030, 20)]


def test_market_sell_hits_highest_bid_first(book):
    book.add_order(1, BID, 14_980, 5)
    book.add_order(2, BID, 14_990, 5)
    fills = book.market_order(ASK, 6)
    assert fills == [Fill(2, 14_990, 5), Fill(1, 14_980, 1)]


def test_market_order_larger_than_book_is_partially_unfilled(book):
    book.add_order(1, ASK, 15_000, 5)
    book.add_order(2, ASK, 15_010, 5)
    fills = book.market_order(BID, 100)
    assert filled(fills) == 10
    assert book.best_ask() is None
    assert book.orders == {}


def test_market_order_on_empty_side(book):
    book.add_order(1, BID, 14_990, 5)
    assert book.market_order(BID, 5) == []  # no asks to buy from
    assert book.depth(BID) == [(14_990, 5)]  # bids untouched


# ---- crossing limit orders ---------------------------------------------------


def test_crossing_limit_matches_then_rests_remainder(book):
    book.add_order(1, ASK, 15_000, 5)
    book.add_order(2, ASK, 15_010, 5)
    fills = book.add_order(3, BID, 15_000, 8)
    assert fills == [Fill(1, 15_000, 5)]  # 15_010 is worse than the limit
    assert book.best_bid() == 15_000
    assert book.orders[3].size_lots == 3
    assert book.best_ask() == 15_010


def test_crossing_limit_sweeps_up_to_its_price(book):
    book.add_order(1, ASK, 15_000, 5)
    book.add_order(2, ASK, 15_010, 5)
    book.add_order(3, ASK, 15_020, 5)
    fills = book.add_order(4, BID, 15_010, 20)
    assert filled(fills) == 10
    assert book.depth(BID) == [(15_010, 10)]
    assert book.depth(ASK) == [(15_020, 5)]


def test_fully_filled_limit_order_does_not_rest(book):
    book.add_order(1, BID, 15_000, 5)
    fills = book.add_order(2, ASK, 14_990, 5)
    assert fills == [Fill(1, 15_000, 5)]  # trades at the maker's price
    assert 2 not in book.orders
    assert book.best_bid() is None and book.best_ask() is None


# ---- cancels --------------------------------------------------------------------


def test_cancel_from_middle_then_match(book):
    """Alice 4, Bob 4, Carol 2; Bob cancels; Dave adds 3; buy 7."""
    for oid, size in [(1, 4), (2, 4), (3, 2)]:
        book.add_order(oid, ASK, 15_000, size)
    assert book.cancel_order(2) is True
    book.add_order(4, ASK, 15_000, 3)
    fills = book.market_order(BID, 7)
    assert fills == [Fill(1, 15_000, 4), Fill(3, 15_000, 2), Fill(4, 15_000, 1)]


def test_cancel_last_order_removes_level(book):
    book.add_order(1, ASK, 15_000, 4)
    book.add_order(2, ASK, 15_010, 4)
    book.cancel_order(1)
    assert book.best_ask() == 15_010
    assert 15_000 not in book.asks


def test_cancel_unknown_or_twice_returns_false(book):
    assert book.cancel_order(999) is False
    book.add_order(1, BID, 14_990, 1)
    assert book.cancel_order(1) is True
    assert book.cancel_order(1) is False


def test_cancel_after_full_fill_returns_false(book):
    book.add_order(1, ASK, 15_000, 4)
    book.market_order(BID, 4)
    assert book.cancel_order(1) is False


def test_cancel_after_partial_fill_removes_remaining_size(book):
    book.add_order(1, ASK, 15_000, 10)
    book.add_order(2, ASK, 15_000, 5)
    book.market_order(BID, 4)
    book.cancel_order(1)
    assert book.depth(ASK) == [(15_000, 5)]


# ---- validation -----------------------------------------------------------------


@pytest.mark.parametrize("size", [0, -1])
def test_rejects_non_positive_size(book, size):
    with pytest.raises(ValueError):
        book.add_order(1, BID, 14_990, size)


def test_rejects_duplicate_resting_id(book):
    book.add_order(1, BID, 14_990, 1)
    with pytest.raises(ValueError):
        book.add_order(1, BID, 14_980, 1)
