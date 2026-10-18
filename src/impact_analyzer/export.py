"""JSON exports for the web playground (v1) and the course (v2).

    python -m impact_analyzer export --db data/collect.sqlite --out course/data/export.json

**v1** (``export_for_playground``, written by ``analyze``): each venue's book
aggregated by price level, its impact curve, and an AMM benchmark size.

**v2** (``export_v2``, PLAN section 3.4) is a strict superset: the same v1
fields, so anything that loads v1 still works, plus

- per venue ``fee_bps`` and ``depth_usd`` (``{"0.005": [bid, ask], ...}``);
- ``jupiter``: the newest tick's quotes, costed against the reference mid;
- ``timeseries``: one array per metric, aligned with ``t`` (null = no data
  for that tick, or a partial fill, which is never shown as a full one);
- ``phoenix_account``: a real slice of the Phoenix market account's bytes (the
  header, the market fields, the start of the bids tree) with a field map for
  the course's hex explorer: every field's offset, size, type, decoded value
  and a one-sentence explanation.

JavaScript numbers are doubles, exact only up to 2**53. Some u64 fields (bid
sequence numbers, see below) are bigger, so those values are written as
strings rather than silently rounded by the browser.
"""

from __future__ import annotations

import argparse
import json
import struct
import sys
import time
from collections.abc import Iterable, Sequence
from pathlib import Path

from . import phoenix
from .amm import equivalent_pool
from .impact import DEFAULT_MAX_SLIPPAGE, DEFAULT_SIZES_USD, impact_curve, log_spaced_sizes
from .metrics import BookMetrics, Dataset, load_dataset, size_key
from .snapshot import BookSnapshot, RestingOrder
from .store import Store, StoredSnapshot

EXPORT_KIND = "impact-analyzer-export"
MAX_EXPORT_BYTES = 2_000_000  # the course inlines this file; keep page loads quick
MAX_SAFE_INTEGER = 2**53 - 1  # largest integer a JavaScript number holds exactly
HEX_NODES = 6  # bids-tree nodes included in the hex slice


# ---- v1 ------------------------------------------------------------------------------------


def book_levels(snap: BookSnapshot, orders: Iterable[RestingOrder], max_levels: int) -> list:
    """``[[price_usd, size_sol], ...]`` per price level, best first (orders at one price summed)."""
    agg: dict[int, int] = {}
    for o in orders:  # dicts keep insertion order: best price first
        agg[o.price_ticks] = agg.get(o.price_ticks, 0) + o.size_lots
    items = list(agg.items())[:max_levels]
    return [[snap.price(p), snap.size(s)] for p, s in items]


def venue_entry(snap: BookSnapshot, curve: dict, max_levels: int = 400) -> dict:
    """One v1 venue object."""
    return {
        "venue": snap.venue,
        "symbol": snap.symbol,
        "fetched_at": snap.fetched_at,
        "mid": snap.mid_price(),
        "spread_bps": snap.spread_bps(),
        "bids": book_levels(snap, snap.bids, max_levels),
        "asks": book_levels(snap, snap.asks, max_levels),
        "curve": {
            side: [[r.target_usd, r.impact_bps, r.fully_filled] for r in curve[side]]
            for side in ("buy", "sell")
        },
        "meta": snap.meta,
    }


def export_for_playground(
    snaps: list[BookSnapshot], curves: dict, amm_usd: float | None, max_levels: int = 400
) -> dict:
    """Aggregate each book by price level, in USD and SOL, for the web playground (v1)."""
    return {
        "kind": EXPORT_KIND,
        "version": 1,
        "generated_at": time.time(),
        "venues": [venue_entry(s, curves[s.venue], max_levels) for s in snaps],
        "amm_usd_reserve": amm_usd,
    }


# ---- v2: the Phoenix hex slice ----------------------------------------------------------------

B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


def base58(data: bytes) -> str:
    """Solana writes public keys in base58 (Bitcoin's alphabet: no 0, O, I or l)."""
    n = int.from_bytes(data, "big")
    out = ""
    while n:
        n, r = divmod(n, 58)
        out = B58_ALPHABET[r] + out
    leading_zeros = len(data) - len(data.lstrip(b"\0"))
    return "1" * leading_zeros + out  # each leading zero byte is written as "1"


