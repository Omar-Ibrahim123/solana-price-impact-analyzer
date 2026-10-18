/* chapters/11-real-data.js: Chapter 11, "Reading real data". PLACEHOLDER: a lesson agent owns this file.
 * Replace `status: "soon"` with "ready", write render() (Explain / See / Try via ctx.section)
 * and 2–3 quiz questions. Chapter 2 (02-order-book.js) is the reference implementation.
 */
(function (OBZ) {
  "use strict";
  OBZ.chapters.register({
    id: "real-data",
    number: 11,
    title: "Reading real data",
    summary: "Junk quotes, price protection, fees, and what 24 hours of Phoenix, Kraken and Coinbase data show.",
    goals: [
      "Tell the junk-quote story and explain price protection",
      "Separate price impact from fees",
      "Read the 24-hour findings across venues"
    ],
    status: "soon",
    planned: "Real Phoenix, Kraken and Coinbase books with a protection toggle, plus time-series charts.",
    render(el, ctx) {
      ctx.placeholder();
    },
    quiz: [],
  });
})(window.OBZ = window.OBZ || {});
