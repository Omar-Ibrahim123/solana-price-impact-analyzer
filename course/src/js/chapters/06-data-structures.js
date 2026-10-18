/* chapters/06-data-structures.js: Chapter 6, "The data structures".
 *   Explain  Big-O in plain words; sorted map of levels, doubly linked list per level, id -> node
 *            hash map; a complexity table with reasons; the measured benchmark from the README
 *   See      a Stepper driven by the real engine's observer hook (OBZ.engine.OrderBook({observer})):
 *            add to an existing level, add a new level, cancel from the middle, cancel the last
 *            order of a level, and a market order with a partial fill
 *   Try      the same drawing as a sandbox (add / cancel / market buy on a live engine), then five
 *            coding exercises (exported as `exercises` for the code lab) and a LeetCode list
 *   Check    the quiz below
 */
(function (OBZ) {
  "use strict";
  const { h, fmt, clear } = OBZ.util;
  const put = (el, ...kids) => { el.append(...kids.filter((k) => k !== null && k !== undefined && k !== false)); return el; };

  /* ================================================================== the drawing */
  const NAMES = ["Alice", "Bob", "Carol", "Dave", "Erin", "Frank", "Grace", "Heidi", "Ivan", "Judy", "Ken", "Lena", "Mia", "Nico", "Omar", "Pia"];
  const nameOf = (id) => NAMES[(id - 1) % NAMES.length] + (id > NAMES.length ? " " + Math.ceil(id / NAMES.length) : "");
  const usd = (ticks) => "$" + (ticks / 100).toFixed(2); // the drawings use $0.01 ticks and 1-SOL lots

  /** What the engine looks like right now: levels (ascending) with their queues, plus the id map. */
  function capture(book) {
    return {
      levels: book.levelPrices(OBZ.engine.ASK).map((p) => ({ p, orders: book.queue(OBZ.engine.ASK, p).map((o) => ({ id: o.orderId, size: o.sizeLots })) })),
      ids: Array.from(book.orders.keys()),
    };
  }

  const NODE_W = 64, NODE_H = 38, GAP = 20, KEY_W = 80, ROW_H = 52, X0 = 100, MAX_NODES = 4;
  /**
   * Draw one frame into svg (from scratch). hl: {price, node, link: [idA, idB], cost, gone: [ids], newKey}
   * seen: every id that has existed (to draw torn-up tickets in the id map).
   */
  function drawFrame(svg, frame, hl, seen) {
    clear(svg);
    const rows = Math.max(1, frame.levels.length);
    const mapY = 34 + rows * ROW_H + 16;
    const chips = seen.slice(-8);
    const chipRows = Math.max(1, Math.ceil(chips.length / 4));
    const H = mapY + 30 + chipRows * 36;
    svg.setAttribute("viewBox", `0 0 440 ${H}`);
    svg.append(
      h("text", { x: 8, y: 18, class: "t-muted", text: "sorted map" }),
      h("text", { x: X0, y: 18, class: "t-muted", text: "queue at each price: head → tail" }),
      hl.cost ? h("text", { x: 432, y: 18, "text-anchor": "end", class: "t-bold t-accent", text: "cost " + hl.cost }) : null);
    if (!frame.levels.length) svg.append(h("text", { x: 8, y: 58, class: "t-muted", text: "(no asks rest in the book)" }));
    frame.levels.forEach((lv, i) => {
      const y = 30 + i * ROW_H;
      const keyHot = hl.price === lv.p;
      svg.append(h("rect", { x: 8, y, width: KEY_W, height: NODE_H, rx: 6, class: keyHot ? "box-accent" : "box" }),
        h("text", { x: 8 + KEY_W / 2, y: y + 24, "text-anchor": "middle", class: "t-mono t-bold", text: usd(lv.p) }));
      if (keyHot && hl.newKey) svg.append(h("text", { x: 8 + KEY_W / 2, y: y + NODE_H + 12, "text-anchor": "middle", class: "t-muted t-accent", text: "new key" }));
      if (!lv.orders.length) {
        svg.append(h("rect", { x: X0, y, width: NODE_W * 1.6, height: NODE_H, rx: 6, class: "box line-dash" }),
          h("text", { x: X0 + NODE_W * 0.8, y: y + 24, "text-anchor": "middle", class: "t-muted", text: "empty" }));
        return;
      }
      const shown = lv.orders.slice(0, MAX_NODES);
      shown.forEach((o, j) => {
        const x = X0 + j * (NODE_W + GAP);
        const hot = hl.node === o.id;
        svg.append(h("rect", { x, y, width: NODE_W, height: NODE_H, rx: 6, class: hot ? "box-accent" : "box-ask" }),
          h("text", { x: x + NODE_W / 2, y: y + 16, "text-anchor": "middle", class: "t-bold", style: "font-size: 13px", text: nameOf(o.id) }),
          h("text", { x: x + NODE_W / 2, y: y + 32, "text-anchor": "middle", class: "t-mono", style: "font-size: 12px", text: o.size + " SOL" }));
        if (j > 0) {
          const prev = shown[j - 1];
          const hotLink = hl.link && hl.link[0] === prev.id && hl.link[1] === o.id;
          svg.append(h("text", { x: x - GAP / 2, y: y + 25, "text-anchor": "middle", class: hotLink ? "t-bold t-accent" : "t-muted", style: hotLink ? "font-size: 18px" : "font-size: 15px", text: "⇄" }));
        }
      });
      if (lv.orders.length > MAX_NODES) svg.append(h("text", { x: 432, y: y + 25, "text-anchor": "end", class: "t-muted", text: "+" + (lv.orders.length - MAX_NODES) }));
    });
    // the id map
    svg.append(h("line", { x1: 0, x2: 440, y1: mapY - 8, y2: mapY - 8, class: "line line-dash" }),
      h("text", { x: 8, y: mapY + 10, class: "t-muted", text: "id map (hash map): order id → node" }));
    const live = new Set(frame.ids);
    chips.forEach((id, k) => {
      const x = 8 + (k % 4) * 108, y = mapY + 20 + Math.floor(k / 4) * 36;
      const alive = live.has(id), hot = hl.node === id;
      const g = h("g", { class: alive ? "" : "dim" },
        h("rect", { x, y, width: 100, height: 28, rx: 14, class: hot ? "box-accent" : "box" }),
        h("text", { x: x + 50, y: y + 19, "text-anchor": "middle", class: "t-mono", style: "font-size: 12px", text: `${id} → ${nameOf(id)}` }));
      if (!alive) g.append(h("line", { x1: x + 6, x2: x + 94, y1: y + 14, y2: y + 14, class: "line" }));
      svg.append(g);
    });
  }

  /** Neighbours an order had in a frame: [prevId, nextId] (null where there is none). */
  function neighbours(frame, id) {
    for (const lv of frame.levels) {
      const i = lv.orders.findIndex((o) => o.id === id);
      if (i >= 0) return [i > 0 ? lv.orders[i - 1].id : null, i < lv.orders.length - 1 ? lv.orders[i + 1].id : null];
    }
    return [null, null];
  }

  /** Plain-language description + highlight for one engine event. before = frame before this event. */
  function describe(ev, before) {
    const who = (id) => `${nameOf(id)}'s order (id ${id})`;
    if (ev.type === "rest") {
      return ev.newLevel
        ? { cost: "O(log L)", hl: { price: ev.priceTicks, node: ev.orderId, newKey: true },
            text: `**Add** ${who(ev.orderId)}: sell ${ev.sizeLots} SOL at ${usd(ev.priceTicks)}. No level exists at that price, so the **sorted map** inserts a new key in its proper place: the one O(log L) step. The order is alone in the new queue, so it is both head and tail. The id map gets its ticket.` }
        : { cost: "O(1)", hl: { price: ev.priceTicks, node: ev.orderId },
            text: `**Add** ${who(ev.orderId)}: sell ${ev.sizeLots} SOL at ${usd(ev.priceTicks)}. That level already exists (one lookup), so the new node joins the **tail** of its queue: the old tail's \`next\` points to it and its \`prev\` points back. Queue position ${ev.queuePosition}. The id map gets its ticket. O(1).` };
    }
    if (ev.type === "cancel") {
      const [a, b] = neighbours(before, ev.orderId);
      const how = a && b ? `It holds ${nameOf(a)}'s shoulder in front and ${nameOf(b)}'s behind, so unlinking is two pointer changes: ${nameOf(a)}.next = ${nameOf(b)} and ${nameOf(b)}.prev = ${nameOf(a)}.`
        : a ? `It was the tail, so the level's tail moves back to ${nameOf(a)}.` : b ? `It was the head, so the level's head moves on to ${nameOf(b)}.` : "It was the only order at that price.";
      return {
        cost: ev.levelRemoved ? "O(1) + O(log L)" : "O(1)",
        hl: { price: ev.levelRemoved ? null : ev.priceTicks, node: ev.orderId, link: a && b ? [a, b] : null },
        text: `**Cancel** id ${ev.orderId}. The id map hands over ${nameOf(ev.orderId)}'s node at once, with no searching. ${how}` +
          (ev.levelRemoved ? ` The ${usd(ev.priceTicks)} level is now empty, so its key is deleted from the sorted map (O(log L)).` : " Nothing else moves. O(1)."),
      };
    }
    if (ev.type === "fill") {
      return {
        cost: "O(1) per fill",
        hl: { price: ev.priceTicks, node: ev.makerOrderId },
        text: ev.full
          ? `The best ask is the first key, ${usd(ev.priceTicks)}. Trade with the **head** of its queue: ${who(ev.makerOrderId)} sells ${ev.sizeLots} SOL at its own price. It is fully filled, so it is unlinked and its ticket torn up.`
          : `${who(ev.makerOrderId)} sells ${ev.sizeLots} SOL and keeps ${ev.makerRemaining}. A **partial fill**: it stays at the head, so nothing is unlinked; only its size and the level's total change.`,
      };
    }
    if (ev.type === "levelRemoved") {
      return { cost: "O(log L)", hl: {}, text: `The ${usd(ev.priceTicks)} queue is empty, so its key is deleted from the sorted map (O(log L)). The next key is now the best ask.` };
    }
    return { cost: "", hl: {}, text: "" };
  }

  /* ================================================================== See: the observer stepper */
  function buildSee(ctx) {
    const { ui } = ctx;
    const E = OBZ.engine;
    const frames = [];
    const seen = [];
    const book = new E.OrderBook({ units: new E.Units("0.01", "1") });
    book.addOrder(1, E.ASK, 10435, 4); book.addOrder(2, E.ASK, 10435, 3); book.addOrder(3, E.ASK, 10440, 5);
    seen.push(1, 2, 3);
    frames.push({ frame: capture(book), cost: "", hl: {}, text: "Two price levels in the **sorted map**: $104.35 and $104.40. Each level is a queue: Alice is at the head of $104.35 with Bob behind her, each holding the other's shoulder. Below, the **id map** knows where every order's node is." });
    let before = capture(book);
    book.observer = (ev) => {
      if (ev.orderId && !seen.includes(ev.orderId)) seen.push(ev.orderId);
      const d = describe(ev, before);
      const frame = capture(book);
      frames.push({ frame, cost: d.cost, hl: d.hl, text: d.text, seen: seen.slice() });
      before = frame;
    };
    book.addOrder(4, E.ASK, 10435, 2);   // joins an existing level
    book.addOrder(5, E.ASK, 10450, 6);   // creates a new level
    book.cancelOrder(2);                 // from the middle of a queue
    book.cancelOrder(3);                 // the only order of its level
    const mStart = frames.length;
    book.marketOrder(E.BID, 7);          // two full fills, a level removed, one partial fill
    frames[mStart].text = "**Market buy 7 SOL.** " + frames[mStart].text;
    frames[frames.length - 1].text += " The buy is done: 3 fills across 2 levels, which is the O(m + k log L) of matching (m orders touched, k levels emptied or visited).";
    const svg = h("svg", { class: "diagram diagram-md", viewBox: "0 0 440 300", attrs: { role: "img", "aria-label": "The engine's three structures: sorted price keys, a queue of order nodes at each price, and the id map" } });
    return ui.Figure({
      label: "Figure 6.1",
      children: ui.Stepper({
        steps: frames.map((f) => f.text), stage: svg, interval: 3200, label: "The three structures during add, cancel and match",
        render: (i) => drawFrame(svg, frames[i].frame, Object.assign({ cost: frames[i].cost }, frames[i].hl), frames[i].seen || [1, 2, 3]),
      }),
      caption: "Every frame is drawn from the real engine: the page runs these operations on a JavaScript port of `orderbook.py` and records each event its observer hook reports (rest, cancel, fill, level removed). Prices use $0.01 ticks and sizes whole SOL to keep the picture small.",
      alt: "Starting book: $104.35 holds Alice 4 SOL then Bob 3 SOL; $104.40 holds Carol 5 SOL. Add Dave 2 SOL at $104.35: he joins the tail, O(1). Add Erin 6 SOL at $104.50: a new key is inserted in the sorted map, O(log L). Cancel Bob: the id map finds his node and Alice and Dave are linked to each other, O(1). Cancel Carol: her level empties and its key is deleted. Market buy 7 SOL: Alice fills 4 and Dave fills 2 (both removed), the empty $104.35 level is deleted, and Erin fills 1 SOL, keeping 5 at the head of $104.50.",
    });
  }

  /* ================================================================== Try: the sandbox */
  const SANDBOX_PRICES = [10435, 10440, 10445, 10450];
  function buildSandbox(ctx) {
    const { ui } = ctx;
    const E = OBZ.engine;
    let book, nextId, seen, events, lastHl;
    const svg = h("svg", { class: "diagram diagram-md", viewBox: "0 0 440 300", attrs: { role: "img", "aria-label": "Your order book: sorted price keys, queues of orders and the id map" } });
    const log = h("ol", { class: "fine", attrs: { "aria-live": "polite" }, style: { margin: "0", paddingLeft: "1.4em" } });
    const logBox = h("div", { class: "readout-panel" }, h("p", null, h("strong", { text: "What the engine reported" })), log);
    let price = SANDBOX_PRICES[0], size = 3;
    const cancelIn = h("input", { type: "number", id: OBZ.util.uid("cx"), class: "input mono", min: "1", value: "2", style: { width: "5.5em" } });
    const buyIn = h("input", { type: "number", id: OBZ.util.uid("bx"), class: "input mono", min: "1", value: "5", style: { width: "5.5em" } });

    function reset() {
      book = new E.OrderBook({ units: new E.Units("0.01", "1"), observer: (ev) => events.push(ev) });
      events = []; seen = []; nextId = 1;
      for (const [p, s] of [ [10435, 4], [10435, 3], [10440, 5] ]) { seen.push(nextId); book.addOrder(nextId++, E.ASK, p, s); }
      events = []; lastHl = {};
      clear(log).append(h("li", { text: "Started with Alice and Bob at $104.35 and Carol at $104.40." }));
      draw();
    }
    function draw() { drawFrame(svg, capture(book), lastHl, seen); }
    function run(label, fn, after) {
      const before = capture(book);
      events = [];
      let result;
      try { result = fn(); } catch (e) { clear(log).append(h("li", { text: "The engine refused: " + e.message })); return; }
      clear(log);
      log.append(h("li", null, h("strong", { text: label })));
      let prev = before;
      for (const ev of events) {
        const d = describe(ev, prev);
        prev = capture(book);
        log.append(h("li", null, ui.rich(`${d.text.replace(/\*\*/g, "")}${d.cost ? "  [" + d.cost + "]" : ""}`)));
        lastHl = Object.assign({ cost: d.cost }, d.hl);
      }
      if (after) { const extra = after(); if (extra) log.append(h("li", { text: extra })); }
      if (!events.length) { log.append(h("li", { text: result === false ? "No order with that id is resting: cancel returned false (a cancel can lose the race to a fill). One hash-map miss, O(1)." : "Nothing happened." })); lastHl = { cost: result === false ? "O(1)" : "" }; }
      draw();
    }
    const priceSeg = ui.Segmented({ label: "Price", small: true, value: price, options: SANDBOX_PRICES.map((p) => ({ value: p, label: usd(p) })), onChange: (p) => { price = p; } });
    const sizeSeg = ui.Segmented({ label: "Size in SOL", small: true, value: size, options: [1, 2, 3, 5, 8].map((s) => ({ value: s, label: s + " SOL" })), onChange: (s) => { size = s; } });
    const addBtn = ui.Button({ label: "Add ask", variant: "sell", onClick: () => { const id = nextId++; seen.push(id); run(`Add ${nameOf(id)} (id ${id}): ${size} SOL at ${usd(price)}`, () => book.addOrder(id, E.ASK, price, size)); } });
    const cancelBtn = ui.Button({ label: "Cancel", onClick: () => { const id = parseInt(cancelIn.value, 10); if (!(id > 0)) return; run(`Cancel id ${id}`, () => book.cancelOrder(id)); } });
    const buyBtn = ui.Button({ label: "Market buy", variant: "buy", onClick: () => { const s = parseInt(buyIn.value, 10); if (!(s > 0)) return; let got = 0;
      run(`Market buy ${s} SOL`, () => { const f = book.marketOrder(E.BID, s); got = f.reduce((a, x) => a + x.sizeLots, 0); return f; },
        () => (got < s ? `The book ran out: ${s - got} SOL could not be bought. A market order never rests, so the rest is simply not filled.` : null)); } });
    reset();
    return h("div", { class: "stack" },
      h("div", { class: "stack" },
        h("div", { class: "btn-row" }, priceSeg, sizeSeg, addBtn),
        h("div", { class: "btn-row" }, h("label", { attrs: { for: cancelIn.id } }, "Cancel order id"), cancelIn, cancelBtn),
        h("div", { class: "btn-row" }, h("label", { attrs: { for: buyIn.id } }, "Buy"), buyIn, h("span", { text: "SOL" }), buyBtn, ui.Button({ label: "Reset", variant: "ghost", onClick: reset }))),
      ui.Figure({ children: svg, caption: "Only the ask side is drawn; bids work the same way, mirrored. Torn tickets in the id map are orders that were cancelled or filled.", alt: "A live drawing of the book you are building: sorted price keys on the left, each level's queue of orders, and the id map below." }),
      logBox);
  }

  /* ================================================================== exercises */
  const REF_ORDER = [
    "class Order {",
    "  constructor(id, size, price = null) {",
    "    this.id = id; this.size = size; this.price = price;",
    "    this.prev = null; // toward the head (older)",
    "    this.next = null; // toward the tail (newer)",
    "  }",
    "}",
    "class Level {",
    "  constructor(price) {",
    "    this.price = price;",
    "    this.head = null; this.tail = null; // oldest, newest",
    "    this.totalSize = 0; this.count = 0;",
    "  }",
    "}",
  ].join("\n");
  const REF_APPEND = [
    "function append(level, order) {",
    "  order.prev = level.tail;",
    "  order.next = null;",
    "  if (level.tail === null) level.head = order; // the level was empty",
    "  else level.tail.next = order;",
    "  level.tail = order;",
    "  level.totalSize += order.size;",
    "  level.count += 1;",
    "}",
  ].join("\n");
  const REF_UNLINK = [
    "function unlink(level, order) {",
    "  if (order.prev === null) level.head = order.next; // it was the head",
    "  else order.prev.next = order.next;",
    "  if (order.next === null) level.tail = order.prev; // it was the tail",
    "  else order.next.prev = order.prev;",
    "  order.prev = null; order.next = null;",
    "  level.totalSize -= order.size;",
    "  level.count -= 1;",
    "}",
  ].join("\n");
  const REF_BOOK = [
    "class Book {",
    "  constructor() {",
    "    this.levels = new Map(); // price -> Level",
    "    this.prices = [];        // prices that have a level, low to high (for asks: best first)",
    "    this.byId = new Map();   // order id -> Order node: the coat check",
    "  }",
    "  add(id, price, size) {",
    "    if (this.byId.has(id)) throw new Error('order ' + id + ' is already resting');",
    "    let level = this.levels.get(price);",
    "    if (!level) {",
    "      level = new Level(price);",
    "      this.levels.set(price, level);",
    "      let i = 0;",
    "      while (i < this.prices.length && this.prices[i] < price) i++;",
    "      this.prices.splice(i, 0, price); // a real sorted map does this in O(log L)",
    "    }",
    "    const order = new Order(id, size, price);",
    "    append(level, order);",
    "    this.byId.set(id, order);",
    "    return order;",
    "  }",
    "  ids(price) {",
    "    const out = [], level = this.levels.get(price);",
    "    for (let o = level ? level.head : null; o; o = o.next) out.push(o.id);",
    "    return out;",
    "  }",
    "}",
  ].join("\n");
  const T = (name, ...lines) => ({ name, code: lines.join("\n") });
  const GIVEN = "These are already defined for you (you can use them):";

  const EX_APPEND = {
    id: "ch6-append", title: "Exercise 1 · Append to a level's tail", level: "easy",
    brief: `A price level is a queue of \`Order\` nodes: \`level.head\` is the oldest, \`level.tail\` the newest, and each node has \`prev\` (toward the head) and \`next\` (toward the tail). Write \`append(level, order)\` so a new order joins the **tail** in O(1), and keep \`level.totalSize\` (total SOL) and \`level.count\` right.

Draw two pictures before you type: an empty level, and a level with one order. This is \`PriceLevel.append\` in \`orderbook.py\`. ${GIVEN} \`Order(id, size)\` and \`Level(price)\`.`,
    prelude: REF_ORDER,
    starter: [
      "function append(level, order) {",
      "  // TODO 1: the new order comes after the current tail, and nothing comes after it",
      "  // TODO 2: if the level was empty it is also the head; otherwise the old tail must point to it",
      "  // TODO 3: it becomes the tail; update totalSize and count",
      "}",
    ].join("\n"),
    exports: ["append", "Order", "Level"],
    tests: [
      T("an order appended to an empty level is both head and tail",
        "const L = new A.Level(104.35), o = new A.Order(1, 4);", "A.append(L, o);",
        "assert(L.head === o, 'head should be order 1');", "assert(L.tail === o, 'tail should be order 1');", "eq(walk(L), [1]);"),
      T("three appends keep arrival order (FIFO)",
        "const L = new A.Level(104.35);", "[4, 3, 2].forEach((s, i) => A.append(L, new A.Order(i + 1, s)));", "eq(walk(L), [1, 2, 3]);"),
      T("totalSize and count add up",
        "const L = new A.Level(104.35);", "[4, 3, 2].forEach((s, i) => A.append(L, new A.Order(i + 1, s)));", "eq([L.totalSize, L.count], [9, 3], '[totalSize, count]');"),
      T("the new tail points back to the old tail and forward to nothing",
        "const L = new A.Level(104.35), a = new A.Order(1, 1), b = new A.Order(2, 1);", "A.append(L, a); A.append(L, b);",
        "assert(b.prev === a, \"order 2's prev should be order 1\");", "assert(b.next === null, \"order 2's next should be null\");",
        "assert(a.next === b, \"order 1's next should be order 2\");", "assert(L.head === a, 'the head should still be order 1');"),
    ],
    hints: [
      "Two cases: the level is empty (`level.tail === null`), or it isn't. In both, the new order's `prev` is whatever the tail was, and its `next` is `null`.",
      "Set `order.prev = level.tail; order.next = null;`. Then if the level was empty, `level.head = order`; otherwise `level.tail.next = order`.",
      "Finish with `level.tail = order; level.totalSize += order.size; level.count += 1;`",
    ],
    solution: REF_APPEND,
  };

  const EX_UNLINK = {
    id: "ch6-unlink", title: "Exercise 2 · Unlink a node from anywhere", level: "medium",
    brief: `Write \`unlink(level, order)\`: remove \`order\` from its level in O(1), whether it is the head, the tail, somewhere in the middle, or the only order. Afterwards set the removed node's \`prev\` and \`next\` to \`null\`, and keep \`totalSize\` and \`count\` right.

Picture the queue at a ticket counter where everyone holds the shoulder in front and the shoulder behind: when someone leaves, their two neighbours take hold of each other. This is \`PriceLevel.remove\`. ${GIVEN} \`Order\`, \`Level\` and a working \`append\`.`,
    prelude: REF_ORDER + "\n" + REF_APPEND,
    starter: [
      "function unlink(level, order) {",
      "  // TODO 1: fix the left side: the node in front (or level.head if there is none)",
      "  // TODO 2: fix the right side: the node behind (or level.tail if there is none)",
      "  // TODO 3: clear order.prev / order.next and update totalSize and count",
      "}",
    ].join("\n"),
    exports: ["unlink", "append", "Order", "Level"],
    tests: [
      T("removing from the middle joins the neighbours",
        "const L = new A.Level(1), os = [1, 2, 3].map((i) => new A.Order(i, i)); os.forEach((o) => A.append(L, o));",
        "A.unlink(L, os[1]);", "eq(walk(L), [1, 3]);", "eq([L.totalSize, L.count], [4, 2], '[totalSize, count]');"),
      T("removing the head moves the head forward",
        "const L = new A.Level(1), os = [1, 2, 3].map((i) => new A.Order(i, 1)); os.forEach((o) => A.append(L, o));",
        "A.unlink(L, os[0]);", "eq(walk(L), [2, 3]);", "assert(L.head === os[1], 'head should be order 2');"),
      T("removing the tail moves the tail back",
        "const L = new A.Level(1), os = [1, 2, 3].map((i) => new A.Order(i, 1)); os.forEach((o) => A.append(L, o));",
        "A.unlink(L, os[2]);", "eq(walk(L), [1, 2]);", "assert(L.tail === os[1], 'tail should be order 2');"),
      T("removing the only order empties the level",
        "const L = new A.Level(1), o = new A.Order(9, 5); A.append(L, o);", "A.unlink(L, o);",
        "assert(L.head === null && L.tail === null, 'head and tail should both be null');", "eq([L.totalSize, L.count], [0, 0], '[totalSize, count]');"),
      T("the removed node no longer points anywhere",
        "const L = new A.Level(1), os = [1, 2, 3].map((i) => new A.Order(i, 1)); os.forEach((o) => A.append(L, o));",
        "A.unlink(L, os[1]);", "assert(os[1].prev === null && os[1].next === null, 'order 2 should have prev = next = null');"),
      T("a level can be emptied and reused",
        "const L = new A.Level(1), os = [1, 2, 3].map((i) => new A.Order(i, 1)); os.forEach((o) => A.append(L, o));",
        "A.unlink(L, os[1]); A.unlink(L, os[0]); A.unlink(L, os[2]);", "A.append(L, new A.Order(9, 7));", "eq(walk(L), [9]);", "eq(L.totalSize, 7, 'totalSize');"),
    ],
    hints: [
      "One rule covers all four cases: fix the neighbour on the left, then the neighbour on the right. A missing neighbour means you are at the head (left) or the tail (right) instead.",
      "Left side: if `order.prev === null` the order was the head, so `level.head = order.next`; otherwise `order.prev.next = order.next`. The right side mirrors it with `next`, `tail` and `prev`.",
      "Right side: if `order.next === null` then `level.tail = order.prev`, else `order.next.prev = order.prev`. Then `order.prev = order.next = null; level.totalSize -= order.size; level.count -= 1;`",
    ],
    solution: REF_UNLINK,
  };

  const EX_CANCEL = {
    id: "ch6-cancel", title: "Exercise 3 · Cancel through the id map", level: "medium",
    brief: `A \`Book\` keeps three things: \`book.levels\` (price → \`Level\`), \`book.prices\` (the prices that have a level, sorted), and \`book.byId\`, the coat check that maps an order id to its node. Write \`cancel(book, id)\`:

- return \`false\` if no order with that id is resting (on a real exchange a cancel can lose the race to a fill, so this is normal, not an error);
- otherwise unlink the node, forget its id, delete the level if it is now empty, and return \`true\`.

This is \`OrderBook.cancel_order\`. ${GIVEN} \`Order\`, \`Level\`, \`append\`, \`unlink\` and \`Book\` (with \`add(id, price, size)\` and \`ids(price)\`). A real sorted map deletes a key in O(log L); here \`book.prices\` is a plain sorted array to keep the code short.`,
    prelude: [REF_ORDER, REF_APPEND, REF_UNLINK, REF_BOOK].join("\n"),
    starter: [
      "function cancel(book, id) {",
      "  // TODO 1: hand in the ticket: book.byId.get(id). Unknown id -> return false",
      "  // TODO 2: unlink the node from its level (order.price tells you which) and forget its id",
      "  // TODO 3: if the level is now empty, delete it from book.levels and book.prices",
      "  return false;",
      "}",
    ].join("\n"),
    exports: ["cancel", "Book"],
    tests: [
      T("cancelling from the middle returns true and unlinks the order",
        "const b = new A.Book(); b.add(1, 104.35, 4); b.add(2, 104.35, 3); b.add(3, 104.35, 2); b.add(4, 104.40, 5);",
        "eq(A.cancel(b, 2), true, 'cancel(2)');", "eq(b.ids(104.35), [1, 3]);", "eq(b.levels.get(104.35).totalSize, 6, 'totalSize');"),
      T("an unknown id returns false and changes nothing",
        "const b = new A.Book(); b.add(1, 104.35, 4); b.add(2, 104.35, 3);",
        "eq(A.cancel(b, 99), false, 'cancel(99)');", "eq(b.ids(104.35), [1, 2]);"),
      T("cancelling twice: the second call returns false",
        "const b = new A.Book(); b.add(1, 104.35, 4); b.add(2, 104.35, 3);",
        "A.cancel(b, 2);", "eq(A.cancel(b, 2), false, 'second cancel(2)');", "eq(b.ids(104.35), [1]);"),
      T("the id map forgets the cancelled order",
        "const b = new A.Book(); b.add(1, 104.35, 4); b.add(2, 104.35, 3);",
        "A.cancel(b, 1);", "eq(b.byId.has(1), false, 'byId.has(1)');", "eq(b.byId.has(2), true, 'byId.has(2)');"),
      T("cancelling the last order of a level deletes the level",
        "const b = new A.Book(); b.add(1, 104.35, 4); b.add(4, 104.40, 5);",
        "eq(A.cancel(b, 4), true, 'cancel(4)');", "eq(b.levels.has(104.40), false, 'levels.has(104.40)');", "eq(b.prices, [104.35], 'prices');"),
      T("other levels are untouched",
        "const b = new A.Book(); b.add(1, 104.35, 4); b.add(2, 104.35, 3); b.add(4, 104.40, 5);",
        "A.cancel(b, 2);", "eq(b.ids(104.40), [4]);", "eq(b.prices, [104.35, 104.40], 'prices');"),
    ],
    hints: [
      "Use the coat-check ticket: `const order = book.byId.get(id);` gives you the node directly, with no searching. If it is `undefined`, return `false`.",
      "The node knows its price, so `const level = book.levels.get(order.price);`. Then `unlink(level, order);` and `book.byId.delete(id);`.",
      "If `level.count === 0`: `book.levels.delete(order.price); book.prices.splice(book.prices.indexOf(order.price), 1);`. Finally `return true;`",
    ],
    solution: [
      "function cancel(book, id) {",
      "  const order = book.byId.get(id);",
      "  if (order === undefined) return false; // not resting (maybe already filled)",
      "  const level = book.levels.get(order.price);",
      "  unlink(level, order);",
      "  book.byId.delete(id);",
      "  if (level.count === 0) {",
      "    book.levels.delete(order.price);",
      "    book.prices.splice(book.prices.indexOf(order.price), 1);",
      "  }",
      "  return true;",
      "}",
    ].join("\n"),
  };

  const EX_MATCH = {
    id: "ch6-match", title: "Exercise 4 · The matching loop", level: "hard",
    brief: `Write \`marketBuy(book, size)\`: buy \`size\` SOL from the asks right now. Return \`{ fills, unfilled }\` where each fill is \`{ id, price, size }\` (the maker's id and **the maker's price**) and \`unfilled\` is whatever the book couldn't supply.

The rules from chapters 3 and 4: best price first (\`book.prices[0]\` is the lowest ask); at one price, oldest first (\`level.head\`); a fully filled maker leaves the queue and the id map; a **partly** filled maker keeps its place at the head with a smaller size (don't forget \`level.totalSize\`); an emptied level is deleted. This is \`OrderBook._match\`. ${GIVEN} \`Order\`, \`Level\`, \`append\`, \`unlink\` and \`Book\`.`,
    prelude: [REF_ORDER, REF_APPEND, REF_UNLINK, REF_BOOK].join("\n"),
    starter: [
      "function marketBuy(book, size) {",
      "  const fills = [];",
      "  let remaining = size;",
      "  // TODO: while something remains and the book has a level:",
      "  //   look at the best level, then trade with its head order again and again",
      "  return { fills, unfilled: remaining };",
      "}",
    ].join("\n"),
    exports: ["marketBuy", "Book"],
    tests: [
      T("12 SOL takes 5 at $104.35, then 7 at $104.40",
        "const b = new A.Book(); b.add(1, 104.35, 5); b.add(2, 104.40, 10); b.add(3, 104.50, 20);",
        "const r = A.marketBuy(b, 12);", "eq(r.fills.map((f) => [f.id, f.price, f.size]), [ [1, 104.35, 5], [2, 104.4, 7] ], 'fills as [id, price, size]');", "eq(r.unfilled, 0, 'unfilled');"),
      T("a partly filled maker keeps its place with less size",
        "const b = new A.Book(); b.add(1, 104.35, 5); b.add(2, 104.40, 10); b.add(3, 104.50, 20);",
        "A.marketBuy(b, 12);", "eq(b.ids(104.40), [2]);", "eq(b.byId.get(2).size, 3, 'order 2 size');", "eq(b.levels.get(104.40).totalSize, 3, 'level totalSize');"),
      T("an emptied level is deleted and filled orders leave the id map",
        "const b = new A.Book(); b.add(1, 104.35, 5); b.add(2, 104.40, 10); b.add(3, 104.50, 20);",
        "A.marketBuy(b, 12);", "eq(b.levels.has(104.35), false, 'levels.has(104.35)');", "eq(b.prices, [104.4, 104.5], 'prices');", "eq(b.byId.has(1), false, 'byId.has(1)');"),
      T("time priority: at one price the oldest order fills first",
        "const b = new A.Book(); b.add(7, 104.35, 2); b.add(8, 104.35, 2);",
        "const r = A.marketBuy(b, 3);", "eq(r.fills.map((f) => [f.id, f.size]), [ [7, 2], [8, 1] ], 'fills as [id, size]');", "eq(b.ids(104.35), [8]);"),
      T("an order bigger than the book fills what exists and reports the rest",
        "const b = new A.Book(); b.add(1, 104.35, 5); b.add(2, 104.40, 10); b.add(3, 104.50, 20);",
        "const r = A.marketBuy(b, 50);", "eq(r.unfilled, 15, 'unfilled');", "eq(b.prices, [], 'prices');", "eq(b.byId.size, 0, 'byId.size');"),
      T("an exact fit records no zero-size fills",
        "const b = new A.Book(); b.add(1, 104.35, 5); b.add(2, 104.40, 10);",
        "const r = A.marketBuy(b, 5);", "eq(r.fills.map((f) => [f.id, f.size]), [ [1, 5] ], 'fills as [id, size]');", "eq(b.prices, [104.4], 'prices');"),
      T("an empty book fills nothing",
        "const b = new A.Book();", "const r = A.marketBuy(b, 4);", "eq(r.fills, [], 'fills');", "eq(r.unfilled, 4, 'unfilled');"),
    ],
    hints: [
      "Two loops. The outer one moves from level to level: `while (remaining > 0 && book.prices.length > 0)`, with `const price = book.prices[0]` and `const level = book.levels.get(price)`. The inner one trades with `level.head` while `remaining > 0 && level.head !== null`.",
      "Inside: `const maker = level.head; const traded = Math.min(remaining, maker.size);` then `fills.push({ id: maker.id, price, size: traded }); remaining -= traded;`. If `traded === maker.size`, `unlink(level, maker)` and `book.byId.delete(maker.id)`; otherwise `maker.size -= traded; level.totalSize -= traded;`.",
      "After the inner loop: `if (level.count === 0) { book.levels.delete(price); book.prices.shift(); }`. Re-read `book.prices[0]` at the top of the outer loop instead of looping over a list you are changing.",
    ],
    solution: [
      "function marketBuy(book, size) {",
      "  const fills = [];",
      "  let remaining = size;",
      "  while (remaining > 0 && book.prices.length > 0) {",
      "    const price = book.prices[0];          // best ask: the lowest price",
      "    const level = book.levels.get(price);",
      "    while (remaining > 0 && level.head !== null) {",
      "      const maker = level.head;            // time priority: the oldest order",
      "      const traded = Math.min(remaining, maker.size);",
      "      fills.push({ id: maker.id, price, size: traded }); // the maker's price",
      "      remaining -= traded;",
      "      if (traded === maker.size) {",
      "        unlink(level, maker);",
      "        book.byId.delete(maker.id);",
      "      } else {",
      "        maker.size -= traded;             // partial fill: keeps its place",
      "        level.totalSize -= traded;",
      "      }",
      "    }",
      "    if (level.count === 0) {",
      "      book.levels.delete(price);",
      "      book.prices.shift();",
      "    }",
      "  }",
      "  return { fills, unfilled: remaining };",
      "}",
    ].join("\n"),
  };

  const EX_IMPACT = {
    id: "ch6-impact", title: "Exercise 5 · Average fill price and impact", level: "easy",
    brief: `Turn fills into the two numbers of [chapter 5](#/learn/5). Write \`avgFill(fills)\`, the size-weighted average price of \`[{ price, size }, …]\` (or \`null\` if there are no fills), and \`impactBps(avg, mid, side)\` with \`side\` either \`"buy"\` or \`"sell"\`, signed so that paying worse than the mid is a positive cost both ways. This is the end of \`impact.simulate\`.`,
    starter: [
      "// fills: [{ price, size }, ...]  ->  total dollars / total SOL, or null with no fills",
      "function avgFill(fills) {",
      "  // TODO",
      "}",
      "",
      "// avg: average fill price, mid: mid before the trade, side: 'buy' or 'sell'",
      "function impactBps(avg, mid, side) {",
      "  // TODO: a buy above the mid is a cost; so is a sell below it",
      "}",
    ].join("\n"),
    exports: ["avgFill", "impactBps"],
    tests: [
      T("the real Phoenix $10K buy averages about $104.38695",
        "near(A.avgFill([{ price: 104.35, size: 25 }, { price: 104.40, size: 70.798 }]), 104.38695, 0.00001);"),
      T("it weights by size, not a plain average of prices",
        "near(A.avgFill([{ price: 100, size: 10 }, { price: 100.2, size: 30 }]), 100.15, 1e-9);"),
      T("a single fill averages to its own price", "near(A.avgFill([{ price: 99.5, size: 3 }]), 99.5, 1e-12);"),
      T("no fills gives null", "eq(A.avgFill([]), null);"),
      T("the Phoenix buy's impact is about 32.38 bps", "near(A.impactBps(104.38695171, 104.05, 'buy'), 32.3836, 0.001);"),
      T("one lot at the best ask pays the half-spread, about 28.83 bps", "near(A.impactBps(104.35, 104.05, 'buy'), 28.8323, 0.001);"),
      T("a sell flips the sign so the cost stays positive", "near(A.impactBps(103.75, 104.05, 'sell'), 28.8323, 0.001);"),
      T("trading exactly at the mid costs 0 bps", "near(A.impactBps(100, 100, 'buy'), 0, 1e-12);", "near(A.impactBps(100, 100, 'sell'), 0, 1e-12);"),
    ],
    hints: [
      "Keep two running totals over the fills: dollars (`price × size`) and SOL (`size`). The average is dollars ÷ SOL. With no fills the SOL total is 0: return `null` before dividing.",
      "For a buy, impact = (avg − mid) ÷ mid × 10,000. For a sell, swap the two: (mid − avg) ÷ mid × 10,000.",
      "`let usd = 0, sol = 0; for (const f of fills) { usd += f.price * f.size; sol += f.size; } return sol ? usd / sol : null;` and `return (side === 'buy' ? avg - mid : mid - avg) / mid * 10000;`",
    ],
    solution: [
      "function avgFill(fills) {",
      "  let usd = 0, sol = 0;",
      "  for (const f of fills) { usd += f.price * f.size; sol += f.size; }",
      "  return sol ? usd / sol : null;",
      "}",
      "",
      "function impactBps(avg, mid, side) {",
      "  const worse = side === 'buy' ? avg - mid : mid - avg;",
      "  return worse / mid * 10000;",
      "}",
    ].join("\n"),
  };

  const EXERCISES = [EX_APPEND, EX_UNLINK, EX_CANCEL, EX_MATCH, EX_IMPACT];

  const LEETCODE = [
    { n: "146", t: "LRU Cache", slug: "lru-cache", lvl: "Medium", why: "The exact pattern of a price level: a hash map pointing into a doubly linked list. If you solve one problem from this list, solve this one." },
    { n: "707", t: "Design Linked List", slug: "design-linked-list", lvl: "Medium", why: "Pointer surgery with every head and tail edge case, like exercises 1 and 2." },
    { n: "460", t: "LFU Cache", slug: "lfu-cache", lvl: "Hard", why: "Many FIFO lists keyed by a number: the same shape as queues keyed by price." },
    { n: "2034", t: "Stock Price Fluctuation", slug: "stock-price-fluctuation", lvl: "Medium", why: "A sorted structure plus a hash map, with updates that arrive out of order." },
    { n: "981", t: "Time Based Key-Value Store", slug: "time-based-key-value-store", lvl: "Medium", why: "Binary search over sorted keys, like finding where a new price level goes." },
    { n: "1845", t: "Seat Reservation Manager", slug: "seat-reservation-manager", lvl: "Medium", why: "Always hand out the smallest free number: a heap or a sorted set. Chapter 9's free list solves a cousin of it." },
    { n: "450", t: "Delete Node in a BST", slug: "delete-node-in-a-bst", lvl: "Medium", why: "What a tree does when a price level empties, without the rebalancing." },
    { n: "1801", t: "Number of Orders in the Backlog", slug: "number-of-orders-in-the-backlog", lvl: "Medium", why: "An order book matching problem. Solve it with two heaps, then explain why a heap can't cancel an order in O(1)." },
  ];

  /* ================================================================== the chapter */
  OBZ.chapters.register({
    id: "data-structures",
    number: 6,
    title: "The data structures",
    summary: "Three structures, one job each: a sorted map finds the best price, a doubly linked list keeps each queue fair, and a hash map makes cancels instant.",
    goals: [
      "Say what Big-O means in plain words, with O(1), O(log n) and O(n) examples",
      "Name the engine's three structures and what each one is for",
      "Give the cost of add, cancel and match, with the reason for each",
      "Optional, for programmers: write append, unlink, cancel and the matching loop yourself, and pass the tests",
    ],
    status: "ready",
    exercises: EXERCISES,

    render(el, ctx) {
      const { ui } = ctx;

      // ---------------- Explain
      const ex = ctx.section("explain", "Three structures, one job each");
      ex.append(
        ui.prose(`
A [[matching-engine|matching engine]] must do four things, thousands of times a second: add an order, cancel one, find the best price, and match. Programmers describe how fast an operation is with [[big-o|Big-O]]: not seconds, but how the work grows as the book grows.

- [[o-1|O(1)]]: the same few steps however big the book is, like opening a book at a page number you already know.
- [[o-log-n|O(log n)]]: each step halves what's left, like finding a word in a dictionary. A million items take about 20 steps.
- [[o-n|O(n)]]: work in proportion to the size, like reading every page to find the word.`),
        ui.prose(`
The engine in \`orderbook.py\` combines three [[data-structure|data structures]], each picked for one job:

1. A [[sorted-map|sorted map]] from price to [[price-level|price level]], one per side. Think of a shelf kept in price order: the best price is always at one end, and a new price has to be slotted into place, which takes O(log L) for L levels.
2. A [[doubly-linked-list|doubly linked list]] of orders inside each level: a queue at a ticket counter where everyone holds the shoulder of the person in front and the person behind. Newcomers join the tail, the head is served first ([[fifo|FIFO]]), and anyone can leave from the middle: their two neighbours just take hold of each other.
3. A [[hash-map|hash map]] from [[order-id|order id]] to that order's [[node]]: a coat check. Hand in ticket 57 and you get coat 57 back without searching the racks. A cancel uses it to jump straight to the order.`),
        ui.Table({
          caption: "What each operation costs (L = price levels on one side)",
          columns: [
            { key: "op", label: "Operation", align: "left", mono: false },
            { key: "steps", label: "What happens", align: "left", mono: false },
            { key: "cost", label: "Cost" },
          ],
          rows: [
            { op: "Add, level exists", steps: "look up the level, append to the tail, store the id", cost: "O(1)" },
            { op: "Add, new level", steps: "as above, plus insert a new price into the sorted map", cost: "O(log L)" },
            { op: "Cancel", steps: "id map → node, unlink it (delete the level if it empties)", cost: "O(1) (+ O(log L))" },
            { op: "Best bid / ask", steps: "read the end of the sorted map", cost: "O(1)" },
            { op: "Match m orders over k levels", steps: "trade with heads; delete emptied levels", cost: "O(m + k log L)" },
          ],
        }),
        ui.prose(`
In one sentence: **everything that touches a single order is O(1); only creating or deleting a whole price level costs O(log L).** Why not a plain list sorted by price and time? Cancelling would mean searching it, O(n). Why not a [[heap]] (a tree that always keeps the smallest or largest item on top)? It finds the best price fast, but a plain heap can't find an arbitrary entry without an extra index (with a position map it can delete one in O(log n)), and it can't look up a price level at all.`),
        ui.Callout({
          kind: "project", open: true, title: "Measured, not just claimed",
          body: `The project's benchmark replays one million random adds, cancels and market orders through \`orderbook.py\` and times each call ([[nanosecond|ns]] = a billionth of a second). The ranking matches the Big-O story: a cancel is the cheapest real operation; a new level costs about 600 ns more than joining one; market orders have the long tail because big ones sweep several levels. Throughput: **757,703 events per second**, in pure Python.`,
          children: ui.Table({
            caption: "benchmarks/bench_engine.py, 1M events, Python 3.14 (from the README)",
            dense: true,
            columns: [
              { key: "op", label: "Operation", align: "left", mono: false },
              { key: "mean", label: "Mean (ns)" },
              { key: "p99", label: "p99 (ns)" },
              { key: "o", label: "Big-O" },
            ],
            rows: [
              { op: "cancel a resting order", mean: "592", p99: "1,000", o: "O(1)" },
              { op: "cancel, already filled (no-op)", mean: "113", p99: "200", o: "O(1)" },
              { op: "add at an existing level", mean: "1,129", p99: "1,800", o: "O(1)" },
              { op: "add that creates a level", mean: "1,711", p99: "2,800", o: "O(log L)" },
              { op: "market order", mean: "4,040", p99: "10,100", o: "O(m + k log L)" },
            ],
          }),
        }));

      // ---------------- See
      const see = ctx.section("see", "Watch the engine work");
      see.append(ui.p("Step through five operations on a tiny book. The highlighted parts are the only things each operation touches; the cost is in the top corner."), buildSee(ctx));

      // ---------------- Try
      const tr = ctx.section("try", "Drive it, then build it");
      tr.append(
        ui.TryIt({
          title: "Your own book, live",
          intro: "Add asks at any of four prices, cancel by id, or send a market buy. Each line below is an event the real engine reported. Try: cancel the middle order of a queue; cancel an id twice; buy more SOL than the book holds.",
          children: buildSandbox(ctx),
        }),
        ui.ForProgrammers({ title: "Coding exercises: build the engine yourself", children: [
        ui.p("Five small functions that together make a working engine. They are in JavaScript so they run right here, in a sandbox with a time limit; the ideas map one to one onto `orderbook.py`. Each has tests, three hints that get more specific, and a reference solution. Your code and progress are saved in this browser, and the [code lab](#/play/code) collects every exercise in the course."),
        ...EXERCISES.map((x) => ui.CodeExercise(x))] }),
        ui.ForProgrammers({ title: "Practice on LeetCode", children: [
        ui.p("The same ideas appear in classic interview problems. Start at the top."),
        ui.Table({
          caption: "Suggested problems, in order",
          columns: [
            { key: "p", label: "Problem", align: "left", mono: false, format: (v) => ui.rich(v) },
            { key: "lvl", label: "Level", align: "left", mono: false },
            { key: "why", label: "Why it helps", align: "left", mono: false },
          ],
          rows: LEETCODE.map((l) => ({ p: `[LC ${l.n} · ${l.t}](https://leetcode.com/problems/${l.slug}/)`, lvl: l.lvl, why: l.why })),
        })] }));
    },

    quiz: [
      {
        q: "Why is each price level a **doubly** linked list rather than a singly linked one (with `next` pointers only)?",
        options: [
          { text: "So matching can walk the queue backwards", why: "Matching always starts at the head and moves toward the tail, so `next` pointers would be enough for that." },
          { text: "So an order in the middle can be removed in O(1)", why: "To remove Bob, the order in front of him must point past him. With a `prev` pointer Bob already knows who that is; with only `next` pointers you would have to walk from the head to find out, which is O(n)." },
          { text: "Because it uses less memory", why: "It uses a little more: every node stores an extra pointer. The engine pays that memory to make cancels O(1)." },
          { text: "To keep the prices sorted", why: "The linked list holds orders at one price, in time order. Keeping prices sorted is the sorted map's job." },
        ],
        answer: 1,
      },
      {
        q: "One side of a book has a million price levels. You cancel an order that shares its level with two others. Roughly how much work is that?",
        options: [
          { text: "O(1): a hash-map lookup and a couple of pointer changes", why: "The id map hands over the node directly and the doubly linked list unlinks it, whatever the size of the book. The level keeps two orders, so the sorted map isn't touched." },
          { text: "O(log L): about 20 steps to find the level", why: "The level never has to be searched for: the node itself is found through the id map. O(log L) only appears if the cancel empties the level and its key must be deleted." },
          { text: "O(L): scan the levels until the order turns up", why: "That is the slow search the id map exists to avoid." },
          { text: "O(n) in the number of orders at that price", why: "No walking is needed: the node knows both of its neighbours, so it can be unlinked in place." },
        ],
        answer: 0,
      },
      {
        q: "In the benchmark, an add that creates a new price level took about 1,711 ns on average, and an add that joins an existing level about 1,129 ns. What best explains the difference?",
        options: [
          { text: "Joining a level means walking its queue to reach the tail", why: "The level keeps a `tail` pointer, so appending never walks the queue. That's why joining a level is O(1)." },
          { text: "A new level needs a new key inserted into the sorted map (O(log L)) and a new level object", why: "Both adds append the order and store its id; only the new-level case also creates a `PriceLevel` and inserts a price into the `SortedDict`. That extra work is the roughly 600 ns gap." },
          { text: "Prices far from the mid are slower to store", why: "The engine never looks at the distance from the mid. A new level costs the same wherever it is." },
          { text: "It's noise: both operations are O(1)", why: "Each figure is an average over hundreds of thousands of calls, so the gap is real. And adding a new level isn't O(1): it inserts into the sorted map." },
        ],
        answer: 1,
      },
    ],
  });
})(window.OBZ = window.OBZ || {});
