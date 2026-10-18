"""Jupiter quote parsing (on a real recorded response) and the quote grid."""

import json
from pathlib import Path

import pytest

from impact_analyzer import jupiter

FIXTURE = Path(__file__).parent / "fixtures" / "jupiter_quote_buy_100k.json"


def test_parse_recorded_quote():
    q = jupiter.parse_quote(json.loads(FIXTURE.read_text()))
    assert q.in_amount == 100_000_000_000  # $100,000 in USDC atoms
    assert q.context_slot and q.context_slot > 400_000_000
    # A real route is split across several pools whose shares add up to 100%.
    assert len(q.route) >= 1
    assert sum(step["percent"] for step in q.route) == 100
    assert sum(step["in_amount"] for step in q.route) == q.in_amount
    # ~964.7 SOL for $100K: about $103.66 per SOL.
    assert q.avg_price("buy") == pytest.approx(100_000 / (q.out_amount / 1e9))
    assert 50 < q.avg_price("buy") < 500


def test_avg_price_for_a_sell():
    q = jupiter.Quote(
        in_amount=2_000_000_000,  # 2 SOL in
        out_amount=300_000_000,  # 300 USDC out
        price_impact_pct=None,
        context_slot=None,
        route=[],
    )
    assert q.avg_price("sell") == pytest.approx(150.0)


def test_parse_error_body():
    with pytest.raises(ValueError, match="NO_ROUTES_FOUND"):
        jupiter.parse_quote({"error": "No routes found", "errorCode": "NO_ROUTES_FOUND"})


def test_grid_pairs_buy_and_sell_and_sizes_sells_by_reference_price():
    grid = jupiter.build_grid(["best", "SolFi"], [1_000, 10_000], ref_price=100.0)
    assert len(grid) == 2 * 2 * 2
    # Buy and sell of the same (dex, size) are adjacent, so they're quoted seconds apart.
    assert [(r.dex, r.usd_size, r.side) for r in grid[:2]] == [
        ("best", 1_000, "buy"),
        ("best", 1_000, "sell"),
    ]
    buy, sell = grid[0], grid[1]
    assert buy.in_amount == 1_000 * 10**6  # USDC atoms
    assert sell.in_amount == 10 * 10**9  # $1,000 / $100 = 10 SOL in lamports
    assert buy.params()["inputMint"] == jupiter.USDC_MINT
    assert sell.params()["inputMint"] == jupiter.SOL_MINT
    assert "dexes" not in buy.params()
    assert grid[4].params()["dexes"] == "SolFi,SolFi V2"


def test_grid_rejects_unknown_dex():
    with pytest.raises(ValueError, match="unknown dex"):
        jupiter.build_grid(["NotADex"], [1_000], ref_price=100.0)
