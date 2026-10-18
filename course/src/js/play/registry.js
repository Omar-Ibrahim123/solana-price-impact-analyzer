/* play/registry.js: sandbox tools (#/play/<id>). Each tool file calls:
 *
 *   OBZ.play.register({
 *     id: "hex",                       // route: #/play/hex
 *     order: 3,                        // position on the Play page
 *     title: "Hex explorer",
 *     summary: "One sentence for the tool card.",
 *     status: "ready" | "soon",
 *     render(el, ctx) { ... },         // ctx is the same as for chapters (minus section())
 *   });
 */
(function (OBZ) {
  "use strict";
  const tools = [];
  function register(t) {
    if (!t.id || !t.title || typeof t.render !== "function") throw new Error("play tool needs id, title and render");
    if (tools.some((x) => x.id === t.id)) throw new Error(`play tool ${t.id} registered twice`);
    tools.push(Object.assign({ status: "soon", order: 99, summary: "" }, t));
    tools.sort((a, b) => a.order - b.order);
  }
  OBZ.play = { register, get: (id) => tools.find((t) => t.id === id) || null, all: () => tools.slice() };
})(window.OBZ = window.OBZ || {});
