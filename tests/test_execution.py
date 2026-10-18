"""IOC orders, TWAP and the resilience model, on small books you can check by hand.

Ticks are $0.01 and lots are 1 SOL, so a level "10 @ 100.05" is 10 lots at 10_005 ticks.
The fake collector DB is written with ``Store.insert_tick``: no network anywhere.
"""

from decimal import Decimal

import pytest

from impact_analyzer.__main__ import main
from impact_analyzer.execution import (
    Dist,
    Series,
    Step,
    book_unchanged_share,
    execute_ioc,
    load_series,
    run_window,
    simulate_ioc,
    twap,
    twap_markdown,
    twap_summary,
)
from impact_analyzer.impact import simulate
from impact_analyzer.snapshot import BookSnapshot, RestingOrder
from impact_analyzer.store import SnapshotRecord, Store, TickRecord

T0 = 1_792_299_900.0  # a multiple of 300 s, like the collector's aligned ticks


def ladder(
    venue: str = "kraken",
    mid: float = 100.0,
    levels: int = 10,
    size: int = 10,
    step: float = 0.10,
    meta: dict | None = None,
    at: float = T0,
) -> BookSnapshot:
    """A thin, even book: ``size`` SOL every ``step`` dollars, best levels mid +/- $0.05."""
    to_ticks = lambda price: round(price * 100)  # noqa: E731
    return BookSnapshot(
        venue=venue,
        symbol="SOL/USD (test)",
        fetched_at=at,
        tick_size=Decimal("0.01"),
        lot_size=Decimal("1"),
        bids=[RestingOrder(to_ticks(mid - 0.05 - i * step), size) for i in range(levels)],
        asks=[RestingOrder(to_ticks(mid + 0.05 + i * step), size) for i in range(levels)],
        meta=meta or {},
    )


# ---- IOC -------------------------------------------------------------------------------


def test_small_ioc_fills_at_the_touch_and_pays_half_spread():
    r = simulate_ioc(ladder(), "buy", 500, limit_bps=100)  # 5 SOL
    assert r.fully_filled and r.requested_lots == 5 and r.unfilled_base == 0
    assert r.avg_price == pytest.approx(100.05)
    assert r.cost_bps == pytest.approx(5.0)  # $0.05 on $100
    assert r.fee_bps == 40.0  # Kraken base tier, from fees.py
    assert r.all_in_bps == pytest.approx(45.0)
    assert r.fee_usd == pytest.approx(r.filled_usd * 0.004)


def test_ioc_with_a_tight_limit_reports_the_unfilled_part():
    # Limit 20 bps from mid = $100.20: only the 100.05 and 100.15 levels qualify.
    r = simulate_ioc(ladder(), "buy", 5_000, limit_bps=20)  # 50 SOL asked
    assert r.requested_lots == 50 and r.filled_lots == 20
    assert r.unfilled_base == 30 and not r.fully_filled
    assert r.fill_ratio == pytest.approx(0.4)
    assert r.limit_price == pytest.approx(100.20)
    assert r.avg_price == pytest.approx(100.10)  # never traded above the limit


def test_sell_ioc_cost_is_positive_and_uses_phoenix_fee_from_meta():
    r = simulate_ioc(ladder("phoenix", meta={"taker_fee_bps": 2}), "sell", 1_500, limit_bps=100)
    assert r.avg_price < 100 and r.cost_bps > 0
    assert r.fee_bps == 2.0


def test_ioc_agrees_with_the_market_order_simulator():
    """Same book, same protection band, same size in SOL: the same average price."""
    book = ladder(levels=50)
    ioc = simulate_ioc(book, "buy", 3_000)
    mkt = simulate(book, "buy", ioc.filled_usd)
    assert ioc.avg_price == pytest.approx(mkt.avg_price, rel=1e-4)


def test_removed_lots_come_off_the_best_levels_first():
    book = ladder()
    r = execute_ioc(book, "buy", 10, removed_lots=15)  # level 1 gone, half of level 2 gone
    assert r.avg_price == pytest.approx((5 * 100.15 + 5 * 100.25) / 10)
    assert r.removed_lots == 15 and r.removed_base == 15
    assert book.asks[0] == RestingOrder(10_005, 10)  # the snapshot itself is untouched


def test_ioc_on_a_one_sided_book_is_an_error():
    book = ladder()
    book.bids = []
    with pytest.raises(ValueError, match="one-sided"):
        simulate_ioc(book, "buy", 100)


