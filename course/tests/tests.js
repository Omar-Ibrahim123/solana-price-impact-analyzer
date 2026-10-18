/* course/tests/tests.js: the browser test suite. build.py inlines it (with the whole course
 * bundle and golden.json) into course/dist/tests.html. Open that file: the summary at the top
 * and document.title say PASS or FAIL; window.OBZ_TEST_RESULT holds the details.
 */
(function () {
  "use strict";
  const OBZ = window.OBZ;
  const { BID, ASK, OrderBook, PriceLevel, Order, Snapshot, Units } = OBZ.engine;

  // Never touch the reader's real saved progress from the test page.
  OBZ.store._forceMemory(true);

  /* ------------------------------------------------------------ tiny harness */
  const groups = [];
  let current = null;
  function group(name, fn) { groups.push({ name, fn, tests: [] }); }
  function test(name, fn) { current.tests.push({ name, fn }); }
  const show = (v) => { try { return JSON.stringify(v); } catch (e) { return String(v); } };
  function eq(a, b, msg) { const A = show(a), B = show(b); if (A !== B) throw new Error((msg ? msg + ": " : "") + "expected " + B.slice(0, 400) + ", got " + A.slice(0, 400)); }
  function ok(c, msg) { if (!c) throw new Error(msg || "expected true"); }
  function near(a, b, tol, msg) { if (!(Math.abs(a - b) <= tol)) throw new Error((msg ? msg + ": " : "") + `expected ≈ ${b} (±${tol}), got ${a}`); }
  function rel(a, b, tol, msg) { const d = Math.abs(a - b) / Math.max(1e-300, Math.abs(b)); if (!(d <= tol) && a !== b) throw new Error((msg ? msg + ": " : "") + `expected ${b}, got ${a} (relative error ${d.toExponential(2)})`); }
  function throws(fn, re, msg) { let t = null; try { fn(); } catch (e) { t = e; } if (!t) throw new Error((msg || "expected an error") + ", but nothing was thrown"); if (re && !re.test(String(t.message))) throw new Error(`error "${t.message}" does not match ${re}`); }
  // requestAnimationFrame never fires in a hidden tab, so fall back to a timer.
  const frame = () => new Promise((r) => { let done = false; const f = () => { if (!done) { done = true; r(); } }; requestAnimationFrame(f); setTimeout(f, 60); });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const sandbox = document.getElementById("sandbox");
  function fresh() { const d = document.createElement("div"); sandbox.appendChild(d); return d; }

  // Console error capture (chapters must render without console errors).
  let captured = [];
  const origError = console.error.bind(console);
  console.error = function (...args) { captured.push(args.map(String).join(" ")); origError(...args); };
  window.addEventListener("error", (e) => captured.push("uncaught: " + e.message));

  const golden = JSON.parse(document.getElementById("golden").textContent);

  /* ------------------------------------------------------------ engine unit tests */
  const filled = (fills) => fills.reduce((s, f) => s + f.sizeLots, 0);
  const F = (maker, price, size) => ({ makerOrderId: maker, priceTicks: price, sizeLots: size });
  function levelIds(level) {
    const ids = []; let node = level.head, prev = null;
    while (node) { ok(node.prev === prev, "prev pointer"); ids.push(node.orderId); prev = node; node = node.next; }
    ok(level.tail === prev, "tail pointer"); return ids;
  }
  function makeLevel(...sizes) { const level = new PriceLevel(15000); const orders = sizes.map((s, i) => new Order(i + 1, ASK, 15000, s)); orders.forEach((o) => level.append(o)); return [level, orders]; }

  group("Engine: unit tests (ported from tests/test_orderbook.py)", () => {
    test("level append keeps FIFO and totals", () => { const [L] = makeLevel(4, 4, 2); eq(levelIds(L), [1, 2, 3]); eq([L.totalSize, L.count], [10, 3]); });
    for (const [id, exp, name] of [[1, [2, 3], "head"], [2, [1, 3], "middle"], [3, [1, 2], "tail"]]) {
      test(`level remove from the ${name}`, () => { const [L, os] = makeLevel(4, 4, 2); const v = os[id - 1]; L.remove(v); eq(levelIds(L), exp); eq(L.totalSize, 10 - v.sizeLots); ok(v.prev === null && v.next === null, "dead node pointers cleared"); });
    }
    test("removing the only order empties the level", () => { const [L, [o]] = makeLevel(5); L.remove(o); ok(L.head === null && L.tail === null); ok(L.isEmpty); eq(L.totalSize, 0); });
    test("empty book", () => { const b = new OrderBook(); eq(b.bestBid(), null); eq(b.bestAsk(), null); eq(b.depth(BID), []); eq(b.depth(ASK), []); });
    test("best prices and depth order", () => {
      const b = new OrderBook();
      b.addOrder(1, BID, 14990, 5); b.addOrder(2, BID, 14980, 7); b.addOrder(3, ASK, 15010, 3); b.addOrder(4, ASK, 15000, 2); b.addOrder(5, ASK, 15000, 1);
      eq(b.bestBid(), 14990); eq(b.bestAsk(), 15000); eq(b.depth(BID), [[14990, 5], [14980, 7]]); eq(b.depth(ASK), [[15000, 3], [15010, 3]]);
    });
    test("price-time priority: Alice before Bob", () => {
      const b = new OrderBook(); b.addOrder(1, ASK, 15000, 4); b.addOrder(2, ASK, 15000, 4);
      eq(b.marketOrder(BID, 5), [F(1, 15000, 4), F(2, 15000, 1)]); ok(!b.orders.has(1)); eq(b.orders.get(2).sizeLots, 3); eq(b.depth(ASK), [[15000, 3]]);
    });
    test("a partial fill keeps its queue position", () => { const b = new OrderBook(); b.addOrder(1, ASK, 15000, 10); b.addOrder(2, ASK, 15000, 10); b.marketOrder(BID, 3); eq(b.marketOrder(BID, 8), [F(1, 15000, 7), F(2, 15000, 1)]); });
    test("sweep multiple levels (the worked example)", () => {
      const b = new OrderBook(); b.addOrder(1, ASK, 15000, 5); b.addOrder(2, ASK, 15010, 10); b.addOrder(3, ASK, 15030, 20);
      eq(b.marketOrder(BID, 12), [F(1, 15000, 5), F(2, 15010, 7)]); eq(b.bestAsk(), 15010); eq(b.depth(ASK), [[15010, 3], [15030, 20]]);
    });
    test("market sell hits the highest bid first", () => { const b = new OrderBook(); b.addOrder(1, BID, 14980, 5); b.addOrder(2, BID, 14990, 5); eq(b.marketOrder(ASK, 6), [F(2, 14990, 5), F(1, 14980, 1)]); });
    test("price protection stops at the limit", () => { const b = new OrderBook(); b.addOrder(1, ASK, 15000, 5); b.addOrder(2, ASK, 15010, 5); b.addOrder(3, ASK, 99999, 5); eq(filled(b.marketOrder(BID, 100, 15010)), 10); eq(b.bestAsk(), 99999); });
    test("a market order bigger than the book is partly unfilled", () => { const b = new OrderBook(); b.addOrder(1, ASK, 15000, 5); b.addOrder(2, ASK, 15010, 5); eq(filled(b.marketOrder(BID, 100)), 10); eq(b.bestAsk(), null); eq(b.orders.size, 0); });
    test("market order on an empty side", () => { const b = new OrderBook(); b.addOrder(1, BID, 14990, 5); eq(b.marketOrder(BID, 5), []); eq(b.depth(BID), [[14990, 5]]); });
    test("crossing limit matches, then rests the remainder", () => {
      const b = new OrderBook(); b.addOrder(1, ASK, 15000, 5); b.addOrder(2, ASK, 15010, 5);
      eq(b.addOrder(3, BID, 15000, 8), [F(1, 15000, 5)]); eq(b.bestBid(), 15000); eq(b.orders.get(3).sizeLots, 3); eq(b.bestAsk(), 15010);
    });
    test("crossing limit sweeps up to its price", () => {
      const b = new OrderBook(); b.addOrder(1, ASK, 15000, 5); b.addOrder(2, ASK, 15010, 5); b.addOrder(3, ASK, 15020, 5);
      eq(filled(b.addOrder(4, BID, 15010, 20)), 10); eq(b.depth(BID), [[15010, 10]]); eq(b.depth(ASK), [[15020, 5]]);
    });
    test("a fully filled limit order does not rest (trades at the maker's price)", () => { const b = new OrderBook(); b.addOrder(1, BID, 15000, 5); eq(b.addOrder(2, ASK, 14990, 5), [F(1, 15000, 5)]); ok(!b.orders.has(2)); eq([b.bestBid(), b.bestAsk()], [null, null]); });
    test("cancel from the middle, then match", () => {
      const b = new OrderBook(); [[1, 4], [2, 4], [3, 2]].forEach(([id, s]) => b.addOrder(id, ASK, 15000, s));
      eq(b.cancelOrder(2), true); b.addOrder(4, ASK, 15000, 3); eq(b.marketOrder(BID, 7), [F(1, 15000, 4), F(3, 15000, 2), F(4, 15000, 1)]);
    });
    test("cancelling the last order removes the level", () => { const b = new OrderBook(); b.addOrder(1, ASK, 15000, 4); b.addOrder(2, ASK, 15010, 4); b.cancelOrder(1); eq(b.bestAsk(), 15010); ok(!b.asks.has(15000)); });
    test("IOC limit order trades like a market order with that limit and never rests", () => {
      const { TimeInForce } = OBZ.engine;
      const mk = () => { const b = new OrderBook(); b.addOrder(1, ASK, 15000, 3); b.addOrder(2, ASK, 15010, 4); return b; };
      const a = mk(), m = mk();
      const fa = a.addOrder(9, BID, 15005, 10, TimeInForce.IOC), fm = m.marketOrder(BID, 10, 15005);
      eq(fa.map((f) => [f.makerOrderId, f.priceTicks, f.sizeLots]), fm.map((f) => [f.makerOrderId, f.priceTicks, f.sizeLots]));
      eq(a.bestBid(), null, "nothing rested"); eq(a.cancelOrder(9), false, "an IOC id is never stored");
      const g = mk(); g.addOrder(9, BID, 15005, 10); eq(g.bestBid(), 15005, "GTC rests the remainder");
    });
    test("cancel of an unknown id, or twice, returns false", () => { const b = new OrderBook(); eq(b.cancelOrder(999), false); b.addOrder(1, BID, 14990, 1); eq(b.cancelOrder(1), true); eq(b.cancelOrder(1), false); });
    test("cancel after a full fill returns false", () => { const b = new OrderBook(); b.addOrder(1, ASK, 15000, 4); b.marketOrder(BID, 4); eq(b.cancelOrder(1), false); });
    test("cancel after a partial fill removes the remaining size", () => { const b = new OrderBook(); b.addOrder(1, ASK, 15000, 10); b.addOrder(2, ASK, 15000, 5); b.marketOrder(BID, 4); b.cancelOrder(1); eq(b.depth(ASK), [[15000, 5]]); });
    for (const s of [0, -1]) test(`rejects size ${s}`, () => { const b = new OrderBook(); throws(() => b.addOrder(1, BID, 14990, s), /positive/); throws(() => b.marketOrder(BID, s), /positive/); });
    test("rejects a duplicate resting id", () => { const b = new OrderBook(); b.addOrder(1, BID, 14990, 1); throws(() => b.addOrder(1, BID, 14980, 1), /already resting/); });
    test("rejects non-integer ticks/lots and bad sides", () => { const b = new OrderBook(); throws(() => b.addOrder(1, BID, 149.9, 1), /integer/); throws(() => b.addOrder(1, BID, 1, 0.5), /integer/); throws(() => b.addOrder(1, "buy", 1, 1), /side/); });
    test("dryMatch predicts marketOrder exactly and mutates nothing", () => {
      const b = new OrderBook(); b.addOrder(1, ASK, 100, 3); b.addOrder(2, ASK, 100, 4); b.addOrder(3, ASK, 102, 9); b.addOrder(4, ASK, 105, 1);
      const before = show(b.depth(ASK));
      const dry = b.dryMatch(BID, 12, 102);
      eq(show(b.depth(ASK)), before, "book unchanged");
      eq(dry.fills, b.marketOrder(BID, 12, 102)); eq(dry.unfilledLots, 0);
    });
    test("observer sees rest, fill and levelRemoved events", () => {
      const evs = []; const b = new OrderBook({ observer: (e) => evs.push(e.type) });
      b.addOrder(1, ASK, 100, 2); b.marketOrder(BID, 2);
      eq(evs, ["rest", "fill", "levelRemoved"]);
    });
    test("queue() and queuePosition() follow FIFO", () => { const b = new OrderBook(); b.addOrder(7, BID, 50, 1); b.addOrder(8, BID, 50, 2); b.addOrder(9, BID, 50, 3); b.cancelOrder(8); eq(b.queue(BID, 50), [{ orderId: 7, sizeLots: 1 }, { orderId: 9, sizeLots: 3 }]); eq(b.queuePosition(9), 2); });
    test("clone() copies queues in order", () => { const b = new OrderBook(); b.addOrder(1, ASK, 10, 1); b.addOrder(2, ASK, 10, 2); b.addOrder(3, BID, 9, 5); const c = b.clone(); eq(c.marketOrder(BID, 3), [F(1, 10, 1), F(2, 10, 2)]); eq(b.depth(ASK), [[10, 3]], "original untouched"); });
    test("Units convert ticks/lots exactly like Python's Decimal", () => {
      const u = new Units("0.001", "1E-8");
      eq(u.price(104350), 104.35); eq(u.size(12355800000), 123.558); eq(u.price(1), 0.001); eq(u.price(9999999999000), 9999999999);
      eq(OBZ.engine.parseDecimal("0.010").d, 2);
    });
    test("pyFloorDiv reproduces Python's float // (1 // 0.1 is 9, not 10)", () => {
      const fd = OBZ.engine.pyFloorDiv;
      eq(fd(7, 2), 3); eq(fd(-7, 2), -4); eq(fd(7.5, 2), 3); eq(fd(1, 0.1), 9); eq(fd(-1, 0.1), -10); eq(Math.floor(1 / 0.1), 10, "the naive version differs");
    });
  });

  /* ------------------------------------------------------------ golden */
  function replay(stream) {
    const b = new OrderBook();
    const out = [], checkpoints = {};
    stream.ops.forEach((op, i) => {
      let r;
      if (op[0] === "add") r = b.addOrder(op[1], op[2], op[3], op[4]).map((f) => [f.makerOrderId, f.priceTicks, f.sizeLots]);
      else if (op[0] === "cancel") r = b.cancelOrder(op[1]);
      else r = b.marketOrder(op[1], op[2], op[3]).map((f) => [f.makerOrderId, f.priceTicks, f.sizeLots]);
      out.push(r);
      if ((i + 1) % 100 === 0) checkpoints[String(i)] = { best_bid: b.bestBid(), best_ask: b.bestAsk(), depth_bid: b.depth(BID), depth_ask: b.depth(ASK), n_orders: b.orders.size };
    });
    const full = (side) => b._book(side).ascending().map((p) => { const lv = b._book(side).get(p); return [p, lv.totalSize, lv.orders().map((o) => [o.orderId, o.sizeLots])]; });
    return { out, checkpoints, final: { bids: full(BID), asks: full(ASK), n_orders: b.orders.size } };
  }
  group("Engine: golden fills vs the Python engine (course/tests/golden.json)", () => {
    let total = 0;
    for (const s of golden.streams) total += s.ops.length;
    test(`golden file has ~2,000 operations (${total})`, () => ok(total >= 1900, "too few ops"));
    for (const s of golden.streams) {
      const r = replay(s);
      test(`${s.name}: every fill and cancel result identical`, () => {
        for (let i = 0; i < s.ops.length; i++) {
          if (show(r.out[i]) !== show(s.results[i])) throw new Error(`op #${i} ${show(s.ops[i])}: Python ${show(s.results[i])}, JS ${show(r.out[i])}`);
        }
      });
      test(`${s.name}: book checkpoints every 100 ops identical`, () => {
        for (const k of Object.keys(s.checkpoints)) eq(r.checkpoints[k], s.checkpoints[k], "after op #" + k);
      });
      test(`${s.name}: final book (every FIFO queue) identical`, () => eq(r.final, s.final));
    }
    test("error cases raise exactly where Python raises", () => {
      for (const c of golden.errors) {
        const b = new OrderBook();
        for (const s of c.setup) { if (s[0] === "add") b.addOrder(s[1], s[2], s[3], s[4]); else b.marketOrder(s[1], s[2], s[3]); }
        let raised = null;
        try { if (c.op[0] === "add") b.addOrder(c.op[1], c.op[2], c.op[3], c.op[4]); else b.marketOrder(c.op[1], c.op[2], c.op[3]); } catch (e) { raised = e; }
        ok(!!raised === !!c.raises, `${c.name}: Python ${c.raises ? "raised" : "did not raise"}, JS ${raised ? "raised " + raised.message : "did not"}`);
      }
    });
  });

  group("Impact: engine.simulate vs impact.py on the real 2026-10-18 snapshots", () => {
    const snaps = {};
    for (const k of Object.keys(golden.snapshots)) snaps[k] = Snapshot.fromDict(golden.snapshots[k]);
    let exact = 0;
    const fields = ["filled_usd", "filled_base", "avg_price", "mid_price", "impact_bps"];
    const js = { filled_usd: "filledUsd", filled_base: "filledBase", avg_price: "avgPrice", mid_price: "midPrice", impact_bps: "impactBps" };
    test(`${golden.impact.length} cases match (floats to 1e-12 relative, counts exactly)`, () => {
      for (const c of golden.impact) {
        const r = OBZ.engine.simulate(snaps[c.venue], c.side, c.usd, c.max_slippage);
        const e = c.expected, label = `${c.venue} ${c.side} $${c.usd} @${c.max_slippage}`;
        let allExact = true;
        for (const f of fields) {
          if (e[f] === null) { eq(r[js[f]], null, label + " " + f); continue; }
          rel(r[js[f]], e[f], 1e-12, label + " " + f);
          if (r[js[f]] !== e[f]) allExact = false;
        }
        eq(r.levelsSwept, e.levels_swept, label + " levels_swept"); eq(r.fullyFilled, e.fully_filled, label + " fully_filled");
        if (allExact) exact++;
      }
    });
    // Python 3.12+ sums floats with compensation (engine.js's pySum copies it), so every case
    // should be bit-for-bit identical. Goldens made on 3.11 may differ in the last bit.
    const py312 = golden.python && /^3\.(1[2-9]|[2-9]\d)/.test(golden.python);
    test(`every case is bit-for-bit identical (golden made with Python ${golden.python || "?"})`, () => ok(exact >= golden.impact.length * (py312 ? 1 : 0.9), `${exact} of ${golden.impact.length} exact`));
    test("book.impact() (dry run) equals simulate()", () => {
      const s = snaps.phoenix, book = s.toBook();
      for (const usd of [1000, 100000]) for (const side of ["buy", "sell"]) {
        const a = OBZ.engine.simulate(s, side, usd), b = book.impact(side, usd);
        eq([b.filledUsd, b.avgPrice, b.impactBps, b.levelsSwept], [a.filledUsd, a.avgPrice, a.impactBps, a.levelsSwept], `${side} ${usd}`);
      }
    });
  });

  group("AMM: amm.js vs amm.py and known values", () => {
    test("pool buy/sell impact matches amm.py", () => {
      for (const c of golden.amm.filter((x) => x.kind === "pool")) {
        const p = new OBZ.amm.AmmPool(c.usd_reserve, c.sol_reserve, c.fee_bps);
        rel(p.spotPrice, c.spot, 1e-15, "spot");
        for (const [u, bps] of c.buy) rel(p.buyImpactBps(u), bps, 1e-12, `buy ${u}`);
        for (const [u, bps] of c.sell) rel(p.sellImpactBps(u), bps, 1e-12, `sell ${u}`);
      }
    });
    test("equivalent_pool matches amm.py on real snapshots", () => {
      for (const c of golden.amm.filter((x) => x.kind === "equivalent_pool")) {
        const p = OBZ.amm.equivalentPool(Snapshot.fromDict(golden.snapshots[c.venue]), c.band);
        rel(p.usdReserve, c.usd_reserve, 1e-12, `${c.venue} band ${c.band}`);
      }
    });
    test("$100K into a $20M / 133,333 SOL pool: 663.35 SOL out, avg $150.75, ~50 bps", () => {
      const r = new OBZ.amm.AmmPool(20000000, 133333).buy(100000);
      near(r.solOut, 663.35, 0.1); near(r.avgPrice, 150.75, 0.01); near(r.impactBps, 50, 0.3);
    });
    test("doubling the pool halves the impact; k is preserved", () => {
      const a = OBZ.amm.AmmPool.atPrice(150, 1e7).buyImpactBps(1e5), b = OBZ.amm.AmmPool.atPrice(150, 2e7).buyImpactBps(1e5);
      near(a / b, 2, 0.02);
      const p = new OBZ.amm.AmmPool(5e6, 4e4), r = p.buy(2.5e5); rel(r.after.k, p.k, 1e-12, "k");
    });
    test("cannot withdraw the whole USD reserve", () => throws(() => new OBZ.amm.AmmPool(100, 1).sellImpactBps(100), /reserve/));
  });

  /* ------------------------------------------------------------ glossary */
  group("Glossary integrity", () => {
    const all = OBZ.glossary.all();
    test(`has a complete set of terms (${all.length})`, () => ok(all.length >= 120, "expected at least 120 terms"));
    test("every entry has a term and a plain definition of reasonable length", () => {
      for (const e of all) { ok(e.term && e.term.length, e.id + " term"); ok(e.def && e.def.length >= 30 && e.def.length <= 520, `${e.id}: definition is ${e.def ? e.def.length : 0} chars`); }
    });
    test("every related id exists and isn't itself", () => { for (const e of all) for (const r of e.related || []) { ok(OBZ.glossary.has(r), `${e.id} → ${r} missing`); ok(r !== e.id, e.id + " relates to itself"); } });
    test("chapter numbers are 1–13", () => { for (const e of all) if (e.chapter !== undefined) ok(e.chapter >= 1 && e.chapter <= 13, e.id); });
    test("required course terms are present", () => {
      const need = ["market", "buyer", "seller", "bid", "ask", "best-bid", "best-ask", "spread", "mid-price", "basis-point", "order-book", "limit-order", "market-order", "maker", "taker", "fill", "partial-fill", "resting-order", "price-level", "depth", "liquidity", "price-time-priority", "fifo", "queue-position", "price-impact", "average-fill-price", "slippage", "price-protection", "ioc", "sorted-map", "linked-list", "doubly-linked-list", "hash-map", "big-o", "o-1", "o-log-n", "tree", "binary-search-tree", "red-black-tree", "free-list", "determinism", "validator", "floating-point", "integer", "tick", "lot", "blockchain", "solana", "account", "program", "slot", "transaction", "rpc", "byte", "hex", "little-endian", "u64", "phoenix", "amm", "constant-product", "xyk", "liquidity-pool", "prop-amm", "solfi", "jupiter", "aggregator", "route", "cex", "kraken", "coinbase", "fee", "taker-fee", "twap", "latency", "rate-limit", "snapshot", "reference-mid", "junk-quote", "sharding", "sequencer"];
      const missing = need.filter((id) => !OBZ.glossary.has(id)); eq(missing, []);
    });
    test("aliases resolve", () => { eq(OBZ.glossary.resolve("Bids"), "bid"); eq(OBZ.glossary.resolve("bps"), "basis-point"); eq(OBZ.glossary.resolve("x·y=k"), "xyk"); });
    test("search finds by name and by definition", () => { ok(OBZ.glossary.search("spread")[0].id === "spread"); ok(OBZ.glossary.search("coat check").some((e) => e.id === "hash-map")); });
  });

  /* ------------------------------------------------------------ chapters, quizzes, views */
  async function stepAll(root) {
    for (const st of root.querySelectorAll(".stepper")) {
      const next = st.querySelector('[aria-label="Next step"]');
      for (let k = 0; k < 40 && next && !next.disabled; k++) next.click();
    }
  }
  group("Chapters render (and every term they use is in the glossary)", () => {
    const chs = OBZ.chapters.all();
    test("13 chapters are registered, numbered 1–13", () => eq(chs.map((c) => c.number), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]));
    test("chapter ids are unique kebab-case", () => { const ids = chs.map((c) => c.id); eq(new Set(ids).size, ids.length); for (const id of ids) ok(/^[a-z0-9-]+$/.test(id), id); });
    for (const ch of chs) {
      test(`chapter ${ch.number} (${ch.title}) renders without errors`, async () => {
        captured = []; OBZ.ui.missingTerms.clear();
        const el = fresh();
        const page = OBZ.app.renderInto(el, { view: "learn", param: String(ch.number), sub: null });
        await frame(); await stepAll(el); await frame();
        eq(captured, [], "console errors");
        eq(Array.from(OBZ.ui.missingTerms), [], "terms missing from the glossary");
        ok(page.querySelector(".ch-title").textContent === ch.title, "title");
        ok(page.querySelector("#sec-check"), "Check section");
        if (ch.status === "ready") for (const k of ["explain", "see", "try"]) ok(page.querySelector("#sec-" + k), `ready chapter needs a ${k} section`);
        else ok(page.querySelector(".soon"), "placeholder");
        el.remove();
      });
    }
    test("chapter 2 is fully written (reference implementation)", () => eq(OBZ.chapters.get(2).status, "ready"));
    test("chapter 2's Try ladder shows real Phoenix data and reacts to a click", async () => {
      const el = fresh();
      OBZ.app.renderInto(el, { view: "learn", param: "2" });
      await frame();
      const rows = el.querySelectorAll(".lrow");
      ok(rows.length >= 10, "ladder rows");
      ok(el.textContent.includes("103.750"), "Phoenix best bid 103.750 shown");
      const ask = el.querySelector(".lrow-ask.is-best"); ask.click();
      ok(el.textContent.includes("best ask"), "picked panel");
      el.remove();
    });
  });

  group("Quiz data shape", () => {
    for (const ch of OBZ.chapters.all()) {
      test(`chapter ${ch.number}: goals and quiz are well formed`, () => {
        ok(Array.isArray(ch.goals) && ch.goals.length >= 2 && ch.goals.length <= 5, "2–5 goals");
        ok(Array.isArray(ch.quiz), "quiz is an array");
        if (ch.status === "ready") ok(ch.quiz.length >= 2 && ch.quiz.length <= 3, "ready chapters have 2–3 questions");
        ch.quiz.forEach((q, i) => {
          const L = `question ${i + 1}`;
          ok(typeof q.q === "string" && q.q.length > 10, L + " text");
          ok(Array.isArray(q.options) && q.options.length >= 2 && q.options.length <= 5, L + " has 2–5 options");
          ok(Number.isInteger(q.answer) && q.answer >= 0 && q.answer < q.options.length, L + " answer index");
          q.options.forEach((o, k) => { ok(typeof o.text === "string" && o.text.length, `${L} option ${k + 1} text`); ok(typeof o.why === "string" && o.why.length >= 15, `${L} option ${k + 1} needs an explanation (why)`); });
          eq(new Set(q.options.map((o) => o.text)).size, q.options.length, L + " options are distinct");
        });
      });
    }
    test("quiz records progress and completes the chapter", () => {
      const el = fresh();
      let done = 0;
      const qs = OBZ.chapters.get(2).quiz;
      el.appendChild(OBZ.ui.Quiz({ id: "test-quiz", questions: qs, onComplete: () => done++ }));
      const fss = el.querySelectorAll("fieldset");
      const wrong = (qs[0].answer + 1) % qs[0].options.length;
      const pick = (fs, k) => { const inp = fs.querySelectorAll("input")[k]; inp.checked = true; inp.dispatchEvent(new Event("change")); };
      pick(fss[0], wrong);
      ok(fss[0].querySelector(".is-wrong"), "wrong marked"); ok(fss[0].textContent.includes(qs[0].options[wrong].why), "wrong explanation shown");
      qs.forEach((q, i) => pick(fss[i], q.answer));
      eq(done, 1, "onComplete called once all are right");
      ok(OBZ.store.quiz.isSolved("test-quiz", qs.length), "stored");
      eq(OBZ.store.quiz.get("test-quiz")[0].firstTry, false, "first try remembered as wrong");
      el.remove();
    });
  });

  group("Other views render", () => {
    const routes = [["home"], ["learn"], ["play"], ["interview"], ["glossary"], ["glossary", "spread"], ["glossary", "no-such-term"], ["notfound", "x"]];
    for (const t of OBZ.play.all()) routes.push(["play", t.id]);
    for (const [view, param] of routes) {
      test(`#/${view}${param ? "/" + param : ""}`, async () => {
        captured = []; OBZ.ui.missingTerms.clear();
        const el = fresh();
        OBZ.app.renderInto(el, { view, param: param || null, sub: null });
        await frame();
        eq(captured, [], "console errors"); eq(Array.from(OBZ.ui.missingTerms), [], "missing terms");
        ok(el.querySelector("h1"), "has a heading");
        el.remove();
      });
    }
    test("play tools are registered", () => eq(OBZ.play.all().map((t) => t.id), ["playground", "real-books", "hex", "amm", "code"]));
  });

  /* ------------------------------------------------------------ exercises */
  group("Exercises: every reference solution passes, every starter fails", () => {
    const seen = new Set(), all = [];
    const collect = (owner, list) => (list || []).forEach((ex) => { if (!seen.has(ex.id)) { seen.add(ex.id); all.push([owner, ex]); } });
    for (const ch of OBZ.chapters.all()) collect(`chapter ${ch.number}`, ch.exercises);
    for (const t of OBZ.play.all()) collect(t.id, t.exercises);
    const run = (ex, code) => OBZ.ui.runCode({ code, prelude: ex.prelude, exports: ex.exports, tests: ex.tests, timeoutMs: ex.timeoutMs || 4000 });
    for (const [owner, ex] of all) {
      test(`${owner}: ${ex.id}`, async () => {
        const good = await run(ex, ex.solution);
        eq(good.type, "done", "solution runs");
        eq(good.results.filter((r) => !r.ok).map((r) => r.name + ": " + r.msg), [], "solution fails no test");
        const bad = await run(ex, ex.starter);
        ok(bad.type !== "done" || bad.results.some((r) => !r.ok), "starter code must not pass every test");
      });
    }
    test("the course has exercises", () => ok(all.length >= 8, `found ${all.length}`));
  });

  /* ------------------------------------------------------------ data */
  const builtinRaw = () => OBZ.data._payload().builtin;
  group("Data loader (export v1 + v2)", () => {
    test("built-in data has Phoenix, Kraken and Coinbase", () => eq(OBZ.data.builtin().venues.map((v) => v.venue), ["phoenix", "kraken", "coinbase"]));
    test("Phoenix snapshot uses the raw orders: best bid 103,750 ticks, mid $104.05, spread ≈ 57.66 bps", () => {
      const s = OBZ.data.snapshot("phoenix");
      eq(s.bestBid(), 103750); eq(s.bestAsk(), 104350); eq(s.midPrice(), 104.05); near(s.spreadBps(), 57.6646, 1e-3);
      ok(s.bids.length > 1000, "unaggregated orders");
      eq(OBZ.data.phoenix().slot, 458302883);
    });
    test("Kraken from aggregated USD levels: mid $103.945", () => { const s = OBZ.data.snapshot("kraken"); eq(s.midPrice(), 103.945); });
    test("fees: Phoenix from the account (2 bps), Kraken/Coinbase base tier", () => eq(OBZ.data.builtin().venues.map((v) => v.feeBps), [2, 40, 120]));
    test("a v1 export (playground.json) round-trips", () => { const r = OBZ.data.parse(JSON.stringify(builtinRaw())); ok(r.ok, r.error); eq(r.dataset.venues.length, 3); });
    const v2 = () => ({
      kind: "impact-analyzer-export", version: 2, generated_at: 1792296059,
      venues: [{ venue: "phoenix", symbol: "SOL/USDC", fetched_at: 1, mid: 100.05, spread_bps: 10, bids: [[100, 1], [99.9, 2]], asks: [[100.1, 1]], fee_bps: 2, depth_usd: { "0.01": [300, 100] }, curve: { buy: [[1000, 5, true], [1e6, null, false]], sell: [] } }],
      amm_usd_reserve: 2624879.99,
      jupiter: [{ dex: "SolFi", side: "buy", usd: 100000, cost_bps_vs_ref: 0.4, route: ["SolFi"], slot: 458308545 }],
      timeseries: { interval_s: 300, t: [1, 2], series: { phoenix: { spread_bps: [10, null], depth_2pct_usd: [[1, 2], null], impact_bps: { buy: { "10000": [3, 4] } } } } },
      phoenix_account: { slot: 458302883, offset: 0, hex: "0010000000000000", fields: [{ name: "bids_size", offset: 16, size: 8, type: "u64", value: 4096, explain: "x" }] },
    });
    test("a v2 export with every optional section loads", () => { const r = OBZ.data.parse(JSON.stringify(v2())); ok(r.ok, r.error); eq(r.dataset.jupiter.length, 1); ok(r.dataset.timeseries && r.dataset.phoenixAccount); });
    const bad = (mut, path, re) => () => { const d = v2(); mut(d); const r = OBZ.data.parse(JSON.stringify(d)); ok(!r.ok, "should be rejected"); if (path !== null) eq(r.path, path); if (re) ok(re.test(r.error), r.error); };
    test("rejects invalid JSON with a friendly message", () => { const r = OBZ.data.parse("{nope"); ok(!r.ok && /valid JSON/.test(r.error)); });
    test("rejects an empty paste", () => { const r = OBZ.data.parse("   "); ok(!r.ok && /empty/.test(r.error)); });
    test("rejects the wrong kind, naming the field", bad((d) => { d.kind = "something"; }, "kind"));
    test("rejects an unknown version", bad((d) => { d.version = 3; }, "version"));
    test("names the exact bad level", bad((d) => { d.venues[0].bids[1][1] = -2; }, "venues[0].bids[1][1]", /size/));
    test("rejects unsorted bids", bad((d) => { d.venues[0].bids.reverse(); }, "venues[0].bids[1]", /order/));
    test("rejects a crossed book", bad((d) => { d.venues[0].asks = [[99.95, 1]]; }, "venues[0].bids[0]", /crossed/));
    test("rejects non-hex Phoenix bytes", bad((d) => { d.phoenix_account.hex = "zz"; }, "phoenix_account.hex"));
    test("rejects a time series longer than t", bad((d) => { d.timeseries.series.phoenix.spread_bps = [1, 2, 3]; }, "timeseries.series.phoenix.spread_bps"));
    test("rejects a bad Jupiter side", bad((d) => { d.jupiter[0].side = "up"; }, "jupiter[0].side"));
    test("rejects files over 5 MB before parsing", () => { const r = OBZ.data.parse(" ".repeat(OBZ.data.MAX_BYTES + 1)); ok(!r.ok && /5 MB/.test(r.error), r.error); });
    test("never executes content: hostile names render as text", async () => {
      const d = v2(); d.venues[0].venue = "<img src=x onerror=window.__pwned=1>"; d.venues[0].symbol = "<scr" + "ipt>window.__pwned=1</scr" + "ipt>";
      const r = OBZ.data.parse(JSON.stringify(d)); ok(r.ok, r.error);
      OBZ.data.use(r.dataset);
      const el = fresh(); OBZ.app.renderInto(el, { view: "play", param: "real-books" }); await frame();
      eq(el.querySelector("img, script"), null, "no element created from data"); ok(!window.__pwned, "nothing ran");
      el.remove(); OBZ.data.reset();
    });
    test("use() notifies subscribers; reset() restores built-in", () => {
      let n = 0; const off = OBZ.data.subscribe(() => n++);
      OBZ.data.use(OBZ.data.parse(JSON.stringify(v2())).dataset); eq(OBZ.data.active().source, "paste");
      OBZ.data.reset(); eq(OBZ.data.active().source, "builtin"); eq(n, 2); off();
    });
  });

  /* ------------------------------------------------------------ store + router */
  group("Store and router", () => {
    test("store works in memory when localStorage is unavailable", () => {
      ok(!OBZ.store.available, "test page forces memory mode");
      OBZ.store.set("x", { a: 1 }); eq(OBZ.store.get("x"), { a: 1 }); eq(OBZ.store.get("nope", 5), 5);
      OBZ.store.progress.visit(4); eq(OBZ.store.progress.last(), 4);
      OBZ.store.progress.complete(4); ok(OBZ.store.progress.isComplete(4));
      OBZ.store.exercises.setPassed("e1"); ok(OBZ.store.exercises.passed("e1"));
      OBZ.store.reset(); eq(OBZ.store.progress.last(), null);
    });
    test("localStorage probing never throws", () => { try { window.localStorage.getItem("obz.test"); } catch (e) { /* blocked is fine */ } ok(true); });
    const P = (h) => { const r = OBZ.router.parse(h); return r && [r.view, r.param, r.sub]; };
    test("route parsing", () => {
      eq(P(""), ["home", null, null]); eq(P("#/"), ["home", null, null]); eq(P("#/learn/5"), ["learn", "5", null]); eq(P("#/learn/5/try"), ["learn", "5", "try"]);
      eq(P("#/play/hex"), ["play", "hex", null]); eq(P("#/glossary/basis-point"), ["glossary", "basis-point", null]); eq(P("#/interview"), ["interview", null, null]);
      eq(P("#/zzz"), ["notfound", "zzz", null]); eq(OBZ.router.parse("#main"), null);
    });
    test("href builds routes", () => { eq(OBZ.router.href("learn", 5), "#/learn/5"); eq(OBZ.router.href("learn", 2, "try"), "#/learn/2/try"); eq(OBZ.router.href("home"), "#/"); });
  });

  /* ------------------------------------------------------------ components */
  group("UI components", () => {
    test("rich(): bold, italic, code, links, terms; unsafe links become text", () => {
      const el = fresh(); el.appendChild(OBZ.ui.rich("a **b** *c* `d` [e](#/learn/1) [f](javascript:alert(1)) [[spread|the spread]]"));
      ok(el.querySelector("strong").textContent === "b"); ok(el.querySelector("em").textContent === "c"); ok(el.querySelector("code").textContent === "d");
      eq(el.querySelectorAll("a").length, 1, "only the safe link"); ok(el.querySelector(".term[data-term=spread]").textContent === "the spread"); el.remove();
    });
    test("Term opens a popover with the definition; Escape closes it", async () => {
      const el = fresh(); const t = OBZ.ui.Term("mid-price"); el.appendChild(t); t.click(); await frame();
      const pop = document.getElementById("obz-popover"); ok(pop && !pop.hidden, "open"); ok(pop.textContent.includes("Halfway"), "definition");
      ok(pop.querySelector('a[href="#/glossary/mid-price"]'), "glossary link");
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); ok(pop.hidden, "closed"); el.remove();
    });
    test("unknown terms are flagged, not silently rendered", () => { OBZ.ui.missingTerms.clear(); const origWarn = console.warn; console.warn = () => {}; OBZ.ui.Term("not-a-term"); console.warn = origWarn; ok(OBZ.ui.missingTerms.has("not-a-term")); OBZ.ui.missingTerms.clear(); });
    test("Ladder: rows, best markers, keyboard and selection", () => {
      const book = new OrderBook({ units: new Units("0.01", "0.001") });
      book.addOrder(1, BID, 9990, 1000); book.addOrder(2, BID, 9980, 2000); book.addOrder(3, ASK, 10010, 500); book.addOrder(4, ASK, 10020, 1500);
      let got = null; const el = fresh(); const L = OBZ.ui.Ladder({ levels: book, rows: 5, onSelect: (l, side) => (got = [side, l.price]) }); el.appendChild(L);
      eq(L.querySelectorAll(".lrow").length, 4); ok(L.querySelector(".lrow-mid").textContent.includes("20.0 bps"), L.querySelector(".lrow-mid").textContent);
      const first = L.querySelector('.lrow[tabindex="0"]'); ok(first && first.classList.contains("is-best"), "best ask is the tab stop");
      first.focus(); first.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })); ok(document.activeElement.classList.contains("lrow-bid"), "arrow moves to the bid");
      document.activeElement.click(); eq(got, ["bid", 99.9]); el.remove();
    });
    test("Stepper: steps forward/back and calls render", () => {
      const seen = []; const el = fresh(); const s = OBZ.ui.Stepper({ steps: ["one", "two", "three"], render: (i) => seen.push(i) }); el.appendChild(s);
      s.api.next(); s.api.next(); s.api.next(); s.api.prev(); eq(seen, [0, 1, 2, 2, 1]); ok(s.textContent.includes("Step 2 of 3")); el.remove();
    });
    test("charts draw without errors and expose a text alternative", async () => {
      captured = []; const el = fresh();
      const lc = OBZ.ui.LineChart({ series: [{ name: "a", color: "--phoenix", points: [[1000, 1], [10000, 3], [100000, null], [1e6, 9, false]] }], x: { log: true, format: OBZ.util.fmt.usdCompact }, y: { label: "bps" }, alt: "test chart", table: true });
      const dc = OBZ.ui.DepthChart({ levels: OBZ.data.book("kraken"), band: 0.005 });
      el.append(lc, dc); await frame(); await frame();
      eq(captured, []); eq(lc.querySelector("canvas").getAttribute("aria-label"), "test chart"); ok(lc.querySelector("table"), "data table");
      ok(dc.querySelector(".chart-readout").textContent.includes("SOL"), "depth summary text");
      document.documentElement.setAttribute("data-theme", "dark"); await frame(); document.documentElement.removeAttribute("data-theme"); await frame();
      eq(captured, [], "redraw on theme change"); el.remove();
    });
    test("HexView decodes little-endian fields", () => {
      eq(OBZ.ui.decodeLE(OBZ.ui.hexToBytes("0010000000000000"), 0, 8, "u64"), "4,096");
      eq(OBZ.ui.decodeLE(OBZ.ui.hexToBytes("ffffffff"), 0, 4, "i32"), "-1");
      eq(OBZ.ui.decodeLE(OBZ.ui.hexToBytes("ffffffffffffffff"), 0, 8, "u64"), "18,446,744,073,709,551,615");
      const el = fresh(); const hv = OBZ.ui.HexView({ bytes: "0010000000000000e803000000000000", fields: [{ name: "a", offset: 0, size: 8, type: "u64" }, { name: "b", offset: 8, size: 8, type: "u64" }] });
      el.appendChild(hv); hv.api.select(9); ok(hv.querySelector(".hex-detail").textContent.includes("1,000"), hv.querySelector(".hex-detail").textContent); el.remove();
    });
    test("Flashcards: flip, grade, spaced repetition", () => {
      const el = fresh(); const fc = OBZ.ui.Flashcards({ id: "t", cards: [{ q: "Q1", a: "A1" }, { q: "Q2", a: "A2" }] }); el.appendChild(fc);
      ok(fc.textContent.includes("Q1")); fc.querySelector(".btn-primary").click(); ok(fc.textContent.includes("A1"), "flipped");
      Array.from(fc.querySelectorAll("button")).find((b) => b.textContent === "Good").click();
      ok(fc.textContent.includes("Q2"), "next card"); eq(OBZ.store.cards.get("t").cards.c0.box, 1); el.remove();
    });
    test("NumberCheck accepts within tolerance", () => {
      const el = fresh(); const nc = OBZ.ui.NumberCheck({ question: "q", answer: 9.6, tolerance: 0.05, explain: "yes" }); el.appendChild(nc);
      const inp = nc.querySelector("input"); inp.value = "9.62 bps"; nc.querySelector("button").click(); ok(nc.querySelector(".is-ok"));
      inp.value = "96"; nc.querySelector("button").click(); ok(nc.querySelector(".is-bad")); el.remove();
    });
    const tests = [{ name: "adds", code: "eq(A.add(2, 3), 5);" }];
    test("CodeExercise runner: passing code", async () => { const r = await OBZ.ui.runCode({ code: "function add(a,b){return a+b}", exports: ["add"], tests }); eq(r.type, "done"); eq(r.results[0].ok, true); });
    test("CodeExercise runner: failing test reports the message", async () => { const r = await OBZ.ui.runCode({ code: "function add(a,b){return a-b}", exports: ["add"], tests }); ok(!r.results[0].ok && /expected 5/.test(r.results[0].msg), show(r)); });
    test("CodeExercise runner: syntax error", async () => { const r = await OBZ.ui.runCode({ code: "function add(a,b){return a+", exports: ["add"], tests }); eq(r.type, "compile"); });
    test("CodeExercise runner: an infinite loop is stopped by the time limit", async () => {
      const t0 = performance.now(); const r = await OBZ.ui.runCode({ code: "function add(){ while(true){} }", exports: ["add"], tests, timeoutMs: 600 });
      if (r.inline) throw new Error("Web Workers are blocked here, so the time limit can't be tested");
      eq(r.type, "timeout"); ok(performance.now() - t0 < 3000, "stopped quickly");
    });
    test("CodeExercise widget runs the demo exercise solution", async () => {
      const ex = OBZ.play.get("code").exercises[0];
      const el = fresh(); el.appendChild(OBZ.ui.CodeExercise(Object.assign({}, ex, { id: "t-demo" })));
      el.querySelector("textarea").value = ex.solution;
      Array.from(el.querySelectorAll("button")).find((b) => b.textContent === "Run tests").click();
      for (let i = 0; i < 50 && !el.querySelector(".ex-ok, .ex-bad"); i++) await sleep(50);
      ok(el.querySelector(".ex-ok"), el.querySelector(".ex-results").textContent); el.remove();
    });
  });

  /* ------------------------------------------------------------ run */
  async function run() {
    const out = document.getElementById("results");
    const summary = document.getElementById("summary");
    let passed = 0, failed = 0;
    const failures = [];
    for (const g of groups) { current = g; try { g.fn(); } catch (e) { g.tests.push({ name: "group setup", fn: () => { throw e; } }); } }
    for (const g of groups) {
      const sec = document.createElement("section");
      const hd = document.createElement("h2"); hd.textContent = g.name; sec.appendChild(hd);
      const ul = document.createElement("ul"); sec.appendChild(ul); out.appendChild(sec);
      let gp = 0;
      for (const t of g.tests) {
        const li = document.createElement("li");
        try { await t.fn(); li.className = "pass"; li.textContent = "✓ " + t.name; passed++; gp++; }
        catch (e) { li.className = "fail"; li.textContent = "✗ " + t.name + " — " + (e && e.message || e); failed++; failures.push(g.name + " › " + t.name + ": " + (e && e.message || e)); }
        ul.appendChild(li);
      }
      hd.textContent = `${g.name} (${gp}/${g.tests.length})`;
      if (gp !== g.tests.length) sec.classList.add("has-fail");
    }
    const total = passed + failed;
    summary.className = failed ? "fail" : "pass";
    summary.textContent = failed ? `FAIL: ${failed} of ${total} tests failed` : `PASS: all ${total} tests passed`;
    document.title = (failed ? `FAIL ${failed}/${total}` : `PASS ${total}/${total}`) + " · Order Books From Zero tests";
    window.OBZ_TEST_RESULT = { passed, failed, total, failures };
    document.getElementById("failures").textContent = failures.join("\n");
    sandbox.hidden = true;
  }
  run();
})();
