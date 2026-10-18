"""PNG charts for the report. One function per chart; each returns its path, or None
when there is nothing to draw (a venue that never answered, a run of one tick...).

Conventions, the same on every chart:

- one colour per venue or route everywhere (order books keep ``plot.COLORS``),
  plus a marker shape and a line style (books solid, Jupiter routes dashed), so a
  colour-blind reader, or a black-and-white print, can still tell lines apart;
- every axis says its unit; times are UTC;
- costs can be negative (a venue priced below the reference sells you SOL
  cheaply), which a log axis can't show, so cost axes are *symlog*: linear
  between -1 and +1 bps, logarithmic beyond. Spreads and depths are always
  positive and use a plain log axis;
- partial fills are never drawn as if they were full: a size the book could
  not fill in any tick has no point (a footnote names it), and a size filled
  only in some ticks gets a hollow marker (its median is over the ticks where
  it did fill).
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from datetime import UTC, datetime
from pathlib import Path

from .plot import COLORS as VENUE_COLORS
from .timeseries import Activity, Key, Obs, Summary, over_time

# Jupiter routes: hues from a colour-blind-checked categorical palette, chosen to
# stay clear of the three venue colours (violet, blue, cyan) they share charts with.
ROUTE_COLORS = {
    "jupiter:best": "#3a3a38",  # near-black: "the market", what a Jupiter user gets
    "jupiter:SolFi": "#eb6834",  # orange: Ellipsis Labs' prop AMM, the one to look at
    "jupiter:Phoenix": "#e87ba4",  # magenta: Phoenix again, as Jupiter prices it
    "jupiter:Whirlpool": "#1baf7a",  # aqua
    "jupiter:Raydium CLMM": "#eda100",  # amber
    "jupiter:Meteora DLMM": "#008300",  # green
    "jupiter:HumidiFi": "#e34948",  # red
}
MARKERS = {
    "phoenix": "o",
    "kraken": "s",
    "coinbase": "^",
    "jupiter:best": "D",
    "jupiter:SolFi": "v",
    "jupiter:Phoenix": "P",
    "jupiter:Whirlpool": "X",
    "jupiter:Raydium CLMM": "<",
    "jupiter:Meteora DLMM": ">",
    "jupiter:HumidiFi": "*",
}
LABELS = {
    "phoenix": "Phoenix",
    "kraken": "Kraken",
    "coinbase": "Coinbase",
    "jupiter:best": "Jupiter best route",
    "jupiter:SolFi": "SolFi via Jupiter",
    "jupiter:Phoenix": "Phoenix via Jupiter",
    "jupiter:Whirlpool": "Orca Whirlpool",
    "jupiter:Raydium CLMM": "Raydium CLMM",
    "jupiter:Meteora DLMM": "Meteora DLMM",
    "jupiter:HumidiFi": "HumidiFi via Jupiter",
}
FALLBACK_COLOR = "#6b7280"  # grey, for anything not listed above
REF_COLOR = "#111827"  # the zero / reference line
NOTE_COLOR = "#4b5563"  # footnotes: secondary ink, never a series colour


def color(series: str) -> str:
    return VENUE_COLORS.get(series) or ROUTE_COLORS.get(series) or FALLBACK_COLOR


def label(series: str) -> str:
    return LABELS.get(series, series.removeprefix("jupiter:"))


def style(series: str) -> dict:
    """Line style for one series: colour, marker, and dashed if it's a Jupiter route."""
    return {
        "color": color(series),
        "marker": MARKERS.get(series, "o"),
        "linestyle": "--" if series.startswith("jupiter:") else "-",
        "linewidth": 1.8,
        "markersize": 6,
    }


def short_usd(usd: float) -> str:
    """``1000 -> "$1K"``, ``1_000_000 -> "$1M"``."""
    for div, suffix in ((1e9, "B"), (1e6, "M"), (1e3, "K")):
        if abs(usd) >= div:
            return f"${float(f'{usd / div:.3g}'):g}{suffix}"
    return f"${usd:,.0f}"


# ---- matplotlib setup -----------------------------------------------------------------


def _plt():
    """Import pyplot headless (we only ever write files) with readable defaults."""
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    plt.rcParams.update(
        {
            "font.size": 10,
            "axes.titlesize": 11,
            "axes.labelsize": 10,
            "legend.fontsize": 8.5,
            "axes.spines.top": False,
            "axes.spines.right": False,
            "axes.grid": True,
            "grid.alpha": 0.3,
            # Otherwise "$1K to $10K" in a label is read as LaTeX maths between the $ signs.
            "text.parse_math": False,
        }
    )
    return plt


