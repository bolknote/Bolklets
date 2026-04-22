"""
Extracts the 10 character sprites from people.png, downscales them to a
chunky pixel-art grid, and generates walking animation frames.

The source image uses a black background; the artwork itself is in natural
color.  After scanning for non-black regions we split the row into ten
bounding boxes (one per character), trim each to its tight bounds, quantize
to a coarse pixel grid (so the result really looks like pixel art rather
than a smooth illustration) and then produce two walking frames.

Output:
    build/sprites/<name>_r_<frame>.png       # right-facing, frame 0|1

Only the right-facing frames are written.  The left-facing variants used
to live next to them as `_l_<frame>.png`, but they were pixel-perfect
horizontal mirrors of the `_r_` ones — produced here by a single
`transpose(FLIP_LEFT_RIGHT)`, with no manual touch-ups.  Storing both
doubled the raw RGBA bytes inside the packed `bolklets_code.png` payload
(zopfli/DEFLATE can't see a horizontal flip as a repeat), so the JS
runtime now mirrors `_r_` to `_l_` once at load time via an offscreen
canvas — see `js/sprites.js`.

Each sprite is rendered on a transparent background so it can be composited
onto the HTML canvas scene.
"""

from __future__ import annotations

import os
from pathlib import Path

import numpy as np
from PIL import Image
from scipy.ndimage import label

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "assets" / "people.png"
OUT = ROOT / "build" / "sprites"
OUT.mkdir(parents=True, exist_ok=True)

# Names line up with the left-to-right order of figures on the sheet.
NAMES = [
    "knight",
    "witch",
    "zombie",
    "archer",
    "robot",
    "firemage",
    "ninja",
    "girl",
    "viking",
    "alien",
]


def is_non_bg(px: tuple[int, int, int, int]) -> bool:
    """True if the pixel is meaningful artwork (not the black background)."""
    r, g, b, a = px
    if a == 0:
        return False
    # The background is pure black; the characters themselves contain
    # only a few pixels darker than ~25.  A small tolerance keeps stray
    # compression noise from being picked up as content.
    return (r + g + b) > 45


def extract_character_images(img: Image.Image, expected: int) -> list[Image.Image]:
    """Return one cropped RGBA image per character.

    Rather than just bounding-box cropping (which would let adjacent
    characters bleed into each other when their silhouettes overlap in
    x, as robot/firemage do here), we extract each character using its
    connected-component mask so the crop only contains that character.
    """
    arr = np.array(img)
    bright = arr[:, :, :3].astype(int).sum(axis=2)
    mask = (bright > 80).astype(np.uint8)
    labeled, num = label(mask, structure=np.ones((3, 3)))

    comps = []
    for i in range(1, num + 1):
        ys, xs = np.where(labeled == i)
        comps.append({
            "id": i,
            "ids": {i},
            "x0": int(xs.min()),
            "y0": int(ys.min()),
            "x1": int(xs.max()) + 1,
            "y1": int(ys.max()) + 1,
            "area": int(len(ys)),
        })

    big = [c for c in comps if c["area"] >= 2000]
    small = [c for c in comps if c["area"] < 2000]
    big.sort(key=lambda c: c["x0"])

    for s in small:
        sx = (s["x0"] + s["x1"]) / 2
        best = min(big, key=lambda b: abs((b["x0"] + b["x1"]) / 2 - sx))
        best["ids"].add(s["id"])
        best["x0"] = min(best["x0"], s["x0"])
        best["y0"] = min(best["y0"], s["y0"])
        best["x1"] = max(best["x1"], s["x1"])
        best["y1"] = max(best["y1"], s["y1"])

    if len(big) != expected:
        raise SystemExit(
            f"detected {len(big)} large components, expected {expected}"
        )

    outs: list[Image.Image] = []
    for c in big:
        member_mask = np.isin(labeled, list(c["ids"]))
        crop = arr.copy()
        crop[~member_mask] = 0  # transparent black for non-member pixels
        sub = crop[c["y0"]:c["y1"], c["x0"]:c["x1"]]
        outs.append(Image.fromarray(sub, "RGBA"))
    return outs


