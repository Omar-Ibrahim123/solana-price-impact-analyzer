/* core/ui.js: the course's components. Every component is a function that returns a DOM
 * element; components that change later expose `el.api` (e.g. ladder.api.update(levels)).
 * See course/CONTRIBUTING-LESSONS.md for a usage example of each one.
 *
 * Text helpers   rich(text), p(text), prose(text)          ** bold **, *em*, `code`, [[term|label]], [label](#/learn/3)
 * Layout         Section, Callout, Figure, TryIt, Stat, StatGrid, Table, ProgressBar
 * Controls       Button, Segmented, Slider, VenuePicker, NumberCheck, DataLoader
 * Teaching       Term, Stepper, Quiz, Flashcards, CodeExercise
 * Market views   Ladder, LineChart, DepthChart, HexView
 */
(function (OBZ) {
  "use strict";
  const { h, clear, fmt, uid, reducedMotion, cssVar, onThemeChange } = OBZ.util;

  /* =====================================================================
   * Rich inline text (authored strings only, never data from files)
   * =================================================================== */
  const INLINE = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]|\*\*(.+?)\*\*|\*([^*\s][^*]*?)\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)/g;
  function rich(text) {
    const frag = document.createDocumentFragment();
    if (text instanceof Node) { frag.appendChild(text); return frag; }
    const s = String(text === undefined || text === null ? "" : text);
    const re = new RegExp(INLINE.source, "g"); // own regex per call: rich() recurses
    let last = 0, m;
    while ((m = re.exec(s))) {
      if (m.index > last) frag.appendChild(document.createTextNode(s.slice(last, m.index)));
      if (m[1]) frag.appendChild(Term(m[1].trim(), m[2] ? m[2].trim() : undefined));
      else if (m[3]) frag.appendChild(h("strong", null, rich(m[3])));
      else if (m[4]) frag.appendChild(h("em", null, rich(m[4])));
      else if (m[5]) frag.appendChild(h("code", { text: m[5] }));
      else if (m[6]) frag.appendChild(link(m[6], m[7]));
      last = re.lastIndex;
    }
    if (last < s.length) frag.appendChild(document.createTextNode(s.slice(last)));
    return frag;
  }
  const richSafe = rich;
  function link(label, href) {
    const ok = /^#\//.test(href) || /^https:\/\//.test(href);
    if (!ok) return document.createTextNode(label);
    const ext = /^https:/.test(href);
    return h("a", { href, attrs: ext ? { target: "_blank", rel: "noopener" } : null }, rich(label), ext ? h("span", { class: "sr-only", text: " (opens in a new tab)" }) : null);
  }
  /** A <p> of rich text. */
  function p(text, cls) { return h("p", { class: cls || null }, richSafe(text)); }
  /** Several paragraphs: blank lines separate them; lines starting "- " become a list. */
  function prose(text) {
    const wrap = h("div", { class: "prose" });
    for (const block of String(text).trim().split(/\n\s*\n/)) {
      const lines = block.split("\n").map((l) => l.trim());
      if (lines.every((l) => l.startsWith("- "))) wrap.appendChild(h("ul", null, lines.map((l) => h("li", null, richSafe(l.slice(2))))));
      else if (lines.every((l) => /^\d+\.\s/.test(l))) wrap.appendChild(h("ol", null, lines.map((l) => h("li", null, richSafe(l.replace(/^\d+\.\s/, ""))))));
      else wrap.appendChild(h("p", null, richSafe(lines.join(" "))));
    }
    return wrap;
  }

  /* =====================================================================
   * Term: dotted underline -> popover with the glossary definition
   * =================================================================== */
  const missingTerms = new Set();
  let pop = null, popFor = null;

  function Term(id, label) {
    const g = OBZ.glossary && OBZ.glossary.get(id);
    const text = label || id.replace(/-/g, " ");
    if (!g) {
      missingTerms.add(id);
      console.warn(`OBZ: glossary has no term "${id}"`);
      return h("span", { class: "term term-missing", dataset: { term: id }, text });
    }
    // A span with role="button" (not a <button>) so the term wraps and flows like normal text.
    const btn = h("span", {
      class: "term", dataset: { term: id }, tabIndex: 0,
      attrs: { role: "button", "aria-haspopup": "dialog", "aria-expanded": "false", title: "Definition: " + g.term },
      on: {
        click: (e) => { e.stopPropagation(); e.preventDefault(); togglePopover(btn, id); },
        keydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); togglePopover(btn, id); } },
      },
    }, text);
    return btn;
  }

  function ensurePopover() {
    if (pop) return pop;
    pop = h("div", { class: "popover", id: "obz-popover", hidden: true, tabIndex: -1, attrs: { role: "dialog", "aria-labelledby": "obz-pop-title" } });
    document.body.appendChild(pop);
    document.addEventListener("click", (e) => { if (pop && !pop.hidden && !pop.contains(e.target)) closePopover(false); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && pop && !pop.hidden) { e.preventDefault(); closePopover(true); } });
    window.addEventListener("resize", () => { if (pop && !pop.hidden && popFor) place(popFor); });
    window.addEventListener("hashchange", () => closePopover(false));
    return pop;
  }
  function togglePopover(btn, id) {
    if (pop && !pop.hidden && popFor === btn) { closePopover(true); return; }
    openPopover(btn, id);
  }
  function openPopover(btn, id) {
    const g = OBZ.glossary.get(id);
    ensurePopover();
    if (popFor) popFor.setAttribute("aria-expanded", "false");
    clear(pop);
    pop.appendChild(h("div", { class: "pop-head" },
      h("h3", { id: "obz-pop-title", class: "pop-title", text: g.term }),
      h("button", { type: "button", class: "icon-btn pop-close", attrs: { "aria-label": "Close definition" }, on: { click: () => closePopover(true) } }, "×")));
    pop.appendChild(h("p", { class: "pop-def" }, richSafe(g.def)));
    if (g.project) pop.appendChild(h("p", { class: "pop-project" }, h("span", { class: "pop-label", text: "In this project " }), richSafe(g.project)));
    const foot = h("div", { class: "pop-foot" });
    foot.appendChild(h("a", { href: OBZ.router.href("glossary", id), text: "Open in glossary →" }));
    if (g.chapter) foot.appendChild(h("a", { href: OBZ.router.href("learn", g.chapter), text: `Chapter ${g.chapter}` }));
    pop.appendChild(foot);
    pop.hidden = false;
    popFor = btn;
    btn.setAttribute("aria-expanded", "true");
    place(btn);
    pop.focus({ preventScroll: true });
  }
  function place(btn) {
    const r = btn.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    if (vw < 560) { pop.classList.add("sheet"); pop.style.left = ""; pop.style.top = ""; return; }
    pop.classList.remove("sheet");
    const w = Math.min(360, vw - 32);
    pop.style.width = w + "px";
    let left = r.left + window.scrollX + r.width / 2 - w / 2;
    left = Math.max(window.scrollX + 16, Math.min(left, window.scrollX + vw - w - 16));
    const ph = pop.offsetHeight;
    let top = r.bottom + window.scrollY + 8;
    if (r.bottom + ph + 16 > window.innerHeight && r.top - ph - 8 > 0) top = r.top + window.scrollY - ph - 8;
    pop.style.left = left + "px";
    pop.style.top = top + "px";
  }
  function closePopover(returnFocus) {
    if (!pop || pop.hidden) return;
    pop.hidden = true;
    if (popFor) {
      popFor.setAttribute("aria-expanded", "false");
      if (returnFocus && popFor.isConnected) popFor.focus();
    }
    popFor = null;
  }

  /* =====================================================================
   * Layout pieces
   * =================================================================== */
  const PHASES = {
    explain: { n: 1, label: "Explain" },
    see: { n: 2, label: "See" },
    try: { n: 3, label: "Try" },
    check: { n: 4, label: "Check" },
  };
  /** A chapter phase. kind: explain | see | try | check. Returns the <section>; append to .body. */
  function Section({ kind, title, id, children }) {
    const ph = PHASES[kind] || PHASES.explain;
    const hid = uid("sec");
    const body = h("div", { class: "sec-body" }, children || null);
    const el = h("section", { class: `sec sec-${kind}`, id: id || null, attrs: { "aria-labelledby": hid } },
      h("header", { class: "sec-head" },
        h("span", { class: "phase" }, h("span", { class: "phase-n", attrs: { "aria-hidden": "true" }, text: ph.n }), h("span", { class: "phase-label", text: ph.label })),
        h("h2", { id: hid, class: "sec-title" }, title ? richSafe(title) : ph.label)),
      body);
    el.body = body;
    return el;
  }

  const CALLOUT = { note: "Note", tip: "Tip", warn: "Careful", real: "In the real world", project: "In this project" };
  const CALLOUT_ICON = { note: "i", tip: "★", warn: "!", real: "◆", project: "▣" };
  /** Callout({kind: note|tip|warn|real|project, title, body: string|node, open}). A "project" callout
   *  (code and file names) is programmer material, so it is folded into ForProgrammers unless open: true. */
  function Callout({ kind = "note", title, body, children, open }) {
    const k = CALLOUT[kind] ? kind : "note";
    const box = h("aside", { class: `callout callout-${k}`, attrs: { role: "note" } },
      h("span", { class: "callout-icon", attrs: { "aria-hidden": "true" }, text: CALLOUT_ICON[k] }),
      h("div", { class: "callout-body" },
        h("p", { class: "callout-title" }, richSafe(title || CALLOUT[k])),
        typeof body === "string" ? prose(body) : body || null,
        children || null));
    return k === "project" && !open ? ForProgrammers({ title: title || CALLOUT[k], children: box }) : box;
  }

  /** ForProgrammers({title, children}): a collapsed "For programmers (optional)" block. Everything a
   *  non-programmer needs is in the prose and widgets around it; this holds code-level detail. */
  function ForProgrammers({ title, children, open = false }) {
    return h("details", { class: "for-programmers", open },
      h("summary", null, h("span", { class: "fp-tag", text: "For programmers (optional)" }), title ? h("span", { class: "fp-title" }, richSafe(title)) : null),
      h("div", { class: "fp-body" }, children || null));
  }

  /** Figure({children, caption, alt, label}) . alt is the text alternative for the visual. */
  function Figure({ children, caption, alt, label, wide }) {
    const capId = uid("cap");
    const fig = h("figure", { class: "figure" + (wide ? " figure-wide" : ""), attrs: { "aria-labelledby": caption ? capId : null } },
      h("div", { class: "fig-body" }, children || null),
      alt ? h("p", { class: "sr-only", text: alt }) : null,
      caption ? h("figcaption", { id: capId }, label ? h("span", { class: "fig-label", text: label + " " }) : null, richSafe(caption)) : null);
    return fig;
  }

  /** TryIt({title, intro, children}): a hands-on card. */
  function TryIt({ title, intro, children }) {
    return h("div", { class: "tryit" },
      h("div", { class: "tryit-head" },
        h("span", { class: "tryit-badge", text: "Try it" }),
        title ? h("h3", { class: "tryit-title" }, richSafe(title)) : null),
      intro ? p(intro, "tryit-intro") : null,
      h("div", { class: "tryit-body" }, children || null));
  }

  /** Stat({label, value, tone: bid|ask|accent|null, sub}) ; el.api.set(value, sub) */
  function Stat({ label, value, tone, sub }) {
    const v = h("div", { class: "stat-v" + (tone ? " tone-" + tone : ""), text: value === undefined ? "–" : value });
    const s = h("div", { class: "stat-sub", text: sub || "" });
    const el = h("div", { class: "stat" }, h("div", { class: "stat-k" }, richSafe(label)), v, s);
    el.api = { set(value2, sub2) { v.textContent = value2; if (sub2 !== undefined) s.textContent = sub2; } };
    return el;
  }
  function StatGrid(stats, opts = {}) {
    return h("div", { class: "stats", attrs: { "aria-live": opts.live ? "polite" : null } }, stats);
  }

  /** Table({columns: [{key, label, align, format}], rows: [obj], caption}) */
  function Table({ columns, rows, caption, dense }) {
    const head = h("tr", null, columns.map((c) => h("th", { attrs: { scope: "col" }, class: c.align === "left" ? "al" : null, text: c.label })));
    const body = rows.map((r) => h("tr", null, columns.map((c, i) => {
      const raw = typeof c.value === "function" ? c.value(r) : r[c.key];
      const v = c.format ? c.format(raw, r) : raw;
      const cell = v instanceof Node ? v : document.createTextNode(v === null || v === undefined ? "–" : String(v));
      return h(i === 0 ? "th" : "td", { class: (c.align === "left" ? "al" : "") + (c.mono === false ? "" : " mono"), attrs: i === 0 ? { scope: "row" } : null }, cell);
    })));
    return h("div", { class: "table-wrap", tabIndex: 0, attrs: { role: "region", "aria-label": caption || "Table" } },
      h("table", { class: "table" + (dense ? " dense" : "") }, caption ? h("caption", { text: caption }) : null, h("thead", null, head), h("tbody", null, body)));
  }

  /** ProgressBar({value, max, label}) ; el.api.set(value, max) */
  function ProgressBar({ value = 0, max = 1, label = "Progress", showText = true }) {
    const fill = h("span", { class: "pbar-fill" });
    const txt = h("span", { class: "pbar-text" });
    const bar = h("div", { class: "pbar", attrs: { role: "progressbar", "aria-label": label, "aria-valuemin": 0 } }, h("span", { class: "pbar-track" }, fill), showText ? txt : null);
    function set(v, m = max) {
      max = m;
      const f = m > 0 ? Math.max(0, Math.min(1, v / m)) : 0;
      fill.style.width = (f * 100).toFixed(1) + "%";
      bar.setAttribute("aria-valuemax", m); bar.setAttribute("aria-valuenow", v);
      bar.setAttribute("aria-valuetext", `${v} of ${m}`);
      txt.textContent = `${v} / ${m}`;
    }
    set(value, max);
    bar.api = { set };
    return bar;
  }

  /* =====================================================================
   * Controls
   * =================================================================== */
  /** Button({label, onClick, variant: primary|ghost|buy|sell, small, icon}) */
  function Button({ label, onClick, variant, small, attrs, disabled }) {
    return h("button", { type: "button", class: "btn" + (variant ? " btn-" + variant : "") + (small ? " btn-sm" : ""), disabled: !!disabled, attrs, on: onClick ? { click: onClick } : null }, label);
  }

  /** Segmented({label, options: [{value, label, color?}], value, onChange}) ; el.api.set(v) */
  function Segmented({ label, options, value, onChange, small }) {
    let cur = value;
    const btns = options.map((o) => h("button", {
      type: "button", class: "seg-btn", dataset: { v: String(o.value) },
      attrs: { "aria-pressed": String(o.value === cur) },
      on: { click: () => { set(o.value); if (onChange) onChange(o.value); } },
    }, o.color ? h("span", { class: "swatch", style: { background: `var(${o.color})` }, attrs: { "aria-hidden": "true" } }) : null, o.label));
    const el = h("div", { class: "seg" + (small ? " seg-sm" : ""), attrs: { role: "group", "aria-label": label } }, btns);
    function set(v) { cur = v; btns.forEach((b, i) => b.setAttribute("aria-pressed", String(options[i].value === v))); }
    el.api = { set, get value() { return cur; } };
    return el;
  }

  /** VenuePicker({venues: ["phoenix", ...], value, onChange}) */
  function VenuePicker({ venues, value, onChange, label = "Venue" }) {
    const names = venues || OBZ.data.venues();
    return Segmented({ label, value: value || names[0], onChange, options: names.map((v, i) => ({ value: v, label: OBZ.data.label(v), color: OBZ.data.colorVar(v, i) })) });
  }

  /** Slider({label, min, max, step, value, format, onInput, log}) ; log: value = 10^slider */
  function Slider({ label, min, max, step = 1, value, format, onInput, log }) {
    const id = uid("sl");
    const out = h("output", { attrs: { for: id } });
    const toSlider = (v) => (log ? Math.log10(v) : v);
    const fromSlider = (s) => (log ? Math.pow(10, s) : s);
    const input = h("input", { type: "range", id, min: String(toSlider(min)), max: String(toSlider(max)), step: String(log ? 0.01 : step), value: String(toSlider(value)) });
    const show = (v) => { out.textContent = format ? format(v) : String(v); input.setAttribute("aria-valuetext", out.textContent); };
    input.addEventListener("input", () => { const v = fromSlider(parseFloat(input.value)); show(v); if (onInput) onInput(v); });
    show(value);
    const el = h("div", { class: "slider" }, h("label", { attrs: { for: id } }, h("span", null, richSafe(label)), out), input);
    el.api = { set(v) { input.value = String(toSlider(v)); show(v); }, get value() { return fromSlider(parseFloat(input.value)); } };
    return el;
  }

  /** NumberCheck({question, answer, tolerance, unit, explain, hint}): "work it out yourself" */
  function NumberCheck({ question, answer, tolerance = 0.01, unit = "", explain, hint, onCorrect }) {
    const id = uid("nc");
    const input = h("input", { type: "text", id, class: "input mono", inputMode: "decimal", autocomplete: "off", attrs: { "aria-describedby": id + "-fb" } });
    const fb = h("div", { class: "nc-feedback", id: id + "-fb", attrs: { "aria-live": "polite" } });
    const ans = typeof answer === "function" ? answer : () => answer;
    function check() {
      const v = parseFloat(String(input.value).replace(/[$,\s]/g, "").replace(/bps?$/i, ""));
      clear(fb);
      if (!isFinite(v)) { fb.className = "nc-feedback"; fb.appendChild(document.createTextNode("Type a number first.")); return; }
      const target = ans();
      const ok = Math.abs(v - target) <= tolerance;
      fb.className = "nc-feedback " + (ok ? "is-ok" : "is-bad");
      fb.appendChild(h("strong", { text: ok ? "✓ Yes. " : "✗ Not quite. " }));
      if (ok && explain) fb.appendChild(richSafe(typeof explain === "function" ? explain() : explain));
      if (ok && onCorrect) onCorrect();
      else if (!ok) fb.appendChild(richSafe(hint ? (typeof hint === "function" ? hint(v) : hint) : `Check your arithmetic and try again.`));
    }
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") check(); });
    return h("div", { class: "numcheck" },
      h("label", { attrs: { for: id }, class: "nc-q" }, richSafe(question)),
      h("div", { class: "nc-row" }, input, unit ? h("span", { class: "nc-unit", text: unit }) : null, Button({ label: "Check", onClick: check, variant: "primary" })),
      fb);
  }

  /** DataLoader({onLoad(dataset)}): paste or upload an export (v1/v2). Never executes content. */
  function DataLoader({ onLoad } = {}) {
    const id = uid("dl");
    const ta = h("textarea", { id, class: "input mono", rows: 5, spellcheck: false, attrs: { placeholder: '{"kind": "impact-analyzer-export", "version": 1, ...}' } });
    const msg = h("p", { class: "dl-msg", attrs: { "aria-live": "polite" } });
    const file = h("input", { type: "file", accept: ".json,application/json", class: "sr-only", id: id + "-f" });
    const show = (res) => {
      if (res.ok) {
        OBZ.data.use(res.dataset);
        msg.className = "dl-msg is-ok";
        msg.textContent = `Loaded ${res.dataset.venues.map((v) => v.label).join(", ")} (format v${res.dataset.version}). Every widget now shows this data.`;
        if (onLoad) onLoad(res.dataset);
      } else {
        msg.className = "dl-msg is-bad";
        msg.textContent = res.error;
      }
    };
    file.addEventListener("change", () => { const f = file.files && file.files[0]; OBZ.data.readFile(f).then(show); file.value = ""; });
    return h("div", { class: "dataloader" },
      h("label", { attrs: { for: id } }, "Paste the contents of ", h("code", { text: "playground.json" }), " (or an export file)"),
      ta,
      h("div", { class: "btn-row" },
        Button({ label: "Load pasted JSON", variant: "primary", onClick: () => show(OBZ.data.parse(ta.value, "paste")) }),
        h("label", { class: "btn", attrs: { for: id + "-f" } }, "Choose a file…"), file,
        Button({ label: "Back to built-in data", variant: "ghost", onClick: () => { OBZ.data.reset(); msg.className = "dl-msg is-ok"; msg.textContent = "Showing the built-in 18 Oct 2026 snapshots again."; } })),
      msg,
      h("p", { class: "fine", text: "Files stay in your browser: nothing is uploaded anywhere, and the file is only read as data (5 MB limit)." }));
  }

  /* =====================================================================
   * Stepper: play / step / back / reset. Reduced motion -> step only.
   * =================================================================== */
  /**
   * Stepper({steps: [string | {caption}], render(i, step), stage, interval, label})
   * render(i) is called on every change (i = 0..steps.length-1). stage (optional node) is
   * shown above the controls. el.api = {go(i), next(), prev(), reset(), index}
   */
  function Stepper({ steps, render, stage, interval = 1800, label = "Step-by-step animation", loop = false }) {
    const n = steps.length;
    let i = 0, timer = null;
    const still = reducedMotion();
    const status = h("p", { class: "step-caption", attrs: { "aria-live": "polite" } });
    const count = h("span", { class: "step-count" });
    const back = Button({ label: "◀ Back", onClick: () => { stop(); go(i - 1); }, attrs: { "aria-label": "Previous step" } });
    const next = Button({ label: "Step ▶", variant: "primary", onClick: () => { stop(); go(i + 1); }, attrs: { "aria-label": "Next step" } });
    const reset = Button({ label: "Reset", variant: "ghost", onClick: () => { stop(); go(0); } });
    const play = still ? null : Button({ label: "▶ Play", onClick: () => (timer ? stop() : start()) });
    function go(j) {
      i = Math.max(0, Math.min(n - 1, j));
      const st = steps[i];
      clear(status).appendChild(richSafe(typeof st === "string" ? st : st.caption || ""));
      count.textContent = `Step ${i + 1} of ${n}`;
      back.disabled = i === 0;
      next.disabled = i === n - 1;
      try { if (render) render(i, st); } catch (e) { console.error(e); }
    }
    function start() {
      if (still) return;
      if (i >= n - 1) go(0);
      play.textContent = "❚❚ Pause"; play.setAttribute("aria-label", "Pause");
      timer = setInterval(() => {
        if (!el.isConnected) { stop(); return; }
        if (i >= n - 1) { if (loop) go(0); else stop(); } else go(i + 1);
      }, interval);
    }
    function stop() { if (timer) clearInterval(timer); timer = null; if (play) { play.textContent = "▶ Play"; play.setAttribute("aria-label", "Play"); } }
    const el = h("div", { class: "stepper", attrs: { role: "group", "aria-label": label } },
      stage ? h("div", { class: "step-stage" }, stage) : null,
      status,
      h("div", { class: "step-controls" }, reset, back, play, next, count),
      still ? h("p", { class: "fine", text: "Animation is off because your device asks for reduced motion. Use Step to move through it." }) : null);
    el.api = { go, next: () => go(i + 1), prev: () => go(i - 1), reset: () => { stop(); go(0); }, get index() { return i; } };
    go(0);
    return el;
  }

  /* =====================================================================
   * Quiz: single choice, an explanation for every option, records progress
   * =================================================================== */
  /**
   * Quiz({id, questions: [{q, options: [{text, why}], answer: index}], onComplete})
   * Every option needs `why`: for wrong options say why it's wrong; for the right one, why
   * it's right. Answers are stored per viewer (OBZ.store.quiz).
   */
  function Quiz({ id, questions, onComplete, title }) {
    const saved = OBZ.store.quiz.get(id);
    const score = h("p", { class: "quiz-score", attrs: { "aria-live": "polite" } });
    const list = h("ol", { class: "quiz-list" });
    const el = h("div", { class: "quiz", dataset: { quiz: id } }, title ? h("h3", { class: "quiz-title" }, richSafe(title)) : null, list, score);

    function updateScore(announce) {
      const st = OBZ.store.quiz.get(id);
      const solved = questions.filter((_, i) => st[i] && st[i].solved).length;
      const first = questions.filter((_, i) => st[i] && st[i].firstTry).length;
      score.textContent = solved === questions.length
        ? `All ${questions.length} answered correctly (${first} on the first try).`
        : `${solved} of ${questions.length} answered correctly so far.`;
      if (solved === questions.length && announce && onComplete) onComplete();
    }

    questions.forEach((q, qi) => {
      const name = uid("q");
      const legendId = uid("ql");
      const fb = h("div", { class: "quiz-feedback", attrs: { "aria-live": "polite" } });
      const opts = q.options.map((o, oi) => {
        const input = h("input", { type: "radio", name, value: String(oi) });
        const lab = h("label", { class: "quiz-opt" }, input, h("span", { class: "quiz-mark", attrs: { "aria-hidden": "true" } }), h("span", { class: "quiz-text" }, richSafe(o.text)));
        input.addEventListener("change", () => choose(oi, true));
        return { input, lab };
      });
      function choose(oi, record) {
        const correct = oi === q.answer;
        opts.forEach((o, k) => {
          o.lab.classList.toggle("is-chosen", k === oi);
          o.lab.classList.toggle("is-correct", k === oi && correct);
          o.lab.classList.toggle("is-wrong", k === oi && !correct);
          o.input.checked = k === oi;
        });
        clear(fb);
        fb.className = "quiz-feedback " + (correct ? "is-ok" : "is-bad");
        fb.appendChild(h("strong", { text: correct ? "✓ Correct. " : "✗ Not quite. " }));
        // the badge already says "Correct", so drop a leading "Right." from the explanation
        fb.appendChild(richSafe(String(q.options[oi].why || "").replace(correct ? /^(Right|Correct)\.\s*/ : /^$/, "")));
        if (!correct) fb.appendChild(h("span", { class: "quiz-retry", text: " Try another answer." }));
        if (record) { OBZ.store.quiz.record(id, qi, oi, correct); updateScore(true); }
      }
      const fs = h("fieldset", { class: "quiz-q", attrs: { "aria-labelledby": legendId } },
        h("legend", { id: legendId, class: "quiz-stem" }, h("span", { class: "quiz-n", text: `Question ${qi + 1}` }), h("span", { class: "quiz-stem-text" }, richSafe(q.q))),
        h("div", { class: "quiz-opts" }, opts.map((o) => o.lab)),
        fb);
      list.appendChild(h("li", null, fs));
      if (saved[qi] && saved[qi].choice !== undefined && q.options[saved[qi].choice]) choose(saved[qi].choice, false);
    });
    updateScore(false);
    el.appendChild(Button({ label: "Reset answers", variant: "ghost", small: true, onClick: () => { OBZ.store.quiz.clear(id); const fresh = Quiz({ id, questions, onComplete, title }); el.replaceWith(fresh); } }));
    return el;
  }

  /* =====================================================================
   * Flashcards with a simple spaced-repetition schedule (Leitner boxes)
   * =================================================================== */
  const BOX_GAP = [0, 2, 4, 8, 16, 32]; // cards until a card in box b comes back
  /** Flashcards({id, cards: [{q, a}]}) ; state per viewer under OBZ.store.cards */
  function Flashcards({ id, cards, title }) {
    const keyOf = (c, i) => c.id || "c" + i;
    let st = Object.assign({ turn: 0, cards: {} }, OBZ.store.cards.get(id));
    cards.forEach((c, i) => { const k = keyOf(c, i); if (!st.cards[k]) st.cards[k] = { box: 0, next: i * 0.001 }; });
    let cur = -1, flipped = false;

    const face = h("div", { class: "fc-face", attrs: { "aria-live": "polite" } });
    const meta = h("div", { class: "fc-meta" });
    const flipBtn = Button({ label: "Show answer", variant: "primary", onClick: () => flip() });
    const again = Button({ label: "Again", onClick: () => grade(false), attrs: { "aria-label": "Again: show this card again soon" } });
    const good = Button({ label: "Good", variant: "primary", onClick: () => grade(true), attrs: { "aria-label": "Good: show this card later" } });
    const gradeRow = h("div", { class: "btn-row fc-grade", hidden: true }, again, good);
    const progress = ProgressBar({ value: 0, max: cards.length, label: "Cards learned" });
    const card = h("div", { class: "fc-card", tabIndex: -1 }, face);
    const el = h("div", { class: "flashcards" },
      title ? h("h3", { class: "fc-title" }, richSafe(title)) : null,
      card, meta,
      h("div", { class: "btn-row" }, flipBtn), gradeRow,
      h("div", { class: "fc-foot" }, h("span", { class: "fine", text: "Learned = answered Good three times in a row." }), progress,
        Button({ label: "Reset deck", variant: "ghost", small: true, onClick: () => { st = { turn: 0, cards: {} }; cards.forEach((c, i) => { st.cards[keyOf(c, i)] = { box: 0, next: i * 0.001 }; }); save(); pick(); } })));

    function save() { OBZ.store.cards.set(id, st); }
    function pick() {
      let best = 0, bestNext = Infinity;
      cards.forEach((c, i) => { const s = st.cards[keyOf(c, i)]; if (s.next < bestNext) { bestNext = s.next; best = i; } });
      cur = best; flipped = false; show();
    }
    function show() {
      const c = cards[cur], s = st.cards[keyOf(c, cur)];
      clear(face);
      face.appendChild(h("p", { class: "fc-side", text: flipped ? "Answer" : "Question" }));
      face.appendChild(h("p", { class: "fc-q" }, richSafe(c.q)));
      if (flipped) face.appendChild(h("div", { class: "fc-a" }, prose(c.a)));
      card.classList.toggle("is-flipped", flipped);
      flipBtn.hidden = flipped; gradeRow.hidden = !flipped;
      meta.textContent = `Card ${cur + 1} of ${cards.length} · box ${s.box} of 5`;
      const learned = cards.filter((cc, i) => st.cards[keyOf(cc, i)].box >= 3).length;
      progress.api.set(learned, cards.length);
    }
    function flip() { flipped = true; show(); good.focus(); }
    function grade(ok) {
      const k = keyOf(cards[cur], cur), s = st.cards[k];
      st.turn += 1;
      s.box = ok ? Math.min(5, s.box + 1) : 1;
      s.next = st.turn + (ok ? BOX_GAP[s.box] : 1) + cur * 0.001;
      save(); pick(); flipBtn.focus();
    }
    pick();
    return el;
  }

  /* =====================================================================
   * CodeExercise: user JS + tests in a Web Worker with a time limit
   * =================================================================== */
  const WORKER_SRC = `
"use strict";
function show(v) { try { return JSON.stringify(v); } catch (e) { return String(v); } }
function eq(a, b, msg) { const A = show(a), B = show(b); if (A !== B) throw new Error((msg ? msg + ": " : "") + "expected " + B + ", got " + A); }
function near(a, b, tol, msg) { if (!(Math.abs(a - b) <= (tol === undefined ? 1e-9 : tol))) throw new Error((msg ? msg + ": " : "") + "expected about " + b + ", got " + a); }
function assert(c, msg) { if (!c) throw new Error(msg || "assertion failed"); }
function walk(level, idKey) { idKey = idKey || "id"; const ids = []; let n = level.head, prev = null, guard = 0;
  while (n) { if (n.prev !== prev) throw new Error("node " + n[idKey] + ".prev should be " + (prev ? prev[idKey] : "null")); ids.push(n[idKey]); prev = n; n = n.next; if (++guard > 100000) throw new Error("the list has a cycle"); }
  if (level.tail !== prev) throw new Error("tail should be " + (prev ? prev[idKey] : "null")); return ids; }
self.onmessage = function (e) {
  const d = e.data, logs = [];
  const fmt = (args) => Array.prototype.map.call(args, (x) => typeof x === "string" ? x : show(x)).join(" ");
  self.console = { log: function () { if (logs.length < 50) logs.push(fmt(arguments)); }, warn: function () { if (logs.length < 50) logs.push(fmt(arguments)); }, error: function () { if (logs.length < 50) logs.push(fmt(arguments)); } };
  let api;
  try {
    const ret = "return {" + d.exports.map((n) => JSON.stringify(n) + ": typeof " + n + " !== 'undefined' ? " + n + " : undefined").join(", ") + "};";
    api = (new Function((d.prelude || "") + "\\n" + d.code + "\\n" + ret))();
  } catch (err) { self.postMessage({ type: "compile", error: String(err && err.message || err), logs }); return; }
  const results = [];
  for (const t of d.tests) {
    try { (new Function("A", "eq", "near", "assert", "walk", t.code))(api, eq, near, assert, walk); results.push({ name: t.name, ok: true }); }
    catch (err) { results.push({ name: t.name, ok: false, msg: String(err && err.message || err) }); }
  }
  self.postMessage({ type: "done", results, logs });
};`;
  let workerUrl = null;
  function makeWorker() {
    if (typeof Worker === "undefined" || typeof Blob === "undefined" || !window.URL) return null;
    try {
      if (!workerUrl) workerUrl = URL.createObjectURL(new Blob([WORKER_SRC], { type: "text/javascript" }));
      return new Worker(workerUrl);
    } catch (e) { return null; }
  }
  /** Run exercise code + tests. Resolves {type: "done"|"compile"|"timeout"|"error", results, logs, error}. */
  function runCode({ code, prelude, exports, tests, timeoutMs = 2000 }) {
    return new Promise((resolve) => {
      const w = makeWorker();
      const msg = { code, prelude: prelude || "", exports, tests: tests.map((t) => ({ name: t.name, code: t.code })) };
      if (!w) {
        // No workers (blocked by the host page): run inline. Infinite loops can't be stopped here.
        try {
          const fn = new Function("self", WORKER_SRC + "\nreturn self.onmessage;");
          const fake = { postMessage: (r) => resolve(Object.assign({ inline: true }, r)) };
          fn(fake)({ data: msg });
        } catch (e) { resolve({ type: "error", error: String(e.message || e), results: [] }); }
        return;
      }
      const timer = setTimeout(() => { w.terminate(); resolve({ type: "timeout", results: [], logs: [] }); }, timeoutMs);
      w.onmessage = (e) => { clearTimeout(timer); w.terminate(); resolve(e.data); };
      w.onerror = (e) => { clearTimeout(timer); w.terminate(); e.preventDefault(); resolve({ type: "error", error: e.message || "the code crashed", results: [] }); };
      w.postMessage(msg);
    });
  }

  /**
   * CodeExercise({id, title, level, brief, starter, prelude, exports, tests: [{name, code}],
   *               hints: [h1, h2, h3], solution, timeoutMs})
   * Test `code` is a string run as a function of (A, eq, near, assert, walk) where A holds
   * the exported names from the learner's code.
   */
  function CodeExercise(ex) {
    const st = OBZ.store.exercises;
    const taId = uid("code");
    const ta = h("textarea", { id: taId, class: "code-editor", spellcheck: false, autocapitalize: "off", autocomplete: "off", attrs: { "aria-describedby": taId + "-help", wrap: "off" } });
    ta.value = st.code(ex.id, ex.starter);
    const save = OBZ.util.debounce(() => st.saveCode(ex.id, ta.value), 300);
    let escaped = false;
    ta.addEventListener("input", save);
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { escaped = true; return; }
      if (e.key === "Tab" && !escaped && !e.shiftKey) {
        e.preventDefault();
        const s = ta.selectionStart, en = ta.selectionEnd;
        ta.value = ta.value.slice(0, s) + "  " + ta.value.slice(en);
        ta.selectionStart = ta.selectionEnd = s + 2; save();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); run(); }
      escaped = false;
    });
    const badge = h("span", { class: "pill " + (st.passed(ex.id) ? "pill-ok" : "pill-todo"), text: st.passed(ex.id) ? "passed" : "not yet" });
    const results = h("div", { class: "ex-results", attrs: { "aria-live": "polite" } });
    const hintBox = h("div", { class: "ex-hints" });
    let hintsShown = 0;
    const hints = ex.hints || [];
    const hintBtn = hints.length ? Button({ label: `Hint 1 of ${hints.length}`, variant: "ghost", onClick: () => {
      if (hintsShown >= hints.length) return;
      hintBox.appendChild(h("div", { class: "ex-hint" }, h("strong", { text: `Hint ${hintsShown + 1}. ` }), richSafe(hints[hintsShown])));
      hintsShown++;
      hintBtn.textContent = hintsShown < hints.length ? `Hint ${hintsShown + 1} of ${hints.length}` : "No more hints";
      hintBtn.disabled = hintsShown >= hints.length;
    } }) : null;
    const solBox = ex.solution ? h("details", { class: "ex-solution" },
      h("summary", { text: "Reveal the reference solution" }),
      h("pre", { class: "code" }, h("code", { text: ex.solution })),
      Button({ label: "Copy it into the editor", variant: "ghost", small: true, onClick: () => { ta.value = ex.solution; st.saveCode(ex.id, ta.value); } })) : null;
    const runBtn = Button({ label: "Run tests", variant: "primary", onClick: () => run() });

    async function run() {
      runBtn.disabled = true; runBtn.textContent = "Running…";
      clear(results).appendChild(h("p", { class: "fine", text: "Running your code…" }));
      const r = await runCode({ code: ta.value, prelude: ex.prelude, exports: ex.exports, tests: ex.tests, timeoutMs: ex.timeoutMs || 2000 });
      runBtn.disabled = false; runBtn.textContent = "Run tests";
      clear(results);
      if (r.type === "timeout") {
        results.appendChild(h("p", { class: "ex-bad" }, h("strong", { text: "✗ Stopped after " + ((ex.timeoutMs || 2000) / 1000) + " s. " }), "Your code is still running, probably an infinite loop: check that every loop changes the thing its condition tests."));
        return;
      }
      if (r.type === "compile" || r.type === "error") {
        results.appendChild(h("p", { class: "ex-bad" }, h("strong", { text: "✗ The code doesn't run: " }), h("code", { text: r.error })));
      } else {
        const okN = r.results.filter((x) => x.ok).length;
        results.appendChild(h("p", { class: okN === r.results.length ? "ex-ok" : "ex-bad" }, h("strong", { text: `${okN === r.results.length ? "✓" : "✗"} ${okN} of ${r.results.length} tests pass.` })));
        results.appendChild(h("ul", { class: "ex-list" }, r.results.map((x) => h("li", { class: x.ok ? "is-ok" : "is-bad" },
          h("span", { class: "ex-icon", attrs: { "aria-hidden": "true" }, text: x.ok ? "✓" : "✗" }),
          h("span", { class: "sr-only", text: x.ok ? "Pass: " : "Fail: " }),
          h("span", { text: x.name }), x.msg ? h("code", { class: "ex-msg", text: x.msg }) : null))));
        if (okN === r.results.length && r.results.length) { st.setPassed(ex.id); badge.className = "pill pill-ok"; badge.textContent = "passed"; }
      }
      if (r.inline) results.appendChild(h("p", { class: "fine", text: "Ran without a background worker (this page blocks them), so an infinite loop would freeze the tab." }));
      if (r.logs && r.logs.length) results.appendChild(h("pre", { class: "code ex-logs" }, h("code", { text: r.logs.join("\n") })));
    }

    return h("div", { class: "exercise", dataset: { exercise: ex.id } },
      h("div", { class: "ex-head" }, h("h3", { class: "ex-title" }, richSafe(ex.title)), ex.level ? h("span", { class: "pill pill-level", text: ex.level }) : null, badge),
      h("div", { class: "ex-body" },
        ex.brief ? prose(ex.brief) : null,
        h("label", { class: "sr-only", attrs: { for: taId }, text: "Code editor for " + ex.title.replace(/[*`]/g, "") }),
        ta,
        h("p", { id: taId + "-help", class: "fine", text: "JavaScript, runs in your browser. Tab indents; press Esc then Tab to leave the editor; Ctrl+Enter runs the tests." }),
        h("div", { class: "btn-row" }, runBtn, hintBtn, Button({ label: "Reset to starter", variant: "ghost", onClick: () => { ta.value = ex.starter; st.saveCode(ex.id, ta.value); clear(results); } })),
        results, hintBox, solBox));
  }

  /* =====================================================================
   * Canvas helpers
   * =================================================================== */
  function prepCanvas(cv) {
    const r = cv.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(r.width)), hh = Math.max(1, Math.round(r.height));
    if (cv.width !== w * dpr || cv.height !== hh * dpr) { cv.width = w * dpr; cv.height = hh * dpr; }
    const ctx = cv.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, hh);
    return { ctx, w, h: hh };
  }
  /** Run fn on the next animation frame, or after 100 ms if frames are paused (hidden tab). */
  function nextFrame(fn) {
    let done = false;
    const go = () => { if (!done) { done = true; fn(); } };
    requestAnimationFrame(go);
    setTimeout(go, 100);
  }
  /** Redraw `draw` on resize and theme change while `el` is in the document. */
  function liveRedraw(el, draw) {
    let raf = 0;
    const schedule = () => { if (raf) return; raf = 1; nextFrame(() => { raf = 0; if (el.isConnected) draw(); }); };
    let ro = null, seen = false;
    // Stop listening once the element has been in the page and then removed (route change).
    const gone = () => { if (el.isConnected) { seen = true; return false; } return seen; };
    if (typeof ResizeObserver !== "undefined") { ro = new ResizeObserver(() => { if (gone()) { ro.disconnect(); return; } schedule(); }); ro.observe(el); }
    else window.addEventListener("resize", schedule);
    const off = onThemeChange(() => { if (gone()) { off(); if (ro) ro.disconnect(); return; } schedule(); });
    return schedule;
  }
  function niceStep(range, target) {
    const raw = range / Math.max(1, target);
    const p = Math.pow(10, Math.floor(Math.log10(raw)));
    for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= raw) return m * p;
    return 10 * p;
  }
  function linTicks(lo, hi, target = 5) {
    const step = niceStep(hi - lo, target), out = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(+v.toFixed(10));
    return out;
  }
  function logTicks(lo, hi) {
    const out = [];
    for (let e = Math.floor(Math.log10(lo)); e <= Math.ceil(Math.log10(hi)); e++) { const v = Math.pow(10, e); if (v >= lo * 0.999 && v <= hi * 1.001) out.push(v); }
    return out;
  }
  function legend(series) {
    return h("ul", { class: "legend" }, series.filter((s) => s.name && !s.noLegend).map((s) => h("li", null,
      h("span", { class: "legend-line" + (s.dash ? " dashed" : ""), style: { "--c": `var(${s.color || "--accent"})` }, attrs: { "aria-hidden": "true" } }),
      s.name)));
  }

  /* =====================================================================
   * LineChart
   * =================================================================== */
  /**
   * LineChart({series: [{name, color: "--phoenix", points: [[x, y|null, full?]], dash, width, markers}],
   *            x: {log, label, format, min, max, ticks}, y: {log, label, format, min, max, ticks},
   *            height, alt, caption, table})
   * Points with y = null leave a gap; a third element false draws a hollow marker (e.g. a
   * partial fill). Colors are token names, resolved at draw time (theme-aware).
   * el.api.update(partialOptions)
   */
  function LineChart(opts) {
    let o = Object.assign({ height: 260, series: [], x: {}, y: {} }, opts);
    const cv = h("canvas", { class: "chart-canvas", attrs: { role: "img", "aria-label": o.alt || "Line chart" } });
    const readout = h("p", { class: "chart-readout", attrs: { "aria-live": "polite" } });
    const legendBox = h("div", { class: "chart-legend" });
    const tableBox = h("div");
    const box = h("div", { class: "chart", style: { height: o.height + "px" } }, cv);
    const el = h("div", { class: "chart-wrap" }, legendBox, box, readout, tableBox);
    let geom = null;

    function bounds(axis, key) {
      const vals = [];
      for (const s of o.series) for (const pt of s.points || []) { const v = pt[key]; if (v !== null && v !== undefined && isFinite(v) && (!axis.log || v > 0)) vals.push(v); }
      let lo = axis.min !== undefined ? axis.min : Math.min(...vals);
      let hi = axis.max !== undefined ? axis.max : Math.max(...vals);
      if (!vals.length) { lo = axis.log ? 1 : 0; hi = axis.log ? 10 : 1; }
      if (lo === hi) { if (axis.log) { lo /= 2; hi *= 2; } else { lo -= 1; hi += 1; } }
      if (!axis.log && axis.max === undefined) hi += (hi - lo) * 0.06;
      return [lo, hi];
    }
    function draw() {
      const { ctx, w, h: H } = prepCanvas(cv);
      const T = { ink: cssVar("--ink"), muted: cssVar("--muted"), grid: cssVar("--grid"), line: cssVar("--line"), mono: cssVar("--f-mono") || "monospace", panel: cssVar("--panel") };
      const small = w < 420;
      const L = small ? 44 : 56, R = 12, Tp = 12, B = o.x.label ? 38 : 24;
      const [x0, x1] = bounds(o.x, 0), [y0, y1] = bounds(o.y, 1);
      const sx = (v) => o.x.log ? (Math.log10(v) - Math.log10(x0)) / (Math.log10(x1) - Math.log10(x0)) : (v - x0) / (x1 - x0);
      const sy = (v) => o.y.log ? (Math.log10(v) - Math.log10(y0)) / (Math.log10(y1) - Math.log10(y0)) : (v - y0) / (y1 - y0);
      const X = (v) => L + sx(v) * (w - L - R);
      const Y = (v) => Tp + (1 - Math.max(-0.02, Math.min(1.02, sy(v)))) * (H - Tp - B);
      geom = { X, Y, x0, x1, L, R, w };
      ctx.font = `${small ? 10 : 11}px ${T.mono}`;
      ctx.lineWidth = 1;
      const xt = o.x.ticks || (o.x.log ? logTicks(x0, x1) : linTicks(x0, x1, small ? 4 : 6));
      const yt = o.y.ticks || (o.y.log ? logTicks(y0, y1) : linTicks(y0, y1, 5));
      const fx = o.x.format || ((v) => fmt.num(v, 2)), fy = o.y.format || ((v) => fmt.num(v, 2));
      ctx.textBaseline = "middle";
      for (const v of yt) { const y = Y(v); ctx.strokeStyle = T.grid; ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(w - R, y); ctx.stroke(); ctx.fillStyle = T.muted; ctx.textAlign = "right"; ctx.fillText(fy(v), L - 6, y); }
      ctx.textBaseline = "top";
      xt.forEach((v, i) => { const x = X(v); ctx.strokeStyle = T.grid; ctx.beginPath(); ctx.moveTo(x, Tp); ctx.lineTo(x, H - B); ctx.stroke(); ctx.fillStyle = T.muted; ctx.textAlign = i === 0 && x - L < 20 ? "left" : i === xt.length - 1 && w - R - x < 20 ? "right" : "center"; ctx.fillText(fx(v), x, H - B + 6); });
      ctx.strokeStyle = T.line; ctx.beginPath(); ctx.moveTo(L, H - B + 0.5); ctx.lineTo(w - R, H - B + 0.5); ctx.stroke();
      if (o.x.label) { ctx.fillStyle = T.muted; ctx.textAlign = "center"; ctx.fillText(o.x.label, L + (w - L - R) / 2, H - 16); }
      if (o.y.label) { ctx.save(); ctx.translate(11, Tp + (H - Tp - B) / 2); ctx.rotate(-Math.PI / 2); ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillStyle = T.muted; ctx.fillText(o.y.label, 0, 0); ctx.restore(); }
      ctx.save(); ctx.beginPath(); ctx.rect(L, Tp - 4, w - L - R, H - Tp - B + 8); ctx.clip();
      for (const s of o.series) {
        const col = cssVar(s.color || "--accent") || T.ink;
        ctx.strokeStyle = col; ctx.lineWidth = s.width || 2; ctx.setLineDash(s.dash ? [6, 4] : []);
        ctx.beginPath(); let on = false;
        for (const pt of s.points || []) {
          const [x, y] = pt;
          if (y === null || y === undefined || !isFinite(y) || (o.x.log && x <= 0) || (o.y.log && y <= 0)) { on = false; continue; }
          if (on) ctx.lineTo(X(x), Y(y)); else { ctx.moveTo(X(x), Y(y)); on = true; }
        }
        ctx.stroke(); ctx.setLineDash([]);
        if (s.markers !== false && !s.dash) for (const pt of s.points || []) {
          const [x, y, full] = pt;
          if (y === null || y === undefined || !isFinite(y)) continue;
          ctx.beginPath(); ctx.arc(X(x), Y(y), full === false ? 3.5 : 2.5, 0, Math.PI * 2);
          if (full === false) { ctx.fillStyle = T.panel; ctx.fill(); ctx.lineWidth = 1.5; ctx.stroke(); } else { ctx.fillStyle = col; ctx.fill(); }
        }
      }
      for (const a of o.annotations || []) {
        const x = X(a.x); ctx.strokeStyle = cssVar(a.color || "--muted"); ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(x, Tp); ctx.lineTo(x, H - B); ctx.stroke(); ctx.setLineDash([]);
        if (a.label) { ctx.fillStyle = cssVar(a.color || "--muted"); ctx.textAlign = x > w / 2 ? "right" : "left"; ctx.textBaseline = "top"; ctx.fillText(a.label, x + (x > w / 2 ? -4 : 4), Tp); }
      }
      ctx.restore();
    }
    function nearest(px) {
      if (!geom) return null;
      let best = null;
      for (const s of o.series) for (const pt of s.points || []) {
        if (pt[1] === null || pt[1] === undefined) continue;
        const d = Math.abs(geom.X(pt[0]) - px);
        if (!best || d < best.d - 0.5) best = { d, s, pt, all: [] };
      }
      if (!best) return null;
      const x = best.pt[0];
      const rows = o.series.map((s) => { const pt = (s.points || []).find((q) => q[0] === x); return pt && pt[1] !== null && pt[1] !== undefined ? `${s.name}: ${(o.y.format || fmt.num)(pt[1])}${pt[2] === false ? " (partial)" : ""}` : null; }).filter(Boolean);
      return `${(o.x.format || fmt.num)(x)} → ${rows.join(" · ")}`;
    }
    cv.addEventListener("pointermove", (e) => { const r = cv.getBoundingClientRect(); const t = nearest(e.clientX - r.left); if (t) readout.textContent = t; });
    function renderSide() {
      clear(legendBox).appendChild(legend(o.series));
      clear(tableBox);
      if (o.table) {
        const xs = Array.from(new Set(o.series.flatMap((s) => (s.points || []).map((pt) => pt[0])))).sort((a, b) => a - b);
        const cols = [{ key: "x", label: o.x.label || "x", format: o.x.format || fmt.num }].concat(o.series.map((s, i) => ({ key: "s" + i, label: s.name, format: (v) => (v === null || v === undefined ? "–" : (o.y.format || fmt.num)(v)) })));
        const rows = xs.map((x) => { const r = { x }; o.series.forEach((s, i) => { const pt = (s.points || []).find((q) => q[0] === x); r["s" + i] = pt ? pt[1] : null; }); return r; });
        tableBox.appendChild(h("details", { class: "chart-table" }, h("summary", { text: "Show the numbers as a table" }), Table({ columns: cols, rows, caption: o.alt || "Chart data", dense: true })));
      }
      readout.textContent = o.readoutHint || (OBZ.util.isCoarse() ? "Touch the chart to read values." : "Hover over the chart to read values.");
    }
    renderSide();
    const schedule = liveRedraw(box, draw);
    schedule(); // first draw once the element is in the page
    el.api = {
      update(next) { o = Object.assign({}, o, next); cv.setAttribute("aria-label", o.alt || "Line chart"); renderSide(); schedule(); },
      redraw: schedule,
    };
    return el;
  }

  /* =====================================================================
   * DepthChart: cumulative size from the mid outward
   * =================================================================== */
  /**
   * DepthChart({levels: {bids: [{price, size}], asks}, band: 0.01, unit: "sol"|"usd", marker, height, alt})
   * levels can also be an OrderBook (uses book.toLevels()). el.api.update({levels, marker, band})
   */
  function DepthChart(opts) {
    let o = Object.assign({ band: 0.01, unit: "sol", height: 200 }, opts);
    const cv = h("canvas", { class: "chart-canvas", attrs: { role: "img", "aria-label": o.alt || "Depth chart" } });
    const box = h("div", { class: "chart", style: { height: o.height + "px" } }, cv);
    const note = h("p", { class: "chart-readout", attrs: { "aria-live": "polite" } });
    const el = h("div", { class: "chart-wrap" },
      h("ul", { class: "legend" },
        h("li", null, h("span", { class: "legend-area", style: { "--c": "var(--bid)" } }), "▲ Bids (cumulative)"),
        h("li", null, h("span", { class: "legend-area", style: { "--c": "var(--ask)" } }), "▼ Asks (cumulative)")),
      box, note);
    function levelsOf() { const lv = o.levels; return lv && typeof lv.toLevels === "function" ? lv.toLevels() : lv || { bids: [], asks: [] }; }
    function draw() {
      const { ctx, w, h: H } = prepCanvas(cv);
      const lv = levelsOf();
      if (!lv.bids.length || !lv.asks.length) { note.textContent = "One side of the book is empty."; return; }
      const mid = (lv.bids[0].price + lv.asks[0].price) / 2;
      const lo = mid * (1 - o.band), hi = mid * (1 + o.band);
      const val = (l) => (o.unit === "usd" ? l.price * l.size : l.size);
      const cum = (arr, inside) => { const pts = []; let c = 0; for (const l of arr) { if (!inside(l.price)) break; c += val(l); pts.push([l.price, c]); } return pts; };
      const bids = cum(lv.bids, (p) => p >= lo), asks = cum(lv.asks, (p) => p <= hi);
      const ymax = Math.max(bids.length ? bids[bids.length - 1][1] : 0, asks.length ? asks[asks.length - 1][1] : 0) * 1.08 || 1;
      const T = { muted: cssVar("--muted"), grid: cssVar("--grid"), ink: cssVar("--ink"), bid: cssVar("--bid"), ask: cssVar("--ask"), bidSoft: cssVar("--bid-soft"), askSoft: cssVar("--ask-soft"), accent: cssVar("--accent"), mono: cssVar("--f-mono") || "monospace" };
      const small = w < 420, L = small ? 44 : 56, R = 10, Tp = 10, B = 24;
      const X = (p) => L + (p - lo) / (hi - lo) * (w - L - R);
      const Y = (v) => Tp + (1 - v / ymax) * (H - Tp - B);
      ctx.font = `${small ? 10 : 11}px ${T.mono}`; ctx.lineWidth = 1; ctx.textBaseline = "middle";
      const yfmt = o.unit === "usd" ? fmt.usdCompact : (v) => (v >= 1000 ? fmt.num(v / 1000, 1) + "k" : fmt.num(v, 0));
      for (const v of linTicks(0, ymax, 4)) { const y = Y(v); ctx.strokeStyle = T.grid; ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(w - R, y); ctx.stroke(); ctx.fillStyle = T.muted; ctx.textAlign = "right"; ctx.fillText(yfmt(v), L - 6, y); }
      ctx.fillStyle = T.muted; ctx.textAlign = "left"; ctx.fillText(o.unit === "usd" ? "USD, added up" : "SOL, added up", L + 6, Tp + 8);
      const area = (pts, end, line, soft) => {
        if (!pts.length) return;
        ctx.beginPath(); ctx.moveTo(X(mid), Y(0)); let prev = 0;
        for (const [px, c] of pts) { ctx.lineTo(X(px), Y(prev)); ctx.lineTo(X(px), Y(c)); prev = c; }
        ctx.lineTo(X(end), Y(prev)); ctx.lineTo(X(end), Y(0)); ctx.closePath();
        ctx.fillStyle = soft; ctx.fill(); ctx.strokeStyle = line; ctx.lineWidth = 1.5; ctx.stroke();
      };
      area(bids, lo, T.bid, T.bidSoft); area(asks, hi, T.ask, T.askSoft);
      ctx.strokeStyle = T.ink; ctx.setLineDash([2, 3]); ctx.beginPath(); ctx.moveTo(X(mid), Tp); ctx.lineTo(X(mid), H - B); ctx.stroke(); ctx.setLineDash([]);
      if (o.marker !== undefined && o.marker !== null && o.marker >= lo && o.marker <= hi) {
        const x = X(o.marker); ctx.strokeStyle = T.accent; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(x, Tp); ctx.lineTo(x, H - B); ctx.stroke();
      }
      ctx.fillStyle = T.muted; ctx.textBaseline = "top";
      ctx.textAlign = "left"; ctx.fillText(fmt.price(lo, 2), L, H - B + 6);
      ctx.textAlign = "center"; ctx.fillText("mid " + fmt.price(mid, 2), X(mid), H - B + 6);
      ctx.textAlign = "right"; ctx.fillText(fmt.price(hi, 2), w - R, H - B + 6);
      const tb = bids.length ? bids[bids.length - 1][1] : 0, ta = asks.length ? asks[asks.length - 1][1] : 0;
      const u = o.unit === "usd" ? fmt.usdCompact : (v) => fmt.sol(v) + " SOL";
      note.textContent = `Within ${fmt.pct(o.band, o.band < 0.01 ? 1 : 0)} of the mid: ${u(tb)} bid, ${u(ta)} offered.`;
    }
    const schedule = liveRedraw(box, draw);
    schedule(); // first draw once the element is in the page
    el.api = { update(next) { o = Object.assign({}, o, next); schedule(); }, redraw: schedule };
    return el;
  }

  /* =====================================================================
   * Ladder: asks above, bids below, spread in the middle
   * =================================================================== */
  /**
   * Ladder({levels: {bids: [{price, size, count?}], asks}, rows: 8, priceDigits: 2,
   *         onSelect(level, side), label, caption})
   * levels may also be an OrderBook (uses book.toLevels(rows)). Rows are buttons with a
   * roving tabindex: Tab enters the ladder, arrow keys move, Enter/Space selects.
   * el.api.update(levels), el.api.select(side, price), el.api.selected
   */
  function Ladder(opts) {
    let o = Object.assign({ rows: 8, priceDigits: 2, label: "Order book ladder", sizeUnit: "SOL" }, opts);
    let selected = null; // {side, price}
    let focusKey = null;
    const list = h("div", { class: "ladder-rows", attrs: { role: "group", "aria-label": o.label } });
    const head = h("div", { class: "ladder-head", attrs: { "aria-hidden": "true" } }, h("span", { text: "Side" }), h("span", { text: "Price ($)" }), h("span", { text: `Size (${o.sizeUnit})` }), h("span", { text: "" }));
    const el = h("div", { class: "ladder" }, head, list);

    function levelsOf() {
      const lv = o.levels;
      const L = lv && typeof lv.toLevels === "function" ? lv.toLevels(o.rows) : lv || { bids: [], asks: [] };
      return { bids: L.bids.slice(0, o.rows), asks: L.asks.slice(0, o.rows) };
    }
    function render() {
      const { bids, asks } = levelsOf();
      const max = Math.max(1e-12, ...bids.map((l) => l.size), ...asks.map((l) => l.size));
      clear(list);
      const row = (side, l) => {
        const key = side + ":" + l.price;
        const isSel = selected && selected.side === side && selected.price === l.price;
        const best = (side === "ask" ? asks[0] : bids[0]) === l;
        const b = h("button", {
          type: "button", class: `lrow lrow-${side}` + (isSel ? " is-selected" : "") + (best ? " is-best" : ""), dataset: { key },
          tabIndex: -1,
          attrs: { "aria-pressed": String(!!isSel), "aria-label": `${side === "ask" ? "Ask" : "Bid"} ${fmt.price(l.price, o.priceDigits)} dollars, ${fmt.sol(l.size)} ${o.sizeUnit}${l.count ? ", " + l.count + " order" + (l.count > 1 ? "s" : "") : ""}${best ? ", best " + side : ""}` },
          on: { click: () => { selected = { side, price: l.price }; focusKey = key; render(); if (o.onSelect) o.onSelect(l, side); } },
        },
        h("span", { class: "lr-side", attrs: { "aria-hidden": "true" }, text: side === "ask" ? "▼ ASK" : "▲ BID" }),
        h("span", { class: "lr-price", text: fmt.price(l.price, o.priceDigits) }),
        h("span", { class: "lr-size", text: fmt.sol(l.size) }),
        h("span", { class: "lr-bar", attrs: { "aria-hidden": "true" } }, h("i", { style: { width: Math.max(1.5, l.size / max * 100).toFixed(1) + "%" } })),
        best ? h("span", { class: "lr-best", attrs: { "aria-hidden": "true" }, text: side === "ask" ? "best ask" : "best bid" }) : null);
        return b;
      };
      for (let i = asks.length - 1; i >= 0; i--) list.appendChild(row("ask", asks[i]));
      if (bids.length && asks.length) {
        const mid = (bids[0].price + asks[0].price) / 2, spr = asks[0].price - bids[0].price;
        list.appendChild(h("div", { class: "lrow-mid" },
          h("span", null, "spread ", h("b", { text: "$" + fmt.price(spr, o.priceDigits + (spr < 0.1 ? 1 : 0)) })),
          h("span", null, h("b", { text: fmt.bps(spr / mid * 1e4) })),
          h("span", null, "mid ", h("b", { text: "$" + fmt.price(mid, o.priceDigits < 3 ? o.priceDigits + 1 : o.priceDigits) }))));
      } else list.appendChild(h("div", { class: "lrow-mid", text: "One side of the book is empty" }));
      for (const l of bids) list.appendChild(row("bid", l));
      const btns = Array.from(list.querySelectorAll(".lrow"));
      const target = btns.find((b) => b.dataset.key === focusKey) || btns.find((b) => b.classList.contains("is-best") && b.classList.contains("lrow-ask")) || btns[0];
      if (target) target.tabIndex = 0;
    }
    list.addEventListener("keydown", (e) => {
      const btns = Array.from(list.querySelectorAll(".lrow"));
      const i = btns.indexOf(document.activeElement);
      if (i < 0) return;
      let j = i;
      if (e.key === "ArrowDown") j = Math.min(btns.length - 1, i + 1);
      else if (e.key === "ArrowUp") j = Math.max(0, i - 1);
      else if (e.key === "Home") j = 0;
      else if (e.key === "End") j = btns.length - 1;
      else return;
      e.preventDefault();
      btns[i].tabIndex = -1; btns[j].tabIndex = 0; btns[j].focus(); focusKey = btns[j].dataset.key;
    });
    render();
    el.api = {
      update(levels) { o.levels = levels; render(); },
      select(side, price) { selected = side ? { side, price } : null; render(); },
      get selected() { return selected; },
    };
    return el;
  }

  /* =====================================================================
   * HexView: raw bytes with a field map
   * =================================================================== */
  function hexToBytes(hex) {
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
  }
  /** Decode `size` little-endian bytes at `off` as `type`. Returns a display string. */
  function decodeLE(bytes, off, size, type) {
    const t = (type || "").toLowerCase();
    const slice = bytes.subarray(off, off + size);
    if (slice.length < size) return "(past the end of this slice)";
    let big = null;
    if (typeof BigInt !== "undefined") { big = BigInt(0); for (let i = size - 1; i >= 0; i--) big = (big << BigInt(8)) | BigInt(slice[i]); }
    const unsignedNum = () => { let v = 0; for (let i = size - 1; i >= 0; i--) v = v * 256 + slice[i]; return v; };
    if (/^u(8|16|32|64|128)$/.test(t)) return big !== null ? big.toLocaleString("en-US") : unsignedNum().toLocaleString("en-US");
    if (/^i(8|16|32|64)$/.test(t)) {
      if (big !== null) { const bits = BigInt(size * 8); const half = BigInt(1) << (bits - BigInt(1)); const v = big >= half ? big - (BigInt(1) << bits) : big; return v.toLocaleString("en-US"); }
      let v = unsignedNum(); const half = Math.pow(2, size * 8 - 1); if (v >= half) v -= half * 2; return v.toLocaleString("en-US");
    }
    if (t === "bool") return slice[0] ? "true" : "false";
    return Array.from(slice, (b) => b.toString(16).padStart(2, "0")).join(" ");
  }

  /**
   * HexView({bytes: Uint8Array | hex string, baseOffset: 0, fields: [{name, offset, size, type, value?, explain}],
   *          bytesPerRow: 16 (8 on phones), label, onSelect(field, byteOffset)})
   * Offsets in `fields` are absolute (same numbering as baseOffset). Hover, tap or use the
   * arrow keys to move over bytes; the panel says which field the byte belongs to.
   * el.api.select(absoluteOffset)
   */
  function HexView(opts) {
    const o = Object.assign({ baseOffset: 0, fields: [], label: "Account bytes" }, opts);
    const bytes = typeof o.bytes === "string" ? hexToBytes(o.bytes) : o.bytes || new Uint8Array(0);
    const base = o.baseOffset;
    const perRow = o.bytesPerRow || (document.documentElement.clientWidth < 600 ? 8 : 16);
    const fieldAt = new Int32Array(bytes.length).fill(-1);
    o.fields.forEach((f, fi) => { for (let k = 0; k < f.size; k++) { const i = f.offset - base + k; if (i >= 0 && i < bytes.length) fieldAt[i] = fi; } });
    const gid = uid("hex");
    const grid = h("div", { class: "hex-grid", tabIndex: 0, attrs: { role: "grid", "aria-label": o.label + ": use the arrow keys to move between bytes", "aria-readonly": "true" } });
    const detail = h("div", { class: "hex-detail", attrs: { "aria-live": "polite" } });
    const cells = [];
    for (let r = 0; r * perRow < bytes.length; r++) {
      const row = h("div", { class: "hex-row", attrs: { role: "row" } }, h("span", { class: "hex-off", attrs: { role: "rowheader" }, text: (base + r * perRow).toString(16).padStart(6, "0") }));
      for (let c = 0; c < perRow; c++) {
        const i = r * perRow + c;
        if (i >= bytes.length) break;
        const fi = fieldAt[i];
        const cell = h("span", {
          class: "hex-b" + (fi >= 0 ? " f" + ((fi % 6) + 1) : " f0") + (fi >= 0 && o.fields[fi].offset - base === i ? " f-start" : ""),
          id: gid + "-" + i, dataset: { i: String(i) },
          attrs: { role: "gridcell", "aria-label": `offset ${base + i}: ${bytes[i].toString(16).padStart(2, "0")}${fi >= 0 ? ", " + o.fields[fi].name : ""}` },
          text: bytes[i].toString(16).padStart(2, "0"),
        });
        cells.push(cell); row.appendChild(cell);
      }
      grid.appendChild(row);
    }
    let cur = -1;
    function select(i) {
      if (i < 0 || i >= bytes.length) return;
      if (cur >= 0) for (const c of grid.querySelectorAll(".is-sel, .is-field")) c.classList.remove("is-sel", "is-field");
      cur = i;
      const fi = fieldAt[i];
      if (fi >= 0) { const f = o.fields[fi]; for (let k = 0; k < f.size; k++) { const c = cells[f.offset - base + k]; if (c) c.classList.add("is-field"); } }
      cells[i].classList.add("is-sel");
      grid.setAttribute("aria-activedescendant", cells[i].id);
      clear(detail);
      const b = bytes[i];
      detail.appendChild(h("p", { class: "hex-where" }, h("span", { class: "mono", text: `offset ${base + i} (0x${(base + i).toString(16)})` }), " · byte ", h("span", { class: "mono", text: `0x${b.toString(16).padStart(2, "0")} = ${b}` })));
      if (fi >= 0) {
        const f = o.fields[fi];
        const decoded = f.value !== undefined && f.value !== null ? (typeof f.value === "number" ? f.value.toLocaleString("en-US") : String(f.value)) : decodeLE(bytes, f.offset - base, f.size, f.type);
        detail.appendChild(h("p", { class: "hex-field" }, h("strong", { text: f.name }), h("span", { class: "pill", text: (f.type || "bytes") + " · " + f.size + " byte" + (f.size > 1 ? "s" : "") }), h("span", { class: "mono", text: ` offsets ${f.offset}–${f.offset + f.size - 1}` })));
        detail.appendChild(h("p", { class: "hex-value" }, "Decoded value: ", h("strong", { class: "mono", text: decoded })));
        if (f.explain) detail.appendChild(p(f.explain));
        if (o.onSelect) o.onSelect(f, base + i);
      } else {
        detail.appendChild(p("This byte isn't part of a field we label here."));
        if (o.onSelect) o.onSelect(null, base + i);
      }
    }
    grid.addEventListener("pointerover", (e) => { const c = e.target.closest(".hex-b"); if (c) select(+c.dataset.i); });
    grid.addEventListener("click", (e) => { const c = e.target.closest(".hex-b"); if (c) { select(+c.dataset.i); grid.focus({ preventScroll: true }); } });
    grid.addEventListener("focus", () => { if (cur < 0) select(0); });
    grid.addEventListener("keydown", (e) => {
      const map = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: perRow, ArrowUp: -perRow };
      if (map[e.key] !== undefined) { e.preventDefault(); select(Math.max(0, Math.min(bytes.length - 1, (cur < 0 ? 0 : cur) + map[e.key]))); cells[cur].scrollIntoView({ block: "nearest" }); }
      else if (e.key === "Home") { e.preventDefault(); select(0); }
      else if (e.key === "End") { e.preventDefault(); select(bytes.length - 1); }
    });
    const legendList = h("ul", { class: "hex-legend" }, o.fields.slice(0, 24).map((f, fi) => h("li", null,
      h("button", { type: "button", class: "hex-chip f" + ((fi % 6) + 1), on: { click: () => { select(f.offset - base); grid.focus({ preventScroll: true }); } } }, f.name))));
    detail.appendChild(p("Hover or tap a byte (or focus the grid and use the arrow keys) to see which field it belongs to."));
    const el = h("div", { class: "hexview" }, h("div", { class: "hex-scroll" }, grid), detail, o.fields.length ? legendList : null);
    el.api = { select: (absOffset) => select(absOffset - base) };
    return el;
  }

  OBZ.ui = {
    rich: richSafe, p, prose, link,
    Term, Section, Callout, ForProgrammers, Figure, TryIt, Stat, StatGrid, Table, ProgressBar,
    Button, Segmented, VenuePicker, Slider, NumberCheck, DataLoader,
    Stepper, Quiz, Flashcards, CodeExercise, runCode,
    LineChart, DepthChart, Ladder, HexView, decodeLE, hexToBytes,
    missingTerms, closePopover,
  };
})(window.OBZ = window.OBZ || {});
