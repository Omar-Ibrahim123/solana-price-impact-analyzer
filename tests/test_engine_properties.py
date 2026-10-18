"""Property-based and differential tests for the matching engine.

``test_orderbook.py`` checks hand-picked scenarios. This file lets Hypothesis invent thousands
of random scenarios and checks rules that must hold in *every* one of them:

1. ``EngineMachine`` (stateful test): Hypothesis plays a random sequence of adds, cancels and
   market orders against the real ``OrderBook`` and, in lockstep, against ``ReferenceBook``,
   a deliberately naive model written below. After every step the two must agree exactly
   (same fills in the same order, same resting orders in the same queue order), and the engine's
   internal structures must be self-consistent. When something fails, Hypothesis shrinks the
   sequence to the shortest one that still fails and prints it as a script.
2. A few ``@given`` tests for single properties that are easy to state on their own.

Prices live in a 9-tick range so bids and asks overlap constantly: most interesting bugs are in
the crossing and matching code, and a wide range would make crosses rare.
"""

from __future__ import annotations

from dataclasses import dataclass

from hypothesis import given
from hypothesis import strategies as st
from hypothesis.stateful import Bundle, RuleBasedStateMachine, invariant, rule

from impact_analyzer.orderbook import Fill, Order, OrderBook, PriceLevel, Side, TimeInForce

BID, ASK = Side.BID, Side.ASK

sides = st.sampled_from(Side)
prices = st.integers(min_value=100, max_value=108)  # small range: books cross often
sizes = st.integers(min_value=1, max_value=10)
market_sizes = st.integers(min_value=1, max_value=30)  # big enough to sweep several levels

# What a book looks like from outside, best price first on each side:
# [(price, [(order_id, remaining_size), ...oldest first]), ...]
BookView = list[tuple[int, list[tuple[int, int]]]]


# ---- the reference model ----------------------------------------------------------------------


@dataclass
class ModelOrder:
    order_id: int
    side: Side
    price: int
    size: int  # remaining
    seq: int  # arrival number: smaller = arrived earlier = higher time priority


class ReferenceBook:
    """The matching rules written as plainly as possible, with no data structures to get wrong.

    One flat list of resting orders. To match, sort the opposite side by
    (price priority, arrival seq) and walk it. That is O(n log n) per order, far too slow for
    real use, but each line can be checked by eye, which is the point: if the fast engine and
    this model ever disagree, the engine is the one to suspect.
    """

    def __init__(self) -> None:
        self.resting: list[ModelOrder] = []
        self.next_seq = 0

    def _queue(self, side: Side) -> list[ModelOrder]:
        """Resting orders of ``side``, in the order a taker would hit them."""
        orders = [o for o in self.resting if o.side is side]
        if side is ASK:
            return sorted(orders, key=lambda o: (o.price, o.seq))  # cheapest ask, then oldest
        return sorted(orders, key=lambda o: (-o.price, o.seq))  # highest bid, then oldest

    def _match(self, side: Side, size: int, limit: int | None) -> tuple[list[Fill], int]:
        fills = []
        for maker in self._queue(side.opposite):
            if size == 0:
                break
            if limit is not None:
                if (side is BID and maker.price > limit) or (side is ASK and maker.price < limit):
                    break  # queue is in price order, so everything after is worse too
            traded = min(size, maker.size)
            fills.append(Fill(maker.order_id, maker.price, traded))
            maker.size -= traded
            size -= traded
        self.resting = [o for o in self.resting if o.size > 0]
        return fills, size

    def add(self, order_id: int, side: Side, price: int, size: int) -> list[Fill]:
        fills, left = self._match(side, size, limit=price)
        if left > 0:
            self.resting.append(ModelOrder(order_id, side, price, left, self.next_seq))
            self.next_seq += 1
        return fills

    def cancel(self, order_id: int) -> bool:
        for i, o in enumerate(self.resting):
            if o.order_id == order_id:
                del self.resting[i]
                return True
        return False

    def market(self, side: Side, size: int, limit: int | None) -> list[Fill]:
        fills, _unfilled = self._match(side, size, limit)  # the unfilled rest just disappears
        return fills

    def view(self, side: Side) -> BookView:
        levels: BookView = []
        for o in self._queue(side):
            if not levels or levels[-1][0] != o.price:
                levels.append((o.price, []))
            levels[-1][1].append((o.order_id, o.size))
        return levels


# ---- helpers that read the real engine ---------------------------------------------------------


