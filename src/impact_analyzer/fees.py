"""Taker fees per venue, so costs can be quoted "all-in".

Price impact is what the book charges you; the venue charges a fee on top,
as a fraction of the traded notional. Takers (orders that trade immediately)
pay the taker fee. We keep fees separate from impact everywhere and report
``all_in_bps = impact_bps + fee_bps``, so neither number hides the other.

Sources (base tier, i.e. a new account with no trading volume; check before
quoting, venues change these):

- Phoenix: read from the market account itself (``taker_fee_bps`` in the
  snapshot meta; 2 bps on SOL/USDC on 2026-10-18).
- Kraken Pro: 0.40% taker at the lowest volume tier.
- Coinbase Advanced: 1.20% taker at the lowest volume tier.
- Jupiter routes: AMM and prop-AMM fees are already inside the quoted price,
  and the lite API charges no platform fee, so the extra fee is 0.

High-volume traders pay far less on the exchanges (a few bps), which is why
the report shows impact and fees side by side instead of a single number.
"""

from __future__ import annotations

from .snapshot import BookSnapshot

BASE_TIER_TAKER_BPS: dict[str, float] = {
    "phoenix": 2.0,  # fallback only; the snapshot's own value wins
    "kraken": 40.0,
    "coinbase": 120.0,
    "jupiter": 0.0,
}


def taker_fee_bps(venue: str, snapshot: BookSnapshot | None = None) -> float:
    """The taker fee for ``venue`` in bps. Phoenix's comes from the account when we have it."""
    if snapshot is not None and "taker_fee_bps" in snapshot.meta:
        return float(snapshot.meta["taker_fee_bps"])
    if venue.startswith("jupiter"):
        return BASE_TIER_TAKER_BPS["jupiter"]
    try:
        return BASE_TIER_TAKER_BPS[venue]
    except KeyError:
        raise ValueError(f"no fee known for venue {venue!r}") from None
