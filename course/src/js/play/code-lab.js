/* play/code-lab.js: PLACEHOLDER with one working demo exercise. Owner: the chapters 5–7 agent.
 * Will collect every CodeExercise from the chapters in one place. */
(function (OBZ) {
  "use strict";

  // A complete example of a CodeExercise definition (lesson agents: copy this shape).
  const DEMO = {
    id: "demo-spread",
    title: "Warm-up: spread and mid",
    level: "easy",
    brief: "Write `spreadBps(bestBid, bestAsk)` that returns the spread in basis points, measured against the mid price. Prices are plain dollar numbers here.",
    starter: [
      "function spreadBps(bestBid, bestAsk) {",
      "  const mid = 0;     // TODO: halfway between bid and ask",
      "  const spread = 0;  // TODO: ask minus bid",
      "  return 0;          // TODO: spread as a fraction of mid, times 10,000",
      "}",
    ].join("\n"),
    exports: ["spreadBps"],
    tests: [
      { name: "Kraken, 18 Oct 2026: 103.94 / 103.95 is about 0.96 bps", code: "near(A.spreadBps(103.94, 103.95), 0.962, 0.001);" },
      { name: "99.95 / 100.05 is exactly 10 bps", code: "near(A.spreadBps(99.95, 100.05), 10, 1e-9);" },
      { name: "a zero spread is 0 bps", code: "eq(A.spreadBps(50, 50), 0);" },
    ],
    hints: [
      "The mid is (bestBid + bestAsk) / 2.",
      "The spread is bestAsk - bestBid. Divide it by the mid to get a fraction of the price.",
      "Multiply that fraction by 10,000: `return (bestAsk - bestBid) / mid * 10000;`",
    ],
    solution: [
      "function spreadBps(bestBid, bestAsk) {",
      "  const mid = (bestBid + bestAsk) / 2;",
      "  const spread = bestAsk - bestBid;",
      "  return spread / mid * 10000;",
      "}",
    ].join("\n"),
  };

  OBZ.play.register({
    id: "code", order: 5, status: "soon",
    title: "Code lab",
    summary: "Every coding exercise from the course in one place: append, unlink, cancel, match, impact, ticks and lots, free lists, AMM swaps.",
    exercises: [DEMO],
    render(el, ctx) {
      el.appendChild(ctx.ui.CodeExercise(DEMO));
      ctx.placeholder("All the coding exercises from chapters 4–10 collected here, with your pass/fail status for each.");
    },
  });
})(window.OBZ = window.OBZ || {});
