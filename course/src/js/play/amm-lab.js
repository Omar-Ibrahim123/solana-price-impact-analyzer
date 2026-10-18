/* play/amm-lab.js: PLACEHOLDER. Owner: the chapters 8–10 agent.
 * x·y=k against a book of equal depth, plus the recorded Jupiter routes (dataset.jupiter). */
(function (OBZ) {
  "use strict";
  OBZ.play.register({
    id: "amm", order: 4, status: "soon",
    title: "AMM lab",
    summary: "Trade along x·y = k, compare with an order book of equal depth, and inspect real Jupiter routes.",
    render(el, ctx) {
      ctx.placeholder("A curve explorer for x·y = k pools, side by side with a real book of the same depth, and the Jupiter quotes recorded by the collector (SolFi, Phoenix and other routes).");
    },
  });
})(window.OBZ = window.OBZ || {});
