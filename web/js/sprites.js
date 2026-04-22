/*
 * Character sprite loader.
 *
 * Each character has four logical frames: {dir=l|r} × {frame=0|1}.  Only
 * the right-facing pair is actually packed into `bolklets_code.png` —
 * the left-facing pair is a pixel-perfect horizontal mirror of the
 * right-facing one (the extractor used to write both via a single
 * `transpose(FLIP_LEFT_RIGHT)` and zopfli/DEFLATE on the outer payload
 * can't see a horizontal flip as a repeat, so storing both wasted ~70 KB
 * of raw RGBA in the bundle).  We synthesise the `l` ImageBitmap once
 * at load time by drawing the `r` bitmap mirrored onto an offscreen
 * canvas; from then on Sprites.get(name, "l", frame) is a regular
 * ImageBitmap lookup with no per-frame flip cost in the hot draw path.
 *
 * Each `r` section is laid out as `[u16 BE width][u16 BE height]
 * [width*height*4 bytes RGBA]` and we decode it straight into an
 * ImageBitmap via createImageBitmap(ImageData) — no Blob/Image dance
 * required.
 *
 * Why raw pixels and not "PNG inside the PNG": the outer payload
 * already runs DEFLATE + zopfli over its entire byte stream, so a
 * second DEFLATE on each sprite (which is what an inner PNG container
 * would do) compresses already-compressed bytes for zero gain and
 * costs us PNG container overhead.  Storing the actual pixel entropy
 * lets zopfli see the runs of fully-transparent pixels and the
 * repeated character palette and squeezes out ~32 KB on a build.
 */
const Sprites = (() => {
  const NAMES = [
    "knight", "witch", "zombie", "archer", "robot",
    "firemage", "ninja", "girl", "viking", "alien",
  ];
  // Non-character sprites that share the same `<name>_r_<frame>` PNG
  // layout but live on their own canvas size and are addressed via
  // Sprites.getExtra() (because Sprites.size() reports the unified hero
  // canvas).  The horse mount is one such sprite — wider and shorter
  // than a hero, and never used as a regular character with a role
  // record / AI tick of its own.
  const EXTRA_SPRITES = ["horse"];
  const FRAMES = [0, 1];

  const images = {};
  let spriteW = 26;
  let spriteH = 32;

  function decodeSprite(bytes) {
    // bytes layout: [u16 BE w][u16 BE h][w*h*4 RGBA]
    const w = (bytes[0] << 8) | bytes[1];
    const h = (bytes[2] << 8) | bytes[3];
    const pixels = bytes.subarray(4, 4 + w * h * 4);
    // ImageData wants a Uint8ClampedArray that owns its memory; use
    // slice() to detach from the shared payload buffer (subarray is a
    // view, ImageData on a view is supported in modern browsers but
    // this keeps things safe across transfer/structured-clone paths).
    const clamped = new Uint8ClampedArray(pixels);
    const data = new ImageData(clamped, w, h);
    return createImageBitmap(data, {
      premultiplyAlpha: "none",
      colorSpaceConversion: "none",
    });
  }

  // Produce a horizontally-mirrored ImageBitmap from a source bitmap.
  // We draw onto an OffscreenCanvas (or HTMLCanvasElement fallback) with
  // a negative x scale, then snapshot the canvas back into an
  // ImageBitmap so the hot draw path stays a plain drawImage call —
  // no per-frame ctx.save/scale/restore on the scene canvas.
  async function mirror(img) {
    const w = img.width, h = img.height;
    let canvas;
    if (typeof OffscreenCanvas !== "undefined") {
      canvas = new OffscreenCanvas(w, h);
    } else {
      canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
    }
    const ctx = canvas.getContext("2d");
    // Disable smoothing so the chunky pixel art stays crisp through the
    // intermediate canvas hop (default is true, which would soften the
    // mirror copy versus the direct-from-ImageData original).
    ctx.imageSmoothingEnabled = false;
    ctx.translate(w, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(img, 0, 0);
    // OffscreenCanvas can hand back an ImageBitmap directly via
    // transferToImageBitmap (cheap, takes ownership of the canvas
    // pixels); for the HTMLCanvasElement fallback we round-trip
    // through createImageBitmap.
    if (typeof canvas.transferToImageBitmap === "function") {
      return canvas.transferToImageBitmap();
    }
    return createImageBitmap(canvas);
  }

  async function loadAll() {
    const jobs = [];
    // Track hero-canvas dims separately so an extra sprite (eg. the
    // horse, which has its own non-uniform size) doesn't poison the
    // shared spriteW/spriteH that hero rendering relies on.
    for (const n of NAMES) {
      images[n] = { l: [], r: [] };
      for (const f of FRAMES) {
        const key = `sprite/${n}_r_${f}`;
        const bytes = Payload.bytes(key);
        if (!bytes) {
          throw new Error(`bolklets payload missing ${key}`);
        }
        const p = decodeSprite(bytes).then(async (img) => {
          images[n].r[f] = img;
          images[n].l[f] = await mirror(img);
          spriteW = img.width;
          spriteH = img.height;
        });
        jobs.push(p);
      }
    }
    for (const n of EXTRA_SPRITES) {
      images[n] = { l: [], r: [] };
      for (const f of FRAMES) {
        const key = `sprite/${n}_r_${f}`;
        const bytes = Payload.bytes(key);
        if (!bytes) {
          // Extra sprites are optional — without them the consumer
          // (eg. the healer's mount summon) just doesn't trigger.
          // Don't tank asset loading the way a missing hero does.
          console.warn(`bolklets payload missing extra sprite ${key}`);
          continue;
        }
        const p = decodeSprite(bytes).then(async (img) => {
          images[n].r[f] = img;
          images[n].l[f] = await mirror(img);
        });
        jobs.push(p);
      }
    }
    await Promise.all(jobs);
    return { w: spriteW, h: spriteH };
  }

  function get(name, dir, frame) {
    return images[name][dir][frame];
  }

  // Same lookup but for non-character sprites whose dimensions don't
  // match the hero canvas.  Returns undefined if the extra sprite
  // wasn't packed into this build (callers should treat that as "no
  // mount available" rather than a hard error).
  function getExtra(name, dir, frame) {
    const set = images[name];
    if (!set) return undefined;
    return set[dir] ? set[dir][frame] : undefined;
  }

  function hasExtra(name) {
    const set = images[name];
    if (!set) return false;
    for (const f of FRAMES) {
      if (!set.r || !set.r[f]) return false;
    }
    return true;
  }

  return {
    NAMES,
    EXTRA_SPRITES,
    loadAll,
    get,
    getExtra,
    hasExtra,
    size: () => ({ w: spriteW, h: spriteH }),
  };
})();