# ---- TWAP on synthetic sequences ---------------------------------------------------------


def test_full_refill_twap_beats_one_shot_on_a_thin_book():
    snaps = [ladder() for _ in range(5)]
    r = twap(snaps, "buy", 5_000, resilience=1.0)  # 50 SOL as 5 x 10 SOL
    assert [c.result.requested_lots for c in r.children] == [10] * 5
    # Each child only ever takes the best level; the one-shot sweeps five levels.
    assert r.avg_price == pytest.approx(100.05)
    assert r.one_shot.avg_price == pytest.approx(100.25)
    assert r.shortfall_bps == pytest.approx(5.0)
    assert r.one_shot.cost_bps == pytest.approx(25.0)
    assert r.saving_bps == pytest.approx(20.0)
    assert r.drift_paid_bps == pytest.approx(0.0) and r.window_drift_bps == 0.0


def test_no_refill_twap_on_identical_snapshots_equals_one_shot():
    """The key sanity check: if nothing comes back, splitting in time changes nothing."""
    snaps = [ladder() for _ in range(4)]
    r = twap(snaps, "buy", 4_300, resilience=0.0)  # 43 lots: children of 11, 11, 11, 10
    assert [c.result.requested_lots for c in r.children] == [11, 11, 11, 10]
    assert [c.result.removed_lots for c in r.children] == [0, 11, 22, 33]
    assert r.filled_lots == r.one_shot.filled_lots == 43
    assert r.filled_usd == pytest.approx(r.one_shot.filled_usd)
    assert r.shortfall_bps == pytest.approx(r.one_shot.cost_bps, abs=1e-9)
    assert r.fee_usd == pytest.approx(r.one_shot.fee_usd)


def test_partial_resilience_removes_the_missing_share_of_what_we_took():
    snaps = [ladder() for _ in range(3)]
    r = twap(snaps, "buy", 3_000, resilience=0.25)  # 3 x 10 lots
    # before child 1: 0.75 * 10 = 7.5 -> 8 lots missing; before child 2: 0.75 * 20 = 15.
    assert [c.result.removed_lots for c in r.children] == [0, 8, 15]
    full = twap(snaps, "buy", 3_000, resilience=1.0)
    none = twap(snaps, "buy", 3_000, resilience=0.0)
    assert full.shortfall_bps < r.shortfall_bps < none.shortfall_bps


def test_fees_do_not_shrink_when_you_split():
    snaps = [ladder() for _ in range(6)]
    for resilience in (0.0, 0.5, 1.0):
        r = twap(snaps, "buy", 4_000, resilience=resilience)
        assert r.fee_bps == pytest.approx(r.one_shot.fee_bps) == pytest.approx(40.0)
        assert r.fee_usd == pytest.approx(sum(c.result.fee_usd for c in r.children))
        assert r.fee_usd == pytest.approx(r.filled_usd * 0.004)
        assert r.all_in_bps == pytest.approx(r.shortfall_bps + 40.0)


def test_arrival_price_math_by_hand():
    """Two children; between them the whole book moves up $1 (the market, not us)."""
    a, b = ladder(mid=100.0), ladder(mid=101.0)
    r = twap([a, b], "buy", 2_000, resilience=1.0)  # 20 SOL at the $100 arrival price
    assert r.arrival_price == 100.0 and r.total_lots == 20
    # child 0: 10 @ 100.05, child 1: 10 @ 101.05 -> average 100.55 = 55 bps over arrival
    assert r.avg_price == pytest.approx(100.55)
    assert r.shortfall_bps == pytest.approx(55.0)
    assert r.drift_paid_bps == pytest.approx(50.0)  # half the SOL bought after a 100 bps move
    assert r.impact_bps == pytest.approx(5.0)  # each child paid its own half-spread
    assert r.shortfall_bps == pytest.approx(r.drift_paid_bps + r.impact_bps)
    assert r.window_drift_bps == pytest.approx(100.0)
    # one-shot at the start: 10 @ 100.05 + 10 @ 100.15 = 10 bps; splitting lost 45 bps
    assert r.one_shot.cost_bps == pytest.approx(10.0)
    assert r.saving_bps == pytest.approx(-45.0)


def test_drift_helps_a_seller_when_the_price_rises():
    r = twap([ladder(mid=100.0), ladder(mid=101.0)], "sell", 2_000)
    assert r.window_drift_bps == pytest.approx(-100.0)  # negative cost: it helped
    assert r.shortfall_bps < r.one_shot.cost_bps


