"""Event replay: rebuild each Phoenix snapshot from the one before it.

What it does
------------
The collector saves the raw Phoenix account bytes at every tick. Phoenix gives
every order a unique sequence number, so an order's identity is ``(side, seq)``
and two consecutive snapshots A -> B can be compared order by order:

- only in B                   -> ADD: a new order. Replayed in seq order (newer = later).
- only in A, gone from B      -> REMOVE: filled or cancelled. The account alone can't
                                 say which: both just delete the node.
- only in A, expired in B     -> EXPIRE: still in B's account but past its expiry, so the
                                 decoder drops it (Phoenix deletes it lazily, later).
- in both, fewer lots         -> REDUCE: a partial fill or a size reduce. Both keep the
                                 order's place in the queue.
- in both, more lots, or a different price or trader
                              -> ANOMALY: impossible for one order id, so it is flagged
                                 and not replayed (no legal event explains it).

Then the engine is loaded with A in time priority, the events are applied
(removals, expiries and reductions first, then adds by seq), and the engine's
book is compared with B: the same resting orders, the same sizes, the same FIFO
order at every price, and not crossed. ``python -m impact_analyzer replay``
does this for every consecutive pair in a collector database.

What this proves, and what it doesn't
-------------------------------------
The events come from diffing snapshots, so the check is partly circular: we
derived the changes from B and then check that they lead to B. It cannot see an
order that was added and removed between two ticks, it cannot tell a fill from a
cancel, and it does not know the order in which events really happened.

What it does check:

- that the engine reproduces Phoenix's resulting book *and its time priority*:
  new orders join the back of their level and reductions keep their place, so
  the engine's queue at each price must come out in Phoenix's seq order. That
  also re-checks the decoder's handling of bid sequence numbers (stored
  bit-flipped), which v1 got wrong;
- that no impossible transitions occur (an order growing or changing price);
- that every new order's number was handed out between A and B (the market's
  order counter, ``order_sequence_number``, must have moved past it);
- how active the market really is: adds, removals, reductions per tick, and how
  many orders rested and vanished between two ticks. Phoenix's program
  (``fifo.rs``, ``place_order_inner``) bumps the counter only when an order
  comes to *rest* in the book; IOC orders and orders that fill completely on
  arrival never get a number. So "counter moved" minus "adds we saw" counts
  resting orders we missed entirely, but it says nothing about takers.

It also flags *crossing adds*: a new order priced through A's opposite side
(a bid at or above A's best ask, or an ask at or below A's best bid). Either it
traded on arrival (fills the snapshots missed) or the orders in its way were
cancelled first; the snapshots can't tell which. During the replay itself all
removals are applied before any add, so the engine never trades; if it ever did,
that would be reported as a mismatch rather than silently changing the book.

Only the raw bytes are used: the book JSON the collector stored was decoded by
older code (bid order within a price was wrong then), so every tick is decoded
again here with the current decoder.
"""

from __future__ import annotations

import argparse
import itertools
import sys
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from enum import Enum
from pathlib import Path

from . import phoenix
from .orderbook import OrderBook, Side
from .store import Store

OrderKey = tuple[Side, int]  # (side, order sequence number): unique on Phoenix


@dataclass(frozen=True, slots=True)
class BookOrder:
    """One resting Phoenix order, with the identity the account gives it."""

    side: Side
    price_ticks: int
    seq: int  # real (un-flipped) order sequence number: lower = older
    trader_index: int  # the trader's seat in the market (who owns the order)
    lots: int  # remaining size in base lots

    @property
    def key(self) -> OrderKey:
        return (self.side, self.seq)

    def __str__(self) -> str:
        return f"{self.side.value} #{self.seq} {self.lots} lots @ {self.price_ticks}"


@dataclass(frozen=True, slots=True)
class PhoenixBook:
    """One snapshot's live orders with their identities, decoded from the raw bytes."""

    bids: list[BookOrder]  # best price first, then oldest first (Phoenix's priority)
    asks: list[BookOrder]
    expired: frozenset[OrderKey]  # still in the account but past expiry: not in the book
    next_seq: int  # the market's order counter: the number the next new order will get

    def orders(self) -> dict[OrderKey, BookOrder]:
        return {o.key: o for o in self.bids + self.asks}


