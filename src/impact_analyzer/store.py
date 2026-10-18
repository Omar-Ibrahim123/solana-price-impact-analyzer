"""SQLite storage for collector runs. This is the only module that writes SQL.

Why SQLite (not Parquet or a folder of JSON files):

- it ships with Python, so there is nothing to install;
- every tick is one transaction: if the process dies mid-tick the database
  still holds every *completed* tick, and nothing half-written;
- a UNIQUE key on (run, tick) makes restarts safe: a resumed collector skips
  ticks that are already stored instead of duplicating them;
- the report is just SQL queries, and the file opens in any SQLite viewer.

Layout: one ``runs`` row per collector invocation, one ``ticks`` row per
5-minute tick, and under each tick one ``snapshots`` row per venue (ok or
failed) and one ``quotes`` row per Jupiter quote. Books are stored as
zlib-compressed JSON (``BookSnapshot.to_dict``); raw Phoenix account bytes are
kept too, so a decoder bug found later can be fixed and the data re-decoded.
"""

from __future__ import annotations

import json
import sqlite3
import zlib
from collections.abc import Iterator
from dataclasses import dataclass, field
from pathlib import Path

from .snapshot import BookSnapshot

SCHEMA_VERSION = 1

SCHEMA = """
CREATE TABLE IF NOT EXISTS runs (
    run_id      INTEGER PRIMARY KEY,
    started_at  REAL NOT NULL,       -- unix seconds
    ends_at     REAL NOT NULL,       -- planned end; --resume continues until then
    interval_s  REAL NOT NULL,
    args_json   TEXT NOT NULL,       -- the configuration, for reproducibility
    git_sha     TEXT,                -- code version that collected the data
    host        TEXT
);
CREATE TABLE IF NOT EXISTS ticks (
    tick_id         INTEGER PRIMARY KEY,
    run_id          INTEGER NOT NULL REFERENCES runs(run_id),
    tick_ts         REAL NOT NULL,   -- the wall-clock slot this tick belongs to (aligned)
    started_at      REAL NOT NULL,
    finished_at     REAL NOT NULL,
    slot            INTEGER,         -- Solana slot at the start of the tick
    slot_latency_ms REAL,
    ref_mid         REAL,            -- mean of the exchanges' mids: the common yardstick
    UNIQUE (run_id, tick_ts)
);
CREATE TABLE IF NOT EXISTS snapshots (
    id           INTEGER PRIMARY KEY,
    tick_id      INTEGER NOT NULL REFERENCES ticks(tick_id),
    venue        TEXT NOT NULL,
    requested_at REAL NOT NULL,
    received_at  REAL NOT NULL,
    latency_ms   REAL,               -- of the successful HTTP attempt
    attempts     INTEGER NOT NULL,
    ok           INTEGER NOT NULL,   -- 1 = we have a book, 0 = see error
    error        TEXT,
    slot         INTEGER,
    mid          REAL,
    spread_bps   REAL,
    n_bids       INTEGER,            -- before trimming
    n_asks       INTEGER,
    book         BLOB,               -- zlib(JSON BookSnapshot)
    raw          BLOB,               -- zlib(raw account bytes), Phoenix only
    UNIQUE (tick_id, venue)
);
CREATE TABLE IF NOT EXISTS quotes (
    id                   INTEGER PRIMARY KEY,
    tick_id              INTEGER NOT NULL REFERENCES ticks(tick_id),
    source               TEXT NOT NULL,   -- "jupiter"
    dex                  TEXT NOT NULL,   -- route filter, e.g. "best", "SolFi"
    side                 TEXT NOT NULL,   -- "buy" / "sell" (SOL)
    usd_size             REAL NOT NULL,
    requested_at         REAL NOT NULL,
    latency_ms           REAL,
    ok                   INTEGER NOT NULL,
    error                TEXT,
    context_slot         INTEGER,
    in_amount            INTEGER,         -- atoms sent (USDC atoms or lamports)
    out_amount           INTEGER,         -- atoms received
    avg_price            REAL,            -- USDC per SOL
    jup_price_impact_pct REAL,
    route_json           TEXT
);
CREATE TABLE IF NOT EXISTS metrics (
    snapshot_id INTEGER NOT NULL REFERENCES snapshots(id),
    version     INTEGER NOT NULL,         -- bump when metrics.py changes meaning
    json        TEXT NOT NULL,
    PRIMARY KEY (snapshot_id, version)
);
CREATE INDEX IF NOT EXISTS snapshots_venue ON snapshots (venue, tick_id);
CREATE INDEX IF NOT EXISTS quotes_tick ON quotes (tick_id);
"""


