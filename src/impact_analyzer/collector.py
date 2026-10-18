"""The ``collect`` command: snapshot every venue on a fixed schedule, for hours.

One *tick* every ``interval`` (default 5 minutes):

1. fetch every order book venue **at the same moment** (one thread each), plus
   the current Solana slot; a venue that fails is recorded as failed and the
   others carry on;
2. compute the reference mid (mean of the exchanges' mids);
3. ask Jupiter for real AMM quotes on a grid of DEX x size x side, paced to
   stay under its rate limit;
4. write the whole tick to SQLite in one transaction.

Ticks are aligned to the wall clock (12:00, 12:05, ...), so every venue's rows
line up and "by hour of day" summaries are clean. If a tick overruns, the
missed slots are skipped, not crammed in late.

Restarts: ``--resume`` reopens the newest run and continues until its planned
end; ticks already in the database are skipped. Ctrl+C asks the collector to
stop after the current tick (pressing it twice quits immediately).
"""

from __future__ import annotations

import contextlib
import json
import logging
import math
import re
import signal
import socket
import statistics
import subprocess
import sys
import time
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, dataclass, field
from pathlib import Path

from . import jupiter
from .jupiter import DEFAULT_DEXES, DEFAULT_RPS, DEFAULT_SIZES_USD
from .net import FetchError, Http, HttpStatusError
from .store import QuoteRecord, Run, SnapshotRecord, Store, TickRecord
from .venues import FETCHERS, REFERENCE_VENUES, VENUES, Fetched, fetch_slot

log = logging.getLogger("impact_analyzer.collect")

DURATION_RE = re.compile(r"(\d+(?:\.\d+)?)([smhd])")
UNIT_S = {"s": 1, "m": 60, "h": 3600, "d": 86400}


def parse_duration(text: str) -> float:
    """``"90s"``, ``"5m"``, ``"24h"``, ``"1h30m"`` -> seconds. A bare number means seconds."""
    text = text.strip().lower()
    try:
        return float(text)
    except ValueError:
        pass
    parts = DURATION_RE.findall(text)
    if not parts or "".join(n + u for n, u in parts) != text:
        raise ValueError(f"can't read duration {text!r}; use e.g. 90s, 5m, 24h, 1h30m")
    return sum(float(n) * UNIT_S[u] for n, u in parts)


@dataclass(slots=True)
class CollectConfig:
    interval_s: float = 300.0
    duration_s: float = 86_400.0
    venues: list[str] = field(default_factory=lambda: list(VENUES))
    rpc: str | None = None
    jupiter: bool = True  # (shadows the module inside this class body; hence the imports)
    jupiter_dexes: list[str] = field(default_factory=lambda: list(DEFAULT_DEXES))
    jupiter_sizes: list[float] = field(default_factory=lambda: list(DEFAULT_SIZES_USD))
    jupiter_rps: float = DEFAULT_RPS  # free tier: 5 requests per 10 s
    cex_band: float = 0.25  # store exchange books only within 25% of mid

    def as_args(self) -> dict:
        args = asdict(self)
        args["rpc"] = "custom" if self.rpc else None  # never store an RPC URL (may hold a key)
        return args


def git_sha() -> str | None:
    """The commit that is collecting, plus ``-dirty`` if the working tree has edits."""
    here = Path(__file__).resolve().parent
    try:
        sha = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            cwd=here,
            capture_output=True,
            text=True,
            timeout=5,
            check=True,
        ).stdout.strip()
        dirty = subprocess.run(
            ["git", "status", "--porcelain", "--untracked-files=no"],
            cwd=here,
            capture_output=True,
            text=True,
            timeout=5,
            check=True,
        ).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return None
    return sha + ("-dirty" if dirty else "")


