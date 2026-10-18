"""Real AMM prices on Solana, via the Jupiter quote API (public, no key).

Jupiter is an aggregator: given "swap X USDC for SOL" it searches every pool
it knows (AMMs, prop AMMs, order books such as Phoenix) and returns the best
route, split across pools. A quote is not a trade; it is what the route would
pay right now. With the ``dexes`` parameter we can restrict the search to one
venue, which gives a per-venue price for the same trade.

We always quote ``ExactIn`` (many prop AMMs don't support ``ExactOut``):

- buy  $X: send X USDC, receive SOL.   avg price = X / SOL received
- sell $X: send X / ref_price SOL,     avg price = USDC received / SOL sent
  (``ref_price`` is the exchanges' mid at the same tick, so the sale is worth
  about $X).

Cost is then measured against a reference mid exactly like the order books
(see ``metrics.py``). Buy and sell of the same size are quoted back to back,
so half their difference (the round-trip cost) is almost immune to the price
drifting during the minute the grid takes.
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal

from .net import Http

QUOTE_URL = "https://lite-api.jup.ag/swap/v1/quote"
USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
SOL_MINT = "So11111111111111111111111111111111111111112"
USDC_DECIMALS = 6
SOL_DECIMALS = 9

# Our name for a route filter -> Jupiter's ``dexes`` value (comma-separated labels, as
# listed by https://lite-api.jup.ag/swap/v1/program-id-to-label). None = no filter.
DEX_FILTERS: dict[str, str | None] = {
    "best": None,  # what a real Jupiter user gets: the best split across everything
    "SolFi": "SolFi,SolFi V2",  # Ellipsis Labs' prop AMM
    "Phoenix": "Phoenix",  # the same order book our decoder reads, priced by Jupiter
    "HumidiFi": "HumidiFi",  # prop AMM
    "Whirlpool": "Whirlpool",  # Orca's concentrated-liquidity AMM
    "Raydium CLMM": "Raydium CLMM",  # Raydium's concentrated-liquidity AMM
    "Meteora DLMM": "Meteora DLMM",  # Meteora's bin-based AMM
}
DEFAULT_SIZES_USD = (1_000, 10_000, 100_000, 1_000_000)
# HumidiFi is left out by default: on 2026-10-18 the free API found no route through it
# at any size. 6 filters x 4 sizes x 2 sides = 48 quotes per tick.
DEFAULT_DEXES = ("best", "SolFi", "Phoenix", "Whirlpool", "Raydium CLMM", "Meteora DLMM")
# The free tier allows 5 requests per 10 s (see the x-ratelimit-* headers).
DEFAULT_RPS = 0.45


@dataclass(frozen=True, slots=True)
class QuoteRequest:
    dex: str  # key of DEX_FILTERS
    side: str  # "buy" or "sell" (SOL)
    usd_size: float  # intended trade size in USD
    in_amount: int  # atoms sent: USDC atoms for a buy, lamports for a sell

    def params(self) -> dict[str, str]:
        buy = self.side == "buy"
        params = {
            "inputMint": USDC_MINT if buy else SOL_MINT,
            "outputMint": SOL_MINT if buy else USDC_MINT,
            "amount": str(self.in_amount),
            "swapMode": "ExactIn",
            "slippageBps": "50",  # only affects the min-out threshold, not the quote
            "restrictIntermediateTokens": "true",  # route through liquid tokens only
        }
        dexes = DEX_FILTERS[self.dex]
        if dexes:
            params["dexes"] = dexes
        return params


@dataclass(frozen=True, slots=True)
class Quote:
    in_amount: int
    out_amount: int
    price_impact_pct: float | None  # Jupiter's own estimate; we compute our own too
    context_slot: int | None
    route: list[dict]  # one entry per pool: label, amm_key, percent, in/out amounts

    def avg_price(self, side: str) -> float:
        """USDC per SOL actually received or paid."""
        if side == "buy":  # USDC in, SOL out
            usdc_atoms, sol_atoms = self.in_amount, self.out_amount
        else:  # SOL in, USDC out
            usdc_atoms, sol_atoms = self.out_amount, self.in_amount
        usdc = Decimal(usdc_atoms) / 10**USDC_DECIMALS
        sol = Decimal(sol_atoms) / 10**SOL_DECIMALS
        return float(usdc / sol)


def build_grid(dexes: list[str], sizes_usd: list[float], ref_price: float) -> list[QuoteRequest]:
    """Every (dex, size, side) to quote, buy and sell of each pair adjacent in time."""
    grid = []
    for dex in dexes:
        if dex not in DEX_FILTERS:
            raise ValueError(f"unknown dex filter {dex!r}; choose from {list(DEX_FILTERS)}")
        for usd in sizes_usd:
            grid.append(QuoteRequest(dex, "buy", usd, round(usd * 10**USDC_DECIMALS)))
            lamports = round(usd / ref_price * 10**SOL_DECIMALS)
            grid.append(QuoteRequest(dex, "sell", usd, lamports))
    return grid


def parse_quote(body: dict) -> Quote:
    """Parse a ``/quote`` response. Raises ValueError if Jupiter returned an error body."""
    if "error" in body:
        raise ValueError(f"{body.get('errorCode', 'error')}: {body['error']}")
    route = [
        {
            "label": step["swapInfo"].get("label"),
            "amm_key": step["swapInfo"].get("ammKey"),
            "percent": step.get("percent"),
            "in_amount": int(step["swapInfo"]["inAmount"]),
            "out_amount": int(step["swapInfo"]["outAmount"]),
        }
        for step in body.get("routePlan", [])
    ]
    impact = body.get("priceImpactPct")
    slot = body.get("contextSlot")
    return Quote(
        in_amount=int(body["inAmount"]),
        out_amount=int(body["outAmount"]),
        price_impact_pct=float(impact) if impact not in (None, "") else None,
        context_slot=int(slot) if slot is not None else None,
        route=route,
    )


def fetch_quote(http: Http, req: QuoteRequest, url: str = QUOTE_URL) -> tuple[Quote, float]:
    """Return ``(quote, latency_ms)``. Errors (no route, rate limit...) propagate."""
    resp = http.get_json(url, params=req.params())
    return parse_quote(resp.body), resp.latency_ms
