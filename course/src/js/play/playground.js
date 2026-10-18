/* play/playground.js: the Order Book Playground, ported onto the course's engine.
 *
 *   - a live simulation: random makers and takers around a drifting fair value
 *     (speed, share of market orders, volatility and book depth are knobs)
 *   - a queue ladder: every resting order is a block, oldest on the left; click a block to
 *     cancel it, click a price to use it in the ticket; the ticket's sweep is previewed on it
 *   - price history (bid/ask band, mid, trades as dots) and a depth chart
 *   - an order ticket (market or limit, optional 10% price protection) with a dry-run preview,
 *     your resting orders, and the trade tape
 *   - the impact curve of the current book next to an x·y=k pool of equal depth
 *   - venue comparison from the active dataset, "load into engine", load your own export
 *   - an engine trace: what the data structures did, newest first
 *
 * Everything trades through OBZ.engine.OrderBook (the port of orderbook.py). The engine's
 * observer events keep the simulator's bookkeeping (random-cancel index, your orders, the
 * trace) in step without touching the engine itself.
 *
 * Timers: one requestAnimationFrame loop, started only while the simulation runs or the view
 * is dirty, stopped by ctx.onCleanup and whenever the tool leaves the page. Reduced motion:
 * starts paused; Step works; no flashes.
 */
