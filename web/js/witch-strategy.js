/*
 * WitchStrategy — pure-function advisor for the witch's combat AI.
 *
 * Why this module exists
 * ----------------------
 * The witch's behaviour during a hydra fight is the single most
 * regression-prone slice of `characters.js`: she's the only hero
 * whose unique value (brewing heal/revive bottles) is destroyed by
 * her death, so even a small mis-step in the engage / retreat /
 * snipe decision wipes the run.  Every fix to those call sites used
 * to thread through `tryRangedSnipe`, `updateRetreatTarget`, and
 * `maybeEnterCombat` directly, mixing the *policy* ("she shouldn't
 * pivot toward the boss while holding a bottle") with the *side
 * effects* (`turnToFace`, `Combat.heroAttack`, `setTarget`) — making
 * the resulting choices impossible to test in isolation.
 *
 * `WitchStrategy.*` extracts the policy half:
 *   • Inputs are a plain-data `world` snapshot (no DOM, no globals,
 *     no `performance.now()` reads).
 *   • Outputs are descriptive ("hex this target", "skip", with a
 *     `reason`); the caller still owns the actual mutation.
 *
 * That makes the policy:
 *   1. Drivable from a Node CLI stand (`tools/witch-stand.js`) —
 *      we can replay 10k synthetic boards in milliseconds and see
 *      exactly which decisions changed before vs. after a tweak.
 *   2. Future-proof — the same `world` shape can grow more advisors
 *      (`adviseRetreat`, `adviseBrew`, `adviseDeliver`) without
 *      touching the runtime each time.
 *
 * Conventions for the `world` snapshot
 * ------------------------------------
 *   witch:    { x, y, range, heldPotion?: "heal"|"revive"|null,
 *               combatMode?: string, hp?: number, hpMax?: number }
 *   hydra:    { active: boolean, body?: { x, y },
 *               headRange?: number, spitR?: number,
 *               inSpitDanger?: (x,y) => boolean }   // optional override
 *   monsters: [{ x, y, kind, dying?: boolean, fleeing?: boolean,
 *                hidden?: boolean }]
 *   planTarget: monster | null   // HydraPlan.targetFor(witch), if any
 *
 * Anything not provided is treated as "absent" — so the same module
 * works for the runtime (which fills everything) and for the stand
 * (which only fills what each scenario needs).
 */
