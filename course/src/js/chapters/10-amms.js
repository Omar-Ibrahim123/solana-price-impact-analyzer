/* chapters/10-amms.js: Chapter 10, "AMMs". PLACEHOLDER: a lesson agent owns this file.
 * Replace `status: "soon"` with "ready", write render() (Explain / See / Try via ctx.section)
 * and 2–3 quiz questions. Chapter 2 (02-order-book.js) is the reference implementation.
 */
(function (OBZ) {
  "use strict";
  OBZ.chapters.register({
    id: "amms",
    number: 10,
    title: "AMMs",
    summary: "Trading against a formula instead of a book: x·y = k, its price impact, and prop AMMs like SolFi.",
    goals: [
      "Derive the price and impact of an x·y = k pool",
      "Compare an AMM with an order book of equal depth",
      "Explain briefly what a prop AMM such as SolFi does differently"
    ],
    status: "soon",
    planned: "A curve explorer: drag a trade along x·y = k, side by side with a book of equal depth.",
    render(el, ctx) {
      ctx.placeholder();
    },
    quiz: [],
  });
})(window.OBZ = window.OBZ || {});
