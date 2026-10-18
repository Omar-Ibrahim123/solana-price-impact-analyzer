"""metrics.py on books small enough to check every number by hand."""

from decimal import Decimal

import pytest

from impact_analyzer import metrics
from impact_analyzer.metrics import (
    book_metrics,
    book_round_trips,
    cost_bps,
    depth_around,
    half_round_trip_bps,
    quote_metrics,
    quote_round_trips,
    size_key,
)
from impact_analyzer.snapshot import BookSnapshot, RestingOrder


def tiny_book(venue: str = "kraken", meta: dict | None = None) -> BookSnapshot:
    """Ticks of $0.01, lots of 1 SOL.

    bids: $99.20 x 10 SOL ($992),   $98.50 x 20 SOL ($1,970)
    asks: $100.80 x 10 SOL ($1,008), $101.50 x 20 SOL ($2,030)
    mid = $100.00, spread = 1.60 / 100 = 160 bps
    """
    return BookSnapshot(
        venue=venue,
        symbol="SOL/USD",
        fetched_at=0.0,
        tick_size=Decimal("0.01"),
        lot_size=Decimal("1"),
        bids=[RestingOrder(9920, 10), RestingOrder(9850, 20)],
        asks=[RestingOrder(10080, 10), RestingOrder(10150, 20)],
        meta=meta or {},
    )


REF = 100.5  # the exchanges' mid: deliberately not this book's own mid


def trade(m, side, usd):
    return next(t for t in m["trades"] if t["side"] == side and t["usd"] == usd)


def test_formulas_by_hand():
    assert cost_bps("buy", 100.8, 100.5) == pytest.approx(0.3 / 100.5 * 1e4)  # 29.85
    assert cost_bps("sell", 99.2, 100.5) == pytest.approx(1.3 / 100.5 * 1e4)  # 129.35
    assert cost_bps("buy", 100.0, 100.5) < 0  # cheaper than the reference: negative cost
    with pytest.raises(ValueError):
        cost_bps("hold", 1, 1)
    # Half round trip = mean of the buy and sell costs, whatever the reference level.
    rt = half_round_trip_bps(100.8, 99.2, 100.5)
    assert rt == pytest.approx(1.6 / 2 / 100.5 * 1e4)
    assert rt == pytest.approx((cost_bps("buy", 100.8, 100.5) + cost_bps("sell", 99.2, 100.5)) / 2)


def test_size_key_avoids_scientific_notation():
    assert size_key(1_000_000.0) == "1000000"
    assert size_key(10_000) == "10000"


def test_depth_bands():
    book = tiny_book()
    d = depth_around(book, 100.0)
    assert d["0.005"] == [0, 0]  # nothing within 50 cents of $100
    assert d["0.01"] == pytest.approx([992, 1008])  # first level each side
    assert d["0.02"] == pytest.approx([992 + 1970, 1008 + 2030])
    # Around a different centre (the reference mid) the answer changes.
    assert depth_around(book, 101.0, [0.01])["0.01"] == pytest.approx([0, 1008 + 2030])


def test_spread_mid_and_top_of_book():
    m = book_metrics(tiny_book(), REF, tick_ts=123.0, sizes_usd=[500])
    assert m["mid"] == pytest.approx(100.0)
    assert m["spread_bps"] == pytest.approx(160.0)
    assert m["mid_vs_ref_bps"] == pytest.approx(-0.5 / 100.5 * 1e4)
    assert (m["best_bid"], m["best_ask"]) == pytest.approx((99.2, 100.8))
    assert (m["best_bid_sol"], m["best_ask_sol"]) == (10.0, 10.0)
    assert m["tick_ts"] == 123.0 and m["venue"] == "kraken"
    assert m["depth_usd"]["0.02"] == pytest.approx([2962, 3038])


def test_small_trade_costs_vs_own_mid_and_reference():
    m = book_metrics(tiny_book(), REF, sizes_usd=[500])
    buy, sell = trade(m, "buy", 500), trade(m, "sell", 500)
    # Buy $500: ceil(500 / 100.8) = 5 lots, all at $100.80.
    assert buy["avg_price"] == pytest.approx(100.8)
    assert buy["filled_usd"] == pytest.approx(504.0) and buy["fully_filled"]
    assert buy["impact_bps"] == pytest.approx(80.0)  # vs own mid $100
    assert buy["cost_bps"] == pytest.approx(0.3 / 100.5 * 1e4)  # vs reference $100.50
    # Sell $500: ceil(500 / 99.2) = 6 lots at $99.20.
    assert sell["avg_price"] == pytest.approx(99.2)
    assert sell["cost_bps"] == pytest.approx(1.3 / 100.5 * 1e4)
    assert m["round_trip_bps"]["500"] == pytest.approx(1.6 / 2 / 100.5 * 1e4)


