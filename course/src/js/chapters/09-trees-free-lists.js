/* chapters/09-trees-free-lists.js: Chapter 9, "Red-black trees in an array, and free lists". PLACEHOLDER: a lesson agent owns this file.
 * Replace `status: "soon"` with "ready", write render() (Explain / See / Try via ctx.section)
 * and 2–3 quiz questions. Chapter 2 (02-order-book.js) is the reference implementation.
 */
(function (OBZ) {
  "use strict";
  OBZ.chapters.register({
    id: "trees-free-lists",
    number: 9,
    title: "Red-black trees in an array, and free lists",
    summary: "How Phoenix keeps a balanced tree in a fixed array, and reuses slots with a free list.",
    goals: [
      "Explain how array indices can act as pointers",
      "Describe how a free list reuses empty slots",
      "Follow an insert and a delete in a node array"
    ],
    status: "soon",
    planned: "An animated node array: insert, delete and slot reuse.",
    render(el, ctx) {
      ctx.placeholder();
    },
    quiz: [],
  });
})(window.OBZ = window.OBZ || {});
