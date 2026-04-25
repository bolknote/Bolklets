"""
Build a tiny `dist/bolklets.js` **bootstrap** plus a single companion
`dist/bolklets_code.png` image.

The host page includes the bootstrap:

    <script async src="path/to/bolklets.js"></script>

and it takes care of everything else:

- injects the Press Start 2P Google font link;
- injects the bolklets CSS as an inline <style>;
- creates the #stage / #scene / #bubbles / #hud DOM nodes at the end
  of <body> (idempotent if the host already provided them);
- fetches `bolklets_code.png`, decodes its pixels, and parses the
  embedded section table;
- extracts the "js" section (the minified bolklets runtime), prepends
  the Payload accessor + BOLKLETS_BASE into its lexical scope, and
  evaluates it.

The PNG carries EVERY runtime-side asset as labelled sections:

    "js"                 -- the minified bolklets runtime (this was the
                            old dist/bolklets.js content minus the
                            bootstrap bits)
    "model"              -- the packed binary Markov dialogue model
    "sprite/<file>"      -- raw RGBA pixels of one character frame,
                            prefixed with [u16 BE width][u16 BE height]
                            -- NOT a PNG.  Storing each sprite as its
                            own PNG inside a PNG meant double DEFLATE
                            on already-compressed bytes; switching to
                            raw pixels lets the outer zopfli compress
                            the actual image entropy and saves ~32 KB
                            on the final bundle.

So page load is exactly one fetch after the bootstrap itself.  The
bootstrap figures out its own base URL from `document.currentScript`
and uses it for the payload PNG fetch, so the two files can be hosted
at any path as long as they sit next to each other.
"""

from __future__ import annotations

import datetime
import json
import shutil
import struct
import subprocess
import sys
from concurrent.futures import ProcessPoolExecutor
from collections import Counter, defaultdict
from pathlib import Path

from PIL import Image

YEAR = datetime.date.today().year
# yyyymmddhhmm — local time of the build, embedded as a tiny
# translucent watermark in the bottom-right corner of the lawn so we
# can tell at a glance which build is on a given page.
BUILD_STAMP = datetime.datetime.now().strftime("%Y%m%d%H%M")

# JS minifier ladder, in order of effectiveness:
#
#   1. terser   — full mangler with TOP-LEVEL renaming, multi-pass
#                 compression, dead-code elimination.  Renames module
#                 names like `Markov`, `Sprites`, `Director` (which are
#                 only referenced inside the same file) to single
#                 letters; saves ~1.3 KB on the final PNG vs esbuild.
#                 Requires Node.js (npm i -g terser).
#   2. esbuild  — whitespace + LOCAL identifier mangling + syntax
#                 shortening.  Doesn't touch top-level names by
#                 default, so module names like `Markov` survive
#                 verbatim.  Single fast Go binary, no Node.js needed.
#   3. rjsmin   — pure-Python whitespace-only fallback so the build
#                 still produces a working (if chunkier) bundle on
#                 systems with neither terser nor esbuild installed.
#
# `Payload` and `BOLKLETS_BASE` are referenced in the runtime but
# never declared there (the bootstrap injects them via
# `new Function('Payload', 'BOLKLETS_BASE', src)`), so terser sees
# them as free / global identifiers and leaves them alone — top-level
# mangling is safe even though it sounds aggressive.
TERSER = shutil.which("terser")
ESBUILD = shutil.which("esbuild")
try:
    import rjsmin  # type: ignore
except ImportError:  # pragma: no cover
    rjsmin = None
try:
    import csscompressor  # type: ignore
except ImportError:  # pragma: no cover
    csscompressor = None


def minify_css(text: str) -> str:
    """Minify CSS using whichever tool gives the smallest output.

    Preference order:
      1. esbuild (when installed) — its CSS pipeline outputs the
         tightest result on our stylesheet (it normalises hex colour
         alpha, drops `:`s on `::before`/`::after`, rewrites `100%`
         keyframe selectors as `to`, shortens `180ms` to `.18s`,
         folds `translateX(-50%)` to `translate(-50%)`, etc.).
      2. csscompressor (Python, pure pip) — solid baseline; we keep
         it as a fallback so the build still runs in environments
         without Node.
      3. The original text — last-resort no-op so the build never
         outright fails just because no minifier is available.
    """
    if ESBUILD:
        result = subprocess.run(
            [ESBUILD, "--minify", "--loader=css"],
            input=text,
            capture_output=True,
            text=True,
            check=True,
        )
        return result.stdout
    if csscompressor is not None:
        return csscompressor.compress(text, preserve_exclamation_comments=False)
    return text


def minify_js(text: str) -> str:
    if TERSER:
        # `mangle.toplevel + compress.toplevel` rename module-level
        # `const Markov = …` / `const Sprites = …` / etc. to single
        # letters consistently across the whole file.  passes=3 lets
        # the compressor re-run inlining + dead-code passes on its own
        # output; the third pass usually shaves another few hundred
        # bytes.  `--ecma 2019` matches what we ship to the browser
        # (async/await, object rest, optional chaining are fine).
        # `--format comments=/^!/` keeps the /*! … */ legal banner in
        # place at the top of the file.
        result = subprocess.run(
            [
                TERSER,
                "--ecma", "2019",
                "--compress", "passes=3,toplevel=true",
                "--mangle", "toplevel=true",
                "--format", "comments=/^!/",
            ],
            input=text,
            capture_output=True,
            text=True,
            check=True,
        )
        return result.stdout
    if ESBUILD:
        # --minify turns on whitespace removal + identifier mangling +
        # syntax shortening.  --legal-comments=inline keeps our /*!…*/
        # banner right where it is at the top of the file instead of
        # pushing it to EOF (esbuild's default).  --target=es2019 keeps
        # modern syntax we already rely on (async/await, object rest,
        # optional chaining) without transpiling to older forms.
        result = subprocess.run(
            [
                ESBUILD,
                "--minify",
                "--legal-comments=inline",
                "--target=es2019",
                "--loader=js",
            ],
            input=text,
            capture_output=True,
            text=True,
            check=True,
        )
        return result.stdout
    if rjsmin is not None:
        # keep_bang_comments=True preserves the top-level /*! banner.
        return rjsmin.jsmin(text, keep_bang_comments=True)
    return text

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"
DIST.mkdir(exist_ok=True)