def _figure(nrows: int = 1, ncols: int = 1, size=(9, 4.6), **kw):
    return _plt().subplots(nrows, ncols, figsize=size, **kw)


def _save(fig, out: Path) -> Path:
    import matplotlib.pyplot as plt

    out = Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    # 9-10 in at 150 dpi = ~1400 px: still sharp when GitHub scales it to README width.
    fig.savefig(out, dpi=150, bbox_inches="tight", facecolor="white")
    plt.close(fig)
    return out


def _dt(ts: float) -> datetime:
    return datetime.fromtimestamp(ts, UTC)


def _time_axis(ax, timestamps: Sequence[float], pad_s: float = 300.0) -> None:
    """UTC time labels that stay readable from 1 tick to several days."""
    import matplotlib.dates as mdates

    locator = mdates.AutoDateLocator(tz=UTC, minticks=3, maxticks=8)
    ax.xaxis.set_major_locator(locator)
    ax.xaxis.set_major_formatter(mdates.ConciseDateFormatter(locator, tz=UTC))
    if timestamps:
        lo, hi = min(timestamps), max(timestamps)
        # One tick on its own would get a meaningless multi-day axis: pad it instead.
        ax.set_xlim(_dt(lo - pad_s), _dt(hi + pad_s))
    ax.set_xlabel("Time (UTC)")


def _symlog_bps(ax, values: Sequence[float]) -> None:
    """Symlog y axis fitted to ``values``, always showing 0 (the reference mid)."""
    from matplotlib.ticker import FuncFormatter

    ax.set_yscale("symlog", linthresh=1.0, linscale=0.5)
    ax.yaxis.set_major_formatter(
        FuncFormatter(lambda v, _: f"{v:,.0f}" if abs(v) >= 1 else f"{v:g}")
    )
    if values:
        lo, hi = min(values), max(values)
        # Pad by a factor on the log part, by a little on the linear part around 0.
        bottom = lo * 2 if lo < -1 else min(lo, 0) - 0.5
        top = hi * 2 if hi > 1 else 1.5
        ax.set_ylim(bottom, top)


def _plain_log(ax, money: bool = False) -> None:
    """Log y axis with plain labels ("$5M", "100") instead of 5x10^6."""
    from matplotlib.ticker import FuncFormatter

    ax.set_yscale("log")

    def fmt(v: float) -> str:
        return short_usd(v) if money else f"{v:g}"

    def minor(v: float, _pos) -> str:
        # Label minor ticks only when the axis spans less than ~1.5 decades
        # (otherwise matplotlib's 2..9 minor ticks would crowd the axis).
        lo, hi = ax.get_ylim()
        return fmt(v) if lo > 0 and math.log10(hi / lo) < 1.5 else ""

    ax.yaxis.set_major_formatter(FuncFormatter(lambda v, _: fmt(v)))
    ax.yaxis.set_minor_formatter(FuncFormatter(minor))


def _size_axis(ax, sizes: Sequence[float]) -> None:
    from matplotlib.ticker import FixedLocator, FuncFormatter, NullLocator

    ax.set_xscale("log")
    ax.xaxis.set_major_locator(FixedLocator(list(sizes)))
    ax.xaxis.set_minor_locator(NullLocator())
    ax.xaxis.set_major_formatter(FuncFormatter(lambda v, _: short_usd(v)))
    ax.set_xlim(min(sizes) / 1.6, max(sizes) * 1.6)
    ax.set_xlabel("Trade size (USD)")


LEGEND_ROW_IN = 0.26  # height of one legend row (8.5 pt text + marker), in inches
FOOTER_LINE_IN = 0.17  # height of one 8 pt footnote line


