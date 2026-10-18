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
class Field:
    """One field of the account layout: where it lives and how to read it."""

    name: str
    offset: int  # bytes from the start of the enclosing structure
    size: int  # bytes
    type: str  # "u32", "u64", "pubkey" (32 bytes) or "bytes" (padding / unused)


# The 576-byte MarketHeader, field by field (offsets from phoenix-trade's layout).
# One table serves both the decoder below and the course's hex explorer (export.py),
# so the two can never disagree about where a field is.
HEADER_LAYOUT: tuple[Field, ...] = (
    Field("discriminant", 0, 8, "bytes"),
    Field("status", 8, 8, "u64"),
    Field("bids_size", 16, 8, "u64"),
    Field("asks_size", 24, 8, "u64"),
    Field("num_seats", 32, 8, "u64"),
    Field("base_decimals", 40, 4, "u32"),
    Field("base_vault_bump", 44, 4, "u32"),
    Field("base_mint", 48, 32, "pubkey"),
    Field("base_vault", 80, 32, "pubkey"),
    Field("base_lot_size", 112, 8, "u64"),
    Field("quote_decimals", 120, 4, "u32"),
    Field("quote_vault_bump", 124, 4, "u32"),
    Field("quote_mint", 128, 32, "pubkey"),
    Field("quote_vault", 160, 32, "pubkey"),
    Field("quote_lot_size", 192, 8, "u64"),
    Field("tick_size_in_quote_atoms_per_base_unit", 200, 8, "u64"),
    Field("authority", 208, 32, "pubkey"),
    Field("fee_recipient", 240, 32, "pubkey"),
    Field("market_sequence_number", 272, 8, "u64"),
    Field("successor", 280, 32, "pubkey"),
    Field("raw_base_units_per_base_unit", 312, 4, "u32"),
    Field("header_padding", 316, HEADER_SIZE - 316, "bytes"),
)
# The six u64s right after the 256 bytes of padding (offsets from the account start).
MARKET_FIELDS_OFFSET = HEADER_SIZE + PADDING_SIZE
MARKET_FIELD_NAMES = (
    "base_lots_per_base_unit",
    "quote_lots_per_base_unit_per_tick",
    "order_sequence_number",
    "taker_fee_bps",
    "collected_quote_lot_fees",
    "unclaimed_quote_lot_fees",
)
# Start of an order tree (offsets from the tree's first byte).
TREE_LAYOUT: tuple[Field, ...] = (
    Field("root", 0, 4, "u32"),
    Field("tree_padding", 4, 12, "bytes"),
    Field("allocator_size", 16, 8, "u64"),
    Field("bump_index", 24, 4, "u32"),
    Field("free_list_head", 28, 4, "u32"),
)
# One 64-byte node (offsets from the node's first byte): 4 registers, key, value.
NODE_LAYOUT: tuple[Field, ...] = (
    Field("left", 0, 4, "u32"),
    Field("right", 4, 4, "u32"),
    Field("parent", 8, 4, "u32"),
    Field("color", 12, 4, "u32"),
    Field("price_in_ticks", 16, 8, "u64"),
    Field("order_sequence_number", 24, 8, "u64"),
    Field("trader_index", 32, 8, "u64"),
    Field("num_base_lots", 40, 8, "u64"),
    Field("last_valid_slot", 48, 8, "u64"),
    Field("last_valid_unix_timestamp_in_seconds", 56, 8, "u64"),
)
_HEADER = {f.name: f for f in HEADER_LAYOUT}


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

        def read(name: str) -> int:
            f = _HEADER[name]  # offset and width come from HEADER_LAYOUT
            return struct.unpack_from("<Q" if f.type == "u64" else "<I", data, f.offset)[0]

        return cls(
            bids_size=read("bids_size"),
            asks_size=read("asks_size"),
            num_seats=read("num_seats"),
            base_decimals=read("base_decimals"),
            quote_decimals=read("quote_decimals"),
            base_lot_size=read("base_lot_size"),
            quote_lot_size=read("quote_lot_size"),
            tick_size_in_quote_atoms_per_base_unit=read("tick_size_in_quote_atoms_per_base_unit"),
            market_sequence_number=read("market_sequence_number"),
            raw_base_units_per_base_unit=read("raw_base_units_per_base_unit"),
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
    order_sequence_number: int  # real (un-flipped) number: lower = older = fills first
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


U64_MASK = (1 << 64) - 1


def decode_order_tree(buf: bytes, is_bids: bool = False) -> list[PhoenixOrder]:
    """Read every live node of one order tree (bids or asks), unsorted.

    Bids store their sequence number bit-flipped (``!seq`` in Rust). The tree
    keeps each side sorted by its key (price, seq), and the program reads bids
    from the high end. Flipping the bits makes an *older* bid (smaller seq) a
    *larger* stored value, so at one price it still comes first. We undo the
    flip here, so ``order_sequence_number`` always means the real number.

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
        if is_bids:
            seq = ~seq & U64_MASK  # un-flip (see docstring); Python ints need the mask
        nodes.append((registers[0], PhoenixOrder(price, seq, trader, lots, slot, ts)))

    free = free_node_indices(buf)
    return [order for i, (_, order) in enumerate(nodes) if i not in free]


def free_node_indices(buf: bytes) -> set[int]:
    """0-based indices of the nodes on one tree's free list (deleted, waiting for reuse).

    The list starts at ``free_list_head`` and each free node's first register
    points at the next one (1-based; 0 ends the list).
    """
    bump_index, head = struct.unpack_from("<ii", buf, 16 + 8)
    free: set[int] = set()
    while 0 < head < bump_index:
        index = head - 1  # 1-based -> 0-based
        if index in free:
            raise ValueError("free list has a cycle")
        off = TREE_PREFIX_SIZE + index * NODE_SIZE
        if off + 4 > len(buf):
            break  # a truncated buffer: stop rather than read past the end
        free.add(index)
        head = struct.unpack_from("<i", buf, off)[0]
    return free


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
    bids_raw = decode_order_tree(data[off : off + bids_len], is_bids=True)
    asks_raw = decode_order_tree(data[off + bids_len : off + bids_len + asks_len])

    def live(orders: list[PhoenixOrder]) -> list[PhoenixOrder]:
        return [o for o in orders if o.num_base_lots and not o.is_expired(slot, now)]

    # Time priority: within a price, the lower (un-flipped) sequence number is
    # older and fills first. v1 sorted bids by the *stored* number, which put the
    # newest bid first; checking real account bytes in v2 caught it.
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