def walk(level: PriceLevel) -> list[Order]:
    """Walk a level head -> tail, asserting every link on the way. Returns the nodes."""
    assert level.head is not None and level.head.prev is None, "head must have no prev"
    nodes: list[Order] = []
    prev, node = None, level.head
    while node is not None:
        assert node.prev is prev, "prev must mirror the previous node's next"
        nodes.append(node)
        prev, node = node, node.next
    assert level.tail is prev, "tail must be the last node reached"
    assert level.tail.next is None, "tail must have no next"
    return nodes


def engine_view(book: OrderBook, side: Side) -> BookView:
    levels = book.bids.items() if side is BID else book.asks.items()
    if side is BID:
        levels = reversed(levels)  # highest bid is best
    return [(price, [(o.order_id, o.size_lots) for o in walk(lvl)]) for price, lvl in levels]


def resting_lots(book: OrderBook) -> int:
    return sum(o.size_lots for o in book.orders.values())


def filled(fills: list[Fill]) -> int:
    return sum(f.size_lots for f in fills)


# ---- the stateful test ------------------------------------------------------------------------


class EngineMachine(RuleBasedStateMachine):
    """Random sequences of operations, engine vs. reference model, invariants after every step."""

    # Every id an add has used. Cancels draw from here, so they hit orders that are resting,
    # partly filled, fully filled, or already cancelled: all the cases a real exchange sees.
    order_ids = Bundle("order_ids")

    def __init__(self) -> None:
        super().__init__()
        self.book = OrderBook()
        self.model = ReferenceBook()
        self.next_id = 1
        # Ledger for the conservation invariant (see lots_are_conserved).
        self.lots_added = 0  # every lot ever submitted in a limit order
        self.lots_cancelled = 0  # remaining size of each order at the moment it was cancelled
        self.maker_lots_traded = 0  # every fill, counted once on the maker side
        self.taker_lots_from_limits = 0  # fills where the taker was a crossing limit order
        self.before: dict[int, tuple[Side, int]] = {}  # set by snapshot()

    def check_fills(self, fills: list[Fill], side: Side, size: int, limit: int | None) -> None:
        """Rules every list of fills must satisfy. Uses a snapshot taken *before* the order."""
        assert filled(fills) <= size, "can't trade more than was asked for"
        assert len({f.maker_order_id for f in fills}) == len(fills), "a maker is hit only once"
        for f in fills:
            assert f.size_lots > 0, "no zero-size fills"
            maker_side, maker_price = self.before[f.maker_order_id]
            # The maker was resting on the other side, and the trade prints at *its* price, not
            # the taker's limit: a buyer bidding 105 into an ask at 102 pays 102.
            assert maker_side is side.opposite
            assert f.price_ticks == maker_price
            if limit is not None:
                assert f.price_ticks <= limit if side is BID else f.price_ticks >= limit

    def snapshot(self) -> None:
        # Fills only carry the maker's id, and a fully filled maker is deleted, so remember every
        # resting order's side and price before each operation.
        self.before = {oid: (o.side, o.price_ticks) for oid, o in self.book.orders.items()}

    # ---- rules: the operations Hypothesis can choose from --------------------------------------

    @rule(target=order_ids, side=sides, price=prices, size=sizes)
    def add_limit_order(self, side: Side, price: int, size: int) -> int:
        order_id = self.next_id
        self.next_id += 1
        self.snapshot()

        fills = self.book.add_order(order_id, side, price, size)

        # Differential check: same fills, same order, as the obviously-correct model.
        assert fills == self.model.add(order_id, side, price, size)
        self.check_fills(fills, side, size, limit=price)
        # Whatever didn't trade rests at the limit price; a fully filled order doesn't rest.
        left = size - filled(fills)
        if left:
            assert self.book.orders[order_id].size_lots == left
            assert self.book.orders[order_id].price_ticks == price
        else:
            assert order_id not in self.book.orders

        self.lots_added += size
        self.maker_lots_traded += filled(fills)
        self.taker_lots_from_limits += filled(fills)
        return order_id  # goes into the order_ids bundle for later cancels

    @rule(order_id=order_ids)
    def cancel_known_id(self, order_id: int) -> None:
        node = self.book.orders.get(order_id)  # None if filled or already cancelled
        views_before = (engine_view(self.book, BID), engine_view(self.book, ASK))

        ok = self.book.cancel_order(order_id)

        assert ok == self.model.cancel(order_id)
        if node is None:
            # A cancel that races a fill (or a double cancel) is a harmless no-op.
            assert ok is False
            assert (engine_view(self.book, BID), engine_view(self.book, ASK)) == views_before
        else:
            assert ok is True
            assert order_id not in self.book.orders
            self.lots_cancelled += node.size_lots  # the size left after any partial fills

    @rule(offset=st.integers(min_value=0, max_value=5))
    def cancel_never_seen_id(self, offset: int) -> None:
        # next_id and above haven't been handed out yet, so no order can have them.
        views_before = (engine_view(self.book, BID), engine_view(self.book, ASK))
        assert self.book.cancel_order(self.next_id + offset) is False
        assert (engine_view(self.book, BID), engine_view(self.book, ASK)) == views_before

    @rule(side=sides, size=market_sizes, limit=st.none() | prices)
    def market_order(self, side: Side, size: int, limit: int | None) -> None:
        self.snapshot()
        ids_before = set(self.book.orders)
        lots_before = resting_lots(self.book)

        fills = self.book.market_order(side, size, limit_price=limit)

        assert fills == self.model.market(side, size, limit)
        self.check_fills(fills, side, size, limit)
        # Market orders never rest: no new id appears, and the book only shrinks, by exactly
        # what traded. Any unfilled remainder is gone, not parked in the book.
        assert set(self.book.orders) <= ids_before
        assert resting_lots(self.book) == lots_before - filled(fills)

        # The taker's lots were never "added" to the book, so only the maker side is counted.
        self.maker_lots_traded += filled(fills)

    @rule(side=sides, price=prices, size=market_sizes)
    def ioc_limit_order(self, side: Side, price: int, size: int) -> None:
        # An IOC limit order must trade exactly like a market order with the same limit,
        # and never rest: its id is used once and then forgotten.
        order_id = self.next_id
        self.next_id += 1
        self.snapshot()
        ids_before = set(self.book.orders)
        lots_before = resting_lots(self.book)

        fills = self.book.add_order(order_id, side, price, size, tif=TimeInForce.IOC)

        assert fills == self.model.market(side, size, price)
        self.check_fills(fills, side, size, limit=price)
        assert set(self.book.orders) <= ids_before
        assert resting_lots(self.book) == lots_before - filled(fills)
        assert self.book.cancel_order(order_id) is False  # nothing rested, nothing to cancel
        self.maker_lots_traded += filled(fills)  # like a market order: only the maker side

    @rule(order_id=order_ids, size=sizes)
    def reject_duplicate_resting_id(self, order_id: int, size: int) -> None:
        # Two resting orders with one id would make cancel ambiguous, so the engine refuses.
        if order_id not in self.book.orders:
            return  # id no longer resting: nothing to test here
        views_before = (engine_view(self.book, BID), engine_view(self.book, ASK))
        try:
            self.book.add_order(order_id, BID, 100, size)
        except ValueError:
            pass
        else:
            raise AssertionError("duplicate resting id was accepted")
        assert (engine_view(self.book, BID), engine_view(self.book, ASK)) == views_before

    # ---- invariants: checked after every single step -------------------------------------------

    @invariant()
    def book_is_not_crossed(self) -> None:
        # If best bid >= best ask, those two orders should have traded when the later one
        # arrived. A crossed book means the matching step was skipped or stopped early.
        bid, ask = self.book.best_bid(), self.book.best_ask()
        if bid is not None and ask is not None:
            assert bid < ask

    @invariant()
    def levels_are_consistent_linked_lists(self) -> None:
        seen: list[int] = []
        for side, levels in ((BID, self.book.bids), (ASK, self.book.asks)):
            for price, level in levels.items():
                # An empty level left in the SortedDict would make best_bid()/best_ask() report
                # a price nobody is quoting.
                assert level.count > 0, f"empty level left at {price}"
                assert level.price_ticks == price
                nodes = walk(level)  # checks head.prev, tail.next and prev/next mirroring
                # count and total_size are cached so depth() needn't walk; they must equal
                # what walking finds, or depth() (and so every impact number) is wrong.
                assert level.count == len(nodes)
                assert level.total_size == sum(o.size_lots for o in nodes)
                for o in nodes:
                    assert o.side is side and o.price_ticks == price
                    assert o.size_lots > 0, "fully filled orders must be unlinked"
                    # The id map must point at this exact node (identity, not equality), or a
                    # cancel would unlink some other object and leave this order in the book.
                    assert self.book.orders.get(o.order_id) is o
                seen.extend(o.order_id for o in nodes)
        # Every resting order appears in exactly one level, and the id map holds nothing else
        # (a stale entry would let a cancel "succeed" on an order that already traded).
        assert len(seen) == len(set(seen))
        assert set(seen) == set(self.book.orders)

    @invariant()
    def matches_reference_model(self) -> None:
        # Same resting orders, same remaining sizes, same queue order at every price. This is
        # what pins down FIFO: a partially filled maker must still be first in line.
        assert engine_view(self.book, BID) == self.model.view(BID)
        assert engine_view(self.book, ASK) == self.model.view(ASK)

    @invariant()
    def lots_are_conserved(self) -> None:
        # Lots are never created or destroyed. Every lot submitted in a limit order ends up in
        # exactly one place: still resting, cancelled, or traded. A trade of q lots between a
        # limit-order taker and a maker uses q lots from *each* of two limit orders, so it is
        # counted twice (once per side). When the taker is a market order, only the maker's q
        # lots were ever in the book, so it is counted once. Market-order lots that don't trade
        # are never added, so they don't appear here at all.
        assert self.lots_added == (
            resting_lots(self.book)
            + self.lots_cancelled
            + self.maker_lots_traded
            + self.taker_lots_from_limits
        )


