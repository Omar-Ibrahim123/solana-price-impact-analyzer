from decimal import Decimal

import pytest

from impact_analyzer.amm import AmmPool, equivalent_pool
from impact_analyzer.convert import load_book
from impact_analyzer.impact import impact_curve, lots_for_notional, simulate
from impact_analyzer.orderbook import Side
from impact_analyzer.snapshot import BookSnapshot, RestingOrder, from_decimal_levels
from impact_analyzer.synthetic import demo_books


def tiny_book() -> BookSnapshot:
    """Ticks of $0.01 and lots of 1 SOL, so the arithmetic is easy to check by hand.

    asks: 10 SOL @ 150.10, 10 @ 150.20, 20 @ 150.50
    bids: 10 SOL @ 149.90, 30 @ 149.50
    mid = 150.00
    """
    return BookSnapshot(
        venue="test",
        symbol="SOL/USD",
        fetched_at=0.0,
        tick_size=Decimal("0.01"),
        lot_size=Decimal("1"),
        bids=[RestingOrder(14990, 10), RestingOrder(14950, 30)],
        asks=[
            RestingOrder(15010, 4),
            RestingOrder(15010, 6),
            RestingOrder(15020, 10),
            RestingOrder(15050, 20),
        ],
    )


# ---- snapshot -------------------------------------------------------------------


def test_snapshot_summary_numbers():
    s = tiny_book()
    assert s.mid_price() == pytest.approx(150.0)
    assert s.spread_bps() == pytest.approx(0.20 / 150 * 1e4)
    assert s.notional("bid") == pytest.approx(10 * 149.90 + 30 * 149.50)


def test_snapshot_round_trip(tmp_path):
    s = tiny_book()
    path = tmp_path / "snap.json"
    s.save(path)
    loaded = BookSnapshot.load(path)
    assert loaded == s


def test_validate_rejects_crossed_and_unsorted():
    s = tiny_book()
    s.bids = [RestingOrder(15010, 1)]
    with pytest.raises(ValueError, match="crossed"):
        s.validate()
    s = tiny_book()
    s.asks = list(reversed(s.asks))
    with pytest.raises(ValueError, match="sorted"):
        s.validate()


def test_from_decimal_levels_sorts_rounds_and_drops():
    s = from_decimal_levels(
        "x",
        "SOL/USD",
        0.0,
        bids=[("149.5", "1.239"), ("149.9", "0.004")],  # 0.004 rounds to 0 lots: dropped
        asks=[("150.2", "2"), ("150.1", "1")],
        tick_size=Decimal("0.1"),
        lot_size=Decimal("0.01"),
    )
    assert s.bids == [RestingOrder(1495, 123)]  # rounded down, never up
    assert [o.price_ticks for o in s.asks] == [1501, 1502]


def test_from_decimal_levels_rejects_off_tick_price():
    with pytest.raises(ValueError, match="multiple"):
        from_decimal_levels("x", "S", 0.0, [("1.005", "1")], [], Decimal("0.01"), Decimal("1"))


# ---- convert --------------------------------------------------------------------


def test_load_book_keeps_time_priority():
    book = load_book(tiny_book())
    assert book.best_bid() == 14990 and book.best_ask() == 15010
    assert book.depth(Side.ASK) == [(15010, 10), (15020, 10), (15050, 20)]
    # The 4-lot order was first in the snapshot, so it must fill first.
    fills = book.market_order(Side.BID, 5)
    assert [(f.size_lots) for f in fills] == [4, 1]


# ---- impact ---------------------------------------------------------------------


def test_lots_for_notional_takes_partial_last_level():
    s = tiny_book()
    # First level is 10 SOL * 150.10 = $1,501. $2,000 needs 10 + ceil(499 / 150.20) = 14.
    assert lots_for_notional(s, Side.BID, 2_000) == 14
    # More than the whole side: everything.
    assert lots_for_notional(s, Side.BID, 1e9) == 40


def test_small_buy_pays_half_spread():
    r = simulate(tiny_book(), "buy", 100)
    assert r.avg_price == pytest.approx(150.10)
    assert r.impact_bps == pytest.approx(0.10 / 150 * 1e4)  # 6.67 bps: just the half-spread
    assert r.levels_swept == 1


def test_sweep_average_and_impact_by_hand():
    r = simulate(tiny_book(), "buy", 3_000)
    # 10 @ 150.10 = 1501, then ceil(1499 / 150.20) = 10 @ 150.20 = 1502. Total 20 SOL, $3003.
    assert r.filled_base == 20
    assert r.avg_price == pytest.approx(3003 / 20)
    assert r.impact_bps == pytest.approx((150.15 - 150) / 150 * 1e4)
    assert r.levels_swept == 2 and r.fully_filled


def test_sell_impact_is_positive_cost():
    r = simulate(tiny_book(), "sell", 1_000)
    assert r.avg_price < r.mid_price
    assert r.impact_bps > 0


def test_exhausted_book_reports_partial():
    r = simulate(tiny_book(), "sell", 1_000_000)
    assert not r.fully_filled
    assert r.filled_base == 40


def test_impact_grows_with_size_on_real_shaped_book():
    for snap in demo_books():
        bps = [r.impact_bps for r in impact_curve(snap, "buy")]
        assert bps == sorted(bps)


def test_simulate_rejects_bad_input():
    with pytest.raises(ValueError):
        simulate(tiny_book(), "hold", 100)
    with pytest.raises(ValueError):
        simulate(tiny_book(), "buy", 0)


# ---- AMM ------------------------------------------------------------------------


def test_amm_small_trade_impact_is_about_dx_over_x():
    pool = AmmPool.at_price(150, usd_reserve=10_000_000)
    assert pool.spot_price == pytest.approx(150)
    assert pool.buy_impact_bps(1_000) == pytest.approx(1_000 / 10_000_000 * 1e4, rel=1e-3)
    assert pool.sell_impact_bps(1_000) == pytest.approx(1_000 / 10_000_000 * 1e4, rel=1e-3)


def test_amm_doubling_pool_halves_impact():
    a = AmmPool.at_price(150, 1e6).buy_impact_bps(10_000)
    b = AmmPool.at_price(150, 2e6).buy_impact_bps(10_000)
    assert b == pytest.approx(a / 2, rel=0.01)


def test_amm_fee_adds_cost():
    assert AmmPool.at_price(150, 1e6, fee_bps=30).buy_impact_bps(1_000) > 30


def test_equivalent_pool_matches_depth_near_mid():
    snap = demo_books()[0]
    pool = equivalent_pool(snap, band=0.02)
    assert pool.spot_price == pytest.approx(snap.mid_price())
    assert pool.usd_reserve > 0