def decode_book(raw: bytes, slot: int, now: int) -> PhoenixBook:
    """Decode a raw Phoenix account (header + order trees) into a ``PhoenixBook``.

    ``slot`` and ``now`` (unix seconds) are what expiry is judged against; use
    the values the snapshot was fetched at, so the book matches what was live then.
    """
    market = phoenix.decode_market(raw, slot, now)  # live orders, sorted by priority
    all_bids, all_asks = phoenix.decode_order_trees(raw, market.header)  # incl. expired

    def convert(side: Side, orders: list[phoenix.PhoenixOrder]) -> list[BookOrder]:
        return [
            BookOrder(
                side, o.price_in_ticks, o.order_sequence_number, o.trader_index, o.num_base_lots
            )
            for o in orders
        ]

    expired = frozenset(
        (side, o.order_sequence_number)
        for side, tree in ((Side.BID, all_bids), (Side.ASK, all_asks))
        for o in tree
        if o.num_base_lots and o.is_expired(slot, now)
    )
    return PhoenixBook(
        bids=convert(Side.BID, market.bids),
        asks=convert(Side.ASK, market.asks),
        expired=expired,
        next_seq=phoenix.market_field(raw, "order_sequence_number"),
    )


# ---- deriving events ----------------------------------------------------------------


class EventKind(Enum):
    ADD = "add"
    REMOVE = "remove"  # filled or cancelled: indistinguishable from the account
    EXPIRE = "expire"
    REDUCE = "reduce"  # partial fill or size reduce: keeps queue place


@dataclass(frozen=True, slots=True)
class Event:
    kind: EventKind
    # ADD: the new order. REMOVE / EXPIRE: the order as it was in A.
    # REDUCE: the order as it is in B (so ``order.lots`` is the new, smaller size).
    order: BookOrder


@dataclass(slots=True)
class Diff:
    """Everything derived from one pair of snapshots A -> B."""

    events: list[Event]  # in replay order: removals, expiries, reductions, then adds by seq
    anomalies: list[str] = field(default_factory=list)  # impossible transitions, explained
    crossing_adds: list[BookOrder] = field(default_factory=list)  # priced through A's book
    seqs_handed_out: int = 0  # how far the order counter moved from A to B

    def count(self, kind: EventKind) -> int:
        return sum(1 for e in self.events if e.kind is kind)

    @property
    def unseen(self) -> int:
        """Order numbers handed out between A and B that never showed up resting in B.

        Phoenix numbers an order only when it comes to rest, so each of these
        was a resting order that was placed *and* filled or cancelled between
        the two ticks: activity the snapshots missed completely. (Takers never
        get a number, so they don't show up here or anywhere in the account.)
        """
        return max(self.seqs_handed_out - self.count(EventKind.ADD), 0)


def derive_events(a: PhoenixBook, b: PhoenixBook) -> Diff:
    """Diff two consecutive snapshots order by order (see the module docstring)."""
    a_orders, b_orders = a.orders(), b.orders()
    removals: list[Event] = []
    reductions: list[Event] = []
    anomalies: list[str] = []

    for key, old in a_orders.items():
        new = b_orders.get(key)
        if new is None:
            kind = EventKind.EXPIRE if key in b.expired else EventKind.REMOVE
            removals.append(Event(kind, old))
        elif (
            new.price_ticks != old.price_ticks
            or new.trader_index != old.trader_index
            or new.lots > old.lots
        ):
            # One id can only shrink or disappear. Anything else means the decoder
            # or our understanding of the account is wrong, so say so loudly.
            anomalies.append(f"{old} became {new}: impossible for one order id")
        elif new.lots < old.lots:
            reductions.append(Event(EventKind.REDUCE, new))

    # New orders in the order Phoenix created them: a higher seq number is later.
    adds = sorted((o for k, o in b_orders.items() if k not in a_orders), key=lambda o: o.seq)
    for o in adds:
        # Its number must have been handed out after A and before B.
        if not a.next_seq <= o.seq < b.next_seq:
            anomalies.append(
                f"new order {o} has a seq outside [{a.next_seq}, {b.next_seq}), "
                "the numbers handed out between the two snapshots"
            )

    return Diff(
        events=removals + reductions + [Event(EventKind.ADD, o) for o in adds],
        anomalies=anomalies,
        crossing_adds=[o for o in adds if crosses(o, a)],
        seqs_handed_out=b.next_seq - a.next_seq,
    )


def crosses(order: BookOrder, book: PhoenixBook) -> bool:
    """Would ``order`` trade against ``book``'s opposite side if it arrived now?"""
    if order.side is Side.BID:
        return bool(book.asks) and order.price_ticks >= book.asks[0].price_ticks
    return bool(book.bids) and order.price_ticks <= book.bids[0].price_ticks


# ---- replaying through the engine ------------------------------------------------------


@dataclass(slots=True)
class Replayed:
    """The engine after a replay, plus the map back from engine ids to Phoenix ids."""

    book: OrderBook
    keys: dict[int, OrderKey]  # engine order_id -> (side, seq)
    problems: list[str]  # things the engine did that a correct replay never does


