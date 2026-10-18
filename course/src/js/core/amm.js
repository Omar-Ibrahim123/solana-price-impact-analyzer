/* core/amm.js: constant-product AMM (x * y = k), a port of src/impact_analyzer/amm.py.
 *
 * A pool holds x USD and y SOL. A buyer adds dx USD and receives y - k / (x + dx) SOL;
 * the price moves continuously along the curve. With no fees, small-trade impact is about
 * dx / x (in bps: dx / x * 1e4), so doubling the pool halves the impact.
 *
 *   const pool = OBZ.amm.AmmPool.atPrice(104, 2_000_000);   // $2M per side at $104
 *   pool.buyImpactBps(10_000)                              // same number amm.py gives
 *   pool.buy(10_000)   -> {solOut, avgPrice, impactBps, after: AmmPool}   (course helper)
 */
(function (OBZ) {
  "use strict";

  class AmmPool {
    constructor(usdReserve, solReserve, feeBps = 0) {
      if (!(usdReserve > 0) || !(solReserve > 0)) throw new RangeError("reserves must be positive");
      this.usdReserve = usdReserve;
      this.solReserve = solReserve;
      this.feeBps = feeBps;
      Object.freeze(this);
    }
    /** A pool whose spot price is `price` and that holds `usdReserve` per side. */
    static atPrice(price, usdReserve, feeBps = 0) { return new AmmPool(usdReserve, usdReserve / price, feeBps); }
    get spotPrice() { return this.usdReserve / this.solReserve; }
    get k() { return this.usdReserve * this.solReserve; }

    /** Impact of spending usdIn on SOL, versus the spot price before the trade (bps). */
    buyImpactBps(usdIn) {
      const x = this.usdReserve, y = this.solReserve;
      const dx = usdIn * (1 - this.feeBps / 10000); // the fee stays in the pool
      const solOut = y - (x * y) / (x + dx);
      const avg = usdIn / solOut;
      return (avg - this.spotPrice) / this.spotPrice * 10000;
    }
    /** Impact of selling enough SOL to receive usdOut, versus spot (bps). */
    sellImpactBps(usdOut) {
      const x = this.usdReserve, y = this.solReserve;
      if (usdOut >= x) throw new RangeError("cannot withdraw the whole USD reserve");
      const dyAfterFee = x * y / (x - usdOut) - y;
      const dy = dyAfterFee / (1 - this.feeBps / 10000);
      const avg = usdOut / dy;
      return (this.spotPrice - avg) / this.spotPrice * 10000;
    }

    // ---- course helpers: full trade results -----------------------------------------
    /** Spend usdIn: {usdIn, solOut, avgPrice, impactBps, priceAfter, after} */
    buy(usdIn) {
      const x = this.usdReserve, y = this.solReserve;
      const dx = usdIn * (1 - this.feeBps / 10000);
      const solOut = y - (x * y) / (x + dx);
      const after = new AmmPool(x + usdIn, y - solOut, this.feeBps);
      return { usdIn, solOut, avgPrice: usdIn / solOut, impactBps: this.buyImpactBps(usdIn), priceAfter: after.spotPrice, after };
    }
    /** Sell solIn SOL: {solIn, usdOut, avgPrice, impactBps, priceAfter, after} */
    sell(solIn) {
      const x = this.usdReserve, y = this.solReserve;
      const dy = solIn * (1 - this.feeBps / 10000);
      const usdOut = x - (x * y) / (y + dy);
      const after = new AmmPool(x - usdOut, y + solIn, this.feeBps);
      const avg = usdOut / solIn;
      return { solIn, usdOut, avgPrice: avg, impactBps: (this.spotPrice - avg) / this.spotPrice * 10000, priceAfter: after.spotPrice, after };
    }
    /** Points [usd, sol] on the curve x*y=k between usd reserves lo..hi, for drawing. */
    curve(lo, hi, n = 64) {
      const k = this.k, pts = [];
      for (let i = 0; i <= n; i++) { const x = lo + (hi - lo) * i / n; pts.push([x, k / x]); }
      return pts;
    }
  }

  /** USD resting within band (0.02 = 2%) of mid, as [bidUsd, askUsd]. Works on a Snapshot. */
  function depthWithin(snap, band) {
    const mid = snap.midPrice();
    if (mid === null) throw new Error("one-sided book");
    const b = [], a = [];
    for (const [p, s] of snap.bids) if (snap.price(p) >= mid * (1 - band)) b.push(snap.price(p) * snap.size(s));
    for (const [p, s] of snap.asks) if (snap.price(p) <= mid * (1 + band)) a.push(snap.price(p) * snap.size(s));
    return [OBZ.engine.pySum(b), OBZ.engine.pySum(a)]; // Python's sum(): compensated
  }

  /** An AMM pool with the same liquidity near the price as snap (amm.equivalent_pool). */
  function equivalentPool(snapOrBook, band = 0.02) {
    const isBook = typeof snapOrBook.depthWithin === "function";
    const [bidUsd, askUsd] = isBook ? snapOrBook.depthWithin(band) : depthWithin(snapOrBook, band);
    const xFromAsks = askUsd / (Math.sqrt(1 + band) - 1);
    const xFromBids = bidUsd / (1 - Math.sqrt(1 - band));
    const mid = isBook ? snapOrBook.mid() : snapOrBook.midPrice();
    return AmmPool.atPrice(mid, (xFromAsks + xFromBids) / 2);
  }

  OBZ.amm = { AmmPool, depthWithin, equivalentPool };
})(window.OBZ = window.OBZ || {});
