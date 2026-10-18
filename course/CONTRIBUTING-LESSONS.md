# Writing lessons for "Order Books From Zero"

This is the contract for anyone (human or agent) writing a chapter, a sandbox tool or the
interview page. The foundation (design system, components, engine, data, build, tests) is done;
you build on it. **Chapter 2 (`src/js/chapters/02-order-book.js`) is the reference
implementation: read it first and copy its shape.**

The reader is a curious high-school senior: algebra yes; finance, crypto and programming no.
The course will be sent to an interviewer at Ellipsis Labs (Phoenix), so it must be correct,
clear and polished.

---

## 1. Build, preview, test

```bash
python course/build.py                 # -> course/dist/order-books-from-zero.html and tests.html
python course/tests/make_golden.py     # only if the Python engine changes (rewrites golden.json)
python -m http.server 8765 --directory course/dist   # then open http://localhost:8765/
```

- `build.py` is stdlib-only. It **fails loudly** on: a missing file, a colour value outside
  `tokens.css`, `fetch`/external scripts, a `[[term]]` that isn't in the glossary, an
  `OBZ.<name>` used but never defined, `</script` inside JS, unbalanced HTML, a page over 2 MB.
- Open `dist/tests.html`. The big banner and `document.title` say `PASS n/n` or `FAIL`;
  `window.OBZ_TEST_RESULT` has the details. Tests include: engine unit tests, the golden
  comparison (2,000 ops; JS fills must equal Python's exactly), impact and AMM vs Python, glossary
  integrity, **every chapter renders with no console errors and no unknown terms** (it also clicks
  through every Stepper), quiz data shape, data loader, store, router and components.
- Check your chapter at **1280 px and 375 px**, light and dark (toggle top right), keyboard only,
  and with reduced motion (DevTools → Rendering → `prefers-reduced-motion: reduce`).

## 2. Files and who owns them

```
src/shell.html                 page frame (top bar, footer)             foundation
src/css/tokens.css             ALL colours, type, spacing tokens         foundation
src/css/components.css         component styles (no colour values)       foundation
src/js/core/*.js               util, engine, amm, store, router,         foundation
                               glossary, data, ui
src/js/chapters/NN-*.js        one file per chapter                      one lesson agent each
src/js/play/*.js               sandbox tools                             see file headers
src/js/interview/interview.js  interview page                            chapters 11–13 agent
src/js/app.js                  routing + chapter layout                  foundation
```

- Edit **only your own files**. Everything is concatenated into one script in a fixed order
  (core → chapters/registry → chapters 01..13 → play → interview → app), each file wrapped in
  `(function (OBZ) { "use strict"; ... })(window.OBZ = window.OBZ || {});`. Keep top-level names
  inside your IIFE so files never collide.
- Need a new shared component or a core change? Don't edit core files yourself; write the widget
  inside your chapter file and note it in your report (the integrator may promote it).
- **Glossary terms**: `src/js/core/glossary.js` is grouped by chapter (`// ---- 5. impact` …).
  If you need a new term, add it **at the end of your chapter's group** (this keeps parallel edits
  in different places so git merges them cleanly). Most terms you need already exist (156).
- CSS for something chapter-specific: prefer existing classes (section 6). If you truly need a
  rule, use inline `style` with `var(--token)` values only, never colour literals.

## 3. The chapter module

```js
(function (OBZ) {
  "use strict";
  const { h, fmt } = OBZ.util;

  OBZ.chapters.register({
    id: "impact",                 // keep the id from the placeholder (quiz progress is stored by it)
    number: 5,
    title: "Price impact",
    summary: "One sentence: the lede under the title and on chapter cards.",
    goals: [                      // 3–4 "you'll be able to…" items, each starting with a verb
      "Compute an average fill price and its impact in bps by hand",
      "...",
    ],
    status: "ready",              // was "soon"; "ready" turns on the 2–3 question rule in the tests

    render(el, ctx) {
      const { ui, data, engine } = ctx;
      const ex = ctx.section("explain", "A title that says the idea");
      ex.append(ui.prose(`Paragraphs with [[price-impact|price impact]] terms...`));

      const see = ctx.section("see", "...");
      see.append(ui.Figure({ children: mySvg, caption: "...", alt: "..." }));

      const tr = ctx.section("try", "...");
      tr.append(ui.TryIt({ title: "...", intro: "...", children: myWidget(ctx) }));
      // Do NOT add a "check" section: the app renders Check with your quiz automatically.
    },

    quiz: [
      {
        q: "Question text (rich text allowed)",
        options: [
          { text: "Wrong answer", why: "Why it's wrong, kindly, and what the right idea is." },
          { text: "Right answer", why: "Why it's right, with the arithmetic if there is some." },
          { text: "Wrong answer", why: "..." },
        ],
        answer: 1,                // index of the right option
      },
    ],
  });
})(window.OBZ = window.OBZ || {});
```

