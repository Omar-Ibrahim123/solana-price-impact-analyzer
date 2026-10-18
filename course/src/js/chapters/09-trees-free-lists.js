/* chapters/09-trees-free-lists.js: Chapter 9, "Red-black trees in an array, and free lists".
 *   Explain  why a balanced tree; red-black colouring as an anti-lopsidedness rule; no pointers
 *            in an account -> nodes in a fixed array linked by index; the free list and the bump
 *            index; how phoenix.py finds the live orders (scan, drop the free list, sort)
 *   See      Stepper: 7 sorted inserts -> a plain BST chain vs a red-black tree -> the same tree
 *            as an array of nodes -> following node numbers to find a key
 *   Try      a node array (8 nodes): add bids, remove them, watch nodes come back via the free
 *            list; a prediction check; the free-list allocator code exercise
 * Exports `exercises: [FREE_LIST_EX]` on the chapter for the code lab.
 * Live numbers come from the dataset's account bytes (phoenixAccount); the asks-tree and depth
 * figures are from an earlier full check of the raw bytes (slot 458,325,932).
 * Wording: "slot" means only Solana's 400 ms slot; array positions are "node numbers".
 */
(function (OBZ) {
  "use strict";
  const { h, fmt, clear } = OBZ.util;

  /* ------------------------------------------------------------------ See: tree -> array */
  // Seven bids inserted in price order. slot = insertion order. Red-black result of inserting
  // 101..107 in order (standard insert): root 102; 104 red; 105, 107 red; others black.
  const NODES = [
    { slot: 1, price: 101, rank: 1, depth: 1, red: false, L: 0, R: 0 },
    { slot: 2, price: 102, rank: 2, depth: 0, red: false, L: 1, R: 4 },
    { slot: 3, price: 103, rank: 3, depth: 2, red: false, L: 0, R: 0 },
    { slot: 4, price: 104, rank: 4, depth: 1, red: true, L: 3, R: 6 },
    { slot: 5, price: 105, rank: 5, depth: 3, red: true, L: 0, R: 0 },
    { slot: 6, price: 106, rank: 6, depth: 2, red: false, L: 5, R: 7 },
    { slot: 7, price: 107, rank: 7, depth: 3, red: true, L: 0, R: 0 },
  ];
  const TREE_EDGES = [[2, 1], [2, 4], [4, 3], [4, 6], [6, 5], [6, 7]];
  const PATH = [2, 4, 6, 5];
  const rx = (n) => 40 + (n.rank - 1) * 60;
  const POS = {
    chain: (n) => [rx(n), 32 + (n.rank - 1) * 38],
    tree: (n) => [rx(n), 40 + n.depth * 62],
    array: (n) => [34 + (n.slot - 1) * 62, 146],
  };

  function buildTreeFigure() {
    const svg = h("svg", { class: "diagram diagram-md", viewBox: "0 0 440 300", attrs: { role: "img", "aria-label": "Seven bids stored as a lopsided chain, as a balanced red-black tree, and as an array of numbered nodes" } });
    const layer = (cls) => { const g = h("g", { class: "fade" + (cls ? " " + cls : "") }); svg.appendChild(g); return g; };
    const at = (layout, slot) => POS[layout](NODES[slot - 1]);
    const chainEdges = layer(), treeEdges = layer(), arrayText = layer(), pathMarks = layer();
    for (let k = 1; k < 7; k++) { const [x1, y1] = at("chain", k), [x2, y2] = at("chain", k + 1); chainEdges.appendChild(h("line", { class: "line", x1, y1, x2, y2 })); }
    for (const [a, b] of TREE_EDGES) { const [x1, y1] = at("tree", a), [x2, y2] = at("tree", b); treeEdges.appendChild(h("line", { class: "line", x1, y1, x2, y2 })); }
    chainEdges.appendChild(h("text", { x: 430, y: 290, "text-anchor": "end", class: "t-muted", text: "height 7" }));
    treeEdges.appendChild(h("text", { x: 430, y: 290, "text-anchor": "end", class: "t-muted", text: "height 4" }));
    for (const n of NODES) {
      const [x, y] = at("array", n.slot);
      arrayText.appendChild(h("text", { x, y: 112, "text-anchor": "middle", class: "t-muted", text: "node " + n.slot }));
      arrayText.appendChild(h("text", { x, y: 190, "text-anchor": "middle", class: "t-mono", text: "L " + n.L }));
      arrayText.appendChild(h("text", { x, y: 208, "text-anchor": "middle", class: "t-mono", text: "R " + n.R }));
      arrayText.appendChild(h("text", { x, y: 228, "text-anchor": "middle", class: "t-muted", text: n.red ? "red" : "black" }));
    }
    arrayText.appendChild(h("text", { x: 10, y: 272, class: "t-bold", text: "root = node 2" }));
    arrayText.appendChild(h("text", { x: 430, y: 272, "text-anchor": "end", class: "t-muted", text: "0 = no child" }));
    PATH.forEach((slot, i) => {
      const [x, y] = at("array", slot);
      pathMarks.appendChild(h("circle", { cx: x, cy: y, r: 25, fill: "none", class: "hl" }));
      pathMarks.appendChild(h("text", { x: x, y: 84, "text-anchor": "middle", class: "t-bold t-accent", text: "step " + (i + 1) }));
    });
    const nodes = {};
    for (const n of NODES) {
      const circle = h("circle", { cx: 0, cy: 0, r: 19, class: "box", style: "transition: fill 0.4s, stroke 0.4s" });
      const label = h("text", { x: 0, y: 5, "text-anchor": "middle", class: "t-mono t-bold", style: "transition: fill 0.4s", text: String(n.price) });
      const g = h("g", { style: "transition: transform 0.7s cubic-bezier(.2,.8,.2,1)" }, circle, label);
      svg.appendChild(g);
      nodes[n.slot] = { g, circle, label };
    }
    return { svg, nodes, layers: { chainEdges, treeEdges, arrayText, pathMarks } };
  }

  const TREE_STEPS = [
    "Seven bids arrive in price order, $101 first. A plain [[binary-search-tree|binary search tree]] hangs each higher price to the right of the one before. The result is a chain: finding $107 takes 7 steps, no better than a list.",
    "A [[red-black-tree|red-black tree]] given the same seven bids stays bushy. Every node is red or black, and two rules always hold: a red node never has a red child, and every path from the root down to an empty spot passes the same number of black nodes. When an insert breaks a rule, the tree recolours a few nodes or does a [[rotation]]. Height: 4 instead of 7.",
    "An account has no stable memory addresses to point with, so the nodes sit in a fixed array, numbered in the order the bids arrived. Each link is just a node number: the root, $102, is node 2, and its children are nodes 1 and 4. 0 means no child.",
    "Follow the numbers to find $105. Start at the root, node 2 ($102). $105 is higher, so take R = 4 ($104). Higher again: R = 6 ($106). Lower: L = 5. Found in 4 steps, using nothing but node numbers.",
  ];

  function applyTreeStep(fig, i) {
    const layout = i === 0 ? "chain" : i === 1 ? "tree" : "array";
    for (const n of NODES) {
      const [x, y] = POS[layout](n);
      const v = fig.nodes[n.slot];
      v.g.style.transform = `translate(${x}px, ${y}px)`;
      v.g.setAttribute("transform", `translate(${x} ${y})`);
      const coloured = i >= 1;
      v.circle.style.fill = coloured ? (n.red ? "var(--bad)" : "var(--ink)") : "";
      v.circle.style.stroke = coloured ? (n.red ? "var(--bad)" : "var(--ink)") : "";
      v.label.style.fill = coloured ? "var(--bg)" : "";
      v.g.style.opacity = i === 3 && !PATH.includes(n.slot) ? "0.45" : "1";
    }
    const show = (g, on) => { g.style.opacity = on ? "1" : "0"; };
    show(fig.layers.chainEdges, i === 0);
    show(fig.layers.treeEdges, i === 1);
    show(fig.layers.arrayText, i >= 2);
    show(fig.layers.pathMarks, i === 3);
  }

  /* ------------------------------------------------------------------ Try: the node array */
  const CAPACITY = 8;
  const PRICES = [103.75, 103.70, 103.80, 103.65, 103.72, 103.78, 103.60, 103.74, 103.68, 103.82, 103.71, 103.77];

  function newState() {
    const slots = [];
    for (let k = 0; k <= CAPACITY; k++) slots.push({ status: "unused", price: null, next: 0, seq: 0 });
    return { slots, bump: 1, head: 0, size: 0, priceIdx: 0, seq: 0, lastTouched: 0 };
  }
  function nextSlot(s) { return s.head !== 0 ? s.head : s.bump <= CAPACITY ? s.bump : 0; }
  function freeChain(s) { const out = []; let k = s.head, guard = 0; while (k && guard++ < 20) { out.push(k); k = s.slots[k].next; } return out; }

  function buildArrayWidget(ctx) {
    const { ui } = ctx;
    let s = newState();
    const wrap = h("div", { class: "stack" });
    const header = h("p", { class: "mono", attrs: { "aria-live": "off" } });
    const row = h("div", { attrs: { role: "group", "aria-label": "The bids array: 8 nodes" }, style: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(76px, 1fr))", gap: "var(--s-2)" } });
    const chain = h("p", { class: "mono" });
    const decoder = h("div", { class: "fine" });
    const log = h("div", { class: "readout-panel", attrs: { "aria-live": "polite" } });
    const addBtn = ui.Button({ label: "Add a bid", variant: "buy", onClick: () => add() });
    const resetBtn = ui.Button({ label: "Reset", variant: "ghost", onClick: () => { s = newState(); say("Back to an empty array: every node is unused, the bump index is 1 and the free list is empty."); draw(); } });
    let flashTimer = null, guess = false;
    ctx.onCleanup(() => clearTimeout(flashTimer));

    function say(text) { clear(log).appendChild(ui.p(text)); }
    function add() {
      const k = nextSlot(s);
      if (!k) { say("**The array is full.** All 8 nodes hold live bids, so there is nowhere to put a new one. Phoenix would reject the order. Remove a bid first."); return; }
      const price = PRICES[s.priceIdx % PRICES.length]; s.priceIdx++;
      let how;
      if (s.head === k) {
        s.head = s.slots[k].next;
        how = `node ${k} came off the **top of the free list** (it was the most recently freed). The free-list head moves on to ${s.head || "nothing (the list is now empty)"}.`;
      } else {
        s.bump++;
        how = `the free list was empty, so it took the never-used node at the **bump index**, and the bump index moved up to ${s.bump}.`;
      }
      s.seq++;
      s.slots[k] = { status: "live", price, next: 0, seq: s.seq };
      s.size++; s.lastTouched = k;
      say(`Added a bid at **$${price.toFixed(2)}** in node ${k}: ${how}`);
      draw();
    }
    function remove(k) {
      const slot = s.slots[k];
      if (slot.status !== "live") return;
      slot.status = "free"; slot.next = s.head; s.head = k; s.size--; s.lastTouched = k;
      say(`Removed the $${slot.price.toFixed(2)} bid from node ${k}. The node was pushed onto the **free list**: its next pointer now holds ${slot.next || "0 (end of list)"}, and the free-list head is ${k}. Its old price is still in the bytes, crossed out here.`);
      draw();
    }
    function draw() {
      header.textContent = `bump_index = ${s.bump} · free_list_head = ${s.head} · size = ${s.size}`;
      clear(row);
      const nxt = nextSlot(s);
      for (let k = 1; k <= CAPACITY; k++) {
        const sl = s.slots[k];
        const cls = sl.status === "live" ? "f3" : sl.status === "free" ? "f5" : "f6";
        const tag = sl.status === "live" ? "▲ live" : sl.status === "free" ? "freed" : "unused";
        const label = sl.status === "live" ? `Node ${k}: live bid at $${sl.price.toFixed(2)}. Activate to remove it.`
          : sl.status === "free" ? `Node ${k}: freed, next free node ${sl.next || "none"}.` : `Node ${k}: never used.`;
        const b = h("button", {
          type: "button", class: cls, disabled: sl.status !== "live",
          attrs: { "aria-label": label },
          style: { minHeight: "88px", border: "1px solid var(--line-strong)", borderRadius: "var(--r-md)", padding: "var(--s-2)", color: "var(--ink)", font: "inherit", textAlign: "left", cursor: sl.status === "live" ? "pointer" : "default", boxShadow: k === s.lastTouched ? "0 0 0 3px var(--accent)" : "none", transition: "box-shadow 0.4s, background-color 0.4s", opacity: "1" },
          on: { click: () => remove(k) },
        },
        h("div", { class: "fine mono", text: "node " + k }),
        h("div", { class: "t-bold", style: { fontWeight: "700" }, text: tag }),
        sl.status === "live" ? h("div", { class: "mono", text: "$" + sl.price.toFixed(2) }) : null,
        sl.status === "free" ? h("div", { class: "mono fine" }, h("s", { text: "$" + sl.price.toFixed(2) }), " → " + (sl.next || "end")) : null,
        k === nxt && !guess ? h("div", { class: "fine", style: { color: "var(--accent)", fontWeight: "600" }, text: "next add" }) : null);
        row.appendChild(b);
      }
      const fc = freeChain(s);
      chain.textContent = `free list: head → ${fc.length ? fc.join(" → ") + " → end" : "end (empty)"}`;
      // what phoenix.py does with this array
      const scanned = [];
      for (let k = 1; k < s.bump; k++) scanned.push(k);
      const freeSet = new Set(fc);
      const live = scanned.filter((k) => !freeSet.has(k)).map((k) => s.slots[k]).sort((a, b) => b.price - a.price || a.seq - b.seq);
      clear(decoder).append(
        h("strong", { text: "What the decoder does: " }),
        scanned.length ? `read nodes 1–${s.bump - 1}, drop the free ones (${fc.length ? fc.slice().sort((a, b) => a - b).join(", ") : "none"}), sort the rest by price, highest first: ` : "nothing to read yet. ",
        live.length ? h("span", { class: "mono", text: live.map((x) => "$" + x.price.toFixed(2)).join(" › ") }) : scanned.length ? "no live bids." : "");
    }
    say("Press **Add a bid** a few times, then click a live node to remove its bid. Before each add, guess which node the new bid will land in. Switch **Guess mode** on to hide the *next add* marker, and off again to check.");
    draw();
    const guessSeg = ui.Segmented({ label: "Guess mode", small: true, value: false, options: [{ value: false, label: "Guess mode off" }, { value: true, label: "Guess mode on" }], onChange: (v) => { guess = v; draw(); } });
    wrap.append(h("div", { class: "btn-row" }, addBtn, resetBtn, guessSeg), header, row, chain, log, decoder);
    return wrap;
  }

  /* ------------------------------------------------------------------ code exercise */
  const FREE_LIST_EX = {
    id: "ex-free-list",
    title: "Exercise 7 · A free-list allocator",
    level: "medium",
    brief: `Phoenix keeps each side's orders in a fixed array of nodes numbered 1 to \`capacity\` (0 means "none"). \`createAllocator(capacity)\` is already written. Write the two functions that hand out and take back nodes:

- \`allocate(a)\` returns a node number for a new order. If the free list isn't empty, reuse its first node (the most recently freed). Otherwise take the never-used node at \`a.bump\` and move \`a.bump\` up by one. If every node is in use, return 0.
- \`release(a, node)\` gives a node back by pushing it onto the front of the free list.

The free list is a linked list through the array \`a.next\`: \`a.freeHead\` is its first node, \`a.next[node]\` is the node after that one, and 0 ends the list. Keep \`a.size\` (nodes in use) up to date.`,
    prelude: [
      "function createAllocator(capacity) {",
      "  return { capacity, bump: 1, freeHead: 0, size: 0, next: new Array(capacity + 1).fill(0) };",
      "}",
    ].join("\n"),
    starter: [
      "function allocate(a) {",
      "  // 1. Free list not empty? Take its head, move freeHead along, return the node.",
      "  // 2. Otherwise, if a.bump <= a.capacity, return a.bump and move it up by one.",
      "  // 3. Otherwise the array is full: return 0.",
      "  return 0;",
      "}",
      "",
      "function release(a, node) {",
      "  // Push node onto the front of the free list.",
      "}",
    ].join("\n"),
    exports: ["allocate", "release", "createAllocator"],
    tests: [
      { name: "a fresh allocator hands out 1, 2, 3 and moves bump to 4", code: "const a = A.createAllocator(4); eq([A.allocate(a), A.allocate(a), A.allocate(a)], [1, 2, 3]); eq(a.bump, 4, 'bump');" },
      { name: "a freed node is reused before a never-used one", code: "const a = A.createAllocator(4); A.allocate(a); A.allocate(a); A.allocate(a); A.release(a, 2); eq(A.allocate(a), 2, 'reuse node 2'); eq(A.allocate(a), 4, 'then the bump node');" },
      { name: "the most recently freed node comes back first (a stack)", code: "const a = A.createAllocator(4); A.allocate(a); A.allocate(a); A.allocate(a); A.release(a, 1); A.release(a, 3); eq([A.allocate(a), A.allocate(a)], [3, 1]);" },
      { name: "the free list is linked through a.next", code: "const a = A.createAllocator(5); for (let i = 0; i < 4; i++) A.allocate(a); A.release(a, 2); A.release(a, 4); eq(a.freeHead, 4, 'freeHead'); eq(a.next[4], 2, 'next[4]'); eq(a.next[2], 0, 'next[2] ends the list');" },
      { name: "size counts the nodes in use", code: "const a = A.createAllocator(4); A.allocate(a); A.allocate(a); A.allocate(a); eq(a.size, 3); A.release(a, 1); eq(a.size, 2); A.allocate(a); eq(a.size, 3);" },
      { name: "a full array returns 0, and works again after a release", code: "const a = A.createAllocator(2); A.allocate(a); A.allocate(a); eq(A.allocate(a), 0, 'full'); eq(a.size, 2, 'size unchanged when full'); A.release(a, 1); eq(A.allocate(a), 1, 'after release'); eq(a.bump, 3, 'bump never goes past capacity + 1');" },
    ],
    hints: [
      "Popping the free list: remember `const node = a.freeHead`, then move the head along with `a.freeHead = a.next[node]`.",
      "`release` is the opposite, and it is two lines: the freed node points at the old head (`a.next[node] = a.freeHead`), then it becomes the new head (`a.freeHead = node`). Don't forget `a.size`.",
      "In `allocate`: `if (a.freeHead !== 0) { const node = a.freeHead; a.freeHead = a.next[node]; a.next[node] = 0; a.size++; return node; }` then `if (a.bump <= a.capacity) { a.size++; return a.bump++; }` and finally `return 0;`.",
    ],
    solution: [
      "function allocate(a) {",
      "  if (a.freeHead !== 0) {          // reuse the most recently freed node",
      "    const node = a.freeHead;",
      "    a.freeHead = a.next[node];",
      "    a.next[node] = 0;",
      "    a.size++;",
      "    return node;",
      "  }",
      "  if (a.bump <= a.capacity) {      // otherwise a never-used node",
      "    a.size++;",
      "    return a.bump++;",
      "  }",
      "  return 0;                        // full",
      "}",
      "",
      "function release(a, node) {",
      "  a.next[node] = a.freeHead;       // push onto the front",
      "  a.freeHead = node;",
      "  a.size--;",
      "}",
    ].join("\n"),
  };

  /** Live numbers from the account bytes in the dataset (via chapter 8's decoder), or null. */
  function realBids(ctx) {
    try {
      const pa = ctx.data.active().phoenixAccount;
      const L = OBZ.lessons && OBZ.lessons.phoenixHex;
      if (!pa || !L) return null;
      const d = L.decode(pa);
      if (!d.ok || !d.bump || d.size === undefined) return null;
      const capacity = d.sizes.bids, used = d.bump - 1;
      return { slot: d.slot, live: d.size, bump: d.bump, root: d.root, capacity, freed: used - d.size, never: capacity - used };
    } catch (e) { return null; }
  }

  /* ------------------------------------------------------------------ the chapter */
  OBZ.chapters.register({
    id: "trees-free-lists",
    number: 9,
    title: "Red-black trees in an array, and free lists",
    summary: "How Phoenix keeps each side of the book as a balanced tree inside a fixed array, and how a free list reuses the nodes that orders leave behind.",
    goals: [
      "Say why an order book wants a balanced tree, and what the red-black rules buy",
      "Explain how node numbers act as pointers inside one account",
      "Describe how the free list and the bump index hand out and reuse nodes",
      "Follow how the decoder finds the live orders among all the nodes",
    ],
    status: "ready",
    exercises: [FREE_LIST_EX],

    render(el, ctx) {
      const { ui } = ctx;

      // ---------------- Explain
      const R = realBids(ctx);
      const n = R ? R.live : 1298;
      const levels = Math.ceil(Math.log2(n + 1)), cap = Math.floor(2 * Math.log2(n + 1));
      const ex = ctx.section("explain", "A sorted book in a box of fixed size");
      ex.append(
        ui.prose(`
${R ? `In a read of Phoenix's SOL/USDC account during the collector run (Solana [[slot]] ${fmt.int(R.slot)}), its bids tree held **${fmt.int(n)} live orders**` : "Phoenix's SOL/USDC bids tree holds well over a thousand live orders"}, and orders keep arriving and leaving. The book must stay sorted through all of it. A sorted list is slow to insert into, because everything after the new item shifts over ([chapter 6](#/learn/6)). A [[binary-search-tree|binary search tree]] is better. It starts from one top node, the **root**; smaller keys go left and larger keys go right, so finding a spot takes one step per level. With ${fmt.int(n)} orders a perfectly balanced tree is about ${levels} levels deep, so about ${levels} steps.

The catch is the word *balanced*. Feed a plain tree prices in rising order and it grows into one long chain. A [[red-black-tree|red-black tree]] prevents that with a rule rather than luck. Each node is coloured red or black; a red node may never have a red child; and every path from the top down to an empty spot must pass the same number of black nodes. Together these keep the longest path at most twice the shortest, so the height is at most 2 × log₂(n + 1). For ${fmt.int(n)} orders that cap is about ${cap} levels. (In an earlier full check of the real bytes, at slot 458,325,932, the tree was 16 deep.) When an insert or a delete breaks a rule, the tree recolours some nodes and does at most three [[rotation|rotations]] to fix it. A rotation is a small local rearrangement: a child moves up into its parent's place and the parent becomes its child, without changing the sorted order. All of it takes [[o-log-n|O(log n)]] time.`),
        ui.prose(`
In an ordinary program each node would hold [[pointer|pointers]]: the memory addresses of its children. An account can't use those. When a transaction runs, the program sees the account's bytes at an address that depends on how that transaction lists its accounts, so an address saved by one transaction could be wrong in the next. Phoenix instead puts all the nodes in one fixed [[array]] and links them by **node number**, an [[index]]. Node numbers are also smaller (4 bytes instead of 8) and mean the same thing wherever the bytes sit. Node *k* sits at a fixed spot: 32 bytes into the tree, plus (*k* − 1) × 64. Numbering starts at 1 because 0 is kept to mean "no node". ${R ? `The bids root was node ${fmt.int(R.root)}, so it lives at byte 880 + 32 + ${fmt.int(R.root - 1)} × 64 = **${fmt.int(912 + (R.root - 1) * 64)}** of the account.` : ""}

(A word of warning: on Solana a *slot* is a moment in time, about 400 ms. The positions in this array are called *node numbers* here, never slots.)

A fixed array raises a new question: when an order leaves the book, what happens to its node? It goes on the [[free-list|free list]], a [[linked-list|linked list]] of empty nodes threaded through the nodes themselves. Think of a coat check: returned tickets go on top of a pile, and the next guest gets the top ticket. The freed node's first link (its *left* register) now holds the number of the next free node, and the tree header remembers the head of the pile. A new order takes the head, so the most recently freed node is reused first, like a [[stack]]. Only when the pile is empty does the tree use a fresh node at the [[bump-index|bump index]], the boundary of never-touched space, and move the boundary up by one. The code that hands nodes out and takes them back is called an *allocator*; Phoenix's comes from a small library called \`sokoban\`.`),
        ui.Callout({
          kind: "project", open: true, title: "Checked on the real bytes",
          body: `${R ? `In the read shown in the [hex explorer](#/play/hex) (slot ${fmt.int(R.slot)}): bids tree bump index **${fmt.int(R.bump)}**, so nodes 1–${fmt.int(R.bump - 1)} have been used. **${fmt.int(R.live)}** hold live orders, so **${fmt.int(R.freed)}** are on the free list (${fmt.int(R.freed)} + ${fmt.int(R.live)} = ${fmt.int(R.bump - 1)}), and **${fmt.int(R.never)}** of the ${fmt.int(R.capacity)} have never been touched.

` : ""}An earlier full check of the whole account (slot 458,325,932) also read the asks tree (341 live, 958 freed, bump index 1,300), confirmed that in both trees no red node had a red child and every path had the same number of black nodes, and found that the freed bid nodes still held old orders adding up to about **7,375 SOL**. So \`phoenix.py\` never walks the tree. It reads every node from 1 to bump_index − 1, follows the free list to mark the freed ones, drops them, and sorts the rest by price and sequence number. Sorting a couple of thousand items is instant for a computer.`,
        }),
        ui.Callout({
          kind: "real", title: "One detail of the real allocator",
          body: "In the drawings here the free list ends with 0. Phoenix's `sokoban` library ends it differently: the last freed node points at the bump index, so the free list runs straight into the never-used space. In the real bytes both trees' chains end exactly at their bump index. That is why the decoder stops following the list when it reaches `bump_index`.",
        }));

      // ---------------- See
      const see = ctx.section("see", "From a lopsided chain to an array of nodes");
      const fig = buildTreeFigure();
      see.append(
        ui.p("Step through seven bids stored three ways. Watch the height, then watch the links turn into plain numbers."),
        ui.Figure({
          label: "Figure 9.1",
          children: ui.Stepper({ steps: TREE_STEPS, stage: fig.svg, render: (i) => applyTreeStep(fig, i), interval: 3200, label: "A tree stored in an array" }),
          caption: "The same seven bids as a plain binary search tree (height 7), a red-black tree (height 4), and that red-black tree laid out in an array by node number. Black nodes are drawn dark and red nodes red; the array view also spells the colour out.",
          alt: "Seven bids priced $101 to $107. First, a plain binary search tree forms a diagonal chain seven levels tall. Second, a red-black tree holds them in four levels: $102 at the root (black) with children $101 (black) and $104 (red); $104 has children $103 (black) and $106 (black); $106 has children $105 (red) and $107 (red). Third, the nodes are numbered 1 to 7 in arrival order, each showing its left and right child as node numbers: node 2 has L 1 and R 4, node 4 has L 3 and R 6, node 6 has L 5 and R 7, the rest have 0. Fourth, a search for $105 visits nodes 2, 4, 6 and 5.",
        }));

      // ---------------- Try
      const tr = ctx.section("try", "Fill, free and reuse");
      tr.append(
        ui.TryIt({
          title: "A bids array with 8 nodes",
          intro: "This is a tiny version of Phoenix's bids array. **Add** a few bids, then **click a live node** to remove its bid. Watch freed nodes form a chain, and see which node the next bid takes. The tree links are left out so you can focus on the array.",
          children: buildArrayWidget(ctx),
        }),
        ui.NumberCheck({
          question: "Your turn: start from an empty array. Add five bids (they take nodes 1 to 5). Remove the bid in node 2, then the bid in node 4. Now add one more bid. Which node does it take?",
          answer: 4, tolerance: 0,
          explain: "Node 4 was freed last, so it sits on top of the free list. The next bid after that takes node 2, and only then does the array use node 6 at the bump index. Try it in the widget above.",
          hint: "The free list is a pile: the node freed most recently is on top. Fresh nodes from the bump index are used only when the pile is empty.",
        }),
        ui.ForProgrammers({ title: "Exercise 7 · A free-list allocator in code", children: ui.CodeExercise(FREE_LIST_EX) }));
    },

    quiz: [
      {
        q: "Why do Phoenix's tree nodes link to each other by node number instead of by memory address?",
        options: [
          { text: "Memory addresses are too big to fit in a 64-byte node", why: "Size isn't the main problem: a 64-bit address would fit, though a 4-byte node number is smaller. The problem is that an address wouldn't stay valid." },
          { text: "Where the bytes sit in memory depends on each transaction, so an address would go stale", why: "Right. The program sees the account at an address that depends on how each transaction lists its accounts. A node number is a position inside the account itself, so it stays valid, and at 4 bytes it is half the size of an address." },
          { text: "Solana programs aren't allowed numbers bigger than 4 billion", why: "Solana programs use 64-bit numbers all the time (prices, sizes, sequence numbers). The reason is that addresses aren't stable." },
          { text: "Following a node number is faster than following an address", why: "Speed isn't the reason. A node number has to be turned into an offset first, so it is slightly more work, but it stays valid wherever the account is loaded." },
        ],
        answer: 1,
      },
      {
        q: "Nodes 1–5 are in use and the free list is empty. The order in node 2 is cancelled, then the order in node 4. Two new orders arrive. Which nodes do they get, in order?",
        options: [
          { text: "Node 2, then node 4", why: "That would be first-in, first-out, like a queue. The free list is a stack: the most recently freed node (4) comes off first." },
          { text: "Node 4, then node 2", why: "Right. Each freed node is pushed on top of the free list, so 4 is on top of 2. New orders pop from the top." },
          { text: "Node 6, then node 7", why: "Fresh nodes from the bump index are used only when the free list is empty. Here it holds 4 and 2." },
          { text: "Node 2, then node 6", why: "Both freed nodes are reused before any fresh one, and the most recent (4) goes first." },
        ],
        answer: 1,
      },
      {
        q: "A freed node still holds its old order's bytes, for example 433 SOL at $92.585. What would go wrong if a decoder read every node up to the bump index without checking the free list?",
        options: [
          { text: "Nothing: freed nodes are wiped, so they would read as empty", why: "Real Phoenix bytes show the opposite. A freed node's first register is reused as the free-list link and its other links are cleared, but the old order's price and size stay in the bytes." },
          { text: "Old filled or cancelled orders would show up as phantom liquidity", why: "Right. In one full check of the real bytes the freed bid nodes held about 7,375 SOL of old orders. Skipping the free list is what keeps them out." },
          { text: "It would miss some of the live orders in the tree", why: "Reading every node up to the bump index finds every live order. The danger runs the other way: it would also pick up dead ones." },
          { text: "The Phoenix program would reject the read", why: "Anyone can read any account's bytes; nothing checks how you decode them. Getting it right is the decoder's job." },
        ],
        answer: 1,
      },
    ],
  });
})(window.OBZ = window.OBZ || {});