# One plain-English sentence per field, for a reader who has never seen a byte layout.
EXPLAIN: dict[str, str] = {
    "discriminant": "A fixed 8-byte tag the program checks first, so it can't mistake some "
    "other account for a market.",
    "status": "The market's state: 1 means active (anyone can trade); others are post-only, "
    "paused or closed.",
    "bids_size": "How many bid orders the bids tree has room for: the array is allocated at "
    "full size up front.",
    "asks_size": "How many ask orders the asks tree has room for.",
    "num_seats": "How many trader seats the account has room for (its capacity, not how many "
    "are taken). A seat is the permission to place resting orders on this market.",
    "base_decimals": "SOL has 9 decimals: 1 SOL = 1,000,000,000 lamports, the smallest unit.",
    "base_vault_bump": "A number used to derive the vault's address; not needed to read the book.",
    "base_mint": "The token being traded (base): this address is SOL.",
    "base_vault": "The account that holds the market's SOL on behalf of its traders.",
    "base_lot_size": "Lamports per base lot: order sizes are whole lots, so the smallest order "
    "is one lot.",
    "quote_decimals": "USDC has 6 decimals: 1 USDC = 1,000,000 atoms.",
    "quote_vault_bump": "A number used to derive the quote vault's address.",
    "quote_mint": "The token prices are quoted in: this address is USDC.",
    "quote_vault": "The account that holds the market's USDC.",
    "quote_lot_size": "USDC atoms per quote lot, the unit fees and balances are counted in.",
    "tick_size_in_quote_atoms_per_base_unit": "The price step: USDC atoms per whole SOL per "
    "tick, so prices are always whole numbers of ticks.",
    "authority": "The key allowed to change the market's settings.",
    "fee_recipient": "Where collected taker fees are sent.",
    "market_sequence_number": "A counter that goes up with every instruction that changes the "
    "market: the difference between two snapshots counts what happened in between.",
    "successor": "The key that would take over as authority if it were handed on.",
    "raw_base_units_per_base_unit": "How many raw SOL units count as one 'unit' for pricing "
    "(1 here).",
    "header_padding": "Reserved space, all zeros, so the header can grow without moving anything.",
    "market_padding": "More reserved space between the header and the market's own fields.",
    "base_lots_per_base_unit": "Lots per whole SOL: converts a size in lots into SOL.",
    "quote_lots_per_base_unit_per_tick": "Quote lots per whole SOL per tick: converts a price "
    "in ticks into USDC.",
    "order_sequence_number": "The next order's sequence number: every new order takes one, "
    "which is how time priority is decided.",
    "taker_fee_bps": "The fee a taker pays, in basis points (1 bps = 0.01%) of the trade.",
    "collected_quote_lot_fees": "All fees this market has collected so far, in quote lots.",
    "unclaimed_quote_lot_fees": "Fees collected but not yet sent to the fee recipient.",
    "root": "Index of the red-black tree's root node (1-based; 0 would mean an empty tree).",
    "tree_padding": "Unused bytes that keep the allocator aligned.",
    "allocator_size": "How many nodes are in use right now: the number of resting bids.",
    "bump_index": "One past the highest node ever used: nodes from here on have never been "
    "touched.",
    "free_list_head": "The first deleted node waiting to be reused; each one points to the next.",
    "left": "Index of the left child: the subtree of orders whose key sorts before this one.",
    "free_next": "On the free list this first register is reused: it holds the index of the "
    "next free node. The list ends at a value of 0 or at bump_index (the first never-used "
    "slot); on SOL/USDC it ends at bump_index.",
    "right": "Index of the right child: the subtree of orders whose key sorts after this one.",
    "parent": "Index of this node's parent (0 for the root).",
    "color": "Red-black colour (0 = black, 1 = red): the rule that keeps the tree balanced.",
    "price_in_ticks": "The order's price in ticks.",
    "node_order_sequence_number": "The order's sequence number. For bids Phoenix stores it "
    "bit-flipped (NOT seq, so the top bit is set): walking the tree from its largest key down "
    "then meets the highest price first and, within a price, the oldest bid first.",
    "trader_index": "Which seat placed this order (an index into the traders tree).",
    "num_base_lots": "The order's remaining size, in base lots.",
    "last_valid_slot": "The slot after which the order expires (0 = never).",
    "last_valid_unix_timestamp_in_seconds": "The time after which the order expires (0 = never).",
}


