/* chapters/07-integers.js: Chapter 7, "Why exchanges count in integers".
 *   Explain  a blockchain primer (validators, transactions, determinism); floating point is
 *            deterministic but inexact; why exchanges use integers anyway; ticks, lots, decimals;
 *            the real Phoenix header numbers as a worked example; integer keys in orderbook.py
 *   See      a Stepper: a float-keyed book splits one price into two levels; integer ticks don't
 *            (every value shown is computed live by this browser)
 *   Try      a float lab (live expressions + "add two decimals" exact vs float), a ticks/lots
 *            converter on the real Phoenix header with exact BigInt arithmetic, a NumberCheck,
 *            and exercise 6 (exported as `exercises` for the code lab)
 *   Check    the quiz below
 */
(function (OBZ) {
  "use strict";
  const { h, fmt, clear } = OBZ.util;

  /* ------------------------------------------------------------------ exact decimal helpers (BigInt) */
  const BI = (v) => BigInt(v);
  const TEN = (n) => BI(10) ** BI(n);
  /** "104.35" -> 104350000n with decimals = 6. Returns null if not a plain decimal or too precise. */
  function parseUnits(str, decimals) {
    const m = /^\s*(\d{1,15})(?:\.(\d*))?\s*$/.exec(String(str).replace(/[$,_]/g, ""));
    if (!m) return null;
    const frac = (m[2] || "").replace(/0+$/, "");
    if (frac.length > decimals) return null;
    return BI(m[1]) * TEN(decimals) + BI((frac + "0".repeat(decimals)).slice(0, decimals) || "0");
  }
  /** 104350000n, 6 -> "104.35" (at least minDp decimals, trailing zeros trimmed beyond that). */
  function formatUnits(atoms, decimals, minDp = 0) {
    const neg = atoms < BI(0); if (neg) atoms = -atoms;
    const whole = atoms / TEN(decimals), frac = (atoms % TEN(decimals)).toString().padStart(decimals, "0");
    let f = frac.replace(/0+$/, "");
    if (f.length < minDp) f = f.padEnd(minDp, "0");
    return (neg ? "−" : "") + whole.toLocaleString("en-US") + (f ? "." + f : "");
  }
  const groupInt = (b) => b.toLocaleString("en-US");

  /** The Phoenix header values: from the real account bytes in the dataset when present. */
  const HEADER_DEFAULT = { tick: 1000, quoteDecimals: 6, lot: 1000000, baseDecimals: 9, slot: null };
  function phoenixHeader(data) {
    const pa = data.active().phoenixAccount;
    if (!pa || !Array.isArray(pa.fields)) return Object.assign({}, HEADER_DEFAULT, { fromAccount: false });
    const val = (name) => { const f = pa.fields.find((x) => x.name === name); const v = f ? Number(f.value) : NaN; return Number.isSafeInteger(v) && v > 0 ? v : null; };
    const hdr = { tick: val("tick_size_in_quote_atoms_per_base_unit"), quoteDecimals: val("quote_decimals"), lot: val("base_lot_size"), baseDecimals: val("base_decimals"), slot: pa.slot || null };
    if (Object.values(hdr).slice(0, 4).some((v) => v === null)) return Object.assign({}, HEADER_DEFAULT, { fromAccount: false });
    return Object.assign(hdr, { fromAccount: true });
  }

  /* ------------------------------------------------------------------ See: float keys split a level */
  function buildSee(ctx) {
    const { ui } = ctx;
    const alice = 104.35;            // typed by a person
    const bob = 104.2 + 0.15;        // computed by a bot: best bid + 15 cents
    const floatMap = new Map();
    floatMap.set(alice, ["Alice 25 SOL"]);
    if (floatMap.has(bob)) floatMap.get(bob).push("Bob 10 SOL"); else floatMap.set(bob, ["Bob 10 SOL"]);
    const toTicks = (p) => Math.round(p / 0.001);
    const E = OBZ.engine;
    const book = new E.OrderBook({ units: new E.Units("0.001", "0.001") });
    book.addOrder(1, E.ASK, toTicks(alice), 25000);
    book.addOrder(2, E.ASK, toTicks(bob), 10000);
    const tickLevels = book.levelPrices(E.ASK);
    const same = alice === bob;

    const svg = h("svg", { class: "diagram diagram-md", viewBox: "0 0 440 290", attrs: { role: "img", "aria-label": "The same price stored as floats makes two levels; stored as integer ticks it makes one" } });
    function card(x, y, w, cls, lines) {
      return h("g", null, h("rect", { x, y, width: w, height: 22 + 18 * (lines.length - 1), rx: 6, class: cls }),
        ...lines.map((t, i) => h("text", { x: x + 10, y: y + 16 + i * 18, class: "t-mono", style: "font-size: 12.5px", text: t })));
    }
    function draw(i) {
      clear(svg);
      svg.append(h("text", { x: 8, y: 18, class: "t-bold", text: "Two sellers, \"the same\" price" }));
      svg.append(card(8, 30, 206, i === 0 ? "box-accent" : "box", ["Alice types 104.35", "≈ " + alice.toPrecision(17)]));
      if (i >= 1) svg.append(card(226, 30, 206, i === 1 ? "box-accent" : "box", ["Bob's bot: 104.2 + 0.15", "= " + String(bob)]));
      if (i >= 2) {
        svg.append(h("text", { x: 8, y: 106, class: "t-bold t-ask", text: "Float keys" }),
          h("text", { x: 8, y: 124, class: "t-muted", text: `Map has ${floatMap.size} level${floatMap.size === 1 ? "" : "s"}` }));
        let y = 134;
        for (const [k, orders] of floatMap) { svg.append(card(8, y, 206, i === 2 ? "box-ask" : "box", ["key " + String(k), ...orders])); y += 22 + 18 * orders.length + 8; }
      }
      if (i >= 3) {
        svg.append(h("text", { x: 226, y: 106, class: "t-bold t-bid", text: "Integer ticks" }),
          h("text", { x: 226, y: 124, class: "t-muted", text: `engine has ${tickLevels.length} level${tickLevels.length === 1 ? "" : "s"}` }));
        let y = 134;
        for (const p of tickLevels) {
          const q = book.queue(E.ASK, p).map((o) => (o.orderId === 1 ? "Alice " : "Bob ") + fmt.int(o.sizeLots) + " lots");
          svg.append(card(226, y, 206, i === 3 ? "box-bid" : "box", ["key " + fmt.int(p) + " ticks", ...q])); y += 22 + 18 * q.length + 8;
        }
      }
      if (i >= 4) {
        const lv = book.level(E.ASK, tickLevels[0]);
        svg.append(h("text", { x: 226, y: 250, class: "t-mono", style: "font-size: 12.5px", text: `total ${fmt.int(lv.totalSize)} lots = ${fmt.int(lv.totalSize / 1000)} SOL` }),
          h("text", { x: 226, y: 270, class: "t-mono", style: "font-size: 12.5px", text: `${fmt.int(tickLevels[0])} ticks = $${formatUnits(BI(tickLevels[0]) * BI(1000), 6, 2)}` }));
      }
    }
    const steps = [
      `Alice types her ask: **$104.35**. As a [[floating-point|float]], 104.35 can't be stored exactly (like 1/3 in decimal), so the computer keeps the nearest binary number: ${alice.toPrecision(20)}… It prints as 104.35, so nobody notices.`,
      `Bob's bot computes its ask as the best bid plus 15 cents: 104.2 + 0.15. Your browser just worked it out: **${String(bob)}**. ${same ? "Here it happens to round to the same float as Alice's." : "Two rounding errors added up to a number one step away from Alice's."}`,
      `A book keyed by float prices puts each order under its price key. ${floatMap.size > 1 ? `The two keys are different numbers, so the map has **${floatMap.size} levels** at what a human calls one price: the depth display shows "$104.35" twice, and Bob's order sits in a queue of its own instead of behind Alice.` : "In this browser the two keys happen to match, but a different formula would split them."}`,
      `An integer engine converts each price **once**, at the edge, to a whole number of ticks: round(price ÷ $0.001). Both become **${fmt.int(toTicks(alice))} ticks**, so the real engine (running here) holds **${tickLevels.length} level**, with Alice first and Bob behind her, exactly as price-time priority says.`,
      `From then on everything is integer arithmetic: sizes are lots (25 SOL = 25,000 lots), level totals are integer sums, and every sum is exact. Dollars appear only for display: multiply integers first, divide once at the end.`,
    ];
    return ui.Figure({
      label: "Figure 7.1",
      children: ui.Stepper({ steps, stage: svg, render: draw, interval: 3000, label: "Float keys against integer ticks" }),
      caption: "Every number in this figure is computed live by your browser, using the same IEEE 754 floating point as JavaScript, Python and Rust's `f64`.",
      alt: `Alice's ask is typed as 104.35; Bob's is computed as 104.2 + 0.15, which evaluates to ${String(bob)}. A map keyed by float prices ends up with ${floatMap.size} levels. Converting both prices to integer ticks gives ${fmt.int(toTicks(alice))} ticks for both, and the engine holds ${tickLevels.length} level with Alice first and Bob second.`,
    });
  }

  /* ------------------------------------------------------------------ Try: float lab */
  function buildFloatLab(ctx) {
    const { ui } = ctx;
    let ten = 0; for (let i = 0; i < 10; i++) ten += 0.1;
    const rows = [
      { e: "0.1 + 0.2", v: String(0.1 + 0.2), note: "not 0.3" },
      { e: "0.1 + 0.2 === 0.3", v: String(0.1 + 0.2 === 0.3), note: "=== asks \"exactly equal?\": no" },
      { e: "0.1 added ten times", v: String(ten), note: "errors pile up" },
      { e: "(0.1 + 0.2) + 0.3", v: String((0.1 + 0.2) + 0.3), note: "grouping changes the answer…" },
      { e: "0.1 + (0.2 + 0.3)", v: String(0.1 + (0.2 + 0.3)), note: "…so order matters" },
      { e: "104.35 ÷ 0.001", v: String(104.35 / 0.001), note: "cutting off the decimals gives tick 104,349" },
      { e: "104,350 × 0.001", v: String(104350 * 0.001), note: "multiply by a rounded tick size: off" },
      { e: "104,350 × 1,000 ÷ 10^6", v: String(104350 * 1000 / 1e6), note: "integers first, one division: exact" },
      { e: "100,000 + 200,000 atoms", v: String(100000 + 200000), note: "= $0.30 exactly, in USDC atoms" },
    ];
    const table = ui.Table({
      caption: "Computed by your browser just now",
      columns: [{ key: "e", label: "Expression", align: "left" }, { key: "v", label: "Result", align: "left" }, { key: "note", label: "", align: "left", mono: false }],
      rows, dense: true,
    });
    const id = OBZ.util.uid("fl");
    const aIn = h("input", { type: "text", id: id + "a", class: "input mono", value: "0.1", inputMode: "decimal", style: { width: "9em" } });
    const bIn = h("input", { type: "text", id: id + "b", class: "input mono", value: "0.2", inputMode: "decimal", style: { width: "9em" } });
    const out = h("div", { class: "readout-panel", attrs: { "aria-live": "polite" } });
    function calc() {
      clear(out);
      const D = 12;
      const A = parseUnits(aIn.value, D), B = parseUnits(bIn.value, D);
      if (A === null || B === null) { out.append(ui.p("Type two positive decimals with up to 12 digits after the point, like `0.1` and `0.2`.")); return; }
      const floatSum = parseFloat(aIn.value.replace(/[$,_]/g, "")) + parseFloat(bIn.value.replace(/[$,_]/g, ""));
      const exact = formatUnits(A + B, D);
      const match = String(floatSum) === exact.replace(/,/g, "");
      out.append(
        h("p", null, h("strong", { text: "Float: " }), h("code", { text: String(floatSum) })),
        h("p", null, h("strong", { text: "Exact (integers): " }), h("code", { text: exact })),
        ui.p(match ? "These agree: this sum happens to round cleanly. Try 0.1 + 0.7, or 1.1 + 2.2." : "They differ in the last digits. The exact answer was computed by scaling both numbers to whole units (like ticks), adding the integers, and putting the decimal point back."));
    }
    aIn.addEventListener("input", calc); bIn.addEventListener("input", calc);
    calc();
    return h("div", { class: "stack" }, table,
      h("div", { class: "btn-row" },
        h("label", { attrs: { for: id + "a" } }, "a = "), aIn,
        h("label", { attrs: { for: id + "b" } }, "b = "), bIn),
      out);
  }

  /* ------------------------------------------------------------------ Try: ticks/lots converter */
  function buildConverter(ctx) {
    const { ui, data } = ctx;
    const box = h("div", { class: "stack" });
    function render() {
      const H = phoenixHeader(data);
      const tickUsd = formatUnits(BI(H.tick), H.quoteDecimals);
      const lotSol = formatUnits(BI(H.lot), H.baseDecimals);
      const ids = OBZ.util.uid("cv");
      const mk = (suffix, value, label) => {
        const input = h("input", { type: "text", id: ids + suffix, class: "input mono", value, inputMode: "decimal", autocomplete: "off", style: { width: "100%" } });
        return { input, row: h("div", { class: "stack", style: { gap: "4px" } }, h("label", { attrs: { for: ids + suffix } }, label), input) };
      };
      const ticks = mk("t", "104350", "Price in ticks (integer)");
      const usdF = mk("u", "104.35", "Price in $ per SOL");
      const lots = mk("l", "25000", "Size in lots (integer)");
      const sol = mk("s", "25", "Size in SOL");
      const msgP = h("p", { class: "fine", attrs: { "aria-live": "polite" } });
      const msgS = h("p", { class: "fine", attrs: { "aria-live": "polite" } });
      const out = h("div", { class: "readout-panel", attrs: { "aria-live": "polite" } });
      const tickAtoms = BI(H.tick), lotAtoms = BI(H.lot);

      function current() {
        const t = /^\s*\d{1,15}\s*$/.test(ticks.input.value) ? BI(ticks.input.value.trim()) : null;
        const l = /^\s*\d{1,15}\s*$/.test(lots.input.value) ? BI(lots.input.value.trim()) : null;
        return { t, l };
      }
      function summary() {
        clear(out);
        const { t, l } = current();
        if (t === null || l === null) { out.append(ui.p("Enter whole numbers of ticks and lots to see the order's value.")); return; }
        // value in quote atoms = ticks × tickAtoms (quote atoms per SOL) × lots × lotAtoms (lamports) ÷ 10^baseDecimals
        const num = t * tickAtoms * l * lotAtoms, den = TEN(H.baseDecimals);
        const atoms = num / den, rem = num % den;
        out.append(
          ui.p(`**${groupInt(l)} lots at ${groupInt(t)} ticks** = ${formatUnits(l * lotAtoms, H.baseDecimals)} SOL at $${formatUnits(t * tickAtoms, H.quoteDecimals, 2)}`),
          ui.p(`Value: ${groupInt(t)} × ${groupInt(tickAtoms)} × ${groupInt(l)} × ${groupInt(lotAtoms)} ÷ 10^${H.baseDecimals} = **${groupInt(atoms)} USDC atoms = $${formatUnits(atoms, H.quoteDecimals, 2)}**${rem ? " (plus a fraction of an atom)" : ""}`),
          H.tick * H.lot === Math.pow(10, H.baseDecimals) ? ui.p("On this market one lot at one tick is worth exactly one USDC atom, so the value in atoms is simply ticks × lots.") : null);
      }
      function fromTicks() {
        const { t } = current();
        if (t === null) { msgP.textContent = "Ticks must be a whole number (that's the point)."; summary(); return; }
        usdF.input.value = formatUnits(t * tickAtoms, H.quoteDecimals, 2);
        msgP.textContent = `${groupInt(t)} × ${groupInt(tickAtoms)} ÷ 10^${H.quoteDecimals} = $${usdF.input.value}`;
        summary();
      }
      function fromUsd() {
        const atoms = parseUnits(usdF.input.value, H.quoteDecimals);
        if (atoms === null) { msgP.textContent = `Type a dollar price with at most ${H.quoteDecimals} decimals.`; return; }
        const t = atoms / tickAtoms, rem = atoms % tickAtoms;
        if (rem) {
          msgP.textContent = `$${formatUnits(atoms, H.quoteDecimals)} is between two ticks: ${groupInt(t)} ($${formatUnits(t * tickAtoms, H.quoteDecimals, 2)}) and ${groupInt(t + BI(1))} ($${formatUnits((t + BI(1)) * tickAtoms, H.quoteDecimals, 2)}). Prices must be whole ticks, so the market won't accept it.`;
          ticks.input.value = "";
        } else {
          ticks.input.value = t.toString();
          msgP.textContent = `${formatUnits(atoms, H.quoteDecimals)} × 10^${H.quoteDecimals} ÷ ${groupInt(tickAtoms)} = ${groupInt(t)} ticks, exactly.`;
        }
        summary();
      }
      function fromLots() {
        const { l } = current();
        if (l === null) { msgS.textContent = "Lots must be a whole number."; summary(); return; }
        sol.input.value = formatUnits(l * lotAtoms, H.baseDecimals);
        msgS.textContent = `${groupInt(l)} × ${groupInt(lotAtoms)} ÷ 10^${H.baseDecimals} = ${sol.input.value} SOL`;
        summary();
      }
      function fromSol() {
        const atoms = parseUnits(sol.input.value, H.baseDecimals);
        if (atoms === null) { msgS.textContent = `Type a SOL amount with at most ${H.baseDecimals} decimals.`; return; }
        const l = atoms / lotAtoms, rem = atoms % lotAtoms;
        if (rem) { msgS.textContent = `${formatUnits(atoms, H.baseDecimals)} SOL isn't a whole number of lots (1 lot = ${lotSol} SOL): it is between ${groupInt(l)} and ${groupInt(l + BI(1))} lots.`; lots.input.value = ""; }
        else { lots.input.value = l.toString(); msgS.textContent = `${formatUnits(atoms, H.baseDecimals)} SOL = ${groupInt(atoms)} lamports ÷ ${groupInt(lotAtoms)} = ${groupInt(l)} lots, exactly.`; }
        summary();
      }
      ticks.input.addEventListener("input", fromTicks); usdF.input.addEventListener("input", fromUsd);
      lots.input.addEventListener("input", fromLots); sol.input.addEventListener("input", fromSol);

      clear(box).append(
        ui.p(H.fromAccount
          ? `Header values read from the real Phoenix SOL/USDC account bytes in this dataset${H.slot ? ` (slot ${fmt.int(H.slot)})` : ""}: tick = ${groupInt(BI(H.tick))} quote atoms per SOL, quote decimals ${H.quoteDecimals}, base lot = ${groupInt(BI(H.lot))} lamports, base decimals ${H.baseDecimals}.`
          : `Phoenix SOL/USDC header values: tick = ${groupInt(BI(H.tick))} quote atoms per SOL, quote decimals ${H.quoteDecimals}, base lot = ${groupInt(BI(H.lot))} lamports, base decimals ${H.baseDecimals}.`),
        h("p", { class: "formula" }, `1 tick = ${groupInt(BI(H.tick))} ÷ 10^${H.quoteDecimals} = $${tickUsd} per SOL`),
        h("p", { class: "formula" }, `1 lot = ${groupInt(BI(H.lot))} ÷ 10^${H.baseDecimals} = ${lotSol} SOL`),
        h("div", { class: "grid-2" },
          h("div", { class: "card stack" }, ticks.row, usdF.row, msgP),
          h("div", { class: "card stack" }, lots.row, sol.row, msgS)),
        out);
      fromTicks(); fromLots();
    }
    render();
    ctx.onData(render);
    return box;
  }

  /* ------------------------------------------------------------------ exercise 6 */
  const EX_TICKS = {
    id: "ch7-ticks", title: "Exercise 6 · Ticks and lots", level: "easy",
    brief: `Convert Phoenix's integers into dollars and SOL, and back, using the header's numbers. Write:

- \`ticksToUsd(ticks, tickAtoms, quoteDecimals)\`: the price in dollars per SOL;
- \`lotsToSol(lots, lotAtoms, baseDecimals)\`: the size in SOL;
- \`usdToTicks(usd, tickAtoms, quoteDecimals)\`: the nearest whole number of ticks for a dollar price.

On the real market \`tickAtoms\` = 1,000 with \`quoteDecimals\` = 6, and \`lotAtoms\` = 1,000,000 with \`baseDecimals\` = 9. The tests compare with \`===\`, so the order of operations matters: try \`104350 * 0.001\` in your head first. This is what \`phoenix.py\` and \`snapshot.py\` do (with exact decimals).`,
    starter: [
      "// price in $ per SOL = ticks × (quote atoms per tick) ÷ 10^quoteDecimals",
      "function ticksToUsd(ticks, tickAtoms, quoteDecimals) {",
      "  return 0; // TODO",
      "}",
      "",
      "// size in SOL = lots × (lamports per lot) ÷ 10^baseDecimals",
      "function lotsToSol(lots, lotAtoms, baseDecimals) {",
      "  return 0; // TODO",
      "}",
      "",
      "// the nearest whole number of ticks for a dollar price",
      "function usdToTicks(usd, tickAtoms, quoteDecimals) {",
      "  return 0; // TODO",
      "}",
    ].join("\n"),
    exports: ["ticksToUsd", "lotsToSol", "usdToTicks"],
    tests: [
      { name: "Phoenix's best ask: 104,350 ticks is exactly $104.35", code: "eq(A.ticksToUsd(104350, 1000, 6), 104.35);" },
      { name: "25,000 lots is exactly 25 SOL", code: "eq(A.lotsToSol(25000, 1000000, 9), 25);" },
      { name: "70,798 lots is exactly 70.798 SOL", code: "eq(A.lotsToSol(70798, 1000000, 9), 70.798);" },
      { name: "$104.35 converts back to 104,350 ticks", code: "eq(A.usdToTicks(104.35, 1000, 6), 104350);" },
      { name: "rounds to the nearest tick instead of chopping: $1.005 is 1,005 ticks", code: "eq(A.usdToTicks(1.005, 1000, 6), 1005);" },
      { name: "the tick count is always a whole number", code: "const t = A.usdToTicks(104.3501, 1000, 6);\nassert(Number.isInteger(t), 'expected an integer, got ' + t);\neq(t, 104350);" },
      { name: "other markets work too", code: "eq(A.ticksToUsd(12345, 10, 4), 12.345, 'ticksToUsd(12345, 10, 4)');\neq(A.lotsToSol(7, 100000000, 9), 0.7, 'lotsToSol(7, 1e8, 9)');" },
    ],
    hints: [
      "`10 ** 6` is 1,000,000 in JavaScript. One tick is `tickAtoms / 10 ** quoteDecimals` dollars, but don't compute that first: 0.001 can't be stored exactly, and multiplying by it drags the error along.",
      "Multiply the integers first, then divide once: `ticks * tickAtoms / 10 ** quoteDecimals`. A single division of exact integers gives the closest possible float. Same shape for lots.",
      "For the way back, turn dollars into quote atoms, divide by atoms per tick, and **round**: `Math.round(usd * 10 ** quoteDecimals / tickAtoms)`. `Math.floor` would turn 1,004.9999999999999 into 1,004.",
    ],
    solution: [
      "function ticksToUsd(ticks, tickAtoms, quoteDecimals) {",
      "  return ticks * tickAtoms / 10 ** quoteDecimals;   // integers first, one division",
      "}",
      "",
      "function lotsToSol(lots, lotAtoms, baseDecimals) {",
      "  return lots * lotAtoms / 10 ** baseDecimals;",
      "}",
      "",
      "function usdToTicks(usd, tickAtoms, quoteDecimals) {",
      "  return Math.round(usd * 10 ** quoteDecimals / tickAtoms); // nearest tick, never chopped",
      "}",
    ].join("\n"),
  };

  /* ------------------------------------------------------------------ the chapter */
  OBZ.chapters.register({
    id: "integers",
    number: 7,
    title: "Why exchanges count in integers",
    summary: "Money has to add up to the last cent, and about a thousand validators must agree on every fill, so on-chain exchanges count in whole ticks and lots instead of decimals. Learn why, and convert them yourself.",
    goals: [
      "Explain what a validator and a transaction are, and why every validator must get bit-for-bit the same result",
      "Show, with live examples, how floating point rounds, and why that matters for money and for price keys",
      "Convert ticks and lots to dollars and SOL with Phoenix's real header numbers",
      "Say why the engine keys price levels by integer ticks, not float prices",
    ],
    status: "ready",
    exercises: [EX_TICKS],

    render(el, ctx) {
      const { ui } = ctx;

      // ---------------- Explain
      const ex = ctx.section("explain", "Exact answers, on every computer");
      ex.append(
        ui.prose(`
**A quick primer.** A [[blockchain]] is a shared computer that many independent machines run together, so no single company controls it. Each of those machines is a [[validator]]; [[solana|Solana]], the blockchain [[phoenix|Phoenix]] lives on, has about a thousand. To do something on it, such as place an order, you send a [[transaction]]: a signed request that every validator runs. They must all reach exactly the same result, or they can't agree on who owns what (that agreement is called [[consensus]]). [Chapter 8](#/learn/8) looks at how Solana stores its data; this chapter is about the arithmetic.

So a [[program]] like Phoenix must be deterministic: same program, same bytes, same order of transactions, same result, to the last digit. That property is [[determinism]].`),
        ui.prose(`
The usual way computers store decimals, [[floating-point|floating point]], is fast but approximate. In binary, 0.1 never ends, like 1/3 = 0.333… in decimal, so the computer stores the nearest number it can. That is why 0.1 + 0.2 gives 0.30000000000000004. Surprisingly, it is the *same* wrong answer on every computer: a standard called IEEE 754 fixes the result of each basic step (add, subtract, multiply, divide), and Solana even runs floats in software so every validator gets the same bits. Floats are allowed on Solana; they are slow and inexact. Machines can disagree only when the order of the steps isn't pinned down, for example when a compiler takes shortcuts or a big sum is split across threads. That risk is why some blockchains ban floats outright.

So why do exchanges avoid them? Four reasons:

- **Money must be exact.** Every smallest unit of a token has to be accounted for. [[rounding-error|Rounding errors]] of a millionth of a cent per trade add up, and somebody would have to own them.
- **Token amounts are whole numbers anyway.** SOL has 9 [[decimals]] (1 SOL = 1,000,000,000 [[lamport|lamports]]) and USDC has 6. Balances on Solana are whole numbers of these smallest units, called **atoms**.
- **A price must be a reliable key.** A price typed as 104.35 and one computed as 104.2 + 0.15 should be the same price. As floats they aren't, as the figure below shows.
- **Integer maths is cheap.** Every step a Solana program takes costs compute, and software floats cost more.`),
        ui.prose(`
[[integer|Integers]] avoid all of this: 3 + 4 is exactly 7. So exchanges count in whole units. A price is a whole number of [[tick|ticks]] and a size a whole number of [[lot|lots]]; the market's [[tick-size|tick size]] and [[lot-size|lot size]] say what one of each is worth. In a pair like SOL/USDC, SOL is the **base** token (the thing being bought and sold) and USDC the **quote** token (the money prices are counted in).`),
        h("p", { class: "formula" }, "price in $ = ticks × tick size"),
        h("p", { class: "formula" }, "size in SOL = lots × lot size"),
        ui.Callout({
          kind: "tip", title: "Worked example: the real Phoenix header",
          body: `Phoenix's SOL/USDC market account starts with a 576-byte header ([chapter 8](#/learn/8) shows the bytes). Three of its numbers define the units. (A *quote atom* is USDC's smallest unit, a millionth of a dollar; a *base unit* is one whole SOL.)

- \`tick_size_in_quote_atoms_per_base_unit\` = **1,000**, with \`quote_decimals\` = 6: one tick is 1,000 ÷ 10⁶ = **$0.001** per SOL.
- \`base_lot_size\` = **1,000,000** lamports, with \`base_decimals\` = 9: one lot is 1,000,000 ÷ 10⁹ = **0.001 SOL**.
- So the best ask at 04:31 UTC on 18 Oct 2026, stored as **104,350 ticks** for **25,000 lots**, means 25 SOL at $104.350.

A neat consequence: one lot at one tick is 0.001 SOL × $0.001 = $0.000001, exactly one USDC atom. So ticks × lots is the order's value in atoms, an integer: 104,350 × 25,000 = 2,608,750,000 atoms = **$2,608.75**.`,
        }),
        ui.Callout({
          kind: "project", title: "Integer keys in orderbook.py",
          body: `The project's engine works the same way: prices are integer ticks and sizes integer lots from end to end, and \`snapshot.py\` converts to dollars only at the edges (with exact decimals). It matters for the [[sorted-map|sorted map]] of levels too. With float keys, a price typed as 104.35 and one computed as 104.2 + 0.15 would be two different keys: two levels at "the same" price, with the queue split and time priority broken. The figure below shows it happening in your browser.`,
        }));

      // ---------------- See
      const see = ctx.section("see", "One price, two levels");
      see.append(ui.p("Two sellers ask for what looks like the same price. Step through what a float-keyed book and an integer-keyed book do with them."), buildSee(ctx));

      // ---------------- Try
      const tr = ctx.section("try", "Break floats, then convert exactly");
      const nc = { t: 89036, l: 61295 };
      tr.append(
        ui.TryIt({
          title: "Float lab",
          intro: "Each result below was computed by your browser when the page loaded. Then add two decimals of your own: the float answer against the exact one, done with integers.",
          children: buildFloatLab(ctx),
        }),
        ui.TryIt({
          title: "Ticks and lots converter",
          intro: "Type in any box and the other one updates, using exact integer arithmetic (JavaScript's BigInt), never floats. Try a price that isn't a whole tick, like $104.3505, or a size of 0.0005 SOL.",
          children: buildConverter(ctx),
        }),
        ui.NumberCheck({
          question: `Your turn: a real Phoenix bid at 04:31 UTC rested at **${fmt.int(nc.t)} ticks** for **${fmt.int(nc.l)} lots**. How many dollars was it worth? (Two decimals.)`,
          answer: nc.t * nc.l / 1e6, tolerance: 0.006, unit: "dollars",
          explain: `${fmt.int(nc.t)} × ${fmt.int(nc.l)} = ${fmt.int(nc.t * nc.l)} USDC atoms (one lot at one tick is one atom), and ÷ 1,000,000 = **$${formatUnits(BI(nc.t) * BI(nc.l), 6, 2)}**. Equivalently: $89.036 × 61.295 SOL.`,
          hint: "Convert first: ticks × $0.001 gives the price, lots × 0.001 gives the SOL. Multiply the two. (Or multiply ticks × lots to get USDC atoms and divide by 1,000,000.)",
        }),
        ui.CodeExercise(EX_TICKS),
        ui.p("More practice: chapter 6's exercises build the engine these integers flow through, and the [code lab](#/play/code) has every exercise in one place."));
    },

    quiz: [
      {
        q: "Why does an on-chain matching engine like Phoenix store prices and sizes as integers rather than floats?",
        options: [
          { text: "Floats give different answers on different validators, so they could never agree", why: "Not quite. IEEE 754 fixes the result of each basic float step, and Solana runs floats in software so every validator gets the same bits. Disagreement is a risk only where the order of steps isn't pinned down. The bigger problem is that floats are inexact." },
          { text: "Money must be exact to the last atom and a price must equal itself; floats round, integers don't", why: "Right. 0.1 + 0.2 is 0.30000000000000004 on every computer: consistent, but wrong for money. Token balances are whole numbers of atoms anyway, integer prices make reliable keys, and integer maths costs less compute." },
          { text: "Floats can't store numbers as large as the prices and sizes a market needs", why: "Floats can store numbers up to about 10³⁰⁸. The trouble is precision, not size: most decimals like 0.1 or 104.35 can't be stored exactly." },
          { text: "Integers take up less space in the account than floats of the same precision", why: "A 64-bit integer and a 64-bit float take the same 8 bytes. Space isn't the reason." },
        ],
        answer: 1,
      },
      {
        q: "A market's tick size is $0.001. An order's price is stored as **104,350**. What is the price?",
        options: [
          { text: "$104,350", why: "That reads the stored integer as dollars. It counts ticks, and each tick is a tenth of a cent: 104,350 × $0.001 = $104.35." },
          { text: "$104.35", why: "104,350 × $0.001 = $104.350. On Phoenix that is 104,350 × 1,000 quote atoms ÷ 10⁶." },
          { text: "$10.435", why: "That divides by 10,000. One tick is $0.001, so divide by 1,000: $104.35." },
          { text: "$1,043.50", why: "That divides by 100, as if a tick were one cent. Here a tick is a tenth of a cent." },
        ],
        answer: 1,
      },
      {
        q: "An engine keys its price levels by float prices. Alice's ask is 104.35; Bob's bot sends 104.2 + 0.15, which a computer evaluates as 104.35000000000001. What happens?",
        options: [
          { text: "They join one level, with Alice's order first in the queue", why: "That's what should happen, and what an integer-keyed engine does. With float keys, 104.35 and 104.35000000000001 are different numbers, so they're different keys." },
          { text: "They form two levels, so the queue splits and time priority is lost", why: "A map treats the two floats as different keys, so the engine makes two levels at what a human calls one price. The depth display splits and Bob's order may be matched in the wrong order. Integer ticks avoid this: both round to 104,350." },
          { text: "The program crashes when the two keys collide", why: "Nothing crashes, which is what makes it dangerous: the book quietly fragments." },
          { text: "Bob's order is rejected as a duplicate of Alice's price", why: "Engines happily accept many orders at one price; they join the same queue. The problem is that these two prices don't compare equal." },
        ],
        answer: 1,
      },
    ],
  });
})(window.OBZ = window.OBZ || {});
