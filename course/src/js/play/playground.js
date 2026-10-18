/* play/playground.js: PLACEHOLDER. Owner: the sandbox agent. Port of the Order Book
 * Playground (live random order flow, ticket, impact, venues) on top of OBZ.engine. */
(function (OBZ) {
  "use strict";
  OBZ.play.register({
    id: "playground", order: 1, status: "soon",
    title: "Playground",
    summary: "A live order book with random traders: place orders, cancel any block, and watch what a market order would sweep.",
    render(el, ctx) {
      ctx.placeholder("The full Order Book Playground, ported onto this course's engine: live simulated order flow, an order ticket, impact preview and venue comparison.");
      el.appendChild(ctx.ui.p("Until then, the original is here: [Order Book Playground](https://claude.ai/artifact/E7S93DeFGcqAum1qg2rvDj)."));
    },
  });
})(window.OBZ = window.OBZ || {});