SPRITE_DIR = ROOT / "build" / "sprites"
CSS_FILE = ROOT / "web" / "style.css"
JS_DIR = ROOT / "web" / "js"
MODEL_FILE = ROOT / "build" / "dialog_model.json"
# Lives next to web/index.html so the dev page can fetch it relatively.
PAYLOAD_IMAGE_FILE = ROOT / "web" / "bolklets_code.png"
# Width of the encoded image.  The actual value doesn't affect file
# size meaningfully; 1024 keeps the image reasonably square and avoids
# silly skinny strips.
PAYLOAD_IMAGE_WIDTH = 1024
ZOPFLIPNG = shutil.which("zopflipng")
OPTIPNG = shutil.which("optipng")
ECT = shutil.which("ect")

# 1-byte header at the very start of the unpacked stream that tells
# the loader how the bytes were spread across pixel channels:
#   FORMAT_GRAY  -- 1 byte  per pixel: source byte goes into R, image
#                   is saved as a single-channel grayscale ('L')
#   FORMAT_RGB   -- 3 bytes per pixel: bytes go into R, G, B in order,
#                   image is saved as 3-channel RGB (alpha omitted on
#                   purpose: see _decode comment in the bootstrap for
#                   the premultiply-alpha rabbit hole we'd hit otherwise)
# The bootstrap reads the R channel of pixel 0 first, branches on it,
# then unpacks the rest of the image accordingly.
FORMAT_GRAY = 0x00
FORMAT_RGB = 0x01
# Modules that go into the packed "js" section of bolklets_code.png —
# i.e. the bolklets runtime itself.  payload.js is deliberately NOT in
# this list: the bootstrap already does the PNG fetch + section parse,
# so a second Payload module inside the core would just be a dead
# redefinition.  The bootstrap injects an equivalent Payload object
# (backed by a pre-populated section Map) into the runtime via a
# closure argument, so existing `Payload.bytes(...)` / `Payload.load(...)`
# call-sites keep working unchanged.
JS_FILES = [
    "markov.js",
    "sprites.js",
    "scene.js",
    "monsters.js",
    "combat.js",
    "characters.js",
    "dialog.js",
    "main.js",
]
BUNDLE_NAME = "bolklets.js"


MODEL_BIN_VERSION = 5
MODEL_BIN_VERSION_V6 = 6
MODEL_BIN_VERSION_V7 = 7

# Tone tags for the per-start tone column.  Order matters: the
# trainer writes integers, the runtime decodes them back via this
# index.  Anything not in this list collapses to "calm" at pack time.
TONE_NAMES = ["calm", "tense", "shaken"]
TONE_INDEX = {t: i for i, t in enumerate(TONE_NAMES)}


def _varint(n: int, buf: bytearray) -> None:
    """Append an LEB128-encoded non-negative integer."""
    while True:
        b = n & 0x7F
        n >>= 7
        if n:
            buf.append(b | 0x80)
        else:
            buf.append(b)
            return


def _quantize_count(c: int) -> int:
    """Snap a transition count down to the nearest power of two.

    Counts are only consumed by the runtime's weighted random picker;
    once flattened to powers of two the per-state distribution shifts
    only slightly (the popular continuations stay popular), the same
    words are emitted in the same order, but the count column collapses
    to a tiny set of distinct varint values, which deflate compresses
    far better than the long tail of raw integer counts.
    """
    return 1 if c <= 0 else 1 << (c.bit_length() - 1)


def _quantize_start_weight(w: int) -> int:
    """Same pow2-snap trick as transition counts, applied to per-start
    weights.  The runtime exponentiates these for sub-linear sampling
    (`weight ** start_flatten`) so collapsing to pow2 buckets shifts
    the resulting distribution by less than the flattening already
    does, while collapsing the column to ~14 distinct values."""
    return 1 if w <= 0 else 1 << (w.bit_length() - 1)


