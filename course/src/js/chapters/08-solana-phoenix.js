/* chapters/08-solana-phoenix.js: Chapter 8, "Solana basics and Phoenix's account".
 *   Explain  accounts, programs, transactions, slots; one market in one account; crankless;
 *            how phoenix.py reads it (getAccountInfo + struct); little-endian
 *   See      a to-scale map of the real account (Stepper: whole account -> 880-byte start -> one node)
 *   Try      a hex explorer on real account bytes (ctx.data.active().phoenixAccount): every byte's
 *            field, offset, type, little-endian reading and meaning; live vs free nodes; one order
 *            decoded, with the bid sequence-number bit flip
 *
 * Also exposes OBZ.lessons.phoenixHex = {explorer(ctx), accountMap(ctx), decode(pa)} so the Play
 * tool (play/hex.js) shows the same explorer. Layout constants mirror src/impact_analyzer/phoenix.py.
 */
(function (OBZ) {
  "use strict";
  const { h, fmt, clear } = OBZ.util;

  /* ------------------------------------------------------------------ layout (phoenix.py) */
  const HEADER = 576, PADDING = 256, FIELDS = 48, TREE_PREFIX = 32, NODE = 64, TRADER_NODE = 144;
  const FIELDS_AT = HEADER + PADDING;          // 832: the six market u64s
  const BIDS_AT = FIELDS_AT + FIELDS;          // 880: the bids tree starts here
  const NODES_AT = BIDS_AT + TREE_PREFIX;      // 912: bids node 1
  // From the real SOL/USDC header (18 Oct 2026); used only when no account bytes are loaded.
  const DEFAULT_SIZES = { bids: 4096, asks: 4096, seats: 8321 };
  const U64_MAX = "18446744073709551615";

  function big(n) { return BigInt(n); }
  const MASK = typeof BigInt !== "undefined" ? big(U64_MAX) : null;

  /** Little-endian unsigned integer of `size` bytes at slice index i, as a BigInt. */
  function readLE(bytes, i, size) {
    let v = big(0);
    for (let k = size - 1; k >= 0; k--) v = (v << big(8)) | big(bytes[i + k]);
    return v;
  }
  const hex2 = (b) => b.toString(16).padStart(2, "0");
  const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  function base58(bytes) {
    let n = big(0);
    for (const b of bytes) n = n * big(256) + big(b);
    let s = "";
    const B = big(58);
    while (n > big(0)) { s = B58[Number(n % B)] + s; n = n / B; }
    for (const b of bytes) { if (b === 0) s = "1" + s; else break; }
    return s || "1";
  }
  function hexToBytes(hex) {
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
  }
  const n2 = (v) => Number(v);
  const bigStr = (v) => v.toLocaleString("en-US");

  /* ------------------------------------------------------------------ regions */
  const REGIONS = {
    header: { label: "Market header", cls: "f1", short: "header" },
    pad: { label: "Padding (all zeros)", cls: "f6", short: "padding" },
    fields: { label: "Market fields", cls: "f2", short: "market fields" },
    tree: { label: "Bids tree header", cls: "f4", short: "tree header" },
    live: { label: "Live bid node", cls: "f3", short: "live node" },
    free: { label: "Freed node (on the free list)", cls: "f5", short: "freed node" },
    unused: { label: "Never-used node", cls: "f6", short: "never used" },
  };

  /* ------------------------------------------------------------------ field explanations */
  // Phoenix's MarketStatus enum (0..5).
  const STATUS_NAMES = {
    0: "uninitialized", 1: "active, fully working (placing resting orders still needs a trader seat)",
    2: "post-only: new orders may rest but may not take", 3: "paused", 4: "closed", 5: "tombstoned (shut down for good)",
  };
  // Plain-English meaning of each field. `d` is the decoded account (tick, lot, values).
  const HEADER_FIELDS = [
    ["discriminant", 0, 8, "bytes", () => "A fixed 8-byte tag at the very start. The program checks it first, so nobody can trick it into treating some other account as a market."],
    ["status", 8, 8, "u64", (d, v) => `The market's state, as a number: 0 uninitialized, 1 active, 2 post-only, 3 paused, 4 closed, 5 tombstoned. ${STATUS_NAMES[v] ? `Here it is ${v}: ${STATUS_NAMES[v]}.` : `Here it is ${v}.`}`],
    ["bids_size", 16, 8, "u64", (d, v) => `Room for ${v} bids. The whole bids tree, ${v} slots of 64 bytes, was set aside when the market was created, before a single order arrived.`],
    ["asks_size", 24, 8, "u64", (d, v) => `Room for ${v} asks, set aside up front in the same way.`],
    ["num_seats", 32, 8, "u64", (d, v) => `Room for ${v} trader seats: the size of the traders tree, which holds every trader's balances. Like bids_size it is a capacity. Together the three sizes fix the account's length exactly.`],
    ["base_decimals", 40, 4, "u32", () => "SOL has 9 decimals: 1 SOL = 1,000,000,000 lamports, its smallest unit."],
    ["base_vault_bump", 44, 4, "u32", () => "A small number used to work out the SOL vault's address. You don't need it to read the book."],
    ["base_mint", 48, 32, "pubkey", () => "The token being traded (the base token). This address is the mint for wrapped SOL."],
    ["base_vault", 80, 32, "pubkey", () => "The token account holding all the SOL traders have deposited in this market. Only the Phoenix program can move it."],
    ["base_lot_size", 112, 8, "u64", (d) => `Lamports per base lot: ${fmt.int(d.baseLotSize)} lamports = ${d.lot} SOL. Every order size is a whole number of these lots.`],
    ["quote_decimals", 120, 4, "u32", () => "USDC has 6 decimals: 1 USDC = 1,000,000 atoms."],
    ["quote_vault_bump", 124, 4, "u32", () => "A small number used to work out the USDC vault's address."],
    ["quote_mint", 128, 32, "pubkey", () => "The token prices are quoted in. This address is the USDC mint."],
    ["quote_vault", 160, 32, "pubkey", () => "The token account holding the market's USDC."],
    ["quote_lot_size", 192, 8, "u64", (d, v) => `USDC atoms per quote lot. Here ${v}, so one quote lot is ${v === "1" ? "one millionth of a dollar" : v + " millionths of a dollar"}.`],
    ["tick_size_in_quote_atoms_per_base_unit", 200, 8, "u64", (d, v) => `The price step, in USDC atoms per whole SOL: ${v} atoms = $${d.tick}. Every price on this market is a whole number of these [[tick|ticks]].`],
    ["authority", 208, 32, "pubkey", () => "The key allowed to change this market's settings."],
    ["fee_recipient", 240, 32, "pubkey", () => "Where the market's collected taker fees can be sent."],
    ["market_sequence_number", 272, 8, "u64", () => "A counter Phoenix increases as activity happens on this market. If two snapshots show different numbers, something happened in between."],
    ["successor", 280, 32, "pubkey", () => "The key that would become the authority if it were handed over (here, the same key)."],
    ["raw_base_units_per_base_unit", 312, 4, "u32", () => "How many raw SOL units count as one unit for pricing. It is 1 here."],
  ];
  const MARKET_FIELDS = [
    ["base_lots_per_base_unit", (d, v) => `Lots per whole SOL (${v}). Divide a size in lots by this to get SOL.`],
    ["tick_size_in_quote_lots_per_base_unit", (d, v) => `The tick size again, counted in quote lots per whole SOL: ${v}. Its type in Phoenix's source is \`QuoteLotsPerBaseUnitPerTick\`, "quote lots per base unit, per tick" (\`phoenix.py\` calls the field \`quote_lots_per_base_unit_per_tick\`). It links ticks to dollars: one tick is ${v} quote lots of ${fmt.num(d.quoteLotUsd, 6)} dollars each, $${d.tick}.`],
    ["order_sequence_number", () => "The number the *next* new order will get. Each order takes the next number, so a smaller number means an older order: that is how time priority is kept."],
    ["taker_fee_bps", (d, v) => `The [[taker-fee|taker fee]] in basis points: ${v} bps = ${(Number(v) / 100).toFixed(2)}% of each trade.`],
    ["collected_quote_lot_fees", (d, v) => `A running total of the fees this market has collected, in quote lots: about ${fmt.usd(Number(v) * d.quoteLotUsd, 0)}.`],
    ["unclaimed_quote_lot_fees", (d, v) => `Fees collected but not yet sent to the fee recipient: about ${fmt.usd(Number(v) * d.quoteLotUsd, 0)}.`],
  ];
  const TREE_FIELDS = [
    ["root", 0, 4, "u32", (d, v) => `The node number of the tree's root, where every search starts. Node numbers start at 1, and 0 means "none", so 0 here would mean an empty tree. The root is node ${v}, past the end of this slice.`],
    ["tree_padding", 4, 12, "bytes", () => "Unused bytes that keep the next part neatly lined up."],
    ["allocator_size", 16, 8, "u64", (d, v) => `How many nodes hold a live order right now: ${v} resting bids.`],
    ["bump_index", 24, 4, "u32", (d, v) => `The next never-used node. Nodes 1 to ${fmt.int(Number(v) - 1)} have each been used at least once; from node ${v} to the end of the array, nothing has ever been written. [Chapter 9](#/learn/9) explains it.`],
    ["free_list_head", 28, 4, "u32", (d, v) => `The most recently freed node, number ${v}: the start of the [[free-list|free list]], a chain of emptied nodes waiting to be reused.`],
  ];
  const NODE_FIELDS = [
    ["left", 0, 4, "u32"], ["right", 4, 4, "u32"], ["parent", 8, 4, "u32"], ["color", 12, 4, "u32"],
    ["price_in_ticks", 16, 8, "u64"], ["order_sequence_number", 24, 8, "u64"], ["trader_index", 32, 8, "u64"],
    ["num_base_lots", 40, 8, "u64"], ["last_valid_slot", 48, 8, "u64"], ["last_valid_unix_timestamp_in_seconds", 56, 8, "u64"],
  ];

  function nodeExplain(name, st, d, node, v) {
    const freed = st === "free";
    switch (name) {
      case "left": return freed
        ? `This node is on the free list, so this register no longer means "left child". It holds the number of the next freed node in the chain: ${v}.`
        : `Node number of the left child: the part of the tree whose keys sort below this one${v === "0" ? ". 0 means it has none" : ""}.`;
      case "right": return freed ? "Cleared to 0 when the node was freed." : `Node number of the right child: the part of the tree whose keys sort above this one${v === "0" ? ". 0 means it has none" : ""}.`;
      case "parent": return freed ? "Cleared to 0 when the node was freed." : `Node number of this node's parent (${v}). Following parents leads up to the root.`;
      case "color": return freed ? "Cleared to 0 when the node was freed." : `Red-black colour: ${v === "1" ? "1 = red" : "0 = black"}. The colours are what keep the tree from getting lopsided (chapter 9).`;
      case "price_in_ticks": return `${freed ? "Old price, left over from the order that used to live here: " : "The price: "}${fmt.int(node.price)} ticks × $${d.tick} = **$${fmt.price(node.price * d.tick, 3)}** per SOL.`;
      case "order_sequence_number": return freed
        ? "The old order's sequence number, stored bit-flipped like every bid's. The node is free, so it no longer means anything."
        : `Stored **bit-flipped** (NOT seq), as Phoenix does for every bid. Un-flipped, this order's real sequence number is **${bigStr(node.seq)}**. See "One order, decoded" below for why.`;
      case "trader_index": return freed ? "The old order's trader. Left over; ignored." : "Which trader placed this order: a node number in the traders tree, which isn't in this slice.";
      case "num_base_lots": return `${freed ? "Old size, still sitting in the bytes: " : "The size still resting: "}${fmt.int(node.lots)} lots × ${d.lot} SOL = **${fmt.sol(node.lots * d.lot)} SOL**.${freed ? " A decoder that forgot to skip the free list would count it as a real bid." : ""}`;
      case "last_valid_slot": return v === "0" ? "The slot after which the order expires. 0 means it never expires." : `The order expires after slot ${v}.`;
      default: return v === "0" ? "A clock time after which the order expires. 0 means never." : `The order expires after ${fmt.date(Number(v))} (a Unix time: seconds since 1 Jan 1970).`;
    }
  }

  /* ------------------------------------------------------------------ decode */
  /** Decode a phoenixAccount slice {hex, offset, fields, slot, address, account_len}. */
  function decode(pa) {
    const bytes = hexToBytes(pa.hex);
    const base = pa.offset || 0;
    const end = base + bytes.length;
    const has = (off, size) => off >= base && off + size <= end;
    const rd = (off, size) => readLE(bytes, off - base, size);
    const d = { bytes, base, end, slot: pa.slot, address: pa.address, accountLen: pa.account_len || null, fields: [], nodes: [], regionAt: new Array(bytes.length).fill(null) };
    if (!has(0, HEADER)) return Object.assign(d, { ok: false });
    const num = (off, size) => n2(rd(off, size));
    d.sizes = { bids: num(16, 8), asks: num(24, 8), seats: num(32, 8) };
    d.baseDecimals = num(40, 4); d.quoteDecimals = num(120, 4);
    d.baseLotSize = num(112, 8); d.quoteLotSize = num(192, 8);
    const tickAtoms = num(200, 8), rawUnits = Math.max(1, num(312, 4));
    d.tick = tickAtoms / Math.pow(10, d.quoteDecimals) / rawUnits;
    d.lot = d.baseLotSize / Math.pow(10, d.baseDecimals);
    d.quoteLotUsd = d.quoteLotSize / Math.pow(10, d.quoteDecimals);
    d.ok = true;

    const exportStatus = {};
    for (const f of pa.fields || []) {
      const m = /^bids\.node\[(\d+)\]\.left$/.exec(f.name || "");
      if (m && typeof f.explain === "string") exportStatus[m[1]] = /free list/i.test(f.explain) ? "free" : /never used/i.test(f.explain) ? "unused" : /live/i.test(f.explain) ? "live" : null;
    }

    const add = (name, off, size, type, region, explain, extra) => {
      if (!has(off, size)) return null;
      let value;
      if (type === "u64" || type === "u32") value = rd(off, size);
      else if (type === "pubkey") value = base58(bytes.subarray(off - base, off - base + size));
      else value = null;
      const f = Object.assign({ name, offset: off, size, type, region, value }, extra || {});
      f.explain = typeof explain === "function" ? explain(d, value === null ? "" : String(value), f) : explain;
      d.fields.push(f);
      for (let k = 0; k < size; k++) d.regionAt[off - base + k] = d.fields.length - 1;
      return f;
    };
    for (const [name, off, size, type, ex] of HEADER_FIELDS) add(name, off, size, type, "header", ex);
    add("header_padding", 316, HEADER - 316, "bytes", "pad", "Reserved space, all zeros, so the header can grow later without moving anything after it.");
    add("market_padding", HEADER, PADDING, "bytes", "pad", "256 more reserved bytes between the header and the market's own fields.");
    MARKET_FIELDS.forEach(([name, ex], i) => add(name, FIELDS_AT + 8 * i, 8, "u64", "fields", ex));
    if (has(BIDS_AT, TREE_PREFIX)) {
      d.root = num(BIDS_AT, 4); d.size = num(BIDS_AT + 16, 8); d.bump = num(BIDS_AT + 24, 4); d.freeHead = num(BIDS_AT + 28, 4);
      for (const [name, off, size, type, ex] of TREE_FIELDS) add("bids." + name, BIDS_AT + off, size, type, "tree", ex);
    }
    d.orderSeqNext = has(FIELDS_AT + 16, 8) ? rd(FIELDS_AT + 16, 8) : null;
    for (let k = 1; has(NODES_AT + (k - 1) * NODE, NODE); k++) {
      const at = NODES_AT + (k - 1) * NODE;
      const regs = [0, 1, 2, 3].map((r) => num(at + 4 * r, 4));
      const stored = rd(at + 24, 8);
      const node = {
        k, at, left: regs[0], right: regs[1], parent: regs[2], color: regs[3],
        price: num(at + 16, 8), stored, seq: MASK & ~stored, trader: num(at + 32, 8), lots: num(at + 40, 8),
        lastSlot: rd(at + 48, 8), lastTs: rd(at + 56, 8),
      };
      let st = d.bump !== undefined && k >= d.bump ? "unused" : exportStatus[k] || null;
      if (!st) st = node.parent === 0 && node.right === 0 && node.color === 0 && k !== d.root ? "free" : "live";
      node.status = st;
      d.nodes.push(node);
      for (const [name, off, size, type] of NODE_FIELDS) {
        add(`bids.node[${k}].${name}`, at + off, size, type, st, (dd, v) => nodeExplain(name, st, dd, node, v), { node: k, short: name });
      }
    }
    return d;
  }

  /* ------------------------------------------------------------------ account map (See) */
  function accountRegions(sizes) {
    const bidsLen = TREE_PREFIX + NODE * sizes.bids, asksLen = TREE_PREFIX + NODE * sizes.asks;
    const tradersLen = TREE_PREFIX + TRADER_NODE * sizes.seats;
    const treesEnd = BIDS_AT + bidsLen + asksLen;
    return { bidsLen, asksLen, tradersLen, treesEnd, total: treesEnd + tradersLen };
  }

  function buildMap(sizes, accountLen) {
    const R = accountRegions(sizes);
    const total = accountLen || R.total;
    const X0 = 20, W = 400;
    const sx = (b) => X0 + (b / total) * W;
    const svg = h("svg", { class: "diagram diagram-md", viewBox: "0 0 440 330", attrs: { role: "img", "aria-label": "A to-scale map of Phoenix's SOL/USDC market account, zooming from the whole account to one 64-byte order node" } });
    const g = (cls) => { const e = h("g", { class: "fade" }); if (cls) e.setAttribute("class", "fade " + cls); svg.appendChild(e); return e; };
    const seg = (parent, x, w, y, hh, cls, label, tcls) => {
      parent.appendChild(h("rect", { x, y, width: Math.max(w, 1.2), height: hh, class: cls, rx: 2 }));
      if (label) parent.appendChild(h("text", { x: x + w / 2, y: y + hh / 2 + 5, "text-anchor": "middle", class: tcls || "t-bold", text: label }));
    };
    // tier 1: whole account
    const t1 = g();
    t1.appendChild(h("text", { x: X0, y: 16, class: "t-bold", text: `The whole account: ${fmt.int(total)} bytes, to scale` }));
    const bx = sx(BIDS_AT), ax = sx(BIDS_AT + R.bidsLen), tx = sx(R.treesEnd);
    seg(t1, X0, sx(BIDS_AT) - X0, 46, 40, "box-accent");
    seg(t1, bx, ax - bx, 46, 40, "box-bid", "▲ bids", "t-bold t-bid");
    seg(t1, ax, tx - ax, 46, 40, "box-ask", "▼ asks", "t-bold t-ask");
    seg(t1, tx, X0 + W - tx, 46, 40, "box", "trader seats");
    t1.appendChild(h("text", { x: tx + (X0 + W - tx) / 2, y: 104, "text-anchor": "middle", class: "t-muted", text: `${fmt.int(sizes.seats)} seats · ${fmt.num(R.tradersLen / 1e6, 2)} MB` }));
    t1.appendChild(h("text", { x: bx + (tx - bx) / 2, y: 104, "text-anchor": "middle", class: "t-muted", text: `${fmt.int(sizes.bids)} + ${fmt.int(sizes.asks)} slots` }));
    // step 2: collector bracket (above the bar)
    const t2 = g();
    t2.appendChild(h("path", { class: "line-accent", d: `M ${X0} 41 v -7 H ${tx} v 7` }));
    t2.appendChild(h("text", { x: tx + 8, y: 39, class: "t-bold t-accent", text: `collector keeps ${fmt.int(R.treesEnd)} bytes` }));
    // step 3: zoom into the first 976 bytes
    const t3 = g();
    const zEnd = NODES_AT + NODE; // 976
    const zx = (b) => X0 + (b / zEnd) * W;
    const Z = 150;
    t3.appendChild(h("path", { class: "line line-dash", d: `M ${X0} 86 L ${X0} ${Z} M ${sx(zEnd) + 0.6} 86 L ${X0 + W} ${Z}` }));
    t3.appendChild(h("text", { x: X0 + W, y: Z - 8, "text-anchor": "end", class: "t-muted", text: `zoom: bytes 0–${zEnd - 1}` }));
    seg(t3, zx(0), zx(HEADER) - zx(0), Z, 34, "box-accent", "header · 576 bytes");
    seg(t3, zx(HEADER), zx(FIELDS_AT) - zx(HEADER), Z, 34, "box", "padding · 256", "t-muted");
    seg(t3, zx(FIELDS_AT), zx(BIDS_AT) - zx(FIELDS_AT), Z, 34, "box-accent");
    seg(t3, zx(BIDS_AT), zx(NODES_AT) - zx(BIDS_AT), Z, 34, "box");
    seg(t3, zx(NODES_AT), zx(zEnd) - zx(NODES_AT), Z, 34, "box-bid");
    const t3l = g();
    const lab = (b0, b1, y, text) => {
      const cx = (zx(b0) + zx(b1)) / 2;
      t3l.appendChild(h("path", { class: "line", d: `M ${cx} ${Z + 34} V ${y - 4} H ${cx - 6}` }));
      t3l.appendChild(h("text", { x: cx - 9, y: y + 1, "text-anchor": "end", class: "t-muted", text }));
    };
    lab(FIELDS_AT, BIDS_AT, Z + 52, "6 market fields · 48");
    lab(BIDS_AT, NODES_AT, Z + 70, "bids tree header · 32");
    lab(NODES_AT, zEnd, Z + 88, "bid node 1 · 64");
    // step 4: one node
    const t4 = g();
    const nx = (b) => X0 + (b / NODE) * W;
    const N = 268;
    t4.appendChild(h("path", { class: "line line-dash", d: `M ${zx(NODES_AT)} ${Z + 34} L ${X0} ${N} M ${zx(zEnd)} ${Z + 34} L ${X0 + W} ${N}` }));
    t4.appendChild(h("text", { x: X0 + W, y: N - 8, "text-anchor": "end", class: "t-muted", text: "zoom: one 64-byte node" }));
    const parts = [["L", 0, 4, "box"], ["R", 4, 8, "box"], ["P", 8, 12, "box"], ["C", 12, 16, "box"],
      ["price", 16, 24, "box-accent"], ["seq", 24, 32, "box-accent"], ["trader", 32, 40, "box-bid"], ["lots", 40, 48, "box-bid"], ["slot", 48, 56, "box-bid"], ["time", 56, 64, "box-bid"]];
    for (const [t, a, b, cls] of parts) seg(t4, nx(a), nx(b) - nx(a), N, 32, cls, t, "t-mono");
    t4.appendChild(h("text", { x: X0, y: N + 52, class: "t-muted", text: "links (4 × 4 B) · key (16 B) · the order (32 B)" }));
    return { svg, tiers: [t1, t2, t3, t4], labels3: t3l, R, total };
  }

  function mapSteps(sizes, R, total) {
    return [
      `The whole SOL/USDC market is **one account** of ${fmt.int(total)} bytes (about ${fmt.num(total / 1e6, 1)} MB), drawn to scale. The biggest part is the traders tree: room for ${fmt.int(sizes.seats)} [[seat|trader seats]] of 144 bytes each.`,
      `The bids and asks trees take ${fmt.int(R.bidsLen)} bytes each: room for ${fmt.int(sizes.bids)} orders a side, reserved up front. The collector keeps only the start of the account, up to the end of the asks tree: **${fmt.int(R.treesEnd)} bytes**. Seats aren't needed to rebuild the book.`,
      `The [[header]] and market fields are just the first 880 bytes, a sliver too thin to see at full scale. Zoomed in: a 576-byte header, 256 bytes of [[padding]], six 8-byte market fields, then the bids tree begins with its own 32-byte header.`,
      "Every order is one **64-byte node**: four 4-byte links that hold the tree together (left, right, parent, colour), a 16-byte key (price and sequence number), then the order itself (trader, size in lots, and two expiry fields).",
    ];
  }

  function accountMap(ctx) {
    const pa = ctx.data.active().phoenixAccount;
    const dec = pa ? decode(pa) : null;
    const sizes = dec && dec.ok ? dec.sizes : DEFAULT_SIZES;
    const len = (dec && dec.accountLen) || null;
    const m = buildMap(sizes, len);
    const steps = mapSteps(sizes, m.R, m.total);
    const show = (i) => { m.tiers.forEach((t, k) => { t.style.opacity = k === 0 || k <= i ? "1" : "0"; }); m.labels3.style.opacity = i === 2 ? "1" : "0"; };
    return ctx.ui.Figure({
      label: "Figure 8.1",
      children: ctx.ui.Stepper({ steps, stage: m.svg, render: show, interval: 3200, label: "Map of the Phoenix market account" }),
      caption: `The ${fmt.int(m.total)} bytes add up exactly: 880 bytes of header and fields, two trees of 32 + ${fmt.int(sizes.bids)} × 64 bytes, and a traders tree of 32 + ${fmt.int(sizes.seats)} × 144 bytes. Sizes are read from the real header.`,
      alt: `A bar drawn to scale shows the ${fmt.int(m.total)}-byte account: a sliver of header and market fields (880 bytes), the bids tree and the asks tree (${fmt.int(m.R.bidsLen)} bytes each), and the traders tree (${fmt.int(m.R.tradersLen)} bytes, the largest part). A bracket marks the first ${fmt.int(m.R.treesEnd)} bytes, which the collector stores. A zoom shows the first 976 bytes: header 576, padding 256, market fields 48, bids tree header 32, then bid node 1 of 64 bytes. A second zoom splits that node into left, right, parent and colour links of 4 bytes each, price and sequence number of 8 bytes each, and trader, lots, expiry slot and expiry time of 8 bytes each.`,
    });
  }

  /* ------------------------------------------------------------------ hex explorer (Try) */
  function leReading(bytes, f, base) {
    const raw = Array.from(bytes.subarray(f.offset - base, f.offset - base + f.size), hex2);
    const rev = raw.slice().reverse().join("");
    const trimmed = rev.replace(/^0+(?=.)/, "");
    return { stored: raw.join(" "), reversed: raw.slice().reverse().join(" "), hex: "0x" + trimmed };
  }

  function explorer(ctx, opts = {}) {
    const { ui } = ctx;
    const wrap = h("div", { class: "stack" });
    const pa = ctx.data.active().phoenixAccount;
    const dec = pa ? decode(pa) : null;
    if (!dec || !dec.ok) {
      wrap.append(ui.Callout({
        kind: "warn", title: "No account bytes in this dataset",
        body: "The hex explorer needs the `phoenix_account` block of an export (format v2), which holds real bytes from the Phoenix market account. The built-in data has it; a file you loaded may not. Use **Back to built-in data** on the Real books page to return.",
      }));
      return wrap;
    }
    const { bytes, base, fields } = dec;
    const perRow = opts.bytesPerRow || (document.documentElement.clientWidth < 600 ? 8 : 16);
    const gid = OBZ.util.uid("phx");
    const offDigits = Math.max(4, (base + bytes.length).toString(16).length);
    const cells = [];
    const grid = h("div", { class: "hex-grid", tabIndex: 0, attrs: { role: "grid", "aria-label": "Phoenix account bytes: use the arrow keys to move between bytes", "aria-readonly": "true" } });
    for (let r = 0; r * perRow < bytes.length; r++) {
      const row = h("div", { class: "hex-row", attrs: { role: "row" } }, h("span", { class: "hex-off", style: { width: "3.6em" }, attrs: { role: "rowheader" }, text: (base + r * perRow).toString(16).padStart(offDigits, "0") }));
      for (let c = 0; c < perRow; c++) {
        const i = r * perRow + c;
        if (i >= bytes.length) break;
        const fi = dec.regionAt[i];
        const f = fi === null ? null : fields[fi];
        const cls = f ? REGIONS[f.region].cls : "f0";
        const cell = h("span", {
          class: "hex-b " + cls + (f && f.offset - base === i ? " f-start" : ""),
          id: gid + "-" + i, dataset: { i: String(i) },
          attrs: { role: "gridcell", "aria-label": `offset ${base + i}: ${hex2(bytes[i])}${f ? ", " + f.name : ""}` },
          text: hex2(bytes[i]),
        });
        cells.push(cell); row.appendChild(cell);
      }
      grid.appendChild(row);
    }
    const detail = h("div", { class: "hex-detail", attrs: { "aria-live": "polite" } }, ui.p("**Hover or tap a byte** (or focus the grid and use the arrow keys) to see which field it belongs to, how its bytes are read, and what it means."));
    let cur = -1;
    function select(i, opts2 = {}) {
      if (i < 0 || i >= bytes.length) return;
      for (const c of grid.querySelectorAll(".is-sel, .is-field")) c.classList.remove("is-sel", "is-field");
      cur = i;
      const fi = dec.regionAt[i];
      const f = fi === null ? null : fields[fi];
      if (f) for (let k = 0; k < f.size; k++) { const c = cells[f.offset - base + k]; if (c) c.classList.add("is-field"); }
      cells[i].classList.add("is-sel");
      grid.setAttribute("aria-activedescendant", cells[i].id);
      if (opts2.scroll) cells[i].scrollIntoView({ block: "nearest", inline: "nearest" });
      clear(detail);
      detail.appendChild(h("p", { class: "hex-where" }, h("span", { class: "mono", text: `offset ${base + i} (0x${(base + i).toString(16)})` }), " · this byte is ", h("span", { class: "mono", text: `0x${hex2(bytes[i])} = ${bytes[i]}` })));
      if (!f) { detail.appendChild(ui.p("This byte isn't part of a field we label here.")); return; }
      const reg = REGIONS[f.region];
      detail.appendChild(h("p", { class: "hex-field" },
        h("span", { class: "pill " + reg.cls, text: f.node ? `node ${f.node} · ${reg.short}` : reg.label }), " ",
        h("strong", { class: "mono", text: f.name }), " ",
        h("span", { class: "pill", text: `${f.type} · ${f.size} byte${f.size > 1 ? "s" : ""}` }),
        h("span", { class: "mono fine", text: ` offsets ${f.offset}–${f.offset + f.size - 1}` })));
      if (f.type === "u64" || f.type === "u32") {
        const le = leReading(bytes, f, base);
        detail.appendChild(h("p", { class: "mono fine", text: `stored:   ${le.stored}` }));
        detail.appendChild(h("p", { class: "mono fine", text: `reversed: ${le.reversed}  →  ${le.hex}` }));
        detail.appendChild(h("p", { class: "hex-value" }, "Decoded value: ", h("strong", { class: "mono", text: bigStr(f.value) })));
        detail.appendChild(h("p", { class: "fine" }, ui.rich("[[little-endian|Little-endian]]: the smallest byte is stored first, so read the bytes right to left.")));
      } else if (f.type === "pubkey") {
        detail.appendChild(h("p", { class: "hex-value" }, "As an address: ", h("strong", { class: "mono", style: { overflowWrap: "anywhere" }, text: f.value })));
        detail.appendChild(h("p", { class: "fine", text: "32 bytes are an address (a public key). People write them in base58, a compact text form." }));
      } else {
        const sl = bytes.subarray(f.offset - base, f.offset - base + f.size);
        const zero = sl.every((b) => b === 0);
        detail.appendChild(h("p", { class: "hex-value" }, "Raw bytes: ", h("strong", { class: "mono", text: zero ? `all ${f.size} are zero` : Array.from(sl.subarray(0, 8), hex2).join(" ") + (f.size > 8 ? " …" : "") })));
      }
      detail.appendChild(ui.p(f.explain));
      if (f.node && opts2.fromGrid !== false) showNode(f.node, false);
    }
    grid.addEventListener("pointerover", (e) => { const c = e.target.closest(".hex-b"); if (c) select(+c.dataset.i); });
    grid.addEventListener("click", (e) => { const c = e.target.closest(".hex-b"); if (c) { select(+c.dataset.i); grid.focus({ preventScroll: true }); } });
    grid.addEventListener("focus", () => { if (cur < 0) select(0); });
    grid.addEventListener("keydown", (e) => {
      const map = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: perRow, ArrowUp: -perRow, PageDown: perRow * 8, PageUp: -perRow * 8 };
      if (map[e.key] !== undefined) { e.preventDefault(); select(Math.max(0, Math.min(bytes.length - 1, (cur < 0 ? 0 : cur) + map[e.key])), { scroll: true }); }
      else if (e.key === "Home") { e.preventDefault(); select(0, { scroll: true }); }
      else if (e.key === "End") { e.preventDefault(); select(bytes.length - 1, { scroll: true }); }
    });
    const jump = (off) => { select(off - base, { scroll: true }); grid.focus({ preventScroll: true }); };

    // legend: one chip per region, each jumps to its first byte
    const firstOf = {};
    fields.forEach((f) => { if (firstOf[f.region] === undefined) firstOf[f.region] = f.offset; });
    const legend = h("ul", { class: "hex-legend", attrs: { "aria-label": "Regions of the account: choose one to jump to it" } },
      Object.keys(REGIONS).filter((k) => firstOf[k] !== undefined).map((k) => h("li", null,
        h("button", { type: "button", class: "hex-chip " + REGIONS[k].cls, on: { click: () => jump(firstOf[k]) } }, REGIONS[k].label))));

    // nodes in the slice + one decoded order
    const nodeBox = h("div", { class: "readout-panel", attrs: { "aria-live": "polite" } });
    const nodeBtns = dec.nodes.map((n) => {
      const st = n.status;
      const label = st === "unused" ? `Node ${n.k} · never used`
        : st === "live" ? `Node ${n.k} · ▲ live bid · $${fmt.price(n.price * dec.tick, 3)} · ${fmt.sol(n.lots * dec.lot)} SOL`
          : `Node ${n.k} · freed · old order: $${fmt.price(n.price * dec.tick, 3)}, ${fmt.sol(n.lots * dec.lot)} SOL`;
      return h("button", { type: "button", class: "hex-chip " + REGIONS[st].cls, attrs: { "aria-pressed": "false" }, on: { click: () => { showNode(n.k, true); jump(n.at + 16); } } }, label);
    });
    function showNode(k, pressed) {
      const n = dec.nodes.find((x) => x.k === k);
      if (!n) return;
      nodeBtns.forEach((b, i) => b.setAttribute("aria-pressed", String(dec.nodes[i].k === k)));
      clear(nodeBox);
      const price = n.price * dec.tick, sol = n.lots * dec.lot;
      if (n.status === "unused") { nodeBox.appendChild(ui.p(`**Node ${k} has never been used.** Its 64 bytes are still all zeros.`)); return; }
      if (n.status === "free") {
        nodeBox.append(
          h("p", null, ui.rich(`**Node ${k} is a freed node.** An order lived here once, then left the book (filled or cancelled). Its links were cleared and the left register now points to the next freed node, **${n.left}**, but the old order's bytes are untouched: ${fmt.sol(sol)} SOL at $${fmt.price(price, 3)}.`)),
          ui.p("That is why `phoenix.py` follows the free list and drops these nodes before it builds the book. [Chapter 9](#/learn/9) shows how freed nodes get reused."));
        return;
      }
      const flipNote = dec.orderSeqNext !== null
        ? ` The market's next number is ${bigStr(dec.orderSeqNext)}, so this order is ${bigStr(dec.orderSeqNext - n.seq)} orders old.` : "";
      nodeBox.append(
        h("p", null, ui.rich(`**Node ${k}, one real resting bid, decoded:**`)),
        h("ul", null,
          h("li", null, ui.rich(`Price: ${fmt.int(n.price)} ticks × $${dec.tick} = **$${fmt.price(price, 3)}** per SOL`)),
          h("li", null, ui.rich(`Size: ${fmt.int(n.lots)} lots × ${dec.lot} SOL = **${fmt.sol(sol)} SOL** (worth ${fmt.usd(price * sol)})`)),
          h("li", null, ui.rich(`Sequence number as stored: \`${bigStr(n.stored)}\``)),
          h("li", null, ui.rich(`Un-flipped: ${U64_MAX.replace(/\B(?=(\d{3})+(?!\d))/g, ",")} − stored = **${bigStr(n.seq)}**.${flipNote}`)),
          h("li", null, ui.rich(`Expires: ${n.lastSlot === big(0) && n.lastTs === big(0) ? "never (both expiry fields are 0)" : "see the expiry fields"}`))),
        ui.p(`**Why flip?** Each tree is sorted by its key, (price, sequence number), and the tree's first node is the order that fills first. The asks tree uses normal order: lowest price first and, at one price, the smallest sequence number, which is the oldest order. The bids tree is kept in *reverse* key order, so its first node is the highest price, the best bid. But reversing the whole key also reverses the sequence numbers: at one price the *newest* bid would come first. So Phoenix stores [[bitwise-not|NOT seq]] for bids.`),
        ui.p(`A small version of the trick: store 10 − n instead of n. Orders 3 and 7 are stored as 7 and 3, so their order flips. With 64-bit numbers, NOT seq = 18,446,744,073,709,551,615 − seq. An older bid (smaller real number) gets a *larger* stored value, and in the reversed tree a larger value comes first, so at one price the oldest bid is first again. A side effect: every stored bid number is enormous, about 18.4 quintillion, with its top bit set, so its last four stored bytes are \`ff ff ff ff\`. A decoder that sorts the raw numbers itself, as \`phoenix.py\` does, sorts bids by price from high to low, then by the un-flipped number from low to high.`));
    }
    const firstLive = dec.nodes.find((n) => n.status === "live");
    if (firstLive) showNode(firstLive.k, false);

    const counts = { live: 0, free: 0, unused: 0 };
    dec.nodes.forEach((n) => counts[n.status]++);
    const src = h("p", { class: "fine" }, ui.rich(`${ctx.data.active().source === "builtin" ? "Real bytes" : "Bytes from your file"}: the first ${fmt.int(bytes.length)} bytes of the Phoenix SOL/USDC market account${dec.accountLen ? ` (of ${fmt.int(dec.accountLen)})` : ""}${dec.slot ? `, read at slot ${fmt.int(dec.slot)}` : ""}. That covers the header, the market fields, the bids tree header and its first ${dec.nodes.length} nodes: ${counts.live} live, ${counts.free} freed${counts.unused ? `, ${counts.unused} never used` : ""}.`));

    wrap.append(src, legend,
      h("div", { class: "hexview" }, h("div", { class: "hex-scroll", style: { maxHeight: "360px" } }, grid), detail),
      h("h4", { text: "Nodes in this slice" }),
      h("div", { class: "btn-row" }, nodeBtns),
      h("h4", { text: "One order, decoded" }),
      nodeBox);
    wrap.api = { select: (abs) => select(abs - base), decoded: dec };
    return wrap;
  }

  /* ------------------------------------------------------------------ your-turn check */
  function seatsCheck(ctx) {
    const pa = ctx.data.active().phoenixAccount;
    const dec = pa ? decode(pa) : null;
    if (!dec || !dec.ok) return null;
    const off = 32;
    const raw = Array.from(dec.bytes.subarray(off - dec.base, off - dec.base + 8), hex2);
    const value = dec.sizes.seats;
    const hi = parseInt(raw[1], 16), lo = parseInt(raw[0], 16);
    const simple = raw.slice(2).every((b) => b === "00");
    return ctx.ui.NumberCheck({
      question: `Your turn: the 8 bytes at offset 32 (\`num_seats\`, a [[u64]]) are \`${raw.join(" ")}\`. Read them little-endian. What number is it?`,
      answer: value, tolerance: 0.5,
      explain: simple
        ? `Reversed, the bytes are \`${raw.slice().reverse().join(" ")}\`: hex 0x${raw[1]}${raw[0]}. That is 0x${raw[1]} × 256 + 0x${raw[0]} = ${hi} × 256 + ${lo} = **${fmt.int(value)}**: room for ${fmt.int(value)} trader seats.`
        : `Read right to left, the bytes make **${fmt.int(value)}**.`,
      hint: `Reverse the order of the bytes, so the last one comes first. Only the first two bytes are not zero: the second one counts 256 times as much as the first. (Hex 0x${raw[1]} = ${hi} and 0x${raw[0]} = ${lo}.)`,
    });
  }

  OBZ.lessons = OBZ.lessons || {};
  OBZ.lessons.phoenixHex = { explorer, accountMap, decode, seatsCheck, REGIONS };

  /* ------------------------------------------------------------------ the chapter */
  OBZ.chapters.register({
    id: "solana-phoenix",
    number: 8,
    title: "Solana basics and Phoenix's account",
    summary: "On Solana, data lives in accounts anyone can read. Phoenix fits a whole market into one of them; here you read its real bytes.",
    goals: [
      "Describe accounts, programs, transactions and slots in plain words",
      "Explain how Phoenix keeps a whole market in one account, and why that makes it crankless",
      "Read a little-endian number from raw bytes",
      "Find the header, the order trees and a decoded order in a real Phoenix account",
    ],
    status: "ready",

    render(el, ctx) {
      const { ui } = ctx;

      // ---------------- Explain
      const ex = ctx.section("explain", "Lockers, keys and a 400 ms clock");
      ex.append(
        ui.prose(`
[[solana|Solana]] is a [[blockchain]]: many independent computers keep identical copies of the same data. That data lives in [[account|accounts]]. An account is a row of [[byte|bytes]] with an [[address]] and an owner. Think of a locker with a glass door: anyone can look inside, but only one [[program]] holds the key to change what's in it.

Programs are the code. They hold no data of their own. To do anything, you send a [[transaction]] that names a program, lists every account it will read or write, and asks for an [[instruction]] such as "place a bid". The program reads those accounts, changes their bytes, and either all of it happens or none of it does.

Time on Solana is counted in [[slot|slots]] of about 400 milliseconds. In each slot one [[validator]] packs transactions into a block, and every other validator runs the same programs on the same bytes, in the same order, and must get exactly the same bytes out. That is the [[determinism]] from [chapter 7](#/learn/7).`),
        ui.prose(`
[[phoenix|Phoenix]], built by [[ellipsis-labs|Ellipsis Labs]], keeps an entire market in **one account**. On SOL/USDC that account is 1,723,488 bytes (about 1.7 MB): a [[header]], the bids and the asks, each a [[red-black-tree|red-black tree]] with room for 4,096 orders, and a tree of [[seat|trader seats]] holding every trader's balances. All of that space is reserved when the market is created, so the account doesn't grow as orders arrive. Solana does let a program grow its own account, but only by up to 10 KiB per instruction (10 MiB at most), and a bigger account must hold more [[rent]]. Allocating the whole market up front avoids all that, and a fixed layout lets the program work on the bytes in place.

Because the book and the balances sit in the same place, one transaction can do the whole trade. A taker's order is matched against the book, the makers' seats are credited, and the taker's tokens move in and out of the market's [[vault|vaults]], all at once. Nothing is left over for later, which is why Phoenix is called [[crankless]]. Older Solana order books such as Serum matched first and left the results in a queue; someone had to send separate "crank" transactions to finish settling.`),
        ui.Callout({
          kind: "real", title: "One account, one queue",
          body: "Each transaction declares its accounts up front, so Solana can run two transactions side by side when neither writes an account the other uses. Every trade on this market writes the same account, so those transactions run one after another, in the order the slot's leader (the validator building that block) put them in the block. For an order book that gives one sequence everyone agrees on. But \"first\" means first in that order, which the leader and the [[priority-fee|priority fees]] people pay decide; it is not simply whoever sent their order first by the clock.",
        }),
        ui.prose(`
To see the book, this project asks any Solana [[rpc|RPC]] node for the account's bytes with one call, \`getAccountInfo\`. The answer is the bytes (in [[base64]]) and the slot they were read at. Then \`phoenix.py\` [[decoding|decodes]] them with no Phoenix library at all: it knows each field's [[offset]] and size, and reads it with Python's \`struct\` module.

Most fields are [[u64]] numbers: 8 bytes each, stored [[little-endian|little-endian]], which means the smallest byte comes first. We write bytes in [[hex]], two digits each. The bids size at offset 16 is stored as \`00 10 00 00 00 00 00 00\`. Read right to left, that is hex \`1000\`, which is 16 × 256 = **4,096**.`),
        ui.Callout({
          kind: "project", title: "In this project: phoenix.py",
          body: "`struct.unpack_from(\"<Q\", data, 16)` reads that number: `<` means little-endian and `Q` means an unsigned 8-byte integer. The collector stores only `data[:order_trees_end(header)]`, the first 525,232 bytes (header plus both trees), because the 1.2 MB of trader seats isn't needed to rebuild the book.",
        }));

      // ---------------- See
      const see = ctx.section("see", "A map of the account, to scale");
      see.append(
        ui.p("Step through the account from the outside in. Every size comes from the real header."),
        accountMap(ctx));

      // ---------------- Try
      const tr = ctx.section("try", "Explore the real bytes");
      const box = h("div");
      const checkBox = h("div");
      const mount = () => {
        clear(box).appendChild(explorer(ctx));
        const c = seatsCheck(ctx);
        clear(checkBox);
        if (c) checkBox.appendChild(c);
      };
      mount();
      ctx.onData(mount);
      tr.append(
        ui.TryIt({
          title: "Hex explorer: Phoenix SOL/USDC",
          intro: "These are real bytes from the Phoenix market account. **Hover or tap any byte** to see its field, how its bytes are read and what it means. Try the chips to jump around: find `bids_size` at offset 16, then compare a **live** node with a **freed** one, and read the decoded order below the grid.",
          children: box,
        }),
        checkBox,
        ui.Callout({
          kind: "project", title: "A bug the real bytes caught",
          body: "Version 1 of this project sorted bids by the sequence number *as stored*. Since the stored value is NOT seq, a smaller stored value means a newer order, so within one price v1 put the newest bid first. Prices and impact were unaffected (every order at one price fills at that price), but who fills first was wrong. Version 2 found it by looking at real bytes: un-flipped, bid numbers land in the same range as the asks' plain ones and below the market's next number. `phoenix.py` now un-flips them on read, and a test checks it.",
        }));
    },

    quiz: [
      {
        q: "A taker's buy on Phoenix fills against three makers. When are those makers' balances updated?",
        options: [
          { text: "Later, when someone sends a separate crank transaction", why: "That's how older books such as Serum worked. Phoenix is crankless: there is no queue of fills waiting to be processed." },
          { text: "In the same transaction, in their seats inside the market account", why: "Right. The book and every trader's seat live in one account, so matching, crediting the makers and moving the taker's tokens all happen inside the taker's transaction." },
          { text: "At the end of the slot, when validators settle all trades together", why: "Validators don't batch-settle trades. Each transaction runs to completion on its own, and its changes are part of the block." },
          { text: "Only when each maker withdraws their money", why: "Withdrawing moves tokens out of the market, but the maker's seat was already credited at the moment of the fill." },
        ],
        answer: 1,
      },
      {
        q: "Eight bytes are stored as `00 10 00 00 00 00 00 00`. Read as a little-endian u64, what number is it?",
        options: [
          { text: "16", why: "0x10 is 16, but it sits in the second byte, which counts 256 times as much as the first. 16 × 256 = 4,096." },
          { text: "4,096", why: "Little-endian puts the smallest byte first, so read right to left: hex 0x1000 = 16 × 256 = 4,096. This is bids_size in the real header." },
          { text: "4,503,599,627,370,496", why: "That is the bytes read left to right (big-endian): 0x0010000000000000. Phoenix stores its integers little-endian." },
          { text: "1,000", why: "\"10\" here is hex, not decimal, and the trailing zeros are separate bytes. Reverse the bytes and read hex 0x1000 = 4,096." },
        ],
        answer: 1,
      },
      {
        q: "Two bids rest at the same price. Bid A has sequence number 500, bid B has 900. Phoenix stores NOT seq for bids. Which stored value is larger, and which bid fills first?",
        options: [
          { text: "B's stored value is larger, and B fills first", why: "Flipping reverses the order: NOT 500 is larger than NOT 900. And B is newer (900 > 500), so it waits behind A." },
          { text: "A's stored value is larger, and A fills first", why: "Right. NOT n = 18,446,744,073,709,551,615 − n, so the smaller real number (A, the older bid) becomes the larger stored value. The bids tree is kept in reverse order, larger keys first, so A comes first, as time priority requires." },
          { text: "A's stored value is smaller, and A fills first", why: "That would be true of the plain numbers. The bit flip turns A's 500 into the larger stored value." },
          { text: "They tie at the same price, so either could fill first", why: "A price tie is broken by time: the older order (A, sequence 500) fills first. The stored key keeps that order." },
        ],
        answer: 1,
      },
    ],
  });
})(window.OBZ = window.OBZ || {});