(function (OBZ) {
  "use strict";
  const { h, fmt, clear, clamp, cssVar, reducedMotion, onThemeChange } = OBZ.util;
  const E = OBZ.engine;
  const { BID, ASK } = E;

  const PROTECTION = 0.10;
  const SIZES = E.logSpacedSizes(1e3, 1e6, 8); // 25 sizes, like impact.py
  const PICK = [1e3, 1e4, 1e5, 1e6];
  const TAPE_ROWS = 40, TRACE_ROWS = 40, MAX_CHIPS = 24, HISTORY = 600;

  /* ------------------------------------------------------------------ randomness */
  const rnd = Math.random;
  const gauss = () => { let u = 0; while (!u) u = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd()); };
  const expo = () => -Math.log(1 - rnd());
  const digitsFor = (tick) => Math.max(2, Math.min(4, Math.round(-Math.log10(tick))));
  const sideWord = (s) => (s === BID ? "buy" : "sell");

  /* ------------------------------------------------------------------ the simulator */
  class Sim {
    constructor() {
      this.p = { speed: 60, taker: 0.08, vol: 1, target: 1200 };
      this.running = false;
      this.book = null;
      this.source = { kind: "random", venue: null, label: "" };
      this.mine = new Set();          // ids of your resting orders
      this.ids = []; this.pos = new Map(); // every resting id, for O(1) random cancels
      this.tape = []; this.series = []; this.dots = []; this.trace = [];
      this.changed = new Set();      // "bid:12345" levels touched since the last render
      this.op = null;                // scratch filled by engine events during one command
      this.events = 0; this.trades = 0; this.nextId = 1;
      this.fair = 150; this.anchor = 150; this.spreadUsd = 0.06; this.digits = 2;
      this.traceDirty = true;
      this.obs = (ev) => this.onEngine(ev);
    }

    // ---- bookkeeping driven by the engine's observer events
    track(id) { this.pos.set(id, this.ids.length); this.ids.push(id); }
    untrack(id) {
      const i = this.pos.get(id); if (i === undefined) return;
      const last = this.ids.pop();
      if (last !== id) { this.ids[i] = last; this.pos.set(last, i); }
      this.pos.delete(id);
    }
    onEngine(ev) {
      const op = this.op;
      if (ev.type === "rest") {
        this.track(ev.orderId);
        this.changed.add(ev.side + ":" + ev.priceTicks);
        if (op) op.rested = { fresh: ev.newLevel, position: ev.queuePosition, priceTicks: ev.priceTicks, sizeLots: ev.sizeLots };
      } else if (ev.type === "fill") {
        const makerSide = ev.takerSide === BID ? ASK : BID;
        this.changed.add(makerSide + ":" + ev.priceTicks);
        if (op) op.fills.push({ mine: this.mine.has(ev.makerOrderId), full: ev.full });
        if (ev.full) { this.untrack(ev.makerOrderId); this.mine.delete(ev.makerOrderId); }
      } else if (ev.type === "cancel") {
        this.untrack(ev.orderId); this.mine.delete(ev.orderId);
        this.changed.add(ev.side + ":" + ev.priceTicks);
        if (op) op.emptied = ev.levelRemoved;
      } else if (ev.type === "levelRemoved") {
        if (op) op.levelsRemoved += 1;
      }
    }
    /** Run one engine command and collect what its events said. -> [result, op] */
    run(fn) {
      this.op = { fills: [], levelsRemoved: 0, rested: null, emptied: false };
      let r, op;
      try { r = fn(); } finally { op = this.op; this.op = null; }
      return [r, op];
    }
    log(op, kind, text, cx) {
      this.trace.unshift({ op, kind, text, cx });
      if (this.trace.length > 60) this.trace.length = 60;
      this.traceDirty = true;
    }
    px(ticks) { return ticks === null || ticks === undefined ? "–" : fmt.price(this.book.usd(ticks), this.digits); }
    pxUsd(usd) { return fmt.price(usd, this.digits); }

    // ---- books
    clearHistory() {
      this.mine.clear(); this.tape.length = 0; this.series.length = 0; this.dots.length = 0; this.changed.clear();
      this.events = 0; this.trades = 0;
    }
    newRandom() {
      this.ids = []; this.pos = new Map(); this.nextId = 1;
      this.book = new E.OrderBook({ units: new E.Units("0.01", "0.01"), observer: this.obs });
      this.source = { kind: "random", venue: null, label: "Simulated SOL/USD market (random traders)" };
      this.fair = this.anchor = 150; this.spreadUsd = 0.06; this.digits = 2;
      this.clearHistory();
      const keep = this.p.taker; this.p.taker = Math.min(keep, 0.05);
      for (let i = 0; i < 14000; i++) this.event(false);
      for (let i = 0; i < 120; i++) { for (let j = 0; j < 4; j++) this.event(false); this.sample(); }
      this.p.taker = keep;
      this.events = 0; this.trades = 0; this.tape.length = 0; this.dots.length = 0;
      this.trace.length = 0;
      this.log("RESET", "add", "new random book: about 1,200 resting orders around $150", "warmed up with 14,000 random events through the same engine");
    }
    /** Load a venue of the active dataset. Returns an error message or null. */
    loadVenue(name) {
      const v = OBZ.data.venue(name);
      if (!v) return "That venue is not in the current data.";
      const ids = [], pos = new Map();
      const prev = { ids: this.ids, pos: this.pos };
      this.ids = ids; this.pos = pos;
      let book;
      try { book = OBZ.data.book(name, { observer: this.obs }); } catch (e) { this.ids = prev.ids; this.pos = prev.pos; return `Could not load ${v.label}: ${e.message}`; }
      if (!book || book.mid() === null) { this.ids = prev.ids; this.pos = prev.pos; return `${v.label}'s book is one-sided, so there is no mid to simulate around.`; }
      this.book = book;
      let maxId = 0; for (const id of book.orders.keys()) if (id > maxId) maxId = id;
      this.nextId = maxId + 1;
      const aggregated = v.meta && v.meta.levels === "aggregated";
      const when = v.fetchedAt ? fmt.date(v.fetchedAt) : "unknown time";
      this.source = { kind: "real", venue: name, label: `${v.label} ${v.symbol}, real book fetched ${when}`, aggregated };
      this.digits = digitsFor(book.units.tickSize);
      this.fair = this.anchor = book.mid();
      this.spreadUsd = Math.max(this.fair * 0.0004, book.units.tickSize);
      this.clearHistory();
      this.trace.length = 0;
      const n = book.orders.size;
      this.log("LOAD", "add", `${v.label}: ${fmt.int(n)} ${aggregated ? "price levels, each loaded as one order" : "real resting orders, each loaded as its own block"}`,
        "every order rests on load: an uncrossed book never trades with itself");
      this.sample();
      return null;
    }

    // ---- one random event
    event(verbose) {
      const b = this.book, u = b.units, tick = u.tickSize;
      this.events++;
      const scale = this.anchor / 150;
      this.fair += gauss() * 0.004 * scale * this.p.vol + (this.anchor - this.fair) * 0.0004;
      const bookMid = b.mid();
      const mid = bookMid === null ? this.fair : bookMid;
      if (rnd() < this.p.taker) {
        // Takers lean toward fair value: buy when the book is cheap, sell when it is rich.
        const lean = clamp((this.fair - mid) / (this.spreadUsd * 2) * 0.35, -0.35, 0.35);
        const side = rnd() < 0.5 + lean ? BID : ASK;
        const lots = Math.max(1, Math.round(Math.exp(Math.log(10) + 0.9 * gauss()) / u.lotSize));
        const limit = bookMid === null ? null : E.protectionLimitTicks(tick, side, bookMid, PROTECTION);
        const [fills, op] = this.run(() => b.marketOrder(side, lots, limit));
        this.recordFills(side, fills, op, false);
        if (verbose) {
          const s = summarize(b, fills);
          this.log("MARKET", "fill", fills.length
            ? `${sideWord(side)} ${fmt.sol(b.sol(lots))} SOL → ${fills.length} fill${fills.length === 1 ? "" : "s"}, avg ${this.pxUsd(s.avg)}` + (op.levelsRemoved ? `, ${op.levelsRemoved} level${op.levelsRemoved > 1 ? "s" : ""} emptied` : "")
            : `${sideWord(side)} ${fmt.sol(b.sol(lots))} SOL → nothing to trade within 10% of the mid`,
          "walk from the best price; each fill takes the head (oldest order) of its level");
        }
        return;
      }
      const n = this.ids.length;
      if (n && rnd() < n / (n + this.p.target)) {
        const id = this.ids[Math.floor(rnd() * n)];
        if (this.mine.has(id)) return; // the crowd never cancels your orders
        const o = b.orders.get(id);
        if (!o) { this.untrack(id); return; }
        const side = o.side, price = o.priceTicks;
        const [, op] = this.run(() => b.cancelOrder(id));
        if (verbose) this.log("CANCEL", "cxl", `#${id} ${side} ${this.px(price)}` + (op.emptied ? " (last order: level removed)" : ""),
          op.emptied ? "id map → node, unlink: O(1); remove the price from the sorted map: O(log L)" : "id map → node, unlink prev/next: O(1)");
        return;
      }
      const side = rnd() < 0.5 ? BID : ASK;
      const dist = Math.max(tick, expo() * this.spreadUsd);
      const px = side === BID ? this.fair - dist : this.fair + dist;
      const price = side === BID ? Math.floor(px / tick) : Math.ceil(px / tick);
      if (!(price > 0)) return;
      const lots = Math.max(1, Math.round(Math.exp(Math.log(14) + 0.9 * gauss()) / u.lotSize));
      const id = this.nextId++;
      const [fills, op] = this.run(() => b.addOrder(id, side, price, lots));
      if (fills.length) this.recordFills(side, fills, op, false);
      if (verbose) {
        if (fills.length) this.log("LIMIT", "fill", `#${id} ${side} ${this.px(price)} crossed the spread: ${fills.length} fill${fills.length > 1 ? "s" : ""}` + (op.rested ? ", the rest rests" : ""), "a limit order matches like a taker up to its price, then rests");
        else if (op.rested) this.log("ADD", "add", `#${id} ${side} ${fmt.sol(b.sol(lots))} SOL @ ${this.px(price)} → position ${op.rested.position} in the queue`,
          op.rested.fresh ? "new price: insert into the sorted map O(log L), start a list" : "existing price: append at the tail of its list, O(1)");
      }
    }
    recordFills(side, fills, op, mineTaker) {
      const b = this.book;
      fills.forEach((f, i) => {
        const makerMine = !!(op && op.fills[i] && op.fills[i].mine);
        const price = b.usd(f.priceTicks);
        this.trades++;
        this.tape.unshift({ price, sol: b.sol(f.sizeLots), side, mine: mineTaker, makerMine });
        this.dots.push({ i: this.series.length, price, side, mine: mineTaker || makerMine });
      });
      if (this.tape.length > 80) this.tape.length = 80;
      if (this.dots.length > 3000) this.dots.splice(0, this.dots.length - 3000);
    }
    sample() {
      const b = this.book, bb = b.bestBid(), ba = b.bestAsk();
      if (bb === null || ba === null) return;
      this.series.push({ bid: b.usd(bb), ask: b.usd(ba), mid: b.mid() });
      if (this.series.length > HISTORY) {
        const cut = this.series.length - HISTORY;
        this.series.splice(0, cut);
        for (const d of this.dots) d.i -= cut;
        while (this.dots.length && this.dots[0].i < 0) this.dots.shift();
      }
    }
  }

  /** fills -> {lots, sol, usd, avg, levels, makers} */
  function summarize(book, fills) {
    let lots = 0, usd = 0; const lv = new Set();
    for (const f of fills) { lots += f.sizeLots; usd += book.usd(f.priceTicks) * book.sol(f.sizeLots); lv.add(f.priceTicks); }
    const sol = book.sol(lots);
    return { lots, sol, usd, avg: lots ? usd / sol : null, levels: lv.size, makers: fills.length };
  }

  /* ------------------------------------------------------------------ small DOM helpers */
  const S = {
    card: "background: var(--panel); border: 1px solid var(--line); border-radius: var(--r-lg); padding: clamp(12px, 3vw, 20px); min-width: 0; display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--s-3); align-content: start;",
    head: "display: flex; flex-wrap: wrap; justify-content: space-between; align-items: baseline; gap: var(--s-1) var(--s-3);",
    h2: "font-size: var(--fs-md); margin: 0;",
    grid: (min) => `display: grid; gap: var(--s-4); align-items: start; grid-template-columns: repeat(auto-fit, minmax(min(100%, ${min}px), 1fr));`,
  };
  function card(title, hint, ...children) {
    return h("section", { style: S.card, attrs: { "aria-label": title } },
      h("div", { style: S.head }, h("h2", { style: S.h2, text: title }), hint ? h("span", { class: "fine", text: hint }) : null),
      ...children);
  }
  function field(labelText, input, note) {
    const id = input.id || (input.id = OBZ.util.uid("pg"));
    return h("div", { style: "display: grid; gap: 4px; min-width: 0;" },
      h("label", { attrs: { for: id }, class: "fine", style: "font-weight: 600; color: var(--ink-2);", text: labelText }),
      input, note ? h("span", { class: "fine", text: note }) : null);
  }
  function checkbox(labelText, checked, onChange) {
    const id = OBZ.util.uid("pgc");
    const input = h("input", { type: "checkbox", id, checked: !!checked, style: "width: 18px; height: 18px; accent-color: var(--accent); margin: 0; flex: none;", on: { change: () => onChange(input.checked) } });
    const el = h("label", { attrs: { for: id }, style: "display: inline-flex; align-items: center; gap: 8px; min-height: 32px; cursor: pointer; font-size: var(--fs-sm); color: var(--ink-2);" }, input, h("span", null, OBZ.ui.rich(labelText)));
    el.input = input;
    return el;
  }

  /* ------------------------------------------------------------------ the queue ladder */
  /**
   * One row per price level, one block per resting order (oldest on the left, the head of
   * the queue fills first). Rows and blocks are created once and reused, so a 60 events/s
   * simulation only rewrites a few attributes per frame. Keyboard: one Tab stop; arrow keys
   * move (up/down between rows, left/right between the price and the blocks), Enter or
   * Delete cancels the focused block, Enter on a price copies it into the ticket.
   */
  function QueueLadder({ onCancel, onPrice }) {
    const coarse = OBZ.util.isCoarse();
    const ROW_H = coarse ? 34 : 26;
    const COLS = "1.3em 5.4em 4.9em minmax(0, 1fr)";
    const rowsEl = h("div", { attrs: { role: "group", "aria-label": "Order queues. Arrow keys move, Enter cancels a block or uses a price." }, style: "display: grid; gap: 2px;" });
    const head = h("div", { attrs: { "aria-hidden": "true" }, style: `display: grid; grid-template-columns: ${COLS}; gap: 6px; padding: 0 4px 4px; font-size: var(--fs-xs); color: var(--muted); font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; font-family: var(--f-body);` },
      h("span", { text: "" }), h("span", { text: "Price ($)" }), h("span", { style: "text-align: right;", text: "SOL" }), h("span", { text: "Queue →" }));
    const el = h("div", { style: "font-family: var(--f-mono); font-variant-numeric: tabular-nums; font-size: 0.82rem; min-width: 0;" }, head, rowsEl);
    let rows = [], mid = null, nPerSide = 0;
    let focus = null; // {r: row index, c: cell index (0 = price, 1.. = blocks)}
    let press = null, keyActAt = 0;
    let flashOn = !reducedMotion();
    let softFlash = "";

    function makeRow(side) {
      const glyph = h("span", { attrs: { "aria-hidden": "true" }, style: `font-size: 0.75rem; font-weight: 700; color: var(--${side});`, text: side === ASK ? "▼" : "▲" });
      const price = h("button", { type: "button", tabIndex: -1, dataset: { cell: "price" }, style: `font: inherit; font-weight: 600; color: var(--${side}); background: none; border: 0; padding: 0 2px; text-align: left; cursor: pointer; min-height: ${ROW_H - 4}px; border-radius: var(--r-xs);` });
      const size = h("span", { style: "text-align: right; color: var(--ink-2);" });
      const more = h("span", { attrs: { "aria-hidden": "true" }, style: "flex: none; font-size: 0.7rem; color: var(--muted); align-self: center; padding-left: 3px;" });
      const bar = h("div", { style: `display: flex; gap: 1px; height: ${ROW_H - 8}px; min-width: 0; overflow: hidden; align-items: stretch;` }, more);
      const row = h("div", { style: `display: grid; grid-template-columns: ${COLS}; gap: 6px; align-items: center; padding: 0 4px; min-height: ${ROW_H}px; border-radius: var(--r-xs);` }, glyph, price, size, bar);
      return { side, row, price, size, bar, more, chips: [], priceTicks: null, key: "" };
    }
    function makeChip(side) {
      return h("button", { type: "button", tabIndex: -1, dataset: { cell: "chip" },
        style: `flex: none; min-width: 3px; height: 100%; border: 0; padding: 0; border-radius: 2px; cursor: pointer; background: var(--${side}-soft); box-shadow: inset 0 0 0 1px var(--${side});` });
    }
    function build(n) {
      nPerSide = n;
      clear(rowsEl); rows = [];
      for (let i = 0; i < n; i++) { const r = makeRow(ASK); rows.push(r); rowsEl.appendChild(r.row); }
      mid = h("div", { style: "display: flex; flex-wrap: wrap; justify-content: space-between; gap: 2px 10px; padding: 6px 4px; margin: 3px 0; border-block: 1px dashed var(--line-strong); color: var(--muted); font-size: 0.78rem;" });
      rowsEl.appendChild(mid);
      for (let i = 0; i < n; i++) { const r = makeRow(BID); rows.push(r); rowsEl.appendChild(r.row); }
    }

    /** levels per side; pv = ticket preview ({eaten: Map id -> fill}) or null */
    function update(book, pv, digits, changed, me) {
      const want = window.innerWidth < 600 ? 7 : 10;
      if (want !== nPerSide) build(want);
      const hadFocus = el.contains(document.activeElement);
      const n = nPerSide;
      const asks = book.levelPrices(ASK).slice(0, n), bids = book.levelPrices(BID).slice(0, n);
      let max = 1;
      for (const p of asks) max = Math.max(max, book.level(ASK, p).totalSize);
      for (const p of bids) max = Math.max(max, book.level(BID, p).totalSize);
      softFlash = flashOn && changed.size ? cssVar("--panel-3") : "";
      const sweptPrices = pv ? new Set(pv.dry.fills.map((f) => f.priceTicks)) : null;
      // ask rows: farthest ask on top, best ask just above the mid row
      for (let i = 0; i < n; i++) fillRow(rows[i], ASK, asks[n - 1 - i], book, pv, sweptPrices, digits, max, changed, me);
      for (let i = 0; i < n; i++) fillRow(rows[n + i], BID, bids[i], book, pv, sweptPrices, digits, max, changed, me);
      const bb = book.bestBid(), ba = book.bestAsk(), m = book.mid();
      clear(mid);
      if (bb !== null && ba !== null) {
        const spr = book.usd(ba) - book.usd(bb);
        mid.append(h("span", null, "mid ", h("b", { style: "color: var(--ink);", text: "$" + fmt.price(m, Math.max(3, digits)) })),
          h("span", null, "spread ", h("b", { style: "color: var(--ink);", text: "$" + fmt.price(spr, digits) }), " · " + fmt.bps(spr / m * 1e4)));
      } else mid.textContent = "One side of the book is empty.";
      ensureTabStop(hadFocus);
    }

    function fillRow(r, side, priceTicks, book, pv, swept, digits, max, changed, me) {
      if (priceTicks === undefined) {
        r.priceTicks = null; r.row.style.visibility = "hidden"; r.price.textContent = ""; r.size.textContent = "";
        for (const c of r.chips) c.hidden = true;
        r.more.textContent = "";
        return;
      }
      r.row.style.visibility = "";
      const lv = book.level(side, priceTicks);
      const priceText = fmt.price(book.usd(priceTicks), digits);
      if (r.priceTicks !== priceTicks) {
        r.priceTicks = priceTicks;
        r.price.textContent = priceText;
        r.price.setAttribute("aria-label", `${side === ASK ? "Ask" : "Bid"} $${priceText}: use this price in the ticket`);
      }
      r.size.textContent = fmt.sol(book.sol(lv.totalSize));
      r.row.style.boxShadow = swept && swept.has(priceTicks) ? "inset 3px 0 0 var(--accent)" : "";
      r.row.style.background = swept && swept.has(priceTicks) ? "var(--panel-2)" : "";
      let k = 0;
      for (let o = lv.head; o && k < MAX_CHIPS; o = o.next, k++) {
        let c = r.chips[k];
        if (!c) { c = makeChip(side); r.chips.push(c); r.bar.insertBefore(c, r.more); }
        c.hidden = false;
        const mine = me.has(o.orderId);
        const f = pv && pv.eaten.get(o.orderId);
        const state = (mine ? "m" : "") + (f ? (f.sizeLots >= o.sizeLots ? "e" : "p" + Math.round(f.sizeLots / o.sizeLots * 100)) : "") + (k === 0 ? "h" : "");
        const key = o.orderId + ":" + o.sizeLots + ":" + state + ":" + max;
        if (c._key === key) continue;
        c._key = key;
        c.dataset.id = String(o.orderId);
        c.style.width = (o.sizeLots / max * 100).toFixed(2) + "%";
        const base = mine ? "var(--mine-soft)" : `var(--${side}-soft)`;
        if (f && f.sizeLots >= o.sizeLots) c.style.background = "var(--accent)";
        else if (f) { const cut = (f.sizeLots / o.sizeLots * 100).toFixed(1); c.style.background = `linear-gradient(90deg, var(--accent) 0 ${cut}%, ${base} ${cut}%)`; }
        else c.style.background = base;
        c.style.boxShadow = mine ? "inset 0 0 0 2px var(--mine)" : k === 0 ? "inset 0 0 0 1.5px var(--ink)" : `inset 0 0 0 1px var(--${side})`;
        c.style.opacity = f && f.sizeLots >= o.sizeLots ? "0.8" : "";
        const label = `Order #${o.orderId}, ${fmt.sol(book.sol(o.sizeLots))} SOL, number ${k + 1} in the queue${k === 0 ? " (fills first)" : ""}${mine ? ", yours" : ""}${f ? (f.sizeLots >= o.sizeLots ? ", your ticket would fill it" : ", your ticket would fill part of it") : ""}. Press to cancel.`;
        c.setAttribute("aria-label", label);
        c.title = label;
      }
      for (let j = k; j < r.chips.length; j++) r.chips[j].hidden = true;
      r.more.textContent = lv.count > k ? "+" + (lv.count - k) : "";
      const key = side + ":" + priceTicks;
      if (softFlash && changed.has(key) && r.row.animate) {
        try {
          if (r.anim) r.anim.cancel(); // one flash per row at a time, never a pile-up
          r.anim = r.row.animate([{ backgroundColor: softFlash }, { backgroundColor: "transparent" }], { duration: 400, easing: "ease-out" });
        } catch (e) { flashOn = false; }
      }
    }

    // ---- keyboard: a roving tab stop over rows x cells
    function cellsOf(r) { if (r.priceTicks === null) return []; return [r.price].concat(r.chips.filter((c) => !c.hidden)); }
    function visibleRows() { return rows.map((r, i) => i).filter((i) => rows[i].priceTicks !== null); }
    function ensureTabStop(hadFocus) {
      for (const r of rows) { r.price.tabIndex = -1; for (const c of r.chips) c.tabIndex = -1; }
      const vis = visibleRows();
      if (!vis.length) return;
      let ri = focus ? focus.r : vis[Math.max(0, vis.indexOf(nPerSide - 1)) ] ;
      if (!rows[ri] || rows[ri].priceTicks === null) ri = vis.reduce((best, i) => (Math.abs(i - ri) < Math.abs(best - ri) ? i : best), vis[0]);
      const cells = cellsOf(rows[ri]);
      const ci = focus ? Math.min(focus.c, cells.length - 1) : 0;
      const target = cells[ci];
      target.tabIndex = 0;
      if (hadFocus && document.activeElement !== target) target.focus({ preventScroll: true });
      if (focus) { focus.r = ri; focus.c = ci; }
    }
    function locate(node) {
      for (let i = 0; i < rows.length; i++) {
        const cells = cellsOf(rows[i]);
        const j = cells.indexOf(node);
        if (j >= 0) return { r: i, c: j };
      }
      return null;
    }
    function act(node) {
      if (!node) return;
      if (node.dataset.cell === "chip" && node.dataset.id) onCancel(Number(node.dataset.id));
      else if (node.dataset.cell === "price") {
        const loc = locate(node);
        if (loc) onPrice(rows[loc.r].side, rows[loc.r].priceTicks);
      }
    }
    rowsEl.addEventListener("focusin", (e) => { const loc = locate(e.target); if (loc) focus = loc; });
    rowsEl.addEventListener("keydown", (e) => {
      const loc = locate(document.activeElement);
      if (!loc) return;
      const vis = visibleRows();
      let { r, c } = loc;
      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        const idx = vis.indexOf(r) + (e.key === "ArrowUp" ? -1 : 1);
        if (idx < 0 || idx >= vis.length) { e.preventDefault(); return; }
        r = vis[idx]; c = Math.min(c, cellsOf(rows[r]).length - 1);
      } else if (e.key === "ArrowLeft") c = Math.max(0, c - 1);
      else if (e.key === "ArrowRight") c = Math.min(cellsOf(rows[r]).length - 1, c + 1);
      else if (e.key === "Home") c = 0;
      else if (e.key === "End") c = cellsOf(rows[r]).length - 1;
      else if (e.key === "Enter" || e.key === " " || e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        if ((e.key === "Delete" || e.key === "Backspace") && document.activeElement.dataset.cell !== "chip") return;
        keyActAt = performance.now();
        act(document.activeElement);
        return;
      } else return;
      e.preventDefault();
      focus = { r, c };
      const cells = cellsOf(rows[r]);
      for (const x of cellsOf(rows[loc.r])) x.tabIndex = -1;
      cells[c].tabIndex = 0; cells[c].focus({ preventScroll: false });
    });
    // Pointer: act on release if the pointer barely moved (so a touch scroll never cancels).
    rowsEl.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      const t = e.target.closest("button[data-cell]");
      if (!t) return;
      press = { id: t.dataset.cell === "chip" ? Number(t.dataset.id) : null, node: t, x: e.clientX, y: e.clientY, pid: e.pointerId, loc: locate(t) };
    });
    rowsEl.addEventListener("pointerup", (e) => {
      const p = press; press = null;
      if (!p || p.pid !== e.pointerId || Math.hypot(e.clientX - p.x, e.clientY - p.y) > 10) return;
      if (p.id !== null) onCancel(p.id);
      else if (p.loc) onPrice(rows[p.loc.r].side, rows[p.loc.r].priceTicks);
    });
    rowsEl.addEventListener("pointercancel", () => { press = null; });
    // Assistive tech "clicks" (no pointer, no key event we saw): detail 0.
    rowsEl.addEventListener("click", (e) => { if (e.detail === 0 && performance.now() - keyActAt > 600) { const t = e.target.closest("button[data-cell]"); if (t) act(t); } });

    el.api = { update };
    return el;
  }

  /* ------------------------------------------------------------------ price history canvas */
  function PriceChart() {
    const cv = h("canvas", { class: "chart-canvas", attrs: { role: "img", "aria-label": "Price history" } });
    const box = h("div", { class: "chart", style: { height: "200px" } }, cv);
    const dot = (c) => h("span", { attrs: { "aria-hidden": "true" }, style: `display: inline-block; width: 9px; height: 9px; border-radius: 50%; background: var(${c});` });
    const legend = h("ul", { class: "legend" },
      h("li", null, h("span", { class: "legend-line", style: { "--c": "var(--ink)" } }), "mid"),
      h("li", null, h("span", { class: "legend-line", style: { "--c": "var(--ask)" } }), "▼ best ask"),
      h("li", null, h("span", { class: "legend-line", style: { "--c": "var(--bid)" } }), "▲ best bid"),
      h("li", null, dot("--bid"), dot("--ask"), "trades (buy / sell)"),
      h("li", null, dot("--mine"), "yours"));
    const el = h("div", { class: "chart-wrap" }, legend, box);
    let T = null, last = null;
    const theme = () => { T = { ink: cssVar("--ink"), muted: cssVar("--muted"), grid: cssVar("--grid"), bid: cssVar("--bid"), ask: cssVar("--ask"), accentSoft: cssVar("--accent-soft"), mine: cssVar("--mine"), mono: cssVar("--f-mono") || "monospace" }; };
    function draw(sim) {
      if (sim) last = sim; else sim = last;
      if (!sim || !cv.isConnected) return;
      if (!T) theme();
      const r = cv.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
      const w = Math.max(1, Math.round(r.width)), H = Math.max(1, Math.round(r.height));
      if (cv.width !== w * dpr || cv.height !== H * dpr) { cv.width = w * dpr; cv.height = H * dpr; }
      const ctx = cv.getContext("2d");
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, H);
      const L = w < 420 ? 50 : 58, R = 8, Tp = 8, B = 20;
      const series = sim.series, d = sim.digits;
      ctx.font = `${w < 420 ? 10 : 11}px ${T.mono}`;
      if (series.length < 2) {
        ctx.fillStyle = T.muted; ctx.textBaseline = "middle"; ctx.fillText("Press Play (or Step) to build a price history.", 8, H / 2);
        cv.setAttribute("aria-label", "Price history: empty until the simulation runs.");
        return;
      }
      let lo = Infinity, hi = -Infinity;
      for (const s of series) { lo = Math.min(lo, s.bid); hi = Math.max(hi, s.ask); }
      const pad = Math.max((hi - lo) * 0.15, sim.book.units.tickSize * 2); lo -= pad; hi += pad;
      const n = Math.max(series.length, 200);
      const X = (i) => L + (i / (n - 1)) * (w - L - R);
      const Y = (p) => Tp + (1 - (p - lo) / (hi - lo)) * (H - Tp - B);
      ctx.lineWidth = 1; ctx.textBaseline = "middle"; ctx.textAlign = "right";
      for (let k = 0; k <= 4; k++) { const p = lo + (hi - lo) * k / 4, y = Y(p); ctx.strokeStyle = T.grid; ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(w - R, y); ctx.stroke(); ctx.fillStyle = T.muted; ctx.fillText(fmt.price(p, d), L - 6, y); }
      // the spread band between best bid and best ask
      ctx.beginPath();
      series.forEach((s, i) => (i ? ctx.lineTo(X(i), Y(s.ask)) : ctx.moveTo(X(i), Y(s.ask))));
      for (let i = series.length - 1; i >= 0; i--) ctx.lineTo(X(i), Y(series[i].bid));
      ctx.closePath(); ctx.fillStyle = T.accentSoft; ctx.fill();
      for (const [key, col] of [["ask", T.ask], ["bid", T.bid]]) {
        ctx.beginPath(); ctx.strokeStyle = col; ctx.lineWidth = 1;
        series.forEach((s, i) => (i ? ctx.lineTo(X(i), Y(s[key])) : ctx.moveTo(X(i), Y(s[key])))); ctx.stroke();
      }
      ctx.beginPath(); ctx.strokeStyle = T.ink; ctx.lineWidth = 1.5;
      series.forEach((s, i) => (i ? ctx.lineTo(X(i), Y(s.mid)) : ctx.moveTo(X(i), Y(s.mid)))); ctx.stroke();
      for (const dt of sim.dots) {
        if (dt.i < 0 || dt.price < lo || dt.price > hi) continue;
        ctx.beginPath(); ctx.arc(X(dt.i), Y(dt.price), dt.mine ? 4 : 2, 0, Math.PI * 2);
        ctx.fillStyle = dt.mine ? T.mine : dt.side === BID ? T.bid : T.ask; ctx.fill();
      }
      ctx.fillStyle = T.muted; ctx.textBaseline = "alphabetic"; ctx.textAlign = "left"; ctx.fillText("← older", L, H - 4);
      ctx.textAlign = "right"; ctx.fillText("now", w - R, H - 4);
      const s = series[series.length - 1];
      cv.setAttribute("aria-label", `Price history of the last ${series.length} samples: mid now $${fmt.price(s.mid, Math.max(3, d))}, best bid $${fmt.price(s.bid, d)}, best ask $${fmt.price(s.ask, d)}, range $${fmt.price(lo + pad, d)} to $${fmt.price(hi - pad, d)}.`);
    }
    el.api = { draw, theme: () => { theme(); draw(); } };
    return el;
  }

  /* ------------------------------------------------------------------ the tool */
  function render(el, ctx) {
    const { ui, data } = ctx;
    const still = reducedMotion();
    const sim = new Sim();
    let alive = true, seen = false, raf = 0, lastT = 0, acc = 0, lastRender = 0, lastSample = 0, lastSlow = 0;
    const dirty = { all: true, slow: true };
    const offs = [];

    /* ---------------- intro + source */
    const intro = ui.prose(`This is a working [[order-book|order book]] that you can poke. Random traders keep it moving: some post [[limit-order|limit orders]] that rest in the book, some cancel, and some send [[market-order|market orders]] that trade at once. You can do all three yourself in the order ticket.

Everything runs through this course's [[matching-engine|matching engine]], a JavaScript port of the project's \`orderbook.py\` that reproduces its fills exactly, with [[price-time-priority|price-time priority]]: best price first, and at one price the oldest order first.`);
    const sourcePill = h("p", { class: "source-pill", attrs: { "aria-live": "polite" } }, h("span", { class: "dot", attrs: { "aria-hidden": "true" } }), h("span"));
    const loadMsg = h("p", { class: "fine", attrs: { "aria-live": "polite" } });
    let startPicker = null;
    const startBox = h("div");
    function mountStart() {
      const opts = [{ value: "random", label: "Random book" }].concat(data.venues().map((v, i) => ({ value: v, label: "Real " + data.label(v), color: data.colorVar(v, i) })));
      startPicker = ui.Segmented({ label: "Start from", options: opts, value: sim.source.kind === "random" ? "random" : sim.source.venue, onChange: (v) => startFrom(v) });
      clear(startBox).appendChild(h("div", { style: "display: grid; gap: 6px;" }, h("span", { class: "fine", style: "font-weight: 600; color: var(--ink-2);", text: "Start from" }), startPicker));
    }
    function startFrom(v) {
      loadMsg.textContent = "";
      if (v === "random") { sim.newRandom(); }
      else {
        const err = sim.loadVenue(v);
        if (err) { loadMsg.textContent = err; if (startPicker) startPicker.api.set(sim.source.kind === "random" ? "random" : sim.source.venue); return; }
        const vv = data.venue(v);
        loadMsg.textContent = sim.source.aggregated
          ? `${vv.label} publishes one total per price, so each level is one block. The crowd's random orders now arrive around its real mid.`
          : `${vv.label}'s book is loaded order by order: every block is a real resting order. The crowd's random orders now arrive around its real mid.`;
        setRunning(false);
      }
      if (startPicker) startPicker.api.set(v);
      afterBookChange();
    }

    /* ---------------- controls */
    const playBtn = ui.Button({ label: "▶ Play", variant: "primary", onClick: () => setRunning(!sim.running) });
    const stepBtn = ui.Button({ label: "Step one event", onClick: () => { setRunning(false); sim.event(true); sim.sample(); markDirty(true); } });
    const resetBtn = ui.Button({ label: "New random book", onClick: () => startFrom("random") });
    const speed = ui.Slider({ label: "Speed", min: 1, max: 1000, log: true, value: sim.p.speed, format: (v) => fmt.int(v) + " events/s", onInput: (v) => { sim.p.speed = Math.max(1, Math.round(v)); } });
    const taker = ui.Slider({ label: "Market orders", min: 0, max: 30, step: 1, value: 8, format: (v) => v + "% of events", onInput: (v) => { sim.p.taker = v / 100; } });
    const vol = ui.Slider({ label: "Volatility", min: 0, max: 4, step: 0.1, value: 1, format: (v) => Number(v).toFixed(1) + "×", onInput: (v) => { sim.p.vol = v; } });
    const depth = ui.Slider({ label: "Book depth", min: 100, max: 2000, step: 50, value: 1200, format: (v) => fmt.int(v) + " orders", onInput: (v) => { sim.p.target = v; } });
    const motionNote = h("p", { class: "fine" }, still
      ? "Your device asks for reduced motion, so the simulation starts paused. Press Play to run it, or Step one event at a time."
      : "Below 6 events/s every event is written to the engine trace at the bottom. Step pauses and runs exactly one event.");
    function setRunning(on) {
      sim.running = on;
      playBtn.textContent = on ? "❚❚ Pause" : "▶ Play";
      playBtn.setAttribute("aria-pressed", String(on));
      lastT = 0;
      if (on) schedule();
    }

    /* ---------------- stats */
    const st = {
      mid: ui.Stat({ label: "Mid" }), spread: ui.Stat({ label: "Spread", tone: "accent" }),
      bid: ui.Stat({ label: "Best bid ▲", tone: "bid" }), ask: ui.Stat({ label: "Best ask ▼", tone: "ask" }),
      orders: ui.Stat({ label: "Resting orders" }), levels: ui.Stat({ label: "Price levels" }),
      events: ui.Stat({ label: "Events" }), trades: ui.Stat({ label: "Trades" }),
    };
    const statGrid = ui.StatGrid(Object.values(st));
    statGrid.style.gridTemplateColumns = "repeat(auto-fit, minmax(min(100%, 118px), 1fr))";
    function renderStats() {
      const b = sim.book, m = b.mid(), bb = b.bestBid(), ba = b.bestAsk();
      st.mid.api.set(m === null ? "–" : "$" + fmt.price(m, Math.max(3, sim.digits)), "(bid + ask) ÷ 2");
      st.spread.api.set(m === null ? "–" : fmt.bps(b.spreadBps()), m === null ? "" : "$" + fmt.price(b.usd(ba) - b.usd(bb), sim.digits));
      st.bid.api.set(bb === null ? "–" : "$" + sim.px(bb), bb === null ? "" : fmt.sol(b.sol(b.level(BID, bb).totalSize)) + " SOL");
      st.ask.api.set(ba === null ? "–" : "$" + sim.px(ba), ba === null ? "" : fmt.sol(b.sol(b.level(ASK, ba).totalSize)) + " SOL");
      st.orders.api.set(fmt.int(b.orders.size), sim.mine.size ? `${sim.mine.size} yours` : "");
      st.levels.api.set(`${fmt.int(b.bids.size)} / ${fmt.int(b.asks.size)}`, "bid / ask");
      st.events.api.set(fmt.int(sim.events), sim.running ? "running" : "paused");
      st.trades.api.set(fmt.int(sim.trades), "");
    }

    /* ---------------- ladder */
    const ladder = QueueLadder({
      onCancel: (id) => {
        const b = sim.book, o = b.orders.get(id);
        if (!o) return;
        const mine = sim.mine.has(id), side = o.side, price = o.priceTicks;
        const [, op] = sim.run(() => b.cancelOrder(id));
        sim.log(mine ? "YOU" : "CANCEL", mine ? "you" : "cxl", `you cancelled #${id} (${side} ${fmt.sol(b.sol(o.sizeLots))} SOL at ${sim.px(price)})` + (op.emptied ? ", the last order there, so the level is removed" : ""),
          "id map → node, then unlink prev/next: O(1)" + (op.emptied ? "; remove the price from the sorted map: O(log L)" : ""));
        markDirty(true);
      },
      onPrice: (side, priceTicks) => {
        setKind("limit");
        priceIn.value = sim.px(priceTicks);
        markDirty();
      },
    });
    const ladderCard = card("Order ladder", "price · SOL · queue",
      h("ul", { class: "legend", style: "font-size: var(--fs-xs);" },
        h("li", null, h("span", { attrs: { "aria-hidden": "true" }, style: "display: inline-block; width: 14px; height: 10px; border-radius: 2px; box-shadow: inset 0 0 0 1.5px var(--ink);" }), "head of the queue (fills first)"),
        h("li", null, h("span", { attrs: { "aria-hidden": "true" }, style: "display: inline-block; width: 14px; height: 10px; border-radius: 2px; background: var(--mine-soft); box-shadow: inset 0 0 0 2px var(--mine);" }), "your orders"),
        h("li", null, h("span", { attrs: { "aria-hidden": "true" }, style: "display: inline-block; width: 14px; height: 10px; border-radius: 2px; background: var(--accent);" }), "your ticket would fill it")),
      ladder,
      ui.p("Each block is one resting order, oldest on the left; its width is its size. **Click a block to cancel it**; click a price to put it in the ticket. Keyboard: Tab into the ladder, arrows to move, Enter to act. Pausing first makes it easier to aim.", "fine"));

    /* ---------------- charts */
    const price = PriceChart();
    let band = 0.005;
    const depthChart = ui.DepthChart({ levels: { bids: [], asks: [] }, band, unit: "sol", height: 170, alt: "Depth chart of the simulated book: cumulative SOL on each side of the mid." });
    // The simulation redraws this many times a second; announcing every redraw would flood a screen reader.
    const depthNote = depthChart.querySelector(".chart-readout"); if (depthNote) depthNote.removeAttribute("aria-live");
    const priceCard = card("Price", "bid/ask band, mid, trades",
      ui.p("The shaded band is the [[spread]] between the [[best-bid|best bid]] and [[best-ask|best ask]], the dark line is the [[mid-price|mid]], and each dot is a trade.", "fine"),
      price);
    const depthCard = card("Depth", "cumulative SOL from the mid",
      ui.p("Starting at the mid, the green area adds up every bid and the red area every ask: a [[depth-chart|depth chart]]. The accent line marks how far your ticket's order would reach.", "fine"),
      depthChart);
    function chooseBand() {
      const b = sim.book, m = b.mid(); if (m === null) return band;
      const bp = b.levelPrices(BID), ap = b.levelPrices(ASK);
      const k = Math.min(60, Math.min(bp.length, ap.length) - 1);
      let r = 0.003;
      if (k > 0) r = Math.max(Math.abs(b.usd(bp[k]) - m), Math.abs(b.usd(ap[k]) - m)) / m;
      for (const nice of [0.001, 0.002, 0.005, 0.01, 0.02, 0.05]) if (r <= nice) return nice;
      return 0.05;
    }

    /* ---------------- ticket */
    const t = { side: BID, kind: "market", usd: 10000, protect: true };
    const sideSeg = ui.Segmented({ label: "Side", value: BID, options: [{ value: BID, label: "▲ Buy" }, { value: ASK, label: "▼ Sell" }], onChange: (v) => { t.side = v; markDirty(); } });
    const kindSeg = ui.Segmented({ label: "Order type", value: "market", options: [{ value: "market", label: "Market" }, { value: "limit", label: "Limit" }], onChange: (v) => setKind(v) });
    const usdIn = h("input", { type: "number", class: "input mono", min: "1", step: "100", value: "10000", inputMode: "decimal" });
    const usdSlider = ui.Slider({ label: "Trade size", min: 100, max: 1e6, log: true, value: 10000, format: fmt.usdCompact, onInput: (v) => { const step = Math.pow(10, Math.floor(Math.log10(v)) - 1); setUsd(Math.round(v / step) * step, true); } });
    const quick = h("div", { class: "btn-row" }, PICK.map((u) => ui.Button({ label: fmt.usdCompact(u), small: true, onClick: () => setUsd(u) })));
    const protect = checkbox("[[price-protection|Price protection]]: never trade more than 10% from the mid", true, (on) => { t.protect = on; markDirty(); });
    const usdField = field("Spend (USD)", usdIn);
    const marketBox = h("div", { style: "display: grid; gap: var(--s-2);" }, usdField, usdSlider, quick, protect);
    const priceIn = h("input", { type: "number", class: "input mono", min: "0", step: "0.01", inputMode: "decimal" });
    const sizeIn = h("input", { type: "number", class: "input mono", min: "0", step: "0.1", value: "25", inputMode: "decimal" });
    const limitBox = h("div", { style: "display: grid; gap: var(--s-2); grid-template-columns: repeat(auto-fit, minmax(min(100%, 140px), 1fr));", hidden: true }, field("Limit price (USD)", priceIn), field("Size (SOL)", sizeIn));
    const preview = h("div", { class: "readout-panel", style: "font-size: var(--fs-sm);" });
    const submit = ui.Button({ label: "Buy", variant: "buy", onClick: () => submitTicket() });
    const result = h("div", { class: "readout-panel", style: "font-size: var(--fs-sm);", attrs: { "aria-live": "polite" }, hidden: true });
    const mineList = h("div", { style: "display: grid; gap: 6px;" });
    const mineWrap = h("div", { hidden: true, style: "display: grid; gap: 6px;" }, h("h3", { style: "font-size: var(--fs-sm); margin: 0;", text: "Your resting orders" }), mineList);
    usdIn.addEventListener("input", () => { const v = parseFloat(usdIn.value); if (v > 0) { t.usd = v; usdSlider.api.set(clamp(v, 100, 1e6)); markDirty(); } });
    priceIn.addEventListener("input", () => markDirty());
    sizeIn.addEventListener("input", () => markDirty());
    function setUsd(u, fromSlider) {
      t.usd = Math.max(1, u);
      if (!fromSlider) usdSlider.api.set(clamp(t.usd, 100, 1e6));
      usdIn.value = String(Math.round(t.usd));
      markDirty();
    }
    function setKind(k) {
      t.kind = k; kindSeg.api.set(k);
      marketBox.hidden = k !== "market"; limitBox.hidden = k !== "limit";
      if (k === "limit" && !priceIn.value) { const bb = t.side === BID ? sim.book.bestBid() : sim.book.bestAsk(); if (bb !== null) priceIn.value = sim.px(bb); }
      priceIn.step = String(sim.book.units.tickSize);
      markDirty();
    }
    function ticketOrder() {
      const b = sim.book, u = b.units;
      if (t.kind === "market") {
        const m = b.mid();
        const limit = t.protect && m !== null ? E.protectionLimitTicks(u.tickSize, t.side, m, PROTECTION) : null;
        return { side: t.side, lots: b.lotsForUsd(t.side, t.usd, limit), limit, market: true };
      }
      const px = parseFloat(priceIn.value), sz = parseFloat(sizeIn.value);
      if (!(px > 0) || !(sz > 0)) return null;
      const limit = Math.round(px / u.tickSize);
      if (!(limit > 0)) return null;
      return { side: t.side, lots: Math.max(1, Math.round(sz / u.lotSize)), limit, market: false };
    }
    function currentPreview() {
      const o = ticketOrder(); if (!o || !o.lots) return null;
      const dry = sim.book.dryMatch(o.side, o.lots, o.limit);
      const eaten = new Map(); for (const f of dry.fills) eaten.set(f.makerOrderId, f);
      return { o, dry, eaten };
    }
    function renderTicket(pv) {
      const b = sim.book, buy = t.side === BID;
      usdField.querySelector("label").textContent = buy ? "Spend (USD)" : "Receive (USD)";
      submit.className = "btn " + (buy ? "btn-buy" : "btn-sell");
      clear(preview);
      const line = (txt, cls) => preview.appendChild(h("p", { class: cls || null }, ui.rich(txt)));
      if (!pv) {
        submit.textContent = buy ? "Buy" : "Sell"; submit.disabled = true;
        line(t.kind === "market" ? "There is nothing to trade against within reach on this side." : "Enter a limit price and a size to preview.", "fine");
        return;
      }
      submit.disabled = false;
      const s = summarize(b, pv.dry.fills), m = b.mid();
      if (t.kind === "market") {
        submit.textContent = `${buy ? "Buy" : "Sell"} ${fmt.usdCompact(t.usd)} at market`;
        if (!pv.dry.fills.length || m === null) { line("The other side of the book is empty.", "fine"); return; }
        const bps = buy ? (s.avg - m) / m * 1e4 : (m - s.avg) / m * 1e4;
        line("**Preview** (nothing has traded yet)", "fine");
        preview.appendChild(h("p", { class: "mono", style: "font-size: 1.3rem; font-weight: 700; color: var(--ink);", text: fmt.bps(bps) + " impact" }));
        line(`Average price $${sim.pxUsd(s.avg)} against a mid of $${fmt.price(m, Math.max(3, sim.digits))}: ${fmt.sol(s.sol)} SOL from ${s.makers} order${s.makers > 1 ? "s" : ""} on ${s.levels} level${s.levels > 1 ? "s" : ""}.`);
        if (s.usd < t.usd * 0.999) line(t.protect ? `Only ${fmt.usd(s.usd, 0)} is available within 10% of the mid: [[price-protection|price protection]] would stop the order there.` : `Only ${fmt.usd(s.usd, 0)} is available on this side: the book would run out.`, "fine");
      } else {
        const sz = b.sol(pv.o.lots);
        submit.textContent = `Place limit ${buy ? "buy" : "sell"}: ${fmt.sol(sz)} SOL @ ${sim.px(pv.o.limit)}`;
        const best = buy ? b.bestAsk() : b.bestBid();
        const crosses = best !== null && (buy ? pv.o.limit >= best : pv.o.limit <= best);
        if (crosses) {
          line("**This limit order [[crossing-the-spread|crosses the spread]].**");
          line(`It trades ${fmt.sol(s.sol)} SOL right away (average $${sim.pxUsd(s.avg)}), then ${pv.dry.unfilledLots ? `rests ${fmt.sol(b.sol(pv.dry.unfilledLots))} SOL at $${sim.px(pv.o.limit)}` : "nothing is left to rest"}.`);
        } else {
          const lv = b.level(t.side, pv.o.limit);
          line("**Rests without trading.**");
          line(lv ? `It joins the tail of the queue at $${sim.px(pv.o.limit)}: number ${lv.count + 1}, behind ${fmt.sol(b.sol(lv.totalSize))} SOL that arrived first.` : `It starts a new [[price-level|price level]] at $${sim.px(pv.o.limit)}.`);
        }
      }
    }
    function submitTicket() {
      const o = ticketOrder(); if (!o || !o.lots) return;
      const b = sim.book, m = b.mid(), buy = o.side === BID;
      let fills, op, id = null;
      if (o.market) [fills, op] = sim.run(() => b.marketOrder(o.side, o.lots, o.limit));
      else {
        id = sim.nextId++;
        sim.mine.add(id);
        [fills, op] = sim.run(() => b.addOrder(id, o.side, o.limit, o.lots));
        if (!op.rested) sim.mine.delete(id);
      }
      sim.recordFills(o.side, fills, op, true);
      const s = summarize(b, fills);
      clear(result); result.hidden = false;
      const line = (txt, cls) => result.appendChild(h("p", { class: cls || null }, ui.rich(txt)));
      if (fills.length) {
        const bps = m === null ? null : buy ? (s.avg - m) / m * 1e4 : (m - s.avg) / m * 1e4;
        line(`**${buy ? "Bought" : "Sold"} ${fmt.sol(s.sol)} SOL** for ${fmt.usd(s.usd, 2)}.`);
        line(`Average $${sim.pxUsd(s.avg)}, mid was $${fmt.price(m, Math.max(3, sim.digits))}: impact **${fmt.bps(bps)}**. ${fills.length} maker order${fills.length > 1 ? "s" : ""} on ${s.levels} level${s.levels > 1 ? "s" : ""}${op.levelsRemoved ? `; ${op.levelsRemoved} level${op.levelsRemoved > 1 ? "s" : ""} emptied` : ""}.`);
        const list = h("ol", { class: "mono fine", style: "margin: 0;" }, fills.slice(0, 8).map((f, i) => h("li", { text: `#${f.makerOrderId} @ ${sim.px(f.priceTicks)} × ${fmt.sol(b.sol(f.sizeLots))} SOL${op.fills[i] && !op.fills[i].full ? " (partial: it keeps its place)" : ""}` })),
          fills.length > 8 ? h("li", { text: `… ${fills.length - 8} more` }) : null);
        result.appendChild(list);
        sim.log("YOU", "you", `you ${buy ? "bought" : "sold"} ${fmt.sol(s.sol)} SOL, avg ${sim.pxUsd(s.avg)}: ${fills.length} fill${fills.length > 1 ? "s" : ""} over ${s.levels} level${s.levels > 1 ? "s" : ""}`, "your order ran through the same matching loop as everyone else's");
        if (o.market && s.usd < t.usd * 0.999) line(o.limit !== null ? `Price protection stopped it: only ${fmt.usd(s.usd, 0)} of ${fmt.usd(t.usd, 0)} could trade within 10% of the mid. The rest was cancelled, never rested ([[ioc|immediate-or-cancel]]).` : `The book ran out: only ${fmt.usd(s.usd, 0)} of ${fmt.usd(t.usd, 0)} filled.`);
      }
      if (op.rested) {
        line(`**Rested ${fmt.sol(b.sol(op.rested.sizeLots))} SOL** at $${sim.px(o.limit)}, number ${op.rested.position} in the queue. It is amber in the ladder.`);
        sim.log("YOU", "you", `your limit #${id} rests at ${sim.px(o.limit)}, queue position ${op.rested.position}`, op.rested.fresh ? "new price level: insert into the sorted map, O(log L)" : "appended at the tail of the level's list: O(1)");
      }
      if (!fills.length && !op.rested) line("Nothing to trade against.");
      markDirty(true);
    }
    const mineRows = new Map();
    function renderMine() {
      const b = sim.book;
      mineWrap.hidden = sim.mine.size === 0;
      for (const [id, row] of mineRows) if (!sim.mine.has(id)) { row.remove(); mineRows.delete(id); }
      for (const id of sim.mine) {
        const o = b.orders.get(id); if (!o) continue;
        let row = mineRows.get(id);
        if (!row) {
          row = h("div", { style: "display: flex; justify-content: space-between; align-items: center; gap: 8px; font-family: var(--f-mono); font-size: var(--fs-sm);" },
            h("span"), ui.Button({ label: "Cancel", small: true, attrs: { "aria-label": `Cancel your order #${id}` }, onClick: () => ladderCancel(id) }));
          mineRows.set(id, row); mineList.appendChild(row);
        }
        const txt = `${o.side === BID ? "▲ buy" : "▼ sell"} ${fmt.sol(b.sol(o.sizeLots))} @ ${sim.px(o.priceTicks)} · #${b.queuePosition(id)} in queue`;
        if (row.firstChild.textContent !== txt) { row.firstChild.textContent = txt; row.firstChild.style.color = `var(--${o.side})`; }
      }
    }
    function ladderCancel(id) {
      const b = sim.book, o = b.orders.get(id); if (!o) return;
      const [, op] = sim.run(() => b.cancelOrder(id));
      sim.log("YOU", "you", `you cancelled #${id}` + (op.emptied ? " (the level is gone)" : ""), "O(1) via the id map");
      markDirty(true);
    }
    const ticketCard = card("Order ticket", null,
      sideSeg, kindSeg, marketBox, limitBox, preview, submit, result, mineWrap);

    /* ---------------- tape */
    const tapeRows = [];
    const tapeBox = h("div", { tabIndex: 0, attrs: { role: "region", "aria-label": "Trade tape, newest first" }, style: "display: grid; gap: 1px; max-height: 260px; overflow: auto; font-family: var(--f-mono); font-size: var(--fs-xs); font-variant-numeric: tabular-nums;" });
    const tapeEmpty = h("p", { class: "fine", text: "No trades yet." });
    tapeBox.appendChild(tapeEmpty);
    for (let i = 0; i < TAPE_ROWS; i++) {
      const r = h("div", { hidden: true, style: "display: grid; grid-template-columns: 1fr 1fr 1.3fr; gap: 6px; padding: 1px 4px; border-radius: 3px;" }, h("span"), h("span", { style: "text-align: right;" }), h("span"));
      tapeRows.push(r); tapeBox.appendChild(r);
    }
    function renderTape() {
      tapeEmpty.hidden = sim.tape.length > 0;
      for (let i = 0; i < TAPE_ROWS; i++) {
        const r = tapeRows[i], x = sim.tape[i];
        if (!x) { r.hidden = true; continue; }
        r.hidden = false;
        r.children[0].textContent = sim.pxUsd(x.price);
        r.children[1].textContent = fmt.sol(x.sol);
        r.children[2].textContent = (x.side === BID ? "▲ buy" : "▼ sell") + (x.mine ? " · you" : x.makerMine ? " · your order" : "");
        r.style.color = x.side === BID ? "var(--bid)" : "var(--ask)";
        r.style.background = x.mine || x.makerMine ? "var(--mine-soft)" : "";
      }
    }
    const tapeCard = card("Trade tape", "price · SOL · who took", ui.p("Every [[fill]], newest on top. A trade prints at the resting ([[maker]]) order's price; the side is what the [[taker]] did.", "fine"), tapeBox);

    /* ---------------- impact */
    let showAmm = true;
    const impactChart = ui.LineChart({
      series: [], height: 240,
      x: { log: true, label: "Trade size (USD)", format: fmt.usdCompact, ticks: PICK, min: 1e3, max: 1e6 },
      y: { label: "bps vs mid", min: 0, format: (v) => fmt.num(v, 1) },
      alt: "Impact curve of the current book.",
    });
    const impactTable = h("div");
    const ammNote = h("p", { class: "fine" });
    const ammToggle = checkbox("Show an [[xyk|x·y=k]] pool of equal depth", true, (on) => { showAmm = on; dirty.slow = true; schedule(); });
    function renderImpact() {
      const b = sim.book, m = b.mid();
      if (m === null) { ammNote.textContent = "One side of the book is empty."; return; }
      const curve = (side) => SIZES.map((u) => { const r = b.impact(side, u, { maxSlippage: PROTECTION }); return [u, r && r.impactBps !== null ? r.impactBps : null, r ? r.fullyFilled : false]; });
      const buy = curve("buy"), sell = curve("sell");
      const series = [
        { name: "▲ market buy", color: "--ask", points: buy },
        { name: "▼ market sell", color: "--bid", points: sell },
      ];
      let pool = null;
      try { pool = OBZ.amm.equivalentPool(b, 0.02); } catch (e) { pool = null; }
      const okPool = pool && pool.usdReserve > 0 && isFinite(pool.usdReserve);
      let ymax = 0; for (const s of series) for (const p of s.points) if (p[1] !== null) ymax = Math.max(ymax, p[1]);
      ymax = ymax > 0 ? ymax * 1.1 : 1;
      if (showAmm && okPool) {
        // Scale to the book's lines; the AMM line may run off the top (cut there, not flattened).
        const pts = []; let off = false;
        for (const u of SIZES) { const v = pool.buyImpactBps(u); if (off) pts.push([u, null]); else { pts.push([u, v]); if (v > ymax) off = true; } }
        series.push({ name: "x·y=k pool, equal depth (buy)", color: "--amm-alt", dash: true, width: 1.5, points: pts });
      }
      impactChart.api.update({ series, y: { label: "bps vs mid", min: 0, max: ymax, format: (v) => fmt.num(v, 1) }, alt: `Impact of a market order on the current book, from $1K to $1M, in basis points against the mid, with 10% price protection.` });
      const cell = (pts, u) => { const p = pts.find((q) => Math.abs(q[0] - u) / u < 1e-6); return !p || p[1] === null ? "–" : fmt.num(p[1], 2) + (p[2] === false ? "*" : ""); };
      const rows = [{ label: "▲ market buy", pts: buy }, { label: "▼ market sell", pts: sell }];
      if (okPool) rows.push({ label: "x·y=k buy", pts: PICK.map((u) => [u, pool.buyImpactBps(u), true]) }, { label: "x·y=k sell", pts: PICK.map((u) => { try { return [u, pool.sellImpactBps(u), true]; } catch (e) { return [u, null]; } }) });
      clear(impactTable).appendChild(ui.Table({
        caption: "Impact in bps against the mid (* = only partly filled)", dense: true,
        columns: [{ key: "label", label: "Order", align: "left", mono: false }].concat(PICK.map((u) => ({ label: fmt.usdCompact(u), value: (r) => cell(r.pts, u) }))),
        rows,
      }));
      ammNote.textContent = okPool
        ? `The dashed line is a constant-product pool holding ${fmt.usdCompact(pool.usdReserve)} per side: the same dollars within 2% of the mid as this book. A pool spreads its liquidity over every price, so matching the book near the mid takes a much bigger pool.`
        : "No x·y=k comparison: this book has nothing within 2% of the mid.";
    }
    const impactCard = card("Impact curve, this book", "refreshes every 1.5 s while running",
      ui.p("How much worse than the mid a market order of each size would do, if sent right now. This is the same calculation as `impact.py`: [[walking-the-book|walk the book]] until the dollars are spent, then compare the [[average-fill-price|average fill]] with the mid. Hollow points (and *) mean the order could only partly fill.", "fine"),
      ammToggle, impactChart, impactTable, ammNote);

    /* ---------------- venue comparison */
    let cmpSide = "buy", cmpLog = true;
    const cmpBox = h("div", { style: "display: grid; gap: var(--s-3);" });
    const cmpSideSeg = ui.Segmented({ label: "Comparison side", small: true, value: "buy", options: [{ value: "buy", label: "Buys" }, { value: "sell", label: "Sells" }], onChange: (v) => { cmpSide = v; renderCompare(); } });
    const cmpScaleSeg = ui.Segmented({ label: "Vertical axis", small: true, value: "log", options: [{ value: "log", label: "Log axis" }, { value: "linear", label: "Linear axis" }], onChange: (v) => { cmpLog = v === "log"; renderCompare(); } });
    // Curves are recomputed by this page's engine from each venue's book, so they always use
    // 10% price protection (an export's stored curve may predate protection).
    const curveCache = new Map();
    function venueCurve(v, side) {
      const key = data.active().label + "|" + v.venue + "|" + side;
      if (curveCache.has(key)) return curveCache.get(key);
      let pts = [];
      try {
        const b = data.book(v.venue);
        if (b && b.mid() !== null) pts = SIZES.map((u) => { const r = b.impact(side, u, { maxSlippage: PROTECTION }); return [u, r ? r.impactBps : null, r ? r.fullyFilled : false]; });
      } catch (e) { pts = []; }
      curveCache.set(key, pts);
      return pts;
    }
    function renderCompare() {
      const ds = data.active();
      const curves = ds.venues.map((v, i) => ({ v, i, pts: venueCurve(v, cmpSide) }));
      const series = curves.map(({ v, i, pts }) => ({ name: v.label, color: data.colorVar(v.venue, i), points: cmpLog ? pts.map((p) => [p[0], p[1] !== null && p[1] > 0 ? p[1] : null, p[2]]) : pts }));
      if (ds.ammUsdReserve) {
        const pool = OBZ.amm.AmmPool.atPrice(100, ds.ammUsdReserve);
        series.push({ name: `x·y=k pool as deep as Phoenix within 2% (${fmt.usdCompact(ds.ammUsdReserve)} per side)`, color: "--amm-alt", dash: true, width: 1.5,
          points: SIZES.map((u) => { try { return [u, cmpSide === "buy" ? pool.buyImpactBps(u) : pool.sellImpactBps(u)]; } catch (e) { return [u, null]; } }) });
      }
      const chart = ui.LineChart({
        series, height: 250,
        x: { log: true, label: "Trade size (USD)", format: fmt.usdCompact, ticks: PICK, min: 1e3, max: 1e6 },
        y: cmpLog ? { log: true, label: "bps vs own mid (log)", format: (v) => fmt.num(v, 1) } : { label: "bps vs own mid", min: 0, format: (v) => fmt.num(v, 0) },
        alt: `Impact of a market ${cmpSide} by trade size for ${ds.venues.map((v) => v.label).join(", ")}, in bps against each venue's own mid.`,
      });
      const near = (pts, u) => { let best = null; for (const p of pts) if (!best || Math.abs(Math.log(p[0] / u)) < Math.abs(Math.log(best[0] / u))) best = p; return best && Math.abs(Math.log(best[0] / u)) < 0.05 ? best : null; };
      const table = ui.Table({
        caption: `Market ${cmpSide} impact in bps against each venue's own mid (* = only partly filled, 10% protection)`, dense: true,
        columns: [
          { key: "label", label: "Venue", align: "left", mono: false, value: (r) => r.v.label },
          { label: "Spread", value: (r) => (r.v.spreadBps === null ? null : r.v.spreadBps), format: (x) => (x === null ? "–" : fmt.num(x, 2)) },
        ].concat(PICK.map((u) => ({ label: fmt.usdCompact(u), value: (r) => { const p = near(r.pts, u); return !p || p[1] === null ? "–" : fmt.num(p[1], 2) + (p[2] === false ? "*" : ""); } }))),
        rows: curves,
      });
      const loadRow = h("div", { class: "btn-row" }, h("span", { class: "fine", style: "font-weight: 600; color: var(--ink-2);", text: "Load into the engine:" }),
        ds.venues.map((v) => ui.Button({ label: v.label, small: true, attrs: { "aria-label": `Load the ${v.label} book into the playground` }, onClick: () => { startFrom(v.venue); el.scrollIntoView({ behavior: still ? "auto" : "smooth", block: "start" }); } })));
      const ds2 = ds.source === "builtin" ? `**Real books** captured within half a second of each other (${ds.label.replace("Built-in snapshots · ", "")}).` : `**${ds.label}**.`;
      clear(cmpBox).append(ui.p(`${ds2} This page's engine walks each book with 10% [[price-protection|price protection]] and measures impact against the venue's own mid, before fees. On a [[log-scale|log axis]] each gridline is ten times the one below.`, "fine"), chart, table, loadRow);
    }
    const loader = h("details", { style: "border-top: 1px solid var(--line); padding-top: var(--s-2);" },
      h("summary", { style: "cursor: pointer; color: var(--accent); font-weight: 600; min-height: 36px; display: flex; align-items: center;", text: "Load your own export" }),
      h("div", { class: "stack", style: "margin-top: var(--s-2);" },
        ui.p("Run `python -m impact_analyzer run` and paste `data/playground.json` (format v1), or an export v2 from the collector. Then use **Load into engine** on any row.", "fine"),
        ui.DataLoader({})));
    const cmpCard = card("Venue comparison", null, h("div", { class: "btn-row" }, cmpSideSeg, cmpScaleSeg), cmpBox, loader);

    /* ---------------- trace */
    const traceList = h("ol", { style: "list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; max-height: 300px; overflow: auto; font-family: var(--f-mono); font-size: var(--fs-xs);", tabIndex: 0, attrs: { "aria-label": "Engine trace, newest first" } });
    const OPC = { add: "--accent", fill: "--bid", cxl: "--ask", you: "--mine" };
    function renderTrace() {
      if (!sim.traceDirty) return;
      sim.traceDirty = false;
      clear(traceList);
      if (!sim.trace.length) { traceList.appendChild(h("li", { class: "fine", text: "Nothing yet. Lower the speed below 6 events/s, press Step, or place an order." })); return; }
      for (const l of sim.trace.slice(0, TRACE_ROWS)) traceList.appendChild(h("li", { style: "display: grid; grid-template-columns: 4.6em minmax(0, 1fr); gap: 8px; margin: 0;" },
        h("span", { style: `font-weight: 700; color: var(${OPC[l.kind] || "--ink"});`, text: l.op }),
        h("span", null, l.text, h("br"), h("span", { style: "color: var(--muted);", text: l.cx }))));
    }
    const traceCard = card("Engine trace", "what the data structures did, newest first",
      ui.p("The book is three structures working together: a [[sorted-map|sorted map]] of prices, a [[doubly-linked-list|doubly linked list]] of orders at each price, and a [[hash-map|hash map]] from [[order-id|order id]] to its node. Chapter 6 builds them; here you can watch them work.", "fine"),
      traceList);

    /* ---------------- layout */
    el.append(
      intro,
      h("div", { style: "display: flex; flex-wrap: wrap; gap: var(--s-3); align-items: end; justify-content: space-between;" }, startBox, sourcePill),
      loadMsg,
      h("section", { style: S.card, attrs: { "aria-label": "Simulation controls" } },
        h("div", { class: "btn-row" }, playBtn, stepBtn, resetBtn),
        h("div", { style: S.grid(180) }, speed, taker, vol, depth),
        motionNote),
      statGrid,
      h("div", { style: S.grid(420) }, ladderCard, ticketCard),
      h("div", { style: S.grid(300) }, priceCard, depthCard, tapeCard),
      h("div", { style: S.grid(400) }, impactCard, cmpCard),
      traceCard);

    /* ---------------- loop */
    function markDirty(all) { dirty.all = true; if (all) dirty.slow = true; schedule(); }
    // One pending frame at a time. The timeout is a fallback for when animation frames are
    // paused (a background tab), so a click still redraws; the sim itself barely runs there.
    let fallback = 0;
    function schedule() {
      if (raf || !alive) return;
      raf = requestAnimationFrame(frame);
      fallback = setTimeout(() => { if (raf) { cancelAnimationFrame(raf); frame(performance.now()); } }, 150);
    }
    function renderAll() {
      const pv = currentPreview();
      ladder.api.update(sim.book, pv, sim.digits, sim.changed, sim.mine);
      sim.changed.clear();
      renderStats(); renderTicket(pv); renderTape(); renderMine(); renderTrace();
      price.api.draw(sim);
      let marker = null;
      if (pv && pv.dry.fills.length) marker = sim.book.usd(pv.dry.fills[pv.dry.fills.length - 1].priceTicks);
      depthChart.api.update({ levels: sim.book, band, marker });
      sourcePill.lastChild.textContent = sim.source.label;
    }
    function frame(now) {
      raf = 0; clearTimeout(fallback);
      if (!alive) return;
      if (el.isConnected) seen = true; else if (seen) { stop(); return; }
      if (sim.running) {
        const dt = lastT ? Math.min(0.25, (now - lastT) / 1000) : 0; lastT = now;
        acc += dt * sim.p.speed;
        const n = Math.min(Math.floor(acc), 2000); acc -= Math.floor(acc);
        const verbose = sim.p.speed < 6;
        for (let i = 0; i < n; i++) sim.event(verbose);
        if (n) dirty.all = true;
        if (now - lastSample > 50) { sim.sample(); lastSample = now; dirty.all = true; }
      }
      if (dirty.all && now - lastRender >= 60) { renderAll(); dirty.all = false; lastRender = now; }
      if ((dirty.slow || sim.running) && now - lastSlow >= (sim.running ? 1500 : 200)) { band = chooseBand(); renderImpact(); dirty.slow = false; lastSlow = now; }
      if (sim.running || dirty.all || dirty.slow) schedule();
    }
    function afterBookChange() {
      band = chooseBand();
      priceIn.step = String(sim.book.units.tickSize);
      priceIn.value = "";
      if (t.kind === "limit") setKind("limit");
      clear(result); result.hidden = true;
      lastSlow = 0; lastRender = 0;
      markDirty(true);
    }
    function stop() {
      alive = false; sim.running = false;
      if (raf) cancelAnimationFrame(raf);
      raf = 0; clearTimeout(fallback);
      for (const off of offs) { try { off(); } catch (e) { /* already gone */ } }
      offs.length = 0;
    }
    ctx.onCleanup(stop);
    offs.push(onThemeChange(() => { if (!alive) return; price.api.theme(); }));
    if (typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(() => { if (alive) { price.api.draw(); markDirty(); } });
      ro.observe(el);
      offs.push(() => ro.disconnect());
    }
    ctx.onData(() => { curveCache.clear(); mountStart(); renderCompare(); });

    sim.newRandom();
    mountStart();
    renderCompare();
    setRunning(!still);
    afterBookChange();
  }

  OBZ.play.register({
    id: "playground", order: 1, status: "ready",
    title: "Playground",
    summary: "A live order book with random traders: place orders, cancel any block, and watch what a market order would sweep.",
    render,
  });
})(window.OBZ = window.OBZ || {});