def quantize(img: Image.Image, block: int) -> Image.Image:
    """Downsample by `block` using a mode filter so chunky pixels emerge.

    Using nearest-neighbour downscale on a smoothly shaded illustration
    leaves jaggy sub-pixel detail.  We instead take the most common opaque
    colour per block, which gives a stable flat-shaded look that matches
    the existing pixel-art characters in people.png.
    """
    w, h = img.size
    nw, nh = w // block, h // block
    out = Image.new("RGBA", (nw, nh), (0, 0, 0, 0))
    src = img.load()
    dst = out.load()
    block_area = block * block
    for by in range(nh):
        for bx in range(nw):
            rs = gs = bs = 0
            opaque = 0
            # Bucket colours to find the dominant one.
            buckets: dict[tuple[int, int, int], int] = {}
            for dy in range(block):
                for dx in range(block):
                    p = src[bx * block + dx, by * block + dy]
                    if p[3] < 32:
                        continue
                    opaque += 1
                    rs += p[0]
                    gs += p[1]
                    bs += p[2]
                    # Coarse bucket so near-identical shades merge.
                    key = (p[0] & 0xF0, p[1] & 0xF0, p[2] & 0xF0)
                    buckets[key] = buckets.get(key, 0) + 1
            # Keep the block if at least 25% of its pixels are opaque.
            if opaque * 4 < block_area:
                continue
            # Use the mean of the opaque pixels (nice smooth pixel
            # colour rather than a single dominant one).
            dst[bx, by] = (rs // opaque, gs // opaque, bs // opaque, 255)
    return out


def tight_crop(img: Image.Image) -> Image.Image:
    bbox = img.getbbox()
    return img.crop(bbox) if bbox else img


def shift_region(img: Image.Image, y0: int, y1: int, x0: int, x1: int, dy: int) -> Image.Image:
    """Return a copy of img where a rectangular region is shifted by dy
    pixels vertically (positive dy = down)."""
    out = img.copy()
    src = img.load()
    dst = out.load()
    # Clear the old region (replace with transparency) then paste shifted.
    for y in range(y0, y1):
        for x in range(x0, x1):
            dst[x, y] = (0, 0, 0, 0)
    for y in range(y0, y1):
        ny = y + dy
        if not (0 <= ny < img.height):
            continue
        for x in range(x0, x1):
            p = src[x, y]
            if p[3] == 0:
                continue
            dst[x, ny] = p
    return out


def make_walk_frames(sprite: Image.Image) -> list[Image.Image]:
    """Build two walking frames.

    The idle sprite is used as frame B.  Frame A lifts one foot by a
    single pixel (the left half of the sprite's bottom row) and bobs
    the torso up by a pixel.  Alternating A and B plays as a gentle
    walk cycle; horizontally mirroring both gives the other direction.
    """
    w, h = sprite.size
    leg_top = h - 3

    a = sprite.copy()
    a = shift_region(a, 0, leg_top, 0, w, -1)  # bob torso up 1px
    a = shift_region(a, leg_top, h, 0, w // 2, -1)  # lift left foot 1px

    b = sprite.copy()
    # Frame B: subtle counter-motion - lift right foot so both feet
    # visibly move between frames without ever leaving the sprite
    # silhouette looking half-collapsed.
    b = shift_region(b, leg_top, h, w // 2, w, -1)

    return [a, b]


def pad_to_canvas(img: Image.Image, target_w: int, target_h: int) -> Image.Image:
    """Center-bottom align img onto a transparent canvas of given size."""
    canvas = Image.new("RGBA", (target_w, target_h), (0, 0, 0, 0))
    x = (target_w - img.width) // 2
    y = target_h - img.height
    canvas.paste(img, (x, y), img)
    return canvas


def extract_horse_image(img: Image.Image) -> Image.Image:
    """Crop the lone horse out of horse.png by its non-black bounding box.

    horse.png is a single AI illustration on a black background — only one
    figure to extract, so a plain bbox is enough (no connected-components
    needed like for the people sheet).  The crop is otherwise treated the
    same as a character: a transparent-background RGBA image at full source
    resolution, ready to be quantised down onto the chunky pixel grid.
    """
    arr = np.array(img)
    bright = arr[:, :, :3].astype(int).sum(axis=2)
    mask = (bright > 80)
    ys, xs = np.where(mask)
    if len(xs) == 0:
        raise SystemExit("horse.png appears to be all background")
    x0, x1 = int(xs.min()), int(xs.max()) + 1
    y0, y1 = int(ys.min()), int(ys.max()) + 1
    crop = arr[y0:y1, x0:x1].copy()
    crop[~mask[y0:y1, x0:x1]] = 0  # transparent black for non-figure pixels
    return Image.fromarray(crop, "RGBA")


def make_horse_frames(sprite: Image.Image) -> list[Image.Image]:
    """Build a 2-frame gallop cycle for the horse sprite.

    Source horse.png is right-facing, head on the right.  We synthesise
    a gallop from a single static pose by alternating which leg pair lifts:
        Frame A: hindlegs (left half of bottom row) lift 1 px
        Frame B: forelegs (right half of bottom row) lift 1 px
    Plus a small +/- 1 px bob of the head region (top third, FULL width)
    to sell the cantering motion.  We deliberately bob the WHOLE top
    band — not just the right half — because the mane on a horse runs
    down the neck from the head and crosses the sprite midline.  Cutting
    the bob at w//2 (the previous behaviour) shifted only the head-side
    half of the mane while the neck-side half stayed put, producing the
    "mane unglued from the head" artifact the user flagged.

    Naive full-width bob (just shift_region(0, head_bot)) introduced a
    NEW artifact: the bottom row of the bob region (head_bot - 1) is
    cleared by shift_region but never refilled — there is no row inside
    the region below it to copy up — leaving a 1-px transparent strip
    slicing horizontally through the silhouette.  At gallop-frame size
    that strip read as "the head and mane were chopped off the body",
    visible in the second screenshot the user sent.  We fix it by
    snapshotting row `head_bot` of the ORIGINAL sprite (the body's
    topmost row, just below the bob region) BEFORE shifting, and then
    pasting that row into the freed seam after the shift.  Net effect:
    the head bobs up 1 px, the body's top row appears doubled by 1 px
    (the back gains a single pixel of thickness), and the silhouette
    stays continuous with no transparent slit through the middle.  The
    saddle band still doesn't move, so the rider doesn't wobble.
    """
    w, h = sprite.size
    leg_top = h - 3  # bottom 3 rows treated as legs
    head_bot = max(2, h // 3)  # top third = head + mane + neck silhouette

    a = sprite.copy()
    a = shift_region(a, leg_top, h, 0, w // 2, -1)            # hindlegs up
    # Snapshot the body's topmost row from the ORIGINAL sprite first —
    # we'll need it after the shift to seal the seam at row head_bot-1.
    src_orig = sprite.load()
    seam_row = [src_orig[x, head_bot] for x in range(w)]
    a = shift_region(a, 0, head_bot, 0, w, -1)                # head + mane up
    # Fill the freshly-cleared seam at row head_bot - 1 with the body's
    # top row.  Without this the bob leaves a transparent horizontal
    # slit between the lifted head/rump and the unchanged torso.
    a_pix = a.load()
    seam_y = head_bot - 1
    if 0 <= seam_y < h:
        for x in range(w):
            p = seam_row[x]
            if p[3] != 0:
                a_pix[x, seam_y] = p

    b = sprite.copy()
    b = shift_region(b, leg_top, h, w // 2, w, -1)            # forelegs up
    # head sits 1 px lower in B (default position) — natural head-bob counter.

    return [a, b]


def main() -> None:
    img = Image.open(SRC).convert("RGBA")
    crops = extract_character_images(img, expected=len(NAMES))

    # Quantize every character onto the same pixel grid so scales match.
    # The source image is 1536x1024; the figures themselves are ~100-130
    # tall; a block size of 8 yields ~13 pixel tall sprites which is a
    # nice chunky retro size.  Use 6 for a bit more detail.
    BLOCK = 6

    processed: list[tuple[str, Image.Image]] = []
    for name, sub in zip(NAMES, crops):
        q = quantize(sub, BLOCK)
        q = tight_crop(q)
        processed.append((name, q))

    max_w = max(p.width for _, p in processed) + 2
    max_h = max(p.height for _, p in processed) + 2

    for name, sprite in processed:
        sprite = pad_to_canvas(sprite, max_w, max_h)
        frames = make_walk_frames(sprite)
        for i, f in enumerate(frames):
            f.save(OUT / f"{name}_r_{i}.png")

    print(f"wrote {len(NAMES) * 2} character frames into {OUT} ({max_w}x{max_h})")

    # ----- horse mount sprite -----
    # horse.png is a separate AI illustration (~399x295 of meaningful art).
    # We want the final horse silhouette to read as visibly bigger than a
    # hero (~30 wide) but still pixel-art chunky and shorter than a hero
    # (~18-20 tall) so the mounted hero doesn't tower off the top of the
    # screen.  BLOCK = 14 puts the horse footprint around 28x21 after a
    # tight crop, which after centre-bottom padding lands on a ~32x24
    # canvas — comfortably larger than the 26x32 hero box without
    # overpowering the scene.
    horse_src = ROOT / "assets" / "horse.png"
    if horse_src.exists():
        himg = Image.open(horse_src).convert("RGBA")
        hcrop = extract_horse_image(himg)
        hq = quantize(hcrop, 14)
        hq = tight_crop(hq)
        # Pad with a tiny margin so the gallop frames have somewhere to
        # bob into without clipping at the canvas edge.
        canvas_w = hq.width + 2
        canvas_h = hq.height + 2
        hpad = pad_to_canvas(hq, canvas_w, canvas_h)
        hframes = make_horse_frames(hpad)
        for i, f in enumerate(hframes):
            f.save(OUT / f"horse_r_{i}.png")
        print(f"wrote 2 horse frames into {OUT} ({canvas_w}x{canvas_h})")
    else:
        print("horse.png not found — skipping horse sprite extraction")


if __name__ == "__main__":
    main()
