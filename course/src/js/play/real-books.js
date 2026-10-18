/* play/real-books.js: PLACEHOLDER (partly working). Owner: the sandbox agent.
 * Already works: the data loader (paste/upload an export) and a per-venue summary table.
 * To do: ladders per venue, the 24 h time series charts, protection toggle. */
(function (OBZ) {
  "use strict";
  const { h, fmt } = OBZ.util;

  OBZ.play.register({
    id: "real-books", order: 2, status: "soon",
    title: "Real books",
    summary: "The built-in 18 Oct 2026 snapshots of Phoenix, Kraken and Coinbase, or load your own export.",
    render(el, ctx) {
      const { ui, data } = ctx;
      const tableBox = h("div");
      const label = h("p", { class: "source-pill" }, h("span", { class: "dot", attrs: { "aria-hidden": "true" } }), h("span"));
      function draw() {
        const ds = data.active();
        label.lastChild.textContent = ds.label;
        OBZ.util.clear(tableBox).appendChild(ui.Table({
          caption: "Top of book per venue",
          columns: [
            { key: "label", label: "Venue", align: "left", mono: false },
            { key: "symbol", label: "Pair", align: "left" },
            { label: "Best bid", value: (v) => (v.bids[0] ? v.bids[0][0] : null), format: (x) => (x === null ? "–" : "$" + fmt.price(x, 3)) },
            { label: "Best ask", value: (v) => (v.asks[0] ? v.asks[0][0] : null), format: (x) => (x === null ? "–" : "$" + fmt.price(x, 3)) },
            { key: "spreadBps", label: "Spread", format: (x) => fmt.bps(x) },
            { key: "feeBps", label: "Taker fee", format: (x) => fmt.bps(x, 0) },
            { label: "Levels (bid/ask)", value: (v) => `${v.bids.length} / ${v.asks.length}` },
          ],
          rows: ds.venues,
        }));
      }
      draw();
      ctx.onData(draw);
      el.append(
        label, tableBox,
        ui.Callout({ kind: "project", title: "Load your own data", body: "Run `python -m impact_analyzer run` (or `export`) and paste the JSON it writes. Formats v1 (playground.json) and v2 both load." }),
        ui.DataLoader({}));
      ctx.placeholder("Ladders and depth for every venue side by side, the 24-hour time series, and a price-protection toggle.");
    },
  });
})(window.OBZ = window.OBZ || {});
