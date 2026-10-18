"""Dump golden data for the course's JavaScript engine tests.

The browser test page (course/dist/tests.html) replays every operation below through
course/src/js/core/engine.js and checks it gets *exactly* the fills, cancel results and book
states that the Python engine (src/impact_analyzer/orderbook.py) produced. That is what proves
the course's engine is the project's engine.

Contents of course/tests/golden.json:

- ``streams``: about 2,000 operations in two streams.
  1. ``benchmarks/order_flow.py``'s reproducible random flow (adds that never cross, cancels
     that may race fills, unprotected market orders).
  2. A harsher stream: limit orders that cross the spread, cancels of unknown ids, and market
     orders with price protection (``limit_price``).
  Each op's result (fills or cancel bool) is recorded, plus checkpoints of the book every 100
  ops and the full final book (every level's FIFO queue).
- ``errors``: inputs the Python engine rejects (zero/negative size, duplicate resting id).
- ``impact``: ``impact.simulate`` on the real Phoenix and Kraken snapshots of 2026-10-18.
- ``amm``: ``amm.py`` pool impacts and ``equivalent_pool`` on the same snapshots.

Run from the repo root (or anywhere):
    PYTHONPATH=src python course/tests/make_golden.py
"""

from __future__ import annotations

import json
import platform
import random
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "src"))
sys.path.insert(0, str(REPO))

from benchmarks.order_flow import Add, Cancel, Market, generate  # noqa: E402
from impact_analyzer.amm import AmmPool, equivalent_pool  # noqa: E402
from impact_analyzer.impact import simulate  # noqa: E402
from impact_analyzer.orderbook import OrderBook, Side  # noqa: E402
from impact_analyzer.snapshot import BookSnapshot  # noqa: E402

LIVE = REPO / "data" / "live-2026-10-18"
OUT = Path(__file__).resolve().parent / "golden.json"
SIDE = {"bid": Side.BID, "ask": Side.ASK}
CHECKPOINT_EVERY = 100


def fills_json(fills) -> list[list[int]]:
    return [[f.maker_order_id, f.price_ticks, f.size_lots] for f in fills]


def book_state(book: OrderBook) -> dict:
    return {
        "best_bid": book.best_bid(),
        "best_ask": book.best_ask(),
        "depth_bid": [list(x) for x in book.depth(Side.BID)],
        "depth_ask": [list(x) for x in book.depth(Side.ASK)],
        "n_orders": len(book.orders),
    }


def full_book(book: OrderBook) -> dict:
    """Every level's queue, head (oldest) first, prices ascending on both sides."""

    def side(levels) -> list:
        out = []
        for price, level in levels.items():
            queue, node = [], level.head
            while node is not None:
                queue.append([node.order_id, node.size_lots])
                node = node.next
            out.append([price, level.total_size, queue])
        return out

    return {"bids": side(book.bids), "asks": side(book.asks), "n_orders": len(book.orders)}


def run_stream(name: str, ops: list[list]) -> dict:
    book = OrderBook()
    results: list = []
    checkpoints: dict[str, dict] = {}
    for i, op in enumerate(ops):
        kind = op[0]
        if kind == "add":
            _, oid, side, price, size = op
            results.append(fills_json(book.add_order(oid, SIDE[side], price, size)))
        elif kind == "cancel":
            results.append(book.cancel_order(op[1]))
        elif kind == "market":
            _, side, size, limit = op
            results.append(fills_json(book.market_order(SIDE[side], size, limit)))
        else:
            raise ValueError(kind)
        if (i + 1) % CHECKPOINT_EVERY == 0:
            checkpoints[str(i)] = book_state(book)
    n_fills = sum(len(r) for r in results if isinstance(r, list))
    print(f"  {name}: {len(ops)} ops, {n_fills} fills, {len(book.orders)} resting at the end")
    return {
        "name": name,
        "ops": ops,
        "results": results,
        "checkpoints": checkpoints,
        "final": full_book(book),
    }


def order_flow_ops(n: int, seed: int) -> list[list]:
    ops: list[list] = []
    for ev in generate(n, seed=seed):
        if isinstance(ev, Add):
            ops.append(["add", ev.order_id, ev.side, ev.price_ticks, ev.size_lots])
        elif isinstance(ev, Cancel):
            ops.append(["cancel", ev.order_id])
        elif isinstance(ev, Market):
            ops.append(["market", ev.side, ev.size_lots, None])
    return ops


def harsh_ops(n: int, seed: int, mid: int = 10_000) -> list[list]:
    """Crossing limits, cancels of filled/unknown ids, protected market orders."""
    rng = random.Random(seed)
    ops: list[list] = []
    ids: list[int] = []
    next_id = 1
    for _ in range(n):
        r = rng.random()
        if r < 0.52 or not ids:
            side = "bid" if rng.random() < 0.5 else "ask"
            # Offsets from -6 to +20 ticks on the wrong side of mid: about 1 in 4 crosses.
            off = rng.randint(-6, 20)
            price = mid - off if side == "bid" else mid + off
            ops.append(["add", next_id, side, price, rng.randint(1, 80)])
            ids.append(next_id)
            next_id += 1
        elif r < 0.74:
            # Mostly ids we used (some already filled), sometimes ids that never existed.
            oid = rng.choice(ids) if rng.random() < 0.85 else rng.randint(10_000, 20_000)
            ops.append(["cancel", oid])
        elif r < 0.88:
            ops.append(["market", "bid" if rng.random() < 0.5 else "ask", rng.randint(1, 60), None])
        else:
            side = "bid" if rng.random() < 0.5 else "ask"
            k = rng.randint(-3, 12)
            limit = mid + k if side == "bid" else mid - k
            ops.append(["market", side, rng.randint(1, 120), limit])
    return ops