def pack(data: bytes) -> bytes:
    return zlib.compress(data, 6)


def unpack(blob: bytes) -> bytes:
    return zlib.decompress(blob)


@dataclass(slots=True)
class SnapshotRecord:
    """One venue's result for one tick, as the collector hands it to the store."""

    venue: str
    requested_at: float
    received_at: float
    attempts: int
    ok: bool
    latency_ms: float | None = None
    error: str | None = None
    slot: int | None = None
    snapshot: BookSnapshot | None = None  # what we store (maybe trimmed)
    n_bids: int | None = None  # counts before trimming
    n_asks: int | None = None
    raw: bytes | None = None


@dataclass(slots=True)
class QuoteRecord:
    dex: str
    side: str
    usd_size: float
    requested_at: float
    ok: bool
    latency_ms: float | None = None
    error: str | None = None
    context_slot: int | None = None
    in_amount: int | None = None
    out_amount: int | None = None
    avg_price: float | None = None
    jup_price_impact_pct: float | None = None
    route: list[dict] = field(default_factory=list)
    source: str = "jupiter"


@dataclass(slots=True)
class TickRecord:
    tick_ts: float
    started_at: float
    finished_at: float
    slot: int | None
    slot_latency_ms: float | None
    ref_mid: float | None
    snapshots: list[SnapshotRecord]
    quotes: list[QuoteRecord]


@dataclass(frozen=True, slots=True)
class Run:
    run_id: int
    started_at: float
    ends_at: float
    interval_s: float
    args: dict


@dataclass(frozen=True, slots=True)
class StoredSnapshot:
    """A row read back from ``snapshots``. Decoding the book is deferred (it's the slow part)."""

    id: int
    tick_id: int
    tick_ts: float
    venue: str
    ok: bool
    latency_ms: float | None
    slot: int | None
    mid: float | None
    spread_bps: float | None
    error: str | None
    _book: bytes | None
    _raw: bytes | None

    def book(self) -> BookSnapshot:
        if self._book is None:
            raise ValueError(f"snapshot {self.id} ({self.venue}) has no book: {self.error}")
        return BookSnapshot.from_dict(json.loads(unpack(self._book)))

    def raw(self) -> bytes | None:
        return unpack(self._raw) if self._raw is not None else None


