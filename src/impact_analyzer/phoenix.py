"""Fetch and decode a Phoenix Legacy market account from Solana.

Phoenix keeps an entire order book in one Solana account: a byte array that
the on-chain program reads and writes in place. To see the book we ask any
Solana RPC node for that account's bytes (``getAccountInfo``) and decode them
ourselves. No Phoenix SDK is needed: the layout below is a direct port of
Ellipsis Labs' own Python client (``phoenix-trade`` on PyPI), which uses the
same offsets.

Account layout (all integers little-endian)::

    [0, 576)        MarketHeader: sizes, token params, lot sizes, tick size
    [576, 832)      256 bytes of padding
    [832, 880)      6 x u64: base_lots_per_base_unit, quote_lots_per_base_unit_per_tick,
                    order sequence number, taker_fee_bps, collected fees, unclaimed fees
    then            bids tree    (16 + 16 + 64 * bids_size bytes)
    then            asks tree    (16 + 16 + 64 * asks_size bytes)
    then            traders tree (not needed for impact)

Each order tree is a red-black tree stored in a fixed array of nodes (the
``sokoban`` crate). We don't walk the tree: we read every allocated node in the
array, drop the ones on the allocator's free list, and sort. That's O(n log n)
on a few hundred orders, which is nothing.
"""

from __future__ import annotations

import base64
import os
import struct
import time
from dataclasses import dataclass
from decimal import Decimal

from .snapshot import BookSnapshot, RestingOrder

SOL_USDC_MARKET = "4DoNfFBfF7UokCC2FQzriy7yHK6DY6NVdYpuekQ5pRgg"
DEFAULT_RPC_URL = "https://api.mainnet-beta.solana.com"
RPC_ENV_VAR = "SOLANA_RPC_URL"

HEADER_SIZE = 576
PADDING_SIZE = 256
MARKET_FIELDS_SIZE = 6 * 8
TREE_PREFIX_SIZE = 16 + 16  # RBTree header (root etc.) + node allocator header
NODE_SIZE = 64  # 4 x i32 registers + 16-byte key + 32-byte value


@dataclass(frozen=True, slots=True)
class MarketHeader:
    """The fields of the 576-byte header that we need (offsets from phoenix-trade)."""

    bids_size: int  # capacity of the bids tree, in nodes
    asks_size: int
    num_seats: int
    base_decimals: int  # SOL: 9
    quote_decimals: int  # USDC: 6
    base_lot_size: int  # base atoms (lamports) per base lot
    quote_lot_size: int  # quote atoms per quote lot
    tick_size_in_quote_atoms_per_base_unit: int
    market_sequence_number: int
    raw_base_units_per_base_unit: int

    @classmethod
    def decode(cls, data: bytes) -> MarketHeader:
        if len(data) < HEADER_SIZE:
            raise ValueError(f"account is {len(data)} bytes, smaller than the header")

        def u64(off: int) -> int:
            return struct.unpack_from("<Q", data, off)[0]

        def u32(off: int) -> int:
            return struct.unpack_from("<I", data, off)[0]

        return cls(
            bids_size=u64(16),
            asks_size=u64(24),
            num_seats=u64(32),
            base_decimals=u32(40),
            quote_decimals=u32(120),
            base_lot_size=u64(112),
            quote_lot_size=u64(192),
            tick_size_in_quote_atoms_per_base_unit=u64(200),
            market_sequence_number=u64(272),
            raw_base_units_per_base_unit=u32(312),
        )

    @property
    def tick_size(self) -> Decimal:
        """USD (quote units) per tick, for one whole SOL."""
        return Decimal(self.tick_size_in_quote_atoms_per_base_unit) / (
            Decimal(10) ** self.quote_decimals * max(self.raw_base_units_per_base_unit, 1)
        )

    @property
    def lot_size(self) -> Decimal:
        """SOL per base lot."""
        return Decimal(self.base_lot_size) / Decimal(10) ** self.base_decimals


@dataclass(frozen=True, slots=True)
class PhoenixOrder:
    price_in_ticks: int
    order_sequence_number: int  # lower = older = higher time priority
    trader_index: int
    num_base_lots: int
    last_valid_slot: int  # 0 = no expiry
    last_valid_unix_timestamp_in_seconds: int  # 0 = no expiry

    def is_expired(self, slot: int, now: int) -> bool:
        """Expired orders stay in the account until something touches them, so skip them."""
        if self.last_valid_slot and self.last_valid_slot < slot:
            return True
        ts = self.last_valid_unix_timestamp_in_seconds
        return bool(ts and ts < now)


@dataclass(frozen=True, slots=True)
class PhoenixMarket:
    header: MarketHeader
    taker_fee_bps: int
    bids: list[PhoenixOrder]  # best first, then oldest first
    asks: list[PhoenixOrder]


