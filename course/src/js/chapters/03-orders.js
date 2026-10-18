/* chapters/03-orders.js: Chapter 3, "Orders, makers, takers".
 *   Explain  limit vs market orders, makers vs takers, the maker's price, why a book never
 *            crosses, GTC vs IOC, and a price-protection teaser
 *   See      three orders arrive at a tiny book (Stepper, every state computed by OBZ.engine)
 *   Try      an order ticket on the real Phoenix book: place limit (GTC / IOC) or market orders,
 *            see maker / taker, fills at the maker's price, and "why didn't it trade?"
 *   Check    the quiz below
 */
(function (OBZ) {
  "use strict";
  const { h, clear, fmt } = OBZ.util;
  const { BID, ASK, OrderBook, Units } = OBZ.engine;

  /* ------------------------------------------------------------------ the See figure */
  // A tiny book in cents and whole SOL. Every state below comes from the real engine.
  const UNITS = new Units("0.01", "1");
  const NAMES = { 1: "Ann", 2: "Raj", 3: "Kim", 4: "Lou", 10: "You", 11: "Ned" };
  const SEED = [[1, ASK, 10410, 3], [2, ASK, 10400, 2], [3, BID, 10390, 4], [4, BID, 10380, 1]];
  // The three incoming orders, in arrival order.
  const OPS = [
    { kind: "limit", id: 10, side: BID, price: 10395, size: 2, who: "You", label: "You · limit buy 2 SOL at $103.95" },
    { kind: "market", side: BID, size: 3, who: "Mia", label: "Mia · market buy 3 SOL" },
    { kind: "limit", id: 11, side: ASK, price: 10390, size: 7, who: "Ned", label: "Ned · limit sell 7 SOL at $103.90" },
  ];
  // Each step: how many OPS have run, and (optionally) the op that is arriving right now.
  const SCRIPT = [
    { done: 0 },
    { done: 1, rested: 10 },
    { done: 1, arriving: 1 },
    { done: 2 },
    { done: 2, arriving: 2 },
    { done: 3, rested: 11, best: true },
  ];
  const STEPS = [
    "A small book. Two sellers rest on the ask side (Ann and Raj), two buyers on the bid side (Kim and Lou). The best ask is $104.00 and the best bid is $103.90.",
    "**You** send a limit buy: 2 SOL at $103.95. The cheapest seller wants $104.00, more than you'll pay, so nothing trades. Your order **rests** as the new best bid. You are a **maker**.",
    "**Mia** sends a market buy for 3 SOL. It trades at once with the best asks: 2 SOL from Raj at **$104.00**, then 1 SOL from Ann at **$104.10**. Mia is the **taker**; each fill is at the maker's price.",
    "Raj's order is used up and leaves the book. Ann keeps 2 SOL. The best ask is now $104.10.",
    "**Ned** sends a limit sell: 7 SOL at $103.90 or better. That is at or below the best bid, so it **crosses the spread**. First it takes your 2 SOL at **$103.95**, which is better than Ned asked for, then Kim's 4 SOL at $103.90.",
    "Ned still has 1 SOL left, and the next bid (Lou, $103.80) is below his limit. So the last 1 SOL **rests** as an ask at $103.90: Ned was a taker for 6 SOL and is a maker for 1. Best bid $103.80 < best ask $103.90: the book is not crossed.",
  ];

  function bookAfter(n) {
    const book = new OrderBook({ units: UNITS });
    for (const [id, side, p, s] of SEED) book.addOrder(id, side, p, s);
    for (let i = 0; i < n; i++) runOp(book, OPS[i]);
    return book;
  }
  function runOp(book, op) {
    return op.kind === "limit" ? book.addOrder(op.id, op.side, op.price, op.size) : book.marketOrder(op.side, op.size, null);
  }

  function drawSee(svg, i) {
    const st = SCRIPT[i];
    const book = bookAfter(st.done);
    const op = st.arriving !== undefined ? OPS[st.arriving] : null;
    // Which makers the arriving order will hit (same loop as the engine, nothing mutated).
    const hits = {};
    let rest = 0;
    if (op) {
      const dm = book.dryMatch(op.side, op.size, op.kind === "limit" ? op.price : null);
      dm.fills.forEach((f, n) => { hits[f.makerOrderId] = Object.assign({ n: n + 1 }, f); });
      rest = op.kind === "limit" ? dm.unfilledLots : 0;
    }
    clear(svg);
    // Incoming card
    const shown = op || (st.rested ? OPS.find((o) => o.id === st.rested) : null);
    svg.appendChild(h("rect", { class: shown ? "box-accent" : "box", x: 10, y: 8, width: 420, height: 40, rx: 8 }));
    svg.appendChild(h("text", { x: 22, y: 33, class: "t-bold", text: shown ? (op ? "Arriving → " : "Arrived → ") + shown.label : "Waiting for orders…" }));

    // Ladder rows: asks (worst at top) then bids (best at top)
    const rows = [];
    const asks = book.levelPrices(ASK).slice().reverse();
    for (const p of asks) for (const q of book.queue(ASK, p)) rows.push({ side: ASK, p, q });
    const midIndex = rows.length;
    for (const p of book.levelPrices(BID)) for (const q of book.queue(BID, p)) rows.push({ side: BID, p, q });
    const RH = 34, X = 30, W = 250;
    let y = 66;
    const bestAsk = book.bestAsk(), bestBid = book.bestBid();
    rows.forEach((r, k) => {
      if (k === midIndex) {
        svg.appendChild(h("line", { class: "line line-dash", x1: X - 10, x2: X + W + 10, y1: y + 4, y2: y + 4 }));
        y += 10;
      }
      const ask = r.side === ASK;
      const id = r.q.orderId;
      const isNew = st.rested === id;
      const hit = hits[id];
      const g = h("g", { class: hit || isNew || !op ? null : "dim" });
      g.appendChild(h("rect", { class: ask ? "box-ask" : "box-bid", x: X, y, width: W, height: RH - 6, rx: 6, style: isNew ? "stroke: var(--mine); stroke-width: 3" : null }));
      g.appendChild(h("text", { x: X + 10, y: y + 19, class: "t-mono t-bold " + (ask ? "t-ask" : "t-bid"), text: ask ? "▼ ASK" : "▲ BID" }));
      g.appendChild(h("text", { x: X + 108, y: y + 19, "text-anchor": "middle", class: "t-mono t-bold", text: "$" + UNITS.price(r.p).toFixed(2) }));
      g.appendChild(h("text", { x: X + 160, y: y + 19, class: "t-bold", text: NAMES[id] || "?" }));
      g.appendChild(h("text", { x: X + W - 10, y: y + 19, "text-anchor": "end", class: "t-mono", text: r.q.sizeLots + " SOL" }));
      svg.appendChild(g);
      // Annotations to the right of the row
      const ax = X + W + 12;
      if (hit) {
        const used = hit.sizeLots === r.q.sizeLots;
        svg.appendChild(h("text", { x: ax, y: y + 13, class: "t-bold t-accent", text: `◀ fill ${hit.n}: ${hit.sizeLots} @ $${UNITS.price(hit.priceTicks).toFixed(2)}` }));
        svg.appendChild(h("text", { x: ax, y: y + 28, class: "t-muted", text: used ? "used up" : `${r.q.sizeLots - hit.sizeLots} left` }));
      } else if (isNew) {
        svg.appendChild(h("text", { x: ax, y: y + 13, class: "t-bold", style: "fill: var(--mine)", text: "◀ rests: maker" }));
        svg.appendChild(h("text", { x: ax, y: y + 28, class: "t-muted", text: "new " + (ask ? "best ask" : "best bid") }));
      } else if (!op && st.best && (r.p === bestAsk || r.p === bestBid) && (k === midIndex - 1 || k === midIndex)) {
        svg.appendChild(h("text", { x: ax, y: y + 19, class: "t-bold " + (ask ? "t-ask" : "t-bid"), text: ask ? "best ask" : "best bid" }));
      }
      y += RH;
    });
    if (op && rest > 0) {
      svg.appendChild(h("text", { x: X, y: y + 16, class: "t-bold", style: "fill: var(--mine)", text: `${rest} SOL can't trade at $${UNITS.price(op.price).toFixed(2)} or better → it will rest` }));
    }
  }

  /* ------------------------------------------------------------------ the Try widget */
  const USER_BASE = 1000000;

  function buildTry(ctx) {
    const { ui, data } = ctx;
    let venue, book, units, startBook, nextId, mine, digits;
    const state = { side: BID, type: "limit", tif: "gtc", protect: false, guess: null };

    // ---- controls
    const sideSeg = ui.Segmented({ label: "Side", value: BID, options: [{ value: BID, label: "▲ Buy" }, { value: ASK, label: "▼ Sell" }], onChange: (v) => { state.side = v; sync(); } });
    const typeSeg = ui.Segmented({ label: "Order type", value: "limit", options: [{ value: "limit", label: "Limit" }, { value: "market", label: "Market" }], onChange: (v) => { state.type = v; sync(); } });
    const tifSeg = ui.Segmented({ label: "Time in force", small: true, value: "gtc", options: [{ value: "gtc", label: "GTC: rest the rest" }, { value: "ioc", label: "IOC: cancel the rest" }], onChange: (v) => { state.tif = v; } });
    const protSeg = ui.Segmented({ label: "Price protection", small: true, value: "off", options: [{ value: "off", label: "No limit" }, { value: "on", label: "Stop 10% from the mid" }], onChange: (v) => { state.protect = v === "on"; } });
    const guessSeg = ui.Segmented({ label: "Your prediction", small: true, value: null, options: [{ value: "maker", label: "Maker" }, { value: "taker", label: "Taker" }, { value: "both", label: "Both" }, { value: "none", label: "Nothing trades" }], onChange: (v) => { state.guess = v; } });

    const priceId = OBZ.util.uid("px"), sizeId = OBZ.util.uid("sz");
    const priceIn = h("input", { type: "number", id: priceId, class: "input mono", inputMode: "decimal", autocomplete: "off", step: "0.001", min: "0" });
    const sizeIn = h("input", { type: "number", id: sizeId, class: "input mono", inputMode: "decimal", autocomplete: "off", step: "0.001", min: "0", max: "1000", value: "1" });
    const quick = h("div", { class: "btn-row" });
    const priceRow = h("div", { class: "stack" },
      h("label", { attrs: { for: priceId }, class: "fine", text: "Limit price ($ per SOL)" }), priceIn, quick);
    const sizeRow = h("div", { class: "stack" }, h("label", { attrs: { for: sizeId }, class: "fine", text: "Size (SOL, up to 1,000)" }), sizeIn);
    const tifRow = h("div", { class: "stack" }, h("p", { class: "fine", text: "Time in force (what happens to the part that can't trade now)" }), tifSeg);
    const protRow = h("div", { class: "stack" }, h("p", { class: "fine", text: "Price protection" }), protSeg);
    const sendBtn = ui.Button({ label: "Send buy order", variant: "buy", onClick: send });
    const resetBtn = ui.Button({ label: "Reset the book", variant: "ghost", onClick: () => { load(); showIntro(); } });
    const formMsg = h("p", { class: "fine", attrs: { "aria-live": "polite" } });

    // ---- views
    const source = h("p", { class: "fine" });
    const ladderBox = h("div");
    let ladder = null;
    const result = h("div", { class: "readout-panel", attrs: { "aria-live": "polite" } });
    const fillsBox = h("div");
    const mineBox = h("div", { class: "stack" });
    const checkBox = h("div");

    function load() {
      venue = data.venue("phoenix") ? "phoenix" : data.venues()[0];
      const snap = data.snapshot(venue);
      book = snap.toBook();
      startBook = snap.toBook();
      units = snap.units;
      digits = Math.max(2, Math.min(4, Math.round(-Math.log10(snap.tickSize))));
      let maxId = 0;
      for (const id of book.orders.keys()) if (id > maxId) maxId = id;
      nextId = Math.max(USER_BASE, maxId + 1);
      mine = [];
      const v = data.venue(venue);
      const when = v && v.fetchedAt ? fmt.date(v.fetchedAt) : "unknown time";
      source.textContent = `${data.active().source === "builtin" ? "Real snapshot" : "Your data"}: ${data.label(venue)} ${v ? v.symbol : ""}, fetched ${when}, ${fmt.int(book.orders.size)} resting orders. Nobody else is trading here, so only your orders change it.`;
      const step = String(units.tickSize);
      priceIn.step = step; sizeIn.step = String(units.lotSize);
      const bb = book.bestBid();
      priceIn.value = bb !== null ? units.price(bb).toFixed(digits) : "";
      if (!ladder) {
        ladder = ui.Ladder({ levels: book, rows: 8, priceDigits: digits, label: `${data.label(venue)} order book, top 8 levels per side`, onSelect: (l) => { priceIn.value = l.price.toFixed(digits); typeSeg.api.set("limit"); state.type = "limit"; sync(); formMsg.textContent = `Limit price set to $${l.price.toFixed(digits)} from the ladder.`; } });
        ladderBox.appendChild(ladder);
      } else ladder.api.update(book);
      sync();
      renderMine();
      buildCheck();
    }

    function quickButtons() {
      clear(quick);
      const bb = book.bestBid(), ba = book.bestAsk(), mid = book.mid();
      const q = (label, v) => v === null ? null : ui.Button({ label, small: true, variant: "ghost", onClick: () => { priceIn.value = v.toFixed(digits); formMsg.textContent = `Limit price set to $${v.toFixed(digits)}.`; } });
      quick.append(...[q("Best bid", bb === null ? null : units.price(bb)), q("Mid", mid === null ? null : Math.round(mid / units.tickSize) * units.tickSize), q("Best ask", ba === null ? null : units.price(ba))].filter(Boolean));
    }

    function sync() {
      const limit = state.type === "limit";
      priceRow.hidden = !limit;
      tifRow.hidden = !limit;
      protRow.hidden = limit;
      sendBtn.textContent = `Send ${limit ? "limit" : "market"} ${state.side === BID ? "buy" : "sell"}`;
      sendBtn.className = "btn " + (state.side === BID ? "btn-buy" : "btn-sell");
      quickButtons();
    }

    // Decimal text -> integer ticks / lots, exactly (no float drift): v * 10^d / m.
    function toUnits(text, dec) {
      const v = parseFloat(String(text).replace(/[$,\s]/g, ""));
      if (!isFinite(v) || v <= 0) return null;
      return Math.round(v * Math.pow(10, dec.d) / dec.m);
    }

    function send() {
      const side = state.side, opp = side === BID ? ASK : BID;
      const lots = toUnits(sizeIn.value, units.lot);
      if (!lots) { formMsg.textContent = "Type a size above zero first."; sizeIn.focus(); return; }
      if (units.size(lots) > 1000) { formMsg.textContent = "Please keep the size at 1,000 SOL or less."; sizeIn.focus(); return; }
      let ticks = null;
      if (state.type === "limit") {
        ticks = toUnits(priceIn.value, units.tick);
        if (!ticks) { formMsg.textContent = "Type a limit price above zero first."; priceIn.focus(); return; }
      }
      formMsg.textContent = "";
      const before = { bb: book.bestBid(), ba: book.bestAsk(), mid: book.mid(), oppBest: side === BID ? book.bestAsk() : book.bestBid() };
      let fills, rested = 0, id = null, protLimit = null;
      if (state.type === "limit" && state.tif === "gtc") {
        id = nextId++;
        fills = book.addOrder(id, side, ticks, lots);
        if (book.orders.has(id)) { rested = book.orders.get(id).sizeLots; mine.push({ id, side, priceTicks: ticks, n: mine.length + 1 }); }
      } else if (state.type === "limit") {
        // IOC: the engine's market_order with a limit is exactly an IOC limit order.
        fills = book.marketOrder(side, lots, ticks);
      } else {
        if (state.protect && before.mid !== null) protLimit = OBZ.engine.protectionLimitTicks(units.tickSize, side, before.mid, 0.10);
        fills = book.marketOrder(side, lots, protLimit);
      }
      ladder.api.update(book);
      quickButtons();
      renderMine();
      explain({ side, opp, lots, ticks, fills, rested, id, protLimit, before });
    }

    function explain(r) {
      const { side, lots, ticks, fills, rested, before } = r;
      const filled = fills.reduce((a, f) => a + f.sizeLots, 0);
      const buy = side === BID;
      const verb = buy ? "bought" : "sold";
      const P = (t) => "$" + units.price(t).toFixed(digits);
      const S = (l) => fmt.sol(units.size(l)) + " SOL";
      const isLimit = r.ticks !== null;
      const role = filled > 0 && rested > 0 ? "both" : filled > 0 ? "taker" : rested > 0 ? "maker" : "none";
      clear(result);
      const out = [];
      const headline = {
        taker: `**Taker.** You ${verb} ${S(filled)} straight away${filled < lots ? ` (of the ${S(lots)} you asked for)` : ""}.`,
        maker: `**Maker.** Nothing traded. Your ${S(rested)} ${buy ? "bid" : "ask"} now rests in the book at ${P(ticks)}.`,
        both: `**Taker, then maker.** You ${verb} ${S(filled)} at once, and the other ${S(rested)} now rests at ${P(ticks)}.`,
        none: `**Nothing traded**, and nothing rests.`,
      }[role];
      out.push(headline);

      if (filled > 0) {
        const usd = fills.reduce((a, f) => a + units.price(f.priceTicks) * units.size(f.sizeLots), 0);
        const avg = usd / units.size(filled);
        const levels = new Set(fills.map((f) => f.priceTicks)).size;
        let line = `${fills.length} fill${fills.length > 1 ? "s" : ""} across ${levels} price level${levels > 1 ? "s" : ""}, average price **$${avg.toFixed(digits)}**. Each fill printed at the resting (maker) order's price`;
        if (isLimit && fills.some((f) => f.priceTicks !== ticks)) line += `, which is ${buy ? "lower" : "higher"} than your ${P(ticks)} limit: your limit is the worst you'll accept, not what you pay`;
        out.push(line + ".");
        if (before.mid !== null) {
          const bps = (buy ? avg - before.mid : before.mid - avg) / before.mid * 1e4;
          if (bps > 100) out.push(`That average is **${fmt.bps(bps)}** ${buy ? "above" : "below"} the mid before you traded ($${before.mid.toFixed(digits)}). Walking deep into the book is expensive: [chapter 5](#/learn/5) measures this as price impact.`);
        }
      }

      // Why it stopped / why it didn't trade
      const unfilled = lots - filled;
      if (unfilled > 0) {
        const next = side === BID ? book.bestAsk() : book.bestBid();
        const oppWord = buy ? "ask" : "bid";
        if (filled === 0 && isLimit) {
          if (before.oppBest === null) out.push(`**Why didn't it trade?** There are no ${oppWord}s in the book at all, so there was nobody to trade with.`);
          else out.push(`**Why didn't it trade?** You'll ${buy ? "pay at most" : "accept at least"} ${P(ticks)}, but the best ${oppWord} is ${P(before.oppBest)}: ${buy ? "every seller wants more than that" : "every buyer offers less than that"}. Your order doesn't [[crossing-the-spread|cross the spread]], so no trade is possible.`);
        } else if (next === null) {
          out.push(`The ${oppWord} side ran out: there was nothing left to trade with.`);
        } else if (isLimit) {
          out.push(`It stopped because the next ${oppWord}, ${P(next)}, is ${buy ? "above" : "below"} your ${P(ticks)} limit.`);
        } else if (r.protLimit !== null) {
          out.push(`Price protection stopped it: the next ${oppWord}, ${P(next)}, is more than 10% from the mid (your worst allowed price was ${P(r.protLimit)}). The unfilled ${S(unfilled)} was dropped.`);
        }
        if (isLimit && state.tif === "ioc") out.push(`Because it was **IOC**, the unfilled ${S(unfilled)} was cancelled instead of resting. An IOC order is only ever a taker.`);
        if (rested > 0) {
          const pos = book.queuePosition(r.id);
          const lv = book.level(side, ticks);
          const best = (side === BID ? book.bestBid() : book.bestAsk()) === ticks;
          out.push(`It joined the queue at ${P(ticks)} in position **${pos} of ${lv.count}**${best ? `, and it is now the **best ${buy ? "bid" : "ask"}**` : ""}. As a maker, it waits for a taker to come to it. Here nobody else is trading, so try sending ${buy ? "a sell" : "a buy"} that reaches it.`);
        }
      }

      const bb = book.bestBid(), ba = book.bestAsk();
      if (bb !== null && ba !== null) out.push(`Book now: best bid ${P(bb)} < best ask ${P(ba)}. It is never crossed, because any order that could cross trades instead of resting.`);

      if (state.guess) {
        const ok = state.guess === role;
        const names = { maker: "maker", taker: "taker", both: "both", none: "nothing trades" };
        out.push(`${ok ? "✓" : "✗"} You predicted **${names[state.guess]}**; the answer was **${names[role]}**.`);
        state.guess = null; guessSeg.api.set(null);
      }
      for (const t of out) result.appendChild(h("p", null, ui.rich(t)));

      // Fills table
      clear(fillsBox);
      if (fills.length) {
        const rows = fills.slice(0, 8).map((f, k) => ({ n: k + 1, price: P(f.priceTicks), size: S(f.sizeLots), maker: f.makerOrderId >= USER_BASE ? `#${f.makerOrderId - USER_BASE + 1} (your own order)` : `#${f.makerOrderId}` }));
        fillsBox.appendChild(ui.Table({
          caption: fills.length > 8 ? `Your fills (first 8 of ${fills.length})` : "Your fills",
          dense: true,
          columns: [{ key: "n", label: "Fill" }, { key: "price", label: "Price (maker's)" }, { key: "size", label: "Size" }, { key: "maker", label: "Maker order", align: "left" }],
          rows,
        }));
      }
    }

    function renderMine() {
      clear(mineBox);
      const live = mine.filter((m) => book.orders.has(m.id));
      if (!live.length) return;
      mineBox.appendChild(h("p", { class: "eyebrow", style: "color: var(--mine)", text: "Your resting orders (you are the maker)" }));
      for (const m of live) {
        const o = book.orders.get(m.id);
        const buy = m.side === BID;
        mineBox.appendChild(h("div", { class: "btn-row", style: "border-left: 4px solid var(--mine); padding-left: var(--s-3)" },
          h("span", { class: "mono" }, `#${m.id - USER_BASE + 1} ${buy ? "▲ BID" : "▼ ASK"} ${fmt.sol(units.size(o.sizeLots))} SOL @ $${units.price(m.priceTicks).toFixed(digits)} · queue position ${book.queuePosition(m.id)}`),
          ui.Button({ label: "Cancel", small: true, variant: "ghost", attrs: { "aria-label": `Cancel your order ${m.id - USER_BASE + 1}` }, onClick: () => {
            book.cancelOrder(m.id); ladder.api.update(book); quickButtons(); renderMine();
            clear(result).appendChild(h("p", null, ui.rich(`Cancelled order #${m.id - USER_BASE + 1}. It left the book without trading.`)));
            clear(fillsBox);
          } })));
      }
    }

    function buildCheck() {
      clear(checkBox);
      const ba = startBook.bestAsk();
      if (ba === null) return;
      const lim = Math.ceil(units.price(ba) * 1.01);
      const fills = startBook.dryMatch(BID, Math.max(1, Math.round(1 / units.lotSize)), Math.round(lim / units.tickSize)).fills;
      if (!fills.length) return;
      const ans = units.price(fills[0].priceTicks);
      checkBox.appendChild(ui.NumberCheck({
        question: `Your turn: on the starting book, you send a limit buy for 1 SOL at **$${lim.toFixed(2)}**. At what price does it trade? (Predict first, then reset the book and try it.)`,
        answer: ans, tolerance: units.tickSize / 2 + 1e-9, unit: "dollars",
        explain: `It trades at the best ask, **$${ans.toFixed(digits)}**: the resting seller is the maker, so the fill prints at the maker's price. Your $${lim.toFixed(2)} was only the most you'd pay.`,
        hint: "Your order crosses the spread and becomes a taker. Whose price does a taker trade at?",
      }));
    }

    function showIntro() {
      clear(result).appendChild(h("p", null, ui.rich("Pick a side and a type, then send. Tip: **click a ladder row** to copy its price into the ticket. Try a limit buy below the best ask, one above it, and a large market sell.")));
      clear(fillsBox);
    }

    load();
    showIntro();
    ctx.onData(() => { load(); showIntro(); });

    const ticket = h("div", { class: "card stack" },
      h("p", { class: "eyebrow", text: "Order ticket" }),
      sideSeg, typeSeg, priceRow, sizeRow, tifRow, protRow,
      h("div", { class: "stack" }, h("p", { class: "fine", text: "Predict before you send (optional)" }), guessSeg),
      h("div", { class: "btn-row" }, sendBtn, resetBtn),
      formMsg);
    return h("div", { class: "stack" },
      source,
      h("div", { class: "grid-2" }, ticket, h("div", { class: "stack" }, ladderBox, mineBox)),
      result, fillsBox, checkBox);
  }

  /* ------------------------------------------------------------------ the chapter */
  OBZ.chapters.register({
    id: "orders",
    number: 3,
    title: "Orders, makers, takers",
    summary: "Limit orders wait, market orders don't. Learn who is the maker and who is the taker, why every trade prints at the maker's price, and why a book never crosses.",
    goals: [
      "Tell a market order from a limit order, and GTC from IOC",
      "Say who is the maker and who is the taker in a trade",
      "Explain why trades print at the maker's price and why resting orders never cross",
      "Predict what an order will do on a real Phoenix book before you send it",
    ],
    status: "ready",

    render(el, ctx) {
      const { ui } = ctx;

      // ---------------- Explain
      const ex = ctx.section("explain", "Waiting orders and impatient orders");
      ex.append(
        ui.prose(`
In [chapter 2](#/learn/2) every order in the book was waiting. Now look at what happens when a new [[order]] arrives. There are two basic kinds:

- A [[limit-order|limit order]] names a worst price: "buy 2 SOL, paying at most $104.00 each." It trades only at that price or better.
- A [[market-order|market order]] names no price: "buy 2 SOL now, at whatever the book offers." It trades straight away with the best orders on the other side.

Think of a farmers' market. A stallholder who puts out apples with a price tag and waits is like a limit order. A shopper who picks up apples and pays the sticker price is like a market order.`),
        ui.prose(`
The exchange checks each incoming order against the other side of the book. If it can trade, it trades at once. If it can't, a limit order [[resting-order|rests]] in the book and waits. So every trade has two roles:

- The [[maker]] is the order that was already resting. It *made* the market by offering a price others could trade against, adding [[liquidity]].
- The [[taker]] is the incoming order that trades with it, *taking* liquidity out of the book.

A market order is always a taker. A limit order is a maker if it can't trade at once, and a taker if it can. It can even be both: a buy priced at or above the best ask [[crossing-the-spread|crosses the spread]], trades as a taker as far as its price allows, then rests whatever is left as a maker.`),
        ui.prose(`
Every [[fill]] happens at the **maker's price**. The maker posted that price first, for everyone to see; the taker only said "this price or better". If the best ask is $104.35 and you send a limit buy at $105.00, you pay $104.35. Your limit is the worst price you'll accept, not the price you pay.

This is also why resting orders never trade with each other. Suppose a bid at $104.40 arrives while an ask rests at $104.35. That bid crosses, so it trades at once instead of resting. After every order, then, the best bid is below the best ask. A book where that fails is a [[crossed-book|crossed book]], and a correct engine can never produce one.

One more choice: a limit order's [[time-in-force|time in force]] says what happens to the part that can't trade at once. The usual kind, [[gtc|GTC]] (good-til-cancelled), rests it in the book. An [[ioc|IOC]] (immediate-or-cancel) order trades what it can right now, at its limit or better, and cancels the rest, so it is only ever a taker.`),
        ui.Callout({
          kind: "project", title: "The same rules, in code",
          body: `In \`orderbook.py\`, every trade is a \`Fill(maker_order_id, price_ticks, size_lots)\`, and the comment on \`price_ticks\` reads "always the maker's price". \`add_order\` takes \`tif=TimeInForce.GTC\` (the default) or \`TimeInForce.IOC\`; the only difference is whether the remainder rests. \`snapshot.validate()\` rejects a crossed snapshot, because loading one would invent trades. This page runs a JavaScript port of the engine that reproduces its fills exactly.`,
        }),
        ui.Callout({
          kind: "warn", title: "A market order with no limit can go very wrong",
          body: `A market order keeps trading at worse and worse prices until it is filled or the book runs out. In the 18 Oct 2026 Phoenix snapshot, the bids drop from $103.75 straight to about $89, and far up the ask side sit [[junk-quote|junk orders]] at $9,999,999,999. So real takers almost always attach a worst acceptable price, called [[price-protection|price protection]]. The engine's \`market_order\` takes an optional limit for exactly this; [chapter 11](#/learn/11) tells the full story.`,
        }));

      // ---------------- See
      const see = ctx.section("see", "Three orders arrive");
      const svg = h("svg", { class: "diagram diagram-md", viewBox: "0 0 440 256", attrs: { role: "img", "aria-label": "A small order book as three orders arrive: one rests, one takes, one does both" } });
      see.append(
        ui.p("Step through three incoming orders. For each one, decide before you click: will it rest (maker), trade (taker), or both? Every state is computed by the course's matching engine."),
        ui.Figure({
          label: "Figure 3.1",
          children: ui.Stepper({ steps: STEPS, stage: svg, render: (i) => drawSee(svg, i), interval: 3200, label: "Three orders meet a small book" }),
          caption: "A limit order that can't trade rests and becomes a maker. An order that can trade is a taker, and every fill prints at the resting order's price. Whatever is left of a crossing limit order rests, and the book is never left crossed.",
          alt: "The book starts with asks at $104.10 (Ann, 3 SOL) and $104.00 (Raj, 2 SOL), and bids at $103.90 (Kim, 4 SOL) and $103.80 (Lou, 1 SOL). You send a limit buy of 2 SOL at $103.95: it can't trade and rests as the best bid. Mia sends a market buy of 3 SOL: it fills 2 SOL from Raj at $104.00 and 1 from Ann at $104.10. Ned sends a limit sell of 7 SOL at $103.90: it fills your 2 SOL at $103.95 and Kim's 4 SOL at $103.90, then rests 1 SOL as an ask at $103.90. The final book has best bid $103.80 and best ask $103.90.",
        }));

      // ---------------- Try
      const tr = ctx.section("try", "Send orders to a real book");
      tr.append(ui.TryIt({
        title: "An order ticket on Phoenix",
        intro: "This is the real [[phoenix|Phoenix]] SOL/USDC book from 18 Oct 2026, 04:31 UTC, loaded into the matching engine. Send limit and market orders and read what happened. Things to try: a limit buy below the best ask (why didn't it trade?), a limit buy just above it, the same with IOC, and a market sell of 100 SOL with and without price protection.",
        children: buildTry(ctx),
      }));
    },

    quiz: [
      {
        q: "On Phoenix the best bid is **$103.75** and the best ask is **$104.35**. You send a limit buy for 1 SOL at **$104.00** (GTC). What happens?",
        options: [
          { text: "It trades at $104.00", why: "No seller asks as little as $104.00; the cheapest wants $104.35. A trade needs someone on the other side who accepts your price." },
          { text: "It trades at $104.35", why: "$104.35 is more than your $104.00 limit, and a limit order never trades at a worse price than its limit." },
          { text: "It rests as the new best bid, and you become a maker", why: "Right. It can't cross the spread, so with GTC it waits in the book. At $104.00 it is above the old best bid of $103.75, so it becomes the best bid." },
          { text: "It is cancelled because it can't trade", why: "That's what an IOC order would do. A GTC order rests whatever can't trade, waiting for a taker." },
        ],
        answer: 2,
      },
      {
        q: "The best ask is **$104.35** with 25 SOL resting. You send a limit buy for 1 SOL at **$105.00**. At what price do you trade?",
        options: [
          { text: "$105.00, your limit", why: "Your limit is the worst price you'll accept, not what you pay. The seller was resting at $104.35, so that is the price." },
          { text: "$104.35, the maker's price", why: "Right. Your order crosses the spread and trades as a taker against the resting ask, and every fill prints at the maker's price." },
          { text: "$104.675, halfway between", why: "Exchanges don't split the difference. The maker's posted price is the trade price." },
          { text: "It doesn't trade; it rests at $105.00", why: "It can trade: $105.00 is at or above the best ask, so it crosses. It would only rest the part that couldn't fill, and here all 1 SOL fills." },
        ],
        answer: 1,
      },
      {
        q: "Why can't a working order book show a bid resting at **$104.40** while an ask rests at **$104.35**?",
        options: [
          { text: "Exchanges don't allow bids above a certain price", why: "You may bid any price you like. The point is what happens when your bid is at or above someone's ask." },
          { text: "Whichever of the two arrived second would have traded with the other at once, so they can't both be resting", why: "Right. An order that crosses the spread trades immediately as a taker. Only what can't trade rests, so the best bid always stays below the best ask." },
          { text: "It can happen; buyers sometimes offer more than sellers ask", why: "They can send such an order, but it doesn't rest: it trades straight away. A book showing both would be crossed, which a correct engine never allows." },
          { text: "Because both orders would be takers", why: "The one that arrived first was resting, so it would be the maker. The second would be the taker, and they would trade." },
        ],
        answer: 1,
      },
    ],
  });
})(window.OBZ = window.OBZ || {});