def _finish(fig, axes, ncol: int = 4, footer: str = "") -> None:
    """Lay out the plots, then one shared legend under them, then the footnote.

    The space for the legend and footnote is reserved first (rows x a fixed
    height, in inches), and the plots are fitted into what's left, so the
    three can never overlap, whatever the number of series or note lines.
    """
    handles: dict = {}
    for ax in axes:
        for h, lab in zip(*ax.get_legend_handles_labels(), strict=True):
            handles.setdefault(lab, h)  # each label once, even if it's on both panels
    rows = math.ceil(len(handles) / ncol) if handles else 0
    lines = footer.count("\n") + 1 if footer else 0
    legend_h = (rows * LEGEND_ROW_IN + 0.1) / fig.get_figheight() if rows else 0.0
    footer_h = (lines * FOOTER_LINE_IN + 0.08) / fig.get_figheight() if lines else 0.0
    fig.tight_layout(rect=(0, legend_h + footer_h, 1, 1))
    if handles:
        fig.legend(
            list(handles.values()),
            list(handles),
            loc="upper center",
            bbox_to_anchor=(0.5, legend_h + footer_h),
            ncol=min(ncol, len(handles)),
            frameon=False,
        )
    if footer:
        fig.text(0.5, 0.005, footer, ha="center", va="bottom", fontsize=8, color=NOTE_COLOR)


# ---- charts ----------------------------------------------------------------------------


def _time_line(ax, pts: Sequence[tuple[float, float]], series: str, interval_s: float) -> None:
    """Plot ``(ts, value)`` points as one line. A hole of more than 1.5 ticks (the venue
    failed, or the collector was down) breaks the line instead of bridging it with a
    straight segment that would pretend we saw what happened in between."""
    xs, ys = [], []
    prev = None
    for t, v in pts:
        if prev is not None and t - prev > 1.5 * interval_s:
            xs.append(_dt((t + prev) / 2))
            ys.append(math.nan)  # matplotlib leaves a gap at NaN
        xs.append(_dt(t))
        ys.append(v)
        prev = t
    ax.plot(xs, ys, label=label(series), **{**style(series), "markersize": 3})


def spread_over_time(
    obs: list[Obs], venues: Sequence[str], out: Path, interval_s: float = 300
) -> Path | None:
    """Quoted spread per order book venue, every tick (log scale: 1 bps and 1,000 bps)."""
    lines = {v: pts for v in venues if (pts := over_time(obs, v, "spread_bps"))}
    if not lines:
        return None
    fig, ax = _figure(size=(9, 4.6))
    for venue, pts in lines.items():
        _time_line(ax, pts, venue, interval_s)
    _plain_log(ax)
    _time_axis(ax, [t for pts in lines.values() for t, _ in pts])
    ax.set_ylabel("Best ask - best bid (bps of mid, log)")
    ax.set_title("Quoted spread over time")
    _finish(fig, [ax])
    return _save(fig, out)


def depth_over_time(
    obs: list[Obs], venues: Sequence[str], out: Path, band: float = 0.02, interval_s: float = 300
) -> Path | None:
    """USD resting within ``band`` of each venue's own mid, bid and ask side panels."""
    fig, axes = _figure(1, 2, size=(10, 4.6), sharey=True)
    drawn, all_ts, empty = False, [], []
    for ax, side in zip(axes, ("bid", "ask"), strict=True):
        for venue in venues:
            pts = over_time(obs, venue, "depth_usd", side, band)
            positive = [(t, v) for t, v in pts if v > 0]  # zero can't sit on a log axis
            if len(positive) < len(pts):
                empty.append(
                    f"{label(venue)} {side}s in {len(pts) - len(positive)}/{len(pts)} ticks"
                )
            if not positive:
                continue
            all_ts += [t for t, _ in positive]
            _time_line(ax, positive, venue, interval_s)
            drawn = True
        ax.set_title("Bids (orders to buy SOL)" if side == "bid" else "Asks (orders to sell SOL)")
    if not drawn:
        import matplotlib.pyplot as plt

        plt.close(fig)
        return None
    for ax in axes:
        _plain_log(ax, money=True)
        _time_axis(ax, all_ts)
    axes[0].set_ylabel(f"USD within {band:.0%} of mid (log)")
    fig.suptitle(f"Depth within {band:.0%} of each venue's own mid")
    note = "Nothing inside the band (not drawn): " + "; ".join(empty) + "." if empty else ""
    _finish(fig, axes, footer=note)
    return _save(fig, out)


