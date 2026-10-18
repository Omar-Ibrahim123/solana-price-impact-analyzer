/* play/amm-lab.js: the AMM lab sandbox tool. Owner: the chapters 8–10 agent.
 *   1. Pool explorer: set an x·y = k pool's size, price and fee; drag a trade along the curve;
 *      price any trade with the fee; impact by size for this pool.
 *   2. AMM vs a real book of equal depth (amm.equivalentPool)            } shared with chapter 10
 *   3. The collector's real Jupiter quotes by route and size (dataset.jupiter) } via OBZ.lessons.amm
 */
(function (OBZ) {
  "use strict";
  const { h, fmt, clear } = OBZ.util;

  function poolExplorer(ctx) {
    const { ui, data } = ctx;
    const k = data.venue("kraken");
    let usd = 1e6, price = k && k.mid ? Math.round(k.mid * 100) / 100 : 100, fee = 0, side = "buy", size = 1e4;
    const curveBox = h("div"), stats = h("div"), chartBox = h("div");
    let curve = null;
    function pool() { return OBZ.amm.AmmPool.atPrice(price, usd, fee); }
    function trade() {
      const p = pool();
      clear(stats);
      let r = null;
      try { r = side === "buy" ? p.buy(size) : p.sell(size / price); } catch (e) { r = null; }
      if (!r || !isFinite(r.avgPrice) || r.avgPrice <= 0) { stats.appendChild(ui.p("That trade is too big for this pool.")); return; }
      stats.appendChild(ui.StatGrid([
        ui.Stat({ label: side === "buy" ? "You pay" : "You sell", value: side === "buy" ? fmt.usd(size, 0) : fmt.sol(size / price) + " SOL" }),
        ui.Stat({ label: "You receive", value: side === "buy" ? fmt.sol(r.solOut) + " SOL" : fmt.usd(r.usdOut, 0), tone: side === "buy" ? "bid" : "ask" }),
        ui.Stat({ label: "Average price", value: fmt.usd(r.avgPrice), sub: `spot before ${fmt.usd(p.spotPrice)}` }),
        ui.Stat({ label: "Impact (fee included)", value: fmt.bps(r.impactBps), tone: "accent", sub: fee ? `${fee} bps of it is the fee, roughly` : "no fee" }),
        ui.Stat({ label: "Spot after", value: fmt.usd(r.priceAfter) }),
      ], { live: true }));
    }
    function chart() {
      clear(chartBox);
      const p = pool(), p0 = OBZ.amm.AmmPool.atPrice(price, usd, 0);
      const sizes = OBZ.engine.logSpacedSizes(1e3, 1e7, 4);
      const pts = (pp, s) => sizes.map((v) => { try { const b = s === "buy" ? pp.buyImpactBps(v) : pp.sellImpactBps(v); return [v, isFinite(b) ? b : null]; } catch (e) { return [v, null]; } });
      const series = [
        { name: "Buy", color: "--bid", points: pts(p, "buy") },
        { name: "Sell", color: "--ask", points: pts(p, "sell") },
      ];
      if (fee) series.push({ name: "Buy, no fee (dx ÷ x)", color: "--amm-alt", dash: true, points: pts(p0, "buy") });
      chartBox.appendChild(ui.LineChart({
        series, height: 240, table: true,
        x: { log: true, label: "Trade size", format: fmt.usdCompact, ticks: [1e3, 1e4, 1e5, 1e6, 1e7] },
        y: { log: true, label: "Impact (bps)", format: (v) => fmt.num(v, v < 1 ? 2 : 0) },
        alt: `Impact against trade size for an x·y = k pool holding ${fmt.usdCompact(usd)} per side at $${price}, fee ${fee} bps. Both axes are logarithmic: impact grows in proportion to size.`,
      }));
    }
    function all() { if (curve) curve.api.setPool(usd, usd / price); trade(); chart(); }
    curve = OBZ.lessons.amm.curveExplorer(ctx, { usd, sol: usd / price, dx: usd * 0.25 });
    curveBox.appendChild(curve);
    const controls = h("div", { class: "grid-2" },
      ui.Slider({ label: "Pool size (dollars per side)", min: 1e4, max: 1e8, log: true, value: usd, format: fmt.usdCompact, onInput: (v) => { usd = v; all(); } }),
      ui.Slider({ label: "Price ($ per SOL)", min: 1, max: 1000, log: true, value: price, format: (v) => fmt.usd(v), onInput: (v) => { price = v; all(); } }),
      ui.Slider({ label: "Fee (bps)", min: 0, max: 100, step: 1, value: fee, format: (v) => v + " bps", onInput: (v) => { fee = v; trade(); chart(); } }),
      ui.Slider({ label: "Trade size", min: 100, max: 1e7, log: true, value: size, format: fmt.usdCompact, onInput: (v) => { size = v; trade(); } }));
    trade(); chart();
    return h("div", { class: "stack" },
      ui.p("The curve uses the pool's size and price but no fee. The calculator and the chart below include the fee, which stays in the pool, as in `amm.py`."),
      controls,
      ui.Segmented({ label: "Side", value: side, options: [{ value: "buy", label: "▲ Buy SOL" }, { value: "sell", label: "▼ Sell SOL" }], onChange: (v) => { side = v; trade(); } }),
      stats, curveBox, chartBox);
  }

  OBZ.play.register({
    id: "amm", order: 4, status: "ready",
    title: "AMM lab",
    summary: "Trade along x·y = k, compare with an order book of equal depth, and inspect real Jupiter routes.",
    render(el, ctx) {
      const { ui } = ctx;
      const A = OBZ.lessons.amm;
      const card = (title, intro, node) => h("div", { class: "card stack" }, h("h2", { style: "font-size: var(--fs-lg)", text: title }), intro ? ui.p(intro) : null, node);
      el.append(
        ui.p("A sandbox for [chapter 10](#/learn/10). Everything here runs `amm.js`, the page's port of the project's `amm.py`, on the same real data as the chapters."),
        card("1 · Pool explorer", "Set up any [[xyk|x·y = k]] pool, then price trades on it.", poolExplorer(ctx)),
        card("2 · A pool against a real book", "A pool holding as much money within the band as the real book does (`equivalent_pool`), compared at every trade size.", A.ammVsBook(ctx)),
        card("3 · Real Jupiter routes", "What [[jupiter|Jupiter]] quoted for each route filter, recorded by the collector.", A.jupiterRoutes(ctx)));
    },
  });
})(window.OBZ = window.OBZ || {});