The app wraps your chapter: header (number, title, summary, goals, section links), your
sections, the **Check** section with your quiz, and the previous/next footer. Answering every
question correctly marks the chapter complete (top-bar progress ring). Visiting it sets
"Resume chapter N".

### `ctx` (passed to chapter and tool `render`)

| Field | What |
| --- | --- |
| `ctx.section(kind, title)` | chapters only. `kind`: `"explain"`, `"see"`, `"try"`. Appends a section, returns its body element. |
| `ctx.ui`, `ctx.h`, `ctx.fmt`, `ctx.util` | components, DOM builder, number formatting, helpers |
| `ctx.engine`, `ctx.amm` | the matching engine and AMM math (section 5) |
| `ctx.data` | the active dataset (section 5) |
| `ctx.store`, `ctx.glossary`, `ctx.router` | per-viewer state, glossary lookups, routes |
| `ctx.onData(fn)` | call `fn(dataset)` when the reader loads other data; auto-unsubscribed on navigation |
| `ctx.onCleanup(fn)` | run `fn` when the reader leaves (clear your timers!) |
| `ctx.placeholder(text?)` | the "coming soon" box |
| `ctx.chapter` / `ctx.tool` | your own module |

## 4. Components (`OBZ.ui`)

Every component returns a DOM element. Ones that change later expose `el.api`.
`h(tag, props, ...children)` builds elements: **strings become text, never HTML** (use
`props.html` only for trusted literal markup, never for data). Props: `class`, `id`, `text`,
`attrs: {...}` (for `for`, `aria-*`, `role`), `dataset`, `style` (object or string), `on: {click}`,
and any DOM property (`type`, `value`, `hidden`, `tabIndex`…). SVG tags work too.

**Rich text** (authored strings only, never data):
`**bold**`, `*italic*`, `` `code` ``, `[[term-id]]` or `[[term-id|shown text]]` (glossary popover),
`[link text](#/learn/5)` (only `#/…` and `https://` links are allowed).

```js
ui.rich("A [[spread]] of **10 bps**")    // DocumentFragment
ui.p("One paragraph of rich text")       // <p>
ui.prose(`Paragraph one.

Paragraph two.

- bullet one
- bullet two`)                            // blank lines split paragraphs; "- " lines -> list; "1. " -> ordered
ui.Term("mid-price", "the mid")          // the popover term on its own
```

**Layout**

```js
ui.Callout({ kind: "tip", title: "Worked example", body: "rich prose string or a node" })
//   kind: note | tip | warn | real ("In the real world") | project ("In this project")
ui.Figure({ label: "Figure 5.1", children: svgOrNode, caption: "rich", alt: "full text alternative" })
ui.TryIt({ title: "…", intro: "rich", children: node })
ui.Stat({ label: "Best bid", value: "$103.75", tone: "bid" | "ask" | "accent", sub: "small print" })  // .api.set(v, sub)
ui.StatGrid([stat1, stat2], { live: true })          // live: aria-live polite
ui.Table({ caption, columns: [{ key, label, align: "left", format: (v, row) => …, value: (row) => … }], rows, dense })
ui.ProgressBar({ value: 3, max: 13, label: "Chapters done" })   // .api.set(v, max)
```

**Controls**

```js
ui.Button({ label: "Run", onClick, variant: "primary" | "ghost" | "buy" | "sell", small: true })
ui.Segmented({ label: "Side", options: [{ value: "buy", label: "Buy" }], value: "buy", onChange })  // .api.set(v)
ui.VenuePicker({ venues: data.venues(), value: "phoenix", onChange })   // venue colours + names
ui.Slider({ label: "Trade size", min: 1e3, max: 1e6, value: 1e4, log: true, format: fmt.usdCompact, onInput })
ui.NumberCheck({ question: "rich", answer: 9.6 /* or () => n */, tolerance: 0.05, unit: "bps",
                 explain: "shown when right (rich)", hint: "shown when wrong" })
ui.DataLoader({ onLoad(dataset) {} })     // paste/upload an export; switches the active dataset
```

