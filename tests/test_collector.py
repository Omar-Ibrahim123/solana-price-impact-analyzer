"""The collector and its SQLite store, with a fake clock and fake venues: no network.

The fake clock only moves when the collector sleeps, so a "24 hour" schedule runs in
milliseconds and every timestamp is predictable.
"""

import sqlite3
import threading

import pytest

from impact_analyzer import jupiter
from impact_analyzer.collector import (
    CollectConfig,
    Collector,
    expected_ticks,
    format_status,
    format_tick,
    parse_duration,
)
from impact_analyzer.net import FetchError, HttpStatusError
from impact_analyzer.store import Store
from impact_analyzer.synthetic import synthetic_book
from impact_analyzer.venues import Fetched

T0 = 1_792_299_900.0  # a multiple of 300 s: the first tick lands exactly on a slot


class FakeClock:
    def __init__(self, t: float) -> None:
        self.t = t
        self.lock = threading.Lock()  # the collector reads the clock from worker threads

    def __call__(self) -> float:
        with self.lock:
            return self.t

    def sleep(self, seconds: float) -> None:
        with self.lock:
            self.t += seconds


def book_fetcher(venue, mid=100.0, raw=None):
    def fetch(http, rpc):
        return Fetched(synthetic_book(venue, mid=mid), latency_ms=12.0, attempts=1, raw=raw)

    return fetch


def failing_fetcher(http, rpc):
    raise FetchError("GET https://api.kraken.com failed: HTTP 503", attempts=4)


def fake_quote(http, req):
    if req.dex == "SolFi" and req.usd_size >= 100_000:
        raise HttpStatusError(400, '{"errorCode": "NO_ROUTES_FOUND", "error": "No routes"}', 1)
    price = 100.05 if req.side == "buy" else 99.95
    if req.side == "buy":
        out = round(req.in_amount / 10**6 / price * 10**9)  # USDC atoms in -> lamports out
    else:
        out = round(req.in_amount / 10**9 * price * 10**6)  # lamports in -> USDC atoms out
    return jupiter.Quote(req.in_amount, out, 0.0001, 458_000_000, [{"label": req.dex}]), 30.0


def make_collector(store, clock, fetchers=None, **config):
    fetchers = fetchers or {
        "phoenix": book_fetcher("phoenix", raw=b"\x00" * 1000),
        "kraken": book_fetcher("kraken"),
        "coinbase": book_fetcher("coinbase"),
    }
    settings = dict(
        interval_s=300,
        duration_s=900,
        venues=list(fetchers),
        jupiter_dexes=["best", "SolFi"],
        jupiter_sizes=[1_000, 100_000],
        jupiter_rps=0,  # no pacing in tests
    )
    cfg = CollectConfig(**{**settings, **config})
    return Collector(
        store,
        cfg,
        http=None,
        fetchers=fetchers,
        slot_fn=lambda http, rpc: (458_000_000, 5.0),
        quote_fn=fake_quote,
        clock=clock,
        sleep=clock.sleep,
    )


@pytest.fixture
def store(tmp_path):
    with Store(tmp_path / "collect.sqlite") as s:
        yield s


def test_parse_duration():
    assert parse_duration("90s") == 90
    assert parse_duration("5m") == 300
    assert parse_duration("24h") == 86_400
    assert parse_duration("1h30m") == 5_400
    assert parse_duration("120") == 120
    with pytest.raises(ValueError):
        parse_duration("5 minutes")


def test_expected_ticks_counts_slots_not_seconds(store):
    # Started 100 s into a slot: that slot counts, so 900 s spans 4 slots.
    run = make_collector(store, FakeClock(T0 + 100)).start_run()
    assert expected_ticks(run) == 4
    run = make_collector(store, FakeClock(T0)).start_run()
    assert expected_ticks(run) == 3


def test_full_run_writes_aligned_ticks(store):
    clock = FakeClock(T0)
    collector = make_collector(store, clock)
    run = collector.start_run()
    assert collector.run(run) == 3  # 900 s / 300 s
    ticks = store.ticks(run.run_id)
    assert [t["tick_ts"] - T0 for t in ticks] == [0, 300, 600]
    assert all(t["slot"] == 458_000_000 for t in ticks)
    assert ticks[0]["ref_mid"] == pytest.approx(100.0, rel=1e-3)

    snaps = list(store.snapshots(run_id=run.run_id))
    assert len(snaps) == 9 and all(s.ok for s in snaps)
    phoenix = next(s for s in snaps if s.venue == "phoenix")
    assert phoenix.raw() == b"\x00" * 1000  # raw bytes survive compression
    book = phoenix.book()
    assert book.venue == "phoenix" and book.mid_price() == pytest.approx(100.0, rel=1e-3)


def test_exchange_books_are_trimmed_but_counts_kept(store):
    clock = FakeClock(T0)
    collector = make_collector(store, clock, cex_band=0.001)  # keep only 0.1% around mid
    tick = collector.collect_tick(T0)
    kraken = next(s for s in tick.snapshots if s.venue == "kraken")
    assert kraken.snapshot.meta["trimmed_band"] == 0.001
    assert len(kraken.snapshot.bids) < kraken.n_bids
    phoenix = next(s for s in tick.snapshots if s.venue == "phoenix")
    assert "trimmed_band" not in phoenix.snapshot.meta  # Phoenix is stored whole