def pack_model(model: dict) -> bytes:
    """Encode the Markov model into a compact column-store binary blob.

    Order-2 models keep using the tightly packed v5 layout below.
    Higher-order models are encoded as v6 via `pack_model_v6()` so the
    browser can reconstruct honest `order`-word state keys instead of
    silently collapsing them back to bigrams.

    Layout (version 5):

      [u8]     format version (== 5)
      [varint] vocab_size
      [vocab_size words] each word is a stream of ASCII bytes; the
                         LAST byte of the word has its high bit set.
                         Our tokeniser only emits [A-Za-z'] and
                         [.!?,] so every character fits in 7 bits
                         and the top bit is a free word terminator,
                         saving the per-word length varint.
      [varint] n_starts
      [varint] n_start_groups
      [varint] n_groups
      [11 × varint] byte-length of each of the columns below, in
                    stream order (so the decoder can slice them out
                    without peeking inside).
      [bytes] col_sg_dw1   -- start-group Δw1, one varint per start group
      [bytes] col_sg_n     -- entries per start group
      [bytes] col_sg_dw2   -- Δw2 within each start group
      [bytes] col_g_dw1    -- trans-group Δw1
      [bytes] col_g_n      -- entries per trans group
      [bytes] col_e_dw2    -- Δw2 within each trans entry (sorted by w2)
      [bytes] col_e_fan    -- fanout per (w1, w2) state
      [bytes] col_n_dnext  -- Δnext-word per transition (sorted by next)
      [bytes] col_n_count  -- transition count, quantised to pow2
      [bytes] col_starts_w   -- per-start weight (one varint per start
                                in iteration order; pow2-quantised so
                                the column collapses to ~14 distinct
                                values, deflate-friendly)
      [bytes] col_starts_tone -- per-start tone tag (one byte per start
                                in iteration order; 0=calm, 1=tense,
                                2=shaken — only 3 distinct values, RLE-
                                friendly)

    The decoder walks the same nested structure as the previous v4 but
    pulls each field from its own stream instead of from one
    interleaved blob.  After the standard `starts` / `trans`
    reconstruction, it walks the start list a second time and reads
    one weight + one tone byte per start.  Reconstructing
    `{starts, trans, start_weights, starts_by_tone, ...}` produces the
    same starts and the same sorted (w1, w2) → [(next, count)] lists
    apart from the deliberate count + start-weight quantisation.

    Design notes:

    * Word dictionary uses frequency ordering, so common words
      ("the", "I", ".") get 1-byte varint indices.
    * Grouping starts and trans entries by w1 collapses repeated
      prefixes; delta-encoding w1/w2/next within each sorted list
      keeps most integers small enough to fit in one varint byte.
    * The high-bit word terminator trick keeps the dictionary tight.
    * Splitting the body into per-field columns is the big PNG win:
      each column has its own value distribution (small Δw1 ints vs
      Δw2 ints vs fanout 1-12 vs deltas vs counts), and keeping each
      one contiguous lets deflate's LZ77 stage find much longer
      matching runs than when the varints were interleaved.  This is a
      lossless rearrangement and shaves ~37 KB off the v3 image.
    * Quantising the per-edge `count` and per-start weight to the
      nearest power of two collapses both columns to a handful of
      distinct values without visibly changing the generator's output.
    * The two new v5 columns add roughly 1 byte (weight) + 1 byte
      (tone) per start.  At 4000 starts that's ~8 KB before deflate;
      after PNG compression both columns crunch to a couple of KB
      each thanks to the very small alphabet.
    """
    order = int(model.get("order", 2) or 2)
    if order != 2:
        if model.get("backoff_trans"):
            return pack_model_v7(model)
        return pack_model_v6(model)

    freq: Counter[str] = Counter()
    for w1, w2 in model["starts"]:
        freq[w1] += 1
        freq[w2] += 1
    for key, nexts in model["trans"].items():
        w1, w2 = key.split(" ", 1)
        freq[w1] += 1
        freq[w2] += 1
        for w, _ in nexts:
            freq[w] += 1
    vocab = [w for w, _ in freq.most_common()]
    idx = {w: i for i, w in enumerate(vocab)}

    out = bytearray()
    out.append(MODEL_BIN_VERSION)

    _varint(len(vocab), out)
    for w in vocab:
        b = w.encode("ascii")
        if not b:
            raise ValueError("empty word in vocabulary")
        if any(c & 0x80 for c in b):
            raise ValueError(
                f"non-ASCII byte in {w!r}: packer relies on the top "
                "bit as a word terminator"
            )
        out += b[:-1]
        out.append(b[-1] | 0x80)

    # Build (w1i, w2i) → weight / tone-id maps, then iterate starts in
    # the same nested order the decoder does.  Defaults (weight=1,
    # tone=calm) keep older trainer outputs that lack these fields
    # packable without a special path.
    start_weight_lookup: dict[tuple[int, int], int] = {}
    start_tone_lookup: dict[tuple[int, int], int] = {}
    raw_weights = model.get("start_weights") or []
    for (w1, w2), wt in zip(model["starts"], raw_weights):
        start_weight_lookup[(idx[w1], idx[w2])] = int(wt)
    starts_by_tone = model.get("starts_by_tone") or {}
    for tone_name, bucket in starts_by_tone.items():
        tone_id = TONE_INDEX.get(tone_name, 0)
        for w1, w2 in bucket:
            start_tone_lookup[(idx[w1], idx[w2])] = tone_id

    starts = sorted((idx[w1], idx[w2]) for w1, w2 in model["starts"])
    start_groups: dict[int, list[int]] = defaultdict(list)
    for w1i, w2i in starts:
        start_groups[w1i].append(w2i)
    start_group_ids = sorted(start_groups)

    col_sg_dw1 = bytearray()
    col_sg_n = bytearray()
    col_sg_dw2 = bytearray()
    col_starts_w = bytearray()
    col_starts_tone = bytearray()
    prev_w1 = 0
    for w1i in start_group_ids:
        _varint(w1i - prev_w1, col_sg_dw1)
        prev_w1 = w1i
        entries = start_groups[w1i]
        _varint(len(entries), col_sg_n)
        prev_w2 = 0
        for w2i in entries:
            _varint(w2i - prev_w2, col_sg_dw2)
            prev_w2 = w2i
            wt = start_weight_lookup.get((w1i, w2i), 1)
            _varint(_quantize_start_weight(wt), col_starts_w)
            col_starts_tone.append(start_tone_lookup.get((w1i, w2i), 0))

    groups: dict[int, list[tuple[int, list[tuple[str, int]]]]] = defaultdict(list)
    for key, nexts in model["trans"].items():
        w1, w2 = key.split(" ", 1)
        groups[idx[w1]].append((idx[w2], nexts))
    group_ids = sorted(groups)

    col_g_dw1 = bytearray()
    col_g_n = bytearray()
    col_e_dw2 = bytearray()
    col_e_fan = bytearray()
    col_n_dnext = bytearray()
    col_n_count = bytearray()
    prev_w1 = 0
    for w1i in group_ids:
        _varint(w1i - prev_w1, col_g_dw1)
        prev_w1 = w1i
        entries = sorted(groups[w1i], key=lambda e: e[0])
        _varint(len(entries), col_g_n)
        prev_w2 = 0
        for w2i, nexts in entries:
            _varint(w2i - prev_w2, col_e_dw2)
            prev_w2 = w2i
            _varint(len(nexts), col_e_fan)
            sorted_nexts = sorted(nexts, key=lambda e: idx[e[0]])
            prev_n = 0
            for w, c in sorted_nexts:
                ni = idx[w]
                _varint(ni - prev_n, col_n_dnext)
                prev_n = ni
                _varint(_quantize_count(c), col_n_count)

    _varint(len(starts), out)
    _varint(len(start_group_ids), out)
    _varint(len(group_ids), out)

    columns = [
        col_sg_dw1, col_sg_n, col_sg_dw2,
        col_g_dw1, col_g_n, col_e_dw2, col_e_fan,
        col_n_dnext, col_n_count,
        col_starts_w, col_starts_tone,
    ]
    for col in columns:
        _varint(len(col), out)
    for col in columns:
        out += col
    return bytes(out)


