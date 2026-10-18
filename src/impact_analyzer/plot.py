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
    """Draw one panel per side (buy, sell), one line per venue, on a log x-axis.

    ``curves[venue][side]`` is a list of results sorted by size. Sizes the book
    could not fully absorb are drawn as hollow markers and the line stops there,
    because the impact of a partial fill understates the true cost.
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
                ax.scatter(
                    [r.target_usd for r in partial],
                    [r.impact_bps for r in partial],
                    facecolors="none",
                    edgecolors=color,
                    label=f"{venue} (book exhausted)",
                )
        if amm is not None:
            sizes = sorted({r.target_usd for c in curves.values() for r in c.get(side, [])})
            fn = amm.buy_impact_bps if side == "buy" else amm.sell_impact_bps
            pts = [(s, fn(s)) for s in sizes if s < amm.usd_reserve]
            ax.plot(*zip(*pts, strict=True), linestyle="--", color="#9ca3af", label="x*y=k AMM")
        ax.set_xscale("log")
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