def test_explicit_prices_set_the_arrival_benchmark():
    snaps = [ladder(mid=100.0), ladder(mid=100.0)]
    r = twap(snaps, "buy", 2_000, prices=[99.0, 99.5])
    assert r.arrival_price == 99.0
    assert r.drift_paid_bps == pytest.approx(0.5 * (0.5 / 99 * 1e4))
    assert r.shortfall_bps == pytest.approx(r.drift_paid_bps + r.impact_bps)


def test_partial_fills_are_reported_not_hidden():
    # 3 levels x 10 SOL inside the 10% band; the parent asks for 60 SOL.
    snaps = [ladder(levels=3) for _ in range(3)]
    none = twap(snaps, "buy", 6_000, resilience=0.0)
    assert none.one_shot.filled_lots == 30 and not none.one_shot.fully_filled
    # Children of 20: the first takes 20, the second the last 10, the third finds nothing.
    assert [c.result.filled_lots for c in none.children] == [20, 10, 0]
    assert none.children[2].result.avg_price is None
    assert none.fill_ratio == pytest.approx(0.5) and not none.fully_filled
    assert none.shortfall_bps == pytest.approx(none.one_shot.cost_bps)
    full = twap(snaps, "buy", 6_000, resilience=1.0)
    assert full.fully_filled  # with refill, three children of 20 all fit


def test_twap_rejects_bad_input():
    snaps = [ladder(), ladder()]
    with pytest.raises(ValueError, match="resilience"):
        twap(snaps, "buy", 1_000, resilience=1.5)
    with pytest.raises(ValueError, match="fewer lots"):
        twap(snaps, "buy", 100)  # 1 SOL can't be split in two whole lots
    with pytest.raises(ValueError, match="at least one"):
        twap([], "buy", 1_000)
    with pytest.raises(ValueError, match="side"):
        twap(snaps, "hold", 1_000)


# ---- refill evidence and percentiles -----------------------------------------------------


def test_book_unchanged_share():
    a = ladder()
    assert book_unchanged_share(a, ladder(), "buy", 2_000) == 1.0
    assert book_unchanged_share(a, ladder(mid=101), "buy", 2_000) == 0.0
    thinner = ladder(size=4)
    assert book_unchanged_share(a, thinner, "sell", 500) == pytest.approx(0.4)


def test_dist_percentiles():
    d = Dist.of([float(x) for x in range(11)])  # 0..10
    assert (d.p10, d.median, d.p90, d.n) == (1.0, 5.0, 9.0, 11)
    assert Dist.of([]) is None
    assert Dist.of([3.0]).fmt() == "3.0"


# ---- the collector DB -------------------------------------------------------------------


def write_run(path, n_ticks=6, skip=(), drift=0.0, venues=("kraken", "phoenix")):
    """A fake collector run: one tick every 300 s, the price rising ``drift`` $ per tick."""
    with Store(path) as store:
        run = store.create_run(T0, T0 + n_ticks * 300, 300, {"test": True})
        for i in range(n_ticks):
            if i in skip:
                continue  # as if the collector overran and skipped this slot
            ts = T0 + i * 300
            mid = 100.0 + drift * i
            records = [
                SnapshotRecord(
                    venue=v,
                    requested_at=ts,
                    received_at=ts,
                    attempts=1,
                    ok=True,
                    snapshot=ladder(
                        v,
                        mid=mid + (0.5 if v == "phoenix" else 0.0),
                        size=10 if v == "kraken" else 2,
                        meta={"taker_fee_bps": 2} if v == "phoenix" else None,
                        at=ts,
                    ),
                )
                for v in venues
            ]
            store.insert_tick(run.run_id, TickRecord(ts, ts, ts, None, None, mid, records, []))
    return path


def test_load_series_and_windows_skip_gaps(tmp_path):
    db = write_run(tmp_path / "c.sqlite", n_ticks=8, skip={3})
    with Store(db) as store:
        series = load_series(store, "kraken")
    assert len(series.steps) == 7 and series.interval_s == 300
    # 3 children 1 tick apart: starts at ticks 0, 4, 5 (anything spanning tick 3 is dropped).
    starts = [round((w[0].tick_ts - T0) / 300) for w in series.windows(3, 1)]
    assert starts == [0, 4, 5]
    # 2 children 2 ticks apart: (0,2) (2,4) (4,6) (5,7)
    starts = [round((w[0].tick_ts - T0) / 300) for w in series.windows(2, 2)]
    assert starts == [0, 2, 4, 5]