def cost_vs_size(
    summaries: dict[Key, Summary],
    series: Sequence[str],
    sizes: Sequence[float],
    out: Path,
    title: str,
    metric: str = "cost_bps",
    ylabel: str = "Cost vs reference mid (bps, symlog)",
) -> Path | None:
    """Median cost per size (line) with the p10-p90 range across ticks (shaded band).

    Buy and sell in two panels. ``summaries`` comes from ``summarize_by_key``.
    """
    fig, axes = _figure(1, 2, size=(10, 4.8), sharey=True)
    drawn, missing, values = False, [], []
    for ax, side in zip(axes, ("buy", "sell"), strict=True):
        for s in series:
            pts, hollow = [], []
            for usd in sizes:
                summ = summaries.get((s, metric, side, float(usd)))
                fill = summaries.get((s, "filled", side, float(usd)))
                if summ is None:
                    if fill is not None and fill.mean == 0:
                        missing.append((s, side, usd))
                    continue
                pts.append((usd, summ))
                if fill is not None and fill.mean < 1:
                    hollow.append((usd, summ.median))
            if not pts:
                continue
            xs = [u for u, _ in pts]
            st = style(s)
            ax.plot(xs, [p.median for _, p in pts], label=label(s), **st)
            values += [v for _, p in pts for v in (p.p10, p.p90)]
            if len(pts) > 1 and any(p.n > 1 for _, p in pts):
                lows, highs = [p.p10 for _, p in pts], [p.p90 for _, p in pts]
                ax.fill_between(xs, lows, highs, color=st["color"], alpha=0.12, linewidth=0)
            for usd, med in hollow:  # filled in only some ticks
                ax.plot(
                    usd,
                    med,
                    marker=st["marker"],
                    markersize=10,
                    markerfacecolor="white",
                    markeredgecolor=st["color"],
                    linestyle="none",
                )
            drawn = True
        ax.axhline(0, color=REF_COLOR, linewidth=0.8)
        ax.set_title(f"Market {side} of SOL")
        _size_axis(ax, sizes)
    if not drawn:
        import matplotlib.pyplot as plt

        plt.close(fig)
        return None
    _symlog_bps(axes[0], values)  # sharey: one call sets both panels
    axes[0].set_ylabel(ylabel)
    fig.suptitle(title)
    footer = (
        "Line: median over ticks. Band: 10th-90th percentile. 0 = the reference mid (mean of "
        "the Kraken and Coinbase mids).\nHollow marker: filled in only some ticks."
    )
    note = _missing_note(missing)
    _finish(fig, axes, ncol=3, footer=footer + ("\n" + note if note else ""))
    return _save(fig, out)


def _missing_note(missing: list[tuple[str, str, float]]) -> str:
    """'Never filled: SolFi via Jupiter buy from $100K; ...' (smallest missing size each)."""
    first: dict[tuple[str, str], float] = {}
    for s, side, usd in missing:
        first[(s, side)] = min(usd, first.get((s, side), usd))
    if not first:
        return ""
    parts = [f"{label(s)} {side} from {short_usd(u)}" for (s, side), u in first.items()]
    return "Never filled (no route, or the book ran out within 10% of mid): " + "; ".join(parts)


def round_trip_vs_size(
    summaries: dict[Key, Summary], series: Sequence[str], sizes: Sequence[float], out: Path
) -> Path | None:
    """Half round-trip cost per size for every venue and route: the one shared yardstick."""
    fig, ax = _figure(size=(9, 5.2))
    drawn, values = False, []
    for s in series:
        pts = [
            (usd, summ)
            for usd in sizes
            if (summ := summaries.get((s, "round_trip_bps", None, float(usd)))) is not None
        ]
        if not pts:
            continue
        xs = [u for u, _ in pts]
        st = style(s)
        ax.plot(xs, [p.median for _, p in pts], label=label(s), **st)
        values += [v for _, p in pts for v in (p.p10, p.p90)]
        if len(pts) > 1 and any(p.n > 1 for _, p in pts):
            lows, highs = [p.p10 for _, p in pts], [p.p90 for _, p in pts]
            ax.fill_between(xs, lows, highs, color=st["color"], alpha=0.10, linewidth=0)
        drawn = True
    if not drawn:
        import matplotlib.pyplot as plt

        plt.close(fig)
        return None
    ax.axhline(0, color=REF_COLOR, linewidth=0.8)
    _size_axis(ax, sizes)
    _symlog_bps(ax, values)
    ax.set_ylabel("Half round-trip cost (bps of reference mid, symlog)")
    ax.set_title("Buy then sell the same size: half the gap between the two prices")
    _finish(
        fig,
        [ax],
        ncol=3,
        footer="(buy avg - sell avg) / 2 / reference mid. Line: median over ticks; band: "
        "10th-90th percentile.\nSizes that never filled both ways in a tick are not drawn.",
    )
    return _save(fig, out)