class Collector:
    """Runs ticks against a ``Store``. Every dependency is injectable for tests."""

    def __init__(
        self,
        store: Store,
        config: CollectConfig,
        http: Http,
        fetchers: dict[str, Callable[[Http, str | None], Fetched]] = FETCHERS,
        slot_fn: Callable[[Http, str | None], tuple[int, float]] = fetch_slot,
        quote_fn: Callable[[Http, jupiter.QuoteRequest], tuple[jupiter.Quote, float]] = (
            jupiter.fetch_quote
        ),
        clock: Callable[[], float] = time.time,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        unknown = set(config.venues) - set(fetchers)
        if unknown:
            raise ValueError(f"unknown venues: {sorted(unknown)}")
        self.store = store
        self.config = config
        self.http = http
        self.fetchers = fetchers
        self.slot_fn = slot_fn
        self.quote_fn = quote_fn
        self.clock = clock
        self.sleep = sleep
        self.stop_requested = False
        self.last_ref_mid: float | None = None  # fallback when both exchanges fail

    def request_stop(self) -> None:
        self.stop_requested = True

    # ---- the schedule -------------------------------------------------------------

    def start_run(self) -> Run:
        now = self.clock()
        return self.store.create_run(
            started_at=now,
            ends_at=now + self.config.duration_s,
            interval_s=self.config.interval_s,
            args=self.config.as_args(),
            git_sha=git_sha(),
            host=socket.gethostname(),
        )

    def run(self, run: Run) -> int:
        """Collect ticks until ``run.ends_at`` or a stop request. Returns ticks written."""
        interval = run.interval_s
        expected = expected_ticks(run)
        written = 0
        # The current wall-clock slot: start right away instead of waiting for the next one.
        tick_ts = math.floor(self.clock() / interval) * interval
        while not self.stop_requested and tick_ts < run.ends_at:
            if self.store.tick_exists(run.run_id, tick_ts):
                log.info("tick %s already stored, skipping", _hhmm(tick_ts))
            else:
                tick = self.collect_tick(tick_ts)
                self.store.insert_tick(run.run_id, tick)
                written += 1
                done = len(self.store.ticks(run.run_id))
                log.info("%s", format_tick(tick, done, expected))
            # Next slot strictly in the future; if this tick overran, skip what we missed.
            next_ts = (math.floor(self.clock() / interval) + 1) * interval
            missed = round((next_ts - tick_ts) / interval) - 1
            if missed > 0:
                log.warning("tick overran: skipping %d slot(s)", missed)
            if next_ts >= run.ends_at:
                break
            self._sleep_until(next_ts)
            tick_ts = next_ts
        return written

    def _sleep_until(self, target: float) -> None:
        # Short naps instead of one long sleep, so a stop request is noticed quickly
        # (and so Ctrl+C works on Windows, where long waits can't be interrupted).
        while not self.stop_requested:
            remaining = target - self.clock()
            if remaining <= 0:
                return
            self.sleep(min(1.0, remaining))

    # ---- one tick -----------------------------------------------------------------

    def collect_tick(self, tick_ts: float) -> TickRecord:
        started = self.clock()
        venues = self.config.venues
        # All venues at once: a slow RPC must not make the exchanges' books
        # minutes older than Phoenix's, or the comparison is unfair.
        with ThreadPoolExecutor(max_workers=len(venues) + 1) as pool:
            slot_future = pool.submit(self.slot_fn, self.http, self.config.rpc)
            futures = [pool.submit(self._fetch_venue, v) for v in venues]
            snapshots = [f.result() for f in futures]  # _fetch_venue never raises
            try:
                slot, slot_latency = slot_future.result()
            except Exception as e:  # noqa: BLE001 - the slot is nice to have, never fatal
                log.warning("getSlot failed: %s: %s", type(e).__name__, e)
                slot, slot_latency = None, None

        ref_mid = self._reference_mid(snapshots)
        quotes = self._quote_grid(ref_mid) if self.config.jupiter and ref_mid else []
        return TickRecord(
            tick_ts=tick_ts,
            started_at=started,
            finished_at=self.clock(),
            slot=slot,
            slot_latency_ms=slot_latency,
            ref_mid=ref_mid,
            snapshots=snapshots,
            quotes=quotes,
        )

    def _fetch_venue(self, venue: str) -> SnapshotRecord:
        requested = self.clock()
        try:
            fetched = self.fetchers[venue](self.http, self.config.rpc)
        except Exception as e:  # noqa: BLE001 - one venue failing must not stop the others
            return SnapshotRecord(
                venue=venue,
                requested_at=requested,
                received_at=self.clock(),
                attempts=getattr(e, "attempts", 1),
                ok=False,
                error=f"{type(e).__name__}: {e}"[:500],
            )
        snap = fetched.snapshot
        n_bids, n_asks = len(snap.bids), len(snap.asks)
        if venue != "phoenix" and self.config.cex_band:
            # Phoenix is kept whole: its junk quotes are part of the story.
            snap = snap.trimmed(self.config.cex_band)
        return SnapshotRecord(
            venue=venue,
            requested_at=requested,
            received_at=self.clock(),
            attempts=fetched.attempts,
            ok=True,
            latency_ms=fetched.latency_ms,
            slot=fetched.slot,
            snapshot=snap,
            n_bids=n_bids,
            n_asks=n_asks,
            raw=fetched.raw,
        )

    def _reference_mid(self, snapshots: list[SnapshotRecord]) -> float | None:
        mids = [
            s.snapshot.mid_price()
            for s in snapshots
            if s.ok and s.venue in REFERENCE_VENUES and s.snapshot is not None
        ]
        mids = [m for m in mids if m]
        if mids:
            self.last_ref_mid = statistics.fmean(mids)
            return self.last_ref_mid
        return self.last_ref_mid  # both exchanges down: reuse the last known price

    def _quote_grid(self, ref_mid: float) -> list[QuoteRecord]:
        grid = jupiter.build_grid(self.config.jupiter_dexes, self.config.jupiter_sizes, ref_mid)
        gap = 1.0 / self.config.jupiter_rps if self.config.jupiter_rps > 0 else 0.0
        out: list[QuoteRecord] = []
        last = -math.inf
        for req in grid:
            if self.stop_requested:
                break  # stop quickly; the quotes we have still get stored
            wait = last + gap - self.clock()
            if wait > 0:
                self.sleep(wait)
            last = self.clock()
            out.append(self._quote(req, last))
        return out

    def _quote(self, req: jupiter.QuoteRequest, requested: float) -> QuoteRecord:
        rec = QuoteRecord(req.dex, req.side, req.usd_size, requested, ok=False)
        try:
            quote, latency = self.quote_fn(self.http, req)
        except HttpStatusError as e:
            rec.error = _jupiter_error(e)
            return rec
        except (FetchError, ValueError, KeyError) as e:
            rec.error = f"{type(e).__name__}: {e}"[:500]
            return rec
        rec.ok = True
        rec.latency_ms = latency
        rec.context_slot = quote.context_slot
        rec.in_amount = quote.in_amount
        rec.out_amount = quote.out_amount
        rec.avg_price = quote.avg_price(req.side) if quote.out_amount else None
        rec.jup_price_impact_pct = quote.price_impact_pct
        rec.route = quote.route
        return rec


def _jupiter_error(e: HttpStatusError) -> str:
    """Jupiter explains 400s in JSON (``errorCode``); keep that, it's what matters."""
    try:
        body = json.loads(e.body)
        return f"HTTP {e.status} {body.get('errorCode', '')}: {body.get('error', '')}"[:500]
    except (ValueError, AttributeError):
        return str(e)[:500]


# ---- reporting progress ----------------------------------------------------------------


def _hhmm(ts: float) -> str:
    return time.strftime("%Y-%m-%d %H:%M", time.gmtime(ts)) + "Z"


def expected_ticks(run: Run) -> int:
    """How many aligned slots a run covers: from the slot it started in, up to its end."""
    first = math.floor(run.started_at / run.interval_s) * run.interval_s
    return max(1, math.ceil((run.ends_at - first) / run.interval_s))


def format_tick(tick: TickRecord, done: int, expected: int) -> str:
    """One log line per tick: enough to spot a problem at a glance."""
    parts = []
    for s in tick.snapshots:
        if s.ok and s.snapshot is not None:
            spread = s.snapshot.spread_bps()
            parts.append(
                f"{s.venue} {s.latency_ms:.0f}ms"
                + (f" {spread:.1f}bps" if spread is not None else "")
                + (f" (x{s.attempts})" if s.attempts > 1 else "")
            )
        else:
            parts.append(f"{s.venue} FAILED")
    if tick.quotes:
        ok = sum(q.ok for q in tick.quotes)
        parts.append(f"jupiter {ok}/{len(tick.quotes)}")
    slot = f"slot {tick.slot:,}" if tick.slot else "slot ?"
    took = tick.finished_at - tick.started_at
    return (
        f"{_hhmm(tick.tick_ts)} [{done}/{expected}] {slot} | "
        + " | ".join(parts)
        + (f" | {took:.0f}s")
    )


def format_status(store: Store) -> str:
    """What ``python -m impact_analyzer status`` prints."""
    run = store.latest_run()
    if run is None:
        return f"{store.path}: no runs yet"
    ticks = store.ticks(run.run_id)
    expected = expected_ticks(run)
    now = time.time()
    lines = [
        f"database   {store.path} ({_size(store.path)})",
        f"run        #{run.run_id}: started {_hhmm(run.started_at)}, ends {_hhmm(run.ends_at)}"
        f", every {run.interval_s:g}s",
        f"progress   {len(ticks)}/{expected} ticks"
        + (f", last at {_hhmm(ticks[-1]['tick_ts'])}" if ticks else "")
        + (f", {(run.ends_at - now) / 3600:.1f} h left" if run.ends_at > now else ", finished"),
        "",
        f"{'venue':<10}{'ok':>10}{'retries':>9}{'avg ms':>9}{'max ms':>9}  last error",
    ]
    for r in store.venue_health(run.run_id):
        lines.append(
            f"{r['venue']:<10}{r['n_ok']:>5}/{r['n']:<4}{r['retries'] or 0:>9}"
            f"{r['avg_latency_ms'] or 0:>9.0f}{r['max_latency_ms'] or 0:>9.0f}  "
            f"{(r['last_error'] or '')[:70]}"
        )
    quotes = store.quote_health(run.run_id)
    if quotes:
        lines += ["", f"{'jupiter route':<14}{'ok':>10}{'avg ms':>9}  last error"]
        for r in quotes:
            lines.append(
                f"{r['dex']:<14}{r['n_ok']:>5}/{r['n']:<4}{r['avg_latency_ms'] or 0:>9.0f}  "
                f"{(r['last_error'] or '')[:70]}"
            )
    return "\n".join(lines)


def _size(path: Path) -> str:
    try:
        n = path.stat().st_size + sum(
            p.stat().st_size for p in path.parent.glob(path.name + "-*") if p.is_file()
        )
    except OSError:
        return "?"
    return f"{n / 1e6:.1f} MB"


class KeepAwake:
    """Ask Windows not to idle-sleep while the collector runs (like a video player does).

    This is a request held by this process only (``SetThreadExecutionState``); it
    changes no settings and ends when the process exits. It does not stop sleep from
    closing the lid. On other systems it does nothing.
    """

    ES_CONTINUOUS = 0x80000000
    ES_SYSTEM_REQUIRED = 0x00000001

    def __enter__(self) -> KeepAwake:
        self.active = False
        if sys.platform == "win32":
            import ctypes

            flags = self.ES_CONTINUOUS | self.ES_SYSTEM_REQUIRED
            self.active = bool(ctypes.windll.kernel32.SetThreadExecutionState(flags))
            if self.active:
                log.info("asked Windows not to sleep while collecting (closing the lid still does)")
        return self

    def __exit__(self, *exc: object) -> None:
        if self.active:
            import ctypes

            ctypes.windll.kernel32.SetThreadExecutionState(self.ES_CONTINUOUS)  # back to normal


def run_collector(
    store: Store, config: CollectConfig, resume: bool = False, keep_awake: bool = True
) -> int:
    """Entry point for the CLI: start or resume a run, with Ctrl+C handled gracefully."""
    with Http() as http, KeepAwake() if keep_awake else contextlib.nullcontext():
        collector = Collector(store, config, http)
        if resume:
            run = store.latest_run()
            if run is None:
                raise SystemExit("nothing to resume: this database has no runs")
            if run.ends_at <= time.time():
                raise SystemExit(f"run #{run.run_id} already ended at {_hhmm(run.ends_at)}")
            # Resume with the run's own settings, so the data stays consistent.
            stored = run.args
            for key in ("venues", "jupiter", "jupiter_dexes", "jupiter_sizes", "cex_band"):
                if key in stored:
                    setattr(config, key, stored[key])
            config.interval_s = run.interval_s
            log.info("resuming run #%d until %s", run.run_id, _hhmm(run.ends_at))
        else:
            run = collector.start_run()
            log.info(
                "run #%d: every %gs until %s -> %s",
                run.run_id,
                run.interval_s,
                _hhmm(run.ends_at),
                store.path,
            )

        def on_sigint(signum: int, frame: object) -> None:
            log.warning("stopping after this tick (Ctrl+C again to quit now)")
            collector.request_stop()
            signal.signal(signal.SIGINT, signal.default_int_handler)  # second Ctrl+C: quit

        previous = signal.signal(signal.SIGINT, on_sigint)
        try:
            written = collector.run(run)
        finally:
            signal.signal(signal.SIGINT, previous)
        log.info(
            "wrote %d tick(s); run #%d %s",
            written,
            run.run_id,
            "stopped early" if collector.stop_requested else "complete",
        )
        return written
