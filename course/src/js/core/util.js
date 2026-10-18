/* core/util.js: tiny DOM and formatting helpers shared by every module.
 *
 * OBZ.util.h(tag, props, ...children)   build an element (strings become TEXT, never HTML)
 * OBZ.util.fmt.*                         number formatting ($, SOL, bps, compact)
 * OBZ.util.onThemeChange(fn)             call fn when light/dark changes (prunes itself)
 * OBZ.util.reducedMotion()               true when the reader asked for less motion
 */
(function (OBZ) {
  "use strict";

  const SVG_NS = "http://www.w3.org/2000/svg";
  const SVG_TAGS = new Set([
    "svg", "g", "path", "rect", "circle", "line", "polyline", "polygon", "text", "tspan",
    "defs", "marker", "title", "desc", "ellipse", "use", "clipPath", "linearGradient", "stop",
  ]);

  /**
   * h("div", {class: "x", on: {click: fn}, attrs: {role: "img"}, style: {width: "3px"}}, "text", node)
   * props keys: class, id, text, html (trusted strings only, never data), attrs, dataset,
   * style (object or string), on (event map), and any other key is set as a property
   * (e.g. type, value, disabled, hidden, tabIndex, checked).
   */
  function h(tag, props, ...children) {
    const svg = SVG_TAGS.has(tag);
    const el = svg ? document.createElementNS(SVG_NS, tag) : document.createElement(tag);
    if (props) {
      for (const k of Object.keys(props)) {
        const v = props[k];
        if (v === undefined || v === null || v === false) continue;
        if (k === "class") {
          if (svg) el.setAttribute("class", v);
          else el.className = v;
        } else if (k === "text") el.textContent = v;
        else if (k === "html") el.innerHTML = v;
        else if (k === "attrs") for (const a of Object.keys(v)) { if (v[a] !== null && v[a] !== undefined && v[a] !== false) el.setAttribute(a, v[a] === true ? "" : String(v[a])); }
        else if (k === "dataset") for (const a of Object.keys(v)) el.dataset[a] = v[a];
        else if (k === "style") {
          if (typeof v === "string") el.setAttribute("style", v);
          else for (const s of Object.keys(v)) { if (s.startsWith("--")) el.style.setProperty(s, v[s]); else el.style[s] = v[s]; }
        } else if (k === "on") for (const ev of Object.keys(v)) el.addEventListener(ev, v[ev]);
        else if (svg) el.setAttribute(k, v);
        else el[k] = v;
      }
    }
    append(el, children);
    return el;
  }

  function append(el, children) {
    for (const c of children) {
      if (c === null || c === undefined || c === false) continue;
      if (Array.isArray(c)) append(el, c);
      else if (c instanceof Node) el.appendChild(c);
      else el.appendChild(document.createTextNode(String(c)));
    }
    return el;
  }

  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  let uidN = 0;
  const uid = (prefix) => (prefix || "obz") + "-" + (++uidN).toString(36);

  function reducedMotion() {
    try { return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches); } catch (e) { return false; }
  }
  function isCoarse() {
    try { return !!(window.matchMedia && window.matchMedia("(pointer: coarse)").matches); } catch (e) { return false; }
  }

  /** Read a CSS custom property (e.g. "--bid") as a colour string, for canvas drawing. */
  function cssVar(name, el) {
    const v = getComputedStyle(el || document.documentElement).getPropertyValue(name).trim();
    return v || "";
  }

  /** Is the page currently dark (system preference or manual toggle)? */
  function isDark() {
    const t = document.documentElement.getAttribute("data-theme");
    if (t === "dark") return true;
    if (t === "light") return false;
    try { return window.matchMedia("(prefers-color-scheme: dark)").matches; } catch (e) { return false; }
  }

  // ---- theme change subscribers (charts redraw) -------------------------------
  const themeSubs = new Set();
  function onThemeChange(fn) { themeSubs.add(fn); return () => themeSubs.delete(fn); }
  function fireTheme() { for (const fn of Array.from(themeSubs)) { try { fn(); } catch (e) { themeSubs.delete(fn); } } }
  try {
    new MutationObserver(fireTheme).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    if (mq.addEventListener) mq.addEventListener("change", fireTheme);
    else if (mq.addListener) mq.addListener(fireTheme);
  } catch (e) { /* old browser: charts simply keep their colours */ }

  function debounce(fn, ms) {
    let t = null;
    return function (...args) { clearTimeout(t); t = setTimeout(() => fn.apply(this, args), ms); };
  }

  // ---- number formatting -------------------------------------------------------
  const fmt = {
    /** $1,234.56 (digits = decimals, default 2) */
    usd(v, digits = 2) {
      if (v === null || v === undefined || !isFinite(v)) return "–";
      const s = Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
      return (v < 0 ? "−$" : "$") + s;
    },
    /** $1.2K, $10K, $1M */
    usdCompact(v) {
      if (v === null || v === undefined || !isFinite(v)) return "–";
      const a = Math.abs(v), sign = v < 0 ? "−" : "";
      if (a >= 1e9) return sign + "$" + trim(a / 1e9) + "B";
      if (a >= 1e6) return sign + "$" + trim(a / 1e6) + "M";
      if (a >= 1e3) return sign + "$" + trim(a / 1e3) + "K";
      return sign + "$" + trim(a);
    },
    /** price with a fixed number of decimals, no $ sign */
    price(v, digits = 2) { return v === null || v === undefined || !isFinite(v) ? "–" : v.toFixed(digits); },
    /** SOL amounts: fewer decimals for bigger numbers */
    sol(v) {
      if (v === null || v === undefined || !isFinite(v)) return "–";
      const a = Math.abs(v);
      const d = a >= 1000 ? 0 : a >= 100 ? 1 : a >= 1 ? 2 : 3;
      return v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
    },
    /** basis points: "12.3 bps" */
    bps(v, digits) {
      if (v === null || v === undefined || !isFinite(v)) return "–";
      const d = digits !== undefined ? digits : Math.abs(v) >= 100 ? 0 : Math.abs(v) >= 10 ? 1 : 2;
      return v.toFixed(d) + " bps";
    },
    pct(v, digits = 2) { return v === null || v === undefined || !isFinite(v) ? "–" : (v * 100).toFixed(digits) + "%"; },
    int(v) { return v === null || v === undefined || !isFinite(v) ? "–" : Math.round(v).toLocaleString("en-US"); },
    /** generic number with up to `digits` decimals, trailing zeros removed */
    num(v, digits = 4) { return v === null || v === undefined || !isFinite(v) ? "–" : trim(v, digits); },
    date(unixSeconds) {
      if (!unixSeconds) return "–";
      try {
        return new Date(unixSeconds * 1000).toLocaleString("en-US", { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC", timeZoneName: "short" });
      } catch (e) { return new Date(unixSeconds * 1000).toISOString(); }
    },
  };
  function trim(v, digits = 2) {
    return Number(v.toFixed(digits)).toLocaleString("en-US", { maximumFractionDigits: digits });
  }

  OBZ.util = { h, append, clear, esc, clamp, uid, reducedMotion, isCoarse, cssVar, isDark, onThemeChange, debounce, fmt, SVG_NS };
})(window.OBZ = window.OBZ || {});
