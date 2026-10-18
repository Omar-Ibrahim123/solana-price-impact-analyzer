/* chapters/06-data-structures.js: Chapter 6, "Data structures". PLACEHOLDER: a lesson agent owns this file.
 * Replace `status: "soon"` with "ready", write render() (Explain / See / Try via ctx.section)
 * and 2–3 quiz questions. Chapter 2 (02-order-book.js) is the reference implementation.
 */
(function (OBZ) {
  "use strict";
  OBZ.chapters.register({
    id: "data-structures",
    number: 6,
    title: "Data structures",
    summary: "The three structures inside the matching engine, and the Big-O of add, cancel and match.",
    goals: [
      "Name the three structures in the engine and what each one is for",
      "Give the Big-O of add, cancel and match, with reasons",
      "Write the core pieces yourself in code exercises"
    ],
    status: "soon",
    planned: "Animated sorted map, linked-list unlink and id map, plus coding exercises with tests and hints.",
    render(el, ctx) {
      ctx.placeholder();
    },
    quiz: [],
  });
})(window.OBZ = window.OBZ || {});