def pack_model_v6(model: dict) -> bytes:
    """Encode an arbitrary-order model into a simpler generic blob.

    Layout (version 6):

      [u8]     format version (== 6)
      [varint] order
      [varint] vocab_size
      [vocab words] same high-bit word terminator trick as v5
      [varint] n_starts
      [varint] n_states
      [7 x varint] byte-length of each column below
      [bytes] col_start_words  -- absolute vocab ids, `order` ids per start
      [bytes] col_start_w      -- per-start weight (pow2-quantised)
      [bytes] col_start_tone   -- per-start tone byte
      [bytes] col_state_words  -- absolute vocab ids, `order` ids per state
      [bytes] col_state_fan    -- fanout per state
      [bytes] col_next_word    -- absolute vocab ids for next words
      [bytes] col_next_count   -- next-word counts (pow2-quantised)

    This is less compressed than the bigram-specialised v5 path, but it
    keeps the ordering honest for trigram experiments and stays simple
    enough to benchmark against the production bigram format.
    """
    order = int(model.get("order", 2) or 2)
    if order < 2:
        raise ValueError(f"unsupported model order {order}")

    freq: Counter[str] = Counter()
    for start in model["starts"]:
        for w in start:
            freq[w] += 1
    for key, nexts in model["trans"].items():
        parts = key.split(" ")
        if len(parts) != order:
            raise ValueError(
                f"state {key!r} does not match model order {order}"
            )
        for w in parts:
            freq[w] += 1
        for w, _ in nexts:
            freq[w] += 1
    vocab = [w for w, _ in freq.most_common()]
    idx = {w: i for i, w in enumerate(vocab)}

    out = bytearray()
    out.append(MODEL_BIN_VERSION_V6)
    _varint(order, out)
    _varint(len(vocab), out)
    for w in vocab:
        b = w.encode("ascii")
        if not b:
            raise ValueError("empty word in vocabulary")
        if any(c & 0x80 for c in b):
            raise ValueError(
                f"non-ASCII byte in {w!r}: packer relies on the top "
                "bit as a word terminator"
            )
        out += b[:-1]
        out.append(b[-1] | 0x80)

    start_weight_lookup: dict[tuple[int, ...], int] = {}
    start_tone_lookup: dict[tuple[int, ...], int] = {}
    raw_weights = model.get("start_weights") or []
    for start, wt in zip(model["starts"], raw_weights):
        start_weight_lookup[tuple(idx[w] for w in start)] = int(wt)
    starts_by_tone = model.get("starts_by_tone") or {}
    for tone_name, bucket in starts_by_tone.items():
        tone_id = TONE_INDEX.get(tone_name, 0)
        for start in bucket:
            start_tone_lookup[tuple(idx[w] for w in start)] = tone_id

    starts = sorted(tuple(idx[w] for w in start) for start in model["starts"])
    states = []
    for key, nexts in model["trans"].items():
        state = tuple(idx[w] for w in key.split(" "))
        states.append((state, nexts))
    states.sort(key=lambda item: item[0])

    col_start_words = bytearray()
    col_start_w = bytearray()
    col_start_tone = bytearray()
    for start in starts:
        for wi in start:
            _varint(wi, col_start_words)
        _varint(_quantize_start_weight(start_weight_lookup.get(start, 1)),
                col_start_w)
        col_start_tone.append(start_tone_lookup.get(start, 0))

    col_state_words = bytearray()
    col_state_fan = bytearray()
    col_next_word = bytearray()
    col_next_count = bytearray()
    for state, nexts in states:
        for wi in state:
            _varint(wi, col_state_words)
        _varint(len(nexts), col_state_fan)
        for w, c in sorted(nexts, key=lambda item: idx[item[0]]):
            _varint(idx[w], col_next_word)
            _varint(_quantize_count(c), col_next_count)

    _varint(len(starts), out)
    _varint(len(states), out)
    columns = [
        col_start_words,
        col_start_w,
        col_start_tone,
        col_state_words,
        col_state_fan,
        col_next_word,
        col_next_count,
    ]
    for col in columns:
        _varint(len(col), out)
    for col in columns:
        out += col
    return bytes(out)


def pack_model_v7(model: dict) -> bytes:
    """Version 7 = v6 trigram body + exact bigram backoff table.

    Used only for higher-order hybrid experiments. The extra table lets
    the runtime fall back to honest bigram counts from the same filtered
    corpus instead of pooling all matching higher-order states together.
    """
    order = int(model.get("order", 2) or 2)
    if order < 3:
        return pack_model_v6(model)
    backoff_trans = model.get("backoff_trans") or {}

    freq: Counter[str] = Counter()
    for start in model["starts"]:
        for w in start:
            freq[w] += 1
    for key, nexts in model["trans"].items():
        for w in key.split(" "):
            freq[w] += 1
        for w, _ in nexts:
            freq[w] += 1
    for key, nexts in backoff_trans.items():
        for w in key.split(" "):
            freq[w] += 1
        for w, _ in nexts:
            freq[w] += 1
    vocab = [w for w, _ in freq.most_common()]
    idx = {w: i for i, w in enumerate(vocab)}

    out = bytearray()
    out.append(MODEL_BIN_VERSION_V7)
    _varint(order, out)
    _varint(len(vocab), out)
    for w in vocab:
        b = w.encode("ascii")
        if not b:
            raise ValueError("empty word in vocabulary")
        if any(c & 0x80 for c in b):
            raise ValueError(
                f"non-ASCII byte in {w!r}: packer relies on the top "
                "bit as a word terminator"
            )
        out += b[:-1]
        out.append(b[-1] | 0x80)

    start_weight_lookup: dict[tuple[int, ...], int] = {}
    start_tone_lookup: dict[tuple[int, ...], int] = {}
    raw_weights = model.get("start_weights") or []
    for start, wt in zip(model["starts"], raw_weights):
        start_weight_lookup[tuple(idx[w] for w in start)] = int(wt)
    starts_by_tone = model.get("starts_by_tone") or {}
    for tone_name, bucket in starts_by_tone.items():
        tone_id = TONE_INDEX.get(tone_name, 0)
        for start in bucket:
            start_tone_lookup[tuple(idx[w] for w in start)] = tone_id

    starts = sorted(tuple(idx[w] for w in start) for start in model["starts"])
    states = []
    for key, nexts in model["trans"].items():
        states.append((tuple(idx[w] for w in key.split(" ")), nexts))
    states.sort(key=lambda item: item[0])
    backoff_states = []
    for key, nexts in backoff_trans.items():
        backoff_states.append((tuple(idx[w] for w in key.split(" ")), nexts))
    backoff_states.sort(key=lambda item: item[0])

    col_start_words = bytearray()
    col_start_w = bytearray()
    col_start_tone = bytearray()
    for start in starts:
        for wi in start:
            _varint(wi, col_start_words)
        _varint(_quantize_start_weight(start_weight_lookup.get(start, 1)), col_start_w)
        col_start_tone.append(start_tone_lookup.get(start, 0))

    col_state_words = bytearray()
    col_state_fan = bytearray()
    col_next_word = bytearray()
    col_next_count = bytearray()
    for state, nexts in states:
        for wi in state:
            _varint(wi, col_state_words)
        _varint(len(nexts), col_state_fan)
        for w, c in sorted(nexts, key=lambda item: idx[item[0]]):
            _varint(idx[w], col_next_word)
            _varint(_quantize_count(c), col_next_count)

    col_back_state_words = bytearray()
    col_back_state_fan = bytearray()
    col_back_next_word = bytearray()
    col_back_next_count = bytearray()
    for state, nexts in backoff_states:
        for wi in state:
            _varint(wi, col_back_state_words)
        _varint(len(nexts), col_back_state_fan)
        for w, c in sorted(nexts, key=lambda item: idx[item[0]]):
            _varint(idx[w], col_back_next_word)
            _varint(_quantize_count(c), col_back_next_count)

    _varint(len(starts), out)
    _varint(len(states), out)
    _varint(len(backoff_states), out)
    columns = [
        col_start_words,
        col_start_w,
        col_start_tone,
        col_state_words,
        col_state_fan,
        col_next_word,
        col_next_count,
        col_back_state_words,
        col_back_state_fan,
        col_back_next_word,
        col_back_next_count,
    ]
    for col in columns:
        _varint(len(col), out)
    for col in columns:
        out += col
    return bytes(out)