def test_one_venue_failing_does_not_stop_the_others(store):
    clock = FakeClock(T0)
    fetchers = {
        "phoenix": book_fetcher("phoenix"),
        "kraken": failing_fetcher,
        "coinbase": book_fetcher("coinbase"),
    }
    collector = make_collector(store, clock, fetchers=fetchers)
    run = collector.start_run()
    collector.run(run)
    rows = list(store.snapshots(run_id=run.run_id, ok_only=False))
    kraken = [r for r in rows if r.venue == "kraken"]
    assert len(kraken) == 3 and not any(r.ok for r in kraken)
    assert "HTTP 503" in kraken[0].error
    assert all(r.ok for r in rows if r.venue != "kraken")
    # Coinbase alone still provides the reference price, so quotes still run.
    assert store.ticks(run.run_id)[0]["ref_mid"] is not None
    health = {r["venue"]: r for r in store.venue_health(run.run_id)}
    assert health["kraken"]["n_ok"] == 0 and health["kraken"]["retries"] == 9
    assert "HTTP 503" in health["kraken"]["last_error"]


def test_quotes_stored_with_errors_explained(store):
    clock = FakeClock(T0)
    collector = make_collector(store, clock)
    run = collector.start_run()
    collector.run(run)
    quotes = store.quotes(run.run_id, ok_only=False)
    assert len(quotes) == 3 * 2 * 2 * 2  # ticks x dexes x sizes x sides
    bad = [q for q in quotes if not q["ok"]]
    assert {(q["dex"], q["usd_size"]) for q in bad} == {("SolFi", 100_000)}
    assert "NO_ROUTES_FOUND" in bad[0]["error"]
    good = next(q for q in quotes if q["ok"] and q["side"] == "buy")
    assert good["avg_price"] == pytest.approx(100.05)


def test_resume_skips_ticks_already_stored(store):
    clock = FakeClock(T0)
    first = make_collector(store, clock)
    run = first.start_run()
    store.insert_tick(run.run_id, first.collect_tick(T0))  # one tick stored, then a crash
    calls = []
    second = make_collector(store, clock)
    original = second.collect_tick
    second.collect_tick = lambda ts: calls.append(ts) or original(ts)
    second.run(store.latest_run())
    assert [c - T0 for c in calls] == [300, 600]  # T0 was not collected again
    assert len(store.ticks(run.run_id)) == 3


def test_stop_request_ends_the_run_after_the_current_tick(store):
    clock = FakeClock(T0)
    collector = make_collector(store, clock)
    original = collector.collect_tick

    def tick_then_stop(ts):
        tick = original(ts)
        collector.request_stop()  # as if Ctrl+C arrived during the first tick
        return tick

    collector.collect_tick = tick_then_stop
    run = collector.start_run()
    assert collector.run(run) == 1
    assert len(store.ticks(run.run_id)) == 1  # the interrupted tick was still saved


def test_overrun_collects_the_current_slot_late_and_skips_the_rest(store):
    clock = FakeClock(T0)
    collector = make_collector(store, clock, duration_s=1_500)
    original = collector.collect_tick

    def slow_first_tick(ts):
        tick = original(ts)
        if ts == T0:
            clock.sleep(650)  # first tick takes > 2 intervals
        return tick

    collector.collect_tick = slow_first_tick
    run = collector.start_run()
    collector.run(run)
    # The tick ran until T0+650: slot 300 was run past (lost), slot 600 is collected late.
    assert [t["tick_ts"] - T0 for t in store.ticks(run.run_id)] == [0, 600, 900, 1200]
    late = store.ticks(run.run_id)[1]
    assert late["started_at"] - late["tick_ts"] == 50


def test_status_and_tick_line_mention_failures(store):
    clock = FakeClock(T0)
    fetchers = {"phoenix": book_fetcher("phoenix"), "kraken": failing_fetcher}
    collector = make_collector(store, clock, fetchers=fetchers)
    run = collector.start_run()
    tick = collector.collect_tick(T0)
    store.insert_tick(run.run_id, tick)
    line = format_tick(tick, 1, 3)
    assert "kraken FAILED" in line and "phoenix 12ms" in line
    status = format_status(store)
    assert "1/3 ticks" in status and "HTTP 503" in status


def test_store_refuses_newer_schema(tmp_path):
    path = tmp_path / "future.sqlite"
    with Store(path) as s:
        s.db.execute("PRAGMA user_version = 99")
    with pytest.raises(RuntimeError, match="newer version"):
        Store(path)


def test_trimmed_keeps_only_the_band():
    book = synthetic_book("x", mid=100.0, level_step_bps=10)
    trimmed = book.trimmed(0.01)
    assert trimmed.bids and trimmed.asks
    assert all(book.price(o.price_ticks) >= 99.0 for o in trimmed.bids)
    assert all(book.price(o.price_ticks) <= 101.0 for o in trimmed.asks)
    assert len(trimmed.bids) < len(book.bids)
    assert trimmed.best_bid() == book.best_bid()  # top of book untouched


def test_readonly_store_reads_but_never_writes(store, tmp_path):
    clock = FakeClock(T0)
    collector = make_collector(store, clock)
    run = collector.start_run()
    store.insert_tick(run.run_id, collector.collect_tick(T0))
    with Store(store.path, readonly=True) as reader:
        assert len(reader.ticks(run.run_id)) == 1
        snap = next(reader.snapshots(venue="kraken"))
        reader.cache_metrics(snap.id, 1, {"x": 1})  # silently skipped
        assert reader.cached_metrics(snap.id, 1) is None
        with pytest.raises(sqlite3.OperationalError):
            reader.db.execute("DELETE FROM ticks")
    with pytest.raises(FileNotFoundError):
        Store(tmp_path / "missing.sqlite", readonly=True)