def _value(field: phoenix.Field, data: bytes, at: int):
    raw = data[at : at + field.size]
    if field.type == "u64":
        v = struct.unpack("<Q", raw)[0]
        return str(v) if v > MAX_SAFE_INTEGER else v  # beyond 2**53 JS would round it
    if field.type == "u32":
        return struct.unpack("<I", raw)[0]
    if field.type == "pubkey":
        return base58(raw)
    if len(raw) <= 16:
        return raw.hex()
    return "all zero" if not any(raw) else raw[:16].hex() + "..."


def _entry(field: phoenix.Field, data: bytes, at: int, name: str, explain: str) -> dict:
    return {
        "name": name,
        "offset": at,
        "size": field.size,
        "type": field.type,
        "value": _value(field, data, at),
        "explain": explain,
    }


def phoenix_account_slice(raw: bytes, slot: int | None, address: str, n_nodes: int = HEX_NODES):
    """The first bytes of a real Phoenix market account, and what every field means.

    Covers the header, the padding, the six market fields, the bids tree's
    header and its first ``n_nodes`` nodes. Offsets come from ``phoenix.py``'s
    layout tables, the same ones the decoder uses.
    """
    header = phoenix.MarketHeader.decode(raw)
    tick, lot = header.tick_size, header.lot_size
    fields: list[dict] = []
    for f in phoenix.HEADER_LAYOUT:
        fields.append(_entry(f, raw, f.offset, f.name, EXPLAIN[f.name]))
    pad = phoenix.Field("market_padding", phoenix.HEADER_SIZE, phoenix.PADDING_SIZE, "bytes")
    fields.append(_entry(pad, raw, pad.offset, pad.name, EXPLAIN[pad.name]))
    for i, name in enumerate(phoenix.MARKET_FIELD_NAMES):
        f = phoenix.Field(name, phoenix.MARKET_FIELDS_OFFSET + 8 * i, 8, "u64")
        fields.append(_entry(f, raw, f.offset, name, EXPLAIN[name]))

    tree = phoenix.MARKET_FIELDS_OFFSET + phoenix.MARKET_FIELDS_SIZE  # bids tree starts here
    for f in phoenix.TREE_LAYOUT:
        fields.append(_entry(f, raw, tree + f.offset, f"bids.{f.name}", EXPLAIN[f.name]))
    bids_len = phoenix.TREE_PREFIX_SIZE + phoenix.NODE_SIZE * header.bids_size
    free = phoenix.free_node_indices(raw[tree : tree + bids_len])
    bump = struct.unpack_from("<i", raw, tree + 24)[0]
    for i in range(n_nodes):
        node = tree + phoenix.TREE_PREFIX_SIZE + i * phoenix.NODE_SIZE
        if i >= bump - 1:
            state = "never used"
        elif i in free:
            state = "deleted, on the free list (its old order's bytes are still there)"
        else:
            state = "a live resting bid"
        for f in phoenix.NODE_LAYOUT:
            key = "node_order_sequence_number" if f.name == "order_sequence_number" else f.name
            text = EXPLAIN[key]
            if f.name == "price_in_ticks":
                ticks = struct.unpack_from("<Q", raw, node + f.offset)[0]
                text += f" {ticks:,} x ${tick} = ${float(ticks * tick):,.3f} per SOL."
            elif f.name == "num_base_lots":
                lots = struct.unpack_from("<Q", raw, node + f.offset)[0]
                text += f" {lots:,} x {lot} SOL = {float(lots * lot):,.3f} SOL."
            elif f.name == "left":
                text = EXPLAIN["free_next"] if i in free else text
                text = f"Node {i + 1} is {state}. " + text
            fields.append(_entry(f, raw, node + f.offset, f"bids.node[{i + 1}].{f.name}", text))
    end = tree + phoenix.TREE_PREFIX_SIZE + n_nodes * phoenix.NODE_SIZE
    return {
        "address": address,
        "slot": slot,
        "offset": 0,
        "length": end,
        "account_len": None,  # filled by the caller when known
        "hex": raw[:end].hex(),
        "fields": fields,
    }


# ---- v2: the rest ---------------------------------------------------------------------------


def _r(x: float | None, nd: int) -> float | None:
    """Round for the file (smaller JSON); None stays None."""
    return None if x is None else round(x, nd)


