/*
 * Monsters: roaming bad guys the heroes have to deal with.
 *
 * We ship four archetypes, all drawn procedurally in the same chunky
 * "1 block == 2 canvas px" style as the activity items.  Sprites are
 * small so several monsters can share the lawn without cluttering it,
 * and each kind has two walking frames plus a simple dying fade-out.
 *
 *   slime     — slow bouncy blob; spawns in packs of 2-3.  Melee.
 *   bat       — flying, fast; spawns in packs of 2-4.  Melee dive.
 *   goblin    — medium speed, a bit tougher; 1-2 at a time.  Melee club.
 *   skeleton  — steady, hits hard; spawns out of the gravestone.  Melee.
 *
 * AI is simple per-monster but globally produces vague group behaviour:
 * every monster picks the nearest reachable hero, and because monsters
 * spawn in waves from the same side they naturally converge on the
 * same target and appear to act together.  Goblins retreat when their
 * pack is wiped, giving a small "morale break" moment.
 *
 * All HP / damage / timers live on the monster object so Combat can
 * read them without a second indirection.
 */
const Monsters = (() => {
  // ---------- worm tuning -------------------------------------------------
  //
  // The sandworm is the lawn's resident ambush predator.  Unlike the
  // four edge-spawning archetypes it surfaces from INSIDE the play
  // area, triggered by *sound*: heroes chatting, or — at much greater
  // range — someone shouting for help.  When buried it shows up to
  // the player as a raised-grass mound (so the threat is readable),
  // but it is INVISIBLE to every hero AI: anyThreat / anyOnPath /
  // nearestMonster all skip a worm whose state isn't "attacking".
  // That gating is what makes the surprise bite land — heroes really
  // do walk over them obliviously.
  //
  // Worms behave like any other monster in the sense that they
  // PERSIST: no despawn timeout, no edge-of-screen fade-out.  When
  // there's no sound to chase they crawl to a random spot on the
  // lawn, wait, then crawl somewhere else — same restless background
  // behaviour the slimes and goblins have.  Hidden worms also don't
  // count toward Monsters.count(), so the wave director keeps
  // spawning regular packs even with several worms wandering
  // underground.  (Phase 2 will let the ninja hear them and stab
  // katana through the soil; until then they're only damageable
  // while surfaced.)
  const WORM_HP                     = 32;
  const WORM_SPEED_UNDER            = 14;     // languid lurking pace
  const WORM_SPEED_WANDER           = 10;     // even slower when there's no sound to chase
  const WORM_SPEED_SURFACE          = 26;
  // When a worm hears a help-shout it sprints underground for the
  // investigation window so it can actually CLOSE the gap before the
  // call (HELP_LIFETIME_MS ~5s) goes silent.  Chat doesn't trigger
  // the sprint — only the loud emergency does.  At 36 px/s an alarmed
  // worm covers the full WORM_HEAR_HELP_R (220 px) in ~6 s and any
  // mid-range shout (≤120 px) in ~3.3 s, comfortably inside the
  // call's lifetime.
  const WORM_SPEED_ALARMED          = 36;
  // After hearing a help-shout the worm latches onto the SOURCE
  // POSITION for this long, even if the call itself stops.  Without
  // a latch a worm that's still 120 px out when the 5 s call expires
  // would just shrug and start wandering again — the player would
  // see "worm heard the shout, did nothing".  ~6 s lets the same
  // worm finish closing on the spot a hero was last in trouble.
  const WORM_ALARMED_MS             = 6000;
  const WORM_DMG                    = 11;
  const WORM_RANGE                  = 18;
  const WORM_CD_MS                  = 1100;
  // Hearing radii, picked so a help-shout is the worm's "loud" trigger
  // (covers most of the lawn) and a quiet conversation only wakes
  // worms that happen to be lurking right under the chat.
  const WORM_HEAR_HELP_R            = 220;
  const WORM_HEAR_TALK_R            = 90;
  // How close a hero's foot needs to land to a buried mound to trip a
  // surprise emergence.  Kept tight so the player can realistically
  // see the bump and steer their interest around it; a wider radius
  // turned every wandering hero into a worm-trigger.
  const WORM_STEPPED_ON_R           = 12;
  // Mounted heroes (currently only the girl on her summoned horse)
  // get a slightly wider "stomp" radius than a hero on foot — the
  // horse silhouette is wider than a human pair of boots, and from a
  // gameplay perspective the gallop should crush a buried worm with
  // a bit more allowance than a tip-toed pedestrian needs to stand on
  // it.  Kept modest so a horse trotting one tile away doesn't
  // mysteriously squish a worm it didn't actually run over.
  const WORM_STOMP_R                = 16;
  const WORM_EMERGE_MS              = 400;
  const WORM_SUBMERGE_MS            = 400;
  const WORM_MAX_SURFACE_MS         = 7000;   // dive after this even mid-fight
  const WORM_NO_BITE_TIMEOUT_MS     = 5000;   // dive if too long without landing a hit
  // Wander pacing: a buried worm picks a random lawn target and
  // crawls to it; once there, it idles for IDLE_MS before picking the
  // next destination.  Re-pick the target periodically too so a worm
  // that gets boxed in by props doesn't just stand still forever.
  const WORM_WANDER_REPICK_MS       = 9000;
  const WORM_WANDER_IDLE_MS         = 1800;
  const WORM_WANDER_REACH_R         = 6;
  const WORM_MAX_ALIVE              = 4;      // soft cap on simultaneous worms
  const WORM_SPAWN_CHANCE           = 0.7;    // per-wave seed chance
  const WORM_SECOND_SEED_CHANCE     = 0.35;   // try seeding a SECOND worm in the same wave

  // ---------- hydra tuning ------------------------------------------------
  // Mini-boss numbers tuned around two facts:
  //  • the body is rooted in the cave at the upper-left, so heads need
  //    real reach (and a ranged spit) to actually threaten heroes who
  //    park on the right side of the lawn;
  //  • magic resist applies to the BODY only — heads are meant to be
  //    cut off, including by the firemage / witch / alien.
  //
  // 2026 boss-pass ("hydra got too soft"): the previous numbers had
  // been nerfed across seven axes simultaneously (BODY_HP 280, HEAD
  // _RANGE 50, SPIT_DMG 6, MAGIC_MUL 0.55, BONUS_CAP 3 = no bonus
  // heads ever, body speed 18 px/s) so the encounter trivialised
  // into "tank one bite while everyone chips for 10 seconds".  The
  // current values restore real boss pressure: heads with reach,
  // a spit that requires the backline to move, magic that genuinely
  // bounces off the body, and the iconic "and another one!" mechanic
  // back online (HEAD_MAX 5 + BONUS_CAP 4 with two extra sprout
  // slots painted by drawHydraHead instead of relying on the baked
  // body sprite — see HYDRA_SLOT_OFFSETS).
  const HYDRA_BODY_HP               = 520;
  const HYDRA_HEAD_HP               = 38;
  const HYDRA_HEAD_DMG              = 14;
  // Heads are baked into the body sprite for slots 0-2 and only
  // "lunge" 1-2 px toward the target on a strike; bonus heads
  // (slots 3-4) are mini sprite snakes painted overlay-only by
  // drawHydraHead.  Reach widened 50 → 95 px so heads can actually
  // dot the front line instead of waiting for someone to step on
  // the body.  Still well inside the cutter ring (124 px) so a
  // properly-positioned formation pays the price knowingly.
  const HYDRA_HEAD_RANGE            = 95;
  const HYDRA_HEAD_CD_MS            = 1320;
  const HYDRA_HEAD_WINDUP_MS        = 720;
  const HYDRA_EMERGE_MS             = 950;
  const HYDRA_DYING_MS              = 1200;
  const HYDRA_STRIKE_MS             = 220;
  const HYDRA_RETRACT_MS            = 260;
  // Regrow tightened 6.5 s → 4.5 s.  Combined with the now-real
  // bonus-head spawn (HEAD_MAX = 5, BONUS_CAP = 4), the team's
  // "push window" after cutting a head is shorter and the cost of
  // ignoring the regrow ramp is real.
  const HYDRA_REGROW_MS             = 4500;
  const HYDRA_HEAD_START            = 3;
  // Five slots total: three baked into the body sprite (left/centre/
  // right at slots 0-2) and two "sprout" slots (3-4) that grow OUT
  // of the body when the bonus mechanic kicks in.  drawHydraHead
  // paints sprout heads as small green snake silhouettes attached
  // to short necks at HYDRA_SLOT_OFFSETS[3..4] — the baked body
  // sprite stays untouched.
  const HYDRA_HEAD_MAX              = 5;
  // Bonus cap set just below HEAD_MAX so a magic-heavy team can
  // realistically pin the count at 4 if they keep severing — but
  // sloppy play ramps to all 5 and the dogpile gets ugly.
  const HYDRA_BONUS_CAP             = 4;
  // Three heads can pile on one hero now (was 2).  With the wider
  // reach and the new sprout heads in play, the hard-cap also
  // matters less — but we still need it so the knight under taunt
  // doesn't get ALL five heads in his face.
  const HYDRA_HEADS_PER_TARGET      = 3;
  // Spawn cadence.  The boss is a real "stop everything" event for
  // the team — too-frequent spawns turned the lawn into a permanent
  // hydra arena instead of a peacetime sim with an occasional boss.
  // Raised RESPAWN_WAVES 5 → 10 (twice the cooldown floor between
  // candidate spawns) and dropped SPAWN_CHANCE 0.55 → 0.30 (each
  // candidate window is now closer to a 1-in-3 lottery instead of
  // a coin flip).  Net effect: average gap between hydras roughly
  // doubles in expected waves before next spawn.
  const HYDRA_RESPAWN_WAVES         = 10;
  const HYDRA_SPAWN_CHANCE          = 0.30;
  // Body magic resist tightened from 0.55 → 0.35.  The previous
  // 0.55 was a soft nerf that let casters trivially chip from
  // safety.  At 0.35 a witch (8.6 raw dps) lands ~3.0 dps on the
  // body, so finishing the boss without physical commitment takes
  // ~170 s — long enough that the bite/spit/regrow cycle has time
  // to actually punish a magic-only team.  Heads still take FULL
  // magic damage so the cutters' job is unchanged.
  const HYDRA_BODY_MAGIC_MUL        = 0.35;
  // Heads no longer use bezier necks — they're painted into the body
  // sprite at fixed positions and only flash a brief "lunge" effect
  // when biting.  These reach numbers stay around so the AI's
  // "can_reach" check is meaningful: STRIKE is the bite circle, IDLE/
  // WINDUP are kept for code paths that read them but no longer drive
  // any neck length.
  const HYDRA_REACH_IDLE            = 12;
  const HYDRA_REACH_WINDUP          = 18;
  const HYDRA_REACH_STRIKE          = HYDRA_HEAD_RANGE;
  // Sector check disabled — every head can bite any direction within
  // STRIKE radius.  The baked sprite heads don't actually rotate to
  // face the target, so restricting the AI by direction would mean
  // half the heroes "below" the cave couldn't be bitten by the
  // up-facing centre head.  Full 360° keeps combat predictable.
  const HYDRA_SECTOR_HALF_ANGLE     = Math.PI;
  // Five heads.  Slots 0-2 are baked into the body sprite at
  // left / centre / right; slots 3-4 are the bonus "sprout" heads
  // painted as small overlay snakes by drawHydraHead when the
  // regrow mechanic spawns them.  These angles are the directions
  // each head visually faces (used only by aim-side picks for FX,
  // not for the bite check).
  const HYDRA_BASE_ANGLES = [
   -150 * Math.PI / 180,
    -90 * Math.PI / 180,
    -30 * Math.PI / 180,
   -170 * Math.PI / 180,   // slot 3 (left sprout)  — faces hard left
    -10 * Math.PI / 180,   // slot 4 (right sprout) — faces hard right
  ];
  // Fire spit: ranged attack any head reverts to when nobody's standing
  // close enough for a bite.  Long range (most of the lawn), modest
  // damage so the team still has to commit to closing in to actually
  // shut the hydra down.
  //
  // 2026 boss-pass: damage 6 → 11, range 220 → 300, active cap 1 → 2;
  // later toned to 9 base so bite/spit pressure stays readable.
  // The previous numbers made the spit a chip annoyance the healer
  // perfectly absorbed.  At 9 dmg (~11 enraged) a single landed spit
  // is half a hero's HP buffer; at 300 px the rally point at
  // (360, 210) sits INSIDE the danger envelope so the team has to
  // actually move out of formation to engage instead of camping.
  // Two simultaneous spits in flight overload the healer if the
  // backline doesn't dodge — a real "spread out" pressure.
  const HYDRA_SPIT_DMG              = 9;
  const HYDRA_SPIT_RANGE            = 300;
  const HYDRA_SPIT_SPEED            = 190;
  const HYDRA_SPIT_WINDUP_MS        = 1020;
  const HYDRA_SPIT_ACTIVE_CAP       = 2;
  // Body magic resist applies to these projectile kinds.  Heads take
  // full damage from anything — they're the soft, severable target.
  const HYDRA_MAGIC_KINDS = new Set(["fireball", "hex", "beam", "meteor", "holy"]);

  // ---------- new boss mechanics (2026 boss-pass) -----------------
  //
  // Four mechanics layered on top of the baseline bite/spit/regrow:
  //
  //   1. Enrage at 50% body HP — +25% bite/spit damage, faster
  //      windups (-25%), redder sprite.  One-shot transition; the
  //      buff stays on for the rest of the fight.
  //   2. Tail sweep — every 7-9 s the body windups a short tail
  //      sweep that hits everyone within ~70 px.  Punishes melee
  //      from sticking to the tank's pocket without rotating, and
  //      smashes anyone trying to walk past the body.
  //   3. Sever roar — every 3rd head severed in the fight, the
  //      body roars and 2 weakened slimes pour out of the lair as
  //      reinforcements.  Severing isn't "free" anymore: cut three
  //      heads → fight a small swarm too.
  //   4. Head-link buff — every additional living sister head adds
  //      +10% outgoing damage to her sisters' bites and spits.
  //      Five heads × +40% link bonus on the lone surviving head
  //      makes "ignore the regrow ramp" a losing strategy.
  const HYDRA_ENRAGE_THRESHOLD     = 0.5;
  const HYDRA_ENRAGE_DMG_MUL       = 1.25;
  const HYDRA_ENRAGE_WINDUP_MUL    = 0.82;

  const HYDRA_TAIL_RANGE           = 70;    // px from body centre
  const HYDRA_TAIL_DMG             = 10;
  const HYDRA_TAIL_CD_MS           = 8000;  // jittered ±1 s in code
  const HYDRA_TAIL_WINDUP_MS       = 700;
  const HYDRA_TAIL_STRIKE_MS       = 220;

  const HYDRA_SEVER_ROAR_EVERY     = 3;     // every Nth sever this fight
  const HYDRA_SEVER_SLIME_COUNT    = 2;
  const HYDRA_SEVER_SLIME_HP_MUL   = 0.55;
  const HYDRA_SEVER_SLIME_DMG_MUL  = 0.7;

  const HYDRA_LINK_BONUS_PER_HEAD  = 0.10;  // +10% per additional sister

  // Torso HP → movement: at low body HP the hydra still crawls but
  // noticeably slower so the team can create space.  (Per-head aim
  // scaling lives in combat.js — bite/spit/lightning.)
  const HYDRA_BODY_SPEED_HP_MIN_MUL = 0.22;

  // Per-element colour scheme for sprout heads (slots 3-4).  Each
  // entry feeds three consumers in drawHydraSproutHead:
  //   • rim   — solid CSS colour for the eye dot (passed through P()
  //             for the sprite-flash overlay).
  //   • tint  — `rgba(R,G,B,` prefix; the call site appends `<alpha>)`
  //             for the idle eye glow + windup throat pulse.
  //   • flash — `rgba(R,G,B,` prefix used for the strike streak,
  //             spit-windup spark and the head-flash overlay.  Brighter
  //             / hotter than `tint` so the action beats pop.
  //
  // Palette mirrors Combat's `EL_COLORS` table for debuff splashes so
  // a head's idle glow matches the splash you take from its bite.
  const HYDRA_ELEMENT_COLORS = {
    fire:      { rim: "#ffb060", tint: "rgba(255,140,40,",  flash: "rgba(255,210,120," },
    acid:      { rim: "#b8ff60", tint: "rgba(120,220,40,",  flash: "rgba(200,255,120," },
    lightning: { rim: "#a0e8ff", tint: "rgba(80,200,255,",  flash: "rgba(200,240,255," },
    ice:       { rim: "#c8eaff", tint: "rgba(160,220,255,", flash: "rgba(220,245,255," },
    poison:    { rim: "#e090ff", tint: "rgba(200,80,255,",  flash: "rgba(230,160,255," },
  };

  // Fixed slot → element mapping (per the boss-pass spec in README,
  // section "Per-head elements").  Indexes line up with
  // HYDRA_SLOT_OFFSETS / HYDRA_BASE_ANGLES:
  //
  //   slot 0 — baked left   → Acid       (slow blob, vulnerable bite)
  //   slot 1 — baked centre → Fire       (lob + acid pool, burn bite)
  //   slot 2 — baked right  → Lightning  (instant arc + chain, root bite)
  //   slot 3 — left sprout  → Ice        (slow shard + AoE chill, chill bite)
  //   slot 4 — right sprout → Poison     (fast bolt, poison stack bite)
  //
  // Stored on each head as `head.element` at makeHydraHead time and
  // preserved across regrows (regrowHydraHead never touches the slot,
  // so the element stays pinned to the slot for the whole fight).
  // Combat.hydraElementSpit / hydraApplyBiteDebuff dispatch off this
  // field; drawHydraHead / drawHydraSproutHead read it for the
  // per-head colour overlay so the player can tell at a glance which
  // head is which.
  const HYDRA_SLOT_ELEMENTS = [
    "acid",       // 0
    "fire",       // 1
    "lightning",  // 2
    "ice",        // 3
    "poison",     // 4
  ];

  // ---- Per-element hero resistances --------------------------------
  //
  // Two tiers of protection against the hydra's elemental attacks:
  //
  //   IMMUNE  — never targeted by that element's spit, takes 0 damage
  //             from any elemental projectile of that type that does
  //             land (splash/AoE), and ignores the bite-rider debuff
  //             entirely.  The narrative reason is "this hero literally
  //             cannot be hurt by this element".
  //
  //   RESIST  — still a valid spit target (with a soft -bias so the
  //             hydra prefers vulnerable buddies when one is in range),
  //             but takes HALF damage from elemental hits and ignores
  //             the rider debuff.  "It hurts less and the secondary
  //             effect doesn't stick".
  //
  // Design rationale per pairing:
  //   fire → firemage   IMMUNE   — the original baseline; she lives in
  //                                flame, so a fire spit washes off and
  //                                a burn debuff has nothing to ignite.
  //   fire → robot      RESIST   — metal chassis shrugs off heat, but
  //                                the joints still warp on a sustained
  //                                hit so it isn't free.
  //   poison → zombie   IMMUNE   — already dead; no metabolism left to
  //                                poison.
  //   poison → robot    IMMUNE   — synthetic; no organics for the
  //                                toxin to attack.
  //   ice → firemage    RESIST   — her core fire melts the chill before
  //                                it can root, but the impact still
  //                                stings.
  //   ice → viking      RESIST   — cold-weather race; chills slide off
  //                                her skin, slow doesn't apply, but
  //                                the ice shard itself still hits.
  //   lightning → alien RESIST   — sci-fi insulation / plasma shielding;
  //                                arc strikes get bled off into the
  //                                hull, root debuff fizzles, but the
  //                                primary discharge still chips HP.
  //
  // Combat reads HYDRA_ELEMENT_IMMUNE for the spit-projectile damage /
  // bite-rider gates; pickHydraSpitTarget reads it to skip immune
  // heroes in target selection and to softly de-prioritise resist
  // heroes (so the head picks a juicier target if one is available).
  const HYDRA_ELEMENT_IMMUNE = {
    fire:      new Set(["firemage"]),
    // skeleton: undead — same poison immunity idea as zombie (monster kind).
    poison:    new Set(["zombie", "robot", "skeleton"]),
    lightning: new Set(),
    ice:       new Set(),
  };
  const HYDRA_ELEMENT_RESIST = {
    fire:      new Set(["robot"]),
    poison:    new Set(),
    lightning: new Set(["alien"]),
    ice:       new Set(["firemage", "viking"]),
  };

  // Public lookup helpers — avoid `Set.has` typos at the call sites.
  function isElementImmune(name, element) {
    const s = HYDRA_ELEMENT_IMMUNE[element];
    return !!(s && s.has(name));
  }
  function isElementResist(name, element) {
    const s = HYDRA_ELEMENT_RESIST[element];
    return !!(s && s.has(name));
  }

  // Heroes use `name`, monsters use `kind` — hydra elemental tables may
  // list either (e.g. "skeleton" kind vs "zombie" hero name).
  function hydraTargetElementId(t) {
    if (!t) return "";
    if (typeof t.name === "string" && t.name) return t.name;
    return t.kind || "";
  }

  function isHydraMonsterVictim(t) {
    if (!t || t.hp == null || t.hp <= 0) return false;
    if (t.kind === "hydraBody" || t.kind === "hydraHead") return false;
    return list.includes(t);
  }

  function hydraCanTargetMonster(o) {
    if (!isHydraMonsterVictim(o) || o.dying) return false;
    if (isHidden(o)) return false;
    return true;
  }

  // Monster archetype definitions.  Speeds are px/sec.  `flying: true`
  // monsters ignore the floor and pick a y in the upper half of the
  // lawn so they fly above the path instead of plodding along it.
  const TYPES = {
    slime: {
      w: 14, h: 10,
      speed: 22, hp: 22,
      atk: { dmg: 6,  range: 14, cdMs: 900 },
      pack: [2, 3], spookedAt: 0.0,
    },
    bat: {
      w: 16, h: 10,
      speed: 52, hp: 18,
      atk: { dmg: 7,  range: 14, cdMs: 700 },
      pack: [2, 4], spookedAt: 0.0,
      flying: true,
    },
    goblin: {
      w: 14, h: 18,
      speed: 34, hp: 36,
      atk: { dmg: 10, range: 18, cdMs: 1000 },
      pack: [1, 2], spookedAt: 0.5,   // retreats at 50% pack strength
    },
    skeleton: {
      w: 14, h: 22,
      speed: 30, hp: 48,
      atk: { dmg: 12, range: 20, cdMs: 1100 },
      pack: [1, 2], spookedAt: 0.0,    // undead doesn't flinch
    },
    // Worm intentionally NOT in KINDS — its spawn rules differ
    // (random lawn coords, not edges) and we seed it separately from
    // the wave KIND lottery via maybeSeedWorm().
    worm: {
      w: 14, h: 12,
      speed: WORM_SPEED_UNDER, hp: WORM_HP,
      atk: { dmg: WORM_DMG, range: WORM_RANGE, cdMs: WORM_CD_MS },
      pack: [1, 1], spookedAt: 0.0,    // no morale: ambushers commit
    },
    hydraBody: {
      // Body speed must stay BELOW Characters.SPEED (28 px/s) — at
      // 34 the body out-paced every hero on the lawn and disengage
      // became impossible (player tested → "killed everyone").
      // 22 px/s keeps her threatening enough that a kiting witch
      // can't stand still forever (still up from the ancient lazy
      // 18) but any hero who actually chooses to run WILL pull
      // away (~6 px/s margin = ~120 px gap per second of kiting).
      w: 32, h: 22,
      speed: 22, hp: HYDRA_BODY_HP,
      pack: [1, 1], spookedAt: 0.0,
    },
    hydraHead: {
      w: 9, h: 8,
      speed: 0, hp: HYDRA_HEAD_HP,
      atk: { dmg: HYDRA_HEAD_DMG, range: HYDRA_HEAD_RANGE, cdMs: HYDRA_HEAD_CD_MS },
      pack: [1, 1], spookedAt: 0.0,
    },
  };
  const KINDS = ["slime", "bat", "goblin", "skeleton"];

  const list = [];
  let wavesSinceLastHydra = HYDRA_RESPAWN_WAVES;

  function rr(a, b) { return a + Math.random() * (b - a); }

  function create(kind, x, y, groupId) {
    const t = TYPES[kind];
    const m = {
      kind,
      x, y,
      w: t.w, h: t.h,
      speed: t.speed,
      hp: t.hp, maxHp: t.hp,
      atk: t.atk ? { ...t.atk } : null,
      flying: !!t.flying,
      dir: Math.random() < 0.5 ? "l" : "r",
      frame: 0,
      frameTimer: 0,
      target: null,
      lastAttackAt: 0,
      hitFlashUntil: 0,
      dying: false,
      dyingStart: 0,
      fleeing: false,
      groupId,
      spookedAt: t.spookedAt,
      spawnedAt: performance.now(),
      // Witch-hex / future cc: while non-zero+future, tick() multiplies
      // movement by SLOWED_MUL.  Doesn't affect attack cooldowns.
      slowedUntil: 0,
      // Goblin-only: set when a fleeing goblin "wins" the morale check
      // and decides to come back.  tick() reads it to flip back into
      // pursue mode after RETURN_DELAY_MS.
      returnAt: 0,
      // Bat-swarm transient damage bonus, recomputed every tick from
      // local pack density.  Multiplier on outgoing damage.
      swarmDmgMul: 1,
      // Marker so split-on-death only spawns micros once even if the
      // damage path runs twice in a frame.
      _splitDone: false,
    };
    if (kind === "worm") {
      // Worms spawn buried.  surfacedAt/lastBiteAt are set when they
      // actually break ground.  Wander* fields drive the idle crawl
      // when no sound source is in earshot — a fresh worm gets a
      // wander target on the first under-tick.
      m.state = "under";
      m.stateUntil = 0;
      m.surfacedAt = 0;
      m.lastBiteAt = 0;
      m.soundTarget = null;
      m.wanderTx = 0;
      m.wanderTy = 0;
      m.wanderUntil = 0;
      m.wanderIdleUntil = 0;
      // Help-call latch: alarmTarget keeps the last-known position
      // of an emergency shout so the worm keeps closing on it after
      // the call itself expires.  Both default to "no alarm" — set
      // by wormFindSoundSource the first time a help-call lands.
      m.alarmTarget = null;
      m.alarmUntil = 0;
    }
    if (kind === "hydraBody") {
      m.state = "emerging";
      m.stateUntil = performance.now() + HYDRA_EMERGE_MS;
      m.spawnedHeads = false;
      m.anchorX = x;
      m.anchorY = y;
      m.wanderTx = x;
      m.wanderTy = y;
      m.wanderUntil = 0;
      // 2026 boss-pass extras: enrage flag (set once HP crosses
      // the 50% threshold), running sever count for the roar
      // mechanic, and a small AI for the tail-sweep cycle.
      m.enraged = false;
      m.severCount = 0;
      m.tailState = "rest";          // rest → winding → striking → rest
      m.tailUntil = 0;               // state-machine timer
      // Tail can't fire until the body has been "active" for a
      // beat — gives the team a clean engage window before the
      // first sweep.  Set in tickHydraBody when state flips to
      // "active" so we don't burn the cooldown during emerge.
      m.tailNextAt = 0;
    }
    if (kind === "hydraHead") {
      m.parent = null;
      m.slot = 0;
      m.baseAngle = 0;
      m.state = "idle";
      m.windUntil = 0;
      m.stateUntil = 0;
      m.severed = false;
      m.regrowAt = 0;
      m.neckLen = HYDRA_REACH_IDLE;
      m.anchorX = x;
      m.anchorY = y;
      m.tipX = x;
      m.tipY = y;
      m.lastAttackAt = performance.now() - rr(0, 800);
    }
    return m;
  }

  // True if `m` is currently a buried/transitioning worm.  Hero AI
  // uses this to skip worms it has no business knowing about — they
  // shouldn't show up as path-blockers, threats, or AoE targets while
  // they're under the soil.  (The drawing layer ignores this and
  // always shows the mound, so the *player* still sees the danger.)
  //
  // The optional `observer` overrides the filter for a specific hero:
  // the ninja's preternatural hearing lets him perceive worms even
  // through the soil so he can chase one down and stab it before it
  // surfaces.  All other observers still get the buried-worm guard.
  function isHidden(m, observer) {
    if (m.kind === "hydraHead" && m.severed) return true;
    if (m.kind !== "worm" || m.state === "attacking") return false;
    if (observer && observer.name === "ninja") return false;
    return true;
  }

  // Public entry: spawn a wave.  Director calls this occasionally.
  function spawnWave() {
    wavesSinceLastHydra++;
    maybeSeedHydra();
    // Roll worm seeds alongside the regular wave — independent
    // chances, capped at WORM_MAX_ALIVE concurrent lurkers.  We do
    // up to two rolls per wave so the lawn actually feels infested
    // rather than getting one worm every couple of minutes.
    maybeSeedWorm();
    if (Math.random() < WORM_SECOND_SEED_CHANCE) maybeSeedWorm();
    const kind = KINDS[Math.floor(Math.random() * KINDS.length)];
    const spec = TYPES[kind];
    const n = spec.pack[0] + Math.floor(Math.random() * (spec.pack[1] - spec.pack[0] + 1));
    const groupId = performance.now() | 0;
    const skeletonSpawn = (kind === "skeleton") ? Scene.grave() : null;
    for (let i = 0; i < n; i++) {
      let x, y;
      if (skeletonSpawn) {
        // Skeletons claw out of the gravestone.  Stagger them so we
        // see them appear one at a time rather than overlapping.
        x = skeletonSpawn.x + rr(-8, 8);
        y = skeletonSpawn.y - 2;
      } else {
        const fromLeft = Math.random() < 0.5;
        x = fromLeft ? -(spec.w + 4) - i * 10 : Scene.WIDTH + spec.w + 4 + i * 10;
        if (spec.flying) {
          y = 30 + Math.random() * 80;
        } else {
          const yLo = Scene.FLOOR_TOP + 20;
          const yHi = Scene.FLOOR_BOTTOM - 10;
          y = yLo + Math.random() * (yHi - yLo);
        }
      }
      list.push(create(kind, x, y, groupId));
    }
  }

  // Body anchor: body.{x,y} = lair.{x,y} + offset.  Both sprites at 1×.
  // The flipped cave's dark opening sits ~1 px RIGHT and 3 px UP of
  // lair.  All three hydra heads are baked on the RIGHT side of the
  // body sprite (head x-offsets +3 / +8 / +17, centroid ~+9 from
  // body.x).  We shift the body LEFT by 8 px so the head cluster
  // lands centred over the cave hole.
  // Body anchor relative to the cave centre.  The new 36×34 hydra3
  // sprite is centred on these coords; we offset slightly down +
  // toward the cave mouth (lair centre is the boulder centroid; the
  // mouth itself is ~2 px left and ~5 px below it) so the hydra
  // reads as standing AT the cave threshold, not behind it.
  const HYDRA_BODY_X_OFFSET = -2;
  const HYDRA_BODY_Y_OFFSET =  4;

  function maybeSeedHydra() {
    const lair = (typeof Scene !== "undefined" && Scene.hydraLair) ? Scene.hydraLair() : null;
    if (!lair) return;
    let alive = false;
    for (const m of list) {
      if (m.kind === "hydraBody" && !m.dying) { alive = true; break; }
    }
    if (alive) {
      lair.occupied = true;
      lair.state = "active";
      return;
    }
    lair.occupied = false;
    lair.state = (wavesSinceLastHydra >= HYDRA_RESPAWN_WAVES) ? "lurking" : "empty";
    if (wavesSinceLastHydra < HYDRA_RESPAWN_WAVES) return;
    if (Math.random() > HYDRA_SPAWN_CHANCE) return;
    const body = create("hydraBody", lair.x + HYDRA_BODY_X_OFFSET, lair.y + HYDRA_BODY_Y_OFFSET, performance.now() | 0);
    body.state = "emerging";
    body.stateUntil = performance.now() + HYDRA_EMERGE_MS;
    body.lairX = lair.x;
    body.lairY = lair.y;
    list.push(body);
    for (let slot = 0; slot < HYDRA_HEAD_START; slot++) {
      list.push(makeHydraHead(body, slot));
    }
    wavesSinceLastHydra = 0;
    lair.occupied = true;
    lair.state = "emerging";
    // Big emerge burst: a cluster of rock chunks scattering plus a
    // dust cloud at the cave mouth so the appearance lands as an
    // event — not a silent fade-in.
    Combat.dirtBurst(lair.x,     lair.y - 2, false, { palette: "rock", count: 9, scale: 1.0,  life: 560 });
    Combat.dirtBurst(lair.x - 8, lair.y + 2, false, { palette: "rock", count: 6, scale: 0.85, life: 480 });
    Combat.dirtBurst(lair.x + 8, lair.y + 2, false, { palette: "rock", count: 6, scale: 0.85, life: 480 });
    Combat.dirtBurst(lair.x,     lair.y - 6, false, { palette: "green", count: 5, scale: 0.7, life: 420 });
    if (Combat.rockChunks) Combat.rockChunks(lair.x, lair.y - 4, 7);
    Scene.shake(2.4, 360);
    // Boss alarm: nudge the dialog tone the same way the pre-wave
    // telegraph does, AND wake the team-level coordinator so heroes
    // converge on a real plan instead of scattering through whatever
    // wandering / training routine they were on.  Both hooks are
    // optional — Dialog.note is a no-op if Dialog isn't loaded yet,
    // and Characters.HydraPlan is only present in the dev runtime
    // (it would no-op cleanly in a hypothetical headless build too).
    if (typeof Dialog !== "undefined" && Dialog.note) {
      Dialog.note("alarm");
    }
    if (typeof Characters !== "undefined" && Characters.HydraPlan
        && Characters.HydraPlan.activate) {
      Characters.HydraPlan.activate(body);
    }
  }

  // Seed at most one underground worm per wave roll.  Picks a random
  // lawn cell, refusing the pond (waterlogged tunnel = unreadable),
  // a small ring around the gravestone (skeletons claw out of there
  // — sharing the patch is visual chaos), and any spot already
  // occupied by a hero (would emerge instantly and skip the lurking
  // beat that makes the worm interesting).
  function maybeSeedWorm() {
    if (Math.random() > WORM_SPAWN_CHANCE) return;
    let alive = 0;
    for (const m of list) if (m.kind === "worm" && !m.dying) alive++;
    if (alive >= WORM_MAX_ALIVE) return;
    const grave = (typeof Scene !== "undefined" && Scene.grave) ? Scene.grave() : null;
    for (let attempt = 0; attempt < 12; attempt++) {
      const x = rr(40, Scene.WIDTH - 40);
      const y = rr(Scene.FLOOR_TOP + 30, Scene.FLOOR_BOTTOM - 18);
      if (Scene.isInPond && Scene.isInPond(x, y, 14)) continue;
      if (grave && Math.hypot(grave.x - x, grave.y - y) < 40) continue;
      let nearHero = false;
      if (typeof Characters !== "undefined") {
        for (const c of Characters.list) {
          if (!Characters.isVisibleNow(c)) continue;
          if (c.hp <= 0) continue;
          if (Math.hypot(c.x - x, c.y - y) < 60) { nearHero = true; break; }
        }
      }
      if (nearHero) continue;
      list.push(create("worm", x, y, performance.now() | 0));
      return;
    }
  }

  function groupStats(groupId) {
    let alive = 0, total = 0;
    for (const m of list) {
      if (m.groupId !== groupId) continue;
      total++;
      if (!m.dying) alive++;
    }
    return { alive, total };
  }

  function hydraHeads(body) {
    const out = [];
    for (const m of list) {
      if (m.kind === "hydraHead" && m.parent === body) out.push(m);
    }
    return out;
  }

  function hydraActiveHeadCount(body) {
    let n = 0;
    for (const h of hydraHeads(body)) {
      if (!h.severed && !h.dying) n++;
    }
    return n;
  }

  function hydraFreeSlots(body) {
    const used = new Set();
    for (const h of hydraHeads(body)) {
      if (!h.dying) used.add(h.slot);
    }
    const out = [];
    for (let i = 0; i < HYDRA_HEAD_MAX; i++) {
      if (!used.has(i)) out.push(i);
    }
    return out;
  }

  // Head slots match the three head positions baked into the body
  // sprite (the 36x34 hydra3 PNG from `assets/hydra3.png`). The
  // sprite is centred on (body.x, body.y) and the three heads sit
  // symmetrically around the top of the body:
  //   slot 0 (left head)  : src ( 5, 10) → world (body.x − 13, body.y − 7)
  //   slot 1 (top head)   : src (17,  4) → world (body.x −  1, body.y − 13)
  //   slot 2 (right head) : src (30, 10) → world (body.x + 12, body.y − 7)
  const HYDRA_SLOT_OFFSETS = [
    { x: -13, y:  -7 },
    { x:  -1, y: -13 },
    { x:  12, y:  -7 },
  ];
  // Slots considered "bonus" heads — painted by drawHydraHead as
  // mini overlay snakes instead of relying on the baked body sprite.
  // Used by both rendering and the head-link damage multiplier (the
  // "and another one!" beat needs the extra heads to actually feel
  // dangerous, not just visual fanfare).
  const HYDRA_SPROUT_SLOT_MIN       = 3;
  function hydraAnchor(body, slot) {
    const o = HYDRA_SLOT_OFFSETS[slot] || HYDRA_SLOT_OFFSETS[HYDRA_SLOT_OFFSETS.length - 1];
    return { x: body.x + o.x, y: body.y + o.y };
  }

  function makeHydraHead(body, slot) {
    const anchor = hydraAnchor(body, slot);
    const head = create("hydraHead", anchor.x, anchor.y, body.groupId);
    head.parent = body;
    head.slot = slot;
    head.baseAngle = HYDRA_BASE_ANGLES[slot] || HYDRA_BASE_ANGLES[HYDRA_BASE_ANGLES.length - 1];
    head.anchorX = anchor.x;
    head.anchorY = anchor.y;
    head.neckLen = HYDRA_REACH_IDLE;
    // Pin element to the slot for the whole fight.  Combat reads this
    // for the per-element spit/bite-debuff dispatch; the renderer
    // reads it for the colour overlay.  Fallback to "fire" so an
    // out-of-range slot can't crash the dispatch tables.
    head.element = HYDRA_SLOT_ELEMENTS[slot] || "fire";
    setHydraHeadPose(head, performance.now());
    return head;
  }

  // Heads are baked into the body sprite — there's no bezier neck
  // anymore.  Pose just tracks the slot anchor (so the head's bite
  // FX, bullet origin, etc. stay in sync with the sprite) plus a
  // tiny 1-2 px lunge toward the target during a strike for the
  // "snap forward" feel.
  function setHydraHeadPose(head, now) {
    const body = head.parent;
    if (!body) return;
    const anchor = hydraAnchor(body, head.slot);
    head.anchorX = anchor.x;
    head.anchorY = anchor.y;
    head.neckLen = HYDRA_REACH_IDLE;
    if (head.severed) {
      head.x = anchor.x;
      head.y = anchor.y;
      head.tipX = anchor.x;
      head.tipY = anchor.y;
      return;
    }
    const tgt = head.target;
    const tgtAlive = tgt && tgt.hp > 0;
    let lungeX = 0, lungeY = 0;
    if (tgtAlive && (head.state === "striking" || head.state === "winding")) {
      const dx = tgt.x - anchor.x;
      const dy = tgt.y - anchor.y;
      const d = Math.hypot(dx, dy) || 1;
      // 2 px lunge during strike, 1 px tell during windup.
      const reach = (head.state === "striking") ? 2 : 1;
      lungeX = (dx / d) * reach;
      lungeY = (dy / d) * reach;
    }
    head.tipX = anchor.x + lungeX;
    head.tipY = anchor.y + lungeY;
    head.x = head.tipX;
    head.y = head.tipY;
  }

  function nearestHero(m) {
    // Prefer the threat-aware picker that accounts for healers,
    // decoys, and partial-HP heroes; if Characters hasn't booted
    // yet (extremely early frames) fall back to raw distance.
    if (Characters.bestHeroFor) return Characters.bestHeroFor(m);
    let best = null, bestD = Infinity;
    for (const c of Characters.list) {
      if (!Characters.isVisibleNow(c)) continue;
      if (c.hp <= 0) continue;
      if (c.combatMode === "ufoing") continue;
      const d = Math.hypot(c.x - m.x, c.y - m.y);
      if (d < bestD) { bestD = d; best = c; }
    }
    return [best, bestD];
  }

  function tick(dt, now) {
    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i];

      if (m.kind === "hydraBody") {
        if (tickHydraBody(m, dt, now)) list.splice(i, 1);
        continue;
      }

      if (m.kind === "hydraHead") {
        if (tickHydraHead(m, dt, now)) list.splice(i, 1);
        continue;
      }

      if (m.dying) {
        if (now - m.dyingStart > 500) list.splice(i, 1);
        continue;
      }

      if (m.kind === "worm") {
        if (tickWorm(m, dt, now)) list.splice(i, 1);
        continue;
      }

      // Goblin morale check: if pack dropped below threshold, flee.
      if (!m.fleeing && m.spookedAt > 0) {
        const gs = groupStats(m.groupId);
        if (gs.total > 0 && gs.alive / gs.total <= m.spookedAt) {
          m.fleeing = true;
          // Schedule a possible "second wind": after a 12 s breather a
          // fleeing goblin may turn around and come back if the lawn
          // looks more inviting (no hero on his side of the screen
          // close enough to scare him off again).
          m.returnAt = now + 12000;
        }
      }
      // Bat swarm bonus: any bat with at least 2 other bats inside
      // 30 px gets a small attack-damage multiplier next time it
      // bites.  Recomputed each tick so the bonus naturally
      // dissolves as the pack thins out.
      if (m.kind === "bat" && !m.dying) {
        let neighbours = 0;
        for (const o of list) {
          if (o === m || o.dying || o.kind !== "bat") continue;
          if (Math.hypot(o.x - m.x, o.y - m.y) < 30) {
            neighbours++;
            if (neighbours >= 2) break;
          }
        }
        if (neighbours >= 2) {
          // Stack up to ~×1.15 with three buddies; small but visible.
          const mul = 1 + 0.05 * neighbours;
          if (m.atk.dmg !== Math.round(TYPES.bat.atk.dmg * mul)) {
            m.atk.dmg = Math.round(TYPES.bat.atk.dmg * mul);
          }
          m.swarmDmgMul = mul;
        } else if (m.swarmDmgMul !== 1) {
          m.atk.dmg = TYPES.bat.atk.dmg;
          m.swarmDmgMul = 1;
        }
      }

      if (m.fleeing) {
        // Goblin "second wind": after the breather window, if no
        // hero is between the goblin and centre stage, flip back
        // into pursue mode.  Other monsters never reverse — a
        // fleeing slime / bat just runs off-screen.
        if (m.kind === "goblin" && m.returnAt > 0 && now >= m.returnAt) {
          let blocked = false;
          if (typeof Characters !== "undefined") {
            for (const c of Characters.list) {
              if (!Characters.isVisibleNow(c)) continue;
              if (c.hp <= 0) continue;
              if (Math.hypot(c.x - m.x, c.y - m.y) < 80) { blocked = true; break; }
            }
          }
          if (!blocked) {
            m.fleeing = false;
            m.returnAt = 0;
            continue;
          }
          // Reblocked — postpone the next attempt.
          m.returnAt = now + 4000;
        }
        const goLeft = m.x < Scene.WIDTH / 2;
        const tx = goLeft ? -m.w - 10 : Scene.WIDTH + m.w + 10;
        const dx = tx - m.x;
        const s = m.speed * 1.4 * dt / 1000;
        let nx = m.x + Math.sign(dx) * Math.min(Math.abs(dx), s);
        let ny = m.y;
        if (!m.flying) [nx, ny] = Scene.avoidPondStep(m.x, m.y, nx, ny, tx, m.y, m);
        m.x = nx;
        m.y = ny;
        m.dir = dx >= 0 ? "r" : "l";
        m.frameTimer += dt;
        if (m.frameTimer > 140) { m.frameTimer = 0; m.frame ^= 1; }
        if (m.x < -m.w - 8 || m.x > Scene.WIDTH + m.w + 8) list.splice(i, 1);
        continue;
      }

      const [hero, dist] = nearestHero(m);
      m.target = hero;

      if (!hero) {
        // No one to hunt — wander slowly; if time passes with no target,
        // give up and leave.
        if (now - m.spawnedAt > 9000) { m.fleeing = true; continue; }
        m.frameTimer += dt;
        if (m.frameTimer > 220) { m.frameTimer = 0; m.frame ^= 1; }
        continue;
      }

      const dx = hero.x - m.x;
      const dy = hero.y - m.y;
      const d = Math.hypot(dx, dy) || 1;

      // Slow debuff (witch hex etc): drag effective speed down for
      // the duration.  Doesn't affect attack cooldowns — slowed
      // monsters still bite at full rhythm once they're in range.
      const slowMul = (m.slowedUntil > now) ? 0.7 : 1;

      if (d > m.atk.range) {
        // Close in.  Bats fly through the air; grounded monsters
        // keep to the lawn band and steer around the pond.
        const s = m.speed * slowMul * dt / 1000;
        if (m.flying) {
          m.x += (dx / d) * Math.min(d, s);
          m.y += (dy / d) * Math.min(d, s);
          m.y = Math.max(18, Math.min(Scene.FLOOR_BOTTOM - 4, m.y));
        } else {
          const ty = Math.max(Scene.FLOOR_TOP + 20,
                              Math.min(Scene.FLOOR_BOTTOM - 10, hero.y));
          const vy = (ty - m.y);
          let nx = m.x + (dx / d) * Math.min(d, s);
          let ny = m.y + Math.sign(vy) * Math.min(Math.abs(vy), s * 0.6);
          [nx, ny] = Scene.avoidPondStep(m.x, m.y, nx, ny, hero.x, ty, m);
          m.x = nx;
          m.y = ny;
        }
        m.dir = dx >= 0 ? "r" : "l";
        m.frameTimer += dt;
        if (m.frameTimer > 160) { m.frameTimer = 0; m.frame ^= 1; }
      } else if (now - m.lastAttackAt > m.atk.cdMs) {
        Combat.monsterAttack(m, hero);
        m.lastAttackAt = now;
      }
    }
  }

  // ---------- hydra AI ----------

  function tickHydraBody(m, dt, now) {
    const lair = (typeof Scene !== "undefined" && Scene.hydraLair) ? Scene.hydraLair() : null;
    if (lair) {
      lair.occupied = true;
      lair.state = m.dying ? "dying" : m.state;
    }
    m.frameTimer += dt;
    if (m.frameTimer > 240) { m.frameTimer = 0; m.frame ^= 1; }
    if (m.dying) {
      if (now - m.dyingStart > HYDRA_DYING_MS) {
        if (lair) {
          lair.occupied = false;
          lair.state = "empty";
        }
        return true;
      }
      return false;
    }
    if (m.state === "emerging" && now >= m.stateUntil) {
      m.state = "active";
      if (lair) lair.state = "active";
      // Schedule first tail sweep ~5-7 s after emerge so heroes
      // have a clean window to position before the first AoE.
      m.tailNextAt = now + 5000 + Math.random() * 2000;
    }
    if (m.state === "active") {
      // Enrage transition (one-shot, irreversible for the fight).
      // Triggers when body HP first crosses below 50% — the heads'
      // damage path picks up the multiplier from `m.parent.enraged`
      // and windups shorten via HYDRA_ENRAGE_WINDUP_MUL.  Visuals:
      // a brief red flash, big shake, dirt burst — the player needs
      // to read the phase change clearly.
      if (!m.enraged && m.hp > 0 && m.hp < m.maxHp * HYDRA_ENRAGE_THRESHOLD) {
        m.enraged = true;
        m.hitFlashUntil = now + 380;
        Scene.shake(3.6, 320);
        Combat.dirtBurst(m.x, m.y - 2, false, { palette: "rock", count: 9, scale: 1.0, life: 540 });
        Combat.dirtBurst(m.x, m.y + 6, false, { palette: "green", count: 6, scale: 0.8, life: 460 });
        // Flip dialog tone — heroes audibly notice the boss go
        // berserk, which is also a useful "danger up" cue.
        if (typeof Dialog !== "undefined" && Dialog.note) Dialog.note("alarm");
      }
      // Tail-sweep state machine: rest → winding (telegraph) →
      // striking (AoE damage in a ring around the body) → rest.
      // Only runs while the body is upright; pauses during dying.
      tickHydraTail(m, now);
    }
    if (m.state === "active") {
      // Walk OUT of the cave toward the nearest hero.  No hard leash —
      // the hydra is a roaming boss that leaves the cave once it decides
      // to hunt.  It's still slow, and speed scales down with torso HP
      // (HYDRA_BODY_SPEED_HP_MIN_MUL).  The cave acts
      // as its spawn point, so it will naturally reemerge from roughly
      // the same corner of the map.
      let target = null;
      let bestD = Infinity;
      if (typeof Characters !== "undefined" && Characters.list) {
        for (const c of Characters.list) {
          if (!Characters.isVisibleNow(c)) continue;
          if (c.hp <= 0 || c.combatMode === "dead" || c.combatMode === "ufoing") continue;
          const dToBody = Math.hypot(c.x - m.x, c.y - m.y);
          if (dToBody < bestD) {
            bestD = dToBody;
            target = c;
          }
        }
      }
      // No heroes visible → wander slowly on the lawn so the body
      // keeps drifting rather than freezing in place.
      if (!target && now >= (m.wanderUntil || 0)) {
        const ang = rr(0, Math.PI * 2);
        const r = rr(20, 60);
        m.wanderTx = Math.max(Scene.FLOOR_TOP + 20, Math.min(Scene.WIDTH - 20,
                       m.x + Math.cos(ang) * r));
        m.wanderTy = Math.max(Scene.FLOOR_TOP + 20, Math.min(Scene.FLOOR_BOTTOM - 16,
                       m.y + Math.sin(ang) * r * 0.55));
        m.wanderUntil = now + rr(1500, 3000);
      }
      const originX = (typeof m.lairX === "number") ? (m.lairX + HYDRA_BODY_X_OFFSET) : m.x;
      const originY = (typeof m.lairY === "number") ? (m.lairY + HYDRA_BODY_Y_OFFSET) : m.y;
      const tx = target ? target.x : (m.wanderTx != null ? m.wanderTx : originX);
      const ty = target ? target.y : (m.wanderTy != null ? m.wanderTy : originY);
      const dx = tx - m.x;
      const dy = ty - m.y;
      const d = Math.hypot(dx, dy) || 1;
      if (d > 6) {
        const bodyHpFrac = m.maxHp > 0
          ? Math.max(0, Math.min(1, m.hp / m.maxHp))
          : 0;
        const bodySpeedMul = HYDRA_BODY_SPEED_HP_MIN_MUL
          + (1 - HYDRA_BODY_SPEED_HP_MIN_MUL) * bodyHpFrac;
        const step = m.speed * bodySpeedMul * dt / 1000;
        let nx = m.x + (dx / d) * Math.min(step, d);
        let ny = m.y + (dy / d) * Math.min(step * 0.6, Math.abs(dy));
        // Floor band.
        ny = Math.max(Scene.FLOOR_TOP + 16, Math.min(Scene.FLOOR_BOTTOM - 10, ny));
        // Avoid the pond but NOT the cave — the hydra lives there.
        if (Scene.avoidPondStep) {
          [nx, ny] = Scene.avoidPondStep(m.x, m.y, nx, ny, tx, ty, m);
        }
        m.x = nx;
        m.y = ny;
        m.dir = (dx >= 0) ? "r" : "l";
      }
      tryRegrowHeads(m, now);
    }
    return false;
  }

  function tickHydraHead(m, dt, now) {
    const body = m.parent;
    if (!body) return true;
    if (body.dying) {
      if (!m.dying) {
        m.dying = true;
        m.dyingStart = now + m.slot * 80;
      }
      if (now < m.dyingStart) return false;
      setHydraHeadPose(m, now);
      return now - m.dyingStart > (HYDRA_DYING_MS - Math.min(m.slot * 70, 240));
    }
    if (m.dying) return now - m.dyingStart > HYDRA_DYING_MS;
    if (body.state !== "active") {
      setHydraHeadPose(m, now);
      return false;
    }
    if (m.severed) {
      setHydraHeadPose(m, now);
      return false;
    }
    if (m.state === "idle") {
      setHydraHeadPose(m, now);
      if (now - m.lastAttackAt < m.atk.cdMs) return false;
      // Enrage shortens both bite and spit windups by 25% so the
      // second half of the fight feels noticeably more frantic.
      const windMul = body.enraged ? HYDRA_ENRAGE_WINDUP_MUL : 1;
      // Try a melee bite first: short windup + long reach + heavy
      // damage if anyone's standing close enough.
      const meleeTarget = pickHydraHeadTarget(m);
      if (meleeTarget) {
        m.target = meleeTarget;
        m.state = "winding";
        m.windUntil = now + HYDRA_HEAD_WINDUP_MS * windMul;
        // Live-tracked telegraph above the targeted hero — its own
        // sprite (zigzag fang ring), distinct from a meteor warn.
        Combat.hydraStrikeWarn(meleeTarget, HYDRA_HEAD_WINDUP_MS * windMul);
        setHydraHeadPose(m, now);
        return false;
      }
      // Nobody in bite range → spit fire at the most threatening
      // hero we can see anywhere on the lawn.  This is what stops
      // a parked archer / witch / ninja from chipping the body down
      // for free from the far side of the screen.  The firemage is
      // immune (filtered out by pickHydraSpitTarget).
      const spitTarget = pickHydraSpitTarget(m);
      if (spitTarget) {
        m.target = spitTarget;
        m.state = "spitWinding";
        m.windUntil = now + HYDRA_SPIT_WINDUP_MS * windMul;
        Combat.hydraSpitWarn(spitTarget, HYDRA_SPIT_WINDUP_MS * windMul);
        setHydraHeadPose(m, now);
        return false;
      }
      return false;
    }
    if (m.state === "winding") {
      const target = m.target;
      if (!target || target.hp <= 0 || !hydraHeadCanReach(m, target, HYDRA_REACH_STRIKE + 20)) {
        m.state = "idle";
        m.target = null;
        setHydraHeadPose(m, now);
        return false;
      }
      setHydraHeadPose(m, now);
      if (now >= m.windUntil) {
        m.state = "striking";
        m.strikeAt = now;
        m.stateUntil = now + HYDRA_STRIKE_MS;
        // Damage = base × enrage × link.  Combat.hydraStrike picks
        // up the supplied dmg over head.atk.dmg if provided.
        const biteDmg = Math.max(1, Math.round(m.atk.dmg * hydraOutgoingDmgMul(body)));
        Combat.hydraStrike(m, target, biteDmg);
        // Per-element bite rider (burn / vulnerable / root / chill /
        // poison) — the README's "bite debuff" column.  Dispatch sits
        // in combat.js so all element bookkeeping (debuff splash FX,
        // applyDebuff call) lives next to the spit logic.
        if (Combat.hydraApplyBiteDebuff) {
          Combat.hydraApplyBiteDebuff(m, target);
        }
      }
      return false;
    }
    if (m.state === "spitWinding") {
      const target = m.target;
      if (!target || target.hp <= 0) {
        m.state = "idle";
        m.target = null;
        m._spitArmed = false;
        setHydraHeadPose(m, now);
        return false;
      }
      setHydraHeadPose(m, now);
      if (now >= m.windUntil) {
        m.state = "striking";
        m.strikeAt = now;
        m.stateUntil = now + HYDRA_STRIKE_MS;
        m._spitArmed = true;
        // Damage = base × enrage × link, same as the bite path.
        const spitDmg = Math.max(1, Math.round(HYDRA_SPIT_DMG * hydraOutgoingDmgMul(body)));
        // Per-element spit dispatch: fire lobs (legacy hydraSpit),
        // acid blob, ice shard, poison bolt, or instant lightning
        // arc — see Combat.hydraElementSpit's switch on head.element.
        // Falls back to plain hydraSpit for any unknown element so a
        // mis-tagged head can't drop the attack entirely.
        if (Combat.hydraElementSpit) {
          Combat.hydraElementSpit(m, target, spitDmg);
        } else {
          Combat.hydraSpit(m, target, spitDmg);
        }
      }
      return false;
    }
    if (m.state === "striking") {
      setHydraHeadPose(m, now);
      if (now >= m.stateUntil) {
        m.state = "retracting";
        m.stateUntil = now + HYDRA_RETRACT_MS;
      }
      return false;
    }
    if (m.state === "retracting") {
      setHydraHeadPose(m, now);
      if (now >= m.stateUntil) {
        m.state = "idle";
        m.target = null;
        m._spitArmed = false;
        m.lastAttackAt = now;
      }
      return false;
    }
    setHydraHeadPose(m, now);
    return false;
  }

  function hydraHeadCanReach(head, target, reach) {
    if (!target || target.hp <= 0) return false;
    const body = head.parent;
    if (!body) return false;
    const dx = target.x - body.x;
    const dy = (target.y - 14) - body.y;
    const d = Math.hypot(dx, dy);
    if (d > reach) return false;
    const ang = Math.atan2(dy, dx);
    const delta = Math.atan2(Math.sin(ang - head.baseAngle), Math.cos(ang - head.baseAngle));
    return Math.abs(delta) <= HYDRA_SECTOR_HALF_ANGLE;
  }

  // Tally how many sister heads (alive, not severed) are currently
  // committed to each hero — used to enforce HYDRA_HEADS_PER_TARGET so
  // five heads don't all dogpile a single victim and one-shot them.
  function hydraHeadLoadByTarget(body) {
    const counts = new Map();
    for (const sister of hydraHeads(body)) {
      if (sister.severed || sister.dying) continue;
      const t = sister.target;
      if (!t || t.hp <= 0) continue;
      if (sister.state !== "winding" && sister.state !== "striking" &&
          sister.state !== "spitWinding") continue;
      counts.set(t, (counts.get(t) || 0) + 1);
    }
    return counts;
  }

  // Decoys / smoke / taunt awareness shared by the bite + spit
  // pickers.  Without this the entire decoy + smoke + taunt kit was
  // invisible to the hydra: pickHydraHeadTarget went straight at the
  // real heroes, so girl decoys + ninja smoke + knight taunt simply
  // didn't exist for the boss.  Returns:
  //   • a large negative number for "go for this one" (decoy / taunt)
  //   • a large positive number for "skip this one" (smoke)
  //   • 0 for the neutral case
  function hydraTargetMod(target, now) {
    if (target.smokeUntil && target.smokeUntil > now) return 9999;
    if (target.tauntUntil && target.tauntUntil > now) return -180;
    if (target.isDecoy || target.decoy) return -240;
    return 0;
  }

  function hydraDecoys() {
    if (typeof Characters === "undefined" || !Characters.listDecoys) return [];
    return Characters.listDecoys();
  }

  function pickHydraHeadTarget(head) {
    const body = head.parent;
    if (!body || typeof Characters === "undefined") return null;
    const load = hydraHeadLoadByTarget(body);
    const now = performance.now();
    let best = null;
    let bestScore = Infinity;
    // Real heroes first.
    for (const c of Characters.list) {
      if (!Characters.isVisibleNow(c)) continue;
      if (c.hp <= 0 || c.combatMode === "dead" || c.combatMode === "ufoing") continue;
      if (!hydraHeadCanReach(head, c, HYDRA_REACH_STRIKE)) continue;
      const taken = load.get(c) || 0;
      // Hard cap: never attach a third head to the same hero.
      if (taken >= HYDRA_HEADS_PER_TARGET) continue;
      const d = Math.hypot(c.x - head.parent.x, c.y - head.parent.y);
      const healerBonus = c.role === "healer" ? -22 : 0;
      // Mild push toward "next free" hero: an already-claimed-once
      // hero costs +60 px-equivalent so a fresh hero a touch farther
      // away still wins.
      const stackPenalty = taken > 0 ? 60 : 0;
      const mod = hydraTargetMod(c, now);
      const score = d + healerBonus + stackPenalty + mod;
      if (score < bestScore) {
        bestScore = score;
        best = c;
      }
    }
    // Decoys are valid bite targets too — the bite wastes itself on
    // the puff of smoke, which is exactly what the girl signed up
    // for when she cast it.  We use a fresh stack count per decoy
    // (decoys aren't keyed in `load`, since hydraHeadLoadByTarget
    // walks Characters-only).
    for (const d of hydraDecoys()) {
      if (d.fadeStartAt > 0) continue;
      if (d.hp <= 0) continue;
      if (!hydraHeadCanReach(head, d, HYDRA_REACH_STRIKE)) continue;
      const dist = Math.hypot(d.x - head.parent.x, d.y - head.parent.y);
      const score = dist + hydraTargetMod(d, now);
      if (score < bestScore) {
        bestScore = score;
        best = d;
      }
    }
    for (const mo of list) {
      if (!hydraCanTargetMonster(mo)) continue;
      if (!hydraHeadCanReach(head, mo, HYDRA_REACH_STRIKE)) continue;
      const taken = load.get(mo) || 0;
      if (taken >= HYDRA_HEADS_PER_TARGET) continue;
      const dist = Math.hypot(mo.x - head.parent.x, mo.y - head.parent.y);
      const stackPenalty = taken > 0 ? 60 : 0;
      const score = dist + stackPenalty;
      if (score < bestScore) {
        bestScore = score;
        best = mo;
      }
    }
    return best;
  }

  // Count heads that are currently committed to spit (windup, mid-
  // strike, or with the projectile presumably still in flight up to
  // the next idle).  Used to cap simultaneous spit pressure.
  function hydraActiveSpitCount(body) {
    let n = 0;
    for (const h of hydraHeads(body)) {
      if (h.severed || h.dying) continue;
      if (h.state === "spitWinding") n++;
      else if (h.state === "striking" && h.target && h._spitArmed) n++;
    }
    return n;
  }

  // Pick a long-range spit target: any visible hero on the lawn the
  // hydra can "see" (line of sight is implicit — there are no walls),
  // biased toward the most threatening / squishiest in range.  Same
  // 2-heads-per-target cap so the team isn't spit-locked.
  function pickHydraSpitTarget(head) {
    const body = head.parent;
    if (!body || typeof Characters === "undefined") return null;
    // Refuse to spit when the salvo is already saturated — keeps the
    // ranged-ring under the "one acid per cycle" budget the healer
    // can actually keep up with.  See HYDRA_SPIT_ACTIVE_CAP.
    if (hydraActiveSpitCount(body) >= HYDRA_SPIT_ACTIVE_CAP) return null;
    const load = hydraHeadLoadByTarget(body);
    const now = performance.now();
    let best = null;
    let bestScore = Infinity;
    for (const c of Characters.list) {
      if (!Characters.isVisibleNow(c)) continue;
      if (c.hp <= 0 || c.combatMode === "dead" || c.combatMode === "ufoing") continue;
      // Per-element immunity: firemage to fire, zombie/robot to
      // poison, etc. (see HYDRA_ELEMENT_IMMUNE for the full table).
      // An immune hero can't be hurt by this kind of spit, so don't
      // waste a salvo budget slot on them — fall through to a real
      // target.  Resist heroes are NOT skipped here; they're handled
      // below as a soft de-prioritisation so a head that has nobody
      // else can still chip them.
      if (isElementImmune(hydraTargetElementId(c), head.element)) continue;
      const dx = c.x - body.x, dy = c.y - body.y;
      const d = Math.hypot(dx, dy);
      if (d > HYDRA_SPIT_RANGE) continue;
      // Spit ignores the per-head sector — the hydra can rear any
      // head into firing position before launching.  We only require
      // the target to be roughly in the lower-right hemisphere of
      // the lair so an off-screen / above-the-cliff target is
      // skipped (heroes never go there in normal play, but worth
      // gating defensively).
      if (dy < -30) continue;
      const taken = load.get(c) || 0;
      if (taken >= HYDRA_HEADS_PER_TARGET) continue;
      // Spit is for pressuring the BACKLINE, not deleting the healer
      // on cooldown.  The previous healer bias made the whole support
      // role impossible: the girl had to stand near the front to heal
      // the tank, and every head immediately preferred her over the
      // fighters actually in melee.  In practice that meant "healer
      // takes the first acid, panics or dies, then the front line
      // collapses".  Flip the weighting: the healer is now mildly
      // DISfavoured, while exposed ranged chip-damage dealers remain
      // attractive but not overwhelmingly so.
      let bonus = 0;
      if (c.role === "healer") bonus += 70;
      if (c.atk && c.atk.kind && (c.atk.kind === "fireball" ||
          c.atk.kind === "hex" || c.atk.kind === "arrow")) bonus -= 12;
      // Soft de-prioritisation for elemental resists: still a legal
      // target (so the head doesn't run out of choices and stand
      // there idle), but other heroes get picked first when the
      // numbers are otherwise close.  ~one-screen-width worth of
      // bias is enough that any non-resist within line of sight wins
      // the comparison, while a resist who is the ONLY thing in
      // range still gets shot at — half-damage chip is better than
      // nothing.
      if (isElementResist(hydraTargetElementId(c), head.element)) bonus += 60;
      const stackPenalty = taken > 0 ? 80 : 0;
      const mod = hydraTargetMod(c, now);
      const score = d + bonus + stackPenalty + mod;
      if (score < bestScore) {
        bestScore = score;
        best = c;
      }
    }
    // Decoys eat spit too — wasting a long-range shot on a clone is
    // exactly the trade the girl is paying her cooldown for.
    for (const d of hydraDecoys()) {
      if (d.fadeStartAt > 0) continue;
      if (d.hp <= 0) continue;
      const dx = d.x - body.x, dy = d.y - body.y;
      const dist = Math.hypot(dx, dy);
      if (dist > HYDRA_SPIT_RANGE) continue;
      if (dy < -30) continue;
      const score = dist + hydraTargetMod(d, now);
      if (score < bestScore) {
        bestScore = score;
        best = d;
      }
    }
    for (const mo of list) {
      if (!hydraCanTargetMonster(mo)) continue;
      if (isElementImmune(hydraTargetElementId(mo), head.element)) continue;
      const dx = mo.x - body.x, dy = mo.y - body.y;
      const d = Math.hypot(dx, dy);
      if (d > HYDRA_SPIT_RANGE) continue;
      if (dy < -30) continue;
      const taken = load.get(mo) || 0;
      if (taken >= HYDRA_HEADS_PER_TARGET) continue;
      let bonus = 0;
      if (isElementResist(hydraTargetElementId(mo), head.element)) bonus += 60;
      const stackPenalty = taken > 0 ? 80 : 0;
      const score = d + bonus + stackPenalty;
      if (score < bestScore) {
        bestScore = score;
        best = mo;
      }
    }
    return best;
  }

  // Two-for-one regrow with staggered birth times so the player
  // visually catches "and another one!".  The first head re-grows at
  // its own slot (the original stump heals over); the bonus head
  // pops up in the next free slot ~600 ms later, with a short
  // post-birth pause before it can attack.
  //
  // The bonus is gated by HYDRA_BONUS_CAP (4) rather than
  // HYDRA_HEAD_MAX (5) so a competent magic-heavy team can hold the
  // head count at 4 instead of being inevitably dragged to 5; at the
  // cap we only regrow what was severed.  The visual story still
  // reads as "and another one!" while there's room to fill, but the
  // team's effort no longer makes the encounter strictly worse.
  function tryRegrowHeads(body, now) {
    let active = hydraActiveHeadCount(body);
    if (active >= HYDRA_HEAD_MAX) return;
    const sisters = hydraHeads(body).sort((a, b) => a.slot - b.slot);
    for (const head of sisters) {
      if (!head.severed || head.regrowAt > now) continue;
      regrowHydraHead(head, now);
      active++;
      if (active >= HYDRA_HEAD_MAX) break;
      if (active >= HYDRA_BONUS_CAP) continue;
      const free = hydraFreeSlots(body);
      if (!free.length) continue;
      const extra = makeHydraHead(body, free[0]);
      // Bonus head can't attack for a beat after birth — gives the
      // team a small window to react to the doubled count.
      extra.lastAttackAt = now + 600;
      list.push(extra);
      // Visual fanfare: green dust at the new slot anchor, plus a
      // small shake for the birth itself.
      const ax = extra.anchorX, ay = extra.anchorY;
      Combat.dirtBurst(ax, ay, true, { palette: "green", count: 6, scale: 0.7, life: 460 });
      if (Combat.hydraSproutFx) Combat.hydraSproutFx(ax, ay - 1, 600);
      Scene.shake(1.4, 160);
      active++;
      if (active >= HYDRA_HEAD_MAX) break;
    }
  }

  function regrowHydraHead(head, now) {
    head.severed = false;
    head.hp = head.maxHp = HYDRA_HEAD_HP;
    head.target = null;
    head.state = "idle";
    // Slight pause before attacking again — also avoids the visual
    // teleport of "reappear and immediately strike".
    head.lastAttackAt = now + 300;
    head.regrowAt = 0;
    head.hitFlashUntil = now + 160;
    setHydraHeadPose(head, now);
    Combat.dirtBurst(head.anchorX, head.anchorY - 1, true, { palette: "green", count: 6, scale: 0.7, life: 420 });
    if (Combat.hydraSproutFx) Combat.hydraSproutFx(head.anchorX, head.anchorY - 1, 0);
  }

  // Number of living, non-severed sister heads on a body.  Drives
  // the head-link damage multiplier (each extra head adds +10%
  // outgoing damage to her sisters' bites and spits) and the
  // sever-roar reinforcement check.  Cheap to call per attack —
  // the head list is small.
  function aliveHydraSisters(body) {
    if (!body) return 0;
    let n = 0;
    for (const h of hydraHeads(body)) {
      if (h.severed || h.dying) continue;
      if (h.hp <= 0) continue;
      n++;
    }
    return n;
  }

  // Combined damage multiplier on a single bite/spit:
  //   • enrage boost (×1.25 once body HP < 50%)
  //   • head-link bonus (+10% per additional living sister)
  // Capped softly at 5 heads × 0.4 link = ×1.4 link, ×1.75 enraged,
  // so a fully-grown hydra at <50% HP hits like ×2.18 of base.
  function hydraOutgoingDmgMul(body) {
    if (!body) return 1;
    const link = 1 + Math.max(0, aliveHydraSisters(body) - 1) * HYDRA_LINK_BONUS_PER_HEAD;
    const enrage = body.enraged ? HYDRA_ENRAGE_DMG_MUL : 1;
    return link * enrage;
  }

  // Tail sweep: a periodic AoE around the body that hits every
  // hero standing within HYDRA_TAIL_RANGE.  Three-phase state
  // machine so the player can read the windup and dodge:
  //   rest     — body is idle, waiting for `tailNextAt` to elapse
  //   winding  — telegraph: dust ring + body shake + dialog tone
  //   striking — apply damage to everyone in range, brief screen
  //              shake, then schedule the next sweep
  // Tail goes silent during dying so the death animation reads
  // cleanly.  Not gated by per-head AI — runs from tickHydraBody
  // even if every head is severed (the body still has a tail).
  function tickHydraTail(body, now) {
    if (!body || body.dying) return;
    if (body.tailState === "rest") {
      if (!body.tailNextAt) return;
      if (now < body.tailNextAt) return;
      body.tailState = "winding";
      body.tailUntil = now + HYDRA_TAIL_WINDUP_MS;
      // Telegraph: a low dust ring at body feet + small shake.
      Combat.dirtBurst(body.x, body.y + 8, false, { palette: "rock", count: 7, scale: 0.85, life: 520 });
      Scene.shake(1.6, 180);
      if (typeof Dialog !== "undefined" && Dialog.note) Dialog.note("alarm");
      return;
    }
    if (body.tailState === "winding") {
      if (now < body.tailUntil) return;
      body.tailState = "striking";
      body.tailUntil = now + HYDRA_TAIL_STRIKE_MS;
      // Apply damage in a ring around the body — every visible
      // hero within HYDRA_TAIL_RANGE eats the swipe.  Skips dead
      // / offstage / ufoing.  Damage scales with enrage but NOT
      // with head link (the tail isn't a sister).
      const dmg = Math.max(1, Math.round(
        HYDRA_TAIL_DMG * (body.enraged ? HYDRA_ENRAGE_DMG_MUL : 1)));
      if (typeof Characters !== "undefined" && Characters.list) {
        for (const c of Characters.list) {
          if (!Characters.isVisibleNow(c)) continue;
          if (c.hp <= 0 || c.combatMode === "dead" || c.combatMode === "ufoing") continue;
          const d = Math.hypot(c.x - body.x, c.y - body.y);
          if (d > HYDRA_TAIL_RANGE) continue;
          Characters.damage(c, dmg, body);
          // Per-hero hit FX so the AoE reads as an actual landed
          // attack on each victim, not a distant rumble.
          Combat.dirtBurst(c.x, c.y - 4, true, { palette: "rock", count: 4, scale: 0.6, life: 280 });
        }
      }
      Scene.shake(3.0, 260);
      return;
    }
    if (body.tailState === "striking") {
      if (now < body.tailUntil) return;
      body.tailState = "rest";
      // Jittered cooldown so the player can't memorise the cycle.
      body.tailNextAt = now + HYDRA_TAIL_CD_MS + (Math.random() * 2000 - 1000);
    }
  }

  // ---------- worm AI ----------
  //
  // Runs in place of the regular monster step for `m.kind === "worm"`.
  // Returns true iff the worm should be removed from the list this
  // tick (used for the silent despawn of bored lurkers).
  function tickWorm(m, dt, now) {
    if (m.state === "under") {
      // Trigger 0: a mounted hero (currently the girl on her
      // summoned horse) galloped over the mound — the hooves crush
      // the worm before it can pop up to bite.  Wider radius than
      // the regular stepped-on check (the horse silhouette is wider
      // than a pair of boots), and we kill the worm in place rather
      // than surfacing it.  Visual is a quick low scatter of dirt
      // (the "splash" the player sees when the mound caves in)
      // tuned smaller than the regular worm-death geyser.
      const stomperMount = wormStompedByMount(m);
      if (stomperMount) { crushWormUnderHoof(m, now); return false; }
      // Trigger 1: someone (on foot) steps on the mound — instant
      // emerge, targeted at the stomper so the bite lands the same
      // beat.  Mounted heroes are filtered out here too because the
      // mount-stomp branch above already handled them.
      const stomper = wormSteppedOn(m);
      if (stomper) { surfaceWorm(m, now, stomper); return false; }

      // Trigger 2: drift toward the loudest reachable sound source.
      // Once close enough, surface; let the attacking branch pick
      // the actual hero target via nearestHero.  A help-call also
      // latches a "last-known" position (m.alarmTarget / m.alarmUntil)
      // so the worm keeps closing on it after the shout itself
      // expires — otherwise WORM_SPEED_UNDER vs HELP_LIFETIME_MS just
      // means the worm gives up before it gets there.
      const src = wormFindSoundSource(m, now);
      if (src && src.kind === "help") {
        m.alarmTarget = { x: src.x, y: src.y };
        m.alarmUntil = now + WORM_ALARMED_MS;
      }
      const chase =
        src ||
        (m.alarmUntil > now && m.alarmTarget
          ? { x: m.alarmTarget.x, y: m.alarmTarget.y, kind: "alarm" }
          : null);
      if (chase) {
        m.soundTarget = chase;
        // Re-pick wander after the chase so the next idle target is
        // freshly chosen from wherever we end up, not from the spot
        // we left behind to investigate the noise.
        m.wanderUntil = 0;
        const dx = chase.x - m.x, dy = chase.y - m.y;
        const d = Math.hypot(dx, dy) || 1;
        if (d < 8) {
          // Reached the noise — surface and let the attack branch
          // pick a hero target.  Clear the latch so we don't keep
          // re-chasing this same spot after the dive resolves.
          m.alarmUntil = 0;
          m.alarmTarget = null;
          surfaceWorm(m, now, null);
          return false;
        }
        // Help-calls (and the latched investigation that follows) use
        // the alarmed sprint speed; idle chat keeps the lazy lurking
        // pace so a couple of chatting heroes don't yank a worm
        // across the lawn.
        const speed = (chase.kind === "talk")
          ? WORM_SPEED_UNDER
          : WORM_SPEED_ALARMED;
        const s = speed * dt / 1000;
        let nx = m.x + (dx / d) * Math.min(d, s);
        // Drift y only half-speed: feels like the worm is mostly
        // moving along the lawn band rather than rocketing diagonally.
        let ny = m.y + Math.sign(dy) * Math.min(Math.abs(dy), s * 0.5);
        [nx, ny] = Scene.avoidPondStep(m.x, m.y, nx, ny, chase.x, chase.y, m);
        m.x = nx; m.y = ny;
        m.dir = dx >= 0 ? "r" : "l";
      } else {
        // No noise to chase — the worm is a restless background
        // critter, not a stationary trap.  Pick a random lawn target
        // and crawl to it; once there, idle a bit and pick another.
        m.soundTarget = null;
        wormWanderTick(m, dt, now);
      }

      // Slow "breathing" pulse on the mound so it visibly lives.
      m.frameTimer += dt;
      if (m.frameTimer > 320) { m.frameTimer = 0; m.frame ^= 1; }

      // No despawn: a buried worm persists like any other monster
      // until something kills it.  (count() filters hidden worms so
      // they don't gate the wave director.)
      return false;
    }

    if (m.state === "emerging") {
      if (now >= m.stateUntil) {
        m.state = "attacking";
        m.surfacedAt = now;
        m.lastBiteAt = 0;
        m.speed = WORM_SPEED_SURFACE;
      }
      return false;
    }

    if (m.state === "submerging") {
      if (now >= m.stateUntil) {
        m.state = "under";
        m.soundTarget = null;
        m.target = null;
        m.frame = 0;
        m.speed = WORM_SPEED_UNDER;
        // Force wander re-pick so a worm that just dove from a
        // failed bite doesn't loiter — it crawls off looking like
        // it's looking for easier prey.
        m.wanderUntil = 0;
        m.wanderIdleUntil = 0;
      }
      return false;
    }

    // ATTACKING — chase + bite, mirroring the grounded-monster path.
    // Dive again after a fixed surface window or a stretch with no
    // successful bite so we don't get an indestructible turret stuck
    // in the middle of the lawn.
    if (now - m.surfacedAt > WORM_MAX_SURFACE_MS ||
        (m.lastBiteAt > 0 && now - m.lastBiteAt > WORM_NO_BITE_TIMEOUT_MS)) {
      submergeWorm(m, now);
      return false;
    }

    const [hero] = nearestHero(m);
    m.target = hero;
    if (!hero) { submergeWorm(m, now); return false; }

    const dx = hero.x - m.x;
    const dy = hero.y - m.y;
    const d = Math.hypot(dx, dy) || 1;

    if (d > m.atk.range) {
      const s = m.speed * dt / 1000;
      const ty = Math.max(Scene.FLOOR_TOP + 20,
                          Math.min(Scene.FLOOR_BOTTOM - 10, hero.y));
      const vy = (ty - m.y);
      let nx = m.x + (dx / d) * Math.min(d, s);
      let ny = m.y + Math.sign(vy) * Math.min(Math.abs(vy), s * 0.6);
      [nx, ny] = Scene.avoidPondStep(m.x, m.y, nx, ny, hero.x, ty, m);
      m.x = nx; m.y = ny;
      m.dir = dx >= 0 ? "r" : "l";
      m.frameTimer += dt;
      if (m.frameTimer > 160) { m.frameTimer = 0; m.frame ^= 1; }
    } else if (now - m.lastAttackAt > m.atk.cdMs) {
      Combat.monsterAttack(m, hero);
      m.lastAttackAt = now;
      m.lastBiteAt = now;
    }
    return false;
  }

  function surfaceWorm(m, now, hero) {
    m.state = "emerging";
    m.stateUntil = now + WORM_EMERGE_MS;
    m.target = hero;
    m.frame = 0;
    m.frameTimer = 0;
    // Soil eruption — same scattered-clod burst as submerge, just a
    // touch larger so the surface read as a real eruption.  The
    // older 5× `Combat.puff` calls each painted a 20×10 brown
    // rectangle, which stacked into a single solid block hanging
    // over the mound.
    const onPath = Scene.isOnPath && Scene.isOnPath(m.x, m.y);
    Combat.dirtBurst(m.x, m.y - 2, !onPath);
    Combat.dirtBurst(m.x + rr(-3, 3), m.y - 1, !onPath);
  }

  function submergeWorm(m, now) {
    m.state = "submerging";
    m.stateUntil = now + WORM_SUBMERGE_MS;
    m.target = null;
    // Scattered earth shower from the dome rather than the old
    // 3× brown puff rectangles (which read as a flat brown block
    // hanging over the mound).  `dark` follows the mound palette
    // — dirt-tone clods on the path, peat-tone clods on the lawn.
    const onPath = Scene.isOnPath && Scene.isOnPath(m.x, m.y);
    Combat.dirtBurst(m.x, m.y - 2, !onPath);
  }

  // Buried, no noise nearby: drift toward a randomly chosen lawn
  // target.  When we get there, idle for WORM_WANDER_IDLE_MS and
  // then pick a new destination — same restless bg loop the slimes
  // and goblins have, just done in slow motion under the soil.
  function wormWanderTick(m, dt, now) {
    if (m.wanderIdleUntil && now < m.wanderIdleUntil) return;
    if (!m.wanderUntil || now > m.wanderUntil) pickWormWanderTarget(m, now);
    const dx = m.wanderTx - m.x;
    const dy = m.wanderTy - m.y;
    const d  = Math.hypot(dx, dy) || 1;
    if (d < WORM_WANDER_REACH_R) {
      // Arrived.  Pause briefly, then schedule a fresh target.
      m.wanderIdleUntil = now + WORM_WANDER_IDLE_MS;
      m.wanderUntil     = 0;
      return;
    }
    const s = WORM_SPEED_WANDER * dt / 1000;
    let nx = m.x + (dx / d) * Math.min(d, s);
    // Half-speed in y matches the sound-pursuit feel: the worm
    // mostly slides along the lawn band rather than diving deep.
    let ny = m.y + Math.sign(dy) * Math.min(Math.abs(dy), s * 0.6);
    [nx, ny] = Scene.avoidPondStep(m.x, m.y, nx, ny, m.wanderTx, m.wanderTy, m);
    m.x = nx; m.y = ny;
    m.dir = dx >= 0 ? "r" : "l";
  }

  function pickWormWanderTarget(m, now) {
    const grave = (typeof Scene !== "undefined" && Scene.grave) ? Scene.grave() : null;
    for (let attempt = 0; attempt < 8; attempt++) {
      const tx = rr(40, Scene.WIDTH - 40);
      const ty = rr(Scene.FLOOR_TOP + 30, Scene.FLOOR_BOTTOM - 18);
      // Don't crawl under the pond (the mound is 9 px wide so we
      // need a generous margin or the visible mound would clip into
      // the water) or under the gravestone (skeletons spawn there
      // — visual clash).  The same margin is applied to the
      // current-vs-target line: targets across the pond force the
      // worm to bounce indefinitely off the rim, which the player
      // reads as "stuck under the lake".
      if (Scene.isInPond && Scene.isInPond(tx, ty, 18)) continue;
      if (grave && Math.hypot(grave.x - tx, grave.y - ty) < 30) continue;
      // Reject targets too close to current position so we actually
      // travel somewhere — otherwise the worm picks a spot 5px away
      // and immediately re-idles.
      if (Math.hypot(tx - m.x, ty - m.y) < 50) continue;
      m.wanderTx = tx;
      m.wanderTy = ty;
      m.wanderUntil = now + WORM_WANDER_REPICK_MS;
      m.wanderIdleUntil = 0;
      return;
    }
    // No clean spot found this tick — try again next time around.
    m.wanderUntil = now + 500;
  }

  function wormSteppedOn(m) {
    if (typeof Characters === "undefined") return null;
    for (const c of Characters.list) {
      if (!Characters.isVisibleNow(c)) continue;
      if (c.hp <= 0 || c.combatMode === "dead") continue;
      if (c.combatMode === "ufoing") continue;     // alien is airborne, doesn't trigger
      // Mounted heroes go through the wider mount-stomp branch
      // instead — the horse crushes the mound before the worm can
      // surface, so the regular "boot pressure → emerge" trigger
      // mustn't also fire on the rider's centre tile.
      if (c.mounted) continue;
      const d = Math.hypot(c.x - m.x, c.y - m.y);
      if (d < WORM_STEPPED_ON_R) return c;
    }
    return null;
  }

  // Hoof-stomp variant.  Same shape as wormSteppedOn but mounted-only
  // and with a slightly wider radius (the horse silhouette covers
  // more ground than a human's footprint, and a brushing-past gallop
  // should still squish a mound centred under the saddle line).
  function wormStompedByMount(m) {
    if (typeof Characters === "undefined") return null;
    for (const c of Characters.list) {
      if (!c.mounted) continue;
      if (!Characters.isVisibleNow(c)) continue;
      if (c.hp <= 0 || c.combatMode === "dead") continue;
      const d = Math.hypot(c.x - m.x, c.y - m.y);
      if (d < WORM_STOMP_R) return c;
    }
    return null;
  }

  // Instant-kill the worm without spawning the regular dirt geyser
  // that Monsters.damage would emit on a normal kill — this is a
  // squish, not an eruption.  Two small low-scale dirtBursts give a
  // brief "clods squirting from under the hoof" feel; the dying
  // animation in drawWormDying still plays so the mound visibly
  // collapses.  Bypass the standard damage path so we don't double
  // up on the geyser AND so an attacker-bookkeeping ("who killed it")
  // pass doesn't credit the rider with a kill they didn't actively
  // commit to (the worm just happened to be under the hooves).
  function crushWormUnderHoof(m, now) {
    if (m.dying) return;
    m.hp = 0;
    m.dying = true;
    m.dyingStart = now;
    m.hitFlashUntil = now + 100;
    const onPath = Scene.isOnPath && Scene.isOnPath(m.x, m.y);
    Combat.dirtBurst(m.x, m.y - 1, !onPath, { count: 5, scale: 0.55, life: 360 });
    Combat.dirtBurst(m.x + rr(-3, 3), m.y, !onPath, { count: 3, scale: 0.45, life: 320 });
  }

  // Score the loudest perceivable noise.  Help-call weight (3) is
  // tuned so a shout always beats a nearby chat — fits the fiction
  // (the worm prefers wounded prey over idle gossip) and avoids the
  // worm getting magnetised to a chatting pair while heroes are
  // dying just out of range.
  function wormFindSoundSource(m, now) {
    if (typeof Characters === "undefined") return null;
    let best = null;
    let bestScore = -Infinity;
    for (const c of Characters.list) {
      if (!Characters.isVisibleNow(c)) continue;
      if (c.hp <= 0 || c.combatMode === "dead") continue;
      if (c.helpRequestUntil <= now) continue;
      const d = Math.hypot(c.x - m.x, c.y - m.y);
      if (d > WORM_HEAR_HELP_R) continue;
      const score = 3 - d / WORM_HEAR_HELP_R;
      if (score > bestScore) {
        bestScore = score;
        best = { x: c.x, y: c.y, kind: "help" };
      }
    }
    for (const c of Characters.list) {
      if (c.state !== "talking" || !c.partner) continue;
      // Canonicalise so each pair is scored once: only the leftmost
      // half of the conversation contributes the midpoint.
      if (c.x > c.partner.x) continue;
      const mx = (c.x + c.partner.x) / 2;
      const my = (c.y + c.partner.y) / 2;
      const d = Math.hypot(mx - m.x, my - m.y);
      if (d > WORM_HEAR_TALK_R) continue;
      const score = 1 - d / WORM_HEAR_TALK_R;
      if (score > bestScore) {
        bestScore = score;
        best = { x: mx, y: my, kind: "talk" };
      }
    }
    return best;
  }

  // Returns true iff THIS hit was the one that killed the monster, so
  // callers (Combat) can fire a "kill" bark on the attacker without
  // each weapon path having to remember to compare hp before/after.
  function damage(m, dmg, opts) {
    if (m.dying) return false;
    if (m.kind === "hydraHead" && m.severed) return false;
    let incoming = dmg;
    // Magic resist is BODY-ONLY: the heads are the soft, severable
    // target so even a pure-magic team can keep them lopped off.  The
    // body itself shrugs most spells (×0.30) so the team is still
    // pushed to bring something physical to actually finish the fight.
    if (m.kind === "hydraBody" && opts && HYDRA_MAGIC_KINDS.has(opts.weapon)) {
      incoming = Math.max(1, Math.round(incoming * HYDRA_BODY_MAGIC_MUL));
    }
    // Worm-vs-axe vulnerability: a viking's overhead axe chop on a
    // worm (surfaced or buried) lands for 1.5×.  Heroes call the
    // damage function with `opts.weapon` so we can distinguish the
    // axe from a generic shuriken / sword swing.
    if (m.kind === "worm" && opts && opts.weapon === "axe") {
      incoming = Math.round(incoming * 1.5);
    }
    m.hp = Math.max(0, m.hp - incoming);
    m.hitFlashUntil = performance.now() + 140;
    if (m.hp <= 0) {
      if (m.kind === "hydraHead") {
        severHydraHead(m, performance.now());
        return false;
      }
      m.dying = true;
      m.dyingStart = performance.now();
      if (m.kind === "worm") {
        const onPath = Scene.isOnPath && Scene.isOnPath(m.x, m.y);
        Combat.dirtBurst(m.x, m.y - 2, !onPath);
      }
      if (m.kind === "hydraBody") {
        killHydraBody(m, performance.now());
      }
      // Slime split-on-death: spawn 2 micro-slimes with reduced HP,
      // damage and lifetime so the kill still feels rewarding but
      // gives the player a small "ugh, more of them" beat.  Skipped
      // for slimes that ARE micros already (no infinite chain) and
      // when the slime was already part of a split (tracked via the
      // `_splitDone` flag set on micros at create time).
      if (m.kind === "slime" && !m._splitDone) {
        const t = TYPES.slime;
        for (let k = 0; k < 2; k++) {
          const ang = Math.random() * Math.PI * 2;
          const r = 6 + Math.random() * 4;
          const mx = m.x + Math.cos(ang) * r;
          const my = m.y + Math.sin(ang) * r;
          const child = create("slime", mx, my, m.groupId);
          child.hp = child.maxHp = Math.max(6, Math.round(t.hp * 0.4));
          child.atk.dmg = Math.max(2, Math.round(t.atk.dmg * 0.5));
          child.w = Math.max(8, Math.round(t.w * 0.6));
          child.h = Math.max(6, Math.round(t.h * 0.6));
          child.speed = t.speed * 1.2;       // micros scoot
          child._splitDone = true;            // never split again
          list.push(child);
        }
      }
      return true;
    }
    return false;
  }

  function severHydraHead(m, now) {
    // Snapshot the death-blow tip BEFORE we collapse the pose: the
    // falling-head FX needs the place where the head was, not the
    // stump it'll snap back to.
    const fx = m.tipX, fy = m.tipY;
    const launchVx = (fx - m.anchorX) * 1.4;
    m.severed = true;
    m.hp = 0;
    m.target = null;
    m.state = "idle";
    m.regrowAt = now + HYDRA_REGROW_MS;
    m.hitFlashUntil = now + 200;
    setHydraHeadPose(m, now);
    // Falling head + fountain of blood + small ground splat: this is
    // the single most important moment for the encounter to read, so
    // the FX budget here is generous.
    if (Combat.hydraSeverFx) {
      Combat.hydraSeverFx(fx, fy, launchVx);
    } else {
      Combat.dirtBurst(fx, fy, true, { palette: "green", count: 5, scale: 0.6, life: 400 });
    }
    Scene.shake(2.6, 220);
    // Sever roar: every Nth severed head triggers a "she's calling
    // for help" beat — two weakened slimes pour out of the lair as
    // reinforcements.  Severing isn't free anymore: cut three heads
    // → fight a small swarm too.  Skipped if the body is already
    // dying so death doesn't summon a posthumous wave.
    const body = m.parent;
    if (body && !body.dying) {
      body.severCount = (body.severCount || 0) + 1;
      if (body.severCount % HYDRA_SEVER_ROAR_EVERY === 0) {
        spawnSeverRoarSlimes(body, now);
      }
    }
  }

  // Pour out HYDRA_SEVER_SLIME_COUNT weakened slimes from the lair
  // mouth as reinforcements after the Nth sever this fight.  Slimes
  // get reduced HP and damage so the swarm is a "now you're also
  // fighting THEM" pressure beat rather than a second mini-wave.
  // Visual: heavy green dust burst at the lair, small shake, dialog
  // tone shift.  The slimes are real Monsters.list entries and use
  // the standard slime AI from there on out.
  function spawnSeverRoarSlimes(body, now) {
    const t = TYPES.slime;
    const lairX = (typeof body.lairX === "number") ? body.lairX : body.x;
    const lairY = (typeof body.lairY === "number") ? body.lairY : body.y;
    for (let k = 0; k < HYDRA_SEVER_SLIME_COUNT; k++) {
      const ang = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 0.8;
      const r = 14 + Math.random() * 10;
      const sx = lairX + Math.cos(ang) * r;
      const sy = lairY + Math.sin(ang) * r * 0.6 + 12;
      const child = create("slime", sx, sy, body.groupId);
      child.hp = child.maxHp = Math.max(6, Math.round(t.hp * HYDRA_SEVER_SLIME_HP_MUL));
      child.atk.dmg = Math.max(1, Math.round(t.atk.dmg * HYDRA_SEVER_SLIME_DMG_MUL));
      // Faintly distinguishable from regular slimes — slightly
      // smaller and a touch faster, reads as "spawned thing" not
      // "one of the wave we just killed".
      child.w = Math.max(8, Math.round(t.w * 0.85));
      child.h = Math.max(6, Math.round(t.h * 0.85));
      child.speed = t.speed * 1.15;
      child._splitDone = true;       // sever-spawn: no second split
      list.push(child);
    }
    Combat.dirtBurst(lairX, lairY + 6, false, { palette: "green", count: 10, scale: 1.0, life: 520 });
    Combat.dirtBurst(lairX, lairY,     false, { palette: "rock",  count: 6,  scale: 0.9, life: 420 });
    Scene.shake(2.4, 260);
    if (typeof Dialog !== "undefined" && Dialog.note) Dialog.note("alarm");
  }

  function killHydraBody(m, now) {
    const lair = (typeof Scene !== "undefined" && Scene.hydraLair) ? Scene.hydraLair() : null;
    m.dying = true;
    m.dyingStart = now;
    if (lair) lair.state = "dying";
    // Tell the team-level coordinator to stand down so heroes drop
    // their boss roles and walk back to their normal routines on
    // the next combat tick.
    if (typeof Characters !== "undefined" && Characters.HydraPlan
        && Characters.HydraPlan.deactivate) {
      Characters.HydraPlan.deactivate();
    }
    // Multi-stage stone collapse: an immediate burst of dust plus a
    // staggered cascade of rock chunks bouncing out of the cave over
    // ~600 ms.  Heavy shake punctuates the moment as the body sinks
    // back into the rocks.
    Combat.dirtBurst(m.x - 6, m.y + 4, false, { palette: "rock", count: 8, scale: 1.0,  life: 560 });
    Combat.dirtBurst(m.x,     m.y - 2, false, { palette: "rock", count: 10, scale: 1.1, life: 620 });
    Combat.dirtBurst(m.x + 6, m.y + 4, false, { palette: "rock", count: 8, scale: 1.0,  life: 560 });
    Combat.dirtBurst(m.x,     m.y + 2, false, { palette: "green", count: 8, scale: 0.85, life: 520 });
    if (Combat.rockChunks) {
      Combat.rockChunks(m.x, m.y, 12);
      Combat.rockChunks(m.x - 8, m.y + 6, 6);
      Combat.rockChunks(m.x + 8, m.y + 6, 6);
    }
    Scene.shake(3.6, 520);
    for (const h of hydraHeads(m)) {
      if (h.dying) continue;
      h.dying = true;
      h.dyingStart = now + h.slot * 90;
      h.target = null;
    }
  }

  // ---------- rendering ----------

  function drawOne(ctx, m, now) {
    const flash = now < m.hitFlashUntil;
    if (m.kind === "hydraBody") {
      return drawHydraBody(ctx, m, flash, now);
    }
    if (m.kind === "hydraHead") {
      return drawHydraHead(ctx, m, flash, now);
    }
    if (m.dying) {
      const t = (now - m.dyingStart) / 500;
      // Worm has its own death animation — body droops & sinks back
      // into the mound, mound itself collapses, and the dirt-clod
      // burst (fired from `damage`) handles the soil scatter.  No
      // grey square is painted for it; that effect was meant for
      // upright sprites and on the worm it just looked like a
      // brown block hovering over the dome.
      if (m.kind === "worm") {
        return drawWormDying(ctx, m, t, now);
      }
      ctx.globalAlpha = Math.max(0, 1 - t);
      drawBody(ctx, m, now);
      ctx.globalAlpha = 1;
      // Poof
      const r = 3 + t * 6;
      ctx.fillStyle = `rgba(200,200,200,${Math.max(0, 1 - t) * 0.6})`;
      ctx.fillRect(m.x - r, m.y - m.h / 2 - r, r * 2, r * 2);
      return;
    }
    if (flash) {
      ctx.save();
      ctx.globalCompositeOperation = "source-over";
      drawBody(ctx, m, now, true);
      ctx.restore();
    } else {
      drawBody(ctx, m, now, false);
    }
  }

  function drawBody(ctx, m, now, flash) {
    switch (m.kind) {
      case "slime":    return drawSlime(ctx, m, flash);
      case "bat":      return drawBat(ctx, m, flash);
      case "goblin":   return drawGoblin(ctx, m, flash);
      case "skeleton": return drawSkeleton(ctx, m, flash);
      case "worm":     return drawWorm(ctx, m, flash, now);
      case "hydraBody": return drawHydraBody(ctx, m, flash, now);
      case "hydraHead": return drawHydraHead(ctx, m, flash, now);
    }
  }

  // Palette helper: hit flash paints the whole sprite white for a beat
  // so the player can see the monster register a hit even when it's
  // barely dropped any HP.
  function P(flash, normal) { return flash ? "#ffffff" : normal; }

  function drawSlime(ctx, m, flash) {
    const x = Math.round(m.x), y = Math.round(m.y);
    const bounce = m.frame ? 0 : -1;
    // Body: squat blob 14×10.
    ctx.fillStyle = P(flash, "#6ec84c");
    ctx.fillRect(x - 6, y - 8 + bounce, 12, 2);
    ctx.fillRect(x - 7, y - 6 + bounce, 14, 4);
    ctx.fillRect(x - 6, y - 2 + bounce, 12, 2);
    ctx.fillRect(x - 4, y, 8, 1);
    // Darker belly
    ctx.fillStyle = P(flash, "#3f8d2e");
    ctx.fillRect(x - 5, y - 2 + bounce, 10, 2);
    // Sheen
    ctx.fillStyle = P(flash, "#c1f5a0");
    ctx.fillRect(x - 4, y - 7 + bounce, 3, 1);
    // Eyes
    ctx.fillStyle = P(flash, "#1a1a1a");
    ctx.fillRect(x - 3, y - 5 + bounce, 1, 2);
    ctx.fillRect(x + 2, y - 5 + bounce, 1, 2);
  }

  function drawBat(ctx, m, flash) {
    const x = Math.round(m.x), y = Math.round(m.y);
    const up = m.frame === 0;
    // Body
    ctx.fillStyle = P(flash, "#2a1d42");
    ctx.fillRect(x - 2, y - 4, 4, 4);
    ctx.fillRect(x - 1, y, 2, 1);
    // Ears
    ctx.fillRect(x - 2, y - 6, 1, 2);
    ctx.fillRect(x + 1, y - 6, 1, 2);
    // Wings (flap)
    ctx.fillStyle = P(flash, "#4a2f70");
    if (up) {
      ctx.fillRect(x - 7, y - 5, 5, 2);
      ctx.fillRect(x + 2, y - 5, 5, 2);
      ctx.fillRect(x - 6, y - 7, 3, 2);
      ctx.fillRect(x + 3, y - 7, 3, 2);
    } else {
      ctx.fillRect(x - 8, y - 2, 6, 2);
      ctx.fillRect(x + 2, y - 2, 6, 2);
      ctx.fillRect(x - 7, y, 3, 1);
      ctx.fillRect(x + 4, y, 3, 1);
    }
    // Eyes (red)
    ctx.fillStyle = P(flash, "#ff4040");
    ctx.fillRect(x - 2, y - 3, 1, 1);
    ctx.fillRect(x + 1, y - 3, 1, 1);
    // Fangs
    ctx.fillStyle = P(flash, "#ffffff");
    ctx.fillRect(x - 1, y - 1, 1, 1);
    ctx.fillRect(x, y - 1, 1, 1);
  }

  function drawGoblin(ctx, m, flash) {
    const x = Math.round(m.x), y = Math.round(m.y);
    const step = m.frame ? 1 : 0;
    const skin = P(flash, "#6aa24a");
    // Head
    ctx.fillStyle = skin;
    ctx.fillRect(x - 3, y - 18, 6, 6);
    ctx.fillRect(x - 4, y - 16, 8, 2);
    // Ears
    ctx.fillRect(x - 5, y - 16, 1, 2);
    ctx.fillRect(x + 4, y - 16, 1, 2);
    // Face
    ctx.fillStyle = P(flash, "#1a1a1a");
    ctx.fillRect(x - 2, y - 15, 1, 1);
    ctx.fillRect(x + 1, y - 15, 1, 1);
    ctx.fillStyle = P(flash, "#ffffff");
    ctx.fillRect(x - 1, y - 13, 3, 1);        // grin
    // Body (tunic)
    ctx.fillStyle = P(flash, "#7a4a1a");
    ctx.fillRect(x - 4, y - 12, 8, 6);
    // Belt
    ctx.fillStyle = P(flash, "#403018");
    ctx.fillRect(x - 4, y - 8, 8, 1);
    // Legs (alternating step)
    ctx.fillStyle = P(flash, "#3a5a2a");
    ctx.fillRect(x - 3, y - 6 + step, 2, 4);
    ctx.fillRect(x + 1, y - 6 - step, 2, 4);
    // Arms: one free, one gripping the club.  Arms are green skin
    // like the head and poke out past the tunic so the goblin stops
    // looking like a legless torso with a floating log next to it.
    const weaponRight = m.dir === "r";
    const freeX   = weaponRight ? x - 5 : x + 4;
    const armX    = weaponRight ? x + 4 : x - 5;
    ctx.fillStyle = skin;
    ctx.fillRect(freeX, y - 11 + step, 1, 4);
    ctx.fillRect(armX,  y - 11 - step, 1, 4);
    // Club extends up out of the weapon hand.
    ctx.fillStyle = P(flash, "#8a5a2a");
    ctx.fillRect(armX, y - 15 - step, 1, 4);
    ctx.fillRect(armX - 1, y - 16 - step, 3, 2);
  }

  function drawSkeleton(ctx, m, flash) {
    const x = Math.round(m.x), y = Math.round(m.y);
    const step = m.frame ? 1 : 0;
    const bone = P(flash, "#eadfb8");
    // Skull: 8×5 with a rounded top + narrower jaw so it reads as a skull
    ctx.fillStyle = bone;
    ctx.fillRect(x - 3, y - 23, 6, 1);
    ctx.fillRect(x - 4, y - 22, 8, 4);
    ctx.fillRect(x - 2, y - 17, 4, 1);        // jaw
    // Eye sockets + teeth
    ctx.fillStyle = P(flash, "#1a1a1a");
    ctx.fillRect(x - 2, y - 21, 1, 2);
    ctx.fillRect(x + 1, y - 21, 1, 2);
    ctx.fillRect(x - 1, y - 18, 1, 1);
    ctx.fillRect(x + 1, y - 18, 1, 1);
    // Spine + collarbone
    ctx.fillStyle = bone;
    ctx.fillRect(x - 1, y - 16, 2, 1);        // neck
    ctx.fillRect(x - 4, y - 15, 8, 1);        // shoulders / collarbone
    // Ribcage: three ribs + central spine, so it reads as bones
    // rather than a solid white chest plate.
    ctx.fillRect(x - 3, y - 13, 6, 1);
    ctx.fillRect(x - 3, y - 11, 6, 1);
    ctx.fillRect(x - 3, y - 9, 6, 1);
    ctx.fillRect(x - 1, y - 14, 2, 6);        // spine column
    // Pelvis
    ctx.fillRect(x - 3, y - 7, 6, 2);
    // Legs
    ctx.fillRect(x - 3, y - 5 + step, 2, 4);
    ctx.fillRect(x + 1, y - 5 - step, 2, 4);
    // Both arms hang from the shoulders, swinging opposite the legs.
    ctx.fillRect(x - 5, y - 14 + step, 1, 6);
    ctx.fillRect(x + 4, y - 14 - step, 1, 6);
    // Rusty sword held in the hand on the facing side.
    const sx = m.dir === "r" ? x + 5 : x - 6;
    ctx.fillStyle = P(flash, "#8a4a20");
    ctx.fillRect(sx - 1, y - 12 - (m.dir === "r" ? step : -step), 3, 1); // crossguard
    ctx.fillStyle = P(flash, "#bbbbbb");
    ctx.fillRect(sx, y - 19 - (m.dir === "r" ? step : -step), 1, 7);     // blade
    ctx.fillStyle = P(flash, "#ffffff");
    ctx.fillRect(sx, y - 20 - (m.dir === "r" ? step : -step), 1, 1);     // tip highlight
  }

  // ---------- hydra sprite -----------------------------------------
  //
  // The hydra is rendered from a hand-built 40x28 px pixel grid that
  // mirrors the final in-game art: three heads on stubby
  // necks rising from a coiled green torso, with red eyes, white
  // fangs, red tongues and a small base of grey rocks underneath.
  // Built once into an offscreen canvas, then blitted via drawImage
  // every frame.  Animation hooks (emerge slide, dying fade, hit
  // flash) all run on the SINGLE composited sprite — there's no
  // per-pixel work in the hot draw path.
  //
  // Heads are NOT separate sprites: each head's position is baked
  // into the body sprite, and individual head logic (target/wind/
  // strike/sever) is conveyed via small overlays painted on top of
  // the sprite (lunge flash, eye-glow, stump patch).
  // The hydra body is shipped as a pixel-perfect 36x34 sprite from
  // `assets/hydra3.png`. The packer drops its raw
  // RGBA pixels into the `sprite/hydra3` section of bolklets_code
  // .png; we decode it on first draw via Scene.decodeStaticSprite,
  // then blit it on every frame.  All three heads (left, top,
  // right) are baked into the body sprite — overlay logic in
  // drawHydraHead handles the dynamic per-head FX (lunge flash,
  // severed stumps, eye glow) on top.
  let HYDRA_SPRITE = null;
  let HYDRA_SPRITE_FLASH = null;
  // Tuned to the new 36×34 hydra3 sprite — used by drawHydraBody to
  // place the blit centred on (body.x, body.y) and by depth-sort
  // code to figure out where the hydra "stands".
  const HYDRA_SPRITE_W = 36;
  const HYDRA_SPRITE_H = 34;
  // Build a flash variant of `src`: same alpha mask as the source
  // sprite, but the whole silhouette painted a flat warm-white.
  // Used when a head is hit so the entire hydra strobes for ~80 ms.
  function buildHydraFlash(src) {
    const c = document.createElement("canvas");
    c.width = src.width;
    c.height = src.height;
    const cctx = c.getContext("2d");
    cctx.drawImage(src, 0, 0);
    cctx.globalCompositeOperation = "source-in";
    cctx.fillStyle = "#fff8e0";
    cctx.fillRect(0, 0, c.width, c.height);
    return c;
  }
  function getHydraSprite(flash) {
    if (!HYDRA_SPRITE) {
      HYDRA_SPRITE = Scene.decodeStaticSprite("hydra3");
    }
    if (!HYDRA_SPRITE) return null;
    if (!flash) return HYDRA_SPRITE;
    if (!HYDRA_SPRITE_FLASH) HYDRA_SPRITE_FLASH = buildHydraFlash(HYDRA_SPRITE);
    return HYDRA_SPRITE_FLASH;
  }

  // Hydra torso: blit the cached sprite centred on (body.x, body.y),
  // with emerge slide-up, dying sink-and-fade, and a small breathing
  // bob.  Per-head overlays (lunge flash, severed stumps) are layered
  // on top in drawHydraHead.
  function drawHydraBody(ctx, m, flash, now) {
    const x = Math.round(m.x), y = Math.round(m.y);
    const dyingT = m.dying
      ? Math.max(0, Math.min(1, (now - m.dyingStart) / HYDRA_DYING_MS))
      : 0;
    const rise = (m.state === "emerging")
      ? 1 - Math.max(0, Math.min(1, (m.stateUntil - now) / HYDRA_EMERGE_MS))
      : 1;
    // No vertical slide on emerge — the hydra used to slide up from
    // 44 px below its final spot, which put the body squarely BELOW
    // the cave silhouette and read as "appearing from the ground"
    // instead of "from the cave".  Now the body is anchored to its
    // final spot and emergence is conveyed via alpha fade-in (alpha
    // is computed below) plus the throat-glow + dust burst already
    // played at spawn.  Dying still sinks the body a bit so the
    // collapse reads.
    const emergeShift = 0;
    const dyingShift = Math.round(dyingT * 6);
    // 1 px breathing bob (1× sprite — anything bigger reads as a jitter).
    const breath = Math.round(Math.sin(now * 0.0028) * 0.5 - 0.5);
    // Body lurch toward the head that's currently committing to an
    // attack — sells "the hydra is reaching out to bite" since the
    // heads themselves are baked into the sprite and don't extend.
    let lurchX = 0, lurchY = 0;
    let strongest = null;
    for (const h of hydraHeads(m)) {
      if (h.severed || h.dying || !h.target || h.target.hp <= 0) continue;
      let weight = 0;
      if (h.state === "striking") weight = 4;
      else if (h.state === "winding") weight = 2;
      else if (h.state === "spitWinding") weight = 2;
      if (weight > (strongest ? strongest.weight : 0)) {
        strongest = { head: h, weight };
      }
    }
    if (strongest) {
      const t = strongest.head.target;
      const dx = t.x - x;
      const dy = t.y - y;
      const dlen = Math.hypot(dx, dy) || 1;
      lurchX = Math.round((dx / dlen) * strongest.weight);
      lurchY = Math.round((dy / dlen) * strongest.weight * 0.6);
    }
    const cx = x + lurchX;
    const cy = y + emergeShift + dyingShift + breath + lurchY;
    // Emerge alpha: fade in from 0 → 1 over the emerge window so the
    // hydra "materialises" inside the cave rather than slamming on
    // screen at full opacity.
    const emergeAlpha = (m.state === "emerging") ? rise : 1;
    const alpha = m.dying ? Math.max(0, 1 - dyingT * 0.85) : emergeAlpha;
    const sprite = getHydraSprite(flash);
    if (!sprite) return;
    const sw = sprite.width;
    const sh = sprite.height;
    const sx = Math.round(cx - sw / 2);
    const sy = Math.round(cy - sh / 2);

    ctx.save();
    ctx.globalAlpha = alpha;
    // Soft drop shadow grounding the body onto the cave threshold.
    ctx.fillStyle = "rgba(0,0,0,0.30)";
    ctx.fillRect(sx + 2, sy + sh - 1, sw - 4, 1);
    ctx.fillStyle = "rgba(0,0,0,0.18)";
    ctx.fillRect(sx + 3, sy + sh, sw - 6, 1);

    // The whole hydra in one blit.
    ctx.drawImage(sprite, sx, sy);

    // (Wound glow removed — read damage off the head-flash + sever FX.)
    // Tail wind-up / strike overlay: a brief reddish arc behind the
    // body during the swing so the AoE has a visible source even
    // though the actual sweep isn't a per-pixel animation.  Painted
    // AFTER the enrage tint so it lands on top.
    if (m.tailState === "winding" || m.tailState === "striking") {
      const tailA = (m.tailState === "striking") ? 0.55 : 0.30;
      ctx.save();
      ctx.fillStyle = `rgba(220,180,80,${tailA})`;
      for (let k = 0; k < 7; k++) {
        const ang = (k / 6) * Math.PI - Math.PI / 2;
        const r = HYDRA_TAIL_RANGE * 0.85;
        const tx = Math.round(x + Math.cos(ang) * r);
        const ty = Math.round(y + Math.sin(ang) * r * 0.45 + 3);
        ctx.fillRect(tx, ty, 1, 1);
      }
      ctx.restore();
    }
    ctx.restore();
  }

  // Hydra head overlay.  The head silhouette itself is baked into the
  // body sprite (drawHydraBody blits the whole hydra in one call).
  // This function paints small per-head adornments ON TOP of the
  // sprite, conveying the head's individual state:
  //   • idle / retracting  → nothing (sprite shows the resting head)
  //   • winding            → eye reddens + a small "tell" pip in front
  //   • striking           → bright bite flash + brief 1-2 px lunge
  //                          ray pointing at the target
  //   • spitWinding        → throat glows orange-fire as it charges
  //   • severed / dying    → dark stump patch at the slot, with a
  //                          slow blood-drip pip
  function drawHydraHead(ctx, m, flash, now) {
    const body = m.parent;
    if (!body) return;
    const deathT = m.dying
      ? Math.max(0, Math.min(1, (now - m.dyingStart) / HYDRA_DYING_MS))
      : 0;
    if (m.dying && now < m.dyingStart) return;
    // Match body emerge fade so per-head overlays don't pop on at full
    // alpha while the body is still fading in.
    const bodyRise = (body.state === "emerging")
      ? 1 - Math.max(0, Math.min(1, (body.stateUntil - now) / HYDRA_EMERGE_MS))
      : 1;
    const alpha = m.dying ? Math.max(0, 1 - deathT) : bodyRise;
    // Mirror the body's draw transform so overlays land on the right
    // pixels even mid-emerge / mid-die / mid-breath.
    const dyingTBody = body.dying
      ? Math.max(0, Math.min(1, (now - body.dyingStart) / HYDRA_DYING_MS))
      : 0;
    const rise = (body.state === "emerging")
      ? 1 - Math.max(0, Math.min(1, (body.stateUntil - now) / HYDRA_EMERGE_MS))
      : 1;
    const emergeShift = 0;
    const dyingShift = Math.round(dyingTBody * 6);
    const breath = Math.round(Math.sin(now * 0.0028) * 0.5 - 0.5);
    // Mirror the body's lurch so per-head overlays (stump, lunge ray,
    // throat glow) stay glued to the head pixels even mid-attack.
    let lurchX = 0, lurchY = 0;
    let strongest = null;
    for (const h of hydraHeads(body)) {
      if (h.severed || h.dying || !h.target || h.target.hp <= 0) continue;
      let weight = 0;
      if (h.state === "striking") weight = 4;
      else if (h.state === "winding") weight = 2;
      else if (h.state === "spitWinding") weight = 2;
      if (weight > (strongest ? strongest.weight : 0)) {
        strongest = { head: h, weight };
      }
    }
    if (strongest) {
      const tg = strongest.head.target;
      const dx = tg.x - body.x;
      const dy = tg.y - body.y;
      const dlen = Math.hypot(dx, dy) || 1;
      lurchX = Math.round((dx / dlen) * strongest.weight);
      lurchY = Math.round((dy / dlen) * strongest.weight * 0.6);
    }
    const yShift = emergeShift + dyingShift + breath + lurchY;

    const anchor = hydraAnchor(body, m.slot);
    const hx = Math.round(anchor.x + lurchX);
    const hy = Math.round(anchor.y + yShift);

    ctx.save();
    ctx.globalAlpha = alpha;

    // Severed: paint a dark stump where the head used to be, with a
    // slow blood drip.  Sized to roughly cover the baked head pixels
    // for that slot (3-4 px square).
    if (m.severed) {
      const pulse = (Math.floor(now / 200) & 1) === 0;
      ctx.fillStyle = P(flash, "#0c0606");
      ctx.fillRect(hx - 2, hy - 3, 5, 4);
      ctx.fillStyle = P(flash, "#3a1010");
      ctx.fillRect(hx - 1, hy - 2, 3, 2);
      ctx.fillStyle = P(flash, "#7a1818");
      ctx.fillRect(hx, hy - 1, 1, 1);
      if (pulse) {
        ctx.fillStyle = P(flash, "#c02020");
        ctx.fillRect(hx, hy + 1, 1, 1);
      }
      ctx.restore();
      return;
    }

    // Sprout heads (slots 3-4): the baked body sprite has no
    // pixels for these — they're bonus heads grown OUT of the
    // body after the player started cutting, so we paint the
    // entire snake head silhouette + full state-visual stack here
    // and return.  Without the early return the regular overlay
    // code below would paint fang glints / throat glows at the
    // neck root (hx, hy) instead of at the actual sprout head
    // position (~6 px out along the aim direction).
    if (m.slot >= HYDRA_SPROUT_SLOT_MIN) {
      drawHydraSproutHead(ctx, m, hx, hy, body, flash, now);
      ctx.restore();
      return;
    }

    const tgt = m.target;
    const aimDx = tgt ? (tgt.x - hx) : Math.cos(m.baseAngle);
    const aimDy = tgt ? (tgt.y - hy) : Math.sin(m.baseAngle);
    const aimLen = Math.hypot(aimDx, aimDy) || 1;
    const aimUx = aimDx / aimLen;
    const aimUy = aimDy / aimLen;

    // Per-element overlay palette (idle eye glow, windup pulse, spit
    // throat charge, strike flash) — same table the sprout heads use,
    // so a baked head's colour matches the splash you take from its
    // bite.  Fall back to fire if a slot is somehow untagged.
    const elCol = HYDRA_ELEMENT_COLORS[m.element] || HYDRA_ELEMENT_COLORS.fire;

    // Permanent idle pip on the eye so the player can read each head's
    // element even when it's not actively winding.  Tiny — one pixel
    // dropped on top of the baked sprite — but enough to colour-tag.
    {
      const idleA = 0.35 + 0.30 * Math.sin(now * 0.004 + (m.slot || 0));
      ctx.fillStyle = elCol.tint + idleA + ")";
      ctx.fillRect(hx, hy - 1, 1, 1);
    }

    // Bite/strike flash + lunge: when the head bites, paint a short
    // bright ray from the head toward the target, plus a small fang
    // glint at the head itself, plus a tiny screen "snap" highlight.
    if (m.state === "striking" && m.strikeAt && (now - m.strikeAt) < 160) {
      const t01 = 1 - (now - m.strikeAt) / 160;
      // Lunge ray: element-coloured streak so a fire bite glows
      // orange, an ice bite glows pale blue, etc.
      ctx.fillStyle = elCol.flash + (0.7 * t01) + ")";
      for (let s = 1; s <= 4; s++) {
        const lx = Math.round(hx + aimUx * s * 2);
        const ly = Math.round(hy + aimUy * s * 2);
        ctx.fillRect(lx, ly, 1, 1);
      }
      // Fang glint at the snout + just past it along the bite axis.
      ctx.fillStyle = `rgba(255,255,255,${0.9 * t01})`;
      ctx.fillRect(hx, hy - 1, 1, 1);
      ctx.fillRect(hx + Math.round(aimUx * 2), hy + Math.round(aimUy * 2), 1, 1);
    }

    if (m.state === "winding") {
      const charge = Math.max(0, Math.min(1, 1 - (m.windUntil - now) / HYDRA_HEAD_WINDUP_MS));
      const pulse = 0.5 + 0.5 * Math.sin(now * 0.018);
      ctx.fillStyle = elCol.tint + (0.4 + 0.4 * pulse) + ")";
      ctx.fillRect(hx, hy - 1, 1, 1);
      const rd = 2 + Math.round(charge * 2);
      const px = Math.round(hx + aimUx * rd);
      const py = Math.round(hy + aimUy * rd);
      ctx.fillStyle = elCol.flash + (0.3 + 0.5 * pulse) + ")";
      ctx.fillRect(px, py, 1, 1);
    }

    if (m.state === "spitWinding") {
      const charge = Math.max(0, Math.min(1, 1 - (m.windUntil - now) / HYDRA_SPIT_WINDUP_MS));
      const pulse = 0.5 + 0.5 * Math.sin(now * 0.02);
      ctx.fillStyle = elCol.tint + (0.45 + 0.55 * pulse) + ")";
      const r = 1 + Math.round(charge * 2);
      ctx.fillRect(hx - r + 1, hy, r * 2, 2);
      ctx.fillStyle = elCol.flash + pulse + ")";
      ctx.fillRect(hx, hy, 1, 1);
      if (charge > 0.55 && (Math.floor(now / 60) & 1)) {
        ctx.fillStyle = elCol.flash + "0.85)";
        const ex = Math.round(hx + aimUx * 2);
        const ey = Math.round(hy + aimUy * 2);
        ctx.fillRect(ex, ey, 1, 1);
      }
    }

    if (flash) {
      ctx.fillStyle = elCol.flash + "0.85)";
      ctx.fillRect(hx - 2, hy - 2, 5, 4);
    }

    ctx.restore();
  }

  // Draw a single sprout head (slots 3-4).  These don't exist in
  // the baked body sprite — they're bonus heads grown from the
  // body after a sever, so we paint their entire silhouette here.
  //
  // Composition (sized to roughly match a baked head):
  //   • 2-3 px neck stub anchored at (anchorX, anchorY) on the body
  //   • chunky 6×4 px head leaning toward the aim direction
  //   • red eye + tiny white fangs + thin tongue
  //   • light bob from the body breath so the head doesn't feel
  //     glued in place
  //
  // (hx, hy) is the lurched anchor (matches drawHydraHead overlays).
  // The sprite-flash variant uses the same colour the body flash
  // uses, so a head taking damage reads with the rest of the body.
  function drawHydraSproutHead(ctx, m, hx, hy, body, flash, now) {
    if (m.dying) return;
    // Lean direction: toward target if locked on, otherwise toward
    // the head's baseAngle (slot 3 → left, slot 4 → right).
    const tgt = m.target;
    let aimX, aimY;
    if (tgt && tgt.hp > 0) {
      aimX = tgt.x - hx;
      aimY = tgt.y - hy;
    } else {
      aimX = Math.cos(m.baseAngle);
      aimY = Math.sin(m.baseAngle);
    }
    const al = Math.hypot(aimX, aimY) || 1;
    const ux = aimX / al;
    const uy = aimY / al;
    // Neck origin is the body anchor (pre-lurch — we want the neck
    // to root at the body, not float with the lurch).  Head sits
    // ~6 px out from the anchor along the aim direction, plus the
    // shared lurch already applied to (hx, hy).
    const neckLen = 6;
    const headCx = Math.round(hx + ux * neckLen);
    const headCy = Math.round(hy + uy * neckLen);
    // Anchor for the neck root: the body's slot anchor without the
    // lurch (lurch is the diff between hx and the anchor).
    const anchor = hydraAnchor(body, m.slot);
    const baseX = Math.round(anchor.x);
    const baseY = Math.round(anchor.y);

    // Neck: two short segments of dark green from base to head.
    ctx.fillStyle = P(flash, "#1a3a14");
    for (let s = 0; s <= 4; s++) {
      const t = s / 4;
      const nx = Math.round(baseX + (headCx - baseX) * t);
      const ny = Math.round(baseY + (headCy - baseY) * t);
      ctx.fillRect(nx - 1, ny - 1, 2, 2);
    }
    // Head silhouette: rounded 6×4 block of mid-green with a 2-px
    // bright-green highlight on top.
    ctx.fillStyle = P(flash, "#306028");
    ctx.fillRect(headCx - 3, headCy - 2, 6, 4);
    ctx.fillStyle = P(flash, "#4ea020");
    ctx.fillRect(headCx - 2, headCy - 3, 4, 1);
    ctx.fillStyle = P(flash, "#80c828");
    ctx.fillRect(headCx - 1, headCy - 3, 2, 1);
    // Snout: a 2 px nub leaning toward the aim direction.
    const snoutX = Math.round(headCx + ux * 3);
    const snoutY = Math.round(headCy + uy * 2);
    ctx.fillStyle = P(flash, "#306028");
    ctx.fillRect(snoutX - 1, snoutY, 2, 2);
    // Element colour scheme for this sprout head.
    const elCol = HYDRA_ELEMENT_COLORS[m.element] || HYDRA_ELEMENT_COLORS.fire;
    // Eye: element-coloured dot so even a non-attacking sprout reads
    // its element at a glance.
    const ex = Math.round(headCx + uy * 1);
    const ey = Math.round(headCy - 1);
    ctx.fillStyle = P(flash, elCol.rim);
    ctx.fillRect(ex, ey, 1, 1);
    // Permanent idle glow: faint element aura at the eye.
    {
      const idleA = 0.5 + 0.35 * Math.sin(now * 0.004 + (m.slot || 3));
      ctx.fillStyle = elCol.tint + idleA + ")";
      ctx.fillRect(ex - 1, ey - 1, 3, 3);
    }
    // Fangs: two white pips at the snout when the mouth is "open"
    // (winding/striking/spitting), else a single tongue dot.
    const open = (m.state === "winding" || m.state === "striking" ||
                  m.state === "spitWinding");
    if (open) {
      ctx.fillStyle = P(flash, "#ffffff");
      ctx.fillRect(snoutX - 1, snoutY + 1, 1, 1);
      ctx.fillRect(snoutX,     snoutY + 1, 1, 1);
    } else {
      ctx.fillStyle = P(flash, "#a82020");
      ctx.fillRect(snoutX, snoutY + 1, 1, 1);
    }
    // ---- per-state overlays (positioned at the sprout HEAD, not
    // the body anchor — that's the whole reason this function
    // duplicates the strike/wind/spit overlay code from drawHydra
    // Head instead of falling through).
    //
    // Strike flash + lunge ray: element-coloured streak.
    if (m.state === "striking" && m.strikeAt && (now - m.strikeAt) < 160) {
      const t01 = 1 - (now - m.strikeAt) / 160;
      ctx.fillStyle = elCol.flash + (0.75 * t01) + ")";
      for (let s = 1; s <= 4; s++) {
        const lx = Math.round(headCx + ux * s * 3);
        const ly = Math.round(headCy + uy * s * 3);
        ctx.fillRect(lx, ly, 2, 2);
      }
      ctx.fillStyle = `rgba(255,255,255,${0.9 * t01})`;
      ctx.fillRect(snoutX - 1, snoutY, 2, 2);
    }
    // Winding eye glow + charging pip just past the snout.
    if (m.state === "winding") {
      const charge = Math.max(0, Math.min(1, 1 - (m.windUntil - now) / HYDRA_HEAD_WINDUP_MS));
      const pulse = 0.5 + 0.5 * Math.sin(now * 0.018);
      ctx.fillStyle = elCol.tint + (0.5 + 0.4 * pulse) + ")";
      ctx.fillRect(ex, ey, 1, 1);
      const rd = 3 + Math.round(charge * 4);
      const px = Math.round(headCx + ux * rd);
      const py = Math.round(headCy + uy * rd);
      ctx.fillStyle = elCol.tint + (0.4 + 0.6 * pulse) + ")";
      ctx.fillRect(px, py, 2, 2);
    }
    // Spit windup throat glow at the sprout's mouth + element sparks.
    if (m.state === "spitWinding") {
      const charge = Math.max(0, Math.min(1, 1 - (m.windUntil - now) / HYDRA_SPIT_WINDUP_MS));
      const pulse = 0.5 + 0.5 * Math.sin(now * 0.02);
      ctx.fillStyle = elCol.tint + (0.5 + 0.5 * pulse) + ")";
      const r = 1 + Math.round(charge * 3);
      ctx.fillRect(snoutX - r, snoutY, r * 2, 2);
      ctx.fillStyle = elCol.flash + pulse + ")";
      ctx.fillRect(snoutX, snoutY, 2, 1);
      if (charge > 0.55 && (Math.floor(now / 60) & 1)) {
        ctx.fillStyle = elCol.tint + "0.85)";
        ctx.fillRect(snoutX + Math.round(ux * 2), snoutY + Math.round(uy * 2), 2, 2);
      }
    }
    // Flash overlay when the head took a hit this frame.
    if (flash) {
      ctx.fillStyle = elCol.flash + "0.85)";
      ctx.fillRect(headCx - 4, headCy - 4, 8, 7);
    }
  }

  // ---------- worm rendering ----------
  //
  // Three drawing modes share the worm sprite:
  //
  //  - Buried (state = "under"): a low grassy hummock — green when
  //    sitting on lawn, brown when lurking under the dirt path so
  //    the colour reads as displaced soil, not weirdly grassy
  //    pavement.  No dark soil rim at the bottom: a stationary
  //    mound is meant to BLEND into the bg, with only the moving
  //    worm leaving a visible trail of overturned earth.
  //
  //  - Transitioning (emerging / submerging) and surfaced
  //    (attacking): the SAME mound stays in place, and the worm
  //    body simply stretches up out of its top — head first, then
  //    progressively more segments as the emerge progress (`p`)
  //    rises.  No "crater" / dark hole / cracked-rectangle effect:
  //    earlier versions of that read as a clipping rectangle, so
  //    we just let the mound stay closed and the body grow out of
  //    it organically.  Body segments still inside the mound are
  //    clipped so it looks like the worm is actually pushing
  //    through the turf rather than floating on top of it.
  function drawWorm(ctx, m, flash, now) {
    // Cosmetic safety net: if the worm centre is somehow inside the
    // pond (avoidPondStep + the wander-target margin should prevent
    // this, but a pond-resize edge case could still slip through),
    // skip the entire sprite this frame so we never paint a mound
    // floating on water.  The next tick's wander logic will pick a
    // dry destination and crawl out.
    if (Scene.isInPond && Scene.isInPond(m.x, m.y, 4)) return;
    const x = Math.round(m.x), y = Math.round(m.y);
    // Mound first (always identical, always closed) so the body
    // paints on top of it.  Underground bookkeeping aside, this is
    // just a small grass dome/dirt bump at every state — only the
    // body changes between idle/emerge/attack/submerge.
    drawWormMound(ctx, x, y, m, now);
    if (m.state === "under") return;
    let p;
    if (m.state === "emerging") {
      p = 1 - (m.stateUntil - now) / WORM_EMERGE_MS;
    } else if (m.state === "submerging") {
      p = (m.stateUntil - now) / WORM_SUBMERGE_MS;
    } else {
      p = 1; // attacking — body fully extended
    }
    p = Math.max(0, Math.min(1, p));
    drawWormBody(ctx, x, y, m, flash, p, now);
  }

  // Buried mound — a small grass dome (or a brown earth dome when
  // the worm is lurking under the dirt path) topped with a few
  // sparse grass blades.  No dark base rim: a stationary mound
  // melts into the lawn, only the moving worm leaves a visible
  // soil trail behind itself.  Identical in every worm state — the
  // body is what changes; the mound just sits there as the spot
  // the worm is rooted in.
  function drawWormMound(ctx, x, y, m, now) {
    const onPath = Scene.isOnPath && Scene.isOnPath(m.x, m.y);
    // Breathing pulse only when the worm is fully buried; once it's
    // transitioning or attacking the mound stays still so the body
    // animation is the only thing moving.
    const buried = m.state === "under";
    const pulse = (buried && m.frame) ? 1 : 0;
    let cTip, cMid, cBlade;
    if (onPath) {
      // Earth tones, picked to match the path tile (#b48b5a) and
      // its highlight (#d4a872) so the mound reads as raised dirt
      // rather than a grass island sitting on the road.
      cTip = "#d4a872";
      cMid = "#a0703c";
      cBlade = null;          // no grass blades when mound is dirt
    } else {
      cTip = "#6ec850";
      cMid = "#4d913a";
      cBlade = "#b8e060";
    }
    // Two rows of mid-tone for the dome body, narrower light-tone
    // tip on top.  Width 9 so the silhouette is readable at game
    // resolution without overpowering the sprite.
    ctx.fillStyle = cMid;
    ctx.fillRect(x - 4, y - 1 - pulse, 9, 1);
    ctx.fillRect(x - 4, y - 2 - pulse, 9, 1);
    ctx.fillStyle = cTip;
    ctx.fillRect(x - 3, y - 3 - pulse, 7, 1);
    if (cBlade) {
      // Three asymmetric blade tips so the silhouette feels organic;
      // centre blade wiggles a tick more than its neighbours.
      ctx.fillStyle = cBlade;
      ctx.fillRect(x - 3, y - 4 - pulse, 1, 1);
      ctx.fillRect(x,     y - 4 - pulse * 2, 1, 1);
      ctx.fillRect(x + 2, y - 4 - pulse, 1, 1);
    }
    // Trail flecks behind the mound when actively moving (chasing
    // a sound or crawling toward a wander target).  Provides a
    // direction cue and the only "dark earth" pixels on a
    // stationary worm; idle mounds blend in by design.
    const moving = buried && (
      m.soundTarget ||
      (m.wanderUntil > 0 && (!m.wanderIdleUntil || now >= m.wanderIdleUntil))
    );
    if (moving) {
      const back = m.dir === "r" ? -1 : 1;
      ctx.fillStyle = onPath ? "#7a5530" : "#3d2a18";
      ctx.fillRect(x + back * 6, y - 1, 1, 1);
      ctx.fillRect(x + back * 8, y - 2, 1, 1);
    }
  }

  // Worm body — a curved 5-segment serpent rooted in the soil
  // hole at (x, y), growing upward with `p` (0 = nothing visible,
  // 1 = fully extended ~12 px tall).  Each segment is offset along
  // an S-curve whose phase shifts with `now` so the body wriggles,
  // and whose amplitude leans into the direction of motion so a
  // worm chasing prey to the right curls right.  Segments shrink
  // a touch toward the tail to read as a tapered animal.
  function drawWormBody(ctx, x, y, m, flash, p, now) {
    if (p < 0.05) return;
    const NUM_SEG = 5;
    const SEG_GAP = 2.4;          // px between consecutive segment centres
    const HEAD_RISE = 11;         // how far the head sits above the hole at p=1
    const headY = y - HEAD_RISE * p;
    const dirSign = m.dir === "l" ? -1 : 1;
    // S-curve parameters: amplitude stays modest at low p (the
    // emerging head is mostly straight as it pushes through the
    // turf) and grows with p so the surfaced worm is visibly
    // curled.  Phase animates over time for the wriggle.
    const amp = 1.5 + p * 1.2;
    const phase = (now * 0.012) % (Math.PI * 2);
    const segCol  = P(flash, "#c98080");
    const segDark = P(flash, "#9a4a4a");
    const segHead = P(flash, "#a64545");
    // Iterate tail → head so the head pixels paint on top.
    // Mound's top tip sits at y - 3, so we clip segments whose centre
    // would be at or below that row — the body needs to appear
    // pushing OUT of the dome's apex, not painting on top of its
    // mid-rows.  As `p` rises from 0 → 1, the head crosses y - 3
    // first and progressively more segments emerge above.
    const moundTop = y - 3;
    for (let i = NUM_SEG - 1; i >= 0; i--) {
      const segY = headY + i * SEG_GAP;
      if (segY > moundTop) continue;
      // Distance from head, normalised: 0 = head, 1 = tail.
      const t = i / (NUM_SEG - 1);
      // Head bends most into the direction of motion; tail anchored
      // at the hole barely shifts.  cos() shape gives a smooth lean
      // without an obvious sine "snake" zigzag.
      const lean = Math.cos(t * Math.PI * 0.5) * amp * dirSign;
      // Layered wriggle on top of the lean so the whole body
      // doesn't hold a frozen pose.
      const wriggle = Math.sin(t * 2.4 + phase) * 0.7;
      const sx = Math.round(x + lean + wriggle);
      const sy = Math.round(segY);
      // Head segment is one pixel wider and sits slightly higher
      // (drawn 2 tall) so the silhouette tapers tail-to-head.  Tail
      // segments are 3 wide / 2 tall, except the last one which is
      // thinner so it reads as anchored in the dirt.
      const isHead = i === 0;
      const isTail = i === NUM_SEG - 1;
      const w = isHead ? 4 : (isTail ? 2 : 3);
      const h = 2;
      ctx.fillStyle = isHead ? segHead : segCol;
      ctx.fillRect(sx - Math.floor(w / 2), sy - 1, w, h);
      // Single-pixel belly stripe per segment — same trick the
      // skeleton's sword highlight uses to give the side a hint of
      // shading without leaving the pixel-art look.
      ctx.fillStyle = segDark;
      ctx.fillRect(sx - Math.floor(w / 2), sy, w, 1);
    }
    // Mouth + teeth, only once the head is well clear of the hole
    // — hides a creepy floating jaw during the early emerge frames.
    if (p > 0.6) {
      const lean = Math.cos(0) * amp * dirSign;     // i=0: head
      const wriggle = Math.sin(phase) * 0.7;
      const sx = Math.round(x + lean + wriggle);
      const sy = Math.round(headY);
      ctx.fillStyle = P(flash, "#3d1010");
      ctx.fillRect(sx - 2, sy - 1, 4, 2);
      if (m.frame === 1) {
        ctx.fillStyle = P(flash, "#ffffff");
        ctx.fillRect(sx - 2, sy, 1, 1);
        ctx.fillRect(sx - 1, sy - 1, 1, 1);
        ctx.fillRect(sx + 1, sy - 1, 1, 1);
        ctx.fillRect(sx + 2, sy, 1, 1);
      }
    }
  }

  // Worm death animation.  Replaces the generic alpha-fade + grey
  // square the other monsters use.  Three layered stages over the
  // 500 ms dying window:
  //
  //   • mound collapses: alpha drops fast (gone by t≈0.6) so it
  //     doesn't sit there as a static brown block once the body's
  //     gone limp;
  //   • body wilts: `p` (used by drawWormBody as the extension
  //     factor) collapses linearly so the worm visibly droops back
  //     into the soil instead of just fading on the spot;
  //   • dirt clods: kicked by Combat.dirtBurst from `damage`, fan
  //     out and tumble in the same 520 ms window so the eye
  //     follows particles outward instead of focusing on the empty
  //     mound spot.
  function drawWormDying(ctx, m, t, now) {
    const x = Math.round(m.x), y = Math.round(m.y);
    // Mound collapse: alpha falls faster than the body so the
    // dome doesn't outlive the worm.
    const moundA = Math.max(0, 1 - t * 1.7);
    if (moundA > 0.02) {
      ctx.globalAlpha = moundA;
      drawWormMound(ctx, x, y, m, now);
      ctx.globalAlpha = 1;
    }
    // Body wilt: extension factor drops from 1 → 0 over the death
    // window, with alpha trailing slightly behind so the slump is
    // visible before the body fades out.  Frozen wriggle phase
    // (we pass `m.dyingStart` instead of `now`) so the corpse
    // doesn't keep dancing.
    const bodyP = Math.max(0, 1 - t * 1.4);
    const bodyA = Math.max(0, 1 - t * 1.15);
    if (bodyA > 0.02 && bodyP > 0.05) {
      ctx.globalAlpha = bodyA;
      drawWormBody(ctx, x, y, m, false, bodyP, m.dyingStart);
      ctx.globalAlpha = 1;
    }
  }

  function anyThreat(x, y, radius) {
    for (const m of list) {
      if (m.dying || m.fleeing) continue;
      if (isHidden(m)) continue;
      if (Math.hypot(m.x - x, m.y - y) < radius) return true;
    }
    return false;
  }

  // Count of live, non-fleeing, visible monsters within `radius` of
  // (x,y).  Used by hero AI branches that want to react differently
  // to "one slime in the bubble" vs "three monsters closing from
  // different sides" (e.g. escalate retreat into panic flee earlier
  // when surrounded).
  function countThreats(x, y, radius) {
    let n = 0;
    for (const m of list) {
      if (m.dying || m.fleeing) continue;
      if (isHidden(m)) continue;
      if (Math.hypot(m.x - x, m.y - y) < radius) n++;
    }
    return n;
  }

  // Aggregated "away from threats" repulsion vector around (x,y).
  // Sums per-monster unit vectors weighted by 1/(distance^2 + soft²)
  // so closer monsters dominate but distant ones still nudge the
  // direction.  Returns { count, dx, dy, maxClose }:
  //
  //   count    — how many threats contributed
  //   dx, dy   — UNIT vector pointing AWAY from the weighted threat
  //              centroid (zero vector if count === 0 or threats
  //              cancel out perfectly).  Multiply by your desired
  //              step length to get a retreat goal.
  //   maxClose — distance to the closest contributing threat, so
  //              callers can decide how urgent the situation is.
  //
  // Solves the "ran away from one monster straight into another" bug
  // that plagued the old per-tick `nearestMonster` retreat: with two
  // slimes flanking the hero, the away-from-nearest vector points
  // through the second slime; a weighted aggregate instead points
  // out the seam between them.
  // Distance from (x,y) to the nearest live, visible threat, capped at
  // `radius` (returns `radius` when nothing is in range — callers use the
  // cap to bound a tie-breaker bonus instead of a raw open-ended distance).
  // Used by the angular-sweep evader (`bestEscapeDirection`) so that when
  // multiple candidate rays score the same on corridor cleanliness, the
  // one whose endpoint sits FURTHEST from every threat wins — without
  // this tie-breaker, iteration order picked the first clean ray
  // clockwise from due-east, which is often a diagonal heading TOWARD
  // an off-axis enemy.
  function nearestThreatDist(x, y, radius) {
    let best = radius;
    for (const m of list) {
      if (m.dying || m.fleeing) continue;
      if (isHidden(m)) continue;
      const d = Math.hypot(m.x - x, m.y - y);
      if (d < best) best = d;
    }
    return best;
  }

  function threatVector(x, y, radius) {
    let sx = 0, sy = 0, n = 0;
    let closest = Infinity;
    const SOFT = 18;
    const SOFT2 = SOFT * SOFT;
    for (const m of list) {
      if (m.dying || m.fleeing) continue;
      if (isHidden(m)) continue;
      const dxm = x - m.x;
      const dym = y - m.y;
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

  // Number of (live, non-fleeing, visible, FORWARD) monsters whose
  // perpendicular distance to the segment (x1,y1)→(x2,y2) is below
  // `clearance`.  Same forward-only convention as distToFirstOnPath
  // (monsters with t<0 along the segment are behind the start and
  // don't count as "in the way").  Used by the panic-flee picker
  // when both candidate exits have a finite first blocker — the
  // edge with FEWER blockers in its corridor is genuinely safer
  // than the one with three of them, even if the first one happens
  // to be a few pixels farther.
  function threatsOnPath(x1, y1, x2, y2, clearance) {
    const dx = x2 - x1, dy = y2 - y1;
    const segLen2 = dx * dx + dy * dy;
    if (segLen2 <= 0) return 0;
    const c2 = clearance * clearance;
    let n = 0;
    for (const m of list) {
      if (m.dying || m.fleeing) continue;
      if (isHidden(m)) continue;
      const px = m.x - x1, py = m.y - y1;
      let t = (px * dx + py * dy) / segLen2;
      if (t < 0) continue;
      if (t > 1) t = 1;
      const cx = x1 + t * dx - m.x;
      const cy = y1 + t * dy - m.y;
      if (cx * cx + cy * cy < c2) n++;
    }
    return n;
  }

  // Is there any (live, non-fleeing) monster within `clearance` pixels
  // of the line segment from (x1,y1) to (x2,y2)?  Used by non-fighters
  // (the girl) to refuse routes that would walk her straight through a
  // melee on her way to revive a corpse or heal a wounded ally.
  // Distance is computed point-to-segment, so a monster off to the
  // side of the path doesn't count — only one actually IN the path's
  // corridor does.
  function anyOnPath(x1, y1, x2, y2, clearance) {
    const dx = x2 - x1, dy = y2 - y1;
    const segLen2 = dx * dx + dy * dy;
    const c2 = clearance * clearance;
    for (const m of list) {
      if (m.dying || m.fleeing) continue;
      if (isHidden(m)) continue;
      const px = m.x - x1, py = m.y - y1;
      let t = segLen2 > 0 ? (px * dx + py * dy) / segLen2 : 0;
      if (t < 0) t = 0; else if (t > 1) t = 1;
      const cx = x1 + t * dx - m.x;
      const cy = y1 + t * dy - m.y;
      if (cx * cx + cy * cy < c2) return true;
    }
    return false;
  }

  // Distance from (x1,y1) to the nearest monster sitting inside the
  // path corridor (perpendicular distance to the segment is less than
  // `clearance`).  Returns Infinity if the corridor is clear.  Used by
  // the panic-flee edge picker: when both edges have at least one
  // would-be-trampled monster on the way out, we take the side whose
  // first blocker is farthest along the path — the fleer at least
  // gets the most run-up before they hit trouble, which is much
  // better than picking randomly and sprinting through a slime.
  //
  // IMPORTANT: monsters BEHIND the start point (parametric t < 0
  // along the segment) are deliberately ignored.  Earlier versions
  // clamped t to [0, 1] which caused a monster sitting just behind
  // the fleer to be reported as "blocker at distance 0 along this
  // path", making the FORWARD direction (away from the monster)
  // look identical to a clean run.  The picker, comparing both
  // edges, would then favour the LEFT exit when the only threat
  // was on the right (or vice-versa) — exactly the "decoyed and
  // then ran into the slime anyway" bug.  Skipping t<0 monsters
  // makes the score honest: a monster behind us isn't "on the
  // forward path", it's a hazard for the OPPOSITE direction.  We
  // still cap t at 1 so a stray monster past the off-screen edge
  // doesn't extend the segment.
  function distToFirstOnPath(x1, y1, x2, y2, clearance) {
    const dx = x2 - x1, dy = y2 - y1;
    const segLen2 = dx * dx + dy * dy;
    if (segLen2 <= 0) return Infinity;
    const c2 = clearance * clearance;
    let bestT = Infinity;
    for (const m of list) {
      if (m.dying || m.fleeing) continue;
      if (isHidden(m)) continue;
      const px = m.x - x1, py = m.y - y1;
      let t = (px * dx + py * dy) / segLen2;
      if (t < 0) continue;       // monster is behind the start — not a forward blocker
      if (t > 1) t = 1;
      const cx = x1 + t * dx - m.x;
      const cy = y1 + t * dy - m.y;
      if (cx * cx + cy * cy < c2 && t < bestT) bestT = t;
    }
    if (bestT === Infinity) return Infinity;
    return bestT * Math.sqrt(segLen2);
  }

  // Same forward-only corridor scan as `distToFirstOnPath`, but
  // returns the actual blocker monster instead of its distance.
  // Used by tickFleeing/tickRetreating to side-step around a close
  // blocker (we need the blocker's Y to know which way to swerve)
  // when the left/right edge flip isn't an option.  Returns null
  // when the corridor is clear.
  function firstOnPath(x1, y1, x2, y2, clearance) {
    const dx = x2 - x1, dy = y2 - y1;
    const segLen2 = dx * dx + dy * dy;
    if (segLen2 <= 0) return null;
    const c2 = clearance * clearance;
    let bestT = Infinity, best = null;
    for (const m of list) {
      if (m.dying || m.fleeing) continue;
      if (isHidden(m)) continue;
      const px = m.x - x1, py = m.y - y1;
      let t = (px * dx + py * dy) / segLen2;
      if (t < 0) continue;
      if (t > 1) t = 1;
      const cx = x1 + t * dx - m.x;
      const cy = y1 + t * dy - m.y;
      if (cx * cx + cy * cy < c2 && t < bestT) { bestT = t; best = m; }
    }
    return best;
  }

  // The wave director gates new spawns on `count() === 0` so the lawn
  // never piles up.  Hidden (buried/transitioning) worms don't count
  // toward that gate: from the heroes' perspective they aren't on
  // stage, and we don't want a couple of lurking worms to indefinitely
  // throttle the regular monster waves.  Surfaced worms DO count
  // because they're a real combat presence at that point.
  function count() {
    let n = 0;
    for (const m of list) {
      if (m.dying) continue;
      if (isHidden(m)) continue;
      if (m.kind === "hydraHead") continue;
      n++;
    }
    return n;
  }

  // Painter's-algorithm sort key for a monster.  For most kinds this
  // is just `m.y` (the foot baseline — sprite paints UPWARD from
  // there, see drawSlime / drawGoblin / drawSkeleton).  The hydra
  // is the exception: drawHydraBody blits a 56-px-tall sprite
  // CENTRED on (m.x, m.y), so the body's actual feet are at
  // `m.y + HYDRA_SPRITE_H / 2`.  Sorting hydra parts by raw m.y
  // makes the entire boss appear ~28 px further north than her
  // feet, so anything south of `m.y` (graves, characters on the
  // lower lawn) drew ON TOP of her even though she's visually in
  // front of them.  Hydra heads inherit the body's sort y so the
  // whole creature reads as a single z-layer instead of slivers.
  function sortY(m) {
    if (!m) return 0;
    if (m.kind === "hydraBody") return m.y + HYDRA_SPRITE_H / 2;
    if (m.kind === "hydraHead") {
      const body = m.parent;
      if (body) return body.y + HYDRA_SPRITE_H / 2;
    }
    return m.y;
  }

  return {
    list, tick, spawnWave, damage, drawOne,
    anyThreat, countThreats, threatVector, threatsOnPath, nearestThreatDist,
    anyOnPath, distToFirstOnPath, firstOnPath, count, TYPES,
    isHidden, sortY,
    // Hydra read-only knobs HydraPlan (over in characters.js) consults
    // when projecting role rings / spit-danger envelope around the
    // live body position.  Re-exposed as plain numbers so the
    // coordinator doesn't have to duplicate the constants.
    HYDRA_SPIT_RANGE,
    HYDRA_TAIL_RANGE,
    HYDRA_HEAD_RANGE,
    // Element-resistance lookups for combat.js (per-spit immunity /
    // resist gating) and any future UI surfacing.
    HYDRA_ELEMENT_IMMUNE,
    HYDRA_ELEMENT_RESIST,
    isElementImmune,
    isElementResist,
    hydraTargetElementId,
    isHydraMonsterVictim,
  };
})();
