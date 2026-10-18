"""Fetchers, tested offline: CEX parsers on fixtures, Phoenix on a synthetic account."""

import struct
from decimal import Decimal

import pytest

from impact_analyzer import phoenix
from impact_analyzer.cex import parse_coinbase, parse_kraken
from impact_analyzer.snapshot import RestingOrder

# ---- Kraken / Coinbase ----------------------------------------------------------

KRAKEN = {
    "error": [],
    "result": {
        "SOLUSD": {
            "asks": [["150.12", "3.5", 1700000000], ["150.13", "10.00000000", 1700000001]],
            "bids": [["150.10", "2.25", 1700000000], ["150.05", "100", 1700000002]],
        }
    },
}

COINBASE = {
    "bids": [["150.09", "4.1", 3], ["150.08", "1", 1]],
    "asks": [["150.11", "0.5", 1], ["150.15", "20.123456789", 7]],
    "sequence": 42,
}


def test_parse_kraken():
    s = parse_kraken(KRAKEN, fetched_at=1.0)
    assert s.venue == "kraken"
    assert s.best_bid() == 150_100_000 and s.best_ask() == 150_120_000  # $1e-6 ticks
    assert s.size(s.asks[0].size_lots) == pytest.approx(3.5)
    assert s.mid_price() == pytest.approx(150.11)


def test_parse_kraken_error():
    with pytest.raises(RuntimeError):
        parse_kraken({"error": ["EQuery:Unknown asset pair"], "result": {}})


def test_parse_coinbase_rounds_size_down():
    s = parse_coinbase(COINBASE, fetched_at=1.0)
    assert s.meta["sequence"] == 42
    assert s.asks[1].size_lots == 2_012_345_678  # 20.123456789 SOL -> 1e-8 lots, rounded down


# ---- Phoenix --------------------------------------------------------------------


def build_account(
    bids: list[tuple[int, int, int]],
    asks: list[tuple[int, int, int]],
    capacity: int = 8,
    free_bid_nodes: tuple[int, ...] = (),
    expiries: dict[int, tuple[int, int]] | None = None,
) -> bytes:
    """Encode a minimal Phoenix market account, mirroring the layout phoenix.py decodes.

    Orders are (price_ticks, sequence_number, base_lots). ``free_bid_nodes`` are
    0-based node indices in the bids tree to put on the free list (their data
    is left in place, as on-chain). ``expiries`` maps a bid node index to
    (last_valid_slot, last_valid_unix_timestamp).
    """
    expiries = expiries or {}
    header = bytearray(phoenix.HEADER_SIZE)
    struct.pack_into("<QQQ", header, 16, capacity, capacity, 1)  # bids, asks, seats
    struct.pack_into("<I", header, 40, 9)  # base decimals (SOL)
    struct.pack_into("<Q", header, 112, 1_000_000)  # base lot = 0.001 SOL
    struct.pack_into("<I", header, 120, 6)  # quote decimals (USDC)
    struct.pack_into("<Q", header, 192, 1)
    struct.pack_into("<Q", header, 200, 1_000)  # tick = 1000 quote atoms = $0.001
    struct.pack_into("<I", header, 312, 1)

    fields = struct.pack("<6Q", 1000, 1, 99, 5, 0, 0)  # taker fee 5 bps

    def tree(orders, free_nodes=(), exp=None, flip_seq=False):
        exp = exp or {}
        nodes = bytearray(phoenix.NODE_SIZE * capacity)
        free_sorted = list(free_nodes)
        for i, (price, seq, lots) in enumerate(orders):
            slot, ts = exp.get(i, (0, 0))
            next_free = 0
            if i in free_sorted:
                k = free_sorted.index(i)
                next_free = free_sorted[k + 1] + 1 if k + 1 < len(free_sorted) else 0
            struct.pack_into("<4i", nodes, i * 64, next_free, 0, 0, 0)
            stored = ~seq & phoenix.U64_MASK if flip_seq else seq  # bids: !seq, as on-chain
            struct.pack_into("<6Q", nodes, i * 64 + 16, price, stored, 0, lots, slot, ts)
        bump = len(orders) + 1
        head = free_sorted[0] + 1 if free_sorted else 0
        alloc = struct.pack("<Qii", capacity, bump, head)
        return bytes(16) + alloc + bytes(nodes)

    return (
        bytes(header)
        + bytes(phoenix.PADDING_SIZE)
        + fields
        + tree(bids, free_bid_nodes, expiries, flip_seq=True)
        + tree(asks)
        + bytes(64)  # stand-in for the traders tree
    )