def test_fees_are_separate_and_added_for_all_in():
    m = book_metrics(tiny_book("kraken"), REF, sizes_usd=[500])
    buy = trade(m, "buy", 500)
    assert m["fee_bps"] == buy["fee_bps"] == 40.0  # Kraken base tier
    assert buy["all_in_bps"] == pytest.approx(buy["cost_bps"] + 40.0)
    phx = book_metrics(tiny_book("phoenix", {"taker_fee_bps": 2}), REF, sizes_usd=[500])
    assert phx["fee_bps"] == 2.0  # read from the snapshot, not the table


def test_walking_two_levels_and_partial_fills():
    m = book_metrics(tiny_book(), REF, sizes_usd=[2_000, 10_000])
    buy = trade(m, "buy", 2_000)
    # $1,008 at $100.80, then ceil(992 / 101.5) = 10 lots at $101.50 -> 20 SOL for $2,023.
    assert buy["avg_price"] == pytest.approx(2023 / 20)
    assert buy["levels_swept"] == 2 and buy["fully_filled"]
    big = trade(m, "buy", 10_000)  # the whole ask side is only $3,038
    assert not big["fully_filled"]
    assert big["filled_usd"] == pytest.approx(3038.0)
    assert m["round_trip_bps"]["10000"] is None  # no round trip from a partial fill


def test_no_reference_mid_keeps_own_mid_numbers():
    m = book_metrics(tiny_book(), None, sizes_usd=[500])
    buy = trade(m, "buy", 500)
    assert buy["impact_bps"] == pytest.approx(80.0)
    assert buy["cost_bps"] is None and buy["all_in_bps"] is None
    assert m["depth_ref_usd"] == {} and m["mid_vs_ref_bps"] is None
    assert m["round_trip_bps"]["500"] == pytest.approx(80.0)  # scaled by own mid instead


def test_one_sided_book_has_no_trades():
    book = tiny_book()
    book.bids = []
    m = book_metrics(book, REF, sizes_usd=[500])
    assert m["mid"] is None and m["trades"] == [] and m["depth_usd"] == {}


def test_phoenix_sequence_number_is_kept():
    m = book_metrics(tiny_book("phoenix", {"market_sequence_number": 893_797_252}), REF)
    assert m["sequence_number"] == 893_797_252
    assert book_metrics(tiny_book(), REF)["sequence_number"] is None


def quote_row(side, avg, dex="SolFi", usd=10_000.0, tick_id=1, ok=True, error=None, ref=100.0):
    return {
        "tick_id": tick_id,
        "tick_ts": 600.0 * tick_id,
        "dex": dex,
        "side": side,
        "usd_size": usd,
        "ok": int(ok),
        "error": error,
        "latency_ms": 40.0 if ok else None,
        "avg_price": avg if ok else None,
        "ref_mid": ref,
        "route_json": '[{"label": "SolFi"}, {"label": "SolFi"}, {"label": "Manifest"}]',
        "context_slot": 1,
    }


def test_quote_cost_round_trip_and_no_route():
    buy = quote_metrics(quote_row("buy", 100.05))
    sell = quote_metrics(quote_row("sell", 99.97))
    assert buy["cost_bps"] == pytest.approx(5.0) and sell["cost_bps"] == pytest.approx(3.0)
    assert buy["fee_bps"] == 0 and buy["all_in_bps"] == pytest.approx(5.0)
    assert buy["route"] == ["SolFi", "Manifest"]  # de-duplicated, in order
    assert buy["series"] == "jupiter:SolFi"
    rts = quote_round_trips([buy, sell])
    assert len(rts) == 1
    assert rts[0]["bps"] == pytest.approx((100.05 - 99.97) / 2 / 100 * 1e4)  # 4.0
    assert rts[0]["bps"] == pytest.approx((5.0 + 3.0) / 2)

    failed = quote_metrics(
        quote_row("buy", None, ok=False, error="HTTP 400 NO_ROUTES_FOUND: No routes found")
    )
    assert not failed["ok"] and failed["no_route"] and failed["cost_bps"] is None
    assert quote_round_trips([failed, sell]) == []  # half a pair is no round trip
    other = quote_metrics(quote_row("buy", None, ok=False, error="HTTP 429"))
    assert not other["no_route"]


def test_book_round_trips_skip_partials():
    m = book_metrics(tiny_book(), REF, tick_ts=5.0, sizes_usd=[500, 10_000])
    rts = book_round_trips([m])
    assert [(r["series"], r["usd"]) for r in rts] == [("kraken", 500.0)]


def test_metrics_version_is_an_int():
    assert isinstance(metrics.METRICS_VERSION, int)