def _encode_varint(n: int, buf: bytearray) -> None:
    """Append an LEB128-encoded non-negative integer (alias of _varint).

    Re-exposed under a clearer name for the section-table code below;
    the implementation is identical to _varint and we delegate so the
    two stay in sync.
    """
    _varint(n, buf)


def pack_payload(sections: list[tuple[str, bytes]]) -> bytes:
    """Pack named binary sections into a single self-describing blob.

    Wire format (matches js/payload.js):

      [varint] n_sections
      for each section:
        [varint] name_len
        [bytes]  name (ASCII)
        [u32 BE] section_size
        [bytes]  section payload

    A 4-byte big-endian uint32 with the *outer* payload length is
    prepended by encode_payload_image so the loader knows where the
    real bytes end inside the rectangular image.

    Section names used at runtime:
      "model"                 -- packed binary Markov model
      "sprite/<basename>"     -- raw RGBA pixels of one sprite frame
                                 (prefixed with [u16 BE w][u16 BE h])
    """
    buf = bytearray()
    _encode_varint(len(sections), buf)
    for name, blob in sections:
        name_bytes = name.encode("ascii")
        _encode_varint(len(name_bytes), buf)
        buf += name_bytes
        buf += struct.pack(">I", len(blob))
        buf += blob
    return bytes(buf)


def _save_png(img: Image.Image, path: Path) -> None:
    """Save an image as PNG and re-crunch with zopflipng/optipng, then ect.

    Those tools are lossless: they only re-encode the PNG (DEFLATE /
    filters), never change decoded pixels.
    """
    img.save(path, format="PNG", optimize=True, compress_level=9)
    if ZOPFLIPNG:
        tmp = path.with_suffix(path.suffix + ".tmp")
        # --iterations=50 is the sweet spot: 100 gives ~150 extra bytes
        # off but doubles build time.
        r = subprocess.run(
            [ZOPFLIPNG, "-y", "--iterations=50", str(path), str(tmp)],
            capture_output=True,
        )
        if (
            r.returncode == 0
            and tmp.exists()
            and tmp.stat().st_size < path.stat().st_size
        ):
            tmp.replace(path)
        else:
            tmp.unlink(missing_ok=True)
    elif OPTIPNG:
        subprocess.run(
            [OPTIPNG, "-o7", "-quiet", "-strip", "all", str(path)],
            check=False,
        )
    if ECT:
        subprocess.run(
            [ECT, "-quiet", "-9", "-strip", str(path)],
            capture_output=True,
            check=False,
        )


def _encode_payload_trial_worker(
    args: tuple[bytes, str, int, str],
) -> tuple[int, str, str]:
    """Encode one pack-mode trial (runs in a child process)."""
    packed, mode, fmt, tmp_path_str = args
    tmp_path = Path(tmp_path_str)
    payload = bytes([fmt]) + struct.pack(">I", len(packed)) + packed
    bpp = 1 if mode == "L" else 3
    pix_count = (len(payload) + bpp - 1) // bpp
    height = max(
        1, (pix_count + PAYLOAD_IMAGE_WIDTH - 1) // PAYLOAD_IMAGE_WIDTH
    )
    pad = PAYLOAD_IMAGE_WIDTH * height * bpp - len(payload)
    img = Image.frombytes(
        mode, (PAYLOAD_IMAGE_WIDTH, height), payload + b"\x00" * pad
    )
    _save_png(img, tmp_path)
    return (tmp_path.stat().st_size, mode, tmp_path_str)


def encode_payload_image(
    sections: list[tuple[str, bytes]], image_path: Path
) -> tuple[int, int, list[tuple[str, int]]]:
    """Encode the section table into the smallest PNG.

    Pipeline:
      1. Build the byte stream:  [u8 format] [u32 BE total_len] [table]
         where format is FORMAT_GRAY (0x00) or FORMAT_RGB (0x01) and
         tells the loader how many source bytes occupy each pixel.
      2. Try both pack modes in parallel (two worker processes):
           PNG / L    PNG / RGB
         encoding the same byte stream into a rectangle of the
         appropriate channel count and recompressing with zopflipng
         (50 iterations), then ect -9 -strip when available.
      3. Pick the smaller output and write it to `image_path`.

    Returns (packed_table_size, final_image_size, trial_results)
    where trial_results is a list of (mode, size_bytes) sorted
    smallest-first so the caller can print them.
    """
    packed = pack_payload(sections)

    variants = [
        ("L", FORMAT_GRAY),
        ("RGB", FORMAT_RGB),
    ]

    trial_args: list[tuple[bytes, str, int, str]] = []
    for mode, fmt in variants:
        tmp = image_path.with_suffix(f".trial.{mode}.png")
        trial_args.append((packed, mode, fmt, str(tmp)))

    with ProcessPoolExecutor(max_workers=2) as pool:
        worker_results = list(pool.map(_encode_payload_trial_worker, trial_args))

    trials: list[tuple[int, str, Path]] = [
        (size, mode, Path(tmp_str)) for size, mode, tmp_str in worker_results
    ]
    trials.sort(key=lambda t: t[0])
    _, _, winner_path = trials[0]
    if image_path.exists():
        image_path.unlink()
    shutil.move(str(winner_path), str(image_path))
    for _, _, tmp in trials[1:]:
        tmp.unlink(missing_ok=True)

    summary = [(mode, size) for size, mode, _ in trials]
    return len(packed), image_path.stat().st_size, summary


