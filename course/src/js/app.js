/* app.js: the shell. Routes to views, renders the chapter layout around each chapter
 * module, keeps the top bar (nav, progress, theme) in sync. Loaded last.
 *
 * The page boots automatically when #obz-app exists and window.OBZ_NO_BOOT is not set
 * (the test page sets it and drives OBZ.app itself).
 */
(function (OBZ) {
  "use strict";
  const { h, clear, fmt } = OBZ.util;
  const ui = () => OBZ.ui;

  let mount = null;
  let cleanups = [];
  let rendered = null; // {view, param}
  let firstRender = true;

  function runCleanups() { const c = cleanups; cleanups = []; for (const fn of c) { try { fn(); } catch (e) { console.error(e); } } }

  /** The context object handed to chapter and tool render() functions. */
  function makeCtx(el, extra) {
    const ctx = {
      ui: OBZ.ui, h, fmt, util: OBZ.util, engine: OBZ.engine, amm: OBZ.amm, data: OBZ.data, store: OBZ.store, glossary: OBZ.glossary, router: OBZ.router,
      onCleanup(fn) { cleanups.push(fn); },
      /** Run fn(dataset) whenever the active dataset changes, until the reader navigates away. */
      onData(fn) { const off = OBZ.data.subscribe(fn); cleanups.push(off); return off; },
      /** A "coming soon" box (uses the chapter's `planned` text when given no argument). */
      placeholder(text) {
        const t = text || (extra && extra.chapter && extra.chapter.planned) || "This part is being written.";
        el.appendChild(h("div", { class: "soon" },
          h("span", { class: "pill pill-soon", text: "Coming soon" }),
          h("h3", { text: extra && extra.chapter ? "This chapter is being written" : "This tool is being built" }),
          OBZ.ui.p("**Planned:** " + t),
          extra && extra.chapter ? OBZ.ui.p("Meanwhile, every term it will use is already in the [glossary](#/glossary).") : null));
      },
    };
    return Object.assign(ctx, extra || {});
  }

  /* ------------------------------------------------------------ top bar */
  function setNav(view) {
    document.querySelectorAll(".nav a[data-nav]").forEach((a) => {
      const on = a.dataset.nav === view || (view === "chapter" && a.dataset.nav === "learn");
      if (on) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    });
  }
  function updateProgress() {
    const done = OBZ.store.progress.completed().filter((n) => OBZ.chapters.get(n)).length;
    const total = OBZ.chapters.TOTAL;
    const t = document.getElementById("obz-progress-text");
    const ring = document.getElementById("obz-ring");
    const pill = document.getElementById("obz-progress");
    if (t) t.textContent = `${done}/${total}`;
    if (ring) ring.setAttribute("stroke-dashoffset", String(53.41 * (1 - done / total)));
    if (pill) pill.setAttribute("aria-label", `Course progress: ${done} of ${total} chapters complete`);
  }
  function setupTheme() {
    const btn = document.getElementById("obz-theme");
    if (!btn) return;
    const label = () => btn.setAttribute("aria-label", OBZ.util.isDark() ? "Switch to light theme" : "Switch to dark theme");
    btn.addEventListener("click", () => { document.documentElement.setAttribute("data-theme", OBZ.util.isDark() ? "light" : "dark"); label(); });
    OBZ.util.onThemeChange(label);
    label();
  }
  function setupChrome() {
    setupTheme();
    const skip = document.getElementById("obz-skip");
    if (skip) skip.addEventListener("click", (e) => { e.preventDefault(); const m = document.getElementById("main"); if (m) m.focus(); });
    const reset = document.getElementById("obz-reset");
    if (reset) {
      let armed = null;
      reset.addEventListener("click", () => {
        if (!armed) { reset.textContent = "Click again to erase everything"; armed = setTimeout(() => { armed = null; reset.textContent = "Reset my progress"; }, 4000); return; }
        clearTimeout(armed); armed = null; OBZ.store.reset(); reset.textContent = "Progress erased"; route(OBZ.router.current || { view: "home" }, true);
      });
    }
    const note = document.getElementById("obz-storage-note");
    if (note && !OBZ.store.available) note.textContent = "This browser isn't letting the page save anything, so your progress will reset when you leave.";
    OBZ.store.onChange(updateProgress);
    updateProgress();
    window.addEventListener("scroll", readbar, { passive: true });
    window.addEventListener("resize", readbar);
  }
  function readbar() {
    const bar = document.getElementById("obz-readbar");
    if (!bar) return;
    if (!rendered || rendered.view !== "learn" || !rendered.param) { bar.style.transform = "scaleX(0)"; return; }
    const max = document.documentElement.scrollHeight - window.innerHeight;
    bar.style.transform = `scaleX(${max > 0 ? Math.min(1, window.scrollY / max) : 1})`;
  }

  /* ------------------------------------------------------------ shared pieces */
  function chapterStatus(ch) {
    if (OBZ.store.progress.isComplete(ch.number)) return { cls: "pill-ok", text: "Done" };
    if (ch.status !== "ready") return { cls: "pill-soon", text: "Coming soon" };
    if (OBZ.store.progress.visited().includes(ch.number)) return { cls: "pill-todo", text: "In progress" };
    return { cls: "", text: `${ch.quiz.length} questions` };
  }
  function chapterList() {
    const wrap = h("div");
    const last = OBZ.store.progress.last();
    for (const part of OBZ.chapters.PARTS) {
      const chs = OBZ.chapters.all().filter((c) => c.number >= part.from && c.number <= part.to);
      if (!chs.length) continue;
      wrap.appendChild(h("div", { class: "part-head" }, h("h2", { text: part.title }), h("span", { class: "fine", text: part.blurb })));
      wrap.appendChild(h("ol", { class: "ch-grid" }, chs.map((c) => {
        const st = chapterStatus(c);
        return h("li", null, h("a", {
          class: "ch-card" + (OBZ.store.progress.isComplete(c.number) ? " is-done" : "") + (last === c.number ? " is-current" : ""),
          href: OBZ.router.href("learn", c.number),
        },
        h("span", { class: "ch-num", attrs: { "aria-hidden": "true" }, text: OBZ.store.progress.isComplete(c.number) ? "✓" : c.number }),
        h("h3", null, h("span", { class: "sr-only", text: `Chapter ${c.number}: ` }), c.title),
        h("p", { text: c.summary }),
        h("span", { class: "ch-meta" }, h("span", { class: "pill " + st.cls, text: st.text }))));
      })));
    }
    return wrap;
  }
  function resumeCard() {
    const last = OBZ.store.progress.last();
    const ch = last && OBZ.chapters.get(last);
    if (!ch) return null;
    return h("div", { class: "resume" },
      h("p", null, "Welcome back. You were reading ", h("strong", { text: `chapter ${ch.number}, ${ch.title}` }), "."),
      h("a", { class: "btn btn-primary", href: OBZ.router.href("learn", ch.number), text: `Resume chapter ${ch.number} →` }));
  }
  function heroArt() {
    // A decorative mini ladder (aria-hidden): asks above, bids below, a mid line.
    const svg = h("svg", { class: "hero-art", viewBox: "0 0 360 260", attrs: { "aria-hidden": "true" } });
    const asks = [62, 96, 140, 188, 230], bids = [210, 172, 120, 84, 58];
    asks.forEach((w, i) => { svg.appendChild(h("rect", { x: 180 - 0, y: 14 + i * 22, width: w * 0.7, height: 16, rx: 3, class: "box-ask" })); svg.appendChild(h("text", { x: 168, y: 27 + i * 22, "text-anchor": "end", class: "t-mono t-ask", text: (104.4 - i * 0.05 * (1)).toFixed(2) })); });
    svg.appendChild(h("line", { x1: 30, x2: 340, y1: 131, y2: 131, class: "line-accent line-dash" }));
    svg.appendChild(h("text", { x: 34, y: 125, class: "t-mono t-accent t-bold", text: "mid 104.15" }));
    bids.forEach((w, i) => { svg.appendChild(h("rect", { x: 180, y: 142 + i * 22, width: w * 0.7, height: 16, rx: 3, class: "box-bid" })); svg.appendChild(h("text", { x: 168, y: 155 + i * 22, "text-anchor": "end", class: "t-mono t-bid", text: (104.1 - i * 0.05).toFixed(2) })); });
    svg.setAttribute("class", "hero-art diagram");
    return svg;
  }

  /* ------------------------------------------------------------ views */
  function viewHome(page) {
    const first = OBZ.chapters.get(1);
    const last = OBZ.store.progress.last();
    const cta = last && OBZ.chapters.get(last)
      ? h("a", { class: "btn btn-primary btn-lg", href: OBZ.router.href("learn", last), text: `Resume chapter ${last} →` })
      : h("a", { class: "btn btn-primary btn-lg", href: OBZ.router.href("learn", first ? 1 : 2), text: "Start chapter 1 →" });
    page.append(
      h("section", { class: "hero" },
        h("div", { class: "stack" },
          h("p", { class: "eyebrow", text: "An interactive course · 13 chapters" }),
          h("h1", { class: "ch-title", tabIndex: -1 }, "Order books, ", h("span", { class: "hl", text: "from zero" })),
          h("p", { class: "lede" }, ui().rich("How does an exchange decide who trades with whom, and at what price? Learn it the way it's really built: a [[matching-engine|matching engine]] you can poke, real order books from [[phoenix|Phoenix]], Kraken and Coinbase, the raw bytes of a [[solana|Solana]] account, and the [[amm|AMMs]] that compete with books.")),
          h("p", { class: "fine", text: "No finance, crypto or programming background needed: if you know some algebra, you're ready. Every term is a tap away." }),
          h("div", { class: "btn-row" }, cta, h("a", { class: "btn btn-lg", href: "#/glossary", text: "Browse the glossary" }))),
        heroArt()),
      h("div", { class: "modes" },
        modeCard("#/learn", "Learn", "13 chapters", "Story mode: explain, see, try, check. Your place is remembered."),
        modeCard("#/play", "Play", "Sandbox", "The engine, real books, a hex explorer, an AMM lab and coding exercises."),
        modeCard("#/interview", "Interview", "Practice", "Likely questions, a 60-second pitch, and spaced-repetition flashcards."),
        modeCard("#/glossary", "Glossary", `${OBZ.glossary.all().length} terms`, "Every word the course uses, in plain language.")),
      h("h2", { text: "The chapters" }),
      chapterList());
  }
  function modeCard(href, title, k, text) {
    return h("a", { class: "mode", href }, h("span", { class: "mode-k", text: k }), h("h3", { text: title }), h("p", { text }));
  }

  function viewLearn(page) {
    page.append(
      h("p", { class: "eyebrow", text: "Learn" }),
      h("h1", { class: "ch-title", tabIndex: -1, text: "The course" }),
      h("p", { class: "lede", text: "Thirteen short chapters. Each one explains an idea, shows it, lets you try it on real data, and checks your understanding with a few questions." }),
      h("div", { style: "height: 24px" }),
      resumeCard(),
      chapterList());
  }

  function viewChapter(page, ch, sub) {
    OBZ.store.progress.visit(ch.number);
    const goals = h("div", { class: "goals" }, h("h2", { text: "You'll be able to" }), h("ul", null, ch.goals.map((g) => h("li", null, h("span", null, ui().rich(g))))));
    const st = chapterStatus(ch);
    const phaseNav = h("ul", { class: "phase-nav", attrs: { "aria-label": "Sections of this chapter" } });
    page.appendChild(h("header", { class: "ch-head" },
      h("div", null,
        h("div", { class: "ch-kicker" }, h("span", { class: "ch-bignum", attrs: { "aria-hidden": "true" }, text: ch.number }), h("span", { class: "eyebrow", text: `Chapter ${ch.number} of ${OBZ.chapters.TOTAL}` }), h("span", { class: "pill " + st.cls, text: st.text })),
        h("h1", { class: "ch-title", tabIndex: -1, text: ch.title }),
        ch.summary ? h("p", { class: "lede" }, ui().rich(ch.summary)) : null,
        phaseNav),
      goals));
    const body = h("div", { class: "ch-body" });
    page.appendChild(body);
    const ctx = makeCtx(body, {
      chapter: ch,
      section(kind, title) { const s = OBZ.ui.Section({ kind, title, id: `sec-${kind}` }); body.appendChild(s); return s.body; },
    });
    try { ch.render(body, ctx); } catch (e) {
      console.error(`OBZ: chapter ${ch.number} failed to render`, e);
      body.appendChild(OBZ.ui.Callout({ kind: "warn", title: "Something went wrong in this chapter", body: "Part of this page failed to load. The rest of the course still works; please try reloading." }));
    }
    // Check: the quiz from the module.
    const check = ctx.section("check", "Check your understanding");
    if (ch.quiz && ch.quiz.length) {
      check.appendChild(OBZ.ui.p("Pick an answer to see whether it's right and why. You can change your mind as often as you like."));
      check.appendChild(OBZ.ui.Quiz({ id: "ch-" + ch.id, questions: ch.quiz, onComplete: () => { OBZ.store.progress.complete(ch.number); } }));
    } else {
      check.appendChild(OBZ.ui.p("The questions for this chapter are coming soon."));
    }
    // Phase navigation (built from the sections that exist).
    for (const s of body.querySelectorAll(":scope > .sec")) {
      const kind = s.id.replace("sec-", "");
      const label = s.querySelector(".phase-label");
      const n = s.querySelector(".phase-n");
      phaseNav.appendChild(h("li", null, h("a", { href: OBZ.router.href("learn", ch.number, kind) }, h("span", { class: "phase-n", attrs: { "aria-hidden": "true" }, style: { "--phase": `var(--sec-${kind})` }, text: n ? n.textContent : "" }), label ? label.textContent : kind)));
    }
    // Previous / next.
    const prev = OBZ.chapters.get(ch.number - 1), next = OBZ.chapters.get(ch.number + 1);
    page.appendChild(h("nav", { class: "ch-foot", attrs: { "aria-label": "Chapter navigation" } },
      prev ? h("a", { class: "prev", href: OBZ.router.href("learn", prev.number) }, h("span", { class: "eyebrow", text: "← Previous" }), h("strong", { text: `${prev.number}. ${prev.title}` })) : h("span"),
      next ? h("a", { class: "next", href: OBZ.router.href("learn", next.number) }, h("span", { class: "eyebrow", text: "Next chapter →" }), h("strong", { text: `${next.number}. ${next.title}` })) : h("a", { class: "next", href: "#/interview" }, h("span", { class: "eyebrow", text: "Finished? →" }), h("strong", { text: "Practise for the interview" }))));
    if (sub) scrollToSection(sub);
  }
  function scrollToSection(sub) {
    const el = document.getElementById("sec-" + sub);
    if (!el) return;
    el.scrollIntoView({ block: "start" });
    const t = el.querySelector(".sec-title");
    if (t) { t.setAttribute("tabindex", "-1"); t.focus({ preventScroll: true }); }
  }

  function viewPlay(page, id) {
    if (id) {
      const tool = OBZ.play.get(id);
      if (!tool) return viewNotFound(page);
      page.append(
        h("p", { class: "crumbs" }, h("a", { href: "#/play", text: "Play" }), " / ", tool.title),
        h("h1", { class: "ch-title", tabIndex: -1, text: tool.title }),
        h("p", { class: "lede", text: tool.summary }));
      const body = h("div", { class: "stack", style: "margin-top: 24px" });
      page.appendChild(body);
      try { tool.render(body, makeCtx(body, { tool })); } catch (e) {
        console.error(`OBZ: tool ${id} failed`, e);
        body.appendChild(OBZ.ui.Callout({ kind: "warn", title: "This tool failed to load", body: "Please try reloading the page." }));
      }
      return;
    }
    page.append(
      h("p", { class: "eyebrow", text: "Play" }),
      h("h1", { class: "ch-title", tabIndex: -1, text: "The sandbox" }),
      h("p", { class: "lede", text: "No lessons here, just the tools. Everything runs the same engine and the same real data as the chapters." }),
      h("div", { class: "tool-grid" }, OBZ.play.all().map((t) => h("a", { class: "tool-card", href: OBZ.router.href("play", t.id) },
        h("h2", { style: "font-size: var(--fs-md)", text: t.title }),
        h("p", { text: t.summary }),
        t.status !== "ready" ? h("span", { class: "pill pill-soon", text: "Coming soon" }) : null))));
  }

  function viewInterview(page) {
    page.append(
      h("p", { class: "eyebrow", text: "Interview" }),
      h("h1", { class: "ch-title", tabIndex: -1, text: "Interview practice" }),
      h("p", { class: "lede", text: "Questions you are likely to be asked, a pitch you can say in a minute, and flashcards that come back just before you forget them." }));
    const body = h("div", { class: "stack", style: "margin-top: 24px" });
    page.appendChild(body);
    try { OBZ.interview.render(body, makeCtx(body, {})); } catch (e) { console.error("OBZ: interview failed", e); }
  }

  function viewGlossary(page, termId) {
    const all = OBZ.glossary.all();
    const input = h("input", { type: "search", class: "input", id: "gl-q", placeholder: "Search terms, e.g. spread, tick, AMM", autocomplete: "off", attrs: { "aria-describedby": "gl-count" } });
    const count = h("p", { class: "fine", id: "gl-count", attrs: { "aria-live": "polite" } });
    const listBox = h("div");
    const letters = h("nav", { class: "gl-letters", attrs: { "aria-label": "Jump to letter" } });
    function entry(e) {
      return h("article", { class: "gl-entry" + (e.id === termId ? " is-target" : ""), id: "g-" + e.id },
        h("h3", null, h("a", { href: OBZ.router.href("glossary", e.id), text: e.term })),
        e.aliases && e.aliases.length ? h("p", { class: "gl-aka", text: "Also: " + e.aliases.join(", ") }) : null,
        h("p", { class: "gl-def" }, ui().rich(e.def)),
        e.project ? h("p", { class: "gl-proj" }, h("strong", { text: "In this project: " }), ui().rich(e.project)) : null,
        (e.related && e.related.length) || e.chapter ? h("div", { class: "gl-rel" },
          e.related && e.related.length ? h("span", { class: "fine", text: "Related:" }) : null,
          (e.related || []).filter((r) => OBZ.glossary.has(r)).map((r) => h("a", { href: OBZ.router.href("glossary", r), text: OBZ.glossary.get(r).term })),
          e.chapter ? h("a", { href: OBZ.router.href("learn", e.chapter), text: `Chapter ${e.chapter} →` }) : null) : null);
    }
    function draw() {
      const q = input.value.trim();
      const items = q ? OBZ.glossary.search(q) : all;
      clear(listBox); clear(letters);
      count.textContent = q ? `${items.length} term${items.length === 1 ? "" : "s"} match “${q}”.` : `${all.length} terms.`;
      if (!items.length) { listBox.appendChild(h("p", { class: "gl-empty", text: "No terms match. Try a shorter word." })); return; }
      if (q) { listBox.appendChild(h("div", { class: "gl-list" }, items.map(entry))); return; }
      const groups = new Map();
      for (const e of items) { const L = /[a-z]/i.test(e.term[0]) ? e.term[0].toUpperCase() : "#"; if (!groups.has(L)) groups.set(L, []); groups.get(L).push(e); }
      for (const [L, es] of groups) {
        letters.appendChild(h("a", { href: "#gl-" + L, text: L, on: { click: (ev) => { ev.preventDefault(); const t = document.getElementById("gl-" + L); if (t) t.scrollIntoView({ block: "start" }); } } }));
        listBox.appendChild(h("section", { class: "gl-group", id: "gl-" + L, attrs: { "aria-label": `Terms starting with ${L}` } }, h("h2", { text: L }), h("div", { class: "gl-list" }, es.map(entry))));
      }
    }
    input.addEventListener("input", OBZ.util.debounce(draw, 120));
    page.append(
      h("p", { class: "eyebrow", text: "Glossary" }),
      h("h1", { class: "ch-title", tabIndex: -1, text: "Every term, in plain language" }),
      h("p", { class: "lede", text: "Each definition is written for someone who has never traded anything. Underlined words in the chapters open these same definitions." }),
      h("div", { class: "gl-search", attrs: { role: "search" } }, h("label", { class: "sr-only", attrs: { for: "gl-q" }, text: "Search the glossary" }), input, count, letters),
      listBox);
    draw();
    if (termId) {
      setTimeout(() => {
        const t = document.getElementById("g-" + termId);
        if (t) { t.scrollIntoView({ block: "start" }); const a = t.querySelector("h3 a"); if (a) a.focus({ preventScroll: true }); }
        else count.textContent = `There is no term called “${termId}”. Showing all ${all.length} terms.`;
      }, 0);
    }
  }

  function viewNotFound(page) {
    page.append(h("h1", { class: "ch-title", tabIndex: -1, text: "Page not found" }), h("p", { class: "lede" }, "That link doesn't point anywhere in the course. ", h("a", { href: "#/", text: "Go to the start" }), "."));
  }

  /* ------------------------------------------------------------ router */
  function route(r, force) {
    if (!mount) return;
    // Same chapter, different section: just scroll, keep widget state.
    if (!force && rendered && r.view === "learn" && rendered.view === "learn" && r.param && rendered.param === r.param) {
      if (r.sub) scrollToSection(r.sub); else window.scrollTo(0, 0);
      return;
    }
    runCleanups();
    if (OBZ.ui.closePopover) OBZ.ui.closePopover(false);
    clear(mount);
    const page = h("div", { class: "page" });
    mount.appendChild(page);
    let navView = r.view;
    try {
      if (r.view === "home") viewHome(page);
      else if (r.view === "learn" && r.param) {
        const ch = OBZ.chapters.get(r.param);
        if (ch) { viewChapter(page, ch, r.sub); navView = "chapter"; } else viewNotFound(page);
      } else if (r.view === "learn") viewLearn(page);
      else if (r.view === "play") viewPlay(page, r.param);
      else if (r.view === "interview") viewInterview(page);
      else if (r.view === "glossary") viewGlossary(page, r.param);
      else viewNotFound(page);
    } catch (e) {
      console.error("OBZ: view failed", e);
      page.appendChild(OBZ.ui.Callout({ kind: "warn", title: "Something went wrong", body: "This page failed to load. Try reloading." }));
    }
    rendered = { view: r.view, param: r.param };
    setNav(navView);
    updateProgress();
    readbar();
    if (!r.sub && !(r.view === "glossary" && r.param)) window.scrollTo(0, 0);
    if (!firstRender) {
      const h1 = page.querySelector(".ch-title");
      if (h1 && !r.sub && !(r.view === "glossary" && r.param)) h1.focus({ preventScroll: true });
    }
    firstRender = false;
  }

  function boot(el) {
    mount = el || document.getElementById("obz-app");
    if (!mount) return;
    setupChrome();
    OBZ.router.start((r) => route(r));
  }

  OBZ.app = {
    boot,
    route: (r, force) => route(r, force),
    /** Render a route into a given element (tests): returns the page element. */
    renderInto(el, r) { const saved = mount; mount = el; rendered = null; firstRender = true; route(r, true); const pageEl = el.firstChild; mount = saved; rendered = null; return pageEl; },
    makeCtx,
  };

  if (!window.OBZ_NO_BOOT) {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => boot());
    else boot();
  }
})(window.OBZ = window.OBZ || {});
