/* play/hex.js: PLACEHOLDER. Owner: the chapters 8–10 agent.
 * Real bytes arrive with export v2 (dataset.phoenixAccount = {slot, offset, hex, fields}).
 * Until then this shows the HexView component on a tiny demo slice that is clearly labelled. */
(function (OBZ) {
  "use strict";
  OBZ.play.register({
    id: "hex", order: 3, status: "soon",
    title: "Hex explorer",
    summary: "The raw bytes of a real Phoenix market account: hover a byte to see its field and decoded value.",
    render(el, ctx) {
      const { ui, data } = ctx;
      const pa = data.active().phoenixAccount;
      if (pa) {
        el.appendChild(ui.p(`Real Phoenix account bytes from slot ${OBZ.util.fmt.int(pa.slot)}.`));
        el.appendChild(ui.HexView({ bytes: pa.hex, baseOffset: pa.offset || 0, fields: pa.fields, label: "Phoenix market account" }));
        return;
      }
      el.appendChild(ui.Callout({ kind: "warn", title: "Demo bytes, not a real account", body: "The real Phoenix bytes come with the next data export. Meanwhile, here are 16 made-up bytes holding two [[u64|u64]] numbers, stored [[little-endian]]." }));
      el.appendChild(ui.HexView({
        bytes: "0010000000000000e803000000000000",
        baseOffset: 0,
        label: "Demo bytes",
        fields: [
          { name: "first_number", offset: 0, size: 8, type: "u64", explain: "Bytes 00 10 00 … read smallest-byte-first are 0x1000 = 4,096." },
          { name: "second_number", offset: 8, size: 8, type: "u64", explain: "e8 03 00 … read smallest-byte-first is 0x03e8 = 1,000." },
        ],
      }));
      ctx.placeholder("A hex explorer over the first few kilobytes of the real SOL/USDC market account: header, padding, market fields and the start of the bids tree, every field decoded and explained.");
    },
  });
})(window.OBZ = window.OBZ || {});
