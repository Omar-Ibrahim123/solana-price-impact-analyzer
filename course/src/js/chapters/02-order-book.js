/* chapters/02-order-book.js: Chapter 2, "The order book".
 * REFERENCE IMPLEMENTATION of a chapter: Explain -> See -> Try -> Check.
 *   Explain  plain-language prose with [[term]] links, a worked example on real numbers
 *   See      an SVG figure driven by a Stepper (step-only under reduced motion)
 *   Try      a ladder on real Phoenix / Kraken / Coinbase data + a "work it out" check
 *   Check    the quiz below (rendered by the app from `quiz`)
 */
(function (OBZ) {
  "use strict";
  const { h, fmt } = OBZ.util;

  /* ------------------------------------------------------------------ the See figure */
  // A tiny example book. Positions are in SVG units (viewBox 0 0 440 300).
  const ORDERS = [
    { id: "a1", side: "ask", price: 104.1, size: 3 },
    { id: "b1", side: "bid", price: 103.85, size: 6 },
    { id: "a2", side: "ask", price: 104.0, size: 2 },
    { id: "b2", side: "bid", price: 103.9, size: 4 },
    { id: "a3", side: "ask", price: 104.05, size: 5 },
    { id: "b3", side: "bid", price: 103.8, size: 1 },
  ];
  const CARD_W = 200, CARD_H = 30, LADDER_X = 120;
  const POS = {
    // step 0: jumbled, in arrival order
    jumble: { a1: [14, 18, -4], b1: [226, 40, 3], a2: [34, 108, 3], b2: [214, 132, -3], a3: [10, 206, 2], b3: [228, 238, -2] },
    // step 1: two piles, still in arrival order
    piles: { a1: [6, 40, 0], a2: [6, 76, 0], a3: [6, 112, 0], b1: [234, 160, 0], b2: [234, 196, 0], b3: [234, 232, 0] },
    // step 2+: the ladder (asks lowest-first upward from the middle, bids highest-first downward)
    ladder: { a1: [LADDER_X, 30, 0], a3: [LADDER_X, 66, 0], a2: [LADDER_X, 102, 0], b2: [LADDER_X, 168, 0], b1: [LADDER_X, 204, 0], b3: [LADDER_X, 240, 0] },
  };
  const MID_Y = 150;

  function buildFigure() {
    const svg = h("svg", { class: "diagram diagram-md", viewBox: "0 0 440 300", attrs: { role: "img", "aria-label": "Six orders being sorted into an order book ladder" } });
    const cards = {};
    for (const o of ORDERS) {
      const g = h("g", { class: "fade", style: "transition: transform 0.6s cubic-bezier(.2,.8,.2,1), opacity 0.35s" },
        h("rect", { class: o.side === "ask" ? "box-ask" : "box-bid", x: 0, y: 0, width: CARD_W, height: CARD_H, rx: 6 }),
        h("text", { x: 10, y: 20, class: "t-mono t-bold " + (o.side === "ask" ? "t-ask" : "t-bid"), text: o.side === "ask" ? "▼ ASK" : "▲ BID" }),
        h("text", { x: 100, y: 20, class: "t-mono t-bold", "text-anchor": "middle", text: "$" + o.price.toFixed(2) }),
        h("text", { x: CARD_W - 10, y: 20, class: "t-mono", "text-anchor": "end", text: o.size + " SOL" }));
      cards[o.id] = g;
      svg.appendChild(g);
    }
    // overlays (hidden until their step)
    const midLine = h("line", { class: "line-accent line-dash", x1: 100, x2: 340, y1: MID_Y, y2: MID_Y });
    const sep = h("g", null, h("line", { class: "line line-dash", x1: 0, x2: 440, y1: MID_Y, y2: MID_Y }));
    const bestAsk = h("g", null, h("text", { x: LADDER_X - 8, y: 121, "text-anchor": "end", class: "t-bold t-ask", text: "best ask" }), h("rect", { x: LADDER_X - 2, y: 100, width: CARD_W + 4, height: CARD_H + 4, rx: 8, fill: "none", class: "hl" }));
    const bestBid = h("g", null, h("text", { x: LADDER_X - 8, y: 187, "text-anchor": "end", class: "t-bold t-bid", text: "best bid" }), h("rect", { x: LADDER_X - 2, y: 166, width: CARD_W + 4, height: CARD_H + 4, rx: 8, fill: "none", class: "hl" }));
    const spread = h("g", null,
      h("path", { class: "line-accent", d: `M ${LADDER_X + CARD_W + 12} 132 h 8 V 168 h -8` }),
      h("text", { x: LADDER_X + CARD_W + 26, y: 146, class: "t-bold t-accent", text: "spread" }),
      h("text", { x: LADDER_X + CARD_W + 26, y: 162, class: "t-mono t-muted", text: "$0.10" }));
    const mid = h("g", null, midLine,
      h("circle", { cx: LADDER_X + CARD_W / 2, cy: MID_Y, r: 5, class: "fill-accent" }),
      h("text", { x: LADDER_X - 8, y: MID_Y + 5, "text-anchor": "end", class: "t-bold t-accent", text: "mid $103.95" }));
    const pileLabels = h("g", null,
      h("text", { x: 6, y: 30, class: "t-muted", text: "sellers (asks)" }),
      h("text", { x: 234, y: 150, class: "t-muted", text: "buyers (bids)" }));
    [sep, pileLabels, bestAsk, bestBid, spread, mid].forEach((g) => { g.setAttribute("class", "fade"); svg.appendChild(g); });
    return { svg, cards, overlays: { sep, pileLabels, bestAsk, bestBid, spread, mid } };
  }

  const STEPS = [
    "Here are six orders, in the order they arrived: three from sellers (**asks**, red ▼) and three from buyers (**bids**, green ▲). As a pile, they are hard to read.",
    "First, split them by [[side]]: asks in one pile, bids in the other. They are still in arrival order, not sorted.",
    "Now sort each side and stack them into a [[ladder]]. Asks go **above** the line, lowest price nearest the middle. Bids go **below**, highest price nearest the middle. The two queues face each other.",
    "The two orders touching the middle line are the top of the book: the **best ask** ($104.00, the cheapest seller) and the **best bid** ($103.90, the most generous buyer).",
    "The gap between them is the **spread**: $104.00 − $103.90 = $0.10. No trade happens inside that gap, because no buyer will pay what any seller asks.",
    "Halfway across the gap is the **mid price**: ($103.90 + $104.00) ÷ 2 = $103.95. As a fraction of the mid, the spread is 0.10 ÷ 103.95 ≈ 0.00096, which is about **9.6 bps**.",
  ];

  function applyStep(fig, i) {
    const layout = i === 0 ? POS.jumble : i === 1 ? POS.piles : POS.ladder;
    for (const o of ORDERS) {
      const [x, y, r] = layout[o.id];
      fig.cards[o.id].style.transform = `translate(${x}px, ${y}px) rotate(${r}deg)`;
      fig.cards[o.id].setAttribute("transform", `translate(${x} ${y}) rotate(${r})`);
      const dimmed = i >= 3 && !(o.id === "a2" || o.id === "b2");
      fig.cards[o.id].style.opacity = dimmed ? "0.45" : "1";
    }
    const show = (g, on) => { g.style.opacity = on ? "1" : "0"; };
    show(fig.overlays.pileLabels, i === 1);
    show(fig.overlays.sep, i === 2);
    show(fig.overlays.bestAsk, i >= 3);
    show(fig.overlays.bestBid, i >= 3);
    show(fig.overlays.spread, i >= 4);
    show(fig.overlays.mid, i >= 5);
  }

  /* ------------------------------------------------------------------ the Try widget */
  function priceDigits(snap) {
    if (!snap) return 2;
    return Math.max(2, Math.min(4, Math.round(-Math.log10(snap.tickSize))));
  }

  function buildTry(ctx) {
    const { ui, data } = ctx;
    const wrap = h("div", { class: "stack" });
    let venueName = data.venue("phoenix") ? "phoenix" : data.venues()[0];
    const solved = new Set(); // venues whose spread in bps the reader has worked out

    const pickerBox = h("div");
    const source = h("p", { class: "fine" });
    const ladderBox = h("div");
    const stats = {
      bid: ui.Stat({ label: "Best bid", tone: "bid" }),
      ask: ui.Stat({ label: "Best ask", tone: "ask" }),
      spread: ui.Stat({ label: "Spread ($)" }),
      bps: ui.Stat({ label: "Spread (bps)", tone: "accent" }),
      mid: ui.Stat({ label: "Mid price" }),
    };
    const picked = h("div", { class: "readout-panel", attrs: { "aria-live": "polite" } });
    const checkBox = h("div");
    const depthBox = h("div");

    function render() {
      const v = data.venue(venueName);
      const snap = data.snapshot(venueName);
      if (!v || !snap) { ladderBox.textContent = "No data for this venue."; return; }
      const book = snap.toBook();
      const digits = priceDigits(snap);
      const aggregated = v.meta && v.meta.levels === "aggregated";
      const levels = book.toLevels(8);
      if (aggregated) for (const side of ["bids", "asks"]) levels[side].forEach((l) => { delete l.count; });

      const bb = book.usd(book.bestBid()), ba = book.usd(book.bestAsk()), mid = book.mid();
      const spr = ba - bb, bps = spr / mid * 1e4;
      stats.bid.api.set("$" + fmt.price(bb, digits), "highest buyer");
      stats.ask.api.set("$" + fmt.price(ba, digits), "lowest seller");
      stats.spread.api.set("$" + fmt.price(spr, digits), "ask − bid");
      if (solved.has(venueName)) stats.bps.api.set(fmt.bps(bps), "spread ÷ mid × 10,000");
      else stats.bps.api.set("?", "work it out below");
      stats.mid.api.set("$" + fmt.price(mid, Math.max(digits, 3)), "(bid + ask) ÷ 2");

      const when = v.fetchedAt ? fmt.date(v.fetchedAt) : "unknown time";
      const slot = v.meta && v.meta.slot ? ` · Solana slot ${fmt.int(v.meta.slot)}` : "";
      const orders = aggregated ? " · levels aggregated by price (one total per price)" : ` · ${fmt.int(snap.bids.length)} bid and ${fmt.int(snap.asks.length)} ask orders`;
      source.textContent = `${data.active().source === "builtin" ? "Real snapshot" : "Your data"}: ${v.label} ${v.symbol}, fetched ${when}${slot}${orders}.`;

      OBZ.util.clear(ladderBox).appendChild(ui.Ladder({
        levels, rows: 8, priceDigits: digits, label: `${v.label} order book, top 8 levels per side`,
        onSelect: (l, side) => showPicked(book, l, side, mid, digits),
      }));
      OBZ.util.clear(picked).appendChild(h("p", null, ui.rich("**Pick any row** of the ladder (click, tap, or use the arrow keys and Enter) to see how far it sits from the mid.")));

      OBZ.util.clear(checkBox).appendChild(ui.NumberCheck({
        question: `Your turn: from the best bid and best ask above, work out ${v.label}'s spread in basis points (one decimal place is fine).`,
        answer: Math.round(bps * 10) / 10,
        tolerance: Math.max(0.06, Math.abs(bps) * 0.01),
        unit: "bps",
        explain: `(${fmt.price(ba, digits)} − ${fmt.price(bb, digits)}) ÷ ${fmt.price(mid, Math.max(digits, 3))} × 10,000 = **${bps.toFixed(2)} bps**.`,
        hint: "Spread = best ask − best bid. Divide it by the mid price, then multiply by 10,000.",
        onCorrect: () => { solved.add(venueName); stats.bps.api.set(fmt.bps(bps), "spread ÷ mid × 10,000"); },
      }));

      OBZ.util.clear(depthBox).appendChild(ui.Figure({
        children: ui.DepthChart({ levels: book, band: 0.01, unit: "sol", height: 190, alt: `Depth chart for ${v.label}: cumulative SOL on each side within 1% of the mid.` }),
        caption: `The same ${v.label} book drawn another way, as a [[depth-chart|depth chart]]. Left to right is price; the height is how much SOL you have added up so far, starting at the mid: the green area adds up every bid going down in price and the red area every ask going up, within 1% of the price. A wall that rises fast means lots of [[liquidity]] close to the mid.`,
      }));
    }

    function showPicked(book, l, side, mid, digits) {
      const away = side === "ask" ? l.price - mid : mid - l.price;
      const bpsAway = away / mid * 1e4;
      const prices = book.levelPrices(side);
      let before = 0;
      for (const p of prices) { if (p === l.priceTicks) break; before += book.sol(book.level(side, p).totalSize); }
      const who = side === "ask" ? "seller" : "buyer";
      const taker = side === "ask" ? "A buyer" : "A seller";
      OBZ.util.clear(picked).appendChild(h("div", null,
        h("p", null, ui.rich(`**${side === "ask" ? "▼ Ask" : "▲ Bid"} at $${fmt.price(l.price, digits)}**: ${fmt.sol(l.size)} SOL${l.count ? ` from ${l.count} order${l.count > 1 ? "s" : ""}` : ""}.`)),
        h("p", null, ui.rich(`It is **$${fmt.price(away, digits)} (${fmt.bps(bpsAway)})** ${side === "ask" ? "above" : "below"} the mid. ` +
          (before > 0 ? `${taker} would first have to trade **${fmt.sol(before)} SOL** at better prices before reaching this ${who}. That walk is what chapter 5 calls [[price-impact|price impact]].`
            : `This is the **best ${side}**: the first ${who} a ${side === "ask" ? "buyer" : "seller"} would trade with.`)))));
    }

    function mountPicker() {
      OBZ.util.clear(pickerBox).appendChild(ui.VenuePicker({
        venues: data.venues(), value: venueName,
        onChange: (v) => { venueName = v; render(); },
      }));
    }

    mountPicker();
    render();
    ctx.onData(() => { if (!data.venue(venueName)) venueName = data.venues()[0]; mountPicker(); render(); });

    wrap.append(
      pickerBox, source,
      h("div", { class: "grid-2" }, ladderBox, h("div", { class: "stack" }, ui.StatGrid(Object.values(stats), { live: true }), picked)),
      checkBox, depthBox);
    return wrap;
  }

  /* ------------------------------------------------------------------ the chapter */
  OBZ.chapters.register({
    id: "order-book",
    number: 2,
    title: "The order book",
    summary: "Two sorted queues of promises to trade. Learn to find the best bid and ask, and read the spread and mid in dollars and basis points.",
    goals: [
      "Read a ladder: which side is buyers, which is sellers, and where the best prices are",
      "Compute the spread and the mid price from the best bid and best ask",
      "Turn a spread into basis points, and say why traders use them",
      "Compare a real Phoenix book with Kraken's and Coinbase's from the same minute",
    ],
    status: "ready",

    render(el, ctx) {
      const { ui } = ctx;

      // ---------------- Explain
      const ex = ctx.section("explain", "Two queues of promises");
      ex.append(
        ui.prose(`
In chapter 1 you met [[buyer|buyers]] and [[seller|sellers]] who disagree about the price. An [[exchange]] can't make them agree, but it can write down exactly what each of them is willing to do. That written list is the [[order-book|order book]].

Every entry in it is a [[limit-order|limit order]]: a promise such as "I will buy 2 SOL, paying at most $103.90 each" or "I will sell 5 SOL for at least $104.00 each". Buyers' promises are called [[bid|bids]] and sellers' promises are called [[ask|asks]]. They sit in the book (traders say they [[resting-order|rest]]) until someone trades with them or their owner cancels.

The exchange keeps the two sides sorted so the most attractive promise is always on top:

- Bids from the **highest** price down, so the most generous buyer is first.
- Asks from the **lowest** price up, so the cheapest seller is first.`),
        ui.prose(`
Drawn as one column, with asks stacked above and bids below, this is called a [[ladder]]. Each row is a [[price-level|price level]]: every order waiting at exactly that price, added together. Four numbers describe the place where the two queues meet:

- The [[best-bid|best bid]] is the highest bid. If you want to sell right now, it is the best price you can get.
- The [[best-ask|best ask]] is the lowest ask. If you want to buy right now, it is the cheapest you can pay.
- The [[spread]] is the gap between them: **best ask − best bid**.
- The [[mid-price|mid price]] is halfway across the gap: **(best bid + best ask) ÷ 2**. It is the usual answer to "what's the price right now?"`),
        ui.prose(`
A 10-cent spread means something very different for a $1 token and a $100,000 bitcoin. So traders measure the spread relative to the price, in [[basis-point|basis points]] (bps). One basis point is one hundredth of a percent: 1 bps = 0.01%, and 100 bps = 1%.`),
        h("p", { class: "formula" }, "spread in bps = (best ask − best bid) ÷ mid × 10,000"),
        ui.Callout({
          kind: "tip", title: "Worked example on real data",
          body: `At 04:31 UTC on 18 October 2026 [[kraken|Kraken]]'s best bid for SOL was **$103.94** and its best ask was **$103.95**.

- Spread: 103.95 − 103.94 = **$0.01**.
- Mid: (103.94 + 103.95) ÷ 2 = **$103.945**.
- Spread in bps: 0.01 ÷ 103.945 × 10,000 ≈ **0.96 bps**.

Buyers and sellers disagreed by less than a hundredth of a percent.`,
        }),
        ui.Callout({
          kind: "real", title: "You can't trade at the mid",
          body: `The mid is a reference point, not an offer. Buy right now and you pay the best ask; sell right now and you get the best bid. Either way you give up half the spread compared with the mid. That small cost of trading immediately is where [[price-impact|price impact]] starts, in chapter 5.`,
        }));

      // ---------------- See
      const see = ctx.section("see", "From a pile of orders to a ladder");
      const fig = buildFigure();
      see.append(
        ui.p("Step through how an exchange turns a jumble of orders into a ladder. Watch where the best prices end up."),
        ui.Figure({
          label: "Figure 2.1",
          children: ui.Stepper({ steps: STEPS, stage: fig.svg, render: (i) => applyStep(fig, i), interval: 2600, label: "Building an order book ladder" }),
          caption: "Asks are sorted lowest-first and bids highest-first, so the best ask and the best bid meet in the middle. The spread is the gap between them; the mid is its centre.",
          alt: "Six orders are sorted into a ladder. Asks $104.10, $104.05 and $104.00 sit above a middle line; bids $103.90, $103.85 and $103.80 sit below it. The best ask is $104.00, the best bid is $103.90, the spread is $0.10 (about 9.6 bps) and the mid is $103.95.",
        }));

      // ---------------- Try
      const tryEl = ctx.section("try", "Read a real book");
      tryEl.append(ui.TryIt({
        title: "Three venues, one minute",
        intro: `These are real SOL order books, captured within half a second of each other: [[phoenix|Phoenix]] runs on the [[solana|Solana]] [[blockchain]] and trades SOL against [[usdc|USDC]] (a digital dollar), while [[kraken|Kraken]] and [[coinbase|Coinbase]] are companies trading SOL against US dollars. Switch venues and compare their [[top-of-book|top of book]] (the best bid and best ask). Two words in the source line: a Solana [[slot]] is the blockchain's unit of time, about 400 ms, so its number pins the Phoenix snapshot to a moment; and Kraken and Coinbase publish their books *aggregated by price*: one total per price, not each order.`,
        children: buildTry(ctx),
      }),
      ui.Callout({
        kind: "real", title: "Why is Phoenix's spread so much wider?",
        body: `In this snapshot Kraken's spread is about **1 bps** and Phoenix's is about **58 bps**, nearly 60 times wider. Kraken and Coinbase have many professional [[market-maker|market makers]] quoting tight prices all day. On this Phoenix book the best orders simply sat further apart, and further down its bids there are orders at prices far from the market. Scroll the Phoenix ladder and you will see the best bid at $103.75 and the next one down at about $89. Yes, really: real books have gaps. Chapter 11 tells the story of those [[junk-quote|junk quotes]], and chapter 10 visits the [[prop-amm|prop AMMs]] where much of Solana's SOL trading now happens.`,
      }));
    },

    quiz: [
      {
        q: "A book has asks at $50.20, $50.10 and $50.40, and bids at $49.90 and $50.00. What is the **best ask**?",
        options: [
          { text: "$50.40, the highest ask", why: "The highest ask is the *worst* deal for a buyer. Sellers compete to be the cheapest, so the best ask is the lowest one." },
          { text: "$50.10", why: "The best ask is the lowest price any seller will accept. Someone who wants to buy right now pays $50.10." },
          { text: "$50.00", why: "$50.00 is a bid, a buyer's price, not an ask. It is actually the best bid." },
          { text: "$50.20, because it was listed first", why: "The order the asks were listed in doesn't matter. The book sorts asks from lowest to highest, and the lowest one is the best." },
        ],
        answer: 1,
      },
      {
        q: "The best bid is $99.95 and the best ask is $100.05. What are the spread and the mid price?",
        options: [
          { text: "Spread $0.10, mid $100.00", why: "Spread = 100.05 − 99.95 = $0.10, and mid = (99.95 + 100.05) ÷ 2 = $100.00." },
          { text: "Spread $0.05, mid $100.00", why: "$0.05 is the half-spread, the distance from the mid to either side. The spread is the whole gap from bid to ask: $0.10." },
          { text: "Spread $0.10, mid $100.05", why: "$100.05 is the best ask. The mid is halfway between the best bid and the best ask: $100.00." },
          { text: "Spread $200.00, mid $100.00", why: "That adds the two prices together. The spread is their difference: ask minus bid." },
        ],
        answer: 0,
      },
      {
        q: "Same book: a spread of $0.10 around a mid of $100.00. How wide is the spread in **basis points**?",
        options: [
          { text: "0.1 bps", why: "That treats $0.10 as if it were already a fraction of the price. As a fraction it is 0.10 ÷ 100 = 0.001, and 0.001 × 10,000 = 10 bps." },
          { text: "1 bps", why: "1 bps of $100 is 0.01% of $100, which is just one cent. The gap here is ten cents." },
          { text: "10 bps", why: "0.10 ÷ 100.00 = 0.001, which is 0.1%. Each percent is 100 bps, so 0.1% = 10 bps." },
          { text: "1,000 bps", why: "1,000 bps is 10%, which would be a $10 gap on a $100 price. Multiply the fraction (0.001) by 10,000." },
        ],
        answer: 2,
      },
    ],
  });
})(window.OBZ = window.OBZ || {});
