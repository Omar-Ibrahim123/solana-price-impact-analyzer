/* chapters/registry.js: the list of chapters. Each chapter file (NN-name.js) calls
 * OBZ.chapters.register({...}) with this shape:
 *
 *   {
 *     id: "order-book",            // stable, kebab-case; used for quiz storage
 *     number: 2,                   // 1..13, decides order and the #/learn/N route
 *     title: "The order book",
 *     summary: "One sentence for chapter cards and the header lede.",
 *     goals: ["Find the best bid and ask in a ladder", ...],   // 3–4 "you'll be able to..." items
 *     status: "ready" | "soon",
 *     planned: "Placeholder text for the widget (status 'soon' only)",
 *     render(el, ctx) { ... },     // build Explain / See / Try sections with ctx.section()
 *     quiz: [{q, options: [{text, why}], answer}],   // 2–3 questions; rendered in Check by the app
 *   }
 *
 * See CONTRIBUTING-LESSONS.md for ctx and the writing rules.
 */
(function (OBZ) {
  "use strict";

  const list = [];
  const PARTS = [
    { title: "Markets and order books", from: 1, to: 5, blurb: "What a price is, how a book stores orders, and what a big trade costs." },
    { title: "Inside the engine", from: 6, to: 9, blurb: "The data structures, the integers, and the bytes of a real Phoenix account." },
    { title: "Beyond the book", from: 10, to: 12, blurb: "AMMs, real data from three venues, and how the whole system is built." },
    { title: "Interview", from: 13, to: 13, blurb: "Questions, a 60-second pitch, and flashcards." },
  ];
  const TOTAL = 13;

  function register(ch) {
    const missing = ["id", "number", "title", "goals", "render"].filter((k) => ch[k] === undefined);
    if (missing.length) throw new Error(`chapter ${ch.number || ch.id || "?"} is missing ${missing.join(", ")}`);
    if (list.some((c) => c.number === ch.number)) throw new Error(`chapter ${ch.number} registered twice`);
    list.push(Object.assign({ status: "soon", quiz: [], summary: "" }, ch));
    list.sort((a, b) => a.number - b.number);
  }
  const get = (n) => list.find((c) => c.number === Number(n)) || null;
  const byId = (id) => list.find((c) => c.id === id) || null;
  const all = () => list.slice();

  OBZ.chapters = { register, get, byId, all, PARTS, TOTAL };
})(window.OBZ = window.OBZ || {});
