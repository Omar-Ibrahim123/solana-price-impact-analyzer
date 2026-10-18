"""Order book snapshots from centralized exchanges (Kraken, Coinbase).

Both publish aggregated price levels as decimal strings over a public REST
endpoint, no API key needed. Each parser takes the decoded JSON so it can be
tested against fixtures without the network; each fetcher just adds the HTTP.

We convert to integer ticks of 1e-6 USD and lots of 1e-8 SOL: fine enough
that every price these venues publish converts exactly, and sizes lose at most
one hundred-millionth of a SOL (rounded down).
"""

from __future__ import annotations

import time
from decimal import Decimal

from .snapshot import BookSnapshot, from_decimal_levels

CEX_TICK = Decimal("0.000001")
CEX_LOT = Decimal("0.00000001")
USER_AGENT = "solana-price-impact-analyzer/0.1 (educational project)"

KRAKEN_URL = "https://api.kraken.com/0/public/Depth"
COINBASE_URL = "https://api.exchange.coinbase.com/products/{product}/book"


def parse_kraken(body: dict, fetched_at: float | None = None) -> BookSnapshot:
    """Kraken: ``{"error": [], "result": {"<pair>": {"asks": [[p, v, ts]], "bids": [...]}}}``."""
    if body.get("error"):
        raise RuntimeError(f"Kraken error: {body['error']}")
    # The result key is Kraken's own pair name (e.g. "SOLUSD"), not always what we asked for.
    pair, book = next(iter(body["result"].items()))
    return from_decimal_levels(
        venue="kraken",
        symbol="SOL/USD",
        fetched_at=time.time() if fetched_at is None else fetched_at,
        bids=[(lvl[0], lvl[1]) for lvl in book["bids"]],
        asks=[(lvl[0], lvl[1]) for lvl in book["asks"]],
        tick_size=CEX_TICK,
        lot_size=CEX_LOT,
        meta={"pair": pair, "levels": "aggregated"},
    )


def parse_coinbase(body: dict, fetched_at: float | None = None) -> BookSnapshot:
    """Coinbase level 2: ``{"bids": [[p, size, num_orders]], "asks": [...], "sequence": n}``."""
    return from_decimal_levels(
        venue="coinbase",
        symbol="SOL/USD",
        fetched_at=time.time() if fetched_at is None else fetched_at,
        bids=[(lvl[0], lvl[1]) for lvl in body["bids"]],
        asks=[(lvl[0], lvl[1]) for lvl in body["asks"]],
        tick_size=CEX_TICK,
        lot_size=CEX_LOT,
        meta={"sequence": body.get("sequence"), "levels": "aggregated"},
    )


def fetch_kraken(pair: str = "SOLUSD", count: int = 500, timeout: float = 15.0) -> BookSnapshot:
    import httpx

    resp = httpx.get(
        KRAKEN_URL,
        params={"pair": pair, "count": count},
        headers={"User-Agent": USER_AGENT},
        timeout=timeout,
    )
    resp.raise_for_status()
    return parse_kraken(resp.json())


def fetch_coinbase(product: str = "SOL-USD", timeout: float = 15.0) -> BookSnapshot:
    import httpx

    # Coinbase rejects requests that have no User-Agent.
    resp = httpx.get(
        COINBASE_URL.format(product=product),
        params={"level": 2},
        headers={"User-Agent": USER_AGENT},
        timeout=timeout,
    )
    resp.raise_for_status()
    return parse_coinbase(resp.json())