def collect_sprite_sections() -> list[tuple[str, bytes]]:
    """Read each sprite as raw RGBA pixels.

    Each section is laid out as:
        [u16 BE width][u16 BE height][width*height*4 bytes RGBA]

    We deliberately don't keep the original PNG container: those bytes
    are already DEFLATE-compressed once, and the outer payload PNG
    (which holds this section table) runs DEFLATE+zopfli over the
    whole thing again.  Compressing already-compressed data is a no-op
    so the inner PNG is pure overhead — switching to raw RGBA exposes
    the actual sprite entropy (lots of repeating colours and runs of
    fully-transparent pixels) to zopfli, which jumps on it and saves
    ~32 KB on a typical build.
    """
    out: list[tuple[str, bytes]] = []
    for f in sorted(SPRITE_DIR.glob("*.png")):
        img = Image.open(f).convert("RGBA")
        # basename without .png — the section is no longer a PNG.
        name = f.stem
        header = struct.pack(">HH", img.width, img.height)
        out.append((f"sprite/{name}", header + img.tobytes()))
    if not out:
        raise SystemExit(
            "no sprites found under build/sprites — run extract_sprites.py first"
        )
    return out


def js_string(text: str) -> str:
    """Quote a string as a JS template literal payload."""
    return text.replace("\\", "\\\\").replace("`", "\\`").replace("${", "\\${")


def build_core_js() -> tuple[str, str]:
    """Concatenate + minify the bolklets runtime.

    Returns (raw, minified) strings; the caller encodes the minified
    form to UTF-8 and stores it in the "js" section of the payload
    PNG, and uses the raw size only for build-log statistics.

    We prepend an explicit 'use strict'; directive: the bootstrap
    evaluates the packed runtime via `new Function(...)`, and
    Function-constructor bodies are sloppy-mode by default.  Putting
    the directive at the very top of the string (pre-minify) is the
    simplest way to guarantee the runtime runs strict regardless of
    whatever the minifier decides to do with per-IIFE directives.
    """
    parts: list[str] = ['"use strict";\n']
    for name in JS_FILES:
        src = (JS_DIR / name).read_text(encoding="utf-8")
        parts.append(f"/* ======== js/{name} ======== */\n{src}\n")
    raw = "\n".join(parts)
    return raw, minify_js(raw)


