"""Event replay on synthetic Phoenix accounts (encoded byte for byte, no network).

The main scenario, snapshot A -> snapshot B (prices in ticks, sizes in lots):

    bids  A: 100: #1 x50, #3 x20 | 99: #2 x40      B: 100: #1 x50, #3 x20, #8 x15, #9 x5
    asks  A: 102: #4 x30, #5 x10 | 103: #6 x25     B: 102: #4 x12, #5 x10 | 103: #7 x5 | 104: #10 x1

So between A and B: bid #2 and ask #6 were removed, ask #4 shrank from 30 to 12
(a partial fill or a size reduce), and four orders were added, two of them at
an existing price (bids #8 and #9 at 100, which must join the back of the queue).
"""

import pytest
from test_fetchers import build_account

from impact_analyzer import phoenix
from impact_analyzer.__main__ import main
from impact_analyzer.orderbook import Side
from impact_analyzer.replay import (
    BookOrder,
    Event,
    EventKind,
    check_pair,
    decode_book,
    derive_events,
    engine_levels,
    first_difference,
    replay,
)
from impact_analyzer.store import SnapshotRecord, Store, TickRecord

BID, ASK = Side.BID, Side.ASK
ADD, REMOVE, EXPIRE, REDUCE = EventKind.ADD, EventKind.REMOVE, EventKind.EXPIRE, EventKind.REDUCE

# Node order in the account is deliberately not priority order: the decoder must sort.
A_BIDS = [(100, 3, 20), (99, 2, 40), (100, 1, 50)]
A_ASKS = [(102, 4, 30), (103, 6, 25), (102, 5, 10)]
B_BIDS = [(100, 9, 5), (100, 3, 20), (100, 8, 15), (100, 1, 50)]
B_ASKS = [(102, 4, 12), (104, 10, 1), (102, 5, 10), (103, 7, 5)]


def book(bids, asks, next_seq, slot=10, now=1_000, **kwargs):
    return decode_book(build_account(bids, asks, next_seq=next_seq, **kwargs), slot, now)


@pytest.fixture
def a():
    return book(A_BIDS, A_ASKS, next_seq=7)


@pytest.fixture
def b():
    return book(B_BIDS, B_ASKS, next_seq=11)


def summary(events: list[Event]) -> list[tuple]:
    return [(e.kind, e.order.side, e.order.seq, e.order.lots) for e in events]


def test_decoded_book_has_identity_and_time_priority(a):
    # Bids are stored with bit-flipped sequence numbers; decode_book must undo the
    # flip, so the older bid (#1) is ahead of #3 at the same price.
    assert [(o.price_ticks, o.seq) for o in a.bids] == [(100, 1), (100, 3), (99, 2)]
    assert [(o.price_ticks, o.seq) for o in a.asks] == [(102, 4), (102, 5), (103, 6)]
    assert a.next_seq == 7 and a.expired == frozenset()


def test_derives_removals_reductions_then_adds_in_seq_order(a, b):
    diff = derive_events(a, b)
    assert summary(diff.events) == [
        (REMOVE, BID, 2, 40),  # filled or cancelled: the account can't say which
        (REMOVE, ASK, 6, 25),
        (REDUCE, ASK, 4, 12),  # the order as it is in B: 12 lots left
        (ADD, ASK, 7, 5),
        (ADD, BID, 8, 15),
        (ADD, BID, 9, 5),
        (ADD, ASK, 10, 1),
    ]
    assert diff.anomalies == [] and diff.crossing_adds == []
    assert diff.seqs_handed_out == 4 and diff.unseen == 0


def test_replay_reproduces_the_next_snapshot_exactly(a, b):
    diff = derive_events(a, b)
    r = replay(a, diff.events)
    assert first_difference(r, b) is None
    # New bids joined the back of the 100 queue; the reduced ask kept its place at the head.
    assert engine_levels(r, BID) == [(100, [(1, 50), (3, 20), (8, 15), (9, 5)])]
    assert engine_levels(r, ASK) == [(102, [(4, 12), (5, 10)]), (103, [(7, 5)]), (104, [(10, 1)])]
    assert r.book.depth(ASK)[0] == (102, 22)  # reduce_order kept the level total in sync
    assert check_pair(a, b).match


def test_an_add_inserted_ahead_of_an_older_order_is_a_mismatch(a, b):
    events = derive_events(a, b).events
    i8 = next(i for i, e in enumerate(events) if e.order.seq == 8)
    events[i8], events[i8 + 1] = events[i8 + 1], events[i8]  # #9 now arrives before #8
    diff = first_difference(replay(a, events), b)
    assert diff == (
        "bids at 100, queue position 2: engine has (seq, lots) (9, 5), snapshot has (8, 15)"
    )