def latest_snapshots(store: Store, run_id: int | None) -> dict[str, StoredSnapshot]:
    """Each venue's newest successful snapshot."""
    latest: dict[str, StoredSnapshot] = {}
    for s in store.snapshots(run_id=run_id):  # time order: later rows overwrite earlier ones
        latest[s.venue] = s
    return latest


def timeseries_block(data: Dataset) -> dict:
    """Arrays aligned with the tick timestamps ``t``: one value (or null) per tick."""
    t = [tk["tick_ts"] for tk in data.ticks]
    index = {ts: i for i, ts in enumerate(t)}
    n = len(t)

    def empty() -> list:
        return [None] * n

    series: dict[str, dict] = {}
    for b in data.books:
        i = index.get(b["tick_ts"])
        if i is None:
            continue
        s = series.setdefault(
            b["venue"],
            {
                "mid": empty(),
                "spread_bps": empty(),
                "depth_2pct_usd": empty(),
                "impact_bps": {"buy": {}, "sell": {}},
                "cost_bps_vs_ref": {"buy": {}, "sell": {}},
                "round_trip_bps": {},
            },
        )
        s["mid"][i] = _r(b["mid"], 4)
        s["spread_bps"][i] = _r(b["spread_bps"], 3)
        if "0.02" in b["depth_usd"]:
            s["depth_2pct_usd"][i] = [round(x) for x in b["depth_usd"]["0.02"]]
        for tr in b["trades"]:
            k = size_key(tr["usd"])
            full = tr["fully_filled"]  # partial fills become null: never shown as full
            imp = s["impact_bps"][tr["side"]].setdefault(k, empty())
            cost = s["cost_bps_vs_ref"][tr["side"]].setdefault(k, empty())
            imp[i] = _r(tr["impact_bps"], 3) if full else None
            cost[i] = _r(tr["cost_bps"], 3) if full else None
        for k, v in b["round_trip_bps"].items():
            s["round_trip_bps"].setdefault(k, empty())[i] = _r(v, 3)
        if b["sequence_number"] is not None:  # Phoenix only
            s.setdefault("sequence_number", empty())[i] = b["sequence_number"]
    for venue_series in series.values():  # events = change since the previous tick with data
        if "sequence_number" not in venue_series:
            continue
        events, prev = empty(), None
        for i, v in enumerate(venue_series["sequence_number"]):
            if v is not None:
                events[i] = v - prev if prev is not None else None
                prev = v
        venue_series["events"] = events
    for q in data.quotes:
        i = index.get(q["tick_ts"])
        if i is None:
            continue
        s = series.setdefault(q["series"], {"cost_bps_vs_ref": {"buy": {}, "sell": {}}})
        arr = s["cost_bps_vs_ref"][q["side"]].setdefault(size_key(q["usd"]), empty())
        arr[i] = _r(q["cost_bps"], 3)
    for rt in data.round_trips:
        if rt["series"].startswith("jupiter:") and (i := index.get(rt["tick_ts"])) is not None:
            s = series.setdefault(rt["series"], {}).setdefault("round_trip_bps", {})
            s.setdefault(size_key(rt["usd"]), empty())[i] = _r(rt["bps"], 3)
    return {
        "interval_s": data.interval_s,
        "t": t,
        "ref_mid": [_r(tk["ref_mid"], 4) for tk in data.ticks],
        "series": series,
    }


def jupiter_block(data: Dataset) -> list[dict]:
    """The newest tick's quotes (ok or not), costed against that tick's reference mid."""
    if not data.quotes:
        return []
    last_tick = max(q["tick_id"] for q in data.quotes)
    return [
        {
            "dex": q["dex"],
            "side": q["side"],
            "usd": q["usd"],
            "ok": q["ok"],
            "cost_bps_vs_ref": _r(q["cost_bps"], 3),
            "avg_price": _r(q["avg_price"], 6),
            "ref_mid": q["ref_mid"],
            "route": q["route"],
            "slot": q["context_slot"],
            "error": q["error"],
        }
        for q in data.quotes
        if q["tick_id"] == last_tick
    ]