def decode_order_tree(buf: bytes) -> list[PhoenixOrder]:
    """Read every live node of one order tree (bids or asks), unsorted.

    Allocator header (bytes 16..32 of the tree): size u64, bump_index i32,
    free_list_head i32. ``bump_index`` is one past the last node ever
    allocated, and node indices are 1-based (0 means "null"). Freed nodes form
    a linked list through their first register.
    """
    bump_index, free_list_head = struct.unpack_from("<ii", buf, 16 + 8)
    n_allocated = max(bump_index - 1, 0)

    nodes: list[tuple[int, PhoenixOrder]] = []  # (next-free pointer, order)
    for i in range(n_allocated):
        off = TREE_PREFIX_SIZE + i * NODE_SIZE
        if off + NODE_SIZE > len(buf):
            break
        registers = struct.unpack_from("<4i", buf, off)
        price, seq, trader, lots, slot, ts = struct.unpack_from("<6Q", buf, off + 16)
        nodes.append((registers[0], PhoenixOrder(price, seq, trader, lots, slot, ts)))

    free: set[int] = set()
    head = free_list_head
    while 0 < head < bump_index:
        index = head - 1  # 1-based -> 0-based
        if index in free:
            raise ValueError("free list has a cycle")
        free.add(index)
        head = nodes[index][0]

    return [order for i, (_, order) in enumerate(nodes) if i not in free]


def order_trees_end(header: MarketHeader) -> int:
    """Byte offset just past the asks tree. The rest of the account (trader seats,
    ~1.2 MB on SOL/USDC) isn't needed to rebuild the book, so the collector stores
    only ``data[:order_trees_end(header)]``.
    """
    trees = 2 * TREE_PREFIX_SIZE + NODE_SIZE * (header.bids_size + header.asks_size)
    return HEADER_SIZE + PADDING_SIZE + MARKET_FIELDS_SIZE + trees


def decode_market(data: bytes, slot: int = 0, now: int | None = None) -> PhoenixMarket:
    """Decode a raw Phoenix market account. Expired and empty orders are dropped."""
    now = int(time.time()) if now is None else now
    header = MarketHeader.decode(data)

    off = HEADER_SIZE + PADDING_SIZE
    taker_fee_bps = struct.unpack_from("<6Q", data, off)[3]
    off += MARKET_FIELDS_SIZE

    bids_len = TREE_PREFIX_SIZE + NODE_SIZE * header.bids_size
    asks_len = TREE_PREFIX_SIZE + NODE_SIZE * header.asks_size
    bids_raw = decode_order_tree(data[off : off + bids_len])
    asks_raw = decode_order_tree(data[off + bids_len : off + bids_len + asks_len])

    def live(orders: list[PhoenixOrder]) -> list[PhoenixOrder]:
        return [o for o in orders if o.num_base_lots and not o.is_expired(slot, now)]

    # Time priority: within a price, the lower sequence number is older and fills
    # first. (phoenix-trade sorts bids by (price, seq) reversed, which puts the
    # newest bid first within a price; harmless for display, wrong for a
    # matching engine.)
    bids = sorted(live(bids_raw), key=lambda o: (-o.price_in_ticks, o.order_sequence_number))
    asks = sorted(live(asks_raw), key=lambda o: (o.price_in_ticks, o.order_sequence_number))
    return PhoenixMarket(header, taker_fee_bps, bids, asks)


def to_snapshot(
    market: PhoenixMarket, address: str, slot: int, fetched_at: float | None = None
) -> BookSnapshot:
    h = market.header
    snap = BookSnapshot(
        venue="phoenix",
        symbol="SOL/USDC",
        fetched_at=time.time() if fetched_at is None else fetched_at,
        tick_size=h.tick_size,
        lot_size=h.lot_size,
        bids=[RestingOrder(o.price_in_ticks, o.num_base_lots) for o in market.bids],
        asks=[RestingOrder(o.price_in_ticks, o.num_base_lots) for o in market.asks],
        meta={
            "address": address,
            "slot": slot,
            "taker_fee_bps": market.taker_fee_bps,
            "market_sequence_number": h.market_sequence_number,
        },
    )
    snap.validate()
    return snap


def fetch_account(rpc_url: str, address: str, timeout: float = 15.0) -> tuple[bytes, int]:
    """Return ``(account bytes, slot)`` via the standard JSON-RPC ``getAccountInfo``."""
    import httpx

    payload = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "getAccountInfo",
        "params": [address, {"encoding": "base64", "commitment": "confirmed"}],
    }
    resp = httpx.post(rpc_url, json=payload, timeout=timeout)
    resp.raise_for_status()
    return parse_account_response(resp.json(), address)


def parse_account_response(body: dict, address: str) -> tuple[bytes, int]:
    """Pull ``(account bytes, slot)`` out of a ``getAccountInfo`` JSON-RPC response."""
    if "error" in body:
        raise RuntimeError(f"RPC error: {body['error']}")
    value = body["result"]["value"]
    if value is None:
        raise RuntimeError(f"account {address} not found")
    data_b64, encoding = value["data"]
    if encoding != "base64":
        raise RuntimeError(f"unexpected encoding {encoding!r}")
    return base64.b64decode(data_b64), body["result"]["context"]["slot"]


def fetch_snapshot(rpc_url: str | None = None, address: str = SOL_USDC_MARKET) -> BookSnapshot:
    rpc_url = rpc_url or os.environ.get(RPC_ENV_VAR) or DEFAULT_RPC_URL
    data, slot = fetch_account(rpc_url, address)
    fetched_at = time.time()
    return to_snapshot(decode_market(data, slot, int(fetched_at)), address, slot, fetched_at)