def test_header_units():
    h = phoenix.MarketHeader.decode(build_account([], []))
    assert h.tick_size == Decimal("0.001")
    assert h.lot_size == Decimal("0.001")


def test_decode_sorts_by_price_then_age():
    data = build_account(
        bids=[(149_900, 5, 100), (150_000, 7, 200), (150_000, 3, 300)],
        asks=[(150_200, 9, 50), (150_100, 8, 60)],
    )
    m = phoenix.decode_market(data, slot=10, now=1_000)
    assert m.taker_fee_bps == 5
    # Best bid first; at 150.000 the older order (seq 3) is ahead of seq 7.
    assert [(o.price_in_ticks, o.order_sequence_number) for o in m.bids] == [
        (150_000, 3),
        (150_000, 7),
        (149_900, 5),
    ]
    assert [o.price_in_ticks for o in m.asks] == [150_100, 150_200]


def test_bid_sequence_numbers_are_stored_bit_flipped():
    # Two bids at one price: seq 3 is older than seq 7, so it must fill first, even
    # though its *stored* value (!3) is larger than !7. v1 got this backwards.
    data = build_account(bids=[(150_000, 7, 1), (150_000, 3, 1)], asks=[(150_100, 8, 1)])
    tree_start = phoenix.HEADER_SIZE + phoenix.PADDING_SIZE + phoenix.MARKET_FIELDS_SIZE
    stored = struct.unpack_from("<Q", data, tree_start + phoenix.TREE_PREFIX_SIZE + 24)[0]
    assert stored == ~7 & phoenix.U64_MASK  # what's really in the bytes
    m = phoenix.decode_market(data, slot=0, now=0)
    assert [o.order_sequence_number for o in m.bids] == [3, 7]


def test_decode_skips_free_list_nodes():
    data = build_account(
        bids=[(150_000, 1, 10), (149_000, 2, 20), (148_000, 3, 30)],
        asks=[(151_000, 4, 10)],
        free_bid_nodes=(0, 2),
    )
    m = phoenix.decode_market(data, slot=0, now=0)
    assert [o.price_in_ticks for o in m.bids] == [149_000]


def test_decode_skips_expired_orders():
    data = build_account(
        bids=[(150_000, 1, 10), (149_000, 2, 20), (148_000, 3, 30)],
        asks=[(151_000, 4, 10)],
        expiries={0: (50, 0), 1: (0, 500), 2: (200, 2_000)},  # slot-expired, ts-expired, alive
    )
    m = phoenix.decode_market(data, slot=100, now=1_000)
    assert [o.price_in_ticks for o in m.bids] == [148_000]


def test_to_snapshot_feeds_the_engine():
    data = build_account(bids=[(149_900, 1, 1_000)], asks=[(150_100, 2, 2_000)])
    snap = phoenix.to_snapshot(phoenix.decode_market(data, 0, 0), "addr", slot=123)
    assert snap.bids == [RestingOrder(149_900, 1_000)]
    assert snap.price(snap.best_ask()) == pytest.approx(150.1)
    assert snap.size(snap.asks[0].size_lots) == pytest.approx(2.0)
    assert snap.mid_price() == pytest.approx(150.0)
    assert snap.meta["slot"] == 123


@pytest.mark.network
def test_live_phoenix():  # pragma: no cover - run with: pytest -m network
    snap = phoenix.fetch_snapshot()
    assert 1 < snap.mid_price() < 10_000
