/* chapters/08-solana-phoenix.js: Chapter 8, "Solana basics and Phoenix's account". PLACEHOLDER: a lesson agent owns this file.
 * Replace `status: "soon"` with "ready", write render() (Explain / See / Try via ctx.section)
 * and 2–3 quiz questions. Chapter 2 (02-order-book.js) is the reference implementation.
 */
(function (OBZ) {
  "use strict";
  OBZ.chapters.register({
    id: "solana-phoenix",
    number: 8,
    title: "Solana basics and Phoenix's account",
    summary: "Accounts, programs and slots, and where the order book lives inside Phoenix's bytes.",
    goals: [
      "Describe accounts, programs and slots in plain words",
      "Read a little-endian u64 from raw bytes",
      "Locate the header and the two order trees in a Phoenix account"
    ],
    status: "soon",
    planned: "A hex explorer on a real Phoenix account: hover a byte, see its field and decoded value.",
    render(el, ctx) {
      ctx.placeholder();
    },
    quiz: [],
  });
})(window.OBZ = window.OBZ || {});
