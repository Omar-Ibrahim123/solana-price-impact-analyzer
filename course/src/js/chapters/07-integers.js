/* chapters/07-integers.js: Chapter 7, "Why blockchains need integers". PLACEHOLDER: a lesson agent owns this file.
 * Replace `status: "soon"` with "ready", write render() (Explain / See / Try via ctx.section)
 * and 2–3 quiz questions. Chapter 2 (02-order-book.js) is the reference implementation.
 */
(function (OBZ) {
  "use strict";
  OBZ.chapters.register({
    id: "integers",
    number: 7,
    title: "Why blockchains need integers",
    summary: "Determinism across validators, and converting ticks and lots into dollars and SOL.",
    goals: [
      "Explain why validators must get bit-for-bit identical answers",
      "Show how floating point can go wrong",
      "Convert ticks and lots to dollars and SOL using a real Phoenix header"
    ],
    status: "soon",
    planned: "A float-drift demo (0.1 + 0.2) and a ticks/lots converter on the real Phoenix header.",
    render(el, ctx) {
      ctx.placeholder();
    },
    quiz: [],
  });
})(window.OBZ = window.OBZ || {});