def hour_of_day(
    hourly: dict[Key, dict[int, Summary]],
    venues: Sequence[str],
    round_trip_series: Sequence[str],
    out: Path,
    usd: float = 10_000,
) -> Path | None:
    """Median spread (left) and median half round trip at ``usd`` (right) per UTC hour."""
    fig, axes = _figure(1, 2, size=(10, 4.6))
    panels = (
        (axes[0], venues, lambda s: (s, "spread_bps", None, None), "Median quoted spread"),
        (
            axes[1],
            round_trip_series,
            lambda s: (s, "round_trip_bps", None, float(usd)),
            f"Median half round trip, {short_usd(usd)}",
        ),
    )
    drawn, rt_values = False, []
    for ax, series, key_of, title in panels:
        for s in series:
            hours = hourly.get(key_of(s), {})
            if not hours:
                continue
            medians = [h.median for h in hours.values()]
            ax.plot(list(hours), medians, label=label(s), **style(s))
            if ax is axes[1]:
                rt_values += medians
            drawn = True
        ax.set_title(title)
        ax.set_xlabel("Hour of day (UTC)")
        ax.set_xlim(-0.5, 23.5)
        ax.set_xticks(range(0, 24, 3))
    if not drawn:
        import matplotlib.pyplot as plt

        plt.close(fig)
        return None
    _plain_log(axes[0])
    axes[0].set_ylabel("Spread (bps of mid, log)")
    _symlog_bps(axes[1], rt_values)
    axes[1].set_ylabel("Cost (bps of reference mid, symlog)")
    fig.suptitle("Does liquidity depend on the time of day?")
    _finish(fig, axes, ncol=4)
    return _save(fig, out)


def phoenix_activity(
    activity: Sequence[Activity], out: Path, interval_s: float = 300
) -> Path | None:
    """Top: Phoenix's best bid and ask against the reference mid. Bottom: events per tick.

    Two panels sharing the time axis, rather than one chart with two y scales:
    prices and event counts have nothing in common but the clock.
    """
    if not activity:
        return None
    from matplotlib.ticker import MaxNLocator

    fig, (top, bottom) = _figure(
        2, 1, size=(9, 6.2), sharex=True, gridspec_kw={"height_ratios": [3, 2]}
    )
    ts = [_dt(a.tick_ts) for a in activity]
    phoenix = VENUE_COLORS["phoenix"]
    top.plot(
        ts,
        [a.best_ask for a in activity],
        label="Phoenix best ask",
        color=phoenix,
        marker="^",
        markersize=4,
        linewidth=1.6,
    )
    top.plot(
        ts,
        [a.best_bid for a in activity],
        label="Phoenix best bid",
        color=phoenix,
        marker="v",
        markersize=4,
        linewidth=1.6,
        linestyle=":",
    )
    refs = [(t, a.ref_mid) for t, a in zip(ts, activity, strict=True) if a.ref_mid]
    if refs:
        top.plot(
            *zip(*refs, strict=True),
            label="Reference mid (Kraken/Coinbase)",
            color=REF_COLOR,
            linewidth=1.2,
            linestyle="--",
        )
    top.set_ylabel("Price (USD per SOL)")
    top.set_title("Phoenix SOL/USDC: top of book vs the exchanges, and how busy the market is")
    top.legend(loc="best", frameon=False)

    with_events = [(t, a.events) for t, a in zip(ts, activity, strict=True) if a.events is not None]
    if with_events:
        width = interval_s / 86_400 * 0.8  # bar width in days (matplotlib's date unit)
        heights = [e for _, e in with_events]
        bottom.bar([t for t, _ in with_events], heights, width=width, color=phoenix, alpha=0.75)
        bottom.set_ylim(0, max(1, max(heights)) * 1.15)  # all-zero bars still get a sane axis
        if not any(heights):
            bottom.text(
                0.5,
                0.5,
                "no events: the sequence number did not move",
                transform=bottom.transAxes,
                ha="center",
                color=NOTE_COLOR,
            )
    else:
        bottom.text(
            0.5,
            0.5,
            "needs at least two ticks",
            transform=bottom.transAxes,
            ha="center",
            va="center",
            color=NOTE_COLOR,
        )
    bottom.yaxis.set_major_locator(MaxNLocator(integer=True))
    bottom.set_ylabel("Events since\nprevious tick")
    _time_axis(bottom, [a.tick_ts for a in activity], pad_s=interval_s)
    _finish(
        fig,
        [],  # the legend sits inside the price panel
        footer="Events = change in the market account's market_sequence_number between "
        "snapshots (one per instruction that changed the market).",
    )
    return _save(fig, out)
