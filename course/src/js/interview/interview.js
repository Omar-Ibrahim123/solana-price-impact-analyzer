/* interview/interview.js: the #/interview page.
 *   OBZ.interview.render(el, ctx)   the page: question bank, 60-second pitch, flashcards, follow-ups
 *   OBZ.interview.cards             the flashcard deck (whole course; chapter 13 reuses it)
 *   OBZ.interview.questions         the question bank [{id, topic, q, a}]
 *   OBZ.interview.FACTS             every number quoted on this page (one place to update)
 *
 * Answers are written in the owner's voice ("I built…"). Every number comes from FACTS, so when
 * the final 24-hour export lands, update FACTS below and every answer follows. The collector
 * numbers marked "(data)" are computed from the built-in export when the page loads (see
 * collectorFacts), with the written value as the fallback, so they follow the export by themselves.
 */
(function (OBZ) {
  "use strict";
  const { h, fmt, clear } = OBZ.util;

  /* ==========================================================================================
   * FACTS: the numbers quoted on this page. UPDATE HERE when the final 24-hour export lands.
   * Sources: README / data/live-2026-10-18 (04:31 snapshot), course/data/export.json (collector,
   * interim: first ~hour, 10 ticks), data/collect.log, git history, benchmarks (README table).
   * ======================================================================================== */
  /** Numbers that come from the collector's time series, computed from the built-in export. */
  function collectorFacts() {
    const out = {};
    try {
      const ds = OBZ.data.builtin();
      const ts = ds && ds.timeseries;
      const med = (arr) => {
        const v = (arr || []).filter((x) => typeof x === "number" && isFinite(x)).sort((a, b) => a - b);
        if (!v.length) return null;
        const m = Math.floor(v.length / 2);
        return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
      };
      if (ts && Array.isArray(ts.t) && ts.t.length > 1 && ts.series) {
        const S = ts.series, n = ts.t.length, hours = (ts.t[n - 1] - ts.t[0]) / 3600;
        out.coverage = `${n} snapshot rounds over ${fmt.num(hours, 1)} hours`;
        const rt = (k, usd) => (S[k] && S[k].round_trip_bps ? med(S[k].round_trip_bps[String(usd)]) : null);
        for (const [name, key] of [["jup", "jupiter:best"], ["kraken", "kraken"], ["coinbase", "coinbase"]]) {
          for (const [suffix, usd] of [["10k", 10000], ["100k", 100000]]) {
            const v = rt(key, usd);
            if (v !== null) out[`${name}Rt${suffix}`] = fmt.bps(v);
          }
        }
        if (S.phoenix && S.phoenix.mid && ts.ref_mid) {
          const g = med(S.phoenix.mid.map((m, i) => (m && ts.ref_mid[i] ? (ts.ref_mid[i] - m) / ts.ref_mid[i] * 1e4 : null)));
          if (g !== null && g > 50) out.ownMidGap = `about ${fmt.int(Math.round(g / 10) * 10)} bps`;
        }
        const fee = ((ds.venues || []).find((v) => v.venue === "phoenix") || {}).feeBps;
        const ours = S.phoenix && S.phoenix.cost_bps_vs_ref && S.phoenix.cost_bps_vs_ref.buy && S.phoenix.cost_bps_vs_ref.buy["1000"];
        const jup = S["jupiter:Phoenix"] && S["jupiter:Phoenix"].cost_bps_vs_ref && S["jupiter:Phoenix"].cost_bps_vs_ref.buy && S["jupiter:Phoenix"].cost_bps_vs_ref.buy["1000"];
        if (ours && jup && isFinite(fee)) {
          const a = med(ours.map((x) => (typeof x === "number" ? x + fee : null))), b = med(jup);
          if (a !== null && b !== null) out.decoderGap = `about ${fmt.num(Math.max(0.1, Math.abs(a - b)), 1)} bps`;
        }
      }
      const best = (ds.jupiter || []).filter((q) => q.dex === "best" && q.ok !== false && Array.isArray(q.route));
      if (best.length) {
        const countBy = new Map();
        for (const q of best) for (const r of new Set(q.route.map((x) => (typeof x === "string" ? x : x && x.label)).filter(Boolean))) countBy.set(r, (countBy.get(r) || 0) + 1);
        const top = Array.from(countBy).filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([r]) => r).slice(0, 4);
        if (top.length) out.propAmms = top.length > 1 ? top.slice(0, -1).join(", ") + " and " + top[top.length - 1] : top[0];
      }
      const solfi = (ds.jupiter || []).filter((q) => q.dex === "SolFi" && q.ok !== false).map((q) => q.usd);
      if (solfi.length) out.solfiMax = fmt.usdCompact(Math.max(...solfi));
    } catch (e) { /* keep the written fallbacks */ }
    return out;
  }

  const FACTS = {
    // ---- the 04:31 UTC snapshot (README findings table)
    snapshotWhen: "18 Oct 2026 at 04:31 UTC",
    snapshotSlot: "458,302,883",
    phoenixSpread: "57.7 bps",
    cexSpread: "about 1 bps",
    phoenixDepth2pct: "$5.2K of bids and $47.1K of asks",
    cexDepth2pct: "millions of dollars on each side",
    phoenix1kBuy: "28.8 bps",                 // impact vs own mid, mostly half the spread
    phoenixMaxBuy: "$47K",                    // what a protected buy could fill
    kraken1mBuy: "10.2 bps", coinbase1mBuy: "17.2 bps",
    junkBid: "$0.001", junkAsk: "$9,999,999,999",
    unprotectedAvg: "$692", unprotectedBps: "about 56,000 bps",
    // ---- the collector (interim export: first ~hour; final numbers come with the 24 h run)
    runStart: "05:09 UTC on 18 Oct",
    vanishedBid: "a 50-SOL bid at $103.75",
    nextBid: "$89.04",
    spreadAfter: "about 1,584 bps",
    coverage: "the first snapshot rounds",    // (data) how much of the run this export holds
    ownMidGap: "about 650 bps",               // (data) Phoenix's own mid below the reference mid (median)
    protectedSellAt: "$89, 14% below the market",
    phoenixActivity: "about one change to its sequence number every 40–50 minutes",
    // (data) median half round trips, formatted like chapter 11 (fmt.bps)
    jupRt10k: "0.40 bps", jupRt100k: "1.00 bps", // Jupiter best route
    krakenRt10k: "0.91 bps", krakenRt100k: "2.97 bps",
    coinbaseRt10k: "1.13 bps", coinbaseRt100k: "4.02 bps",
    propAmms: "Kipseli, TesseraV, GoonFi V2 and BisonFi", // (data) labels on most best routes
    solfiMax: "$10K",                         // (data) largest size with a SolFi route via Jupiter
    feeKraken: "40 bps", feeCoinbase: "120 bps", feePhoenix: "2 bps",
    decoderGap: "about 0.2 bps",              // (data) ours + Phoenix's fee vs Jupiter through Phoenix, $1K buy medians
    ticksPerDay: "288", quotesPerTick: "48", tickSeconds: "about 105 seconds",
    jupiterLimit: "5 requests per 10 seconds",
    // ---- engineering
    benchRate: "about 758,000 events per second",
    benchCancel: "about 600 ns", benchAdd: "1.1–1.7 µs", benchMarket: "about 4 µs", benchCancelMiss: "about 110 ns",
    goldenOps: "2,000",
    mutationBugs: "8",                        // python -m benchmarks.mutation_check: realistic bugs planted
    mutationCaught: "all 8",                  // ...and how many the tests caught
    accountBytes: "about 1.7 MB",             // Phoenix SOL/USDC market account (1,723,488 bytes)
  };
  Object.assign(FACTS, collectorFacts());
  const F = FACTS;

  /* ==========================================================================================
   * Question bank
   * ======================================================================================== */
  const TOPICS = [
    { id: "overview", label: "The project" },
    { id: "books", label: "Order books" },
    { id: "ds", label: "Data structures" },
    { id: "solana", label: "Solana & Phoenix" },
    { id: "amm", label: "AMMs" },
    { id: "testing", label: "Testing" },
    { id: "design", label: "System design" },
    { id: "behavioural", label: "Behavioural" },
  ];

  const questions = [
    // ---------------------------------------------------------------- the project
    { id: "ov-walk", topic: "overview", q: "Walk me through your project.",
      a: `I wanted to know what it really costs to trade SOL on an on-chain order book, so I built a tool that measures it. It downloads Phoenix's SOL/USDC market account from Solana, decodes the raw bytes into an order book, and loads that book into my own price-time priority matching engine. Then it simulates market orders from $1K to $1M and measures the price impact in basis points. It does the same for Kraken and Coinbase, fetched at the same moment.

Version 2 turned it into a research tool: a collector, built to run for 24 hours, that snapshots every venue every 5 minutes into SQLite, with real Jupiter quotes for Solana's AMM routes, plus metrics, a report, and this course. The headline: on ${F.snapshotWhen} Phoenix's spread was ${F.phoenixSpread} against ${F.cexSpread} on Kraken, and the cheapest route of all was Jupiter, mostly through prop AMMs.` },
    { id: "ov-why", topic: "overview", q: "Why did you build this?",
      a: `Two reasons. I wanted to understand order books from the bottom up, and the best way I know is to build the engine myself and test it against real data. And price impact is the number on-chain exchanges compete on. "How much does a large trade move the price here, compared with Coinbase?" is a question with a measurable answer, so I measured it, with the same engine and the same method for every venue, so the differences come from the books, not from my code.` },
    { id: "ov-found", topic: "overview", q: "What did you find?",
      a: `Three things. First, the Phoenix Legacy SOL/USDC book was thin when I measured it: a ${F.phoenixSpread} spread against about 1 bps on Kraken and Coinbase, and only ${F.phoenixDepth2pct} within 2% of the mid, where the exchanges had ${F.cexDepth2pct}. Second, the cheapest place to trade was Jupiter's best route, mostly through venues Jupiter labels ${F.propAmms}, which are mostly prop AMMs run by market makers: about ${F.jupRt100k} for a half round trip at $100K, against ${F.krakenRt100k} on Kraken. Third, for a small trader on an exchange, the fee is the cost: Kraken's base-tier taker fee is ${F.feeKraken}, against a trading cost of about ${F.krakenRt10k} at $10K.` },
    { id: "ov-limits", topic: "overview", q: "What are the limitations of your data?",
      a: `I try to say these first. Quotes aren't trades: a snapshot shows what could have traded at that instant, not what a real order would have got once makers react. The exchange books are aggregated by price, and Kraken returns at most 500 levels. The fees I show are base tier; large traders pay much less. The collector was built for one day of 5-minute snapshots (the export this course uses holds ${F.coverage}), so I miss everything in between. And I measured Phoenix Legacy's SOL/USDC spot market, not Phoenix Perpetuals, so I wouldn't generalise from it to Phoenix as a whole.` },
    { id: "ov-next", topic: "overview", q: "What would you do with another month?",
      a: `Move from snapshots to events. Phoenix emits every market event (fills, places, reduces, evictions and fees) through a self-CPI "log" instruction, a call the program makes to itself so the event is recorded in the transaction. I'd parse those events from the market's transactions, which captures changes inside a slot that account snapshots miss, then replay the stream through my engine and check that I reproduce the next snapshot exactly. That would let me measure resilience (how fast the book refills after a big trade), which my TWAP model currently has to assume. I'd also run the collector for weeks instead of a day, and look at Phoenix Perpetuals if its account is readable the same way.` },

    // ---------------------------------------------------------------- order books
    { id: "ob-basics", topic: "books", q: "What is an order book? Define the spread and the mid.",
      a: `It's two sorted queues of limit orders: bids, buyers' prices, highest first; and asks, sellers' prices, lowest first. The best bid and best ask face each other at the top. The spread is best ask minus best bid, and the mid is halfway between them. I quote both relative to the price in basis points, where 1 bps is 0.01%, so a 10-cent spread on a $100 asset is 10 bps.` },
    { id: "ob-impact", topic: "books", q: "How do you define and measure price impact?",
      a: `I send a market order of a given dollar size into a copy of the book and record the fills. Impact is the average fill price against the mid, in bps: (average − mid) ÷ mid × 10,000 for a buy, with the sign flipped for a sell. It includes half the spread, which is why even a tiny order has impact. In version 2 I also measure cost against a reference mid, the average of the Kraken and Coinbase mids, because a venue's own mid can be wrong and an AMM route has no order-book mid of its own.` },
    { id: "ob-spread-depth", topic: "books", q: "When does the spread matter, and when does depth?",
      a: `The spread decides small trades: a $1K order fills at or next to the best price, so it pays about half the spread. On Kraken in my snapshot a $1K buy cost 0.86 bps against a half-spread of 0.48 bps, because the best ask held only 5.9 SOL. Depth decides large trades: a $1M order walks down the book, so what matters is how much sits near the mid. In my snapshot, Phoenix's $1K buy cost ${F.phoenix1kBuy}, almost all half-spread. On Kraken and Coinbase a $1M buy cost ${F.kraken1mBuy} and ${F.coinbase1mBuy}, because they had ${F.cexDepth2pct} within 2%.` },
    { id: "ob-ptp", topic: "books", q: "Explain price-time priority.",
      a: `Better price fills first. At the same price, the order that arrived first fills first: a FIFO queue per price level. Trades print at the resting maker's price, not the taker's limit. And a maker that's only partly filled keeps its place at the front of the queue, because moving it back would punish it for being hit. My engine enforces all of that, and the property tests compare it with a naive model after every step.` },
    { id: "ob-spread-jump", topic: "books", q: "Why did Phoenix's spread jump from 57.7 to about 1,584 bps?",
      a: `One order. At 04:31 the best bid was ${F.vanishedBid}. When the collector started, that bid was gone, and the next bid down was at ${F.nextBid}. On a thin book a single order can be the whole top of the book, so one cancel moved the spread to ${F.spreadAfter} and dragged Phoenix's own mid ${F.ownMidGap} below the market. It's a vivid picture of what "thin" means.` },
    { id: "ob-protection", topic: "books", q: "What are junk quotes, and what is price protection?",
      a: `Phoenix's account held bids at ${F.junkBid} and asks at ${F.junkAsk}. Nobody expects them to trade, but a market order with no limit fills against whatever is there: an unlimited $1M buy averaged ${F.unprotectedAvg} per SOL, an impact of ${F.unprotectedBps}. Real traders send a limit, so every simulated order stops 10% from the market and reports a partial fill instead. In version 2 the band is centred on the reference mid, because centring it on Phoenix's own mid let a "protected" sell fill at ${F.protectedSellAt}. The 10% is a choice, not a derived number; it's a command-line flag.` },

    // ---------------------------------------------------------------- data structures
    { id: "ds-structures", topic: "ds", q: "What data structures does your engine use, and why?",
      a: `Three. A sorted map from price to level on each side (Python's SortedDict), so the best price is at one end and a new level goes in at O(log L). Each level is a doubly linked list of orders, oldest at the head, which gives FIFO and lets me unlink any order in O(1). And a hash map from order id to its node, so a cancel jumps straight to the order instead of searching. Each level also caches its total size so depth queries don't walk the list.` },
    { id: "ds-heap", topic: "ds", q: "Why not use a heap for the best price?",
      a: `A heap gives you the best price cheaply, but the book needs more than that. A new order has to find its own price level, and when a level empties it has to be removed from the middle. A plain heap can't look up by price, and it can't find an arbitrary entry without an extra index: with a position map it can delete one in O(log n), otherwise you end up with lazy deletion and stale entries. A sorted map does all three directly: best price, lookup and removal.` },
    { id: "ds-complexity", topic: "ds", q: "What's the complexity of add, cancel and a market order?",
      a: `Adding an order that joins an existing level is O(1); one that creates a new level is O(log L), where L is the number of levels on that side. Cancel is O(1) through the id map, plus O(log L) only if it empties its level. Matching m orders across k levels is O(m + k log L): each fill is constant time, and each emptied level costs a removal from the sorted map.` },
    { id: "ds-bench", topic: "ds", q: "What did your benchmark show, and what doesn't it show?",
      a: `Replaying a million random operations, the pure-Python engine did ${F.benchRate}. A cancel took ${F.benchCancel}, an add ${F.benchAdd} (the new-level case is slower: that's the O(log L) insert), and a market order ${F.benchMarket} with a long tail when it sweeps several levels. A cancel of an already-filled order is just a dictionary miss, ${F.benchCancelMiss}. What it doesn't show is production speed: it's Python with method-call overhead. It confirms the relative costs match the complexity analysis.` },
    { id: "ds-faster", topic: "ds", q: "How would you make the engine much faster?",
      a: `Rewrite the hot path in a compiled language like Rust, and stop allocating: preallocate orders in an array and reuse slots with a free list, which is exactly what Phoenix does in its account. Use integer ids as array indexes instead of hash lookups where possible. For a dense price range, index levels directly by tick instead of a tree. Keep it single-threaded per market so there are no locks, and move everything that isn't matching (validation, market data) off that thread.` },

    // ---------------------------------------------------------------- Solana & Phoenix
    { id: "sol-layout", topic: "solana", q: "How is a Phoenix market stored on chain?",
      a: `In one Solana account, ${F.accountBytes} for SOL/USDC. It starts with a 576-byte header (sizes, mints, tick and lot sizes, sequence number), then padding and a few market fields, then the bids and the asks, each a red-black tree laid out in a fixed array of 64-byte nodes, then the trader seats. Tree links are array indexes, not pointers, and freed nodes go on a free list to be reused. Everything is preallocated when the market is created. A program can grow its account, but only by 10 KiB per instruction, up to 10 MiB, and a bigger account needs more rent, so Phoenix sizes the whole market up front and works on that fixed layout in place.` },
    { id: "sol-integers", topic: "solana", q: "Why integers instead of floats?",
      a: `Mostly exactness. Floats round: 0.1 + 0.2 is 0.30000000000000004. That is the same on every machine, since IEEE 754 fixes each basic operation and Solana runs floats in software, so validators would agree. But money has to be exact to the last atom, token balances are integers anyway, a price used as a map key must compare equal to itself, and integer maths costs less compute. Floats only disagree between machines when the order of operations isn't pinned down, as with fast-math or parallel sums, which is why some chains ban them outright. So Phoenix stores prices in ticks and sizes in lots, both integers, and so does my engine, end to end. I only convert to dollars and SOL at the edges, for display and for measuring impact.` },
    { id: "sol-decode", topic: "solana", q: "How did you decode the account, and how do you know it's right?",
      a: `I fetch the raw bytes with getAccountInfo and decode them with Python's struct module, using one layout table that matches Ellipsis Labs' own Python client. I check it three ways. Unit tests decode an account I encode myself. I inspect real bytes, which is how I found a bug my own tests couldn't. And the strongest check: Jupiter quotes a trade through Phoenix using its own reader of the same account, and my engine on my decoded book agrees with it within ${F.decoderGap} once I add Phoenix's ${F.feePhoenix} fee (medians of the $1,000 buy across the collector run).` },
    { id: "sol-crankless", topic: "solana", q: "What does crankless mean?",
      a: `Phoenix settles a trade inside the same instruction that matches it. Older Solana order books like Serum matched first and pushed results into an event queue, and someone had to send separate "crank" transactions to finish the trades. Crankless means one transaction does the whole thing, so there's no backlog to process and no extra party to pay.` },
    { id: "sol-constraints", topic: "solana", q: "What constraints does an on-chain order book face that a centralised exchange doesn't?",
      a: `Every validator runs the program, so it must be deterministic and fit a compute budget per transaction. State lives in accounts, which a program can only grow slowly (10 KiB per instruction) and which cost rent, so Phoenix preallocates the book and it has a hard capacity. And the whole market is one account: Solana only runs two transactions in parallel when neither writes an account the other uses, so every trade on one market is serialised, in the order the slot's leader puts them in the block. On top of that, every quote update a market maker sends is a transaction with a fee and a slot of latency, which makes deep, tight quoting harder than on a CEX.` },
    { id: "sol-slot", topic: "solana", q: "Why record the Solana slot?",
      a: `A slot is Solana's clock tick, about 400 ms, and slot numbers only go up. Recording the slot of each Phoenix snapshot pins it to a moment in the chain's own time, so I can line it up with Jupiter's quotes, which report the slot they were computed at. Without it I'd only have my laptop's clock, which says when I received the data, not which state of the chain it describes.` },

    // ---------------------------------------------------------------- AMMs
    { id: "amm-xyk", topic: "amm", q: "How does a constant-product AMM price a trade?",
      a: `The pool holds x USDC and y SOL and keeps x × y = k constant. Its spot price is x ÷ y. If I buy SOL with dx USDC, the pool now has x + dx USDC, so it must keep y' = k ÷ (x + dx) SOL, and I receive y − y'. Every unit I buy moves the price along the curve, so impact grows smoothly with size: roughly dx ÷ x for small trades, which means doubling the pool roughly halves the impact.` },
    { id: "amm-vs-book", topic: "amm", q: "How is an AMM different from an order book?",
      a: `A book is a list of individual promises at chosen prices; you walk through them. An AMM is a formula over a pool: the price follows a curve. A real pool's fee acts like a half-spread, so buying and selling at the same moment differ by about twice the fee; only the fee-free x·y=k model gives you the first dollar at the spot price. The book's edge is that makers can stack depth near the mid. In version 1 I sized a fee-free x·y=k pool to hold the same dollars within 2% as the Phoenix book: it beat Phoenix at $1K because, with no fee, it had no spread, but its curve was steeper further out.` },
    { id: "amm-prop", topic: "amm", q: "What is a prop AMM, and where does SolFi fit?",
      a: `A prop AMM is a pool run by one professional market maker whose program reprices it from the firm's own model, instead of a fixed curve anyone can provide liquidity to. Much of Solana's SOL/USDC flow now goes through them. SolFi is Ellipsis Labs' prop AMM. In my data Jupiter found SolFi routes up to ${F.solfiMax}, but no route through SolFi at larger sizes, while other prop AMMs carried the large best-route quotes.` },
    { id: "amm-jupiter", topic: "amm", q: "Why was Jupiter's route the cheapest?",
      a: `Jupiter is an aggregator: it searches many pools and books and splits the trade across them, so it gets the best of all of them at once. Its best routes mostly went through venues Jupiter labels ${F.propAmms}, mostly prop AMMs run by market makers, which quote tightly. The half round trip was about ${F.jupRt10k} at $10K and ${F.jupRt100k} at $100K, against ${F.krakenRt10k} and ${F.krakenRt100k} on Kraken. The caveat is the same as for books: these are quotes, not executed trades. Jupiter's quotes do include the pools' fees.` },
    { id: "amm-fair", topic: "amm", q: "How did you compare AMM routes with order books fairly?",
      a: `Three choices. One yardstick: every cost is measured against the same reference mid, the Kraken–Coinbase average at that tick, because a pool has no mid of its own. Same sizes and both sides: buy and sell at $1K to $1M. And the half round trip: I quote the buy and the sell back to back and take half the gap between them. That barely depends on the reference mid, or on slow drift over the minutes the whole quote grid takes; it doesn't cancel a move in the couple of seconds between the buy quote and the sell quote. Fees are kept in a separate column.` },

    // ---------------------------------------------------------------- testing
    { id: "t-engine", topic: "testing", q: "How did you test the matching engine?",
      a: `Hand-written unit tests for the scenarios I could think of, then Hypothesis for the ones I couldn't. Its stateful test runs random adds, cancels, market orders and IOC orders against my engine and, in lockstep, against a deliberately naive reference model, and requires identical fills after every step. It also checks invariants after every step: the book is never crossed, the linked lists are intact, the id map is exact, and lots are conserved. When something fails, Hypothesis shrinks it to the shortest sequence that still fails. To test the tests, \`python -m benchmarks.mutation_check\` plants ${F.mutationBugs} realistic bugs in the engine, one at a time; the tests catch ${F.mutationCaught}.` },
    { id: "t-differential", topic: "testing", q: "What is differential testing, and why a naive model?",
      a: `You run two implementations of the same rules and require identical outputs. My reference model is one flat list of orders: to match, sort the other side by price and arrival and walk it. It's far too slow for real use, O(n log n) per order, but every line can be checked by eye. So when the fast engine and the model disagree, I know which one to suspect, and Hypothesis hands me a minimal sequence that shows the difference.` },
    { id: "t-golden", topic: "testing", q: "How do you know the course's JavaScript engine matches Python?",
      a: `Golden tests. A script runs about ${F.goldenOps} random operations through the Python engine and saves every fill. The browser test page replays the same operations through the JavaScript port and requires identical fills, and it checks that impact numbers on the real snapshots match Python's to the bit. So the engine in the course is the project's engine, not an approximation of it.` },
    { id: "t-collector", topic: "testing", q: "How did you test the collector without hitting real APIs?",
      a: `Everything the collector depends on is injectable: the clock, sleep, the fetchers, the HTTP transport. Tests use a fake clock and fake venues to check aligned ticks, one venue failing while the others are stored, a 429 that honours Retry-After, resume skipping stored ticks, and Ctrl+C finishing the current tick. Recorded API responses are fixtures, so the default test run is offline; live smoke tests are marked separately.` },
    { id: "t-invariants", topic: "testing", q: "What invariants must a matching engine always keep?",
      a: `The book is never crossed after an operation: best bid below best ask, otherwise a match was skipped. No lots are created or destroyed: everything added is resting, cancelled or traded. FIFO within a level, and partial fills keep their place. Fills print at the maker's price and never beyond the taker's limit. Cancelling an unknown or already-filled order is a harmless no-op. An IOC order never rests. And no empty levels left behind, since they would report a best price nobody is quoting.` },

    // ---------------------------------------------------------------- system design
    { id: "sd-collector", topic: "design", q: "Walk me through the collector's design.",
      a: `Every 5 minutes, on wall-clock boundaries, it fetches all three books at the same moment, one thread per venue, plus the Solana slot. It computes the reference mid, then asks Jupiter for ${F.quotesPerTick} quotes, paced to the free tier's ${F.jupiterLimit}, which takes ${F.tickSeconds}. The whole tick is written to SQLite in one transaction. Failures are recorded per venue, retries use exponential backoff and honour Retry-After, --resume continues a run and skips stored ticks, and Ctrl+C finishes the current tick. The run used a git worktree pinned to one commit, so my development couldn't change it mid-run.` },
    { id: "sd-failure", topic: "design", q: "What happens when one venue fails?",
      a: `Nothing else does. Each venue is fetched in its own thread and its exceptions are caught, so a Kraken timeout becomes a Kraken row with ok = 0, the number of attempts and the error, while Phoenix and Coinbase are stored as normal. Transient errors (timeouts, 429, 5xx) are retried up to 3 times; a 400 like Jupiter's "no route" isn't, because it would just repeat. If both exchanges fail, the reference mid falls back to the last known value.` },
    { id: "sd-sqlite", topic: "design", q: "Why SQLite and not Parquet?",
      a: `It fits the workload. SQLite is in Python's standard library, a tick lands in one transaction so a crash never leaves half of it, a unique key makes restarts safe, and WAL mode lets status and report read while the collector writes. The data is ${F.ticksPerDay} ticks a day, tiny. Parquet is better for columnar scans over millions of rows and is written whole, which is awkward for appending every 5 minutes. At exchange scale I'd append to a log and compact into Parquet partitioned by day and market.` },
    { id: "sd-exchange", topic: "design", q: "How would you design the matching engine of a real exchange?",
      a: `A gateway authenticates, rate-limits and validates orders; a risk check confirms balances. Then a sequencer gives every order one place in a total order and writes it to a durable log. One single-threaded engine per market consumes that log: no locks, deterministic, and replaying the log rebuilds the book exactly, which is also how you recover from a crash. Fills and book updates fan out to market data subscribers, and settlement updates balances afterwards. Scale comes from sharding markets across engines, not from threads inside one book.` },
    { id: "sd-scale", topic: "design", q: "How would your project scale to every market on every venue?",
      a: `The design already separates the pieces, so each scales on its own. Fetching becomes a pool of workers per venue with a shared rate limiter, and websocket or account-subscription streams instead of 5-minute polling. Storage becomes an append-only log compacted into Parquet by day, venue and market. Metrics are computed per snapshot and cached with a version number, so they parallelise across machines. The engine already runs one book at a time, which is the natural shard.` },
    { id: "sd-race", topic: "design", q: "A cancel arrives a microsecond after the order filled. What should happen?",
      a: `It should be a harmless no-op. The engine looks up the id, finds nothing, and returns false; it doesn't raise and it doesn't change the book. The client gets a cancel reject and already has, or is about to get, the fill. Cancels must be idempotent, because this race is normal, not an edge case. My property tests deliberately cancel filled and already-cancelled ids, and the benchmark times that case separately (${F.benchCancelMiss}).` },

    // ---------------------------------------------------------------- behavioural
    { id: "b-bug", topic: "behavioural", q: "What was the hardest bug?",
      a: `A bug in my Phoenix decoder that no unit test could catch. Phoenix keeps its bids tree in reverse key order, best price first, and stores bid sequence numbers bit-flipped, so that under that reversed order the oldest bid still comes first at each price. My decoder reads the raw nodes and sorts them itself, and it sorted bids by the stored value, which put the newest bid first. Prices and impact were unaffected, since everything at one price fills at that price, but which maker fills first was wrong. My tests passed because I'd encoded the test accounts with the same wrong assumption. I found it by looking at real bytes: un-flipped, the bid numbers fall in the same range as the asks'. Lesson: test against reality, not only against yourself.` },
    { id: "b-wrong", topic: "behavioural", q: "Tell me about a time you were wrong.",
      a: `I centred the 10% price protection on each venue's own mid, which seemed obviously right. Within an hour of collecting, Phoenix's best bid vanished, its own mid fell ${F.ownMidGap} below the market, and my "protected" sell was filling at ${F.protectedSellAt}. The numbers looked plausible, which is what made it dangerous. I changed the band to centre on a reference mid from Kraken and Coinbase, kept the old version as a secondary column so the two can be compared, and versioned the metrics so no cached old numbers got mixed in.` },
    { id: "b-different", topic: "behavioural", q: "What would you do differently?",
      a: `Start collecting on day one, even with rough code, because data takes time and code can be rerun on saved data; that's why I keep raw bytes. Anchor measurements on an external reference from the start, instead of trusting each venue's own mid. And handle the "tick overran" case before starting the long run: my first tick took ${F.tickSeconds} and spilled into the next slot, which the pinned code skipped, leaving one gap. I fixed it five minutes later but kept the run on its pinned commit for consistency.` },
    { id: "b-ai", topic: "behavioural", q: "How did you use AI tools on this project?",
      a: `(Make this answer your own.) A truthful shape: I used an AI coding assistant as a pair programmer for a lot of the typing and for reviews. I chose the questions and the design, read every change, and insisted on evidence: tests, real bytes, and independent cross-checks such as Jupiter's quote through Phoenix. The two fixes I'm proudest of, the bid-ordering bug and anchoring protection on the reference mid, came from checking outputs against reality rather than trusting them.` },
    { id: "b-why", topic: "behavioural", q: "Why Ellipsis Labs?",
      a: `(Make this answer your own.) A starting point: I decoded Phoenix's market account byte by byte and measured its book against two big exchanges, and SolFi showed up in my own data as part of where Solana's liquidity now trades. I'd like to work on the systems I've only measured from outside, with people who think about matching engines, determinism and market structure every day.` },
    { id: "b-learned", topic: "behavioural", q: "What did you learn?",
      a: `That the matching loop is the easy part; trusting the data is the hard part. Junk quotes, a mid that drifts, a decoder that passes its own tests while being wrong, a slot skipped on the first tick. Each was caught by checking against something independent: the reference mid, real bytes, Jupiter's quote, the log. I also learned to write down the limits of a result before presenting it.` },
  ];

  /* ==========================================================================================
   * Likely follow-ups (short answers)
   * ======================================================================================== */
  const followUps = [
    { q: "Why every 5 minutes, not every second?", a: `Jupiter's free tier allows ${F.jupiterLimit}, and ${F.quotesPerTick} quotes per tick take ${F.tickSeconds}. Five minutes leaves headroom and still gives ${F.ticksPerDay} ticks a day, enough for hour-of-day patterns. Finer data needs streams, not polling.` },
    { q: "Why REST snapshots instead of websockets?", a: "For 5-minute sampling, a snapshot is simpler and self-contained. For event-level data (every add, cancel and fill) I'd subscribe to Phoenix account updates and exchange websockets and replay them." },
    { q: "Is Phoenix really that thin?", a: "This one market, Phoenix Legacy SOL/USDC, was thin on that day. Much SOL/USDC flow now goes through prop AMMs, and I didn't measure Phoenix Perpetuals. I'd say exactly that rather than generalise." },
    { q: "Why does Jupiter's Phoenix quote cost slightly more than your engine?", a: `Jupiter includes Phoenix's ${F.feePhoenix} taker fee; my impact number doesn't. Add the fee and they agree within ${F.decoderGap} (medians of the $1,000 buy).` },
    { q: "What is the half round trip, and why use it?", a: "Buy $X and sell $X back to back, take half the gap between the average prices, over the reference mid. It equals the mean of the buy and sell costs, so it barely depends on the reference mid or on slow drift during the quote grid. It doesn't cancel a price move in the couple of seconds between the two quotes." },
    { q: "Does splitting a big order (TWAP) help?", a: "On deep books the impact it saves is small, while waiting exposes the order to price moves. That is risk, not an expected cost, unless the market trends against you or others see your flow and trade ahead of it. My model also has to assume how fast the book refills (resilience), which snapshots can't measure, so I report it as an assumption." },
    { q: "Why keep the raw Phoenix bytes?", a: "So a decoder bug found later can be fixed and the whole run re-decoded. The bid-ordering bug is exactly that kind of bug." },
    { q: "What does a 429 mean, and what do you do?", a: "Too Many Requests. I wait as long as Retry-After (or Jupiter's x-ratelimit-reset) says, capped at 60 s, then retry; otherwise exponential backoff with jitter, up to 3 retries." },
    { q: "How did you keep development from disturbing the collector run?", a: "The run used its own git worktree pinned to the commit that started it, and report and export open the database read-only." },
    { q: "Why quote Jupiter with ExactIn?", a: "Many prop AMMs don't support ExactOut. For a sell I send $X worth of SOL at the reference price, so both sides are about $X." },
    { q: "What if both exchanges are down?", a: "The reference mid falls back to the last known value so the Jupiter grid can still run, and the venue rows record the failures." },
    { q: "Why is your engine single-threaded?", a: "Matching must be deterministic: the same orders in the same sequence always give the same book. One thread per market needs no locks, and scaling comes from sharding markets." },
  ];

  /* ==========================================================================================
   * Flashcards: the whole course, chapter by chapter
   * ======================================================================================== */
  const cards = [
    { id: "bid-ask", q: "Bid, ask: which is which?", a: "A bid is a buyer's price (the most they'll pay). An ask is a seller's price (the least they'll accept). Bids sit below asks in a healthy book." },
    { id: "spread-mid", q: "Best bid $99.95, best ask $100.05. Spread and mid?", a: "Spread = 100.05 − 99.95 = $0.10. Mid = $100.00. In bps: 0.10 ÷ 100 × 10,000 = 10 bps." },
    { id: "bps", q: "What is a basis point?", a: "One hundredth of a percent: 1 bps = 0.01%, 100 bps = 1%. Traders use it to compare costs across prices." },
    { id: "maker-taker", q: "Maker or taker: who sets the trade price?", a: "The maker: the order that was already resting. The incoming taker trades at the maker's price, and usually pays the higher fee." },
    { id: "limit-market", q: "Limit order vs market order?", a: "A limit order names the worst price you'll accept and may rest in the book. A market order takes whatever is there right now, at any price, unless something limits it." },
    { id: "ptp", q: "What is price-time priority?", a: "Better price fills first; at the same price, whoever arrived first fills first. A partial fill keeps its place in the queue." },
    { id: "ioc", q: "What does IOC mean?", a: "Immediate-or-cancel: trade what you can right now at your limit or better, cancel the rest. It never rests in the book, so it is always a taker." },
    { id: "impact", q: "What is price impact?", a: "How much worse your average fill is than the mid before you traded, in basis points: (average fill − mid) ÷ mid × 10,000. It grows with trade size and shrinks with depth." },
    { id: "spread-depth", q: "Spread or depth: which matters when?", a: "The spread sets the cost of small trades (you pay half of it). Depth sets the cost of big trades (how far down the book you must walk)." },
    { id: "walk", q: "Asks: 2 SOL at $100, 3 SOL at $101. Buy 4 SOL. Average price?", a: "2 × 100 + 2 × 101 = $402 for 4 SOL, so $100.50 on average." },
    { id: "structures", q: "The engine's three data structures?", a: "A sorted map of price → level (best price, new levels in O(log L)), a doubly linked list per level (FIFO, unlink in O(1)), and a hash map id → node (cancel in O(1))." },
    { id: "cancel-o1", q: "Why is cancel O(1) in the engine?", a: "A hash map from order id to its node finds the order instantly, and the doubly linked list lets it unlink without scanning. Only emptying a level costs O(log L)." },
    { id: "heap", q: "Why not a heap for the book?", a: "A plain heap can't look up a level by price, and can't find an arbitrary entry without an extra index (with a position map it can delete in O(log n)). A sorted map does both directly and still gives the best price." },
    { id: "integers", q: "Why ticks and lots instead of floats?", a: "Money must be exact: floats round (0.1 + 0.2 = 0.30000000000000004, the same on every machine, but wrong). Token amounts are integers anyway, an exact price is a reliable key, and integer maths costs less compute." },
    { id: "ticks-lots", q: "Tick size $0.001, lot size 0.001 SOL. What is 104,350 ticks × 25,000 lots?", a: "Price 104,350 × 0.001 = $104.35; size 25,000 × 0.001 = 25 SOL." },
    { id: "account", q: "What is a Solana account?", a: "An array of bytes with an address and an owner program. Programs hold no state; all state lives in accounts that anyone can read. The owner can grow an account only slowly (10 KiB per instruction), so Phoenix preallocates its whole market." },
    { id: "slot", q: "What is a slot?", a: "Solana's clock tick, about 400 ms, in which one validator may add a block. Slot numbers only go up, so a slot pins a snapshot to a moment." },
    { id: "phoenix-layout", q: "How is a Phoenix book stored?", a: "One market account: a 576-byte header, padding, market fields, then the bids and asks as red-black trees in fixed arrays of 64-byte nodes, then the trader seats." },
    { id: "little-endian", q: "What does little-endian mean?", a: "The least significant byte comes first. The bytes 00 10 00 00 00 00 00 00 read as a u64 are 0x1000 = 4,096." },
    { id: "free-list", q: "What is a free list?", a: "A linked list of unused slots in a fixed array. Allocating pops a slot off it; freeing pushes the slot back, so memory is reused without ever growing." },
    { id: "bitflip", q: "How does Phoenix store bid sequence numbers, and why?", a: "Bit-flipped (NOT seq). The bids tree is kept in reverse key order, so its first node is the best (highest) price; under that reversed order, NOT seq puts an older bid (smaller real number, larger stored value) first at the same price. Side effect: every stored bid number has its top bit set. Sorting raw nodes yourself: price high to low, then un-flipped seq low to high." },
    { id: "crankless", q: "What does crankless mean?", a: "Phoenix settles each trade inside the same instruction that matched it. Older books like Serum needed separate crank transactions to finish trades." },
    { id: "xyk", q: "Constant-product AMM: the rule and the spot price?", a: "x × y = k stays constant. Spot price = x ÷ y (USDC per SOL). Buying SOL adds USDC and removes SOL, moving the price along the curve." },
    { id: "prop-amm", q: "What is a prop AMM?", a: "A pool run by one professional market maker, repriced from the firm's own model rather than a fixed curve. SolFi is Ellipsis Labs' prop AMM." },
    { id: "aggregator", q: "What does Jupiter do?", a: "It's an aggregator: it searches many pools and books and splits a trade across them for the best overall price." },
    { id: "junk", q: "What are junk quotes, and what do they break?", a: `Orders priced absurdly far from the market (bids at ${F.junkBid}, asks at ${F.junkAsk}). An unlimited market order fills against them: a $1M buy reported ${F.unprotectedBps}.` },
    { id: "protection", q: "What is price protection in the simulator?", a: "Every simulated order stops 10% from the market and reports a partial fill instead of trading at junk prices, like a real trader's limit." },
    { id: "ref-mid", q: "Why a reference mid?", a: "A venue's own mid can be wrong (Phoenix's sat hundreds of bps below the market when its best bid vanished), and AMMs have no mid. The reference is the average of the Kraken and Coinbase mids at the same tick." },
    { id: "round-trip", q: "What is the half round-trip cost?", a: "Half the gap between the average prices of a buy and a sell of the same size, over the reference mid. It barely depends on the reference mid or on slow drift during the quotes." },
    { id: "fees", q: "Kraken $10K trade: ~1 bps impact, 40 bps fee. All-in?", a: "About 41 bps. For a small trader the fee is almost the whole cost; that's why fees are shown separately." },
    { id: "twap", q: "What does a TWAP trade off?", a: "Splitting a big order over time saves impact if the book refills between children, but exposes the order to price moves meanwhile: risk, not an expected cost, unless the market trends against you. Shortfall = drift + impact." },
    { id: "pipeline", q: "The project's pipeline, in order?", a: "Fetch → normalize → store → engine → analyze → report (collector/venues/net → snapshot → store → orderbook/impact → metrics/timeseries → report/export)." },
    { id: "fault-isolation", q: "Kraken times out. What does the tick store?", a: "Phoenix and Coinbase as normal, a Kraken row with ok = 0, 4 attempts and the error, and a reference mid from Coinbase alone." },
    { id: "one-tx", q: "Why write each tick in one transaction?", a: "A crash leaves the whole tick or none of it, never half. Completed ticks always survive, and --resume skips them." },
    { id: "backoff", q: "How does net.py retry?", a: "Timeouts, 429 and 5xx: up to 3 retries, waiting 1, 2, 4 s × random 0.5–1.5, or exactly what Retry-After says. Other 4xx: no retry." },
    { id: "sqlite", q: "Why SQLite over Parquet here?", a: "Built into Python, crash-safe per transaction, restart-safe with a unique key, readable during writes (WAL). Parquet wins for columnar scans over millions of rows." },
    { id: "sharding", q: "How does an exchange scale matching?", a: "Shard by market: one single-threaded engine per market, fed by a sequencer that puts every order in one total order. Add machines, not locks." },
    { id: "contention", q: "Why are trades on one Phoenix market serialised?", a: "They all write the same market account, and Solana only runs two transactions in parallel when neither writes an account the other uses. Solana also caps the compute per writable account per block." },
    { id: "hypothesis", q: "How was the engine tested?", a: "Hypothesis stateful differential testing: random adds, cancels, market and IOC orders against the engine and a naive model, identical fills and queues required after every step, plus invariants." },
    { id: "golden", q: "How do we know the course's engine is the project's?", a: `Golden tests: about ${F.goldenOps} operations replayed in JavaScript must give exactly Python's fills, and impact must match bit for bit.` },
    { id: "star", q: "STAR stands for?", a: "Situation, Task, Action, Result: a shape for telling a project story in about a minute." },
  ];

  /* ==========================================================================================
   * 60-second pitch: five slots, pick a sentence and edit it
   * ======================================================================================== */
  const PITCH = [
    { id: "problem", label: "1. The problem", options: [
      "I wanted to know what it really costs to trade SOL on an on-chain order book, from $1,000 to $1,000,000, compared with Kraken, Coinbase and Solana's AMMs.",
      "On-chain exchanges compete on price impact, so I set out to measure it: how much does a large trade move the price on Phoenix compared with a big centralised exchange?",
    ] },
    { id: "built", label: "2. What I built", options: [
      "I built a Python tool that decodes Phoenix's market account byte by byte, rebuilds the book in my own price-time priority matching engine, and simulates market orders against it and against Kraken and Coinbase books fetched at the same moment.",
      "I built a matching engine and a collector designed to run for a day: every five minutes it snapshots Phoenix, Kraken and Coinbase at the same moment, plus real Jupiter quotes for the AMM routes, into SQLite.",
    ] },
    { id: "finding", label: "3. One finding", options: [
      `When I measured it, the Phoenix SOL/USDC book was thin: a ${F.phoenixSpread} spread against about 1 bps on Kraken, and one disappearing bid widened it to ${F.spreadAfter}.`,
      `The cheapest route was Jupiter, mostly through prop AMMs: about ${F.jupRt100k} for a half round trip at $100,000, below Kraken's ${F.krakenRt100k}.`,
      `The raw book held junk quotes, asks at ${F.junkAsk}, so without price protection a $1M buy reported ${F.unprotectedBps}.`,
    ] },
    { id: "decision", label: "4. One engineering decision", options: [
      `I anchored price protection on a reference mid from Kraken and Coinbase, because Phoenix's own mid drifted ${F.ownMidGap} below the market and let a "protected" sell fill 14% too low.`,
      "I fetched every venue in its own thread so the books are simultaneous, and wrote each tick in one SQLite transaction so a crash never leaves half a tick.",
      "I tested the engine with Hypothesis against a deliberately naive model, requiring identical fills after every random step.",
    ] },
    { id: "learned", label: "5. What I learned", options: [
      "The matching loop was the easy part; trusting the data was the hard part. Checking real bytes found a bid-ordering bug that my own tests couldn't.",
      "I learned to check every number against something independent, and that's the kind of engineering I'd like to do at Ellipsis.",
    ] },
  ];

  /* ==========================================================================================
   * Rendering
   * ======================================================================================== */
  const words = (s) => (String(s).trim().match(/\S+/g) || []).length;

  function sectionHead(id, eyebrow, title, lede) {
    return h("header", { class: "stack", style: { marginTop: "var(--s-7)" } },
      h("p", { class: "eyebrow", text: eyebrow }),
      h("h2", { id, tabIndex: -1, text: title }),
      lede ? OBZ.ui.p(lede, "lede") : null);
  }

  function buildBank(ctx) {
    const { ui } = ctx;
    let practised = new Set(OBZ.store.get("iv.practised", []));
    let topic = OBZ.store.get("iv.topic", "all");
    if (topic !== "all" && !TOPICS.some((t) => t.id === topic)) topic = "all";
    let hidePractised = !!OBZ.store.get("iv.hidePractised", false);
    const open = new Set();
    const listBox = h("div", { class: "stack" });
    const progress = ui.ProgressBar({ value: 0, max: questions.length, label: "Questions practised" });
    const progressText = h("p", { class: "fine", attrs: { "aria-live": "polite" } });
    const hideBtn = ui.Button({ label: "Hide practised", small: true, attrs: { "aria-pressed": String(hidePractised) }, onClick: () => { hidePractised = !hidePractised; OBZ.store.set("iv.hidePractised", hidePractised); paintHide(); draw(); } });
    function paintHide() { hideBtn.setAttribute("aria-pressed", String(hidePractised)); hideBtn.textContent = (hidePractised ? "✓ " : "") + "Hide practised"; }
    paintHide();
    const expandBtn = ui.Button({ label: "Show all answers", small: true, variant: "ghost", onClick: () => { visible().forEach((q) => open.add(q.id)); draw(); } });
    const collapseBtn = ui.Button({ label: "Hide all answers", small: true, variant: "ghost", onClick: () => { open.clear(); draw(); } });
    const resetBtn = ui.Button({ label: "Reset practised", small: true, variant: "ghost", onClick: () => { practised = new Set(); save(); draw(); } });
    const topicSeg = ui.Segmented({ label: "Topic", value: topic, small: true, onChange: (v) => { topic = v; OBZ.store.set("iv.topic", v); draw(); },
      options: [{ value: "all", label: "All" }].concat(TOPICS.map((t) => ({ value: t.id, label: t.label }))) });

    function save() { OBZ.store.set("iv.practised", Array.from(practised)); }
    function visible() { return questions.filter((q) => (topic === "all" || q.topic === topic) && !(hidePractised && practised.has(q.id))); }

    function card(q, n) {
      const ansId = "iv-a-" + q.id;
      const isOpen = open.has(q.id), done = practised.has(q.id);
      const toggle = h("button", {
        type: "button", class: "btn btn-ghost", attrs: { "aria-expanded": String(isOpen), "aria-controls": ansId },
        style: { width: "100%", justifyContent: "space-between", textAlign: "left", whiteSpace: "normal", height: "auto", padding: "var(--s-2) var(--s-3)", gap: "var(--s-3)" },
        on: { click: () => { if (open.has(q.id)) open.delete(q.id); else open.add(q.id); draw(q.id); } },
      }, h("span", null, h("span", { class: "eyebrow", text: `Q${n} · ${TOPICS.find((t) => t.id === q.topic).label}`, style: { display: "block" } }), h("strong", { text: q.q, style: { fontSize: "var(--fs-md)" } })),
      h("span", { attrs: { "aria-hidden": "true" }, text: isOpen ? "−" : "+", style: { fontSize: "var(--fs-lg)" } }));
      const mark = ui.Button({ label: done ? "✓ Practised" : "Mark as practised", small: true, variant: done ? "primary" : null,
        attrs: { "aria-pressed": String(done), "aria-label": `${done ? "Practised" : "Mark as practised"}: ${q.q}` },
        onClick: () => { if (practised.has(q.id)) practised.delete(q.id); else practised.add(q.id); save(); draw(q.id, true); } });
      const body = h("div", { id: ansId, hidden: !isOpen, class: "stack", style: { padding: "0 var(--s-3) var(--s-3)" } },
        h("p", { class: "fine", text: "Say your answer out loud first, then compare:" }),
        OBZ.ui.prose(q.a),
        h("div", { class: "btn-row" }, mark));
      return h("article", { class: "card", dataset: { q: q.id }, style: { padding: "var(--s-2)", borderColor: done ? "var(--ok)" : null } }, toggle, body,
        !isOpen && done ? h("p", { class: "fine", style: { margin: "0 var(--s-3) var(--s-2)" }, text: "✓ Practised" }) : null);
    }

    function draw(focusId, focusMark) {
      clear(listBox);
      const vis = visible();
      progress.api.set(practised.size, questions.length);
      progressText.textContent = `${practised.size} of ${questions.length} practised${hidePractised ? " (practised ones hidden)" : ""}.`;
      if (!vis.length) { listBox.appendChild(ui.p(hidePractised ? "Every question in this topic is marked as practised. Untick **Hide practised** to see them again." : "No questions here.")); return; }
      const groups = topic === "all" ? TOPICS.filter((t) => vis.some((q) => q.topic === t.id)) : [TOPICS.find((t) => t.id === topic)];
      for (const t of groups) {
        const qs = vis.filter((q) => q.topic === t.id);
        if (!qs.length) continue;
        listBox.appendChild(h("section", { class: "stack", attrs: { "aria-label": t.label } },
          h("h3", { text: `${t.label} (${qs.length})` }),
          qs.map((q) => card(q, questions.indexOf(q) + 1))));
      }
      if (focusId) {
        const art = listBox.querySelector(`[data-q="${focusId}"]`);
        const target = art && (focusMark ? art.querySelector("[aria-pressed]") : art.querySelector("[aria-expanded]"));
        if (target) target.focus();
      }
    }
    draw();
    return h("div", { class: "stack" },
      h("div", { class: "stack" }, topicSeg, h("div", { class: "btn-row" }, hideBtn, expandBtn, collapseBtn, resetBtn), progress, progressText),
      listBox);
  }

  function buildPitch(ctx) {
    const { ui } = ctx;
    const saved = OBZ.store.get("iv.pitch", {});
    const state = {};
    for (const s of PITCH) {
      const sv = saved[s.id] || {};
      const choice = Number.isInteger(sv.choice) && sv.choice >= -1 && sv.choice < s.options.length ? sv.choice : 0;
      state[s.id] = { choice, text: typeof sv.text === "string" ? sv.text : s.options[Math.max(0, choice)] };
    }
    const preview = h("div", { class: "prose", style: { fontSize: "var(--fs-md)" } });
    const count = ui.Stat({ label: "Words", tone: "accent" });
    const est = ui.Stat({ label: "At 150 words a minute" });
    const timerStat = ui.Stat({ label: "Timer" });
    const verdict = h("p", { class: "fine", attrs: { "aria-live": "polite" } });
    const timerBar = ui.ProgressBar({ value: 0, max: 60, label: "Seconds of 60", showText: false });
    function save() { const out = {}; for (const s of PITCH) out[s.id] = state[s.id]; OBZ.store.set("iv.pitch", out); }

    function full() { return PITCH.map((s) => state[s.id].text.trim()).filter(Boolean).join(" "); }
    function update() {
      const text = full(), n = words(text), secs = n / 150 * 60;
      clear(preview).appendChild(h("p", { text: text || "Pick a sentence in each step to build your pitch." }));
      count.api.set(String(n), "aim for about 150");
      est.api.set(`${Math.round(secs)} s`, "speaking time");
      verdict.textContent = n === 0 ? "" : n < 120 ? "A little short: you have room for one more concrete detail or number." : n <= 170 ? "About a minute. Good length." : "Over a minute: cut a clause or two; keep the number and the decision.";
    }

    const slots = PITCH.map((s) => {
      const name = OBZ.util.uid("pitch");
      const ta = h("textarea", { class: "input", value: state[s.id].text, rows: 3, attrs: { "aria-label": `${s.label}: your sentence (editable)` } });
      ta.addEventListener("input", () => { state[s.id].text = ta.value; state[s.id].choice = -1; radios.forEach((r) => { r.checked = false; }); paintRadios(); save(); update(); });
      const radios = [], labels = [];
      const opts = s.options.map((o, i) => {
        const r = h("input", { type: "radio", name, value: String(i), checked: state[s.id].choice === i });
        r.addEventListener("change", () => { state[s.id] = { choice: i, text: o }; ta.value = o; paintRadios(); save(); update(); });
        radios.push(r);
        const lab = h("label", { class: "quiz-opt" }, r, h("span", { class: "quiz-mark", attrs: { "aria-hidden": "true" } }), h("span", { class: "quiz-text", text: o }));
        labels.push(lab);
        return lab;
      });
      function paintRadios() {
        labels.forEach((lab, i) => {
          const on = state[s.id].choice === i, mark = lab.querySelector(".quiz-mark");
          lab.style.borderColor = on ? "var(--accent)" : "";
          lab.style.background = on ? "var(--accent-soft)" : "";
          mark.style.background = on ? "var(--accent)" : "";
          mark.style.borderColor = on ? "var(--accent)" : "";
          mark.textContent = on ? "✓" : "";
        });
      }
      paintRadios();
      return h("fieldset", { class: "card stack", style: { margin: 0 } },
        h("legend", { class: "eyebrow", text: s.label, style: { padding: "0 var(--s-1)" } }),
        h("div", { class: "quiz-opts" }, opts),
        h("p", { class: "fine", text: "Edit it into your own words:" }), ta);
    });

    // Timer (a text readout; no animation, so it is reduced-motion safe)
    let started = null, elapsed = 0, iv = null;
    const startBtn = ui.Button({ label: "Start timer", variant: "primary", onClick: () => (iv ? pause() : start()) });
    const resetBtn = ui.Button({ label: "Reset timer", variant: "ghost", onClick: () => { pause(); elapsed = 0; paintTimer(); verdictTimer.textContent = ""; } });
    const verdictTimer = h("p", { class: "fine", attrs: { "aria-live": "polite" } });
    function now() { return elapsed + (started ? (Date.now() - started) / 1000 : 0); }
    function paintTimer() {
      const t = now();
      timerStat.api.set(`${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`, t >= 60 ? "over a minute" : "say it out loud");
      timerBar.api.set(Math.min(60, Math.floor(t)), 60);
    }
    function start() { started = Date.now(); iv = setInterval(() => { paintTimer(); if (now() >= 60 && !verdictTimer.textContent) verdictTimer.textContent = "One minute is up. Wrap up with your last sentence."; }, 250); startBtn.textContent = "Pause timer"; }
    function pause() { if (started) elapsed = now(); started = null; if (iv) clearInterval(iv); iv = null; startBtn.textContent = "Start timer"; paintTimer(); }
    ctx.onCleanup(() => { if (iv) clearInterval(iv); });

    const copyBtn = ui.Button({ label: "Copy pitch", small: true, variant: "ghost", onClick: () => {
      const text = full();
      const done = () => { verdict.textContent = "Copied to the clipboard."; };
      try { if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, () => { verdict.textContent = "Copying isn't allowed here; select the text above instead."; }); else verdict.textContent = "Copying isn't available here; select the text above instead."; } catch (e) { verdict.textContent = "Copying isn't available here; select the text above instead."; }
    } });
    const resetPitch = ui.Button({ label: "Reset to the first options", small: true, variant: "ghost", onClick: () => {
      for (const s of PITCH) state[s.id] = { choice: 0, text: s.options[0] };
      save();
      const fresh = buildPitch(ctx); wrap.replaceWith(fresh);
    } });

    paintTimer(); update();
    const wrap = h("div", { class: "stack" },
      h("div", { class: "grid-2" },
        h("div", { class: "stack" }, slots),
        h("div", { class: "stack", style: { position: "sticky", top: "calc(var(--topbar-h) + var(--s-3))" } },
          h("div", { class: "readout-panel stack" },
            h("p", { class: "eyebrow", text: "Your pitch" }), preview,
            ui.StatGrid([count, est, timerStat]), verdict, timerBar,
            h("div", { class: "btn-row" }, startBtn, resetBtn), verdictTimer,
            h("div", { class: "btn-row" }, copyBtn, resetPitch)))));
    return wrap;
  }

  function buildFollowUps() {
    return h("div", { class: "stack" }, followUps.map((f) => h("details", { class: "card chart-table", style: { padding: "var(--s-3) var(--s-4)" } },
      h("summary", { text: f.q }),
      h("p", { text: f.a, style: { margin: "var(--s-2) 0 0" } }))));
  }

  function render(el, ctx) {
    const { ui } = ctx;
    const jump = (id) => () => { const t = document.getElementById(id); if (t) { t.scrollIntoView({ block: "start" }); t.focus({ preventScroll: true }); } };
    el.append(
      h("div", { class: "stack" },
        ui.p(`Practise out loud. Model answers are written in the first person, the way you'd say them, and stay true to the code; numbers come from the ${F.snapshotWhen} snapshot and the collector run. Your progress is saved in this browser only.`),
        h("nav", { class: "btn-row", attrs: { "aria-label": "Sections of this page" } },
          ui.Button({ label: `Questions (${questions.length})`, small: true, onClick: jump("iv-questions") }),
          ui.Button({ label: "60-second pitch", small: true, onClick: jump("iv-pitch") }),
          ui.Button({ label: `Flashcards (${cards.length})`, small: true, onClick: jump("iv-cards") }),
          ui.Button({ label: `Follow-ups (${followUps.length})`, small: true, onClick: jump("iv-follow") })),
        ui.Callout({ kind: "tip", title: "How to use this page", body: "Read a question, answer it out loud, then open the model answer and compare. Mark it practised when you'd be happy saying your version to an interviewer. The STAR shape and the habits behind these answers are in [chapter 13](#/learn/13)." })),
      sectionHead("iv-questions", "Part 1", "Question bank", "Grouped by topic. Click a question to reveal the model answer."),
      buildBank(ctx),
      sectionHead("iv-pitch", "Part 2", "Your 60-second pitch", "Problem → what I built → one finding → one decision → what I learned. About 150 words is a minute at a calm pace. Pick a sentence in each step, make it yours, then time yourself."),
      buildPitch(ctx),
      sectionHead("iv-cards", "Part 3", "Flashcards", "The whole course in one deck, with [[spaced-repetition|spaced repetition]]: cards you mark **Good** come back later, cards you mark **Again** come back soon."),
      ui.Flashcards({ id: "interview-all", cards, title: "Order Books From Zero: every chapter" }),
      sectionHead("iv-follow", "Part 4", "Likely follow-ups", "The short questions a good interviewer asks next. One or two sentences each."),
      buildFollowUps());
  }

  OBZ.interview = { render, cards, questions, followUps, FACTS, TOPICS };
})(window.OBZ = window.OBZ || {});
