import json

from impact_analyzer.__main__ import main


def test_demo_runs_end_to_end(tmp_path, capsys):
    chart = tmp_path / "impact.png"
    main(["--data-dir", str(tmp_path), "demo", "--chart", str(chart)])
    out = capsys.readouterr().out
    assert "demo-dex" in out and "demo-cex" in out
    assert chart.stat().st_size > 10_000
    export = json.loads((tmp_path / "demo-playground.json").read_text())
    assert export["kind"] == "impact-analyzer-export"
    assert {v["venue"] for v in export["venues"]} == {"demo-dex", "demo-cex"}
    v = export["venues"][0]
    assert v["bids"][0][0] < v["asks"][0][0]
    assert len(v["curve"]["buy"]) > 10