def replay(a: PhoenixBook, events: Iterable[Event]) -> Replayed:
    """Load A into a fresh engine in time priority, then apply ``events`` in order."""
    book = OrderBook()
    ids: dict[OrderKey, int] = {}  # (side, seq) -> engine order_id
    keys: dict[int, OrderKey] = {}  # and back
    problems: list[str] = []
    # Engine ids are just a counter and the dicts translate: the engine wants one
    # id space for both sides, and this assumes nothing about Phoenix's numbering.
    # (Not len(ids) + 1: re-adding a key would then reuse an id that still rests.)
    new_id = itertools.count(1)

    def add(o: BookOrder) -> None:
        order_id = next(new_id)
        ids[o.key] = order_id
        keys[order_id] = o.key
        if book.add_order(order_id, o.side, o.price_ticks, o.lots):
            # A fill means the order crossed the book. Report it: the engine must
            # not quietly trade away orders that B says are still resting.
            problems.append(f"engine traded when adding {o}: the book was crossed")

    # Best price first, oldest first: appending at the tail of each level means
    # the first order added at a price ends up at the head, as on Phoenix.
    for o in a.bids + a.asks:
        add(o)

    for e in events:
        o = e.order
        if e.kind is EventKind.ADD:
            add(o)
        elif e.kind is EventKind.REDUCE:
            book.reduce_order(ids[o.key], o.lots)
        else:  # REMOVE or EXPIRE: either way the order leaves the book
            book.cancel_order(ids[o.key])
    return Replayed(book, keys, problems)


Level = tuple[int, list[tuple[int, int]]]  # (price_ticks, [(seq, lots), ...] head -> tail)


def engine_levels(r: Replayed, side: Side) -> list[Level]:
    """The engine's book on one side, best price first, each queue head -> tail."""
    levels = r.book.bids if side is Side.BID else r.book.asks
    items = reversed(levels.items()) if side is Side.BID else levels.items()
    out: list[Level] = []
    for price, level in items:
        queue = []
        node = level.head
        while node is not None:
            queue.append((r.keys[node.order_id][1], node.size_lots))
            node = node.next
        out.append((price, queue))
    return out


def snapshot_levels(orders: list[BookOrder]) -> list[Level]:
    """B's book on one side in the same shape (orders arrive sorted by priority)."""
    out: list[Level] = []
    for o in orders:
        if not out or out[-1][0] != o.price_ticks:
            out.append((o.price_ticks, []))
        out[-1][1].append((o.seq, o.lots))
    return out


def first_difference(r: Replayed, b: PhoenixBook) -> str | None:
    """Compare the replayed engine with snapshot B. None means an exact match."""
    if r.problems:
        return r.problems[0]
    for side, orders in ((Side.BID, b.bids), (Side.ASK, b.asks)):
        got, want = engine_levels(r, side), snapshot_levels(orders)
        # Each level's running total is what depth queries (and so impact) read:
        # it must equal the sum of its orders, which reduce_order has to maintain.
        for (price, queue), (_, total) in zip(got, r.book.depth(side), strict=True):
            if sum(lots for _, lots in queue) != total:
                return f"{side.value}s at {price}: level total {total} != sum of its orders"
        for i, ((g_price, g_queue), (w_price, w_queue)) in enumerate(zip(got, want, strict=False)):
            if g_price != w_price:
                return f"{side.value}s level {i}: engine has price {g_price}, snapshot {w_price}"
            if g_queue != w_queue:
                pos = next(
                    (j for j, (g, w) in enumerate(zip(g_queue, w_queue, strict=False)) if g != w),
                    min(len(g_queue), len(w_queue)),  # one queue is a prefix of the other
                )
                g = g_queue[pos] if pos < len(g_queue) else "nothing"
                w = w_queue[pos] if pos < len(w_queue) else "nothing"
                return (
                    f"{side.value}s at {g_price}, queue position {pos}: "
                    f"engine has (seq, lots) {g}, snapshot has {w}"
                )
        if len(got) != len(want):
            return f"{side.value}s: engine has {len(got)} levels, snapshot {len(want)}"
    bid, ask = r.book.best_bid(), r.book.best_ask()
    if bid is not None and ask is not None and bid >= ask:
        return f"engine book is crossed: best bid {bid} >= best ask {ask}"
    return None


# ---- a whole collector database --------------------------------------------------------


@dataclass(frozen=True, slots=True)
class PairResult:
    """One consecutive pair of Phoenix snapshots, A -> B."""

    a_ts: float  # tick time of A (unix seconds)
    b_ts: float
    diff: Diff
    difference: str | None  # None = the replay reproduced B exactly

    @property
    def match(self) -> bool:
        return self.difference is None


