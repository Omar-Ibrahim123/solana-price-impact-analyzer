/* core/engine.js: a line-by-line port of src/impact_analyzer/orderbook.py
 * (plus snapshot.py, convert.py and impact.py), with IDENTICAL semantics:
 *
 *   - prices are integer ticks, sizes are integer lots (never floats inside the engine)
 *   - bids/asks: price -> PriceLevel, kept sorted ascending (best ask = smallest key,
 *     best bid = largest key), exactly like Python's SortedDict
 *   - PriceLevel: a doubly linked list of Order nodes, oldest at the head (FIFO)
 *   - orders: Map orderId -> Order node, so cancel is O(1)
 *   - trades always print at the MAKER's (resting order's) price
 *   - a partial fill keeps its place at the head of the queue
 *   - cancelOrder of an unknown id returns false (a cancel can race a fill)
 *   - addOrder(..., tif): TimeInForce.GTC (default) rests the unfilled part; IOC drops it
 *   - marketOrder(side, lots, limitPrice) never rests; limitPrice is optional
 *     price protection (an IOC limit order without an id)
 *
 * The golden test (course/tests/golden.json, made by make_golden.py) replays ~2,000
 * operations through both engines and checks every fill matches.
 *
 * Course-only helpers (not in the Python engine, never mutate the book): dryMatch, queue,
 * toLevels, lotsForUsd, impact, depthWithin, clone, observer events for animations.
 */
