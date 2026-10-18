"""Export v2 (the course's data file): schema, v1 compatibility, the Phoenix hex slice."""

import json
import struct

import pytest
from collector_db import EVENTS_PER_TICK, build_db
from test_fetchers import build_account

from impact_analyzer import phoenix
from impact_analyzer.__main__ import main
from impact_analyzer.export import (
    MAX_SAFE_INTEGER,
    base58,
    export_v2,
    phoenix_account_slice,
    write_export,
)

V1_VENUE_KEYS = {
    "venue",
    "symbol",
    "fetched_at",
    "mid",
    "spread_bps",
    "bids",
    "asks",
    "curve",
    "meta",
}


@pytest.fixture(scope="module")
def doc(tmp_path_factory):
    with build_db(tmp_path_factory.mktemp("db") / "collect.sqlite", ticks=3) as store:
        return export_v2(store)


def test_header_and_v1_superset(doc):
    assert doc["kind"] == "impact-analyzer-export" and doc["version"] == 2
    assert {"generated_at", "venues", "amm_usd_reserve"} <= set(doc)  # every v1 key
    assert [v["venue"] for v in doc["venues"]] == ["phoenix", "kraken", "coinbase"]
    for v in doc["venues"]:
        assert V1_VENUE_KEYS <= set(v)
        assert v["bids"][0][0] < v["asks"][0][0]  # [price, size] levels, best first
        assert len(v["curve"]["buy"]) > 10 and len(v["curve"]["buy"][0]) == 3
        assert set(v["depth_usd"]) == {"0.005", "0.01", "0.02"}
        assert all(len(pair) == 2 for pair in v["depth_usd"].values())
    fees = {v["venue"]: v["fee_bps"] for v in doc["venues"]}
    assert fees == {"phoenix": 5.0, "kraken": 40.0, "coinbase": 120.0}  # Phoenix's from bytes


def test_jupiter_block(doc):
    q = doc["jupiter"]
    assert len(q) == 3 * 2 * 2  # newest tick only: dexes x sizes x sides
    solfi_big = [x for x in q if x["dex"] == "SolFi" and x["usd"] == 100_000]
    assert solfi_big and all(not x["ok"] and x["cost_bps_vs_ref"] is None for x in solfi_big)
    best = next(x for x in q if x["dex"] == "best" and x["side"] == "buy" and x["usd"] == 1_000)
    assert best["cost_bps_vs_ref"] == pytest.approx(5.0, abs=0.5)  # fake quotes: $100.05 vs ~100
    assert best["route"] == ["best"] and best["slot"] == 458_000_000


def test_timeseries_arrays_align_with_t(doc):
    ts = doc["timeseries"]
    n = len(ts["t"])
    assert n == 3 and ts["interval_s"] == 300 and len(ts["ref_mid"]) == n

    def arrays(node):
        if isinstance(node, list):
            yield node
        elif isinstance(node, dict):
            for v in node.values():
                yield from arrays(v)

    for name, series in ts["series"].items():
        for arr in arrays(series):
            assert len(arr) == n, name
    kraken = ts["series"]["kraken"]
    assert kraken["spread_bps"][1] is None  # the tick Kraken failed
    assert kraken["impact_bps"]["buy"]["1000"][0] is not None
    phx = ts["series"]["phoenix"]
    assert phx["events"] == [None, EVENTS_PER_TICK, EVENTS_PER_TICK]
    assert phx["cost_bps_vs_ref"]["buy"]["1000000"] == [None] * n  # partial: never shown full
    assert "jupiter:SolFi" in ts["series"]
    assert ts["series"]["jupiter:SolFi"]["round_trip_bps"]["1000"][0] is not None


def test_phoenix_account_slice(doc):
    acct = doc["phoenix_account"]
    raw = bytes.fromhex(acct["hex"])
    assert acct["offset"] == 0 and len(raw) == acct["length"] and acct["slot"] == 7
    fields = acct["fields"]
    # Fields are contiguous and inside the slice: the hex explorer can label every byte.
    end = 0
    for f in fields:
        assert f["offset"] == end, f["name"]
        assert f["explain"] and f["explain"].endswith((".", ")"))
        end = f["offset"] + f["size"]
    assert end == len(raw)
    by_name = {f["name"]: f for f in fields}
    h = phoenix.MarketHeader.decode(raw)
    assert by_name["bids_size"]["value"] == h.bids_size == 8
    assert by_name["base_decimals"]["value"] == 9 and by_name["quote_decimals"]["value"] == 6
    assert by_name["market_sequence_number"]["value"] == h.market_sequence_number
    assert by_name["taker_fee_bps"]["value"] == 5
    assert by_name["bids.node[1].price_in_ticks"]["value"] == 99_000
    assert "$99.000" in by_name["bids.node[1].price_in_ticks"]["explain"]
    assert "live resting bid" in by_name["bids.node[1].left"]["explain"]
    assert "never used" in by_name["bids.node[3].left"]["explain"]  # only 2 bids allocated


def test_free_list_nodes_are_labelled():
    data = build_account(
        bids=[(150_000, 1, 10), (149_000, 2, 20), (148_000, 3, 30)],
        asks=[(151_000, 4, 10)],
        free_bid_nodes=(0, 2),
    )
    fields = {f["name"]: f for f in phoenix_account_slice(data, 1, "addr")["fields"]}
    assert "free list" in fields["bids.node[1].left"]["explain"]
    assert "live" in fields["bids.node[2].left"]["explain"]


def test_big_u64_values_become_strings():
    data = bytearray(build_account(bids=[(150_000, 1, 10)], asks=[(151_000, 2, 10)]))
    bid_seq_at = 912 + 24  # first bids node, order_sequence_number
    struct.pack_into("<Q", data, bid_seq_at, ~5 & (2**64 - 1))  # Phoenix stores bids as NOT seq
    fields = {f["name"]: f for f in phoenix_account_slice(bytes(data), 1, "addr")["fields"]}
    value = fields["bids.node[1].order_sequence_number"]["value"]
    assert isinstance(value, str) and int(value) > MAX_SAFE_INTEGER
    assert fields["bids_size"]["value"] == 8  # small values stay numbers


def test_base58():
    assert base58(bytes(32)) == "1" * 32
    assert base58(bytes(31) + b"\x01") == "1" * 31 + "2"
    assert base58(b"\x00\x00\x3a") == "1121"  # 58 = "21" in base 58, two leading zeros


def test_written_file_is_small_and_valid_json(doc, tmp_path):
    path = tmp_path / "course" / "export.json"
    size = write_export(doc, path)
    assert size < 2_000_000
    assert json.loads(path.read_text(encoding="utf-8"))["version"] == 2


def test_export_cli(tmp_path, capsys):
    with build_db(tmp_path / "c.sqlite", ticks=2) as store:
        db = store.path
    out = tmp_path / "export.json"
    main(["export", "--db", str(db), "--out", str(out)])
    assert json.loads(out.read_text(encoding="utf-8"))["kind"] == "impact-analyzer-export"
    assert "export v2" in capsys.readouterr().out