class Store:
    def __init__(self, path: Path | str) -> None:
        self.path = Path(path)
        if str(path) != ":memory:":
            self.path.parent.mkdir(parents=True, exist_ok=True)
        # check_same_thread=False: the collector writes only from its main thread,
        # but tests and the report may hand the store around.
        self.db = sqlite3.connect(str(path), check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        # WAL: readers (e.g. `status` in another terminal) never block the writer.
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA foreign_keys=ON")
        self._migrate()

    def close(self) -> None:
        self.db.close()

    def __enter__(self) -> Store:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def _migrate(self) -> None:
        version = self.db.execute("PRAGMA user_version").fetchone()[0]
        if version > SCHEMA_VERSION:
            raise RuntimeError(
                f"{self.path} was written by a newer version (schema {version}); upgrade the code"
            )
        with self.db:
            self.db.executescript(SCHEMA)
            self.db.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")

    # ---- runs -------------------------------------------------------------------

    def create_run(
        self,
        started_at: float,
        ends_at: float,
        interval_s: float,
        args: dict,
        git_sha: str | None = None,
        host: str | None = None,
    ) -> Run:
        with self.db:
            cur = self.db.execute(
                "INSERT INTO runs (started_at, ends_at, interval_s, args_json, git_sha, host)"
                " VALUES (?, ?, ?, ?, ?, ?)",
                (started_at, ends_at, interval_s, json.dumps(args), git_sha, host),
            )
        return Run(cur.lastrowid, started_at, ends_at, interval_s, args)

    def _run(self, row: sqlite3.Row) -> Run:
        return Run(
            row["run_id"],
            row["started_at"],
            row["ends_at"],
            row["interval_s"],
            json.loads(row["args_json"]),
        )

    def latest_run(self) -> Run | None:
        row = self.db.execute("SELECT * FROM runs ORDER BY run_id DESC LIMIT 1").fetchone()
        return self._run(row) if row else None

    def runs(self) -> list[Run]:
        return [self._run(r) for r in self.db.execute("SELECT * FROM runs ORDER BY run_id")]

    # ---- ticks ------------------------------------------------------------------

    def tick_exists(self, run_id: int, tick_ts: float) -> bool:
        row = self.db.execute(
            "SELECT 1 FROM ticks WHERE run_id = ? AND tick_ts = ?", (run_id, tick_ts)
        ).fetchone()
        return row is not None

    def insert_tick(self, run_id: int, tick: TickRecord) -> int:
        """Write a whole tick (all venues, all quotes) atomically. Returns its tick_id."""
        with self.db:  # one transaction: all of it lands, or none of it
            cur = self.db.execute(
                "INSERT INTO ticks (run_id, tick_ts, started_at, finished_at, slot,"
                " slot_latency_ms, ref_mid) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (
                    run_id,
                    tick.tick_ts,
                    tick.started_at,
                    tick.finished_at,
                    tick.slot,
                    tick.slot_latency_ms,
                    tick.ref_mid,
                ),
            )
            tick_id = cur.lastrowid
            for s in tick.snapshots:
                snap = s.snapshot
                self.db.execute(
                    "INSERT INTO snapshots (tick_id, venue, requested_at, received_at,"
                    " latency_ms, attempts, ok, error, slot, mid, spread_bps, n_bids, n_asks,"
                    " book, raw) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        tick_id,
                        s.venue,
                        s.requested_at,
                        s.received_at,
                        s.latency_ms,
                        s.attempts,
                        int(s.ok),
                        s.error,
                        s.slot,
                        snap.mid_price() if snap else None,
                        snap.spread_bps() if snap else None,
                        s.n_bids,
                        s.n_asks,
                        pack(json.dumps(snap.to_dict()).encode()) if snap else None,
                        pack(s.raw) if s.raw is not None else None,
                    ),
                )
            for q in tick.quotes:
                self.db.execute(
                    "INSERT INTO quotes (tick_id, source, dex, side, usd_size, requested_at,"
                    " latency_ms, ok, error, context_slot, in_amount, out_amount, avg_price,"
                    " jup_price_impact_pct, route_json)"
                    " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        tick_id,
                        q.source,
                        q.dex,
                        q.side,
                        q.usd_size,
                        q.requested_at,
                        q.latency_ms,
                        int(q.ok),
                        q.error,
                        q.context_slot,
                        q.in_amount,
                        q.out_amount,
                        q.avg_price,
                        q.jup_price_impact_pct,
                        json.dumps(q.route) if q.route else None,
                    ),
                )
        return tick_id

    def ticks(self, run_id: int | None = None) -> list[sqlite3.Row]:
        sql = "SELECT * FROM ticks"
        args: tuple = ()
        if run_id is not None:
            sql += " WHERE run_id = ?"
            args = (run_id,)
        return list(self.db.execute(sql + " ORDER BY tick_ts", args))

    # ---- reading snapshots and quotes ---------------------------------------------

    def snapshots(
        self, venue: str | None = None, run_id: int | None = None, ok_only: bool = True
    ) -> Iterator[StoredSnapshot]:
        """Stored snapshots in time order. Books are decoded only when you call ``.book()``."""
        where, args = [], []
        if venue is not None:
            where.append("s.venue = ?")
            args.append(venue)
        if run_id is not None:
            where.append("t.run_id = ?")
            args.append(run_id)
        if ok_only:
            where.append("s.ok = 1")
        sql = (
            "SELECT s.*, t.tick_ts FROM snapshots s JOIN ticks t USING (tick_id)"
            + (" WHERE " + " AND ".join(where) if where else "")
            + " ORDER BY t.tick_ts, s.venue"
        )
        for r in self.db.execute(sql, args):
            yield StoredSnapshot(
                id=r["id"],
                tick_id=r["tick_id"],
                tick_ts=r["tick_ts"],
                venue=r["venue"],
                ok=bool(r["ok"]),
                latency_ms=r["latency_ms"],
                slot=r["slot"],
                mid=r["mid"],
                spread_bps=r["spread_bps"],
                error=r["error"],
                _book=r["book"],
                _raw=r["raw"],
            )

    def quotes(self, run_id: int | None = None, ok_only: bool = True) -> list[sqlite3.Row]:
        where, args = [], []
        if run_id is not None:
            where.append("t.run_id = ?")
            args.append(run_id)
        if ok_only:
            where.append("q.ok = 1")
        sql = (
            "SELECT q.*, t.tick_ts, t.ref_mid FROM quotes q JOIN ticks t USING (tick_id)"
            + (" WHERE " + " AND ".join(where) if where else "")
            + " ORDER BY t.tick_ts, q.id"
        )
        return list(self.db.execute(sql, args))

    # ---- metrics cache ---------------------------------------------------------------

    def cached_metrics(self, snapshot_id: int, version: int) -> dict | None:
        row = self.db.execute(
            "SELECT json FROM metrics WHERE snapshot_id = ? AND version = ?",
            (snapshot_id, version),
        ).fetchone()
        return json.loads(row["json"]) if row else None

    def cache_metrics(self, snapshot_id: int, version: int, data: dict) -> None:
        with self.db:
            self.db.execute(
                "INSERT OR REPLACE INTO metrics (snapshot_id, version, json) VALUES (?, ?, ?)",
                (snapshot_id, version, json.dumps(data)),
            )

    # ---- status -----------------------------------------------------------------------

    def venue_health(self, run_id: int) -> list[sqlite3.Row]:
        """Per venue: ticks attempted, ok count, median-ish latency, last error."""
        return list(
            self.db.execute(
                """
                SELECT s.venue,
                       COUNT(*)                        AS n,
                       SUM(s.ok)                       AS n_ok,
                       AVG(CASE WHEN s.ok THEN s.latency_ms END) AS avg_latency_ms,
                       MAX(CASE WHEN s.ok THEN s.latency_ms END) AS max_latency_ms,
                       SUM(s.attempts - 1)             AS retries,
                       (SELECT error FROM snapshots s2 JOIN ticks t2 USING (tick_id)
                         WHERE t2.run_id = ? AND s2.venue = s.venue AND s2.ok = 0
                         ORDER BY t2.tick_ts DESC LIMIT 1) AS last_error
                FROM snapshots s JOIN ticks t USING (tick_id)
                WHERE t.run_id = ?
                GROUP BY s.venue ORDER BY s.venue
                """,
                (run_id, run_id),
            )
        )

    def quote_health(self, run_id: int) -> list[sqlite3.Row]:
        return list(
            self.db.execute(
                """
                SELECT q.dex, COUNT(*) AS n, SUM(q.ok) AS n_ok, AVG(q.latency_ms) AS avg_latency_ms,
                       (SELECT error FROM quotes q2 JOIN ticks t2 USING (tick_id)
                         WHERE t2.run_id = ? AND q2.dex = q.dex AND q2.ok = 0
                         ORDER BY q2.id DESC LIMIT 1) AS last_error
                FROM quotes q JOIN ticks t USING (tick_id)
                WHERE t.run_id = ?
                GROUP BY q.dex ORDER BY q.dex
                """,
                (run_id, run_id),
            )
        )