(function (OBZ) {
  "use strict";

  const BID = "bid"; // buy
  const ASK = "ask"; // sell
  // What happens to the part of a limit order that can't trade at once (orderbook.py TimeInForce).
  const TimeInForce = Object.freeze({ GTC: "gtc", IOC: "ioc" });

  function opposite(side) {
    if (side === BID) return ASK;
    if (side === ASK) return BID;
    throw new TypeError(`side must be "bid" or "ask", got ${JSON.stringify(side)}`);
  }
  function checkSide(side) { opposite(side); return side; }
  function checkInt(name, v) {
    if (!Number.isSafeInteger(v)) throw new TypeError(`${name} must be an integer, got ${v}`);
  }

  /** A resting limit order. Also a node in its level's linked list. */
  class Order {
    constructor(orderId, side, priceTicks, sizeLots) {
      this.orderId = orderId;
      this.side = side;
      this.priceTicks = priceTicks;
      this.sizeLots = sizeLots; // remaining (unfilled) size
      this.prev = null; // toward the head (older)
      this.next = null; // toward the tail (newer)
    }
  }

  /** One match between an incoming (taker) order and a resting (maker) order. */
  function Fill(makerOrderId, priceTicks, sizeLots) {
    return Object.freeze({ makerOrderId, priceTicks, sizeLots });
  }

  /** All resting orders at one price, in arrival order (FIFO). */
  class PriceLevel {
    constructor(priceTicks) {
      this.priceTicks = priceTicks;
      this.head = null; // oldest: matched first
      this.tail = null; // newest: new orders join here
      this.totalSize = 0;
      this.count = 0;
    }
    get isEmpty() { return this.count === 0; }

    /** Add order at the tail in O(1). */
    append(order) {
      order.prev = this.tail;
      order.next = null;
      if (this.tail === null) this.head = order; // empty level
      else this.tail.next = order;
      this.tail = order;
      this.totalSize += order.sizeLots;
      this.count += 1;
    }

    /** Unlink order from anywhere (head, middle, tail) in O(1). */
    remove(order) {
      if (order.prev === null) this.head = order.next;
      else order.prev.next = order.next;
      if (order.next === null) this.tail = order.prev;
      else order.next.prev = order.prev;
      order.prev = order.next = null;
      this.totalSize -= order.sizeLots;
      this.count -= 1;
    }

    /** Orders head -> tail (oldest first). */
    orders() { const out = []; for (let o = this.head; o; o = o.next) out.push(o); return out; }
  }

  /** A minimal SortedDict: price -> level, keys kept ascending, binary-search insert/delete. */
  class SortedLevels {
    constructor() { this.keys = []; this.map = new Map(); }
    get size() { return this.keys.length; }
    get(price) { return this.map.get(price); }
    has(price) { return this.map.has(price); }
    _index(price) {
      let lo = 0, hi = this.keys.length;
      while (lo < hi) { const m = (lo + hi) >> 1; if (this.keys[m] < price) lo = m + 1; else hi = m; }
      return lo;
    }
    set(price, level) {
      if (!this.map.has(price)) this.keys.splice(this._index(price), 0, price);
      this.map.set(price, level);
    }
    delete(price) {
      if (!this.map.has(price)) return false;
      this.keys.splice(this._index(price), 1);
      this.map.delete(price);
      return true;
    }
    /** Like SortedDict.peekitem: index 0 = smallest key, -1 = largest. */
    peekItem(index) {
      const i = index < 0 ? this.keys.length + index : index;
      const k = this.keys[i];
      return [k, this.map.get(k)];
    }
    ascending() { return this.keys.slice(); }
    descending() { return this.keys.slice().reverse(); }
  }

  /* --------------------------------------------------------------------------
   * Exact unit conversion, matching Python's float(Decimal(str(n)) * tick_size).
   * A decimal string like "0.001" or "1E-8" is held as m * 10^-d with integer m, so
   * n * m is an exact integer and one IEEE division gives the correctly rounded
   * result: bit-for-bit the same float Python produces.
   * ------------------------------------------------------------------------ */
  const POW10 = Array.from({ length: 23 }, (_, i) => Number("1e" + i));
  function parseDecimal(s) {
    const str = String(s).trim();
    const m = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(str);
    if (!m || (m[2] === "" && (m[3] === undefined || m[3] === ""))) throw new Error(`not a decimal: ${s}`);
    const frac = m[3] || "";
    let digits = (m[2] + frac).replace(/^0+(?=\d)/, "");
    let d = frac.length - (m[4] ? parseInt(m[4], 10) : 0);
    // Strip trailing zeros to keep m small.
    while (d > 0 && digits.length > 1 && digits.endsWith("0")) { digits = digits.slice(0, -1); d -= 1; }
    let mant = Number(digits);
    while (d < 0) { mant *= 10; d += 1; }
    if (!Number.isSafeInteger(mant) || d > 22) throw new Error(`decimal out of range: ${s}`);
    return { m: m[1] === "-" ? -mant : mant, d, str, value: Number(str) };
  }
  class Units {
    /** tickSize / lotSize as decimal strings (e.g. "0.001"); numbers are accepted too. */
    constructor(tickSize = "1", lotSize = "1") {
      this.tick = parseDecimal(tickSize);
      this.lot = parseDecimal(lotSize);
      this.tickSize = this.tick.value; // USD per tick, as a float (like float(tick_size))
      this.lotSize = this.lot.value; // SOL per lot
    }
    price(ticks) { return (ticks * this.tick.m) / POW10[this.tick.d]; }
    size(lots) { return (lots * this.lot.m) / POW10[this.lot.d]; }
  }
  const IDENTITY = new Units("1", "1");

  /** Python's float floor division (a // b), so ceiling divisions match bit for bit. */
  function pyFloorDiv(a, b) {
    let mod = a % b;
    let div = (a - mod) / b;
    if (mod) { if ((b < 0) !== (mod < 0)) { mod += b; div -= 1; } }
    if (div) { let f = Math.floor(div); if (div - f > 0.5) f += 1; return f; }
    return 0 * (a / b);
  }

  /** Python 3.12+'s built-in sum() of floats: Neumaier-compensated, so totals match bit for bit. */
  function pySum(values) {
    let total = 0, c = 0;
    for (const x of values) {
      const t = total + x;
      if (Math.abs(total) >= Math.abs(x)) c += (total - t) + x;
      else c += (x - t) + total;
      total = t;
    }
    return c && isFinite(c) ? total + c : total;
  }

  /* --------------------------------------------------------------------------
   * The order book
   * ------------------------------------------------------------------------ */
  class OrderBook {
    /** opts.units: a Units (for $ helpers); opts.observer: fn(event) for animations. */
    constructor(opts = {}) {
      this.bids = new SortedLevels();
      this.asks = new SortedLevels();
      this.orders = new Map();
      this.units = opts.units || IDENTITY;
      this.observer = opts.observer || null;
    }
    _book(side) { return checkSide(side) === BID ? this.bids : this.asks; }
    _emit(ev) { if (this.observer) this.observer(ev); }

    // ---- queries ---------------------------------------------------------------
    /** Highest bid price in ticks, or null. */
    bestBid() { return this.bids.size ? this.bids.peekItem(-1)[0] : null; }
    /** Lowest ask price in ticks, or null. */
    bestAsk() { return this.asks.size ? this.asks.peekItem(0)[0] : null; }
    /** [[priceTicks, totalSizeLots], ...] best price first. */
    depth(side) {
      const book = this._book(side);
      const keys = side === ASK ? book.ascending() : book.descending();
      return keys.map((p) => [p, book.get(p).totalSize]);
    }

    // ---- commands --------------------------------------------------------------
    /** Submit a limit order; returns the fills it caused (possibly empty).
     *  tif = TimeInForce.GTC rests the remainder; TimeInForce.IOC cancels it (never rests). */
    addOrder(orderId, side, priceTicks, sizeLots, tif = TimeInForce.GTC) {
      checkSide(side); checkInt("priceTicks", priceTicks); checkInt("sizeLots", sizeLots);
      if (tif !== TimeInForce.GTC && tif !== TimeInForce.IOC) throw new TypeError(`tif must be "gtc" or "ioc", got ${JSON.stringify(tif)}`);
      if (sizeLots <= 0) throw new RangeError(`size_lots must be positive, got ${sizeLots}`);
      if (this.orders.has(orderId)) throw new RangeError(`order_id ${orderId} is already resting`);

      const fills = this._match(side, sizeLots, priceTicks);
      let remaining = sizeLots;
      for (const f of fills) remaining -= f.sizeLots;
      // The only difference between GTC and IOC: whether the remainder rests.
      if (remaining > 0 && tif === TimeInForce.GTC) {
        const book = this._book(side);
        let level = book.get(priceTicks);
        const fresh = level === undefined;
        if (fresh) { level = new PriceLevel(priceTicks); book.set(priceTicks, level); }
        const order = new Order(orderId, side, priceTicks, remaining);
        level.append(order);
        this.orders.set(orderId, order);
        this._emit({ type: "rest", orderId, side, priceTicks, sizeLots: remaining, newLevel: fresh, queuePosition: level.count });
      }
      return fills;
    }

    /** Remove a resting order. Returns false if the id isn't resting. */
    cancelOrder(orderId) {
      const order = this.orders.get(orderId);
      if (order === undefined) return false;
      this.orders.delete(orderId);
      const book = this._book(order.side);
      const level = book.get(order.priceTicks);
      level.remove(order);
      const emptied = level.isEmpty;
      if (emptied) book.delete(order.priceTicks);
      this._emit({ type: "cancel", orderId, side: order.side, priceTicks: order.priceTicks, sizeLots: order.sizeLots, levelRemoved: emptied });
      return true;
    }

    /** Buy (BID) or sell (ASK) sizeLots now; never rests. limitPrice = price protection. */
    marketOrder(side, sizeLots, limitPrice = null) {
      checkSide(side); checkInt("sizeLots", sizeLots);
      if (sizeLots <= 0) throw new RangeError(`size_lots must be positive, got ${sizeLots}`);
      if (limitPrice !== null && limitPrice !== undefined) checkInt("limitPrice", limitPrice);
      return this._match(side, sizeLots, limitPrice === undefined ? null : limitPrice);
    }

    /** The matching loop shared by limit and market orders (side = taker side). */
    _match(side, sizeLots, limitPrice) {
      const opp = opposite(side);
      const book = this._book(opp);
      const bestIndex = side === BID ? 0 : -1;
      const fills = [];
      let remaining = sizeLots;

      while (remaining > 0 && book.size) {
        const [price, level] = book.peekItem(bestIndex);
        if (limitPrice !== null) {
          const tooExpensive = side === BID && price > limitPrice;
          const tooCheap = side === ASK && price < limitPrice;
          if (tooExpensive || tooCheap) break;
        }
        // Time priority: always trade with the oldest order at this price.
        while (remaining > 0 && level.head !== null) {
          const maker = level.head;
          const traded = Math.min(remaining, maker.sizeLots);
          fills.push(Fill(maker.orderId, price, traded));
          remaining -= traded;
          const full = traded === maker.sizeLots;
          if (full) {
            level.remove(maker);
            this.orders.delete(maker.orderId);
          } else {
            // Partial fill: the maker keeps its place at the head.
            maker.sizeLots -= traded;
            level.totalSize -= traded;
          }
          this._emit({ type: "fill", takerSide: side, makerOrderId: maker.orderId, priceTicks: price, sizeLots: traded, full, makerRemaining: full ? 0 : maker.sizeLots });
        }
        if (level.isEmpty) { book.delete(price); this._emit({ type: "levelRemoved", side: opp, priceTicks: price }); }
      }
      return fills;
    }

    // ---- course helpers (read-only) ---------------------------------------------
    /** Same loop as _match but mutates nothing: {fills, unfilledLots}. */
    dryMatch(side, sizeLots, limitPrice = null) {
      const opp = opposite(side);
      const book = this._book(opp);
      const keys = side === BID ? book.ascending() : book.descending();
      const fills = [];
      let remaining = sizeLots;
      for (const price of keys) {
        if (remaining <= 0) break;
        if (limitPrice !== null && (side === BID ? price > limitPrice : price < limitPrice)) break;
        for (let o = book.get(price).head; o && remaining > 0; o = o.next) {
          const traded = Math.min(remaining, o.sizeLots);
          fills.push(Fill(o.orderId, price, traded));
          remaining -= traded;
        }
      }
      return { fills, unfilledLots: remaining };
    }
    /** Prices on one side, best first. */
    levelPrices(side) { const b = this._book(side); return side === ASK ? b.ascending() : b.descending(); }
    level(side, priceTicks) { return this._book(side).get(priceTicks); }
    /** The FIFO queue at one price: [{orderId, sizeLots}] oldest first. */
    queue(side, priceTicks) {
      const lv = this._book(side).get(priceTicks);
      return lv ? lv.orders().map((o) => ({ orderId: o.orderId, sizeLots: o.sizeLots })) : [];
    }
    /** 1-based position of a resting order in its queue, or null. */
    queuePosition(orderId) {
      const o = this.orders.get(orderId); if (!o) return null;
      let n = 1; for (let x = o.prev; x; x = x.prev) n++;
      return n;
    }
    /** Top n levels per side with $ / SOL conversions, for ladders and charts. */
    toLevels(n = Infinity) {
      const u = this.units;
      const side = (s) => this.levelPrices(s).slice(0, n).map((p) => {
        const lv = this._book(s).get(p);
        return { priceTicks: p, sizeLots: lv.totalSize, count: lv.count, price: u.price(p), size: u.size(lv.totalSize) };
      });
      return { bids: side(BID), asks: side(ASK) };
    }
    usd(ticks) { return this.units.price(ticks); }
    sol(lots) { return this.units.size(lots); }
    /** Mid in USD like snapshot.mid_price(): price(bid + ask) / 2, or null. */
    mid() {
      const b = this.bestBid(), a = this.bestAsk();
      return b === null || a === null ? null : this.units.price(b + a) / 2;
    }
    spreadBps() {
      const b = this.bestBid(), a = this.bestAsk(), mid = this.mid();
      return mid === null ? null : (this.units.price(a) - this.units.price(b)) / mid * 10000;
    }
    /** impact.lots_for_notional on this book: lots a taker must trade to spend/raise usd. */
    lotsForUsd(side, usd, limitTicks = null) {
      const opp = opposite(side);
      let remaining = usd, lots = 0;
      for (const p of this.levelPrices(opp)) {
        if (limitTicks !== null && (side === BID ? p > limitTicks : p < limitTicks)) break;
        const lv = this._book(opp).get(p);
        const price = this.units.price(p);
        const levelUsd = price * this.units.size(lv.totalSize);
        if (levelUsd >= remaining) {
          const usdPerLot = price * this.units.lotSize;
          const needed = -pyFloorDiv(-remaining, usdPerLot);
          return lots + Math.min(needed, lv.totalSize);
        }
        lots += lv.totalSize;
        remaining -= levelUsd;
      }
      return lots;
    }
    /** Same numbers as impact.simulate(), without touching the book. side: "buy" | "sell". */
    impact(side, targetUsd, opts = {}) {
      const maxSlippage = opts.maxSlippage === undefined ? DEFAULT_MAX_SLIPPAGE : opts.maxSlippage;
      const taker = side === "buy" ? BID : side === "sell" ? ASK : null;
      if (!taker) throw new TypeError(`side must be 'buy' or 'sell', got ${side}`);
      const mid = this.mid();
      if (mid === null) return null;
      const limit = maxSlippage === null ? null : protectionLimitTicks(this.units.tickSize, taker, mid, maxSlippage);
      const lots = this.lotsForUsd(taker, targetUsd, limit);
      const fills = lots > 0 ? this.dryMatch(taker, lots, limit).fills : [];
      return summarize(this.units, "book", side, targetUsd, mid, fills);
    }
    /** USD resting within band (0.02 = 2%) of mid: [bidUsd, askUsd]. */
    depthWithin(band) {
      const mid = this.mid(); if (mid === null) throw new Error("one-sided book");
      const u = this.units, b = [], a = [];
      for (const p of this.levelPrices(BID)) { const px = u.price(p); if (px < mid * (1 - band)) break; for (const o of this.bids.get(p).orders()) b.push(px * u.size(o.sizeLots)); }
      for (const p of this.levelPrices(ASK)) { const px = u.price(p); if (px > mid * (1 + band)) break; for (const o of this.asks.get(p).orders()) a.push(px * u.size(o.sizeLots)); }
      return [pySum(b), pySum(a)];
    }
    /** Deep copy (same ids, same FIFO order, no observer). */
    clone() {
      const c = new OrderBook({ units: this.units });
      for (const s of [BID, ASK]) for (const p of this._book(s).ascending()) for (const o of this._book(s).get(p).orders()) c.addOrder(o.orderId, s, p, o.sizeLots);
      return c;
    }
  }

  /* --------------------------------------------------------------------------
   * snapshot.py + convert.py + impact.py
   * ------------------------------------------------------------------------ */
  const DEFAULT_MAX_SLIPPAGE = 0.10;
  const DEFAULT_SIZES_USD = [1000, 10000, 100000, 1000000];

  class Snapshot {
    /** d: {venue, symbol, fetchedAt, tickSize, lotSize, bids: [[ticks, lots]], asks, meta} */
    constructor(d) {
      this.venue = d.venue; this.symbol = d.symbol || ""; this.fetchedAt = d.fetchedAt || 0;
      this.units = d.units || new Units(d.tickSize, d.lotSize);
      this.tickSize = this.units.tickSize; this.lotSize = this.units.lotSize;
      this.bids = d.bids || []; this.asks = d.asks || []; this.meta = d.meta || {};
    }
    /** From BookSnapshot.to_dict() JSON (snake_case keys, decimal strings). */
    static fromDict(d) {
      return new Snapshot({ venue: d.venue, symbol: d.symbol, fetchedAt: Number(d.fetched_at), tickSize: d.tick_size, lotSize: d.lot_size, bids: d.bids.map(([p, s]) => [Number(p), Number(s)]), asks: d.asks.map(([p, s]) => [Number(p), Number(s)]), meta: d.meta || {} });
    }
    /** From an export venue (aggregated [usd, sol] levels): infers exact tick/lot sizes. */
    static fromUsdLevels(v) {
      const all = v.bids.concat(v.asks);
      const pd = Math.min(10, Math.max(0, ...all.map(([p]) => decimalsOf(p))));
      const sd = Math.min(10, Math.max(0, ...all.map(([, s]) => decimalsOf(s))));
      const toT = (p) => Math.round(p * POW10[pd]), toL = (s) => Math.round(s * POW10[sd]);
      const conv = (lv) => lv.map(([p, s]) => [toT(p), toL(s)]).filter(([t, l]) => t > 0 && l > 0);
      return new Snapshot({ venue: v.venue, symbol: v.symbol, fetchedAt: v.fetched_at || 0, tickSize: "1e-" + pd, lotSize: "1e-" + sd, bids: conv(v.bids), asks: conv(v.asks), meta: v.meta || {} });
    }
    price(ticks) { return this.units.price(ticks); }
    size(lots) { return this.units.size(lots); }
    bestBid() { return this.bids.length ? this.bids[0][0] : null; }
    bestAsk() { return this.asks.length ? this.asks[0][0] : null; }
    midPrice() { const b = this.bestBid(), a = this.bestAsk(); return b === null || a === null ? null : this.price(b + a) / 2; }
    spreadBps() { const b = this.bestBid(), a = this.bestAsk(), m = this.midPrice(); return m === null ? null : (this.price(a) - this.price(b)) / m * 10000; }
    notional(side) { return pySum((side === BID ? this.bids : this.asks).map(([p, s]) => this.price(p) * this.size(s))); }
    validate() {
      for (const [name, orders, desc] of [["bids", this.bids, true], ["asks", this.asks, false]]) {
        for (let i = 1; i < orders.length; i++) {
          const a = orders[i - 1][0], b = orders[i][0];
          if (desc ? a < b : a > b) throw new Error(`${name} are not sorted best-first`);
        }
        if (orders.some(([p, s]) => s <= 0 || p <= 0)) throw new Error(`${name} contain a non-positive price or size`);
      }
      const b = this.bestBid(), a = this.bestAsk();
      if (b !== null && a !== null && b >= a) throw new Error(`book is crossed: best bid ${b} >= best ask ${a}`);
    }
    /** convert.load_book: replay every resting order into a fresh OrderBook. */
    toBook(opts = {}) {
      this.validate();
      const book = new OrderBook({ units: this.units, observer: opts.observer });
      let id = 0;
      for (const [side, orders] of [[BID, this.bids], [ASK, this.asks]]) {
        for (const [p, s] of orders) {
          id += 1;
          if (book.addOrder(id, side, p, s).length) throw new Error("snapshot is crossed: loading it produced a trade");
        }
      }
      return book;
    }
  }
  function decimalsOf(x) {
    const s = String(x);
    const e = /e-(\d+)$/i.exec(s);
    if (e) { const base = s.split(/e/i)[0]; return (base.split(".")[1] || "").length + parseInt(e[1], 10); }
    return (s.split(".")[1] || "").length;
  }

  /** impact.protection_limit: worst acceptable price in ticks. tickSize is a float. */
  function protectionLimitTicks(tickSize, side, mid, maxSlippage) {
    if (side === BID) return Math.floor(mid * (1 + maxSlippage) / tickSize);
    return Math.ceil(mid * (1 - maxSlippage) / tickSize);
  }
  function protectionLimit(snap, side, mid, maxSlippage) { return protectionLimitTicks(snap.tickSize, side, mid, maxSlippage); }

  /** impact.lots_for_notional, walking the snapshot order by order. */
  function lotsForNotional(snap, side, targetUsd, limitTicks = null) {
    const levels = side === BID ? snap.asks : snap.bids;
    let remaining = targetUsd, lots = 0;
    for (const [p, s] of levels) {
      if (limitTicks !== null && (side === BID ? p > limitTicks : p < limitTicks)) break;
      const price = snap.price(p);
      const levelUsd = price * snap.size(s);
      if (levelUsd >= remaining) {
        const usdPerLot = price * snap.lotSize;
        const needed = -pyFloorDiv(-remaining, usdPerLot);
        return lots + Math.min(needed, s);
      }
      lots += s;
      remaining -= levelUsd;
    }
    return lots;
  }

  function summarize(units, venue, side, targetUsd, mid, fills) {
    let filledLots = 0;
    const prices = new Set();
    for (const f of fills) { filledLots += f.sizeLots; prices.add(f.priceTicks); }
    const filledUsd = pySum(fills.map((f) => units.price(f.priceTicks) * units.size(f.sizeLots)));
    const filledBase = units.size(filledLots);
    const avg = filledBase ? filledUsd / filledBase : null;
    let impact = null;
    if (avg !== null) impact = side === "buy" ? (avg - mid) / mid * 10000 : (mid - avg) / mid * 10000;
    return {
      venue, side, targetUsd, filledUsd, filledBase, avgPrice: avg, midPrice: mid, impactBps: impact,
      levelsSwept: prices.size, fullyFilled: filledUsd >= targetUsd * 0.999, fills,
    };
  }

  /** impact.simulate: one market order of targetUsd on a fresh book from snap. */
  function simulate(snap, side, targetUsd, maxSlippage = DEFAULT_MAX_SLIPPAGE) {
    if (side !== "buy" && side !== "sell") throw new TypeError(`side must be 'buy' or 'sell', got ${side}`);
    if (!(targetUsd > 0)) throw new RangeError("target_usd must be positive");
    const mid = snap.midPrice();
    if (mid === null) throw new Error(`${snap.venue}: cannot measure impact on a one-sided book`);
    const taker = side === "buy" ? BID : ASK;
    const limit = protectionLimit(snap, taker, mid, maxSlippage);
    const lots = lotsForNotional(snap, taker, targetUsd, limit);
    const fills = lots > 0 ? snap.toBook().marketOrder(taker, lots, limit) : [];
    return summarize(snap.units, snap.venue, side, targetUsd, mid, fills);
  }
  function impactCurve(snap, side = "buy", sizes = DEFAULT_SIZES_USD, maxSlippage = DEFAULT_MAX_SLIPPAGE) {
    return sizes.map((s) => simulate(snap, side, s, maxSlippage));
  }
  /** Trade sizes evenly spaced on a log scale (impact.log_spaced_sizes). */
  function logSpacedSizes(lo = 1000, hi = 1000000, perDecade = 8) {
    const n = Math.round(Math.log10(hi / lo) * perDecade);
    return Array.from({ length: n + 1 }, (_, i) => lo * Math.pow(hi / lo, i / n));
  }

  OBZ.engine = {
    BID, ASK, TimeInForce, opposite, Order, Fill, PriceLevel, SortedLevels, OrderBook, Units, Snapshot,
    parseDecimal, pyFloorDiv, pySum, protectionLimit, protectionLimitTicks, lotsForNotional, simulate,
    impactCurve, logSpacedSizes, DEFAULT_MAX_SLIPPAGE, DEFAULT_SIZES_USD,
  };
})(window.OBZ = window.OBZ || {});