# pytest collects this TestCase; the Hypothesis profile in conftest.py sets how many sequences
# it tries (max_examples) and how long each one is (stateful_step_count).
TestEngineStateful = EngineMachine.TestCase


# ---- single-property tests --------------------------------------------------------------------


@given(queue=st.lists(sizes, min_size=1, max_size=8), take=st.integers(1, 100))
def test_one_level_fills_oldest_first(queue: list[int], take: int):
    """At one price, a taker eats the queue from the front: whole orders, then at most one
    partial. That is exactly what FIFO (time priority) means."""
    book = OrderBook()
    for oid, size in enumerate(queue, start=1):
        book.add_order(oid, ASK, 100, size)

    fills = book.market_order(BID, take)

    expected, left = [], take
    for oid, size in enumerate(queue, start=1):
        if left == 0:
            break
        expected.append(Fill(oid, 100, min(size, left)))
        left -= min(size, left)
    assert fills == expected


@given(
    first=st.integers(2, 50),
    others=st.lists(sizes, min_size=1, max_size=5),
    data=st.data(),
)
def test_partial_fill_keeps_queue_position(first: int, others: list[int], data):
    """A partially filled order keeps its place at the front of the queue. On Phoenix and every
    price-time book, losing your place because someone traded *part* of your order would be a
    bug that costs the maker money."""
    book = OrderBook()
    book.add_order(1, ASK, 100, first)
    for oid, size in enumerate(others, start=2):
        book.add_order(oid, ASK, 100, size)
    nibble = data.draw(st.integers(1, first - 1), label="nibble")  # strictly less than order 1

    book.market_order(BID, nibble)

    ids = [o.order_id for o in walk(book.asks[100])]
    assert ids == list(range(1, len(others) + 2))  # same order as before
    assert book.orders[1].size_lots == first - nibble
    # The next taker hits order 1's remainder before anyone else.
    assert book.market_order(BID, 1) == [Fill(1, 100, 1)]


