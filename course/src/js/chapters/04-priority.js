/* chapters/04-priority.js: Chapter 4, "Price-time priority". PLACEHOLDER: a lesson agent owns this file.
 * Replace `status: "soon"` with "ready", write render() (Explain / See / Try via ctx.section)
 * and 2–3 quiz questions. Chapter 2 (02-order-book.js) is the reference implementation.
 */
(function (OBZ) {
  "use strict";
  OBZ.chapters.register({
    id: "priority",
    number: 4,
    title: "Price-time priority",
    summary: "Who gets filled first when many orders share a price, and why partial fills keep their place.",
    goals: [
      "Predict who fills first in a FIFO queue",
      "Explain why a partial fill keeps its place",
      "Trace a market order through several queues"
    ],
    status: "soon",
    planned: "A step-through queue (Alice, Bob, Carol, Dave) with a \"guess the next fill\" game.",
    render(el, ctx) {
      ctx.placeholder();
    },
    quiz: [],
  });
})(window.OBZ = window.OBZ || {});
