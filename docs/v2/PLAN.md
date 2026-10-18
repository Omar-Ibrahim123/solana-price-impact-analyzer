# v2 plan: liquidity research tool + "Order Books From Zero"

Written 2026-10-18. Interview ~2026-10-28. Target: everything built, pushed and published by
2026-10-22 (day 5), leaving five days to study.

## 0. What changed since the brief was written

The brief assumes a cloud container with no internet and a laptop reachable only for files. This
session actually runs **on the laptop** (`C:\Users\omari\Documents\solana-price-impact-analyzer`,
Python 3.14 venv), and from here every endpoint we need answers:

| Endpoint | Result on 2026-10-18 |
| --- | --- |
| Kraken `/0/public/Time` | 200 in 0.27 s |
| Coinbase `/products/SOL-USD/ticker` | 200 in 0.14 s |
| Solana mainnet-beta `getSlot` | slot 458,308,444 |
| Jupiter `lite-api.jup.ag/swap/v1/quote` (no key) | 200, real multi-pool routes |
| github.com / `git ls-remote origin` | OK (Git Credential Manager is configured) |

Consequences:

- **I can run the collector myself**, from a pinned copy of the code, and push to GitHub directly.
  You don't need to paste anything back. The laptop must stay plugged in, awake and online for
  the 24 h run (I'll ask Windows to keep it awake while the session runs).
- **No `gh` CLI and no Node.js.** CI status is read from GitHub's public API with `curl`. The
  course's JavaScript tests run in a browser test page that I open in the app's browser pane.
- The live data from v1 sits in `data/` (gitignored), not `data/live-2026-10-18/`. I'll copy it
  into a tracked `data/live-2026-10-18/` folder so the course and tests can use it.
- First Jupiter result worth noting: a $100K USDC→SOL quote routed 100% through **prop AMMs**
  (Kipseli 46%, BisonFi 43%, TesseraV 11%), with Jupiter estimating 0.003% impact. Jupiter
  also lists **SolFi**, Ellipsis's own prop AMM. "Real AMM routes" therefore means the
  prop AMMs that actually carry SOL/USDC flow, and SolFi is the interview hook.

## 1. Program architecture (v2)

### 1.1 Pipeline

```
                ┌──────────── collect (every 5 min, 24 h) ─────────────┐
Solana RPC ─────┤ phoenix.py   raw account bytes + slot                │
Kraken REST ────┤ cex.py       aggregated levels                       ├──▶ SQLite (store.py)
Coinbase REST ──┤ cex.py       aggregated levels                       │    raw + normalized,
Jupiter quote ──┤ jupiter.py   real routes, per size, per side, per DEX│    one row per fetch
getSlot ────────┘ collector.py timing, retries, per-venue isolation   ─┘
                                                                            │
         metrics.py  (spread, mid, depth 0.5/1/2 %, impact per size, fees) ◀─┘ per snapshot, cached
                │
         timeseries.py (medians, p10/p90, by hour of day, uptime, latency)
                │
         report.py ──▶ docs/report/REPORT.md + charts      export.py ──▶ course data (JSON v2)
```

The engine, snapshot, decoders, impact and AMM math from v1 stay as they are. v2 adds modules
around them, each with one job.

### 1.2 New and changed files

| Path | Job |
| --- | --- |
| `src/impact_analyzer/store.py` | SQLite schema, migrations, insert/query helpers. Nothing else touches SQL. |
| `src/impact_analyzer/collector.py` | The `collect` loop: aligned ticks, concurrent fetches, retries/backoff, resume, graceful stop. |
| `src/impact_analyzer/jupiter.py` | Jupiter quote client + parser (routes, labels, amounts) and the DEX filters we track. |
| `src/impact_analyzer/venues.py` | One registry of venues: fetch function, fee, colour, label. Replaces the `if venue == ...` chain in `__main__`. |
| `src/impact_analyzer/metrics.py` | Per-snapshot numbers: spread, depth in bands, impact per size (own mid and common reference mid), with fees. |
| `src/impact_analyzer/timeseries.py` | Aggregates: medians, percentiles, hour-of-day buckets, uptime and latency per venue. |
| `src/impact_analyzer/report.py` + `charts.py` | `report` command: Markdown + PNG charts into `docs/report/`. |
| `src/impact_analyzer/fees.py` | Taker fee per venue (Phoenix from the snapshot; Kraken/Coinbase from published base tiers, cited in code, overridable). |
| `src/impact_analyzer/execution.py` | IOC limit orders, and a TWAP that splits a parent order into child orders filled against **successive real snapshots**. |
| `src/impact_analyzer/replay.py` (stretch) | Derive add/cancel/fill events between two Phoenix snapshots from order sequence numbers, replay them, compare with the next snapshot. |
| `src/impact_analyzer/export.py` | Course/playground export, format v2 (below). Moved out of `__main__.py`. |
| `src/impact_analyzer/__main__.py` | Thin CLI: `fetch`, `analyze`, `run`, `demo` (unchanged), plus `collect`, `status`, `report`, `export`, `twap`, `replay`. |
| `tests/` | New tests per module; `tests/fixtures/` holds recorded API responses and a tiny SQLite DB. Hypothesis property tests for the engine. |
| `benchmarks/bench_engine.py` | Emits a Markdown table (events/s, ns per add/cancel/match) for the README. |
| `course/` | Source of the interactive course (section 3). |
| `data/live-2026-10-18/` | The v1 snapshots, now tracked. |

### 1.3 Storage: SQLite, not Parquet

- **In the standard library.** No new dependency; works on Python 3.11–3.14 and in CI.
- **Crash-safe appends.** Each tick commits in one transaction (WAL mode). Kill the process or
  lose power mid-tick, and the file still holds every completed tick. Parquet files are written
  whole, so appending every 5 minutes means many small files or rewriting one.
- **Restartable.** A unique key on `(venue, tick_ts)` means a restarted collector skips work
  that's already done and carries on.
- **Queryable.** `status` and `report` are SQL queries; you can open the file in any SQLite
  viewer during the interview.
- The workload is tiny (≈ 300 ticks/day × 4 venues). Parquet's columnar speed would matter at
  millions of rows. If the interviewer asks "at exchange scale?", the answer is: columnar files
  (Parquet) partitioned by day and venue, written by a separate compaction step.

Schema (v1 of the DB, `PRAGMA user_version = 1`):

```sql
runs(run_id PK, started_at, ends_at, interval_s, args_json, git_sha, host)
ticks(tick_id PK, run_id, tick_ts, slot, slot_latency_ms)            -- one per 5-minute tick
snapshots(id PK, tick_id, venue, requested_at, received_at, latency_ms, slot,
          ok, error, attempts, mid, spread_bps, n_bids, n_asks,
          book BLOB,          -- zlib(JSON BookSnapshot), CEX books trimmed to ±25 % of mid
          raw BLOB NULL,      -- zlib(raw Phoenix account bytes): re-decodable later
          UNIQUE(tick_id, venue))
quotes(id PK, tick_id, source, dex_filter, side, usd_size, requested_at, latency_ms,
       context_slot, in_amount, out_amount, jup_price_impact_pct, route_json, ok, error)
metrics(snapshot_id, version, json)                                   -- cache for report
```

Estimated size: ≈ 50 KB per tick after compression → ≈ 15 MB per 24 h.

### 1.4 Collector behaviour

`python -m impact_analyzer collect --every 5m --duration 24h --db data/collect.sqlite`

- **Aligned ticks.** Ticks land on wall-clock multiples of the interval (00:00, 00:05, …), so
  venues line up and hour-of-day buckets are clean.
- **Concurrent, isolated fetches.** A thread pool fetches every venue at the same moment; one
  venue timing out or throwing is logged in its row (`ok=0`, `error`) and never touches the
  others.
- **Rate limits.** Retry 429/5xx/timeouts up to 3 times with exponential backoff plus jitter,
  honouring `Retry-After`. Jupiter calls are paced (default 1 request/s) and limited to a size
  and DEX grid you can configure.
- **Slot and latency.** One `getSlot` per tick, plus each Phoenix response's own context slot;
  `latency_ms` is measured per request around the HTTP call.
- **Restarts.** `collect --resume` continues the newest unfinished run until its original end
  time. Ctrl+C finishes the current tick, commits, and exits cleanly.
- **Visibility.** One log line per tick (venues OK/failed, latency, slot) and a `status`
  command: ticks done, failures per venue, DB size, time left.
- **Isolation from development.** The 24 h run uses its own git worktree pinned to the commit
  that started it (`..\spia-collector`), so code I change in the main checkout can't affect
  the run.

Jupiter grid per tick (default): sizes $1K / $10K / $100K / $1M × buy and sell × filters
`best` (no filter), `SolFi`, `Phoenix`, `HumidiFi`, `Whirlpool`, `Raydium CLMM`, `Meteora DLMM`.
That's 56 calls ≈ 1 minute at 1/s, comfortably inside a 5-minute tick. The `Phoenix`-only route
doubles as a check on our own decoder: Jupiter quoting through Phoenix should roughly match
what our engine predicts from the same slot.

### 1.5 Measurement rules (kept consistent everywhere)

- Impact vs **own mid** (as v1) and cost vs a **common reference mid** = mean of the Kraken
  and Coinbase mids at the same tick. Only the reference version can compare venues that
  disagree on price, and AMM routes don't have a mid of their own.
- Price protection 10 % (unchanged). Partial fills are reported, never plotted as full.
- Fees reported as a separate column and as "all-in" bps; never silently mixed in.

### 1.6 Milestones for Part 1

| # | Item | Done when |
| --- | --- | --- |
| 1 | Collector + store + Jupiter | a 1-hour run on the laptop produces a clean DB; 24 h run started |
| 2 | Metrics, time series, `report` | REPORT.md + charts generated from the fixture DB, then from the real 24 h DB |
| 3 | Real AMM comparison | report has Phoenix vs SolFi vs other routes vs x·y=k, on the reference mid |
| 4 | Fees, IOC, TWAP | `twap` command; report section "does splitting help?" with real refill data |
| 5 | Hypothesis tests + benchmark table | invariants pass with 1,000s of examples; table in README |
| 6 | Replay (stretch) | derived events reproduce the next Phoenix snapshot exactly, or the mismatch is explained |

## 2. Curriculum: "Order Books From Zero"

Reader: a curious high-school senior. No finance, crypto or CS background assumed beyond
algebra. Each chapter has **Explain → See → Try → Check** (2–3 questions, every wrong answer
explained) and links every term to the glossary.

| # | Chapter | By the end the reader can… | Try-it widget |
| --- | --- | --- | --- |
| 1 | What a market is | explain why a price exists only because buyers and sellers disagree; read "bid" and "ask" | a lemonade-stand market: drag buyer and seller limits, see where trades happen |
| 2 | The order book | find best bid/ask, compute spread and mid from a ladder | a live ladder; click levels, read spread/mid in $ and bps |
| 3 | Orders, makers, takers | tell market from limit orders; say why trades print at the maker's price and why resting orders never cross | ticket that places either kind; a "why didn't it trade?" explainer |
| 4 | Price-time priority | predict who fills first in a FIFO queue; know partial fills keep their place | step-through queue (Alice/Bob/Carol/Dave) + "guess the next fill" |
| 5 | Price impact | compute average fill and bps by hand; explain spread-vs-depth crossover | walk-the-book animator + two-venue slider chart (from Price Impact Lab) |
| 6 | Data structures | name the three structures and the Big-O of add, cancel, match, with reasons | animated sorted map, linked-list unlink, id map; **coding exercises** with tests and hints |
| 7 | Why blockchains need integers | explain determinism across validators; convert ticks/lots to $ and SOL | float-drift demo (0.1+0.2) and a ticks/lots converter on the real Phoenix header |
| 8 | Solana basics + Phoenix's account | describe accounts, programs, slots; locate the header and order trees in bytes | **hex explorer** on a real Phoenix account: hover a byte, see the field and its decoded value |
| 9 | Red-black trees in an array, free lists | explain index pointers and how a free list reuses slots | animated node array: insert, delete, slot reuse |
| 10 | AMMs | derive x·y=k price and impact; contrast with a book; explain prop AMMs (SolFi) briefly | curve explorer: drag a trade along x·y=k; side-by-side with a book of equal depth |
| 11 | Reading real data | tell the junk-quote story; explain price protection; read the 24 h findings | real Phoenix/Kraken/Coinbase books, protection toggle, time-series charts |
| 12 | System design | draw the pipeline; explain failure handling; say what changes at exchange scale | clickable pipeline diagram, "break a venue" failure simulator |
| 13 | Interview mode | answer likely questions; give a 60-second pitch | question bank with model answers, 60-second pitch builder, flashcards (spaced repetition) |

LeetCode lists carry over from Price Impact Lab (LC 146, 1801, 707, 460, 2034, 981, 1845, 450,
303, 2389, 1011…), attached to chapters 4–6 and 9.

Coding exercises (JavaScript, run in a Web Worker with a time limit so an infinite loop can't
freeze the page): append to a level, unlink a node, cancel via id map, the matching loop, average
fill and bps, ticks/lots conversion, free-list allocate/release, constant-product swap. Each has
tests, three graded hints, and a reference solution behind a "show" button.

## 3. Artifact design

### 3.1 Information architecture

```
Order Books From Zero
├── Learn (story mode)      13 chapters, progress bar, "resume where you left off"
├── Play (sandbox)
│   ├── Playground          the full Order Book Playground, ported (live sim, ticket, impact, venues)
│   ├── Real books          built-in 2026-10-18 snapshots + 24 h time series; paste/upload exports
│   ├── Hex explorer        real Phoenix account bytes
│   ├── AMM lab             x·y=k vs book, plus the Jupiter routes we recorded
│   └── Code lab            all exercises in one place
├── Interview               questions, pitch builder, flashcards
└── Glossary                every term, linked from everywhere; searchable
```

Hash routing (`#/learn/5`, `#/play/hex`, `#/glossary/spread`) so the back button works and you
can send someone a link to one chapter. Progress, quiz answers and flashcard state are stored in
the viewer's own browser (localStorage, wrapped in try/catch; the page works without it).
Footer links to the GitHub repo and both older artifacts.

### 3.2 Visual design system

Successor to both artifacts: the Lab's calm workbook layout, the Playground's trading-desk
colours.

- **Type:** Chivo (display, from the Playground), IBM Plex Sans (body, from the Lab),
  JetBrains Mono (numbers, tabular). 17 px body on desktop, 16 px on phones, 68 ch measure.
- **Colour tokens** on `:root`, redefined for dark mode (system preference and a manual
  toggle): `--bg --panel --panel-2 --ink --muted --line --accent` (indigo), `--bid` green,
  `--ask` red, `--mine` amber (your orders), venue colours `--phoenix` violet, `--kraken` blue,
  `--coinbase` teal, `--amm` orange/grey. Bid/ask colours are never the only signal (labels and
  shapes too) for colour-blind readers.
- **Components:** Chapter header (number, title, goals), Callout (note / warning / "in the
  real world"), Term (dotted underline → glossary popover), Figure (SVG, captioned), Stepper
  (play / step / back / reset; reduced motion switches to step-only), TryIt card, Quiz
  (single-choice, per-option feedback), Ladder, DepthChart and LineChart (canvas, log axes),
  HexView, CodeExercise, Flashcards, ProgressBar.
- **Accessibility:** every control reachable by keyboard with visible focus; SVG/canvas figures
  have text alternatives; `aria-live` for widget results; `prefers-reduced-motion` honoured;
  tap targets ≥ 44 px on phones; no horizontal page scroll at 360 px.

### 3.3 How it's built

One self-contained HTML file (all CSS, JS and data inlined; Google Fonts the only external
load), published as an Artifact. The source is split so several agents can work in parallel:

```
course/
  src/shell.html             layout, nav, router mount points
  src/css/tokens.css         design tokens (the only place colours live)
  src/css/components.css
  src/js/core/*.js           engine.js (port of orderbook.py), amm.js, store.js, router.js,
                             ui.js (components above), glossary.js, data.js (loader + validator)
  src/js/chapters/NN-*.js    one file per chapter: {id, title, goals, render(el, ctx), quiz}
  src/js/play/*.js           sandbox tools
  data/                      generated JSON (python -m impact_analyzer export --course)
  tests/tests.html           browser test page: engine unit tests + golden tests vs Python
  build.py                   concatenates everything → course/dist/order-books-from-zero.html
```

The **golden tests** matter most: Python generates random order sequences and the fills its
engine produces; the JS engine must produce identical fills. That proves the course's engine
is the project's engine.

### 3.4 Data format the course loads (export v2)

Backward compatible: anything v1 (`playground.json`) still loads.

```jsonc
{
  "kind": "impact-analyzer-export", "version": 2, "generated_at": 1792296059.0,
  "venues": [ /* v1 venue objects, plus: */ { "fee_bps": 2, "depth_usd": {"0.005": [b, a], "0.01": [b, a], "0.02": [b, a]} } ],
  "amm_usd_reserve": 2624879.99,
  "jupiter": [ { "dex": "SolFi", "side": "buy", "usd": 100000, "cost_bps_vs_ref": 0.4, "route": ["SolFi"], "slot": 458308545 } ],
  "timeseries": {                      // present when exported from a collector DB
    "interval_s": 300, "t": [ /* unix seconds */ ],
    "series": { "phoenix": { "spread_bps": [...], "depth_2pct_usd": [[b, a], ...], "impact_bps": {"buy": {"10000": [...]}} } }
  },
  "phoenix_account": {                 // for the hex explorer: a trimmed slice of real bytes
    "slot": 458302883, "offset": 0, "hex": "…",
    "fields": [ { "name": "bids_size", "offset": 16, "size": 8, "type": "u64", "value": 4096, "explain": "…" } ]
  }
}
```

The loader validates shape and size (cap 5 MB), shows a friendly error naming the bad field, and
never executes anything from the file.

## 4. How the work is split

```
Day 1 (Oct 18)  me ──── collector + store + jupiter ──── 1 h smoke run ──── 24 h run starts tonight
Day 2 (Oct 19)  agents in parallel, each in its own git worktree/branch:
                  A  metrics + timeseries + report (against a fixture DB)
                  B  fees + IOC + TWAP
                  C  Hypothesis tests + benchmark table
                  D  course core: tokens, components, engine.js port, golden tests, build.py
Day 2–3         after D lands, lesson agents in parallel (same design system, separate files):
                  E  chapters 1–4      F  chapters 5–7 + code exercises
                  G  chapters 8–10 + hex explorer + AMM lab      H  chapters 11–13 + sandbox port
Day 3 (Oct 20)  24 h run done → real report, README findings; me: integration of A–H
Day 4 (Oct 21)  reviews (below), fixes, publish artifact, merge v2 → main, CI green
Day 5 (Oct 22)  replay (stretch, agent I), interview one-pager, final walkthrough
```

I own integration: merging branches, the shared design system and data contracts, and anything
that crosses modules. Agents get a written brief each: the files they own, the interfaces they
must honour (this plan's schema, export format and component list), and the tests that define
"done". No two agents edit the same file.

## 5. Test and review plan

- **Default test run stays offline.** Recorded fixtures for Jupiter, Kraken, Coinbase, Solana
  responses; a tiny fixture SQLite DB; `network`-marked live tests (`pytest -m network`).
- **Collector:** fake clock + fake fetchers test aligned ticks, one venue failing, 429 with
  `Retry-After`, resume after a kill mid-run, Ctrl+C handling.
- **Analysis:** hand-computed expected values on small books; report generation smoke test.
- **Engine (Hypothesis):** never crossed after any sequence; size conserved (added = resting +
  filled + cancelled); FIFO within a level; cancel of a filled/unknown id is a no-op; IOC never
  rests.
- **Course:** browser test page (engine unit tests, golden fills vs Python, quiz data shape,
  every glossary link resolves, every chapter renders without console errors).
- **CI:** ruff check + ruff format + pytest on Python 3.11–3.14 (adds 3.14, your laptop's
  version).
- **Skeptic code review:** a reviewer agent reads the whole v2 diff for bugs only; I verify each
  finding before fixing.
- **High-school-senior review:** a reader agent goes through the course as the target reader and
  flags every undefined term, leap, or confusing widget; I fix and re-run until clean.
- **Render matrix:** I check each section in the app's browser pane at 1280 px and 375 px, light
  and dark, keyboard-only, with reduced motion.

## 6. Definition of done (from the brief), mapped

| Brief item | Where |
| --- | --- |
| v2 merged to `main`, CI green | §4 day 4 |
| README with findings over time, charts, architecture diagram, how to run | §1.6 milestones 2–3 |
| Collector run on the laptop, report on real data | §1.4, §4 day 1–3 |
| Artifact published, links to repo, loads real data, passes HS-senior review | §3, §5 |
| One-page interview summary | `docs/INTERVIEW.md`, day 5 |
