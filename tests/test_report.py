"""The report command end to end on a small offline database (no network)."""

import pytest
from collector_db import EVENTS_PER_TICK, build_db

from impact_analyzer import metrics
from impact_analyzer.__main__ import main
from impact_analyzer.metrics import METRICS_VERSION, load_dataset
from impact_analyzer.report import build_report, fmt_bps
from impact_analyzer.store import Store

CHARTS = (
    "spread_over_time.png",
    "depth_2pct_over_time.png",
    "cost_vs_size_books.png",
    "cost_vs_size_jupiter.png",
    "round_trip_vs_size.png",
    "hour_of_day.png",
    "phoenix_activity.png",
)


@pytest.fixture
def store(tmp_path):
    s = build_db(tmp_path / "collect.sqlite", ticks=3)
    yield s
    s.close()


def test_report_writes_markdown_and_every_chart(store, tmp_path):
    out = tmp_path / "report"
    md_path = build_report(store, out)
    md = md_path.read_text(encoding="utf-8")
    for name in CHARTS:
        assert (out / name).stat().st_size > 10_000, name
        assert f"]({name})" in md
    for venue in ("Phoenix", "Kraken", "Coinbase", "Jupiter best route", "SolFi via Jupiter"):
        assert venue in md
    assert "## Headline findings" in md and "Median quoted spread" in md
    assert "SolFi via Jupiter found no route at: $100K" in md  # NO_ROUTES handled
    assert f"advanced a median of {EVENTS_PER_TICK} events per tick" in md
    assert "| Kraken | 3 | 2 |" in md  # health table: one failed tick of three
    assert "## Method" in md and "## Caveats" in md
    assert "partial run" not in md  # the run collected every tick it planned


def test_report_reads_a_live_database_without_writing(store, tmp_path):
    with Store(store.path, readonly=True) as ro:
        md = build_report(ro, tmp_path / "ro").read_text(encoding="utf-8")
    assert "## Does splitting a big order help?" in md  # execution.py's TWAP section
    assert md.index("## Does splitting") < md.index("## Method")
    assert store.db.execute("SELECT COUNT(*) FROM metrics").fetchone()[0] == 0  # no cache rows


def test_report_on_a_single_tick(tmp_path):
    with build_db(tmp_path / "one.sqlite", ticks=1) as s:
        md = build_report(s, tmp_path / "r").read_text(encoding="utf-8")
    assert "**1 ticks**" in md
    assert (tmp_path / "r" / "phoenix_activity.png").exists()  # draws "needs two ticks"


def test_metrics_are_cached_per_snapshot(store, monkeypatch):
    first = load_dataset(store)
    rows = store.db.execute("SELECT COUNT(*) FROM metrics WHERE version = ?", (METRICS_VERSION,))
    assert rows.fetchone()[0] == len(first.books) == 8  # 3 Phoenix + 2 Kraken + 3 Coinbase

    def boom(*a, **k):
        raise AssertionError("should have come from the cache")

    monkeypatch.setattr(metrics, "book_metrics", boom)
    again = load_dataset(store)
    assert again.books == first.books
    with pytest.raises(AssertionError):  # other settings = other numbers: not reused
        load_dataset(store, max_slippage=0.05)


def test_report_cli(store, tmp_path, capsys):
    out = tmp_path / "cli-report"
    main(["report", "--db", str(store.path), "--out", str(out)])
    assert (out / "REPORT.md").exists()
    assert "REPORT.md" in capsys.readouterr().out


def test_report_cli_refuses_a_missing_db(tmp_path):
    with pytest.raises(SystemExit):
        main(["report", "--db", str(tmp_path / "nope.sqlite"), "--out", str(tmp_path)])


def test_fmt_bps():
    assert fmt_bps(1583.77) == "1,584"
    assert fmt_bps(57.74) == "57.7"
    assert fmt_bps(0.964) == "0.96"
    assert fmt_bps(None) == "n/a"
