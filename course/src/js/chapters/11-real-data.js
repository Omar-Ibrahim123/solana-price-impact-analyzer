/* chapters/11-real-data.js: Chapter 11, "Reading real data".
 *   Explain  junk quotes, price protection, own mid vs reference mid, fees kept separate
 *   See      the collector's time series: spread over time, cost by trade size (books and
 *            Jupiter routes), plus findings computed from the data (they update when a newer
 *            export is loaded)
 *   Try      a $1M order on the real Phoenix book with price protection off / on own mid /
 *            on the reference mid, and with the one bid that later vanished removed
 *   Check    quiz below
 * Everything numeric is read from ctx.data (venues, timeseries, jupiter) at render time.
 */
(function (OBZ) {
  "use strict";
  const { h, fmt, clear } = OBZ.util;

  const BAND = 0.10; // the project's price-protection band (impact.DEFAULT_MAX_SLIPPAGE)
  const REF_VENUES = ["kraken", "coinbase"]; // venues.REFERENCE_VENUES

  /* ------------------------------------------------------------------ helpers */
  function refMid(data) {
    const mids = REF_VENUES.map((v) => data.venue(v)).filter((v) => v && isFinite(v.mid)).map((v) => v.mid);
    return mids.length ? mids.reduce((a, b) => a + b, 0) / mids.length : null;
  }
  function median(arr) {
    const v = (arr || []).filter((x) => x !== null && x !== undefined && isFinite(x)).sort((a, b) => a - b);
    if (!v.length) return null;
    const m = Math.floor(v.length / 2);
    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
  }
  const count = (arr) => (arr || []).filter((x) => x !== null && x !== undefined && isFinite(x)).length;
  const hhmm = (t) => new Date(t * 1000).toISOString().slice(11, 16);
  const bpsTxt = (v) => (v === null || v === undefined || !isFinite(v) ? "–" : Math.abs(v) >= 1000 ? (v < 0 ? "−" : "") + fmt.int(Math.abs(v)) + " bps" : fmt.bps(v).replace("-", "−"));

  /** One market order with the band on `anchor` ("off" | "own" | "ref"), measured two ways.
   *  Same steps as impact.simulate (lots_for_notional, then market_order with a limit). */
  function runOrder(snap, side, usd, anchor, ref) {
    const E = OBZ.engine;
    const taker = side === "buy" ? E.BID : E.ASK;
    const own = snap.midPrice();
    const center = anchor === "own" ? own : anchor === "ref" ? ref : null;
    const limit = center === null ? null : E.protectionLimitTicks(snap.tickSize, taker, center, BAND);
    const lots = E.lotsForNotional(snap, taker, usd, limit);
    const fills = lots > 0 ? snap.toBook().marketOrder(taker, lots, limit) : [];
    let filledLots = 0, filledUsd = 0, junkUsd = 0, junkN = 0, worst = null;
    for (const f of fills) {
      const px = snap.price(f.priceTicks), q = snap.size(f.sizeLots);
      filledLots += f.sizeLots; filledUsd += px * q;
      if (ref && (side === "buy" ? px > ref * 2 : px < ref / 2)) { junkUsd += px * q; junkN += 1; }
      if (worst === null || (side === "buy" ? px > worst : px < worst)) worst = px;
    }
    const sol = snap.size(filledLots);
    const avg = sol ? filledUsd / sol : null;
    const sign = side === "buy" ? 1 : -1;
    return {
      side, usd, anchor, own, ref, center, limitPrice: limit === null ? null : snap.price(limit),
      filledUsd, sol, avg, worst, makers: fills.length, junkUsd, junkN,
      impactOwn: avg === null ? null : sign * (avg - own) / own * 1e4,
      costRef: avg === null || !ref ? null : sign * (avg - ref) / ref * 1e4,
      full: filledUsd >= usd * 0.999,
    };
  }

  /** The 04:31 Phoenix snapshot without the orders at its best bid (what the collector's first
   *  round showed at the top of the book: best bid $89.036, best ask $104.35). */
  function withoutBestBid(snap) {
    const bb = snap.bestBid();
    return new OBZ.engine.Snapshot({ venue: snap.venue, symbol: snap.symbol, fetchedAt: snap.fetchedAt, units: snap.units,
      bids: snap.bids.filter(([p]) => p !== bb), asks: snap.asks, meta: snap.meta });
  }
  function bestBidInfo(snap) {
    const bb = snap.bestBid();
    const at = snap.bids.filter(([p]) => p === bb);
    return { price: snap.price(bb), sol: snap.size(at.reduce((a, [, s]) => a + s, 0)), n: at.length };
  }

  /* ------------------------------------------------------------------ See: time series */
  const SERIES = {
    kraken: { name: "Kraken (book)", color: "--kraken" },
    coinbase: { name: "Coinbase (book)", color: "--coinbase" },
    phoenix: { name: "Phoenix (our engine on its book)", color: "--phoenix" },
    "jupiter:best": { name: "Jupiter, best route", color: "--accent" },
    "jupiter:SolFi": { name: "Jupiter via SolFi", color: "--amm" },
    "jupiter:Phoenix": { name: "Jupiter via Phoenix", color: "--phoenix", dash: true },
    "jupiter:Whirlpool": { name: "Jupiter via Whirlpool", color: "--amm-alt" },
    "jupiter:Raydium CLMM": { name: "Jupiter via Raydium CLMM", color: "--mine" },
    "jupiter:Meteora DLMM": { name: "Jupiter via Meteora DLMM", color: "--ink" },
  };
  const VIEWS = {
    main: ["kraken", "coinbase", "phoenix", "jupiter:best", "jupiter:SolFi", "jupiter:Phoenix"],
    amm: ["jupiter:best", "jupiter:SolFi", "jupiter:Phoenix", "jupiter:Whirlpool", "jupiter:Raydium CLMM", "jupiter:Meteora DLMM"],
  };

  /** Time ticks on round 5-minute / hour boundaries. */
  function timeTicks(t0, t1) {
    for (const step of [300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200]) {
      if ((t1 - t0) / step <= 6) {
        const out = [];
        for (let v = Math.ceil(t0 / step) * step; v <= t1; v += step) out.push(v);
        return out;
      }
    }
    return [t0, t1];
  }

  /** [[t, value]] with a null inserted where rounds are missing, so the line breaks at gaps. */
  function withGaps(t, values, interval) {
    const pts = [];
    for (let i = 0; i < t.length; i++) {
      if (i > 0 && t[i] - t[i - 1] > interval * 1.5) pts.push([(t[i] + t[i - 1]) / 2, null]);
      const v = values ? values[i] : null;
      pts.push([t[i], v === undefined ? null : v]);
    }
    return pts;
  }
  function missingTicks(t, interval) {
    let n = 0;
    for (let i = 1; i < t.length; i++) n += Math.max(0, Math.round((t[i] - t[i - 1]) / interval) - 1);
    return n;
  }

  function spreadChart(ts) {
    const interval = ts.interval_s || 300;
    const series = ["phoenix", "kraken", "coinbase"].filter((k) => ts.series[k] && ts.series[k].spread_bps).map((k) => ({
      name: OBZ.data.label(k), color: SERIES[k].color,
      points: withGaps(ts.t, ts.series[k].spread_bps, interval).map(([x, y]) => [x, y !== null && y > 0 ? y : null]),
    }));
    const t0 = ts.t[0], t1 = ts.t[ts.t.length - 1];
    return OBZ.ui.LineChart({
      series, height: 250, table: true,
      x: { label: "Time (UTC)", format: hhmm, ticks: timeTicks(t0, t1), min: t0, max: t1 },
      y: { log: true, label: "Spread (bps, log scale)", format: (v) => (v >= 1 ? fmt.int(v) : fmt.num(v, 2)) },
      alt: "Spread in basis points at every collector round for Phoenix, Kraken and Coinbase, on a log scale.",
    });
  }

  function costChart(ts, view, metric) {
    const sizes = [1000, 10000, 100000, 1000000];
    const series = [];
    for (const key of VIEWS[view]) {
      const s = ts.series[key];
      if (!s) continue;
      const src = metric === "rt" ? s.round_trip_bps : s.cost_bps_vs_ref && s.cost_bps_vs_ref.buy;
      if (!src) continue;
      const pts = sizes.map((usd) => { const m = median(src[String(usd)]); return [usd, m]; });
      if (!pts.some(([, y]) => y !== null)) continue;
      series.push({ name: SERIES[key].name, color: SERIES[key].color, dash: !!SERIES[key].dash, points: pts });
    }
    return {
      series,
      el: OBZ.ui.LineChart({
        series, height: 280, table: true,
        x: { log: true, label: "Trade size (USD)", format: fmt.usdCompact, ticks: sizes, min: 800, max: 1.25e6 },
        y: { log: true, label: metric === "rt" ? "Half round trip (bps, log)" : "Buy cost vs reference (bps, log)", format: (v) => (v >= 1 ? fmt.int(v) : fmt.num(v, 2)) },
        alt: (metric === "rt" ? "Median half round-trip cost" : "Median buy cost against the reference mid") + " in basis points at $1K, $10K, $100K and $1M, for " + series.map((s) => s.name).join(", ") + ". Missing points mean no fill or no route at that size.",
      }),
    };
  }

  /** Findings computed from the dataset. Returns [{title, text}] with data-derived text (plain). */
  function findings(ds) {
    const ts = ds.timeseries, out = [];
    if (!ts || !ts.t || !ts.t.length) return out;
    const S = ts.series || {}, n = ts.t.length;
    const hours = (ts.t[n - 1] - ts.t[0]) / 3600;
    const span = `${n} rounds, ${hhmm(ts.t[0])}–${hhmm(ts.t[n - 1])} UTC`;
    const spreads = ["phoenix", "kraken", "coinbase"].filter((k) => S[k] && S[k].spread_bps)
      .map((k) => `${OBZ.data.label(k)} ${bpsTxt(median(S[k].spread_bps))}`);
    if (spreads.length) out.push({ title: "Median spread", text: `${spreads.join(" · ")} (${span}).` });

    if (S.phoenix && S.phoenix.mid && ts.ref_mid) {
      const gaps = S.phoenix.mid.map((m, i) => (m && ts.ref_mid[i] ? (m - ts.ref_mid[i]) / ts.ref_mid[i] * 1e4 : null));
      const g = median(gaps);
      if (g !== null) out.push({ title: "Phoenix's own mid vs the reference mid", text: `median ${g > 0 ? "+" : "−"}${fmt.int(Math.abs(g))} bps (${g < 0 ? "below" : "above"} the market). A protection band centred on Phoenix's own mid would sit in the wrong place.` });
    }

    const rt = (key, usd) => (S[key] && S[key].round_trip_bps ? median(S[key].round_trip_bps[String(usd)]) : null);
    const rows = [["jupiter:best", "Jupiter best route"], ["kraken", "Kraken"], ["coinbase", "Coinbase"]];
    const at = (usd) => rows.map(([k, l]) => `${l} ${bpsTxt(rt(k, usd))}`).join(" · ");
    if (rt("jupiter:best", 10000) !== null || rt("kraken", 10000) !== null) {
      out.push({ title: "Half round trip at $10K", text: at(10000) + "." });
      out.push({ title: "Half round trip at $100K", text: at(100000) + "." });
    }

    const A = OBZ.lessons && OBZ.lessons.amm;
    const best = (ds.jupiter || []).filter((q) => q.dex === "best" && q.ok !== false && Array.isArray(q.route) && q.route.length);
    if (best.length && A) {
      const legs = best.slice().sort((a, b) => a.usd - b.usd || (a.side < b.side ? -1 : 1)).map((q) => `${q.side} ${fmt.usdCompact(q.usd)}: ${A.routeText(q.route)}`);
      out.push({ title: "Jupiter's best routes (latest round), legs in order", text: legs.join(" · ") + ". A leg can hand an in-between token to the next leg, so these names are venues the route passed through, not SOL liquidity each one held." });
    }

    const solfi = S["jupiter:SolFi"] && S["jupiter:SolFi"].cost_bps_vs_ref;
    if (solfi && solfi.buy) {
      const sizes = [1000, 10000, 100000, 1000000];
      const parts = sizes.map((usd) => `${fmt.usdCompact(usd)}: ${count(solfi.buy[String(usd)])}/${n}`);
      const never = sizes.filter((usd) => count(solfi.buy[String(usd)]) === 0).map(fmt.usdCompact);
      out.push({ title: "Rounds with a SolFi buy route", text: parts.join(" · ") + "." + (never.length ? ` At ${never.join(" and ")} Jupiter never found a route through SolFi in this data.` : "") });
    }

    const ev = S.phoenix && S.phoenix.events;
    if (ev && count(ev)) {
      const total = ev.reduce((a, x) => a + (x || 0), 0);
      out.push({ title: "Phoenix activity", text: `the market's sequence number (it goes up with every instruction that changes the book) moved ${fmt.int(total)} time${total === 1 ? "" : "s"} in ${fmt.num(hours, 1)} hours${total ? `, about once every ${fmt.int(hours * 60 / total)} minutes` : ""}.` });
    }

    const ours = S.phoenix && S.phoenix.cost_bps_vs_ref && S.phoenix.cost_bps_vs_ref.buy && S.phoenix.cost_bps_vs_ref.buy["1000"];
    const jup = S["jupiter:Phoenix"] && S["jupiter:Phoenix"].cost_bps_vs_ref && S["jupiter:Phoenix"].cost_bps_vs_ref.buy && S["jupiter:Phoenix"].cost_bps_vs_ref.buy["1000"];
    const fee = (ds.venues.find((v) => v.venue === "phoenix") || {}).feeBps;
    if (ours && jup && isFinite(fee)) {
      const a = median(ours.map((x) => (x === null ? null : x + fee))), b = median(jup);
      if (a !== null && b !== null) {
        const d = Math.abs(a - b), close = d <= Math.max(1, Math.abs(b) * 0.02);
        out.push({ title: "Decoder cross-check ($1K buy)", text: `our engine on our decoded Phoenix book, plus Phoenix's ${fee} bps taker fee: ${bpsTxt(a)}; Jupiter's own quote through Phoenix: ${bpsTxt(b)} (medians). ${close ? `Two independent readings of the same account agree within ${fmt.num(d, 1)} bps.` : `They differ by ${fmt.num(d, 1)} bps, which is worth investigating.`}` });
      }
    }
    return out;
  }

  function buildSee(ctx) {
    const { ui, data } = ctx;
    const wrap = h("div", { class: "stack" });
    let view = OBZ.store.get("ch11.view", "main"), metric = OBZ.store.get("ch11.metric", "rt");
    if (!VIEWS[view]) view = "main";
    if (metric !== "rt" && metric !== "buy") metric = "rt";

    function render() {
      clear(wrap);
      const ds = data.active(), ts = ds.timeseries;
      if (!ts || !ts.t || ts.t.length < 2 || !ts.series) {
        wrap.appendChild(ui.Callout({ kind: "note", title: "No time series in this dataset", body: "The charts here need an export made from the collector's database (`python -m impact_analyzer export`). The dataset that is loaded has single snapshots only. Load a collector export, or reset to the built-in data, to see them." }));
        return;
      }
      const interval = ts.interval_s || 300, missing = missingTicks(ts.t, interval);
      wrap.appendChild(ui.Figure({
        label: "Figure 11.1",
        children: spreadChart(ts),
        caption: `Spread at every collector round, one round every ${Math.round(interval / 60)} minutes, on a log scale so 1 bps and 1,000 bps both fit.${missing ? ` ${missing} round${missing === 1 ? " is" : "s are"} missing from the series; the lines break there instead of joining across the gap.` : ""}`,
        alt: "Spread over time on a log scale. Median spreads: " + ["phoenix", "kraken", "coinbase"].filter((k) => ts.series[k] && ts.series[k].spread_bps).map((k) => `${OBZ.data.label(k)} ${bpsTxt(median(ts.series[k].spread_bps))} (lowest ${bpsTxt(Math.min(...ts.series[k].spread_bps.filter((x) => x !== null)))}, highest ${bpsTxt(Math.max(...ts.series[k].spread_bps.filter((x) => x !== null)))})`).join("; ") + ".",
      }));

      const chartBox = h("div");
      const viewSeg = ui.Segmented({ label: "Which routes", value: view, small: true, options: [{ value: "main", label: "Books vs best route" }, { value: "amm", label: "Every Jupiter route" }], onChange: (v) => { view = v; OBZ.store.set("ch11.view", v); drawCost(); } });
      const metricSeg = ui.Segmented({ label: "Which cost", value: metric, small: true, options: [{ value: "rt", label: "Half round trip" }, { value: "buy", label: "Buy cost vs reference mid" }], onChange: (v) => { metric = v; OBZ.store.set("ch11.metric", v); drawCost(); } });
      const note = h("p", { class: "fine", attrs: { "aria-live": "polite" } });
      function drawCost() {
        const c = costChart(ts, view, metric);
        clear(chartBox).appendChild(c.el);
        const shown = new Set(c.series.map((s) => s.name));
        const absent = VIEWS[view].filter((k) => ts.series[k] && !shown.has(SERIES[k].name)).map((k) => SERIES[k].name);
        note.textContent = absent.length ? `Not drawn: ${absent.join(", ")}, because there is no number at any size for this cost.${absent.includes(SERIES.phoenix.name) ? " Phoenix's own book has no round trip: its bids could not fill a sale within 10% of the reference mid." : ""}` : "";
      }
      drawCost();
      wrap.appendChild(ui.Figure({
        label: "Figure 11.2",
        children: h("div", { class: "stack" }, h("div", { class: "btn-row" }, viewSeg, metricSeg), chartBox, note),
        caption: "Median cost of a trade by size, across every round. **[[half-round-trip|Half round trip]]** = buy $X and sell $X back to back, then take half the gap between the two average prices: it is the cost of one trip, and it barely depends on the reference mid or on slow drift while the quotes are taken. **Buy cost vs reference mid** compares a buy's average price with the Kraken–Coinbase reference. A line that stops means no fill or no route at the next size. Fees are not included for the books; Jupiter's quotes include the pools' own fees.",
        alt: "Median cost in basis points against trade size, both on log scales, for the selected routes. The exact values for every line are in the table under the chart.",
      }));

      const fs = findings(ds);
      if (fs.length) {
        wrap.appendChild(h("div", { class: "readout-panel", attrs: { "aria-live": "polite" } },
          h("p", { class: "eyebrow", text: `What this dataset shows · ${ds.source === "builtin" ? "built-in collector export" : "your export"}` }),
          h("ul", { class: "stack", style: { paddingLeft: "1.1em", margin: 0 } }, fs.map((f) => h("li", null, h("strong", { text: f.title + ": " }), f.text)))));
      }
    }
    render();
    ctx.onData(render);
    return wrap;
  }

  /* ------------------------------------------------------------------ Try: protection toggle */
  function buildTry(ctx) {
    const { ui, data } = ctx;
    const wrap = h("div", { class: "stack" });
    const state = { book: "fetched", side: "buy", usd: 1e6, anchor: "off" };
    const controls = h("div", { class: "stack" });
    const stats = {
      filled: ui.Stat({ label: "Filled" }),
      avg: ui.Stat({ label: "Average price", tone: "accent" }),
      own: ui.Stat({ label: "Impact vs own mid" }),
      ref: ui.Stat({ label: "Cost vs reference mid" }),
      worst: ui.Stat({ label: "Worst price paid" }),
    };
    const story = h("div", { class: "readout-panel", attrs: { "aria-live": "polite" } });
    const source = h("p", { class: "fine" });
    const checkBox = h("div");
    let base = null, gone = null, ref = null;

    function load() {
      base = data.snapshot("phoenix");
      ref = refMid(data);
      gone = base && base.bids.length > 1 ? withoutBestBid(base) : null;
    }

    function draw() {
      if (!base || !ref) {
        clear(controls); clear(story);
        story.appendChild(ui.p("This widget needs a Phoenix book plus Kraken and Coinbase books (for the reference mid). The loaded dataset doesn't have all three; reset to the built-in data to try it."));
        return;
      }
      const snap = state.book === "gone" && gone ? gone : base;
      const r = runOrder(snap, state.side, state.usd, state.anchor, ref);
      const v = data.venue("phoenix");
      source.textContent = `Phoenix SOL/USDC as fetched ${v && v.fetchedAt ? fmt.date(v.fetchedAt) : ""}: ${fmt.int(snap.bids.length)} bid and ${fmt.int(snap.asks.length)} ask orders. Own mid $${fmt.price(r.own, 3)}; reference mid (Kraken–Coinbase) $${fmt.price(ref, 3)}.`;
      stats.filled.api.set(fmt.usdCompact(r.filledUsd), `of ${fmt.usdCompact(state.usd)}${r.full ? " (all of it)" : " (partial fill)"}`);
      stats.avg.api.set(r.avg === null ? "–" : "$" + (r.avg >= 1e4 ? fmt.int(r.avg) : fmt.price(r.avg, 2)), r.sol ? `${fmt.sol(r.sol)} SOL from ${fmt.int(r.makers)} order${r.makers === 1 ? "" : "s"}` : "nothing traded");
      stats.own.api.set(bpsTxt(r.impactOwn), "vs Phoenix's mid");
      stats.ref.api.set(bpsTxt(r.costRef), "vs Kraken–Coinbase mid");
      stats.worst.api.set(r.worst === null ? "–" : "$" + (r.worst >= 1e4 ? fmt.int(r.worst) : fmt.price(r.worst, 3)), r.limitPrice === null ? "no limit" : `limit $${fmt.price(r.limitPrice, 3)}`);

      clear(story);
      const sideWord = state.side === "buy" ? "buy" : "sell";
      if (!r.sol) {
        story.appendChild(ui.p(`**Nothing traded.** Every ${state.side === "buy" ? "ask" : "bid"} is more than 10% from the band's centre ($${fmt.price(r.center, 2)}), so a protected order refuses all of them. That is the honest answer: this book cannot ${sideWord} near the market price right now.`));
      } else if (r.junkN > 0) {
        story.appendChild(ui.p(`**Nonsense.** With no limit, the order used up the real liquidity and kept going into [[junk-quote|junk quotes]]: ${fmt.int(r.junkN)} order${r.junkN === 1 ? "" : "s"} priced ${state.side === "buy" ? "above double" : "below half"} the market took ${fmt.usd(r.junkUsd, 0)}. The "average price" of $${r.avg >= 1e4 ? fmt.int(r.avg) : fmt.price(r.avg, 2)} and the ${fmt.int(r.impactOwn)} bps impact describe those junk orders, not the market.`));
      } else if (state.anchor === "own" && r.center && Math.abs(r.center - ref) / ref > 0.02 && (state.side === "sell" ? r.worst < ref * (1 - BAND) : r.worst > ref * (1 + BAND))) {
        story.appendChild(ui.p(`**Protected around the wrong price.** The band is centred on Phoenix's own mid ($${fmt.price(r.own, 2)}), not on the market ($${fmt.price(ref, 2)}). So this "protected" ${sideWord} traded at $${fmt.price(r.worst, 2)}, **${fmt.num(Math.abs(r.worst - ref) / ref * 100, 1)}%** away from the market. Centre the band on the reference mid instead.`));
      } else if (!r.full) {
        story.appendChild(ui.p(`**A partial fill, reported as one.** Only ${fmt.usd(r.filledUsd, 0)} of ${fmt.usdCompact(state.usd)} could trade within 10% of $${fmt.price(r.center, 2)}. The simulator stops at the limit ($${fmt.price(r.limitPrice, 2)}) and says how much filled, instead of averaging junk into the price.`));
      } else {
        story.appendChild(ui.p(`**A normal fill.** The whole ${fmt.usdCompact(state.usd)} traded at sensible prices${r.limitPrice !== null ? ", inside the limit" : ""}. At this size price protection changes nothing; it only matters when an order would run past the real liquidity.`));
      }
    }

    function mountControls() {
      clear(controls);
      if (!base || !ref) return;
      const info = bestBidInfo(base);
      const afterMid = gone ? gone.midPrice() : null;
      controls.append(
        h("div", { class: "btn-row" },
          ui.Segmented({ label: "Which Phoenix book", value: state.book, onChange: (v) => { state.book = v; draw(); }, options: [
            { value: "fetched", label: "As fetched" },
            { value: "gone", label: `Without the $${fmt.price(info.price, 2)} bid` }] }),
          ui.Segmented({ label: "Side", value: state.side, onChange: (v) => { state.side = v; draw(); }, options: [{ value: "buy", label: "▲ Buy SOL" }, { value: "sell", label: "▼ Sell SOL" }] })),
        ui.Slider({ label: "Order size", min: 1000, max: 1e6, log: true, value: state.usd, format: fmt.usdCompact, onInput: OBZ.util.debounce((x) => { state.usd = x; draw(); }, 60) }),
        h("div", null,
          h("p", { class: "fine", text: "Price protection: a 10% band centred on…" }),
          ui.Segmented({ label: "Price protection", value: state.anchor, onChange: (v) => { state.anchor = v; draw(); }, options: [
            { value: "off", label: "Off" }, { value: "own", label: "Phoenix's own mid" }, { value: "ref", label: "Reference mid" }] })));
      clear(checkBox);
      if (afterMid) {
        const answer = (ref - afterMid) / ref * 1e4;
        checkBox.appendChild(ui.NumberCheck({
          question: `Your turn: without the $${fmt.price(info.price, 2)} bid, Phoenix's own mid falls to **$${fmt.price(afterMid, 3)}**. The reference mid is **$${fmt.price(ref, 3)}**. How many basis points below the market is Phoenix's own mid?`,
          answer: Math.round(answer), tolerance: Math.max(3, answer * 0.01), unit: "bps",
          explain: `(${fmt.price(ref, 3)} − ${fmt.price(afterMid, 3)}) ÷ ${fmt.price(ref, 3)} × 10,000 ≈ **${fmt.int(answer)} bps**, about ${fmt.num(answer / 100, 1)}%. A 10% band around that mid reaches down to $${fmt.price(afterMid * (1 - BAND), 2)}, far below anything a real seller would accept.`,
          hint: "Subtract Phoenix's mid from the reference mid, divide by the reference mid, then multiply by 10,000.",
        }));
      }
    }

    load(); mountControls(); draw();
    ctx.onData(() => { load(); mountControls(); draw(); });
    wrap.append(controls, source, ui.StatGrid(Object.values(stats), { live: true }), story, checkBox);
    return wrap;
  }

  /* ------------------------------------------------------------------ the chapter */
  OBZ.chapters.register({
    id: "real-data",
    number: 11,
    title: "Reading real data",
    summary: "Real books are messy. Junk quotes, a mid that drifts away from the market, and fees that dwarf impact: what the project found, and the rules it uses so the numbers stay honest.",
    goals: [
      "Tell the junk-quote story and explain why every simulated order carries price protection",
      "Explain why the band is anchored on a reference mid, not the venue's own mid",
      "Separate price impact from fees, and read the collector's charts across venues",
      "Name the limits of the data before someone else does",
    ],
    status: "ready",

    render(el, ctx) {
      const { ui, data } = ctx;
      const snap = data.snapshot("phoenix");
      const ref = refMid(data);
      const ph = data.phoenix();
      let worked = null, protectedRun = null, bb = null, afterMid = null, afterSpread = null;
      try {
        if (snap && ref) {
          worked = runOrder(snap, "buy", 1e6, "off", ref);
          protectedRun = runOrder(snap, "buy", 1e6, "ref", ref);
          bb = bestBidInfo(snap);
          const g = withoutBestBid(snap); afterMid = g.midPrice(); afterSpread = g.spreadBps();
        }
      } catch (e) { worked = null; }
      const kr = data.venue("kraken"), cb = data.venue("coinbase");
      const ts = data.active().timeseries;
      const rt10 = (k) => (ts && ts.series && ts.series[k] && ts.series[k].round_trip_bps ? median(ts.series[k].round_trip_bps["10000"]) : null);

      // ---------------- Explain
      const ex = ctx.section("explain", "When the data fights back");
      ex.append(
        ui.prose(`
A [[snapshot]] of a real [[order-book|order book]] is like a photo of a notice board in a busy hallway. Most notes are sensible offers. A few are pinned there and forgotten, and some are deliberately absurd. A program that reads the board has to cope with all of them.

The Phoenix SOL/USDC book from 18 Oct 2026, 04:31 UTC held ${ph ? fmt.int(ph.n_bids) : "about 1,300"} bids and ${ph ? fmt.int(ph.n_asks) : "about 340"} asks. Near the top it looked normal. Further down sat [[junk-quote|junk quotes]]: bids at **$0.001** and asks at **$9,999,999,999**. Nobody expects them to trade. But a [[market-order|market order]] with no limit doesn't know that: it walks the book until it is full, whatever the price.`),
        ui.Callout({
          kind: "tip", title: "Worked example: a $1M buy with no limit",
          body: worked
            ? `On that book, a $1M market buy first takes every sensible ask, about ${fmt.usdCompact(protectedRun.filledUsd)} of them, then keeps climbing into the junk. Our engine reports an average price of **$${fmt.price(worked.avg, 2)}** per SOL, when SOL cost about $${fmt.price(ref, 2)}. That is a [[price-impact|price impact]] of **${fmt.int(worked.impactOwn)} bps**: a number that describes the junk orders, not the market.`
            : "On that book, an unlimited $1M market buy reported an average price of about $692 per SOL and an impact of about 56,000 bps, describing the junk orders rather than the market.",
        }),
        ui.prose(`
Real traders never send that order. They send a limit: "buy, but not above this price". So every order the project simulates carries [[price-protection|price protection]]: it trades at most 10% away from the market and stops there. If the book can't supply the full amount inside the band, the result says "partial fill: only this much traded", rather than averaging in junk.

But 10% away from *which* price? The obvious answer, the venue's own [[mid-price|mid]], broke within an hour. At 04:31 Phoenix's best bid was ${bb ? `$${fmt.price(bb.price, 2)} for ${fmt.sol(bb.sol)} SOL` : "$103.75 for 50 SOL"}. When the collector looked again, that bid was gone, and the next bid down was at $89.04. One missing order moved Phoenix's own mid to ${afterMid ? `$${fmt.price(afterMid, 2)}` : "about $96.69"} and its [[spread]] to ${afterSpread ? fmt.int(afterSpread) : "about 1,584"} bps, while Kraken and Coinbase still said SOL was worth about $103.6. A band centred on that broken mid let a "protected" sell trade at $89, 14% below the market.

So version 2 centres the band on a [[reference-mid|reference mid]]: the average of the Kraken and Coinbase mids at the same moment. Costs are measured against it too, which is also the only fair way to compare a book with an [[amm|AMM]] route, since a pool has no mid of its own.`),
        ui.prose(`
One more rule: [[fee|fees]] are always shown separately, never mixed in. A beginner on Kraken pays a ${kr && isFinite(kr.feeBps) ? kr.feeBps : 40} bps [[taker-fee|taker fee]], and on Coinbase ${cb && isFinite(cb.feeBps) ? cb.feeBps : 120} bps, at the lowest volume tier. Their trading cost for a $10K order was ${rt10("kraken") !== null ? `about ${fmt.num(rt10("kraken"), 1)} and ${fmt.num(rt10("coinbase"), 1)} bps` : "about 1 bps"}. For a small trader the fee is the cost; the book barely matters. Big traders pay much lower fees, which is why the project reports impact, fee and [[all-in-cost|all-in cost]] side by side.`),
        ui.Callout({
          kind: "project", title: "In this project",
          body: "`impact.py` takes the band (`max_slippage`, default 10%) and an optional `anchor`. `metrics.py` simulates every order twice, with the band on the round's reference mid (the headline numbers) and on the venue's own mid (kept as a secondary column), and bumps `METRICS_VERSION` whenever a formula changes meaning so old cached numbers are never mixed with new ones.",
        }));

      // ---------------- See
      const see = ctx.section("see", "What the collector saw");
      see.append(
        ui.p("Every five minutes the [[collector]] fetched all three books at the same moment, plus real [[jupiter|Jupiter]] quotes through each AMM route. Each of those 5-minute measurements is a **snapshot round**. (The project's code calls a round a *tick*, but in this course a tick is only the price step.) These charts read that [[time-series|time series]]. Hover or touch to read values, or open the table under each chart. Figures are [[median|medians]] across rounds, so one odd round can't drag them."),
        buildSee(ctx));

      // ---------------- Try
      const tryEl = ctx.section("try", "Break the simulator, then fix it");
      tryEl.append(
        ui.TryIt({
          title: "Price protection on the real Phoenix book",
          intro: "Start with protection **Off** and a **$1M buy**: watch the average price. Then centre the band on **Phoenix's own mid**. Now remove the best bid and try a **sell** with the band on the own mid, then on the **reference mid**. Which answer would you trust?",
          children: buildTry(ctx),
        }),
        ui.Callout({
          kind: "warn", title: "What this data can't tell you",
          body: `Say these before an interviewer has to ask:

- **Quotes aren't trades.** A snapshot shows what *could* have traded at that instant. A real order would meet makers who requote, and other takers.
- **Exchange books are aggregated.** Kraken's API returns up to 500 price levels per side (the course's teaching snapshot keeps 400) and Coinbase's level-2 book is summed by price; the collector keeps them within 25% of the mid. Very large orders can run out of what the API shows.
- **Fees are base tier.** Kraken's 40 bps and Coinbase's 120 bps are what a new account pays; large traders pay far less. Jupiter's quotes already include the pools' fees.
- **Solana's own fees aren't counted.** On-chain routes also pay a transaction fee and, often, a priority fee. At these trade sizes they are small, but they are not in these numbers.
- **One day at most, one market.** The collector was built to run for 24 hours, with a snapshot every 5 minutes. ${ts && ts.t && ts.t.length > 1 ? `This export holds ${ts.t.length} snapshot rounds covering ${fmt.num((ts.t[ts.t.length - 1] - ts.t[0]) / 3600, 1)} hours.` : ""} Five-minute snapshots miss everything in between, and Phoenix Legacy SOL/USDC is one spot market, not Phoenix Perpetuals.`,
        }));
    },

    quiz: [
      {
        q: "A simulated $1M buy on the real Phoenix book, with no limit, reports an average price of about **$692 per SOL** when SOL traded near $104. What went wrong?",
        options: [
          { text: "The engine has a bug: average prices can never be that high", why: "The engine is right: it filled exactly the orders in the book, best price first. The problem is the book itself. After the real asks ran out, the order kept buying junk asks priced up to $9,999,999,999." },
          { text: "The order ran past the real liquidity into junk quotes, because nothing told it to stop", why: "Right. A market order with no limit walks the book until it is full, whatever the price. Price protection (a limit 10% from the market) makes it stop and report a partial fill instead." },
          { text: "Phoenix charges a large fee on big orders", why: "Phoenix's taker fee in this snapshot is 2 bps, and fees are reported separately anyway. The huge price comes from the orders the market buy filled against." },
          { text: "SOL's price jumped while the order was filling", why: "A simulation on one snapshot is instant: the book doesn't change while it fills. The extreme average comes from junk asks deep in that same book." },
        ],
        answer: 1,
      },
      {
        q: "Phoenix's best bid vanishes, so its own mid drops to about **$96.7** while Kraken and Coinbase both say SOL is worth about **$103.6**. Why does the project centre the 10% protection band on the Kraken–Coinbase mid instead of Phoenix's own mid?",
        options: [
          { text: "Because Kraken and Coinbase are always cheaper to trade on", why: "The reference mid isn't about which venue is cheaper. It is a yardstick for what the price *is*, so the band sits around the real market." },
          { text: "Because a band around a broken mid lets a 'protected' sell trade far below the market", why: "Right. 10% below $96.7 is about $87, so a sell could fill at $89, about 14% under the real price. Around the reference mid the band stops at about $93, so the order honestly reports that nothing could trade." },
          { text: "Because Phoenix's own mid can't be computed when the spread is wide", why: "It can: (best bid + best ask) ÷ 2 works for any spread. The trouble is that the result no longer describes the market." },
        ],
        answer: 1,
      },
      {
        q: "A $10K buy on Kraken has a trading cost of about **1 bps** against the reference mid. A new account pays Kraken's base-tier taker fee of **40 bps**. What is the all-in cost, and what does it tell you?",
        options: [
          { text: "About 1 bps: fees don't count as a cost of trading", why: "Fees are a real cost: the buyer pays them. The project shows them separately so neither part hides the other, then adds them for the all-in figure." },
          { text: "About 41 bps: for a small trader the fee is almost the whole cost", why: "Right. 1 + 40 = 41 bps. The book is so deep that impact barely registers; the fee tier decides what a small trader pays. Large traders pay much lower fees." },
          { text: "About 40 bps, because the fee replaces the impact", why: "The two add up rather than replace each other: you pay the book's price, then the fee on top. 1 + 40 = 41 bps." },
          { text: "About 0.4 bps: 40 bps is 0.4%, and 0.4% of 1 bps is tiny", why: "A fee in bps is a share of the trade's value, not of its impact. 40 bps of $10,000 is $40. Add it to the 1 bps impact for about 41 bps all-in." },
        ],
        answer: 1,
      },
    ],
  });
})(window.OBZ = window.OBZ || {});