def test_run_window_with_reference_benchmark(tmp_path):
    db = write_run(tmp_path / "c.sqlite", n_ticks=4, drift=0.10)
    with Store(db) as store:
        window = load_series(store, "phoenix").windows(4)[0]
    own = run_window(window, "buy", 1_000, benchmark="own")
    ref = run_window(window, "buy", 1_000, benchmark="ref")
    assert own.arrival_price == pytest.approx(100.5)  # Phoenix's own mid sits $0.50 high
    assert ref.arrival_price == pytest.approx(100.0)  # the tick's reference mid
    assert ref.shortfall_bps > own.shortfall_bps  # vs the market, Phoenix's premium is a cost
    assert ref.window_drift_bps == pytest.approx(0.30 / 100 * 1e4)
    assert ref.fee_bps == pytest.approx(2.0)


def test_summary_and_markdown_on_a_fake_run(tmp_path):
    db = write_run(tmp_path / "c.sqlite", n_ticks=6)
    with Store(db) as store:
        rows = twap_summary(store, sizes=(1_000, 5_000), n_children=3)
        md = twap_markdown(store, sizes=(1_000, 5_000), n_children=3)
    assert {(r.venue, r.usd) for r in rows} == {
        (v, s) for v in ("kraken", "phoenix") for s in (1_000.0, 5_000.0)
    }
    kraken = next(r for r in rows if r.venue == "kraken" and r.usd == 5_000)
    assert kraken.side == "both" and kraken.n_windows == 4 and kraken.window_s == 600
    # Identical books every tick: full refill always wins, and nothing ever changed.
    assert kraken.twap_cheaper == 1.0 and kraken.saving.median > 0
    assert kraken.unchanged.median == 1.0 and kraken.abs_drift.median == 0.0
    assert kraken.fee_bps == pytest.approx(40.0)
    assert md.startswith("## Does splitting a big order help?")
    assert "| kraken | $5K | buy | 4 |" in md and "| kraken | $5K | sell | 4 |" in md
    assert "hardly requote" in md  # the static book is called out
    assert "preliminary" in md  # 4 start times is not a lot


def test_markdown_says_drift_dominates_when_the_price_moves_more_than_impact(tmp_path):
    # $0.50 per tick on a $100 book (50 bps) dwarfs the 1-2 bps a $1K order moves it.
    db = write_run(tmp_path / "c.sqlite", n_ticks=5, drift=0.5, venues=("kraken",))
    with Store(db) as store:
        md = twap_markdown(store, sizes=(1_000,), n_children=3)
        (row,) = twap_summary(store, sizes=(1_000,), n_children=3)
    assert "mostly luck" in md
    assert row.abs_drift.median == pytest.approx(100.0, rel=0.01)  # $1 over 2 ticks
    assert row.abs_drift_paid.median > row.impact_saving.median


def test_markdown_on_a_run_too_short_says_so(tmp_path):
    db = write_run(tmp_path / "c.sqlite", n_ticks=2)
    with Store(db) as store:
        md = twap_markdown(store, n_children=12)
    assert "Not enough data yet" in md and "12 consecutive ticks" in md


def test_twap_cli_prints_one_shot_vs_twap(tmp_path, capsys):
    db = write_run(tmp_path / "c.sqlite", n_ticks=4, drift=0.05)
    main(["twap", "--db", str(db), "--venue", "kraken", "--usd", "3000", "--children", "3"])
    out = capsys.readouterr().out
    assert "one-shot at start" in out and "TWAP x 3" in out
    assert "Price move over the window: +10.00 bps (against a buyer)" in out
    assert "40 bps either way" in out


def test_twap_cli_summary_and_short_run(tmp_path, capsys):
    db = write_run(tmp_path / "c.sqlite", n_ticks=4)
    main(["twap", "--db", str(db), "--summary", "--children", "2", "--sizes", "1000"])
    assert "| kraken | $1K | buy |" in capsys.readouterr().out
    with pytest.raises(SystemExit, match="consecutive ticks"):
        main(["twap", "--db", str(db), "--venue", "kraken", "--children", "12"])


def test_series_from_steps_directly():
    """Series doesn't need a DB: the course or a notebook can build one by hand."""
    steps = [Step(T0 + i * 300, ladder(at=T0 + i * 300), 100.0) for i in range(3)]
    series = Series("kraken", 300, steps)
    assert len(series.windows(3)) == 1 and len(series.windows(2)) == 2
