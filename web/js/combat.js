/*
 * Combat: projectiles, one-shot effects, and the simple damage book-
 * keeping the heroes and the monsters both go through.
 *
 * Responsibilities:
 *   - carry arrows / fireballs / shurikens / hex bolts / UFO beams
 *     from shooter to victim, apply damage on contact;
 *   - render hit flashes, heal sparkles, cast puffs, potion drink fx;
 *   - stack HP bars above anyone wounded (both sides);
 *   - provide heroAttack/monsterAttack entry points so the AI code in
 *     Characters/Monsters stays focused on behaviour, not book-keeping.
 *
 * Melee attacks don't spawn a projectile — they just flash an impact
 * puff at the target's position and deal damage immediately.
 */
const Combat = (() => {
  const projectiles = [];
  const effects = [];

  const PROJ_SPEED = {
    arrow:    260,
    fireball: 200,
    shuriken: 280,
    hex:      220,
    laser:    480,
    beam:     520,   // alien UFO ray — very fast, nearly hitscan
    // Meteor: a flaming chunk that streaks in diagonally from off-
    // screen for the firemage's "rain of fire" AoE.  Faster than a
    // fireball so the impact reads as a real meteor (the long
    // streak you see is mostly the ~50 px of trail moving past the
    // eye in one frame), and so the on-screen flight time stays
    // short — keeps a 6-meteor volley from cluttering the lawn for
    // multiple seconds.
    meteor:   320,
    // Hydra fire spit: a slow, wobbling ball of orange flame lobbed
    // at heroes that stand outside bite range.  Slow enough to
    // dodge if you're paying attention; fast enough that just
    // strolling away doesn't save you.  Lands as a small ember
    // splash at the impact point.  The firemage is immune.
    fire:     190,
  };

  function now() { return performance.now(); }
  function rr(a, b) { return a + Math.random() * (b - a); }

  // ---- particle factories shared by several effect kinds --------------
  // Pre-roll a scatter of embers (used by explode) so the burst keeps
  // the same shape across all frames it lives for.  Each ember has a
  // ballistic vx/vy + a random size pip in {1, 2}.  Cone is roughly
  // upward (sin/cos tilted toward -y) but spread wide so the burst
  // reads as an explosion, not a fountain.
  function makeEmbers(n, speed) {
    const out = [];
    for (let i = 0; i < n; i++) {
      const ang = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.4;
      const spd = speed * (0.55 + Math.random() * 0.8);
      out.push({
        vx: Math.cos(ang) * spd,
        vy: Math.sin(ang) * spd,
        size: Math.random() < 0.4 ? 2 : 1,
        // Per-ember palette pick: brighter half stays yellow longer.
        hot: Math.random() < 0.5,
      });
    }
    return out;
  }

  // Pre-roll a small spark burst for the generic projectile-hit FX.
  // Sparks shoot out in a 360° fan with random short-range velocities,
  // gravity pulls them down a bit, fade is linear with the effect's
  // life.  Cheap, but instantly tells the player "something landed".
  function makeSparks(n) {
    const out = [];
    for (let i = 0; i < n; i++) {
      const ang = Math.random() * Math.PI * 2;
      const spd = 50 + Math.random() * 70;
      out.push({
        vx: Math.cos(ang) * spd,
        vy: Math.sin(ang) * spd - 20,    // slight upward bias
        size: Math.random() < 0.3 ? 2 : 1,
      });
    }
    return out;
  }

  // ----- public API -----------------------------------------------------

  function heroAttack(c, target) {
    if (!target || target.dying) return;
    const kind = c.atk.kind;
    // Outgoing damage scales by the hero's current station-buff
    // multiplier (atkBoost from the dummy / stump bumps it up; no
    // active buff leaves it at the base value).  Same number is
    // used for both melee swings and ranged projectiles so the
    // buff reads consistently across the kit.
    const dmg = Math.round(c.atk.dmg * (c.dmgMul || 1));
    if (isMelee(kind)) {
      // Short windup so a strike looks deliberate — handled visually
      // via a brief "attack flash" on the character, but damage lands
      // immediately; monsters hit back on their own cooldown.  The
      // effect kind is picked by weapon so a punching robot reads
      // different from a swinging knight, and the dwarf's axe gets
      // a dedicated overhead-chop animation from his shoulder.
      // Lunge cue: drawOne nudges the sprite forward in c.dir for
      // ~180 ms so the body language matches the FX flash in front.
      // Set on EVERY melee swing so sword / axe / punch / bite-back
      // all read the same physically.
      c.swingUntil = now() + 180;
      // Viking cleave: small splash damage to monsters within
      // CLEAVE_R of the primary target.  Splash is intentionally
      // small (~4 dmg) so the axe still rewards focused targets
      // but pack-clearing feels visibly different.  Skipped if the
      // primary swing kills the target (we don't want a single
      // swing to chain-clear a clumped pack).
      const CLEAVE_R   = 12;
      const CLEAVE_DMG = 4;
      const cleaveable = (kind === "axe" && c.name === "viking");
      const killed = Monsters.damage(target, dmg, { weapon: kind });
      spawnDamageNumber(target.x, target.y - target.h - 4, dmg, "dmg");
      if (cleaveable && !killed) {
        for (const o of Monsters.list) {
          if (o === target || o.dying) continue;
          if (Math.hypot(o.x - target.x, o.y - target.y) > CLEAVE_R) continue;
          const k2 = Monsters.damage(o, CLEAVE_DMG);
          spawnDamageNumber(o.x, o.y - o.h - 4, CLEAVE_DMG, "dmg");
          if (k2) Dialog.note("kill");
        }
      }
      if (killed) {
        Dialog.note("kill");
        Dialog.bark(c, "kill");
      }
      // Zombie lifesteal: every successful zombie hit (not just
      // kills) returns a small sliver of HP — feels like he's
      // chewing on the corpse.  Per-hit, capped to his maxHp.
      if (c.name === "zombie" && c.hp > 0 && c.hp < c.maxHp) {
        const steal = Math.max(1, Math.round(dmg * 0.05) + (killed ? 5 : 0));
        healHero(c, steal, "lifesteal");
      }
      const tx = target.x;
      const ty = target.y - target.h / 2;
      if (kind === "axe") {
        effects.push({
          kind: "axe",
          sx: c.x + (c.dir === "r" ? 4 : -4),
          sy: c.y - 18,
          x: tx, y: ty,
          dir: c.dir,
          born: now(), until: now() + 320,
        });
        // Big swing → meaty shake on impact (peaks ~last 1/3 of the
        // anim, but the call here is fine — shake decays linearly).
        Scene.shake(2, 180);
      } else if (kind === "punch") {
        effects.push({
          kind: "pow", x: tx, y: ty,
          born: now(), until: now() + 260,
          dir: c.dir,
        });
        Scene.shake(1.5, 140);
      } else {
        // Per-character look: knight gets the bright clean steel
        // arc, zombie gets a rusted/tinted one so the same "sword"
        // weapon kind still reads as two different fighters.
        effects.push({
          kind: "slash", x: tx, y: ty,
          // Anchor a hilt-side pivot to the attacker so the arc
          // swings out FROM the attacker and INTO the target,
          // instead of just flashing on top of the victim.
          sx: c.x, sy: c.y - 16,
          variant: c.name === "zombie" ? "rust" : "steel",
          born: now(), until: now() + 260,
          dir: c.dir,
        });
        Scene.shake(1.2, 110);
      }
    } else {
      // Archer aimed shot: if he's been sitting still long enough
      // (Characters.tickStations sets c.aimedConsumeNext) the very
      // next bow shot fires for +50% damage.  One-shot consume.
      let shotDmg = dmg;
      if (c.name === "archer" && c.aimedConsumeNext) {
        shotDmg = Math.round(dmg * 1.5);
        c.aimedConsumeNext = false;
        c.aimedReadyAt = 0;
      }
      // Firemage embers: each stack adds +EMBER_BONUS_PER damage to
      // the next fireball.  Stacks are spent on cast, then refresh
      // the aura visual to show it dipping back to zero.
      //
      // Boss exception: the hydra body has a heavy magic resist
      // (HYDRA_BODY_MAGIC_MUL = 0.35) so a 5-stack dump on the
      // body is only ~3.5 effective bonus dmg — practically wasted
      // compared to 10 effective on a head.  Hold the stacks for
      // the next head shot instead of burning them on the body.
      if (c.name === "firemage" && kind === "fireball" &&
          (c.emberStacks || 0) > 0) {
        const isResistedBody = target && target.kind === "hydraBody";
        if (!isResistedBody) {
          shotDmg = shotDmg + (c.emberStacks * 2);
          c.emberStacks = 0;
        }
      }
      spawnProjectile(kind, c.x, c.y - 16, target, shotDmg, "hero", c);
      // Per-element cast wisp colour so the muzzle flash before each
      // shot tells you WHICH spell is leaving the caster's hand:
      // archers and ninjas get a clean steel/leaf wisp, fire mages
      // an orange ember, the witch a violet mote, the alien a hot
      // red pulse.  Defaults stay on the original violet fallback.
      effects.push({
        kind: "cast",
        // Pass projectile kind so drawEffect can pick the palette
        // without having to re-derive it from the caster.
        weapon: kind,
        x: c.x + (c.dir === "r" ? 8 : -8),
        y: c.y - 16, born: now(), until: now() + 160,
      });
    }
  }

  // Ninja's anti-worm finisher: he plants a katana straight down into
  // the mound, holds for a beat, then yanks it free.  Damage lands
  // immediately; the visual is a thin blade that descends, lingers,
  // and retracts (see the "stab" branch in drawEffect for the actual
  // pixels).  Used only when the target is a buried worm so the
  // shuriken kit doesn't have to model "throwing a star at dirt".
  function ninjaWormStab(c, target, dmg) {
    if (!target || target.dying) return;
    // Plant-the-katana lunge — reads as a deliberate two-handed
    // plunge because the body shoves forward as the blade goes in.
    // Slightly longer than a standard swing since the stab anim
    // itself runs ~360 ms.
    c.swingUntil = now() + 220;
    const killed = Monsters.damage(target, dmg);
    spawnDamageNumber(target.x, target.y - target.h - 4, dmg, "dmg");
    if (killed) {
      Dialog.note("kill");
      Dialog.bark(c, "kill");
    }
    effects.push({
      kind: "stab",
      x: target.x, y: target.y,
      // Side the ninja is standing on (left/right) so the hilt drifts
      // a touch toward him — sells the "two-handed plunge from the
      // attacker" rather than a free-floating blade.
      side: c.x < target.x ? -1 : 1,
      born: now(), until: now() + 360,
    });
    Scene.shake(1.6, 150);
  }

  function monsterAttack(m, hero) {
    if (!hero || hero.hp <= 0) return;
    // All monster attacks are melee for now; the "attack flash" lands
    // on the hero and hero.hp drops.  The attacker is passed through
    // so the hero's damage handler can retaliate directly at it.
    Characters.damage(hero, m.atk.dmg, m);
    // Red incoming-pain tag above the wounded hero.
    spawnDamageNumber(hero.x, hero.y - 28, m.atk.dmg, "hurt");
    effects.push({
      kind: "bite", x: hero.x, y: hero.y - 20,
      // Side the attacker is on — used by drawEffect so the blood
      // sprays AWAY from the bite, not back into the monster's mouth.
      side: m.x < hero.x ? -1 : 1,
      born: now(), until: now() + 260,
    });
    Scene.shake(1.2, 110);
  }

  // Per-head HP: wounded heads bite and spit less accurately (see
  // hydraHeadHpFrac).  Torso movement speed scales in monsters.js.
  const HYDRA_AIM_ERR_MAX_PX = 92;
  const HYDRA_BITE_MISS_CURVE = 0.40;

  function hydraHeadHpFrac(head) {
    if (!head || !head.maxHp) return 1;
    return Math.max(0, Math.min(1, head.hp / head.maxHp));
  }

  function hydraSpitJitterAim(head, hero) {
    let tx = hero.x;
    let ty = hero.y - (hero.h || 20) / 2;
    const frac = hydraHeadHpFrac(head);
    const errMax = (1 - frac) * HYDRA_AIM_ERR_MAX_PX;
    if (errMax > 0.5) {
      const r = Math.sqrt(Math.random()) * errMax;
      const ang = Math.random() * Math.PI * 2;
      tx += Math.cos(ang) * r;
      ty += Math.sin(ang) * r;
    }
    return { tx, ty };
  }

  // `dmg` is supplied by Monsters (which folds in the enrage and
  // head-link multipliers); we fall back to the head's flat atk
  // value if the caller doesn't provide one.
  function hydraStrike(head, tgt, dmg) {
    if (!tgt || tgt.hp <= 0) return;
    const frac = hydraHeadHpFrac(head);
    if (Math.random() < (1 - frac) * HYDRA_BITE_MISS_CURVE) {
      const mx = tgt.x + (Math.random() - 0.5) * 44;
      const my = tgt.y - 12 + (Math.random() - 0.5) * 28;
      effects.push({
        kind: "bite", x: mx, y: my,
        side: (head.tipX || head.x) < tgt.x ? -1 : 1,
        born: now(), until: now() + 200,
      });
      Scene.shake(1.2, 100);
      return;
    }
    const d = (typeof dmg === "number") ? dmg : head.atk.dmg;
    if (Monsters && Monsters.isHydraMonsterVictim && Monsters.isHydraMonsterVictim(tgt)) {
      Monsters.damage(tgt, d, { weapon: "hydraBite" });
      spawnDamageNumber(tgt.x, tgt.y - tgt.h - 4, d, "dmg");
    } else {
      Characters.damage(tgt, d, head);
      spawnDamageNumber(tgt.x, tgt.y - 28, d, "hurt");
    }
    // Bite gash (re-uses the standard "bite" sprite for the red gash
    // + droplets) plus an ember puff native to the hydra so the
    // impact reads as part of HER fiery kit rather than a generic
    // bite — her mouth is full of flame even when she's biting.
    effects.push({
      kind: "bite", x: head.tipX || tgt.x, y: head.tipY || (tgt.y - 20),
      side: (head.tipX || head.x) < tgt.x ? -1 : 1,
      born: now(), until: now() + 300,
    });
    effects.push({
      kind: "fireSplash",
      x: tgt.x, y: tgt.y - 12,
      born: now(), until: now() + 360,
      sparks: makeSparks(5),
    });
    Scene.shake(2.4, 200);
  }

  // Hydra fire spit: lobs a "fire" projectile from the head's open
  // mouth toward the hero's centre of mass.  The projectile is a
  // standard single-target one tagged srcKind="hydra" so the existing
  // tick loop drives it through Characters.damage on contact, except
  // the firemage who is immune.  `dmg` is supplied by the caller
  // (Monsters owns the encounter tuning); we default to 9 to match
  // the constant if anyone calls without it.
  function hydraSpit(head, hero, dmg) {
    if (!hero || hero.hp <= 0) return;
    const sx = (typeof head.tipX === "number") ? head.tipX : head.x;
    const sy = (typeof head.tipY === "number") ? head.tipY : head.y;
    const aim = hydraSpitJitterAim(head, hero);
    const tx = aim.tx;
    const ty = aim.ty;
    const dx = tx - sx, dy = ty - sy;
    const d = Math.hypot(dx, dy) || 1;
    const speed = PROJ_SPEED.fire;
    projectiles.push({
      kind: "fire",
      x: sx, y: sy,
      // Add a small upward bias so the lob arcs over the rocks rather
      // than going straight as a dart.
      vx: (dx / d) * speed,
      vy: (dy / d) * speed - 30,
      // Gravity-affected so the trajectory curves down into the
      // target instead of flying flat.  tick() reads this field and
      // integrates accordingly for projectiles that have it.
      gy: 280,
      dmg: typeof dmg === "number" ? dmg : 9,
      target: hero,
      srcKind: "hydra",
      srcRef: head,
      ttl: (d / speed) * 1000 + 600,
      born: now(),
    });
    // Spit puff at the mouth + a tiny cough shake.
    effects.push({
      kind: "fireSplash",
      x: sx, y: sy,
      born: now(), until: now() + 240,
      sparks: makeSparks(3),
      tiny: true,
    });
    Scene.shake(1.0, 90);
  }

  // Pre-strike telegraph for the bite: a pulsing two-ring marker
  // that LIVE-tracks the hero so dodging by walking away actually
  // works.  Distinct sprite from meteorWarn — green/red instead of
  // orange — so the player can read "snake bite incoming" not
  // "fire from the sky".
  function hydraStrikeWarn(target, lead) {
    if (!target) return;
    effects.push({
      kind: "hydraStrikeWarn",
      live: true, target,
      x: target.x, y: target.y,
      born: now(), until: now() + (lead || 700),
    });
  }

  // Pre-spit telegraph: tighter, sicker green crosshair on the
  // intended landing point — also live-tracks the hero so walking
  // out of the path mid-windup matters.
  function hydraSpitWarn(target, lead) {
    if (!target) return;
    effects.push({
      kind: "hydraSpitWarn",
      live: true, target,
      x: target.x, y: target.y,
      born: now(), until: now() + (lead || 700),
    });
  }

  // Severed-head FX: a gory falling head that ballistic-arcs to the
  // ground + a fountain of blood at the cut point + a longer-lived
  // ground splat where it lands.  Three layered effects so the
  // reader doesn't miss a sever — the most thematic moment in the
  // entire encounter.
  function hydraSeverFx(x, y, launchVx) {
    const t = now();
    // Falling head: a small green/dark sprite that arcs out away from
    // the body.  vx is biased AWAY from the lair (positive launchVx
    // for heads on the right side) so heads don't stack on top of
    // each other at the cave mouth.
    effects.push({
      kind: "hydraFallingHead",
      x, y,
      vx: launchVx * 0.6 + (Math.random() - 0.5) * 30,
      vy: -120 - Math.random() * 40,
      born: t, until: t + 900,
    });
    // Blood spray at the cut.
    effects.push({
      kind: "bloodSpurt",
      x, y,
      drops: makeBloodDrops(14),
      born: t, until: t + 700,
    });
  }

  // Visible regrowth sprout — a brief green pulse + 3 ichor drops
  // dripping outward.  Optional `delay` lets the bonus head (born a
  // beat after the original) get its own birth fanfare instead of
  // sharing one with the regrown stump.
  function hydraSproutFx(x, y, delay) {
    const t = now() + (delay || 0);
    effects.push({
      kind: "hydraSprout",
      x, y,
      born: t, until: t + 540,
    });
  }

  // Pre-rolled blood drops: red ballistic particles for the sever
  // and fire splash effects.  Heavier gravity than sparks so they
  // arc back to the ground quickly.
  function makeBloodDrops(n) {
    const out = [];
    for (let i = 0; i < n; i++) {
      const ang = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.6;
      const spd = 70 + Math.random() * 90;
      out.push({
        vx: Math.cos(ang) * spd,
        vy: Math.sin(ang) * spd,
        size: Math.random() < 0.35 ? 2 : 1,
        // Per-drop palette pick: most are dark blood, a few brighter
        // arterial red so the spray reads as wet, not flat.
        hot: Math.random() < 0.4,
      });
    }
    return out;
  }

  // Cluster of small grey rock chunks bouncing out of the lair.  Used
  // by Monsters when the hydra emerges and when it dies — gives the
  // event a chunky physics layer beyond the dust burst.
  function rockChunks(x, y, n) {
    const t = now();
    for (let i = 0; i < n; i++) {
      const ang = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.7;
      const spd = 90 + Math.random() * 110;
      effects.push({
        kind: "rockChunk",
        x, y,
        vx: Math.cos(ang) * spd,
        vy: Math.sin(ang) * spd,
        size: Math.random() < 0.4 ? 3 : 2,
        born: t, until: t + 700 + Math.random() * 250,
      });
    }
  }

  // Alien hovering in the UFO fires a ray straight down on a monster.
  // We DON'T freeze the endpoint coordinates here — by the time the
  // 220ms beam finishes drawing, both the UFO and the monster have
  // moved a bit, and a stale snapshot leaves the ray dangling in
  // mid-air.  Instead we stash the target reference and look up the
  // saucer + monster live in `drawEffect`.  The frozen x/y/x2/y2 are
  // kept only as a fallback for when the target gets cleaned up.
  function ufoBeam(ufox, ufoy, target) {
    if (!target || target.dying) return;
    const t = now();
    effects.push({
      kind: "beam",
      live: true,
      target,
      x: ufox, y: ufoy,
      x2: target.x, y2: target.y - target.h / 2,
      born: t, until: t + 220,
    });
    Scene.shake(1.4, 120);
    spawnDamageNumber(target.x, target.y - target.h - 4, 22, "dmg");
    return Monsters.damage(target, 22);
  }

  // Instant heal + green sparkle.  Called by the healer or when
  // drinking a potion.
  function healHero(c, amount, kind) {
    if (!c) return;
    c.hp = Math.min(c.maxHp, c.hp + amount);
    effects.push({
      kind: kind || "heal", x: c.x, y: c.y - 18,
      born: now(), until: now() + 500,
    });
    // Green +N tag drifting up from the patient.  Lets the player
    // see HOW MUCH HP came back, distinct from outgoing damage.
    spawnDamageNumber(c.x, c.y - 24, amount, "heal");
  }

  // Floating damage / heal number.  Generic helper so anyone (Combat
  // itself, Monsters.damage callbacks, Characters.damage handlers)
  // can pop a number above a hit point without knowing the rendering
  // details.  `kind` controls the palette:
  //   • "dmg"   — yellow (default), used for damage to monsters
  //   • "hurt"  — red, used for damage to heroes (incoming pain)
  //   • "heal"  — green "+N", used for healHero
  //   • "crit"  — orange "!N", reserved for future big hits
  // Numbers are integers and clamped >= 1 (anything dealing zero
  // skips the popup, since a "0" cluttering the lawn is noise).
  function spawnDamageNumber(x, y, amount, kind) {
    const v = Math.max(0, Math.round(amount));
    if (v <= 0) return;
    effects.push({
      kind: "dmgnum",
      x, y,
      // A tiny horizontal jitter per number so a fast volley
      // doesn't stack three "10"s into one illegible pixel column.
      jitterX: Math.round((Math.random() - 0.5) * 6),
      // Each number rises ~16 px over its lifetime.
      value: v,
      variant: kind || "dmg",
      born: now(), until: now() + 700,
    });
  }

  // Oil-spritz arc from the oilcan spout to a thirsty robot.  Two
  // glistening yellow droplets ride a short ballistic path from
  // src → dst so the recharge actually reads on screen — without it
  // the only visible feedback was a one-pixel pulsing pip above the
  // robot's head, easy to miss.  Drawn by tick() below.
  function oilSpritz(srcX, srcY, dstX, dstY) {
    effects.push({
      kind: "oilspritz",
      x: srcX, y: srcY,
      dstX, dstY,
      born: now(), until: now() + 520,
    });
  }

  // Generic puff for spell wind-up / teleport-in of the alien.
  function puff(x, y, color) {
    effects.push({
      kind: "puff", x, y, color,
      born: now(), until: now() + 350,
    });
  }

  // ----- new-ability visual primitives ---------------------------------

  // Witch hex slow swirl.  Spawned on the monster every time the slow
  // is applied or refreshed; a fresh effect simply layers on top of
  // an existing one and the older fades behind.
  function slowFx(x, y) {
    effects.push({
      kind: "slow", x, y,
      born: now(), until: now() + 700,
    });
  }

  // Knight taunt ring + ! cue.
  function tauntFx(x, y) {
    effects.push({
      kind: "taunt", x, y,
      born: now(), until: now() + 600,
    });
    Scene.shake(1.0, 100);
  }

  // Pre-impact circle that telegraphs an incoming firemage meteor.
  function meteorWarn(x, y, lead) {
    effects.push({
      kind: "meteorWarn", x, y,
      born: now(), until: now() + (lead || 700),
    });
  }

  // Ninja smoke-bomb cloud.  Drops on the ninja's current position.
  function smokeBomb(x, y) {
    effects.push({
      kind: "smokeBomb", x, y,
      born: now(), until: now() + 700,
    });
  }

  // Alien protective beam between caster (`from`) and ally (`to`).
  // Persists for `dur` ms; positions look up live from the actor refs
  // so the ribbon tracks if either party walks during the channel.
  function shieldBeam(from, to, dur) {
    effects.push({
      kind: "shieldBeam",
      live: true, from, to,
      x: from.x, y: from.y - 16,
      x2: to.x,  y2: to.y - 16,
      born: now(), until: now() + (dur || 4000),
    });
  }

  // Firemage ember orbit.  `stacks` (1..5) drives how many motes draw
  // and their intensity.  Spawned every time a stack count changes so
  // the audience sees the buff growing.
  function embersAura(x, y, stacks) {
    effects.push({
      kind: "embersAura", x, y,
      stacks: Math.max(1, Math.min(5, stacks | 0)),
      born: now(), until: now() + 1200,
    });
  }

  // Robot repair-kit chassis sparkle.  Brief, ~400 ms, paired with a
  // sizable healHero call for the actual HP.
  function repairSpark(x, y) {
    effects.push({
      kind: "repairSpark", x, y,
      born: now(), until: now() + 420,
    });
  }

  // Tiny shower of dirt clods + dust kicked up where the ground was
  // disturbed — used by the worm whenever it leaves OR re-enters the
  // soil (submerge, death) instead of the chunky `puff` rectangle
  // that used to leave a brown 20×10 block hanging over the mound.
  // Each clod is its own 1-2 px particle with its own ballistic arc
  // so the burst reads as scattered earth rather than a flat
  // coloured square.  `dark` toggles a darker palette (true = peat /
  // grass tone, false = light dirt-path tone) so a worm submerging
  // on the path doesn't spit dark earth and vice versa.
  function dirtBurst(x, y, dark, opts) {
    // opts let callers shape the burst:
    //   count — particle count (default 7).  Smaller numbers read
    //           as a quick scatter rather than a full eruption;
    //           the horse-stomp squish on a worm mound passes 4-5
    //           so it feels like a flick of dirt, not a death
    //           geyser.
    //   scale — multiplier on initial speed AND visual size.  <1
    //           keeps the cone tight and short (small splash);
    //           >1 throws clods further.  Default 1 preserves
    //           every existing call site.
    //   life  — override total lifetime in ms (default 520).
    //           Shorter lives + smaller scale = the "spritzy"
    //           feel the stomp wants.
    const N      = (opts && opts.count) || 7;
    const scale  = (opts && opts.scale) || 1;
    const lifeMs = (opts && opts.life)  || 520;
    const clods = [];
    for (let i = 0; i < N; i++) {
      // Cone aimed slightly upward, spread over ~140°, varying
      // initial speed so the particles separate as they fall.
      const ang = -Math.PI / 2 + (i / (N - 1) - 0.5) * 2.4 + (Math.random() - 0.5) * 0.4;
      const spd = (28 + Math.random() * 26) * scale;
      clods.push({
        x: (Math.random() - 0.5) * 2,
        y: (Math.random() - 0.5) * 1,
        vx: Math.cos(ang) * spd,
        vy: Math.sin(ang) * spd,
        size: scale < 0.7
          ? 1
          : (Math.random() < 0.45 ? 2 : 1),
        spin: Math.random(),
      });
    }
    effects.push({
      kind: "dirtburst",
      x, y,
      dark: !!dark,
      palette: (opts && opts.palette) || null,
      clods,
      born: now(),
      until: now() + lifeMs,
    });
  }

  // Grey dust puff played the moment a hero collapses.  The grave is
  // drawn by Characters.drawGraveMarker, so this effect is just the
  // "thud" we see rising from the body.
  function deathPuff(x, y) {
    effects.push({
      kind: "deathpuff", x, y,
      // Pre-roll soul wisps so they keep their phase across frames.
      wisps: [
        { dx: -2, dy: 0, sp: 18, ph: 0.0 },
        { dx:  2, dy: 0, sp: 14, ph: 0.4 },
        { dx:  0, dy: 0, sp: 22, ph: 0.7 },
      ],
      born: now(), until: now() + 800,
    });
    Scene.shake(2.4, 220);
  }

  // Standing column of golden light over a fallen ally during a
  // revive channel.  The effect lives for `durMs` so it lines up with
  // the caster's channel window.
  function holyLight(x, y, durMs) {
    effects.push({
      kind: "holylight", x, y,
      born: now(), until: now() + durMs,
    });
  }

  // Necromantic green pillar — same role as holyLight but cast by
  // the grave itself when a fallen zombie pulls himself back up.
  // The visual deliberately reads as "the wrong kind of light":
  // mossy / bile green core instead of warm gold, with a couple of
  // colder embers drifting up through the column.  Caller passes
  // the channel duration so the effect ends right when the
  // resurrect lands.
  function necroLight(x, y, durMs) {
    effects.push({
      kind: "necrolight", x, y,
      born: now(), until: now() + durMs,
    });
  }

  // Pixel "holy rain" over a hero the priest just healed.  Soft halo
  // bubble at the top with a handful of light-blue / cream droplets
  // falling out of it, plus a couple of cross-shaped sparkles and a
  // ground glimmer at the patient's feet.  Lives for `durMs` so it
  // overlaps the cooldown window between casts and reads as a
  // continuous "she's being healed" cue rather than a single flicker.
  //
  // Stores a `target` ref so the draw loop can re-read the patient's
  // live coordinates every frame: without this the cloud stayed
  // anchored to the cast point and a wounded hero who took two steps
  // mid-cooldown would walk out from under his own rain.  The frozen
  // x/y kept on the effect are just a fallback for when the target
  // gets cleaned up (death, leave-stage) — in that case the rain
  // finishes its last few frames in place rather than vanishing.
  function holyRain(target, durMs) {
    const t = now();
    effects.push({
      kind: "holyrain",
      live: true,
      target,
      x: target.x, y: target.y - 16,
      born: t, until: t + durMs,
    });
  }

  // Finishing flash when the revive actually lands.
  function reviveBurst(x, y) {
    effects.push({
      kind: "reviveburst", x, y,
      born: now(), until: now() + 450,
    });
  }

  // Potion-revive smash: a hero just broke a green revive bottle on
  // a fallen friend's chest.  We need a visual that's clearly NOT
  // the casters' golden pillar (holyLight) — same outcome, different
  // mechanism.  This effect is a quick green burst + four glass
  // shards arcing outward + a rising lime sparkle column, all played
  // for a short window (~700 ms) that overlaps the carrier's "use"
  // phase.  The actual reviveBurst still plays at the end (from
  // resurrect()) so the resurrection itself reads consistently.
  function potionReviveSmash(x, y) {
    effects.push({
      kind: "potionsmash", x, y,
      born: now(), until: now() + 700,
    });
    Scene.shake(1.2, 140);
  }

  // Healer-only mount summon aura.  A growing pixel-art horse
  // silhouette materialises over the caster's head while a ring of
  // sparkles orbits around her — a clear "magic happening, mount on
  // the way" cue that's distinct from the holy rain (downward droplets)
  // and the holy light (vertical column).  `target` is a live ref so
  // the aura tracks the caster if she gets nudged mid-channel.
  function summonHorseAura(target, until) {
    effects.push({
      kind: "horseAura",
      live: true,
      target,
      x: target.x, y: target.y - 28,
      born: now(), until,
    });
  }

  // Healer's decoy spell — short spinning sparkle ring around her
  // body during the cast.  Tracks the live caster ref so the spin
  // visual stays glued to her if she's nudged at all (she shouldn't
  // be — the cast pins her movement — but the same belt-and-braces
  // pattern as the holy rain / horse aura).
  function decoyCast(target, until) {
    effects.push({
      kind: "decoyCast",
      live: true,
      target,
      x: target.x, y: target.y - 16,
      born: now(), until,
    });
  }

  // One-shot puff played the instant the clone materialises in
  // front of the screen — a flash ring that expands out of the
  // decoy's footprint so the appearance reads as a "pop", not a
  // silent fade-in.
  function decoyAppear(decoy) {
    effects.push({
      kind: "decoyAppear",
      x: decoy.x, y: decoy.y - 14,
      born: now(), until: now() + 360,
    });
  }

  // Pixel-art "tractor beam of life": a column of soft light from the
  // UFO down to a fallen ally with a couple of glowing rings sliding
  // down it.  Emitted repeatedly by the alien's revive channel so each
  // pulse overlaps the next — the rings keep descending as long as the
  // alien hovers.  (ufox, ufoy) is where the ray comes out of the
  // saucer; (tx, ty) is the corpse's feet.
  function ufoRay(ufox, ufoy, tx, ty, durMs) {
    const t = now();
    effects.push({
      kind: "uforay",
      live: true,                  // saucer keeps moving while the
      x: ufox, y: ufoy,            // beam is alive — re-read the live
      x2: tx, y2: ty,              // saucer position every frame so
      born: t, until: t + durMs,   // the ray always connects.
    });
  }

  function isMelee(kind) {
    return kind === "sword" || kind === "axe" || kind === "bite" || kind === "punch";
  }

  function spawnProjectile(kind, x, y, target, dmg, srcKind, srcRef) {
    const tx = target.x, ty = target.y - (target.h || 20) / 2;
    const dx = tx - x, dy = ty - y;
    const d = Math.hypot(dx, dy) || 1;
    const s = PROJ_SPEED[kind] ?? 220;
    projectiles.push({
      kind,
      x, y,
      vx: (dx / d) * s, vy: (dy / d) * s,
      dmg, target, srcKind, srcRef,
      ttl: (d / s) * 1000 + 250,
      born: now(),
    });
  }

  // No-damage practice projectile used by ranged heroes shooting at
  // their training target.  Re-uses the regular projectile renderer
  // (so an archer's training arrow looks like a real arrow) but
  // carries no monster reference: in `tick` it just flies in a
  // straight line until it reaches its destination, where the
  // optional `onArrive` callback fires (used by Characters to bump
  // the stuck-arrow counter on the target prop the moment the
  // arrow visually lands).
  function trainingShot(kind, srcX, srcY, dstX, dstY, onArrive) {
    const dx = dstX - srcX, dy = dstY - srcY;
    const d = Math.hypot(dx, dy) || 1;
    const s = PROJ_SPEED[kind] ?? 220;
    projectiles.push({
      kind, x: srcX, y: srcY,
      vx: (dx / d) * s, vy: (dy / d) * s,
      dmg: 0, target: null, srcKind: "training", srcRef: null,
      trainDx: dstX, trainDy: dstY, trainOnArrive: onArrive || null,
      ttl: (d / s) * 1000 + 80,
      born: now(),
    });
  }

  // Firemage's "rain of fire" AoE.  `impacts` is an array of
  // `{ x, y, delay }` where `delay` is milliseconds from now until
  // that meteor visually appears at the top of the screen.  Each
  // meteor flies diagonally from off-screen onto its landing point
  // and on contact does `dmg` damage to every monster within `hitR`
  // pixels of the impact point — a single rain therefore deals
  // overlapping splash damage across a small area, naturally
  // rewarding a tightly-clustered group of monsters and being a
  // weak choice against a single isolated target.  `srcRef` is the
  // firemage so kill barks (and any future scoreboard) credit the
  // right hero.  No friendly-fire path: the splash loop only
  // touches the Monsters list.
  function meteorRain(srcRef, impacts, hitR, dmg) {
    const t = now();
    for (let i = 0; i < impacts.length; i++) {
      const imp = impacts[i];
      spawnMeteor(srcRef, imp.x, imp.y, dmg, hitR, t + (imp.delay || 0));
    }
  }

  function spawnMeteor(srcRef, lx, ly, dmg, hitR, armAt) {
    // Pre-impact telegraph: ~700 ms warning circle on the landing
    // point so the player (and any roaming hero who'd otherwise
    // walk into the splash) can see the meteor incoming.  The
    // warning is purely visual — the meteor's own armAt timer
    // still controls when the splash actually lands.
    const lead = 700;
    effects.push({
      kind: "meteorWarn",
      x: lx, y: ly,
      born: armAt - lead, until: armAt,
    });
    // Pick an off-screen origin diagonally above the landing.  We
    // alternate left / right per meteor (random) so a 6-meteor volley
    // streaks down from BOTH sides and reads as a shower instead of
    // a single column.  startY is well above the canvas top so the
    // streak is already at meteor speed by the time it enters the
    // viewport.
    const fromLeft = Math.random() < 0.5;
    const sideX = fromLeft ? -180 : 180;
    const startX = lx + sideX + (Math.random() - 0.5) * 40;
    const startY = -50 - Math.random() * 30;
    const dx = lx - startX, dy = ly - startY;
    const d = Math.hypot(dx, dy) || 1;
    const s = PROJ_SPEED.meteor;
    projectiles.push({
      kind: "meteor",
      x: startX, y: startY,
      vx: (dx / d) * s, vy: (dy / d) * s,
      dmg, dmgR: hitR,
      // Area-target fields (mutually exclusive with `target` used by
      // single-shot projectiles).  `tick` checks `landX !== undefined`
      // to know which path to run.
      landX: lx, landY: ly,
      target: null, srcKind: "hero", srcRef,
      armAt,                  // hidden until now >= armAt
      ttl: (d / s) * 1000 + 500,
      born: armAt,
    });
  }

  // ----- per-frame update ----------------------------------------------

  function tick(dt) {
    const t = now();

    for (let i = projectiles.length - 1; i >= 0; i--) {
      const p = projectiles[i];

      // Staggered meteors in a fire-rain volley share one spawn call
      // but are armed at different timestamps — until ours lands, we
      // hold completely still off-screen so the streak appears at
      // the top of the canvas in a clean staccato rather than a
      // single-frame bunch.
      if (p.armAt && t < p.armAt) continue;

      p.x += p.vx * dt / 1000;
      p.y += p.vy * dt / 1000;
      // Gravity-aware projectiles (currently the hydra fire lob)
      // accumulate downward velocity so the trajectory arcs into the
      // target.  All other projectiles ignore this branch.
      if (p.gy) p.vy += p.gy * dt / 1000;
      p.ttl -= dt;

      // Area-target projectile (meteor): land at (landX, landY) and
      // splash-damage every monster within `dmgR` of the impact.
      // Distinct from single-target projectiles below because we
      // don't have one specific monster to chase — we land on a
      // tile, not a target.
      if (p.landX !== undefined) {
        const ddx = p.x - p.landX, ddy = p.y - p.landY;
        if (ddx * ddx + ddy * ddy < 36) {            // within 6 px
          let killedAny = false;
          for (const m of Monsters.list) {
            if (m.dying || m.fleeing) continue;
            if (Monsters.isHidden && Monsters.isHidden(m)) continue;
            const md = Math.hypot(m.x - p.landX, m.y - p.landY);
            if (md < p.dmgR) {
              const killed = Monsters.damage(m, p.dmg, { weapon: p.kind });
              spawnDamageNumber(m.x, m.y - m.h - 4, p.dmg, "dmg");
              if (killed) killedAny = true;
            }
          }
          // Big orange splash + a couple of ember puffs so the
          // landing reads as a real impact.  We deliberately don't
          // bark a kill on every splashed monster — the volley would
          // chain a wall of "Got him!"s; one bark per *volley* fires
          // separately from castFireRain in characters.js.  We DO
          // emit a kill note (HUD) per meteor that took something
          // down, so the kill counter still reflects reality.
          if (killedAny) Dialog.note("kill");
          effects.push({
            kind: "explode",
            x: p.landX, y: p.landY,
            // Pre-rolled embers so the burst keeps the same look
            // each frame instead of jittering when re-randomised.
            embers: makeEmbers(8, 70),
            r: p.dmgR || 24,
            born: t, until: t + 420,
          });
          // Falling chunk of magma → meaty thump.
          Scene.shake(3, 220);
          for (let k = 0; k < 3; k++) {
            const ex = p.landX + (Math.random() - 0.5) * 18;
            const ey = p.landY + (Math.random() - 0.5) * 8;
            const r = 120 + Math.floor(Math.random() * 70);
            effects.push({
              kind: "puff", x: ex, y: ey,
              color: `rgba(255,${r},40,0.85)`,
              born: t, until: t + 320 + Math.random() * 120,
            });
          }
          projectiles.splice(i, 1);
          continue;
        }
        if (p.ttl <= 0 ||
            p.y > Scene.HEIGHT + 30 || p.x < -60 || p.x > Scene.WIDTH + 60) {
          projectiles.splice(i, 1);
        }
        continue;
      }

      // Practice shots: no monster, no damage, just look for arrival
      // at the marked spot and fire the callback (which typically
      // increments stuck-arrow counts on the prop).  Falling through
      // to the ttl/out-of-bounds clean-up below keeps stray ones
      // from hanging around if the hero moved mid-flight.
      if (p.srcKind === "training") {
        const dd = Math.hypot(p.x - p.trainDx, p.y - p.trainDy);
        if (dd < 6) {
          if (p.trainOnArrive) p.trainOnArrive();
          // Fireball practice shots get the same orange splash as a
          // real combat fireball impact so the bullseye visibly gets
          // scorched (a silent vanish would read as a misfire).
          if (p.kind === "fireball") {
            effects.push({
              kind: "explode",
              x: p.x, y: p.y,
              embers: makeEmbers(6, 55),
              r: 18,
              born: t, until: t + 360,
            });
            // Practice shot still gives a light thump — sells that the
            // fireball ACTUALLY hit something, not just dissolved.
            Scene.shake(1.6, 130);
          }
          projectiles.splice(i, 1);
          continue;
        }
      }

      const tgt = p.target;
      const alive = tgt && (p.srcKind === "hero"
        ? !tgt.dying
        : tgt.hp > 0);
      // Per-element resistance gate.  Maps the projectile's `kind`
      // back to the element it represents and consults the public
      // tables in monsters.js (HYDRA_ELEMENT_IMMUNE / RESIST).
      //   immune → 0 damage, no rider debuff, just a small puff so
      //            the player reads "the hit landed but did nothing".
      //   resist → half damage and the rider debuff is suppressed,
      //            but the splash FX still play normally.
      // Always false / no-op for hero-fired projectiles (only hydra
      // spits target heroes; lightning is handled separately).
      const projElement = (
        p.kind === "fire"        ? "fire"   :
        p.kind === "hydraAcid"   ? "acid"   :
        p.kind === "hydraIce"    ? "ice"    :
        p.kind === "hydraPoison" ? "poison" :
        null
      );
      const tgtElId = (tgt && Monsters && Monsters.hydraTargetElementId)
        ? Monsters.hydraTargetElementId(tgt)
        : (tgt && tgt.name) || "";
      const immune = !!(tgt && projElement && p.srcKind === "hydra"
        && Monsters && Monsters.isElementImmune
        && Monsters.isElementImmune(tgtElId, projElement));
      const resist = !!(tgt && projElement && p.srcKind === "hydra"
        && !immune
        && Monsters && Monsters.isElementResist
        && Monsters.isElementResist(tgtElId, projElement));
      if (alive) {
        const hitR = (p.kind === "fireball") ? 14 : 10;
        const dd = Math.hypot(p.x - tgt.x, p.y - (tgt.y - (tgt.h || 20) / 2));
        if (dd < hitR) {
          if (p.srcKind === "hero") {
            const killed = Monsters.damage(tgt, p.dmg, { weapon: p.kind });
            spawnDamageNumber(tgt.x, tgt.y - tgt.h - 4, p.dmg, "dmg");
            // Witch hex slow: every hex bolt that lands tags the
            // target with the slow debuff for ~2.5 s.  The slow
            // multiplier is consumed on the monsters side in
            // Monsters.tick.  Still applied even if the bolt was
            // the killing blow — the slow FX ticks during the
            // monster's brief dying frames, which is harmless.
            if (p.kind === "hex" && tgt && !tgt.dying) {
              // Body shrugs off the slow (it's rooted anyway, and we
              // want pure-magic teams to feel the magic resist matter).
              // Heads, however, take the full slow — gives the witch
              // a real anti-hydra contribution since slowed heads
              // attack less often before they're severed.
              if (tgt.kind === "hydraBody") {
                // No-op — body magic immunity (mirrors damage path).
              } else {
                const SLOW_MS = 2500;
                tgt.slowedUntil = Math.max(tgt.slowedUntil || 0, t + SLOW_MS);
                slowFx(tgt.x, tgt.y - (tgt.h || 16) / 2);
              }
            }
            if (killed) {
              Dialog.note("kill");
              Dialog.bark(p.srcRef, "kill");
              // Firemage ember stack: every kill credited to the
              // firemage (whether by fireball or by meteor splash)
              // bumps his stack count, capped at EMBER_MAX.  The
              // next fireball reads the stack to add bonus damage,
              // and the visual embersAura draws around him while
              // any stacks are present.  Reset on rain-of-fire
              // cast — the rain "spends" the embers.
              if (p.srcRef && p.srcRef.name === "firemage") {
                const cap = 5;
                p.srcRef.emberStacks = Math.min(cap, (p.srcRef.emberStacks || 0) + 1);
                embersAura(p.srcRef.x, p.srcRef.y - 18, p.srcRef.emberStacks);
              }
            }
          } else {
            // Firemage immunity (`immune` is computed once above for
            // the whole hit handler).  We still spawn an ember puff
            // at the impact so the player reads "the attack hit but
            // did nothing" during a chaotic fight; the kind-dispatch
            // below also skips the rider debuff for the same flag.
            if (immune) {
              puff(p.x, p.y, "rgba(255,210,100,0.85)");
            } else {
              // Resist: half damage (rounded up so a 1-dmg spit still
              // does 1, not 0), and the rider debuff is suppressed
              // further down by the same `resist` flag.
              const eff = resist ? Math.max(1, Math.ceil(p.dmg / 2)) : p.dmg;
              if (Monsters && Monsters.isHydraMonsterVictim && Monsters.isHydraMonsterVictim(tgt)) {
                Monsters.damage(tgt, eff, { weapon: p.kind });
                spawnDamageNumber(tgt.x, tgt.y - tgt.h - 4, eff, resist ? "resist" : "dmg");
              } else {
                Characters.damage(tgt, eff, p.srcRef);
                spawnDamageNumber(tgt.x, tgt.y - 28, eff, resist ? "resist" : "hurt");
              }
            }
          }
          if (p.kind === "fireball") {
            effects.push({
              kind: "explode",
              x: p.x, y: p.y,
              embers: makeEmbers(6, 55),
              r: 18,
              born: t, until: t + 360,
            });
            Scene.shake(2.2, 180);
          } else if (p.kind === "fire") {
            // Orange splash + a few embers.  Bigger shake than a
            // regular hit so a hydra spit reads with weight even
            // though damage is modest.
            effects.push({
              kind: "fireSplash",
              x: p.x, y: p.y,
              sparks: makeSparks(7),
              born: t, until: t + 380,
            });
            Scene.shake(1.4, 130);
          } else if (p.kind === "hydraAcid") {
            // Acid spit lands: vulnerable debuff + green splash.
            // Skip the rider for both immune AND resist heroes —
            // resist's whole point is "the secondary effect bounces".
            if (!immune && !resist && !(Monsters && Monsters.isHydraMonsterVictim && Monsters.isHydraMonsterVictim(tgt))) {
              if (Characters.applyDebuff) Characters.applyDebuff(tgt, "vulnerable", t);
            }
            effects.push({ kind: "hydraAcidSplash", x: p.x, y: p.y,
                           born: t, until: t + 420 });
            Scene.shake(1.6, 140);
          } else if (p.kind === "hydraIce") {
            // Ice spit lands: AoE chill on nearby heroes.
            effects.push({ kind: "hydraIceSplash", x: p.x, y: p.y,
                           born: t, until: t + 500 });
            if (typeof Characters !== "undefined" && Characters.list) {
              for (const c of Characters.list) {
                if (!Characters.isVisibleNow(c)) continue;
                if (c.hp <= 0 || c.combatMode === "dead") continue;
                if (Math.hypot(c.x - p.x, c.y - p.y) < HYDRA_ICE_CHILL_R) {
                  // Per-hero ice resist: both immune and resist
                  // heroes shrug off the AoE chill (firemage, viking).
                  // The chill applies element-wide to anyone caught
                  // in the splash, not just the primary target, so
                  // the resist check has to live HERE rather than
                  // piggy-back the per-projectile `resist` flag.
                  if (Monsters && Monsters.isElementImmune
                      && Monsters.isElementImmune(c.name, "ice")) continue;
                  if (Monsters && Monsters.isElementResist
                      && Monsters.isElementResist(c.name, "ice")) continue;
                  if (Characters.applyDebuff) Characters.applyDebuff(c, "chill", t);
                }
              }
            }
            Scene.shake(1.4, 130);
          } else if (p.kind === "hydraPoison") {
            // Poison spit lands: one poison stack + violet splash.
            // Skip the stack for both immune AND resist heroes (the
            // poison set currently only declares immunes — zombie /
            // robot — but the resist check is here for symmetry if
            // the table grows later).
            if (!immune && !resist && !(Monsters && Monsters.isHydraMonsterVictim && Monsters.isHydraMonsterVictim(tgt))) {
              if (Characters.applyDebuff) Characters.applyDebuff(tgt, "poison", t);
            }
            effects.push({ kind: "hydraPoisonSplash", x: p.x, y: p.y,
                           born: t, until: t + 420 });
            Scene.shake(1.2, 110);
          } else {
            effects.push({
              kind: "hit",
              x: p.x, y: p.y,
              // Sparks fly opposite the projectile's incoming direction
              // (so an arrow from the left throws sparks to the right).
              vx: p.vx, vy: p.vy,
              sparks: makeSparks(5),
              born: t, until: t + 220,
            });
            Scene.shake(0.8, 80);
          }
          projectiles.splice(i, 1);
          continue;
        }
      }
      // Fire that misses: when a spit projectile expires past the
      // hero or runs out of TTL it splashes harmlessly on the ground
      // instead of vanishing — sells "you dodged that".
      if (p.kind === "fire" || p.kind === "hydraAcid" ||
          p.kind === "hydraIce" || p.kind === "hydraPoison") {
        const offGround = p.y > Scene.FLOOR_BOTTOM - 4;
        const offScreen = p.x < -30 || p.x > Scene.WIDTH + 30 || p.y > Scene.HEIGHT + 30;
        if (p.ttl <= 0 || offGround || offScreen) {
          if (offGround && !offScreen) {
            const px = Math.max(8, Math.min(Scene.WIDTH - 8, p.x));
            const py = Math.min(Scene.FLOOR_BOTTOM - 2, p.y);
            if (p.kind === "fire") {
              effects.push({ kind: "fireSplash", x: px, y: py,
                             sparks: makeSparks(5), born: t, until: t + 360, tiny: true });
            } else if (p.kind === "hydraAcid") {
              effects.push({ kind: "hydraAcidSplash", x: px, y: py, born: t, until: t + 360 });
            } else if (p.kind === "hydraIce") {
              effects.push({ kind: "hydraIceSplash", x: px, y: py, born: t, until: t + 400 });
            } else if (p.kind === "hydraPoison") {
              effects.push({ kind: "hydraPoisonSplash", x: px, y: py, born: t, until: t + 360 });
            }
          }
          projectiles.splice(i, 1);
          continue;
        }
      }
      if (p.ttl <= 0 ||
          p.x < -30 || p.x > Scene.WIDTH + 30 ||
          p.y < -30 || p.y > Scene.HEIGHT + 30) {
        projectiles.splice(i, 1);
      }
    }

    for (let i = effects.length - 1; i >= 0; i--) {
      if (t > effects[i].until) effects.splice(i, 1);
    }
  }

  // ----- rendering ------------------------------------------------------

  function draw(ctx, t) {
    // Projectiles
    for (const p of projectiles) {
      // Hold pre-armed meteors invisible until their stagger fires.
      if (p.armAt && t < p.armAt) continue;
      drawProjectile(ctx, p, t);
    }
    // Effects drawn on top so hit flashes read clearly
    for (const e of effects) drawEffect(ctx, e, t);
    // HP bars
    for (const c of Characters.list) {
      if (!Characters.isVisibleNow(c)) continue;
      if (c.hp > 0 && c.hp < c.maxHp) {
        drawHpBar(ctx, Math.round(c.x), Math.round(c.y) - 36,
                  c.hp / c.maxHp, "#62d162");
      }
    }
    for (const m of Monsters.list) {
      if (m.dying) continue;
      if (Monsters.isHidden && Monsters.isHidden(m)) continue;
      if (m.hp < m.maxHp) {
        drawHpBar(ctx, Math.round(m.x), Math.round(m.y) - m.h - 6,
                  m.hp / m.maxHp, "#d16262");
      }
    }
  }

  function drawProjectile(ctx, p, t) {
    const x = Math.round(p.x), y = Math.round(p.y);
    switch (p.kind) {
      case "arrow": {
        // Streak the shaft along the actual flight direction so a
        // diagonal shot doesn't look like a horizontal twig.  The
        // unit vector is the flight direction (forward); negative
        // unit is the trail.  Rounding to integer endpoints keeps
        // the line crisp on the pixel grid.
        const lenA = Math.hypot(p.vx, p.vy) || 1;
        const fx = p.vx / lenA, fy = p.vy / lenA;
        const tx2 = Math.round(x - fx * 5), ty2 = Math.round(y - fy * 5);
        const hx2 = Math.round(x + fx * 4), hy2 = Math.round(y + fy * 4);
        // Faint motion-blur after-image stretching back from the
        // tail (a long brown smear at low alpha).
        ctx.strokeStyle = "rgba(80,55,30,0.45)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(Math.round(x - fx * 11), Math.round(y - fy * 11));
        ctx.lineTo(tx2, ty2);
        ctx.stroke();
        // Solid shaft.
        ctx.strokeStyle = "#8a5a2a";
        ctx.beginPath();
        ctx.moveTo(tx2, ty2);
        ctx.lineTo(hx2, hy2);
        ctx.stroke();
        // Steel arrowhead at the tip.
        ctx.fillStyle = "#cccccc";
        ctx.fillRect(hx2, hy2, 2, 1);
        ctx.fillRect(hx2, hy2 - 1, 1, 1);
        // White fletching at the tail (two pips perpendicular to
        // the flight axis so they read as feathers from any angle).
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(Math.round(tx2 - fy), Math.round(ty2 + fx), 1, 1);
        ctx.fillRect(Math.round(tx2 + fy), Math.round(ty2 - fx), 1, 1);
        break;
      }
      case "fireball": {
        const flick = Math.floor(t / 80) % 2;
        ctx.fillStyle = "#ff9523";
        ctx.fillRect(x - 3, y - 3, 6, 6);
        ctx.fillStyle = "#ffd142";
        ctx.fillRect(x - 2, y - 2, 4, 4);
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(x - 1 + flick, y - 1, 2, 2);
        // trail
        ctx.fillStyle = "rgba(255,100,30,0.5)";
        ctx.fillRect(x - 6, y - 1, 3, 2);
        break;
      }
      case "meteor": {
        // Bigger fiery chunk than a fireball, with a long trail in
        // the direction OPPOSITE the velocity so the streak reads as
        // motion blur for an object hurtling down from the sky.  The
        // trail tapers off in three colour-darkening, alpha-fading
        // segments.
        const flick = Math.floor(t / 50) % 2;
        const len = Math.hypot(p.vx, p.vy) || 1;
        const ux = -p.vx / len, uy = -p.vy / len;     // unit vector backward
        // Trail (drawn first so the head pixel sits on top).
        ctx.fillStyle = "rgba(255,160,40,0.55)";
        ctx.fillRect(Math.round(x + ux * 4) - 2, Math.round(y + uy * 4) - 2, 4, 4);
        ctx.fillStyle = "rgba(255,90,30,0.4)";
        ctx.fillRect(Math.round(x + ux * 9) - 2, Math.round(y + uy * 9) - 2, 4, 4);
        ctx.fillStyle = "rgba(180,40,20,0.25)";
        ctx.fillRect(Math.round(x + ux * 14) - 2, Math.round(y + uy * 14) - 2, 4, 4);
        ctx.fillStyle = "rgba(120,30,15,0.15)";
        ctx.fillRect(Math.round(x + ux * 20) - 1, Math.round(y + uy * 20) - 1, 3, 3);
        // Head: bright orange shell, yellow core, white-hot pip that
        // flickers on/off so the chunk visibly burns.
        ctx.fillStyle = "#ff5418";
        ctx.fillRect(x - 4, y - 4, 8, 8);
        ctx.fillStyle = "#ff9523";
        ctx.fillRect(x - 3, y - 3, 6, 6);
        ctx.fillStyle = "#ffd142";
        ctx.fillRect(x - 2, y - 2, 4, 4);
        if (flick) {
          ctx.fillStyle = "#ffffff";
          ctx.fillRect(x - 1, y - 1, 2, 2);
        }
        break;
      }
      case "shuriken": {
        // Spinning star with a silver after-image trail.  Two trail
        // ghosts behind the head at fading alpha give the visible
        // sense of fast rotation through space, like a saw blade
        // motion-blur in pixel art.
        const lenS = Math.hypot(p.vx, p.vy) || 1;
        const ux2 = -p.vx / lenS, uy2 = -p.vy / lenS;
        // Ghost 1 (close, brighter).
        ctx.fillStyle = "rgba(200,200,210,0.55)";
        ctx.fillRect(Math.round(x + ux2 * 4) - 2, Math.round(y + uy2 * 4) - 2, 4, 4);
        // Ghost 2 (further, dimmer).
        ctx.fillStyle = "rgba(180,180,190,0.30)";
        ctx.fillRect(Math.round(x + ux2 * 8) - 1, Math.round(y + uy2 * 8) - 1, 3, 3);
        // 4-frame rotating star — alternates between an upright "+"
        // and a 45° "×" so the eye reads continuous spin.
        const spin = Math.floor(t / 35) % 4;
        ctx.fillStyle = "#d0d0d0";
        if (spin === 0 || spin === 2) {
          // Upright cross.
          ctx.fillRect(x - 2, y, 4, 1);
          ctx.fillRect(x, y - 2, 1, 4);
        } else {
          // Diagonal cross (saltire).
          ctx.fillRect(x - 2, y - 2, 1, 1);
          ctx.fillRect(x - 1, y - 1, 1, 1);
          ctx.fillRect(x + 1, y + 1, 1, 1);
          ctx.fillRect(x + 2, y + 2, 1, 1);
          ctx.fillRect(x + 2, y - 2, 1, 1);
          ctx.fillRect(x + 1, y - 1, 1, 1);
          ctx.fillRect(x - 1, y + 1, 1, 1);
          ctx.fillRect(x - 2, y + 2, 1, 1);
        }
        // White centre pip — keeps the silhouette grounded.
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(x, y, 1, 1);
        break;
      }
      case "hex": {
        // Witch's hex bolt: a pulsing purple core with two trailing
        // sparks that lag behind in the flight direction.  The
        // sparks alternate between cool magenta and a deeper violet
        // so the trail visually "scintillates" rather than being a
        // flat smear.
        const lenH = Math.hypot(p.vx, p.vy) || 1;
        const uxH = -p.vx / lenH, uyH = -p.vy / lenH;
        const pulse = Math.floor(t / 100) % 2;
        // Trailing magic sparks.
        ctx.fillStyle = "rgba(180,90,255,0.55)";
        ctx.fillRect(Math.round(x + uxH * 4) - 1, Math.round(y + uyH * 4) - 1, 2, 2);
        ctx.fillStyle = "rgba(120,60,200,0.35)";
        ctx.fillRect(Math.round(x + uxH * 8) - 1, Math.round(y + uyH * 8) - 1, 2, 2);
        ctx.fillStyle = "rgba(80,30,140,0.20)";
        ctx.fillRect(Math.round(x + uxH * 12), Math.round(y + uyH * 12), 1, 1);
        // Two perpendicular orbital pips wobbling around the head —
        // gives a hint of "this thing is alive" without rotating.
        const phx = Math.round(Math.sin(t / 60) * 3);
        const phy = Math.round(Math.cos(t / 60) * 3);
        ctx.fillStyle = "rgba(220,170,255,0.7)";
        ctx.fillRect(x + phx, y + phy, 1, 1);
        ctx.fillRect(x - phx, y - phy, 1, 1);
        // Core (pulsing violet) + bright white inner pip.
        ctx.fillStyle = pulse ? "#b45aff" : "#7a3ad0";
        ctx.fillRect(x - 2, y - 2, 4, 4);
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(x - 1, y - 1, 2, 2);
        break;
      }
      case "fire": {
        // Hydra fire lob: a flickering ball of orange flame with a
        // smoky trail.  Outer red glow + bright orange core + white-
        // hot inner pip so the projectile reads as a fireball at any
        // distance.  The flicker per-frame sells "alive flame".
        const lenAc = Math.hypot(p.vx, p.vy) || 1;
        const uxAc = -p.vx / lenAc, uyAc = -p.vy / lenAc;
        const wob = Math.floor(t / 80) % 2;
        // Smoke / ember trail (two fading pips behind the main ball).
        ctx.fillStyle = "rgba(220,120,40,0.50)";
        ctx.fillRect(Math.round(x + uxAc * 5) - 1, Math.round(y + uyAc * 5) - 1, 2, 2);
        ctx.fillStyle = "rgba(120,80,40,0.30)";
        ctx.fillRect(Math.round(x + uxAc * 10), Math.round(y + uyAc * 10), 1, 1);
        // Outer dim red glow.
        ctx.fillStyle = "rgba(255,90,40,0.55)";
        ctx.fillRect(x - 3, y - 3, 6, 6);
        // Mid orange body.
        ctx.fillStyle = "#ff8a2a";
        ctx.fillRect(x - 2, y - 2, 4, 4);
        // Bright yellow core (jitters by 1 px to flicker).
        ctx.fillStyle = "#ffe070";
        ctx.fillRect(x - 1 + wob, y - 1, 2, 2);
        // White-hot inner pip.
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(x, y, 1, 1);
        break;
      }
      case "hydraAcid": {
        // Slow green blob with a viscous wobble.
        const wob = Math.floor(t / 100) % 2;
        ctx.fillStyle = "rgba(80,200,40,0.45)";
        ctx.fillRect(x - 4, y - 4, 8, 8);
        ctx.fillStyle = "#60d820";
        ctx.fillRect(x - 3, y - 3, 6, 6);
        ctx.fillStyle = "#a0f050";
        ctx.fillRect(x - 2 + wob, y - 2, 3, 3);
        ctx.fillStyle = "#d8ffb0";
        ctx.fillRect(x - 1, y - 1, 2, 2);
        break;
      }
      case "hydraIce": {
        // Pale blue crystal shard.
        const icicle = Math.floor(t / 120) % 2;
        ctx.fillStyle = "rgba(140,220,255,0.45)";
        ctx.fillRect(x - 3, y - 3, 6, 6);
        ctx.fillStyle = "#90d8ff";
        ctx.fillRect(x - 2, y - 2, 4, 4);
        ctx.fillStyle = "#d0f0ff";
        ctx.fillRect(x - 1 + icicle, y - 1, 2, 2);
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(x, y, 1, 1);
        break;
      }
      case "hydraPoison": {
        // Fast violet ball with a wisp trail.
        const lenP = Math.hypot(p.vx, p.vy) || 1;
        const uxP = -p.vx / lenP, uyP = -p.vy / lenP;
        ctx.fillStyle = "rgba(200,60,255,0.35)";
        ctx.fillRect(Math.round(x + uxP * 5) - 1, Math.round(y + uyP * 5) - 1, 2, 2);
        ctx.fillStyle = "rgba(200,60,255,0.50)";
        ctx.fillRect(x - 3, y - 3, 6, 6);
        ctx.fillStyle = "#c040ff";
        ctx.fillRect(x - 2, y - 2, 4, 4);
        ctx.fillStyle = "#e8a0ff";
        ctx.fillRect(x - 1, y - 1, 2, 2);
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(x, y, 1, 1);
        break;
      }
      case "laser": {
        // Alien sidearm bolt: red glow halo around a white-hot core,
        // with a long fading red afterglow streak behind so a fast
        // laser still reads as a continuous beam-line in the eye.
        const lenL = Math.hypot(p.vx, p.vy) || 1;
        const fxL = p.vx / lenL, fyL = p.vy / lenL;
        const x1 = Math.round(x - fxL * 14), y1 = Math.round(y - fyL * 14);
        const x2 = Math.round(x + fxL * 5),  y2 = Math.round(y + fyL * 5);
        // Outer red glow, drawn as a thicker dim line.
        ctx.strokeStyle = "rgba(255,60,60,0.35)";
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
        // Mid red beam.
        ctx.strokeStyle = "#ff4040";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(Math.round(x - fxL * 9), Math.round(y - fyL * 9));
        ctx.lineTo(x2, y2);
        ctx.stroke();
        // Hot white core at the head.
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(Math.round(x - fxL * 2) - 1, Math.round(y - fyL * 2) - 1, 4, 2);
        ctx.lineWidth = 1;
        break;
      }
    }
  }

  function drawEffect(ctx, e, t) {
    const a = 1 - (t - e.born) / (e.until - e.born);
    const x = Math.round(e.x), y = Math.round(e.y);
    switch (e.kind) {
      case "hit": {
        // Yellow flash core + cross spike (kept from the original
        // version) so the impact point still pops at frame 1.
        ctx.fillStyle = `rgba(255,255,120,${a})`;
        ctx.fillRect(x - 3, y - 3, 6, 6);
        ctx.fillStyle = `rgba(255,255,255,${a})`;
        ctx.fillRect(x - 1, y - 4, 2, 8);
        ctx.fillRect(x - 4, y - 1, 8, 2);
        // Spark shower: each spark integrates its own ballistic arc
        // over the effect's lifetime so the burst reads as PARTICLES
        // flying outward, not a static splat.  A bit of gravity
        // pulls them down toward the end so they curve into a fan.
        if (e.sparks) {
          const lifeS = (t - e.born) / 1000;
          const lifeT = (t - e.born) / Math.max(1, e.until - e.born);
          const grav = 220;
          for (const s of e.sparks) {
            const sx = x + s.vx * lifeS;
            const sy = y + s.vy * lifeS + 0.5 * grav * lifeS * lifeS;
            const sa = Math.max(0, 1 - lifeT * 1.1);
            ctx.fillStyle = `rgba(255,210,90,${sa})`;
            ctx.fillRect(Math.round(sx), Math.round(sy), s.size, s.size);
            // Tiny white tip on bigger sparks for an extra bit of
            // glint.
            if (s.size > 1) {
              ctx.fillStyle = `rgba(255,255,255,${sa * 0.9})`;
              ctx.fillRect(Math.round(sx), Math.round(sy), 1, 1);
            }
          }
        }
        break;
      }
      case "bite": {
        // Red impact gash (the original 2-bar shape so existing
        // bites still read the same first frame), now followed by
        // 3 blood droplets arcing AWAY from the attacker.
        const p = (t - e.born) / Math.max(1, e.until - e.born);
        const pp = Math.max(0, Math.min(1, p));
        const baseA = 1 - pp;
        ctx.fillStyle = `rgba(255,80,80,${baseA})`;
        ctx.fillRect(x - 5, y - 2, 10, 2);
        ctx.fillRect(x - 2, y - 5, 4, 2);
        // Droplets: short ballistic arcs that pick up gravity, with a
        // longer-lived 1-px ground splat once they've landed.  `side`
        // is +1 / -1 (which way the bite came from) so the spray fans
        // out OVER the victim rather than back into the attacker's
        // mouth.
        const side = e.side || 1;
        const lifeS = (t - e.born) / 1000;
        const grav = 320;
        const drops = [
          { vx: side * 70, vy: -55 },
          { vx: side * 95, vy: -25 },
          { vx: side * 45, vy: -75 },
        ];
        for (const d of drops) {
          const dx = d.vx * lifeS;
          const dy = d.vy * lifeS + 0.5 * grav * lifeS * lifeS;
          // Cap at ground (~+4 below the bite point) so droplets
          // don't fall off the world.
          const px = Math.round(x + dx);
          const py = Math.round(y + Math.min(dy, 6));
          ctx.fillStyle = `rgba(180,30,30,${baseA})`;
          ctx.fillRect(px, py, 2, 2);
          ctx.fillStyle = `rgba(120,20,20,${baseA * 0.9})`;
          ctx.fillRect(px, py + 1, 1, 1);
        }
        break;
      }
      case "slash": {
        // Sword swing: a curved arc traced by 4 motion-blurred
        // segments, fading from leading-edge bright white to a soft
        // tail; an impact flash + sparks land in the final third of
        // the effect.  Two variants:
        //   • "steel" (default, knight) — bright white edge, cool
        //     blue-grey tail, gold sparks on impact.
        //   • "rust" (zombie) — duller bone-white edge, sickly
        //     green-grey tail, dark crimson sparks.
        // The arc is a pivot-based polar swing: pivot at (sx, sy)
        // (the attacker's hand), the blade tip rotates ~110° from
        // BEHIND the attacker through to the target.  The geometry
        // is read straight off `dir` so the same effect works for
        // both facings without a left-mirror branch.
        const s   = e.dir === "r" ? 1 : -1;
        const px  = e.sx, py = e.sy;
        const tx  = e.x, ty = e.y;
        const p   = (t - e.born) / Math.max(1, e.until - e.born);
        const pp  = Math.max(0, Math.min(1, p));
        // Distance pivot → target sets the arc radius; clamp so a
        // very short reach still draws a readable arc.
        const dx0 = tx - px, dy0 = ty - py;
        const reach = Math.max(14, Math.hypot(dx0, dy0));
        // Angle to target from pivot — we land the LEAD segment
        // exactly here at impact.
        const aT  = Math.atan2(dy0, dx0 * s);
        // Arc swings ~110° back from the impact angle; ease-in (pp²)
        // makes the windup slower than the fast snap into the
        // target, matching the way a sword feels on screen.
        const span = (110 * Math.PI) / 180;
        const ep   = pp * pp;
        const aLead = aT - (1 - ep) * span;
        // Palette per variant.
        const isRust = e.variant === "rust";
        const edgeR = isRust ? 220 : 250, edgeG = isRust ? 245 : 250, edgeB = isRust ? 200 : 255;
        const tailR = isRust ? 130 : 200, tailG = isRust ? 160 : 220, tailB = isRust ? 110 : 255;
        // Draw 4 trail segments behind the lead, each one shorter
        // and more transparent.  Each segment is a 2-px-thick strip
        // tangent to the arc at its angle.
        const segs = 4;
        const segGap = 0.18;                              // radians between segments
        for (let k = 0; k < segs; k++) {
          const ak = aLead - k * segGap;
          // Trail visibility fades both with k and with overall
          // life so the arc sweeps through and dies cleanly.
          const segFade = (1 - k / segs) * (1 - pp * 0.8);
          if (segFade <= 0.05) continue;
          // Inner / outer points along the radius give the segment
          // its 2-px thickness without per-pixel rasterising.
          const r1 = reach * 0.55, r2 = reach * 1.0;
          const cx1 = Math.round(px + Math.cos(ak) * r1 * s);
          const cy1 = Math.round(py + Math.sin(ak) * r1);
          const cx2 = Math.round(px + Math.cos(ak) * r2 * s);
          const cy2 = Math.round(py + Math.sin(ak) * r2);
          // Outer (bright edge) — leading segment stays whitest.
          const edgeA = (k === 0 ? 1.0 : 0.7) * segFade;
          ctx.strokeStyle = `rgba(${edgeR},${edgeG},${edgeB},${edgeA})`;
          ctx.lineWidth = (k === 0) ? 2 : 1;
          ctx.beginPath();
          ctx.moveTo(cx1, cy1);
          ctx.lineTo(cx2, cy2);
          ctx.stroke();
          // Tail wash on the inner side — gives the arc visible
          // depth instead of being a single pixel line.
          if (k > 0) {
            const tailA = 0.4 * segFade;
            ctx.strokeStyle = `rgba(${tailR},${tailG},${tailB},${tailA})`;
            ctx.lineWidth = 2;
            const cmx = Math.round((cx1 + cx2) / 2);
            const cmy = Math.round((cy1 + cy2) / 2);
            ctx.beginPath();
            ctx.moveTo(cx1, cy1);
            ctx.lineTo(cmx, cmy);
            ctx.stroke();
          }
        }
        ctx.lineWidth = 1;
        // Impact: yellow/crimson flash + a small spray of sparks at
        // the target during the last third of the effect.
        if (pp > 0.55) {
          const ia = (pp - 0.55) / 0.45;                   // 0 → 1 across impact
          const fa = 1 - ia;
          const ir = Math.round(2 + ia * 5);
          const flashR = isRust ? 200 : 255, flashG = isRust ? 220 : 240, flashB = isRust ? 90 : 120;
          ctx.fillStyle = `rgba(${flashR},${flashG},${flashB},${fa})`;
          ctx.fillRect(tx - ir, ty - 2, ir * 2, 4);
          ctx.fillRect(tx - 2, ty - ir, 4, ir * 2);
          ctx.fillStyle = `rgba(255,255,255,${fa * 0.9})`;
          ctx.fillRect(tx - 1, ty - 1, 2, 2);
          // Four corner sparks growing outward.
          const sd = 3 + Math.round(ia * 4);
          const sparkR = isRust ? 130 : 255, sparkG = isRust ? 50 : 200, sparkB = isRust ? 50 : 70;
          ctx.fillStyle = `rgba(${sparkR},${sparkG},${sparkB},${fa})`;
          ctx.fillRect(tx - sd - 1, ty - sd, 2, 1);
          ctx.fillRect(tx + sd - 1, ty - sd, 2, 1);
          ctx.fillRect(tx - sd - 1, ty + sd, 2, 1);
          ctx.fillRect(tx + sd - 1, ty + sd, 2, 1);
        }
        break;
      }
      case "stab": {
        // Three-phase katana plunge into a worm mound:
        //   plunge  (0.00..0.30): blade slides DOWN from above
        //   hold    (0.30..0.65): blade frozen, soil burst around it
        //   pullout (0.65..1.00): blade rises and fades
        const p = (t - e.born) / Math.max(1, e.until - e.born);
        const pp = Math.max(0, Math.min(1, p));
        const sideDx = (e.side || -1) * 0.6;   // hilt leans toward attacker
        let yOff;
        if (pp < 0.30) yOff = -10 + (10 * pp / 0.30);
        else if (pp < 0.65) yOff = 0;
        else yOff = -12 * ((pp - 0.65) / 0.35);
        const fade = pp < 0.65 ? 1 : (1 - (pp - 0.65) / 0.35);
        const ax = ctx.globalAlpha;
        ctx.globalAlpha = ax * fade;
        const bx = Math.round(x + sideDx);
        const by = Math.round(y + yOff);
        // Blade — bright steel column.
        ctx.fillStyle = "rgba(235,238,250,1)";
        ctx.fillRect(bx, by - 16, 1, 12);
        // Edge highlight — a single pixel offset for "shine".
        ctx.fillStyle = "rgba(255,255,255,1)";
        ctx.fillRect(bx, by - 14, 1, 4);
        // Tsuba (handguard) — a 3-pixel crossbar at the top of the
        // blade so the silhouette reads as a sword and not a needle.
        ctx.fillStyle = "rgba(180,150,40,1)";
        ctx.fillRect(bx - 1, by - 17, 3, 1);
        // Grip — a stubby wrapped handle above the guard.
        ctx.fillStyle = "rgba(80,30,30,1)";
        ctx.fillRect(bx, by - 20, 1, 3);
        // Soil eruption while the blade is buried.
        if (pp > 0.25 && pp < 0.7) {
          const burst = Math.min(1, (pp - 0.25) / 0.15);
          ctx.fillStyle = `rgba(125,95,60,${0.7 * burst})`;
          ctx.fillRect(bx - 3, by - 1, 1, 1);
          ctx.fillRect(bx - 2, by - 2, 1, 1);
          ctx.fillRect(bx + 2, by - 1, 1, 1);
          ctx.fillRect(bx + 3, by - 2, 1, 1);
        }
        ctx.globalAlpha = ax;
        break;
      }
      case "axe": {
        // Dwarf's overhead chop.  The axe head tracks a quadratic arc
        // from above-behind the shoulder, down and forward onto the
        // target.  Motion-blur streak trails the head through the
        // middle of the swing; a yellow chop-flash + wood chips land
        // in the final quarter of the effect's lifetime.
        const p = 1 - a;                  // progress 0 → 1
        const s = e.dir === "r" ? 1 : -1; // horizontal facing
        const sx = e.sx, sy = e.sy;
        const tx = e.x, ty = e.y;

        // Quadratic bezier: start above-behind the shoulder, mid
        // control point raised overhead, end on the target.  Ease-in
        // (p*p) makes the windup slower than the impact.
        const ep = p * p;
        const startX = sx - s * 6, startY = sy - 8;
        const midX   = sx + s * 4, midY   = sy - 18;
        const endX   = tx,         endY   = ty;
        const u = 1 - ep;
        const ax = u * u * startX + 2 * u * ep * midX + ep * ep * endX;
        const ay = u * u * startY + 2 * u * ep * midY + ep * ep * endY;
        const axR = Math.round(ax), ayR = Math.round(ay);

        // Handle points from the dwarf's shoulder toward the axe head.
        const dirx = ax - sx, diry = ay - sy;
        const dmag = Math.hypot(dirx, diry) || 1;
        const ux = dirx / dmag, uy = diry / dmag;
        const handleLen = 10;
        const hx = Math.round(ax - ux * handleLen);
        const hy = Math.round(ay - uy * handleLen);

        // Motion trail behind the axe head during the fast middle of
        // the swing — a short fading stripe.
        if (p > 0.3 && p < 0.85) {
          const trailA = 0.8 - Math.abs(p - 0.55) * 1.6;
          ctx.strokeStyle = `rgba(230,230,255,${Math.max(0, trailA)})`;
          ctx.lineWidth = 2;
          const backX = Math.round(ax - ux * 9);
          const backY = Math.round(ay - uy * 9);
          ctx.beginPath();
          ctx.moveTo(backX, backY);
          ctx.lineTo(axR, ayR);
          ctx.stroke();
          ctx.lineWidth = 1;
        }

        // Wooden handle.
        ctx.strokeStyle = "#8a5a2a";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(hx, hy);
        ctx.lineTo(axR, ayR);
        ctx.stroke();
        ctx.lineWidth = 1;

        // Axe head: pixel block with a highlight stripe.  Orient the
        // blade so it points in the swing direction (perpendicular to
        // the handle, roughly).
        const px = -uy, py = ux;
        const bx = axR + Math.round(px * 2);
        const by = ayR + Math.round(py * 2);
        ctx.fillStyle = "#c8c8c8";
        ctx.fillRect(bx - 3, by - 3, 6, 5);
        ctx.fillStyle = "#eaeaea";
        ctx.fillRect(bx - 2, by - 2, 4, 2);
        ctx.fillStyle = "#6e6e6e";
        ctx.fillRect(bx - 3, by + 1, 6, 1);

        // Impact flash + wood chips in the final quarter.
        if (p > 0.75) {
          const ia = (p - 0.75) / 0.25;   // 0 → 1 across impact
          const ir = Math.round(2 + ia * 6);
          const fa = 1 - ia;
          ctx.fillStyle = `rgba(255,240,120,${fa})`;
          ctx.fillRect(tx - ir, ty - 2, ir * 2, 4);
          ctx.fillRect(tx - 2, ty - ir, 4, ir * 2);
          ctx.fillStyle = `rgba(255,255,255,${fa})`;
          ctx.fillRect(tx - 2, ty - 2, 4, 4);
          ctx.fillStyle = `rgba(170,110,50,${fa})`;
          const cd = 3 + Math.round(ia * 4);
          ctx.fillRect(tx - cd - 2, ty - cd, 2, 2);
          ctx.fillRect(tx + cd,     ty - cd, 2, 2);
          ctx.fillRect(tx - cd,     ty + cd - 2, 2, 2);
          ctx.fillRect(tx + cd - 2, ty + cd, 2, 2);
        }
        break;
      }
      case "pow": {
        // Comic-book impact burst — a yellow star-ish splat with a
        // white hot centre, a growing 8-spoke spike halo and four
        // diagonal sparks that fly out as the effect plays.  Used by
        // the robot's punch.
        const grow = 1 - a; // 0 → 1 over the effect's lifetime
        const r = 3 + Math.round(grow * 3);
        // Eight-spoke star halo (4 cardinal + 4 diagonal) that grows
        // and fades.  Reads as a comic-book "BIFF!" without needing
        // an actual letter sprite.
        const haloR = 4 + Math.round(grow * 6);
        const haloA = (1 - grow) * 0.85 + a * 0.15;
        ctx.fillStyle = `rgba(255,200,50,${haloA})`;
        // Cardinal spikes (1-px thick lines extending outward).
        ctx.fillRect(x - 1,        y - haloR,    2, haloR - 2);   // up
        ctx.fillRect(x - 1,        y + 2,        2, haloR - 2);   // down
        ctx.fillRect(x - haloR,    y - 1,        haloR - 2, 2);   // left
        ctx.fillRect(x + 2,        y - 1,        haloR - 2, 2);   // right
        // Diagonal spikes (stair-stepped 2x2 pips marching outward).
        const dSteps = Math.max(0, haloR - 3);
        for (let k = 1; k <= dSteps; k++) {
          ctx.fillRect(x - k - 1, y - k - 1, 2, 1);
          ctx.fillRect(x + k - 1, y - k - 1, 2, 1);
          ctx.fillRect(x - k - 1, y + k,     2, 1);
          ctx.fillRect(x + k - 1, y + k,     2, 1);
        }
        // Inner cross flash.
        ctx.fillStyle = `rgba(255,220,70,${a})`;
        ctx.fillRect(x - r, y - 2, r * 2, 4);
        ctx.fillRect(x - 2, y - r, 4, r * 2);
        ctx.fillStyle = `rgba(255,255,255,${a})`;
        ctx.fillRect(x - 2, y - 2, 4, 4);
        // Diagonal sparks shooting outward (smaller, faster than the
        // halo so they read as discrete debris, not part of the star).
        const sp = 2 + Math.round(grow * 4);
        ctx.fillStyle = `rgba(255,180,40,${a})`;
        ctx.fillRect(x - r - sp,     y - r - sp,     2, 2);
        ctx.fillRect(x + r + sp - 2, y - r - sp,     2, 2);
        ctx.fillRect(x - r - sp,     y + r + sp - 2, 2, 2);
        ctx.fillRect(x + r + sp - 2, y + r + sp - 2, 2, 2);
        // White-hot pip in the very centre — the "punch landed" core.
        ctx.fillStyle = `rgba(255,255,255,${a * 0.9})`;
        ctx.fillRect(x - 1, y - 1, 2, 2);
        break;
      }
      case "explode": {
        // Layered pixel-art explosion:
        //   • opening flash (~first 60ms): big bright white-hot core
        //     so the impact frame really pops;
        //   • shockwave ring expanding to roughly the splash radius
        //     `e.r` (defaults to 16 for older callers without one),
        //     so the player can SEE the AoE that just hit;
        //   • shrinking orange/yellow fireball at the centre;
        //   • ballistic embers (`e.embers`) flying outward with
        //     gravity, leaving glowing 1-2 px trails.
        // All four pieces are driven from the same life fraction `p`
        // so the explosion has visible phases instead of one flat
        // shrink-and-fade.
        const p   = (t - e.born) / Math.max(1, e.until - e.born);
        const pp  = Math.max(0, Math.min(1, p));
        const fa  = 1 - pp;
        const blastR = e.r || 16;

        // 1) Opening flash — a bright square that fades out fast in
        // the first ~25 % of the effect.  Without this the explosion
        // starts already mid-shrink and looks weak.
        if (pp < 0.25) {
          const fla = (1 - pp / 0.25);
          const fr  = Math.round(6 + fla * 4);
          ctx.fillStyle = `rgba(255,250,210,${fla * 0.9})`;
          ctx.fillRect(x - fr, y - fr, fr * 2, fr * 2);
          ctx.fillStyle = `rgba(255,255,255,${fla * 0.95})`;
          ctx.fillRect(x - 2, y - 2, 4, 4);
        }

        // 2) Shockwave ring — 1-px outline of an axis-aligned square
        // (cheap pixel-art ellipse stand-in) that grows from a few
        // pixels out to `blastR` over the lifetime, fading as it
        // expands.  Uses a hint of yellow→orange shift so it reads
        // as fire, not an alien laser ring.
        const ringR = Math.round(3 + (blastR - 3) * pp);
        const ringA = fa * 0.85;
        ctx.fillStyle = `rgba(255,200,90,${ringA})`;
        ctx.fillRect(x - ringR, y - ringR,     ringR * 2, 1);
        ctx.fillRect(x - ringR, y + ringR - 1, ringR * 2, 1);
        ctx.fillRect(x - ringR,     y - ringR, 1, ringR * 2);
        ctx.fillRect(x + ringR - 1, y - ringR, 1, ringR * 2);

        // 3) Inner fireball — original shrinking orange/yellow blob,
        // kept so older call sites still see the familiar core but
        // wrapped inside the new flash + ring.
        const r = Math.round(8 * fa);
        if (r > 0) {
          ctx.fillStyle = `rgba(255,150,50,${fa})`;
          ctx.fillRect(x - r, y - r, r * 2, r * 2);
          ctx.fillStyle = `rgba(255,230,150,${fa * 0.85})`;
          const r2 = Math.max(1, Math.round(r * 0.6));
          ctx.fillRect(x - r2, y - r2, r2 * 2, r2 * 2);
        }

        // 4) Ember scatter — each ember's own ballistic arc, with
        // gravity pulling embers down so the explosion fans into a
        // dome rather than hovering.  Pre-rolled velocities keep the
        // shape stable across frames.
        if (e.embers) {
          const lifeS = (t - e.born) / 1000;
          const grav = 260;
          for (const em of e.embers) {
            const ex = x + em.vx * lifeS;
            const ey = y + em.vy * lifeS + 0.5 * grav * lifeS * lifeS;
            const ea = Math.max(0, fa);
            const col = em.hot
              ? `rgba(255,230,120,${ea})`
              : `rgba(255,120,40,${ea})`;
            ctx.fillStyle = col;
            ctx.fillRect(Math.round(ex), Math.round(ey), em.size, em.size);
            // Tiny dim trail: previous-tick position dimmed.
            if (lifeS > 0.05) {
              const lifeS0 = lifeS - 0.04;
              const ex0 = x + em.vx * lifeS0;
              const ey0 = y + em.vy * lifeS0 + 0.5 * grav * lifeS0 * lifeS0;
              ctx.fillStyle = `rgba(120,40,20,${ea * 0.5})`;
              ctx.fillRect(Math.round(ex0), Math.round(ey0), 1, 1);
            }
          }
        }
        break;
      }
      case "cast": {
        // Per-element muzzle flash: outer halo (cool wash), middle
        // mote (saturated colour), white-hot pip in the centre.
        // Falls back to the original violet ("magic" wisp) for any
        // unknown kind so older callers still look the same.
        let outer = "180,160,255";
        let mid   = "200,180,255";
        switch (e.weapon) {
          case "fireball": outer = "255,150, 60"; mid = "255,210,120"; break;
          case "hex":      outer = "180, 90,255"; mid = "200,140,255"; break;
          case "arrow":    outer = "120,200,140"; mid = "200,255,210"; break;
          case "shuriken": outer = "200,210,225"; mid = "240,245,255"; break;
          case "laser":    outer = "255, 80,120"; mid = "255,180,210"; break;
        }
        // Outer puff — slightly bigger and softer than the original
        // 4×4 square, with a tiny growth over the lifetime so it
        // reads as energy bursting outward.
        const g = 1 - a;
        const ro = 2 + Math.round(g * 2);
        ctx.fillStyle = `rgba(${outer},${a * 0.55})`;
        ctx.fillRect(x - ro, y - ro, ro * 2, ro * 2);
        // Inner saturated mote.
        ctx.fillStyle = `rgba(${mid},${a})`;
        ctx.fillRect(x - 2, y - 2, 4, 4);
        // 4 little spokes flicking outward in cardinal directions —
        // drawn only in the second half of the effect's life so the
        // flash visibly "pops" rather than just fading.
        if (g > 0.4) {
          const sp = 3 + Math.round((g - 0.4) * 4);
          ctx.fillStyle = `rgba(${mid},${a * 0.85})`;
          ctx.fillRect(x - 1, y - sp, 2, 1);
          ctx.fillRect(x - 1, y + sp - 1, 2, 1);
          ctx.fillRect(x - sp, y - 1, 1, 2);
          ctx.fillRect(x + sp - 1, y - 1, 1, 2);
        }
        // Hot white core (kept from the original).
        ctx.fillStyle = `rgba(255,255,255,${a})`;
        ctx.fillRect(x - 1, y - 1, 2, 2);
        break;
      }
      case "heal": {
        // Holy heal cue: a green "+" cross with a white-hot core
        // pulsing in the centre, four orbital sparkles spinning
        // around the patch, and a couple of rising green pips so the
        // upward "vital flow" still reads like the original effect.
        // Two pulses across the lifetime so the cross feels alive
        // instead of just fading out linearly.
        const p   = (t - e.born) / Math.max(1, e.until - e.born);
        const pp  = Math.max(0, Math.min(1, p));
        const fa  = 1 - pp;
        const pulse = 0.55 + 0.45 * Math.sin(pp * Math.PI * 2);
        // Cross: 5×5 plus a 3-px-wide arms.
        const crossA = fa * pulse;
        ctx.fillStyle = `rgba(120,230,120,${crossA})`;
        ctx.fillRect(x - 1, y - 4, 2, 9);                    // vertical
        ctx.fillRect(x - 4, y - 1, 9, 2);                    // horizontal
        ctx.fillStyle = `rgba(220,255,220,${crossA * 0.95})`;
        ctx.fillRect(x,     y - 3, 1, 7);                    // bright stroke
        ctx.fillRect(x - 3, y,     7, 1);
        ctx.fillStyle = `rgba(255,255,255,${crossA})`;
        ctx.fillRect(x - 1, y - 1, 2, 2);                    // hot core
        // Orbital sparkles — 4 cardinal pips spinning fast so the
        // cross looks energised, not static.  Tied to wall-clock so
        // they keep moving even when the alpha is low.
        const ang = (t / 60) % (Math.PI * 2);
        for (let k = 0; k < 4; k++) {
          const a2 = ang + k * Math.PI / 2;
          const ox = x + Math.round(Math.cos(a2) * 7);
          const oy = y + Math.round(Math.sin(a2) * 5);
          ctx.fillStyle = `rgba(220,255,220,${fa})`;
          ctx.fillRect(ox, oy, 1, 1);
        }
        // Rising vital pips (the original "stream of green dots"
        // upward) so the buff still has its vertical motion read.
        const rise = Math.round(8 * (1 - a));
        ctx.fillStyle = `rgba(160,255,160,${a})`;
        ctx.fillRect(x - 1, y - rise, 2, 2);
        ctx.fillRect(x + 3, y + 4, 1, 1);
        ctx.fillRect(x - 5, y + 2, 1, 1);
        break;
      }
      case "lifesteal": {
        // Zombie's necromantic life-leech.  Same vertical-rise +
        // scattered-pip layout as the holy heal so the bookkeeping
        // is familiar, but recoloured in clotted dark crimson with
        // a faint sickly green underglow.  Adds an orbital pair of
        // dim green wisps and a soft inverted-cross core so the
        // visual reads as "stolen vitae" with a darker pulse than
        // the priest's heal — clearly the same family but obviously
        // the wrong kind of magic.
        const p     = (t - e.born) / Math.max(1, e.until - e.born);
        const pp    = Math.max(0, Math.min(1, p));
        const fa    = 1 - pp;
        const pulse = 0.55 + 0.45 * Math.sin(pp * Math.PI * 2);
        const rise  = Math.round(10 * (1 - a));
        // Inverted (downward-biased) cross: long bottom arm, short
        // top arm — visually distinct from the heal's symmetric +.
        const crossA = fa * pulse;
        ctx.fillStyle = `rgba(140,28,32,${crossA})`;
        ctx.fillRect(x - 1, y - 2, 2, 7);                    // long down stroke
        ctx.fillRect(x - 3, y - 1, 7, 2);                    // short cross
        ctx.fillStyle = `rgba(60,12,12,${crossA * 0.9})`;
        ctx.fillRect(x,     y - 1, 1, 6);
        ctx.fillStyle = `rgba(180,40,40,${crossA})`;
        ctx.fillRect(x - 1, y - 1, 2, 2);                    // dim crimson core
        // Orbital sickly-green wisps — only two (vs heal's four), at
        // half speed, to read as "weaker, wrong" magic.
        const ang = (t / 110) % (Math.PI * 2);
        for (let k = 0; k < 2; k++) {
          const a2 = ang + k * Math.PI;
          const ox = x + Math.round(Math.cos(a2) * 7);
          const oy = y + Math.round(Math.sin(a2) * 4);
          ctx.fillStyle = `rgba(140,200,120,${fa * 0.7})`;
          ctx.fillRect(ox, oy, 1, 1);
        }
        // Rising dark drops on the central axis (kept from the
        // original) so the upward "draw" still reads.
        ctx.fillStyle = `rgba(140,28,32,${a})`;
        ctx.fillRect(x - 1, y - rise,     2, 3);
        ctx.fillRect(x - 1, y - rise - 4, 2, 2);
        ctx.fillStyle = `rgba(94,52,18,${a * 0.85})`;
        ctx.fillRect(x - 5, y + 2, 2, 2);
        ctx.fillRect(x + 3, y + 4, 2, 2);
        ctx.fillRect(x - 3, y - 2, 2, 2);
        break;
      }
      case "drink": {
        ctx.fillStyle = `rgba(255,120,120,${a})`;
        ctx.fillRect(x - 1, y, 2, 3);
        ctx.fillStyle = `rgba(255,255,255,${a})`;
        ctx.fillRect(x - 2, y - 6, 1, 2);
        ctx.fillRect(x + 1, y - 4, 1, 2);
        break;
      }
      case "puff": {
        ctx.fillStyle = e.color || `rgba(220,220,220,${a})`;
        const r = Math.round(4 + 6 * (1 - a));
        ctx.fillRect(x - r, y - r / 2, r * 2, r);
        break;
      }
      case "dirtburst": {
        // Per-clod ballistic integration over the lifetime so each
        // pellet flies its own arc and tumbles to the ground —
        // visually a scattered shower instead of a single blob.
        const lifeMs = e.until - e.born;
        const lifeS = (t - e.born) / 1000;
        const lifeT = (t - e.born) / lifeMs;     // 0..1 normalized
        const grav = 240;                        // px/s² downward
        const dustA = Math.max(0, 1 - lifeT) * 0.35;
        // Soft low dust haze near the ground — narrower than the
        // old puff rectangle, thinner alpha, no hard edges.  Two
        // 1-px-tall strips give a pixel-art "billow".
        if (dustA > 0.02) {
          const dr = 4 + lifeT * 4;
          let dustRgb = e.dark ? "70,55,38" : "170,140,98";
          if (e.palette === "rock") dustRgb = "110,110,110";
          if (e.palette === "green") dustRgb = "74,120,48";
          ctx.fillStyle = `rgba(${dustRgb},${dustA})`;
          ctx.fillRect(x - dr,     y - 1, dr * 2,     1);
          ctx.fillRect(x - dr + 1, y,     dr * 2 - 2, 1);
        }
        // Clod palettes: light dirt for path, darker grass-mixed
        // soil for the lawn.  Two tones each so half the particles
        // get a brighter highlight pixel and the burst doesn't read
        // as one flat colour.
        const cMain = e.palette === "rock"
          ? "#6e6e6e"
          : (e.palette === "green" ? "#4a7d30" : (e.dark ? "#5a3d22" : "#a07a4a"));
        const cHi   = e.palette === "rock"
          ? "#a0a0a0"
          : (e.palette === "green" ? "#89c060" : (e.dark ? "#8a6038" : "#d6b482"));
        for (const c of e.clods) {
          // Clod hits the ground when its parabolic y returns to 0;
          // after that we leave it sitting where it fell, fading
          // out with the rest of the burst.
          const cy0 = c.y + c.vy * lifeS + 0.5 * grav * lifeS * lifeS;
          const cy = cy0 < 0 ? cy0 : Math.min(cy0, 6);
          const cx = c.x + c.vx * lifeS;
          // Tumble: alternate between main / highlight colour at a
          // few hertz per clod so each pellet "spins".
          const tumble = ((c.spin + lifeS * 8) | 0) & 1;
          const aClod = Math.max(0, 1 - lifeT * 1.05);
          let hiRgb = e.dark ? "138,96,56" : "214,180,130";
          let mainRgb = e.dark ? "90,61,34" : "160,122,74";
          if (e.palette === "rock") { hiRgb = "160,160,160"; mainRgb = "110,110,110"; }
          if (e.palette === "green") { hiRgb = "137,192,96"; mainRgb = "74,125,48"; }
          ctx.fillStyle = tumble
            ? `rgba(${hiRgb},${aClod})`
            : `rgba(${mainRgb},${aClod})`;
          ctx.fillRect(Math.round(x + cx), Math.round(y + cy), c.size, c.size);
        }
        break;
      }
      case "oilspritz": {
        // Two yellow droplets ride a low arc from the spout to the
        // robot.  Phase along the lifetime is the linear t-norm; we
        // subtract a 0.18 stagger for the trailing droplet so they
        // arrive in a quick "drip-drip" rhythm rather than as one
        // blob.  A sin-arc lifts the midpoint a few px so it reads
        // as squirted oil instead of a straight line.
        const life = (t - e.born) / (e.until - e.born);
        const dxArc = e.dstX - e.x, dyArc = e.dstY - e.y;
        function dropAt(p) {
          if (p < 0 || p > 1) return null;
          const px = e.x + dxArc * p;
          const py = e.y + dyArc * p - Math.sin(p * Math.PI) * 6;
          return { x: Math.round(px), y: Math.round(py) };
        }
        const d1 = dropAt(life);
        const d2 = dropAt(life - 0.18);
        ctx.fillStyle = `rgba(255,216,112,${0.95 * a})`;
        if (d1) ctx.fillRect(d1.x - 1, d1.y - 1, 2, 2);
        if (d2) ctx.fillRect(d2.x, d2.y, 1, 2);
        ctx.fillStyle = `rgba(255,248,196,${0.9 * a})`;
        if (d1) ctx.fillRect(d1.x, d1.y - 1, 1, 1);
        // A faint splash burst as the leading drop reaches the robot.
        if (life > 0.85) {
          const sa = (1 - (life - 0.85) / 0.15) * a;
          ctx.fillStyle = `rgba(255,232,140,${0.8 * sa})`;
          ctx.fillRect(e.dstX - 2, e.dstY - 1, 4, 1);
          ctx.fillRect(e.dstX - 1, e.dstY - 2, 2, 1);
        }
        break;
      }
      case "deathpuff": {
        // Layered grief cue:
        //   • expanding ring on the ground (the "thump" hits hard);
        //   • dust mound rising and broadening as the body settles;
        //   • three soul wisps climbing on individual phases so the
        //     spirit visibly leaves the body instead of one flat
        //     grey blob.
        const p   = (t - e.born) / Math.max(1, e.until - e.born);
        const pp  = Math.max(0, Math.min(1, p));
        const fa  = 1 - pp;
        // Expanding shockwave ring.
        const ringR = Math.round(2 + pp * 12);
        const ringA = fa * 0.6;
        ctx.fillStyle = `rgba(180,180,180,${ringA})`;
        ctx.fillRect(x - ringR, y - 1, ringR * 2, 1);
        ctx.fillRect(x - ringR, y + 1, ringR * 2, 1);
        ctx.fillRect(x - ringR,     y, 1, 1);
        ctx.fillRect(x + ringR - 1, y, 1, 1);
        // Dust mound — wider as it falls, kept from the original.
        const rise = Math.round(10 * fa);
        ctx.fillStyle = `rgba(120,120,120,${fa * 0.7})`;
        ctx.fillRect(x - 6, y - rise, 12, 4);
        ctx.fillStyle = `rgba(200,200,200,${fa * 0.55})`;
        ctx.fillRect(x - 3, y - 6 - rise, 6, 3);
        // Soul wisps: three small whitish pixels rising on their own
        // sin-wobble + per-wisp phase (pre-rolled in `e.wisps`).  A
        // dim outer halo follows each wisp 1 px below for a touch of
        // glow without needing a real shadow pass.
        const wisps = e.wisps || [
          { dx: -2, dy: 0, sp: 18, ph: 0.0 },
          { dx:  2, dy: 0, sp: 14, ph: 0.4 },
          { dx:  0, dy: 0, sp: 22, ph: 0.7 },
        ];
        for (const w of wisps) {
          const wp = (pp + w.ph) % 1;
          const wy = Math.round(y - w.sp * (pp * 1.2 + 0.2) - 4);
          const wx = Math.round(x + w.dx + Math.sin(t / 120 + w.ph * 6.28) * 2);
          const wa = (1 - wp) * fa * 0.85;
          if (wa <= 0.05) continue;
          ctx.fillStyle = `rgba(200,200,220,${wa * 0.6})`;
          ctx.fillRect(wx - 1, wy + 1, 3, 1);
          ctx.fillStyle = `rgba(245,245,255,${wa})`;
          ctx.fillRect(wx, wy, 1, 2);
        }
        break;
      }
      case "holylight": {
        // Golden pillar of light + sparkles rising up through it,
        // plus periodic ground "shockwave" rings that pulse outward
        // from the corpse so the channel reads as actively building
        // up rather than statically holding.
        // The life fraction `p` (0..1) is only used to fade the column
        // in/out at the very edges so it doesn't pop on and off; the
        // body of the cast just flickers at constant brightness.
        const p = (t - e.born) / (e.until - e.born);
        const edgeFade = Math.min(1, Math.min(p, 1 - p) * 6);
        const flick = (0.7 + 0.3 * Math.sin(t / 70)) * edgeFade;
        // Wide soft glow.
        ctx.fillStyle = `rgba(255,230,150,${0.22 * flick})`;
        ctx.fillRect(x - 12, y - 40, 24, 40);
        // Inner pillar.
        ctx.fillStyle = `rgba(255,250,210,${0.55 * flick})`;
        ctx.fillRect(x - 4, y - 40, 8, 40);
        // Hot white core.
        ctx.fillStyle = `rgba(255,255,255,${0.85 * flick})`;
        ctx.fillRect(x - 1, y - 40, 2, 40);
        // Ground ring at the corpse's feet.
        ctx.fillStyle = `rgba(255,240,180,${0.8 * flick})`;
        ctx.fillRect(x - 10, y - 1, 20, 2);
        // Pulsing shockwave ring expanding outward at the base.  Two
        // concurrent rings phase-offset so a wave is always travelling
        // across the lawn under the channel — instantly reads as
        // "magic is doing something here".  Each ring lives for ~700
        // ms and grows to ~18 px, then resets.
        for (let k = 0; k < 2; k++) {
          const ph = ((t / 700) + k * 0.5) % 1;
          const rR = Math.round(2 + ph * 16);
          const rA = (1 - ph) * 0.7 * edgeFade;
          if (rA <= 0.04) continue;
          ctx.fillStyle = `rgba(255,235,160,${rA})`;
          // Pixel-art "ellipse outline" — top + bottom 1-px caps so
          // the ring sits flat on the ground rather than wrapping
          // around like a bubble.
          ctx.fillRect(x - rR, y,     rR * 2, 1);
          ctx.fillRect(x - rR, y - 2, 1,      2);
          ctx.fillRect(x + rR - 1, y - 2, 1,  2);
        }
        // Sparkles scrolling upward through the column.
        for (let k = 0; k < 5; k++) {
          const ph = ((t / 450) + k * 0.2) % 1;
          const sy = y - Math.round(ph * 38);
          const sx = x + Math.round(Math.sin(k * 2.3 + ph * 6.2) * 5);
          const sa = (1 - ph) * flick;
          ctx.fillStyle = `rgba(255,255,255,${sa})`;
          ctx.fillRect(sx - 1, sy - 1, 2, 2);
        }
        break;
      }
      case "necrolight": {
        // Green necromantic pillar — same column geometry as
        // holylight so it reads as the same kind of "this body is
        // being pulled back up" event, but with a distinctly
        // mossy/swamp palette, slower shockwave rings and faint
        // cool embers instead of warm sparkles.  Used by the
        // zombie's grave-side self-revive.
        const p = (t - e.born) / (e.until - e.born);
        const edgeFade = Math.min(1, Math.min(p, 1 - p) * 6);
        const flick = (0.7 + 0.3 * Math.sin(t / 70)) * edgeFade;
        ctx.fillStyle = `rgba(120,200,90,${0.22 * flick})`;
        ctx.fillRect(x - 12, y - 40, 24, 40);
        ctx.fillStyle = `rgba(170,255,120,${0.55 * flick})`;
        ctx.fillRect(x - 4, y - 40, 8, 40);
        ctx.fillStyle = `rgba(220,255,200,${0.85 * flick})`;
        ctx.fillRect(x - 1, y - 40, 2, 40);
        ctx.fillStyle = `rgba(150,230,110,${0.8 * flick})`;
        ctx.fillRect(x - 10, y - 1, 20, 2);
        // Slower, sicker shockwave rings — period ~900 ms (vs holy's
        // 700) and a moss-green tint, so the necromantic version
        // visibly drags itself out of the ground rather than the
        // priest's brisk pulses.
        for (let k = 0; k < 2; k++) {
          const ph = ((t / 900) + k * 0.5) % 1;
          const rR = Math.round(2 + ph * 16);
          const rA = (1 - ph) * 0.65 * edgeFade;
          if (rA <= 0.04) continue;
          ctx.fillStyle = `rgba(150,230,110,${rA})`;
          ctx.fillRect(x - rR, y,     rR * 2, 1);
          ctx.fillRect(x - rR, y - 2, 1,      2);
          ctx.fillRect(x + rR - 1, y - 2, 1,  2);
        }
        for (let k = 0; k < 5; k++) {
          const ph = ((t / 520) + k * 0.2) % 1;
          const sy = y - Math.round(ph * 38);
          const sx = x + Math.round(Math.sin(k * 2.3 + ph * 6.2) * 5);
          const sa = (1 - ph) * flick;
          ctx.fillStyle = `rgba(200,255,180,${sa})`;
          ctx.fillRect(sx - 1, sy - 1, 2, 2);
        }
        break;
      }
      case "horseAura": {
        // Healer's mount-summon channel: a growing pixel-art horse
        // silhouette over her head plus a 4-pixel sparkle ring
        // orbiting her shoulders.  Tracks the live caster ref so it
        // sticks with her if she's nudged mid-cast.
        let cx = e.x, cy = e.y;
        if (e.live && e.target && e.target.hp > 0 &&
            Characters.isVisibleNow(e.target)) {
          cx = e.target.x;
          cy = e.target.y - 28;
          e.x = cx; e.y = cy;
        }
        const xR = Math.round(cx);
        const yR = Math.round(cy);
        const p = (t - e.born) / Math.max(1, e.until - e.born);
        const pp = Math.max(0, Math.min(1, p));
        // Try to draw the actual horse sprite at a small scale that
        // grows from ~40% to 100% over the cast — looks nicer than a
        // hand-painted silhouette and reads instantly as "the thing
        // I'm summoning".  Falls back to a chunky pixel block if the
        // sprite isn't packed in this build.
        const img = Sprites.getExtra && Sprites.getExtra("horse", "r", 0);
        if (img) {
          const scale = 0.4 + pp * 0.55;
          const dw = Math.max(2, Math.round(img.width * scale));
          const dh = Math.max(2, Math.round(img.height * scale));
          const a = ctx.globalAlpha;
          ctx.globalAlpha = a * (0.35 + pp * 0.45);
          ctx.drawImage(img, xR - Math.round(dw / 2), yR - dh, dw, dh);
          ctx.globalAlpha = a;
        } else {
          const w = Math.max(2, Math.round(8 * pp));
          const hh = Math.max(2, Math.round(6 * pp));
          ctx.fillStyle = `rgba(180,200,255,${0.7})`;
          ctx.fillRect(xR - w / 2, yR - hh, w, hh);
        }
        // Sparkle ring orbiting her head — four pips on a circle,
        // each pip a single white pixel that flips through the four
        // cardinal-ish positions every ~70 ms.  The ring spins fast
        // enough to clearly read as motion across the 700 ms cast.
        const angle = (t / 80) % (Math.PI * 2);
        ctx.fillStyle = "#fff8c0";
        for (let i = 0; i < 4; i++) {
          const a2 = angle + (i * Math.PI / 2);
          const sx = xR + Math.round(Math.cos(a2) * 7);
          const sy = yR + 6 + Math.round(Math.sin(a2) * 4);
          ctx.fillRect(sx, sy, 1, 1);
        }
        // Falling sparkle dust at her feet — three pixels drifting
        // from waist-height down past the ground line, phase-offset
        // for a continuous shower instead of a synchronous flash.
        for (let k = 0; k < 3; k++) {
          const dph = ((t / 260) + k * 0.33) % 1;
          const da = (1 - dph) * 0.8;
          ctx.fillStyle = `rgba(255,255,210,${da})`;
          ctx.fillRect(xR - 5 + k * 5, yR + 14 + Math.round(dph * 14), 1, 1);
        }
        break;
      }
      case "decoyCast": {
        // Quick spin-up of pale-blue sparkles around the girl during
        // the ~280 ms cast.  Live-tracks her position so the ring
        // stays centred even though she shouldn't be moving (cast
        // pins her in place).  Two visual layers:
        //   • Four cardinal sparkles orbiting fast (full revolution
        //     per ~120 ms) — sells "she's spinning up the magic".
        //   • A small ground ring that grows over the cast and
        //     pulses through cool blue / cyan, hinting "something
        //     is about to appear here".
        let cx = e.x, cy = e.y;
        if (e.live && e.target && e.target.hp > 0 &&
            Characters.isVisibleNow(e.target)) {
          cx = e.target.x;
          cy = e.target.y - 16;
          e.x = cx; e.y = cy;
        }
        const xR = Math.round(cx);
        const yR = Math.round(cy);
        const p = (t - e.born) / Math.max(1, e.until - e.born);
        const pp = Math.max(0, Math.min(1, p));
        // Orbiting sparkles.
        const ang = (t / 30) % (Math.PI * 2);
        for (let i = 0; i < 4; i++) {
          const a2 = ang + (i * Math.PI / 2);
          const sx = xR + Math.round(Math.cos(a2) * 9);
          const sy = yR + 4 + Math.round(Math.sin(a2) * 5);
          const a = (0.7 + 0.3 * Math.sin(t / 60 + i));
          ctx.fillStyle = `rgba(200,225,255,${a})`;
          ctx.fillRect(sx, sy, 1, 1);
        }
        // Ground halo at the girl's feet — ring radius grows over
        // the cast and the alpha pulses so it reads as "charging up".
        const groundY = yR + 16;
        const r = Math.max(3, Math.round(3 + pp * 6));
        const alpha = 0.4 + 0.4 * pp;
        ctx.fillStyle = `rgba(170,210,255,${alpha})`;
        ctx.fillRect(xR - r, groundY,     1, 1);
        ctx.fillRect(xR + r, groundY,     1, 1);
        ctx.fillRect(xR - r + 1, groundY - 1, r * 2 - 1, 1);
        // Two extra dust pixels falling around her — phase offset
        // so the falling motion stays continuous over the cast.
        for (let k = 0; k < 2; k++) {
          const dph = ((t / 110) + k * 0.5) % 1;
          const da = (1 - dph) * 0.7;
          ctx.fillStyle = `rgba(220,235,255,${da})`;
          ctx.fillRect(xR - 6 + k * 12, yR + 6 + Math.round(dph * 12), 1, 1);
        }
        break;
      }
      case "decoyAppear": {
        // Pop ring at the moment the clone lands: a quick expanding
        // square outline in cool blue, fading out over the effect's
        // lifetime so it doesn't clutter the lawn.
        const p = (t - e.born) / Math.max(1, e.until - e.born);
        const pp = Math.max(0, Math.min(1, p));
        const r = Math.round(2 + pp * 9);
        const a = (1 - pp) * 0.85;
        ctx.fillStyle = `rgba(170,210,255,${a})`;
        // Hollow square: just the four edge strips so the ring
        // reads as an outline, not a solid swatch.
        ctx.fillRect(x - r, y - r, r * 2, 1);            // top
        ctx.fillRect(x - r, y + r, r * 2, 1);            // bottom
        ctx.fillRect(x - r, y - r, 1, r * 2);            // left
        ctx.fillRect(x + r, y - r, 1, r * 2 + 1);        // right
        // Small bright core that fades faster than the ring so the
        // first ~80 ms reads as a flash before settling into the
        // expanding outline.
        if (pp < 0.4) {
          const ca = (1 - pp / 0.4) * 0.9;
          ctx.fillStyle = `rgba(245,250,255,${ca})`;
          ctx.fillRect(x - 1, y - 1, 3, 3);
        }
        break;
      }
      case "holyrain": {
        // Small, gentle "priest just healed you" shower.  Three
        // overlapping bits, all driven off the effect's life
        // fraction `p` so the rain pulses softly through the
        // cooldown window:
        //   * A pale halo bubble above the patient (the cloud the
        //     drops fall out of).
        //   * Five 1×2 droplets falling from the halo down through
        //     the patient's chest height, each on its own phase so
        //     they don't all land on the same beat.
        //   * Two tiny cross-shaped sparkles flickering at the
        //     bottom of the patch.
        //   * A faint warm glimmer ring at the feet.
        // Colours stay in cool cream / pale-blue territory so the
        // spell reads as holy magic, distinct from the witch's hex
        // (purple) and the firemage's fireball (orange).
        // The patient is allowed to move while this plays; we re-
        // read their live position every frame so the cloud stays
        // tied to them instead of standing where the cast began.
        // If the target died / left the stage (`live` cleared by
        // having no usable ref) we fall back to the frozen x/y
        // captured at cast time so the last few frames of fade-out
        // play in place.
        let cx = e.x, cy = e.y;
        if (e.live && e.target && e.target.hp > 0 &&
            Characters.isVisibleNow(e.target)) {
          cx = e.target.x;
          cy = e.target.y - 16;
          // Cache so a sudden disappearance still has somewhere
          // sensible to render the trailing frames.
          e.x = cx; e.y = cy;
        }
        // From here down, the original code referenced the closure
        // `x` / `y` snapshotted at the top of drawEffect; switch to
        // `xR` / `yR` so the live-tracking values above take effect.
        const xR = Math.round(cx);
        const yR = Math.round(cy);
        const p   = (t - e.born) / (e.until - e.born);
        const fade = Math.min(1, Math.min(p, 1 - p) * 4);
        // Halo cloud: a soft bright blob with a brighter rim above
        // the patient's head.
        ctx.fillStyle = `rgba(220,235,255,${0.55 * fade})`;
        ctx.fillRect(xR - 5, yR - 14, 10, 3);
        ctx.fillStyle = `rgba(255,255,255,${0.7 * fade})`;
        ctx.fillRect(xR - 4, yR - 15, 8, 1);
        ctx.fillStyle = `rgba(180,210,255,${0.45 * fade})`;
        ctx.fillRect(xR - 6, yR - 12, 12, 1);
        // Five droplets — phase-offset so they fall in a soft
        // shower rather than a single column.  `dropPh` runs 0..1
        // and maps to a 14-px fall.
        const drops = 5;
        for (let k = 0; k < drops; k++) {
          const dropPh = ((t / 320) + k * 0.21) % 1;
          const dx = -4 + k * 2;
          const dy = Math.round(-10 + dropPh * 14);
          const da = (1 - dropPh) * fade * 0.95;
          ctx.fillStyle = `rgba(190,225,255,${da})`;
          ctx.fillRect(xR + dx, yR + dy, 1, 2);
          ctx.fillStyle = `rgba(255,255,255,${da})`;
          ctx.fillRect(xR + dx, yR + dy, 1, 1);
        }
        // Cross sparkles: two little 3-px crosses popping at the
        // bottom of the shower, also phase-offset.
        for (let k = 0; k < 2; k++) {
          const sph = ((t / 240) + k * 0.5) % 1;
          if (sph > 0.55) continue; // dark gap between flickers
          const sa = (1 - sph / 0.55) * fade * 0.9;
          const sx = xR + (k === 0 ? -3 : 4);
          const sy = yR + 4 + (k === 0 ? 0 : -2);
          ctx.fillStyle = `rgba(255,255,210,${sa})`;
          ctx.fillRect(sx - 1, sy,     3, 1);
          ctx.fillRect(sx,     sy - 1, 1, 3);
        }
        // Warm ground glimmer at the patient's feet, centred 16 px
        // below the patch (matching the y-offset call sites use to
        // place the patch over the chest).
        const gy = yR + 16;
        ctx.fillStyle = `rgba(255,240,200,${0.55 * fade})`;
        ctx.fillRect(xR - 6, gy, 12, 1);
        ctx.fillStyle = `rgba(255,255,255,${0.45 * fade})`;
        ctx.fillRect(xR - 2, gy, 4, 1);
        break;
      }
      case "reviveburst": {
        // Triple-layered "they're back!" payoff:
        //   • bright cross-shaped halo (the original look) so the
        //     character UPRIGHT moment still pops at frame 1;
        //   • shockwave ring expanding outward across the full life
        //     of the effect — sells "miracle just landed";
        //   • a few rising gold sparks that float up around the
        //     newly-revived hero.
        const p   = (t - e.born) / Math.max(1, e.until - e.born);
        const pp  = Math.max(0, Math.min(1, p));
        // Cross halo (original).
        const r = Math.round(4 + 14 * (1 - pp));
        ctx.fillStyle = `rgba(255,255,255,${1 - pp})`;
        ctx.fillRect(x - r, y - 2, r * 2, 4);
        ctx.fillRect(x - 2, y - r, 4, r * 2);
        ctx.fillStyle = `rgba(255,230,150,${(1 - pp) * 0.7})`;
        ctx.fillRect(x - r + 2, y - 1, (r - 2) * 2, 2);
        ctx.fillRect(x - 1, y - r + 2, 2, (r - 2) * 2);
        // Expanding gold shockwave ring (1-px outline of an
        // axis-aligned square approximating an ellipse on the ground
        // — keeps the pixel-art look consistent with the holylight
        // pulses).  Grows from r=4 to r=22 over the lifetime.
        const ringR = Math.round(4 + pp * 18);
        const ringA = (1 - pp) * 0.85;
        if (ringA > 0.04) {
          ctx.fillStyle = `rgba(255,235,170,${ringA})`;
          ctx.fillRect(x - ringR, y - ringR,     ringR * 2, 1);
          ctx.fillRect(x - ringR, y + ringR - 1, ringR * 2, 1);
          ctx.fillRect(x - ringR,     y - ringR, 1, ringR * 2);
          ctx.fillRect(x + ringR - 1, y - ringR, 1, ringR * 2);
        }
        // Rising gold motes — 5 phase-offset specks drifting up.
        for (let k = 0; k < 5; k++) {
          const ph = ((t / 280) + k * 0.2) % 1;
          const my = y - Math.round(ph * 22);
          const mx = x + Math.round(Math.sin(k * 1.7 + ph * 6.2) * 5);
          const ma = (1 - ph) * (1 - pp) * 0.9;
          if (ma <= 0.04) continue;
          ctx.fillStyle = `rgba(255,240,180,${ma})`;
          ctx.fillRect(mx - 1, my - 1, 2, 2);
          ctx.fillStyle = `rgba(255,255,255,${ma})`;
          ctx.fillRect(mx, my, 1, 1);
        }
        break;
      }
      case "potionsmash": {
        // Green revive bottle smashed on a fallen ally.  Three
        // overlapping bits, all driven by the effect's life
        // fraction `p` (0..1):
        //   * Expanding ground ring of green light (the "splash")
        //   * Four glass shards arcing outward + downward
        //   * A lime sparkle column rising up from the body
        // At the very end the shared reviveBurst plays from
        // resurrect(), so we don't need a final cross-flash here.
        const p = (t - e.born) / (e.until - e.born);
        const ringR = Math.round(2 + 18 * p);
        const ringA = (1 - p) * 0.9;
        // Outer green halo ring (1-px stroke, axis-aligned).
        ctx.fillStyle = `rgba(120,230,140,${ringA})`;
        ctx.fillRect(x - ringR, y - 1, ringR * 2, 1);
        ctx.fillRect(x - ringR, y + 1, ringR * 2, 1);
        ctx.fillRect(x - ringR, y, 1, 1);
        ctx.fillRect(x + ringR - 1, y, 1, 1);
        // Inner brighter splash patch on the body itself, fades
        // from a thick blob to nothing.
        const blobR = Math.round(4 + 4 * (1 - p));
        const blobA = (1 - p);
        ctx.fillStyle = `rgba(180,255,200,${blobA * 0.65})`;
        ctx.fillRect(x - blobR, y - blobR, blobR * 2, blobR * 2);
        ctx.fillStyle = `rgba(255,255,210,${blobA * 0.8})`;
        ctx.fillRect(x - 1, y - 1, 2, 2);
        // Four glass shards flying out (NE/NW/SE/SW), with a hint
        // of gravity pulling them downward as they fade.
        const dirs = [[-1, -1], [1, -1], [-1, 1], [1, 1]];
        for (let k = 0; k < dirs.length; k++) {
          const [sx, sy] = dirs[k];
          const dist = Math.round(1 + 14 * p);
          const fall = Math.round(6 * p * p);
          const sa = (1 - p) * 0.95;
          const px = x + sx * dist;
          const py = y + sy * Math.max(2, dist - 4) + fall;
          ctx.fillStyle = `rgba(120,200,140,${sa})`;
          ctx.fillRect(px - 1, py - 1, 2, 2);
          ctx.fillStyle = `rgba(220,255,230,${sa * 0.8})`;
          ctx.fillRect(px, py, 1, 1);
        }
        // Rising lime sparkles: 4 phase-offset 1-px specks travel
        // upward from the body, fading as they go.  This is the
        // "essence escaping the bottle" cue.
        for (let k = 0; k < 4; k++) {
          const ph = ((t / 250) + k * 0.27) % 1;
          const ry = y - Math.round(ph * 22);
          const rx = x + Math.round(Math.sin(k * 1.7 + ph * 6.2) * 4);
          const ra = (1 - ph) * (1 - p) * 0.9;
          ctx.fillStyle = `rgba(180,255,200,${ra})`;
          ctx.fillRect(rx - 1, ry - 1, 2, 2);
          ctx.fillStyle = `rgba(255,255,255,${ra})`;
          ctx.fillRect(rx, ry, 1, 1);
        }
        break;
      }
      case "uforay": {
        // "Tractor beam of life": a downward CONE of glowing rings
        // from the UFO emitter (apex, narrow) to the corpse's feet
        // (base, wide).  No central beam — the cone is drawn as a
        // stack of phase-offset rings that descend AND grow as they
        // fall, so visually it reads as a flared funnel of light.
        // Everything is axis-aligned 1-px pixel rects so it stays
        // crunchy at any zoom.
        // Re-read the saucer position every frame: the UFO drifts
        // around while the beam is alive, and a stale snapshot would
        // leave the cone hanging from where the saucer USED to be.
        // Corpse coords (e.x2/e.y2) stay frozen — corpses don't walk.
        let srcX = e.x, srcY = e.y;
        if (e.live) {
          const uc = Scene.ufoCenter();
          srcX = uc.x; srcY = uc.y;
        }
        const cx = Math.round(srcX);
        const yTop = Math.round(srcY);
        const yBot = Math.round(e.y2);
        const colH = Math.max(1, yBot - yTop);

        // Cone geometry: narrow apex (rTop) at the saucer's emitter,
        // wide base (rBot) at the corpse.  The base radius scales
        // gently with the cone height so a tall cone (corpse far
        // below) doesn't look anorexic and a short cone (corpse
        // right under the saucer) doesn't look like a manhole.
        const rTop = 2;
        const rBot = Math.max(8, Math.min(16, 6 + Math.round(colH * 0.22)));

        // Cone CENTRE LINE slants from the saucer (cx, yTop) down to
        // the corpse (cxBot, yBot), so even when the UFO is still
        // sliding sideways into station the cone visually CONNECTS
        // both endpoints instead of being a vertical column that
        // misses the body.
        const cxBot = Math.round(e.x2);

        // Soft cone fill: stacked horizontal stripes whose half-width
        // interpolates from rTop (top) to rBot (bottom), so the
        // outline naturally widens as we go down.  Two passes give a
        // hint of inner brightness without needing real blending.
        for (let py = 0; py < colH; py++) {
          const t01 = py / Math.max(1, colH - 1);
          const halfO = Math.max(1, Math.round(rTop + (rBot - rTop) * t01));
          const halfI = Math.max(1, halfO - 2);
          const sx = Math.round(cx + (cxBot - cx) * t01);
          ctx.fillStyle = `rgba(220,255,235,${0.18 * a})`;
          ctx.fillRect(sx - halfO, yTop + py, halfO * 2, 1);
          ctx.fillStyle = `rgba(255,255,220,${0.30 * a})`;
          ctx.fillRect(sx - halfI, yTop + py, halfI * 2, 1);
        }

        // Descending rings: 5 phase-offset rings that travel from
        // apex to base.  Each ring's diameter interpolates with its
        // own descent progress, so successive rings trace out the
        // cone shape AS THEY FALL — that's the "cone of circles"
        // look: smaller circles up top, bigger circles further down.
        const NRINGS = 5;
        for (let k = 0; k < NRINGS; k++) {
          const ph = ((t / 800) + k / NRINGS) % 1;
          const ry = yTop + Math.round(ph * (colH - 1));
          const rcx = Math.round(cx + (cxBot - cx) * ph);
          const half = Math.max(1, Math.round(rTop + (rBot - rTop) * ph));
          const ra = a * Math.sin(ph * Math.PI);            // 0 at ends
          if (ra <= 0.04) continue;
          // Pixel ring outline (axis-aligned ellipse approximation):
          // top + bottom 1-px segments, plus left/right 1-px caps.
          const innerW = Math.max(0, (half - 1) * 2);
          ctx.fillStyle = `rgba(255,255,210,${ra})`;
          if (innerW > 0) {
            ctx.fillRect(rcx - half + 1, ry - 1, innerW, 1);
            ctx.fillRect(rcx - half + 1, ry + 1, innerW, 1);
          }
          ctx.fillRect(rcx - half, ry, 1, 1);
          ctx.fillRect(rcx + half - 1, ry, 1, 1);
          // Hot inner spark on the ring's centre — 2 px wide.
          ctx.fillStyle = `rgba(255,255,255,${ra * 0.9})`;
          ctx.fillRect(rcx - 1, ry, 2, 1);
        }

        // Ground halo at the corpse's feet so the cone "lands" — a
        // 1-px elliptical pad sized to the cone's base, anchored to
        // the corpse, not the slanted apex.
        const gAlpha = 0.75 * a;
        ctx.fillStyle = `rgba(255,255,210,${gAlpha})`;
        ctx.fillRect(cxBot - rBot + 1, yBot,     (rBot - 1) * 2, 1);
        ctx.fillRect(cxBot - rBot - 1, yBot - 1,  3, 1);
        ctx.fillRect(cxBot + rBot - 1, yBot - 1,  3, 1);
        break;
      }
      case "beam": {
        // UFO death ray — thick white inside, glow outside, plus a
        // pulsing halo at the impact point and a brief spark splash
        // when the beam fades.  Re-source both endpoints every frame
        // so the beam tracks the moving saucer AND the moving
        // monster instead of dangling between two stale snapshots.
        // A dead/dying target falls back to the last known endpoint
        // so the beam at least finishes its 220ms instead of
        // vanishing mid-flash.
        let x1 = e.x, y1 = e.y, x2 = e.x2, y2 = e.y2;
        if (e.live) {
          const uc = Scene.ufoCenter();
          x1 = uc.x; y1 = uc.y;
          const tg = e.target;
          if (tg && !tg.dying && tg.hp > 0) {
            x2 = tg.x;
            y2 = tg.y - (tg.h || 20) / 2;
          }
        }
        x1 = Math.round(x1); y1 = Math.round(y1);
        x2 = Math.round(x2); y2 = Math.round(y2);
        // Lifetime fraction (drives the beam pulsation + impact
        // sparks).  Beam is brightest at birth and fades out.
        const p = (t - e.born) / Math.max(1, e.until - e.born);
        const pp = Math.max(0, Math.min(1, p));
        // Beam thickness pulses subtly across its life — gives the
        // ray a "live current" feel instead of a flat line.
        const pulse = 1 + Math.sin(t / 22) * 0.15;
        // Outer pink glow.
        ctx.strokeStyle = `rgba(255,120,180,${a * 0.55})`;
        ctx.lineWidth = 6 * pulse;
        ctx.beginPath();
        ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
        // Inner hot white core.
        ctx.strokeStyle = `rgba(255,255,255,${a})`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
        ctx.lineWidth = 1;
        // Impact halo at the target end — pink ring expanding +
        // bright white centre.  Fades in over the first 25 % then
        // out with the rest of the effect, so the burn-mark on the
        // monster reads even if the line itself is dim.
        const hr = Math.round(3 + pp * 5);
        const ha = a * 0.85;
        ctx.fillStyle = `rgba(255,160,200,${ha})`;
        ctx.fillRect(x2 - hr, y2 - 1, hr * 2, 1);
        ctx.fillRect(x2 - hr, y2 + 1, hr * 2, 1);
        ctx.fillRect(x2 - hr,     y2, 1, 1);
        ctx.fillRect(x2 + hr - 1, y2, 1, 1);
        ctx.fillStyle = `rgba(255,255,255,${ha})`;
        ctx.fillRect(x2 - 1, y2 - 1, 3, 3);
        // Tail-end sparks: kick in during the last 30 % so the
        // moment the laser lifts off the target it leaves behind a
        // small splash of red sparks instead of just snapping out.
        if (pp > 0.7) {
          const sa = (1 - (pp - 0.7) / 0.3) * 0.9;
          for (let k = 0; k < 5; k++) {
            const ang = (k * Math.PI * 2) / 5 + Math.PI / 7;
            const dist = 3 + Math.round((pp - 0.7) / 0.3 * 6);
            const sx = x2 + Math.round(Math.cos(ang) * dist);
            const sy = y2 + Math.round(Math.sin(ang) * dist);
            ctx.fillStyle = `rgba(255,120,160,${sa})`;
            ctx.fillRect(sx, sy, 1, 1);
          }
        }
        break;
      }
      case "slow": {
        // Witch hex slow: a light-violet swirl over the affected
        // monster.  Two pinwheeling 1-px arms rotate around the
        // target's centre, with a soft halo at the base.
        const lifeT = (t - e.born) / Math.max(1, e.until - e.born);
        const aS = Math.max(0, 1 - lifeT) * 0.85;
        ctx.fillStyle = `rgba(180,140,230,${aS * 0.45})`;
        ctx.fillRect(x - 6, y - 2, 12, 3);
        ctx.fillStyle = `rgba(220,180,255,${aS})`;
        for (let k = 0; k < 4; k++) {
          const ang = (t / 220) + k * Math.PI / 2;
          const px = x + Math.round(Math.cos(ang) * 5);
          const py = y - 4 + Math.round(Math.sin(ang) * 3);
          ctx.fillRect(px, py, 1, 1);
        }
        break;
      }
      case "taunt": {
        // Knight taunt: pulsing red ring + a tiny "!" floating up.
        const lifeT = (t - e.born) / Math.max(1, e.until - e.born);
        const aT = Math.max(0, 1 - lifeT);
        const r = Math.round(8 + lifeT * 14);
        ctx.fillStyle = `rgba(255,80,60,${aT * 0.7})`;
        ctx.fillRect(x - r, y - 1, r * 2, 1);
        ctx.fillRect(x - r, y + 1, r * 2, 1);
        ctx.fillRect(x - r,     y, 1, 1);
        ctx.fillRect(x + r - 1, y, 1, 1);
        ctx.fillStyle = `rgba(255,255,200,${aT})`;
        ctx.fillRect(x, y - 12 - Math.round(lifeT * 6), 1, 4);
        ctx.fillRect(x, y - 6 - Math.round(lifeT * 6),  1, 1);
        break;
      }
      case "meteorWarn": {
        // 700 ms-ish red telegraph circle that pulses in place
        // before a rain-of-fire meteor lands.  Two concentric
        // dashed rings + a flicker core.
        const lifeT = (t - e.born) / Math.max(1, e.until - e.born);
        const aW = Math.max(0, 1 - lifeT);
        const flick = 0.6 + 0.4 * Math.sin(t / 60);
        const r1 = 10, r2 = 6;
        ctx.fillStyle = `rgba(255,80,40,${aW * 0.9 * flick})`;
        for (let k = 0; k < 8; k++) {
          if (k & 1) continue;
          const ang = (k / 8) * Math.PI * 2;
          const px = x + Math.round(Math.cos(ang) * r1);
          const py = y + Math.round(Math.sin(ang) * r1 * 0.5);
          ctx.fillRect(px, py, 2, 2);
        }
        ctx.fillStyle = `rgba(255,200,80,${aW})`;
        ctx.fillRect(x - r2, y - 1, r2 * 2, 2);
        ctx.fillStyle = `rgba(255,255,255,${aW * flick})`;
        ctx.fillRect(x - 1, y - 1, 2, 2);
        break;
      }
      case "hydraStrikeWarn": {
        // Pre-bite telegraph that LIVE-tracks the targeted hero.  A
        // toothy ring of red zigzag pips around them, plus a green
        // crosshair flickering at the centre — both colours so the
        // marker reads as "hydra incoming" instead of "fire metoer".
        const tg = e.live && e.target ? e.target : null;
        const cx = tg ? Math.round(tg.x) : x;
        const cy = tg ? Math.round(tg.y - 12) : y;
        const lifeT = (t - e.born) / Math.max(1, e.until - e.born);
        const aW = Math.max(0, 1 - lifeT);
        const grow = 0.6 + 0.4 * Math.sin(t / 90);
        const r1 = Math.round(11 * grow);
        ctx.fillStyle = `rgba(220,30,40,${aW * 0.9})`;
        for (let k = 0; k < 12; k++) {
          if (k & 1) continue;
          const ang = (k / 12) * Math.PI * 2;
          const px = cx + Math.round(Math.cos(ang) * r1);
          const py = cy + Math.round(Math.sin(ang) * r1 * 0.55);
          ctx.fillRect(px, py, 2, 1);
          ctx.fillRect(px, py + 1, 1, 1);
        }
        ctx.fillStyle = `rgba(140,220,60,${aW * 0.85})`;
        ctx.fillRect(cx - 4, cy, 9, 1);
        ctx.fillRect(cx, cy - 3, 1, 7);
        ctx.fillStyle = `rgba(255,255,200,${aW})`;
        ctx.fillRect(cx, cy, 1, 1);
        break;
      }
      case "hydraSpitWarn": {
        // Pre-spit telegraph: a tighter orange crosshair on the
        // intended landing point — also live-tracks the hero so
        // sidestepping at the last moment matters.  Tighter and
        // less ferocious than the bite warn so the player can read
        // "ranged shot, less commitment".
        const tg = e.live && e.target ? e.target : null;
        const cx = tg ? Math.round(tg.x) : x;
        const cy = tg ? Math.round(tg.y - 12) : y;
        const lifeT = (t - e.born) / Math.max(1, e.until - e.born);
        const aW = Math.max(0, 1 - lifeT);
        const flick = 0.5 + 0.5 * Math.sin(t / 80);
        ctx.fillStyle = `rgba(255,150,60,${aW * 0.7 * flick})`;
        ctx.fillRect(cx - 5, cy, 11, 1);
        ctx.fillRect(cx, cy - 4, 1, 9);
        ctx.fillStyle = `rgba(180,70,20,${aW})`;
        for (let k = 0; k < 4; k++) {
          const ang = k * Math.PI / 2 + Math.PI / 4;
          const px = cx + Math.round(Math.cos(ang) * 6);
          const py = cy + Math.round(Math.sin(ang) * 4);
          ctx.fillRect(px, py, 1, 1);
        }
        ctx.fillStyle = `rgba(255,230,150,${aW})`;
        ctx.fillRect(cx, cy, 1, 1);
        break;
      }
      case "fireSplash": {
        // Orange ember splat: a low flame oval + small embers
        // (re-using makeSparks shape) shooting outward, plus a
        // glowing scorch that lingers.  `tiny` shrinks the splash
        // for low-impact uses (mouth puff, harmless miss).
        const lifeT = (t - e.born) / Math.max(1, e.until - e.born);
        const aA = Math.max(0, 1 - lifeT);
        const big = e.tiny ? 0.55 : 1;
        const r = Math.round((4 + lifeT * 6) * big);
        // Central scorch (dark red base, fades fastest).
        ctx.fillStyle = `rgba(120,40,20,${aA * 0.8})`;
        ctx.fillRect(x - r, y - 1, r * 2, 2);
        // Mid flame band (bright orange).
        ctx.fillStyle = `rgba(255,140,40,${aA})`;
        ctx.fillRect(x - Math.floor(r / 2), y - 2, r, 2);
        // White-hot core pip at the centre.
        ctx.fillStyle = `rgba(255,240,180,${aA})`;
        ctx.fillRect(x - 1, y - 1, 2, 1);
        // Embers (small flying sparks, gravity pulls them down).
        if (e.sparks) {
          const lifeS = (t - e.born) / 1000;
          const grav = 180;
          for (const s of e.sparks) {
            const sx = x + s.vx * lifeS * 0.5;
            const sy = y + s.vy * lifeS * 0.5 + 0.5 * grav * lifeS * lifeS;
            const sa = Math.max(0, aA);
            // Two-tone embers: brighter sparks pop, darker embers drift.
            ctx.fillStyle = (s.size >= 2)
              ? `rgba(255,200,80,${sa})`
              : `rgba(220,90,30,${sa})`;
            ctx.fillRect(Math.round(sx), Math.round(sy), s.size, s.size);
          }
        }
        break;
      }
      case "bloodSpurt": {
        // Severed-head fountain: many red drops fly in a wide arc
        // then arc back down with strong gravity, leaving 1-px
        // ground splats once they land.  Dual-palette (dark blood +
        // bright arterial red) so the spray reads as wet, not flat.
        const lifeS = (t - e.born) / 1000;
        const lifeT = (t - e.born) / Math.max(1, e.until - e.born);
        const grav = 380;
        if (e.drops) {
          for (const d of e.drops) {
            const sx = x + d.vx * lifeS;
            const sy = y + d.vy * lifeS + 0.5 * grav * lifeS * lifeS;
            const sa = Math.max(0, 1 - lifeT * 0.9);
            ctx.fillStyle = d.hot
              ? `rgba(220,40,40,${sa})`
              : `rgba(140,20,20,${sa})`;
            ctx.fillRect(Math.round(sx), Math.round(sy), d.size, d.size);
          }
        }
        // Central dark cut + flash at first frame.
        if (lifeT < 0.25) {
          ctx.fillStyle = `rgba(180,30,30,${1 - lifeT * 4})`;
          ctx.fillRect(x - 3, y - 1, 6, 2);
        }
        break;
      }
      case "hydraFallingHead": {
        // Severed head ballistic-arcing to the ground — a small
        // dark green pixel head with a bright red cut underneath,
        // tumbling end-over-end.  After landing we keep painting
        // it as a still cadaver until the effect's TTL expires.
        const lifeS = (t - e.born) / 1000;
        const grav = 700;
        const sx = e.x + e.vx * lifeS;
        const sy = e.y + e.vy * lifeS + 0.5 * grav * lifeS * lifeS;
        const grounded = sy > Scene.FLOOR_BOTTOM - 4;
        const headX = Math.round(sx);
        const headY = Math.round(grounded ? Scene.FLOOR_BOTTOM - 4 : sy);
        const tumble = Math.floor(t / 90) & 1;
        ctx.fillStyle = "#1c2e10";
        ctx.fillRect(headX - 2, headY - 1, 5, 3);
        ctx.fillRect(headX - 1, headY - 2, 3, 1);
        ctx.fillStyle = "#2f4d20";
        ctx.fillRect(headX - 1, headY, 3, 2);
        // Eye glints in random direction while tumbling.
        ctx.fillStyle = "#ffd040";
        ctx.fillRect(headX + (tumble ? 1 : -1), headY - 1, 1, 1);
        // Red cut ring.
        ctx.fillStyle = "#aa1818";
        ctx.fillRect(headX - 1, headY + 2, 3, 1);
        // Drip trail behind the falling head.
        if (!grounded) {
          ctx.fillStyle = "rgba(180,20,20,0.55)";
          ctx.fillRect(headX, headY + 3, 1, 1);
        } else {
          // Ground pool grows for a beat after impact.
          const poolR = Math.min(4, Math.round(2 + (t - e.born) / 200));
          ctx.fillStyle = "rgba(90,10,10,0.7)";
          ctx.fillRect(headX - poolR, headY + 3, poolR * 2, 1);
        }
        break;
      }
      case "hydraAcidSplash": {
        const lifeT = (t - e.born) / Math.max(1, e.until - e.born);
        const aS = Math.max(0, 1 - lifeT);
        const r = Math.round(3 + lifeT * 8);
        ctx.fillStyle = `rgba(100,220,40,${aS * 0.7})`;
        ctx.fillRect(x - r, y - 1, r * 2, 2);
        ctx.fillStyle = `rgba(200,255,100,${aS})`;
        ctx.fillRect(x - 1, y - 2, 2, 4);
        for (let k = 0; k < 4; k++) {
          const ang = (k / 4) * Math.PI * 2 + lifeT * 3;
          const px = x + Math.round(Math.cos(ang) * (3 + lifeT * 5));
          const py = y + Math.round(Math.sin(ang) * (2 + lifeT * 3));
          ctx.fillStyle = `rgba(140,255,60,${aS * 0.8})`;
          ctx.fillRect(px, py, 1, 1);
        }
        break;
      }
      case "hydraIceSplash": {
        const lifeT = (t - e.born) / Math.max(1, e.until - e.born);
        const aS = Math.max(0, 1 - lifeT);
        const r = Math.round(4 + lifeT * 10);
        ctx.fillStyle = `rgba(160,230,255,${aS * 0.6})`;
        ctx.fillRect(x - r, y - 1, r * 2, 2);
        ctx.fillStyle = `rgba(220,248,255,${aS})`;
        ctx.fillRect(x - 2, y - 3, 4, 6);
        // Crystal shards radiating outward.
        for (let k = 0; k < 5; k++) {
          const ang = (k / 5) * Math.PI * 2;
          const px = x + Math.round(Math.cos(ang) * (4 + lifeT * 7));
          const py = y + Math.round(Math.sin(ang) * (3 + lifeT * 5));
          ctx.fillStyle = `rgba(200,240,255,${aS * 0.9})`;
          ctx.fillRect(px, py, 1, 1);
        }
        break;
      }
      case "hydraPoisonSplash": {
        const lifeT = (t - e.born) / Math.max(1, e.until - e.born);
        const aS = Math.max(0, 1 - lifeT);
        const r = Math.round(3 + lifeT * 7);
        ctx.fillStyle = `rgba(180,60,240,${aS * 0.6})`;
        ctx.fillRect(x - r, y - 1, r * 2, 2);
        ctx.fillStyle = `rgba(230,120,255,${aS})`;
        ctx.fillRect(x - 1, y - 2, 2, 4);
        for (let k = 0; k < 3; k++) {
          const ang = (k / 3) * Math.PI * 2 + lifeT * 4;
          const px = x + Math.round(Math.cos(ang) * (3 + lifeT * 4));
          const py = y + Math.round(Math.sin(ang) * (2 + lifeT * 3));
          ctx.fillStyle = `rgba(220,80,255,${aS * 0.8})`;
          ctx.fillRect(px, py, 1, 1);
        }
        break;
      }
      case "hydraLightningArc": {
        // Instant cyan bolt between two points, fading quickly.
        const lifeT = (t - e.born) / Math.max(1, e.until - e.born);
        const aL = Math.max(0, 1 - lifeT);
        const tx = e.x2 || x, ty = e.y2 || y;
        const steps = Math.max(2, Math.round(Math.hypot(tx - x, ty - y) / 3));
        // Main arc (jagged — offset every other step by 1-2 px perpendicular).
        const nx = -(ty - y) / (Math.hypot(tx - x, ty - y) || 1);
        const ny = (tx - x) / (Math.hypot(tx - x, ty - y) || 1);
        ctx.fillStyle = `rgba(60,220,255,${aL * 0.9})`;
        for (let k = 0; k <= steps; k++) {
          const frac = k / steps;
          const jag = (k % 2 === 0) ? 0 : (Math.random() < 0.5 ? 1 : -1);
          const px = Math.round(x + (tx - x) * frac + nx * jag * 2);
          const py = Math.round(y + (ty - y) * frac + ny * jag * 2);
          ctx.fillRect(px, py, e.chain ? 1 : 2, 1);
        }
        // White core at origin.
        ctx.fillStyle = `rgba(255,255,255,${aL})`;
        ctx.fillRect(x - 1, y - 1, 2, 2);
        break;
      }
      case "debuffSplash": {
        // Small elemental burst at the hero position after a debuff
        // is applied — the player needs to SEE the element that hit them.
        const lifeT = (t - e.born) / Math.max(1, e.until - e.born);
        const aS = Math.max(0, 1 - lifeT);
        const EL_COLORS = {
          fire: "255,130,40", acid: "100,230,40",
          lightning: "80,220,255", ice: "180,230,255", poison: "200,80,255",
        };
        const col = EL_COLORS[e.element] || "255,200,80";
        const r2 = Math.round(2 + lifeT * 8);
        ctx.fillStyle = `rgba(${col},${aS * 0.7})`;
        ctx.fillRect(x - r2, y - r2 / 2, r2 * 2, r2);
        ctx.fillStyle = `rgba(255,255,255,${aS * 0.6})`;
        ctx.fillRect(x - 1, y - 1, 2, 2);
        break;
      }
      case "hydraSprout": {
        // Brief green pulse + 3 dripping ichor drops radiating outward.
        // Used for a regrown stump and (with a delay) for the bonus
        // head's birth fanfare.
        const lifeT = (t - e.born) / Math.max(1, e.until - e.born);
        if (lifeT < 0) break;
        const aS = Math.max(0, 1 - lifeT);
        const r = Math.round(2 + lifeT * 5);
        ctx.fillStyle = `rgba(120,200,60,${aS * 0.8})`;
        ctx.fillRect(x - r, y - 1, r * 2, 2);
        ctx.fillStyle = `rgba(220,255,140,${aS})`;
        ctx.fillRect(x - 1, y - 1, 2, 1);
        // Drips.
        for (let k = 0; k < 3; k++) {
          const ang = (k / 3) * Math.PI * 2 + lifeT;
          const px = x + Math.round(Math.cos(ang) * (4 + lifeT * 4));
          const py = y + Math.round(Math.sin(ang) * (2 + lifeT * 3));
          ctx.fillStyle = `rgba(80,150,40,${aS})`;
          ctx.fillRect(px, py, 1, 1);
        }
        break;
      }
      case "rockChunk": {
        // Small grey chunk bouncing out of the lair on a ballistic
        // arc.  Simple gravity — once it hits the floor it sticks
        // there fading out.
        const lifeS = (t - e.born) / 1000;
        const lifeT = (t - e.born) / Math.max(1, e.until - e.born);
        const grav = 600;
        const sx = e.x + e.vx * lifeS;
        const sy = e.y + e.vy * lifeS + 0.5 * grav * lifeS * lifeS;
        const grounded = sy > Scene.FLOOR_BOTTOM - 2;
        const cx = Math.round(sx);
        const cy = Math.round(grounded ? Scene.FLOOR_BOTTOM - 2 : sy);
        const aR = Math.max(0, 1 - lifeT);
        ctx.fillStyle = `rgba(60,60,64,${aR})`;
        ctx.fillRect(cx, cy + 1, e.size, 1);
        ctx.fillStyle = `rgba(120,120,128,${aR})`;
        ctx.fillRect(cx, cy, e.size, e.size);
        ctx.fillStyle = `rgba(170,170,180,${aR})`;
        ctx.fillRect(cx, cy, e.size - 1, 1);
        break;
      }
      case "smokeBomb": {
        // Ninja smoke bomb: expanding grey puff, dense at first.
        const lifeT = (t - e.born) / Math.max(1, e.until - e.born);
        const aS = Math.max(0, 1 - lifeT) * 0.8;
        const r = Math.round(4 + lifeT * 18);
        ctx.fillStyle = `rgba(70,70,80,${aS})`;
        ctx.fillRect(x - r, y - r / 2, r * 2, r);
        ctx.fillStyle = `rgba(140,140,150,${aS * 0.6})`;
        ctx.fillRect(x - r + 2, y - r / 2 + 1, r * 2 - 4, 1);
        ctx.fillRect(x - r + 4, y + r / 2 - 2, r * 2 - 8, 1);
        break;
      }
      case "shieldBeam": {
        // Alien shield beam: narrow blue ribbon between caster and
        // recipient + a soft halo orbiting the recipient.  Like the
        // ufo beam this is "live" — looks up actor positions every
        // frame so the ribbon tracks if either party walks.
        const sx = (e.live && e.from) ? e.from.x : e.x;
        const sy = (e.live && e.from) ? (e.from.y - 16) : e.y;
        const tx = (e.live && e.to)   ? e.to.x : e.x2;
        const ty = (e.live && e.to)   ? (e.to.y - 16) : e.y2;
        const lifeT = (t - e.born) / Math.max(1, e.until - e.born);
        const aB = Math.max(0, 1 - lifeT);
        // Ribbon (bresenham-ish step for pixel art).
        const steps = Math.max(2, Math.round(Math.hypot(tx - sx, ty - sy) / 2));
        ctx.fillStyle = `rgba(120,200,255,${aB * 0.8})`;
        for (let k = 0; k <= steps; k++) {
          const px = Math.round(sx + (tx - sx) * (k / steps));
          const py = Math.round(sy + (ty - sy) * (k / steps));
          ctx.fillRect(px, py, 1, 1);
        }
        // Halo on recipient.
        ctx.fillStyle = `rgba(150,220,255,${aB * 0.6})`;
        for (let k = 0; k < 6; k++) {
          const ang = (t / 180) + k * Math.PI / 3;
          const px = Math.round(tx + Math.cos(ang) * 8);
          const py = Math.round(ty + Math.sin(ang) * 5);
          ctx.fillRect(px, py, 1, 1);
        }
        break;
      }
      case "embersAura": {
        // Firemage embers: a few floating orange motes orbiting his
        // shoulder.  Stack count drives mote count and intensity.
        const lifeT = (t - e.born) / Math.max(1, e.until - e.born);
        const aE = Math.max(0, 1 - lifeT);
        const stacks = Math.max(1, Math.min(5, e.stacks || 1));
        for (let k = 0; k < stacks; k++) {
          const ph = (t / 380) + k * (Math.PI * 2 / stacks);
          const px = x + Math.round(Math.cos(ph) * 6);
          const py = y - 4 + Math.round(Math.sin(ph) * 3);
          const c1 = (k & 1) ? "255,160,40" : "255,220,90";
          ctx.fillStyle = `rgba(${c1},${aE})`;
          ctx.fillRect(px, py, 2, 2);
          ctx.fillStyle = `rgba(255,240,180,${aE * 0.7})`;
          ctx.fillRect(px, py - 1, 1, 1);
        }
        break;
      }
      case "repairSpark": {
        // Robot repair-kit potion: yellow / blue arcs around the
        // chassis suggesting the soldering / wiring.  Same lifetime
        // shape as `heal` but with mechanical tones.
        const lifeT = (t - e.born) / Math.max(1, e.until - e.born);
        const aR = Math.max(0, 1 - lifeT);
        for (let k = 0; k < 5; k++) {
          const ph = (t / 90) + k * 1.3;
          const px = x + Math.round(Math.cos(ph) * 5);
          const py = y - 4 + Math.round(Math.sin(ph) * 4);
          ctx.fillStyle = (k & 1)
            ? `rgba(120,200,255,${aR})`
            : `rgba(255,220,80,${aR})`;
          ctx.fillRect(px, py, 1, 1);
        }
        ctx.fillStyle = `rgba(180,255,180,${aR * 0.5})`;
        ctx.fillRect(x - 3, y - 1, 6, 1);
        break;
      }
      case "dmgnum": {
        // Floating combat number ("12", "+8", "-3"…) that rises from
        // the damage point and fades.  Drawn with a custom 3×5 pixel
        // glyph set so it reads as part of the same hand-pixelled
        // game and not a CSS overlay.  Variant picks the colour:
        //   • "dmg"  yellow  — outgoing damage on monsters
        //   • "hurt" red     — heroes taking damage
        //   • "heal" green   — HP restored ("+N")
        const lifeP = (t - e.born) / Math.max(1, e.until - e.born);
        const lp = Math.max(0, Math.min(1, lifeP));
        // Ease the rise: fast at first, then settles, so the eye
        // catches the spawn point and the number floats away.
        const rise = Math.round(Math.pow(lp, 0.6) * 16);
        // Fade out over the last 60 % of the life.
        const aN = lp < 0.4 ? 1 : Math.max(0, 1 - (lp - 0.4) / 0.6);
        let main = "255,235,80", shadow = "0,0,0";
        let prefix = "";
        if (e.variant === "hurt") { main = "255, 90, 90"; prefix = "-"; }
        else if (e.variant === "heal") { main = "120,255,140"; prefix = "+"; }
        // "resist" — half-damage tick from an elementally-protected
        // hero.  Cool blue-grey with a leading dot so the player
        // immediately reads "this hit was reduced", separate from a
        // normal red hurt number.
        else if (e.variant === "resist") { main = "150,200,255"; prefix = "·"; }
        const text = prefix + String(e.value);
        // Glyph width 3, gap 1, height 5.  Total width:
        const cellW = 4;
        const totalW = text.length * cellW - 1;
        const baseX = Math.round(e.x - totalW / 2 + (e.jitterX || 0));
        const baseY = Math.round(e.y - rise);
        // Drop shadow for legibility against the lawn.
        ctx.fillStyle = `rgba(${shadow},${aN * 0.7})`;
        for (let i = 0; i < text.length; i++) {
          drawTinyGlyph(ctx, text[i], baseX + i * cellW + 1, baseY + 1);
        }
        ctx.fillStyle = `rgba(${main},${aN})`;
        for (let i = 0; i < text.length; i++) {
          drawTinyGlyph(ctx, text[i], baseX + i * cellW, baseY);
        }
        break;
      }
    }
  }

  // 3×5 pixel font for floating damage numbers.  Each glyph is a
  // string of 15 chars where '#' = filled and '.' = empty, read
  // top-left to bottom-right (5 rows of 3 columns).  Only the
  // characters we actually emit need to be defined ('+', '-', and
  // the digits 0..9).
  const TINY_GLYPHS = {
    "0": "###" + "#.#" + "#.#" + "#.#" + "###",
    "1": ".#." + "##." + ".#." + ".#." + "###",
    "2": "###" + "..#" + "###" + "#.." + "###",
    "3": "###" + "..#" + "###" + "..#" + "###",
    "4": "#.#" + "#.#" + "###" + "..#" + "..#",
    "5": "###" + "#.." + "###" + "..#" + "###",
    "6": "###" + "#.." + "###" + "#.#" + "###",
    "7": "###" + "..#" + ".#." + ".#." + ".#.",
    "8": "###" + "#.#" + "###" + "#.#" + "###",
    "9": "###" + "#.#" + "###" + "..#" + "###",
    "+": "..." + ".#." + "###" + ".#." + "...",
    "-": "..." + "..." + "###" + "..." + "...",
  };
  function drawTinyGlyph(ctx, ch, x, y) {
    const g = TINY_GLYPHS[ch];
    if (!g) return;
    for (let row = 0; row < 5; row++) {
      for (let col = 0; col < 3; col++) {
        if (g[row * 3 + col] === "#") {
          ctx.fillRect(x + col, y + row, 1, 1);
        }
      }
    }
  }

  function drawHpBar(ctx, x, y, ratio, color) {
    const W = 20, H = 3;
    ctx.fillStyle = "rgba(0,0,0,0.6)";
    ctx.fillRect(x - W / 2 - 1, y - 1, W + 2, H + 2);
    ctx.fillStyle = "#5a1a1a";
    ctx.fillRect(x - W / 2, y, W, H);
    ctx.fillStyle = color;
    ctx.fillRect(x - W / 2, y, Math.max(1, Math.round(W * ratio)), H);
  }

  // ---- elemental hydra spits + bite-rider debuffs -------------------
  //
  // hydraElementSpit(head, hero, dmg) — dispatches to the per-element
  //   spit function based on head.element.
  // hydraApplyBiteDebuff(head, hero) — applies the per-element bite
  //   rider debuff via Characters.applyDebuff.
  //
  // Element spit functions:
  //   fire      — unchanged fireball lob (hydraSpit, existing), leaves acid pool
  //   acid      — slow green blob, LARGER acid pool (r=40), applied vulnerable
  //   lightning — instant arc (no projectile), chains to second target
  //   ice       — slow blue bolt, AoE chill r=32 on land, slows nearby heroes
  //   poison    — fast purple bolt, adds poison stack on hit

  // Spit-projectile speed table (supplementing PROJ_SPEED).
  const HYDRA_SPIT_ACID_SPEED      = 110;  // slow — big pool, worth dodging
  const HYDRA_SPIT_ICE_SPEED       = 135;
  const HYDRA_SPIT_POISON_SPEED    = 230;  // fast — hard to dodge
  const HYDRA_ICE_CHILL_R          = 32;   // AoE chill radius on ice spit landing
  const HYDRA_LIGHTNING_CHAIN_R    = 80;   // chain to second hero within this radius

  // Shared helper: make a spit projectile.
  function makeHydraSpitProjectile(head, hero, spd, kind, dmg) {
    if (!hero || hero.hp <= 0) return null;
    const sx = (typeof head.tipX === "number") ? head.tipX : head.x;
    const sy = (typeof head.tipY === "number") ? head.tipY : head.y;
    const aim = hydraSpitJitterAim(head, hero);
    const tx = aim.tx;
    const ty = aim.ty;
    const dx = tx - sx, dy = ty - sy;
    const d = Math.hypot(dx, dy) || 1;
    return {
      kind, x: sx, y: sy,
      vx: (dx / d) * spd,
      vy: (dy / d) * spd - 20,
      gy: 240,
      dmg: typeof dmg === "number" ? dmg : 9,
      target: hero,
      srcKind: "hydra",
      srcRef: head,
      ttl: (d / spd) * 1000 + 600,
      born: now(),
    };
  }

  // Fire spit: original behaviour (delegates to hydraSpit which also
  // drops an acid pool — already wired in the tick's hit/miss paths).
  function hydraFireSpit(head, hero, dmg) {
    hydraSpit(head, hero, dmg);
  }

  // Acid spit: slow green blob.  On hit, applies vulnerable debuff
  // AND drops a big acid pool.  Pool is dropped in the tick loop
  // via srcKind === "hydra" + kind === "hydraAcid".
  function hydraAcidSpit(head, hero, dmg) {
    const p = makeHydraSpitProjectile(head, hero, HYDRA_SPIT_ACID_SPEED, "hydraAcid", dmg);
    if (!p) return;
    projectiles.push(p);
    hydraSpitWarn(hero, 900);
  }

  // Ice spit: pale blue bolt, applies chill AoE on landing.
  function hydraIceSpit(head, hero, dmg) {
    const p = makeHydraSpitProjectile(head, hero, HYDRA_SPIT_ICE_SPEED, "hydraIce", dmg);
    if (!p) return;
    projectiles.push(p);
  }

  // Poison spit: fast violet bolt, adds one poison stack on hit.
  function hydraPoisonSpit(head, hero, dmg) {
    const p = makeHydraSpitProjectile(head, hero, HYDRA_SPIT_POISON_SPEED, "hydraPoison", dmg);
    if (!p) return;
    projectiles.push(p);
  }

  // Lightning arc: instant, no projectile.  Damages the primary target
  // (hero or monster), then chains to the nearest second target within
  // HYDRA_LIGHTNING_CHAIN_R for 50% damage.  Heroes are briefly rooted.
  // When the primary was a monster and the chain clips a hero, we pass
  // null as attacker so Characters.damage does not fire helpCall — the
  // zap is splash off a mob, not a direct boss focus on that hero.
  function hydraLightningStrike(head, primary, dmg) {
    if (!primary || primary.hp <= 0) return;
    const t = now();
    const sx = (typeof head.tipX === "number") ? head.tipX : head.x;
    const sy = (typeof head.tipY === "number") ? head.tipY : head.y;
    const frac = hydraHeadHpFrac(head);
    if (Math.random() < (1 - frac) * HYDRA_BITE_MISS_CURVE) {
      const wildX = primary.x + (Math.random() - 0.5) * 110;
      const wildY = primary.y + (Math.random() - 0.5) * 50;
      effects.push({ kind: "hydraLightningArc",
                     x: sx, y: sy, x2: wildX, y2: wildY - 14,
                     born: t, until: t + 220 });
      Scene.shake(1.4, 140);
      return;
    }
    const pid = (Monsters && Monsters.hydraTargetElementId)
      ? Monsters.hydraTargetElementId(primary) : (primary.name || primary.kind || "");
    const lImmune = !!(Monsters && Monsters.isElementImmune
      && Monsters.isElementImmune(pid, "lightning"));
    const lResist = !lImmune && !!(Monsters && Monsters.isElementResist
      && Monsters.isElementResist(pid, "lightning"));
    const primMon = !!(Monsters && Monsters.isHydraMonsterVictim && Monsters.isHydraMonsterVictim(primary));
    if (lImmune) {
      effects.push({ kind: "debuffSplash", element: "lightning",
                     x: primary.x, y: primary.y - 16, born: t, until: t + 280 });
    } else {
      const eff = lResist ? Math.max(1, Math.ceil(dmg / 2)) : dmg;
      if (primMon) {
        Monsters.damage(primary, eff, { weapon: "lightning" });
        spawnDamageNumber(primary.x, primary.y - primary.h - 4, eff, lResist ? "resist" : "dmg");
      } else {
        Characters.damage(primary, eff, head);
        spawnDamageNumber(primary.x, primary.y - 28, eff, lResist ? "resist" : "hurt");
        if (!lResist && Characters.applyDebuff) Characters.applyDebuff(primary, "root", t);
      }
    }
    effects.push({ kind: "hydraLightningArc",
                   x: sx, y: sy, x2: primary.x, y2: primary.y - 14,
                   born: t, until: t + 260 });
    effects.push({ kind: "debuffSplash", element: "lightning",
                   x: primary.x, y: primary.y - 16, born: t, until: t + 480 });
    Scene.shake(2.2, 200);
    let chainTarget = null;
    let chainDist = HYDRA_LIGHTNING_CHAIN_R;
    function considerChain(x) {
      if (!x || x === primary) return;
      if (Monsters && Monsters.isHydraMonsterVictim && Monsters.isHydraMonsterVictim(x)) {
        if (x.hp <= 0 || x.dying) return;
        if (Monsters.isHidden && Monsters.isHidden(x)) return;
      } else {
        if (typeof Characters === "undefined" || !Characters.isVisibleNow(x)) return;
        if (x.hp <= 0 || x.combatMode === "dead") return;
      }
      const d = Math.hypot(x.x - primary.x, x.y - primary.y);
      if (d < chainDist) { chainDist = d; chainTarget = x; }
    }
    if (typeof Characters !== "undefined" && Characters.list) {
      for (const c of Characters.list) considerChain(c);
    }
    if (Monsters && Monsters.list) {
      for (const m of Monsters.list) considerChain(m);
    }
    if (chainTarget) {
      const cid = (Monsters && Monsters.hydraTargetElementId)
        ? Monsters.hydraTargetElementId(chainTarget) : (chainTarget.name || chainTarget.kind || "");
      const cImmune = !!(Monsters && Monsters.isElementImmune
        && Monsters.isElementImmune(cid, "lightning"));
      const cResist = !cImmune && !!(Monsters && Monsters.isElementResist
        && Monsters.isElementResist(cid, "lightning"));
      const chainMon = !!(Monsters && Monsters.isHydraMonsterVictim && Monsters.isHydraMonsterVictim(chainTarget));
      effects.push({ kind: "hydraLightningArc",
                     x: primary.x, y: primary.y - 14,
                     x2: chainTarget.x, y2: chainTarget.y - 14,
                     born: t, until: t + 200, chain: true });
      if (cImmune) {
        effects.push({ kind: "debuffSplash", element: "lightning",
                       x: chainTarget.x, y: chainTarget.y - 16, born: t, until: t + 280 });
      } else {
        const baseChain = Math.max(1, Math.round(dmg * 0.5));
        const chainDmg = cResist ? Math.max(1, Math.ceil(baseChain / 2)) : baseChain;
        if (chainMon) {
          Monsters.damage(chainTarget, chainDmg, { weapon: "lightning" });
          spawnDamageNumber(chainTarget.x, chainTarget.y - chainTarget.h - 4, chainDmg, cResist ? "resist" : "dmg");
        } else {
          const chainAttacker = (primMon && !chainMon) ? null : head;
          Characters.damage(chainTarget, chainDmg, chainAttacker);
          spawnDamageNumber(chainTarget.x, chainTarget.y - 28, chainDmg, cResist ? "resist" : "hurt");
          if (!cResist && Characters.applyDebuff) Characters.applyDebuff(chainTarget, "root", t);
        }
        effects.push({ kind: "debuffSplash", element: "lightning",
                       x: chainTarget.x, y: chainTarget.y - 16, born: t, until: t + 480 });
      }
    }
  }

  // Dispatch table: element → spit function.
  function hydraElementSpit(head, hero, dmg) {
    switch (head.element) {
      case "fire":      hydraFireSpit(head, hero, dmg);        break;
      case "acid":      hydraAcidSpit(head, hero, dmg);        break;
      case "lightning": hydraLightningStrike(head, hero, dmg); break;
      case "ice":       hydraIceSpit(head, hero, dmg);         break;
      case "poison":    hydraPoisonSpit(head, hero, dmg);      break;
      default:          hydraSpit(head, hero, dmg);            break;
    }
  }

  // Bite-rider debuff: called from Monsters after hydraStrike lands.
  function hydraApplyBiteDebuff(head, tgt) {
    if (!Characters.applyDebuff) return;
    if (Monsters && Monsters.isHydraMonsterVictim && Monsters.isHydraMonsterVictim(tgt)) return;
    const t = now();
    const el = head.element;
    const id = (Monsters && Monsters.hydraTargetElementId)
      ? Monsters.hydraTargetElementId(tgt) : tgt.name;
    const skip = !!(Monsters && (
      (Monsters.isElementImmune && Monsters.isElementImmune(id, el)) ||
      (Monsters.isElementResist && Monsters.isElementResist(id, el))
    ));
    if (!skip) {
      switch (el) {
        case "fire":      Characters.applyDebuff(tgt, "burn",       t); break;
        case "acid":      Characters.applyDebuff(tgt, "vulnerable", t); break;
        case "lightning": Characters.applyDebuff(tgt, "root",       t); break;
        case "ice":       Characters.applyDebuff(tgt, "chill",      t); break;
        case "poison":    Characters.applyDebuff(tgt, "poison",     t); break;
      }
    }
    effects.push({ kind: "debuffSplash", element: el,
                   x: tgt.x, y: tgt.y - 16, born: t,
                   until: t + (skip ? 240 : 480) });
  }

  // Expose for characters.js DoT tickHeroDebuffs.
  function spawnDamageNumberPub(x, y, dmg, variant) {
    spawnDamageNumber(x, y, dmg, variant);
  }

  return {
    tick, draw,
    heroAttack, monsterAttack,
    hydraStrike, hydraSpit, hydraStrikeWarn, hydraSpitWarn,
    hydraSeverFx, hydraSproutFx, rockChunks,
    hydraElementSpit, hydraApplyBiteDebuff, spawnDamageNumberPub,
    ninjaWormStab, healHero,
    ufoBeam, ufoRay, puff, oilSpritz,
    deathPuff, holyLight, necroLight, holyRain, reviveBurst, potionReviveSmash,
    dirtBurst,
    trainingShot, meteorRain, summonHorseAura,
    decoyCast, decoyAppear,
    slowFx, tauntFx, meteorWarn, smokeBomb, shieldBeam, embersAura, repairSpark,
    isMelee,
  };
})();
