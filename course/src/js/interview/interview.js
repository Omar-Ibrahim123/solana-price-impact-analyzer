/* interview/interview.js: PLACEHOLDER (with a working flashcard deck). Owner: the chapters 11–13 agent.
 *   OBZ.interview.render(el, ctx)   the #/interview page
 *   OBZ.interview.cards             the flashcard deck (also reusable by chapter 13)
 */
(function (OBZ) {
  "use strict";
  const { h } = OBZ.util;

  const cards = [
    { id: "impact", q: "What is price impact?", a: "How much worse your average fill is than the mid before you traded, in basis points: (average fill − mid) ÷ mid × 10,000. It grows with trade size and shrinks with depth." },
    { id: "spread-depth", q: "Spread or depth: which matters when?", a: "The spread sets the cost of small trades (you pay half of it). Depth sets the cost of big trades (how far down the book you must walk)." },
    { id: "ptp", q: "What is price-time priority?", a: "Better price fills first; at the same price, whoever arrived first fills first. A partial fill keeps its place in the queue." },
    { id: "cancel-o1", q: "Why is cancel O(1) in the engine?", a: "A hash map from order id to its node finds the order instantly, and the doubly linked list lets it unlink without scanning. Only emptying a level costs O(log L)." },
    { id: "integers", q: "Why ticks and lots instead of floats?", a: "Integer arithmetic is exact and identical on every machine. Floating-point rounding can differ, and validators must agree bit for bit." },
    { id: "account", q: "What is a Solana account?", a: "A fixed-size array of bytes with an address and an owner program. Programs hold no state; all state lives in accounts that anyone can read." },
    { id: "phoenix-layout", q: "How is a Phoenix book stored?", a: "One market account: a 576-byte header, padding, market fields, then the bids and asks as red-black trees in fixed arrays of 64-byte nodes, then the trader seats." },
    { id: "maker-taker", q: "Maker or taker: who sets the trade price?", a: "The maker: the order that was already resting. The incoming taker trades at the maker's price, and usually pays the higher fee." },
  ];

  function render(el, ctx) {
    const { ui } = ctx;
    el.append(
      h("div", { class: "measure stack" },
        ui.p("A preview of interview mode: a short flashcard deck with spaced repetition. Cards you mark **Good** come back later; cards you mark **Again** come back soon."),
        ui.Flashcards({ id: "interview-core", cards, title: "Core ideas" })));
    ctx.placeholder("A question bank with model answers, a 60-second pitch builder, and the full flashcard deck.");
  }

  OBZ.interview = { render, cards };
})(window.OBZ = window.OBZ || {});
