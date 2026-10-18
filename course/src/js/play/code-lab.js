/* play/code-lab.js: every coding exercise in the course, in one place. Owner: the chapters 5–7 agent.
 *
 * Collection is generic: any chapter (OBZ.chapters.all()) or other play tool can export
 *   exercises: [CodeExercise definition, ...]
 * on its module, and it appears here grouped under that chapter, with a pass/fail pill per
 * exercise. Pass state and code are the same per-viewer store the chapters use
 * (OBZ.store.exercises), so solving an exercise in its chapter ticks it here too, and vice versa.
 * Exercises open lazily (a <details> per exercise) so the page stays light.
 */
(function (OBZ) {
  "use strict";
  const { h, clear } = OBZ.util;

  // The warm-up, and a complete example of a CodeExercise definition (copy this shape).
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

  /** [{key, title, href, blurb, exercises}] in course order; each exercise id appears once. */
  function collect() {
    const groups = [{ key: "warmup", title: "Warm-up", href: OBZ.router.href("learn", 2), blurb: "Spread and mid, the idea from chapter 2 (this exercise lives only here): a gentle first run of the editor and tests.", exercises: [DEMO] }];
    const seen = new Set([DEMO.id]);
    const take = (list) => (Array.isArray(list) ? list : []).filter((x) => x && x.id && !seen.has(x.id) && seen.add(x.id));
    for (const ch of OBZ.chapters.all()) {
      const ex = take(ch.exercises);
      if (ex.length) groups.push({ key: "ch" + ch.number, title: `Chapter ${ch.number} · ${ch.title}`, href: OBZ.router.href("learn", ch.number), blurb: ch.summary, exercises: ex });
    }
    for (const t of OBZ.play.all()) {
      if (t.id === "code") continue;
      const ex = take(t.exercises);
      if (ex.length) groups.push({ key: "tool-" + t.id, title: t.title, href: OBZ.router.href("play", t.id), blurb: t.summary, exercises: ex });
    }
    return groups;
  }

  OBZ.play.register({
    id: "code", order: 5, status: "ready",
    title: "Code lab",
    summary: "Every coding exercise from the course in one place: append, unlink, cancel, match, impact, ticks and lots, and more, with your pass/fail status for each.",
    exercises: [DEMO],
    render(el, ctx) {
      const { ui, store } = ctx;
      const groups = collect();
      const all = groups.flatMap((g) => g.exercises);
      const pills = []; // [{id, el}] status pills to refresh
      const groupCounts = []; // [{group, el}]

      const pill = (id) => {
        const p = h("span", { class: "pill" });
        pills.push({ id, el: p });
        return p;
      };
      const progress = ui.ProgressBar({ value: 0, max: all.length, label: "Exercises passed" });
      function refresh() {
        for (const { id, el: p } of pills) {
          const ok = store.exercises.passed(id);
          p.className = "pill " + (ok ? "pill-ok" : "pill-todo");
          p.textContent = ok ? "passed" : "not yet";
        }
        for (const { group, el: c } of groupCounts) c.textContent = `${group.exercises.filter((x) => store.exercises.passed(x.id)).length} of ${group.exercises.length} passed`;
        progress.api.set(all.filter((x) => store.exercises.passed(x.id)).length, all.length);
      }

      const details = new Map(); // id -> {det, summary}
      function openExercise(id) {
        const d = details.get(id);
        if (!d) return;
        d.det.open = true;
        d.det.scrollIntoView({ behavior: OBZ.util.reducedMotion() ? "auto" : "smooth", block: "start" });
        d.summary.focus({ preventScroll: true });
      }

      // ---- overview
      const overview = h("div", { class: "grid-2" }, groups.map((g) => {
        const count = h("p", { class: "fine" });
        groupCounts.push({ group: g, el: count });
        return h("div", { class: "card stack" },
          h("h2", { style: { fontSize: "var(--fs-md)", margin: "0" } }, g.href ? h("a", { href: g.href, text: g.title }) : g.title),
          count,
          h("ul", { style: { listStyle: "none", padding: "0", margin: "0", display: "grid", gap: "var(--s-2)" } }, g.exercises.map((x) => h("li", { style: { display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: "var(--s-2)", alignItems: "center" } },
            h("button", { type: "button", class: "btn btn-ghost btn-sm", style: { textAlign: "left", whiteSpace: "normal", justifyContent: "flex-start", height: "auto" }, attrs: { "aria-label": "Open " + x.title.replace(/[*`]/g, "") }, on: { click: () => openExercise(x.id) } }, ui.rich(x.title.replace(/^Exercise (\d+) · /, "$1. "))),
            pill(x.id)))));
      }));

      // ---- the exercises, grouped
      const sections = groups.map((g) => h("section", { class: "stack", attrs: { "aria-label": g.title } },
        h("h2", null, g.title),
        g.blurb ? ui.p(g.blurb + (g.href ? ` [Open the lesson](${g.href}).` : ""), "fine") : null,
        ...g.exercises.map((x) => {
          const summary = h("summary", { style: { cursor: "pointer", display: "flex", gap: "var(--s-2)", alignItems: "center", flexWrap: "wrap", padding: "var(--s-2) 0" } },
            h("strong", null, ui.rich(x.title)), x.level ? h("span", { class: "pill pill-level", text: x.level }) : null, pill(x.id));
          const body = h("div");
          const det = h("details", { class: "card", dataset: { exercise: x.id } }, summary, body);
          det.addEventListener("toggle", () => { if (det.open && !body.firstChild) body.appendChild(ui.CodeExercise(x)); });
          details.set(x.id, { det, summary });
          return det;
        })));

      refresh();
      ctx.onCleanup(store.onChange((key) => { if (key === "ex.passed" || key === "*") refresh(); }));

      el.append(
        ui.prose(`Every coding exercise in the course, collected from the chapters. Each one runs your JavaScript in a sandbox with a time limit (an infinite loop can't freeze the page), checks it against tests, and offers three hints and a reference solution. Your code and your passes are saved in this browser and shared with the chapters, so an exercise passed here is passed there too.

They follow the project: chapter 6 builds the engine of \`orderbook.py\` piece by piece (exercises 1–5), chapter 7 converts Phoenix's integers the way \`phoenix.py\` does (6), chapter 9 writes the free-list allocator behind Phoenix's order trees (7), and chapter 10 prices a constant-product AMM swap the way \`amm.py\` does (8).`),
        progress,
        overview,
        ...sections);
    },
  });
})(window.OBZ = window.OBZ || {});
