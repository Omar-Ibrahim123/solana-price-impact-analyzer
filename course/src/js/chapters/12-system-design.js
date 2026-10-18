/* chapters/12-system-design.js: Chapter 12, "System design".
 *   Explain  the pipeline idea, the collector's rules, SQLite over Parquet, exchange scale
 *   See      a clickable pipeline: fetch -> normalize -> store -> engine -> analyze -> report;
 *            each stage opens what it does, its modules and the decision behind it
 *   Try      "break a venue": a model of one collector round (collector.py + net.py rules) with
 *            failures you switch on, the rows it would write, and --resume after a crash
 *   Check    quiz below
 * The failure simulator is a model of the code's rules, not a run of it: timings are examples,
 * retry counts and waits follow net.py (3 retries, 1 s / 2 s / 4 s backoff, Retry-After).
 */
(function (OBZ) {
  "use strict";
  const { h, fmt, clear } = OBZ.util;

  /* ------------------------------------------------------------------ See: the pipeline */
  const STAGES = [
    {
      id: "fetch", name: "Fetch", modules: "collector.py · venues.py · net.py",
      what: "Every 5 minutes, on the clock (12:00, 12:05, …), the [[collector]] starts one [[single-threaded|thread]] (a line of work the computer runs side by side with others) per venue and fetches Phoenix's market account over Solana [[rpc|RPC]], Kraken's and Coinbase's books from their [[api|APIs]], and the current Solana [[slot]], all at the same moment. Then it asks [[jupiter|Jupiter]] for 48 quotes (6 routes × 4 sizes × buy and sell), paced at 0.45 requests per second to stay inside the free tier's 5 requests per 10 seconds.",
      why: "**Threads, so the books are simultaneous.** Fetched one after another, a slow RPC call would make Kraken's book seconds older than Phoenix's, and the comparison would be unfair. **Each venue is isolated**: an error becomes a failed row, never a crashed round. **Retries live in one place**, `net.py`: timeouts, HTTP 429 (too many requests) and 5xx (the server's own errors) are retried up to 3 times with [[exponential-backoff|exponential backoff]] plus a little randomness (jitter), honouring `Retry-After` and Jupiter's `x-ratelimit-reset`. Other 4xx errors, like Jupiter's \"no route found\", are not retried: asking again gives the same answer.",
    },
    {
      id: "normalize", name: "Normalize", modules: "snapshot.py · phoenix.py · cex.py",
      what: "Each venue's answer becomes one `BookSnapshot`: prices in integer [[tick|ticks]], sizes in integer [[lot|lots]], bids highest first, asks lowest first, oldest first within a price. Phoenix's raw bytes are [[decoding|decoded]] with Python's `struct`, using one layout table that matches Ellipsis Labs' own client.",
      why: "**One shape for every venue** makes everything after this step venue-blind: the engine can't treat Phoenix and Kraken differently, because it can't tell them apart. Exchange books are trimmed to 25% around the mid to save space; Phoenix is kept whole, because its [[junk-quote|junk quotes]] are part of the story. Adding a venue means one fetch function and one line in the registry in `venues.py`.",
    },
    {
      id: "store", name: "Store", modules: "store.py · SQLite",
      what: "Each round is written in **one transaction**: the round row, one row per venue (ok or failed, attempts, latency, error), each book as compressed JSON, Phoenix's raw account bytes, and every Jupiter quote with its route. `store.py` is the only module that writes SQL.",
      why: "**[[sqlite|SQLite]] over Parquet.** It ships with Python; a round lands completely or not at all, so a crash never leaves half a round; a unique key on (run, round time) makes restarts safe; and `status` and `report` are plain SQL queries. Parquet (a file format that stores data column by column) shines when you scan millions of rows for a few columns, which a day of 5-minute rounds isn't. **Raw bytes are kept** so a decoder bug found later can be fixed and the whole run re-decoded, instead of being baked into the data.",
    },
    {
      id: "engine", name: "Engine", modules: "orderbook.py · convert.py · impact.py",
      what: "`convert.py` replays a snapshot, order by order, into a fresh `OrderBook`. `impact.py` then sends one [[market-order|market order]] per trade size, with a 10% [[price-protection|price-protection]] band, and records every fill.",
      why: "**Price-time priority with three structures**: a sorted map of price levels, a doubly linked list per level (FIFO, unlink in O(1)), and a hash map from order id to node (cancel in O(1)). **Integers end to end**, as on-chain programs require. **One engine for every venue**, so differences come from the books, not the code. This page runs a JavaScript port of it that reproduces the Python engine's fills exactly on about 2,000 recorded operations.",
    },
    {
      id: "analyze", name: "Analyze", modules: "metrics.py · timeseries.py · execution.py · fees.py",
      what: "Per snapshot: spread, depth within 0.5%, 1% and 2%, the cost of each trade size against the [[reference-mid|reference mid]], half round trips, and fees. Across the run: medians and percentiles, hour of day, uptime and latency per venue, and Phoenix activity from its sequence number. `execution.py` adds [[ioc|IOC]] orders and a [[twap|TWAP]] that splits a big order over successive real snapshots.",
      why: "**Two yardsticks**, own mid and reference mid, because a venue's own mid can be wrong ([chapter 11](#/learn/11)). **Fees in their own column**, never mixed in silently. **Results cached per snapshot with a version number** (`METRICS_VERSION`): change a formula, bump the number, and old cached results are recomputed instead of being mixed with new ones.",
    },
    {
      id: "report", name: "Report", modules: "report.py · charts.py · export.py",
      what: "`report` writes `REPORT.md`, with findings sentences generated from the numbers, plus PNG charts. `export` writes the JSON file this course loads: books, time series, Jupiter quotes and a slice of real Phoenix bytes.",
      why: "**Read-only access**: both open the database with SQLite's `mode=ro`, so they can run while the collector is still writing, with no chance of touching its data. Because the sentences are generated from the numbers, re-running after the full run updates the text as well as the charts.",
    },
  ];

  function buildPipeline(ctx) {
    const { ui } = ctx;
    let cur = OBZ.store.get("ch12.stage", "fetch");
    if (!STAGES.some((s) => s.id === cur)) cur = "fetch";
    const detail = h("div", { class: "readout-panel", id: OBZ.util.uid("stage"), attrs: { "aria-live": "polite" } });
    const btns = STAGES.map((s, i) => h("button", {
      type: "button",
      attrs: { "aria-pressed": String(s.id === cur), "aria-controls": detail.id },
      style: { textAlign: "left", padding: "var(--s-3)", borderRadius: "var(--r-md)", border: "1px solid var(--line-strong)", background: "var(--panel)", cursor: "pointer", minHeight: "var(--tap)", display: "flex", flexDirection: "column", gap: "2px" },
      on: { click: () => select(s.id) },
    },
    h("span", { class: "eyebrow", text: `Step ${i + 1}${i < STAGES.length - 1 ? " →" : ""}` }),
    h("strong", { text: s.name, style: { fontSize: "var(--fs-md)" } }),
    h("span", { class: "mono fine", text: s.modules })));

    function paint() {
      STAGES.forEach((s, i) => {
        const on = s.id === cur;
        btns[i].setAttribute("aria-pressed", String(on));
        btns[i].style.background = on ? "var(--accent-soft)" : "var(--panel)";
        btns[i].style.borderColor = on ? "var(--accent)" : "var(--line-strong)";
        btns[i].style.boxShadow = on ? "inset 0 0 0 1px var(--accent)" : "none";
      });
      const s = STAGES.find((x) => x.id === cur), i = STAGES.indexOf(s);
      clear(detail).append(
        h("p", { class: "eyebrow", text: `Step ${i + 1} of ${STAGES.length} · ${s.modules}` }),
        h("h3", { text: s.name, style: { margin: "0 0 var(--s-2)" } }),
        h("p", null, h("strong", { text: "What it does. " }), ui.rich(s.what)),
        h("p", null, h("strong", { text: "The decision behind it. " }), ui.rich(s.why)));
    }
    function select(id) {
      cur = id; OBZ.store.set("ch12.stage", id); paint();
      const r = detail.getBoundingClientRect();
      if (r.top > window.innerHeight - 80) detail.scrollIntoView({ block: "nearest" }); // phones: bring the answer into view
    }
    paint();
    return h("div", { class: "stack" },
      h("p", { class: "fine" }, h("strong", { text: "In: " }), "Solana RPC (Phoenix account, slot) · Kraken REST · Coinbase REST · Jupiter quote API"),
      h("div", { attrs: { role: "group", "aria-label": "Pipeline stages, in order" }, style: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 125px), 1fr))", gap: "var(--s-2)" } }, btns),
      h("p", { class: "fine" }, h("strong", { text: "Out: " }), "REPORT.md and charts · the export this course loads"),
      detail);
  }

  /* ------------------------------------------------------------------ Try: break a venue */
  const T_TIMEOUT = 15;          // net.Http timeout (s)
  const BACKOFF = [1, 2, 4];     // net._delay without jitter: backoff_s * 2^(attempt-1)
  const JUP_GAP = 1 / 0.45;      // jupiter.DEFAULT_RPS
  const N_QUOTES = 48;           // 6 routes x 4 sizes x 2 sides
  const NO_ROUTE = 4;            // SolFi at $100K and $1M, buy and sell: HTTP 400 NO_ROUTES_FOUND
  const LAT = { phoenix: 0.43, kraken: 0.17, coinbase: 0.12, slot: 0.15 }; // typical latencies in the real run's log (s)
  const VENUE_LABEL = { phoenix: "Phoenix", kraken: "Kraken", coinbase: "Coinbase" };

  const FAULTS = [
    { id: "krakenTimeout", label: "Kraken times out" },
    { id: "coinbase503", label: "Coinbase returns HTTP 503" },
    { id: "coinbase429", label: "Coinbase rate-limits once (429)" },
    { id: "rpcSlow", label: "Solana RPC times out once" },
    { id: "jup429", label: "Jupiter rate-limits a burst (429)" },
  ];

  const clock = (t) => { const d = new Date(t * 1000); return d.toISOString().slice(11, 19); };
  const hm = (t) => new Date(t * 1000).toISOString().slice(11, 16);
  const secs = (s) => (s < 10 ? s.toFixed(1) : Math.round(s)) + " s";

  /** One venue's fetch under the faults, following net.Http._request. */
  function fetchVenue(name, f) {
    const ev = [], lat = LAT[name];
    let t = 0;
    const failing = (name === "kraken" && f.krakenTimeout) ? "timeout" : (name === "coinbase" && f.coinbase503) ? "503" : null;
    if (failing) {
      for (let a = 1; a <= 4; a++) {
        t += failing === "timeout" ? T_TIMEOUT : 0.2;
        ev.push([t, `${VENUE_LABEL[name]}: attempt ${a} ${failing === "timeout" ? `timed out after ${T_TIMEOUT} s` : "got HTTP 503"}`]);
        if (a <= 3) { ev.push([t, `${VENUE_LABEL[name]}: waiting about ${BACKOFF[a - 1]} s before retrying (backoff × random 0.5–1.5)`]); t += BACKOFF[a - 1]; }
      }
      const err = failing === "timeout" ? "FetchError: GET https://api.kraken.com/0/public/Depth failed: ReadTimeout" : "FetchError: GET https://api.exchange.coinbase.com/products/SOL-USD/book failed: HTTP 503";
      ev.push([t, `${VENUE_LABEL[name]}: gave up after 4 attempts; row saved with ok = 0 and the error`]);
      return { ok: false, attempts: 4, end: t, ev, error: err };
    }
    let attempts = 1;
    if (name === "coinbase" && f.coinbase429) {
      t += lat; ev.push([t, "Coinbase: HTTP 429 Too Many Requests, Retry-After: 2"]);
      ev.push([t, "Coinbase: waiting exactly 2 s, as Retry-After asks"]); t += 2; attempts = 2;
    }
    if (name === "phoenix" && f.rpcSlow) {
      t += T_TIMEOUT; ev.push([t, `Phoenix: RPC call timed out after ${T_TIMEOUT} s`]);
      ev.push([t, "Phoenix: waiting about 1 s before retrying"]); t += 1; attempts = 2;
    }
    t += lat;
    ev.push([t, `${VENUE_LABEL[name]}: book received${attempts > 1 ? ` on attempt ${attempts}` : ""} (${Math.round(lat * 1000)} ms)`]);
    return { ok: true, attempts, end: t, ev };
  }

  function buildSimulator(ctx) {
    const { ui, data } = ctx;
    const START = Date.UTC(2026, 9, 18, 12, 0, 0) / 1000; // an example run starting 12:00 UTC
    const mids = { kraken: (data.venue("kraken") || {}).mid || 103.945, coinbase: (data.venue("coinbase") || {}).mid || 103.955 };
    const faults = {};
    let interrupt = "none", restartAfter = 8;
    let db, nextSlot, running, lastRef, lastLog, lastSummary;
    function reset() { db = []; nextSlot = START; running = true; lastRef = null; lastLog = []; lastSummary = "Press **Run next round** to collect the 12:00 round."; }
    reset();

    const faultBtns = FAULTS.map((fa) => h("button", {
      type: "button", class: "btn btn-sm", attrs: { "aria-pressed": "false" },
      on: { click: (e) => { faults[fa.id] = !faults[fa.id]; e.currentTarget.setAttribute("aria-pressed", String(!!faults[fa.id])); paintFaults(); } },
    }, h("span", { class: "fault-mark", attrs: { "aria-hidden": "true" }, text: "○ " }), fa.label));
    function paintFaults() {
      faultBtns.forEach((b, i) => {
        const on = !!faults[FAULTS[i].id];
        b.querySelector(".fault-mark").textContent = on ? "● " : "○ ";
        b.style.borderColor = on ? "var(--bad)" : "";
        b.style.background = on ? "var(--bad-soft)" : "";
      });
    }
    const interruptSeg = ui.Segmented({ label: "During the Jupiter quotes", value: interrupt, small: true, onChange: (v) => { interrupt = v; }, options: [
      { value: "none", label: "Nothing" }, { value: "ctrlc", label: "Press Ctrl+C" }, { value: "kill", label: "Power cut (process killed)" }] });
    const restartSeg = ui.Segmented({ label: "Restart after", value: String(restartAfter), small: true, onChange: (v) => { restartAfter = Number(v); }, options: [
      { value: "1", label: "1 minute" }, { value: "8", label: "8 minutes" }] });
    const runBtn = ui.Button({ label: "Run next round", variant: "primary", onClick: () => runTick() });
    const resumeBtn = ui.Button({ label: "Restart: collect --resume", onClick: () => resume() });
    const resetBtn = ui.Button({ label: "Reset database", variant: "ghost", small: true, onClick: () => { reset(); paint(); } });
    const summary = h("div", { class: "readout-panel", attrs: { "aria-live": "polite" } });
    const logBox = h("div");
    const dbBox = h("div");
    const statusBox = h("div");

    /** collect_tick + insert_tick for the 5-minute window `ts`, starting `late` seconds after it began. */
    function collect(ts, late) {
      const f = Object.assign({}, faults);
      const log = [];
      const t0 = ts + late;
      const add = (dt, text) => log.push([t0 + dt, text]);
      if (late > 1) add(0, `The ${hm(ts)} window started ${Math.round(late / 60)} min ago: collect it now, a little late (started_at records the delay)`);
      add(0, "Threads start together: Phoenix, Kraken, Coinbase and getSlot");
      const res = {};
      for (const v of ["phoenix", "kraken", "coinbase"]) { res[v] = fetchVenue(v, f); for (const [dt, text] of res[v].ev) add(dt, text); }
      add(LAT.slot, "getSlot: Solana slot recorded");
      const booksEnd = Math.max(res.phoenix.end, res.kraken.end, res.coinbase.end, LAT.slot);
      const okRef = ["kraken", "coinbase"].filter((v) => res[v].ok);
      let ref = null, refNote;
      if (okRef.length) { ref = okRef.reduce((a, v) => a + mids[v], 0) / okRef.length; lastRef = ref; refNote = okRef.length === 2 ? "Kraken + Coinbase" : `${VENUE_LABEL[okRef[0]]} only`; }
      else if (lastRef) { ref = lastRef; refNote = "last known (both exchanges down)"; }
      else refNote = "none";
      add(booksEnd, ref ? `Reference mid $${ref.toFixed(3)}: ${refNote}` : "No reference mid yet (both exchanges down on the first round): Jupiter quotes skipped");

      let quotes = 0, okQ = 0, t = booksEnd, stopped = null, extra = 0;
      if (ref) {
        add(booksEnd, `Jupiter: 48 quotes, one every ${JUP_GAP.toFixed(1)} s (free tier: 5 requests per 10 s)`);
        const cut = interrupt === "none" ? N_QUOTES : 20;
        const hit429 = f.jup429 ? new Set([6, 7, 8]) : new Set();
        for (let q = 0; q < cut; q++) {
          t = booksEnd + q * JUP_GAP + extra;
          if (hit429.has(q)) { add(t, `Jupiter quote ${q + 1}: HTTP 429; waiting for x-ratelimit-reset (about 6 s), then retrying: OK`); extra += 6; }
          quotes++;
          const isNoRoute = q >= 12 && q < 12 + NO_ROUTE; // SolFi $100K / $1M come 13th–16th in the grid
          if (isNoRoute) { if (q === 12) add(t, "Jupiter, SolFi at $100K and $1M: HTTP 400 NO_ROUTES_FOUND. Not retried (asking again won't create a route); saved as a failed quote with the reason"); }
          else okQ++;
        }
        t += JUP_GAP;
        if (interrupt === "ctrlc") { stopped = "ctrlc"; add(t, "Ctrl+C: \"stopping after this round\". The quote loop stops early; the quotes already taken are kept"); }
        if (interrupt === "kill") { stopped = "kill"; add(t, "Power cut: the process dies in the middle of the quote loop"); }
        else add(t, `Jupiter: ${okQ} of ${quotes} quotes OK${quotes - okQ === NO_ROUTE ? " (the other 4: SolFi has no route at $100K and $1M, buying or selling)" : ""}`);
      } else if (interrupt !== "none") {
        stopped = interrupt;
        add(t, interrupt === "kill" ? "Power cut: the process dies before the round is written" : "Ctrl+C: \"stopping after this round\"");
      }
      const row = {
        ts, late, ref, refNote, quotes, okQ,
        venues: { phoenix: res.phoenix, kraken: res.kraken, coinbase: res.coinbase },
      };
      if (stopped === "kill") {
        add(t, "Nothing from this round reaches the database: the round was still in memory, and it is written in one transaction only at the end");
        running = false;
        return { log, row: null, stopped };
      }
      db.push(row);
      add(t, `One transaction: round ${hm(ts)} written (1 round row, 3 venue rows, ${quotes} quote rows)`);
      if (stopped === "ctrlc") { add(t, "Committed. The collector exits cleanly."); running = false; }
      return { log, row, stopped };
    }

    function runTick() {
      if (!running) return;
      const out = collect(nextSlot, 0);
      lastLog = out.log;
      if (interrupt !== "none") { interrupt = "none"; interruptSeg.api.set("none"); } // one-shot
      const r = out.row, at = hm(nextSlot);
      if (out.stopped === "kill") lastSummary = `**Killed during the ${at} round.** The database still holds every completed round (${db.length}) and nothing half-written. Choose when to restart, then press **Restart**.`;
      else {
        const failed = ["phoenix", "kraken", "coinbase"].filter((v) => !r.venues[v].ok).map((v) => VENUE_LABEL[v]);
        lastSummary = `**Round ${at} stored.** ${failed.length ? `${failed.join(" and ")} failed and ${failed.length === 1 ? "is" : "are"} recorded with the error; the other venues are in the round as normal. ` : "All three books are in. "}Reference mid: ${r.ref ? "$" + r.ref.toFixed(3) + " (" + r.refNote + ")" : "none"}. Jupiter: ${r.okQ} of ${r.quotes} quotes OK.${out.stopped === "ctrlc" ? " Ctrl+C: the collector finished this round, committed it, and exited." : ""}`;
      }
      nextSlot += 300;
      paint();
    }

    function resume() {
      if (running) return;
      const lastAttempt = nextSlot - 300;           // the window that was being collected
      const now = lastAttempt + 60 + restartAfter * 60; // stopped about a minute into it
      const current = Math.floor((now - START) / 300) * 300 + START;
      const log = [];
      log.push([now, "collect --resume: reopens the newest run with its own settings, until its planned end"]);
      running = true;
      let slot = current, late = now - current;
      if (db.some((r) => r.ts === slot)) {
        log.push([now, `Round ${hm(slot)} already stored, skipping`]);
        slot += 300; late = 0;
        log.push([now, `Sleeping until ${hm(slot)}`]);
      }
      const lost = [];
      for (let s = lastAttempt; s < slot; s += 300) if (!db.some((r) => r.ts === s)) lost.push(hm(s));
      const out = collect(slot, late);
      lastLog = log.concat(out.log);
      nextSlot = slot + 300;
      lastSummary = `**Resumed.** ${lost.length ? `No row for ${lost.join(", ")}: that 5-minute window passed while the process was down, so it is a gap in the data (charts break their lines there). ` : "No round was lost. "}${out.row ? `Round ${hm(slot)} collected${late > 1 ? ` ${Math.round(late / 60)} min late` : ""}.` : ""}`;
      paint();
    }

    function cell(v) {
      if (!v) return "–";
      return v.ok ? `✓ ok${v.attempts > 1 ? ` (${v.attempts} attempts)` : ""}` : `✗ failed (${v.attempts} attempts)`;
    }

    function paint() {
      runBtn.disabled = !running;
      resumeBtn.disabled = running;
      clear(summary).appendChild(ui.p(lastSummary));
      clear(logBox);
      if (lastLog.length) {
        const sorted = lastLog.slice().sort((a, b) => a[0] - b[0]);
        logBox.appendChild(h("details", { class: "chart-table", open: true },
          h("summary", { text: "What the collector did, second by second" }),
          h("ol", { class: "mono fine", style: { listStyle: "none", padding: 0, margin: "var(--s-2) 0 0", display: "grid", gap: "4px" } },
            sorted.map(([t, text]) => h("li", { style: { display: "grid", gridTemplateColumns: "6.5em 1fr", gap: "var(--s-2)" } }, h("span", { class: "muted", text: clock(t) }), h("span", { text }))))));
      }
      clear(dbBox);
      if (db.length) {
        dbBox.appendChild(ui.Table({
          caption: "What the database holds (one row per stored round)", dense: true,
          columns: [
            { key: "round", label: "Round", align: "left" },
            { key: "phoenix", label: "Phoenix", align: "left" },
            { key: "kraken", label: "Kraken", align: "left" },
            { key: "coinbase", label: "Coinbase", align: "left" },
            { key: "ref", label: "Reference mid", align: "left" },
            { key: "jup", label: "Jupiter quotes" },
          ],
          rows: db.map((r) => ({
            round: hm(r.ts) + (r.late > 1 ? " (late)" : ""),
            phoenix: cell(r.venues.phoenix), kraken: cell(r.venues.kraken), coinbase: cell(r.venues.coinbase),
            ref: r.ref ? `$${r.ref.toFixed(3)} · ${r.refNote}` : "none",
            jup: r.quotes ? `${r.okQ} / ${r.quotes} ok` : "skipped",
          })),
        }));
        const errs = db.flatMap((r) => ["phoenix", "kraken", "coinbase"].filter((v) => !r.venues[v].ok).map((v) => `${hm(r.ts)} ${VENUE_LABEL[v]}: ${r.venues[v].error}`));
        if (errs.length) dbBox.appendChild(h("p", { class: "fine mono", text: "error column: " + errs.slice(-3).join(" · ") }));
      } else dbBox.appendChild(h("p", { class: "fine", text: "The database is empty." }));
      clear(statusBox);
      const health = ["phoenix", "kraken", "coinbase"].map((v) => {
        const n = db.length, ok = db.filter((r) => r.venues[v].ok).length, retries = db.reduce((a, r) => a + (r.venues[v].attempts - 1), 0);
        return `${VENUE_LABEL[v]} ${ok}/${n} ok, ${retries} retr${retries === 1 ? "y" : "ies"}`;
      });
      statusBox.appendChild(h("p", { class: "fine mono", text: `status → ${db.length} round${db.length === 1 ? "" : "s"} · ${health.join(" · ")} · process ${running ? "running" : "stopped"}` }));
    }
    paintFaults(); paint();

    return h("div", { class: "stack" },
      h("div", null, h("p", { class: "fine", text: "Switch on any failures, then run a round:" }), h("div", { class: "btn-row", attrs: { role: "group", "aria-label": "Failures to simulate" } }, faultBtns)),
      h("div", { class: "grid-2" },
        h("div", null, h("p", { class: "fine", text: "During the Jupiter quotes:" }), interruptSeg),
        h("div", null, h("p", { class: "fine", text: "After a stop, restart:" }), restartSeg)),
      h("div", { class: "btn-row" }, runBtn, resumeBtn, resetBtn),
      summary, dbBox, statusBox, logBox);
  }

  /* ------------------------------------------------------------------ the chapter */
  OBZ.chapters.register({
    id: "system-design",
    number: 12,
    title: "System design",
    summary: "How the project is put together, from fetching four APIs to writing a report, how it survives the failures a 24-hour run will meet, and what would change at exchange scale.",
    goals: [
      "Draw the pipeline from fetch to report and say what each step is responsible for",
      "Explain what the collector records when a venue fails, and how it resumes after a crash",
      "Defend SQLite over Parquet for this job, and say when that would flip",
      "Say what changes at exchange scale: sharding, sequencing, latency, on-chain limits",
    ],
    status: "ready",

    render(el, ctx) {
      const { ui } = ctx;

      // ---------------- Explain
      const ts = ctx.data.active().timeseries;
      const coverage = ts && Array.isArray(ts.t) && ts.t.length > 1
        ? ` (The export this course uses holds ${ts.t.length} rounds, covering ${fmt.num((ts.t[ts.t.length - 1] - ts.t[0]) / 3600, 1)} hours.)` : "";
      const ex = ctx.section("explain", "An assembly line that expects things to break");
      ex.append(
        ui.prose(`
The project is a [[pipeline]]: an assembly line where each station does one job and hands its output to the next. **Fetch** the books, **normalize** them into one shape, **store** them, replay them through the **engine**, **analyze** the results, **report**. Each station is one or two Python files, and none of them knows how the others work inside. That is what lets you swap a station (a new venue, a new metric) without touching the rest.

The interesting station is the first one. The [[collector]] was built to run for 24 hours, calling four public services every 5 minutes: 288 snapshot rounds a day (the project's code calls a round a "tick"; in this course a tick is only the price step), each with three books and 48 [[jupiter|Jupiter]] quotes.${coverage} Over a day, something *will* go wrong: a timeout, an overloaded server, a [[rate-limit|rate limit]], a laptop that goes to sleep. Good design means deciding in advance what happens each time.`),
        ui.prose(`
The collector's rules:

- **Fetch every venue at the same moment**, one thread each, so no book is seconds older than another.
- **Isolate failures.** If Kraken times out, the round still stores Phoenix and Coinbase, plus a Kraken row that says "failed after 4 attempts" (1 try + 3 retries) and why. That is [[fault-isolation|fault isolation]].
- **Retry politely**: wait 1, 2, then 4 seconds with a little randomness ([[exponential-backoff|exponential backoff]]), and if a server says "Retry-After: 2", wait exactly that long.
- **Write each round in one [[db-transaction|database transaction]]**, so a crash leaves the whole round or none of it.
- **Resume after a restart**: \`collect --resume\` carries on with the same run and skips rounds already stored. Ctrl+C finishes the current round first.
- **Protect the run from its author.** The run used its own copy of the code (a pinned git worktree: a separate folder holding the code at one fixed version), so edits made during the run couldn't change it halfway.`),
        ui.Callout({
          kind: "project", open: true, title: "SQLite, not Parquet: the reasoning",
          body: "[[sqlite|SQLite]] is built into Python, survives a crash mid-write, enforces \"one row per venue per round\" with a unique key, and answers `status` and `report` with plain SQL. A day is 288 rounds, an estimated 15 MB. Parquet, a file format that stores data column by column, wins when you scan millions of rows for a few columns. At exchange scale the answer flips: append to a log, then compact it into Parquet files split by day and market.",
        }),
        ui.prose(`
**What changes at exchange scale?** This project matches one book at a time, in Python, and nobody is waiting for the answer. A real exchange matches thousands of books for thousands of traders, and every microsecond counts:

- **[[sharding|Shard]] by market.** Each market gets its own [[single-threaded|single-threaded]] engine. Markets share nothing, so you add machines, not locks (the rules that stop two threads changing the same data at once, and make them wait).
- **A [[sequencer]] decides the order.** Before matching, every order gets a place in one agreed sequence and is written to a log. Replaying the log rebuilds the book exactly: [[determinism]] doubles as crash recovery.
- **[[latency|Latency]] budgets.** The collector thinks in seconds; a matching engine in microseconds. Nothing slow (disk, network, memory allocation) is allowed on the path an order takes.
- **Compiled languages and fixed memory.** Our pure-Python engine handles about 758,000 events per second; Rust or C++ with preallocated arrays is far faster.
- **On-chain limits.** Every [[validator]] re-runs every trade, so a Solana [[transaction]] gets a fixed [[compute-budget|compute budget]]. Phoenix keeps a whole market in one [[account]] (about 1.7 MB for SOL/USDC), and Solana only runs two transactions side by side when neither writes an account the other uses, so every trade on one market waits its turn. (Solana also caps how much compute all the transactions writing one account may use per block.)`));

      // ---------------- See
      const see = ctx.section("see", "The pipeline, station by station");
      see.append(ui.Figure({
        label: "Figure 12.1",
        children: buildPipeline(ctx),
        caption: "Click a station (or Tab to it and press Enter) to see what it does, which files do it, and the decision behind it. Data flows left to right, step 1 to step 6.",
        alt: "The project's pipeline in six steps. 1 Fetch: collector.py, venues.py and net.py fetch Phoenix, Kraken, Coinbase and Jupiter every 5 minutes. 2 Normalize: snapshot.py turns every venue into integer rounds and lots. 3 Store: store.py writes each round to SQLite in one transaction. 4 Engine: orderbook.py replays the book and impact.py simulates market orders. 5 Analyze: metrics.py and timeseries.py compute costs against the reference mid and aggregate them. 6 Report: report.py and export.py write REPORT.md, charts and the course data.",
      }));

      // ---------------- Try
      const tryEl = ctx.section("try", "Break a venue");
      tryEl.append(ui.TryIt({
        title: "A collector round, with failures you choose",
        intro: "Run a normal round first. Then switch on **Kraken times out** and run another: what gets stored? Switch on both exchange failures at once and watch the reference mid. Finally choose **Power cut** and run a round, then restart after 8 minutes and look for the gap.",
        children: h("div", { class: "stack" },
          buildSimulator(ctx),
          ui.NumberCheck({
            question: "Your turn: Kraken times out on every attempt. How many requests does `net.py` send to Kraken in that round before it records the failure?",
            answer: 4, tolerance: 0, unit: "requests",
            explain: "**4**: the first try plus 3 retries, with waits of about 1, 2 and 4 seconds between them. With a 15-second timeout each, Kraken's thread gives up after roughly a minute, while the other threads finished long before.",
            hint: "Count the first attempt as well as the retries. `net.py` allows 3 retries.",
          })),
      }),
      ui.Callout({
        kind: "real", title: "The real run's one gap, and why it stayed",
        body: `The collector run started at 05:09 UTC. The collector began with the 5-minute window it was in, 05:05, and that round took 105 seconds (mostly the paced Jupiter quotes), so it finished at 05:11, already inside the 05:10 window. The pinned code skipped a window it had run into, so 05:10 is missing: it is the break in chapter 11's charts.

The fix, "collect a round late instead of skipping it" (what this simulator does), was committed five minutes after the run started. The run was deliberately left on its pinned commit, so every round of the run is collected by the same code.`,
      }),
      ui.Callout({
        kind: "real", title: "How the project tests itself",
        body: `Three ideas do most of the work, and the interview page asks about all of them:

- **Property-based testing.** Instead of writing each test case by hand, the Hypothesis library makes up thousands of random sequences of adds, cancels and market orders. When one fails, it shrinks it to the shortest sequence that still fails.
- **Differential testing.** Each random sequence also runs through a deliberately simple reference model: one flat list of orders, sorted on every match. It is far too slow for real use, but easy to check by eye. After every step the fast engine and the model must report identical fills.
- **Invariants.** Rules that must hold after every step: the book is never crossed, the linked lists are intact, the id map matches the book exactly, and no lots appear or vanish.

And to test the tests, \`python -m benchmarks.mutation_check\` plants 8 realistic bugs in the engine, one at a time (for example, letting a partial fill lose its place). The tests catch all 8.`,
      }),
      ui.Callout({
        kind: "note", title: "What the model leaves out",
        body: "This simulator follows the collector's rules (`collector.py`, `net.py`) but doesn't run them: latencies are typical values from the real log, and the random part of each backoff wait is left out. The real tests do run the code, with a fake clock and fake fetchers: one venue failing, a 429 with `Retry-After`, resume after a kill, and Ctrl+C (`tests/test_collector.py`, `tests/test_net.py`).",
      }));
    },

    quiz: [
      {
        q: "During one round, Kraken times out on every attempt. What does the database hold for that round?",
        options: [
          { text: "Nothing: one failed venue makes the collector throw the whole round away", why: "That would lose two good books because of one bad one. Each venue is fetched in its own thread and its errors are caught, so the round is stored without Kraken." },
          { text: "The other two books, a failed Kraken row, and a Coinbase-only reference mid", why: "Right. Failures are isolated and recorded, not hidden. The reference mid is the mean of whichever exchange mids are available, here Coinbase's only." },
          { text: "All three books: the collector waits as long as it takes for Kraken to answer", why: "The collector never waits forever: each request has a 15-second timeout and there are 3 retries. After that it records the failure and moves on." },
          { text: "Kraken's book from the previous round, copied forward to fill the hole", why: "Copying old data forward would make Kraken look like it had a book it didn't show. The row says honestly that the fetch failed." },
        ],
        answer: 1,
      },
      {
        q: "The laptop loses power during the Jupiter quotes of the **12:05** round. You run `collect --resume` at **12:13**. What does the database contain afterwards?",
        options: [
          { text: "Half of the 12:05 round (the books, without the quotes), then 12:10", why: "The round is written in one transaction at the end, so a crash never leaves part of a round. The books for 12:05 were only in memory." },
          { text: "Every round up to 12:00, then 12:10 collected a little late at 12:13; 12:05 is a gap", why: "Right. Completed rounds survived. On restart, the collector collects the 5-minute window it is in (12:10) straight away and notes the delay; the 12:05 window passed while it was down." },
          { text: "A duplicate of 12:00, because resuming starts the run again", why: "Resume continues the same run, and a unique key on the round time means a stored round is skipped, never duplicated." },
          { text: "A 12:05 round filled with the 12:13 books", why: "That would put data from the wrong time under the 12:05 label. The collector only collects the 5-minute window it is actually in." },
        ],
        answer: 1,
      },
      {
        q: "Why can't Solana run two trades on the **same** Phoenix market at the same time, side by side?",
        options: [
          { text: "Solana's validators can only run one transaction at a time", why: "Solana does run transactions in parallel, but only when neither writes an account the other uses." },
          { text: "Both write the same market account, so they must take turns", why: "Right. Phoenix keeps the whole book in one account, so every trade on that market must wait its turn. Trades on different markets can run side by side, which is sharding by market." },
          { text: "Phoenix allows only one trade in each slot", why: "Many trades can land in the same slot; they just run one after another when they touch the same market account." },
          { text: "Floating-point rounding would make parallel trades disagree", why: "Phoenix uses integers, so rounding isn't the issue. The limit comes from two transactions writing the same account." },
        ],
        answer: 1,
      },
    ],
  });
})(window.OBZ = window.OBZ || {});
