"""timeseries.py: pure aggregations over hand-written metric rows."""

import pytest
from test_metrics import REF, quote_row, tiny_book  # tests/ is on sys.path under pytest

from impact_analyzer.metrics import book_metrics, quote_metrics
from impact_analyzer.timeseries import (
    Obs,
    biggest_spread_jump,
    by_hour,
    health,
    hour_of_day,
    observations,
    over_time,
    phoenix_activity,
    quantile,
    route_mix,
    summarize,
    summarize_by_key,
)

DAY = 1_792_281_600.0  # 2026-10-18 00:00 UTC


def test_quantile_interpolates_like_numpy():
    v = [1.0, 2.0, 3.0, 4.0]
    assert quantile(v, 0.5) == 2.5
    assert quantile(v, 0.9) == pytest.approx(3.7)  # position 2.7: 3 + 0.7 * (4 - 3)
    assert quantile(v, 0.0) == 1.0 and quantile(v, 1.0) == 4.0
    assert quantile([7.0], 0.9) == 7.0
    with pytest.raises(ValueError):
        quantile([], 0.5)


def test_summarize():
    s = summarize([5, 1, 3, None, float("nan")])
    assert (s.n, s.median, s.mean) == (3, 3, 3)
    assert summarize([]) is None


def test_observations_leave_partial_fills_out_of_costs():
    m = book_metrics(tiny_book(), REF, tick_ts=DAY, sizes_usd=[500, 10_000])
    obs = observations([m])
    s = summarize_by_key(obs)
    assert s[("kraken", "spread_bps", None, None)].median == pytest.approx(160)
    assert s[("kraken", "depth_usd", "ask", 0.02)].median == pytest.approx(3038)
    assert ("kraken", "cost_bps", "buy", 500.0) in s
    assert ("kraken", "cost_bps", "buy", 10_000.0) not in s  # partial: no cost
    assert s[("kraken", "filled", "buy", 10_000.0)].mean == 0.0
    assert s[("kraken", "filled", "buy", 500.0)].mean == 1.0


def test_quote_observations_count_no_route_as_unfilled_but_ignore_other_errors():
    rows = [
        quote_metrics(quote_row("buy", 100.05)),
        quote_metrics(quote_row("buy", None, tick_id=2, ok=False, error="NO_ROUTES_FOUND")),
        quote_metrics(quote_row("buy", None, tick_id=3, ok=False, error="HTTP 429")),
    ]
    s = summarize_by_key(observations([], rows))
    fill = s[("jupiter:SolFi", "filled", "buy", 10_000.0)]
    assert (fill.n, fill.mean) == (2, 0.5)
    assert s[("jupiter:SolFi", "cost_bps", "buy", 10_000.0)].median == pytest.approx(5.0)


def test_by_hour_and_over_time():
    obs = [
        Obs(DAY + 1_800, "kraken", "spread_bps", None, None, 1.0),  # 00:30
        Obs(DAY + 2_100, "kraken", "spread_bps", None, None, 3.0),  # 00:35
        Obs(DAY + 13 * 3600, "kraken", "spread_bps", None, None, 9.0),  # 13:00
    ]
    assert hour_of_day(DAY + 13 * 3600 + 59) == 13
    hours = by_hour(obs)[("kraken", "spread_bps", None, None)]
    assert sorted(hours) == [0, 13]
    assert hours[0].median == 2.0 and hours[13].n == 1
    assert over_time(list(reversed(obs)), "kraken", "spread_bps") == [
        (DAY + 1_800, 1.0),
        (DAY + 2_100, 3.0),
        (DAY + 13 * 3600, 9.0),
    ]


def test_health_uptime_latency_and_no_route():
    fetches = [
        {"tick_ts": 1, "source": "kraken", "ok": True, "no_route": False, "latency_ms": 100.0,
         "error": None},
        {"tick_ts": 2, "source": "kraken", "ok": True, "no_route": False, "latency_ms": 300.0,
         "error": None},
        {"tick_ts": 3, "source": "kraken", "ok": False, "no_route": False, "latency_ms": None,
         "error": "HTTP 503"},
        {"tick_ts": 1, "source": "jupiter:SolFi", "ok": False, "no_route": True,
         "latency_ms": None, "error": "NO_ROUTES_FOUND"},
    ]  # fmt: skip
    h = {x.source: x for x in health(fetches)}
    k = h["kraken"]
    assert (k.attempted, k.ok, k.errors, k.no_route) == (3, 2, 1, 0)
    assert k.uptime == pytest.approx(2 / 3)
    assert k.latency_p50_ms == 200.0 and k.latency_p95_ms == pytest.approx(290.0)
    assert k.last_error == "HTTP 503"
    s = h["jupiter:SolFi"]
    assert s.uptime == 0 and s.answered == 1.0 and s.errors == 0


def phoenix_row(ts: float, seq: int, best_bid_ticks: int):
    book = tiny_book("phoenix", {"market_sequence_number": seq, "taker_fee_bps": 2})
    book.bids = [type(book.bids[0])(best_bid_ticks, 10)]  # one bid: it alone sets the spread
    return book_metrics(book, REF, tick_ts=ts, sizes_usd=[500])


def test_phoenix_activity_and_the_biggest_spread_jump():
    rows = [
        phoenix_row(DAY, 1_000, 9920),
        phoenix_row(DAY + 300, 1_008, 9920),
        phoenix_row(DAY + 900, 1_008, 9000),  # a tick was missed; the best bid moved down
    ]
    act = phoenix_activity(list(reversed(rows)) + [book_metrics(tiny_book(), REF)])
    assert [a.events for a in act] == [None, 8, 0]  # kraken row ignored, sorted by time
    assert [a.gap_s for a in act] == [None, 300, 600]
    jump = biggest_spread_jump(act)
    assert jump.before.tick_ts == DAY + 300 and jump.after.best_bid == pytest.approx(90.0)
    assert jump.ratio > 5  # 160 bps -> ~1,130 bps
    assert biggest_spread_jump(act[:1]) is None


def test_route_mix_counts_quotes_not_hops():
    rows = [quote_metrics(quote_row("buy", 100.0, dex="best")) for _ in range(3)]
    assert route_mix(rows, "best") == [("SolFi", 3, 3), ("Manifest", 3, 3)]
    assert route_mix(rows, "SolFi") == []
