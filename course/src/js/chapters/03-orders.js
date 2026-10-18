/* chapters/03-orders.js: Chapter 3, "Orders, makers, takers". PLACEHOLDER: a lesson agent owns this file.
 * Replace `status: "soon"` with "ready", write render() (Explain / See / Try via ctx.section)
 * and 2–3 quiz questions. Chapter 2 (02-order-book.js) is the reference implementation.
 */
(function (OBZ) {
  "use strict";
  OBZ.chapters.register({
    id: "orders",
    number: 3,
    title: "Orders, makers, takers",
    summary: "Limit orders wait, market orders don't; why every trade prints at the maker's price.",
    goals: [
      "Tell a market order from a limit order",
      "Say who is the maker and who is the taker in a trade",
      "Explain why trades print at the maker's price and why resting orders never cross"
    ],
    status: "soon",
    planned: "An order ticket that places either kind of order, plus a \"why didn't it trade?\" explainer.",
    render(el, ctx) {
      ctx.placeholder();
    },
    quiz: [],
  });
})(window.OBZ = window.OBZ || {});