def test_a_reduce_replayed_as_cancel_and_readd_loses_queue_place(a, b):
    """Shrinking must not cost an order its place: cancel + re-add puts #4 behind #5."""
    events = []
    for e in derive_events(a, b).events:
        if e.kind is REDUCE:
            events += [Event(REMOVE, e.order), Event(ADD, e.order)]
        else:
            events.append(e)
    diff = first_difference(replay(a, events), b)
    assert diff is not None and diff.startswith("asks at 102, queue position 0")


def test_an_order_past_its_expiry_counts_as_expired_not_removed():
    # Bid #2 (node 1) is valid until slot 20. B still holds it in the account, but B
    # was taken at slot 30, so the decoder drops it from the book.
    a = book(A_BIDS, A_ASKS, next_seq=7, slot=10, expiries={1: (20, 0)})
    b = book(A_BIDS, A_ASKS, next_seq=7, slot=30, expiries={1: (20, 0)})
    assert b.expired == {(BID, 2)}
    result = check_pair(a, b)
    assert summary(result.diff.events) == [(EXPIRE, BID, 2, 40)]
    assert result.match


def test_impossible_transitions_are_flagged(a):
    # Same ids as A, but #1 grew, #5 moved price, #6 changed owner; #3 is new but
    # carries a number handed out before A (A's counter was already 7).
    b = book(
        bids=[(100, 1, 60), (100, 3, 20), (99, 2, 40)],
        asks=[(102, 4, 30), (101, 5, 10), (103, 6, 25, 42)],
        next_seq=7,
    )
    a_without_3 = book([(99, 2, 40), (100, 1, 50)], A_ASKS, next_seq=7)
    assert len(derive_events(a, b).anomalies) == 3
    diff = derive_events(a_without_3, b)
    assert any("seq outside [7, 7)" in s for s in diff.anomalies)
    # Anomalies have no legal event, so they are not replayed: B can't be reproduced.
    assert not check_pair(a, b).match


def test_an_add_priced_through_the_old_book_is_flagged_as_crossing(a):
    # Both asks at 102 are gone and a new bid rests at 102: when it arrived it was at
    # or above A's best ask, so it either traded with them or they were cancelled first.
    b = book(A_BIDS + [(102, 7, 8)], [(103, 6, 25)], next_seq=8)
    result = check_pair(a, b)
    assert [o.seq for o in result.diff.crossing_adds] == [7]
    assert result.match  # removals are applied first, so the engine never trades


def test_the_engine_never_trades_silently(a):
    r = replay(a, [Event(ADD, BookOrder(BID, 102, 7, 0, 5))])  # crosses the asks at 102
    assert first_difference(r, a).startswith("engine traded when adding bid #7")


# ---- the command, on a small collector database -------------------------------------------


def write_db(path, accounts: list[bytes]) -> None:
    t0 = 1_800_000_000.0
    with Store(path) as store:
        run = store.create_run(t0, t0 + 300 * len(accounts), 300, {"test": True})
        for i, raw in enumerate(accounts):
            ts = t0 + 300 * i
            snap = phoenix.to_snapshot(phoenix.decode_market(raw, 10, 1_000), "Addr", 10, ts)
            record = SnapshotRecord("phoenix", ts, ts, 1, True, slot=10, snapshot=snap, raw=raw)
            store.insert_tick(run.run_id, TickRecord(ts, ts, ts, 10, None, None, [record], []))


def test_replay_command_prints_counts_and_passes(tmp_path, capsys):
    a = build_account(A_BIDS, A_ASKS, next_seq=7)
    b = build_account(B_BIDS, B_ASKS, next_seq=11)
    write_db(tmp_path / "c.sqlite", [a, b, b])
    main(["replay", "--db", str(tmp_path / "c.sqlite")])
    out = capsys.readouterr().out
    assert "2 consecutive Phoenix snapshot pairs" in out
    total = next(line for line in out.splitlines() if line.startswith("total"))
    # new#, unseen, adds, removed, expired, reduced, crossing, anomalies, matched
    assert total.split()[1:] == ["4", "0", "4", "2", "0", "1", "0", "0", "2/2"]


def test_replay_command_exits_non_zero_on_a_mismatch(tmp_path, capsys):
    a = build_account(A_BIDS, A_ASKS, next_seq=7)
    grown = build_account([(100, 3, 20), (99, 2, 40), (100, 1, 99)], A_ASKS, next_seq=7)
    write_db(tmp_path / "c.sqlite", [a, grown])
    with pytest.raises(SystemExit) as exit_info:
        main(["replay", "--db", str(tmp_path / "c.sqlite")])
    assert exit_info.value.code == 1
    out = capsys.readouterr().out
    assert "ANOMALY" in out and "MISMATCH" in out
