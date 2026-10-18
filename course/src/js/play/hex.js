/* play/hex.js: the Hex explorer sandbox tool. Owner: the chapters 8–10 agent.
 * Real Phoenix account bytes from the active dataset (dataset.phoenixAccount, export v2), shown
 * with the same explorer as chapter 8 (OBZ.lessons.phoenixHex, defined in 08-solana-phoenix.js):
 * the account map, every field decoded with its little-endian reading, live vs freed nodes, and
 * one order decoded with the bid sequence-number bit flip. */
(function (OBZ) {
  "use strict";
  const { h, clear } = OBZ.util;

  OBZ.play.register({
    id: "hex", order: 3, status: "ready",
    title: "Hex explorer",
    summary: "The raw bytes of a real Phoenix market account: hover a byte to see its field, how it is read and what it means.",
    render(el, ctx) {
      const { ui } = ctx;
      const L = OBZ.lessons.phoenixHex;
      const mapBox = h("div"), exBox = h("div"), checkBox = h("div");
      const mount = () => {
        clear(mapBox).appendChild(L.accountMap(ctx));
        clear(exBox).appendChild(L.explorer(ctx));
        clear(checkBox);
        const c = L.seatsCheck(ctx);
        if (c) checkBox.appendChild(c);
      };
      mount();
      ctx.onData(mount);
      el.append(
        ui.p("Phoenix keeps a whole market in one Solana [[account]]. This tool shows the start of the real SOL/USDC account: its [[header]], the market fields, and the first nodes of the bids tree. [Chapter 8](#/learn/8) explains the layout and [chapter 9](#/learn/9) the tree and its [[free-list|free list]]."),
        h("div", { class: "card stack" }, h("h2", { style: "font-size: var(--fs-lg)", text: "The bytes" }), exBox),
        checkBox,
        h("div", { class: "card stack" }, h("h2", { style: "font-size: var(--fs-lg)", text: "Where these bytes sit in the account" }), mapBox),
        ui.Callout({
          kind: "project", title: "How the project reads these bytes",
          body: "`phoenix.py` fetches the account with one `getAccountInfo` call and decodes it with `struct.unpack_from` at fixed offsets. Its layout tables (`HEADER_LAYOUT`, `TREE_LAYOUT`, `NODE_LAYOUT`) also produce this tool's field map when `export.py` writes the course data, so the explorer and the decoder can't disagree about where a field is.",
        }));
    },
  });
})(window.OBZ = window.OBZ || {});
