/* chapters/12-system-design.js: Chapter 12, "System design". PLACEHOLDER: a lesson agent owns this file.
 * Replace `status: "soon"` with "ready", write render() (Explain / See / Try via ctx.section)
 * and 2–3 quiz questions. Chapter 2 (02-order-book.js) is the reference implementation.
 */
(function (OBZ) {
  "use strict";
  OBZ.chapters.register({
    id: "system-design",
    number: 12,
    title: "System design",
    summary: "The project's pipeline, how it survives failures, and what changes at exchange scale.",
    goals: [
      "Draw the pipeline from fetch to report",
      "Explain how the collector handles a venue failing",
      "Say what changes at exchange scale (sharding, sequencing)"
    ],
    status: "soon",
    planned: "A clickable pipeline diagram and a \"break a venue\" failure simulator.",
    render(el, ctx) {
      ctx.placeholder();
    },
    quiz: [],
  });
})(window.OBZ = window.OBZ || {});
