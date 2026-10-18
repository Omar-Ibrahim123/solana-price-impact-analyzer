/* chapters/13-interview-mode.js: Chapter 13, "Interview mode".
 *   Explain  how to tell the project as a story (STAR), how to answer technical questions
 *            (claim -> reason -> evidence), and honesty habits
 *   See      a Stepper through the project's STAR story
 *   Try      pick the strongest sentence for each STAR step (with feedback), then practise a
 *            random question from the interview page's bank
 *   Check    quiz below
 * Numbers come from OBZ.interview.FACTS (interview/interview.js), so they update in one place.
 */
(function (OBZ) {
  "use strict";
  const { h, clear } = OBZ.util;

  const facts = () => (OBZ.interview && OBZ.interview.FACTS) || {};

  /* ------------------------------------------------------------------ See: STAR stepper */
  function starSteps() {
    const F = facts();
    return [
      { k: "S", word: "Situation", text: `**Situation.** On-chain exchanges compete on price impact: how much a big trade moves the price. I wanted a like-for-like measurement of what trading SOL costs on Phoenix compared with Kraken and Coinbase.` },
      { k: "T", word: "Task", text: `**Task.** Measure the cost of $1,000 to $1,000,000 trades on every venue with one engine and one method, so any difference comes from the books, not from my code.` },
      { k: "A", word: "Action", text: `**Action.** I decoded Phoenix's market account byte by byte, built a price-time priority matching engine tested against a naive model with Hypothesis, and built a collector designed to run for 24 hours, snapshotting every venue every 5 minutes, with real Jupiter quotes for the AMM routes.` },
      { k: "R", word: "Result", text: `**Result.** On ${F.snapshotWhen || "18 Oct 2026"} Phoenix's spread was ${F.phoenixSpread || "57.7 bps"} against ${F.cexSpread || "about 1 bps"} on the exchanges; Jupiter's prop-AMM routes were cheapest of all. Along the way I found junk quotes that made price protection necessary, and a decoder bug in bid ordering that only real bytes revealed.` },
    ];
  }

  function buildStar(ctx) {
    const steps = starSteps();
    const svg = h("svg", { class: "diagram diagram-md", viewBox: "0 0 440 150", attrs: { role: "img", "aria-label": "The four parts of a STAR answer: Situation, Task, Action, Result" } });
    const boxes = steps.map((s, i) => {
      const x = 10 + i * 107;
      const g = h("g", { class: "fade" },
        h("rect", { class: "box", x, y: 20, width: 96, height: 96, rx: 10 }),
        h("text", { x: x + 48, y: 70, "text-anchor": "middle", class: "t-bold", style: "font-size: 34px", text: s.k }),
        h("text", { x: x + 48, y: 100, "text-anchor": "middle", class: "t-muted", style: "font-size: 13px", text: s.word }));
      svg.appendChild(g);
      if (i < steps.length - 1) svg.appendChild(h("path", { class: "line", d: `M ${x + 98} 68 h 9` }));
      return g;
    });
    function render(i) {
      boxes.forEach((g, k) => {
        g.style.opacity = k <= i ? "1" : "0.3";
        g.querySelector("rect").setAttribute("class", k === i ? "box-accent" : "box");
      });
    }
    return OBZ.ui.Stepper({ steps: steps.map((s) => s.text), stage: svg, render, interval: 4000, label: "The project as a STAR story" });
  }

  /* ------------------------------------------------------------------ Try: pick the sentence */
  const PICKS = [
    {
      q: "**Situation.** Which opening sets the scene best?",
      options: [
        { text: "I've always been really passionate about crypto and finance.", why: "It tells the interviewer about you, not about the problem, and it can't be checked. Open with the question the project answers." },
        { text: "On-chain exchanges compete on price impact, and I wanted a like-for-like measurement of what a SOL trade costs on Phoenix compared with Kraken and Coinbase.", why: "Right. One sentence, a concrete question, and the venues named. The listener knows what you were trying to find out." },
        { text: "Phoenix stores its book as red-black trees in a fixed array of 64-byte nodes inside one Solana account.", why: "True and interesting, but it's an Action detail. Starting with it loses a listener who doesn't yet know why it matters." },
      ],
      answer: 1,
    },
    {
      q: "**Task.** Which sentence states your goal most clearly?",
      options: [
        { text: "Measure $1K–$1M trades on every venue with one engine and one method, so differences come from the books, not my code.", why: "Right. It says what you measured, the range, and the design principle that makes the comparison fair." },
        { text: "Build something cool with Solana.", why: "Too vague: an interviewer can't tell what success looked like. Name the measurement." },
        { text: "Write a collector, a store, metrics, time series, a report, an export and a course.", why: "That's a list of outputs, not a goal. Keep the Task to what you set out to learn; the parts belong in Action." },
      ],
      answer: 0,
    },
    {
      q: "**Action.** Which sentence describes what *you* did best?",
      options: [
        { text: "We used various data structures and testing approaches.", why: "\"We\" and \"various\" hide your contribution. Say I, and name the specific choices." },
        { text: "I decoded Phoenix's account, built a price-time priority engine tested against a naive model with Hypothesis, and built a 5-minute collector for a 24-hour run.", why: "Right. Three concrete actions, each one a door the interviewer can open with a follow-up question." },
        { text: "I spent a lot of late nights debugging.", why: "Effort isn't an action. Say what you built or decided; save the debugging story for \"what was the hardest bug?\"." },
      ],
      answer: 1,
    },
    {
      q: "**Result.** Which result is strongest?",
      options: [
        { text: "It worked really well and I learned a lot.", why: "No number, nothing checkable. A result should be something the interviewer could verify." },
        { text: "Phoenix is a bad exchange.", why: "It overgeneralises from one market on one day, and it's an odd thing to tell the people who build it. State what you measured, with its date and limits." },
        { text: "On 18 Oct, Phoenix's SOL/USDC spread was 57.7 bps against about 1 bps on Kraken, and Jupiter's prop-AMM routes were cheapest; I'd want weeks of data before generalising.", why: "Right. Specific numbers, a date, and the honest limit in one breath. That's what makes an interviewer trust the rest." },
      ],
      answer: 2,
    },
  ];

  function buildDrill(ctx) {
    const { ui } = ctx;
    const bank = (OBZ.interview && OBZ.interview.questions) || [];
    const box = h("div", { class: "readout-panel stack", attrs: { "aria-live": "polite" } });
    let i = Math.floor(Math.random() * Math.max(1, bank.length));
    function show(reveal) {
      clear(box);
      if (!bank.length) { box.appendChild(ui.p("The question bank is on the [interview page](#/interview).")); return; }
      const q = bank[i];
      box.append(
        h("p", { class: "eyebrow", text: `Practice question ${i + 1} of ${bank.length}` }),
        h("p", null, h("strong", { text: q.q })),
        reveal ? ui.prose(q.a) : h("p", { class: "fine", text: "Answer out loud in about a minute: claim, reason, evidence from the project. Then compare." }),
        h("div", { class: "btn-row" },
          reveal ? null : ui.Button({ label: "Show model answer", variant: "primary", onClick: () => show(true) }),
          ui.Button({ label: "Another question", onClick: () => { i = (i + 1 + Math.floor(Math.random() * Math.max(1, bank.length - 1))) % bank.length; show(false); } })));
    }
    show(false);
    return box;
  }

  /* ------------------------------------------------------------------ the chapter */
  OBZ.chapters.register({
    id: "interview-mode",
    number: 13,
    title: "Interview mode",
    summary: "How to turn everything in this course into answers: the project as a one-minute story, technical answers that carry their own evidence, and the habit of naming limits first.",
    goals: [
      "Tell the project as a STAR story in about a minute",
      "Answer a technical question with a claim, a reason and evidence from the project",
      "Handle \"what would you do differently?\" and questions you can't answer, honestly",
    ],
    status: "ready",

    render(el, ctx) {
      const { ui } = ctx;
      const F = facts();

      // ---------------- Explain
      const ex = ctx.section("explain", "A story with one number in it");
      ex.append(
        ui.prose(`
An interviewer hears dozens of project descriptions. The ones they remember are short stories with a clear question, something the speaker actually did, and one number that sticks. A list of technologies is forgettable; "one missing bid moved the spread from 57.7 to about 1,584 bps" is not.

A reliable shape is **[[star|STAR]]**:**S**ituation (the problem), **T**ask (what you set out to do), **A**ction (what *you* did, with "I", not "we"), **R**esult (what happened, with a number). Think of it as a film trailer: enough to make them want to ask about the scenes. Every concrete noun in your Action is a door the interviewer can open, so only put in doors you're happy to walk through. The model answers on the [interview page](#/interview) all follow this shape.`),
        ui.prose(`
For technical questions, use **claim → reason → evidence**. The claim answers the question in one sentence. The reason says why. The evidence comes from your own project, which is what makes it yours:

- *Claim:* "Cancel is O(1)."
- *Reason:* "A [[hash-map|hash map]] from order id to its node finds the order, and the [[doubly-linked-list|doubly linked list]] unlinks it without a scan."
- *Evidence:* "In my benchmark a cancel took ${F.benchCancel || "about 600 ns"}, the cheapest real operation, and a cancel of an already-filled order is just a dictionary miss."

The same pattern works for [[price-impact|price impact]] ("…and on 18 Oct Phoenix's $1K buy cost ${F.phoenix1kBuy || "28.8 bps"}, almost all half the spread"), for [[determinism]], for [[sqlite|SQLite]] versus Parquet.`),
        ui.Callout({
          kind: "tip", title: "Three honesty habits",
          body: `- **Say the limits before they ask.** Quotes aren't trades; at most a day of data; base-tier fees; Phoenix Legacy spot, not Phoenix Perpetuals. Saying it first shows you understand your own result.
- **Date your numbers.** "On 18 Oct at 04:31 UTC" is stronger than "Phoenix's spread is", because books change by the minute.
- **"I don't know, but here's how I'd find out."** Then reason out loud from what you do know. Interviewers are testing how you think, not whether you've memorised Phoenix's codebase.`,
        }),
        ui.prose(`
"What would you do differently?" is not a trap. Pick one or two specific changes and say why: start collecting on day one, anchor on a [[reference-mid|reference mid]] from the start, handle the collector round that overran before the long run began. A specific regret shows judgement; "nothing" shows the opposite.

Finally, connect to who you're talking to. [[ellipsis-labs|Ellipsis Labs]] builds [[phoenix|Phoenix]] and [[solfi|SolFi]]. Your project decoded one and measured the other's routes; that is a natural bridge to "and that's why I'd like to work on it".`));

      // ---------------- See
      const see = ctx.section("see", "The project in four beats");
      see.append(ui.Figure({
        label: "Figure 13.1",
        children: buildStar(ctx),
        caption: "Step through the project's STAR story. Said at a calm pace (about 150 words a minute), the four beats take about a minute.",
        alt: "Four boxes, S, T, A and R. Situation: on-chain exchanges compete on price impact; I wanted a like-for-like measurement of Phoenix against Kraken and Coinbase. Task: measure $1K to $1M trades with one engine and one method. Action: decoded Phoenix's account, built and property-tested a matching engine, built a collector designed to run for 24 hours, with Jupiter quotes. Result: Phoenix's spread was 57.7 bps against about 1 bps on the exchanges; Jupiter's prop-AMM routes were cheapest; junk quotes and a decoder bug were found and fixed.",
      }));

      // ---------------- Try
      const tryEl = ctx.section("try", "Build the answer, then say it");
      tryEl.append(
        ui.TryIt({
          title: "Pick the strongest sentence for each beat",
          intro: "For each STAR beat, choose the sentence you would actually say. Every option explains what works or doesn't.",
          children: ui.Quiz({ id: "ch13-star-picks", questions: PICKS }),
        }),
        ui.TryIt({
          title: "Practise one question out loud",
          intro: "A random question from the interview page's bank. Answer it out loud before you reveal the model answer.",
          children: buildDrill(ctx),
        }),
        ui.Callout({
          kind: "project", title: "Your rehearsal space",
          body: `The [interview page](#/interview) has ${(OBZ.interview && OBZ.interview.questions.length) || "40-plus"} questions with model answers in eight topics, a 60-second pitch builder with a timer, ${(OBZ.interview && OBZ.interview.cards.length) || "40"} flashcards covering every chapter, and the follow-ups a good interviewer will ask.`,
        }));
    },

    quiz: [
      {
        q: "The interviewer asks: **\"What would you do differently?\"** Which answer is strongest?",
        options: [
          { text: "Honestly, nothing. I'm happy with how it turned out.", why: "It sounds confident but signals you haven't reflected. Every project has a decision you'd revisit; naming one shows judgement." },
          { text: "I'd anchor price protection on a reference mid from day one: I started with each venue's own mid, and when Phoenix's best bid vanished a 'protected' sell filled 14% below the market.", why: "Right. One specific change, the evidence that taught you, and what you did about it. It invites a good follow-up conversation." },
          { text: "I'd rewrite everything in Rust, add a web UI, support every exchange and use machine learning.", why: "A wish list without reasons sounds like you're guessing. Pick one or two changes and explain why each matters." },
        ],
        answer: 1,
      },
      {
        q: "You're asked how **Phoenix Perpetuals** handles liquidations, which your project never touched. What do you do?",
        options: [
          { text: "Make up a plausible answer so you don't look unprepared", why: "Interviewers at Ellipsis know the real answer. A confident wrong answer costs far more trust than an honest \"I don't know\"." },
          { text: "Say your project measured Phoenix Legacy's spot market, then reason out loud about what a liquidation engine would need, and how you'd find out", why: "Right. State the boundary of what you know, then show how you think. That's what the question is really testing." },
          { text: "Change the subject back to your matching engine", why: "Dodging is noticeable. Acknowledge the gap first; you can connect back to what you built afterwards." },
        ],
        answer: 1,
      },
      {
        q: "Which way of answering **\"Why is cancel O(1) in your engine?\"** follows claim → reason → evidence?",
        options: [
          { text: "\"Because it uses good data structures, which makes it fast.\"", why: "There's a claim, but the reason is vague and there's no evidence. Name the structures and how they make it constant time." },
          { text: "\"Cancel is O(1): an id-to-node hash map finds the order and the doubly linked list unlinks it; in my benchmark a cancel took about 600 ns.\"", why: "Right. One-sentence claim, the mechanism, then a number from your own project." },
          { text: "\"Big-O notation describes how running time grows with input size, and O(1) means constant…\"", why: "That defines the notation instead of answering the question. Start with the claim about your engine, then explain why." },
          { text: "\"I'm not sure, I think the library handles it.\"", why: "You built this engine; the reason is yours to give. The id map and linked list are exactly what make cancel O(1)." },
        ],
        answer: 1,
      },
    ],
  });
})(window.OBZ = window.OBZ || {});
