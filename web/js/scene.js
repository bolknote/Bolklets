/*
 * Pre-renders the pixel-art lawn into an off-screen canvas that the main
 * loop blits every frame.  The canvas is 800×300 and contains nothing but
 * the ground, a pond, a winding dirt path and scattered decoration --
 * everything the characters walk around on.  Sky, mountains and distant
 * forest have been removed so the scene is only the "lawn" layer.
 *
 * Activity stations are still drawn on top of the lawn every frame so
 * they can wobble/glow (cauldron bubbles, campfire flickers, UFO bobs).
 */
const Scene = (() => {
  // WIDTH/HEIGHT are filled in at Scene.init() so the scene adapts to
  // whatever CSS size the #scene canvas ends up at.  They're exposed as
  // live mutable fields on the returned Scene object so the character
  // controller can read the current bounds on every frame.
  let WIDTH = 800;
  let HEIGHT = 300;

  // Characters walk anywhere on the lawn, with a small margin at the
  // top/bottom to avoid their feet clipping the canvas edge.
  const FLOOR_TOP = 40;
  const FLOOR_BOTTOM_MARGIN = 10;
  let FLOOR_BOTTOM = HEIGHT - FLOOR_BOTTOM_MARGIN;

  // Fresh seed per page load so each reload looks a little different.
  let seed = (Math.random() * 1e9) | 0;
  function rand() {
    seed = (seed * 1664525 + 1013904223) | 0;
    return ((seed >>> 0) % 1000) / 1000;
  }
  function rr(a, b) { return a + rand() * (b - a); }
  function ri(a, b) { return Math.floor(rr(a, b + 1)); }

  // Activity stations as fractional x coordinates (0..1) so the scene
  // scales cleanly to any viewport width.  y is still in absolute pixels
  // because the lawn is always 300px tall.
  const ACTIVITY_SPEC = {
    // Knight's training dummy used to sit at xr 0.11 (~x 79 on a 720
    // canvas), which put him inside the hydra body's bite envelope
    // (lair x≈96, REACH_STRIKE 130) the instant she emerged.  Heroes
    // are free to leave their station to fight, but the moment they
    // resume training they walked back into chew distance and ate
    // a free bite for it.  Slid right to 0.20 (~x 144) so the dummy
    // is a comfortable sword-length OUTSIDE the bite cone while
    // staying visually in the left workshop area.
    // Y dropped from 200 → 120 so the dummy sits ABOVE the dirt
    // path that wobbles through y≈180 at this xr — at y=200 the
    // scarecrow's outstretched arms (y - 21 = 179) clipped right
    // through the road surface.  120 leaves a generous gap above
    // the path crest while still staying clear of the cave (cave
    // bbox bottoms out at y≈101 in this column).
    knight:   { xr: 0.20, y: 120, item: "dummy" },
    archer:   { xr: 0.92, y: 110, item: "target" },
    witch:    { xr: 0.28, y: 245, item: "cauldron" },
    firemage: { xr: 0.74, y: 255, item: "campfire" },
    viking:   { xr: 0.22, y: 265, item: "stump" },
    zombie:   { xr: 0.86, y: 220, item: "gravestone" },
    robot:    { xr: 0.52, y: 270, item: "oilcan" },
    ninja:    { xr: 0.46, y: 140, item: "chest" },
    girl:     { xr: 0.65, y: 180, item: "flowers" },
    alien:    { xr: 0.40, y: 85,  item: "ufo" },
  };

  let ACTIVITIES = {};

  // Potions live INSIDE the chest.  The chest is a small cupboard-
  // kiosk that the witch stocks from her cauldron: she brews a potion,
  // walks it over, flips the lid up, drops the bottle in, and closes
  // it.  Heroes low on HP repeat the dance in reverse: approach, open
  // the lid, take a potion, step aside, drink.
  //
  // Two kinds of potions share the chest:
  //   "heal"   — what hurt heroes drink to top off their HP.
  //   "revive" — what ANY hero (not just the casters) can carry over
  //              to a fallen ally and use to bring them back up.  The
  //              witch brews these too, just less often.
  //
  // State lives on the chest activity object (ACTIVITIES.ninja) so the
  // render code sees it directly without any extra lookup:
  //   .contents  array of kind strings ("heal" | "revive"), length
  //              0..POTION_CAP — the order matters for rendering so
  //              the slot palette stays stable while the lid is open.
  //   .openUntil timestamp (ms); lid is raised while openUntil > now
  const POTION_CAP = 3;
  const CHEST_INITIAL_STOCK = 2;

  // Campfire fuel pacing.  The fire starts with INIT_FUEL minutes on
  // the timer; while the timer has time on it, the fire emits a small
  // regen field on top of its hex (see Characters.tickStations).  Each
  // log the firemage tosses in (or that auto-feeds in from the viking's
  // chopping pile) refreshes the timer by LOG_FUEL_MS, capped at
  // MAX_FUEL_MS so a stockpile can't get banked indefinitely.
  const CAMPFIRE_INIT_FUEL_MS = 90000;
  const CAMPFIRE_LOG_FUEL_MS  = 28000;
  const CAMPFIRE_MAX_FUEL_MS  = 110000;

  // Hydra lair: a fixed cave tucked into the upper-left rocks.  The
  // static rock cluster is baked into the background; the cave mouth,
  // glowing depths and blinking eyes are drawn live so Monsters can
  // flip it between empty / lurking / active / emerging / dying
  // without rebuilding the bg canvas.
  //
  // Coordinates are tuned so the body of an emerged hydra sits ABOVE
  // the rock arch (around y = lair.y - 20) where it's clearly visible
  // against the lawn, with the necks fanning down past the arch and
  // out into the play area.  Anything that walks on top of the lair
  // is just running over rocks — the cave entrance itself is purely
  // a visual detail.
  let hydraLairState = {
    x: 96,
    y: 86,
    occupied: false,
    state: "empty",    // "empty" | "lurking" | "active" | "emerging" | "dying"
  };

  function inBounds(x, y) {
    return y > FLOOR_TOP && y < FLOOR_BOTTOM;
  }

  let bg = null;

  function init(canvasW, canvasH) {
    WIDTH = canvasW;
    HEIGHT = canvasH;
    FLOOR_BOTTOM = HEIGHT - FLOOR_BOTTOM_MARGIN;
    hydraLairState = { x: 96, y: 86, occupied: false, state: "empty" };

    // Pond geometry needs to be settled BEFORE activities are placed
    // so we can shove any station that would land in the water back
    // onto dry ground.  paintPond() (called below) just paints the
    // ellipse — the geometry itself is owned here.
    pondGeom = {
      cx: 130,
      cy: HEIGHT - 45,
      rx: 46,
      ry: 14,
      pad: 4,
    };

    // Build the activity map at the real canvas width.  We jitter each
    // station by a few pixels so repeated reloads don't line up exactly
    // and the scene feels hand-placed rather than snapped to a grid.
    // After placing, we sanity-check against the pond and shove any
    // station that would render in the water sideways onto dry land
    // (a gravestone bobbing in the pond looks ridiculous, and the AI
    // would cheerfully steer heroes into the waterline trying to
    // "use" it).
    ACTIVITIES = {};
    for (const [name, spec] of Object.entries(ACTIVITY_SPEC)) {
      let x = Math.round(spec.xr * WIDTH + rr(-18, 18));
      const y = spec.y + Math.round(rr(-6, 6));
      x = nudgeOutOfPond(x, y);
      // Also shove out of the cave area (the lair is placed at x=96,
      // so spec.xr fractions near 0 could land activity stations on
      // the rocks).
      if (isInCave(x, y, 10)) {
        x = hydraLairState.x + 50;
      }
      ACTIVITIES[name] = { x, y, item: spec.item };
    }
    // Prime the chest with a couple of starter heal potions so heroes
    // have something to grab in the first wave, before the witch has
    // had time to brew her first fresh batch.  Revive potions only
    // ever appear via the witch's brewing cycle.
    if (ACTIVITIES.ninja) {
      const start = [];
      for (let i = 0; i < CHEST_INITIAL_STOCK; i++) start.push("heal");
      ACTIVITIES.ninja.contents = start;
      ACTIVITIES.ninja.openUntil = 0;
    }
    // Per-station live state used by drawing and the AI.  Most start
    // empty: stations only "show wear" once a hero has actually used
    // them — a fresh stump has no logs piled next to it, a fresh
    // target has no stuck arrows, etc.  Campfire boots up burning so
    // the lawn isn't cold the moment the page loads.
    if (ACTIVITIES.knight)   { ACTIVITIES.knight.lastHit = 0; }
    if (ACTIVITIES.archer)   {
      ACTIVITIES.archer.arrows = 0;
      ACTIVITIES.archer.lastShot = 0;
      ACTIVITIES.archer.lastArrowDecayAt = 0;
      // Last time a fireball impact scorched the bullseye (firemage
      // training visit).  drawTarget paints fading flames + soot
      // for a short window after this; 0 = pristine target.
      ACTIVITIES.archer.firedAt = 0;
    }
    if (ACTIVITIES.viking)   { ACTIVITIES.viking.logs = 0; ACTIVITIES.viking.lastChop = 0; }
    if (ACTIVITIES.robot)    { ACTIVITIES.robot.lastOil = 0; }
    if (ACTIVITIES.zombie)   { ACTIVITIES.zombie.lastVisit = 0; }
    if (ACTIVITIES.girl)     { ACTIVITIES.girl.bloom = 0; }
    if (ACTIVITIES.firemage) {
      ACTIVITIES.firemage.fuelUntil = performance.now() + CAMPFIRE_INIT_FUEL_MS;
    }

    bg = document.createElement("canvas");
    bg.width = canvasW;
    bg.height = canvasH;
    repaintBg();

    // Fireflies depend on the canvas size; reset on every init so a
    // resize gets a fresh distribution scaled to the new dimensions.
    rerollFireflies(canvasW, canvasH);

    return { activities: ACTIVITIES, inBounds, bg };
  }

  // Bake the static background canvas (grass + path + pond + flowers
  // + cave + rocks).  Called from init() and again from the cave PNG
  // onload handler (the cave is loaded asynchronously, so the first
  // bg paint may not include it; once the image arrives we re-bake
  // so the cave appears in the next frame).
  function repaintBg() {
    if (!bg) return;
    const ctx = bg.getContext("2d");
    paintGrass(ctx);
    paintPath(ctx);
    paintPond(ctx);
    paintFlowers(ctx);
    paintHydraLairBase(ctx);
    paintRocks(ctx);
  }

  // Ambient fireflies wandering above the lawn.  Pre-rolled at init
  // time (one set sized to the canvas, never reallocated per frame)
  // so per-firefly randomness stays constant — they each have a
  // home (homeX/homeY), an orbit radius (rx/ry), an angular speed
  // and a phase offset.  Alpha is driven by a slow sin so each
  // light blinks softly on its own beat.  Heights are biased toward
  // the top half of the play area so they don't compete with the
  // sprites on the ground.
  let fireflies = [];
  function rerollFireflies(W, H) {
    const N = Math.max(6, Math.min(14, Math.round(W / 60)));
    fireflies = [];
    for (let i = 0; i < N; i++) {
      fireflies.push({
        homeX: 30 + Math.random() * (W - 60),
        homeY: 30 + Math.random() * (H * 0.55),
        rx:    18 + Math.random() * 28,
        ry:    10 + Math.random() * 14,
        as:    0.45 + Math.random() * 0.55,         // angular speed (rad/s)
        ph:    Math.random() * Math.PI * 2,
        blink: 0.6 + Math.random() * 0.6,           // blink speed (Hz-ish)
        bph:   Math.random() * Math.PI * 2,
      });
    }
  }

  function draw(ctx, now) {
    ctx.drawImage(bg, 0, 0);
    // Fireflies sit BETWEEN the static background and the sprites,
    // so they read as dust caught in the light without ever sitting
    // on top of a hero.  Drawn directly into the world ctx so they
    // pick up the screen shake along with everything else.
    if (fireflies.length === 0 && WIDTH > 0) rerollFireflies(WIDTH, HEIGHT);
    const t = (typeof now === "number") ? now : performance.now();
    const ts = t / 1000;
    for (const f of fireflies) {
      const ang = f.ph + ts * f.as;
      const fx = Math.round(f.homeX + Math.cos(ang) * f.rx);
      const fy = Math.round(f.homeY + Math.sin(ang) * f.ry);
      // Blink alpha — clamp to 0 so the lows feel like real off
      // beats (a real firefly is dark for half its cycle).
      const aRaw = 0.55 + 0.65 * Math.sin(t * 0.0035 * f.blink + f.bph);
      const a = Math.max(0, Math.min(1, aRaw));
      if (a < 0.05) continue;
      // Faint outer green-yellow glow.
      ctx.fillStyle = `rgba(180,255,140,${a * 0.35})`;
      ctx.fillRect(fx - 1, fy - 1, 3, 3);
      // Hot yellow-white core.
      ctx.fillStyle = `rgba(255,255,200,${a})`;
      ctx.fillRect(fx, fy, 1, 1);
    }
    drawHydraLairOverlay(ctx, t);
  }

  // ----- screen shake --------------------------------------------------
  // A tiny global shake the rest of the engine can request to give
  // weight to impacts (sword hits, fireball blasts, deaths, etc).  We
  // store the strongest active shake and let it decay linearly over
  // its lifetime so back-to-back small shakes don't pile into nausea.
  // `shakeOffset(now)` returns the current (dx, dy) the renderer
  // should `ctx.translate` by; `main.js` wraps the whole world draw in
  // it.  Both numbers are integers so pixel art stays crisp.
  let shakeAmp = 0;     // peak amplitude in pixels
  let shakeStart = 0;
  let shakeLife = 0;    // ms until the shake fully decays
  function shake(amp, durMs) {
    if (!(amp > 0) || !(durMs > 0)) return;
    const now = performance.now();
    const remaining = Math.max(0, shakeStart + shakeLife - now);
    const remainingAmp = shakeAmp * (shakeLife > 0 ? remaining / shakeLife : 0);
    // Use whichever is bigger so a small later shake doesn't reset a
    // big earlier one, but a stronger shake takes over immediately.
    if (amp >= remainingAmp) {
      shakeAmp = amp;
      shakeStart = now;
      shakeLife = durMs;
    }
  }
  function shakeOffset(now) {
    if (shakeAmp <= 0 || shakeLife <= 0) return { x: 0, y: 0 };
    const t = now - shakeStart;
    if (t >= shakeLife) { shakeAmp = 0; return { x: 0, y: 0 }; }
    const k = 1 - t / shakeLife;                       // linear decay
    const a = shakeAmp * k;
    // High-frequency pseudo-random offset; sin chains keep it cheap
    // and deterministic per-frame (no Math.random per pixel).
    const dx = Math.round(Math.sin(t * 0.085) * a);
    const dy = Math.round(Math.cos(t * 0.073) * a * 0.7);
    return { x: dx, y: dy };
  }

  // ----- chest potion stock -----------------------------------------

  function chestContents() {
    const c = ACTIVITIES.ninja;
    return (c && c.contents) || [];
  }

  function chestStock() {
    return chestContents().length;
  }

  // How many bottles of a specific kind are currently in the chest.
  // Used by the AI to gate kind-aware behaviours (only go drink if
  // there's a HEAL bottle waiting; only fetch a revive potion for a
  // fallen friend if a REVIVE bottle is in stock; etc.).
  function chestStockOf(kind) {
    const arr = chestContents();
    let n = 0;
    for (let i = 0; i < arr.length; i++) if (arr[i] === kind) n++;
    return n;
  }

  function chestHasRoom() {
    return chestStock() < POTION_CAP;
  }

  function isChestOpen(now) {
    const c = ACTIVITIES.ninja;
    const t = (typeof now === "number") ? now : performance.now();
    return !!(c && (c.openUntil || 0) > t);
  }

  // Keep the lid up for at least `durMs` from now.  Stacks naturally
  // when several characters take turns at the chest — we just extend
  // the existing deadline instead of fighting over it.
  function openChest(durMs) {
    const c = ACTIVITIES.ninja;
    if (!c) return;
    const target = performance.now() + durMs;
    if (!c.openUntil || c.openUntil < target) c.openUntil = target;
  }

  function closeChestNow() {
    const c = ACTIVITIES.ninja;
    if (c) c.openUntil = 0;
  }

  // Pull one potion of the requested kind out of the chest.  Returns
  // true on success, false if there wasn't one of that kind in stock.
  // We splice the FIRST matching slot so the remaining bottles keep
  // their relative draw order — pulling out the middle of the row
  // would otherwise visually re-shuffle the chest every time.
  function takePotionFromChest(kind) {
    const c = ACTIVITIES.ninja;
    if (!c || !c.contents) return false;
    const i = c.contents.indexOf(kind);
    if (i < 0) return false;
    c.contents.splice(i, 1);
    return true;
  }

  function depositPotionToChest(kind) {
    const c = ACTIVITIES.ninja;
    if (!c) return false;
    if (!c.contents) c.contents = [];
    if (c.contents.length >= POTION_CAP) return false;
    c.contents.push(kind || "heal");
    return true;
  }

  // Per-kind palette for the tiny potion sprite: cork stays the same
  // dark wood, the gold ring stays the same brass band, only the
  // liquid (top + body) and the highlight change.  Heals are red with
  // a blue meniscus (default look); revives are deep green with a
  // pale gold meniscus + a lime highlight, so they read clearly as
  // "the OTHER bottle" at chest-slot scale (3..5 px wide).
  const POTION_PALETTE = {
    heal:   { top: "#6ad0ff", body: "#e04040", glow: "#ff9090" },
    revive: { top: "#fff0a0", body: "#3cc06c", glow: "#a0ffb0" },
  };

  // Small standalone potion renderer used both for potions sitting in
  // the chest and for the bottle a character holds while carrying one.
  // `p.kind` ("heal" | "revive") picks the palette; defaults to heal
  // for backwards-compatible callers.
  function drawPotion(ctx, p) {
    const x = Math.round(p.x), y = Math.round(p.y);
    const pal = POTION_PALETTE[p.kind] || POTION_PALETTE.heal;
    ctx.fillStyle = "#222";
    ctx.fillRect(x - 2, y - 8, 4, 1);
    ctx.fillStyle = "#d0a040";
    ctx.fillRect(x - 1, y - 9, 2, 1);
    ctx.fillStyle = pal.top;
    ctx.fillRect(x - 2, y - 7, 4, 2);
    ctx.fillStyle = pal.body;
    ctx.fillRect(x - 2, y - 5, 4, 3);
    ctx.fillStyle = pal.glow;
    ctx.fillRect(x - 1, y - 4, 1, 1);
    ctx.fillStyle = "#222";
    ctx.fillRect(x - 2, y - 1, 4, 1);
  }

  // ----- ground potions ---------------------------------------------
  //
  // Bottles dropped on the lawn — currently produced when the witch is
  // killed mid-deposit (or any other carrier dies with `heldPotion`
  // set).  They sit visible on the grass with a tiny bob and get
  // claimed by wounded passers-by who walk over and drink them on the
  // spot.  No despawn timer: a dropped bottle waits indefinitely until
  // someone picks it up, so the player never sees a useful potion
  // blink and vanish on its own.
  const groundPotions = [];

  function dropPotion(x, y, kind) {
    const ny = Math.max(FLOOR_TOP + 12, Math.min(FLOOR_BOTTOM - 6, y));
    const nx = Math.max(8, Math.min(WIDTH - 8, x));
    const p = {
      x: nx, y: ny,
      kind: kind || "heal",
      bornAt: performance.now(),
      claimer: null,
      bobPhase: Math.random() * Math.PI * 2,
    };
    groundPotions.push(p);
    return p;
  }

  function tickGroundPotions(now) {
    for (let i = groundPotions.length - 1; i >= 0; i--) {
      const p = groundPotions[i];
      if (p.claimer) {
        // Release the reservation if the claimer dropped out (died,
        // exited combat, was redirected to a different errand).  This
        // is what stops a bottle from sitting there forever marked
        // "held" because someone got bumped onto a different goal
        // mid-walk.  Two errand types own a bottle on the lawn: the
        // self-drink runner ("drinking") and the ground-revive runner
        // ("potionReviving" with revivePhase "approachGround").
        const c = p.claimer;
        const stillClaiming = c && c.hp > 0 && c.targetGroundPotion === p && (
          c.combatMode === "drinking" ||
          (c.combatMode === "potionReviving" &&
           c.revivePhase === "approachGround")
        );
        if (!stillClaiming) p.claimer = null;
      }
    }
  }

  function takeGroundPotion(p) {
    const i = groundPotions.indexOf(p);
    if (i < 0) return false;
    groundPotions.splice(i, 1);
    return true;
  }

  function groundPotionExists(p) {
    return groundPotions.indexOf(p) >= 0;
  }

  function listGroundPotions() {
    return groundPotions;
  }

  function drawGroundPotion(ctx, p, now) {
    const bob = (Math.sin(now * 0.005 + p.bobPhase) > 0) ? 0 : -1;
    drawPotion(ctx, { x: p.x, y: p.y + bob, kind: p.kind });
    ctx.fillStyle = "rgba(0,0,0,0.18)";
    ctx.fillRect(Math.round(p.x) - 3, Math.round(p.y) + 1, 6, 1);
  }

  // Positions of landmark activity stations the combat code needs:
  // chest (potion depot), UFO (alien's escape pod), and the gravestone
  // that skeletons emerge from.  Expose them as tiny helpers so the
  // other modules don't have to know about the ACTIVITIES dictionary.
  function chest() { return ACTIVITIES.ninja; }
  function ufo()   { return ACTIVITIES.alien; }
  // Generic accessor used by Characters.tickStations to look up the
  // station object for any role (dummy, target, stump, etc.) without
  // every caller having to know the owner-name mapping.
  function activity(ownerName) { return ACTIVITIES[ownerName] || null; }

  // ----- campfire fuel ----------------------------------------------
  // Drop one log into the fire: extends the burn timer by LOG_FUEL_MS,
  // capped at MAX_FUEL_MS so a stockpile can't be banked indefinitely.
  // Returns true if the log was actually accepted (the fire wasn't
  // already topped up).
  function feedCampfire() {
    const c = ACTIVITIES.firemage;
    if (!c) return false;
    const now = performance.now();
    const cur = Math.max(c.fuelUntil || 0, now);
    if (cur - now >= CAMPFIRE_MAX_FUEL_MS - 1000) return false;
    c.fuelUntil = Math.min(now + CAMPFIRE_MAX_FUEL_MS,
                           cur + CAMPFIRE_LOG_FUEL_MS);
    return true;
  }
  function campfireFuelLeft() {
    const c = ACTIVITIES.firemage;
    if (!c) return 0;
    return Math.max(0, (c.fuelUntil || 0) - performance.now());
  }
  function campfireBurning() { return campfireFuelLeft() > 0; }
  // Live centre of the saucer (hull midline), accounting for the
  // lift-off and any in-flight drift.  The bob is ignored on purpose
  // — we want the beam to look steady, not wobbly.
  function ufoCenter() {
    const u = ACTIVITIES.alien;
    const lift = u.ufoBoardLift || 0;
    return {
      x: u.x + (u.flyDx || 0),
      y: u.y + (u.flyDy || 0) - 14 - lift,
    };
  }
  function grave() { return ACTIVITIES.zombie; }
  function hydraLair() { return hydraLairState; }

  // Cave "obstacle" geometry used by movement code (same interface as
  // pondGeom but for the hydra lair).  The new cave sprite is 52×43
  // px centred on (lair.x, lair.y); we expose an ellipse a hair
  // tighter than the bounding box so heroes don't dodge invisible
  // air around the rocks but still won't walk through the silhouette.
  function caveBounds() {
    const lair = hydraLairState;
    return {
      cx: lair.x,
      cy: lair.y,
      rx: 24,
      ry: 19,
      pad: 5,
    };
  }
  function isInCave(x, y, extra) {
    const g = caveBounds();
    const e = extra || 0;
    const rx = g.rx + g.pad + e;
    const ry = g.ry + g.pad + e;
    const ux = (x - g.cx) / rx;
    const uy = (y - g.cy) / ry;
    return ux * ux + uy * uy < 1;
  }
  // Steers a step around the cave, mirroring avoidPondStep with one
  // extra escape hatch: the pond is a place heroes never ARE (they
  // spawn on the lawn, wander goals exclude it, avoid-step keeps them
  // out), so its fallback of "return [x0, y0] if nothing works" is
  // safe.  The cave is different — fighters intentionally charge in
  // to attack the hydra, a stepAwayFrom at the rim can shove anyone
  // across the ellipse boundary, and corpses can settle inside.  Once
  // a hero's position is already inside the cave, the per-frame step
  // (~0.5 px at SPEED 28) is far too small for the tangent OR the
  // radial outward fallback to reach the rim, so avoid-step kept
  // returning [x0, y0] and the hero stayed frozen inside the cave
  // forever — the user-reported firemage "застрял в пещере, бьётся
  // влево-вправо" (stuck in the cave, flipping facing each tick as
  // his imminent-threat retarget swapped combat targets between
  // opposite sides of him, while the body never actually moved).
  // Let steppers who are already inside pass through freely; the
  // outward step will carry them out over the next few frames as
  // their own movement logic aims at lawn targets.  No risk of
  // unwanted ingress — the "inside" predicate only fires once we're
  // already there, so walk-ins from the rim still hit the normal
  // deflection branches below.
  function avoidCaveStep(x0, y0, x1, y1, tx, ty, mover) {
    if (isInCave(x0, y0)) {
      if (mover) mover.caveDetourDir = 0;
      return [x1, y1];
    }
    if (!isInCave(x1, y1)) {
      if (mover) mover.caveDetourDir = 0;
      return [x1, y1];
    }
    const MIN_MOVE = 0.1;
    if (Math.abs(x1 - x0) > MIN_MOVE && !isInCave(x1, y0)) {
      if (mover) mover.caveDetourDir = 0;
      return [x1, y0];
    }
    if (Math.abs(y1 - y0) > MIN_MOVE && !isInCave(x0, y1)) {
      if (mover) mover.caveDetourDir = 0;
      return [x0, y1];
    }
    const g = caveBounds();
    const stepLen = Math.hypot(x1 - x0, y1 - y0) || 1;
    const dx = x0 - g.cx;
    const dy = y0 - g.cy;
    let dir = mover ? (mover.caveDetourDir | 0) : 0;
    if (!dir) {
      const gx = (tx == null ? x1 : tx) - x0;
      const gy = (ty == null ? y1 : ty) - y0;
      const dotA = (-dy) * gx + dx * gy;
      const dotB = ( dy) * gx + (-dx) * gy;
      dir = dotA >= dotB ? 1 : -1;
      if (mover) mover.caveDetourDir = dir;
    }
    const tnx = dir === 1 ? -dy : dy;
    const tny = dir === 1 ? dx : -dx;
    const tLen = Math.hypot(tnx, tny) || 1;
    const sx = x0 + (tnx / tLen) * stepLen;
    const sy = y0 + (tny / tLen) * stepLen;
    if (!isInCave(sx, sy)) return [sx, sy];
    const rLen = Math.hypot(dx, dy) || 1;
    const ox = x0 + (dx / rLen) * stepLen;
    const oy = y0 + (dy / rLen) * stepLen;
    if (!isInCave(ox, oy)) return [ox, oy];
    return [x0, y0];
  }

  function drawItem(ctx, item, t) {
    // `item.item` names the kind of activity prop painted at the
    // station; the object itself carries any live runtime state the
    // drawer needs (UFO lift, potion counter, etc.).
    switch (item.item) {
      case "dummy": return drawDummy(ctx, item.x, item.y, t, item);
      case "target": return drawTarget(ctx, item.x, item.y, t, item);
      case "cauldron": return drawCauldron(ctx, item.x, item.y, t);
      case "campfire": return drawCampfire(ctx, item.x, item.y, t, item);
      case "stump": return drawStump(ctx, item.x, item.y, t, item);
      case "gravestone": return drawGravestone(ctx, item.x, item.y, t, item);
      case "oilcan": return drawOilcan(ctx, item.x, item.y, t, item);
      case "chest": return drawChest(ctx, item.x, item.y, t, item);
      case "flowers": return drawFlowerPatch(ctx, item.x, item.y, t, item);
      case "ufo": return drawUfo(ctx, item.x, item.y, t, item);
    }
  }

  // ---- background painting helpers --------------------------------

  function paintGrass(ctx) {
    ctx.fillStyle = "#5db85d";
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
    const shades = ["#6ec86e", "#4da14d", "#7ed67e"];
    for (let y = 0; y < HEIGHT; y += 4) {
      for (let x = 0; x < WIDTH; x += 4) {
        if (rand() < 0.14) {
          ctx.fillStyle = shades[ri(0, shades.length - 1)];
          ctx.fillRect(x, y, ri(2, 6), 2);
        }
      }
    }
    // Grass tufts — density scales with the canvas width so wider
    // scenes don't look sparse.
    ctx.fillStyle = "#2e6b2e";
    const tuftCount = Math.ceil((WIDTH * 220) / 800);
    for (let i = 0; i < tuftCount; i++) {
      const x = ri(0, WIDTH);
      const y = ri(8, HEIGHT - 6);
      ctx.fillRect(x, y, 2, 2);
      ctx.fillRect(x + 2, y - 2, 2, 2);
      ctx.fillRect(x - 2, y - 2, 2, 2);
    }
  }

  // Path geometry helper, factored so isOnPath() and paintPath() agree
  // on exactly where the dirt strip lives.  The path is painted as
  // 20×8 tiles with their top-left at (x, yOf(t)), so a point counts
  // as "on the path" when its y is within roughly 0..8 of yOf at the
  // same x.  We pad a couple of pixels on each side for the worm
  // mound to start switching to its brown palette before its centre
  // is exactly on the dirt.
  const PATH_TILE_H = 8;
  function pathYAt(x) {
    const t = x / WIDTH;
    return HEIGHT * 0.5 + Math.sin(t * Math.PI * 2) * 30 + Math.cos(t * 7) * 6;
  }
  function isOnPath(x, y) {
    const py = pathYAt(x);
    return y >= py - 2 && y <= py + PATH_TILE_H + 2;
  }

  function paintPath(ctx) {
    // Horizontal winding dirt path across the middle of the lawn.
    // Paint as densely spaced overlapping tiles so the path stays
    // continuous no matter how wide the canvas is.  Each tile is 20px
    // wide; stepping every 4px guarantees they overlap.
    const tileW = 20;
    const tileH = PATH_TILE_H;
    const stepPx = 4;
    const yOf = pathYAt;

    ctx.fillStyle = "#b48b5a";
    for (let x = -tileW; x < WIDTH + tileW; x += stepPx) {
      const y = yOf(x);
      ctx.fillRect(Math.floor(x), Math.floor(y), tileW, tileH);
    }

    // Small highlight dots along the path — count scales with width.
    ctx.fillStyle = "#d4a872";
    const dotCount = Math.ceil(WIDTH / 10);
    for (let i = 0; i < dotCount; i++) {
      const x = rand() * WIDTH;
      const y = yOf(x);
      ctx.fillRect(Math.floor(x + rr(0, 18)), Math.floor(y + rr(0, 4)), 2, 2);
    }
  }

  function paintPond(ctx) {
    // Geometry already settled by init() (so activity placement can
    // see it); this just paints it.  The pond is now framed by a
    // ring of small grey boulders ("rocky beach") with a few green
    // lily pads floating on the water — closer to a proper "level 1
    // medium lake" than the bare ellipse of water it used to be.
    if (!pondGeom) return;
    const { cx, cy, rx, ry } = pondGeom;

    // Soft mud/dirt ring just outside the water — a slightly larger
    // brown ellipse that the rocks sit on, so the pond has a visible
    // muddy shore instead of grass running right up to the water.
    ctx.fillStyle = "#6a4a2a";
    fillEllipse(ctx, cx, cy, rx + 3, ry + 2);
    ctx.fillStyle = "#8a6a3a";
    fillEllipse(ctx, cx, cy - 1, rx + 2, ry + 1);

    // Dark base water (deep colour around the rim, lighter centre is
    // painted on top).
    ctx.fillStyle = "#143a72";
    fillEllipse(ctx, cx, cy, rx, ry);
    ctx.fillStyle = "#1d4c8a";
    fillEllipse(ctx, cx, cy - 1, rx - 2, ry - 1);
    ctx.fillStyle = "#3f7ecf";
    fillEllipse(ctx, cx, cy - 2, rx - 6, ry - 3);
    ctx.fillStyle = "#5e9ee0";
    fillEllipse(ctx, cx, cy - 3, rx - 12, ry - 5);

    // Highlight ripples — three short bright strokes scattered across
    // the surface.  Slightly thinner than before so the lily pads
    // (added below) read as the dominant detail, not the ripples.
    ctx.fillStyle = "#a3c9ef";
    ctx.fillRect(cx - 18, cy - 4, 8, 1);
    ctx.fillRect(cx + 4,  cy - 2, 12, 1);
    ctx.fillRect(cx - 6,  cy + 2, 6, 1);
    ctx.fillStyle = "#dceaf8";
    ctx.fillRect(cx - 16, cy - 4, 3, 1);
    ctx.fillRect(cx + 6,  cy - 2, 3, 1);

    // Stone rim — small grey rocks scattered around the ellipse
    // boundary.  Each rock is 3-5 px wide with a mid-grey body, a
    // pale highlight on top and a dark shadow on the bottom so it
    // reads as a tiny rounded boulder.  Rocks are placed in even
    // angular steps with a deterministic per-index size jitter so
    // the rim has rhythm without looking mechanical.
    const ringSegments = 18;
    for (let i = 0; i < ringSegments; i++) {
      const ang = (i / ringSegments) * Math.PI * 2;
      const px = Math.round(cx + Math.cos(ang) * (rx - 1));
      const py = Math.round(cy + Math.sin(ang) * (ry - 1));
      const w = 4 + ((i * 53) % 3);
      const h = 3 + ((i * 29) % 2);
      const x0 = px - (w >> 1);
      const y0 = py - (h >> 1);
      ctx.fillStyle = "#3c3c44";
      ctx.fillRect(x0, y0, w, h);
      ctx.fillStyle = "#787880";
      ctx.fillRect(x0, y0, w, h - 1);
      ctx.fillStyle = "#a0a0aa";
      ctx.fillRect(x0 + 1, y0, w - 2, 1);
    }

    // Lily pads / algae clumps floating on the water — a few small
    // dark-green ovals with a brighter green centre, scattered so
    // they don't all line up on one side of the pond.
    const pads = [
      { dx: -22, dy: -2 },
      { dx: -10, dy:  2 },
      { dx:   4, dy:  1 },
      { dx:  18, dy: -1 },
      { dx:  -2, dy: -4 },
    ];
    for (const p of pads) {
      const lx = cx + p.dx;
      const ly = cy + p.dy;
      ctx.fillStyle = "#1e3412";
      ctx.fillRect(lx - 2, ly,     5, 2);
      ctx.fillRect(lx - 1, ly - 1, 3, 1);
      ctx.fillStyle = "#306028";
      ctx.fillRect(lx - 1, ly,     3, 1);
      ctx.fillStyle = "#5cb024";
      ctx.fillRect(lx,     ly,     1, 1);
    }
  }

  // Pond geometry (ellipse, in canvas pixels) used by movement code to
  // steer characters around the water.  null until init() has drawn
  // the scene at least once.
  let pondGeom = null;

  function pondBounds() { return pondGeom; }

  // Push an (x, y) point that landed inside (or right on the rim of)
  // the pond sideways onto dry land.  Used at activity-placement
  // time so a small canvas can't drop a gravestone or oilcan into
  // the water.  Adds a generous EXTRA so the prop's full sprite
  // (not just its anchor pixel) clears the rim — sprites overhang
  // their anchor by ~14 px.
  function nudgeOutOfPond(x, y) {
    if (!pondGeom) return x;
    const EXTRA = 14;
    if (!isInPond(x, y, EXTRA)) return x;
    // Pick whichever side of the pond is closer in screen space, but
    // bias to whichever side actually fits within the canvas — a
    // station whose left-shove would clip off the canvas should go
    // right instead.
    const leftX  = pondGeom.cx - pondGeom.rx - pondGeom.pad - EXTRA - 2;
    const rightX = pondGeom.cx + pondGeom.rx + pondGeom.pad + EXTRA + 2;
    const leftFits  = leftX  > 18;
    const rightFits = rightX < WIDTH - 18;
    if (leftFits && rightFits) {
      return Math.abs(x - leftX) < Math.abs(x - rightX) ? leftX : rightX;
    }
    if (leftFits)  return leftX;
    if (rightFits) return rightX;
    return x;  // pond eats the whole row, nothing we can do
  }

  // `extra` adds an additional ring of personal space around the
  // normal `pad`, used when picking fresh wander targets (we want
  // those firmly on dry land).
  function isInPond(x, y, extra) {
    if (!pondGeom) return false;
    const e = extra || 0;
    const rx = pondGeom.rx + pondGeom.pad + e;
    const ry = pondGeom.ry + pondGeom.pad + e;
    const ux = (x - pondGeom.cx) / rx;
    const uy = (y - pondGeom.cy) / ry;
    return ux * ux + uy * uy < 1;
  }

  // Steers a proposed (x0,y0) -> (x1,y1) step around the pond.
  //
  // Strategy:
  //   1. If the straight step is dry, take it (and clear any sticky
  //      detour direction on `mover`).
  //   2. Try axis-aligned slides — but only if they actually move us,
  //      otherwise a mover pressed flat against the rim (motion purely
  //      along the blocked axis) would freeze in place.
  //   3. Otherwise slide tangentially along the ellipse at full step.
  //      The cw/ccw choice is committed on the first blocked frame
  //      (by dot-producting both tangent candidates with the goal)
  //      and STORED on `mover.pondDetourDir`, so the detour direction
  //      doesn't oscillate frame-to-frame when the dot-product test
  //      ties (which is exactly what happens when the goal is roughly
  //      straight across the pond — without commitment the mover
  //      flips cw/ccw every frame and freezes against the rim).
  //   4. Last resort: push radially outward in case we drifted
  //      slightly inside the exclusion ring.
  //
  // `mover` is optional; pass the character/monster object so we can
  // park the committed direction on it.  Bats fly and skip this
  // helper entirely.
  function avoidPondStep(x0, y0, x1, y1, tx, ty, mover) {
    if (!isInPond(x1, y1)) {
      if (mover) mover.pondDetourDir = 0;
      return [x1, y1];
    }
    const MIN_MOVE = 0.1;
    if (Math.abs(x1 - x0) > MIN_MOVE && !isInPond(x1, y0)) {
      if (mover) mover.pondDetourDir = 0;
      return [x1, y0];
    }
    if (Math.abs(y1 - y0) > MIN_MOVE && !isInPond(x0, y1)) {
      if (mover) mover.pondDetourDir = 0;
      return [x0, y1];
    }
    if (!pondGeom) return [x0, y0];
    const stepLen = Math.hypot(x1 - x0, y1 - y0) || 1;
    const dx = x0 - pondGeom.cx;
    const dy = y0 - pondGeom.cy;
    let dir = mover ? (mover.pondDetourDir | 0) : 0;
    if (!dir) {
      const gx = (tx == null ? x1 : tx) - x0;
      const gy = (ty == null ? y1 : ty) - y0;
      const dotA = (-dy) * gx + dx * gy;  // cw  in screen coords
      const dotB = ( dy) * gx + (-dx) * gy; // ccw in screen coords
      dir = dotA >= dotB ? 1 : -1;
      if (mover) mover.pondDetourDir = dir;
    }
    const tnx = dir === 1 ? -dy : dy;
    const tny = dir === 1 ? dx : -dx;
    const tLen = Math.hypot(tnx, tny) || 1;
    const sx = x0 + (tnx / tLen) * stepLen;
    const sy = y0 + (tny / tLen) * stepLen;
    if (!isInPond(sx, sy)) return [sx, sy];
    const rLen = Math.hypot(dx, dy) || 1;
    const ox = x0 + (dx / rLen) * stepLen;
    const oy = y0 + (dy / rLen) * stepLen;
    if (!isInPond(ox, oy)) return [ox, oy];
    return [x0, y0];
  }

  function paintFlowers(ctx) {
    const colors = ["#ff5a7a", "#ffd14a", "#ffffff", "#c18aff"];
    const n = Math.ceil((WIDTH * 110) / 800);
    for (let i = 0; i < n; i++) {
      const x = ri(20, WIDTH - 20);
      const y = ri(20, HEIGHT - 10);
      ctx.fillStyle = colors[ri(0, colors.length - 1)];
      ctx.fillRect(x, y, 2, 2);
      ctx.fillRect(x - 2, y + 2, 2, 2);
      ctx.fillRect(x + 2, y + 2, 2, 2);
      ctx.fillStyle = "#ffd14a";
      ctx.fillRect(x, y + 2, 2, 2);
    }
  }

  function paintRocks(ctx) {
    const n = Math.ceil((WIDTH * 22) / 800);
    let placed = 0;
    let tries = 0;
    // Keep trying until we place enough rocks, but cap retries so
    // very small canvases can't loop forever if exclusions eat space.
    while (placed < n && tries < n * 6) {
      tries++;
      const x = ri(20, WIDTH - 20);
      const y = ri(20, HEIGHT - 14);
      // Random background rocks should not overlap the cave mouth /
      // arch area, otherwise they end up visually "stuck onto" the
      // cave sprite.
      const cx = x + 5;
      const cy = y + 2;
      if (isInCave(cx, cy, 8)) continue;
      // Same for the pond: keep decorative rocks on grass/shore, not
      // floating on top of water pixels.
      if (isInPond(cx, cy, 6)) continue;
      ctx.fillStyle = "#8a8a8a";
      ctx.fillRect(x, y, 10, 6);
      ctx.fillRect(x + 2, y - 2, 6, 2);
      ctx.fillStyle = "#b0b0b0";
      ctx.fillRect(x + 2, y, 4, 2);
      placed++;
    }
  }

  // The hydra cave is shipped as a pixel-perfect sprite from
  // `assets/cave.png`. The packer drops the raw
  // RGBA pixels into the `sprite/cave` section of bolklets_code.png
  // alongside the character frames; we decode them on first paint
  // into an offscreen canvas, then blit it via `ctx.drawImage`.
  let CAVE_SPRITE = null;

  // Decode a `sprite/<name>` payload section straight onto an
  // offscreen canvas.  The section payload layout matches what
  // tools/build.py writes for character frames:
  //     [u16 BE width][u16 BE height][w*h*4 bytes RGBA]
  // We keep this synchronous (putImageData onto a fresh canvas) so
  // the result is immediately usable as a drawImage source — no
  // promise plumbing leaking into the bake path.  Returns null if
  // the section is missing (the caller paints a fallback) so we
  // don't crash a build that was packed without the asset.
  function decodeStaticSprite(name) {
    if (typeof Payload === "undefined") return null;
    const bytes = Payload.bytes("sprite/" + name);
    if (!bytes || bytes.length < 4) return null;
    const w = (bytes[0] << 8) | bytes[1];
    const h = (bytes[2] << 8) | bytes[3];
    if (!w || !h || bytes.length < 4 + w * h * 4) return null;
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const cctx = c.getContext("2d");
    const pixels = new Uint8ClampedArray(bytes.buffer, bytes.byteOffset + 4, w * h * 4);
    // Copy into a freshly-owned buffer so the ImageData isn't a
    // view onto the shared payload bytes (some browsers refuse
    // putImageData on a non-detached view).
    cctx.putImageData(new ImageData(new Uint8ClampedArray(pixels), w, h), 0, 0);
    return c;
  }

  // Build (or fetch) an offscreen canvas containing a sprite painted from
  // a row-major hex-char grid: each char is parsed as a hex digit indexing
  // into `palette`; null entries are treated as transparent.
  //
  // Optional opts:
  //   • scale (integer ≥ 1) blows each source pixel up to a `scale × scale`
  //     block — used to render the cave / hydra at chunky 2-3× their
  //     source-grid size without paying per-pixel cost at draw time.
  //   • interiorColor (CSS string) fills any transparent cell that is
  //     SURROUNDED by non-transparent cells (i.e. an interior hole in
  //     the silhouette) with the given colour — used for the cave so
  //     light from the lawn doesn't show through the cave mouth, while
  //     keeping the rectangular border around the silhouette
  //     transparent so the grass is uninterrupted around the rocks.
  //     Determined via 4-connected flood fill from the canvas border.
  //   • flipH (bool) mirrors the result left-right after drawing.
  function buildPixelSprite(rows, palette, scale, opts) {
    // Backwards compat: old callers passed (rows, palette, scale).
    opts = opts || {};
    const s = (scale && scale > 1) ? Math.floor(scale) : 1;
    const h = rows.length;
    const w = rows[0].length;
    // Flood-fill from the outer border across transparent cells to
    // separate "outside the silhouette" from "inside a hole".  Cells
    // marked OUTSIDE stay transparent; cells INSIDE that are also
    // transparent get painted with `interiorColor` (if supplied).
    let outside = null;
    if (opts.interiorColor) {
      outside = new Uint8Array(w * h);
      const queue = [];
      const enq = (x, y) => {
        if (x < 0 || y < 0 || x >= w || y >= h) return;
        const k = y * w + x;
        if (outside[k]) return;
        const ch = rows[y][x];
        if (ch !== "0") return;
        outside[k] = 1;
        queue.push(x, y);
      };
      for (let x = 0; x < w; x++) { enq(x, 0); enq(x, h - 1); }
      for (let y = 0; y < h; y++) { enq(0, y); enq(w - 1, y); }
      while (queue.length) {
        const y = queue.pop();
        const x = queue.pop();
        enq(x + 1, y); enq(x - 1, y);
        enq(x, y + 1); enq(x, y - 1);
      }
    }

    const c = document.createElement("canvas");
    c.width = w * s;
    c.height = h * s;
    const ctx = c.getContext("2d");
    for (let r = 0; r < h; r++) {
      const row = rows[r];
      for (let cIdx = 0; cIdx < w; cIdx++) {
        const ch = row[cIdx];
        if (ch === "0") {
          if (outside && !outside[r * w + cIdx]) {
            ctx.fillStyle = opts.interiorColor;
            ctx.fillRect(cIdx * s, r * s, s, s);
          }
          continue;
        }
        const idx = parseInt(ch, 16);
        const color = palette[idx];
        if (!color) continue;
        ctx.fillStyle = color;
        ctx.fillRect(cIdx * s, r * s, s, s);
      }
    }
    if (opts.flipH) {
      const tmp = document.createElement("canvas");
      tmp.width = c.width;
      tmp.height = c.height;
      const tctx = tmp.getContext("2d");
      tctx.translate(c.width, 0);
      tctx.scale(-1, 1);
      tctx.drawImage(c, 0, 0);
      return tmp;
    }
    return c;
  }

  // Paint the static cave behind the hydra into the baked background.
  // The sprite ships fully-coloured (boulder + moss + dark mouth +
  // fangs + claw scratches) so the live overlay only has to draw
  // dynamic eye/glow effects when the hydra is lurking / emerging /
  // dying.
  function paintHydraLairBase(ctx) {
    const { x, y } = hydraLairState;
    if (!CAVE_SPRITE) CAVE_SPRITE = decodeStaticSprite("cave");
    if (!CAVE_SPRITE) return;
    const w = CAVE_SPRITE.width;
    const h = CAVE_SPRITE.height;
    ctx.drawImage(CAVE_SPRITE, Math.round(x - w / 2), Math.round(y - h / 2));
  }

  // The cave itself is baked into the background by paintHydraLairBase
  // (sprite blit).  This live overlay only adds the dynamic state
  // effects on top of the dark cave interior — yellow blinking eyes
  // when the hydra is lurking, an orange furnace pulse while it's
  // emerging, a low red breathing glow while active, and a cold ash
  // wash on death.  All positioned inside the sprite's cave hole
  // (~y-3 to y+9, ~x-5 to x+5).
  function drawHydraLairOverlay(ctx, now) {
    const lair = hydraLairState;
    // The cave sprite is 52×43 px and is centred on (lair.x, lair.y).
    // The dark mouth (largest dark blob in the sprite) is at sprite
    // (~24, ~26), so the mouth centre in lawn coords lands at
    // (lair.x - 2, lair.y + 5).
    const x = Math.round(lair.x) - 2;
    const y = Math.round(lair.y) + 5;
    const t = (typeof now === "number") ? now : performance.now();
    if (lair.state === "lurking" && !lair.occupied) {
      // Lurking: two single-pixel yellow eyes peering out of the
      // cave's dark mouth, ~5 px apart.
      const cycle = (t % 2500) / 2500;
      const closed = cycle < 0.05
                  || (cycle > 0.10 && cycle < 0.14);
      if (!closed) {
        ctx.fillStyle = "#ffd040";
        ctx.fillRect(x - 3, y, 1, 1);
        ctx.fillRect(x + 2, y, 1, 1);
      } else {
        ctx.fillStyle = "#1a0e08";
        ctx.fillRect(x - 3, y, 1, 1);
        ctx.fillRect(x + 2, y, 1, 1);
      }
    } else if (lair.state === "emerging") {
      const pulse = 0.35 + 0.65 * Math.abs(Math.sin(t / 130));
      ctx.fillStyle = `rgba(255,90,30,${pulse * 0.55})`;
      ctx.fillRect(x - 6, y - 4, 12, 9);
      ctx.fillStyle = `rgba(255,200,90,${pulse * 0.4})`;
      ctx.fillRect(x - 2, y - 2, 4, 5);
    } else if (lair.state === "dying") {
      ctx.fillStyle = "rgba(180,180,180,0.20)";
      ctx.fillRect(x - 6, y - 2, 12, 8);
    }
  }

  function fillCircle(ctx, cx, cy, r) {
    for (let dy = -r; dy <= r; dy += 2) {
      const dx = Math.floor(Math.sqrt(r * r - dy * dy));
      ctx.fillRect(Math.floor(cx - dx), Math.floor(cy + dy), dx * 2, 2);
    }
  }
  function fillEllipse(ctx, cx, cy, rx, ry) {
    for (let dy = -ry; dy <= ry; dy += 2) {
      const dx = Math.floor(rx * Math.sqrt(1 - (dy * dy) / (ry * ry)));
      ctx.fillRect(Math.floor(cx - dx), Math.floor(cy + dy), dx * 2, 2);
    }
  }

  // ---- sprite-based icons -----------------------------------------
  // The four icons below (cauldron, oilcan, closed chest, open chest)
  // were redrawn by hand to match generated-image1.png — black iron
  // pot with handles + 3 legs (no green brew), tan oiler with the
  // spout going UP-LEFT and the D-handle on the RIGHT, and wooden
  // chests bound by horizontal iron straps (top + bottom + a clasp)
  // instead of the corner-strap style of the previous procedural
  // versions.  Each is a buildPixelSprite grid baked once and blitted
  // every frame, with live overlays (steam/drip/potion bottles)
  // painted on top.

  const ICON_CAULDRON_PAL = [
    null,
    "#1a1a1a", "#2a2a2a", "#3a3a3a", "#5a5a5a",
    "#7a7a7a", "#9a9a9a", "#0a0a0a",
  ];
  const ICON_CAULDRON_PIX = [
    "001111111111111111111100",
    "015577777777777777775510",
    "015777777777777777777510",
    "114444444444444444444411",
    "101345333333333333322311",
    "101345333333333333322311",
    "113345333333333333322311",
    "001345333333333333322310",
    "001343333333333333322310",
    "000133333333333333323100",
    "000011333333333333311000",
    "000000111111311111100000",
    "000011100011100011100000",
    "000011100011100011100000",
  ];

  const ICON_OILCAN_PAL = [
    null,
    "#1a1a1a", "#3a3a3a", "#5a5a5a", "#7a7a7a",
    "#3c220e", "#5a371b", "#7a4520",
    "#5a4a26", "#a8915a", "#cdb887", "#e8d4a8",
  ];
  const ICON_OILCAN_PIX = [
    "0120000000000000",
    "0110000000000000",
    "0110000000000000",
    "0110000000000000",
    "0110000000000000",
    "0001100002200000",
    "0001100022220000",
    "0000011013310000",
    "0000133199910000",
    "0001999999998000",
    "0001BB9999998660",
    "0001B99999998007",
    "0001999999998006",
    "0008888888888006",
    "0001999999991006",
    "0001999999998006",
    "0001999999998006",
    "0008888888888660",
    "0002222222222000",
    "0002222222222000",
    "0022222222222200",
  ];

  const ICON_CHEST_PAL = [
    null,
    "#1a0a04", "#3c220e", "#5a371b", "#6b3f1e", "#a06a3a",
    "#2a2a2a", "#5a5a5a", "#7a7a7a", "#9a9a9a",
    "#d0a040", "#7a5a10",
  ];
  // Closed chest — 24×17.  Three vertical wood planks (seams '2'),
  // iron strap across the top of the lid, iron strap across the
  // bottom of the body, and a brass clasp at the lid/body seam.
  const ICON_CHEST_CLOSED_PIX = [
    "000188888888888888881000",
    "011888888888888888888110",
    "978888888888888888888879",
    "174444442444444424444471",
    "174444442444444424444471",
    "174444442444444424444471",
    "174444442444444424444471",
    "97777777777BA77777777779",
    "97666666666B166666666679",
    "17444444244BA44424444471",
    "174444442444444424444471",
    "174444442444444424444471",
    "174444442444444424444471",
    "174444442444444424444471",
    "174444442444444424444471",
    "177777777777777777777771",
    "918888888888888888888819",
  ];
  // Open chest — same body, lid raised at the top so the dark
  // interior void shows through.  Potion bottles are painted on
  // top live so the chest's contents update without a sprite swap.
  const ICON_CHEST_OPEN_PAL = [
    null,
    "#1a0a04", "#3c220e", "#5a371b", "#6b3f1e", "#a06a3a",
    "#2a2a2a", "#5a5a5a", "#7a7a7a", "#9a9a9a",
    "#0a0408", "#1a0e06",
  ];
  // Lid sits directly on top of the body — no air gap — so the
  // chest reads as a hinged box opened backward, not a floating
  // panel.  The lid is 4 rows tall (rows 0..3, capped by an iron
  // strap), then the body starts at row 4 with the dark interior
  // void carved into rows 5..8 and a thin wood floor at row 9.
  const ICON_CHEST_OPEN_PIX = [
    "000188888888888888881000",
    "011888888888888888888110",
    "918888888888888888888819",
    "913333333333333333333319",
    "916666666666666666666619",
    "17AAAAAAAAAAAAAAAAAAAA71",
    "17AAAAAAAAAAAAAAAAAAAA71",
    "17AAAAAAAAAAAAAAAAAAAA71",
    "17AAAAAAAAAAAAAAAAAAAA71",
    "17BBBBBBBBBBBBBBBBBBBB71",
    "174444442444444424444471",
    "174444442444444424444471",
    "174444442444444424444471",
    "174444442444444424444471",
    "174444442444444424444471",
    "174444442444444424444471",
    "177777777777777777777771",
    "918888888888888888888819",
  ];

  let ICON_CAULDRON_SPRITE = null;
  let ICON_OILCAN_SPRITE = null;
  let ICON_CHEST_CLOSED_SPRITE = null;
  let ICON_CHEST_OPEN_SPRITE = null;
  function getIconSprite(name) {
    switch (name) {
      case "cauldron":
        if (!ICON_CAULDRON_SPRITE) ICON_CAULDRON_SPRITE = buildPixelSprite(ICON_CAULDRON_PIX, ICON_CAULDRON_PAL, 1);
        return ICON_CAULDRON_SPRITE;
      case "oilcan":
        if (!ICON_OILCAN_SPRITE) ICON_OILCAN_SPRITE = buildPixelSprite(ICON_OILCAN_PIX, ICON_OILCAN_PAL, 1);
        return ICON_OILCAN_SPRITE;
      case "chestClosed":
        if (!ICON_CHEST_CLOSED_SPRITE) ICON_CHEST_CLOSED_SPRITE = buildPixelSprite(ICON_CHEST_CLOSED_PIX, ICON_CHEST_PAL, 1);
        return ICON_CHEST_CLOSED_SPRITE;
      case "chestOpen":
        if (!ICON_CHEST_OPEN_SPRITE) ICON_CHEST_OPEN_SPRITE = buildPixelSprite(ICON_CHEST_OPEN_PIX, ICON_CHEST_OPEN_PAL, 1);
        return ICON_CHEST_OPEN_SPRITE;
    }
    return null;
  }

  // ---- activity items ---------------------------------------------

  function drawDummy(ctx, x, y, t, item) {
    // Straw scarecrow on a wooden post: round straw head, T-arms with
    // straw spilling out of the cuffs, plump body, brown sash sloping
    // across the chest.  Heroes still whack the centre of the body so
    // the wobble math (item.lastHit) is unchanged.
    const since = (item && item.lastHit) ? Math.max(0, t - item.lastHit) : 9999;
    let sh = 0;
    if (since < 220) {
      const k = 1 - since / 220;
      sh = Math.round(Math.sin(since / 22) * 2 * k);
    }

    // Wooden post buried in the ground (visible below the body).
    ctx.fillStyle = "#5a371b";
    ctx.fillRect(x - 1 + sh, y - 14, 3, 14);
    ctx.fillStyle = "#3c220e";
    ctx.fillRect(x + 1 + sh, y - 14, 1, 14);

    // Straw body (puffy bundle, lighter rim on the left, dark on the
    // right so it reads as a cylinder).
    ctx.fillStyle = "#c48b30";
    ctx.fillRect(x - 5 + sh, y - 22, 10, 9);
    ctx.fillRect(x - 4 + sh, y - 23, 8, 1);
    ctx.fillRect(x - 4 + sh, y - 13, 8, 1);
    ctx.fillStyle = "#e0b25a";
    ctx.fillRect(x - 5 + sh, y - 21, 1, 7);
    ctx.fillStyle = "#8a5612";
    ctx.fillRect(x + 4 + sh, y - 21, 1, 7);
    // Straw poking out at the waist.
    ctx.fillStyle = "#a06a18";
    ctx.fillRect(x - 4 + sh, y - 13, 1, 2);
    ctx.fillRect(x + 3 + sh, y - 13, 1, 2);

    // Outstretched arms — each ends in a tuft of straw "fingers".
    ctx.fillStyle = "#c48b30";
    ctx.fillRect(x - 10 + sh, y - 21, 5, 2);
    ctx.fillRect(x + 5 + sh,  y - 21, 5, 2);
    ctx.fillStyle = "#e0b25a";
    ctx.fillRect(x - 11 + sh, y - 22, 1, 1);
    ctx.fillRect(x - 11 + sh, y - 19, 1, 1);
    ctx.fillRect(x - 12 + sh, y - 21, 1, 2);
    ctx.fillRect(x + 10 + sh, y - 22, 1, 1);
    ctx.fillRect(x + 10 + sh, y - 19, 1, 1);
    ctx.fillRect(x + 11 + sh, y - 21, 1, 2);

    // Diagonal brown sash slung from left shoulder to right hip.
    ctx.fillStyle = "#6b3f1e";
    ctx.fillRect(x - 4 + sh, y - 21, 2, 1);
    ctx.fillRect(x - 3 + sh, y - 20, 2, 1);
    ctx.fillRect(x - 2 + sh, y - 19, 2, 1);
    ctx.fillRect(x - 1 + sh, y - 18, 2, 1);
    ctx.fillRect(x      + sh, y - 17, 2, 1);
    ctx.fillRect(x + 1 + sh, y - 16, 2, 1);
    ctx.fillRect(x + 2 + sh, y - 15, 2, 1);
    ctx.fillStyle = "#3c220e";
    ctx.fillRect(x + 3 + sh, y - 14, 1, 1);

    // Round straw head sitting on the body.
    ctx.fillStyle = "#c48b30";
    ctx.fillRect(x - 3 + sh, y - 30, 6, 6);
    ctx.fillRect(x - 4 + sh, y - 29, 8, 4);
    ctx.fillStyle = "#e0b25a";
    ctx.fillRect(x - 4 + sh, y - 28, 1, 2);
    ctx.fillRect(x - 3 + sh, y - 30, 1, 1);
    ctx.fillStyle = "#8a5612";
    ctx.fillRect(x + 3 + sh, y - 28, 1, 2);
    ctx.fillRect(x + 2 + sh, y - 30, 1, 1);
    // Sad pinpoint eyes + simple stitched mouth.
    ctx.fillStyle = "#1a1a1a";
    ctx.fillRect(x - 2 + sh, y - 28, 1, 1);
    ctx.fillRect(x + 1 + sh, y - 28, 1, 1);
    ctx.fillStyle = "#5c2f12";
    ctx.fillRect(x - 1 + sh, y - 26, 2, 1);

    // Scuffs/scratches from getting beaten on regularly.
    ctx.fillStyle = "#5c2f12";
    ctx.fillRect(x - 3 + sh, y - 17, 2, 1);
    ctx.fillRect(x + 2 + sh, y - 14, 1, 1);
  }

  function drawTarget(ctx, x, y, t, item) {
    // Wooden post with a stone-grey foot the disc sits on top of.
    ctx.fillStyle = "#6b3f1e";
    ctx.fillRect(x - 2, y - 14, 4, 14);
    ctx.fillStyle = "#a06a3a";
    ctx.fillRect(x - 2, y - 14, 1, 14);
    ctx.fillStyle = "#3c220e";
    ctx.fillRect(x + 1, y - 14, 1, 14);
    ctx.fillStyle = "#5a5a5a";
    ctx.fillRect(x - 5, y - 1, 10, 1);
    ctx.fillStyle = "#3a3a3a";
    ctx.fillRect(x - 4, y,     8, 1);

    // Concentric bullseye disc — black outline, then red/white bands
    // and a black pip in the centre, like the reference target.
    ctx.fillStyle = "#1a1a1a";
    fillCircle(ctx, x, y - 24, 10);
    ctx.fillStyle = "#ffffff";
    fillCircle(ctx, x, y - 24, 9);
    ctx.fillStyle = "#d62020";
    fillCircle(ctx, x, y - 24, 7);
    ctx.fillStyle = "#ffffff";
    fillCircle(ctx, x, y - 24, 5);
    ctx.fillStyle = "#d62020";
    fillCircle(ctx, x, y - 24, 3);
    ctx.fillStyle = "#1a1a1a";
    fillCircle(ctx, x, y - 24, 1);
    // Stuck arrows from recent practice — count = item.arrows, each
    // arrow placed deterministically around the rings so the layout
    // stays stable across frames (no flicker as the count changes).
    const n = (item && item.arrows) | 0;
    for (let i = 0; i < n; i++) {
      const ang = (i * 137) % 360;          // golden-angle scatter
      const rad = 4 + (i % 3) * 2;
      const ar = (ang * Math.PI) / 180;
      const ax = x + Math.round(Math.cos(ar) * rad);
      const ay = y - 24 + Math.round(Math.sin(ar) * rad);
      const fromLeft = Math.cos(ar) < 0;
      const sx = fromLeft ? -1 : 1;
      ctx.fillStyle = "#3a2210";
      ctx.fillRect(ax, ay, 6 * sx, 1);
      ctx.fillStyle = "#c8c8c8";
      ctx.fillRect(ax + sx * 5, ay - 1, 1, 1);
      ctx.fillStyle = "#d8d040";
      ctx.fillRect(ax - sx * 1, ay - 1, 1, 2);
    }
    // Scorch + flickering flame after a firemage training fireball
    // hit — lasts SCORCH_VISIBLE_MS, with a short bright FLAME phase
    // up front and a longer dark soot tail.  The Combat layer also
    // draws an "explode" effect at impact, so this is the residual
    // burn on the prop itself.
    const fired = (item && item.firedAt) ? item.firedAt : 0;
    if (fired > 0) {
      const since = t - fired;
      if (since >= 0 && since < 900) {
        if (since < 280) {
          const phase = Math.floor(t / 80) % 2;
          ctx.fillStyle = "#ff9523";
          ctx.fillRect(x - 5, y - 27, 10, 3);
          ctx.fillStyle = "#ffd142";
          ctx.fillRect(x - 3 + phase, y - 28, 6, 3);
          ctx.fillStyle = "#ffffff";
          ctx.fillRect(x - 1, y - 26, 2, 1);
        } else if (since < 520) {
          const phase = Math.floor(t / 110) % 2;
          ctx.fillStyle = "#ff7e2e";
          ctx.fillRect(x - 3 + phase, y - 26, 4, 2);
          ctx.fillStyle = "#ffd142";
          ctx.fillRect(x - 1, y - 27 + phase, 2, 1);
        }
        ctx.fillStyle = "#2a1a0a";
        ctx.fillRect(x - 4, y - 23, 1, 1);
        ctx.fillRect(x + 2, y - 24, 1, 1);
        ctx.fillRect(x - 1, y - 22, 1, 1);
        ctx.fillRect(x + 3, y - 26, 1, 1);
      }
    }
  }

  function drawCauldron(ctx, x, y, t) {
    // Sprite-based: round black iron pot with raised lip rim, two
    // open ring handles at the shoulders and three stubby legs poking
    // out the bottom — taken pixel-faithful from generated-image1.png.
    // Sprite is 24 wide × 14 tall and anchors with its bottom row at
    // `y` and centre column at `x`.  Green brew surface, bubbles and
    // wispy yellow-green steam are painted on top so the witch's
    // brewing reads at a glance.
    const sprite = getIconSprite("cauldron");
    ctx.drawImage(sprite, Math.round(x - sprite.width / 2),
                          Math.round(y - sprite.height + 1));

    // Brew surface: draw it slightly BELOW the rim so it reads as
    // liquid inside the pot rather than green pixels sitting on the
    // lip. A darker belly plus a brighter top edge gives the little
    // 24px icon some visible depth.
    const mx = Math.round(x);
    const top = Math.round(y - sprite.height + 4);
    ctx.fillStyle = "#173e12";                     // deep shadow inside the brew
    ctx.fillRect(mx - 6, top + 1, 12, 2);
    ctx.fillStyle = "#2f7f28";                     // main green body
    ctx.fillRect(mx - 7, top, 14, 2);
    ctx.fillRect(mx - 5, top + 2, 10, 1);
    ctx.fillStyle = "#79db63";                     // bright upper meniscus
    ctx.fillRect(mx - 6, top, 12, 1);
    ctx.fillStyle = "#b9f59a";                     // a couple of hot highlights
    ctx.fillRect(mx - 4, top, 2, 1);
    ctx.fillRect(mx + 2, top, 2, 1);

    // Bubbles: 3 deterministic bobbing dots on the brew surface,
    // each with its own phase so they pop at different times.  The
    // brightest pixel reads as a fresh bubble cap, the darker one
    // beside it as its shadow on the brew.
    for (let b = 0; b < 3; b++) {
      const ph = ((t / 720) + b * 0.37) % 1;
      const bx = mx - 5 + b * 5 + Math.round(Math.sin(t / 460 + b * 1.7) * 1);
      const by = top + 1 + (ph < 0.5 ? 0 : 1);
      const alive = ph < 0.7;
      if (!alive) continue;
      ctx.fillStyle = "#bff5a0";
      ctx.fillRect(bx, by, 1, 1);
      ctx.fillStyle = "#1f5a1a";
      ctx.fillRect(bx + 1, by, 1, 1);
    }

    // Steam wisps tinted green-yellow so they read as alchemical
    // vapours rising off the brew, not generic smoke.  Three
    // phase-offset curls drift up and slightly sideways and fade
    // as they climb.
    for (let k = 0; k < 3; k++) {
      const ph = ((t / 1300) + k * 0.33) % 1;
      const sy = Math.round(y - 18 - ph * 12);
      const sx = x + Math.round(Math.sin(k * 1.6 + ph * 6.2) * 3) + (k - 1) * 3;
      const sa = (1 - ph) * 0.55;
      if (sa <= 0.04) continue;
      ctx.fillStyle = `rgba(190,220,150,${sa})`;
      ctx.fillRect(sx, sy, 2, 2);
    }
  }

  function drawCampfire(ctx, x, y, t, item) {
    // Crossed logs forming a small X-shaped wood pile.  Two short
    // tilted logs lean against each other on top of a broader base
    // log, with paler end-grain caps so each one reads as a felled
    // billet rather than just a brown blob.
    // Base log lying flat across the front.
    ctx.fillStyle = "#6b3f1e";
    ctx.fillRect(x - 11, y - 3, 22, 3);
    ctx.fillStyle = "#a06a3a";
    ctx.fillRect(x - 11, y - 3,  2, 3);   // left end-grain
    ctx.fillRect(x +  9, y - 3,  2, 3);   // right end-grain
    ctx.fillStyle = "#3c220e";
    ctx.fillRect(x - 8,  y - 1, 16, 1);   // bark shadow underside

    // Two angled logs leaning together to make the X.
    ctx.fillStyle = "#5a371b";
    ctx.fillRect(x - 10, y - 7, 7, 3);
    ctx.fillRect(x +  3, y - 7, 7, 3);
    ctx.fillStyle = "#a06a3a";
    ctx.fillRect(x - 10, y - 7, 1, 3);    // far end of left log
    ctx.fillRect(x +  9, y - 7, 1, 3);    // far end of right log
    ctx.fillStyle = "#7a4520";
    ctx.fillRect(x - 9,  y - 6, 5, 1);    // left log highlight
    ctx.fillRect(x +  4, y - 6, 5, 1);    // right log highlight
    // Fuel ratio drives flame size.  When fuel runs out the fire
    // collapses to a small cluster of orange embers — still warm-
    // looking but obviously "needs another log" — and the regen
    // field stops emitting (Characters.tickStations gates on this).
    const fuelLeft = (item && item.fuelUntil) ? Math.max(0, item.fuelUntil - t) : 0;
    const fuelMax = CAMPFIRE_MAX_FUEL_MS;
    const f = Math.min(1, fuelLeft / fuelMax);
    const phase = Math.floor(t / 120) % 2;
    if (f > 0.05) {
      // Wide red flame base sitting just on top of the wood pile.
      const bw = 10 + Math.round(f * 4);
      ctx.fillStyle = "#c41a14";
      ctx.fillRect(x - Math.floor(bw / 2), y - 8, bw, 2);
      // Outer orange flame: scales 6..12 wide, 4..8 tall with fuel.
      const ow = 6 + Math.round(f * 6);
      const oh = 4 + Math.round(f * 4);
      ctx.fillStyle = "#ff5a14";
      ctx.fillRect(x - Math.floor(ow / 2), y - 8 - oh, ow, oh);
      // Brighter orange tongue inside.
      const mw = 4 + Math.round(f * 4);
      ctx.fillStyle = "#ff9523";
      ctx.fillRect(x - Math.floor(mw / 2) + phase, y - 9 - oh, mw, oh);
      // Bright yellow inner flame.
      const iw = 3 + Math.round(f * 2);
      const ih = 3 + Math.round(f * 3);
      ctx.fillStyle = "#ffd142";
      ctx.fillRect(x - Math.floor(iw / 2) + phase, y - 9 - oh - ih + 2, iw, ih);
      // White-hot peak only when fuel is healthy.
      if (f > 0.3) {
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(x - 1, y - 11 - oh - ih - phase, 2, 2 + Math.round(f * 2));
      }
      // Rising sparks — 3 phase-offset 1-px specks that climb above
      // the flame and fade out.  Each spark wobbles on a sine so the
      // column reads as turbulent hot air, not a vertical pipe.  The
      // top of the climb sits well above the flame so they READ as
      // escaped embers and not part of the flame body.
      const flameTop = y - 9 - oh - ih;
      for (let k = 0; k < 3; k++) {
        const ph = ((t / 950) + k * 0.33) % 1;
        const sy = Math.round(flameTop - 3 - ph * 14);
        const sx = x + Math.round(Math.sin(k * 1.7 + ph * 6.2) * 3);
        const sa = (1 - ph) * 0.85;
        ctx.fillStyle = `rgba(255,${180 + Math.round(50 * (1 - ph))},80,${sa})`;
        ctx.fillRect(sx, sy, 1, 1);
      }
      // Soft smoke wisp drifting up + slightly downwind (here just
      // a constant +x shear, no real wind system).  Two stacked
      // semi-transparent grey blobs at increasing heights, fading
      // as they go — only emitted when fuel is healthy enough to
      // produce visible smoke.
      if (f > 0.25) {
        const smokeTop = flameTop - 6;
        for (let k = 0; k < 2; k++) {
          const ph = ((t / 1400) + k * 0.5) % 1;
          const sw = 3 + Math.round(ph * 3);
          const sy = Math.round(smokeTop - ph * 18);
          const sx = x + Math.round(ph * 3) - Math.round(sw / 2);
          const sa = (1 - ph) * 0.32 * f;
          ctx.fillStyle = `rgba(140,135,128,${sa})`;
          ctx.fillRect(sx, sy, sw, 2);
        }
      }
    } else {
      // Embers: a couple of glowing dots tucked into the V of the
      // crossed logs.
      ctx.fillStyle = "#c45a14";
      ctx.fillRect(x - 3, y - 5, 2, 1);
      ctx.fillRect(x + 1, y - 5, 2, 1);
      if (phase) {
        ctx.fillStyle = "#ffaf3a";
        ctx.fillRect(x - 2, y - 5, 1, 1);
        ctx.fillRect(x + 2, y - 5, 1, 1);
      }
      // Faint dying smoke wisp — even when the flames are out, the
      // logs should look like they recently burned.  Half the alpha
      // of the live-fire smoke and only one tendril.
      const ph = ((t / 1700)) % 1;
      const sa = (1 - ph) * 0.18;
      if (sa > 0.04) {
        const sy = Math.round(y - 9 - ph * 16);
        const sx = x + Math.round(ph * 2) - 2;
        ctx.fillStyle = `rgba(150,145,138,${sa})`;
        ctx.fillRect(sx, sy, 4, 2);
      }
    }
  }

  function drawStump(ctx, x, y, t, item) {
    // Exposed roots fanning out from the base of the trunk.  Drawn
    // first so the trunk overlaps and they look anchored under it.
    // Roots only stick out far on the LEFT — the right side is kept
    // tight so the chopped-log pile (drawn later) sits cleanly next
    // to the stump without crashing into root pixels.
    ctx.fillStyle = "#5a371b";
    ctx.fillRect(x - 13, y - 1, 4, 1);
    ctx.fillRect(x - 12, y - 3, 3, 2);
    ctx.fillRect(x - 9,  y - 1, 3, 1);
    ctx.fillRect(x + 9,  y - 1, 2, 1);
    ctx.fillRect(x + 8,  y - 2, 2, 1);
    ctx.fillStyle = "#3c220e";
    ctx.fillRect(x - 13, y - 1, 1, 1);
    ctx.fillRect(x + 10, y - 1, 1, 1);

    // Trunk side (bark) with vertical striations for grain texture.
    ctx.fillStyle = "#6b3f1e";
    ctx.fillRect(x - 10, y - 9, 20, 8);
    ctx.fillStyle = "#3c220e";
    ctx.fillRect(x - 8, y - 7, 1, 5);
    ctx.fillRect(x - 4, y - 8, 1, 6);
    ctx.fillRect(x + 1, y - 6, 1, 4);
    ctx.fillRect(x + 5, y - 7, 1, 5);
    // Left highlight on the bark so the trunk reads as cylindrical.
    ctx.fillStyle = "#7a4520";
    ctx.fillRect(x - 10, y - 8, 1, 6);
    ctx.fillStyle = "#3c220e";
    ctx.fillRect(x + 9,  y - 8, 1, 6);

    // Cross-cut top: paler end-grain face with concentric tree rings
    // so the stump reads as a freshly felled trunk seen from above.
    // The face is 5 px tall (was 4) so the three rings actually have
    // room to read instead of compressing into a single brown smear.
    ctx.fillStyle = "#c08a4a";
    ctx.fillRect(x - 10, y - 14, 20, 5);
    ctx.fillRect(x - 9,  y - 15, 18, 1);
    // Top edge bright highlight (front lip).
    ctx.fillStyle = "#e0a868";
    ctx.fillRect(x - 8, y - 15, 14, 1);
    ctx.fillRect(x - 10, y - 14, 1, 2);
    // Outer ring (darker brown).
    ctx.fillStyle = "#7a4520";
    ctx.fillRect(x - 8, y - 13, 16, 1);
    // Middle ring.
    ctx.fillStyle = "#8a5320";
    ctx.fillRect(x - 5, y - 11, 10, 1);
    // Inner core dot.
    ctx.fillStyle = "#5a371b";
    ctx.fillRect(x - 1, y - 10, 2, 1);
    // Chopped logs piled to the right of the stump.  Each log is a
    // small dark-bark cylinder with a paler end-grain face on top so
    // it reads as a cross-cut billet, not just a brown rectangle.
    const logs = (item && item.logs) | 0;
    for (let i = 0; i < logs; i++) {
      const lx = x + 11 + (i % 2) * 5;
      const ly = y - 2 - Math.floor(i / 2) * 4;
      ctx.fillStyle = "#5a371b";
      ctx.fillRect(lx, ly, 5, 3);
      ctx.fillStyle = "#a06a3a";
      ctx.fillRect(lx, ly, 5, 1);
      ctx.fillStyle = "#3c220e";
      ctx.fillRect(lx + 4, ly, 1, 3);
    }
    // Recent-chop flash: short bright cut mark on the top surface.
    if (item && item.lastChop && t - item.lastChop < 240) {
      ctx.fillStyle = "#f5d68a";
      ctx.fillRect(x - 4, y - 12, 8, 1);
    }
  }

  function drawGravestone(ctx, x, y, t, item) {
    // Single rounded headstone with a carved cross — taken straight
    // from generated-image1.png (one stone, not the three-plot
    // cluster).  Wisps drift up from behind and the recent-visit
    // flare still triggers off item.lastVisit.

    // Ambient + recent-visit wisps (drawn BEHIND the stone so they
    // climb past the top of the headstone).
    for (let k = 0; k < 3; k++) {
      const ph = ((t / 1900) + k * 0.33) % 1;
      const wy = Math.round(y - 22 - ph * 10);
      const wx = x + Math.round(Math.sin(k * 1.4 + ph * 6.2) * 3);
      const wa = (1 - ph) * 0.18;
      if (wa <= 0.04) continue;
      ctx.fillStyle = `rgba(140,220,120,${wa})`;
      ctx.fillRect(wx - 1, wy, 2, 2);
    }
    const since = (item && item.lastVisit) ? Math.max(0, t - item.lastVisit) : 9999;
    if (since < 600) {
      const k = 1 - since / 600;
      const wob = (Math.sin(t / 180) * 1.5) | 0;
      ctx.fillStyle = `rgba(140,220,120,${0.45 * k})`;
      ctx.fillRect(x - 5 + wob, y - 28, 2, 2);
      ctx.fillRect(x + 3 - wob, y - 30, 2, 2);
      ctx.fillRect(x - 1, y - 32, 2, 2);
    }

    // Soil strip at the foot of the headstone.
    ctx.fillStyle = "#3a2210";
    ctx.fillRect(x - 10, y - 1, 20, 1);
    ctx.fillRect(x - 8,  y - 2, 16, 1);

    // Headstone body — rectangular base with a rounded top (two
    // narrower stacked rows above) and shaded edges.
    ctx.fillStyle = "#7a7a7a";
    ctx.fillRect(x - 8, y - 22, 16, 22);
    ctx.fillRect(x - 7, y - 24, 14,  2);
    ctx.fillRect(x - 5, y - 26, 10,  2);
    ctx.fillStyle = "#5a5a5a";
    ctx.fillRect(x + 6, y - 22, 2, 22);
    ctx.fillRect(x + 5, y - 24, 2,  2);
    ctx.fillRect(x + 4, y - 26, 1,  2);
    ctx.fillStyle = "#9a9a9a";
    ctx.fillRect(x - 8, y - 22, 1, 18);
    ctx.fillRect(x - 7, y - 24, 1,  2);
    ctx.fillRect(x - 5, y - 26, 1,  2);

    // Carved cross — recessed darker channels in the stone face.
    ctx.fillStyle = "#3a3a3a";
    ctx.fillRect(x - 1, y - 21, 2, 12);
    ctx.fillRect(x - 4, y - 17, 8,  2);
    ctx.fillStyle = "#2a2a2a";
    ctx.fillRect(x,     y - 21, 1, 12);
    ctx.fillRect(x - 4, y - 16, 8,  1);

    // A couple of weathering cracks on the lower body.
    ctx.fillStyle = "#4a4a4a";
    ctx.fillRect(x + 3, y - 6, 1, 3);
    ctx.fillRect(x - 4, y - 4, 1, 2);
  }

  function drawOilcan(ctx, x, y, t, item) {
    // Sprite-based: tan pump-oiler taken pixel-faithful from
    // generated-image1.png — the curved spout sweeps UP-LEFT (not
    // up-right like the previous procedural version) and the
    // D-shaped carry handle is on the RIGHT flank of the body.  The
    // sprite is 16 wide × 21 tall; we anchor with its bottom row at
    // `y` and its centre column at `x`.  The drip from the spout
    // tip stays procedural so it plays the moment the robot oils.
    const sprite = getIconSprite("oilcan");
    const sx = Math.round(x - sprite.width / 2);
    const sy = Math.round(y - sprite.height + 1);
    ctx.drawImage(sprite, sx, sy);

    // Recent oiling: a glistening drop falling from the spout tip
    // (which in the new sprite sits at the upper-LEFT of the icon).
    if (item && item.lastOil) {
      const since = Math.max(0, t - item.lastOil);
      if (since < 600) {
        const fall = Math.min(7, since / 80);
        // Spout opening in the sprite is at column 1, row 1 → in
        // lawn coords sx + 1, sy + 1.
        const dx = sx + 1;
        const dy = sy + 1 + fall;
        ctx.fillStyle = "#ffd870";
        ctx.fillRect(dx, dy, 1, 2);
        if (since < 200) {
          ctx.fillStyle = "#fff8c0";
          ctx.fillRect(dx, sy, 1, 1);
        }
      }
    }
  }

  function drawChest(ctx, x, y, t, item) {
    // Sprite-based: two hand-pixelled chest sprites taken pixel-
    // faithful from generated-image1.png — wooden planks bound by a
    // horizontal iron strap on the lid top + a horizontal iron strap
    // on the body bottom, with a brass clasp at the lid/body seam
    // (closed) and the lid raised + dark interior carved out (open).
    // Both are 24 wide; the closed sprite is 17 tall and the open
    // sprite is 22 tall.  Both anchor with their bottom row at `y`
    // and their centre column at `x`, so the wood body sits in the
    // same physical spot regardless of state.
    const openUntil = (item && item.openUntil) || 0;
    const contents = (item && item.contents) || [];
    const open = openUntil > t;

    const sprite = getIconSprite(open ? "chestOpen" : "chestClosed");
    const sx = Math.round(x - sprite.width / 2);
    const sy = Math.round(y - sprite.height + 1);
    ctx.drawImage(sprite, sx, sy);

    if (open) {
      // Potion bottles lined up inside the open chest.  Each slot
      // reads its own palette so a row of "two heals + one revive"
      // is visually obvious — the green bottle pops out next to the
      // red ones.  Bottles sit inside the dark interior void carved
      // into the open sprite (rows 5..8 in CHEST_OPEN, with the
      // wood floor at row 9), so cap = sy + 5 and bottle base rests
      // on the floor at sy + 9.
      const slots = Math.min(contents.length, 3);
      for (let i = 0; i < slots; i++) {
        const px = x - 6 + i * 6;
        const pal = POTION_PALETTE[contents[i]] || POTION_PALETTE.heal;
        ctx.fillStyle = "#222";
        ctx.fillRect(px - 1, sy + 5, 2, 1);                 // cork
        ctx.fillStyle = pal.top;
        ctx.fillRect(px - 1, sy + 6, 2, 1);                 // shoulder
        ctx.fillStyle = pal.body;
        ctx.fillRect(px - 1, sy + 7, 2, 3);                 // body
      }
    }
  }

  function drawFlowerPatch(ctx, x, y, t, item) {
    const petals = [
      { c: "#ff5a7a", dx: 0,  dy: 0 },
      { c: "#ffd14a", dx: 6,  dy: 2 },
      { c: "#c18aff", dx: -6, dy: 2 },
      { c: "#ffffff", dx: 2,  dy: 6 },
      { c: "#ff5a7a", dx: -4, dy: 6 },
    ];
    for (const p of petals) {
      ctx.fillStyle = p.c;
      ctx.fillRect(x + p.dx, y + p.dy, 2, 2);
      ctx.fillRect(x + p.dx - 2, y + p.dy + 2, 2, 2);
      ctx.fillRect(x + p.dx + 2, y + p.dy + 2, 2, 2);
      ctx.fillStyle = "#ffd14a";
      ctx.fillRect(x + p.dx, y + p.dy + 2, 2, 2);
      ctx.fillStyle = "#3c8a3c";
      ctx.fillRect(x + p.dx + 1, y + p.dy + 4, 1, 4);
    }
    // Healing blooms tended by the girl.  Each bloom is a single
    // bright pinkish-white flower on a tall stem rising above the
    // patch — drawn as a small "+" of petals with a white centre and
    // a soft sway so it feels alive.  Pickable by any wounded hero.
    const blooms = (item && item.bloom) | 0;
    const stems = [
      { dx: -10, dy: -2 },
      { dx:  10, dy: -3 },
      { dx:   0, dy: -5 },
    ];
    for (let i = 0; i < blooms && i < stems.length; i++) {
      const s = stems[i];
      const sw = Math.round(Math.sin(t / 380 + i) * 1);
      const fx = x + s.dx + sw;
      const fy = y + s.dy;
      ctx.fillStyle = "#3c8a3c";
      ctx.fillRect(fx, fy, 1, 6);
      ctx.fillStyle = "#ff8eb4";
      ctx.fillRect(fx - 1, fy - 2, 1, 1);
      ctx.fillRect(fx + 1, fy - 2, 1, 1);
      ctx.fillRect(fx,     fy - 3, 1, 1);
      ctx.fillRect(fx,     fy - 1, 1, 1);
      ctx.fillStyle = "#fff0a0";
      ctx.fillRect(fx, fy - 2, 1, 1);
    }
  }

  function drawUfo(ctx, x, y, t, item) {
    // The alien's UFO station.  When the alien is piloting:
    //   - `ufoBoardLift` raises the saucer off the landing pad;
    //   - `flyDx` / `flyDy` push the saucer around the sky;
    //   - `piloted` draws the tiny pilot silhouette inside the dome.
    const lift = (item && item.ufoBoardLift) || 0;
    const flyDx = (item && item.flyDx) || 0;
    const flyDy = (item && item.flyDy) || 0;
    const piloted = !!(item && item.piloted);
    const bob = Math.sin(t / 400) * 2;
    // Saucer centre ("cx", "cy") — also where the beam / pilot draws.
    const cx = x + flyDx;
    const cy = y + flyDy - 14 + bob - lift;
    const groundY = y + 1;

    // Ground shadow stays anchored to the station pad, not the
    // airborne saucer, and shrinks/fades as the UFO lifts away.
    const shadowStrength = Math.max(0, 1 - lift / 40);
    const shadowW = 12 - Math.min(6, lift * 0.25);
    ctx.fillStyle = `rgba(0,0,0,${0.28 * shadowStrength})`;
    fillEllipse(ctx, x, groundY, shadowW, 2);

    // Hull
    ctx.fillStyle = "#8a8a8a";
    ctx.fillRect(cx - 14, cy, 28, 4);
    ctx.fillRect(cx - 11, cy + 4, 22, 2);
    ctx.fillStyle = "#6b6b6b";
    ctx.fillRect(cx - 14, cy + 3, 28, 1);
    // Dome
    ctx.fillStyle = "#6adfff";
    fillEllipse(ctx, cx, cy - 4, 8, 5);
    // Pilot silhouette: a tiny green head with two black eye dots
    // nested inside the dome, so the alien is obviously in there.
    if (piloted) {
      ctx.fillStyle = "#6ec84c";
      ctx.fillRect(cx - 3, cy - 5, 6, 3);
      ctx.fillRect(cx - 2, cy - 7, 4, 2);
      ctx.fillStyle = "#1a1a1a";
      ctx.fillRect(cx - 2, cy - 5, 1, 1);
      ctx.fillRect(cx + 1, cy - 5, 1, 1);
    }
    // Dome highlight
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(cx - 3, cy - 6, 2, 1);
    // Running lights
    ctx.fillStyle = (Math.floor(t / 200) % 2) ? "#ff4040" : "#ffd140";
    ctx.fillRect(cx - 10, cy + 2, 2, 2);
    ctx.fillRect(cx + 8, cy + 2, 2, 2);
    // Small thruster flicker under the saucer while in flight; no more
    // wide "glow cone" — the beam itself is the weapon.
    if (lift > 0) {
      const flick = Math.floor(t / 80) % 2;
      ctx.fillStyle = "rgba(255,240,180,0.55)";
      ctx.fillRect(cx - 4 - flick, cy + 6, 8 + flick * 2, 2);
    }

    // Battery indicator — a thin charge bar on the leading edge of
    // the hull, visible whenever there's a live charge value posted
    // on the saucer.  Empty cell stays dark grey; the fill colour
    // shifts from green (full) through amber to red (depleted) so
    // the player can see at a glance whether the saucer is about to
    // need a recharge break.
    const e   = item && item.ufoEnergy;
    const eMx = item && item.ufoEnergyMax;
    if (typeof e === "number" && typeof eMx === "number" && eMx > 0) {
      const frac = Math.max(0, Math.min(1, e / eMx));
      const barW = 14;
      const barH = 1;
      const bx   = cx - 7;
      const by   = cy - 2;
      ctx.fillStyle = "#222";
      ctx.fillRect(bx, by, barW, barH);
      let col;
      if (frac > 0.66)      col = "#5ef07a";
      else if (frac > 0.33) col = "#f0c64a";
      else                  col = "#ee5a4a";
      ctx.fillStyle = col;
      ctx.fillRect(bx, by, Math.round(barW * frac), barH);
    }
  }

  // Expose live getters so callers always see the current canvas dims
  // (init updates these when the stage size changes on each reload).
  const api = {
    init, draw, drawItem, inBounds,
    shake, shakeOffset,
    FLOOR_TOP,
    chest, ufo, ufoCenter, grave, hydraLair, activity,
    chestStock, chestStockOf, chestHasRoom, isChestOpen,
    openChest, closeChestNow,
    takePotionFromChest, depositPotionToChest,
    drawPotion,
    dropPotion, tickGroundPotions, takeGroundPotion,
    groundPotionExists, listGroundPotions, drawGroundPotion,
    feedCampfire, campfireFuelLeft, campfireBurning,
    pondBounds, isInPond, avoidPondStep, isOnPath,
    caveBounds, isInCave, avoidCaveStep,
    buildPixelSprite,
    decodeStaticSprite,
  };
  Object.defineProperty(api, "WIDTH", { get: () => WIDTH });
  Object.defineProperty(api, "HEIGHT", { get: () => HEIGHT });
  Object.defineProperty(api, "FLOOR_BOTTOM", { get: () => FLOOR_BOTTOM });
  return api;
})();