def export_v2(
    store: Store,
    run_id: int | None = None,
    sizes_usd: Sequence[float] = DEFAULT_SIZES_USD,
    max_slippage: float = DEFAULT_MAX_SLIPPAGE,
    use_cache: bool = True,
    max_levels: int = 400,
) -> dict:
    """Build the course's data file from a collector database."""
    data = load_dataset(store, run_id, sizes_usd, max_slippage, use_cache)
    metrics_by_id: dict[int, BookMetrics] = {b["snapshot_id"]: b for b in data.books}
    latest = latest_snapshots(store, run_id)
    curve_sizes = log_spaced_sizes(1_000, 1_000_000)  # 8 per decade: smooth curves

    snaps, venues = [], []
    for venue in data.venues:
        stored = latest.get(venue)
        if stored is None:
            continue  # never answered: nothing to show
        snap = stored.book()
        if snap.mid_price() is None:
            continue  # one-sided book: no curve possible
        curve = {
            side: impact_curve(snap, side, curve_sizes, max_slippage) for side in ("buy", "sell")
        }
        entry = venue_entry(snap, curve, max_levels)
        m = metrics_by_id.get(stored.id)
        entry["fee_bps"] = m["fee_bps"] if m else None
        entry["depth_usd"] = m["depth_usd"] if m else {}
        entry["depth_ref_usd"] = m["depth_ref_usd"] if m else {}
        entry["ref_mid"] = m["ref_mid"] if m else None
        entry["tick_ts"] = stored.tick_ts
        snaps.append(snap)
        venues.append(entry)

    # AMM benchmark as in v1: a constant-product pool as deep near the price as Phoenix.
    base = next((s for s in snaps if s.venue == "phoenix"), snaps[0] if snaps else None)
    amm = equivalent_pool(base) if base is not None else None
    # Zero depth inside the band (a very wide Phoenix spread) would give an empty pool.
    amm_usd = amm.usd_reserve if amm is not None and amm.usd_reserve > 0 else None

    out = {
        "kind": EXPORT_KIND,
        "version": 2,
        "generated_at": time.time(),
        "venues": venues,
        "amm_usd_reserve": amm_usd,
        "jupiter": jupiter_block(data),
        "timeseries": timeseries_block(data),
        "phoenix_account": None,
    }
    ph = latest.get("phoenix")
    raw = ph.raw() if ph is not None else None
    if raw:
        block = phoenix_account_slice(raw, ph.slot, ph.book().meta.get("address", ""))
        block["account_len"] = ph.book().meta.get("account_len")
        out["phoenix_account"] = block
    return out


def write_export(doc: dict, path: Path) -> int:
    """Write compact JSON; refuse to write more than ``MAX_EXPORT_BYTES``. Returns the size."""
    text = json.dumps(doc, separators=(",", ":"))
    if len(text.encode()) > MAX_EXPORT_BYTES:
        raise ValueError(f"export is {len(text) / 1e6:.1f} MB, over the 2 MB budget")
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return len(text.encode())


# ---- CLI ---------------------------------------------------------------------------------------


def add_parser(sub: argparse._SubParsersAction) -> None:
    """Register ``export`` on the main parser (``__main__`` calls this)."""
    p = sub.add_parser(
        "export",
        help="course data file (export v2 JSON) from a collector database",
        description="Write the course's export (format v2, a superset of the playground's v1).",
    )
    p.add_argument("--db", default="data/collect.sqlite", help="collector SQLite file")
    p.add_argument("--out", default="course/data/export.json", help="output JSON file")
    p.add_argument("--run", type=int, help="only this run id (default: every run in the file)")
    p.add_argument(
        "--max-slippage",
        type=float,
        default=DEFAULT_MAX_SLIPPAGE * 100,
        help="price protection in %% of mid (default 10)",
    )
    p.add_argument("--max-levels", type=int, default=400, help="price levels per book side")
    p.set_defaults(handler=cmd_export)


def cmd_export(args: argparse.Namespace) -> None:
    if not Path(args.db).exists():
        sys.exit(f"{args.db} does not exist (collect some data first: collect)")
    with Store(args.db, readonly=True) as store:  # never write to the database we export
        doc = export_v2(
            store,
            run_id=args.run,
            max_slippage=args.max_slippage / 100,
            max_levels=args.max_levels,
        )
    size = write_export(doc, Path(args.out))
    ticks, venues = len(doc["timeseries"]["t"]), len(doc["venues"])
    print(f"export v2 ({ticks} ticks, {venues} venues, {size / 1e3:,.0f} KB) -> {args.out}")