const WitchStrategy = (() => {
  // Geometry constants — kept in sync with monsters.js / characters.js.
  // Duplicated here on purpose: this module must be importable in Node
  // without the rest of the runtime, so we can't read them off
  // `Monsters.HYDRA_*` at evaluation time.  If the canonical values
  // ever drift, the stand will catch it via the smoke scenarios.
  const DEFAULT_HYDRA_HEAD_RANGE = 95;     // bite radius around body
  const BITE_PAD = 10;                     // extra padding for "bite ring"
  const DEFAULT_HYDRA_SPIT_RANGE = 280;    // outer spit radius
  const SPIT_HEADROOM = 30;                // matches HYDRA_SPIT_HEADROOM

  // Hydra-part kinds the witch should *never* lock as a primary combat
  // target via `startFighting` — those slots are reserved for the
  // melee/ranged DPS roles.  She may still take an opportunistic hex
  // at a head when she's safe to do so (see chooseHexTarget below).
  const HYDRA_PART_KINDS = new Set(["hydraBody", "hydraHead"]);

  function isHydraPart(m) {
    return !!m && HYDRA_PART_KINDS.has(m.kind);
  }

  // ----- danger predicates ------------------------------------------
  //
  // We accept either `hydra.inSpitDanger(x,y)` (runtime path: defers
  // to the canonical HydraPlan implementation, which knows about
  // pulse timing) OR fall back to the static-radius geometry used by
  // the offline simulators in tools/.  The fallback is intentionally
  // *more conservative* (always-on spit envelope) so the stand never
  // decides something is safe that the live game would flag as
  // dangerous.

  function inSpitDanger(world, x, y) {
    const h = world && world.hydra;
    if (!h || !h.active || !h.body) return false;
    if (typeof h.inSpitDanger === "function") {
      return !!h.inSpitDanger(x, y);
    }
    const spitR = (typeof h.spitR === "number") ? h.spitR
                : (DEFAULT_HYDRA_SPIT_RANGE + SPIT_HEADROOM);
    const dx = x - h.body.x, dy = y - h.body.y;
    return (dx * dx + dy * dy) <= spitR * spitR;
  }

  function inBiteDanger(world, x, y) {
    const h = world && world.hydra;
    if (!h || !h.active || !h.body) return false;
    const headR = (typeof h.headRange === "number" ? h.headRange : DEFAULT_HYDRA_HEAD_RANGE) + BITE_PAD;
    const dx = x - h.body.x, dy = y - h.body.y;
    return (dx * dx + dy * dy) <= headR * headR;
  }

  function inHydraDanger(world, x, y) {
    return inSpitDanger(world, x, y) || inBiteDanger(world, x, y);
  }

  // Straight-line segment grazes the bite ring around the hydra body.
  // Same maths as `pathCrossesHydra` in characters.js but operating
  // on the snapshot instead of live globals.
  function pathCrossesHydra(world, x1, y1, x2, y2, radius) {
    const h = world && world.hydra;
    if (!h || !h.active || !h.body) return false;
    const r = (typeof radius === "number")
      ? radius
      : (typeof h.headRange === "number" ? h.headRange : DEFAULT_HYDRA_HEAD_RANGE) + BITE_PAD;
    const cx = h.body.x, cy = h.body.y;
    const dx = x2 - x1, dy = y2 - y1;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return inBiteDanger(world, x1, y1);
    let t = ((cx - x1) * dx + (cy - y1) * dy) / len2;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    const px = x1 + t * dx, py = y1 + t * dy;
    const ex = px - cx, ey = py - cy;
    return (ex * ex + ey * ey) <= r * r;
  }

  // ----- monster scoring helpers ------------------------------------

  function eligibleMonster(m) {
    if (!m) return false;
    if (m.dying || m.fleeing || m.hidden) return false;
    return true;
  }

  function dist(ax, ay, bx, by) {
    const dx = ax - bx, dy = ay - by;
    return Math.sqrt(dx * dx + dy * dy);
  }

  // ----- chooseHexTarget --------------------------------------------
  //
  // The witch's `tryRangedSnipe` used to:
  //   • prefer HydraPlan's per-role target if in range (smasher → body),
  //   • else snap to the nearest monster in range,
  //   • turn-to-face + fire.
  //
  // The "shoot whoever is in range" tail-end is what made her look
  // like she was *fighting* the hydra: a head wandering into her
  // 130-px hex range produced a turn-and-flash on the boss side of
  // the screen.  My previous attempt to fix that flat-out forbade
  // any hex on a hydra part — but that also killed her only ranged
  // self-defence (`startFighting` on the boss is already vetoed for
  // her, so without the opportunistic hex she had literally nothing
  // to answer with when a head poked her at 80–100 px).
  //
  // The advisor strikes the middle:
  //   1. Plan target (if any) wins, even if it's a hydra part —
  //      that's a deliberate team decision, not opportunism.
  //   2. Otherwise pick the nearest in-range monster.
  //   3. If that nearest is a hydra part:
  //        a. and the witch is currently inside the spit envelope →
  //           refuse to fire (the pivot stun is a death sentence
  //           in spit; reposition first), OR
  //        b. and the witch is carrying a bottle → refuse (don't
  //           waste the brew by adding a turn-and-flash that delays
  //           her deposit / delivery), OR
  //        c. else: try to substitute the closest non-hydra monster
  //           in range.  If one exists, use it.  If not, hex the
  //           hydra part — better a small chip than standing still
  //           while a head winds up a bite.
  //
  // Returns: { target: monster|null, reason: string }.
  function chooseHexTarget(world) {
    const w = world && world.witch;
    if (!w) return { target: null, reason: "no witch" };
    const range = w.range || 130;

    let pick = null;
    let pickReason = "";

    const planT = world.planTarget;
    if (planT && eligibleMonster(planT) &&
        dist(planT.x, planT.y, w.x, w.y) <= range) {
      pick = planT;
      pickReason = "plan-target";
    }

    const monsters = (world.monsters || []).filter(eligibleMonster);

    if (!pick) {
      let bestD = range;
      for (const m of monsters) {
        const d = dist(m.x, m.y, w.x, w.y);
        if (d < bestD) { bestD = d; pick = m; }
      }
      pickReason = pick ? "nearest-in-range" : "none-in-range";
    }

    if (!pick) return { target: null, reason: pickReason };

    if (isHydraPart(pick) && pickReason !== "plan-target") {
      const witchInSpit = inSpitDanger(world, w.x, w.y);
      if (witchInSpit) {
        return { target: null, reason: "self-in-spit-skip-hex" };
      }
      if (w.heldPotion) {
        return { target: null, reason: "courier-skip-hex" };
      }
      let alt = null, altD = range;
      for (const m of monsters) {
        if (isHydraPart(m)) continue;
        const d = dist(m.x, m.y, w.x, w.y);
        if (d < altD) { altD = d; alt = m; }
      }
      if (alt) return { target: alt, reason: "substitute-non-hydra" };
      return { target: pick, reason: "hex-hydra-no-alt" };
    }

    return { target: pick, reason: pickReason };
  }

  // ----- monster-list helpers (pure ports of monsters.js) -----------
  //
  // These mirror `Monsters.anyThreat / threatVector / anyOnPath /
  // distToFirstOnPath / nearestThreatDist`, but operate on the
  // `world.monsters` snapshot instead of a live global list.  We keep
  // the same names and return shapes so a port is just s/Monsters./
  // localFn(world,/.  The pre-filter (`!dying && !fleeing && !hidden`)
  // matches what the runtime does before passing the list in.

  function eligibleThreat(m) { return eligibleMonster(m); }

  function anyThreat(world, x, y, radius) {
    for (const m of world.monsters || []) {
      if (!eligibleThreat(m)) continue;
      const dx = m.x - x, dy = m.y - y;
      if (dx * dx + dy * dy < radius * radius) return true;
    }
    return false;
  }

  function nearestThreatDist(world, x, y, radius) {
    let best = radius;
    for (const m of world.monsters || []) {
      if (!eligibleThreat(m)) continue;
      const d = dist(m.x, m.y, x, y);
      if (d < best) best = d;
    }
    return best;
  }

  function nearestMonster(world, x, y, radius) {
    let best = null, bestD = (typeof radius === "number") ? radius : Infinity;
    for (const m of world.monsters || []) {
      if (!eligibleThreat(m)) continue;
      const d = dist(m.x, m.y, x, y);
      if (d < bestD) { bestD = d; best = m; }
    }
    return best;
  }

  // Aggregated "away from threats" repulsion vector.  See
  // monsters.js.threatVector for the long version of why we need 1/d²
  // weighting (otherwise two flanking slimes cancel into a degenerate
  // zero vector and the hero stands still in the pinch).
  function threatVector(world, x, y, radius) {
    let sx = 0, sy = 0, n = 0, closest = Infinity;
    const SOFT2 = 18 * 18;
    for (const m of world.monsters || []) {
      if (!eligibleThreat(m)) continue;
      const dxm = x - m.x, dym = y - m.y;
      const d = Math.hypot(dxm, dym);
      if (d >= radius) continue;
      n++;
      if (d < closest) closest = d;
      const w = 1 / (d * d + SOFT2);
      const inv = d > 0 ? 1 / d : 0;
      sx += dxm * inv * w;
      sy += dym * inv * w;
    }
    if (n === 0) return { count: 0, dx: 0, dy: 0, maxClose: Infinity };
    const len = Math.hypot(sx, sy);
    if (len <= 1e-6) return { count: n, dx: 0, dy: 0, maxClose: closest };
    return { count: n, dx: sx / len, dy: sy / len, maxClose: closest };
  }

  function anyOnPath(world, x1, y1, x2, y2, clearance) {
    const dx = x2 - x1, dy = y2 - y1;
    const segLen2 = dx * dx + dy * dy;
    const c2 = clearance * clearance;
    for (const m of world.monsters || []) {
      if (!eligibleThreat(m)) continue;
      const px = m.x - x1, py = m.y - y1;
      let t = segLen2 > 0 ? (px * dx + py * dy) / segLen2 : 0;
      if (t < 0) t = 0; else if (t > 1) t = 1;
      const cx = x1 + t * dx - m.x;
      const cy = y1 + t * dy - m.y;
      if (cx * cx + cy * cy < c2) return true;
    }
    return false;
  }

  function distToFirstOnPath(world, x1, y1, x2, y2, clearance) {
    const dx = x2 - x1, dy = y2 - y1;
    const segLen2 = dx * dx + dy * dy;
    if (segLen2 <= 0) return Infinity;
    const c2 = clearance * clearance;
    let bestT = Infinity;
    for (const m of world.monsters || []) {
      if (!eligibleThreat(m)) continue;
      const px = m.x - x1, py = m.y - y1;
      let t = (px * dx + py * dy) / segLen2;
      if (t < 0) continue;
      if (t > 1) t = 1;
      const cx = x1 + t * dx - m.x;
      const cy = y1 + t * dy - m.y;
      if (cx * cx + cy * cy < c2 && t < bestT) bestT = t;
    }
    if (bestT === Infinity) return Infinity;
    return bestT * Math.sqrt(segLen2);
  }

  // ----- bestEscapeDirection ----------------------------------------
  //
  // 16-ray angular sweep, scored by corridor cleanliness +
  // endpoint-safety penalties.  Identical scoring to the runtime
  // version in characters.js (so the stand and the live game agree
  // on which ray wins) — port only differs in that it reads
  // `world.scene` for clamps and passes through the snapshot's
  // monster list to the helpers above.
  //
  // Returns `null` if no candidate direction exists (e.g. every ray
  // lands in pond and we couldn't even score one).  Otherwise:
  //   { x, y, score, dx, dy, first }
  function bestEscapeDirection(world, x, y, step) {
    const scene = world.scene || {};
    const minY = (scene.floorTop || 40) + 14;
    const maxY = (scene.floorBottom || 280) - 14;
    const minX = 20, maxX = (scene.width || 800) - 20;
    const N = 16;
    const hydraOn = !!(world.hydra && world.hydra.active && world.hydra.body);
    const headBiteR = ((world.hydra && world.hydra.headRange) || DEFAULT_HYDRA_HEAD_RANGE) + BITE_PAD;
    const FLEE_PATH_CLEARANCE = 45;
    let best = null, bestScore = -Infinity;
    for (let i = 0; i < N; i++) {
      const ang = (i / N) * Math.PI * 2;
      const dx = Math.cos(ang), dy = Math.sin(ang);
      const rawEx = x + dx * step;
      const rawEy = y + dy * step;
      const ex = Math.max(minX, Math.min(maxX, rawEx));
      const ey = Math.max(minY, Math.min(maxY, rawEy));
      if (typeof scene.isInPond === "function" && scene.isInPond(ex, ey, 8)) continue;
      let first = distToFirstOnPath(world, x, y, ex, ey, FLEE_PATH_CLEARANCE);
      if (hydraOn) {
        const body = world.hydra.body;
        const dxC = ex - x, dyC = ey - y;
        const seg2 = dxC * dxC + dyC * dyC;
        if (seg2 > 0) {
          let t = ((body.x - x) * dxC + (body.y - y) * dyC) / seg2;
          if (t < 0) t = 0; else if (t > 1) t = 1;
          const px = x + t * dxC, py = y + t * dyC;
          if (Math.hypot(px - body.x, py - body.y) < headBiteR) {
            const distHydra = t * Math.sqrt(seg2);
            if (distHydra < first) first = distHydra;
          }
        }
      }
      let s = (first === Infinity) ? step + 140 : Math.min(first, step + 140);
      if (anyThreat(world, ex, ey, 36)) s -= 160;
      if (hydraOn && inSpitDanger(world, ex, ey)) s -= 120;
      if (hydraOn && inBiteDanger(world, ex, ey)) s -= 300;
      const nearestEnd = nearestThreatDist(world, ex, ey, 200);
      s += Math.min(nearestEnd, 200) * 0.4;
      const clampPx = Math.hypot(ex - rawEx, ey - rawEy);
      s -= clampPx * 0.5;
      if (s > bestScore) {
        bestScore = s;
        best = { x: ex, y: ey, score: s, dx, dy, first };
      }
    }
    return best;
  }

  // ----- chooseRetreatGoal ------------------------------------------
  //
  // Pure port of `updateRetreatTarget` (characters.js) restricted to
  // the witch's branch — it keeps the witch-specific hydra veto and
  // drops the alien/girl haven heuristics that aren't relevant to her.
  //
  // World inputs (in addition to the standard `witch` / `monsters` /
  // `hydra` blocks):
  //   havens.healer   — { x, y } of the healer if she's safe to use,
  //                     else null/undefined.  Mirrors `findSafeHealer`.
  //   havens.chest    — { x, y, healStock?: number } chest position +
  //                     current heal-bottle count.  Used as a haven
  //                     when `healStock > 0` (or `witchDeliveringHeal`
  //                     in the runtime — caller decides).
  //   scene           — { width, height, floorTop, floorBottom,
  //                       isInPond?: (x,y,pad)=>bool }
  //   tunables (optional, defaults baked in):
  //     retreatStep, multiThreatR, safeHavenBlend, pinHoldMs
  //
  //   prevDecision (optional): { reason, committedUntil, tx, ty }
  //     passed back by the caller on each tick so a sticky outcome
  //     (currently only "hydra-pinned") survives its commitment
  //     window without re-evaluating every ~400 ms.
  //   now (optional ms): required when prevDecision is supplied and
  //     when `tunables.pinHoldMs` is set — defaults to 0 so a
  //     caller that doesn't care about hysteresis (smoke suite,
  //     classic runtime path) gets the original stateless policy.
  //
  // Output:
  //   { tx, ty, reason, committedUntil }
  //
  // `reason` is a short label so the stand can group decisions in
  // its histogram ("haven-blend", "escape-sweep", "hydra-pinned",
  // "no-threat-rest", …).  `committedUntil` is only populated for
  // sticky outcomes; treat it as monotonic-advance "don't touch
  // before this timestamp".
  function chooseRetreatGoal(world) {
    const w = world && world.witch;
    if (!w) return { tx: 0, ty: 0, reason: "no-witch" };

    const tun = world.tunables || {};
    const RETREAT_STEP = tun.retreatStep || 120;
    const MULTI_THREAT_R = tun.multiThreatR || 220;
    const SAFE_HAVEN_BLEND = (typeof tun.safeHavenBlend === "number")
      ? tun.safeHavenBlend : 0.6;
    const PIN_HOLD_MS = tun.pinHoldMs || 0;

    // Hysteresis gate: only "hydra-pinned" is sticky.  Every other
    // outcome recomputes each call — they're cheap and we want them
    // responsive to threat-vector changes.  The pin is sticky
    // because the sandwich branch fired specifically when the
    // sweep found NO safe ray; re-polling every 400 ms on that
    // same degenerate board just makes her jitter a pixel each way
    // as the body drifts, instead of committing to "stand still
    // until something changes meaningfully".
    const now = typeof world.now === "number" ? world.now : 0;
    const prev = world.prevDecision;
    if (PIN_HOLD_MS > 0 && prev && prev.reason === "hydra-pinned" &&
        typeof prev.committedUntil === "number" &&
        prev.committedUntil > now) {
      return {
        tx: w.x, ty: w.y,
        reason: "hydra-pinned",
        committedUntil: prev.committedUntil,
      };
    }

    const scene = world.scene || {};
    const minX = 20, maxX = (scene.width || 800) - 20;
    const minY = (scene.floorTop || 40) + 10;
    const maxY = (scene.floorBottom || 280) - 10;

    // 1. Multi-threat away vector (1/d² aggregated repulsion).
    const tv = threatVector(world, w.x, w.y, MULTI_THREAT_R);
    let awayX = w.x, awayY = w.y;
    let m = null;
    let reason = "rest";
    if (tv.count > 0 && (tv.dx !== 0 || tv.dy !== 0)) {
      const yMul = (tv.count >= 2) ? 0.45 : 0.3;
      awayX = w.x + tv.dx * RETREAT_STEP;
      awayY = w.y + tv.dy * RETREAT_STEP * yMul;
      m = nearestMonster(world, w.x, w.y, MULTI_THREAT_R);
      reason = "away-vector";
    } else {
      m = nearestMonster(world, w.x, w.y, 9999);
      if (m) {
        const dx = w.x - m.x, dy = w.y - m.y;
        const d = Math.hypot(dx, dy) || 1;
        awayX = w.x + (dx / d) * RETREAT_STEP;
        awayY = w.y + (dy / d) * RETREAT_STEP * 0.3;
        reason = "away-from-distant";
      } else if (w.activity) {
        awayX = w.activity.x;
        awayY = w.activity.y;
        reason = "no-threat-rest";
      }
    }

    // 2. Haven blend.
    const havens = world.havens || {};
    let havenX = null, havenY = null;
    if (havens.healer) {
      havenX = havens.healer.x; havenY = havens.healer.y;
    } else if (havens.chest && (havens.chest.healStock || 0) > 0) {
      havenX = havens.chest.x; havenY = havens.chest.y;
    }

    let tx = awayX, ty = awayY;
    if (havenX !== null) {
      let havenUsable = true;
      if (m) {
        const havenSign = Math.sign(havenX - w.x);
        const threatSign = Math.sign(m.x - w.x);
        const havenDist = Math.hypot(havenX - w.x, havenY - w.y);
        const threatDist = Math.hypot(m.x - w.x, m.y - w.y);
        const sameSide = havenSign !== 0 && havenSign === threatSign;
        const havenPast = havenDist > threatDist - 4;
        if (sameSide && havenPast) {
          if (anyOnPath(world, w.x, w.y, havenX, havenY, 30)) {
            havenUsable = false;
          }
        }
      }
      if (havenUsable) {
        tx = havenX * SAFE_HAVEN_BLEND + awayX * (1 - SAFE_HAVEN_BLEND);
        ty = havenY * SAFE_HAVEN_BLEND + awayY * (1 - SAFE_HAVEN_BLEND);
        reason = "haven-blend";
      }
    }

    tx = Math.max(minX, Math.min(maxX, tx));
    ty = Math.max(minY, Math.min(maxY, ty));

    // 3. Sandwich rescue: blended goal lands somewhere unsafe.
    const goalUnsafe =
      anyThreat(world, tx, ty, 36) ||
      anyOnPath(world, w.x, w.y, tx, ty, 30) ||
      inHydraDanger(world, tx, ty);
    if (goalUnsafe) {
      const best = bestEscapeDirection(world, w.x, w.y, RETREAT_STEP);
      if (best) {
        const witchHydraBad = inHydraDanger(world, best.x, best.y);
        if (!witchHydraBad) {
          tx = best.x; ty = best.y;
          reason = "escape-sweep";
        } else {
          // 4. Witch boss veto: every ray ends in spit / bite too.
          // Pinning is the safest one-tick decision; the runtime
          // re-evaluates next replan slot so the body has time to
          // drift before we commit somewhere.  When PIN_HOLD_MS is
          // set, the caller will respect a commitment window and
          // skip replans inside it — the hysteresis the stand
          // tunes.
          tx = w.x; ty = w.y;
          reason = "hydra-pinned";
        }
      }
    }

    // 5. Pond avoidance.
    if (typeof scene.isInPond === "function" && scene.isInPond(tx, ty, 8)) {
      const P = scene.pondBounds && scene.pondBounds();
      if (P) {
        ty = (w.y < P.cy) ? (P.cy - P.ry - 10) : (P.cy + P.ry + 10);
        ty = Math.max(minY, Math.min(maxY, ty));
        reason += "+pond-avoid";
      }
    }

    const out = { tx, ty, reason };
    if (PIN_HOLD_MS > 0 && reason === "hydra-pinned") {
      out.committedUntil = now + PIN_HOLD_MS;
    }
    return out;
  }

  // ----- top-level choose() — STUB for telemetry --------------------
  //
  // Intentionally a thin description right now.  The real work will
  // grow as we extract the next two decision sites (retreat goal,
  // brew/deliver priority).  Kept here so the stand can already
  // print "what is the witch's overall posture this tick" without
  // having to reach into chooseHexTarget directly.
  function choose(world) {
    const hex = chooseHexTarget(world);
    const w = world && world.witch;
    const inDanger = !!(w && inHydraDanger(world, w.x, w.y));
    let posture;
    if (inDanger) posture = "evade";
    else if (hex.target) posture = "snipe";
    else posture = "idle";
    return { posture, hex, inDanger };
  }

  // ==========================================================================
  //  Learned retreat policy (linear net, 48 weights)
  // ==========================================================================
  //
  // Trained by `tools/witch-stand.js --train` using a simple evolution
  // strategy (weighted-mean of top-half, σ decay 0.93/gen) on a 25-tick
  // battle simulator.  Every training candidate is warm-started from
  // the previously-shipped theta, so ES can only refine, not regress.
  //
  // Three sim generations have existed, each strictly stronger than
  // the last at representing what actually kills the witch:
  //
  //   simA (v1)  witch + hydra + random-walking slimes; no friends.
  //   simB (v2)  friends exist as static aggro-sinks; slimes retarget
  //              to the nearest of {witch, ...friends}.
  //   simC (v3)  THIS commit.  Friends are a set of typed fighters
  //              (melee / ranged / heavy) with real DPS who kill
  //              slimes in 1–2 s; the hydra also makes a periodic
  //              bite-lunge at whichever hero is nearest the head
  //              tip, which is where friend POSITION pays off — a
  //              friend standing between witch and body statistically
  //              eats the lunge.
  //
  // Held-out evaluation on simC (12 000 episodes, seed=42, disjoint from
  // training seeds):
  //     utility-AI (retreatStep=260)              avg damage = 21.92
  //     v3-linear  (48 params, shipped below)     avg damage = 20.35   (-7.1%)
  //     v2-linear  (old theta, friends=static)    avg damage = 20.41   (-6.9%)
  //     mlp-H12    (326 params, no warm-start)    avg damage = 21.51   (-1.8%)
  //
  // v3 beats v2 by ~0.06 points (<1%) — tiny, consistent, within one SE
  // — but the weights shift is more telling than the headline number:
  // making friends actually fight doubled the magnitude of the friend
  // features in the learned policy:
  //     friend1_y     (dx):  +0.40  →  +0.66
  //     friend1_prox  (dx):  +0.21  →  +0.63
  // and the threat-side weights grew too (|t0_prox|: 1.33 → 2.05).
  // That is: the policy learned to lean harder on ALL its cues once
  // the simulator punished bad retreats more cleanly.  The ceiling is
  // still set by geometry (witch is only 4 px/s faster than a slime),
  // so the headline gain is modest; but v3 is the right theta to ship
  // because it was selected on a fixture the old theta was never
  // evaluated on.
  //
  // Interpreted weights (full table in `--train` dump):
  //   • t0_x = -1.63, t0_y = -2.63    → dominant: flee the nearest threat.
  //   • t0_prox (dx) = -2.05           → stronger the closer the threat.
  //   • body_unit_x = -1.72            → move opposite hydra body (x).
  //   • body_unit_y (dy) = -1.09       → same, vertical.
  //   • in_bite (dx) = +1.44            → bitten ⇒ drive EAST hard.
  //   • in_spit (dy) = +1.34            → in spit envelope ⇒ drive SOUTH.
  //   • bias (dx, dy) = (+1.77, -0.85) → default NORTH-EAST — more NE
  //     than v2's SE; head-lunges seem to favour southern heroes, so
  //     the net learned a small anti-south drift.
  //   • friend1_y (dx) = +0.66          → largest friend signal:
  //                                      friend south-of-you ⇒ bias east
  //                                      (step sideways past them).
  //   • friend1_prox (dx) = +0.63       → the closer friend-1 is, the
  //                                      stronger that sideways push.
  //
  // v4 (REVERTED): a team-centric reward shaping (cost = damage +
  // 0.08 · final_dist_from_cauldron + 40 · off_stage_frac + 0.03 ·
  // avg_team_dist) was tried — held-out sim showed +2.1 damage / 5-s
  // window for a 49-px tighter return path (203 → 154 px).  In live
  // play that +10% damage compounded across many retreat cycles per
  // boss fight and she started dying noticeably more often.  Pulled
  // back to v3 weights — the cauldron-distance push was real but the
  // damage cost was too steep at this shaping weight.  Re-attempt
  // when (a) the damage signal accounts for retreat *frequency*, not
  // just per-window cost, or (b) we move scoring into the headless
  // sim where "boss fight survived" is the actual reward and a few
  // extra HP lost between brews stops being measured as catastrophic.
  // Both paths are tracked via the experiment log in tools/witch-stand.js.
  //
  // Safety-fallbacks are unchanged: hydra inactive → defer to utility
  // AI; proposed goal in bite ring → defer; proposed goal in pond →
  // defer.  See `chooseRetreatGoalNN` below.
  const DEFAULT_RETREAT_POLICY_THETA = Object.freeze([
    // dx weights (f0..f23)
     1.7701,  1.0448, -0.8298, -1.7186, -0.4048,  0.3181,  0.0913,  1.4364,
    -1.6347, -0.0823, -2.0543, -0.0351,  0.0200, -0.9573, -0.0117, -0.0987,
    -0.3382, -0.4905,  0.1202, -0.3769, -0.1470, -0.0787,  0.6642,  0.6338,
    // dy weights (f0..f23)
    -0.8507,  0.6677,  0.4059,  0.9957, -1.0880,  0.2442,  1.3427,  0.0237,
     0.2104, -2.6303,  0.5535,  0.1223, -0.7951,  0.2545,  0.0234, -0.1810,
    -0.2542,  0.0290, -0.0723, -0.0400, -0.3685, -0.1488,  0.0092,  0.1287,
  ]);
  const RETREAT_FEATURE_COUNT = 24;

  // NB: a v4 extractor with 16 extra quadrant-density features (4
  // sectors × {enemy, friend} × {count, nearest-prox}) was tried on
  // the stand but did NOT beat v3 on held-out episodes.  Even with a
  // 3× training budget (800 eps/eval × 25 gens × 24 pop) the quadrant
  // variant matched v3 on average damage and occasionally lost, so we
  // keep the v3 feature set and don't pay for 16 extra feature
  // computations every retreat tick.  See the `runNetworkCompare`
  // comment block in tools/witch-stand.js for the experiment log.
  //
  // Feature layout (keep aligned with the comment above + stand dump):
  //   0   bias (always 1)
  //   1   witch.x / width            (normalised absolute x)
  //   2   witch.y / height
  //   3   unit(body - witch).x       (0 if hydra inactive)
  //   4   unit(body - witch).y
  //   5   dist(body) / 400           (capped at 1)
  //   6   inSpitDanger flag
  //   7   inBiteDanger flag
  //   8-10   nearest threat:   unit(x), unit(y), 1/(d/200+1) proximity
  //   11-13  2nd-nearest threat: same triple
  //   14-16  3rd-nearest threat: same triple
  //   17  heldPotion flag
  //   18-20  nearest friend:     unit(x), unit(y), 1/(d/150+1) proximity
  //   21-23  2nd-nearest friend: same triple
  //
  // The "friend" slots are all zero when no friends are supplied
  // (peacetime, non-hydra retreats, or stand scenarios that skip them),
  // so the feature layout is stable across callers and the network
  // simply ignores them when irrelevant.
  function extractRetreatFeatures(world) {
    const w = world.witch;
    const scene = world.scene || {};
    const width = scene.width || 800;
    const f = new Array(RETREAT_FEATURE_COUNT);
    f[0] = 1;
    f[1] = w.x / width;
    f[2] = w.y / (scene.height || 320);
    const h = world.hydra;
    if (h && h.active && h.body) {
      const bdx = h.body.x - w.x, bdy = h.body.y - w.y;
      const bd = Math.hypot(bdx, bdy) || 1;
      f[3] = bdx / bd;
      f[4] = bdy / bd;
      f[5] = Math.min(bd, 400) / 400;
      f[6] = inSpitDanger(world, w.x, w.y) ? 1 : 0;
      f[7] = inBiteDanger(world, w.x, w.y) ? 1 : 0;
    } else {
      f[3] = 0; f[4] = 0; f[5] = 1; f[6] = 0; f[7] = 0;
    }
    const threats = [];
    const mons = world.monsters || [];
    for (let i = 0; i < mons.length; i++) {
      const m = mons[i];
      if (!m || m.dying || m.fleeing || m.hidden) continue;
      const dx = m.x - w.x, dy = m.y - w.y;
      threats.push({ dx, dy, d: Math.hypot(dx, dy) });
    }
    threats.sort((a, b) => a.d - b.d);
    for (let i = 0; i < 3; i++) {
      const off = 8 + i * 3;
      if (i < threats.length) {
        const { dx, dy, d } = threats[i];
        const inv = 1 / (d + 1);
        f[off + 0] = dx * inv;
        f[off + 1] = dy * inv;
        f[off + 2] = 1 / (d / 200 + 1);
      } else {
        f[off + 0] = 0; f[off + 1] = 0; f[off + 2] = 0;
      }
    }
    f[17] = w.heldPotion ? 1 : 0;

    // Top-2 nearest friends.  We pull from both `world.friends` (used by
    // the simulator) and the runtime havens (healer/chest/girl anchors)
    // so the same extractor works in both environments without the game
    // having to maintain a separate "friends" array.
    const friends = [];
    const flist = world.friends || [];
    for (let i = 0; i < flist.length; i++) {
      const fr = flist[i];
      if (!fr || fr.dying || fr.fleeing) continue;
      const dx = fr.x - w.x, dy = fr.y - w.y;
      friends.push({ dx, dy, d: Math.hypot(dx, dy) });
    }
    // Also surface runtime havens as "friendly anchors" — in-game the
    // healer _is_ a friend for retreat purposes, and she's already in
    // world.havens.healer from characters.js.
    const havens = world.havens || {};
    if (havens.healer && !flist.some(x => x === havens.healer)) {
      const dx = havens.healer.x - w.x, dy = havens.healer.y - w.y;
      friends.push({ dx, dy, d: Math.hypot(dx, dy) });
    }
    friends.sort((a, b) => a.d - b.d);
    for (let i = 0; i < 2; i++) {
      const off = 18 + i * 3;
      if (i < friends.length) {
        const { dx, dy, d } = friends[i];
        const inv = 1 / (d + 1);
        f[off + 0] = dx * inv;
        f[off + 1] = dy * inv;
        f[off + 2] = 1 / (d / 150 + 1);
      } else {
        f[off + 0] = 0; f[off + 1] = 0; f[off + 2] = 0;
      }
    }
    return f;
  }

  function evalRetreatLinearPolicy(world, theta) {
    theta = theta || DEFAULT_RETREAT_POLICY_THETA;
    const f = extractRetreatFeatures(world);
    const F = RETREAT_FEATURE_COUNT;
    let dx = 0, dy = 0;
    for (let i = 0; i < F; i++) {
      dx += theta[i] * f[i];
      dy += theta[F + i] * f[i];
    }
    return { dxUnit: Math.tanh(dx), dyUnit: Math.tanh(dy), features: f };
  }

  function inPondAt(world, x, y) {
    const scene = world.scene;
    if (!scene || typeof scene.isInPond !== "function") return false;
    return !!scene.isInPond(x, y);
  }

  // Hybrid retreat goal: the learned policy decides direction, utility AI
  // steps in only when the net would do something provably unsafe — land
  // inside the bite ring, or step into the pond (neither ever appeared in
  // the training sim, so the net has no signal for them).  If the hydra
  // isn't active, the net loses its most informative features and the
  // utility AI's haven-blend / sandwich-rescue handle peacetime retreats
  // better, so we defer wholesale.
  function chooseRetreatGoalNN(world, opts) {
    if (!world || !world.witch) {
      return chooseRetreatGoal(world);
    }
    const hydraOn = !!(world.hydra && world.hydra.active);
    if (!hydraOn) return chooseRetreatGoal(world);

    const theta = (opts && opts.theta) || DEFAULT_RETREAT_POLICY_THETA;
    const step = (opts && opts.step) || 260;
    const w = world.witch;
    const scene = world.scene || {};
    const { dxUnit, dyUnit } = evalRetreatLinearPolicy(world, theta);

    const minX = 20;
    const maxX = (scene.width || 800) - 20;
    const minY = (scene.floorTop || 40) + 14;
    const maxY = (scene.floorBottom || 280) - 14;
    let tx = Math.max(minX, Math.min(maxX, w.x + dxUnit * step));
    let ty = Math.max(minY, Math.min(maxY, w.y + dyUnit * step));

    if (inBiteDanger(world, tx, ty)) {
      const fallback = chooseRetreatGoal(world);
      return { tx: fallback.tx, ty: fallback.ty, reason: "nn-veto-bite" };
    }
    if (inPondAt(world, tx, ty)) {
      const fallback = chooseRetreatGoal(world);
      return { tx: fallback.tx, ty: fallback.ty, reason: "nn-veto-pond" };
    }
    return { tx, ty, reason: "nn" };
  }

  return {
    chooseHexTarget,
    chooseRetreatGoal,
    chooseRetreatGoalNN,
    evalRetreatLinearPolicy,
    extractRetreatFeatures,
    choose,
    inSpitDanger,
    inBiteDanger,
    inHydraDanger,
    pathCrossesHydra,
    isHydraPart,
    bestEscapeDirection,
    threatVector,
    anyThreat,
    anyOnPath,
    distToFirstOnPath,
    nearestThreatDist,
    nearestMonster,
    DEFAULT_RETREAT_POLICY_THETA,
    RETREAT_FEATURE_COUNT,
    _constants: {
      DEFAULT_HYDRA_HEAD_RANGE,
      BITE_PAD,
      DEFAULT_HYDRA_SPIT_RANGE,
      SPIT_HEADROOM,
    },
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = WitchStrategy;
}