**Teaching**

```js
ui.Stepper({ steps: ["caption 1 (rich)", "caption 2"], stage: svg, render: (i) => drawStep(i),
             interval: 2000, label: "What this animation shows" })
//   Play / Step / Back / Reset; with reduced motion there is no Play, only stepping.
//   Your render(i) must draw step i from scratch (it is called for any i, in any order).
//   For movement use CSS transitions (they are switched off automatically under reduced motion).
ui.Quiz({ id: "unique-id", questions, onComplete })   // chapters get this for free from `quiz`
ui.Flashcards({ id: "deck-id", cards: [{ id: "stable-id", q: "rich", a: "rich prose" }], title })
ui.CodeExercise({
  id: "ex-append", title: "Exercise 1 · Append to a level", level: "easy" | "medium" | "hard",
  brief: "rich prose", starter: "function f() {\n}", prelude: "code defined before the learner's",
  exports: ["f"],                          // names the tests can reach as A.f
  tests: [{ name: "shown to the learner", code: "eq(A.f(1), 2);" }],
  //   test code is a STRING run as a function of (A, eq, near, assert, walk):
  //   eq(a, b, msg) deep-equal via JSON; near(a, b, tol, msg); assert(cond, msg);
  //   walk(level, idKey = "id") -> ids head→tail, checking prev/next/tail pointers
  hints: ["gentle", "more specific", "almost the answer"],   // exactly 3
  solution: "reference code", timeoutMs: 2000,
})
//   Runs in a Web Worker made from a Blob, killed after timeoutMs (infinite loops are safe).
//   console.log output is shown. Code and pass state are saved per viewer.
```

**Market views**

```js
ui.Ladder({ levels: book /* OrderBook */ or { bids: [{ price, size, count? }], asks: [...] },
            rows: 8, priceDigits: 2, label: "Kraken order book", onSelect: (level, side) => … })
//   .api.update(levels), .api.select(side, price). Arrow keys move between rows.
ui.DepthChart({ levels: book, band: 0.01, unit: "sol" | "usd", marker: priceOrNull, height: 200, alt })
ui.LineChart({
  series: [{ name: "Phoenix", color: "--phoenix", points: [[x, y | null, full?]], dash: false, markers: true }],
  x: { log: true, label: "Trade size", format: fmt.usdCompact, ticks: [1e3, 1e4, 1e5, 1e6] },
  y: { label: "Impact (bps)", format: (v) => v.toFixed(0), min: 0 },
  height: 260, alt: "text alternative", table: true,      // table: "Show the numbers" <details>
  annotations: [{ x: 1e5, label: "$100K", color: "--muted" }],
})
//   y = null leaves a gap; third element false draws a hollow (partial-fill) marker.
//   Colours are token NAMES; charts redraw on resize and theme change. .api.update({...})
ui.HexView({ bytes: hexStringOrUint8Array, baseOffset: 0, label: "Phoenix market account",
             fields: [{ name: "bids_size", offset: 16, size: 8, type: "u64", value?, explain: "rich" }],
             onSelect: (field, offset) => … })
//   types decoded little-endian: u8/u16/u32/u64/u128, i8/i16/i32/i64, bool, else hex. .api.select(offset)
```

## 5. Engine, AMM and data

```js
const { BID, ASK, OrderBook, Snapshot, Units } = OBZ.engine;
const book = new OrderBook({ units: new Units("0.01", "0.001") });   // $ per tick, SOL per lot
book.addOrder(1, ASK, 15000, 5);        // -> [Fill]   (ids, ticks, lots are integers)
book.marketOrder(BID, 12, null);         // -> [{makerOrderId, priceTicks, sizeLots}]
book.cancelOrder(1);                     // -> true / false (unknown id)
book.bestBid(); book.bestAsk(); book.depth(BID)       // [[priceTicks, totalLots]] best first
book.dryMatch(BID, 12, limit)            // {fills, unfilledLots}: same loop, mutates nothing
book.queue(ASK, 15000); book.queuePosition(id); book.levelPrices(BID); book.toLevels(8)
book.mid(); book.spreadBps(); book.usd(ticks); book.sol(lots)
book.lotsForUsd(BID, 10000, limitTicks); book.impact("buy", 10000, { maxSlippage: 0.10 })
book.depthWithin(0.02); book.clone()
new OrderBook({ observer: (ev) => … })   // ev.type: "rest" | "fill" | "cancel" | "levelRemoved" (for animations)
OBZ.engine.simulate(snapshot, "buy", 1e5, 0.10)   // = impact.simulate; result fields camelCase
OBZ.engine.impactCurve(snapshot, "sell", [1e3, 1e4]); OBZ.engine.logSpacedSizes(1e3, 1e6, 8)

const pool = OBZ.amm.AmmPool.atPrice(104.05, 2_000_000, /* feeBps */ 0);
pool.buyImpactBps(1e4); pool.sellImpactBps(1e4); pool.buy(1e4) /* {solOut, avgPrice, impactBps, priceAfter, after} */
pool.sell(10); pool.spotPrice; pool.k; pool.curve(lo, hi, n)
OBZ.amm.equivalentPool(snapshotOrBook, 0.02)        // pool "as deep as" the book within ±2%
```

