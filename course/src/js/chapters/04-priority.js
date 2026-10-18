/* chapters/04-priority.js: Chapter 4, "Price-time priority".
 *   Explain  better price first, then earlier arrival (FIFO); partial fills keep their place;
 *            cancel and re-post loses it; why exchanges (and blockchains) use the rule; pro-rata
 *   See      who is served first across two price levels (Stepper, fills from OBZ.engine)
 *   Try      the Alice / Bob / Carol / Dave queue, driven by the engine, with a
 *            "guess who fills next" mode; then LeetCode practice
 *   Check    the quiz below
 */
(function (OBZ) {
  "use strict";
  const { h, clear } = OBZ.util;
  const { BID, ASK, OrderBook, Units } = OBZ.engine;
  const UNITS = new Units("0.01", "1"); // cents and whole SOL, to keep the numbers small
  const $ = (ticks) => "$" + UNITS.price(ticks).toFixed(2);
  const MOVE = "transition: transform 0.55s cubic-bezier(.2,.8,.2,1), opacity 0.35s";

  function place(g, x, y) {
    g.style.transform = `translate(${x}px, ${y}px)`;
    g.setAttribute("transform", `translate(${x} ${y})`);
  }

  /** An order card (96 x 62): name, size, a status line. Returns {g, set(...)} */
  function card(svg, name) {
    const rect = h("rect", { class: "box-ask", x: 0, y: 0, width: 96, height: 62, rx: 8 });
    const tName = h("text", { x: 48, y: 21, "text-anchor": "middle", class: "t-bold", text: name });
    const tSize = h("text", { x: 48, y: 39, "text-anchor": "middle", class: "t-mono", text: "" });
    const tNote = h("text", { x: 48, y: 55, "text-anchor": "middle", class: "t-muted", text: "" });
    const g = h("g", { style: MOVE }, rect, tName, tSize, tNote);
    g.style.opacity = "0";
    svg.appendChild(g);
    return {
      g,
      set({ x, y, size, note, mode }) {
        place(g, x, y);
        tSize.textContent = size;
        tNote.textContent = note || "";
        g.style.opacity = mode === "gone" ? "0" : mode === "ghost" ? "0.4" : "1";
        rect.setAttribute("class", mode === "hit" ? "box-accent" : "box-ask");
        rect.setAttribute("stroke-dasharray", mode === "ghost" ? "5 4" : "");
      },
    };
  }

  /* ------------------------------------------------------------------ the See figure */
  // Jae came first but asks more; Hana and Ivan share the better price.
  const SEE_ORDERS = [
    { id: 1, name: "Jae", price: 10405, size: 5, time: "8:55" },
    { id: 2, name: "Hana", price: 10400, size: 3, time: "9:00" },
    { id: 3, name: "Ivan", price: 10400, size: 2, time: "9:02" },
  ];
  const SEE_STEPS = [
    "Three sellers are waiting. **Jae** arrived first, at 8:55, asking $104.05. **Hana** (9:00) and **Ivan** (9:02) both ask $104.00.",
    "Rule 1, **price**: a buyer wants the cheapest SOL, so the $104.00 level is served before $104.05, even though Jae was there first.",
    "Rule 2, **time**: inside the $104.00 level the queue is first in, first out. Hana arrived before Ivan, so the order of service is Hana, Ivan, then Jae.",
    "A buyer sends a market order for **7 SOL**. Fill 1: Hana's 3 SOL at $104.00. Her order is used up and leaves the queue.",
    "Fill 2: Ivan's 2 SOL at $104.00. The $104.00 level is now empty, so it disappears.",
    "Fill 3: the last 2 SOL come from Jae at $104.05. Jae had 5, so 3 are left, and Jae **stays at the front** of the $104.05 queue: a partial fill keeps its place.",
  ];

  function buildSee() {
    const svg = h("svg", { class: "diagram diagram-md", viewBox: "0 0 345 200", attrs: { role: "img", "aria-label": "Two price levels of sellers and the order in which a buyer is filled" } });
    const book = new OrderBook({ units: UNITS });
    for (const o of SEE_ORDERS) book.addOrder(o.id, ASK, o.price, o.size);
    const fills = book.dryMatch(BID, 7, null).fills; // the engine decides who fills, in order
    const ROW = { 10405: 34, 10400: 134 };
    const labels = h("g", null,
      h("text", { x: 4, y: 58, class: "t-bold t-ask", text: "▼ $104.05" }),
      h("text", { x: 4, y: 158, class: "t-bold t-ask", text: "▼ $104.00" }),
      h("text", { x: 4, y: 76, class: "t-muted", text: "worse price" }),
      h("text", { x: 4, y: 176, class: "t-muted", text: "best price" }),
      h("text", { x: 112, y: 20, class: "t-muted", text: "front of queue (oldest) →  back" }));
    svg.appendChild(labels);
    const lvlEmpty = h("text", { x: 112, y: 170, class: "t-muted", text: "(level empty, removed)" });
    lvlEmpty.setAttribute("class", "t-muted fade");
    svg.appendChild(lvlEmpty);
    const cards = {};
    const badges = {};
    for (const o of SEE_ORDERS) {
      cards[o.id] = card(svg, o.name);
      badges[o.id] = h("g", { class: "fade" }, h("circle", { r: 13, class: "fill-accent" }), h("text", { y: 5, "text-anchor": "middle", style: "fill: var(--accent-ink)", class: "t-bold", text: "" }));
      svg.appendChild(badges[o.id]);
    }
    const order = fills.map((f) => f.makerOrderId); // service order: [2, 3, 1]
    function render(i) {
      const filledBy = {};
      const nFills = Math.max(0, i - 2);
      fills.slice(0, nFills).forEach((f) => { filledBy[f.makerOrderId] = (filledBy[f.makerOrderId] || 0) + f.sizeLots; });
      // queue slots per level, oldest first (arrival order = id order here)
      const slot = { 10405: 0, 10400: 0 };
      for (const o of SEE_ORDERS) {
        const x = 112 + slot[o.price] * 106, y = ROW[o.price];
        slot[o.price]++;
        const got = filledBy[o.id] || 0;
        const left = o.size - got;
        const justHit = nFills > 0 && fills[nFills - 1].makerOrderId === o.id;
        cards[o.id].set({
          x, y,
          size: left > 0 ? `${left} SOL` : `filled ${got} ✓`,
          note: got && left ? `${got} filled, keeps place` : `arrived ${o.time}`,
          mode: left === 0 ? "ghost" : justHit ? "hit" : "normal",
        });
        const rank = order.indexOf(o.id) + 1;
        place(badges[o.id], x + 92, y + 2);
        badges[o.id].lastChild.textContent = String(rank);
        badges[o.id].style.opacity = i >= 2 ? "1" : "0";
      }
      lvlEmpty.style.opacity = i >= 4 ? "1" : "0";
      // Rule 1 emphasis: dim the worse level on step 1
      cards[1].g.style.opacity = i === 1 ? "0.35" : cards[1].g.style.opacity;
    }
    return { svg, render };
  }

  /* ------------------------------------------------------------------ the Try widget */
  const PRICE = 10400;
  const NAMES = { 1: "Alice", 2: "Bob", 3: "Carol", 4: "Dave", 5: "Bob" };
  // Each op runs on the book left by the previous ones. "take" = cumulative size of ONE buy
  // order, split into the fills it makes (the engine's FIFO loop decides who they are).
  const OPS = [
    null,
    { add: [1, 4] },
    { add: [2, 4] },
    { add: [3, 2] },
    { cancel: 2 },
    { add: [4, 3] },
    { take: 7, fill: 1 },
    { take: 7, fill: 2 },
    { take: 7, fill: 3 },
    { add: [5, 4] },
  ];
  const CAPTIONS = [
    "An empty queue of asks at **$104.00**. Sellers will line up here.",
    "**Alice** posts 4 SOL. The queue was empty, so she is at the front (the head).",
    "**Bob** posts 4 SOL. He joins at the back (the tail), behind Alice.",
    "**Carol** posts 2 SOL and joins behind Bob.",
    "**Bob cancels.** His order is unlinked from the middle of the queue, and Carol moves up to second.",
    "**Dave** posts 3 SOL. He joins at the back, behind Carol. A gap left by a cancel doesn't save a spot for anyone.",
    "A buyer sends a market order for **7 SOL**. The front of the queue trades first: Alice fills **4 SOL** at $104.00 and leaves.",
    "The buyer still needs 3 SOL. Next in line is Carol: she fills **2 SOL** and leaves.",
    "The buyer needs 1 more. Dave fills **1 SOL** and keeps the other 2. He **stays at the front**: a partial fill doesn't lose its place. Fills: Alice 4, Carol 2, Dave 1.",
    "Bob changes his mind and posts 4 SOL again. It is a **new** order, so it joins the back, behind Dave. Cancelling cost Bob his place.",
  ];
  // Guesses asked BEFORE moving to step `at`. answer() reads the engine, so it can't drift.
  const QUESTIONS = {
    5: { q: "Dave is about to post 3 SOL. Where will he join the queue?", options: [["front", "At the front"], ["gap", "In Bob's old spot (2nd)"], ["back", "At the back, behind Carol"]],
      answer: (b) => { const pos = b.queuePosition(4), n = b.level(ASK, PRICE).count; return pos === 1 ? "front" : pos === n ? "back" : "gap"; },
      why: "New orders always join the back of the queue. Bob's old position isn't kept for anyone." },
    6: { q: "A buyer wants 7 SOL. Whose order fills first?", options: [["1", "Alice"], ["3", "Carol"], ["4", "Dave"]], answer: (b, f) => String(f[0].makerOrderId),
      why: "Alice is at the head of the queue: she arrived first at this price." },
    7: { q: "Alice's 4 SOL are gone and the buyer needs 3 more. Who fills next?", options: [["3", "Carol"], ["4", "Dave"], ["both", "Carol and Dave share it"]], answer: (b, f) => String(f[1].makerOrderId),
      why: "Carol is next in line, so she fills before Dave. Time priority never splits an order between people; it goes strictly in order." },
    8: { q: "The buyer needs 1 more SOL and Dave has 3. What happens to Dave?", options: [["front", "Fills 1, keeps 2, stays at the front"], ["back", "Fills 1, keeps 2, moves to the back"], ["all", "All 3 of his SOL fill"]],
      answer: (b) => (b.queuePosition(4) === 1 ? "front" : "back"),
      why: "The buyer only wanted 1 more, so Dave trades 1. His remaining 2 SOL keep their place at the head of the queue." },
    9: { q: "Bob posts 4 SOL again. Where does he go?", options: [["old", "Back to his old 2nd place"], ["front", "The front, since he first came before Carol and Dave"], ["back", "The back, behind Dave"]],
      answer: (b) => (b.queuePosition(5) === b.level(ASK, PRICE).count ? "back" : "front"),
      why: "A cancelled order is gone for good. The new one is timestamped now, so it waits behind everyone already there." },
  };

  /** Replay steps 1..i in a fresh engine. Returns the book, the fills of the buy (if any) and ghosts. */
  function stateAt(i) {
    const book = new OrderBook({ units: UNITS });
    let fills = [], ghost = null;
    let k = 1;
    while (k <= i) {
      const op = OPS[k];
      if (op.add) { book.addOrder(op.add[0], ASK, PRICE, op.add[1]); k++; }
      else if (op.cancel) {
        if (k === i) ghost = { id: op.cancel, note: "cancelled", slot: book.queuePosition(op.cancel) - 1 };
        book.cancelOrder(op.cancel);
        k++;
      } else {
        // One buy order, revealed one fill per step. The engine's FIFO loop decides the fills;
        // a market order for the first n fills' total size produces exactly those n fills.
        let end = k;
        while (OPS[end + 1] && OPS[end + 1].take) end++;
        const all = book.dryMatch(BID, op.take, null).fills;
        const shown = Math.min(i, end) - k + 1;
        fills = all.slice(0, shown);
        const last = fills[shown - 1];
        const maker = book.orders.get(last.makerOrderId);
        if (k + shown - 1 === i && maker && last.sizeLots === maker.sizeLots) ghost = { id: last.makerOrderId, note: `filled ${last.sizeLots} ✓`, slot: 0 };
        book.marketOrder(BID, fills.reduce((a, f) => a + f.sizeLots, 0), null);
        k = end + 1;
      }
    }
    return { book, fills, ghost };
  }

  function buildTry(ctx) {
    const { ui } = ctx;
    let i = 0, guessMode = true;
    const answered = {}; // step -> {pick, ok}
    const svg = h("svg", { class: "diagram diagram-md", viewBox: "0 0 440 150", attrs: { role: "img", "aria-label": "The queue of asks at $104.00, front on the left" } });
    svg.appendChild(h("text", { x: 4, y: 18, class: "t-bold t-ask", text: "▼ ASK queue at $104.00" }));
    svg.appendChild(h("text", { x: 436, y: 18, "text-anchor": "end", class: "t-muted", text: "front (oldest) → back" }));
    const head = h("text", { x: 4, y: 132, class: "t-muted", text: "" });
    svg.appendChild(head);
    const cards = {};
    for (const id of [1, 2, 3, 4, 5]) cards[id] = card(svg, NAMES[id]);

    const caption = h("div", { class: "step-caption", attrs: { "aria-live": "polite" } });
    const engineLine = h("p", { class: "fine mono" });
    const fillsLine = h("p", { class: "fine" });
    const count = h("span", { class: "step-count" });
    const score = h("span", { class: "fine" });
    const quizBox = h("div", { class: "card stack", hidden: true });
    const back = ui.Button({ label: "◀ Back", onClick: () => go(i - 1), attrs: { "aria-label": "Previous step" } });
    const next = ui.Button({ label: "Step ▶", variant: "primary", onClick: () => go(i + 1), attrs: { "aria-label": "Next step" } });
    const reset = ui.Button({ label: "Reset", variant: "ghost", onClick: () => { for (const k of Object.keys(answered)) delete answered[k]; go(0); } });
    const modeSeg = ui.Segmented({ label: "Guess mode", small: true, value: "on", options: [{ value: "on", label: "Guess first" }, { value: "off", label: "Just watch" }], onChange: (v) => { guessMode = v === "on"; go(i); } });

    function draw(st) {
      const q = st.book.queue(ASK, PRICE);
      const ids = q.map((o) => o.orderId);
      // Ghost (just cancelled / just filled) keeps its old slot for one step so you can see the change.
      const slots = ids.slice();
      if (st.ghost && !ids.includes(st.ghost.id)) slots.splice(Math.min(st.ghost.slot, slots.length), 0, st.ghost.id);
      for (const id of [1, 2, 3, 4, 5]) {
        const k = slots.indexOf(id);
        const live = q.find((o) => o.orderId === id);
        const isGhost = st.ghost && st.ghost.id === id && !live;
        const lastFill = st.fills[st.fills.length - 1];
        const hit = live && lastFill && lastFill.makerOrderId === id && OPS[i] && OPS[i].take;
        if (k < 0) { cards[id].set({ x: 330, y: 40, size: "", mode: "gone" }); continue; }
        // Bob's two orders share a name; only one is ever on screen.
        cards[id].set({
          x: 4 + k * 108, y: 40,
          size: isGhost ? st.ghost.note : `${live.sizeLots} SOL`,
          note: isGhost ? "" : hit ? `filled ${lastFill.sizeLots}, keeps place` : `#${ids.indexOf(id) + 1} in line`,
          mode: isGhost ? "ghost" : hit ? "hit" : "normal",
        });
      }
      head.textContent = ids.length ? `Next to trade: ${NAMES[ids[0]]}` : "Queue is empty";
      engineLine.textContent = "engine: book.queue(ASK, $104.00) → " + (q.length ? q.map((o) => `${NAMES[o.orderId]} ${o.sizeLots}`).join(" · ") : "[]");
      fillsLine.textContent = st.fills.length ? "Buyer's fills so far: " + st.fills.map((f) => `${NAMES[f.makerOrderId]} ${f.sizeLots} SOL @ ${$(f.priceTicks)}`).join(", ") : "";
    }

    function go(j) {
      i = Math.max(0, Math.min(OPS.length - 1, j));
      const st = stateAt(i);
      draw(st);
      clear(caption);
      const a = answered[i];
      if (a) caption.appendChild(h("p", null, h("strong", { text: a.ok ? "✓ Right. " : "✗ Not quite. " }), ui.rich(QUESTIONS[i].why)));
      caption.appendChild(h("p", null, ui.rich(CAPTIONS[i])));
      count.textContent = `Step ${i + 1} of ${OPS.length}`;
      back.disabled = i === 0;
      next.disabled = i === OPS.length - 1;
      // Ask about the NEXT step before showing it.
      const nq = QUESTIONS[i + 1];
      clear(quizBox);
      quizBox.hidden = !(guessMode && nq && !answered[i + 1]);
      next.textContent = quizBox.hidden ? "Step ▶" : "Skip: show me ▶";
      if (!quizBox.hidden) {
        quizBox.append(h("p", { class: "eyebrow", text: "Your guess" }), h("p", null, ui.rich("**" + nq.q + "**")),
          h("div", { class: "btn-row" }, nq.options.map(([key, label]) => ui.Button({ label, onClick: () => pick(i + 1, key) }))));
      }
      const asked = Object.keys(answered).length, right = Object.values(answered).filter((x) => x.ok).length;
      score.textContent = asked ? `Guesses right: ${right} of ${asked}` : "";
    }

    function pick(step, key) {
      const st = stateAt(step);
      const q = QUESTIONS[step];
      const ans = q.answer(st.book, st.fills);
      answered[step] = { pick: key, ok: key === ans };
      go(step);
      next.focus();
    }

    go(0);
    return h("div", { class: "stack" },
      h("div", { class: "btn-row" }, h("span", { class: "fine", text: "Mode:" }), modeSeg),
      h("div", { class: "stepper", attrs: { role: "group", "aria-label": "The Alice, Bob, Carol and Dave queue" } },
        h("div", { class: "step-stage" }, ui.Figure({ children: svg, alt: "Cards for each resting order at $104.00, front of the queue on the left. Cancelled and filled orders appear faded for one step before they leave." })),
        caption, quizBox,
        h("div", { class: "step-controls" }, reset, back, next, count, score)),
      engineLine, fillsLine);
  }

  /* ------------------------------------------------------------------ the chapter */
  OBZ.chapters.register({
    id: "priority",
    number: 4,
    title: "Price-time priority",
    summary: "Who gets filled first when many orders share a price, why a partial fill keeps its place, and why a cancel loses it.",
    goals: [
      "Predict who fills first: better price, then earlier arrival",
      "Explain why a partial fill keeps its place and a cancel loses it",
      "Trace one market order through several queues",
      "Say why exchanges, and blockchains especially, use this rule",
    ],
    status: "ready",

    render(el, ctx) {
      const { ui } = ctx;

      // ---------------- Explain
      const ex = ctx.section("explain", "First the best price, then the first to arrive");
      ex.append(
        ui.prose(`
In [chapter 3](#/learn/3) a taker traded with "the best resting order". But often several orders wait at exactly the same price. Who goes first?

Almost every order book answers with [[price-time-priority|price-time priority]]:

1. **Better price first.** A buyer is matched with the cheapest ask before any pricier one; a seller with the highest bid first.
2. **Then earlier arrival.** At one price, orders wait in a [[fifo|FIFO]] queue: first in, first out.

Picture a queue at a ticket counter with one twist: anyone offering a better deal jumps ahead of everyone offering a worse one. Among people offering the same deal, it's strictly first come, first served.`),
        ui.prose(`
Your [[queue-position|queue position]] decides when you trade, so two details matter:

- A [[partial-fill|partial fill]] keeps its place. If you are first in line with 3 SOL and a buyer takes 1, your remaining 2 SOL stay at the front. Being traded with shouldn't send you to the back.
- A [[cancel]] gives your place up. If you cancel and send the same order again, it is a brand-new order and joins the back, behind everyone who arrived in the meantime. It's like leaving the line to grab a drink: when you come back, you start again at the end.`),
        ui.prose(`
Why this rule? Two reasons.

First, it rewards showing your hand early. A [[market-maker|market maker]] who posts a good price first is first to trade at it, so there is a reason to quote early and openly instead of waiting to see what others do.

Second, it is completely **deterministic**: the same orders arriving in the same sequence always produce exactly the same fills, with no randomness and no judgment calls. On a blockchain that is essential. On [[solana|Solana]], every [[validator]] re-runs each transaction, and they must all reach exactly the same result. [[determinism|Determinism]] is the subject of [chapter 7](#/learn/7).`),
        ui.Callout({
          kind: "note", title: "The alternative: pro-rata",
          body: `Not every exchange uses time priority. Under [[pro-rata|pro-rata matching]], an incoming order is shared among all orders at the best price in proportion to their size. If Alice rests 6 SOL and Bob 2 SOL, a buyer of 4 SOL gets 3 from Alice and 1 from Bob, whoever came first. Some futures exchanges use it. It rewards posting big orders rather than posting early, which can tempt traders to show more size than they really want to trade. The engine in this project uses price-time priority.`,
        }),
        ui.Callout({
          kind: "project", title: "How the engine keeps the queue",
          body: `In \`orderbook.py\` each price is a \`PriceLevel\`: a [[doubly-linked-list|doubly linked list]] with the oldest order at the head. New orders are appended at the tail, and the [[matching-loop|matching loop]] always trades with \`level.head\`. On a partial fill the code changes the size and leaves the order where it is ("the maker keeps its place at the head"). A cancel unlinks the order from wherever it sits; [chapter 6](#/learn/6) shows why that takes constant time.`,
        }));

      // ---------------- See
      const see = ctx.section("see", "Who is served first");
      const fig = buildSee();
      see.append(
        ui.p("Two price levels, three sellers, one buyer. The numbered badges show the order in which they will trade."),
        ui.Figure({
          label: "Figure 4.1",
          children: ui.Stepper({ steps: SEE_STEPS, stage: fig.svg, render: fig.render, interval: 2800, label: "Price priority, then time priority" }),
          caption: "Price comes first: the earliest seller still waits if her price is worse. Within one price, arrival order decides. A partly filled order keeps its place at the front.",
          alt: "Jae rests 5 SOL at $104.05, posted at 8:55. Hana rests 3 SOL at $104.00 (9:00) and Ivan 2 SOL at $104.00 (9:02). The order of service is Hana, Ivan, Jae: better price first, then earlier arrival. A buyer of 7 SOL fills Hana's 3 and Ivan's 2 at $104.00, which empties that level, then 2 of Jae's 5 at $104.05. Jae keeps 3 SOL at the front of the $104.05 queue.",
        }));

      // ---------------- Try
      const tr = ctx.section("try", "Step through a queue");
      tr.append(ui.TryIt({
        title: "Alice, Bob, Carol and Dave",
        intro: "Four sellers share one price, $104.00. Step through what happens: three orders arrive, Bob cancels, Dave arrives, a buyer takes 7 SOL, and Bob tries again. In **Guess first** mode you predict each key moment before you see it. Every state comes from the matching engine.",
        children: buildTry(ctx),
      }),
      ui.Callout({
        kind: "tip", title: "Practice: three LeetCode problems",
        body: `If you'd like to code these ideas, these problems on LeetCode fit this chapter:

- [LC 1700, Number of Students Unable to Eat Lunch](https://leetcode.com/problems/number-of-students-unable-to-eat-lunch/) (easy): a warm-up in simulating a queue.
- [LC 2073, Time Needed to Buy Tickets](https://leetcode.com/problems/time-needed-to-buy-tickets/) (easy): a FIFO line where people take a little at a time, the same shape as partial fills.
- [LC 1801, Number of Orders in the Backlog](https://leetcode.com/problems/number-of-orders-in-the-backlog/) (medium): an order book matching problem. Solve it with two heaps, then ask why heaps alone make cancels hard.`,
      }));
    },

    quiz: [
      {
        q: "Asks at $50.00, in arrival order: Alice 3 SOL, Bob 5 SOL, Carol 2 SOL. A buyer sends a market order for **6 SOL**. Who fills, and how much?",
        options: [
          { text: "Alice 3, Bob 3", why: "Right. Alice is first in line and fills all 3. Bob is next and fills the remaining 3, keeping 2 SOL at the front of the queue. Carol waits." },
          { text: "Alice 2, Bob 3, Carol 1", why: "That splits the order by size, which is pro-rata matching. Under price-time priority the queue is served strictly in arrival order." },
          { text: "Carol 2, Alice 3, Bob 1", why: "Size doesn't decide the order, and Carol arrived last. At one price, the earliest order trades first." },
          { text: "Bob 5, Alice 1", why: "The biggest order doesn't go first. Alice arrived first, so she trades first." },
        ],
        answer: 0,
      },
      {
        q: "Bob is second in a queue of four at $50.00. He cancels and immediately sends the identical order again. Where is he now?",
        options: [
          { text: "Back in second place, since the order is identical", why: "The exchange doesn't remember cancelled orders. The new one is a different order that arrived just now." },
          { text: "At the front, as a reward for re-posting", why: "Nothing rewards re-posting. Time priority only looks at when the current order arrived." },
          { text: "At the back of the queue", why: "Right. A cancel removes his order for good, and the new order joins the tail like any new arrival. That is why traders think twice before cancelling." },
          { text: "Nowhere: you can't re-post after cancelling", why: "You can post as often as you like. You just lose your old place in line." },
        ],
        answer: 2,
      },
      {
        q: "Jae posted 5 SOL at **$104.05** at 8:55. Hana posted 3 SOL at **$104.00** at 9:00. A buyer wants 2 SOL. Who sells to the buyer?",
        options: [
          { text: "Jae, because Jae arrived first", why: "Time only breaks ties between orders at the same price. Hana's price is better for the buyer, so she goes first." },
          { text: "Hana, because her price is better", why: "Right. Price priority comes first: the buyer gets the cheapest SOL available, $104.00. Arrival time only matters within one price." },
          { text: "They share it, 1 SOL each", why: "Orders at different prices never share. The better price trades first, and Hana has enough for all 2 SOL." },
          { text: "Whoever has more SOL, so Jae", why: "Size doesn't decide priority. Better price first, then earlier arrival." },
        ],
        answer: 1,
      },
    ],
  });
})(window.OBZ = window.OBZ || {});