def error_cases() -> list[dict]:
    cases = []
    for label, setup, op in [
        ("zero size limit", [], ["add", 1, "bid", 100, 0]),
        ("negative size limit", [], ["add", 1, "ask", 100, -5]),
        ("zero size market", [], ["market", "bid", 0, None]),
        ("duplicate resting id", [["add", 1, "bid", 100, 1]], ["add", 1, "bid", 99, 1]),
    ]:
        book = OrderBook()
        for s in setup:
            book.add_order(s[1], SIDE[s[2]], s[3], s[4])
        try:
            if op[0] == "add":
                book.add_order(op[1], SIDE[op[2]], op[3], op[4])
            else:
                book.market_order(SIDE[op[1]], op[2], op[3])
            raised = None
        except ValueError as e:
            raised = type(e).__name__
        cases.append({"name": label, "setup": setup, "op": op, "raises": raised})
    # A filled id can be reused (it is no longer resting): no error.
    book = OrderBook()
    book.add_order(1, Side.ASK, 100, 1)
    book.market_order(Side.BID, 1)
    book.add_order(1, Side.ASK, 101, 1)
    cases.append(
        {
            "name": "reusing the id of a filled order is allowed",
            "setup": [["add", 1, "ask", 100, 1], ["market", "bid", 1, None]],
            "op": ["add", 1, "ask", 101, 1],
            "raises": None,
        }
    )
    return cases


def latest(pattern: str) -> Path:
    files = sorted(LIVE.glob(pattern))
    if not files:
        raise SystemExit(f"missing {LIVE / pattern}")
    return files[-1]


def impact_cases(snaps: dict[str, BookSnapshot]) -> list[dict]:
    sizes = [250, 1_000, 3_333.33, 10_000, 47_500, 100_000, 1_000_000, 25_000_000]
    out = []
    for venue, snap in snaps.items():
        for side in ("buy", "sell"):
            for usd in sizes:
                for slip in (0.10, 0.02):
                    r = simulate(snap, side, usd, slip)
                    out.append(
                        {
                            "venue": venue,
                            "side": side,
                            "usd": usd,
                            "max_slippage": slip,
                            "expected": r.as_dict(),
                        }
                    )
    return out


def amm_cases(snaps: dict[str, BookSnapshot]) -> list[dict]:
    out = []
    usds = [100, 1_000, 10_000, 100_000, 1_000_000]
    for pool in (
        AmmPool.at_price(150.0, 20_000_000),
        AmmPool.at_price(104.05, 2_624_879.9885707377, fee_bps=30),
        AmmPool(5_000_000, 40_000, fee_bps=5),
    ):
        out.append(
            {
                "kind": "pool",
                "usd_reserve": pool.usd_reserve,
                "sol_reserve": pool.sol_reserve,
                "fee_bps": pool.fee_bps,
                "spot": pool.spot_price,
                "buy": [[u, pool.buy_impact_bps(u)] for u in usds],
                "sell": [[u, pool.sell_impact_bps(u)] for u in usds if u < pool.usd_reserve],
            }
        )
    for venue, snap in snaps.items():
        for band in (0.01, 0.02):
            pool = equivalent_pool(snap, band)
            out.append(
                {
                    "kind": "equivalent_pool",
                    "venue": venue,
                    "band": band,
                    "usd_reserve": pool.usd_reserve,
                    "sol_reserve": pool.sol_reserve,
                }
            )
    return out


def main() -> None:
    print("Generating golden data:")
    streams = [
        run_stream("order_flow.generate(1500, seed=7)", order_flow_ops(1500, seed=7)),
        run_stream("crossing limits, races and protected market orders (500)", harsh_ops(500, 11)),
    ]
    snaps = {
        "phoenix": BookSnapshot.load(latest("phoenix-*.json")),
        "kraken": BookSnapshot.load(latest("kraken-*.json")),
    }
    golden = {
        "version": 1,
        "generated_by": "course/tests/make_golden.py",
        # sum() of floats is compensated from Python 3.12; engine.js copies that (pySum).
        "python": platform.python_version(),
        "streams": streams,
        "errors": error_cases(),
        "snapshots": {k: v.to_dict() for k, v in snaps.items()},
        "impact": impact_cases(snaps),
        "amm": amm_cases(snaps),
    }
    OUT.write_text(json.dumps(golden, separators=(",", ":")), encoding="utf-8")
    n_ops = sum(len(s["ops"]) for s in streams)
    print(
        f"wrote {OUT} ({OUT.stat().st_size / 1024:.0f} KB): {n_ops} ops, "
        f"{len(golden['impact'])} impact cases, {len(golden['amm'])} AMM cases"
    )


if __name__ == "__main__":
    main()
