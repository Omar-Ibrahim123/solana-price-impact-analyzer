/* chapters/01-market.js: Chapter 1, "What a market is".
 *   Explain  buyers, sellers, walk-away prices, why a trade needs disagreement, bid and ask
 *   See      one ticket, two people: the "deal zone" on a price line (Stepper)
 *   Try      a small concert-ticket market: drag each buyer's maximum and each seller's
 *            minimum, see which trades can happen and the range of prices that clears it
 *   Check    the quiz below
 */
(function (OBZ) {
  "use strict";
  const { h, clear } = OBZ.util;

  /* ------------------------------------------------------------------ the See figure */
  // A price line from $40 to $120 in a 440 x 230 viewBox.
  const LO = 40, HI = 120, X0 = 40, X1 = 420;
  const xOf = (v) => X0 + (v - LO) * (X1 - X0) / (HI - LO);
  const AXIS_Y = 125, BUY_Y = 70, SELL_Y = 180;

  function marker(kind, y, label) {
    // kind "buy" (▲ green, above the line) or "sell" (▼ red, below the line); drawn at x = 0.
    const buy = kind === "buy";
    const g = h("g", { class: "fade", style: "transition: transform 0.6s cubic-bezier(.2,.8,.2,1), opacity 0.35s" },
      h("line", { class: "line line-dash", x1: 0, x2: 0, y1: buy ? y + 8 : AXIS_Y, y2: buy ? AXIS_Y : y - 8 }),
      h("path", { class: buy ? "fill-bid" : "fill-ask", d: buy ? `M 0 ${y - 9} l 9 15 h -18 z` : `M 0 ${y + 9} l 9 -15 h -18 z` }),
      h("text", { x: 0, y: buy ? y - 16 : y + 28, "text-anchor": "middle", class: "t-bold " + (buy ? "t-bid" : "t-ask"), text: label }));
    return g;
  }
  function setLabel(g, text) { g.querySelector("text").textContent = text; }
  function moveTo(g, v) {
    const x = xOf(v);
    g.style.transform = `translate(${x}px, 0px)`;
    g.setAttribute("transform", `translate(${x} 0)`);
  }

  function buildFigure() {
    const svg = h("svg", { class: "diagram diagram-md", viewBox: "0 0 440 230", attrs: { role: "img", "aria-label": "A price line showing a seller's minimum, a buyer's maximum and the deal zone between them" } });
    // Axis and ticks
    const axis = h("g", null, h("line", { class: "line", x1: X0 - 10, x2: X1 + 10, y1: AXIS_Y, y2: AXIS_Y }));
    for (let v = LO; v <= HI; v += 10) {
      axis.appendChild(h("line", { class: "line", x1: xOf(v), x2: xOf(v), y1: AXIS_Y - 4, y2: AXIS_Y + 4 }));
      axis.appendChild(h("text", { x: xOf(v), y: AXIS_Y + 20, "text-anchor": "middle", class: "t-muted t-mono", text: "$" + v }));
    }
    const zone = h("g", { class: "fade" },
      h("rect", { class: "box-accent", x: xOf(60), y: 34, width: xOf(90) - xOf(60), height: 176, rx: 6, style: "opacity: 0.55" }),
      h("text", { x: (xOf(60) + xOf(90)) / 2, y: 26, "text-anchor": "middle", class: "t-bold t-accent", text: "deal zone: $60 to $90" }));
    const seller = marker("sell", SELL_Y, "you: at least $60");
    const buyer = marker("buy", BUY_Y, "Sam: at most $90");
    const deal = h("g", { class: "fade" },
      h("circle", { cx: xOf(75), cy: AXIS_Y, r: 7, class: "fill-accent" }),
      h("text", { x: xOf(75) + 12, y: AXIS_Y - 10, class: "t-bold t-accent", text: "$75" }));
    const quotes = h("g", { class: "fade" },
      h("path", { class: "fill-bid", d: `M ${xOf(70)} ${AXIS_Y - 14} l 7 12 h -14 z` }),
      h("path", { class: "fill-ask", d: `M ${xOf(80)} ${AXIS_Y + 14} l 7 -12 h -14 z` }),
      h("text", { x: xOf(70) - 6, y: AXIS_Y - 20, "text-anchor": "end", class: "t-bold t-bid", text: "▲ BID $70" }),
      h("text", { x: xOf(80) + 6, y: AXIS_Y + 36, class: "t-bold t-ask", text: "▼ ASK $80" }),
      h("path", { class: "line-accent", d: `M ${xOf(70)} ${AXIS_Y - 40} v -6 H ${xOf(80)} v 6` }),
      h("text", { x: xOf(75), y: AXIS_Y - 52, "text-anchor": "middle", class: "t-bold t-accent", text: "gap" }));
    const none = h("g", { class: "fade" },
      h("path", { class: "line-accent line-dash", d: `M ${xOf(50)} 34 H ${xOf(60)}` }),
      h("text", { x: xOf(55), y: 26, "text-anchor": "middle", class: "t-bold t-accent", text: "no overlap: no trade" }));
    svg.append(zone, axis, deal, quotes, none, seller, buyer);
    return { svg, seller, buyer, zone, deal, quotes, none };
  }

  const STEPS = [
    "You have a spare ticket for Saturday's concert. You won't sell it for less than **$60**: below that you'd rather go yourself. That is your **walk-away price** as a seller (▼, red).",
    "Your friend Sam would pay at most **$90**. Above that he would rather stay home. That is his walk-away price as a buyer (▲, green).",
    "Any price from $60 to $90 leaves you both better off. This overlap is the **deal zone**. A trade is possible because the ticket is worth more to Sam than to you.",
    "Say you settle on **$75**. You get $15 more than your minimum, and Sam pays $15 less than his maximum. Both of you gain, which is why people trade at all.",
    "In practice nobody reveals a walk-away price. You **ask** $80, hoping for more; Sam **bids** $70, hoping to pay less. The bid is below the ask, so for now there is a gap and no trade. Someone has to move.",
    "Now suppose Sam would pay at most **$50**. No price is both at least $60 and at most $50. There is no deal zone, so no trade happens, however long you talk.",
  ];

  function applyStep(fig, i) {
    const show = (g, on, dim) => { g.style.opacity = on ? (dim ? "0.35" : "1") : "0"; };
    moveTo(fig.seller, 60);
    moveTo(fig.buyer, i >= 5 ? 50 : 90);
    setLabel(fig.buyer, i >= 5 ? "Sam: at most $50" : "Sam: at most $90");
    show(fig.seller, true, i === 4);
    show(fig.buyer, i >= 1, i === 4);
    show(fig.zone, i >= 2 && i <= 4, i === 4);
    show(fig.deal, i === 3);
    show(fig.quotes, i === 4);
    show(fig.none, i === 5);
  }

  /* ------------------------------------------------------------------ the Try widget */
  const PRICE_MIN = 20, PRICE_MAX = 150;
  const START = {
    buyers: [{ name: "Maya", v: 110 }, { name: "Jordan", v: 85 }, { name: "Priya", v: 55 }],
    sellers: [{ name: "Leo", v: 40 }, { name: "Sofia", v: 70 }, { name: "Ben", v: 95 }],
  };

  /** Pair the keenest buyer with the cheapest seller, and so on. k = trades that can happen.
   *  One market price p clears all k trades when every matched buyer will pay p, every matched
   *  seller will take p, and the people left out don't want in: [max(s_k, b_k+1), min(b_k, s_k+1)]. */
  function clearMarket(buyers, sellers) {
    const b = buyers.slice().sort((x, y) => y.v - x.v);
    const s = sellers.slice().sort((x, y) => x.v - y.v);
    const n = Math.min(b.length, s.length);
    let k = 0;
    while (k < n && b[k].v >= s[k].v) k++;
    let lo = null, hi = null;
    if (k > 0) {
      lo = Math.max(s[k - 1].v, k < b.length ? b[k].v : -Infinity);
      hi = Math.min(b[k - 1].v, k < s.length ? s[k].v : Infinity);
    }
    return { b, s, k, lo, hi };
  }

  function buildTry(ctx) {
    const { ui } = ctx;
    const people = {
      buyers: START.buyers.map((p) => Object.assign({}, p)),
      sellers: START.sellers.map((p) => Object.assign({}, p)),
    };
    const W = 440, CX0 = 92, CX1 = 425;
    const cx = (v) => CX0 + (v - PRICE_MIN) * (CX1 - CX0) / (PRICE_MAX - PRICE_MIN);
    const ROW = 26, TOP = 40;
    const lineY = TOP + 3 * ROW + 14;
    const H = lineY + 14 + 3 * ROW + 30;

    const svg = h("svg", { class: "diagram diagram-md", viewBox: `0 0 ${W} ${H}`, attrs: { role: "img", "aria-label": "Each buyer's maximum and each seller's minimum on a price line, with the range of prices that clears the market shaded" } });
    const readout = h("div", { class: "readout-panel", attrs: { "aria-live": "polite" } });
    const pairsBox = h("div");
    const goals = h("ul", { class: "stack", style: "list-style: none; padding: 0; margin: 0", attrs: { "aria-live": "polite" } });

    const sliders = [];
    function sliderFor(group, p) {
      const el = ui.Slider({
        label: `${group === "buyers" ? "▲ " : "▼ "}${p.name} ${group === "buyers" ? "pays at most" : "takes at least"}`,
        min: PRICE_MIN, max: PRICE_MAX, step: 5, value: p.v,
        format: (v) => "$" + Math.round(v),
        onInput: (v) => { p.v = Math.round(v); draw(); },
      });
      sliders.push({ el, p, start: p.v });
      return el;
    }
    const buyCol = h("div", { class: "stack" }, h("p", { class: "eyebrow", style: "color: var(--bid)", text: "▲ Buyers (want a ticket)" }), people.buyers.map((p) => sliderFor("buyers", p)));
    const sellCol = h("div", { class: "stack" }, h("p", { class: "eyebrow", style: "color: var(--ask)", text: "▼ Sellers (have a ticket)" }), people.sellers.map((p) => sliderFor("sellers", p)));
    const resetBtn = ui.Button({
      label: "Reset the market", variant: "ghost", small: true,
      onClick: () => { for (const s of sliders) { s.p.v = s.start; s.el.api.set(s.start); } draw(); },
    });

    const CHALLENGES = [
      { id: "all", text: "Make all three tickets sell.", test: (r) => r.k === 3 },
      { id: "none", text: "Freeze the market: arrange it so that no trade can happen.", test: (r) => r.k === 0 },
      { id: "one", text: "Squeeze the clearing range down to one single price.", test: (r) => r.k > 0 && r.lo === r.hi },
    ];
    const done = new Set();

    function draw() {
      const r = clearMarket(people.buyers, people.sellers);
      clear(svg);
      // price axis
      svg.appendChild(h("line", { class: "line", x1: CX0 - 6, x2: CX1 + 6, y1: lineY, y2: lineY }));
      for (let v = PRICE_MIN; v <= PRICE_MAX; v += 20) {
        svg.appendChild(h("line", { class: "line", x1: cx(v), x2: cx(v), y1: lineY - 4, y2: lineY + 4 }));
        svg.appendChild(h("text", { x: cx(v), y: lineY + 4 + 3 * ROW + 26, "text-anchor": "middle", class: "t-muted t-mono", text: "$" + v }));
      }
      // clearing band
      if (r.k > 0) {
        const x1 = cx(r.lo), x2 = cx(r.hi);
        svg.appendChild(h("rect", { class: "box-accent", x: Math.min(x1, x2 - 4), y: TOP - 18, width: Math.max(4, x2 - x1), height: H - TOP - 10, rx: 4, style: "opacity: 0.5" }));
        const label = r.lo === r.hi ? `one price: $${r.lo}` : `clears at $${r.lo}–$${r.hi}`;
        const mid = (x1 + x2) / 2;
        const anchor = mid < 160 ? "start" : mid > 340 ? "end" : "middle";
        svg.appendChild(h("text", { x: anchor === "start" ? Math.min(x1, x2 - 4) : anchor === "end" ? Math.max(x2, x1 + 4) : mid, y: TOP - 24, "text-anchor": anchor, class: "t-bold t-accent", text: label }));
      } else {
        svg.appendChild(h("text", { x: (CX0 + CX1) / 2, y: TOP - 24, "text-anchor": "middle", class: "t-bold t-accent", text: "no price works: no trades" }));
      }
      // people, one row each: buyers above the line, sellers below
      const row = (p, y, buy, matched) => {
        const g = h("g", { class: matched ? null : "dim" },
          h("text", { x: 0, y: y + 5, class: "t-bold " + (buy ? "t-bid" : "t-ask"), text: p.name }),
          h("line", { class: "line line-dash", x1: CX0 - 6, x2: cx(p.v), y1: y, y2: y }),
          h("path", { class: buy ? "fill-bid" : "fill-ask", d: buy ? `M ${cx(p.v)} ${y - 8} l 8 13 h -16 z` : `M ${cx(p.v)} ${y + 8} l 8 -13 h -16 z` }),
          h("text", { x: cx(p.v) + (p.v > 125 ? -12 : 12), y: y + 5, "text-anchor": p.v > 125 ? "end" : "start", class: "t-mono", text: "$" + p.v }));
        svg.appendChild(g);
      };
      r.b.forEach((p, i) => row(p, TOP + i * ROW, true, i < r.k));
      r.s.forEach((p, i) => row(p, lineY + 14 + i * ROW + 10, false, i < r.k));

      // readout
      clear(readout);
      if (r.k === 0) {
        readout.append(
          h("p", null, ui.rich(`**No trades.** The keenest buyer, ${r.b[0].name}, pays at most **$${r.b[0].v}**, but the cheapest seller, ${r.s[0].name}, wants at least **$${r.s[0].v}**.`)),
          h("p", null, ui.rich("No price satisfies both, so the market is stuck until someone changes their mind.")));
      } else {
        const ins = r.b.slice(0, r.k).map((p) => p.name).concat(r.s.slice(0, r.k).map((p) => p.name));
        const outs = r.b.slice(r.k).map((p) => `${p.name} (pays at most $${p.v})`).concat(r.s.slice(r.k).map((p) => `${p.name} (wants at least $${p.v})`));
        const range = r.lo === r.hi ? `exactly **$${r.lo}**` : `any price from **$${r.lo}** to **$${r.hi}**`;
        readout.append(
          h("p", null, ui.rich(`**${r.k} ticket${r.k > 1 ? "s" : ""} can change hands.** At ${range}, ${listOf(ins)} are all happy to trade${outs.length ? `, and ${listOf(outs)} stay${outs.length === 1 ? "s" : ""} out` : ""}.`)),
          h("p", { class: "fine" }, ui.rich("Outside that range, either someone in a trade would back out or someone left out would jump in. Real markets find this price by trial and error, through bids and asks.")));
      }

      // pairs, keenest first
      clear(pairsBox);
      const n = Math.min(r.b.length, r.s.length);
      const rows = [];
      for (let i = 0; i < n; i++) rows.push({ i: i + 1, buyer: `${r.b[i].name} ≤ $${r.b[i].v}`, seller: `${r.s[i].name} ≥ $${r.s[i].v}`, ok: r.b[i].v >= r.s[i].v, room: r.b[i].v - r.s[i].v });
      pairsBox.appendChild(ui.Table({
        caption: "Keenest buyer with cheapest seller, then the next pair",
        dense: true,
        columns: [
          { key: "i", label: "Pair" },
          { key: "buyer", label: "▲ Buyer pays at most", align: "left" },
          { key: "seller", label: "▼ Seller takes at least", align: "left" },
          { key: "ok", label: "Can they trade?", align: "left", format: (v, row) => (v ? `✓ yes, room $${row.room}` : "✗ no, buyer's max is below seller's min") },
        ],
        rows,
      }));

      // challenges
      clear(goals);
      for (const c of CHALLENGES) {
        if (c.test(r)) done.add(c.id);
        const ok = done.has(c.id);
        goals.appendChild(h("li", { class: "fine", style: ok ? "color: var(--ok)" : null },
          h("strong", { text: ok ? "✓ " : "○ " }), c.text, ok ? h("span", { class: "sr-only", text: " (done)" }) : null));
      }
    }

    function listOf(items) {
      if (items.length <= 1) return items.join("");
      return items.slice(0, -1).join(", ") + " and " + items[items.length - 1];
    }

    draw();
    return h("div", { class: "stack" },
      ui.Figure({ children: svg, alt: "A price line from $20 to $150. Buyers are drawn above it at their maximum price, sellers below it at their minimum price. A shaded band marks the prices at which every trade that can happen does happen; people who cannot trade are faded." }),
      readout,
      h("div", { class: "grid-2" }, buyCol, sellCol),
      h("div", { class: "btn-row" }, resetBtn),
      pairsBox,
      h("div", { class: "card stack" }, h("p", { class: "eyebrow", text: "Your turn" }), goals));
  }

  /* ------------------------------------------------------------------ the chapter */
  OBZ.chapters.register({
    id: "market",
    number: 1,
    title: "What a market is",
    summary: "Why a price only exists because buyers and sellers value things differently, and what \"bid\" and \"ask\" mean.",
    goals: [
      "Explain why a trade needs a buyer who values something more than its seller does",
      "Read the words bid and ask, and say who posts each",
      "Predict when a buyer and a seller will trade, and in what price range",
      "Say why a busy market needs a system to match buyers with sellers",
    ],
    status: "ready",

    render(el, ctx) {
      const { ui } = ctx;

      // ---------------- Explain
      const ex = ctx.section("explain", "A price is where two opinions meet");
      ex.append(
        ui.prose(`
A [[market]] is any place where [[buyer|buyers]] and [[seller|sellers]] meet to [[trade]]: a farmers' market, a website that resells concert tickets, a stock [[exchange]]. In this course the thing being traded is [[sol|SOL]], the currency of the Solana blockchain, paid for in US dollars. But start smaller.

You have a spare ticket for Saturday's concert. Before you talk to anyone, you know the lowest price you would accept, say $60; for less, you would rather go yourself. Your friend Sam knows the most he would pay, say $90. Each of you has a [[reservation-price|walk-away price]].`),
        ui.prose(`
Any price between $60 and $90 leaves you both better off. At $75 you get $15 more than you needed, and Sam pays $15 less than he was ready to. That is why trades happen at all: the ticket is worth more to Sam than to you, so moving it from you to him helps you both.

If Sam would only pay $50, no price is both at least $60 and at most $50, so there is no trade. And if everyone valued the ticket at exactly the same amount, nobody would gain anything by trading. A [[price]] only appears when people value the same thing differently, and someone values it more than its owner does.`),
        ui.prose(`
People rarely reveal their walk-away price. Instead they make offers. An offer to buy is a [[bid]] ("I'll pay $70"). An offer to sell is an [[ask]] ("I want $80"). A bid is usually below what the buyer would really pay, and an ask above what the seller would really take, because everyone hopes for a better deal. While the highest bid is below the lowest ask, nothing trades; someone has to give in.

Big markets work the same way, with thousands of people. At 04:31 UTC on 18 October 2026 the highest bid for one SOL on [[kraken|Kraken]] was **$103.94** and the lowest ask was **$103.95**. Buyers and sellers disagreed by one cent, and a trade happened each time someone accepted the other side's price.`),
        ui.prose(`
With two people you can just talk. With thousands you need rules: who trades with whom, at what price, and who goes first when two people offer the same thing. An exchange solves this by writing every bid and ask into one list, sorted so the best offers are on top. That list is the [[order-book|order book]], the subject of [chapter 2](#/learn/2).`),
        ui.Callout({
          kind: "real", title: "Nobody sets the price of SOL",
          body: `There is no official price list. "The price of SOL" is just where the latest bids and asks met. A market finding that meeting point, over and over as opinions change, is called [[price-discovery|price discovery]].`,
        }));

      // ---------------- See
      const see = ctx.section("see", "One ticket, two people");
      const fig = buildFigure();
      see.append(
        ui.p("Step through one trade on a price line. Watch for the overlap between what the seller needs and what the buyer will pay."),
        ui.Figure({
          label: "Figure 1.1",
          children: ui.Stepper({ steps: STEPS, stage: fig.svg, render: (i) => applyStep(fig, i), interval: 2800, label: "Two walk-away prices and the deal zone" }),
          caption: "A trade can happen only when the buyer's maximum is at or above the seller's minimum. Bids and asks are the offers people actually show, usually with a gap between them.",
          alt: "A price line from $40 to $120. The seller's minimum is $60 and the buyer's maximum is $90; the shaded deal zone between them is $60 to $90. A price of $75 leaves each side $15 better off. Next, the buyer bids $70 and the seller asks $80, leaving a $10 gap with no trade. Finally the buyer's maximum drops to $50, below the seller's $60, so there is no overlap and no trade.",
        }));

      // ---------------- Try
      const tr = ctx.section("try", "Run a ticket market");
      tr.append(ui.TryIt({
        title: "Six people, three tickets",
        intro: "An example market (not real data): three fans each want one ticket, and three fans each have one to sell. Drag the sliders (or use the arrow keys) to change what each person will pay or accept, and watch which trades become possible and the range of prices that works for everyone. Then try the three tasks at the bottom.",
        children: buildTry(ctx),
      }),
      ui.Callout({
        kind: "tip", title: "What to notice",
        body: `The keenest buyer and the cheapest seller always trade first. Each extra trade needs a buyer who will pay a bit less to meet a seller who wants a bit more, until the next pair no longer overlaps. An order book does exactly this sorting for you: highest bids on top of one side, lowest asks on top of the other.`,
      }));
    },

    quiz: [
      {
        q: "A seller won't take less than **$50** for a ticket. The only buyer will pay at most **$40**. What happens?",
        options: [
          { text: "They trade at $45, halfway between", why: "At $45 the seller gets less than her $50 minimum, so she would walk away. Splitting the difference only works when the ranges overlap." },
          { text: "They trade at $50", why: "$50 is $10 more than the buyer will pay, so he would walk away." },
          { text: "No trade happens", why: "Right. No price is both at least $50 and at most $40. A trade needs the buyer's maximum to be at or above the seller's minimum." },
          { text: "They trade at $40", why: "$40 is $10 below the seller's minimum, so she keeps the ticket." },
        ],
        answer: 2,
      },
      {
        q: "On Kraken the highest bid for SOL was **$103.94** and the lowest ask was **$103.95**. You want to buy one SOL right away. What do you pay?",
        options: [
          { text: "$103.94", why: "That is a bid: another buyer's offer to buy. To buy right away you need a seller, and the cheapest seller asks $103.95." },
          { text: "$103.95", why: "Right. An ask is a seller's price. Buying right away means accepting the lowest ask." },
          { text: "$103.945, halfway between", why: "That's the middle of the gap. Nobody is offering to sell at $103.945; the cheapest seller wants $103.95." },
          { text: "$0.01", why: "$0.01 is the gap between the bid and the ask, not a price for SOL. You pay the seller's ask, $103.95." },
        ],
        answer: 1,
      },
      {
        q: "Imagine everyone in a market, buyers and sellers alike, values a ticket at exactly **$75**. Why would hardly any trades happen?",
        options: [
          { text: "Because $75 is too expensive", why: "The amount itself doesn't matter. The trouble is that buyers and sellers agree: at any price, one of them would be no better off." },
          { text: "Because nobody gains from trading: a trade needs a buyer who values it more than its owner does", why: "Right. If a seller's minimum and a buyer's maximum are both $75, the only possible price is $75 and neither side gains. Trades come from differences in value." },
          { text: "Because there is no exchange to match them", why: "An exchange helps people find each other, but even with one, nobody gains by trading something they value exactly as much as the money." },
          { text: "Because the sellers would all ask $80", why: "Asking more than $75 would scare off every buyer here, since none would pay more than $75. The real reason is that everyone values the ticket the same." },
        ],
        answer: 1,
      },
    ],
  });
})(window.OBZ = window.OBZ || {});
