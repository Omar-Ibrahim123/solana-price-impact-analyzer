"""Every order book venue in one registry: how to fetch it, what to call it.

Each fetcher takes a shared ``Http`` client (retries, latency) and returns a
``Fetched``: the normalized snapshot plus anything worth keeping raw. Adding a
venue means writing one function and one registry line; the collector, the
``fetch`` command and the report pick it up from here.
"""

from __future__ import annotations

import os
import time
from collections.abc import Callable
from dataclasses import dataclass

from . import cex, phoenix
from .net import Http
from .snapshot import BookSnapshot


@dataclass(frozen=True, slots=True)
class Fetched:
    snapshot: BookSnapshot
    latency_ms: float
    attempts: int
    slot: int | None = None  # Solana slot the data is from (Phoenix only)
    raw: bytes | None = None  # raw account bytes (Phoenix only), so we can re-decode later


def rpc_url(override: str | None = None) -> str:
    return override or os.environ.get(phoenix.RPC_ENV_VAR) or phoenix.DEFAULT_RPC_URL


def fetch_phoenix(http: Http, rpc: str | None = None) -> Fetched:
    payload = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "getAccountInfo",
        "params": [phoenix.SOL_USDC_MARKET, {"encoding": "base64", "commitment": "confirmed"}],
    }
    resp = http.post_json(rpc_url(rpc), payload)
    data, slot = phoenix.parse_account_response(resp.body, phoenix.SOL_USDC_MARKET)
    fetched_at = time.time()
    market = phoenix.decode_market(data, slot, int(fetched_at))
    snap = phoenix.to_snapshot(market, phoenix.SOL_USDC_MARKET, slot, fetched_at)
    snap.meta["account_len"] = len(data)
    raw = data[: phoenix.order_trees_end(market.header)]  # header + bids + asks, no seats
    return Fetched(snap, resp.latency_ms, resp.attempts, slot=slot, raw=raw)


def fetch_kraken(http: Http, rpc: str | None = None) -> Fetched:
    resp = http.get_json(cex.KRAKEN_URL, params={"pair": "SOLUSD", "count": 500})
    return Fetched(cex.parse_kraken(resp.body), resp.latency_ms, resp.attempts)


def fetch_coinbase(http: Http, rpc: str | None = None) -> Fetched:
    resp = http.get_json(cex.COINBASE_URL.format(product="SOL-USD"), params={"level": 2})
    return Fetched(cex.parse_coinbase(resp.body), resp.latency_ms, resp.attempts)


def fetch_slot(http: Http, rpc: str | None = None) -> tuple[int, float]:
    """Current Solana slot and the call's latency: a clock every tick can be lined up on."""
    resp = http.post_json(rpc_url(rpc), {"jsonrpc": "2.0", "id": 1, "method": "getSlot"})
    if "error" in resp.body:
        raise RuntimeError(f"RPC error: {resp.body['error']}")
    return int(resp.body["result"]), resp.latency_ms


FETCHERS: dict[str, Callable[[Http, str | None], Fetched]] = {
    "phoenix": fetch_phoenix,
    "kraken": fetch_kraken,
    "coinbase": fetch_coinbase,
}
VENUES = tuple(FETCHERS)
# Venues whose mids form the common reference price (deep, centralized books).
REFERENCE_VENUES = ("kraken", "coinbase")
