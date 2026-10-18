"""Plot price impact (bps) against trade size for each venue."""

from __future__ import annotations

from pathlib import Path

from .amm import AmmPool
from .impact import ImpactResult

COLORS = {
    "phoenix": "#7c3aed",
    "kraken": "#2563eb",
    "coinbase": "#0891b2",
    "demo-dex": "#7c3aed",
    "demo-cex": "#2563eb",
}


def plot_impact(
    curves: dict[str, dict[str, list[ImpactResult]]],
    out_path: Path,
    amm: AmmPool | None = None,
    title: str = "SOL price impact vs. trade size",
) -> Path:
    """Draw one panel per side (buy, sell), one line per venue, on log-log axes.

    ``curves[venue][side]`` is a list of results sorted by size. Log scales on
    both axes keep a 0.5 bps exchange and a 50 bps on-chain book readable on
    the same chart. Where a book runs out (a partial fill), the line stops and
    an x marks how much it could absorb: the impact of a partial fill
    understates the true cost, so it is not plotted as if it were a real point.
    """
    import matplotlib

    matplotlib.use("Agg")  # no window: we only write a file
    import matplotlib.pyplot as plt

    fig, axes = plt.subplots(1, 2, figsize=(12, 5), sharey=True)
    for ax, side in zip(axes, ("buy", "sell"), strict=True):
        for venue, by_side in curves.items():
            results = [r for r in by_side.get(side, []) if r.impact_bps is not None]
            color = COLORS.get(venue)
            full = [r for r in results if r.fully_filled]
            partial = [r for r in results if not r.fully_filled]
            ax.plot(
                [r.target_usd for r in full],
                [r.impact_bps for r in full],
                marker="o",
                markersize=3,
                label=venue,
                color=color,
            )
            if partial:
                p = partial[0]
                ax.plot(p.filled_usd, p.impact_bps, marker="x", markersize=9, color=color)
                ax.annotate(
                    f"{venue} runs out at ${p.filled_usd:,.0f}",
                    (p.filled_usd, p.impact_bps),
                    textcoords="offset points",
                    xytext=(8, 6),
                    fontsize=8,
                    color=color,
                )
        if amm is not None:
            sizes = sorted({r.target_usd for c in curves.values() for r in c.get(side, [])})
            fn = amm.buy_impact_bps if side == "buy" else amm.sell_impact_bps
            pts = [(s, fn(s)) for s in sizes if s < amm.usd_reserve]
            pts = [(s, bps) for s, bps in pts if bps > 0]
            ax.plot(*zip(*pts, strict=True), linestyle="--", color="#9ca3af", label="x*y=k AMM")
        ax.set_xscale("log")
        ax.set_yscale("log")
        ax.set_title(f"Market {side}")
        ax.set_xlabel("Trade size (USD)")
        ax.grid(True, which="both", alpha=0.3)
        ax.legend(fontsize=8)
    axes[0].set_ylabel("Impact vs. mid (bps)")
    fig.suptitle(title)
    fig.tight_layout()
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(out_path, dpi=150)
    plt.close(fig)
    return out_path
