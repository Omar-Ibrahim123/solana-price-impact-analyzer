/* chapters/05-impact.js: Chapter 5, "Price impact". PLACEHOLDER: a lesson agent owns this file.
 * Replace `status: "soon"` with "ready", write render() (Explain / See / Try via ctx.section)
 * and 2–3 quiz questions. Chapter 2 (02-order-book.js) is the reference implementation.
 */
(function (OBZ) {
  "use strict";
  OBZ.chapters.register({
    id: "impact",
    number: 5,
    title: "Price impact",
    summary: "Why a big order costs more per SOL than a small one, measured in basis points.",
    goals: [
      "Compute an average fill price and its impact in bps by hand",
      "Explain when the spread matters and when depth matters",
      "Read an impact curve for two venues"
    ],
    status: "soon",
    planned: "A walk-the-book animator and a two-venue impact slider chart (from Price Impact Lab).",
    render(el, ctx) {
      ctx.placeholder();
    },
    quiz: [],
  });
})(window.OBZ = window.OBZ || {});
