/* core/router.js: hash routes, so the back button works and any page can be linked.
 *
 *   #/                    home
 *   #/learn               chapter list          #/learn/5            chapter 5
 *   #/learn/5/try         chapter 5, scrolled to its "try" section (explain | see | try | check)
 *   #/play                sandbox tools         #/play/hex           one tool
 *   #/interview           interview mode
 *   #/glossary            glossary              #/glossary/spread    one entry
 *
 * Hashes that don't start with "#/" (e.g. "#main" from the skip link) are ignored, so
 * in-page anchors never re-render the page.
 *
 *   OBZ.router.parse("#/learn/5")  -> {view: "learn", param: "5", sub: null, path: "/learn/5"}
 *   OBZ.router.href("learn", 5)    -> "#/learn/5"
 *   OBZ.router.go("#/glossary/tick")
 *   OBZ.router.start(handler)      handler(route) on load and on every change
 */
(function (OBZ) {
  "use strict";

  const VIEWS = new Set(["home", "learn", "play", "interview", "glossary"]);
  let handler = null;
  let current = null;

  function parse(hash) {
    let h = String(hash || "");
    if (h.startsWith("#")) h = h.slice(1);
    if (h === "" || h === "/") return { view: "home", param: null, sub: null, path: "/" };
    if (!h.startsWith("/")) return null; // an in-page anchor, not a route
    const parts = h.slice(1).split("/").filter(Boolean).map((p) => { try { return decodeURIComponent(p); } catch (e) { return p; } });
    const view = parts[0] || "home";
    if (!VIEWS.has(view)) return { view: "notfound", param: parts.join("/"), sub: null, path: h };
    return { view, param: parts[1] || null, sub: parts[2] || null, path: h };
  }

  function href(view, param, sub) {
    if (!view || view === "home") return "#/";
    let s = "#/" + view;
    if (param !== undefined && param !== null && param !== "") s += "/" + encodeURIComponent(String(param));
    if (sub) s += "/" + encodeURIComponent(String(sub));
    return s;
  }

  function go(hash) {
    if (location.hash === hash) dispatch();
    else location.hash = hash;
  }

  function dispatch() {
    const r = parse(location.hash);
    if (!r) return; // anchor: leave the page as it is
    current = r;
    if (handler) handler(r);
  }

  function start(fn) {
    handler = fn;
    window.addEventListener("hashchange", dispatch);
    dispatch();
  }

  OBZ.router = { parse, href, go, start, get current() { return current; } };
})(window.OBZ = window.OBZ || {});
