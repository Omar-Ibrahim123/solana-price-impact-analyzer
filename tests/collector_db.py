"""A small collector database built offline, shared by the report and export tests.

It goes through the real ``Collector`` (fake clock, fake venues, fake Jupiter),
so the rows are exactly what a live run writes, including the awkward parts:
Kraken fails on one tick, SolFi has no route at $100K, and the Phoenix venue
returns real account bytes (built with the same layout the decoder reads) whose
sequence number moves 8 events per tick.
"""

from __future__ import annotations

import itertools
import struct

from test_collector import T0, FakeClock, fake_quote, make_collector
from test_fetchers import build_account

from impact_analyzer import phoenix
from impact_analyzer.net import FetchError
from impact_analyzer.store import Store
from impact_analyzer.synthetic import synthetic_book
from impact_analyzer.venues import Fetched

EVENTS_PER_TICK = 8


def phoenix_fetcher():
    calls = itertools.count()

    def fetch(http, rpc):
        n = next(calls)
        # $99 x 5 SOL and $98 x 20 SOL bids; $101 x 5 SOL and $102 x 20 SOL asks.
        account = bytearray(
            build_account(
                bids=[(99_000, 1, 5_000), (98_000, 2, 20_000)],
                asks=[(101_000, 3, 5_000), (102_000, 4, 20_000)],
            )
        )
        struct.pack_into("<Q", account, 272, 1_000 + EVENTS_PER_TICK * n)  # sequence number
        data = bytes(account)
        snap = phoenix.to_snapshot(phoenix.decode_market(data, 0, 0), "PhoenixAddr", slot=7)
        return Fetched(snap, latency_ms=300.0, attempts=1, slot=7, raw=data)

    return fetch


def flaky_kraken():
    calls = itertools.count()

    def fetch(http, rpc):
        if next(calls) == 1:  # the second tick fails
            raise FetchError("GET https://api.kraken.com failed: HTTP 503", attempts=4)
        return Fetched(synthetic_book("kraken", mid=100.0), latency_ms=150.0, attempts=1)

    return fetch


def build_db(path, ticks: int = 3) -> Store:
    """A store holding ``ticks`` ticks of every venue plus a Jupiter grid each tick."""
    store = Store(path)
    clock = FakeClock(T0)
    fetchers = {
        "phoenix": phoenix_fetcher(),
        "kraken": flaky_kraken(),
        "coinbase": lambda http, rpc: Fetched(
            synthetic_book("coinbase", mid=100.0, seed=3), latency_ms=90.0, attempts=1
        ),
    }
    collector = make_collector(
        store,
        clock,
        fetchers=fetchers,
        duration_s=300 * ticks,
        jupiter_dexes=["best", "SolFi", "Phoenix"],
        jupiter_sizes=[1_000, 100_000],
    )
    assert collector.quote_fn is fake_quote
    collector.run(collector.start_run())
    return store