@given(asks=st.lists(st.tuples(prices, sizes), min_size=1, max_size=15), take=market_sizes)
def test_sweep_walks_prices_best_first(asks: list[tuple[int, int]], take: int):
    """A market buy pays the cheapest asks first, so fill prices never go down, and it consumes
    exactly the front of depth(): the level-by-level view the impact simulator relies on."""
    book = OrderBook()
    for oid, (price, size) in enumerate(asks, start=1):
        book.add_order(oid, ASK, price, size)
    depth_before = book.depth(ASK)

    fills = book.market_order(BID, take)

    fill_prices = [f.price_ticks for f in fills]
    assert fill_prices == sorted(fill_prices)
    assert filled(fills) == min(take, sum(size for _, size in asks))
    # Re-derive the fills level by level from depth() and compare totals per price.
    left, expected = take, {}
    for price, size in depth_before:
        if left == 0:
            break
        expected[price] = min(size, left)
        left -= expected[price]
    got: dict[int, int] = {}
    for f in fills:
        got[f.price_ticks] = got.get(f.price_ticks, 0) + f.size_lots
    assert got == expected


@given(size=sizes, cancel_twice=st.booleans())
def test_cancel_then_readd_goes_to_back_of_queue(size: int, cancel_twice: bool):
    """Cancelling and re-submitting forfeits time priority: the order joins behind everyone
    already waiting. (A second cancel of the same id is a no-op that returns False.)"""
    book = OrderBook()
    book.add_order(1, ASK, 100, size)
    book.add_order(2, ASK, 100, size)
    assert book.cancel_order(1) is True
    if cancel_twice:
        assert book.cancel_order(1) is False
    book.add_order(1, ASK, 100, size)
    assert [o.order_id for o in walk(book.asks[100])] == [2, 1]
