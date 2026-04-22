/*
 * Bundled payload loader.
 *
 * The build packs every runtime asset that isn't the bootstrap JS —
 * the minified bolklets runtime, the dialogue Markov model, and
 * every character sprite PNG — into a single lossless image
 * (`bolklets_code.png`).  Loading one image instead of N tiny ones
 * means one HTTP round-trip and one decode at startup.  The image
 * lives next to the bundle on the host.
 *
 * Container format:
 *   The payload is a PNG (`bolklets_code.png`).  The build tries
 *   grayscale vs RGB byte packing and keeps the smaller file.
 *
 * Pixel-pack format:
 *   The build also tries grayscale (1 source byte per pixel) and RGB
 *   (3 source bytes per pixel) packing per build.  We branch on the
 *   format flag at byte 0 (R channel of pixel 0) to know which one
 *   the writer chose:
 *     0x00 -- grayscale: take R channel of each pixel as one byte
 *     0x01 -- RGB pack:  take R, G, B of each pixel as three bytes
 *
 * Wire format (after pixel unpacking):
 *
 *   [u8]      format flag (already consumed during unpack)
 *   [u32 BE]  payload_size            -- bytes of the section table
 *   [varint]  n_sections              -- LEB128
 *   for each section:
 *     [varint] name_len
 *     [bytes]  name (ASCII)
 *     [u32 BE] section_size
 *     [bytes]  section payload
 *   trailing zero pad to fill the rectangle
 *
 * Section names used by the rest of the bundle:
 *   "js"               -- minified bolklets runtime (eval'd by the
 *                         bootstrap; absent in dev mode where each
 *                         js/*.js is loaded from disk directly)
 *   "model"            -- packed binary Markov model (see markov.js)
 *   "sprite/<file>"    -- raw PNG bytes of one character frame
 *
 * Why never the alpha channel: a non-255 alpha would trigger
 * premultiplication on canvas read-back on some browsers (Safari in
 * particular) and quietly corrupt the byte stream — 10 * 50 / 255
 * rounds to 2, not 10.  Both grayscale and RGB packing keep alpha
 * fully opaque so the round-trip is byte-exact.
 */
const Payload = (() => {
  const sections = new Map();
  let loaded = false;

  async function load(url) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`fetch ${url}: ${resp.status}`);
    const raw = new Uint8Array(await resp.arrayBuffer());
    const blob = new Blob([raw], { type: "image/png" });
    const bitmap = await createImageBitmap(blob, {
      premultiplyAlpha: "none",
      colorSpaceConversion: "none",
    });
    const w = bitmap.width, h = bitmap.height;
    const canvas = (typeof OffscreenCanvas !== "undefined")
      ? new OffscreenCanvas(w, h)
      : Object.assign(document.createElement("canvas"), { width: w, height: h });
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0);
    const rgba = ctx.getImageData(0, 0, w, h).data;

    const fmt = rgba[0];
    let bytes;
    if (fmt === 0x01) {
      bytes = new Uint8Array((rgba.length >>> 2) * 3);
      for (let i = 0, j = 0; j < rgba.length; i += 3, j += 4) {
        bytes[i]     = rgba[j];
        bytes[i + 1] = rgba[j + 1];
        bytes[i + 2] = rgba[j + 2];
      }
    } else {
      bytes = new Uint8Array(rgba.length >>> 2);
      for (let i = 0, j = 0; j < rgba.length; i++, j += 4) bytes[i] = rgba[j];
    }

    let p = 5;

    function vi() {
      let result = 0, shift = 0, b;
      for (;;) {
        b = bytes[p++];
        result |= (b & 0x7f) << shift;
        if ((b & 0x80) === 0) return result >>> 0;
        shift += 7;
      }
    }
    function u32() {
      const v = (bytes[p] << 24) | (bytes[p + 1] << 16) |
                (bytes[p + 2] << 8) | bytes[p + 3];
      p += 4;
      return v >>> 0;
    }

    const td = new TextDecoder("ascii");
    const n = vi();
    for (let i = 0; i < n; i++) {
      const nameLen = vi();
      const name = td.decode(bytes.subarray(p, p + nameLen));
      p += nameLen;
      const size = u32();
      sections.set(name, bytes.subarray(p, p + size));
      p += size;
    }
    loaded = true;
  }

  function bytes(name) { return sections.get(name); }
  function has(name)   { return sections.has(name); }
  function names()     { return Array.from(sections.keys()); }
  function isLoaded()  { return loaded; }

  return { load, bytes, has, names, isLoaded };
})();