def build_bootstrap_js(css_text: str) -> tuple[str, str]:
    """Build the tiny loader that gets saved as dist/bolklets.js.

    This is the ONLY JS that ships outside the PNG.  It:

      1. resolves its own base URL;
      2. injects the Press Start 2P link + inline CSS + #bolklets-*
         DOM nodes (same as the old prelude);
      3. fetches bolklets_code.png, reads the bytes back through a
         canvas, and parses the LEB128 section table;
      4. builds a Payload object whose `load()` is a no-op (the PNG
         is already parsed) and whose `bytes(name)` reads from the
         pre-populated Map;
      5. evaluates the packed "js" section via `new Function(...)`,
         passing Payload and BOLKLETS_BASE as arguments so the runtime
         sees them via lexical scope (no globals).

    Returns (raw_source, minified_source); caller writes the minified
    form to dist/bolklets.js.
    """
    src = f"""\
/*! bolklets — a tiny pixel-art adventure in the spirit of old 8-bit
 * games: little heroes wander a sunlit lawn, chat with each other,
 * brew potions, fend off monsters, and call in a flying saucer.
 * (c) {YEAR} Stepanischev Evgeny. MIT license. */
(function () {{
  'use strict';
  var SCRIPT = document.currentScript;
  if (!SCRIPT) {{
    var scripts = document.getElementsByTagName('script');
    SCRIPT = scripts[scripts.length - 1];
  }}
  var BOLKLETS_BASE = '';
  if (SCRIPT && SCRIPT.src) {{
    BOLKLETS_BASE = SCRIPT.src.replace(/\\/[^\\/]*$/, '/');
  }}

  if (!document.querySelector('link[data-bolklets-font]')) {{
    var fontLink = document.createElement('link');
    fontLink.rel = 'stylesheet';
    fontLink.href = 'https://fonts.googleapis.com/css2?family=Press+Start+2P&display=swap';
    fontLink.setAttribute('data-bolklets-font', '1');
    document.head.appendChild(fontLink);
  }}

  if (!document.querySelector('style[data-bolklets-style]')) {{
    var styleEl = document.createElement('style');
    styleEl.setAttribute('data-bolklets-style', '1');
    styleEl.textContent = `{js_string(css_text)}`;
    document.head.appendChild(styleEl);
  }}

  function ensureStage() {{
    var stage = document.getElementById('bolklets-stage');
    if (!stage) {{
      stage = document.createElement('div');
      stage.id = 'bolklets-stage';
      stage.innerHTML =
        '<canvas id="bolklets-scene" width="800" height="300"></canvas>' +
        '<div id="bolklets-bubbles"></div>' +
        '<div id="bolklets-hud"><span id="bolklets-status"></span></div>';
      document.body.appendChild(stage);
    }}
    if (!document.getElementById('bolklets-build')) {{
      var b = document.createElement('div');
      b.id = 'bolklets-build';
      b.textContent = 'Bolklets, build {BUILD_STAMP}';
      stage.appendChild(b);
    }}
    return stage;
  }}

  // Shared section map: populated by loadPayload(), read by the
  // Payload shim we hand to the runtime.  A Map keeps insertion
  // order + gives us cheap has/get/keys on names.
  var SECTIONS = new Map();
  var Payload = {{
    load:     function () {{ return Promise.resolve(); }},
    bytes:    function (n) {{ return SECTIONS.get(n); }},
    has:      function (n) {{ return SECTIONS.has(n); }},
    names:    function ()  {{ return Array.from(SECTIONS.keys()); }},
    isLoaded: function ()  {{ return SECTIONS.size > 0; }}
  }};

  async function loadPayload(url) {{
    var resp = await fetch(url);
    if (!resp.ok) throw new Error('fetch ' + url + ': ' + resp.status);
    var raw = new Uint8Array(await resp.arrayBuffer());
    var blob = new Blob([raw], {{ type: 'image/png' }});
    var bitmap = await createImageBitmap(blob, {{
      premultiplyAlpha: 'none',
      colorSpaceConversion: 'none'
    }});
    var w = bitmap.width, h = bitmap.height;
    var canvas = (typeof OffscreenCanvas !== 'undefined')
      ? new OffscreenCanvas(w, h)
      : Object.assign(document.createElement('canvas'), {{ width: w, height: h }});
    var ctx = canvas.getContext('2d', {{ willReadFrequently: true }});
    ctx.drawImage(bitmap, 0, 0);
    var rgba = ctx.getImageData(0, 0, w, h).data;
    // First byte (R channel of pixel 0) is a format flag set by the
    // encoder: 0x00 = source bytes were 1-per-pixel (grayscale path,
    // read R only), 0x01 = source bytes were 3-per-pixel (RGB pack,
    // read R+G+B in order).  We deliberately never use the alpha
    // channel — non-255 alpha would trigger premultiplication on
    // canvas read-back and corrupt the byte stream on some browsers
    // (Safari rounds 10*50/255 to 2 instead of 10, etc.).
    var fmt = rgba[0];
    var bytes;
    if (fmt === 0x01) {{
      bytes = new Uint8Array((rgba.length >>> 2) * 3);
      for (var i = 0, j = 0; j < rgba.length; i += 3, j += 4) {{
        bytes[i]     = rgba[j];
        bytes[i + 1] = rgba[j + 1];
        bytes[i + 2] = rgba[j + 2];
      }}
    }} else {{
      bytes = new Uint8Array(rgba.length >>> 2);
      for (var k = 0, l = 0; l < rgba.length; k++, l += 4) bytes[k] = rgba[l];
    }}
    // Skip the 1-byte format flag + u32 BE declared table length (bytes 1-4);
    // section table starts at byte 5.
    var p = 5;
    function vi() {{
      var r = 0, s = 0, b;
      for (;;) {{
        b = bytes[p++];
        r |= (b & 0x7f) << s;
        if ((b & 0x80) === 0) return r >>> 0;
        s += 7;
      }}
    }}
    function u32() {{
      var v = (bytes[p] << 24) | (bytes[p+1] << 16) | (bytes[p+2] << 8) | bytes[p+3];
      p += 4;
      return v >>> 0;
    }}
    var td = new TextDecoder('ascii');
    var n = vi();
    for (var s = 0; s < n; s++) {{
      var nl = vi();
      var name = td.decode(bytes.subarray(p, p + nl));
      p += nl;
      var sz = u32();
      SECTIONS.set(name, bytes.subarray(p, p + sz));
      p += sz;
    }}
  }}

  async function boot() {{
    ensureStage();
    try {{
      await loadPayload(BOLKLETS_BASE + 'bolklets_code.png?v={BUILD_STAMP}');
    }} catch (err) {{
      console.error('bolklets: failed to load payload', err);
      return;
    }}
    var jsBytes = SECTIONS.get('js');
    if (!jsBytes) {{
      console.error('bolklets: "js" section missing from payload');
      return;
    }}
    var src = new TextDecoder('utf-8').decode(jsBytes);
    // Hand Payload + BOLKLETS_BASE to the runtime via a Function
    // parameter list.  The runtime's modules pick them up through
    // lexical scope (just like the old IIFE prelude did), and nothing
    // leaks onto window.
    (new Function('Payload', 'BOLKLETS_BASE', src))(Payload, BOLKLETS_BASE);
  }}

  if (document.readyState === 'loading') {{
    document.addEventListener('DOMContentLoaded', boot);
  }} else {{
    boot();
  }}
}})();
"""
    return src, minify_js(src)