def check_pair(a: PhoenixBook, b: PhoenixBook, a_ts: float = 0, b_ts: float = 0) -> PairResult:
    """Derive A -> B's events, replay them on A, and compare the result with B."""
    diff = derive_events(a, b)
    return PairResult(a_ts, b_ts, diff, first_difference(replay(a, diff.events), b))


def replay_store(store: Store, run_id: int | None = None) -> list[PairResult]:
    """Check every consecutive pair of stored Phoenix snapshots (in tick order).

    Pairs span any gap left by a failed fetch: the diff is still valid, it just
    covers a longer time.
    """
    results: list[PairResult] = []
    prev: tuple[float, PhoenixBook] | None = None
    for s in store.snapshots(venue="phoenix", run_id=run_id):
        raw = s.raw()
        if raw is None or s.slot is None:
            continue  # not a Phoenix account snapshot we can re-decode
        # Only fetched_at is taken from the stored JSON book: it is the clock the
        # collector judged expiry against. The orders themselves come from raw.
        book = decode_book(raw, s.slot, int(s.book().fetched_at))
        if prev is not None:
            results.append(check_pair(prev[1], book, prev[0], s.tick_ts))
        prev = (s.tick_ts, book)
    return results


# ---- command line ------------------------------------------------------------------


COLUMNS = ("min", "new#", "unseen", "adds", "removed", "expired", "reduced", "crossing", "anom")


def _row(label: str, minutes: str, d: Diff, match: str) -> str:
    values = (
        d.seqs_handed_out,
        d.unseen,
        d.count(EventKind.ADD),
        d.count(EventKind.REMOVE),
        d.count(EventKind.EXPIRE),
        d.count(EventKind.REDUCE),
        len(d.crossing_adds),
        len(d.anomalies),
    )
    return f"{label:<15}{minutes:>5}" + "".join(f"{v:>9}" for v in values) + f"  {match}"


def format_results(results: list[PairResult]) -> str:
    def hhmm(ts: float) -> str:
        return datetime.fromtimestamp(ts, UTC).strftime("%H:%M")

    lines = [
        f"{'A -> B (UTC)':<15}"
        + f"{COLUMNS[0]:>5}"
        + "".join(f"{c:>9}" for c in COLUMNS[1:])
        + "  match"
    ]
    total = Diff(events=[])
    for r in results:
        minutes = f"{(r.b_ts - r.a_ts) / 60:.0f}"
        lines.append(
            _row(f"{hhmm(r.a_ts)} -> {hhmm(r.b_ts)}", minutes, r.diff, "yes" if r.match else "NO")
        )
        total.events += r.diff.events
        total.anomalies += r.diff.anomalies
        total.crossing_adds += r.diff.crossing_adds
        total.seqs_handed_out += r.diff.seqs_handed_out
    matched = sum(r.match for r in results)
    lines.append(_row("total", "", total, f"{matched}/{len(results)}"))
    lines.append(
        "new# = resting orders created (Phoenix's counter moved this far; takers get no"
        " number);\nunseen = new# minus adds (rested and vanished between ticks);"
        " removed = filled or cancelled\n(the account can't say which); crossing = adds priced"
        " through A's opposite side."
    )
    for r in results:
        for a in r.diff.anomalies:
            lines.append(f"ANOMALY {hhmm(r.a_ts)} -> {hhmm(r.b_ts)}: {a}")
        if not r.match:
            lines.append(f"MISMATCH {hhmm(r.a_ts)} -> {hhmm(r.b_ts)}: {r.difference}")
    return "\n".join(lines)


def add_parser(sub: argparse._SubParsersAction) -> None:
    """Register ``replay`` on the main parser (``__main__`` calls this)."""
    p = sub.add_parser(
        "replay",
        help="rebuild each Phoenix snapshot from the previous one plus derived events",
        description="Diff consecutive Phoenix snapshots order by order, replay the changes "
        "through the engine, and check the result equals the next snapshot exactly.",
    )
    p.add_argument("--db", default="data/collect.sqlite", help="collector SQLite file")
    p.add_argument("--run", type=int, help="only this run id (default: every run in the file)")
    p.set_defaults(handler=cmd_replay)


def cmd_replay(args: argparse.Namespace) -> None:
    if not Path(args.db).exists():
        sys.exit(f"{args.db} does not exist (collect some data first: collect)")
    with Store(args.db, readonly=True) as store:  # never write to a database being collected
        results = replay_store(store, run_id=args.run)
    if not results:
        sys.exit("need at least two Phoenix snapshots with raw account bytes")
    print(f"Event replay: {len(results)} consecutive Phoenix snapshot pairs from {args.db}")
    print(format_results(results))
    if not all(r.match for r in results):
        sys.exit(1)  # a mismatch is a failed check: say so to scripts and CI too
