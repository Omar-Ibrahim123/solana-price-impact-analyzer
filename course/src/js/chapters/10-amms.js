/* chapters/10-amms.js: Chapter 10, "AMMs".
 *   Explain  x·y = k from scratch with a worked example; price = ratio; impact = dx / x;
 *            liquidity over all prices vs a book's chosen levels; concentrated liquidity;
 *            prop AMMs and aggregators (Jupiter)
 *   See      the curve with a draggable trade (tangent = spot price, chord = average price)
 *   Try      (1) AMM vs a real book of equal depth (amm.equivalentPool, the project's idea)
 *            (2) the real Jupiter quotes from the collector: cost by route and size
 *            + a NumberCheck and the constant-product swap code exercise
 * Exposes OBZ.lessons.amm = {curveExplorer, ammVsBook, jupiterRoutes, quoteContext, routeText,
 * routeLabels, quoteNotes} for play/amm-lab.js, chapter 11 and the Real books page.
 */
(function (OBZ) {
  "use strict";
  const { h, fmt, clear, clamp } = OBZ.util;

  const bpsText = (v) => (v === null || v === undefined || !isFinite(v) ? "–" : Math.abs(v) >= 1000 ? fmt.int(v) + " bps" : fmt.bps(v));
  const signedBps = (v) => (v === null || v === undefined || !isFinite(v) ? "–" : (v < 0 ? "−" : "") + (Math.abs(v) >= 100 ? fmt.int(Math.abs(v)) : Math.abs(v).toFixed(1)));

  /* ------------------------------------------------------------------ Jupiter route helpers */
  const SOL_MINT = "So11111111111111111111111111111111111111112";
  const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  /** A route leg's label; legs are strings, or objects {label, input_mint, output_mint} in richer exports. */
  const legLabel = (leg) => String(typeof leg === "string" ? leg : (leg && leg.label) || "?").replace(/[^\w .()+-]/g, "");
  /** true / false when the leg says which tokens it swaps; null when the export only has labels. */
  function legDirect(leg) {
    if (!leg || typeof leg !== "object") return null;
    const a = leg.input_mint || leg.inputMint, b = leg.output_mint || leg.outputMint;
    if (!a || !b) return null;
    const pair = [a, b].sort().join("|");
    return pair === [SOL_MINT, USDC_MINT].sort().join("|");
  }
  /** "A → B → C", marking legs that swap through another token when the data says so. */
  function routeText(route) {
    if (!Array.isArray(route) || !route.length) return "–";
    return route.map((leg) => legLabel(leg) + (legDirect(leg) === false ? " (via another token)" : "")).join(" → ");
  }
  /** Labels used by the best routes of the latest round, most used first: [[label, count]]. */
  function routeLabels(ds) {
    const best = ((ds && ds.jupiter) || []).filter((q) => q.dex === "best" && q.ok !== false && Array.isArray(q.route));
    const n = new Map();
    for (const q of best) for (const l of new Set(q.route.map(legLabel))) n.set(l, (n.get(l) || 0) + 1);
    return Array.from(n).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }
  const listWords = (xs) => (xs.length < 2 ? xs.join("") : xs.slice(0, -1).join(", ") + " and " + xs[xs.length - 1]);

  /* ------------------------------------------------------------------ the curve (See) */
  /**
   * An SVG plot of x·y = k with a draggable trade.
   * opts: {usd: 1000, sol: 10, step, label}. Returns an element with .api.set(dx), .api.setPool(usd, sol).
   */
  function curveExplorer(ctx, opts = {}) {
    const { ui } = ctx;
    let x0 = opts.usd || 1000, y0 = opts.sol || 10;
    let dx = opts.dx !== undefined ? opts.dx : x0 * 0.1;
    const L = 58, R = 420, T = 16, B = 250;
    const X = (x) => L + (x / (2.5 * x0)) * (R - L);
    const Y = (y) => B - (y / (2.5 * y0)) * (B - T);
    const svg = h("svg", { class: "diagram diagram-md", viewBox: "0 0 440 300", attrs: { role: "img", "aria-label": "The constant-product curve x times y equals k, with a trade drawn along it" } });
    const axes = h("g"), curve = h("path", { class: "line", style: "stroke-width: 2.5" });
    const tangent = h("line", { class: "line line-dash" });
    const chord = h("line", { class: "line-accent" });
    const dxLine = h("line", { class: "line-accent line-dash" }), dyLine = h("line", { class: "line-accent line-dash" });
    const dxText = h("text", { class: "t-bold t-accent", "text-anchor": "middle" });
    const dyText = h("text", { class: "t-bold t-accent" });
    const tanText = h("text", { class: "t-muted", text: "SOL per $ at the spot price" });
    const start = h("circle", { r: 6, class: "fill-accent" });
    const startText = h("text", { class: "t-bold", text: "before" });
    const ring = h("circle", { r: 15, fill: "none", class: "hl", style: "opacity: 0" });
    const knob = h("circle", { r: 9, style: "fill: var(--amm); stroke: var(--panel); stroke-width: 2" });
    const hit = h("circle", { r: 24, style: "fill: transparent" });
    const handle = h("g", { tabIndex: 0, style: "cursor: grab; touch-action: none; outline: none", attrs: { role: "slider", "aria-label": opts.label || "Dollars spent on SOL" } }, ring, hit, knob);
    const afterText = h("text", { class: "t-bold", text: "after" });
    svg.append(axes, curve, tangent, tanText, chord, dxLine, dyLine, dxText, dyText, start, startText, afterText, handle);

    const readout = h("div", { class: "readout-panel", attrs: { "aria-live": "polite" } });
    const maxDx = () => 1.5 * x0;
    const slider = ui.Slider({ label: "Dollars you spend", min: 0, max: maxDx(), step: x0 / 200, value: dx, format: (v) => fmt.usd(v, 0), onInput: (v) => set(v, true) });

    function drawAxes() {
      clear(axes);
      axes.appendChild(h("line", { class: "line", x1: L, y1: B, x2: R, y2: B }));
      axes.appendChild(h("line", { class: "line", x1: L, y1: T, x2: L, y2: B }));
      for (let i = 0; i <= 5; i++) {
        const xv = x0 * 0.5 * i, yv = y0 * 0.5 * i;
        axes.appendChild(h("text", { x: X(xv), y: B + 18, "text-anchor": "middle", class: "t-muted", text: fmt.usdCompact(xv) }));
        if (i > 0) axes.appendChild(h("text", { x: L - 6, y: Y(yv) + 4, "text-anchor": "end", class: "t-muted", text: fmt.num(yv, 2) }));
        if (i > 0) axes.appendChild(h("line", { class: "line line-dash", style: "opacity: 0.25", x1: L, x2: R, y1: Y(yv), y2: Y(yv) }));
      }
      axes.appendChild(h("text", { x: (L + R) / 2, y: B + 40, "text-anchor": "middle", class: "t-muted", text: "x: dollars (USDC) in the pool" }));
      axes.appendChild(h("text", { x: 12, y: (T + B) / 2, "text-anchor": "middle", class: "t-muted", transform: `rotate(-90 12 ${(T + B) / 2})`, text: "y: SOL in the pool" }));
      const k = x0 * y0, pts = [];
      for (let i = 0; i <= 90; i++) { const xv = x0 * (0.4 + 2.1 * i / 90); pts.push(`${i ? "L" : "M"} ${X(xv).toFixed(1)} ${Y(k / xv).toFixed(1)}`); }
      curve.setAttribute("d", pts.join(" "));
      // tangent at the start: dy/dx = -y0/x0
      const ta = x0 * 0.62, tb = x0 * 1.55;
      tangent.setAttribute("x1", X(ta)); tangent.setAttribute("y1", Y(y0 + (x0 - ta) * y0 / x0));
      tangent.setAttribute("x2", X(tb)); tangent.setAttribute("y2", Y(y0 - (tb - x0) * y0 / x0));
      tanText.setAttribute("x", X(ta) + 4); tanText.setAttribute("y", Y(y0 + (x0 - ta) * y0 / x0) - 8);
      start.setAttribute("cx", X(x0)); start.setAttribute("cy", Y(y0));
      startText.setAttribute("x", X(x0) - 10); startText.setAttribute("y", Y(y0) + 22); startText.setAttribute("text-anchor", "end");
    }

    function set(v, fromSlider) {
      dx = clamp(v, 0, maxDx());
      const k = x0 * y0, x1 = x0 + dx, y1 = k / x1, out = y0 - y1;
      const spot0 = x0 / y0, spot1 = x1 / y1, avg = out > 0 ? dx / out : spot0;
      knob.setAttribute("cx", X(x1)); knob.setAttribute("cy", Y(y1));
      hit.setAttribute("cx", X(x1)); hit.setAttribute("cy", Y(y1));
      ring.setAttribute("cx", X(x1)); ring.setAttribute("cy", Y(y1));
      afterText.setAttribute("x", X(x1) + 6); afterText.setAttribute("y", Y(y1) + 26);
      const vis = dx > x0 * 0.01 ? "1" : "0", visText = dx > x0 * 0.12 ? "1" : "0";
      for (const e of [chord, dxLine, dyLine]) e.style.opacity = vis;
      for (const e of [dxText, dyText, afterText]) e.style.opacity = visText;
      chord.setAttribute("x1", X(x0)); chord.setAttribute("y1", Y(y0)); chord.setAttribute("x2", X(x1)); chord.setAttribute("y2", Y(y1));
      dxLine.setAttribute("x1", X(x0)); dxLine.setAttribute("y1", Y(y0)); dxLine.setAttribute("x2", X(x1)); dxLine.setAttribute("y2", Y(y0));
      dyLine.setAttribute("x1", X(x1)); dyLine.setAttribute("y1", Y(y0)); dyLine.setAttribute("x2", X(x1)); dyLine.setAttribute("y2", Y(y1));
      dxText.setAttribute("x", (X(x0) + X(x1)) / 2); dxText.setAttribute("y", Y(y0) - 8); dxText.textContent = "+" + fmt.usdCompact(dx);
      dyText.setAttribute("x", X(x1) + 8); dyText.setAttribute("y", (Y(y0) + Y(y1)) / 2 + 5); dyText.textContent = "−" + fmt.num(out, 3) + " SOL";
      handle.setAttribute("aria-valuemin", "0"); handle.setAttribute("aria-valuemax", String(Math.round(maxDx())));
      handle.setAttribute("aria-valuenow", String(Math.round(dx)));
      handle.setAttribute("aria-valuetext", `Spend ${fmt.usd(dx, 0)}, receive ${fmt.num(out, 4)} SOL`);
      if (!fromSlider) slider.api.set(dx);
      clear(readout).append(
        h("p", null, ui.rich(`Spend **${fmt.usd(dx, 0)}** → receive **${fmt.num(out, 4)} SOL**: y − k ÷ (x + dx) = ${fmt.num(y0, 4)} − ${fmt.num(k, 0)} ÷ ${fmt.num(x1, 2)}.`)),
        h("p", null, ui.rich(`Average price **${fmt.usd(avg)}** = ${fmt.usd(dx, 0)} ÷ ${fmt.num(out, 4)} SOL, against a spot price of ${fmt.usd(spot0)} before. Spot after the trade: **${fmt.usd(spot1)}**.`)),
        h("p", null, ui.rich(`Impact: (${fmt.usd(avg)} − ${fmt.usd(spot0)}) ÷ ${fmt.usd(spot0)} = **${bpsText((avg - spot0) / spot0 * 1e4)}**, exactly dx ÷ x = ${fmt.num(dx, 2)} ÷ ${fmt.num(x0, 2)}.`)));
    }

    function fromPointer(e) {
      const pt = svg.createSVGPoint(); pt.x = e.clientX; pt.y = e.clientY;
      const m = svg.getScreenCTM(); if (!m) return;
      const p = pt.matrixTransform(m.inverse());
      const snap = x0 / 100;
      set(Math.round((((p.x - L) / (R - L)) * 2.5 * x0 - x0) / snap) * snap);
    }
    let dragging = false;
    handle.addEventListener("pointerdown", (e) => { dragging = true; try { handle.setPointerCapture(e.pointerId); } catch (err) { /* old browser */ } handle.style.cursor = "grabbing"; e.preventDefault(); });
    handle.addEventListener("pointermove", (e) => { if (dragging) fromPointer(e); });
    const end = () => { dragging = false; handle.style.cursor = "grab"; };
    handle.addEventListener("pointerup", end); handle.addEventListener("pointercancel", end);
    handle.addEventListener("focus", () => { ring.style.opacity = "1"; });
    handle.addEventListener("blur", () => { ring.style.opacity = "0"; });
    handle.addEventListener("keydown", (e) => {
      const step = x0 / 40, big = x0 / 4;
      const map = { ArrowRight: step, ArrowUp: step, ArrowLeft: -step, ArrowDown: -step, PageUp: big, PageDown: -big };
      if (map[e.key] !== undefined) { e.preventDefault(); set(dx + map[e.key]); }
      else if (e.key === "Home") { e.preventDefault(); set(0); }
      else if (e.key === "End") { e.preventDefault(); set(maxDx()); }
    });

    drawAxes(); set(dx);
    const el = h("div", { class: "stack" }, svg, slider, readout);
    el.api = {
      set: (v) => set(v),
      setPool(usd, sol) { x0 = usd; y0 = sol; dx = Math.min(dx, maxDx()); drawAxes(); set(dx); },
    };
    return el;
  }

  /* ------------------------------------------------------------------ AMM vs a book (Try 1) */
  function ammVsBook(ctx) {
    const { ui, data } = ctx;
    const wrap = h("div", { class: "stack" });
    let venue = data.venue("kraken") ? "kraken" : data.venues()[0];
    let side = "buy", band = 0.02;
    const pickerBox = h("div"), statsBox = h("div"), chartBox = h("div"), note = h("div", { class: "readout-panel", attrs: { "aria-live": "polite" } }), checkBox = h("div");
    const sizes = OBZ.engine.logSpacedSizes(1e3, 1e6, 4);
    function render() {
      clear(statsBox); clear(chartBox); clear(note); clear(checkBox);
      const book = data.book(venue);
      if (!book || book.mid() === null) { statsBox.appendChild(ui.p("No two-sided book for this venue.")); return; }
      const [bidUsd, askUsd] = book.depthWithin(band);
      if (!(bidUsd > 0) || !(askUsd > 0)) { statsBox.appendChild(ui.p(`This book has no orders within ${fmt.pct(band, 1)} of its mid on one side, so there is no pool of equal depth to compare.`)); return; }
      const pool = OBZ.amm.equivalentPool(book, band);
      const x = pool.usdReserve, depth = side === "buy" ? askUsd : bidUsd;
      statsBox.appendChild(ui.StatGrid([
        ui.Stat({ label: `Book: asks within ${fmt.pct(band, band < 0.01 ? 1 : 0)}`, value: fmt.usdCompact(askUsd), tone: "ask", sub: "▼ what a buyer can walk through" }),
        ui.Stat({ label: `Book: bids within ${fmt.pct(band, band < 0.01 ? 1 : 0)}`, value: fmt.usdCompact(bidUsd), tone: "bid", sub: "▲ what a seller can walk through" }),
        ui.Stat({ label: "Pool of equal depth (x)", value: fmt.usdCompact(x), tone: "accent", sub: `dollars per side, at $${fmt.price(book.mid(), 3)}` }),
        ui.Stat({ label: "Pool ÷ book depth", value: fmt.num(x / ((bidUsd + askUsd) / 2), 0) + "×", sub: "money the pool needs" }),
      ], { live: true }));
      const bookPts = sizes.map((s) => { const r = book.impact(side, s); return r && r.filledBase > 0 ? [s, r.impactBps, r.fullyFilled] : [s, null]; });
      const poolPts = sizes.map((s) => { try { return [s, side === "buy" ? pool.buyImpactBps(s) : pool.sellImpactBps(s)]; } catch (e) { return [s, null]; } });
      const label = data.label(venue);
      chartBox.appendChild(ui.LineChart({
        series: [
          { name: `${label} book`, color: data.colorVar(venue), points: bookPts },
          { name: "x·y = k pool of equal depth (no fee)", color: "--amm", points: poolPts },
        ],
        x: { log: true, label: `Trade size (${side === "buy" ? "buying" : "selling"} SOL)`, format: fmt.usdCompact, ticks: [1e3, 1e4, 1e5, 1e6] },
        y: { label: "Impact (bps)", format: (v) => fmt.num(v, 1), min: 0 },
        height: 250, table: true,
        alt: `Price impact against trade size for the ${label} book and for an x·y = k pool holding ${fmt.usdCompact(x)} per side, the same depth within ${fmt.pct(band, 1)} of the mid.`,
      }));
      const at = (pts, s) => { const p = pts.find((q) => Math.abs(q[0] - s) < 1); return p ? p[1] : null; };
      const b10 = at(bookPts, 1e4), p10 = at(poolPts, 1e4), b1m = at(bookPts, 1e6), p1m = at(poolPts, 1e6);
      const partial = bookPts.some((p) => p[2] === false);
      note.append(
        ui.p(`At **$10K** the ${label} book costs ${bpsText(b10)} and the pool ${bpsText(p10)}. At **$1M**: book ${b1m === null ? "no fill" : bpsText(b1m)}${partial ? " (hollow markers are partial fills: the book ran out within 10% of the mid)" : ""}, pool ${bpsText(p1m)}.`),
        ui.p(`Small trades: this pool has no fee, so it has no [[spread]] either and its first dollar trades at the spot price, while the book always charges at least half the spread. (A real pool charges a fee, which works like a half-spread: buying and selling at the same moment differ by about twice the fee.) Big trades: the pool's price keeps sliding along the curve, while the book's cost depends on where its makers actually put their orders.`));
      checkBox.appendChild(ui.NumberCheck({
        question: `Your turn: this pool holds x = ${fmt.usd(x, 0)} on its dollar side. With no fee, what is its impact for a **$10,000 buy**, in bps?`,
        answer: 1e4 / x * 1e4, tolerance: Math.max(0.01, 1e4 / x * 1e4 * 0.02), unit: "bps",
        explain: `Impact = dx ÷ x = 10,000 ÷ ${fmt.num(x, 0)} = ${fmt.num(1e4 / x, 6)}, which is **${fmt.bps(1e4 / x * 1e4, 3)}**. It matches the chart's pool line at $10K.`,
        hint: "For a buy on an x·y = k pool the impact is exactly dx ÷ x. Multiply by 10,000 to get bps.",
      }));
    }
    function mountPicker() {
      clear(pickerBox).append(
        ui.VenuePicker({ venues: data.venues(), value: venue, onChange: (v) => { venue = v; render(); } }),
        h("div", { class: "btn-row" },
          ui.Segmented({ label: "Side", value: side, options: [{ value: "buy", label: "▲ Buy SOL" }, { value: "sell", label: "▼ Sell SOL" }], onChange: (v) => { side = v; render(); } }),
          ui.Segmented({ label: "Match depth within", value: band, options: [{ value: 0.005, label: "±0.5%" }, { value: 0.01, label: "±1%" }, { value: 0.02, label: "±2%" }], onChange: (v) => { band = v; render(); } })));
    }
    mountPicker(); render();
    ctx.onData(() => { if (!data.venue(venue)) venue = data.venues()[0]; mountPicker(); render(); });
    wrap.append(pickerBox, statsBox, chartBox, note, checkBox);
    return wrap;
  }

  /* ------------------------------------------------------------------ Jupiter quotes (Try 2) */
  const DEX_ORDER = ["best", "SolFi", "Phoenix", "Whirlpool", "Raydium CLMM", "Meteora DLMM"];
  const DEX_LABEL = { best: "Best route (no filter)", SolFi: "SolFi only", Phoenix: "Phoenix only", Whirlpool: "Whirlpool only", "Raydium CLMM": "Raydium CLMM only", "Meteora DLMM": "Meteora DLMM only" };
  const DEX_COLOR = { best: "--accent", SolFi: "--amm", Phoenix: "--phoenix", Whirlpool: "--coinbase", "Raydium CLMM": "--amm-alt", "Meteora DLMM": "--mine" };
  const DEX_DASH = { "Meteora DLMM": true };

  /** When and where the quotes came from: {slots: [lo, hi], refMid, t (unix) | null}. */
  function quoteContext(ds) {
    const q = (ds.jupiter || []).filter((x) => x.ok);
    if (!q.length) return null;
    const slots = q.map((x) => x.slot).filter((s) => typeof s === "number");
    const refMid = q[0].ref_mid;
    let t = null;
    const ts = ds.timeseries;
    if (ts && Array.isArray(ts.ref_mid) && typeof refMid === "number") {
      const i = ts.ref_mid.findIndex((m) => typeof m === "number" && Math.abs(m - refMid) < 1e-9);
      if (i >= 0) t = ts.t[i];
    }
    return { slots: slots.length ? [Math.min(...slots), Math.max(...slots)] : null, refMid, t };
  }

  /** Bullet points about the latest Jupiter round, computed from the data. Returns markdown or null. */
  function quoteNotes(ds) {
    const q = (ds.jupiter || []);
    if (!q.length) return null;
    const out = [];
    const best = q.filter((x) => x.dex === "best" && x.ok !== false && typeof x.cost_bps_vs_ref === "number");
    if (best.length) {
      const labels = routeLabels(ds).map(([l]) => l);
      const worst = Math.max(...best.map((x) => x.cost_bps_vs_ref));
      out.push(`Jupiter's **best route** used ${labels.length} venue label${labels.length === 1 ? "" : "s"} in this round (${labels.length > 3 ? `${labels.slice(0, 3).join(", ")} and ${labels.length - 3} more` : listWords(labels)}). Most are prop AMMs run by market makers. Its cost was at most ${signedBps(worst)} bps at every size, buying or selling.`);
    }
    const ts = ds.timeseries, S = ts && ts.series && ts.series.phoenix;
    const pb = q.find((x) => x.dex === "Phoenix" && x.side === "buy" && x.usd === 1000 && x.ok !== false);
    const ps = q.find((x) => x.dex === "Phoenix" && x.side === "sell" && x.usd === 1000 && x.ok !== false);
    const ph = (ds.venues || []).find((v) => v.venue === "phoenix");
    const fee = ph && isFinite(ph.feeBps) ? ph.feeBps : null;
    if (pb && ps && S && S.mid && S.spread_bps && fee !== null) {
      const i = ts.t.length - 1, mid = S.mid[i], spr = S.spread_bps[i];
      if (isFinite(mid) && isFinite(spr) && spr > 50) {
        const ask = mid * (1 + spr / 2e4), bid = mid * (1 - spr / 2e4);
        const dBuy = Math.abs(pb.avg_price / (ask * (1 + fee / 1e4)) - 1) * 1e4, dSell = Math.abs(ps.avg_price / (bid * (1 - fee / 1e4)) - 1) * 1e4;
        out.push(`**Phoenix via Jupiter** was expensive here because Phoenix's SOL/USDC book was very wide at that moment: the collector's own decode in the same round shows a best ask of $${fmt.price(ask, 2)} and a best bid of $${fmt.price(bid, 2)}. Jupiter's Phoenix-only quote for $1K ($${fmt.price(pb.avg_price, 2)} to buy, $${fmt.price(ps.avg_price, 2)} to sell) is within about ${fmt.num(Math.max(dBuy, dSell), 1)} bps of that book plus the ${fee} bps taker fee: a useful check that our decoder and Jupiter read the same bytes.`);
      }
    }
    const junk = q.filter((x) => x.dex === "Phoenix" && x.ok !== false && typeof x.avg_price === "number" && typeof x.ref_mid === "number"
      && (x.side === "buy" ? x.avg_price > 2 * x.ref_mid : x.avg_price < x.ref_mid / 2));
    if (junk.length) out.push(`At ${listWords(Array.from(new Set(junk.map((x) => x.usd))).sort((a, b) => a - b).map(fmt.usdCompact))}, the Phoenix-only quotes averaged absurd prices (${junk.map((x) => `$${fmt.price(x.avg_price, 2)} to ${x.side}`).join(", ")}): they ran past the real orders into the book's [[junk-quote|junk quotes]] ([chapter 11](#/learn/11) tells that story).`);
    const sOk = Array.from(new Set(q.filter((x) => x.dex === "SolFi" && x.ok !== false).map((x) => x.usd))).sort((a, b) => a - b);
    const sNo = Array.from(new Set(q.filter((x) => x.dex === "SolFi" && x.ok === false).map((x) => x.usd))).sort((a, b) => a - b);
    if (sOk.length && sNo.length) out.push(`**SolFi** quoted ${listWords(sOk.map(fmt.usdCompact))} but had no route at ${listWords(sNo.map(fmt.usdCompact))} in this round.`);
    return out.length ? out.map((x) => "- " + x).join("\n") : null;
  }

  function jupiterRoutes(ctx) {
    const { ui, data } = ctx;
    const wrap = h("div", { class: "stack" });
    let side = "buy";
    const body = h("div", { class: "stack" });
    function render() {
      clear(body);
      const ds = data.active();
      const quotes = (ds.jupiter || []).filter((q) => q.side === side);
      if (!quotes.length) {
        body.appendChild(ui.Callout({ kind: "note", title: "No Jupiter quotes in this dataset", body: "Quotes come from the collector (`jupiter.py`) and are part of export format v2. The built-in data has them; a file you loaded may not." }));
        return;
      }
      const dexes = DEX_ORDER.filter((d) => quotes.some((q) => q.dex === d)).concat(Array.from(new Set(quotes.map((q) => q.dex))).filter((d) => !DEX_ORDER.includes(d)));
      const sizes = Array.from(new Set(quotes.map((q) => q.usd))).sort((a, b) => a - b);
      const get = (d, s) => quotes.find((q) => q.dex === d && q.usd === s) || null;
      const qc = quoteContext(ds);
      body.appendChild(h("p", { class: "fine" }, ui.rich(`Real quotes recorded by the collector${qc && qc.t ? ` in its ${fmt.date(qc.t)} snapshot round, a later moment than the 04:31 books used elsewhere` : ""}${qc && qc.slots ? `, Solana slots ${fmt.int(qc.slots[0])}–${fmt.int(qc.slots[1])} (about ${fmt.num((qc.slots[1] - qc.slots[0]) * 0.4 / 60, 0)} minutes; the quotes are spaced out to respect Jupiter's rate limit)` : ""}. Cost is measured against the [[reference-mid|reference mid]]${qc && qc.refMid ? ` of $${fmt.price(qc.refMid, 4)}` : ""}, the average of Kraken's and Coinbase's mids in the same round. Negative means the quote beat that mid: a route can price SOL a little better than the exchanges' average, because the mid comes from other venues and prop AMMs often quote tightly.`)));
      const cols = [{ key: "label", label: "Route", align: "left", mono: false }].concat(sizes.map((s) => ({
        key: String(s), label: fmt.usdCompact(s),
        value: (r) => r.dex, format: (d) => { const q = get(d, s); return !q ? "–" : q.ok ? signedBps(q.cost_bps_vs_ref) + " bps" : "no route"; },
      })));
      body.appendChild(ui.Table({ caption: `Cost in bps vs the reference mid, ${side === "buy" ? "buying" : "selling"} SOL`, columns: cols, rows: dexes.map((d) => ({ dex: d, label: DEX_LABEL[d] || d })), dense: true }));
      // chart
      const YMAX = 120;
      const off = [];
      const series = dexes.map((d) => ({
        name: DEX_LABEL[d] || d, color: DEX_COLOR[d] || "--muted", dash: !!DEX_DASH[d], width: d === "best" ? 3.5 : 2,
        points: sizes.map((s) => {
          const q = get(d, s);
          if (!q || !q.ok || typeof q.cost_bps_vs_ref !== "number") return [s, null];
          if (q.cost_bps_vs_ref > YMAX) { off.push(`${DEX_LABEL[d] || d} at ${fmt.usdCompact(s)}: ${fmt.int(q.cost_bps_vs_ref)} bps`); return [s, null]; }
          return [s, q.cost_bps_vs_ref];
        }),
      }));
      const allV = series.flatMap((s) => s.points.map((p) => p[1])).filter((v) => v !== null);
      body.appendChild(ui.LineChart({
        series,
        x: { log: true, label: "Trade size", format: fmt.usdCompact, ticks: sizes },
        y: { label: "Cost vs reference mid (bps)", min: Math.min(0, Math.floor(Math.min(...allV) / 5) * 5), max: YMAX, format: (v) => fmt.num(v, 0) },
        height: 280, table: true,
        alt: `Jupiter quote cost in basis points against trade size, ${side === "buy" ? "buying" : "selling"} SOL, for each route filter.`,
      }));
      const notes = [];
      if (off.length) notes.push(`Off the top of the chart (over ${YMAX} bps): ${off.join("; ")}.`);
      const solfiMissing = sizes.filter((s) => { const q = get("SolFi", s); return q && !q.ok; });
      if (solfiMissing.length) notes.push(`Jupiter found **no SolFi route** at ${solfiMissing.map(fmt.usdCompact).join(" and ")} in this round: SolFi quoted the smaller sizes only.`);
      const legs = sizes.map((s) => { const q = get("best", s); return q && q.ok && q.route && q.route.length ? `${fmt.usdCompact(s)}: ${routeText(q.route)}` : null; }).filter(Boolean);
      if (legs.length) {
        const known = quotes.some((q) => Array.isArray(q.route) && q.route.some((l) => legDirect(l) !== null));
        notes.push(`The best route's legs, in Jupiter's order: ${legs.join(" · ")}. Some legs run side by side; others hand an in-between token to the next leg, so a name in the list is not necessarily SOL that venue held.${known ? "" : " This export keeps only the venue labels, not the tokens each leg swaps, so it can't say which legs are which."}`);
      }
      if (notes.length) body.appendChild(h("div", { class: "readout-panel" }, notes.map((n) => ui.p(n))));
    }
    wrap.append(
      ui.Segmented({ label: "Side", value: side, options: [{ value: "buy", label: "▲ Buy SOL" }, { value: "sell", label: "▼ Sell SOL" }], onChange: (v) => { side = v; render(); } }),
      body);
    render();
    ctx.onData(render);
    return wrap;
  }

  /* ------------------------------------------------------------------ code exercise */
  const SWAP_EX = {
    id: "ex-amm-swap",
    title: "Exercise · A constant-product swap",
    level: "easy",
    brief: `A pool is \`{ usd, sol }\`. Write \`swap(pool, usdIn, feeBps)\` for someone buying SOL with \`usdIn\` dollars. Return \`{ solOut, avgPrice, pool }\` where \`pool\` is a **new** object for the pool after the trade (don't change the one you were given).

The fee works as in \`amm.py\`: only \`usdIn × (1 − feeBps / 10,000)\` counts in the formula, but the whole \`usdIn\` goes into the pool, so the fee stays there for the liquidity providers. With \`k = usd × sol\`, the SOL left in the pool must be \`k ÷ (usd + that amount)\`.`,
    starter: [
      "function swap(pool, usdIn, feeBps) {",
      "  const k = 0;          // TODO: the product before the trade",
      "  const dx = 0;         // TODO: the dollars that count after the fee",
      "  const solOut = 0;     // TODO: SOL now minus SOL that must stay",
      "  return { solOut, avgPrice: 0, pool: { usd: pool.usd, sol: pool.sol } };",
      "}",
    ].join("\n"),
    exports: ["swap"],
    tests: [
      { name: "worked example: $100 into a pool of $1,000 and 10 SOL gives 0.909 SOL", code: "const r = A.swap({ usd: 1000, sol: 10 }, 100, 0); near(r.solOut, 0.9090909090909, 1e-9);" },
      { name: "…at an average price of $110", code: "const r = A.swap({ usd: 1000, sol: 10 }, 100, 0); near(r.avgPrice, 110, 1e-9);" },
      { name: "with no fee, x · y is still 10,000 afterwards", code: "const r = A.swap({ usd: 1000, sol: 10 }, 100, 0); near(r.pool.usd * r.pool.sol, 10000, 1e-6); near(r.pool.usd, 1100, 1e-9);" },
      { name: "a 30 bps fee: $10,000 into $100,000 / 1,000 SOL gives 90.661 SOL", code: "const r = A.swap({ usd: 100000, sol: 1000 }, 10000, 30); near(r.solOut, 90.66108938801494, 1e-7);" },
      { name: "the fee stays in the pool, so k grows", code: "const r = A.swap({ usd: 100000, sol: 1000 }, 10000, 30); near(r.pool.usd, 110000, 1e-9, 'all of usdIn goes in'); assert(r.pool.usd * r.pool.sol > 1e8, 'k should grow');" },
      { name: "a buy's impact is exactly dx ÷ x (1% of the pool → 100 bps)", code: "const r = A.swap({ usd: 2000000, sol: 20000 }, 20000, 0); near((r.avgPrice / 100 - 1) * 10000, 100, 1e-6);" },
      { name: "the pool you pass in is not changed", code: "const p = { usd: 1000, sol: 10 }; A.swap(p, 100, 30); eq(p, { usd: 1000, sol: 10 });" },
    ],
    hints: [
      "`k = pool.usd * pool.sol`, and `dx = usdIn * (1 - feeBps / 10000)`.",
      "The SOL that must stay is `k / (pool.usd + dx)`, so `solOut = pool.sol - k / (pool.usd + dx)`. The average price is dollars paid per SOL received: `usdIn / solOut`.",
      "The new pool holds every dollar you paid and less SOL: `{ usd: pool.usd + usdIn, sol: pool.sol - solOut }`. Return `{ solOut, avgPrice: usdIn / solOut, pool: { usd: pool.usd + usdIn, sol: pool.sol - solOut } }`.",
    ],
    solution: [
      "function swap(pool, usdIn, feeBps) {",
      "  const k = pool.usd * pool.sol;",
      "  const dx = usdIn * (1 - feeBps / 10000);   // the fee stays in the pool",
      "  const solOut = pool.sol - k / (pool.usd + dx);",
      "  return {",
      "    solOut,",
      "    avgPrice: usdIn / solOut,",
      "    pool: { usd: pool.usd + usdIn, sol: pool.sol - solOut },",
      "  };",
      "}",
    ].join("\n"),
  };

  OBZ.lessons = OBZ.lessons || {};
  OBZ.lessons.amm = { curveExplorer, ammVsBook, jupiterRoutes, quoteContext, quoteNotes, routeText, routeLabels, SWAP_EX };

  /* ------------------------------------------------------------------ the chapter */
  OBZ.chapters.register({
    id: "amms",
    number: 10,
    title: "AMMs",
    summary: "Trading against a formula instead of a book: x·y = k, its price impact, and how prop AMMs and aggregators like Jupiter fit in, with real quotes.",
    goals: [
      "Work out an x·y = k trade by hand: SOL out, average price and impact",
      "Explain why a pool spreads its money over every price while a book's makers choose theirs",
      "Compare an AMM with a real order book of equal depth",
      "Describe what prop AMMs and aggregators do, using real Jupiter quotes",
    ],
    status: "ready",
    exercises: [SWAP_EX],

    render(el, ctx) {
      const { ui } = ctx;

      // ---------------- Explain
      const top = routeLabels(ctx.data.active()).map(([l]) => l).filter((l) => !/solfi/i.test(l)).slice(0, 2);
      const labelsLine = top.length ? ` In our data Jupiter's best routes mostly ran through venues it labels ${listWords(top)} and a few others, mostly prop AMMs run by market makers.` : "";
      const ex = ctx.section("explain", "A pool, a product and a curve");
      ex.append(
        ui.prose(`
An order book needs people to post orders. An [[amm|AMM]] (automated market maker) doesn't. It is a [[liquidity-pool|pool]] holding two tokens, say x dollars of USDC and y SOL, and one rule: after every trade, x times y must still equal the same number, k. That is the [[constant-product|constant-product]] rule, [[xyk|x·y = k]]. You don't trade with another person; you trade with the pool, and the formula sets the price.

**Worked example.** A pool holds **10 SOL and $1,000**, so k = 1,000 × 10 = 10,000. Its [[spot-price|spot price]] is the ratio x ÷ y = $100. You spend $100:

- dollars in the pool: x = 1,000 + 100 = 1,100
- SOL that must stay: y = 10,000 ÷ 1,100 = 9.0909
- SOL you receive: 10 − 9.0909 = **0.9091 SOL**
- your average price: 100 ÷ 0.9091 = **$110.00**, while the new spot price is 1,100 ÷ 9.0909 = $121.00

You paid 10% over the starting price: an impact of 1,000 bps. That is no accident. Work the algebra through and the average price of a buy is always spot × (1 + dx ÷ x), so **the impact of a buy is exactly dx ÷ x**: spend 1% of the pool's dollars and you pay 1% over spot. Double the pool and the impact halves.`),
        ui.prose(`
That is the big difference from a book. A pool quotes every price from almost zero to almost infinity, so its money is spread thinly over all of them. To push this curve's price up 2% you only need to add about 1% of x, because the price grows with x². An order book's [[market-maker|market makers]] instead put their size exactly where they choose, usually close to the mid. So only about 1% of an x·y = k pool's dollars sit within 2% of its price. To be as deep there as a book, the pool needs about 100× the book's depth within 2% of the price. [[concentrated-liquidity|Concentrated-liquidity]] AMMs fix part of this: on Orca **Whirlpool** and **Raydium CLMM** each provider picks a price range, and inside it the pool acts like a much bigger x·y = k pool; **Meteora DLMM** splits prices into fixed bins, a little like the levels of a book.

Two newer ideas matter on Solana. A [[prop-amm|prop AMM]] belongs to one market-making firm: there is no public curve and no outside depositors, and the firm's own program prices every trade from parameters the firm updates on-chain frequently, often every slot. To a trader it looks like any pool: send USDC, get SOL. [[solfi|SolFi]], from [[ellipsis-labs|Ellipsis Labs]], is one.${labelsLine} And an [[aggregator]] such as [[jupiter|Jupiter]] asks all of these venues, AMMs, prop AMMs and books like [[phoenix|Phoenix]], for a price, then splits your trade into a [[route]] across the cheapest ones.`),
        ui.Callout({
          kind: "project", title: "In this project: amm.py and jupiter.py",
          body: "`amm.py` (ported to this page as `amm.js`) prices trades on an x·y = k pool and builds `equivalent_pool`: a pool as deep as a real book within ±2% of its mid. `jupiter.py` asks Jupiter's public quote API how much SOL each route would give for $1K to $1M, both with no filter (the best route) and restricted to one venue at a time: SolFi, Phoenix, Whirlpool, Raydium CLMM and Meteora DLMM.",
        }));

      // ---------------- See
      const see = ctx.section("see", "Slide a trade along the curve");
      see.append(
        ui.p("This is the worked-example pool, with a $500 trade to start. Set it to $100 to check the numbers above. **Drag the orange dot** along the curve (or focus it and use the arrow keys, or use the slider) to spend more dollars. How steeply a line falls is SOL per dollar. The dashed line touches the curve at the start: SOL per dollar at the spot price, 1 SOL per $100. The solid line from *before* to *after* is what you actually got. It is always flatter, because each extra dollar buys a little less SOL than the one before: that gap is the impact."),
        ui.Figure({
          label: "Figure 10.1",
          children: curveExplorer(ctx, { usd: 1000, sol: 10, dx: 500 }),
          caption: "Every point on the curve has x · y = 10,000. A buy moves right (more dollars in) and down (less SOL left). The bigger the move, the flatter the solid line and the further your average price drifts above the spot price.",
          alt: "A downward-sloping curve of SOL in the pool against dollars in the pool, passing through $1,000 and 10 SOL. The starting trade of $500 moves the point to $1,500 and 6.67 SOL: 3.33 SOL out at an average of $150, spot after $225, impact 5,000 bps. A $100 trade gives 0.909 SOL at an average of $110, impact 1,000 bps. A dashed tangent at the start falls 1 SOL per $100, the spot price. A solid line from the start to the new point is flatter, because on average each dollar bought less SOL.",
        }));

      // ---------------- Try
      const tr = ctx.section("try", "A pool against a real book, and real routes");
      tr.append(
        ui.TryIt({
          title: "AMM vs a book of equal depth",
          intro: "Using the real 18 Oct 2026 books, this builds an x·y = k pool holding exactly as much money within ±2% of the mid as the book does (the project's `equivalent_pool`), then compares their impact at every size. Start with **Kraken**, then try **Phoenix**, and switch the band.",
          children: ammVsBook(ctx),
        }),
        ui.TryIt({
          title: "What Jupiter actually quoted",
          intro: "Real quotes the collector recorded for buying and selling SOL with USDC, by route and size. Compare the best route with each single venue, and look at which pools the best route used.",
          children: jupiterRoutes(ctx),
        }));
      const notesBox = h("div");
      const drawNotes = () => {
        clear(notesBox);
        const notes = quoteNotes(ctx.data.active());
        if (notes) notesBox.appendChild(ui.Callout({ kind: "real", title: "Reading these quotes carefully", body: `They come from one 5-minute snapshot round, so treat them as a snapshot, not a ranking.\n\n${notes}` }));
      };
      drawNotes();
      ctx.onData(drawNotes);
      tr.append(notesBox);
      tr.append(ui.ForProgrammers({ title: "Exercise · A constant-product swap in code", children: ui.CodeExercise(SWAP_EX) }));
    },

    quiz: [
      {
        q: "A pool holds $2,000 and 20 SOL. You spend $200 on SOL (no fee). How much SOL do you get, and at what average price?",
        options: [
          { text: "2 SOL at $100", why: "$100 is the spot price before the trade. As your dollars go in, the price climbs along the curve, so you get less than 2 SOL." },
          { text: "1.818 SOL at $110", why: "Right. k = 40,000. After the trade x = 2,200, so y = 40,000 ÷ 2,200 = 18.18 SOL, and you get 20 − 18.18 = 1.818 SOL. $200 ÷ 1.818 = $110: impact dx ÷ x = 10%." },
          { text: "1.818 SOL at $121", why: "$121 is the spot price after the trade (2,200 ÷ 18.18). You paid the average along the way: $200 ÷ 1.818 = $110." },
          { text: "1.98 SOL at $101", why: "That would be a 1% impact, which needs a trade of 1% of x ($20). $200 is 10% of the pool's dollars, so the impact is 10%." },
        ],
        answer: 1,
      },
      {
        q: "Why does an x·y = k pool need far more money than an order book to be equally deep within 2% of the price?",
        options: [
          { text: "Its money is spread over every price, so only about 1% of it sits within 2% of the price", why: "Right. Moving the price up 2% takes x × (√1.02 − 1) ≈ 0.99% of x. A book's makers put their size right where they want it, near the mid." },
          { text: "AMMs charge higher fees, and the fees eat into the pool's depth", why: "Fees change the cost of a trade, not how much money sits near the price. Even with no fee the pool's money is spread over all prices." },
          { text: "Pools can only trade in whole SOL, so small amounts of depth are lost", why: "Pools trade any amount; the formula works with fractions. The issue is where along the curve the money is." },
          { text: "Liquidity providers pull their money out whenever the price moves", why: "They can withdraw, but that isn't why. Even a pool that never changes keeps most of its money far from the current price." },
        ],
        answer: 0,
      },
      {
        q: "Suppose that in one snapshot round Jupiter's best $1K buy uses a single pool, its best $100K buy splits across three venues, and a SolFi-only quote finds no route at $100K. What is the fairest conclusion?",
        options: [
          { text: "SolFi is broken, since it couldn't quote the larger size", why: "A venue can quote small sizes and have no route for big ones. One round with no route at $100K doesn't say anything is broken." },
          { text: "Prop AMMs always beat order books, so books no longer matter", why: "One round is a snapshot. An order book can be part of a best route, and the winners can change from minute to minute." },
          { text: "Jupiter compares venues for each trade; which win depends on size and moment", why: "Right. The best route changes with size (one pool for a small trade, a split for a big one), and a venue that is cheapest at one size may have no route at another." },
          { text: "Jupiter always sends the whole trade to the single cheapest pool", why: "The $100K route in the question is split across three venues. Splitting is exactly what an aggregator is for." },
        ],
        answer: 2,
      },
    ],
  });
})(window.OBZ = window.OBZ || {});