def main() -> None:
    css_text_raw = CSS_FILE.read_text(encoding="utf-8")
    css_text = minify_css(css_text_raw)

    core_raw, core_min = build_core_js()
    core_bytes = core_min.encode("utf-8")
    core_raw_size = len(core_raw.encode("utf-8"))
    core_min_size = len(core_bytes)

    bootstrap_raw, bootstrap_min = build_bootstrap_js(css_text)
    bootstrap_raw_size = len(bootstrap_raw.encode("utf-8"))
    bootstrap_min_size = len(bootstrap_min.encode("utf-8"))

    out_path = DIST / BUNDLE_NAME
    out_path.write_text(bootstrap_min, encoding="utf-8")

    sprite_sections = collect_sprite_sections()
    sprite_raw_total = sum(len(b) for _, b in sprite_sections)
    # Order matters for readability of the packed image only (parser
    # reads all sections regardless).  Put "js" first so a hex dump of
    # the image leads with the runtime, then model, then sprites.
    sections: list[tuple[str, bytes]] = [("js", core_bytes)]
    if MODEL_FILE.exists():
        model = json.loads(MODEL_FILE.read_text(encoding="utf-8"))
        model_packed = pack_model(model)
        model_bin_version = model_packed[0] if model_packed else MODEL_BIN_VERSION
        sections.append(("model", model_packed))
        # Pack per-act metadata as a compact JSON section ("act").
        # Contains only the fields the runtime needs:
        #   starts_by_act, start_weights_by_act, act_trans, act_lex
        # "chatter" is the default act (largest pool, ~5k starts) so
        # we exclude it from starts_by_act — the runtime falls back to
        # the global start pool for chatter, which is the same thing.
        # We also cap each act pool at 400 starts (sorted by weight)
        # to keep the section under ~20 KB after JSON serialisation.
        ACT_POOL_CAP = 400
        packed_starts_by_act = {}
        packed_weights_by_act = {}
        for act_name, act_starts in model.get("starts_by_act", {}).items():
            if act_name == "chatter":
                continue
            act_weights = model.get("start_weights_by_act", {}).get(act_name, [])
            pairs = sorted(zip(act_weights, act_starts), reverse=True)[:ACT_POOL_CAP]
            if pairs:
                packed_weights_by_act[act_name] = [p[0] for p in pairs]
                packed_starts_by_act[act_name]  = [p[1] for p in pairs]
        act_section = {
            "starts_by_act":        packed_starts_by_act,
            "start_weights_by_act": packed_weights_by_act,
            "act_trans":            model.get("act_trans", {}),
            "act_lex":              model.get("act_lex", {}),
        }
        act_bytes = json.dumps(act_section, separators=(",", ":")).encode("utf-8")
        sections.append(("act", act_bytes))
        json_size = MODEL_FILE.stat().st_size
        packed_size = len(model_packed)
    else:
        json_size = packed_size = 0
        model_bin_version = MODEL_BIN_VERSION
        print("warning: dialog_model.json missing; run train_dialog.py")
    sections.extend(sprite_sections)

    # Pack everything into a single image.  encode_payload_image
    # tries grayscale vs RGB packing and writes the smaller PNG under
    # the canonical filename.  The image is also written to the project
    # root so the un-bundled dev page works.
    payload_packed_size, image_size, encoder_trials = encode_payload_image(
        sections, PAYLOAD_IMAGE_FILE
    )
    shutil.copy(PAYLOAD_IMAGE_FILE, DIST / PAYLOAD_IMAGE_FILE.name)

    # Demo page: nothing but one async script tag - no separate JS files,
    # no CSS link, no sprite PNGs.  Everything else comes from the bundle.
    demo_html = f"""\
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>bolklets demo</title>
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <style>
    html, body {{ margin:0; font-family: system-ui, sans-serif; }}
    body {{ min-height: 100vh; display: flex; flex-direction: column;
           background: linear-gradient(#f8f1e6, #e6dcc9); }}
    main {{ flex: 1 0 auto; max-width: 720px; width: 100%;
           margin: 0 auto; padding: 60px 24px; box-sizing: border-box; }}
    h1 {{ font-size: 1.6rem; }}
    p {{ line-height: 1.6; color: #333; }}
    pre {{ background: rgba(0,0,0,0.05); padding: 10px 14px;
           border-radius: 4px; }}
  </style>
</head>
<body>
  <main>
    <h1>bolklets demo</h1>
    <p>This page loads a single tiny bootstrap script and nothing else:</p>
    <pre><code>&lt;script async src="{BUNDLE_NAME}"&gt;&lt;/script&gt;</code></pre>
    <p>The bootstrap is only a few KB — it injects the CSS + font +
    DOM, fetches <code>{PAYLOAD_IMAGE_FILE.name}</code>, and eval's the
    real runtime straight out of the image.  That single lossless
    grayscale PNG's pixel bytes are a section table carrying the
    minified bolklets runtime, every character sprite (as inner PNGs),
    and the packed binary Markov dialogue model (frequency-ranked
    word dictionary with high-bit word terminators + bigram
    transitions grouped by first word and delta-encoded with LEB128
    varints).  The bootstrap decodes the image with a &lt;canvas&gt;,
    slices out each section, and hands them to the runtime on page
    load.</p>
    <p>Scroll to the bottom of the page to see the pixel strip.</p>
  </main>
  <script async src="{BUNDLE_NAME}?v={BUILD_STAMP}"></script>
</body>
</html>
"""
    (DIST / "index.html").write_text(demo_html, encoding="utf-8")

    def kb(n: int) -> str:
        return f"{n / 1024:,.1f} KB"

    missing: list[str] = []
    if csscompressor is None and not ESBUILD:
        missing.append("csscompressor (pip) or esbuild (brew install esbuild)")
    if not TERSER and not ESBUILD and rjsmin is None:
        missing.append(
            "terser (npm i -g terser), esbuild (brew install esbuild), "
            "or rjsmin (pip)"
        )
    elif not TERSER and not ESBUILD:
        print(
            "note: neither terser nor esbuild found — falling back to "
            "rjsmin (whitespace-only).  `npm i -g terser` (best) or "
            "`brew install esbuild` for proper minification.",
            file=sys.stderr,
        )
    elif not TERSER:
        print(
            "note: terser not found — using esbuild.  `npm i -g terser` "
            "saves another ~1-2 KB on the packed PNG via top-level "
            "identifier mangling.",
            file=sys.stderr,
        )
    if missing:
        print(
            "note: install " + " + ".join(missing) + " for effective minification",
            file=sys.stderr,
        )

    # Bootstrap size: the PUBLIC face of the bundle — the only JS the
    # host page actually links to.  `core` is the runtime that lives
    # inside the PNG, reported separately because it contributes to
    # the image size, not to this file.
    bs_ratio = (
        (1 - bootstrap_min_size / bootstrap_raw_size) * 100
        if bootstrap_raw_size
        else 0
    )
    core_ratio = (
        (1 - core_min_size / core_raw_size) * 100 if core_raw_size else 0
    )
    print(
        f"built dist/{BUNDLE_NAME} (bootstrap):\n"
        f"  raw       {kb(bootstrap_raw_size)}\n"
        f"  minified  {kb(bootstrap_min_size)}  (-{bs_ratio:.0f}%)"
    )
    print(
        f"bolklets runtime (packed into payload as \"js\" section):\n"
        f"  raw       {kb(core_raw_size)}\n"
        f"  minified  {kb(core_min_size)}  (-{core_ratio:.0f}%)"
    )
    inputs_total = json_size + sprite_raw_total + core_min_size
    if inputs_total:
        ratio = (1 - image_size / inputs_total) * 100
        print(
            f"packed payload -> {PAYLOAD_IMAGE_FILE.name}:\n"
            f"  js        {kb(core_min_size)} minified runtime\n"
            f"  model     {kb(json_size)} json -> {kb(packed_size)} "
            f"binary v{model_bin_version} (column-store streams,\n"
            f"            pow2-quantised counts, grouped starts,\n"
            f"            grouped+delta varints, 7-bit word terms)\n"
            f"  sprites   {kb(sprite_raw_total)} across "
            f"{len(sprite_sections)} frames\n"
            f"  packed    {kb(payload_packed_size)} section table"
        )
        print(f"  encoder   tried {len(encoder_trials)} variants:")
        winner_mode = encoder_trials[0][0]
        for mode, size in encoder_trials:
            mark = "  <-- chosen" if mode == winner_mode else ""
            print(f"              PNG /{mode:<3}  {kb(size):>10}{mark}")
        print(
            f"  image     {kb(image_size)}  (-{ratio:.0f}% vs raw "
            f"sources, lossless)"
        )
    print("plus demo index.html")


if __name__ == "__main__":
    main()
