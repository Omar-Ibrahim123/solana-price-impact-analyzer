/* play/real-books.js: the real-data explorer.
 *
 *   1. Top of book for every venue in the active dataset (spread, mid, fee, depth).
 *   2. One venue up close: ladder, depth chart, stats against the reference mid.
 *   3. What a market order would cost, by size, for every venue: own mid or reference mid,
 *      fees excluded or all-in, 10% price protection on or off. Computed by OBZ.engine from
 *      the books themselves (an export's stored curves may predate price protection).
 *   4. The collector's time series (export v2): spread, depth within 2% and cost vs the
 *      reference mid over time, cost by size at any tick, for venues and Jupiter routes,
 *      plus the raw Jupiter quotes. v1 data (one snapshot) gets a friendly note instead.
 *   5. Load your own export (v1 or v2).
 *
 * Everything from the data is rendered as text (h() never parses HTML).
 */
(function (OBZ) {
  "use strict";
  const { h, fmt, clear } = OBZ.util;
  const E = OBZ.engine;

  const SIZES = E.logSpacedSizes(1e3, 1e6, 8);
  const PICK = [1e3, 1e4, 1e5, 1e6];
  const PROTECTION = 0.10;

  const ROUTES = {
    // The palette is small, so routes that share a hue with a book are dashed.
    best: { color: "--ink", label: "Jupiter, best route" },
    SolFi: { color: "--amm", label: "SolFi via Jupiter" },
    Phoenix: { color: "--phoenix", dash: true, label: "Phoenix via Jupiter" },
    Whirlpool: { color: "--mine", dash: true, label: "Whirlpool via Jupiter" },
    "Raydium CLMM": { color: "--accent", dash: true, label: "Raydium CLMM via Jupiter" },
    "Meteora DLMM": { color: "--amm-alt", label: "Meteora DLMM via Jupiter" },
  };
  const SPARE = ["--coinbase", "--kraken", "--muted", "--bid", "--ask"];

  const S = {
    card: "background: var(--panel); border: 1px solid var(--line); border-radius: var(--r-lg); padding: clamp(12px, 3vw, 22px); min-width: 0; display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--s-3); align-content: start;",
    h2: "font-size: var(--fs-lg); margin: 0;",
    h3: "font-size: var(--fs-md); margin: 0;",
    grid: (min) => `display: grid; gap: var(--s-4); align-items: start; grid-template-columns: repeat(auto-fit, minmax(min(100%, ${min}px), 1fr));`,
    controls: "display: flex; flex-wrap: wrap; gap: var(--s-2) var(--s-4); align-items: end;",
  };
  /** append that skips null/false children (Element.append would print "null") */
  const put = (el, ...kids) => OBZ.util.append(el, kids);
  const hhmm = (t) => new Date(t * 1000).toISOString().slice(11, 16);
  const digitsFor = (snap) => (snap ? Math.max(2, Math.min(4, Math.round(-Math.log10(snap.tickSize)))) : 2);

  function card(title, ...children) {
    return h("section", { style: S.card, attrs: { "aria-label": title } }, h("h2", { style: S.h2, text: title }), ...children);
  }
  function labelled(text, control) {
    return h("div", { style: "display: grid; gap: 4px; min-width: 0;" }, h("span", { class: "fine", style: "font-weight: 600; color: var(--ink-2);", text }), control);
  }

  /** Reference mid: mean of the Kraken and Coinbase mids (PLAN.md §1.5), or null. */
  function referenceMid(data) {
    const k = data.snapshot("kraken"), c = data.snapshot("coinbase");
    if (!k || !c) return null;
    const a = k.midPrice(), b = c.midPrice();
    return a === null || b === null ? null : (a + b) / 2;
  }

  /** Display name and colour for a time-series key ("kraken", "jupiter:SolFi", ...). */
  function seriesMeta(data, key, i) {
    if (key.startsWith("jupiter:")) {
      const dex = key.slice(8);
      const r = ROUTES[dex];
      return r ? { key, label: r.label, color: r.color, dash: !!r.dash, route: true } : { key, label: `${dex} via Jupiter`, color: SPARE[i % SPARE.length], dash: true, route: true };
    }
    return { key, label: data.label(key) + " book", color: data.colorVar(key, i), dash: false, route: false };
  }

  /** Where a venue's taker fee came from, in a few words. */
  function feeNote(v) {
    if (v.feeBps === null) return "unknown";
    if (v.meta && typeof v.meta.taker_fee_bps === "number" && v.meta.taker_fee_bps === v.feeBps) return "read from the market account";
    const base = OBZ.data.DEFAULT_FEES[v.venue];
    if (base !== undefined && base === v.feeBps) return "published base tier";
    return v.feeSource === "export" ? "from the export" : v.feeSource;
  }

  /* ================================================================== the tool */
  function render(el, ctx) {
    const { ui, data } = ctx;
    const store = OBZ.store;
    const state = {
      venue: store.get("play.realBooks.venue", "phoenix"),
      band: 0.01, unit: "sol",
      side: "buy", vs: "own", fees: false, protect: true, log: true,
      sel: store.get("play.realBooks.series", null),
      tsLog: true, tsSide: "buy", tsSize: "10000", tick: null,
    };

    const pill = h("p", { class: "source-pill" }, h("span", { class: "dot", attrs: { "aria-hidden": "true" } }), h("span"));
    const summaryBox = h("div");
    const venueBox = h("div");
    const costBox = h("div");
    const tsBox = h("div");

    el.append(
      ui.prose(`Real [[order-book|order books]] captured by this project, and how much a trade would have cost on each. The built-in data has two parts: three [[snapshot|snapshots]] of SOL books taken within half a second of each other on 18 Oct 2026 at 04:31 UTC, and a [[time-series|time series]] from the project's [[collector]], which measured the venues and several [[jupiter|Jupiter]] routes every 5 minutes afterwards.`),
      pill,
      card("Top of book, every venue", summaryBox),
      card("One venue up close", venueBox),
      card("What a market order would cost", costBox),
      card("Over time: the collector's measurements", tsBox),
      card("Load your own data",
        ui.p("Run `python -m impact_analyzer run` (one snapshot, format v1: `playground.json`) or `python -m impact_analyzer export` (the collector's database, format v2 with time series and Jupiter quotes), then paste or choose the file. Every widget on the page switches to it.", "fine"),
        ui.DataLoader({})));

    /* ---------------------------------------------------------------- 1. summary */
    function drawSummary() {
      const ds = data.active();
      const ref = referenceMid(data);
      const rows = ds.venues.map((v) => {
        const snap = data.snapshot(v.venue);
        let d2 = null;
        try { d2 = v.depthUsd && v.depthUsd["0.02"] ? v.depthUsd["0.02"] : snap && snap.midPrice() !== null ? OBZ.amm.depthWithin(snap, 0.02) : null; } catch (e) { d2 = null; }
        return { v, snap, d2, digits: digitsFor(snap) };
      });
      put(clear(summaryBox), 
        ui.p(`The [[best-bid|best bid]], [[best-ask|best ask]], [[spread]] and [[mid-price|mid]] of each book, its [[taker-fee|taker fee]], and how many dollars rest within 2% of its mid ([[depth]]). ${ref !== null ? `The [[reference-mid|reference mid]] (average of the Kraken and Coinbase mids) is **$${fmt.price(ref, 3)}**.` : "This dataset has no Kraken + Coinbase pair, so there is no reference mid."}`, "fine"),
        ui.Table({
          caption: `${ds.label}`, dense: true,
          columns: [
            { label: "Venue", align: "left", mono: false, value: (r) => r.v.label },
            { label: "Pair", align: "left", value: (r) => r.v.symbol || "–" },
            { label: "Best bid", value: (r) => (r.snap && r.snap.bestBid() !== null ? "$" + fmt.price(r.snap.price(r.snap.bestBid()), r.digits) : "–") },
            { label: "Best ask", value: (r) => (r.snap && r.snap.bestAsk() !== null ? "$" + fmt.price(r.snap.price(r.snap.bestAsk()), r.digits) : "–") },
            { label: "Mid", value: (r) => (r.snap && r.snap.midPrice() !== null ? "$" + fmt.price(r.snap.midPrice(), Math.max(3, r.digits)) : "–") },
            { label: "Spread", value: (r) => (r.snap ? fmt.bps(r.snap.spreadBps()) : "–") },
            { label: "Taker fee", value: (r) => (r.v.feeBps === null ? "–" : fmt.bps(r.v.feeBps, 0)) },
            { label: "Within 2% (bid / ask)", value: (r) => (r.d2 ? `${fmt.usdCompact(r.d2[0])} / ${fmt.usdCompact(r.d2[1])}` : "–") },
            { label: "Fetched", value: (r) => (r.v.fetchedAt ? hhmm(r.v.fetchedAt) + " UTC" : "–") },
          ],
          rows,
        }),
        ui.p("Fees are the venues' published base tiers (from `fees.py`), except Phoenix's, which is read from its market account. They are shown separately and never mixed into the impact numbers unless you ask for all-in costs below.", "fine"));
    }

    /* ---------------------------------------------------------------- 2. one venue */
    const vStats = {
      bid: ui.Stat({ label: "Best bid ▲", tone: "bid" }), ask: ui.Stat({ label: "Best ask ▼", tone: "ask" }),
      spread: ui.Stat({ label: "Spread", tone: "accent" }), mid: ui.Stat({ label: "Mid" }),
      ref: ui.Stat({ label: "Mid vs reference" }), fee: ui.Stat({ label: "Taker fee" }),
      d1: ui.Stat({ label: "Within 1% of mid" }), d2: ui.Stat({ label: "Within 2% of mid" }),
    };
    function drawVenue() {
      const ds = data.active();
      if (!data.venue(state.venue)) state.venue = ds.venues[0] ? ds.venues[0].venue : null;
      clear(venueBox);
      if (!state.venue) { venueBox.appendChild(ui.p("This dataset has no venues.")); return; }
      const v = data.venue(state.venue);
      const snap = data.snapshot(state.venue);
      let book = null, err = null;
      try { book = snap.toBook(); } catch (e) { err = e.message; }
      const picker = ui.VenuePicker({ venues: data.venues(), value: state.venue, onChange: (x) => { state.venue = x; store.set("play.realBooks.venue", x); drawVenue(); } });
      if (!book) { put(venueBox, picker, h("p", { text: "This book could not be loaded: " + err })); return; }
      const digits = digitsFor(snap);
      const aggregated = v.meta && v.meta.levels === "aggregated";
      const levels = book.toLevels(10);
      if (aggregated) for (const side of ["bids", "asks"]) levels[side].forEach((l) => { delete l.count; });
      const when = v.fetchedAt ? fmt.date(v.fetchedAt) : "an unknown time";
      const slot = v.meta && typeof v.meta.slot === "number" ? [" at Solana ", ui.Term("slot"), " " + fmt.int(v.meta.slot)] : null;
      const how =aggregated ? "This venue publishes one total per price, so each row is a whole [[price-level|price level]]." : `Each row adds up the individual orders at that price (${fmt.int(snap.bids.length)} bids and ${fmt.int(snap.asks.length)} asks in all); the order count is on the screen-reader label.`;

      const m = book.mid(), bb = book.bestBid(), ba = book.bestAsk(), ref = referenceMid(data);
      if (m !== null) {
        vStats.bid.api.set("$" + fmt.price(book.usd(bb), digits), fmt.sol(book.sol(book.level("bid", bb).totalSize)) + " SOL");
        vStats.ask.api.set("$" + fmt.price(book.usd(ba), digits), fmt.sol(book.sol(book.level("ask", ba).totalSize)) + " SOL");
        vStats.spread.api.set(fmt.bps(book.spreadBps()), "$" + fmt.price(book.usd(ba) - book.usd(bb), digits));
        vStats.mid.api.set("$" + fmt.price(m, Math.max(3, digits)), "(bid + ask) ÷ 2");
        vStats.ref.api.set(ref === null ? "–" : (m >= ref ? "+" : "−") + fmt.bps(Math.abs(m - ref) / ref * 1e4), ref === null ? "no reference mid" : `reference $${fmt.price(ref, 3)}`);
        const d1 = book.depthWithin(0.01), d2 = book.depthWithin(0.02);
        vStats.d1.api.set(fmt.usdCompact(d1[0] + d1[1]), `${fmt.usdCompact(d1[0])} bid · ${fmt.usdCompact(d1[1])} ask`);
        vStats.d2.api.set(fmt.usdCompact(d2[0] + d2[1]), `${fmt.usdCompact(d2[0])} bid · ${fmt.usdCompact(d2[1])} ask`);
      }
      vStats.fee.api.set(v.feeBps === null ? "–" : fmt.bps(v.feeBps, 0), feeNote(v));

      const depth = ui.DepthChart({ levels: book, band: state.band, unit: state.unit, height: 200, alt: `Depth chart for ${v.label}: cumulative ${state.unit === "usd" ? "dollars" : "SOL"} on each side within ${fmt.pct(state.band, state.band < 0.01 ? 1 : 0)} of the mid.` });
      const bandSeg = ui.Segmented({ label: "Price window", small: true, value: state.band, options: [0.005, 0.01, 0.02, 0.05].map((b) => ({ value: b, label: "±" + fmt.pct(b, b < 0.01 ? 1 : 0) })), onChange: (b) => { state.band = b; depth.api.update({ band: b }); } });
      const unitSeg = ui.Segmented({ label: "Depth unit", small: true, value: state.unit, options: [{ value: "sol", label: "SOL" }, { value: "usd", label: "USD" }], onChange: (u) => { state.unit = u; depth.api.update({ unit: u }); } });

      put(venueBox, 
        picker,
        // venue names come from the data: text nodes only, never rich markup
        h("p", { class: "fine" }, h("strong", { text: `${v.label} ${v.symbol}`.trim() }), `, fetched ${when}`, slot, ". ", ui.rich(how)),
        h("div", { class: "grid-2" },
          ui.Ladder({ levels, rows: 10, priceDigits: digits, label: `${v.label} order book, top 10 levels per side` }),
          h("div", { class: "stack" }, ui.StatGrid(Object.values(vStats)),
            ui.p("**Mid vs reference** says how far this venue's own mid sat from the shared reference price. AMM routes have no mid of their own, so the cost charts below can also measure everything from the reference mid.", "fine"))),
        h("div", { style: S.controls }, labelled("Price window", bandSeg), labelled("Depth in", unitSeg)),
        ui.Figure({ children: depth, caption: `The same book as a [[depth-chart|depth chart]]: from the mid outward, the green area adds up the bids and the red area the asks. A wall that rises close to the mid means plenty of [[liquidity]] near the price; a flat line means nobody is quoting there.` }));
    }

    /* ---------------------------------------------------------------- 3. cost curves */
    const bookCache = new Map();
    function bookFor(venue) {
      const key = data.active().label + "|" + venue;
      if (!bookCache.has(key)) { let b = null; try { b = data.book(venue); } catch (e) { b = null; } bookCache.set(key, b); }
      return bookCache.get(key);
    }
    function curveFor(v, ref) {
      const b = bookFor(v.venue);
      if (!b || b.mid() === null) return [];
      const fee = state.fees && v.feeBps !== null ? v.feeBps : 0;
      return SIZES.map((u) => {
        const r = b.impact(state.side, u, { maxSlippage: state.protect ? PROTECTION : null });
        if (!r || r.avgPrice === null) return [u, null, false];
        let bps = r.impactBps;
        if (state.vs === "ref") bps = state.side === "buy" ? (r.avgPrice - ref) / ref * 1e4 : (ref - r.avgPrice) / ref * 1e4;
        return [u, bps + fee, r.fullyFilled];
      });
    }
    function drawCost() {
      const ds = data.active();
      const ref = referenceMid(data);
      if (state.vs === "ref" && ref === null) state.vs = "own";
      const curves = ds.venues.map((v, i) => ({ v, i, pts: curveFor(v, ref) }));
      let hidden = 0;
      const series = curves.map(({ v, i, pts }) => ({
        name: v.label, color: data.colorVar(v.venue, i), width: v.venue === state.venue ? 3 : 2,
        points: state.log ? pts.map((p) => { if (p[1] !== null && p[1] <= 0) { hidden++; return [p[0], null, p[2]]; } return p; }) : pts,
      }));
      const what = `${state.vs === "ref" ? "vs the reference mid" : "vs own mid"}${state.fees ? ", all-in (fee included)" : ", before fees"}`;
      const chart = ui.LineChart({
        series, height: 270, table: true,
        x: { log: true, label: "Trade size (USD)", format: fmt.usdCompact, ticks: PICK, min: 1e3, max: 1e6 },
        y: state.log ? { log: true, label: `bps ${state.vs === "ref" ? "vs ref" : "vs mid"} (log)`, format: (v) => fmt.num(v, 1) } : { label: `bps ${state.vs === "ref" ? "vs ref" : "vs mid"}`, format: (v) => fmt.num(v, 1) },
        alt: `Cost of a market ${state.side} from $1K to $1M for ${ds.venues.map((v) => v.label).join(", ")}, in basis points ${what}, ${state.protect ? "with" : "without"} 10% price protection.`,
      });
      const near = (pts, u) => pts.find((p) => Math.abs(p[0] - u) / u < 1e-6);
      const table = ui.Table({
        caption: `Market ${state.side}, bps ${what} (* = only partly filled)`, dense: true,
        columns: [{ label: "Venue", align: "left", mono: false, value: (r) => r.v.label }].concat(PICK.map((u) => ({ label: fmt.usdCompact(u), value: (r) => { const p = near(r.pts, u); return !p || p[1] === null ? "–" : fmt.num(p[1], 2) + (p[2] === false ? "*" : ""); } }))),
        rows: curves,
      });
      const seg = (label, value, options, key, after) => labelled(label, ui.Segmented({ label, small: true, value, options, onChange: (x) => { state[key] = x; if (after) after(); drawCost(); } }));
      put(clear(costBox), 
        ui.p("Each line walks a real book, as `impact.py` does, for a market order of every size from $1K to $1M. Thicker line: the venue picked above. Hollow points and * mean the book (or the protection band) ran out before the order was filled.", "fine"),
        h("div", { style: S.controls },
          seg("Side", state.side, [{ value: "buy", label: "▲ Buy" }, { value: "sell", label: "▼ Sell" }], "side"),
          ref !== null ? seg("Measured against", state.vs, [{ value: "own", label: "Own mid" }, { value: "ref", label: "Reference mid" }], "vs") : null,
          seg("Fees", state.fees, [{ value: false, label: "Excluded" }, { value: true, label: "All-in" }], "fees"),
          seg("Price protection", state.protect, [{ value: true, label: "10%" }, { value: false, label: "Off" }], "protect"),
          seg("Vertical axis", state.log, [{ value: true, label: "Log" }, { value: false, label: "Linear" }], "log")),
        chart, table,
        ui.p(explainCost(ref, hidden), "fine"));
    }
    function explainCost(ref, hidden) {
      const parts = [];
      parts.push(state.vs === "ref"
        ? `Against the [[reference-mid|reference mid]] ($${fmt.price(ref, 3)}), a venue whose own mid sits above the reference starts out more expensive for buyers, and one below it starts out cheaper: this is the fair way to compare venues that disagree on the price.`
        : "Against each venue's own mid, the smallest trade costs about half the spread ([[half-spread]]), and the line rises as the order [[walking-the-book|walks the book]].");
      if (state.fees) parts.push("All-in adds each venue's taker fee to every point ([[all-in-cost|all-in cost]]).");
      if (!state.protect) parts.push("With protection off, an order keeps filling at any price, including [[junk-quote|junk quotes]] far from the market: watch Phoenix's line at large sizes.");
      else parts.push("With 10% [[price-protection|price protection]], an order never trades more than 10% from the mid; whatever is left is cancelled.");
      if (state.log) parts.push(`On a [[log-scale|log axis]] each gridline is ten times the one below.${hidden ? ` ${hidden} point${hidden > 1 ? "s" : ""} at or below 0 bps (better than the reference) can't be drawn on it; switch to Linear to see ${hidden > 1 ? "them" : "it"}.` : ""}`);
      return parts.join(" ");
    }

    /* ---------------------------------------------------------------- 4. time series */
    function tsKeys(ts) {
      const keys = Object.keys(ts.series || {});
      const order = OBZ.data.venues(); // books in the dataset's venue order, then the rest
      const rank = (k) => (order.indexOf(k) < 0 ? order.length : order.indexOf(k));
      const books = keys.filter((k) => !k.startsWith("jupiter:")).sort((a, b) => rank(a) - rank(b));
      return books.concat(keys.filter((k) => k.startsWith("jupiter:")));
    }
    /** [[t, y], ...] for one metric of one series, with a gap (null) where ticks are missing. */
    function points(ts, values, pick) {
      const out = [], t = ts.t, step = ts.interval_s || 300;
      for (let i = 0; i < t.length; i++) {
        if (i > 0 && t[i] - t[i - 1] > step * 1.5) out.push([(t[i] + t[i - 1]) / 2, null]);
        const raw = values ? values[i] : null;
        const y = raw === null || raw === undefined ? null : pick ? pick(raw) : raw;
        out.push([t[i], y === null || y === undefined || !isFinite(y) ? null : y]);
      }
      return out;
    }
    function timeTicks(t0, t1) {
      for (const step of [300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400]) {
        const first = Math.ceil(t0 / step) * step, n = Math.floor((t1 - first) / step) + 1;
        if (n <= 6) { const out = []; for (let x = first; x <= t1; x += step) out.push(x); return out.length ? out : [t0, t1]; }
      }
      return [t0, t1];
    }
    function logSafe(series, onHide) {
      if (!state.tsLog) return series;
      return series.map((s) => Object.assign({}, s, { points: s.points.map((p) => { if (p[1] !== null && p[1] <= 0) { onHide(s, p); return [p[0], null]; } return p; }) }));
    }
    function hasData(series) { return series.some((s) => s.points.some((p) => p[1] !== null)); }

    function drawTs() {
      const ds = data.active();
      const ts = ds.timeseries;
      clear(tsBox);
      if (!ts || !Array.isArray(ts.t) || !ts.t.length || !ts.series) {
        tsBox.appendChild(ui.Callout({ kind: "note", title: "No time series in this data",
          body: `${ds.version === 1 ? "This is a format v1 file (`playground.json`): it holds one snapshot of each book, which is everything above." : "This export has no time series section."} To see spread, depth and cost every 5 minutes, export from the collector's database with \`python -m impact_analyzer export\` and load that file, or go **Back to built-in data** below.` }));
        return;
      }
      const keys = tsKeys(ts);
      const metas = keys.map((k, i) => seriesMeta(data, k, i));
      const metaOf = (k) => metas.find((m) => m.key === k);
      if (!state.sel || !state.sel.some((k) => keys.includes(k))) {
        const wanted = ["phoenix", "kraken", "coinbase", "jupiter:best", "jupiter:SolFi"];
        state.sel = keys.filter((k) => wanted.includes(k));
        if (!state.sel.length) state.sel = keys.slice(0, 4);
      }
      const sel = keys.filter((k) => state.sel.includes(k));
      const t = ts.t, n = t.length, t0 = t[0], t1 = t[n - 1];
      if (state.tick === null || state.tick >= n) state.tick = n - 1;
      const day = new Date(t0 * 1000).toISOString().slice(0, 10);
      const xAxis = { label: "Time (UTC)", format: hhmm, ticks: timeTicks(t0, t1), min: t0, max: t1 };

      // ---- picker (multi-select)
      const picker = h("div", { class: "seg", attrs: { role: "group", "aria-label": "Venues and routes shown on the charts" }, style: "flex-wrap: wrap;" },
        metas.map((m) => h("button", {
          type: "button", class: "seg-btn", attrs: { "aria-pressed": String(sel.includes(m.key)) },
          on: { click: () => { const on = state.sel.includes(m.key); state.sel = on ? state.sel.filter((k) => k !== m.key) : state.sel.concat([m.key]); store.set("play.realBooks.series", state.sel); drawTs(); } },
        }, h("span", { attrs: { "aria-hidden": "true" }, style: "width: 1em; font-weight: 700;", text: sel.includes(m.key) ? "✓" : "" }),
        h("span", { class: "swatch", attrs: { "aria-hidden": "true" }, style: { background: `var(${m.color})` } }), m.label)));
      const scale = ui.Segmented({ label: "Vertical axis", small: true, value: state.tsLog, options: [{ value: true, label: "Log" }, { value: false, label: "Linear" }], onChange: (x) => { state.tsLog = x; drawTs(); } });

      const hiddenNotes = [];
      const onHide = (s) => { if (!hiddenNotes.includes(s.name)) hiddenNotes.push(s.name); };
      const empty = (txt) => h("p", { class: "fine", text: txt });
      const yFmt = (v) => fmt.num(v, v < 10 ? 2 : v < 100 ? 1 : 0);

      // ---- A. spread over time (books only)
      const bookSel = sel.filter((k) => !metaOf(k).route && ts.series[k] && ts.series[k].spread_bps);
      const spreadSeries = logSafe(bookSel.map((k) => ({ name: metaOf(k).label, color: metaOf(k).color, points: points(ts, ts.series[k].spread_bps) })), onHide);
      const spreadChart = hasData(spreadSeries) ? ui.LineChart({ series: spreadSeries, height: 220, table: true, x: xAxis, y: Object.assign({ label: "Spread (bps)", format: yFmt }, state.tsLog ? { log: true } : { min: 0 }), alt: `Spread in basis points every ${Math.round((ts.interval_s || 300) / 60)} minutes for ${bookSel.map((k) => metaOf(k).label).join(", ")}.` })
        : empty("Pick at least one book (Phoenix, Kraken or Coinbase) to see its spread.");

      // ---- B. depth within 2% over time (bids solid, asks dashed)
      const depthSeries = [];
      const zeroDepth = [];
      for (const k of sel) {
        const s = ts.series[k]; if (metaOf(k).route || !s || !s.depth_2pct_usd) continue;
        const m = metaOf(k);
        const b = points(ts, s.depth_2pct_usd, (x) => (Array.isArray(x) ? x[0] : null));
        const a = points(ts, s.depth_2pct_usd, (x) => (Array.isArray(x) ? x[1] : null));
        if (![...b, ...a].some((p) => p[1] !== null && p[1] > 0)) { zeroDepth.push(data.label(k)); continue; }
        depthSeries.push({ name: `${data.label(k)} ▲ bids`, color: m.color, points: b }, { name: `${data.label(k)} ▼ asks`, color: m.color, dash: true, points: a });
      }
      const depthSafe = logSafe(depthSeries, () => {});
      const depthChart = hasData(depthSafe) ? ui.LineChart({ series: depthSafe, height: 220, table: true, x: xAxis, y: Object.assign({ label: "USD within 2%", format: fmt.usdCompact }, state.tsLog ? { log: true } : { min: 0 }), alt: "Dollars resting within 2% of the mid, bids and asks, over time." })
        : empty(zeroDepth.length ? "" : "Pick at least one book to see its depth.");

      // ---- C. cost vs reference over time at one size and side
      const sizesAvail = Array.from(new Set(sel.flatMap((k) => { const c = ts.series[k] && ts.series[k].cost_bps_vs_ref; return c && c[state.tsSide] ? Object.keys(c[state.tsSide]) : []; }))).sort((a, b) => Number(a) - Number(b));
      if (sizesAvail.length && !sizesAvail.includes(state.tsSize)) state.tsSize = sizesAvail.includes("10000") ? "10000" : sizesAvail[0];
      const costSel = sel.filter((k) => { const c = ts.series[k] && ts.series[k].cost_bps_vs_ref; return c && c[state.tsSide] && c[state.tsSide][state.tsSize]; });
      const costSeries = logSafe(costSel.map((k) => { const m = metaOf(k); return { name: m.label, color: m.color, dash: m.dash, points: points(ts, ts.series[k].cost_bps_vs_ref[state.tsSide][state.tsSize]) }; }), onHide);
      const costControls = h("div", { style: S.controls },
        labelled("Side", ui.Segmented({ label: "Side", small: true, value: state.tsSide, options: [{ value: "buy", label: "▲ Buy" }, { value: "sell", label: "▼ Sell" }], onChange: (x) => { state.tsSide = x; drawTs(); } })),
        sizesAvail.length ? labelled("Trade size", ui.Segmented({ label: "Trade size", small: true, value: state.tsSize, options: sizesAvail.map((s) => ({ value: s, label: fmt.usdCompact(Number(s)) })), onChange: (x) => { state.tsSize = x; drawTs(); } })) : null);
      const costChart = hasData(costSeries) ? ui.LineChart({ series: costSeries, height: 240, table: true, x: xAxis, y: Object.assign({ label: "Cost vs ref (bps)", format: yFmt }, state.tsLog ? { log: true } : {}), alt: `Cost of a ${fmt.usdCompact(Number(state.tsSize))} market ${state.tsSide} against the reference mid over time.` })
        : empty("No cost measurements for this selection, side and size.");

      // ---- D. cost by size at one tick
      const tickSlider = ui.Slider({ label: "Tick", min: 0, max: Math.max(1, n - 1), step: 1, value: state.tick, format: (i) => `${hhmm(t[Math.round(i)])} UTC${Math.round(i) === n - 1 ? " (latest)" : ""}`, onInput: (i) => { state.tick = Math.round(i); redrawBySize(); } });
      const bySizeBox = h("div");
      function redrawBySize() {
        const i = state.tick;
        const hid = [];
        const ser = sel.map((k) => {
          const c = ts.series[k] && ts.series[k].cost_bps_vs_ref && ts.series[k].cost_bps_vs_ref[state.tsSide];
          if (!c) return null;
          const m = metaOf(k);
          const pts = Object.keys(c).map(Number).sort((a, b) => a - b).map((u) => { const y = c[String(u)] ? c[String(u)][i] : null; return [u, y === null || y === undefined ? null : y]; });
          return { name: m.label, color: m.color, dash: m.dash, points: pts };
        }).filter(Boolean);
        const safe = logSafe(ser, (s) => { if (!hid.includes(s.name)) hid.push(s.name); });
        put(clear(bySizeBox), hasData(safe)
          ? ui.LineChart({ series: safe, height: 260, table: true, x: { log: true, label: "Trade size (USD)", format: fmt.usdCompact, ticks: PICK }, y: Object.assign({ label: "Cost vs ref (bps)", format: yFmt }, state.tsLog ? { log: true } : {}), alt: `Cost of a market ${state.tsSide} against the reference mid by trade size at ${hhmm(t[i])} UTC.` })
          : empty("No cost measurements for this selection at this tick."),
        hid.length ? h("p", { class: "fine", text: `Not drawn on the log axis (at or below 0 bps, i.e. better than the reference mid): ${hid.join(", ")}. Switch to Linear to see them.` }) : null);
      }
      redrawBySize();

      // ---- Jupiter quotes
      const jq = ds.jupiter || [];
      const jupBox = jq.length ? h("details", null,
        h("summary", { style: "cursor: pointer; color: var(--accent); font-weight: 600; min-height: 36px; display: flex; align-items: center;", text: `The raw Jupiter quotes from the latest tick (${jq.length})` }),
        ui.p("Each row is one quote request: Jupiter was asked for the best way to trade the size, either across every pool (*best*) or through one venue only. The route lists the pools it would use, in order.", "fine"),
        ui.Table({
          caption: "Jupiter quotes: cost in bps against the reference mid", dense: true,
          columns: [
            { label: "Through", align: "left", mono: false, value: (q) => q.dex },
            { label: "Side", align: "left", value: (q) => q.side },
            { label: "Size", value: (q) => fmt.usdCompact(q.usd) },
            { label: "Cost (bps)", value: (q) => (typeof q.cost_bps_vs_ref === "number" ? fmt.num(q.cost_bps_vs_ref, 2) : "–") },
            { label: "Avg price", value: (q) => (typeof q.avg_price === "number" ? "$" + fmt.price(q.avg_price, 3) : "–") },
            { label: "Route", align: "left", mono: false, value: (q) => (q.ok === false ? (/NO_ROUTES/.test(String(q.error || "")) ? "no route found" : "quote failed") : Array.isArray(q.route) && q.route.length ? OBZ.lessons.amm.routeText(q.route) : "–") },
          ],
          rows: jq,
        }))
        : ui.p("This dataset has no Jupiter quotes.", "fine");

      const nTicks = n === 1 ? "1 measurement" : `${n} measurements`;
      // How do the books above relate to these ticks? (Said from the data, not assumed.)
      const snapT = Math.max(0, ...ds.venues.map((v) => v.fetchedAt || 0));
      let when = "";
      if (snapT && snapT < t0 - 60) {
        when = ` They are later moments than the snapshot above (taken at ${hhmm(snapT)} UTC), so the books may have changed since.`;
        const ph = ts.series.phoenix && ts.series.phoenix.spread_bps, s0 = data.snapshot("phoenix");
        const first = ph ? ph.find((x) => typeof x === "number") : undefined;
        const snapSpread = s0 ? s0.spreadBps() : null;
        if (first !== undefined && snapSpread && (first > snapSpread * 2 || first < snapSpread / 2)) when += ` Phoenix's spread, for example, was ${fmt.bps(snapSpread)} in the snapshot and ${fmt.bps(first)} at the first tick.`;
      } else if (snapT && Math.abs(snapT - t1) <= (ts.interval_s || 300)) when = " The books above are from the last of these ticks.";
      put(tsBox, 
        ui.p(`**${nTicks}**, one every ${Math.round((ts.interval_s || 300) / 60)} minutes, from ${hhmm(t0)} to ${hhmm(t1)} UTC on ${day}, recorded by the project's collector.${when} Every cost is measured against the [[reference-mid|reference mid]] at the same tick, so books and AMM routes are comparable. A gap in a line is a tick that wasn't recorded.`, "fine"),
        labelled("Show", picker),
        h("div", { style: S.controls }, labelled("Vertical axis", scale)),
        h("h3", { style: S.h3, text: "Spread over time" }),
        ui.p("The [[spread]] in basis points at each tick. A flat line means the best bid and ask barely moved; a high line means buyers and sellers were far apart.", "fine"),
        spreadChart,
        h("h3", { style: S.h3, text: "Depth within 2% over time" }),
        ui.p("Dollars resting within 2% of each book's mid: bids solid, asks dashed. More depth near the price means big orders move the price less.", "fine"),
        depthChart,
        zeroDepth.length ? h("p", { class: "fine", text: `${zeroDepth.join(", ")}: $0 within 2% at every tick. Its best bid and best ask were both more than 2% from its mid, so nothing rested that close.` }) : null,
        h("h3", { style: S.h3, text: "Cost of one trade size over time" }),
        ui.p("What a market order of the chosen size cost against the reference mid, tick by tick, on each book and through each [[jupiter|Jupiter]] [[route]]. Below 0 means the trade beat the reference price.", "fine"),
        costControls, costChart,
        hiddenNotes.length && state.tsLog ? h("p", { class: "fine", text: `Not drawn on the log axis (at or below 0 bps, i.e. better than the reference mid) at some ticks: ${hiddenNotes.join(", ")}. A gap in those lines is such a point; switch to Linear to see every point.` }) : null,
        h("h3", { style: S.h3, text: "Cost by trade size, at one moment" }),
        ui.p("Pick a tick to see every size at once: the same shape as an [[impact-curve|impact curve]], measured from the reference mid. Lines that stop early had no quote (for example, no route found) at the bigger sizes.", "fine"),
        tickSlider, bySizeBox,
        jupBox);
    }

    /* ---------------------------------------------------------------- wiring */
    function drawAll() {
      bookCache.clear();
      pill.lastChild.textContent = data.active().label;
      for (const [name, fn] of [["summary", drawSummary], ["venue", drawVenue], ["cost", drawCost], ["time series", drawTs]]) {
        try { fn(); } catch (e) { console.error(`OBZ real-books: ${name} failed`, e); }
      }
    }
    drawAll();
    ctx.onData(() => { state.tick = null; drawAll(); });
  }

  OBZ.play.register({
    id: "real-books", order: 2, status: "ready",
    title: "Real books",
    summary: "Real Phoenix, Kraken and Coinbase books, the collector's spread, depth and cost over time, and Jupiter routes. Load your own export too.",
    render,
  });
})(window.OBZ = window.OBZ || {});
