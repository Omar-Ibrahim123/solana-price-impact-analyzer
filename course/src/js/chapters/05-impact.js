/* chapters/05-impact.js: Chapter 5, "Price impact".
 *   Explain  walking the book, the quantity-weighted average fill, impact in bps, half-spread vs
 *            depth, price protection; a worked example on the real Phoenix book
 *   See      a Stepper that walks a real Phoenix snapshot level by level (fills from engine.simulate)
 *   Try      (a) trade-size slider on the real books: fills per level, average, bps, impact curves
 *            (b) a two-venue model (tight-but-thin vs wide-but-deep) with the crossover found
 *   Check    the quiz below
 * Every number on real data comes from OBZ.engine.simulate, which matches impact.py bit for bit.
 */
(function (OBZ) {
  "use strict";
  const { h, fmt, clear } = OBZ.util;
  /** el.append(...) that skips null/false children (plain append would insert the text "null"). */
  const put = (el, ...kids) => { el.append(...kids.filter((k) => k !== null && k !== undefined && k !== false)); return el; };

  /* ------------------------------------------------------------------ helpers */
  function priceDigits(snap) {
    if (!snap) return 2;
    return Math.max(2, Math.min(4, Math.round(-Math.log10(snap.tickSize))));
  }
  /** Fills (best first) grouped by price level: [{priceTicks, price, lots, sol, usd}] */
  function byLevel(snap, fills) {
    const out = [];
    for (const f of fills) {
      let row = out.length ? out[out.length - 1] : null;
      if (!row || row.priceTicks !== f.priceTicks) { row = { priceTicks: f.priceTicks, price: snap.price(f.priceTicks), lots: 0 }; out.push(row); }
      row.lots += f.sizeLots;
    }
    for (const r of out) { r.sol = snap.size(r.lots); r.usd = r.price * r.sol; }
    return out;
  }
  /** Half the spread, in bps of the mid: the cost of the very first lot. */
  function halfSpreadBps(snap, side) {
    const mid = snap.midPrice();
    if (mid === null) return null;
    return side === "buy" ? (snap.price(snap.bestAsk()) - mid) / mid * 1e4 : (mid - snap.price(snap.bestBid())) / mid * 1e4;
  }
  /** Round a slider value to two significant figures ($12,589 -> $13,000). */
  function niceSize(v) {
    const p = Math.pow(10, Math.floor(Math.log10(v)) - 1);
    return Math.round(v / p) * p;
  }
  function when(v) { return v && v.fetchedAt ? fmt.date(v.fetchedAt) : "an unknown time"; }
  function pickVenue(data, preferred) { return data.venue(preferred) ? preferred : data.venues()[0]; }

  /* ------------------------------------------------------------------ Explain: live table */
  function tenKTable(ctx) {
    const { ui, data } = ctx;
    const box = h("div", { class: "stack" });
    function render() {
      const rows = [];
      for (const name of data.venues()) {
        const snap = data.snapshot(name);
        if (!snap || snap.midPrice() === null) continue;
        const r = OBZ.engine.simulate(snap, "buy", 10000);
        const d = priceDigits(snap);
        rows.push({
          venue: data.label(name),
          ask: "$" + fmt.price(snap.price(snap.bestAsk()), d),
          avg: r.avgPrice === null ? "–" : "$" + fmt.price(r.avgPrice, d + 2),
          half: fmt.bps(halfSpreadBps(snap, "buy")),
          impact: fmt.bps(r.impactBps) + (r.fullyFilled ? "" : " (partial)"),
          levels: String(r.levelsSwept),
        });
      }
      const v = data.venue(data.venues()[0]);
      clear(box).append(
        ui.Table({
          caption: `A $10,000 market buy on each venue (books fetched ${when(v)})`,
          columns: [
            { key: "venue", label: "Venue", align: "left", mono: false },
            { key: "ask", label: "Best ask" },
            { key: "avg", label: "Average fill" },
            { key: "half", label: "Half-spread" },
            { key: "impact", label: "Impact" },
            { key: "levels", label: "Levels" },
          ],
          rows, dense: true,
        }),
        h("p", { class: "fine", text: "Computed in your browser by the same engine and impact code as the project (impact.py), on the built-in snapshots." }));
    }
    render();
    ctx.onData(render);
    return box;
  }

  /* ------------------------------------------------------------------ See: walk the book */
  /** The first n ask levels, orders at the same price merged: [{priceTicks, price, sol, usd}] */
  function askLevels(snap, n) {
    const out = [];
    for (const [p, s] of snap.asks) {
      const last = out[out.length - 1];
      if (last && last.priceTicks === p) { last.sol += snap.size(s); continue; }
      if (out.length === n) break;
      out.push({ priceTicks: p, price: snap.price(p), sol: snap.size(s) });
    }
    for (const l of out) l.usd = l.price * l.sol;
    return out;
  }
  /** Pick a buy size that sweeps about five ask levels of this snapshot, as a round number. */
  function walkSize(snap) {
    const usd = askLevels(snap, 6).map((l) => l.usd);
    if (!usd.length) return 1000;
    const n = Math.min(4, usd.length - 1);
    let cum = 0; for (let i = 0; i < n; i++) cum += usd[i];
    const step = cum > 20000 ? 5000 : cum > 2000 ? 1000 : 100;
    let target = Math.ceil((cum + 0.1 * (usd[n] || 0)) / step) * step;
    if (usd[n] && target >= cum + usd[n]) target = Math.round((cum + usd[n] / 2) / step) * step || step;
    return target;
  }

  function buildWalk(ctx) {
    const { ui, data } = ctx;
    const name = pickVenue(data, "phoenix");
    const v = data.venue(name), snap = data.snapshot(name);
    if (!v || !snap || snap.midPrice() === null || !snap.asks.length) return ui.p("This dataset has no two-sided book to walk.");
    const d = priceDigits(snap);
    const target = walkSize(snap);
    const r = OBZ.engine.simulate(snap, "buy", target);
    const levels = byLevel(snap, r.fills);
    const mid = r.midPrice;
    const half = halfSpreadBps(snap, "buy");
    const limitTicks = OBZ.engine.protectionLimit(snap, OBZ.engine.BID, mid, OBZ.engine.DEFAULT_MAX_SLIPPAGE);

    // Rows to draw: the swept levels plus the next one, best ask at the bottom (next to the mid).
    const rows = askLevels(snap, Math.min(levels.length + 1, 6));
    const maxSol = Math.max(...rows.map((x) => x.sol));
    const ROW = 34, TOP = 34, BAR_X = 90, BAR_W = 160;
    const baseY = TOP + rows.length * ROW; // y of the mid line
    const H = baseY + 150;
    const svg = h("svg", { class: "diagram diagram-md", viewBox: `0 0 440 ${H}`, attrs: { role: "img", "aria-label": `A $${fmt.int(target)} market buy walking up ${v.label}'s ask levels` } });
    const stage = h("g");
    svg.append(h("text", { x: 8, y: 18, class: "t-muted", text: "▼ ASKS (sellers): cheapest at the bottom" }), stage);

    function rowY(i) { return baseY - (i + 1) * ROW + 6; } // i = 0 is the best ask

    function draw(step) {
      clear(stage);
      const k = Math.min(step, levels.length); // levels taken so far
      let spent = 0, sol = 0;
      for (let i = 0; i < k; i++) { spent += levels[i].usd; sol += levels[i].sol; }
      rows.forEach((row, i) => {
        const y = rowY(i);
        const w = Math.max(10, row.sol / maxSol * BAR_W);
        const takenSol = i < k ? levels[i].sol : 0;
        const current = step >= 1 && step <= levels.length && i === step - 1;
        const g = h("g", { class: i < k || current || step === 0 ? "" : "dim" });
        put(g,
          h("text", { x: 8, y: y + 16, class: "t-mono t-bold t-ask", text: "$" + fmt.price(row.price, d) }),
          h("rect", { x: BAR_X, y, width: w, height: 22, rx: 4, class: "box-ask" }),
          takenSol > 0 ? h("rect", { x: BAR_X, y, width: Math.max(3, takenSol / maxSol * BAR_W), height: 22, rx: 4, class: "fill-accent", style: "opacity: 0.85" }) : null,
          h("text", { x: BAR_X + BAR_W + 8, y: y + 16, class: "t-mono", text: fmt.sol(row.sol) + " SOL" }));
        if (takenSol > 0) g.append(h("text", { x: 432, y: y + 16, "text-anchor": "end", class: "t-mono t-accent t-bold", text: (takenSol < row.sol - 1e-9 ? "took " : "all ") + fmt.sol(takenSol) }));
        if (current) g.append(h("rect", { x: 2, y: y - 4, width: 436, height: 30, rx: 6, fill: "none", class: "hl" }));
        stage.append(g);
      });
      // mid line and best bid
      stage.append(
        h("line", { x1: 0, x2: 440, y1: baseY + 4, y2: baseY + 4, class: "line-accent line-dash" }),
        h("text", { x: 8, y: baseY + 22, class: "t-bold t-accent", text: "mid $" + fmt.price(mid, d) }),
        h("text", { x: 432, y: baseY + 22, "text-anchor": "end", class: "t-muted", text: "best bid $" + fmt.price(snap.price(snap.bestBid()), d) + " ▲" }));
      // running totals
      const y0 = baseY + 44;
      const avg = sol ? spent / sol : null;
      const imp = avg === null ? null : (avg - mid) / mid * 1e4;
      stage.append(
        h("rect", { x: 0, y: y0, width: 440, height: 96, rx: 8, class: "box" }),
        h("text", { x: 14, y: y0 + 24, class: "t-mono", text: `spent  ${fmt.usd(spent)} of ${fmt.usd(target, 0)}` }),
        h("text", { x: 14, y: y0 + 46, class: "t-mono", text: `bought ${fmt.sol(sol)} SOL over ${k} level${k === 1 ? "" : "s"}` }),
        h("text", { x: 14, y: y0 + 68, class: "t-mono t-bold", text: `average ${avg === null ? "–" : "$" + fmt.price(avg, d + 1)}` }),
        h("text", { x: 14, y: y0 + 88, class: "t-mono t-bold t-accent", text: `impact  ${imp === null ? "–" : fmt.bps(imp, 1)}` }));
    }

    const steps = [`A market buy for **${fmt.usd(target, 0)}** arrives at ${v.label}'s real book (fetched ${when(v)}). The mid is **$${fmt.price(mid, d)}**; the cheapest seller asks $${fmt.price(levels[0] ? levels[0].price : snap.price(snap.bestAsk()), d)}. The engine starts at the best ask and works upward.`];
    let left = target;
    levels.forEach((lv, i) => {
      const row = rows[i];
      const full = row && lv.sol >= row.sol - 1e-9;
      left -= lv.usd;
      steps.push(`Level ${i + 1}: **$${fmt.price(lv.price, d)}** offers ${fmt.sol(row ? row.sol : lv.sol)} SOL. ` +
        (full ? `The order takes all of it: ${fmt.sol(lv.sol)} SOL for ${fmt.usd(lv.usd)}. ${left > 0.005 ? `Still to spend: ${fmt.usd(Math.max(0, left))}.` : ""}`
          : `The order needs only ${fmt.usd(lv.usd + Math.max(0, left))} more, so it takes **${fmt.sol(lv.sol)} SOL** (rounded up to whole lots) and the rest of this level stays in the book.`));
    });
    const halfPart = Math.min(half, r.impactBps);
    steps.push(`Done: **${fmt.sol(r.filledBase)} SOL** for **${fmt.usd(r.filledUsd)}**. Average fill = dollars ÷ SOL = **$${fmt.price(r.avgPrice, d + 2)}**. Impact = (${fmt.price(r.avgPrice, d + 2)} − ${fmt.price(mid, d)}) ÷ ${fmt.price(mid, d)} × 10,000 = **${fmt.bps(r.impactBps, 1)}**. Of that, ${fmt.bps(halfPart, 1)} is the half-spread (the first lot already cost that much) and ${fmt.bps(r.impactBps - halfPart, 1)} came from climbing ${levels.length - 1} more level${levels.length === 2 ? "" : "s"}.`);
    const nextRow = rows[levels.length];
    const beyond = nextRow && nextRow.priceTicks > limitTicks
      ? ` Look at the next seller: $${fmt.price(nextRow.price, d)}, already outside the band. A bigger order would empty the $${fmt.price(levels[levels.length - 1].price, d)} level and then stop, reporting a partial fill instead of paying that.`
      : " Here it stopped long before that.";
    steps.push(`The order also carried **price protection**: it would never pay more than $${fmt.price(snap.price(limitTicks), d)} (the mid + 10%).${beyond} On a thin book, the band is what stops a big order from reaching absurd prices.`);

    return ui.Figure({
      label: "Figure 5.1",
      children: ui.Stepper({ steps, stage: svg, render: (i) => draw(i), interval: 2400, label: "A market buy walking the book" }),
      caption: `A real ${fmt.usd(target, 0)} buy on ${v.label}, computed with the project's impact code. Each bar is one price level; the filled part is what the order took. The running average rises with every level.`,
      alt: `Walking ${v.label}'s ask levels with a ${fmt.usd(target, 0)} market buy. ` + levels.map((lv, i) => `Level ${i + 1} at $${fmt.price(lv.price, d)}: took ${fmt.sol(lv.sol)} SOL for ${fmt.usd(lv.usd)}.`).join(" ") +
        ` In total ${fmt.sol(r.filledBase)} SOL for ${fmt.usd(r.filledUsd)}, average $${fmt.price(r.avgPrice, d + 2)}, impact ${fmt.bps(r.impactBps, 1)} against a mid of $${fmt.price(mid, d)}, of which ${fmt.bps(halfPart, 1)} is the half-spread.`,
    });
  }

  /* ------------------------------------------------------------------ Try (a): size it yourself */
  const CURVE_SIZES = OBZ.engine.logSpacedSizes(1000, 1000000, 8);

  function buildSizer(ctx) {
    const { ui, data, store } = ctx;
    let venueName = pickVenue(data, store.get("ch5.venue", "phoenix"));
    let side = store.get("ch5.side", "buy") === "sell" ? "sell" : "buy";
    let size = Number(store.get("ch5.size", 10000)) || 10000;
    const curves = new Map(); // dataset label|side -> series

    const pickerBox = h("div");
    const sideSeg = ui.Segmented({ label: "Side", value: side, options: [{ value: "buy", label: "▲ Buy (lift asks)" }, { value: "sell", label: "▼ Sell (hit bids)" }], onChange: (s) => { side = s; store.set("ch5.side", s); render(); } });
    const slider = ui.Slider({ label: "Trade size", min: 1000, max: 1000000, value: size, log: true, format: (x) => fmt.usd(niceSize(x), 0), onInput: (x) => { size = niceSize(x); schedule(); } });
    const quick = h("div", { class: "btn-row" }, [1e3, 1e4, 1e5, 1e6].map((s) => ui.Button({ label: fmt.usdCompact(s), small: true, variant: "ghost", attrs: { "aria-label": "Set trade size to " + fmt.usd(s, 0) }, onClick: () => { size = s; slider.api.set(s); render(); } })));
    const stats = {
      avg: ui.Stat({ label: "Average fill" }),
      impact: ui.Stat({ label: "Impact", tone: "accent" }),
      half: ui.Stat({ label: "of which half-spread" }),
      filled: ui.Stat({ label: "Filled" }),
      levels: ui.Stat({ label: "Levels swept" }),
    };
    const note = h("div", { class: "readout-panel", attrs: { "aria-live": "polite" } });
    const tableBox = h("div");
    const source = h("p", { class: "fine" });
    const chart = ui.LineChart({
      series: [], height: 250, table: true,
      x: { log: true, label: "Trade size (USD, log scale)", format: fmt.usdCompact, ticks: [1e3, 1e4, 1e5, 1e6] },
      y: { label: "Impact (bps)", format: (x) => x.toFixed(0), min: 0 },
      alt: "Impact curves for each venue",
    });

    let raf = 0;
    function schedule() { if (raf) return; raf = 1; requestAnimationFrame(() => { raf = 0; render(); }); }

    function seriesFor() {
      const key = data.active().label + "|" + side;
      if (curves.has(key)) return curves.get(key);
      const s = data.venues().map((name, i) => {
        const snap = data.snapshot(name);
        const pts = snap && snap.midPrice() !== null ? OBZ.engine.impactCurve(snap, side, CURVE_SIZES).map((r) => [r.targetUsd, r.impactBps, r.fullyFilled]) : [];
        return { name: data.label(name), color: data.colorVar(name, i), points: pts };
      });
      curves.set(key, s);
      return s;
    }

    function render() {
      store.set("ch5.size", size);
      const v = data.venue(venueName), snap = data.snapshot(venueName);
      if (!v || !snap || snap.midPrice() === null) { clear(tableBox).append(ui.p("This venue has a one-sided book, so impact can't be measured.")); return; }
      const d = priceDigits(snap);
      const r = OBZ.engine.simulate(snap, side, size);
      const lv = byLevel(snap, r.fills);
      const half = halfSpreadBps(snap, side);
      stats.avg.api.set(r.avgPrice === null ? "–" : "$" + fmt.price(r.avgPrice, d + 2), "dollars ÷ SOL");
      stats.impact.api.set(fmt.bps(r.impactBps, 2), side === "buy" ? "(avg − mid) ÷ mid" : "(mid − avg) ÷ mid");
      stats.half.api.set(fmt.bps(half, 2), r.impactBps === null ? "" : "depth adds " + fmt.bps(Math.max(0, r.impactBps - half), 2));
      stats.filled.api.set(fmt.usd(r.filledUsd, 0), fmt.sol(r.filledBase) + " SOL");
      stats.levels.api.set(String(r.levelsSwept), lv.length > 1 ? "price levels touched" : "only the best level");

      clear(note);
      if (r.filledBase === 0) note.append(ui.p(`**Nothing fills.** No ${side === "buy" ? "asks" : "bids"} sit within 10% of the mid.`));
      else if (!r.fullyFilled) note.append(ui.p(`**Partial fill.** Only ${fmt.usd(r.filledUsd)} of ${side === "buy" ? "asks" : "bids"} sit within 10% of the mid on this book, so price protection stops the order there. The impact shown is for the part that filled.`));
      else note.append(ui.p(`A ${fmt.usd(size, 0)} ${side} on ${v.label} fills completely across **${r.levelsSwept} level${r.levelsSwept === 1 ? "" : "s"}**. ${r.levelsSwept === 1 ? "The best level was enough, so the only cost is the half-spread." : "Each level after the first is a worse price, which pulls the average away from the mid."}`));

      let run$ = 0, runSol = 0;
      const rows = lv.map((x, i) => { run$ += x.usd; runSol += x.sol; return { n: i + 1, price: "$" + fmt.price(x.price, d), sol: fmt.sol(x.sol), usd: fmt.usd(x.usd), avg: "$" + fmt.price(run$ / runSol, d + 2) }; });
      const MAXR = 10;
      put(clear(tableBox),
        rows.length ? ui.Table({
          caption: `Fills level by level (${side === "buy" ? "asks, cheapest first" : "bids, highest first"})`,
          columns: [{ key: "n", label: "Level" }, { key: "price", label: "Price" }, { key: "sol", label: "SOL" }, { key: "usd", label: "Dollars" }, { key: "avg", label: "Running average" }],
          rows: rows.slice(0, MAXR), dense: true,
        }) : null,
        rows.length > MAXR ? h("p", { class: "fine", text: `…and ${rows.length - MAXR} more levels, ending at $${fmt.price(lv[lv.length - 1].price, d)}.` }) : null);

      source.textContent = `${data.active().source === "builtin" ? "Real snapshot" : "Your data"}: ${v.label} ${v.symbol}, fetched ${when(v)}. Mid $${fmt.price(r.midPrice, Math.max(d, 3))}. Every order carries 10% price protection, like impact.py.`;
      chart.api.update({
        series: seriesFor(),
        annotations: [{ x: size, label: fmt.usdCompact(size), color: "--ink" }],
        alt: `Impact in bps against trade size for each venue, ${side === "buy" ? "buying" : "selling"} SOL. Hollow markers are partial fills.`,
      });
    }

    function mountPicker() {
      clear(pickerBox).append(ui.VenuePicker({ venues: data.venues(), value: venueName, onChange: (x) => { venueName = x; store.set("ch5.venue", x); render(); } }));
    }
    mountPicker();
    render();
    ctx.onData(() => { curves.clear(); venueName = pickVenue(data, venueName); mountPicker(); render(); });

    return h("div", { class: "stack" },
      h("div", { class: "btn-row" }, pickerBox, sideSeg), source,
      slider, quick,
      ui.StatGrid(Object.values(stats), { live: true }), note, tableBox,
      ui.Figure({
        children: chart,
        caption: "The same simulation at 25 sizes per venue: an [[impact-curve|impact curve]] on a [[log-scale|log scale]]. Where a curve starts is the half-spread; how fast it climbs is depth. Hollow markers are partial fills (the book ran out inside the 10% band). The thin vertical line is your size.",
      }));
  }

  /* ------------------------------------------------------------------ Try (b): spread vs depth model */
  const MODEL_MID = 104, MODEL_TICK = 0.01;
  const MODEL_SIZES = OBZ.engine.logSpacedSizes(1000, 1000000, 16);
  /** Buy usd on a model book: best ask = mid + half-spread, then a level every $0.01 holding depthSol each. */
  function modelImpact(usd, spreadBps, depthSol) {
    let price = MODEL_MID * (1 + spreadBps / 2e4), left = usd, qty = 0, cost = 0, n = 0;
    while (left > 1e-9 && n < 200000) {
      const take = Math.min(depthSol, left / price);
      qty += take; cost += take * price; left -= take * price; price += MODEL_TICK; n++;
    }
    return { bps: (cost / qty - MODEL_MID) / MODEL_MID * 1e4, levels: n };
  }

  function buildModel(ctx) {
    const { ui, store } = ctx;
    const st = Object.assign({ aS: 2, aD: 20, bS: 12, bD: 800 }, store.get("ch5.model", {}));
    const out = h("div", { class: "readout-panel", attrs: { "aria-live": "polite" } });
    const chart = ui.LineChart({
      series: [], height: 250, table: true,
      x: { log: true, label: "Trade size (USD, log scale)", format: fmt.usdCompact, ticks: [1e3, 1e4, 1e5, 1e6] },
      y: { label: "Impact (bps)", format: (x) => x.toFixed(0), min: 0 },
      alt: "Model impact curves for venue A and venue B",
    });
    const sl = (key, label, opts) => ui.Slider(Object.assign({ label, value: st[key], onInput: (x) => { st[key] = opts.log ? Math.round(x) : x; schedule(); } }, opts));
    const controls = h("div", { class: "grid-2" },
      h("div", { class: "card stack" }, h("p", null, h("strong", { text: "Venue A" }), " · tight but thin"),
        sl("aS", "Spread", { min: 1, max: 40, step: 1, format: (x) => x + " bps" }),
        sl("aD", "SOL per price level", { min: 5, max: 2000, log: true, format: (x) => fmt.int(x) + " SOL" })),
      h("div", { class: "card stack" }, h("p", null, h("strong", { text: "Venue B" }), " · wide but deep"),
        sl("bS", "Spread", { min: 1, max: 40, step: 1, format: (x) => x + " bps" }),
        sl("bD", "SOL per price level", { min: 5, max: 2000, log: true, format: (x) => fmt.int(x) + " SOL" })));
    let raf = 0;
    function schedule() { if (raf) return; raf = 1; requestAnimationFrame(() => { raf = 0; render(); }); }

    function render() {
      store.set("ch5.model", st);
      const a = MODEL_SIZES.map((u) => modelImpact(u, st.aS, st.aD).bps);
      const b = MODEL_SIZES.map((u) => modelImpact(u, st.bS, st.bD).bps);
      // crossover: first size where the cheaper venue changes
      let cross = null;
      for (let i = 1; i < MODEL_SIZES.length; i++) {
        const d0 = a[i - 1] - b[i - 1], d1 = a[i] - b[i];
        if (d0 === 0 || (d0 < 0) !== (d1 < 0)) {
          // refine by bisection on a log scale
          let lo = Math.log10(MODEL_SIZES[i - 1]), hi = Math.log10(MODEL_SIZES[i]);
          for (let k = 0; k < 30; k++) { const m = (lo + hi) / 2, u = Math.pow(10, m); const dm = modelImpact(u, st.aS, st.aD).bps - modelImpact(u, st.bS, st.bD).bps; if ((dm < 0) === (d0 < 0)) lo = m; else hi = m; }
          cross = Math.pow(10, (lo + hi) / 2); break;
        }
      }
      // rule of thumb: impact ≈ s/2 + k·Q with k = tick·1e4 / (2·depth·mid) bps per SOL
      const kA = MODEL_TICK * 1e4 / (2 * st.aD * MODEL_MID), kB = MODEL_TICK * 1e4 / (2 * st.bD * MODEL_MID);
      const qStar = kA !== kB ? ((st.bS - st.aS) / 2) / (kA - kB) : null;
      chart.api.update({
        series: [
          { name: "Venue A (tight, thin)", color: "--accent", points: MODEL_SIZES.map((u, i) => [u, a[i]]), markers: false },
          { name: "Venue B (wide, deep)", color: "--mine", points: MODEL_SIZES.map((u, i) => [u, b[i]]), markers: false, width: 3 },
        ],
        annotations: cross ? [{ x: cross, label: "crossover " + fmt.usdCompact(cross), color: "--ink" }] : [],
      });
      const cheaper = (i) => (a[i] < b[i] ? "A" : b[i] < a[i] ? "B" : "neither");
      const first = 0, last = MODEL_SIZES.length - 1;
      clear(out).append(
        ui.p(`At **$1K**: A ${fmt.bps(a[first], 1)}, B ${fmt.bps(b[first], 1)}. At **$1M**: A ${fmt.bps(a[last], 1)}, B ${fmt.bps(b[last], 1)}.`),
        ui.p(cross
          ? `Venue ${cheaper(first)} is cheaper below about **${fmt.usd(niceSize(cross), 0)}**, venue ${cheaper(last)} above it.` +
            (qStar !== null && qStar > 0 ? ` The rule of thumb below predicts ${fmt.sol(qStar)} SOL ≈ ${fmt.usd(niceSize(qStar * MODEL_MID), 0)}.` : "")
          : `With these settings venue ${cheaper(first)} is cheaper at every size from $1K to $1M: one venue is both tighter and deeper (or the curves cross outside this range).`));
    }
    render();
    return h("div", { class: "stack" }, controls, ui.Figure({
      children: chart,
      caption: "A **model**, not real data: each book has its best ask half a spread above a $104 mid, then a price level every $0.01 holding the same amount of SOL.",
    }), out,
    h("p", { class: "formula" }, "impact ≈ half-spread + (SOL bought ÷ SOL per level) × $0.01 ÷ 2 ÷ mid × 10,000"),
    ui.p("Why: buying Q SOL on levels of d SOL each climbs Q ÷ d levels, a cent each, and on average you pay about half of that climb. Set the two right-hand sides equal and solve for Q: that is the crossover. Below it the half-spread decides; above it, depth does."));
  }

  /* ------------------------------------------------------------------ the chapter */
  OBZ.chapters.register({
    id: "impact",
    number: 5,
    title: "Price impact",
    summary: "Why a big order costs more per SOL than a small one: walk the book level by level, average the fills, and measure the cost in basis points.",
    goals: [
      "Compute an average fill price and its impact in bps by hand",
      "Explain why impact against the mid always includes half the spread",
      "Say when the spread matters and when depth matters, and find the crossover",
      "Read impact curves for Phoenix, Kraken and Coinbase on real books",
    ],
    status: "ready",

    render(el, ctx) {
      const { ui } = ctx;

      // ---------------- Explain
      const ex = ctx.section("explain", "Walking the book");
      ex.append(
        ui.prose(`
In [chapter 3](#/learn/3) you met the [[market-order|market order]]: "buy 100 SOL now, at whatever the book offers". The engine fills it against the best ask first. If that seller doesn't have enough, the order moves up to the next price level, and the next, until it is done. Traders call this [[walking-the-book|walking the book]].

Think of buying concert tickets online when the cheap seats are nearly gone. You get the last two at $50, the next four at $60, and the rest at $75. You paid more than one price, so the honest summary is an average.`),
        ui.prose(`
That average is the [[average-fill-price|average fill price]]: total dollars paid ÷ total SOL received. It is a *weighted* average: a fill of 70 SOL counts for more than a fill of 25 SOL, because more of your money went there.`),
        h("p", { class: "formula" }, "average fill = (p₁ × q₁ + p₂ × q₂ + …) ÷ (q₁ + q₂ + …)"),
        ui.prose(`
[[price-impact|Price impact]] says how much worse that average was than the [[mid-price|mid price]] just before you traded, in [[basis-point|basis points]]. The sign is chosen so that impact is a cost in both directions:`),
        h("p", { class: "formula" }, "buy impact = (average − mid) ÷ mid × 10,000"),
        h("p", { class: "formula" }, "sell impact = (mid − average) ÷ mid × 10,000"),
        ui.Callout({
          kind: "tip", title: "Worked example on the real Phoenix book",
          body: `At 04:31 UTC on 18 October 2026, [[phoenix|Phoenix]]'s mid was **$104.050**. A $10,000 buy took **25 SOL at $104.35** (all of the best ask) and **70.798 SOL at $104.40**.

- Dollars: 25 × 104.35 + 70.798 × 104.40 = 2,608.75 + 7,391.31 = **$10,000.06**
- SOL: 25 + 70.798 = **95.798**
- Average: 10,000.06 ÷ 95.798 ≈ **$104.387**
- Impact: (104.387 − 104.050) ÷ 104.050 × 10,000 ≈ **32.4 bps**

The first lot alone, at $104.35, already cost (104.35 − 104.05) ÷ 104.05 × 10,000 ≈ 28.8 bps. That is the [[half-spread|half-spread]].`,
        }),
        ui.prose(`
That last line is the key idea. Measured against the mid, every trade pays at least the half-spread, because even the tiniest buy trades at the best ask, not at the mid. Everything above that comes from [[depth]]: how much SOL sits at each level, so how far a given order must climb.

So the [[spread]] decides the cost of small trades, and depth decides the cost of large ones. Phoenix's wide spread made a $1,000 buy cost about 29 bps there, against under 1 bp on [[kraken|Kraken]]. For a $1,000,000 buy, Kraken's millions of dollars of depth kept the cost near 10 bps.`),
        tenKTable(ctx),
        ui.prose(`
One more rule keeps these numbers honest. Phoenix's raw book also held [[junk-quote|junk quotes]]: asks at $9,999,999,999 and bids at $0.001. A "$1M buy" with no limit would fill against them and report nonsense (the README measured about 56,000 bps). So, like a careful trader, the simulator gives every order [[price-protection|price protection]]: it never trades more than 10% away from the mid, and whatever can't fill inside that band is reported as a partial fill. In this snapshot only $47,069 of Phoenix asks sat inside the band, so a $100K buy fills only partly. [Chapter 11](#/learn/11) tells the full story.`),
        ui.Callout({
          kind: "project", title: "Where this lives in the code",
          body: `\`impact.py\` does exactly this. \`lots_for_notional\` walks the opposite side to find how many lots a dollar amount needs (rounding the last level up to a whole lot), then \`simulate\` loads the snapshot into a fresh \`OrderBook\` and sends one market order with a 10% limit price. It never re-implements matching. Every number in this chapter comes from a JavaScript port of that code which reproduces its results bit for bit.`,
        }));

      // ---------------- See
      const see = ctx.section("see", "One order, level by level");
      const seeBox = h("div");
      const drawSee = () => clear(seeBox).append(buildWalk(ctx));
      drawSee();
      ctx.onData(drawSee);
      see.append(ui.p("Step through a real market buy on Phoenix's book. Watch the running average: every new level pulls it further from the mid."), seeBox);

      // ---------------- Try
      const tr = ctx.section("try", "Size a trade on real books");
      const kx = { p1: 103.95, q1: 5.871, p2: 103.96, q2: 90.32 };
      const kAvg = (kx.p1 * kx.q1 + kx.p2 * kx.q2) / (kx.q1 + kx.q2);
      tr.append(
        ui.TryIt({
          title: "Drag the size, watch the fills",
          intro: "Pick a venue and a side, then drag the trade size from $1K to $1M (or use the buttons). Try: the same $10K on Phoenix and on Kraken; then a $100K buy on Phoenix, where the 10% band runs out.",
          children: buildSizer(ctx),
        }),
        ui.NumberCheck({
          question: `Your turn: in the same snapshot, a $10,000 buy on Kraken took **${kx.q1} SOL at $${kx.p1}** and **${kx.q2} SOL at $${kx.p2}**. What was its average fill price? (Three decimals is plenty.)`,
          answer: Math.round(kAvg * 1000) / 1000, tolerance: 0.0015, unit: "dollars",
          explain: `(${kx.q1} × ${kx.p1} + ${kx.q2} × ${kx.p2}) ÷ (${kx.q1} + ${kx.q2}) = ${fmt.usd(kx.p1 * kx.q1 + kx.p2 * kx.q2)} ÷ ${(kx.q1 + kx.q2).toFixed(3)} ≈ **$${kAvg.toFixed(4)}**. Almost all of it filled at $103.96, so the average sits very close to that price, not halfway between the two.`,
          hint: "Multiply each price by its SOL, add the two dollar amounts, then divide by the total SOL. A plain average of the two prices ($103.955) ignores that most of the SOL came from the second level.",
        }),
        ui.TryIt({
          title: "Tight but thin, or wide but deep?",
          intro: "Two made-up venues with the same mid. A has a tight spread but little SOL per level; B has a wide spread but lots of SOL per level. Predict which is cheaper for a $1K buy and for a $1M buy, then move the sliders. Can you make the crossover disappear?",
          children: buildModel(ctx),
        }),
        ui.Callout({
          kind: "real", title: "What the real books showed",
          body: `In this snapshot Phoenix was both wider and thinner than the exchanges, so its curve is higher at every size: there is no crossover with Kraken. Kraken and Coinbase had the same spread (about 0.96 bps), but Kraken's best ask held only 5.9 SOL, so small buys were slightly cheaper on Coinbase while Kraken's deeper levels made it cheaper at $1M. Liquidity changes all day, which is why the project's collector measures all three venues every five minutes ([chapter 11](#/learn/11)).`,
        }));
    },

    quiz: [
      {
        q: "A buy fills **10 SOL at $100.00** and **30 SOL at $100.20**. What is the average fill price?",
        options: [
          { text: "$100.10", why: "That is the plain average of the two prices. It treats both fills as equally important, but three times as much SOL traded at $100.20, so the average must lean towards $100.20." },
          { text: "$100.15", why: "Dollars: 10 × 100.00 + 30 × 100.20 = 1,000 + 3,006 = $4,006. SOL: 40. Average: 4,006 ÷ 40 = $100.15. It sits three quarters of the way to $100.20 because three quarters of the SOL filled there." },
          { text: "$100.20", why: "That is the last (worst) price the order reached. The first 10 SOL were cheaper, so the average is below $100.20." },
          { text: "$100.05", why: "That leans the wrong way: it weights the $100.00 fill more heavily, but only 10 of the 40 SOL filled there." },
        ],
        answer: 1,
      },
      {
        q: "Just before that buy, the best bid was $99.90 and the best ask $100.00, so the mid was $99.95. What was the price impact?",
        options: [
          { text: "15 bps", why: "That measures against $100.00, the best ask. Impact is measured against the mid, so it includes the half-spread: (100.15 − 99.95) ÷ 99.95 × 10,000 ≈ 20 bps." },
          { text: "About 20 bps", why: "(100.15 − 99.95) ÷ 99.95 × 10,000 ≈ 20.0 bps. About 5 bps of that is the half-spread ($0.05 on a $99.95 mid) and the rest comes from walking up to the $100.20 level." },
          { text: "0.2 bps", why: "$0.20 ÷ $99.95 ≈ 0.002, which is 0.2%. Basis points are hundredths of a percent, so multiply the fraction by 10,000, not 100: about 20 bps." },
          { text: "−20 bps, because the price went up", why: "For a buy, impact = (average − mid) ÷ mid, which is positive when you paid more than the mid. The formula is signed so that impact is always a cost, for buys and sells alike." },
        ],
        answer: 1,
      },
      {
        q: "Venue A has a 2 bps spread and 20 SOL per price level. Venue B has a 12 bps spread and 800 SOL per level. Which is cheaper for a $1,000 buy, and for a $1,000,000 buy?",
        options: [
          { text: "A for both: a tighter spread is always cheaper", why: "The spread only sets where the impact curve starts. A $1M order on A must climb thousands of thin levels, so its depth cost swamps the 10 bps it saved on the spread." },
          { text: "A for $1,000, B for $1,000,000", why: "A $1,000 buy (under 10 SOL) fits in the first level of either venue, so it pays only the half-spread: 1 bps on A against 6 bps on B. A $1M buy (about 9,600 SOL) climbs hundreds of A's levels but only a dozen of B's, so B's depth wins. The curves cross in between." },
          { text: "B for both: a deeper book is always cheaper", why: "Depth only helps once a trade is bigger than the first level. A $1,000 buy never leaves the best ask, so it pays B's half-spread of 6 bps instead of A's 1 bps." },
          { text: "They cost the same, because the mid is the same", why: "The same mid is the starting point, but the two books offer different prices around it. Impact depends on the spread and on how much size sits at each level." },
        ],
        answer: 1,
      },
    ],
  });
})(window.OBZ = window.OBZ || {});
