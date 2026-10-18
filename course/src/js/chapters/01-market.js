/* chapters/01-market.js: Chapter 1, "What a market is". PLACEHOLDER: a lesson agent owns this file.
 * Replace `status: "soon"` with "ready", write render() (Explain / See / Try via ctx.section)
 * and 2–3 quiz questions. Chapter 2 (02-order-book.js) is the reference implementation.
 */
(function (OBZ) {
  "use strict";
  OBZ.chapters.register({
    id: "market",
    number: 1,
    title: "What a market is",
    summary: "Why a price only exists because buyers and sellers disagree, and what \"bid\" and \"ask\" mean.",
    goals: [
      "Explain why a price exists only because buyers and sellers disagree",
      "Read the words bid and ask, and say who posts each",
      "Predict when a buyer and a seller will trade, and at what price"
    ],
    status: "soon",
    planned: "A lemonade-stand market: drag buyer and seller limits and see where trades happen.",
    render(el, ctx) {
      ctx.placeholder();
    },
    quiz: [],
  });
})(window.OBZ = window.OBZ || {});