The engine is the project's engine: `tests.html` replays 2,000 operations from `golden.json` and
requires identical fills, and `simulate` matches `impact.py` bit for bit on the real snapshots.
Write about it with confidence ("this page runs a JavaScript port of `orderbook.py` that
reproduces its fills exactly").

**Data** (`OBZ.data`, or `ctx.data`):

```js
data.active()            // {source, label, venues: [...], ammUsdReserve, jupiter, timeseries, phoenixAccount}
data.venues()            // ["phoenix", "kraken", "coinbase"]
data.venue("kraken")     // {venue, label, symbol, fetchedAt, mid, spreadBps, bids: [[usd, sol]], asks,
                         //  curve: {buy: [[usd, bps|null, full]], sell}, meta, feeBps, feeSource, depthUsd}
data.snapshot("phoenix") // OBZ.engine.Snapshot (Phoenix: the raw 1,638 orders; others: aggregated levels)
data.book("phoenix")     // a FRESH OrderBook each call (mutate it freely)
data.phoenix()           // raw Phoenix summary: slot, address, taker_fee_bps, n_bids, junk counts...
data.label("phoenix")    // "Phoenix";  data.colorVar("phoenix") -> "--phoenix"
ctx.onData(redraw)       // the reader may load their own export at any time
```

Built-in data: real books fetched **18 Oct 2026, 04:31 UTC** (within half a second): Phoenix
SOL/USDC (slot 458,302,883, best bid $103.750, best ask $104.350, spread ≈ 57.7 bps, taker fee
2 bps, junk asks at $9,999,999,999 and bids at $0.001), Kraken SOL/USD (103.94 / 103.95,
≈ 0.96 bps, base-tier fee 40 bps), Coinbase SOL/USD (103.95 / 103.96, ≈ 0.96 bps, 120 bps).
`timeseries`, `jupiter` and `phoenixAccount` (real account bytes) are **null/empty until the
v2 export lands** (`course/data/export.json`, picked up by `build.py`). Code for them must
handle "not there yet" gracefully (a short note, not an error).

Other helpers: `OBZ.util.fmt.usd(v, 2)`, `.usdCompact`, `.price(v, digits)`, `.sol`, `.bps(v)`,
`.pct`, `.int`, `.num`, `.date(unixSeconds)`; `OBZ.util.reducedMotion()`, `isDark()`,
`cssVar("--bid")`, `onThemeChange(fn)`, `debounce`, `clamp`, `uid`.
Store: `OBZ.store.get/set(key)` for small per-viewer widget state (namespaced key please, e.g.
`"ch5.lastSize"`); it already falls back to memory when storage is blocked.

## 6. Design rules

- **Colours only through tokens**: `var(--bid)`, `var(--ask)`, `var(--mine)`, `var(--accent)`,
  venues `--phoenix --kraken --coinbase --amm` (and `--amm-alt` grey for the theoretical x·y=k
  line), surfaces `--panel --panel-2 --line --muted --ink`, soft fills `--bid-soft --ask-soft …`.
  Charts take token names (`color: "--kraken"`).
- **Bid/ask are never colour-only**: always pair with "▲ BID" / "▼ ASK", words, or shapes.
- Phases look different on purpose (Explain plain prose; See and Try in framed panels; Try has a
  dotted "workbench" background). Put the main interactive in **Try**, the explanatory visual in
  **See**.
- Useful classes: `.prose` (68ch measure), `.stack` / `.stack-lg` (vertical rhythm), `.grid-2`,
  `.grid-3`, `.btn-row`, `.card`, `.formula` (a formula chip), `.readout-panel` (live
  result next to a widget; give it `aria-live="polite"`), `.fine` (small muted), `.eyebrow`,
  `.mono`, `.lede`, `.table-wrap` (horizontal scroll inside), `.sr-only`.
- **SVG figures**: `h("svg", { class: "diagram diagram-md", viewBox: "0 0 440 300", attrs: { role: "img", "aria-label": "…" } })`.
  Classes: `.box .box-bid .box-ask .box-accent .line .line-accent .line-dash .t-muted .t-mono .t-bold
  .t-bid .t-ask .t-accent .fill-accent .fill-bid .fill-ask .hl .dim .fade`. `diagram-md` caps the
  width at 540 px, `diagram-sm` at 400 px. Keep text ≥ 13 px in viewBox units for a ~440-unit-wide
  viewBox so it stays readable on a phone.
- Phone: everything must work at 360 px with no horizontal page scroll. Wide things go inside
  `ui.Figure` (scrolls inside) or `.table-wrap`. Tap targets ≥ 44 px come from the components; if
  you make your own buttons use `ui.Button`.

## 7. Writing rules

- **Audience**: a smart 17-year-old who has never traded anything. Short sentences. One idea per
  paragraph. Everyday analogies (queues at a ticket counter, a coat check, a used-games shop),
  then the precise version.
- **Define every term on first use with `[[term]]`** (each chapter, not just the first time in
  the course). Don't link the same term more than once per section.
- **Explain → See → Try → Check**, in that order:
  - Explain: 250–500 words in 2–4 `ui.prose` blocks, plus at most two Callouts. A worked example
    on real numbers (from `data` or the figures above) is the best thing you can include.
  - See: one figure or Stepper, captioned, with a full `alt` text (what a sighted reader learns).
  - Try: one main widget on **real data** where possible, plus a small "your turn" task
    (`NumberCheck`, a prediction, a toggle). Say what to try in the intro.
  - Check: 2–3 questions (via `quiz`). Each tests understanding, not recall of wording. 3–4
    options; **every option has a `why`**; wrong-answer explanations name the misconception
    kindly ("That's the half-spread…") and point to the right idea.
- **Accuracy first**: only claim what the project measured or what is standard knowledge. Quote
  real numbers with their date ("on 18 Oct 2026 at 04:31 UTC"). Say "in this snapshot" rather
  than generalising from one moment. If unsure, leave it out.
- Tone: calm, warm, confident; no hype, no exclamation marks, no "simply"/"just"/"obviously".
  Second person ("you") is fine. US spelling of numbers ($1,000, 10 bps).
- Connect to the project: name the Python file that does the thing (`orderbook.py`,
  `impact.py`, `phoenix.py`…) where it helps, in a `project` Callout or a sentence.
- Link forward/back with `[chapter 5](#/learn/5)` when an idea is covered elsewhere.

## 8. Accessibility checklist (built into the components; keep it true for your own widgets)

- Every control is a real `<button>`/`<input>` (or `ui.*` control), reachable by Tab, with the
  global focus ring. Arrow-key widgets use a roving tabindex like `ui.Ladder`.
- Results that change go in an `aria-live="polite"` element (`StatGrid({live: true})`,
  `.readout-panel`).
- Canvas/SVG has `role="img"` + `aria-label`, and the figure has `alt` text; charts with numbers
  offer `table: true`.
- Animation: use `ui.Stepper` or CSS transitions; never auto-play long animations; respect
  `OBZ.util.reducedMotion()` for anything driven by JS timers.
- Clear intervals in `ctx.onCleanup`.

## 9. Done checklist for a chapter

- [ ] `status: "ready"`, 3–4 goals, a one-sentence `summary`
- [ ] Explain, See and Try sections via `ctx.section`; no hand-made Check section
- [ ] every term linked with `[[…]]` on first use; `python course/build.py` passes (it rejects unknown terms)
- [ ] the See figure has a caption and a full `alt`
- [ ] Try uses real data (or says clearly that it is an example), handles `ctx.onData`
- [ ] 2–3 quiz questions, every option has a `why`, the answer index is right
- [ ] `dist/tests.html` shows PASS (your chapter renders with zero console errors)
- [ ] looks right at 1280 px and 375 px, light and dark; works with keyboard only and with reduced motion
- [ ] no colour literals, no external requests, no `innerHTML` with data
