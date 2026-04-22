/*
 * Character state machine, movement, animation, and combat.
 *
 * Two parallel state axes:
 *
 *   state       (peacetime life)  offstage | entering | working
 *                                 wandering | leaving | talking
 *   combatMode  (when bad things) none     | fighting | fleeing | drinking
 *                                 healing  | depositing | ufoing
 *                                 dead     | reviving  | retreating
 *
 * combatMode overrides `state` while it's active.  When combatMode is
 * not `none`, step() bypasses the normal day-to-day routine and runs
 * the combat branch instead; once combat is over the character drops
 * back into `wandering` so they stroll back to their routine rather
 * than snapping straight to an activity station.
 *
 * Roles:
 *   fighter — melee or ranged attacker.  Runs at monsters in aggro
 *             range; retreats to the chest for a health potion when
 *             low; if no potion is available and HP is critical, runs
 *             offstage (fleeing).
 *   healer  — the girl.  Never attacks; seeks out wounded allies and
 *             pulses green healing.  Flees offstage if a monster is
 *             standing on top of her and no ally is close by.
 *   alien   — climbs into the UFO and strafes monsters with a beam,
 *             then lands a few seconds later.
 *
 * Death & revive.  When a hero's HP hits 0 they collapse in place and
 * a tombstone is painted over them (combatMode = "dead").  They sit
 * there, untargetable, until a reviver (girl, witch, or firemage)
 * walks up and channels a holy-light spell on them.  At the end of
 * the cast the character pops back up with full HP and resumes their
 * wandering routine.  If nobody shows up, the grave just stays put.
 */
const Characters = (() => {
  const SPEED = 28;
  const FRAME_MS = 180;
  const TALK_DIST = 46;
  const STAY_AT_ITEM_MS = [3000, 6500];
  const WANDER_STEP_MS = [2500, 4500];
  const POST_CONVO_COOLDOWN_MS = 9000;
  // After two specific characters finish a chat they won't chat with
  // *each other* again for this long, even if they drift back into
  // range, so we don't get hello/goodbye ping-pong loops.
  const PAIR_COOLDOWN_MS = 35000;
  const LEAVE_AFTER_WANDER_P = 0.45;
  const LEAVE_AFTER_WORK_P = 0.35;

  // Combat tuning -----------------------------------------------------
  const AGGRO_RANGE = 140;
  // Boss perception override.  AGGRO_RANGE was the right knob for
  // every regular monster (anything farther than ~140 px isn't worth
  // a hero peeling off their wandering / station / chat to engage),
  // but the hydra is rooted in a fixed corner — most heroes are
  // never within AGGRO_RANGE of it, so without this override the
  // big kindHydra* threat weights below never even get evaluated by
  // bestMonsterFor.  When HydraPlan is active we let bestMonsterFor
  // see hydra parts at this distance, which covers the entire 720-
  // wide stage with comfortable headroom.  Non-hydra monsters still
  // respect the normal AGGRO_RANGE.
  const BOSS_PERCEPTION_R = 900;
  // Threat-score weights used by bestMonsterFor / bestHeroFor.  The
  // legacy nearestMonster / nearestHero pickers chose targets purely
  // by Euclidean distance, which produced two visible failure modes:
  //  • a low-HP straggler 30 px farther away than a fresh tank got
  //    ignored even though one extra swing would finish it;
  //  • flying bats and ambush worms, both naturally hard targets,
  //    were treated identically to a slime at the same range.
  // The score is "lower = more attractive": distance contributes
  // base, low-HP and "is currently chewing on my friend" subtract,
  // hard-to-hit kinds add a small penalty.  See threatScoreHero
  // for the per-axis explanations.
  const THREAT_WEIGHTS = {
    distance:        1.0,    // raw px (the dominant axis)
    lowHp:          50.0,    // up to -50 px-equivalent for a 1-hp monster
    kindFly:        25.0,    // bats/airborne -- keep this small for archers
    kindWorm:       18.0,    // worm = ambush, slightly worse target
    // Hydra weights are large enough to overwhelm raw distance: the
    // body sits in a fixed corner and is the only thing that ends
    // the fight, so heroes should reliably commit to walking over to
    // it instead of treating the closest skeleton as more important.
    // Heads are urgent CC because every alive head is a free attack
    // tick on someone — but they're also self-resolving (they sever
    // and regrow), so the body still wins the priority contest.
    kindHydraHead: -120.0,
    kindHydraBody: -260.0,
    attackingAlly: -60.0,    // huge bonus for "biting my friend right now"
    isHealer:       40.0,    // monster going for our healer = hot target
    isDecoy:       120.0,    // decoy aggro = top priority for monsters
  };
  // Healer-guard sensing.  Any monster crowding within HEALER_GUARD_R
  // of an allied healer counts as "chasing her" — idle fighters
  // within HEALER_GUARD_DEFENDER_R of HER will drop their wandering
  // / passive-aggro pick to engage the chaser instead.  This is what
  // makes the team actually defend the priest, including the special
  // case the user asked for: a fighter currently being healed who
  // isn't already in combat naturally qualifies (he stands within
  // GIRL_HEAL_RANGE = 88 px, well under the defender radius), so as
  // soon as his maybeEnterCombat tick fires he peels off to clean up
  // whatever was bothering his medic.
  const HEALER_GUARD_R          = 130;
  const HEALER_GUARD_DEFENDER_R = 240;
  // A monster this close to the defender outranks the healer guard:
  // if something is already biting our ankles we deal with that
  // first, then go help out.  Same magnitude as a slime hop.
  const SELF_DEFENCE_R          = 36;
  const LOW_HP_FRACTION = 0.55;    // seek a potion / healer below this
  const PANIC_HP_FRACTION = 0.18;  // flee offstage below this
  // "My friend is in trouble" radius.  If an ally is brawling within
  // this distance, other heroes on stage pile in to help (or bolt off
  // the lawn if they can't throw a punch).
  const BUDDY_RANGE = 260;
  // "Help!" radius: how far a panicked hero's shout carries.  Much
  // wider than BUDDY_RANGE because it's an explicit yell, not just
  // visual situational awareness — anyone within earshot should hear
  // it even if the brawl is on the far side of the lawn.  At 420 px
  // a call from near the centre reaches every active corner of an
  // 800-wide stage, so the cry actually drags responders in instead
  // of being heard only by neighbours who'd already see the brawl.
  const HELP_RADIUS = 420;
  // How long an open call stays "active" — a responder picking it
  // up after this point is just turning up to a finished fight.
  const HELP_LIFETIME_MS = 5000;
  // Per-hero rate limit on the call itself.  Stops a defenceless
  // healer who's getting chained by a slime from screaming every
  // single frame; she yells, the audience reacts for ~6 s, then
  // she's allowed to yell again if she's still in trouble.
  const HELP_COOLDOWN_MS = 6000;
  // The knight and the viking are heavy fighters — they shrug off
  // hits longer and pride keeps them from yelling for backup at the
  // first scratch.  Per-character overrides flatten their call rate:
  // a much longer cooldown and a lower HP threshold so they only
  // shout when things are genuinely going sideways.
  const HELP_COOLDOWN_TOUGH_MS  = 14000;
  const HELP_HP_FRACTION_TOUGH  = 0.30;
  function isToughCaller(c) {
    return c && (c.name === "knight" || c.name === "viking");
  }
  function helpCooldownFor(c) {
    return isToughCaller(c) ? HELP_COOLDOWN_TOUGH_MS : HELP_COOLDOWN_MS;
  }
  function helpHpFractionFor(c) {
    return isToughCaller(c) ? HELP_HP_FRACTION_TOUGH : LOW_HP_FRACTION;
  }
  // Melee responders need at least this much HP fraction before
  // they'll commit to running into someone else's brawl — a knight
  // at 30 % HP rushing to "help" the healer is just one more body
  // for the slime to chew on.  Ranged responders bypass the check
  // (they can plink from outside the bite radius without dying).
  const HELP_ANSWER_HP_FRACTION = 0.55;
  // Retreat tuning: when a hero is hurt (below LOW_HP_FRACTION) and
  // can't reach a potion, they back away from the nearest monster and
  // angle toward a healer (or the chest) instead of slugging it out.
  const RETREAT_STEP = 120;         // px away from monster per goal
  const RETREAT_RESUME_HP = 0.75;   // return to normal combat at this HP
  const RETREAT_REPLAN_MS = [700, 1100];
  // How hard we pull the retreat goal toward a "safe haven" (healer
  // first, then chest).  1.0 = directly onto the haven, 0.0 = pure
  // away-from-monster; 0.6 gives a clear bias without ignoring the
  // threat behind us.
  const SAFE_HAVEN_BLEND = 0.6;
  // Panic-flee refuge tuning.  startFleeing normally bolts the hero
  // toward the nearest screen edge, but a closer safe destination on
  // the lawn — the alien's parked saucer for himself, or any safe
  // healer / reviver-capable ally for everyone else — is a much
  // better outcome than running offstage and then having to wait
  // out the offstage timer before re-entering.
  //
  //   FLEE_REFUGE_*_MAX_DIST  — hard cap on how far we'll consider
  //                             a refuge to be reachable in a panic.
  //                             Beyond this we just run for the edge,
  //                             since the long jog through the lawn
  //                             eats more health than the offstage
  //                             warp would.
  //   FLEE_REFUGE_EDGE_BIAS   — the chosen refuge has to be at least
  //                             this fraction of the edge-flight
  //                             distance closer than the edge itself
  //                             (1.0 = just-barely-closer is enough,
  //                             smaller numbers demand a bigger win).
  //                             We give a slight advantage to running
  //                             toward an ally because they'll
  //                             actively help on arrival; for the
  //                             alien the saucer is also reliably
  //                             safer than offstage, so same number.
  //   FLEE_REFUGE_RECHECK_MS  — throttle for the in-flight refuge
  //                             validity check (path still safe?
  //                             ally / saucer still reachable?).
  //   FLEE_REFUGE_ARRIVE_R    — radius around the refuge that counts
  //                             as "made it" — pick something
  //                             generous so a hero who runs into
  //                             friendly meatshield range still
  //                             completes the flee gracefully.
  const FLEE_REFUGE_ALLY_MAX_DIST = 320;
  const FLEE_REFUGE_UFO_MAX_DIST  = 360;
  const FLEE_REFUGE_EDGE_BIAS     = 0.95;
  const FLEE_REFUGE_RECHECK_MS    = 320;
  const FLEE_REFUGE_ARRIVE_R      = 32;
  // Mid-flight flee replan.  startFleeing picks the cleaner of the
  // two horizontal exits at the moment the panic begins, but the
  // monsters are alive too — they wander, intercept, and a slime
  // that was 35 px lateral to the chosen corridor (just outside
  // FLEE_PATH_CLEARANCE) will absolutely shuffle into bite range
  // by the time the hero arrives at it, so the hero ends up
  // walking THROUGH a live monster on the way off-stage.  That's
  // the "girl ran past the decoyed slime, then straight through a
  // skeleton, off-screen" complaint.  Fix: while fleeing toward an
  // edge (no refuge active), every FLEE_REPLAN_MS re-score both
  // edges from the current position; if a blocker on the chosen
  // path is uncomfortably close ahead AND the opposite edge has
  // meaningfully more clearance, flip direction.  We're
  // conservative so the girl doesn't oscillate every tick:
  //   • only flip when the near blocker is within FLEE_REPLAN_BLOCKED_R
  //     (≈ 2-3 monster bite radii — close enough that running past
  //     it will land a hit), AND
  //   • only flip when the alt edge is at least FLEE_REPLAN_GAIN px
  //     better — small wins aren't worth the extra travel, AND
  //   • only flip when she still has room to about-face — once
  //     she's within FLEE_REPLAN_EDGE_LOCK px of her chosen edge,
  //     committing forward is faster than turning back.
  // FLEE_PATH_CLEARANCE itself is bumped from the old local 30 to
  // 45 so the initial picker also flags monsters that are CLOSE
  // BUT not on the line — same dynamic-blocker problem at t=0.
  const FLEE_PATH_CLEARANCE      = 45;
  const FLEE_REPLAN_MS           = 280;
  const FLEE_REPLAN_BLOCKED_R    = 70;
  const FLEE_REPLAN_GAIN         = 90;
  const FLEE_REPLAN_EDGE_LOCK    = 80;
  // Anti-dither commit window.  Even with the GAIN margin above, a
  // hero standing between two roughly-equally-bad blockers will
  // happily flip every replan tick as the monsters drift a few
  // pixels: chosen side gains a closer blocker, alt becomes 90+ px
  // better, flip; on the next tick the geometry mirrors and it
  // flips back; result is the bot pivoting in place, never
  // covering ground, eaten by whatever was actually on its way.
  // (User-visible as "the bot could not decide which way to go"
  // — same death-by-indecision pattern that the healer-loop
  // guard at ~5728 fixes for the heal/retreat thrash.)
  //
  // Survival-first rule: once you've picked a direction, COMMIT
  // for at least FLEE_FLIP_COOLDOWN_MS — moving into a slightly
  // worse corridor still beats standing still, because forward
  // motion buys distance from the lawn's brawl centre.  The only
  // override is genuine emergency: a blocker is now within
  // FLEE_FLIP_PANIC_R px of us on the current heading (an actual
  // imminent bite, not a "shuffled into the corridor 60 px out"
  // worry), in which case we flip regardless of cooldown so the
  // hero doesn't auto-walk into the chew.
  const FLEE_FLIP_COOLDOWN_MS    = 1200;
  const FLEE_FLIP_PANIC_R        = 26;
  // Opportunistic heal-on-the-way-out: if the healer's mid-flee but
  // the lawn quietened down before she reached the edge AND there's
  // a real heal target within easy walking distance, abort the run
  // and switch to healing.  See the FLEE_ABORT_* gates inside
  // tickFleeing for the full rationale.  Numbers picked so:
  //   • the threat bubble is wide enough that a slime drifting
  //     toward her wouldn't catch her flat-footed mid-cast;
  //   • the ally radius is roughly half a screen — close enough
  //     that the heal commute beats finishing the flee;
  //   • the throttle is light so we're not re-scanning every
  //     frame but still catch the "monster died, now what" beat
  //     within a few sprite widths of travel.
  const FLEE_ABORT_THREAT_R      = 140;
  const FLEE_ABORT_ALLY_R        = 220;
  const FLEE_ABORT_CHECK_MS      = 250;
  // UFO sortie budget.  Even with monsters still on stage the alien
  // will forcibly land after this much flight time so he isn't a
  // permanent helicopter — he actually comes out of the saucer and
  // plays on the ground between flights.  Then a cooldown window
  // keeps him grounded for a bit before he's allowed to board again.
  const UFO_SORTIE_MAX_MS = [7000, 11000];
  const UFO_COOLDOWN_MS   = [6000, 10000];
  // UFO beam charge.  The saucer carries a battery the pilot drains
  // by firing — burst a few shots, then either coast on slow regen
  // or touch down to recharge.  Tuned so a fresh saucer can fire
  // ~3-4 shots back-to-back at the normal cooldown, then settles
  // into a sustained ~one-shot-every-3 s pace until landed.  Ground
  // regen is much faster so each new sortie starts with a full
  // battery.  When the battery is too low to fire AND no monster is
  // right under the saucer, set down so the alien can recharge on
  // the pad — but only with a bit of clearance, so he doesn't land
  // straight on top of the slime that just drained him.
  const UFO_ENERGY_MAX             = 100;
  const UFO_ENERGY_PER_SHOT        = 28;
  const UFO_ENERGY_AIR_REGEN_PER_S = 9;
  const UFO_ENERGY_GND_REGEN_PER_S = 35;
  const UFO_DEPLETED_LAND_DIST     = 110;
  // Max horizontal reach for the saucer's attack beam (distance from
  // the pilot / UFO position to the monster).  Keep tighter than
  // ground heroes' aggro so strafing rewards flying over the fight.
  const UFO_BEAM_MAX_RANGE         = 88;
  // Hard ceiling on a single sortie regardless of charge — safety
  // valve so a perfectly-paced pilot can't camp the sky forever.
  const UFO_PATROL_FAILSAFE_MS     = 28000;
  // Shot down in flight: saucer eases down, pilot falls out, then death.
  const UFO_CRASH_DESCEND_MS       = 720;
  const UFO_CRASH_FALL_MS          = 420;
  const HEAL_RANGE = 22;           // melee fall-back range
  // The girl is a proper MMO-style healer: she lobs holy magic from
  // way back and never has to walk into the slime's mouth.  A ~88 px
  // reach is wide enough to cover a brawling ally from outside the
  // average monster's bite radius (the safety check uses 56 px) but
  // tight enough that she still has to move with the fight rather
  // than camping the chest.  Same trick for revives — she stands a
  // tile or two off the corpse and channels rather than tucking in
  // alongside it where the slime that just killed it is still
  // chewing.  These wider reaches are also what makes her actually
  // get heals off in the field; the melee 22 px version basically
  // never passed the safePath filter when it mattered.
  const GIRL_HEAL_RANGE   = 88;
  const GIRL_REVIVE_RANGE = 64;
  const HEAL_COOLDOWN_MS = 1600;
  // Threshold below which the girl will commit to healing an ally.
  // Bumped from 0.8 → 0.92 so she's not idling next to a 78%-HP
  // knight just because his bar isn't dramatic enough yet — at
  // ~28 HP per cast (after the flower buff) a few extra top-ups
  // are essentially free, and they keep her actively casting.
  const GIRL_HEAL_TARGET_FRAC = 0.92;
  // Revive ritual: stand next to a fallen ally and channel holy light
  // for REVIVE_MS before they pop back up at full HP.  Only witch,
  // firemage and girl know how to do this.
  const REVIVE_RANGE = 24;
  const REVIVE_MS = 2400;
  // Mid-channel safety abort radius for the girl: any monster
  // wandering inside this distance during the channel phase yanks
  // her out of the cast and into a flee.  Tuned a touch above
  // typical monster bite reach (~22 px) so we abort a beat BEFORE
  // the first hit lands rather than after, which gives the
  // post-decoy gallop / horse summon a useful head start instead
  // of triggering on the bite that already chewed her bar in half.
  const REVIVE_CHANNEL_BITE_R = 36;
  // Fighter-on-an-errand interrupt radius: a witch or firemage walking
  // up to a corpse / wounded ally normally just snipes opportunistically
  // while moving (see snipeAllowed → tryRangedSnipe).  But if a monster
  // has closed inside this radius, the fighter is about to be bitten
  // and one fireball every 1500 ms is not going to cut it — they
  // should engage properly (startFighting), trade blows, and resume
  // the errand on the next maybeEnterCombat pass.  Tuned a bit larger
  // than typical bite reach (~22 px) so we react BEFORE the first hit
  // lands, with enough headroom for the run-up step the fighter needs
  // to face the target without immediately re-triggering.
  const FIGHTER_ERRAND_BITE_R = 60;
  // "Under fire" window — how recently a character has been hit for
  // the under-fire heuristics (eager self-drink while carrying a
  // brew, etc.) to count them as actively in combat.  3 s covers
  // typical monster bite cooldowns (slime ~900 ms, skeleton ~700 ms)
  // with comfortable headroom: as long as a monster is still
  // swinging at her every couple of seconds, she's "under fire".
  // UNDER_FIRE_DRINK_FRAC is the bumped HP threshold for cracking
  // open a held heal bottle while under fire — chosen at 0.75 so a
  // witch carrying a brew through a melee at 70% HP (the exact
  // scenario the user reported) actually drinks it instead of
  // committing to the chest run and dying with it in hand.
  const UNDER_FIRE_MS         = 3000;
  const UNDER_FIRE_DRINK_FRAC = 0.75;
  // UFO revive: the alien parks the saucer over a corpse and beams it
  // back up with a descending cone of holy rings.  UFO_REVIVE_HOVER_DX
  // / _DY define the "on station" box — the cone only channels once
  // the saucer is roughly over the body.  We want the saucer LOW over
  // the corpse for the revive (a beam from way up in the sky reads
  // like a searchlight, not a tractor beam), so the on-station band
  // is just 16..52 px above the body.  UFO_REVIVE_MS is how long the
  // channel has to hold to complete.
  const UFO_REVIVE_MS = 2600;
  const UFO_REVIVE_HOVER_DX = 22;
  const UFO_REVIVE_HOVER_DY_MIN = 16;
  const UFO_REVIVE_HOVER_DY_MAX = 52;
  // Drinking-from-chest pacing: how long the hero fiddles with the
  // lid before a potion comes out, and how long they stand still to
  // actually drink it.
  const CHEST_OPEN_MS = 260;
  const DRINK_MS = 800;
  const POTION_HEAL = 40;
  // Pickup radius for a wounded hero to detour onto a dropped heal
  // bottle: roughly "if I can see it across half the lawn I'll go".
  // Tighter than chest-seeking range because the bottle is a windfall
  // — we don't want everyone abandoning a defended spot to chase a
  // glint of glass on the far side.
  const GROUND_PICKUP_R = 140;
  const GIRL_HEAL = 18;

  // Hand-off detour: the witch is walking a freshly brewed heal
  // bottle to the chest when a wounded ally happens to be right on
  // her path.  Rather than stocking the kiosk and making the friend
  // queue for it, she swings by and presses the bottle into their
  // hand on the spot.  HANDOFF_R bounds how big a detour we tolerate
  // (px from the witch's *current* position, not the chest), the HP
  // gate matches the same "go drink a potion" threshold the rest of
  // the team uses, the check is throttled so we're not pathfinding
  // every frame, and HANDOFF_GIVE_MS is the little stand-still beat
  // for the transfer animation / barks to read on screen.
  const HANDOFF_R = 110;
  const HANDOFF_HP_FRACTION = LOW_HP_FRACTION;
  const HANDOFF_CHECK_MS = 500;
  const HANDOFF_GIVE_MS = 260;
  const HANDOFF_APPROACH_TIMEOUT_MS = 5000;
  // How long the witch will keep a freshly brewed bottle on her belt
  // when the chest already has stock of that kind.  She'll happily
  // wander around with it — opportunistically self-drinking when she
  // gets shot up or handing it off to a wounded ally that walks past
  // — but if the lawn stays calm long enough she eventually walks it
  // over to the kiosk so the inventory still gets restocked instead
  // of festering in her pocket forever.
  const WITCH_CARRY_DEPOSIT_MS = 16000;

  // Per-brew probability that the witch's next bottle comes out a
  // REVIVE potion instead of a heal.  Heals are the default because
  // wounded heroes need them often; revives are the rarer specialty
  // tool, so we keep the chance low (~1 in 5) and additionally avoid
  // brewing more revives when the chest already has one waiting (see
  // tickWitchBrew).  Tweak this single knob if revives feel too
  // common or too scarce.  We also force a revive brew the moment
  // there's an actual corpse on the lawn but no revive bottle in
  // stock — see tickWitchBrew below — so a fallen ally always
  // gets a revive in the pipeline regardless of this lottery.
  const REVIVE_BREW_PROB = 0.35;
  // Extra revive chance when the chest already has at least one heal
  // but no revive yet — keeps a green bottle on the shelf without
  // starving the red stack.
  const REVIVE_BREW_PROB_WHEN_HEAL_OK = 0.52;

  // Witch brewing pacing.  While she's standing at her cauldron the
  // `brewAccum` timer fills up; once it's full a potion is "ready" and
  // she heads to the chest to stock it.
  const BREW_MS = 9600;
  const DEPOSIT_OPEN_MS = 260;

  // ---- HydraPlan: team-level boss coordinator -----------------------
  // The hydra is a stationary boss with FIVE distinct ways of killing
  // a hero (bite, spit, head crush, body crawl, regrow ramp).  Letting
  // the regular wandering / aggro AI sort itself out against her was
  // visibly broken: melee heroes either ignored the body (out of
  // AGGRO_RANGE) or piled into the bite cone three at a time, casters
  // chipped at the body from inside spit range with no idea they were
  // about to eat acid, and the healer + reviver routinely walked
  // straight through the spit fan to top someone up — the textbook
  // "characters acting chaotically and dying like flies" the user
  // complained about.
  //
  // HydraPlan is the single source of truth for "what the team is
  // doing right now".  It activates when the hydra emerges (called
  // from Monsters.maybeSeedHydra), deactivates when she dies
  // (Monsters.killHydraBody), and exposes a small read-only API the
  // existing AI branches can consult:
  //
  //   .active()         — boss fight currently in progress?
  //   .body()           — the live hydra body monster, or null
  //   .pushWindow()     — true while head pressure is low enough that
  //                       even ranged heroes / revivers should commit
  //                       to closing the gap (≤ HEAD_PUSH_THRESHOLD
  //                       alive heads).  Heads outside this window
  //                       are restored to "stay outside spit range
  //                       unless you're a TANK" defensive posture.
  //   .roleFor(c)       — TANK / CUTTER / SMASHER / HEALER (string)
  //                       or null for "no boss role assigned" (corpse,
  //                       offstage, etc.).
  //   .targetFor(c)     — preferred monster for this hero given role:
  //                       CUTTER → nearest live head, SMASHER → body,
  //                       TANK → adjacent head if any else body.  Used
  //                       by maybeEnterCombat to pick a target with
  //                       authority instead of relying on the
  //                       distance-bounded threat picker.
  //   .stanceFor(c)     — { x, y } the hero should stand at when not
  //                       actively closing for a swing.  Used by the
  //                       healer-pocket nudge so the girl naturally
  //                       sits OUTSIDE spit range during boss fights.
  //   .inSpitDanger(x,y) — point inside the live spit envelope?  The
  //                       reviver / healer safe-path checks consult
  //                       this before crossing the lawn so they don't
  //                       walk into acid for a top-up.
  //
  // Numbers below are set so a 720-wide stage (the default index.html
  // viewport) has all four ring positions visible and reachable, with
  // ~30 px of headroom outside the live HYDRA_SPIT_RANGE so a tiny
  // wobble doesn't immediately re-trigger the danger check.
  const HYDRA_PUSH_HEAD_THRESHOLD = 2;
  const HYDRA_TANK_RING_R         = 80;   // melee ring radius from body
  const HYDRA_CUTTER_RING_R       = 124;  // bow / shuriken ring
  const HYDRA_SMASHER_RING_R      = 132;  // fireball / body-chip ring
  const HYDRA_HEALER_RING_R       = 138;  // close enough to reach frontliners
  const HYDRA_SPIT_HEADROOM       = 30;   // healer pocket sits outside this

  // ---- Boss prep phase ("war council") ------------------------------
  // Two-phase boss life cycle:
  //   RALLY  — alarm just fired, hydra still emerging.  Heroes converge
  //            on a fixed safe assembly point (NOT to scattered
  //            stations, several of which sit inside spit range).  No
  //            engagement is allowed: bestMonsterFor's pass-2 (the
  //            "hydra is visible from anywhere" override) stays closed.
  //   ENGAGE — hydra is fully out and either ≥N heroes have arrived at
  //            rally OR the timeout fired.  At the transition we apply
  //            a one-shot "war cry" buff to everyone present at the
  //            rally point (those who lingered or stayed at prep
  //            stations get nothing — penalty for not joining), then
  //            normal stance/target logic takes over.
  //
  // Rally point geometry (assuming 720×~330 stage, body at ~(96, 86)):
  //   distance to body = sqrt(264² + 124²) ≈ 292 px → outside the
  //   220 px spit envelope + 30 px headroom (= 250 px), so a hero
  //   gathered here is genuinely safe.  March from rally to the
  //   nearest engage ring (smasher at r=132 from body) is ~160 px,
  //   short enough that the formation transition reads as "step
  //   forward into combat", not "march across the map".
  const HYDRA_PHASE_RALLY      = "rally";
  const HYDRA_PHASE_ENGAGE     = "engage";
  const HYDRA_RALLY_X          = 360;
  const HYDRA_RALLY_Y          = 210;
  const HYDRA_RALLY_R          = 70;       // "in rally" radius from the point
  const HYDRA_RALLY_MIN_HEROES = 4;        // adaptive engage trigger
  const HYDRA_RALLY_MAX_MS     = 8000;     // hard timeout: engage no matter what
  const HYDRA_RALLY_MIN_MS     = 2200;     // floor: never engage before emerge done

  // War-cry buff applied at the moment of engage.  Stacks ON TOP of
  // station buffs (infused, atkBoost, etc.) — it's a small additional
  // bump for being in formation, not a replacement for prep.
  const HYDRA_WARCRY_DMG_MUL   = 1.20;
  const HYDRA_WARCRY_HEAL_MUL  = 1.30;
  const HYDRA_WARCRY_CD_MUL    = 0.90;
  const HYDRA_WARCRY_MS        = 25000;

  const HydraPlan = (function () {
    let body = null;
    let activeFlag = false;
    let phase = HYDRA_PHASE_RALLY;
    let phaseStartedAt = 0;
    let warCryFiredAt = 0;

    function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

    function rallyPoint() {
      // Single safe assembly point in the open lawn, well outside
      // spit range from the body.  The rally point is fixed (not
      // body-relative) because the body sits in a fixed corner — a
      // dynamic rally would just track the same coordinate and add
      // jitter for no gain.
      return { x: HYDRA_RALLY_X, y: HYDRA_RALLY_Y };
    }

    function inRally(c) {
      if (!c || c.hp <= 0) return false;
      const r = rallyPoint();
      return Math.hypot(c.x - r.x, c.y - r.y) < HYDRA_RALLY_R;
    }

    function ralliedHeroes() {
      let n = 0;
      for (const c of list) {
        if (c.hp <= 0 || c.combatMode === "dead") continue;
        if (c.state === "offstage") continue;
        if (inRally(c)) n++;
      }
      return n;
    }

    function activate(b) {
      body = b || null;
      activeFlag = !!b;
      phase = HYDRA_PHASE_RALLY;
      phaseStartedAt = (typeof performance !== "undefined")
        ? performance.now() : Date.now();
      warCryFiredAt = 0;
      if (!b) return;
      // Boss-start nudge.  We deliberately do NOT:
      //   • force offstage heroes onto the lawn (the Director handles
      //     timing; the witch finishing a brew shouldn't be cut short),
      //   • yank heroes away from a prep station (firemage at the
      //     campfire is far from the cave and SHOULD finish charging,
      //     witch at her cauldron has already started — let her cook).
      //
      // What we DO:
      //   • End idle chit-chat so alert-line dialogue can play.
      //   • Cancel "leaving" — the boss is a reason to stay.
      //   • Nudge wandering heroes toward the rally point so the team
      //     visibly converges instead of orbiting their last wander
      //     destination.  Heroes in `working` (= actively buffing at a
      //     station) keep their target — they'll head to rally once
      //     their work cycle exits naturally.
      const r = rallyPoint();
      for (const c of list) {
        if (c.hp <= 0 || c.combatMode === "dead") continue;
        if (c.state === "offstage") continue;
        if (c.state === "talking" && c.partner) endTalking(c);
        if (c.state === "leaving") c.state = "wandering";
        if (c.state === "wandering" && c.combatMode === "none") {
          // Spread heroes around the rally point so they don't all
          // pile on one pixel — small per-hero offset based on name
          // hash gives stable, readable formation.
          const nm = c.name || "";
          let seed = nm.length;
          for (let i = 0; i < nm.length; i++) seed = (seed * 31 + nm.charCodeAt(i)) | 0;
          const ang = (Math.abs(seed) * 0.073) % (Math.PI * 2);
          const off = 16 + (Math.abs(seed) % 14);
          setTarget(c, r.x + Math.cos(ang) * off,
                       r.y + Math.sin(ang) * off);
        }
        c.lastThreatCheck = 0;
      }
    }

    function deactivate() {
      body = null;
      activeFlag = false;
      phase = HYDRA_PHASE_RALLY;
    }

    function active() {
      if (!activeFlag) return false;
      // Catch races where the body was removed without anyone calling
      // deactivate (e.g. dev-only Monsters.list reset) — re-validate
      // on every read so a stale `active = true` doesn't haunt the
      // perception override forever.
      if (!body || body.dying) {
        if (body && body.dying) return true; // dying body still counts as "boss fight"
        activeFlag = false;
        body = null;
        return false;
      }
      return true;
    }

    function getBody() { return active() ? body : null; }

    function inEngage() {
      return active() && phase === HYDRA_PHASE_ENGAGE;
    }

    function inRallyPhase() {
      return active() && phase === HYDRA_PHASE_RALLY;
    }

    // Time the current RALLY phase has been running, in ms.  Used by
    // pre-engage prep helpers (firemage's campfire top-up) to decide
    // whether a side-trip still fits before the rally MAX timeout.
    // Returns 0 outside active rally.
    function rallyAgeMs(now) {
      if (!active() || phase !== HYDRA_PHASE_RALLY) return 0;
      return Math.max(0, now - phaseStartedAt);
    }

    // Called once per frame from the main hero tick.  Walks the phase
    // machine forward: RALLY → ENGAGE when the body is fully out AND
    // the team has either gathered (≥4 in rally) or the timeout
    // expired.  At the transition we fire the "war cry" pulse.
    function tickPlan(now) {
      if (!active()) return;
      if (phase !== HYDRA_PHASE_RALLY) return;
      const elapsed = now - phaseStartedAt;
      if (elapsed < HYDRA_RALLY_MIN_MS) return;
      // Body still emerging?  Hold rally — engaging mid-emerge means
      // hitting nothing and walking into the bite cone as she settles.
      if (body && body.state === "emerging") return;
      const enough = ralliedHeroes() >= HYDRA_RALLY_MIN_HEROES;
      const timeout = elapsed >= HYDRA_RALLY_MAX_MS;
      if (!enough && !timeout) return;
      // Transition to engage.
      phase = HYDRA_PHASE_ENGAGE;
      phaseStartedAt = now;
      fireWarCry(now);
    }

    function fireWarCry(now) {
      if (warCryFiredAt > 0) return;
      warCryFiredAt = now;
      let count = 0;
      for (const c of list) {
        if (c.hp <= 0 || c.combatMode === "dead") continue;
        if (c.state === "offstage") continue;
        if (!inRally(c)) continue;
        c.warCryUntil = now + HYDRA_WARCRY_MS;
        count++;
        // Reset their threat check so the engage starts immediately.
        c.lastThreatCheck = 0;
      }
      // Light tone bump so dialog colours shift the moment the team
      // commits.  We re-use the existing alarm channel rather than
      // adding a new one — the engage transition is conceptually a
      // second "they're coming" beat (now plural, now formed up).
      if (count > 0 && typeof Dialog !== "undefined" && Dialog.note) {
        Dialog.note("alarm");
      }
    }

    function aliveHeads() {
      if (!active()) return [];
      const out = [];
      for (const m of Monsters.list) {
        if (m.kind !== "hydraHead") continue;
        if (m.parent !== body) continue;
        if (m.severed || m.dying) continue;
        out.push(m);
      }
      return out;
    }

    function pushWindow() {
      if (!active()) return false;
      if (phase !== HYDRA_PHASE_ENGAGE) return false;
      return aliveHeads().length <= HYDRA_PUSH_HEAD_THRESHOLD;
    }

    function spitR() {
      return (Monsters.HYDRA_SPIT_RANGE || 280);
    }

    function tailR() {
      return (Monsters.HYDRA_TAIL_RANGE || 70);
    }

    // Tail telegraph: body's `tailState` flips to "winding" 700 ms
    // before the strike lands and stays "striking" for the 220 ms
    // damage window (see tickHydraTail in monsters.js).  Anyone
    // currently inside HYDRA_TAIL_RANGE during either phase eats
    // HYDRA_TAIL_DMG (10, +25% enraged).  We expose the telegraph
    // so non-tanks can sidestep instead of soaking the swipe — the
    // TANK is supposed to be in the swipe and is excluded from the
    // dodge prompt below (see shouldDodgeTail).
    function tailWinding() {
      if (!active() || !body) return false;
      return body.tailState === "winding"
          || body.tailState === "striking";
    }

    function inTailDanger(x, y) {
      if (!tailWinding()) return false;
      // Small headroom (8 px) so a hero standing right at the edge of
      // the swipe doesn't get a false "you're safe" reading from a
      // round-off and then eat the strike anyway.
      return Math.hypot(x - body.x, y - body.y) < tailR() + 8;
    }

    // Returns true when this hero should drop their current move and
    // step away from the body for the tail window.  TANK eats the
    // swipe by design (he has block + DR) so the formation doesn't
    // collapse; everyone else makes a hole.  HEALER also dodges,
    // since one tail tick on the medic can cascade into team death.
    function shouldDodgeTail(c) {
      if (!c || c.hp <= 0) return false;
      const r = roleFor(c);
      if (r === "TANK") return false;
      return inTailDanger(c.x, c.y);
    }

    // Where to step to clear the swipe.  Pushes radially outward
    // from the body to (tailR + DODGE_PAD) px so a single step lands
    // safely.  Y is biased toward the body's lower hemisphere
    // because most heroes engage from below the lair, so a straight
    // radial nudge keeps them in their existing engage lane instead
    // of yanking them across the body.
    function tailDodgeGoal(c) {
      if (!body) return null;
      const dx = c.x - body.x;
      const dy = c.y - body.y;
      const len = Math.hypot(dx, dy) || 1;
      const goal = tailR() + 22; // pad past the radius for a clean exit
      return clampStance(body.x + (dx / len) * goal,
                         body.y + (dy / len) * goal);
    }

    function inSpitDanger(x, y) {
      if (!active()) return false;
      const dx = x - body.x;
      const dy = y - body.y;
      // Spit only fires into the lower hemisphere of the lair (see
      // pickHydraSpitTarget — it rejects targets with dy < -30) so a
      // hero standing roughly level with or above the body doesn't
      // need the same caution.  Keep a generous halo on the lower
      // side and a tight one on the upper side to match.
      if (dy < -20) return false;
      return Math.hypot(dx, dy) < spitR() + HYDRA_SPIT_HEADROOM;
    }

    // Role assignment is tuned to the hydra's damage profile:
    //   • Body has magic-resist 0.55 → physical damage is ~1.8× more
    //     efficient at chipping body HP than magic.  Physical heroes
    //     (knight, viking, archer, zombie, ninja, robot) are SMASHER
    //     by default — body is the win condition.
    //   • Heads take FULL magic damage and only 26 HP each → magic
    //     heroes (firemage, witch, alien-on-foot) are CUTTER — they
    //     keep the regrow swarm under control while the physical
    //     side punches body HP down.
    //   • Knight is the dedicated TANK because his taunt+block kit
    //     was designed for exactly this — pulls head aggro, mitigates
    //     bites, and chips body when no head is in face.
    //   • Viking COULD be TANK on raw HP but his cleave on heads is
    //     too valuable to spend on holding aggro — moves to SMASHER
    //     (body) so his physical 18 dmg lands without resist; cleave
    //     still hits adjacent heads as a side-effect.
    function roleFor(c) {
      if (!active() || !c) return null;
      if (c.hp <= 0) return null;
      if (c.combatMode === "dead") return null;
      if (c.combatMode === "ufoing") return "SKY";
      if (c.role === "healer") return "HEALER";
      if (c.name === "knight") return "TANK";
      // Magic kit → CUTTER (heads, full damage).
      if (c.name === "firemage" || c.name === "witch") return "CUTTER";
      if (c.name === "alien" && !c.mounted) return "CUTTER";
      // Everything else physical → SMASHER (body, resist-bypass).
      return "SMASHER";
    }

    function nearestHeadTo(c) {
      let best = null, bestD = Infinity;
      for (const h of aliveHeads()) {
        const d = Math.hypot(h.x - c.x, h.y - c.y);
        if (d < bestD) { bestD = d; best = h; }
      }
      return best;
    }

    function targetFor(c) {
      if (!active() || !c) return null;
      // During rally phase we're not engaging anyone — the picker
      // should fall back to its normal local-threat behaviour.
      if (phase !== HYDRA_PHASE_ENGAGE) return null;
      const role = roleFor(c);
      if (!role) return null;
      if (role === "CUTTER") return nearestHeadTo(c) || body;
      if (role === "TANK") {
        // If a head has reared into our face, swing at it; otherwise
        // chip the body so we're not standing useless during retracts.
        const close = nearestHeadTo(c);
        if (close && Math.hypot(close.x - c.x, close.y - c.y) < HYDRA_TANK_RING_R) {
          return close;
        }
        return body;
      }
      if (role === "SMASHER") {
        // Default: bodies all the way down (resist-bypass + win
        // condition).  Only divert to a head if one is right in the
        // smasher's face AND a CUTTER hasn't already locked it — this
        // prevents archer/ninja/zombie spending shots on heads that
        // firemage/witch are already deleting.
        const range = (c.atk && c.atk.range) || 60;
        const close = nearestHeadTo(c);
        // Short-ranged ranged SMASHER bail-out: a hero whose weapon
        // range can't reach the body from outside the head's bite
        // envelope (HYDRA_HEAD_RANGE ≈ 95 + a small safety pad)
        // shouldn't be marched into bite reach just to chip body HP.
        // The user-reported case: the ninja (range 120) standing off
        // at range-6 = 114 px ends up 19 px outside head reach — any
        // head that swivels his way bites him for free.  Returning
        // null here makes maybeEnterCombat fall through to the local-
        // aggro picker, so he engages slimes/adds in his face at his
        // own standoff and only commits to a head if one drifts into
        // actual weapon range.  Melee SMASHERs (viking, zombie,
        // robot) are unaffected — they need to be in melee anyway.
        // Long-ranged SMASHERs (archer, range 170) clear the bar
        // and stay on the body chip plan.
        const headReach = (Monsters.HYDRA_HEAD_RANGE || 95);
        const safeBodyRange = headReach + 25;
        const tooShortForBody =
          isRanged(c) && (range - 6) < safeBodyRange;
        if (tooShortForBody) {
          // Snipe a head only if it's already inside his weapon
          // range (no walking-in required).  Else bail out — the
          // wandering tick lets tryRangedSnipe pick off whatever
          // wanders into range, and the imminent-threat retarget in
          // tickFighting picks up adds that close on him.
          if (close && Math.hypot(close.x - c.x, close.y - c.y) <= range - 6) {
            return close;
          }
          return null;
        }
        if (close && Math.hypot(close.x - c.x, close.y - c.y) < range * 0.40) {
          return close;
        }
        return body;
      }
      return null;
    }

    function clampStance(x, y) {
      const W = (typeof Scene !== "undefined" && Scene.WIDTH) || 720;
      const top = (typeof Scene !== "undefined" && Scene.FLOOR_TOP) || 40;
      const bot = (typeof Scene !== "undefined" && Scene.FLOOR_BOTTOM)
        || (top + 100);
      return {
        x: clamp(x, 24, W - 24),
        y: clamp(y, top + 14, bot - 8),
      };
    }

    function stanceFor(c) {
      if (!active() || !c) return null;
      const role = roleFor(c);
      if (!role) return null;
      // RALLY phase: every role gets a slightly different rally-point
      // offset so the formation is readable — tanks in front (closer
      // to the body), cutters/smashers behind them, healer at the
      // back.  This is BEFORE the fight starts; engage-time stances
      // (the body-relative rings) only kick in after the phase flips.
      if (phase === HYDRA_PHASE_RALLY) {
        const r = rallyPoint();
        if (role === "TANK")    return clampStance(r.x - 18, r.y +  4);
        if (role === "CUTTER")  return clampStance(r.x +  6, r.y - 12);
        if (role === "SMASHER") return clampStance(r.x + 22, r.y +  0);
        if (role === "HEALER")  return clampStance(r.x + 30, r.y + 16);
        return clampStance(r.x, r.y);
      }
      const bx = body.x, by = body.y;
      // Body sits in the upper-LEFT corner of the lawn; everyone
      // approaches from the lower-right.  We project each role's ring
      // into that quadrant so the four roles visually fan out instead
      // of stacking on the same column.
      if (role === "TANK") {
        // Front-and-slightly-right of the body, well inside spit so
        // we soak bites + serve as a forward marker for revivers.
        return clampStance(bx + HYDRA_TANK_RING_R * 0.7,
                           by + HYDRA_TANK_RING_R * 0.5);
      }
      if (role === "CUTTER") {
        // Witch boss role = SUPPORT, not front-line cutter.  Her
        // unique value in a hydra fight is brewing heal/revive
        // potions and channelling field revives — both of which
        // require her standing at her own cauldron (the brew tick
        // only progresses while atHome < 24 px from the station).
        // The previous "stand at hex-range from body biased toward
        // cauldron" stance put her at ~116 px from the body, well
        // inside the spit envelope AND inside head-bite reach,
        // which is exactly why playtest reported her dying in the
        // first half of every fight.  We now park her AT the
        // cauldron during engage so the brew clock keeps ticking;
        // her firing AI will still take an opportunistic hex if a
        // head wanders into her 130-px range, but she no longer
        // commits to a stance that gets her killed.  Combat entry
        // is gated separately in maybeEnterCombat so she doesn't
        // walk away from the cauldron to chase a head she can't
        // hit from there.
        if (c.name === "witch" && c.activity) {
          return clampStance(c.activity.x, c.activity.y);
        }
        return clampStance(bx + HYDRA_CUTTER_RING_R * 0.85,
                           by + HYDRA_CUTTER_RING_R * 0.45);
      }
      if (role === "SMASHER") {
        if (pushWindow()) {
          // Push window: head pressure low enough that we can step
          // into the spit envelope to actually land hits on body HP
          // before the next regrow cycle resets the count.
          return clampStance(bx + HYDRA_SMASHER_RING_R * 0.95,
                             by + HYDRA_SMASHER_RING_R * 0.4);
        }
        // Spit-safe ring just outside acid range: the body is still
        // shootable from here for any caster (range ≥ 150) but we
        // stop being a free spit target.
        const r = HYDRA_SMASHER_RING_R;
        return clampStance(bx + r * 0.92, by + r * 0.42);
      }
      if (role === "HEALER") {
        // Healer pocket = the IDLE position she holds when nobody
        // urgently needs a heal.  The previous version sat at
        // HYDRA_HEALER_RING_R (138 px) from the body — visually
        // "behind the smashers" but in practice INSIDE the spit
        // envelope (280 px) the entire fight, so she ate spit
        // every push window even with no heal target.
        // tools/girl_position_sim.py confirmed: with the old pocket
        // she spent 100 % of the fight in spit and her mean min
        // distance from the body was 134 px (just 30 px clear of
        // bite reach).  The new pocket sits OUTSIDE the spit
        // headroom envelope (HYDRA_SPIT_RANGE + HYDRA_SPIT_HEADROOM
        // ≈ 330 px) so she only enters spit when she's actively
        // closing on a wounded ally — `safeCastFrom` still permits
        // standoffs inside the spit ring during the actual cast,
        // and `tickHealing` re-evaluates per tick so she steps back
        // out the moment the patient is topped up.
        const safeR = (Monsters.HYDRA_SPIT_RANGE || 280) +
                      HYDRA_SPIT_HEADROOM + 5;
        // Sweep angles in the SOUTH semicircle (south-east → south →
        // south-west).  We never project NORTH of the body because
        // the team approaches from south and we don't want her on
        // the wrong side of the boss; we never flip pocket "across"
        // the body either, because that forces her to walk through
        // the boss to switch sides (which is exactly how the
        // simpler east/west picker dragged her into bite range when
        // the body roamed into the eastern half of the lawn).
        // Pick the angle whose projection lands FARTHEST from the
        // body after the lawn-clamp — i.e. the south arc point most
        // comfortably inside the lawn rectangle.
        let best = null, bestD = -1;
        // 33° matches the historical (0.88, 0.58) SE projection so
        // we keep that as the default tie-breaker; the rest of the
        // sweep adds south + SW + ESE/SSW alternatives for cases
        // where the body roams toward a corner.
        const ANGLES = [33, 55, 75, 95, 115, 135, 145, 25, 15];
        // Same-side stickiness: never pick a pocket that requires
        // walking THROUGH the boss to reach.  If the girl is east
        // of the body, restrict to east-half angles (cos > 0).  If
        // west, restrict to west-half (cos < 0).  When her side has
        // NO angle that lands at safeR (boss in a corner), we fall
        // back to allowing all angles — better to eat one tick of
        // spit than to pin her right next to the body.
        const sameSideOnly = c && (c.x !== bx);
        const onEast = c && c.x >= bx;
        let bestSameSide = null, bestSameSideD = -1;
        for (let i = 0; i < ANGLES.length; i++) {
          const a = ANGLES[i] * Math.PI / 180;
          const cand = clampStance(bx + Math.cos(a) * safeR,
                                    by + Math.sin(a) * safeR);
          const d = Math.hypot(cand.x - bx, cand.y - by);
          // Bias toward SE (smaller index in ANGLES = preferred).
          // The +0.0001 * (ANGLES.length - i) keeps SE winning when
          // multiple angles project to the same clamped distance —
          // visually identical pockets, but prefer the historical
          // SE-behind-the-smashers framing.
          const score = d + 0.0001 * (ANGLES.length - i);
          if (score > bestD) { bestD = score; best = cand; }
          if (sameSideOnly) {
            const candEast = cand.x >= bx;
            if (candEast === onEast && score > bestSameSideD) {
              bestSameSideD = score; bestSameSide = cand;
            }
          }
        }
        // Prefer the same-side pocket as long as it keeps her clear
        // of head-bite range.  Crossing through the body to reach a
        // marginally farther pocket is FAR worse than camping in
        // spit for a few seconds — the cross-through walk takes ~3
        // seconds at girl speed, and every tick of that walk is
        // inside bite reach (bite per second ~25 dmg vs spit per
        // second ~6).  Threshold of HYDRA_HEAD_RANGE + 30 (135 px
        // from the body) keeps her two slime-bites of margin clear
        // of the head ring while letting her camp the same side
        // when the body has cornered her.
        const headBiteR = (Monsters.HYDRA_HEAD_RANGE || 95) + 10;
        if (bestSameSide && bestSameSideD >= headBiteR + 30) {
          return bestSameSide;
        }
        return best;
      }
      return null;
    }

    return {
      activate, deactivate,
      active, body: getBody, pushWindow,
      inSpitDanger, spitR,
      tailWinding, inTailDanger, shouldDodgeTail, tailDodgeGoal,
      roleFor, targetFor, stanceFor,
      aliveHeads,
      tickPlan,
      inEngage, inRallyPhase, rallyAgeMs,
      rallyPoint, ralliedHeroes, inRally,
    };
  })();

  // ---- station buffs ------------------------------------------------
  // Each peacetime station applies a small temporary combat buff to
  // whoever spends time at it.  The numbers are deliberately mild —
  // we want recognisable "I just trained, I'm warmed up" beats, not
  // a buff treadmill that makes off-station play feel weak.
  const ATK_BOOST_MUL  = 1.30;   // dummy / stump: heavier hits
  const ATK_BOOST_MS   = 12000;
  const RAPID_FIRE_MUL = 0.75;   // target: faster cooldown
  const RAPID_FIRE_MS  = 12000;
  const HEAL_POWER_MUL = 1.55;   // flowers: girl heals harder
  const HEAL_POWER_MS  = 12000;
  const OILED_MUL      = 0.80;   // robot: faster cooldown when oiled
  const OILED_MS       = 18000;
  // Firemage soaking heat from his own burning campfire: hits harder
  // AND a touch faster.  Both muls are deliberately stacked because
  // the campfire is the firemage's *only* personal station (no dummy
  // / target equivalent to drift to), so the single buff has to
  // carry both flavours.  Still capped well under "double damage" so
  // a charged firemage feels potent without trivialising the stage.
  const INFUSED_DMG_MUL = 1.45;
  const INFUSED_CD_MUL  = 0.85;
  const INFUSED_MS      = 14000;
  // Firemage's "rain of fire" AoE — unlocked only while the
  // "infused" buff is up, so the campfire really does grant a
  // distinct ultimate and not just bigger numbers on the same
  // fireball.  Cluster gating + cooldown shape it into "every few
  // seconds, when monsters group up, drop a volley":
  //   • FIRE_RAIN_CLUSTER_R  — radius around a candidate centre
  //     that we count monsters in to score "this is a cluster".
  //   • FIRE_RAIN_MIN_CLUSTER — minimum monsters in that radius
  //     before the spell fires.  3 means it stays a *group* answer
  //     and a single straggler keeps eating regular fireballs.
  //   • FIRE_RAIN_AOE_R      — how far from the centroid each of
  //     the meteor impact points may be scattered.
  //   • FIRE_RAIN_HIT_R      — splash radius of one meteor.  Smaller
  //     than the cluster radius so the rain rewards a TIGHTLY-packed
  //     group: overlap stacks damage on the centre monsters; loose
  //     formations only catch one meteor each.
  //   • FIRE_RAIN_DMG        — per-meteor damage before c.dmgMul.
  //     6 meteors × 14 dmg × 1.45 (infused) ≈ 122 spread damage on
  //     a tight cluster — enough to delete weak adds, soften tanks.
  //   • FIRE_RAIN_COUNT      — meteors per volley.
  //   • FIRE_RAIN_STAGGER_MS — gap between successive meteors so
  //     the rain reads as a shower instead of one frame of strobe.
  //   • FIRE_RAIN_CD_MS      — base cooldown; multiplied by the
  //     hero's cdMul like every other ranged attack, so infused
  //     (0.85 mul) ≈ 3825 ms cadence.  Slow enough that the basic
  //     fireball still does most of the firemage's work; fast
  //     enough that during a 14 s buff he gets ~3 rains.
  const FIRE_RAIN_CLUSTER_R   = 38;
  const FIRE_RAIN_MIN_CLUSTER = 3;
  const FIRE_RAIN_AOE_R       = 32;
  const FIRE_RAIN_HIT_R       = 18;
  const FIRE_RAIN_DMG         = 14;
  const FIRE_RAIN_COUNT       = 6;
  const FIRE_RAIN_STAGGER_MS  = 130;
  const FIRE_RAIN_CD_MS       = 4500;
  // Ninja anti-worm: when his target is a buried/transitioning worm
  // he abandons the shuriken kit and drives the katana into the soil
  // at point-blank range.  STAB_RANGE matches the worm mound radius +
  // a small grace, STAB_DMG is enough to one-shot a fresh worm in
  // about 3-4 strikes (worm hp 32, dmg 11) so a stealth kill is real
  // but not free, and STAB_CD_MS is a touch slower than the shuriken
  // tempo because each stab visually commits both arms.
  const NINJA_STAB_RANGE = 18;
  const NINJA_STAB_DMG   = 11;
  const NINJA_STAB_CD_MS = 720;
  const RUSTY_MUL      = 1.22;   // robot: penalty when not oiled in
                                 // a while
  const OIL_DECAY_MS   = 30000;  // last-oil window before rust kicks in
  // How long a hero must linger at a station before a single buff
  // tick lands, and how often a sustained stay can re-tick the
  // buff.  Together these stop a hero who's just walking past from
  // claiming the buff for free, and let an extended visit keep the
  // buff topped up.
  const BUFF_REFRESH_MS = 1200;
  // Training animation tuning.  TRAIN_RANGED_OFFSET is how far an
  // archer stands back from his practice target so he's actually
  // SHOOTING at it instead of poking it from arm's length.  The
  // animation timer flips the otherwise-still working sprite back
  // and forth at TRAIN_FRAME_MS so the hero visibly swings / draws
  // while training, instead of standing in a stupor while their
  // station does all the visual work.  TRAIN_THREAT_R suppresses
  // both the animation and the detour if anything dangerous is
  // close — when monsters are around, training is over.
  const TRAIN_RANGED_OFFSET    = 70;
  const TRAIN_FRAME_MS         = 220;
  const TRAIN_THREAT_R         = 90;
  // "Walking past my own station with no buff active" detour.
  // Throttled so heroes don't loop check it on every frame, and
  // they only commit if they aren't already mid-buff (a healthy
  // chunk of buff time still on the clock means they're freshly
  // trained — no point doing it again right now).
  const TRAIN_ERRAND_INTERVAL_MS = 2400;
  const TRAIN_BUFF_FRESH_MS      = 4000;
  // Cadence of the archer's visible practice arrow at the target.
  // Slow enough that the flight is readable, fast enough that the
  // bullseye actually accumulates arrows during a single visit.
  const TRAIN_SHOT_INTERVAL_MS   = 800;
  // Campfire AoE regen: anyone (hero, healer, alien on foot) within
  // CAMPFIRE_REGEN_R px of a burning campfire ticks +1 HP every
  // CAMPFIRE_REGEN_MS.
  const CAMPFIRE_REGEN_R   = 30;
  const CAMPFIRE_REGEN_MS  = 1500;
  const CAMPFIRE_REGEN_HP  = 1;
  // Zombie self-revive at his grave.
  //
  // Lore: the gravestone is the zombie's "home" — passive regen is
  // stronger here, AND if he actually goes down within the same
  // radius, the necromantic pull pieces him back together after a
  // beat without anybody else's help.  Mechanically:
  //
  //   • ZOMBIE_SELF_REVIVE_R   — death tile must be within this
  //     many pixels of his grave activity for the timer to arm.
  //     Lined up with GRAVE_REGEN_R + a small buffer so dying with
  //     "feet on the grave" qualifies.
  //   • ZOMBIE_SELF_REVIVE_DELAY_MS — quiet wait before the green
  //     pillar starts.  Long enough that a random nearby fighter
  //     can finish a hand-revive in the meantime if they want; if
  //     nobody bothers, he gets up on his own.
  //   • ZOMBIE_SELF_REVIVE_CAST_MS  — channel duration of the green
  //     pillar.  Slightly shorter than REVIVE_MS so it visually
  //     reads as "his own thing", not a stretched golden cast.
  //   • ZOMBIE_SELF_REVIVE_PREEMPT_R — exception window: a
  //     non-potion reviver standing within a couple of steps may
  //     still grab the body even though it's pending self-revive.
  //     Anything farther defers to the green pillar (they'd have
  //     to walk for whole seconds — pointless, the corpse will
  //     get up by itself before they arrive).
  const ZOMBIE_SELF_REVIVE_R         = 28;
  const ZOMBIE_SELF_REVIVE_DELAY_MS  = 7000;
  const ZOMBIE_SELF_REVIVE_CAST_MS   = 1600;
  const ZOMBIE_SELF_REVIVE_PREEMPT_R = 36;
  // Panic-flee override range for the zombie.  Within this many pixels
  // of his gravestone, a panic flee is hijacked into "die at home" —
  // engage the threat in place if there is one, otherwise just walk
  // back to the grave (the existing maybeEnterCombat tick will
  // re-engage along the way).  Reasoning: dying inside
  // ZOMBIE_SELF_REVIVE_R arms the green-pillar self-revive, which
  // restores him to full HP at his post in ~9 s; fleeing offstage
  // also restores full HP but burns the offstage timer AND drops his
  // post.  As long as the grave is reachable, the self-revive line
  // is the strictly better play.  The "hold" sub-radius is the
  // self-revive arming radius itself (plus a sprite buffer); anything
  // farther but still inside the walk-back radius walks back, gated
  // on safePathTo so we don't suicide-jog through a slime cluster.
  const ZOMBIE_GRAVE_HOLD_R          = ZOMBIE_SELF_REVIVE_R + 8;
  const ZOMBIE_GRAVE_WALK_BACK_R     = 110;

  // Zombie at his own gravestone regenerates faster (it's basically
  // his bedroom).
  const GRAVE_REGEN_R      = 22;
  const GRAVE_REGEN_MS     = 1100;
  const GRAVE_REGEN_HP     = 2;
  // Stuck arrows on the practice target rot off / get pulled out
  // every ARROW_DECAY_MS so the prop doesn't sit at the cap forever
  // after a busy practice session.  Slow enough that an active archer
  // (cd ~1.1s, halved by rapidFire) easily out-paces it during
  // practice, fast enough that a quiet stretch clears the bullseye
  // in under half a minute.
  const ARROW_DECAY_MS     = 3500;
  // Stump → campfire log chain.  The viking generates one billet
  // every CHOP_INTERVAL ms of station-time, capping at STUMP_LOG_CAP
  // visible logs.  Whenever the campfire's fuel timer drops below
  // CAMPFIRE_LOW_THRESH and a log is available on the stump, one
  // billet auto-flies into the fire (via Scene.feedCampfire).
  const CHOP_INTERVAL_MS = 4500;
  const STUMP_LOG_CAP    = 3;
  const CAMPFIRE_LOW_THRESH_MS = 18000;
  // Flower bloom production at the girl's patch.
  const BLOOM_GROW_MS    = 9000;
  const BLOOM_CAP        = 3;
  const FLOWER_PICK_HEAL = 22;
  // Throttle on the "wounded hero detours to the flower patch to
  // pluck a healing bloom" check so the AI doesn't recompute it
  // every frame.  Only fires on heroes already meaningfully hurt
  // (FLOWER_PICK_HP_FRACTION) so it stays a side beat, not a
  // dominant strategy.
  const FLOWER_PICK_INTERVAL_MS  = 4000;
  const FLOWER_PICK_HP_FRACTION  = 0.85;
  const FLOWER_PICK_PROB         = 0.35;
  const FLOWER_PICK_SAFETY_R     = 110;

  // Wounded heroes detour to the campfire to soak up its passive
  // regen tick.  Throttled so the AI doesn't replan every frame and
  // gated on safety so nobody jogs through a slime to cuddle the
  // fire.  Once arrived, the hero parks for WARM_DURATION_MS so the
  // 1 HP / 1.5 s tick (CAMPFIRE_REGEN_MS / _HP) actually adds up to
  // a meaningful top-off instead of just brushing past.  Zombie is
  // explicitly skipped — his regen station is the gravestone, see
  // REST_* below.
  const WARM_INTERVAL_MS    = 2800;
  const WARM_HP_FRACTION    = 0.85;
  const WARM_SAFETY_R       = 110;
  const WARM_DURATION_MS    = [8000, 14000];
  // Same idea for the zombie at his own gravestone — he's already
  // got a stronger passive regen there (GRAVE_REGEN_*), but we want
  // to actively send him home when he's hurt instead of relying on
  // the wander cycle to eventually loop him back.  Slightly higher
  // HP threshold so he's eager to rest at the slightest scratch.
  const REST_INTERVAL_MS    = 2400;
  const REST_HP_FRACTION    = 0.95;
  const REST_DURATION_MS    = [6000, 11000];
  // Firemage charge errand: when his "infused" buff is empty (or
  // about to lapse) and the lawn is calm, he should swing back to
  // his campfire to top up rather than wandering past it like an
  // empty matchstick.  Throttled so the AI doesn't replan every
  // frame, gated on safety so he doesn't jog through a slime to do
  // it, and parks for CHARGE_DURATION_MS on arrival so the buff
  // tick (BUFF_REFRESH_MS = 1.2 s) has time to land and stack
  // toward the INFUSED_MS ceiling.
  const CHARGE_INTERVAL_MS  = 3500;
  const CHARGE_LOW_REMAIN_MS = 4000;
  const CHARGE_SAFETY_R     = 110;
  const CHARGE_DURATION_MS  = [6000, 11000];

  // ---- girl's mount summon -----------------------------------------
  // Magical horse: the healer summons it for fast travel between heal
  // / revive jobs, or to flee a melee.  Designed as a clearly special
  // tool: long cooldown, short ride window, and rebalanced drive-by
  // healing while mounted so a galloping girl can't outright replace
  // her stationary work.
  //
  // HORSE_COOLDOWN_MS starts ticking the moment the horse finishes
  // dissolving — long enough that one full fight wave usually only
  // sees one ride.  HORSE_CANCEL_CD_MS is a forgiving short cooldown
  // for the case where the cast is interrupted by a hit OR the
  // approach times out before she actually gets in the saddle (in
  // either case the spell never *delivered*, so we don't punish
  // her with the full timer).  HORSE_CAST_MS is the brief stand-
  // still channel where the rearing horse silhouette grows over her
  // head.  HORSE_APPROACH_TIMEOUT_MS catches the edge case where
  // pathing somehow loses the horse (pond shenanigans, etc.) — set
  // generously so it only ever trips on a genuine stuck case, never
  // on a slow-but-progressing trot around the pond.  HORSE_RIDE_MS
  // is the *floor* on the time spent mounted; the actual ride window
  // is recomputed in mountUp from the live Scene.WIDTH so the gallop
  // covers ~70 % of the lawn on any canvas size (the original 11 s
  // tuning gave ~73 % on the 800 px default but only ~49 % on a
  // 1200 px canvas, so a long lawn would dismount her after about
  // half a screen).  The ride clock starts the instant mountUp runs
  // (NOT at cast or approach), so a long approach never eats into
  // the actual ride duration.  The two SPEED_MUL knobs are the only
  // place horse-vs-foot pacing lives.  HORSE_DISMOUNT_MS is the
  // dissolve animation length.
  const HORSE_COOLDOWN_MS         = 80000;
  const HORSE_CANCEL_CD_MS        = 8000;
  const HORSE_CAST_MS             = 700;
  const HORSE_APPROACH_TIMEOUT_MS = 9000;
  const HORSE_RIDE_MS             = 11000;
  const HORSE_APPROACH_SPEED_MUL  = 2.2;
  const HORSE_RIDE_SPEED_MUL      = 1.9;
  const HORSE_DISMOUNT_MS         = 250;
  // Trigger thresholds.  COMMUTE_MIN_DIST is "the heal target is far
  // enough that walking would burn most of my heal cooldown getting
  // there"; PANIC_FRAC + DANGER_R is the emergency-flee profile (low
  // HP and a monster within striking distance).  HEAL_RANGE_BAILOUT
  // is the dismount trigger when she's gotten close enough to a
  // wounded ally that the gallop served its purpose.
  // The horse is an emergency tool — fire it only for situations
  // where the gallop pays for itself.  Two scenarios qualify:
  //   "commute" — wounded ally on the far side of the lawn, healer
  //     has nothing else useful she can be doing right this second.
  //     The dist threshold is "still a real walk" (200 px ≈ a quarter
  //     of the 800 px lawn) — anything shorter and the summon-and-
  //     mount overhead eats most of the savings.  The HP gate is
  //     deliberately close to the actual heal trigger
  //     (GIRL_HEAL_TARGET_FRAC = 0.92): ANY meaningfully-wounded
  //     ally is enough.  An earlier 0.55 cap meant the trigger
  //     basically never fired — she heals everyone the moment they
  //     dip below 92 %, so by the time anyone bled down to 55 % she
  //     was already standing on top of them.  At 0.85 we still skip
  //     "patient is at 90 % and on the other side of the pond"
  //     summons (those resolve themselves in two foot steps) but
  //     pretty much every real "knight took two slime hits across
  //     the lawn" beat now qualifies for a gallop.
  //   "revive" — corpse exists at HORSE_REVIVE_MIN_DIST or further
  //     and the healer can revive (corpse and her are both alive).
  //     A revive every 80 s of cooldown is the main "high-value"
  //     trigger; we don't want her standing over a corpse waiting
  //     to walk to it.
  //   "panic" — a monster is right on top of her and she's not at
  //     full HP.  The previous gate (HP < 30%) read as "she only
  //     summons the horse once she's already half-dead" — by the
  //     time it fired she was usually mid-flee and missed the
  //     window.  Now any monster inside HORSE_PANIC_DANGER_R while
  //     she's below HORSE_PANIC_FRAC is enough; the 80 s cooldown
  //     still keeps this from being spammy.
  const HORSE_COMMUTE_MIN_DIST    = 200;
  const HORSE_COMMUTE_HP_FRAC     = 0.85;
  const HORSE_REVIVE_MIN_DIST     = 200;
  const HORSE_PANIC_FRAC          = 0.75;
  const HORSE_PANIC_DANGER_R      = 70;
  // Boss-fight HP threshold for the "boss" horse-summon reason.
  // Looser than HORSE_PANIC_FRAC because the gate doesn't require
  // a monster within 70 px (the boss is corner-camped) — the bar
  // here is "any meaningful chunk of her HP is gone, get out of
  // dodge before the next spit/bite finishes the job."
  const HORSE_BOSS_HP_FRAC        = 0.85;
  // Re-check cadence for the panic-summon hook bolted onto an
  // already-running flee/retreat.  maybeEnterCombat only fires while
  // combatMode is "none", so a healer who's *already* retreating
  // from an earlier scare would never re-arm the horse when a
  // fresh monster closes the gap.  The mid-flee hook below catches
  // that case at ~3 Hz, which is plenty for a panic decision.
  const HORSE_FLEE_RECHECK_MS     = 350;
  // Auto-dismount the moment a mounted girl spends this long with no
  // useful errand AND no movement target (combat mode "none", state
  // not "wandering", not currently galloping toward a goal).  The
  // mount-up path always seeds a wander destination so a fresh ride
  // never trips this in normal operation; the timer is purely a
  // safety net for state corruption (lost wander target on a busy
  // tick, etc.) and is generous enough that a brief stand-still
  // between two trot legs doesn't dissolve the horse out from under
  // her.  Without the seeded wander she'd dismount within a tick of
  // mounting if the situation that justified the cast resolved
  // mid-summon — the user-visible "horse appeared, girl mounted,
  // horse vanished" bug.
  const HORSE_IDLE_DISMOUNT_MS    = 5000;
  // Drive-by penalties: while mounted, holy rain casts slower and
  // heals less.  Tuned so the "I'm gallop-healing" beat is useful
  // but visibly less efficient than a static pour.
  const MOUNTED_HEAL_CD_MUL       = 1.4;
  const MOUNTED_HEAL_MUL          = 0.75;
  // Pixels the rider's foot Y sits above the horse's foot Y (~horse
  // saddle height as drawn).  Kept in one place so visuals + pickup
  // tests / aura placement agree.
  const HORSE_SADDLE_OFFSET       = 11;
  // Mounted rider sits slightly back on the horse's spine so the
  // animal's head pokes out forward of her body — without this shift
  // the rider's torso (~14 px wide) is centered over the saddle and
  // covers the head + mane that would otherwise be visible on the
  // facing side.  Sign flips with c.dir so she always sits "behind"
  // the head regardless of which way the horse is facing.
  const HORSE_RIDER_X_OFFSET      = 5;
  // She also sits a few pixels lower than the strict saddle anchor
  // so her butt actually touches the saddle pad instead of hovering
  // above it.  The visual result is the rider blending into the
  // horse's silhouette rather than perching on a pillar of air.
  const HORSE_RIDER_Y_DROP        = 2;
  // How close the trotting horse must get to its rider before she
  // mounts up (in px).  Loose so the mount latches even if both
  // wobble during the last frame of approach.
  const HORSE_MOUNT_R             = 8;
  // Spawn offset from the girl when the horse first materialises
  // (along the girl's facing axis).  Far enough that the gallop-in
  // is visually distinct, close enough that the horse usually
  // reaches her in well under HORSE_APPROACH_TIMEOUT_MS.
  const HORSE_SPAWN_OFFSET_X      = 90;

  // Healer decoy / "split" spell.
  //
  // Cast while the girl is escaping (retreating or full panic flee)
  // and a monster is closing on her — she spins in place for a
  // beat, drops a translucent twin where she stood, and continues
  // her escape.  The clone is a static dummy: it stands rooted to
  // the spot, has its own HP pool, and shows up in nearestHero(),
  // so any monster currently chasing the real girl re-targets the
  // closer "her" instead.
  //
  // Tuning intent:
  //   • DECOY_COOLDOWN_MS — long enough that the spell feels like a
  //     panic button, not a spammable shield.
  //   • DECOY_LIFETIME_MS — covers a typical 4-5 s sprint to safety
  //     before it puffs out.
  //   • DECOY_HP — a couple of bites' worth (most monsters land
  //     ~10-18 dmg per hit), so even a single melee that ignores
  //     the bait still wastes ~2 s on it.
  //   • DECOY_TRIGGER_R — only cast when there's an actual pursuer,
  //     not as a free buff every cooldown tick.
  //   • DECOY_CAST_MS — short spin freeze so the visual reads as
  //     "split-second misdirection" without crippling her flight.
  const DECOY_COOLDOWN_MS         = 16000;
  const DECOY_LIFETIME_MS         = 5000;
  const DECOY_CAST_MS             = 280;
  const DECOY_HP                  = 60;
  const DECOY_TRIGGER_R           = 130;
  const DECOY_FADE_MS             = 400;
  // Min cooldown re-stamp on a cancelled cast (e.g. she gets bitten
  // mid-spin) so she can retry sooner than the full lockout —
  // matches the cancel-vs-success split used by the horse summon.
  const DECOY_CANCEL_CD_MS        = 4000;

  // Per-character config.  `hp` is the max; `atk` describes the kind
  // of attack (melee or ranged) used by the hero AI.  `role` switches
  // between whole AI branches.
  const ROLES = {
    knight:   { role: "fighter", hp: 110, atk: { kind: "sword",    dmg: 14, range: 22,  cdMs:  900 } },
    archer:   { role: "fighter", hp:  72, atk: { kind: "arrow",    dmg: 10, range: 170, cdMs: 1100 } },
    witch:    { role: "fighter", hp:  68, atk: { kind: "hex",      dmg: 12, range: 130, cdMs: 1400 } },
    firemage: { role: "fighter", hp:  68, atk: { kind: "fireball", dmg: 16, range: 150, cdMs: 1500 } },
    viking:   { role: "fighter", hp: 110, atk: { kind: "axe",      dmg: 18, range: 24,  cdMs: 1100 } },
    zombie:   { role: "fighter", hp:  80, atk: { kind: "sword",    dmg: 10, range: 20,  cdMs:  800 } },
    // Robot: comfortably the toughest body on the lawn (150 vs the
    // knight/viking's 110) because the chassis is literally metal,
    // AND — unlike the meat fighters — he can't chug a heal potion
    // or warm up at the campfire to recover.  His only field-
    // recovery loops are the healer's holy rain and the grave-and-
    // revive cycle, so the bigger raw HP pool is what stands in for
    // "ability to take a long fight".  The oilcan still governs
    // *speed* (oiled vs rusty cdMul); HP is the durability axis.
    robot:    { role: "fighter", hp: 150, atk: { kind: "punch",    dmg: 16, range: 22,  cdMs:  650 } },
    ninja:    { role: "fighter", hp:  62, atk: { kind: "shuriken", dmg:  9, range: 120, cdMs:  650 } },
    girl:     { role: "healer",  hp:  58, atk: null },
    // Laser range deliberately wider than the generic 140 px aggro
    // radius: the alien parks his sprite up by his UFO at y≈70 while
    // monsters mill around at y≈200, so the vertical gap eats most
    // of the Euclidean reach.  A 140 px range left only ~70 px of
    // horizontal play — he'd jog the entire lawn to his saucer
    // without firing once because the closest goblin was always
    // 150-180 px diagonal.  220 px keeps the snipe useful while
    // pre-boarding (~180 px horizontal at the typical y-gap) and
    // doesn't affect the airborne beam (that uses its own 130 px
    // window at line ~6420 because the saucer hovers right above
    // its target).
    alien:    { role: "alien",   hp:  82, atk: { kind: "laser",    dmg: 13, range: 220, cdMs: 1100 } },
  };

  const list = [];
  // Live healer-decoy clones.  Independent of `list` because they
  // aren't real characters — they don't think, talk, eat potions,
  // or grow up to be heroes.  They DO get treated as targets by
  // monsters (see Characters.listDecoys + Monsters.nearestHero), so
  // the array is exposed below.  Lifecycle: pushed by spawnDecoy(),
  // marked `fadeStartAt` when killed/expired, spliced out of the
  // list once the fade finishes.
  const decoys = [];

  function rr(a, b) { return a + Math.random() * (b - a); }

  function offstageParkX() {
    const { w } = Sprites.size();
    return Math.random() < 0.5 ? -w * 3 : Scene.WIDTH + w * 3;
  }

  function create(name, activity) {
    const park = offstageParkX();
    const cfg = ROLES[name] ?? { role: "fighter", hp: 80, atk: null };
    return {
      name,
      activity,
      x: park,
      y: activity.y,
      tx: park,
      ty: activity.y,
      dir: park < 0 ? "r" : "l",
      frame: 0,
      frameTimer: 0,
      state: "offstage",
      stateUntil: 0,
      wandersLeft: 0,
      lastConvoAt: -Infinity,
      lastConvoPartner: null,
      lastConvoPartnerAt: -Infinity,
      lastStageExit: 0,
      partner: null,
      bubble: null,
      activeConvo: null,

      role: cfg.role,
      atk: cfg.atk,
      maxHp: cfg.hp,
      hp: cfg.hp,

      combatMode: "none",
      combatTarget: null,     // monster ref for fighters, char ref for healer
      combatUntil: 0,         // for timed sub-states (drinking, casting, ufoing)
      lastAttackAt: 0,
      lastHealAt: 0,
      lastDamagedAt: 0,       // most recent damage() hit, used by under-fire heuristics
      lastThreatCheck: 0,
      hitFlashUntil: 0,
      castFlashUntil: 0,
      // Brief "I just swung" timestamp.  Set by Combat.heroAttack
      // for melee fighters (sword / axe / punch).  drawOne reads
      // it to nudge the sprite forward in c.dir for ~120 ms so the
      // attacker visibly LUNGES into the strike instead of staying
      // glued to their walking pose while the FX plays in front.
      swingUntil: 0,

      // Ranged kiting (see tryKiteFromMonster).  kiteUntil is the
      // timestamp the current "back away while shooting" burst ends;
      // kiteDecideAt throttles re-evaluations between bursts so the
      // hero doesn't roll the dice every frame and stutter.
      kiteUntil: 0,
      kiteDecideAt: 0,

      // "Spinning around" stun: when a ranged hero needs to fire at
      // a target on the opposite side of their current facing, they
      // pivot first (`turnToFace`) and that pivot blocks both the
      // shot AND `moveStep` until this timestamp passes — so taking
      // a backwards target costs the hero a beat instead of being
      // a free 180° snap-shot.
      facingStunUntil: 0,

      // "Help!" call: when a hero is being mauled and either has no
      // attack of their own (the girl) or is already low on HP, they
      // shout for help and any nearby idle fighter who hears them
      // (HELP_RADIUS) drops what they're doing and rushes over.
      // helpRequestUntil is the timestamp the open call expires at;
      // helpAttacker remembers the monster we want responders to
      // jump on; lastHelpCallAt rate-limits the bark/cooldown so a
      // single hero doesn't spam the lawn with screaming every tick.
      helpRequestUntil: 0,
      helpAttacker: null,
      lastHelpCallAt: 0,

      // Cw/ccw direction the character is currently committed to
      // walking around the pond.  Set by Scene.avoidPondStep on the
      // first blocked frame and cleared as soon as a straight or
      // axis-aligned step succeeds; keeps the detour from oscillating
      // when the goal is roughly straight across the water.
      pondDetourDir: 0,

      // Potion logistics.  `heldPotion` is a tiny object with a `kind`
      // tag ("drink" when the character just grabbed one from the
      // chest, "deliver" when the witch is carrying a fresh brew over
      // to be stocked); it's drawn as a little bottle bobbing above
      // the head while non-null.  `drinkPhase` / `depositPhase` are
      // the sub-phase machines for the chest interactions — see
      // tickDrinking / tickDepositing below.
      heldPotion: null,
      drinkPhase: null,
      depositPhase: null,
      // Spare revive bottle: a non-reviver who runs the chest drink
      // ritual takes a revive bottle along with the heal (when stock
      // permits) and keeps it on their belt.  If they die later, the
      // bottle drops onto the lawn for the next non-reviver to pick
      // up; if they're still walking around when an ally falls, they
      // skip the chest fetch and use the spare on the corpse directly.
      // Boolean — we don't model spare stacks, one bottle per carrier.
      spareRevive: false,
      // Ground-pickup target: the dropped bottle this hero is
      // currently walking toward, set by startPickupPotion and
      // released by exitCombat / startDying.  Reservation keeps two
      // wounded heroes from sprinting at the same lone bottle.
      targetGroundPotion: null,
      // Hand-off detour: when the witch is mid-deposit and spots a
      // wounded ally close to her route she can peel off and give the
      // bottle directly instead of stocking the chest.  `deliverTarget`
      // is the recipient she's walking toward; `deliverPhase` threads
      // approach -> give -> return; `handoffCheckAt` throttles the
      // periodic scan in tickDepositing.
      deliverTarget: null,
      deliverPhase: null,
      handoffCheckAt: 0,

      // Death & revive bookkeeping.  `deathAt` is the timestamp the
      // character collapsed (0 while alive); the grave marker we paint
      // in place uses it for a small settling animation.  `revivePhase`
      // is the sub-state for the reviver walking up and channelling.
      deathAt: 0,
      revivePhase: null,

      // Witch brewing progress at the cauldron.  brewAccum ticks up
      // while she stands at her station; once it hits BREW_MS the
      // brew finishes and brewReady flips to true.  She then either
      // walks the bottle to the chest (kiosk needs the kind, or the
      // carry-around timer ran out) or just keeps it on her belt for
      // an opportunistic self-drink / hand-off — see the maybeEnter‑
      // Combat witch branches.  brewKind is decided at the moment
      // the brew completes (see tickWitchBrew) and decides whether
      // the bottle she's holding is a heal or a revive.  brewedAt
      // timestamps the completion so the carry-timeout deposit
      // fallback can fire.
      brewAccum: 0,
      brewReady: false,
      brewKind: "heal",
      brewedAt: 0,

      // ---- station buffs ------------------------------------------
      // Damage / cooldown / heal-amount multipliers applied to the
      // base atk numbers and to outgoing heals.  Recomputed every
      // frame in tickStations from `workBuffKind` / `workBuffUntil`
      // and (for the robot) `lastOilAt`.  Defaults are a no-op 1×.
      dmgMul: 1,
      cdMul: 1,
      healMul: 1,
      // Active "I just trained at my station" buff, if any.  The
      // kind is just a tag for the visual aura ("atkBoost" /
      // "rapidFire" / "oiled" / "healPower"); the actual numbers
      // live in dmgMul / cdMul / healMul above.
      workBuffKind: null,
      workBuffUntil: 0,
      // Boss-fight war-cry pulse: set by HydraPlan.fireWarCry at the
      // moment the rally phase transitions to engage, decays naturally
      // via recomputeStationMuls.  Stacks multiplicatively with any
      // station buff already on the clock.
      warCryUntil: 0,
      // The last time `tickStations` granted (or refreshed) a buff
      // tick at any station — used to throttle further ticks while
      // the hero lingers in place.
      lastBuffTickAt: 0,
      // Robot oil bookkeeping.  `lastOilAt` is the last time he
      // visited the oilcan; if it falls more than OIL_DECAY_MS
      // behind, his cdMul flips to RUSTY_MUL until he tops up.
      lastOilAt: 0,
      // Throttles for station side-effects (chops, blooms, regen
      // ticks).  Each tick is gated by its own "last X at" so the
      // pacing is steady regardless of frame rate.
      lastChopAt: 0,
      lastBloomAt: 0,
      lastRegenAt: 0,
      lastGraveRegenAt: 0,
      // "I'm walking to the flower patch to pluck a heal" detour
      // flag set in maybeFlowerErrand and consumed in arrivedAt.
      flowerErrand: false,
      flowerErrandCheckAt: 0,
      // "I'm detouring to my own training station for a buff
      // top-up" flag, set in maybeTrainErrand and consumed when
      // the hero arrives at the training spot (then the working
      // state machine takes over for STAY_AT_ITEM_MS).
      trainErrand: false,
      trainErrandCheckAt: 0,
      lastTrainShotAt: 0,
      // "I'm wounded, the lawn is calm — let me park by the fire
      // and tick HP back up."  Set in maybeWarmAtFire, consumed in
      // arrivedAt by switching into a long working stay so the
      // standard regen tick (in tickStations) can do its thing.
      // Skipped for the zombie — he uses restErrand (his grave) for
      // the same purpose with the faster tick.
      warmErrand: false,
      warmErrandCheckAt: 0,
      restErrand: false,
      restErrandCheckAt: 0,
      // Firemage equivalent of warmErrand: detour back to his own
      // campfire to top up the "infused" buff before it lapses.
      // Distinct from warmErrand because it's about charging the
      // outgoing-damage buff, not regen, so it fires at full HP too.
      chargeErrand: false,
      chargeErrandCheckAt: 0,
      // Firemage's separate cooldown for the rain-of-fire AoE.  The
      // single-target fireball still ticks off `lastAttackAt` /
      // effectiveCd; the AoE has its own (longer) timer so the two
      // spells interleave instead of fighting each other for the
      // same cooldown slot.
      lastAoeAt: 0,

      // Girl's summonable horse mount.  Only the girl ever populates
      // these but every character carries them so the rest of the
      // engine can read them uniformly without a name guard.
      //   horseCooldownUntil  — `now`-stamped lockout; while non-zero
      //                         and in the future, no new summon.
      //   horseEntity         — the live horse object (see
      //                         summonHorse() for the full shape) or
      //                         null when no horse exists.
      //   mounted             — true while the rider is sitting on
      //                         a fully-fledged horse (post-approach,
      //                         pre-dismount).  When true, drawOne
      //                         stacks the rider on top of the horse
      //                         and movement uses the mounted speed.
      //   mountedUntil        — `now`-stamped expiry of the ride
      //                         window; auto-triggers a dismount.
      //   horseSummonAt       — `now`-stamped start of the cast; lets
      //                         the cast aura draw a growing animation
      //                         and the cancel-on-hit branch clamp to
      //                         the short cancel cooldown.
      horseCooldownUntil: 0,
      horseEntity: null,
      mounted: false,
      mountedUntil: 0,
      horseSummonAt: 0,
      // mountedBusyAt is restamped every tick the rider is doing
      // something (any combatMode != "none"); the idle-dismount
      // safety net checks `now - mountedBusyAt` to spot a mounted
      // girl who has been sitting in "none" too long.
      mountedBusyAt: 0,
      // Throttle stamp for the mid-flee horse-summon recheck (see
      // HORSE_FLEE_RECHECK_MS).  Lazily initialised in tickFleeing /
      // tickRetreating so other roles never bother touching it.
      _horsePanicCheckAt: 0,
      // Panic-flee refuge: when startFleeing finds a safer / closer
      // destination than the screen edge — the alien's parked saucer
      // for himself, or a safe healer / reviver-capable ally for
      // everyone else — it stashes the plan here and tickFleeing
      // routes us to that instead of off-stage.  Shape:
      //   { kind: "ufo" | "ally", x, y, ref?: ally character,
      //     edgeX, edgeY,        // fallback edge destination
      //     checkAt: timestamp } // throttle for validity rechecks
      // Cleared by exitCombat and on any refuge invalidation
      // (path no longer safe, ally died/fled, etc.) — at which
      // point tickFleeing falls back to the original edge route.
      fleeRefuge: null,
      // Throttle stamp for the drive-by passing-heal scan that
      // tickReviving / tickRideToCorpse use to scoop up a wounded
      // ally on the way to a corpse.  Lazy-initialised by the hook.
      _passingHealCheckAt: 0,
      // Healer decoy / "split" spell.  Like the horse fields above,
      // these live on every character so the engine can poll them
      // without a name guard, but only the girl ever sets them to
      // anything meaningful.  See the DECOY_* constants block for
      // the spec.
      //   decoyCooldownUntil — `now`-stamped lockout; while non-zero
      //                        and in the future, can't cast.
      //   decoyCastUntil     — `now`-stamped end of the spin freeze;
      //                        non-zero means "currently mid-cast".
      //   decoyActive        — ref to the live clone (in `decoys`)
      //                        or null when no clone is on stage.
      decoyCooldownUntil: 0,
      decoyCastUntil: 0,
      decoyActive: null,
      // Zombie-only "self-revive at the grave" bookkeeping.  Like
      // the other role-specific fields we keep them on every
      // character so the engine can read them uniformly without a
      // name guard.
      //   selfReviveAt        — `now`-stamped moment the green
      //                         pillar should kick in (0 = no
      //                         pending self-revive, e.g. died too
      //                         far from the grave or already
      //                         resurrected).
      //   selfReviveCastUntil — non-zero while the channel is
      //                         actually playing; the corpse is
      //                         immune to nearestDeadAlly during
      //                         this whole window too (no point
      //                         walking up to a body that's about
      //                         to get up on its own in a beat).
      selfReviveAt: 0,
      selfReviveCastUntil: 0,

      // ---- social deals ------------------------------------------
      // Filled in by the Deals module (defined further down).  Live
      // on every character so the rest of the engine can poll them
      // without a name guard, but only become non-default once a
      // chat actually settles a deal.
      //
      //   pact          — { partner, until, kind } when this hero is
      //                   currently in an ambush pact with another;
      //                   biases buddy lookups in maybeEnterCombat
      //                   and waives the melee HP gate when answering
      //                   the partner's "Help!" call.
      //   moraleUntil   — `now`-stamped expiry of the +10% dmg /
      //                   +10% heal "morale" bonus folded in by
      //                   recomputeStationMuls.  Granted by
      //                   moralePact and (briefly) by restRound.
      //   lookoutUntil  — `now`-stamped expiry of the council's
      //                   +15% dmg "lookout" bonus.  Set by
      //                   Director's elected lookout vote.
      //   _swapShift    — true while walking to a peer's station for
      //                   a swapShift deal; consumed by arrivedAt to
      //                   lock in a "working" stay at someone else's
      //                   workspace without having to swap c.activity
      //                   itself (which would tangle a dozen other
      //                   bookkeeping paths).
      //   lastDealAt    — last time this hero sealed (or refused) a
      //                   deal; throttle for the per-chat picker so
      //                   a hero who just made a deal isn't offered
      //                   another two chats later.
      pact: null,
      moraleUntil: 0,
      lookoutUntil: 0,
      _swapShift: false,
      lastDealAt: 0,

      // ---- new ability bookkeeping --------------------------------
      // All of these are role-specific but live on every character so
      // the engine can read them uniformly without a name guard.
      // Each ability stamps an "until" timestamp that the relevant
      // ticker (tickFighting / Combat.heroAttack / damage) checks.
      //
      //   tauntUntil          — Knight: while non-zero+future, nearby
      //                         monsters reroll target through bestHero‑
      //                         For with the knight scored as a decoy.
      //   tauntCdUntil        — cooldown lockout for the next taunt.
      //   blockUntil          — Knight (and Alien shieldBeam recipient):
      //                         while non-zero+future, incoming damage
      //                         is multiplied by (1 - blockDR).
      //   blockDR             — current damage-reduction fraction (0..1).
      //   blockCdUntil        — Knight's own block cooldown.
      //   shieldUntil         — Alien-applied shield expiry on a buddy.
      //   berserkUntil        — Viking: while non-zero+future, dmgMul
      //                         and DR are boosted in recomputeStation‑
      //                         Muls / damage().
      //   berserkCdUntil      — Viking's berserk cooldown.
      //   smokeUntil          — Ninja: invisible to monster targeting.
      //   smokeCdUntil        — Ninja's smoke-bomb cooldown.
      //   aimedReadyAt        — Archer: timestamp at which a stationary
      //                         shooter qualifies for the +50% bonus.
      //   aimedConsumeNext    — true if the very next bow shot fires
      //                         the bonus (cleared on shoot).
      //   slowedUntil         — Witch hex (and any future slow source):
      //                         monster moveStep multiplies speed×0.7
      //                         while non-zero+future.
      //   emberStacks         — Firemage: 0..5 stacks, each adds +emb
      //                         dmg to next fireball.  Reset on rain.
      //   meteorWarnedAt      — last firemage rain-of-fire warning
      //                         broadcast for the current cast.
      //   repairCharges       — Robot: number of repair-kit potions
      //                         currently carried (0/1 in practice).
      //   _liteHpAtKill       — book-keeping for Zombie soul-drag (last
      //                         ally corpse ref the zombie is towing).
      lastRumorShoutAt:    0,   // Ninja worm-alert rate-limit
      tauntUntil:          0,
      tauntCdUntil:        0,
      blockUntil:          0,
      blockDR:             0,
      blockCdUntil:        0,
      shieldUntil:         0,
      berserkUntil:        0,
      berserkCdUntil:      0,
      smokeUntil:          0,
      smokeCdUntil:        0,
      aimedReadyAt:        0,
      aimedConsumeNext:    false,
      slowedUntil:         0,
      emberStacks:         0,
      meteorWarnedAt:      0,
      repairCharges:       0,
      shieldCdUntil:       0,
      lastDamagedSelfAt:   0,    // mirror of lastDamagedAt for ability gating
      // ---- elemental debuffs from hydra heads -----------------
      // burn  (fire bite):    ticks dmg over time
      burnUntil:           0,
      burnDps:             0,    // dmg per second while burnUntil > now
      // vulnerable (acid bite/spit):  incoming dmg multiplied
      vulnerableUntil:     0,
      vulnerableMul:       1.0,  // e.g. 1.25 = +25% incoming
      // chill (ice spit):  reduces hero movement speed
      chillUntil:          0,
      chillMul:            1.0,  // speed multiplier while chilled (e.g. 0.55)
      // poison (poison bite/spit):  stacking DoT
      poisonStacks:        0,    // 0-3, each adds poisonDpsPerStack / s
      poisonStackExpiry:   [],   // array of expiry timestamps, one per stack
      // root (lightning bite): brief complete movement freeze
      rootUntil:           0,
      // lastDebuffTickAt: used to pace the per-frame DoT application
      lastDebuffTickAt:    0,
    };
  }

  function init(activities) {
    for (const name of Sprites.NAMES) {
      // Share the activity object with Scene so rendering reads the
      // same live object we mutate at runtime (e.g. UFO lift / flight
      // offsets / "pilot is onboard" flags).  Previously this was a
      // shallow copy, which silently ignored any state flipped on the
      // original Scene.ACTIVITIES entry.
      list.push(create(name, activities[name]));
    }
  }

  function reassignActivities(activities) {
    for (const c of list) {
      const a = activities[c.name];
      if (!a) continue;
      c.activity = a;
      if (c.state === "entering" || c.state === "working") {
        setTarget(c, c.activity.x, c.activity.y);
      } else if (c.state === "wandering") {
        const [nx, ny] = randomLawnPoint(c);
        setTarget(c, nx, ny);
      }
    }
  }

  function setTarget(c, x, y) { c.tx = x; c.ty = y; }

  // Stations a wandering hero might idly drift toward to pick up a
  // shared-station buff — the dwarf wandering past the dummy gets a
  // free atkBoost without having to plan an "errand" for it.
  const SHARED_DRIFT_STATIONS = {
    knight:   ["viking"],          // dummy can host viking
    archer:   ["firemage", "ninja", "witch"],   // target practice
    viking:   ["knight"],          // stump can host knight
  };
  // Per-wander chance (~1 in 6) that the next wander goal is a
  // peer's station instead of a random nearby patch.  Low enough
  // that visits feel organic, not relentless.
  const SHARED_DRIFT_PROB = 0.18;

  function randomLawnPoint(c) {
    // Occasionally drift toward a peer station that grants this
    // character a buff, so cross-station perks (knight at the stump,
    // archer-target rapid-fire for the firemage / witch / ninja,
    // etc.) actually occur in normal play instead of only when the
    // RNG happens to drop a wander point on top of the right tile.
    if (c.combatMode === "none" && Math.random() < SHARED_DRIFT_PROB) {
      for (const ownerName of Object.keys(SHARED_DRIFT_STATIONS)) {
        const visitors = SHARED_DRIFT_STATIONS[ownerName];
        if (!visitors.includes(c.name)) continue;
        const station = Scene.activity(ownerName);
        if (!station) continue;
        if (Scene.isInPond(station.x, station.y, 6)) continue;
        const sx = station.x + (Math.random() - 0.5) * 8;
        const sy = station.y + (Math.random() - 0.5) * 6;
        return [sx, sy];
      }
    }
    // Pick a point near the character's activity station, then reject
    // any that land in the pond (with a little extra margin — we want
    // the goal firmly on dry ground, not on the waterline).  For
    // non-fighters we additionally reject any candidate that sits
    // close to a monster OR that would take us through a monster on
    // the way there: the girl picking a wander goal on the far side
    // of a slime would just walk through it on her way and die.
    const safetyRequired = nonFighter(c);
    for (let tries = 0; tries < 8; tries++) {
      const cx = c.activity.x + rr(-140, 140);
      const cy = c.activity.y + rr(-40, 40);
      const x = Math.max(30, Math.min(Scene.WIDTH - 30, cx));
      const y = Math.max(Scene.FLOOR_TOP + 10, Math.min(Scene.FLOOR_BOTTOM - 10, cy));
      if (Scene.isInPond(x, y, 6)) continue;
      if (Scene.isInCave && Scene.isInCave(x, y, 8)) continue;
      if (safetyRequired && !safePathTo(c, x, y)) continue;
      if (graveBlocks(c, x, y)) continue;
      if (fireBlocks(c, x, y)) continue;
      if (caveBlocks(c, x, y)) continue;
      return [x, y];
    }
    // Fallback: head back to the activity station, but only if going
    // there isn't itself unsafe.  If the activity is also crawling
    // with monsters the girl just stays put — better to do nothing
    // than to march into a brawl on the way home.  (Her own activity
    // tile is the flower patch, which is well outside GRAVE_AVOID_R,
    // so the grave check there is a no-op in practice.)
    if (safetyRequired && !safePathTo(c, c.activity.x, c.activity.y)) {
      return [c.x, c.y];
    }
    return [c.activity.x, c.activity.y];
  }

  function isOnStage(c) {
    // Dead heroes are still visible (the tombstone is there) but they
    // don't take up an active-hero slot as far as the Director is
    // concerned — otherwise corpses piling up would starve reviver
    // spawns and the monsters would stop coming.
    if (c.state === "offstage") return false;
    if (c.combatMode === "dead") return false;
    if (c.hp <= 0 && c.ufoCrashAnim) return false;
    return true;
  }

  function isVisibleNow(c) {
    if (c.state === "offstage") return false;
    // While walking TO the UFO the alien is still a pedestrian and we
    // draw the regular sprite; once boarded (`c.boarded` is flipped on
    // at lift-off) the saucer itself carries him, so we hide the walking
    // sprite and Scene.drawUfo paints the pilot inside the dome.
    if (c.combatMode === "ufoing" && c.boarded) return false;
    const { w } = Sprites.size();
    return c.x > -w && c.x < Scene.WIDTH + w;
  }

  function startEnter(c) {
    const { w } = Sprites.size();
    const fromLeft = c.activity.x < Scene.WIDTH / 2;
    c.x = fromLeft ? -w - 2 : Scene.WIDTH + w + 2;
    c.y = c.activity.y + rr(-30, 30);
    c.dir = fromLeft ? "r" : "l";
    c.state = "entering";
    c.hp = c.maxHp;
    c.combatMode = "none";
    c.combatTarget = null;
    // A fresh-on-stage robot is presumed freshly oiled — start his
    // oil-charge meter full and let it visibly drain so the player
    // sees the mechanic from the first moment instead of staring at
    // an empty (rusty-looking) bar until his first oilcan visit.
    if (c.name === "robot") {
      c.lastOilAt = performance.now();
    }
    const tp = trainingPos(c) || { x: c.activity.x, y: c.activity.y };
    setTarget(c, tp.x, tp.y);
  }

  function startLeave(c) {
    // Witch stays at her post for the whole boss window — brewing
    // and healing are more valuable than a lunch break.
    if (c.name === "witch" && HydraPlan.active()) {
      c.state = "working";
      c.stateUntil = performance.now() + 12000;
      if (c.activity) setTarget(c, c.activity.x, c.activity.y);
      return;
    }
    const { w } = Sprites.size();
    // Same density-aware exit picker the panic flee uses: a hero
    // calmly "going off to lunch" still shouldn't pick the edge
    // that requires walking through two slimes when the other side
    // has a clear corridor.  pickExitEdge scores both edges by
    // (1) blocker count on the corridor, (2) distance to first
    // blocker, (3) aggregated away-vector, then applies the
    // grave / hydra path-cross vetoes.  Falls back to the lawn-
    // half heuristic only when there are no monsters around (the
    // common peacetime case), so non-combat behaviour is unchanged.
    const { goLeft } = pickExitEdge(c);
    setTarget(c, goLeft ? -w - 4 : Scene.WIDTH + w + 4,
                 c.y + rr(-20, 20));
  }

  function startTalking(a, b) {
    a.state = "talking";
    b.state = "talking";
    a.partner = b;
    b.partner = a;
    const now = performance.now();
    a.lastConvoAt = now;
    b.lastConvoAt = now;
    a.dir = (b.x >= a.x) ? "r" : "l";
    b.dir = (a.x >= b.x) ? "r" : "l";
    // Decide right at chat start whether this exchange carries a
    // deal.  Deciding here (rather than mid-script) lets us thread
    // the "yes/no" branch into Dialog.beginDeal so the curated
    // proposal/response lines line up with the eventual side-effect.
    // Refusal is a coin-flip on top of feasibility so the lawn
    // doesn't read as a string of unconditional "yes" handshakes;
    // friends with high affinity refuse less often.
    const kind = pickDealFor(a, b, now);
    if (kind && Dialog.beginDeal) {
      const aff = getAffinity(a, b);
      const acceptChance = Math.max(0.5, Math.min(0.95, 0.78 + 0.04 * aff));
      const accepted = Math.random() < acceptChance;
      Dialog.beginDeal(a, b, kind, accepted, {
        onAccept: () => applyDeal(a, b, kind),
        onRefuse: () => refuseDeal(a, b, kind),
      });
      return;
    }
    Dialog.begin(a, b);
  }

  // Politely break off a conversation because something more urgent
  // came up: low HP, a corpse on the lawn, an open help call, an
  // ally who's about to bleed out.  Mirrors the cancel-and-reset
  // path that `applyDamage` runs when a hero gets hit mid-chat —
  // both partners drop back into "wandering" so the next tick re-
  // evaluates each one independently (the partner often has nothing
  // urgent and just goes back to small-talk later).  Optionally
  // schedules an apology bark a beat after the cancel so the U-turn
  // reads as an excuse-me beat ("Sorry — gotta dash!") rather than
  // a silent teleport away from the conversation.  The bark is
  // delayed past the showBubble() fade-out (~200 ms) because
  // Dialog.bark() suppresses one-shots while the character's chat
  // bubble is still on screen.
  function excuseFromConvo(c, barkKind) {
    if (c.state !== "talking") return;
    const p = c.partner;
    Dialog.cancel(c);
    c.state = "wandering";
    c.partner = null;
    c.activeConvo = null;
    if (p) {
      p.partner = null;
      p.state = "wandering";
      p.activeConvo = null;
    }
    if (barkKind) {
      setTimeout(() => Dialog.bark(c, barkKind, { force: true }), 350);
    }
  }

  function endTalking(c) {
    if (c.state !== "talking") return;
    const p = c.partner;
    c.partner = null;
    const now = performance.now();
    // Remember each other so we don't immediately restart the same
    // conversation; this is what used to turn two stationary heroes
    // into an infinite hello/goodbye loop.
    if (p) {
      c.lastConvoPartner = p;
      c.lastConvoPartnerAt = now;
      p.lastConvoPartner = c;
      p.lastConvoPartnerAt = now;
    }
    c.state = "wandering";
    c.wandersLeft = 1;
    c.stateUntil = now + rr(...WANDER_STEP_MS);
    // Walk clearly away from the partner instead of a random point
    // that might land us straight back on top of them.
    walkAwayFrom(c, p);
    if (p) {
      p.partner = null;
      p.state = "wandering";
      p.wandersLeft = 1;
      p.stateUntil = now + rr(...WANDER_STEP_MS);
      walkAwayFrom(p, c);
    }
  }

  function walkAwayFrom(c, other) {
    // Pick a lawn point at least 80 px from `other`, preferring the
    // direction c already faces away from them.
    const minGap = 80;
    for (let tries = 0; tries < 6; tries++) {
      const [nx, ny] = randomLawnPoint(c);
      if (!other || Math.hypot(nx - other.x, ny - other.y) >= minGap) {
        setTarget(c, nx, ny);
        return;
      }
    }
    // Fallback: head toward the opposite horizontal edge.
    const goLeft = other ? other.x > c.x : Math.random() < 0.5;
    const tx = goLeft
      ? Math.max(40, c.x - 120)
      : Math.min(Scene.WIDTH - 40, c.x + 120);
    setTarget(c, tx, Math.max(Scene.FLOOR_TOP + 12,
                              Math.min(Scene.FLOOR_BOTTOM - 10,
                                       c.y + rr(-20, 20))));
  }

  // ----- relationships & deals ---------------------------------------
  //
  // Two heroes who chat enough start to add up an "affinity" score
  // that nudges later social behaviour: better friends offer each
  // other more deals, slip into a calmer chat tone, and waive the
  // usual melee-HP gate when answering each other's "Help!" calls.
  // The score is intentionally tiny — a single number per ordered
  // pair, decayed gently over real time — because the Markov small-
  // talk has no opinions of its own and everything we layer on top
  // has to stay legible.
  //
  // Deals are the only place in the codebase that actually changes
  // anyone's state from a chat.  A successful chat picks one of a
  // small set of curated proposals (share a spare revive bottle,
  // mutual morale buff, head to the campfire together, swap shifts
  // for one work cycle, an ambush pact for the next wave, or just
  // rumour-sharing that nudges the scene's tone toward "tense").
  // Feasibility is gated on real state (does A actually have a
  // spare bottle? is the campfire burning? do these two roles share
  // a swap-compatible station?) so the offered deals make sense in
  // the current frame; refusals happen too, but they're a coin-flip
  // on top of feasibility, not a separate negotiation tree.
  const AFFINITY_DECAY_PER_MIN = 0.5;
  const AFFINITY_MAX = 5;
  const AFFINITY_MIN = -3;
  const affinity = new Map();   // pair-key -> { score, stampedAt }
  function pairKey(a, b) {
    return (a.name < b.name) ? (a.name + "|" + b.name) : (b.name + "|" + a.name);
  }
  function decayedAffinity(rec, now) {
    if (!rec) return 0;
    const dtMin = Math.max(0, (now - rec.stampedAt) / 60000);
    const sign = rec.score >= 0 ? 1 : -1;
    const drained = Math.max(0, Math.abs(rec.score) - AFFINITY_DECAY_PER_MIN * dtMin);
    return sign * drained;
  }
  function getAffinity(a, b) {
    const rec = affinity.get(pairKey(a, b));
    return decayedAffinity(rec, performance.now());
  }
  function bumpAffinity(a, b, delta) {
    const now = performance.now();
    const key = pairKey(a, b);
    const cur = decayedAffinity(affinity.get(key), now);
    const next = Math.max(AFFINITY_MIN, Math.min(AFFINITY_MAX, cur + delta));
    affinity.set(key, { score: next, stampedAt: now });
    return next;
  }

  // Per-hero throttle on "you just settled a deal, you don't need
  // another one for a beat".  Long enough that two heroes who chat
  // again in 30 s after a deal just trade Markov small-talk like
  // any other pair.
  const DEAL_PER_HERO_COOLDOWN_MS = 28000;
  // Mutual buffs handed out by moralePact and (at 60 % strength) by
  // restRound; same magnitude either way, only the duration differs.
  const MORALE_DURATION_MS = 25000;
  const MORALE_DMG_MUL  = 1.10;
  const MORALE_HEAL_MUL = 1.10;
  // Ambush-pact buddy-up window.  After it lapses we let the pact
  // age out; nothing forcibly cleans it up because maybeEnterCombat
  // already gates on `c.pact && c.pact.until > now`.
  const PACT_DURATION_MS = 22000;
  // Council "lookout" badge bestowed on the highest-HP attendee.
  // Same shape as a station buff (modifies dmgMul) but lives on its
  // own field so it can stack with whatever station buff the
  // lookout already had.
  const LOOKOUT_DURATION_MS = 30000;
  const LOOKOUT_DMG_MUL = 1.15;

  // ---- new ability tuning -----------------------------------------
  // Knight active taunt: short rallying yell that drags monster aggro
  // toward him for a beat.  Cooldown is intentionally chunky — taunt
  // is meant to be used at decision points (healer is being chewed
  // on, two monsters are stacking on the alien) and not spammed.
  const TAUNT_DURATION_MS  = 2200;
  const TAUNT_COOLDOWN_MS  = 14000;
  const TAUNT_RANGE        = 90;
  // Knight block stance: brief 50% damage reduction.  Triggered when
  // surrounded or focused.  Cooldown shortened from the original
  // 9 s → 6.5 s after playtest: at the old number the knight's
  // defensive uptime was a flat 22 % (2000/9000), which barely
  // moved the needle on long fights where the front line is
  // soaking continuous pressure (boss bites, gnoll waves).  6500
  // pushes uptime to ~31 % without making block "always on".
  const BLOCK_DURATION_MS  = 2000;
  const BLOCK_COOLDOWN_MS  = 6500;
  const BLOCK_DR           = 0.5;
  // Heavy-fighter passive armor.  knight / viking (110 HP melee
  // frontline) and robot (150 HP chassis) are conceptually "tanks"
  // — they're supposed to soak hits the rest of the team can't.
  // Without a baseline DR they survive long fights only on raw HP,
  // which means every swing on them lands at the same per-point
  // efficiency as on a 62-HP ninja.  The armor slot uses the same
  // "highest DR wins" rule as block / shield / berserk, so it does
  // NOT stack on top of an active button (a knight in block stance
  // still takes 50 % off, not 50 % then 15 %), but it guarantees
  // there's never a *zero-mitigation* hit on the frontline — and
  // for the robot (no active DR button at all) it's the only
  // source of mitigation he ever sees.
  const ARMOR_DR           = 0.15;
  function hasArmor(c) {
    return c && (c.name === "knight" || c.name === "viking" || c.name === "robot");
  }
  // Viking berserk: a flat damage / DR boost when low.  Threshold
  // lifted from the original 0.35 → 0.50 so the panic button fires
  // *before* he's one hit from death.  At 0.35 the typical sequence
  // was "viking takes a chunk, eats one more, drops to 30 %, pops
  // berserk, dies on the next swing anyway"; 0.50 buys him an
  // actual berserk window in which to land hits.
  const BERSERK_HP_FRAC    = 0.50;
  const BERSERK_DURATION_MS= 8000;
  const BERSERK_COOLDOWN_MS= 30000;
  const BERSERK_DMG_MUL    = 1.8;
  const BERSERK_DR         = 0.3;
  // Robot repair-kit potion: a chunky self-heal he can drink instead
  // of fleeing when oilcan / chest carry one.
  const REPAIR_HEAL        = 60;
  const REPAIR_HP_FRAC     = 0.5;
  // Witch hex slow on monsters.  SLOW_MUL is applied to monster speed
  // by Monsters.tick.
  const HEX_SLOW_MS        = 2500;
  const HEX_SLOW_MUL       = 0.7;
  // Brewed-buff potion: 10% chance per brew cycle, bumps cd ×0.85
  // for the drinker.
  const BREWED_BUFF_CHANCE = 0.10;
  const BREWED_BUFF_CD_MUL = 0.85;
  const BREWED_BUFF_MS     = 10000;
  // Firemage ember stacks (kill -> +1 stack, max 5; reset on rain).
  const EMBER_MAX          = 5;
  const EMBER_BONUS_PER    = 2;
  // Archer aimed shot: stationary for AIMED_DELAY_MS arms a +50%
  // damage next-shot bonus.  Cleared on movement OR on shoot.
  const AIMED_DELAY_MS     = 1500;
  const AIMED_DMG_MUL      = 1.5;
  // Ninja smoke bomb: brief invisible window + small aggro reset.
  const SMOKE_DURATION_MS  = 3000;
  const SMOKE_COOLDOWN_MS  = 30000;
  const SMOKE_HP_FRAC      = 0.30;
  const SMOKE_RADIUS       = 60;
  // Alien shield beam: a protective DR aura applied to a buddy.
  const SHIELD_DURATION_MS = 4000;
  const SHIELD_COOLDOWN_MS = 20000;
  const SHIELD_DR          = 0.5;
  // Girl auto-dismount idle window.
  const AUTO_DISMOUNT_MS   = 8000;

  // Who can swap shifts at whose station and still have it look
  // plausible?  Mirrors the SHARED_DRIFT_STATIONS table above
  // (used for idle drift toward a peer station) so the swap deals
  // only fire between roles where the visit already passes the
  // visual sniff test.  Ranged users (archer, firemage, witch,
  // ninja) all share the bullseye; melee bruisers (knight, viking)
  // share the dummy and stump.
  const SWAP_PEERS = {
    knight:   ["viking"],
    viking:   ["knight"],
    archer:   ["firemage", "ninja", "witch"],
    firemage: ["archer"],
    ninja:    ["archer"],
    witch:    ["archer"],
  };
  function swapPeerStationFor(visitor, hostName) {
    if (!SWAP_PEERS[hostName]) return null;
    if (!SWAP_PEERS[hostName].includes(visitor.name)) return null;
    return Scene.activity ? Scene.activity(hostName) : null;
  }

  function dealFeasible(kind, a, b, now) {
    switch (kind) {
      case "sharePotion": {
        // Symmetric: feasible when EITHER hero is carrying a spare
        // and the other isn't.  applyDeal's giver/taker logic later
        // sorts out which way the bottle moves; here we just gate
        // the offer on the basic shape ("one of them has it, both
        // are alive, neither is the alien who can't use ground
        // bottles").  Without this symmetry only A→B sharing was
        // ever offered, so a chat where only B held the bottle
        // silently dropped the deal.
        const oneHasIt = (a.spareRevive && !b.spareRevive)
                      || (b.spareRevive && !a.spareRevive);
        if (!oneHasIt) return false;
        if (a.role === "alien" || b.role === "alien") return false;
        if (a.combatMode !== "none" || b.combatMode !== "none") return false;
        return a.hp > 0 && b.hp > 0;
      }
      case "moralePact":
        return !!a.atk && !!b.atk
            && a.combatMode === "none" && b.combatMode === "none"
            && Math.max(a.moraleUntil, b.moraleUntil) <= now + 2000;
      case "restRound": {
        if (a.name === "zombie" || a.name === "robot") return false;
        if (b.name === "zombie" || b.name === "robot") return false;
        if (a.heldPotion || b.heldPotion) return false;
        if (a.brewReady || b.brewReady) return false;
        if (a.warmErrand || b.warmErrand) return false;
        if (!Scene.campfireBurning || !Scene.campfireBurning()) return false;
        const fire = Scene.activity && Scene.activity("firemage");
        if (!fire) return false;
        if (Monsters.anyThreat(fire.x, fire.y, 120)) return false;
        return true;
      }
      case "swapShift": {
        // Swapping requires BOTH to leave their current station and
        // walk to the OTHER's, so neither hero can be carrying any
        // bottle/brew bookkeeping that needs them somewhere specific.
        if (a.heldPotion || b.heldPotion) return false;
        if (a.brewReady || b.brewReady) return false;
        const aDest = swapPeerStationFor(a, b.name);
        const bDest = swapPeerStationFor(b, a.name);
        return !!(aDest && bDest);
      }
      case "ambushPact":
        return !!a.atk && !!b.atk
            && a.role !== "alien" && b.role !== "alien"
            && (!a.pact || a.pact.until <= now)
            && (!b.pact || b.pact.until <= now);
      case "gossip":
        return true;
    }
    return false;
  }

  // What kinds of deals are actually plausible for THIS pair right
  // now?  Returns the highest-priority feasible kind, or null.  The
  // ordering puts state-changing deals first (so a wounded buddy
  // who could use a bottle gets the bottle before we settle for
  // gossip) but still rolls a die at the top to keep "no deal,
  // just chat" the most common outcome.
  const DEAL_KINDS = ["sharePotion", "ambushPact", "moralePact", "swapShift", "restRound", "gossip"];
  function pickDealFor(a, b, now) {
    if (now - (a.lastDealAt || 0) < DEAL_PER_HERO_COOLDOWN_MS) return null;
    if (now - (b.lastDealAt || 0) < DEAL_PER_HERO_COOLDOWN_MS) return null;
    const aff = getAffinity(a, b);
    // Base offer rate: ~28 % among strangers, climbs to ~53 % at
    // max affinity.  Negative affinity collapses the rate so the
    // pair just trades Markov banter and walks off.
    const baseChance = 0.28 + 0.05 * Math.max(0, aff);
    if (aff < -1.5) return null;
    if (Math.random() > baseChance) return null;
    // Pick from the pair's feasible kinds.  All kinds are now
    // symmetric in their feasibility check (sharePotion handles its
    // own direction internally inside applyDeal), so a single A,B
    // pass is enough.
    const candidates = [];
    for (const k of DEAL_KINDS) {
      if (dealFeasible(k, a, b, now)) candidates.push(k);
    }
    if (!candidates.length) return null;
    // Mild bias toward state-changing deals when a clearly-useful
    // one is on the table.  If sharePotion or ambushPact is in the
    // candidate set we take it 70 % of the time; otherwise pick
    // uniformly from the rest.
    const strong = candidates.filter((k) => k === "sharePotion" || k === "ambushPact");
    if (strong.length && Math.random() < 0.7) {
      return strong[Math.floor(Math.random() * strong.length)];
    }
    return candidates[Math.floor(Math.random() * candidates.length)];
  }

  // Apply the side-effects of an accepted deal.  Always runs AFTER
  // Dialog has finished its script and called endTalking() so the
  // walkAwayFrom targets the conversation set are overridden by
  // whatever this function picks (e.g. restRound parks both at the
  // fire instead of letting them scatter).
  function applyDeal(a, b, kind) {
    if (!a || !b) return;
    if (a.hp <= 0 || b.hp <= 0) return;
    const now = performance.now();
    a.lastDealAt = now;
    b.lastDealAt = now;
    bumpAffinity(a, b, +1);
    switch (kind) {
      case "sharePotion": {
        // Direction matters: the carrier hands the bottle to the
        // one without a spare.  If the picker fired b→a (b carries),
        // we swap which way around the transfer goes.
        const giver = a.spareRevive ? a : b;
        const taker = giver === a ? b : a;
        if (giver.spareRevive && !taker.spareRevive) {
          giver.spareRevive = false;
          taker.spareRevive = true;
          giver.castFlashUntil = now + 200;
          taker.castFlashUntil = now + 200;
        }
        break;
      }
      case "moralePact": {
        a.moraleUntil = now + MORALE_DURATION_MS;
        b.moraleUntil = now + MORALE_DURATION_MS;
        a.castFlashUntil = now + 240;
        b.castFlashUntil = now + 240;
        break;
      }
      case "restRound": {
        const fire = Scene.activity && Scene.activity("firemage");
        if (fire) {
          // Clear any other errand flag that arrivedAt would
          // process AHEAD of warmErrand (or, worse, AFTER it on a
          // later wander tick — the firemage's chargeErrand is
          // particularly prone to lingering).  Without this a
          // restRound deal could leave a stale chargeErrand=true
          // that re-fires the next time the firemage idles past
          // the fire and double-buffs.
          a.flowerErrand = false; a.trainErrand = false;
          a.restErrand   = false; a.chargeErrand = false;
          a._swapShift   = false;
          b.flowerErrand = false; b.trainErrand = false;
          b.restErrand   = false; b.chargeErrand = false;
          b._swapShift   = false;
          a.warmErrand = true;
          setTarget(a, fire.x + rr(-12, 12), fire.y + rr(-6, 6));
          b.warmErrand = true;
          setTarget(b, fire.x + rr(-12, 12), fire.y + rr(-6, 6));
        }
        // Smaller morale top-up than the standalone pact — the regen
        // tick by the fire is the main payoff, the buff is a garnish.
        const dur = Math.floor(MORALE_DURATION_MS * 0.6);
        a.moraleUntil = now + dur;
        b.moraleUntil = now + dur;
        break;
      }
      case "swapShift": {
        const aDest = swapPeerStationFor(a, b.name);
        const bDest = swapPeerStationFor(b, a.name);
        if (aDest && bDest) {
          // Same idea as restRound: drop competing errand flags
          // so the visit to the peer station isn't shortened by
          // arrivedAt grabbing a flowerErrand/warmErrand/etc that
          // happened to still be set on this hero.
          a.warmErrand = false; a.flowerErrand = false;
          a.trainErrand = false; a.restErrand = false;
          a.chargeErrand = false;
          b.warmErrand = false; b.flowerErrand = false;
          b.trainErrand = false; b.restErrand = false;
          b.chargeErrand = false;
          a._swapShift = true;
          setTarget(a, aDest.x + rr(-6, 6), aDest.y + rr(-4, 4));
          b._swapShift = true;
          setTarget(b, bDest.x + rr(-6, 6), bDest.y + rr(-4, 4));
        }
        break;
      }
      case "ambushPact": {
        a.pact = { partner: b, until: now + PACT_DURATION_MS, kind: "ambush" };
        b.pact = { partner: a, until: now + PACT_DURATION_MS, kind: "ambush" };
        a.castFlashUntil = now + 240;
        b.castFlashUntil = now + 240;
        break;
      }
      case "gossip": {
        // Toned-down nudge: the lawn collectively gets a bit jumpier
        // for the next few seconds, biasing the next chat tones
        // toward "tense" (Markov pulls the tense seed pool).
        if (Dialog && Dialog.note) Dialog.note("rumor");
        break;
      }
    }
  }

  // Refusal callback: small affinity ding, no state change.  Worth
  // its own function so the cancellation path (chat interrupted by
  // a monster mid-handshake) can fall back to the same accounting
  // as a clean "no, thanks".
  function refuseDeal(a, b, _kind) {
    bumpAffinity(a, b, -0.5);
    const now = performance.now();
    a.lastDealAt = now;
    b.lastDealAt = now;
  }

  // Lookout election.  Picks the on-stage attendee with the highest
  // current HP fraction (bigger absolute HP wins ties — the knight
  // beats the archer when both are full) and stamps the lookout
  // buff for LOOKOUT_DURATION_MS.  Returns the elected hero or null
  // if the candidates list is empty.
  function electLookout(candidates) {
    let best = null, bestScore = -Infinity;
    for (const c of candidates) {
      if (!c || c.hp <= 0) continue;
      if (!c.atk) continue;
      if (!isVisibleNow(c)) continue;
      const score = (c.hp / c.maxHp) * 100 + c.hp * 0.1;
      if (score > bestScore) { bestScore = score; best = c; }
    }
    if (!best) return null;
    const now = performance.now();
    best.lookoutUntil = now + LOOKOUT_DURATION_MS;
    best.castFlashUntil = now + 320;
    return best;
  }

  function arrivedAt(c) {
    const now = performance.now();
    switch (c.state) {
      case "entering": {
        c.state = "working";
        c.stateUntil = now + rr(...STAY_AT_ITEM_MS);
        break;
      }
      case "wandering": {
        // Whichever errand resolves at this arrival "wins" — we're
        // standing where it pointed us.  Clear ALL other errand
        // flags so a stale one (e.g. a swapShift target that got
        // hijacked by a maybeWarmAtFire mid-walk) doesn't re-fire
        // on the NEXT arrivedAt and park us in working state at
        // some random lawn spot we didn't intend to stay at.
        // The branches below each consume their own flag too;
        // this helper just makes sure no other flag survives.
        const clearOtherErrands = (keep) => {
          if (keep !== "flowerErrand") c.flowerErrand = false;
          if (keep !== "trainErrand")  c.trainErrand  = false;
          if (keep !== "warmErrand")   c.warmErrand   = false;
          if (keep !== "_swapShift")   c._swapShift   = false;
          if (keep !== "restErrand")   c.restErrand   = false;
          if (keep !== "chargeErrand") c.chargeErrand = false;
        };
        // If we got here because of a flower-pick detour, consume
        // the bloom (heal + sparkle) before we continue wandering.
        // Trip aborted partway (e.g. combat happened en route)
        // would have cleared the flag elsewhere, so this only
        // fires on a clean arrival.  Note: flowerErrand intentionally
        // falls through (no `break`, no clearOtherErrands call) so a
        // hero who picked a flower on the way to e.g. a warm-stay can
        // still settle into the warm-stay after consuming the bloom.
        if (c.flowerErrand) {
          consumeFlowerErrand(c);
        }
        // Train-detour landed: lock in a working stay right here so
        // the buff loop / training-anim tick can do their job.  Skip
        // the rest of the wander logic — we're done walking.
        if (c.trainErrand) {
          clearOtherErrands(null);
          c.state = "working";
          c.stateUntil = now + rr(...STAY_AT_ITEM_MS);
          break;
        }
        // Warming-by-the-fire detour landed: park here for a long
        // working stay so the campfire's slow 1 HP / 1.5 s tick
        // (or, for the zombie, the grave's faster tick) actually
        // adds up to a real top-off.  Combat / threats can still
        // pull us out as usual via the normal combat checks.
        if (c.warmErrand) {
          clearOtherErrands(null);
          c.state = "working";
          c.stateUntil = now + rr(...WARM_DURATION_MS);
          break;
        }
        // Swap-shift deal: park here for one short work cycle.  The
        // station isn't c's own (c.activity stays unchanged), so the
        // station-buff loop in tickStations only grants a buff if
        // SWAP_PEERS happens to map to a stationBuffFor(owner, c)
        // hit — which is the whole point of restricting the swap to
        // peer-compatible roles.  After the stay we drop back into
        // wandering normally.
        if (c._swapShift) {
          clearOtherErrands(null);
          c.state = "working";
          c.stateUntil = now + rr(...STAY_AT_ITEM_MS);
          break;
        }
        if (c.restErrand) {
          clearOtherErrands(null);
          c.state = "working";
          c.stateUntil = now + rr(...REST_DURATION_MS);
          break;
        }
        // Firemage finished his charge jog.  Park here in "working"
        // so the buff loop in tickStations has time to stack the
        // infused timer toward its INFUSED_MS ceiling instead of
        // ticking once and immediately wandering off again.
        if (c.chargeErrand) {
          clearOtherErrands(null);
          c.state = "working";
          c.stateUntil = now + rr(...CHARGE_DURATION_MS);
          break;
        }
        if (c.mounted) {
          // Mounted girl never settles into "working" or wanders off
          // the stage between trot legs — both would dismount her
          // (working stops movement, the offstage parker forces a
          // dismount) which is the opposite of what the player wants
          // to see when the magical horse just appeared.  Refresh
          // the wander step every arrival until either the ride
          // timer expires or a real heal / revive errand interrupts
          // her via maybeEnterCombat.
          c.wandersLeft = 1;
          c.stateUntil = now + rr(...WANDER_STEP_MS);
          const [nx, ny] = randomLawnPoint(c);
          setTarget(c, nx, ny);
          break;
        }
        if (c.wandersLeft > 0 && now < c.stateUntil) {
          const [nx, ny] = randomLawnPoint(c);
          setTarget(c, nx, ny);
        } else {
          if (Math.random() < LEAVE_AFTER_WANDER_P) {
            startLeave(c);
          } else {
            c.state = "working";
            c.stateUntil = now + rr(...STAY_AT_ITEM_MS);
            const tp = trainingPosJittered(c);
            setTarget(c, tp.x, tp.y);
          }
        }
        break;
      }
    }
  }

  // ----- combat: common movement helper --------------------------------

  // Cost-of-pivot for ranged shots.  Long enough to read on screen
  // (the sprite visibly pauses and faces the new direction before
  // the projectile leaves) but short enough that a sniper isn't
  // crippled by it on every shot.  Burns ~one walk cycle's worth
  // of frames.
  const TURN_STUN_MS = 280;

  // Is the hero allowed to fire at a target that requires `desiredDir`
  // facing right now?  Three cases:
  //   • already facing that way and not mid-pivot     -> true (fire)
  //   • already mid-pivot from an earlier flip        -> false (wait)
  //   • facing the wrong way                          -> flip + start
  //                                                      a fresh pivot
  //                                                      stun, false
  // The stun field is also honoured by moveStep, so the hero stands
  // still while turning instead of waddling sideways during the pivot.
  function turnToFace(c, desiredDir, now) {
    if (c.facingStunUntil > now) return false;
    if (c.dir === desiredDir) return true;
    c.dir = desiredDir;
    c.facingStunUntil = now + TURN_STUN_MS;
    c.frame = 0;
    return false;
  }

  function moveStep(c, dt, speedMul) {
    if (c.facingStunUntil && performance.now() < c.facingStunUntil) {
      // Mid-pivot — freeze in place so the turn actually costs a
      // beat (otherwise the hero would just keep coasting along
      // their wander path while the sprite spun under them).
      c.frame = 0;
      return false;
    }
    // Mounted units gallop at HORSE_RIDE_SPEED_MUL on top of whatever
    // speedMul the call site already requested (1.0 wandering, 1.2
    // retreating, 1.35 fleeing, etc).  This is the single chokepoint
    // where the mount actually translates into faster movement —
    // every AI branch that calls moveStep automatically inherits the
    // boost while c.mounted is true, so individual ticks (heal,
    // flee, retreat) don't need to know about the horse.
    const effSpeedMul = c.mounted ? speedMul * HORSE_RIDE_SPEED_MUL : speedMul;
    const pnow = performance.now();
    // Elemental movement debuffs applied multiplicatively on top of
    // the caller's speedMul.  Priority: root > chill ≈ slow.
    // Root is a full stop for its duration (lightning bite).
    if (c.rootUntil && c.rootUntil > pnow) {
      c.frame = 0;
      return false;
    }
    // Chill (ice spit) reduces speed; slowedUntil (witch hex) also
    // applies here for heroes.  Use the stronger of the two.
    let debuffMul = 1;
    if (c.chillUntil   && c.chillUntil   > pnow) debuffMul = Math.min(debuffMul, c.chillMul  || 0.55);
    if (c.slowedUntil  && c.slowedUntil  > pnow) debuffMul = Math.min(debuffMul, 0.55);
    const finalSpeedMul = effSpeedMul * debuffMul;
    const dx = c.tx - c.x;
    const dy = c.ty - c.y;
    const d = Math.hypot(dx, dy);
    if (d > 2) {
      const s = (SPEED * finalSpeedMul) * dt / 1000;
      const step = Math.min(d, s);
      let nx = c.x + (dx / d) * step;
      let ny = c.y + (dy / d) * step;
      [nx, ny] = Scene.avoidPondStep(c.x, c.y, nx, ny, c.tx, c.ty, c);
      if (Scene.avoidCaveStep) {
        [nx, ny] = Scene.avoidCaveStep(c.x, c.y, nx, ny, c.tx, c.ty, c);
      }
      // Archer aimed-shot bookkeeping: any real movement resets the
      // "I've been holding still" timer, so the +50 % bonus only
      // pays off when the archer is genuinely camped on a firing
      // line, not while jogging into position.
      if (c.name === "archer") {
        c.aimedReadyAt     = 0;
        c.aimedConsumeNext = false;
      }
      // Track the actual displacement so the facing + walk animation
      // reflect where we really went (not just the desired target).
      const mvx = nx - c.x;
      c.x = nx;
      c.y = ny;
      if (Math.abs(mvx) > 0.01) c.dir = mvx >= 0 ? "r" : "l";
      c.frameTimer += dt;
      if (c.frameTimer >= FRAME_MS) {
        c.frameTimer = 0;
        c.frame ^= 1;
      }
      // Keep the mount glued to its rider every frame so the rider
      // and horse don't drift apart visually (drawOne stacks them
      // using the rider's c.x/c.y as the anchor; if the horse's
      // entity record fell out of sync the gallop bob would jitter).
      if (c.mounted && c.horseEntity) {
        c.horseEntity.x = c.x;
        c.horseEntity.y = c.y;
        c.horseEntity.dir = c.dir;
        c.horseEntity.frame = c.frame;
        c.horseEntity.frameTimer = c.frameTimer;
      }
      return false;
    }
    c.frame = 0;
    if (c.mounted && c.horseEntity) {
      // Stand-still tick: keep the horse glued to the rider AND keep
      // its facing in lockstep.  Without the dir sync, a mounted
      // girl who turns in place (e.g. to face a healed ally) leaves
      // the horse pointing the old way underneath her, which reads
      // as the rider sitting backwards on the saddle.
      c.horseEntity.x = c.x;
      c.horseEntity.y = c.y;
      c.horseEntity.dir = c.dir;
      c.horseEntity.frame = 0;
      c.horseEntity.frameTimer = 0;
    }
    return true;
  }

  // (Pond avoidance lives in Scene.avoidPondStep — shared with
  // monsters so grounded enemies don't wade through the water either.)

  // ----- combat: threat detection --------------------------------------

  // Score a monster from the perspective of `c`.  Lower = more
  // attractive target.  Produces a px-equivalent number so a hero
  // standing 80 px from a low-HP bat can prefer it over a 60-px
  // skeleton, etc.  Distance is the floor; everything else nudges.
  function threatScoreHero(c, m) {
    const dx = m.x - c.x, dy = m.y - c.y;
    const d  = Math.hypot(dx, dy);
    let s = d * THREAT_WEIGHTS.distance;
    const hpFrac = (m.maxHp > 0) ? (m.hp / m.maxHp) : 1;
    s -= (1 - hpFrac) * THREAT_WEIGHTS.lowHp;
    if (m.flying)        s += THREAT_WEIGHTS.kindFly;
    if (m.kind === "worm") s += THREAT_WEIGHTS.kindWorm;
    if (m.kind === "hydraHead") s += THREAT_WEIGHTS.kindHydraHead;
    if (m.kind === "hydraBody") s += THREAT_WEIGHTS.kindHydraBody;
    // Archer specifically loves flying targets — drop the kindFly
    // penalty and add a small bonus so volley priority matches the
    // fiction.
    if (c.name === "archer" && m.flying) {
      s -= THREAT_WEIGHTS.kindFly + 18;
    }
    // "This monster is biting one of my friends right now" — big
    // bonus so heroes peel off to defend instead of grinding the
    // closest mob.
    if (m.target && m.target !== c &&
        m.target.hp > 0 && m.target.combatMode !== "dead") {
      s += THREAT_WEIGHTS.attackingAlly;
      if (m.target.role === "healer") s -= THREAT_WEIGHTS.isHealer;
    }
    return s;
  }

  // Score a hero (or decoy) from the perspective of monster `m`.
  // Same idea: lower = more attractive.  Decoys are way more
  // attractive than the real hero, healers slightly more attractive
  // than fighters (squishy back-line target).
  function threatScoreMonster(m, hero) {
    const dx = hero.x - m.x, dy = hero.y - m.y;
    const d  = Math.hypot(dx, dy);
    let s = d * THREAT_WEIGHTS.distance;
    if (hero.isDecoy || hero.decoy) s -= THREAT_WEIGHTS.isDecoy;
    if (hero.role === "healer")     s -= THREAT_WEIGHTS.isHealer;
    const hpFrac = (hero.maxHp > 0) ? (hero.hp / hero.maxHp) : 1;
    s -= (1 - hpFrac) * THREAT_WEIGHTS.lowHp * 0.4;
    // Knight active taunt: yank monster aggro toward him for the
    // duration of TAUNT_DURATION_MS.  Same shape as the decoy
    // bonus (huge negative) so the knight outranks fresh targets.
    const t = performance.now();
    if (hero.tauntUntil && hero.tauntUntil > t) {
      s -= THREAT_WEIGHTS.isDecoy;
    }
    // Ninja smoke bomb: invisible to monster targeting for the
    // smoke window — heavily penalize selection so monsters look
    // elsewhere instead of locking on through the cloud.
    if (hero.smokeUntil && hero.smokeUntil > t) {
      s += 9999;
    }
    return s;
  }

  // Pick the best monster for hero `c` to engage within `maxRange`.
  // Drop-in replacement for nearestMonster when the caller actually
  // wants a TARGET (not a "is anything in this corridor" check).
  // Returns [bestMonster, distanceToBest] for back-compat with the
  // old nearestMonster shape.
  function bestMonsterFor(c, maxRange) {
    let best = null, bestS = Infinity, bestD = Infinity;
    // Boss-fight tiered picker.
    //
    // Problem: with hydra's kindHydraBody weight (-260) and
    // BOSS_PERCEPTION_R covering the whole stage, a slime at 130 px
    // scores ~130 while the body at 400 px scores ~140 — body barely
    // wins.  But a slime at 150 px is FILTERED (> maxRange) while the
    // body is still visible.  Net result: heroes walk past a live
    // skeleton at 150 px to reach a body 300 px further, get killed
    // en route, and the body never takes damage anyway.
    //
    // Fix — two-pass tiered pick when the boss is active:
    //   Pass 1: best non-hydra monster inside the NORMAL aggro radius.
    //   Pass 2: if pass-1 found nothing, best hydra part anywhere.
    // This preserves "hydra is visible at any distance" (so heroes
    // WILL converge once the local field is clear) while keeping the
    // invariant "clear your lane before marching across the map".
    if (HydraPlan && HydraPlan.active()) {
      // Pass 1 — local threats only (always open, including during
      // rally — slimes that wander onto the lawn while heroes
      // assemble must still be cleared, otherwise the rally is just
      // a free target practice for adds).
      for (const m of Monsters.list) {
        if (m.dying || m.fleeing) continue;
        if (m.kind === "hydraBody" || m.kind === "hydraHead") continue;
        if (Monsters.isHidden(m, c)) continue;
        const d = Math.hypot(m.x - c.x, m.y - c.y);
        if (d > maxRange) continue;
        const s = threatScoreHero(c, m);
        if (s < bestS) { bestS = s; best = m; bestD = d; }
      }
      // Pass 2 — hydra parts anywhere on stage, but ONLY:
      //   • we're in the engage phase (during rally heroes converge
      //     on the assembly point; engaging the boss now would split
      //     the formation and waste the war-cry pulse),
      //   • pass 1 found nothing,
      //   • the hero isn't actively prepping (witch at cauldron,
      //     firemage at campfire — let the prep finish, they'll
      //     re-evaluate as soon as state exits).
      if (!best && HydraPlan.inEngage()) {
        const prepping = c.state === "working"
          || c.chargeErrand || c.trainErrand || c.warmErrand;
        if (!prepping) {
          for (const m of Monsters.list) {
            if (m.dying || m.fleeing) continue;
            if (m.kind !== "hydraBody" && m.kind !== "hydraHead") continue;
            if (Monsters.isHidden(m, c)) continue;
            const d = Math.hypot(m.x - c.x, m.y - c.y);
            const s = threatScoreHero(c, m);
            if (s < bestS) { bestS = s; best = m; bestD = d; }
          }
        }
      }
      return [best, bestD];
    }
    // Normal (non-boss) pick: single-pass by range.
    for (const m of Monsters.list) {
      if (m.dying || m.fleeing) continue;
      if (Monsters.isHidden(m, c)) continue;
      const d = Math.hypot(m.x - c.x, m.y - c.y);
      if (d > maxRange) continue;
      const s = threatScoreHero(c, m);
      if (s < bestS) { bestS = s; best = m; bestD = d; }
    }
    return [best, bestD];
  }

  // Pick the best hero (or decoy) for monster `m` to chase.  Used by
  // Monsters.tick replacing the old nearestHero.
  function bestHeroFor(m) {
    let best = null, bestS = Infinity, bestD = Infinity;
    for (const c of list) {
      if (!isVisibleNow(c)) continue;
      if (c.hp <= 0) continue;
      if (c.combatMode === "ufoing") continue;
      const s = threatScoreMonster(m, c);
      if (s < bestS) {
        bestS = s; best = c;
        bestD = Math.hypot(c.x - m.x, c.y - m.y);
      }
    }
    if (decoys && decoys.length) {
      for (const d of decoys) {
        if (d.fadeStartAt > 0) continue;
        if (d.hp <= 0) continue;
        const s = threatScoreMonster(m, d);
        if (s < bestS) {
          bestS = s; best = d;
          bestD = Math.hypot(d.x - m.x, d.y - m.y);
        }
      }
    }
    return [best, bestD];
  }

  function nearestMonster(c, maxRange) {
    let best = null, bestD = Infinity;
    for (const m of Monsters.list) {
      if (m.dying || m.fleeing) continue;
      // Buried/transitioning worms are imperceptible to most heroes —
      // they shouldn't show up as combat targets.  The ninja is the
      // exception: his hearing lets him pick out a buried worm from
      // the soil itself, so isHidden(..., c) waves him through.
      if (Monsters.isHidden(m, c)) continue;
      const d = Math.hypot(m.x - c.x, m.y - c.y);
      if (d < bestD && d < maxRange) { bestD = d; best = m; }
    }
    return [best, bestD];
  }

  function anyMonsterNear(x, y, r) {
    return Monsters.anyThreat(x, y, r);
  }

  // Same shape as Monsters.anyThreat but ignores hydra body/heads.
  // The witch parks at the cauldron during a boss fight (~190 px from
  // the body) and an inflated head reaches ~95 px out — that puts a
  // hydra part inside the witch's standard 120 px "is it safe to
  // start an errand" bubble for nearly the entire fight, which used
  // to wedge her at the cauldron with a brewed bottle even though
  // the arc-route to the chest was clean.  We still want her to
  // notice slimes / skeletons / adds in that bubble — only hydra
  // parts are excluded, since route safety is then decided by
  // `hydraPathBlocked` at the call site.
  function anyNonHydraThreatNear(x, y, r) {
    for (const m of Monsters.list) {
      if (m.dying || m.fleeing) continue;
      if (m.kind === "hydraBody" || m.kind === "hydraHead") continue;
      if (Monsters.isHidden && Monsters.isHidden(m)) continue;
      if (Math.hypot(m.x - x, m.y - y) < r) return true;
    }
    return false;
  }

  // "Non-fighter" = a hero with no attack at all — currently only the
  // girl.  Used by AI branches that would normally walk straight at a
  // target (revive, heal) but for a defenceless character should
  // refuse routes through monsters and refuse targets that sit IN a
  // melee, since she can't defend herself once she gets there.
  function nonFighter(c) {
    return !c.atk;
  }

  // The girl casts at long range; everyone else who runs the heal
  // / revive code paths still uses the melee fall-backs.  Centralised
  // so future healers (priest sprite, etc.) only need a role check
  // here instead of touching every state-machine site.
  function healRangeOf(c) {
    return c.role === "healer" ? GIRL_HEAL_RANGE : HEAL_RANGE;
  }
  function reviveRangeOf(c) {
    return c.role === "healer" ? GIRL_REVIVE_RANGE : REVIVE_RANGE;
  }

  // Where the girl wants to STAND while casting on `targetX/Y` — a
  // spot `range - 8` px to one side of the patient, clamped into the
  // lawn so she doesn't try to plant herself off-screen when the
  // patient is hugging the edge.
  //
  // Side selection used to be "whichever side already has her", which
  // does the wrong thing in the most common scenario: a monster has
  // run up to a wounded ally and the girl is on the same side as the
  // monster.  The naive standoff then puts her *between* her current
  // spot and the monster, so she cheerfully sprints toward the slime
  // to "stand back from the patient".  Instead, look for the closest
  // threat near the patient (or near the would-be standoff itself)
  // and stand on the OPPOSITE side; if nothing is close, fall back to
  // the shorter-walk side.  If both sides have a threat, prefer the
  // side whose threat is farther so we at least pick the lesser evil.
  function standoffNear(c, tx, ty, range) {
    const off = Math.max(8, range - 8);
    const margin = 12;
    const xL = Math.max(margin, Math.min(Scene.WIDTH - margin, tx - off));
    const xR = Math.max(margin, Math.min(Scene.WIDTH - margin, tx + off));
    // Distance from the closer threat to each candidate standoff.
    // We sample threats inside a generous bubble around the patient
    // (range + half the standoff offset) so we react to anything
    // that could plausibly reach either side mid-cast.
    const probeR = range + off * 0.5;
    let nearL = Infinity, nearR = Infinity;
    for (const m of Monsters.list) {
      if (m.dying || m.fleeing) continue;
      if (Monsters.isHidden(m)) continue;
      if (Math.hypot(m.x - tx, m.y - ty) > probeR) continue;
      const dL = Math.hypot(m.x - xL, m.y - ty);
      const dR = Math.hypot(m.x - xR, m.y - ty);
      if (dL < nearL) nearL = dL;
      if (dR < nearR) nearR = dR;
    }
    let pickLeft;
    // Hydra-body bias: when the boss is alive the body itself is
    // rarely on `Monsters.list` as a normal threat (it's tracked by
    // HydraPlan), so the `nearL/nearR` sweep above doesn't see it.
    // A close-to-the-body corpse therefore picks "shorter walk"
    // even when one of the two standoffs lands inside head reach.
    // Bias toward the side whose centre is FARTHER from the body
    // when the asymmetry is meaningful (>12 px) and one side is
    // clearly safer.
    if (HydraPlan && HydraPlan.active && HydraPlan.active()) {
      const b = HydraPlan.body && HydraPlan.body();
      if (b) {
        const dL = Math.hypot(xL - b.x, ty - b.y);
        const dR = Math.hypot(xR - b.x, ty - b.y);
        if (Math.abs(dL - dR) > 12) {
          return { x: dL > dR ? xL : xR, y: ty };
        }
      }
    }
    if (nearL === Infinity && nearR === Infinity) {
      // Quiet — go with the shorter walk.
      pickLeft = (c.x <= tx);
    } else {
      // Default: stand on the side whose nearest threat is farther.
      // BUT: if the caster is already on the closer side and that
      // side has at least a tolerable buffer (~ FLIP_BIAS px), bias
      // toward staying — otherwise the girl tries to "stand back from
      // the patient" by walking THROUGH the patient (and the slime
      // currently chewing on him) to reach the marginally safer
      // opposite-side standoff.  The whole point of a long-range
      // heal is that she doesn't need to close on the brawl.
      const casterOnLeft = c.x <= tx;
      const naturalNear = casterOnLeft ? nearL : nearR;
      const flippedNear = casterOnLeft ? nearR : nearL;
      const FLIP_BIAS = 28;
      if (naturalNear + FLIP_BIAS >= flippedNear) {
        pickLeft = casterOnLeft;
      } else {
        pickLeft = nearL >= nearR;
      }
    }
    return { x: pickLeft ? xL : xR, y: ty };
  }

  // Relaxed safety predicate for the girl: the standoff tile must
  // be threat-free AND the path TO that tile must be clear, but the
  // patient's own tile (where the monster usually is) is allowed to
  // be hot — the whole point of a long-range heal/revive is that
  // she doesn't have to walk INTO the monster.  Falls back to the
  // strict whole-line safePathTo for non-healers.
  //
  // `purpose` ("heal" by default, "revive" for resurrection paths)
  // toggles the grave-avoidance veto: heals refuse anything inside
  // skeleton-spawn territory, revives explicitly opt out so the girl
  // will still walk to a corpse lying right on the grave (that's the
  // one job important enough to risk being clawed at).
  function safeCastFrom(c, tx, ty, range, purpose) {
    if (!nonFighter(c)) return safePathTo(c, tx, ty);
    const s = standoffNear(c, tx, ty, range);
    // Hydra exception: the healer / reviver sometimes MUST stand in a
    // controlled front pocket to matter.  The generic safePathTo
    // rejects any destination in the spit envelope outside the push
    // window, which is correct for potion runs / flower errands but
    // too strict for the one role whose entire job is to keep the
    // front line alive.  Permit a narrow band just behind the smashers:
    // still reject actual melee danger on the tile / path, but don't
    // veto the spot purely because it's inside the hydra's outer spit
    // radius.  This keeps the girl near enough to heal the tank while
    // still preventing suicide-runs deep into the bite cone.
    if (HydraPlan.active() && c.role === "healer") {
      if (Monsters.anyThreat(s.x, s.y, DEST_CLEARANCE)) return false;
      if (Monsters.anyOnPath(c.x, c.y, s.x, s.y, PATH_CLEARANCE)) return false;
      const b = HydraPlan.body();
      // Bite-floor: ALWAYS reject standoffs inside head-bite reach
      // (the channel is a death sentence there).  For heals during
      // a hydra fight the tank is in front of the girl and absorbs
      // bites at HYDRA_TANK_RING_R + 18 (~98 px), so 98 px is the
      // legal floor.  For a REVIVE there is no tank — the corpse
      // fell wherever it fell — so the standoff itself must clear
      // the head-bite ring with margin or the channel dies on the
      // first chomp.  Mirrors girl_revive_sim.py's safe_cast_from.
      const headBiteR = (Monsters.HYDRA_HEAD_RANGE || 95) + 10;
      const biteFloor = (purpose === "revive")
        ? (headBiteR + 10)
        : (HYDRA_TANK_RING_R + 18);
      if (b) {
        const dBody = Math.hypot(s.x - b.x, s.y - b.y);
        if (dBody < biteFloor) return false;
      }
      // Spit-band veto: heals can wait — refusing a standoff in the
      // outer spit ring just means she casts again in two seconds.
      // Revives can't wait: a corpse blocked by the spit ring is
      // unrevivable, and spit is dodgeable mid-channel via the
      // generic `nonFighter && anyThreat` bail-out.  Skip the band
      // check for revives, keep it for heals.
      if (purpose !== "revive" && b && HydraPlan.inSpitDanger(s.x, s.y)) {
        const dBody = Math.hypot(s.x - b.x, s.y - b.y);
        if (dBody > HYDRA_HEALER_RING_R + 30) return false;
      }
      // Hydra body veto: even with both endpoints in the
      // "controlled front pocket" band above, a straight-line
      // walk from her current X to a standoff on the far side
      // of the boss can graze the head-bite ring.  The generic
      // anyOnPath uses PATH_CLEARANCE (~38 px) which is way
      // tighter than the hydra's head reach (~95 px) — the body
      // itself often isn't even in `Monsters.list` as a normal
      // threat, and even when it is, a path that threads the
      // needle around the body within head reach reads as clear
      // up until the first bite lands.  This is the user-reported
      // "the girl ran at the hydra again" case: she had a
      // perfectly-safe standoff to revive an ally on the far
      // side, no monster on the line within 38 px, and walked
      // through bite range to get there.  Reject those paths
      // outright; the revive can wait one cycle, the reviver
      // can't be replaced.
      if (b && hydraPathBlocked(c.x, c.y, s.x, s.y)) return false;
    } else if (!safePathTo(c, s.x, s.y)) {
      return false;
    }
    if (purpose !== "revive" && graveBlocks(c, s.x, s.y)) return false;
    return true;
  }

  // Skeletons crawl out of the gravestone tile every wave.  The girl
  // gives the area a wide berth — she's defenceless, and a fresh
  // skeleton's first action is to bite the closest soft target.
  // GRAVE_AVOID_R is roughly "two skeleton hops" past the stone, big
  // enough that she has time to back off before the next pop.  The
  // filter only triggers for the healer role; everyone else may walk
  // past the grave freely (and actually wants to, to fight the
  // skeletons that come out).
  const GRAVE_AVOID_R = 56;
  function pointNearGrave(x, y, r) {
    const g = Scene.grave && Scene.grave();
    if (!g) return false;
    const rad = (r != null) ? r : GRAVE_AVOID_R;
    return Math.hypot(g.x - x, g.y - y) < rad;
  }
  // Does the straight line from (x1,y1) to (x2,y2) pass within `r`
  // pixels of the gravestone?  Same point-to-segment trick Monsters
  // uses for path-clearance checks.
  function pathCrossesGrave(x1, y1, x2, y2, r) {
    const g = Scene.grave && Scene.grave();
    if (!g) return false;
    const rad = (r != null) ? r : GRAVE_AVOID_R;
    const dx = x2 - x1, dy = y2 - y1;
    const segLen2 = dx * dx + dy * dy;
    let t = segLen2 > 0
      ? ((g.x - x1) * dx + (g.y - y1) * dy) / segLen2
      : 0;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    const cx = x1 + t * dx - g.x;
    const cy = y1 + t * dy - g.y;
    return (cx * cx + cy * cy) < (rad * rad);
  }
  // Hydra-body avoidance: same point-segment-distance shape as
  // pathCrossesGrave, but the obstacle is the live boss body and
  // the avoid radius is a fraction of the spit envelope.  Used by
  // startFleeing to flip the chosen exit edge if it would route
  // the runner through the lair, and by tickRideToCorpse to bend
  // the gallop around the body when the corpse is on the far
  // side.  Returns false when there's no boss fight in progress.
  function pathCrossesHydra(x1, y1, x2, y2, r) {
    if (!HydraPlan || !HydraPlan.active || !HydraPlan.active()) return false;
    const body = HydraPlan.body && HydraPlan.body();
    if (!body) return false;
    // Default radius = ~half the spit envelope: tight enough that
    // a corridor along the lair edge is still legal, wide enough
    // that "straight through the body" never is.
    const rad = (r != null) ? r : (Monsters.HYDRA_SPIT_RANGE || 280) * 0.5;
    const dx = x2 - x1, dy = y2 - y1;
    const segLen2 = dx * dx + dy * dy;
    let t = segLen2 > 0
      ? ((body.x - x1) * dx + (body.y - y1) * dy) / segLen2
      : 0;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    const cx = x1 + t * dx - body.x;
    const cy = y1 + t * dy - body.y;
    return (cx * cx + cy * cy) < (rad * rad);
  }

  // Combined "is this site in skeleton-spawn territory" check used
  // by the girl's pathing and by safeCastFrom.  Considers both the
  // destination tile and the straight-line walk to it.  Cheap no-op
  // for non-healers so it can sit in shared call sites without an
  // explicit role guard at every site.
  function graveBlocks(c, tx, ty) {
    if (c.role !== "healer") return false;
    if (pointNearGrave(tx, ty)) return true;
    if (pathCrossesGrave(c.x, c.y, tx, ty)) return true;
    return false;
  }

  // Zombie's "fire dread" — the undead aren't fond of an open flame
  // and shouldn't drift through the campfire's hex while wandering.
  // Pattern mirrors the grave avoidance above (point check + segment
  // clearance), but is gated on `c.name === "zombie"` and only active
  // while the fire is actually lit.  Used by randomLawnPoint to reject
  // wander goals near or through the fire.
  const FIRE_DREAD_R = 50;
  function pointNearFire(x, y, r) {
    const f = Scene.activity && Scene.activity("firemage");
    if (!f) return false;
    const rad = (r != null) ? r : FIRE_DREAD_R;
    return Math.hypot(f.x - x, f.y - y) < rad;
  }
  function pathCrossesFire(x1, y1, x2, y2, r) {
    const f = Scene.activity && Scene.activity("firemage");
    if (!f) return false;
    const rad = (r != null) ? r : FIRE_DREAD_R;
    const dx = x2 - x1, dy = y2 - y1;
    const segLen2 = dx * dx + dy * dy;
    let t = segLen2 > 0
      ? ((f.x - x1) * dx + (f.y - y1) * dy) / segLen2
      : 0;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    const cx = x1 + t * dx - f.x;
    const cy = y1 + t * dy - f.y;
    return (cx * cx + cy * cy) < (rad * rad);
  }
  function fireBlocks(c, tx, ty) {
    if (c.name !== "zombie") return false;
    if (!Scene.campfireBurning || !Scene.campfireBurning()) return false;
    // Always reject destinations sitting on top of the fire.
    if (pointNearFire(tx, ty)) return true;
    // If the zombie is already inside the dread radius (e.g. wandered
    // past before the fire was lit, or got pushed there by combat),
    // let him pick targets that walk OUT — only veto routes that
    // cross the fire when starting from outside.
    if (!pointNearFire(c.x, c.y) && pathCrossesFire(c.x, c.y, tx, ty)) {
      return true;
    }
    return false;
  }

  // Cave dread: any hero who is NOT a fighter (melee bruisers walk in
  // to engage the hydra) should refuse wander goals that sit on the
  // cave rocks or whose straight path would run through them.  Fighters
  // ignore it — they intentionally charge in.  Applied any time the
  // hydra lair exists (regardless of whether the hydra is present,
  // since "no monster" ≠ "safe near the cave").
  const CAVE_DREAD_R = 50;
  function pointNearCave(x, y, r) {
    if (!Scene.isInCave) return false;
    const rad = r != null ? r : CAVE_DREAD_R;
    const lair = Scene.hydraLair ? Scene.hydraLair() : null;
    if (!lair) return false;
    return Math.hypot(lair.x - x, lair.y - y) < rad;
  }
  function caveBlocks(c, tx, ty) {
    // Fighters charge in deliberately.
    if (c.role === "fighter") return false;
    if (!Scene.isInCave) return false;
    // Always reject goals inside the cave sprite.
    if (Scene.isInCave(tx, ty, 8)) return true;
    // If already inside the dread radius let them escape outward.
    if (pointNearCave(c.x, c.y, CAVE_DREAD_R)) return false;
    // Reject goals very close to the cave even outside the sprite.
    if (pointNearCave(tx, ty, CAVE_DREAD_R)) return true;
    return false;
  }

  // Does this hero shoot from a distance (arrow/shuriken/hex/laser/…)
  // as opposed to swinging a melee weapon?  Ranged heroes can fire
  // OPPORTUNISTIC shots while doing other things (running an errand
  // to revive, walking to the chest, retreating, just wandering past
  // a monster, …) without breaking out of their current state — see
  // `tryRangedSnipe`.  Melee fighters can't do that — landing a sword
  // hit requires getting into melee range, which is the explicit
  // "fighting" mode's whole job.
  function isRanged(c) {
    return !!(c.atk && !Combat.isMelee(c.atk.kind));
  }

  // Fire a free shot at the nearest in-range monster IF the hero is
  // ranged AND the per-attack cooldown has elapsed AND there's
  // actually a target in range.  Returns true if a shot went out.
  //
  // If the target is on the opposite side of the hero's current
  // facing, the hero pivots first (`turnToFace`) and the actual
  // shot is delayed by one TURN_STUN_MS pause — the hero stands
  // still during the pivot, loses a beat, then fires forward.
  // Stops the old "snap-shoot 180° behind without ever turning"
  // bug where an archer walking right would magically launch an
  // arrow over their left shoulder.
  function tryRangedSnipe(c, now) {
    if (!isRanged(c)) return false;
    if (now - c.lastAttackAt < effectiveCd(c)) return false;
    if (c.facingStunUntil > now) return false;
    // During a hydra fight, prefer the role's plan target if it's
    // within weapon range — a SMASHER with their fireball ready
    // shouldn't burn it on a stray slime when the body is an
    // identical-distance target that actually closes the encounter.
    // Falls through to the regular nearest-in-range pick when the
    // plan target is out of reach (typical for a CUTTER whose head
    // got severed last beat) so we still get opportunistic plinks.
    let m = null;
    if (HydraPlan.active()) {
      const planT = HydraPlan.targetFor(c);
      if (planT && !planT.dying &&
          Math.hypot(planT.x - c.x, planT.y - c.y) <= c.atk.range) {
        m = planT;
      }
    }
    if (!m) {
      const [near] = nearestMonster(c, c.atk.range);
      m = near;
    }
    if (!m) return false;
    // Witch-only: route the candidate through WitchStrategy so the
    // policy ("don't pivot toward the boss while inside spit / while
    // carrying a brewed bottle / when there's a non-hydra add I could
    // shoot instead") lives in one place that we can stand-test.  The
    // advisor returns either the same target, a substitute, or null
    // (skip this tick).  Falls through to the original behaviour for
    // every other ranged hero.
    if (c.name === "witch" && typeof WitchStrategy !== "undefined") {
      const monsters = [];
      for (const o of Monsters.list) {
        if (!o || o.dying || o.fleeing) continue;
        const hidden = !!(Monsters.isHidden && Monsters.isHidden(o, c));
        monsters.push({ x: o.x, y: o.y, kind: o.kind, ref: o, hidden });
      }
      const hydraOn = HydraPlan && HydraPlan.active && HydraPlan.active();
      const world = {
        witch: {
          x: c.x, y: c.y,
          range: c.atk.range,
          heldPotion: c.heldPotion || null,
          combatMode: c.combatMode,
          hp: c.hp, hpMax: c.hpMax,
        },
        hydra: hydraOn ? {
          active: true,
          body: HydraPlan.body() || null,
          headRange: Monsters.HYDRA_HEAD_RANGE,
          spitR: HydraPlan.spitR ? HydraPlan.spitR()
                                 : (Monsters.HYDRA_SPIT_RANGE || 280),
          inSpitDanger: HydraPlan.inSpitDanger,
        } : { active: false },
        monsters,
        planTarget: hydraOn ? (() => {
          const t = HydraPlan.targetFor(c);
          if (!t) return null;
          return { x: t.x, y: t.y, kind: t.kind, ref: t, hidden: false };
        })() : null,
      };
      const advice = WitchStrategy.chooseHexTarget(world);
      if (!advice.target) return false;
      m = advice.target.ref || advice.target;
    }
    const desired = m.x >= c.x ? "r" : "l";
    if (!turnToFace(c, desired, now)) return false;
    Combat.heroAttack(c, m);
    c.lastAttackAt = now;
    c.castFlashUntil = now + 160;
    return true;
  }

  // Drive-by snipe during a panic flee.  Unlike `tryRangedSnipe`
  // we deliberately REFUSE to pivot — `turnToFace` would burn a
  // TURN_STUN_MS standing-still beat that a fleeing hero literally
  // can't afford (the user reported "arrows just whiz past the
  // monsters" — the previous code took it further and disabled
  // snipe entirely while fleeing, see the original snipeAllowed
  // veto for "fleeing").  We pick the nearest in-range monster
  // that's already on our current facing side, and only fire
  // there; a shot fired forward doesn't slow movement (heroAttack
  // doesn't gate the move loop) so the fleer thins blockers in
  // her own corridor as she sprints past.  Returns true if a
  // shot went out.  Same rate-limit as a normal swing.
  function tryFleeSnipe(c, now) {
    if (!isRanged(c)) return false;
    if (now - c.lastAttackAt < effectiveCd(c)) return false;
    if (c.facingStunUntil > now) return false;
    const range = c.atk.range;
    const facingRight = c.dir === "r";
    let best = null, bestD2 = range * range;
    for (const m of Monsters.list) {
      if (!m || m.dying || m.fleeing) continue;
      if (Monsters.isHidden && Monsters.isHidden(m, c)) continue;
      if ((m.x >= c.x) !== facingRight) continue;
      const dx = m.x - c.x, dy = m.y - c.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD2) { bestD2 = d2; best = m; }
    }
    if (!best) return false;
    Combat.heroAttack(c, best);
    c.lastAttackAt = now;
    c.castFlashUntil = now + 160;
    return true;
  }

  // Whitelist of combat sub-states where opportunistic snipe is
  // welcome.  We skip explicit attack states (already firing) and
  // states where the animation is "I'm doing a delicate thing" —
  // the channel half of a revive cast, smashing a revive bottle on
  // a corpse, drinking from / rummaging in the chest, fleeing
  // off-stage in a panic, or sitting in the UFO.
  //
  // "ufoing" is special: the alien wears that combatMode the entire
  // time from the moment he starts walking toward the saucer until
  // he lands at the end of the sortie.  The "no shooting" rule only
  // makes sense once he's actually aboard — in the pre-board phase
  // he's still on foot with the laser holstered, and silently
  // jogging past a goblin without plinking it was the bug behind
  // "the alien stopped doing ranged attacks when outside the UFO".
  // While not boarded yet we treat him like a normal grounded
  // ranged hero: fire on cooldown if a monster wanders inside his
  // weapon range.
  function snipeAllowed(c) {
    if (c.ufoCrashAnim) return false;
    switch (c.combatMode) {
      case "fighting": case "fleeing": case "dead":
        return false;
      case "ufoing":
        return c.role === "alien" && !c.boarded;
      case "reviving":
        return c.revivePhase === "approach";
      case "potionReviving":
        return c.revivePhase !== "openChest" && c.revivePhase !== "use";
      case "drinking":
        return c.drinkPhase !== "open" && c.drinkPhase !== "drink";
      case "depositing":
        return c.depositPhase !== "open";
      case "delivering":
        // Walking up to a wounded ally with a bottle in hand — fine
        // to potshot a passing monster mid-stride; freeze during the
        // actual hand-off beat so the transfer reads cleanly.
        return c.deliverPhase !== "give";
      default:
        // "none", "retreating", "healing": fine to fire while moving.
        return true;
    }
  }

  // Path-safety predicate for non-fighters: a route from `c` to
  // (`tx`,`ty`) is "unsafe" if any live monster sits within
  // PATH_CLEARANCE px of the line, OR within DEST_CLEARANCE px of the
  // destination itself (so e.g. a corpse standing in the middle of a
  // brawl is rejected even if no monster blocks the actual path).
  // Both numbers are tuned to the monster reach (~14..20 px) plus a
  // bit of buffer so the girl bails BEFORE taking her first hit.
  const PATH_CLEARANCE = 38;
  const DEST_CLEARANCE = 56;
  function safePathTo(c, tx, ty) {
    if (Monsters.anyThreat(tx, ty, DEST_CLEARANCE)) return false;
    if (Monsters.anyOnPath(c.x, c.y, tx, ty, PATH_CLEARANCE)) return false;
    // Hydra spit envelope: anyTriaging / fetching errand a non-
    // fighter takes that ends inside the live spit fan is going to
    // get the runner acid-bathed every ~2.5 s, so reject those
    // destinations the same way we'd reject a path that crosses a
    // skeleton.  We allow it when the team is in the push window —
    // head pressure is light enough that the salvo cap (≤ 2 active
    // spits, see HYDRA_SPIT_ACTIVE_CAP) keeps the hit rate
    // survivable AND a healer-on-station can actually keep the
    // runner up.  Outside the push window we'd rather leave a
    // corpse on the ground for one more cycle than trade the
    // reviver for it.
    if (HydraPlan.active() && !HydraPlan.pushWindow()
        && HydraPlan.inSpitDanger(tx, ty)) {
      return false;
    }
    // Head-bite ring: even a destination outside the spit fan is
    // not "safe" if the straight-line walk to it cuts across the
    // hydra body's bite reach.  Without this guard the witch could
    // happily plot a course from the chest back to the cauldron
    // that runs right through the boss's mouth (see
    // hydraPathBlocked) — which is exactly how she "ran toward
    // the hydra from afar".
    if (hydraPathBlocked(c.x, c.y, tx, ty)) return false;
    return true;
  }

  function neediestAlly(c) {
    // Find a visible wounded ally (including self) to heal next.
    // For a non-fighter we additionally refuse to pick an ally we
    // can't reach safely — better to leave one wounded buddy
    // unhealed than to walk straight into the monsters chewing on him
    // and die trying.  The girl uses the relaxed `safeCastFrom`
    // gate (only her standoff tile + path to it has to be clear,
    // not the patient's own tile) so a knight being chewed on by a
    // slime is still a valid heal target — she just stands back and
    // lobs the spell from outside the bite radius.
    const safetyRequired = nonFighter(c);
    const range = healRangeOf(c);
    let best = null, bestFrac = 0.95;
    for (const o of list) {
      if (o === c) continue;
      if (!isVisibleNow(o) || o.hp <= 0) continue;
      if (o.combatMode === "ufoing") continue;
      const f = o.hp / o.maxHp;
      if (f >= bestFrac) continue;
      if (safetyRequired && !safeCastFrom(c, o.x, o.y, range, "heal")) continue;
      bestFrac = f; best = o;
    }
    return best;
  }

  // Only witch, firemage and the girl know how to channel the revive
  // spell.  Everyone else just has to wait it out if they want their
  // comrades back.  A mounted girl is also disqualified — the revive
  // channel is a stationary cast and can't be done from horseback;
  // she has to dismount first (which the auto-dismount logic in
  // tickHealing/tickRetreating triggers when a fresh corpse appears).
  function canRevive(c) {
    if (c.mounted) return false;
    return isChannelReviver(c);
  }

  // Classwise "has the channel-revive spell in their kit" check.
  // Differs from `canRevive` in that it IGNORES mount state — used
  // by the spare-revive bookkeeping around the chest / potion
  // errands, which cares whether the hero can ever cast the revive,
  // not whether they could cast it right this frame.  Without this
  // split, a mounted girl looked like a "non-reviver" to those
  // gates and would grab a spare revive bottle alongside her heal
  // (visible as the green bottle bobbing on her shoulder), which is
  // nonsense — she channels the revive for free once she dismounts,
  // so carrying the bottle just burns chest stock another hero
  // actually needs.  Same reasoning keeps the four "errand
  // aborted, restash the held bottle as a spare" fallbacks from
  // attaching a bottle to a mounted channel-reviver.
  function isChannelReviver(c) {
    return c.name === "witch" || c.name === "firemage" || c.name === "girl";
  }

  // Closest ally currently in a `fighting` combat mode within the
  // given radius, if any.  Used for the "buddy backup" behaviour: a
  // bystander sees a friend brawling and either joins in or flees.
  function nearestFightingAlly(c, range) {
    let best = null, bestD = Infinity;
    for (const o of list) {
      if (o === c) continue;
      if (o.combatMode !== "fighting") continue;
      if (!o.combatTarget || o.combatTarget.dying) continue;
      if (!isVisibleNow(o)) continue;
      const d = Math.hypot(o.x - c.x, o.y - c.y);
      if (d < bestD && d < range) { bestD = d; best = o; }
    }
    return best;
  }

  // Closest monster threatening any allied healer that THIS character
  // can plausibly defend, or null.  A "threat" is a non-buried, non-
  // dying monster within HEALER_GUARD_R of a healer who is herself
  // alive, on stage, and not already fleeing / down (no point sending
  // backup to defend a corpse or someone who's already legged it
  // offstage).  We additionally gate on the defender being within
  // HEALER_GUARD_DEFENDER_R of the healer so far-off heroes don't
  // sprint half a screen to peel a slime off her — at that point
  // someone closer should react.  Returns the nearest qualifying
  // monster across all qualifying healers so a defender always picks
  // the most urgent threat in their guard radius rather than fixating
  // on one specific medic.
  function monsterChasingHealer(c) {
    let best = null, bestD = Infinity;
    for (const h of list) {
      if (h === c) continue;
      if (h.role !== "healer") continue;
      if (h.hp <= 0) continue;
      if (!isVisibleNow(h)) continue;
      if (h.combatMode === "fleeing" || h.combatMode === "dead") continue;
      if (Math.hypot(h.x - c.x, h.y - c.y) > HEALER_GUARD_DEFENDER_R) continue;
      for (const m of Monsters.list) {
        if (m.dying || m.fleeing) continue;
        if (Monsters.isHidden(m, c)) continue;
        const dm = Math.hypot(m.x - h.x, m.y - h.y);
        if (dm > HEALER_GUARD_R) continue;
        if (dm < bestD) { bestD = dm; best = m; }
      }
    }
    return best;
  }

  // A healer who's currently in a state where they can actually help
  // — on stage and not already running/dead — is used as the "safe
  // haven" for the retreat behaviour.  Returns null if none available
  // (in which case the retreat falls back to the chest or just
  // distance from the threat).
  function findSafeHealer(c) {
    for (const o of list) {
      if (o === c) continue;
      if (o.role !== "healer") continue;
      if (!isVisibleNow(o)) continue;
      if (o.combatMode === "fleeing" || o.combatMode === "dead") continue;
      if (o.combatMode === "ufoing") continue;
      return o;
    }
    return null;
  }

  // Closest ally currently in shape to act as a panic-flee destination
  // — a healer to mend us, or a reviver in case we don't make it and
  // need to be picked back up.  Same eligibility rules as
  // findSafeHealer (alive, on-stage, not panicking themselves, not
  // sitting in the saucer) so we don't sprint TOWARD a comrade
  // who's already legged it offstage.  Returns the closest viable
  // ally with its straight-line distance, or [null, Infinity].
  // Caller is responsible for deciding whether the path is actually
  // safe and the distance is short enough to bother with.
  function nearestSafeFleeAlly(c) {
    let best = null, bestD = Infinity;
    for (const o of list) {
      if (o === c) continue;
      if (o.role !== "healer" && !canRevive(o)) continue;
      if (!isVisibleNow(o)) continue;
      if (o.hp <= 0) continue;
      if (o.combatMode === "fleeing" || o.combatMode === "dead") continue;
      if (o.combatMode === "ufoing") continue;
      const d = Math.hypot(o.x - c.x, o.y - c.y);
      if (d < bestD) { bestD = d; best = o; }
    }
    return [best, bestD];
  }

  // Pick a panic-flee refuge — the alien's parked saucer for himself,
  // or the closest safe healer / reviver-capable ally for everyone
  // else — IF (and only if) it's safer to run there than to bolt for
  // the screen edge `(edgeX, edgeY)` we already chose.  Returns a
  // refuge descriptor consumed by tickFleeing, or null when the
  // hero should stick to the offstage exit.
  //
  // Eligibility: distance must be inside the role-specific cap AND
  // strictly closer than the edge by FLEE_REFUGE_EDGE_BIAS, AND the
  // straight-line path has to currently be free of monster threats
  // (`safePathTo`).  This is intentionally conservative — we'd
  // rather run for the edge than bait someone into a corridor that
  // turns out to be full of slimes.
  function findFleeRefuge(c, edgeX, edgeY) {
    const edgeD = Math.hypot(edgeX - c.x, edgeY - c.y);
    if (c.role === "alien") {
      const ufo = Scene.ufo();
      if (!ufo) return null;
      const d = Math.hypot(ufo.x - c.x, ufo.y - c.y);
      if (d > FLEE_REFUGE_UFO_MAX_DIST) return null;
      // Alien-specific priority: if the saucer is reachable and the
      // route is currently safe, prefer panic-running to the UFO over
      // bolting offstage even when the selected edge is a bit closer.
      // This avoids the "ran left off-screen while my UFO stood right"
      // behaviour and keeps his unique survival loop (panic-board,
      // immediate lift-off, keep contributing) intact.
      if (!safePathTo(c, ufo.x, ufo.y)) return null;
      return { kind: "ufo", x: ufo.x, y: ufo.y };
    }
    const [ally, d] = nearestSafeFleeAlly(c);
    if (!ally) return null;
    if (d > FLEE_REFUGE_ALLY_MAX_DIST) return null;
    if (d > edgeD * FLEE_REFUGE_EDGE_BIAS) return null;
    if (!safePathTo(c, ally.x, ally.y)) return null;
    return { kind: "ally", x: ally.x, y: ally.y, ref: ally };
  }

  // Is *anyone* on stage currently hurt below the given threshold?
  // Used by the witch to decide whether to drop her wandering and
  // rush back to the cauldron, and by the brew tick to force a
  // heal (not a revive) and accelerate the bubbling.  The dying /
  // down don't count — they need a revive, not a heal.  Default
  // threshold is the "looks sickly" 0.7 so the witch starts worrying
  // before her friends are already in retreat-territory; pass an
  // explicit number for branches that want a tighter / looser
  // definition of "hurt".
  const HURT_ALLY_DEFAULT = 0.7;
  function anyHurtAlly(threshold) {
    const t = (typeof threshold === "number") ? threshold : HURT_ALLY_DEFAULT;
    for (const o of list) {
      if (o.hp <= 0) continue;
      if (o.combatMode === "dead") continue;
      if (!isVisibleNow(o)) continue;
      if (o.hp < o.maxHp * t) return true;
    }
    return false;
  }

  // ---- healing flower errand ----------------------------------------
  //
  // The girl tends a small herb patch (the flower station) and
  // every BLOOM_GROW_MS of station-time produces a single bright
  // bloom (capped at BLOOM_CAP).  Any wounded hero strolling by can
  // detour to pluck one for an instant +FLOWER_PICK_HEAL HP.
  //
  // We keep the trigger conservative so the lawn doesn't turn into
  // a flower-rush mosh pit:
  //   • Only heroes already meaningfully hurt (HP < 0.85) qualify.
  //   • Re-checked at most once every FLOWER_PICK_INTERVAL_MS per
  //     hero, with FLOWER_PICK_PROB chance per check, so even a
  //     thoroughly wounded brawler will sometimes shrug it off.
  //   • Skips heroes who are mid-combat, fleeing, retreating, or
  //     already running an errand of their own (potion, deposit,
  //     revive…).  And skips the girl herself — she gets her buff
  //     by tending, not by plucking.
  //   • Skips the trip if a monster is within FLOWER_PICK_SAFETY_R
  //     of the patch — picking flowers under a slime's nose is a
  //     great way to get bitten.
  // Once committed, the bloom is decremented immediately (so two
  // heroes can't claim the same one) and consumed on arrival.  If
  // the errand gets aborted (combat starts mid-walk), the bloom is
  // simply lost — easier than refunding it and effectively just
  // means the flower wilted.
  function maybeFlowerErrand(c, now) {
    if (c.flowerErrand) return false;
    if (c.combatMode !== "none") return false;
    if (c.state !== "wandering" && c.state !== "working") return false;
    if (c.name === "girl") return false;
    if (c.hp >= c.maxHp * FLOWER_PICK_HP_FRACTION) return false;
    if (c.hp <= 0) return false;
    if (now - (c.flowerErrandCheckAt || 0) < FLOWER_PICK_INTERVAL_MS) return false;
    c.flowerErrandCheckAt = now;
    const garden = Scene.activity("girl");
    if (!garden || (garden.bloom | 0) <= 0) return false;
    if (Monsters.anyThreat(garden.x, garden.y, FLOWER_PICK_SAFETY_R)) return false;
    if (nonFighter(c) && !safePathTo(c, garden.x, garden.y)) return false;
    if (Math.random() > FLOWER_PICK_PROB) return false;
    garden.bloom = Math.max(0, (garden.bloom | 0) - 1);
    c.flowerErrand = true;
    c.state = "wandering";
    c.wandersLeft = Math.max(c.wandersLeft, 1);
    setTarget(c, garden.x, garden.y);
    return true;
  }

  function consumeFlowerErrand(c) {
    if (!c.flowerErrand) return;
    c.flowerErrand = false;
    Combat.healHero(c, FLOWER_PICK_HEAL, "heal");
    Dialog.bark(c, "drink");
  }

  // "I'm bleeding and the lawn is calm — let me park by the fire
  // for a bit and tick HP back up."  Sends any wounded non-zombie
  // hero to the burning campfire so the passive regen tick in
  // tickStations actually has time to do something.  Without this
  // the AI happily wandered RIGHT PAST the fire (the regen branch
  // only fired when the wander route happened to clip the hex by
  // chance — usually for half a second, then the hero kept
  // walking).  The zombie has his own grave (maybeRestAtGrave).
  function maybeWarmAtFire(c, now) {
    if (c.warmErrand || c.flowerErrand || c.trainErrand) return false;
    if (c.combatMode !== "none") return false;
    if (c.state !== "wandering") return false;
    // Zombie and robot don't get HP from the fire (the campfire AoE
    // regen filters them out), so don't bother routing them there
    // for a top-up — it'd just be a wasted detour.  The zombie has
    // his grave (maybeRestAtGrave); the robot has the oilcan.
    if (c.name === "zombie" || c.name === "robot") return false;
    if (c.brewReady || c.heldPotion) return false;
    if (c.hp <= 0) return false;
    if (c.hp >= c.maxHp * WARM_HP_FRACTION) return false;
    if (now - (c.warmErrandCheckAt || 0) < WARM_INTERVAL_MS) return false;
    c.warmErrandCheckAt = now;
    if (!Scene.campfireBurning || !Scene.campfireBurning()) return false;
    const fire = Scene.activity("firemage");
    if (!fire) return false;
    if (Monsters.anyThreat(fire.x, fire.y, WARM_SAFETY_R)) return false;
    // Already parked inside the regen hex — the standard tick is
    // already handling us, no need to retarget.
    if (Math.hypot(c.x - fire.x, c.y - fire.y) < CAMPFIRE_REGEN_R - 6) return false;
    if (nonFighter(c) && !safePathTo(c, fire.x, fire.y)) return false;
    c.warmErrand = true;
    // Slight jitter so two heroes warming together don't pile onto
    // the same pixel.
    setTarget(c, fire.x + rr(-10, 10), fire.y + rr(-6, 6));
    return true;
  }

  // Firemage version of "swing back to your station for a top-up":
  // when his "infused" buff is missing or about to lapse and the
  // lawn is calm, jog back to the campfire to charge up before
  // wandering off again.  Same shape as maybeWarmAtFire (safety
  // gate, throttle, "already in the hex" early-out) but the trigger
  // is buff state, not HP — the firemage tops up at full HP too,
  // because the buff is what makes his fireballs hit hard.
  function maybeChargeAtFire(c, now) {
    if (c.name !== "firemage") return false;
    if (c.combatMode !== "none") return false;
    if (c.state !== "wandering") return false;
    if (c.warmErrand || c.flowerErrand || c.trainErrand || c.chargeErrand)
      return false;
    if (c.brewReady || c.heldPotion) return false;
    if (!Scene.campfireBurning || !Scene.campfireBurning()) return false;
    const fire = Scene.activity("firemage");
    if (!fire) return false;
    // Hydra-rally pre-engage top-up.  A boss fight will easily
    // outlast a fresh 14-s "infused" buff, so during the rally
    // window we want to charge regardless of how much time the
    // buff currently has on the clock — provided the side-trip
    // still fits before HYDRA_RALLY_MAX_MS expires and engage
    // starts without him.  This bypasses BOTH the regular
    // CHARGE_INTERVAL_MS throttle (we want to react the same tick
    // the boss appears, not 3.5 s later) AND the "buff already
    // healthy" early-out (peacetime saves him the walk; a hydra
    // fight is the opposite — every infused fireball lands ~+45 %
    // damage, so paying 1-2 s up front for a 14-s damage uplift
    // across a 60+ s fight is a strict win when the budget allows).
    // Time budget: walk to fire + one soak tick must finish before
    // engage; he doesn't need to walk BACK before engage because
    // he can start the journey to his stance with the buff already
    // active.  500 ms safety margin so a borderline-fit doesn't
    // strand him at the fire when engage flips early.
    const inBossRally = HydraPlan && HydraPlan.active && HydraPlan.active()
      && HydraPlan.inRallyPhase && HydraPlan.inRallyPhase();
    if (inBossRally) {
      if (Monsters.anyThreat(fire.x, fire.y, CHARGE_SAFETY_R)) return false;
      if (!safePathTo(c, fire.x, fire.y)) return false;
      const dToFire = Math.hypot(c.x - fire.x, c.y - fire.y);
      const walkMs  = (dToFire / SPEED) * 1000;
      const soakMs  = BUFF_REFRESH_MS + 300;
      const available = HYDRA_RALLY_MAX_MS - HydraPlan.rallyAgeMs(now) - 500;
      if (walkMs + soakMs > available) return false;
      c.chargeErrand = true;
      c.chargeErrandCheckAt = now;
      // If he's already inside the buff radius the activate() rally
      // nudge has just retargeted him AWAY from the fire — without
      // re-pinning here he'd trot out of the radius before the buff
      // loop could land a single tick.  A small wiggle target keeps
      // him centred in the hex until the buff lands and the working-
      // state park (set by arrivedAt's chargeErrand branch) takes
      // over.  Otherwise jog toward the fire as usual.
      if (dToFire < CAMPFIRE_REGEN_R - 6) {
        setTarget(c, c.x + rr(-3, 3), c.y + rr(-3, 3));
      } else {
        setTarget(c, fire.x + rr(-8, 8), fire.y + rr(-4, 4));
      }
      return true;
    }
    if (now - (c.chargeErrandCheckAt || 0) < CHARGE_INTERVAL_MS) return false;
    c.chargeErrandCheckAt = now;
    // Buff already healthy with plenty of time left?  Don't bother
    // — let him keep wandering / sniping.  The threshold is large
    // enough that he tops up well before the buff lapses, so a
    // monster wave doesn't catch him cold.
    const remain = Math.max(0, (c.workBuffUntil || 0) - now);
    if (c.workBuffKind === "infused" && remain > CHARGE_LOW_REMAIN_MS)
      return false;
    if (Monsters.anyThreat(fire.x, fire.y, CHARGE_SAFETY_R)) return false;
    // Already standing in the buff radius — the per-frame buff loop
    // is already topping him up, no need to retarget.
    if (Math.hypot(c.x - fire.x, c.y - fire.y) < CAMPFIRE_REGEN_R - 6)
      return false;
    if (!safePathTo(c, fire.x, fire.y)) return false;
    c.chargeErrand = true;
    setTarget(c, fire.x + rr(-8, 8), fire.y + rr(-4, 4));
    return true;
  }

  // Zombie equivalent of maybeWarmAtFire.  His grave's regen tick
  // is faster (GRAVE_REGEN_*) and only triggers for him, so any
  // wounded zombie just standing around should make a beeline for
  // home instead of waiting for the wander cycle to loop him back
  // there.  Higher HP threshold so even a small scratch sends him
  // home — being undead, he loves his grave.
  // Panic-flee dispatch for the zombie.  Returns one of:
  //   "hold"     — already on top of the grave, dying here arms the
  //                green-pillar self-revive; engage the threat (or
  //                stand still if there isn't one) instead of
  //                running offstage.
  //   "approach" — within walking distance of the grave AND the path
  //                home is clear; head back to die at home rather
  //                than burning the offstage timer.
  //   "flee"     — too far / route blocked; fall through to the
  //                regular off-stage flee.  In this case the
  //                offstage HP reset is the only safe option left.
  // Used as the first branch of startFleeing for the zombie.  Kept
  // as its own helper so the threshold logic (and the "what counts
  // as a safe walk back" gate) lives in one place rather than being
  // duplicated at every panic-flee call site.
  function zombieGraveDeathStrategy(c) {
    if (c.name !== "zombie") return "flee";
    const grave = Scene.activity && Scene.activity("zombie");
    if (!grave) return "flee";
    const d = Math.hypot(c.x - grave.x, c.y - grave.y);
    if (d <= ZOMBIE_GRAVE_HOLD_R) return "hold";
    if (d <= ZOMBIE_GRAVE_WALK_BACK_R && safePathTo(c, grave.x, grave.y)) {
      return "approach";
    }
    return "flee";
  }

  function maybeRestAtGrave(c, now) {
    if (c.name !== "zombie") return false;
    if (c.combatMode !== "none") return false;
    if (c.state !== "wandering") return false;
    if (c.restErrand) return false;
    if (c.hp <= 0) return false;
    if (c.hp >= c.maxHp * REST_HP_FRACTION) return false;
    if (now - (c.restErrandCheckAt || 0) < REST_INTERVAL_MS) return false;
    c.restErrandCheckAt = now;
    const grave = Scene.activity("zombie");
    if (!grave) return false;
    if (Math.hypot(c.x - grave.x, c.y - grave.y) < GRAVE_REGEN_R - 4) return false;
    c.restErrand = true;
    setTarget(c, grave.x + rr(-6, 6), grave.y + rr(-4, 4));
    return true;
  }

  // The archer's training station is a target on a stake — he should
  // stand BACK and shoot at it instead of nudging the bullseye with
  // his nose.  Other ranged trainees who drift to the same prop are
  // visitors borrowing the rapidFire buff: they keep the close-range
  // visit (the existing buff radius handles them via tickStations'
  // standard buff loop), so this gate is archer-only.
  function wantsRangedAtTarget(c) {
    return c.name === "archer" && c.activity && c.activity.item === "target";
  }

  // Where this hero wants to STAND while working at his own activity.
  // Almost everyone parks right on top of their station; the archer
  // is the lone exception and parks TRAIN_RANGED_OFFSET px to the
  // open side of the lawn from his target so his arrows have room
  // to fly.  Mirrored automatically when the natural stand-off
  // would walk him off-screen.
  function trainingPos(c) {
    const a = c.activity;
    if (!a) return null;
    if (wantsRangedAtTarget(c)) {
      let sx = a.x - TRAIN_RANGED_OFFSET;
      if (sx < 30) sx = a.x + TRAIN_RANGED_OFFSET;
      sx = Math.max(20, Math.min(Scene.WIDTH - 20, sx));
      return { x: sx, y: a.y };
    }
    return { x: a.x, y: a.y };
  }

  // Same spot, with a few pixels of jitter so successive working
  // stays don't snap to the exact same pixel — used by the wander →
  // working transition where the hero is picking a fresh resting
  // tile, not just confirming an already-claimed one (the latter
  // uses the un-jittered version so the AI's safety / proximity
  // checks stay deterministic frame-to-frame).
  function trainingPosJittered(c) {
    const p = trainingPos(c);
    if (!p) return null;
    const jx = wantsRangedAtTarget(c) ? 4 : 6;
    const jy = wantsRangedAtTarget(c) ? 4 : 4;
    return { x: p.x + rr(-jx, jx), y: p.y + rr(-jy, jy) };
  }

  // "Walked past my own station, no buff on the clock — let me grab
  // a quick training tick."  Mirrors the shape of maybeFlowerErrand:
  // throttled, gated on safety, and only commits when the hero is
  // actually free (not in combat, not chained into a bottle errand,
  // not already running a flower / train detour).  Heroes whose own
  // station doesn't grant a personal buff (witch's cauldron,
  // firemage's campfire, ninja's chest, zombie's grave, alien's UFO)
  // skip the branch entirely — they're not "training" stations in
  // the buff sense, just their day jobs.
  function maybeTrainErrand(c, now) {
    if (!c.activity) return false;
    if (c.combatMode !== "none") return false;
    if (c.state !== "wandering") return false;
    if (c.flowerErrand || c.trainErrand) return false;
    if (c.brewReady || c.heldPotion) return false;
    if (now - (c.trainErrandCheckAt || 0) < TRAIN_ERRAND_INTERVAL_MS) return false;
    c.trainErrandCheckAt = now;
    if (!stationBuffFor(c.name, c)) return false;
    if ((c.workBuffUntil || 0) > now + TRAIN_BUFF_FRESH_MS) return false;
    if (Monsters.anyThreat(c.x, c.y, TRAIN_THREAT_R)) return false;
    if (Monsters.anyThreat(c.activity.x, c.activity.y, TRAIN_THREAT_R)) return false;
    const tp = trainingPos(c);
    if (!tp) return false;
    if (!safePathTo(c, tp.x, tp.y)) return false;
    c.trainErrand = true;
    setTarget(c, tp.x + rr(-3, 3), tp.y + rr(-3, 3));
    return true;
  }

  // ---- station buffs ------------------------------------------------
  //
  // Three multipliers folded into combat math:
  //
  //   c.dmgMul   →  outgoing melee/ranged damage   (Combat.heroAttack)
  //   c.cdMul    →  attack cooldown                (effectiveCd below)
  //   c.healMul  →  outgoing heal amount (girl)    (effectiveHeal)
  //
  // They reset to 1 every frame in `recomputeStationMuls` and then a
  // small set of context-dependent rules layer in:
  //
  //   • workBuffKind / workBuffUntil  → atkBoost / rapidFire / oiled /
  //     healPower granted by spending time at a station
  //   • robot's lastOilAt              → oiled vs rusty cooldown
  //
  // Because everything funnels through the three muls, downstream
  // combat code stays oblivious — it just calls effectiveCd / Dmg /
  // Heal and gets the right number for the current frame.
  function effectiveCd(c)   { return c.atk.cdMs * (c.cdMul || 1); }
  function effectiveDmg(c)  { return c.atk.dmg  * (c.dmgMul || 1); }
  function effectiveHeal(c, amount) { return Math.round(amount * (c.healMul || 1)); }

  // Apply (or refresh) a "I just used my station" buff.  durMs is
  // additive on top of any time already left, so a hero camped at
  // their dummy keeps stacking duration up to a generous ceiling
  // instead of resetting the timer every tick.
  function applyWorkBuff(c, kind, durMs, now) {
    const cur = Math.max(c.workBuffUntil || 0, now);
    const newUntil = Math.min(now + durMs * 2, cur + durMs);
    c.workBuffKind = kind;
    c.workBuffUntil = newUntil;
  }

  function recomputeStationMuls(c, now) {
    c.dmgMul = 1;
    c.cdMul = 1;
    c.healMul = 1;
    if (!c.atk) {
      // Healer (girl): only the heal mul matters and that's set
      // below by the workBuff branch.
    }
    // Active station buff?
    if (c.workBuffUntil > now) {
      switch (c.workBuffKind) {
        case "atkBoost":  c.dmgMul  = ATK_BOOST_MUL;  break;
        case "rapidFire": c.cdMul   = RAPID_FIRE_MUL; break;
        case "oiled":     c.cdMul   = OILED_MUL;      break;
        case "healPower": c.healMul = HEAL_POWER_MUL; break;
        case "infused":   c.dmgMul  = INFUSED_DMG_MUL;
                          c.cdMul   = INFUSED_CD_MUL; break;
      }
    } else {
      c.workBuffKind = null;
    }
    // War-cry pulse: applied when the hydra fight transitions from
    // RALLY to ENGAGE to anyone who actually showed up at the rally
    // point.  Stacks ON TOP of station buffs (so a charged firemage
    // who joined rally gets infused × warcry) — it's a small bump for
    // formation discipline, not a replacement for prep.
    if ((c.warCryUntil || 0) > now) {
      c.dmgMul  *= HYDRA_WARCRY_DMG_MUL;
      c.cdMul   *= HYDRA_WARCRY_CD_MUL;
      c.healMul *= HYDRA_WARCRY_HEAL_MUL;
    } else if (c.warCryUntil) {
      c.warCryUntil = 0;
    }
    // Robot's "rusty" penalty: if it's been too long since his last
    // oil and he isn't currently riding the oiled buff, his combat
    // cooldown gets stretched out a bit until he tops up.  This
    // gives the oilcan a real ongoing job instead of a one-off
    // pit-stop buff.
    if (c.name === "robot" && c.workBuffKind !== "oiled") {
      if (c.lastOilAt > 0 && now - c.lastOilAt > OIL_DECAY_MS) {
        c.cdMul = RUSTY_MUL;
      }
    }
    // Social bonuses stack ON TOP of the station buff above (they
    // multiply the existing muls, not replace them) so a pacted
    // knight who just touched the dummy gets both the morale +10 %
    // and the dummy's atkBoost.  Both are short-lived; both clear
    // themselves once their respective `until` lapses.
    if (c.moraleUntil > now) {
      c.dmgMul  *= MORALE_DMG_MUL;
      c.healMul *= MORALE_HEAL_MUL;
    }
    if (c.lookoutUntil > now) {
      c.dmgMul  *= LOOKOUT_DMG_MUL;
    }
    // Viking berserk fury: a brutal damage spike that lasts a few
    // seconds when the viking dips low on HP.  Stacks multiplicatively
    // on top of stump / morale / lookout because the fiction is a
    // berserker rage, not a station drill.
    if (c.berserkUntil > now) {
      c.dmgMul *= BERSERK_DMG_MUL;
    }
  }

  // What buff (if any) does `c` get from spending time at the
  // station owned by `ownerName`?  null = ownerName's station is
  // off-limits to this character (e.g. the witch can't train at
  // the punching dummy — visually wrong).  The set of "shared"
  // stations is small and curated:
  //
  //   • dummy (knight)    — knight, viking
  //   • target (archer)   — archer, firemage, witch, ninja
  //   • stump (viking)    — viking, knight
  //   • oilcan (robot)    — robot only
  //   • flowers (girl)    — girl only
  //   • campfire (firemage) — firemage only, requires the fire to
  //                           actually be burning (no charge from
  //                           cold embers)
  //
  // Other stations (cauldron, gravestone, chest, UFO) are role-
  // specific and don't grant a portable combat buff at all — they
  // have their own dedicated mechanics (brewing, regen, AoE warmth,
  // etc.).
  function stationBuffFor(ownerName, c) {
    switch (ownerName) {
      case "knight":
        if (c.name === "knight" || c.name === "viking")
          return { kind: "atkBoost", ms: ATK_BOOST_MS };
        return null;
      case "archer":
        if (c.name === "archer" || c.name === "firemage" ||
            c.name === "witch"  || c.name === "ninja")
          return { kind: "rapidFire", ms: RAPID_FIRE_MS };
        return null;
      case "viking":
        if (c.name === "viking" || c.name === "knight")
          return { kind: "atkBoost", ms: ATK_BOOST_MS };
        return null;
      case "robot":
        if (c.name === "robot")
          return { kind: "oiled", ms: OILED_MS };
        return null;
      case "girl":
        if (c.name === "girl")
          return { kind: "healPower", ms: HEAL_POWER_MS };
        return null;
      case "firemage":
        // Cold campfire = no charge.  The campfire's regen AoE is a
        // separate system (always-on as long as it's burning); this
        // is the firemage's personal damage / cooldown buff.
        if (c.name === "firemage" &&
            Scene.campfireBurning && Scene.campfireBurning())
          return { kind: "infused", ms: INFUSED_MS };
        return null;
    }
    return null;
  }

  // Training-time visual + buff-tick pass.  Runs AFTER moveStep in
  // step(), because moveStep snaps c.frame back to 0 when the hero
  // is stationary — putting the animation tick before that would
  // make the swing/draw animation invisible.  Conditions:
  //   • currently in the working state at our own activity;
  //   • close enough to the station to count as "at" it (extra
  //     room for the archer's standoff);
  //   • lawn calm (no monsters within TRAIN_THREAT_R);
  //   • the station actually grants this hero a training buff
  //     (so e.g. the witch idling at her cauldron isn't repurposed
  //     into a "training" loop — she's brewing, not sparring).
  // For the archer specifically this also fires a no-damage
  // arrow at the bullseye and applies the rapidFire buff
  // explicitly (his standoff is well outside the radius the
  // generic buff loop handles).
  function tickTrainingFx(c, dt, now) {
    if (c.combatMode !== "none") return;
    if (c.state !== "working") return;
    if (!c.activity) return;
    if (Monsters.anyThreat(c.x, c.y, TRAIN_THREAT_R)) return;
    if (!stationBuffFor(c.name, c)) return;
    const a = c.activity;
    const ranged = wantsRangedAtTarget(c);
    const nearR = ranged ? TRAIN_RANGED_OFFSET + 24 : 28;
    const dx = c.x - a.x, dy = c.y - a.y;
    if (dx * dx + dy * dy >= nearR * nearR) return;
    c.dir = a.x >= c.x ? "r" : "l";
    c.frameTimer += dt;
    if (c.frameTimer >= TRAIN_FRAME_MS) {
      c.frameTimer = 0;
      c.frame ^= 1;
    }
    if (ranged && a.item === "target" &&
        now - (c.lastTrainShotAt || 0) > TRAIN_SHOT_INTERVAL_MS) {
      c.lastTrainShotAt = now;
      const sx = c.x + (c.dir === "r" ? 4 : -4);
      const sy = c.y - 16;
      const dstX = a.x + rr(-3, 3);
      const dstY = a.y - 24 + rr(-3, 3);
      const station = a;
      Combat.trainingShot("arrow", sx, sy, dstX, dstY, () => {
        station.arrows = Math.min(7, (station.arrows | 0) + 1);
        station.lastShot = performance.now();
        station.lastArrowDecayAt = performance.now();
      });
      if (now - (c.lastBuffTickAt || 0) > BUFF_REFRESH_MS) {
        applyWorkBuff(c, "rapidFire", RAPID_FIRE_MS, now);
        c.lastBuffTickAt = now;
        recomputeStationMuls(c, now);
      }
    }
  }

  // Per-frame "what's the lawn doing for this character right now?"
  // pass.  Updates buff multipliers, runs station side-effects (chops
  // logs, blooms flowers, ticks regen at the campfire and gravestone)
  // and grants buffs to anyone lingering near a compatible station.
  function tickStations(c, dt, now) {
    recomputeStationMuls(c, now);
    if (c.combatMode === "dead") return;
    if (c.state === "offstage") return;

    // Stuck arrows on the practice target slowly fall out / rot off
    // the bullseye so the prop doesn't pile up to the cap and stay
    // there forever.  Driven once per frame off the archer's tick
    // (any character would do — the timer is on the station, not
    // the character — but the archer is always around when the
    // target exists, so it's the natural driver).  ARROW_DECAY_MS
    // is slow enough that an active archer will easily out-pace it
    // and keep the quiver visible during practice, fast enough that
    // a quiet stretch clears the target inside ~half a minute.
    if (c.name === "archer") {
      const tgt = Scene.activity("archer");
      if (tgt && (tgt.arrows | 0) > 0) {
        const last = tgt.lastArrowDecayAt || tgt.lastShot || 0;
        if (now - last > ARROW_DECAY_MS) {
          tgt.arrows = Math.max(0, (tgt.arrows | 0) - 1);
          tgt.lastArrowDecayAt = now;
        }
      }
    }

    // Campfire AoE regen — applies to everyone alive on stage who
    // walks (or stops) near the fire while it's burning.  It ignores
    // ufo flight (the saucer is too far away anyway).  Two characters
    // are explicitly excluded: the zombie (undead don't warm to an
    // open flame; his restoration source is the gravestone, handled
    // below) and the robot (mechanical chassis, no biology to mend —
    // his upkeep comes from the oilcan, not heat).
    const campfire = Scene.activity("firemage");
    if (campfire && Scene.campfireBurning() &&
        c.combatMode !== "ufoing" && c.hp > 0 && c.hp < c.maxHp &&
        c.name !== "zombie" && c.name !== "robot") {
      const d = Math.hypot(c.x - campfire.x, c.y - campfire.y);
      if (d < CAMPFIRE_REGEN_R && now - (c.lastRegenAt || 0) > CAMPFIRE_REGEN_MS) {
        c.lastRegenAt = now;
        c.hp = Math.min(c.maxHp, c.hp + CAMPFIRE_REGEN_HP);
      }
    }

    // Alien recharging on the pad: while he's grounded (cooldown
    // window between sorties OR taking a stroll), the saucer's
    // battery refills fast.  By the time he's allowed to board
    // again it's at full charge for the next strafing run.
    if (c.role === "alien" && c.combatMode !== "ufoing") {
      c.ufoEnergy = Math.min(
        UFO_ENERGY_MAX,
        (c.ufoEnergy != null ? c.ufoEnergy : UFO_ENERGY_MAX)
          + UFO_ENERGY_GND_REGEN_PER_S * dt / 1000,
      );
      const u = Scene.ufo();
      if (u) { u.ufoEnergy = c.ufoEnergy; u.ufoEnergyMax = UFO_ENERGY_MAX; }
    }

    // Zombie at his own grave: stronger regen tick, only for him.
    // Marks the grave as "visited" so the green wisps render in
    // drawGravestone.
    if (c.name === "zombie") {
      const grave = Scene.activity("zombie");
      if (grave && c.hp > 0 && c.hp < c.maxHp) {
        const dg = Math.hypot(c.x - grave.x, c.y - grave.y);
        if (dg < GRAVE_REGEN_R) {
          if (now - (c.lastGraveRegenAt || 0) > GRAVE_REGEN_MS) {
            c.lastGraveRegenAt = now;
            c.hp = Math.min(c.maxHp, c.hp + GRAVE_REGEN_HP);
          }
          grave.lastVisit = now;
        }
      }
    }

    // Buff grant: only fires while the hero is in a "lingering"
    // state — working at a station or wandering near it without
    // being mid-combat.  We loop the small set of buffable
    // stations (dummy/target/stump/oilcan/flowers) and check each
    // for proximity + compatibility.
    if (c.combatMode === "none" &&
        (c.state === "working" || c.state === "wandering")) {
      const ownerNames = ["knight", "archer", "viking", "robot", "girl", "firemage"];
      for (const owner of ownerNames) {
        const station = Scene.activity(owner);
        if (!station) continue;
        const dx = c.x - station.x, dy = c.y - station.y;
        // Campfire's "absorb" radius matches its regen hex so the
        // firemage doesn't have to nose-press the embers; every
        // other station keeps the tighter 24 px contact range.
        const r = (owner === "firemage") ? CAMPFIRE_REGEN_R : 24;
        if (dx * dx + dy * dy > r * r) continue;
        const buff = stationBuffFor(owner, c);
        if (!buff) continue;
        if (now - (c.lastBuffTickAt || 0) < BUFF_REFRESH_MS) break;
        c.lastBuffTickAt = now;
        applyWorkBuff(c, buff.kind, buff.ms, now);
        // Fire the station's own visual side-effect for this tick:
        // dummy flinches, the stump shows a fresh chop, the target
        // catches another arrow, the oilcan drips, flowers bloom.
        switch (owner) {
          case "knight":
            station.lastHit = now;
            break;
          case "viking":
            station.lastChop = now;
            // Knight chopping at the stump still produces logs but
            // less efficiently than the resident viking.  Capped so
            // the stockpile never gets out of hand.
            if (now - (c.lastChopAt || 0) >
                CHOP_INTERVAL_MS * (c.name === "viking" ? 1 : 1.6) &&
                (station.logs | 0) < STUMP_LOG_CAP) {
              station.logs = (station.logs | 0) + 1;
              c.lastChopAt = now;
            }
            break;
          case "archer":
            if (c.name === "firemage") {
              // Wrong tool for the job: a fire-mage doesn't pluck a
              // bow off the rack to plink the bullseye, he lobs a
              // small fireball at it.  The buff he gets is the same
              // (rapidFire == cd reduction == "feels snappier"), the
              // visual is appropriate to his kit.  As a bonus the
              // impact incinerates whatever arrows the archer left
              // stuck in the target — they don't survive a direct
              // fireball hit, and the prop briefly shows scorch
              // marks for a beat afterwards (drawTarget reads
              // station.firedAt).  No bow visit until the embers
              // cool, so the arrow count will repopulate naturally
              // once the archer comes back to practice.
              c.dir = station.x >= c.x ? "r" : "l";
              const sx = c.x + (c.dir === "r" ? 4 : -4);
              const sy = c.y - 16;
              const dstX = station.x + rr(-3, 3);
              const dstY = station.y - 24 + rr(-3, 3);
              Combat.trainingShot("fireball", sx, sy, dstX, dstY, () => {
                const nowMs = performance.now();
                station.arrows = 0;
                station.firedAt = nowMs;
                station.lastShot = nowMs;
                station.lastArrowDecayAt = nowMs;
              });
            } else {
              station.lastShot = now;
              station.arrows = Math.min(7, (station.arrows | 0) + 1);
              // Reset the decay clock too — if an arrow just landed,
              // we don't want the very next frame to immediately
              // strip one off because the previous decay tick was
              // overdue.  Tick from "now" instead.
              station.lastArrowDecayAt = now;
            }
            break;
          case "robot":
            station.lastOil = now;
            c.lastOilAt = now;
            // Visible oil-spritz from the can spout to the robot's
            // chest so the recharge actually reads on screen — the
            // tiny brassy pip above his head was easy to miss.
            // Spout tip is ~22px above the can's anchor and ~11px
            // to the right; chest is ~14px above his feet.
            Combat.oilSpritz(
              station.x + 11, station.y - 22,
              c.x, c.y - 14,
            );
            break;
          case "girl":
            // Girl tending her patch occasionally produces a
            // pickable bloom for any wounded hero to pluck later.
            if (now - (c.lastBloomAt || 0) > BLOOM_GROW_MS &&
                (station.bloom | 0) < BLOOM_CAP) {
              station.bloom = (station.bloom | 0) + 1;
              c.lastBloomAt = now;
            }
            break;
          case "firemage":
            // Tiny ember puff midway between the firemage's torso
            // and the campfire so the recharge actually reads on
            // screen — without it the only feedback was the pip
            // above his head, easy to miss while flames already
            // crackle in the same patch of pixels.
            station.lastInfuse = now;
            c.lastChargeAt = now;
            Combat.puff(
              Math.round((c.x + station.x) / 2),
              Math.round((c.y - 8 + station.y - 6) / 2),
              "#ff7e2e",
            );
            break;
        }
        // Recompute muls right away so the freshly applied buff
        // takes effect this same frame instead of waiting for the
        // next tick.
        recomputeStationMuls(c, now);
        break;
      }
    }

    // Stump → campfire log auto-feed.  Independent of any character:
    // whenever the fire is running low and the stump has logs to
    // spare, a billet "flies" into the fire (we just decrement +
    // refresh fuel; the visual handoff is implicit because the
    // log pile shrinks and the flame jumps back up next frame).
    // We rate-limit by only firing once every ~600 ms so a depleted
    // fire doesn't gobble the entire stockpile in a single tick.
    if (c.name === "viking") {                  // run the chain once,
                                                // off any character —
                                                // viking is convenient
      const stump = Scene.activity("viking");
      const fire = Scene.activity("firemage");
      if (stump && fire && (stump.logs | 0) > 0 &&
          Scene.campfireFuelLeft() < CAMPFIRE_LOW_THRESH_MS &&
          now - (stump.lastAutoFeedAt || 0) > 600) {
        if (Scene.feedCampfire()) {
          stump.logs = (stump.logs | 0) - 1;
          stump.lastAutoFeedAt = now;
        }
      }
    }

    // Cap arrow stockpile decay — once the practice target is full
    // the archer doesn't keep adding more.  Arrows visually persist
    // until the next session naturally caps; we don't bother
    // expiring them.
  }

  // ---- "Help!" call -------------------------------------------------
  //
  // Open a help call for `c`, attributing the caller's most recent
  // attacker (so responders know which monster to jump on).  The
  // call is rate-limited per hero by HELP_COOLDOWN_MS so a chained
  // healer doesn't scream every frame, and silently no-ops if `c`
  // already has an open call (extending it would just keep the
  // bubble visible forever).  The actual "hear" check happens in
  // `tryAnswerHelp`.
  function tryCallForHelp(c, attacker, now) {
    if (!c || c.hp <= 0) return;
    if (c.combatMode === "dead") return;
    if (now - c.lastHelpCallAt < helpCooldownFor(c)) return;
    if (c.helpRequestUntil > now) return;
    c.helpRequestUntil = now + HELP_LIFETIME_MS;
    c.helpAttacker =
      attacker && !attacker.dying ? attacker : null;
    c.lastHelpCallAt = now;
    Dialog.bark(c, "helpCall", { force: true });
  }

  // Find the closest open help-call within HELP_RADIUS that `c` is
  // actually capable of answering.  Skips the call if it's stale
  // (past helpRequestUntil), if the caller is the responder, or if
  // the caller isn't visible anymore.  Returns the caller object on
  // success, or null.
  function nearestHelpCall(c, now) {
    let best = null, bestD = Infinity;
    for (const o of list) {
      if (o === c) continue;
      if (o.helpRequestUntil <= now) continue;
      if (o.hp <= 0 || o.combatMode === "dead") continue;
      if (!isVisibleNow(o)) continue;
      const d = Math.hypot(o.x - c.x, o.y - c.y);
      if (d < bestD && d <= HELP_RADIUS) { bestD = d; best = o; }
    }
    return best;
  }

  // Returns true if `c` answered an open help call this tick (and
  // tickWandering / maybeEnterCombat should bail out — combat mode
  // has been set).  Eligibility: `c` is idle (combatMode === "none"),
  // can attack at all, and either fires from range OR has enough HP
  // to safely run into a melee.  Non-fighters (the girl) are
  // excluded — they're the ones who CALL for help, not who answer.
  function tryAnswerHelp(c, now) {
    if (c.combatMode !== "none") return false;
    if (!c.atk) return false;
    if (c.role === "alien") return false;
    const caller = nearestHelpCall(c, now);
    if (!caller) return false;
    const ranged = isRanged(c);
    // Pact-partner override: if the caller is `c`'s sworn ambush
    // buddy AND the pact is still live, skip the HP gate — the
    // whole point of the pact is that we run to each other even
    // when the prudent thing would be to stay at half-HP and snipe
    // from a distance.  The standard ranged-skip still fires for
    // everyone else.
    const pactWith = c.pact && c.pact.until > now ? c.pact.partner : null;
    const pactedCall = pactWith && pactWith === caller;
    if (!ranged && !pactedCall && c.hp < c.maxHp * HELP_ANSWER_HP_FRACTION) return false;
    let target = caller.helpAttacker;
    if (!target || target.dying) {
      const [m] = nearestMonster(caller, AGGRO_RANGE * 1.5);
      target = m;
    }
    if (!target) {
      // Nothing left to swing at — the call is effectively resolved.
      // Clear it so the caller doesn't drag any other responders
      // over for a fight that's already finished.
      caller.helpRequestUntil = 0;
      caller.helpAttacker = null;
      return false;
    }
    if (c.state === "talking") endTalking(c);
    startFighting(c, target);
    Dialog.bark(c, "helpAnswer");
    return true;
  }

  // Anyone walking a freshly-brewed HEAL bottle to the chest right
  // now?  Used by the retreat haven picker so a wounded hero can
  // park near the chest and be there the moment the witch drops the
  // bottle off, instead of wandering the lawn waiting.
  function witchDeliveringHeal() {
    for (const o of list) {
      if (o.name !== "witch") continue;
      if (!isVisibleNow(o)) continue;
      if (o.combatMode === "depositing" &&
          o.heldPotion && o.heldPotion.potionKind === "heal") return true;
      if (o.brewReady && (o.brewKind || "heal") === "heal") return true;
    }
    return false;
  }

  // Returns the character (if any) already committed to reviving
  // `corpse` — either a ground reviver in the "reviving" combat mode
  // whose combatTarget is this body, or the alien who has parked the
  // saucer and already locked the corpse as his ufoReviveTarget.  We
  // use this to keep multiple revivers from piling onto the same
  // grave: the first one wins dibs and everybody else looks for a
  // different body (or falls back to their normal routine if there
  // aren't any).
  //
  // Defensive checks: a dead character (hp <= 0 / combatMode "dead")
  // or one who's already left the stage cannot hold a claim — even
  // if some bug somewhere left their stale combatTarget pointing at
  // this corpse, we ignore it.  Otherwise a reviver who got killed
  // mid-channel would block the body forever and no-one else would
  // come help.
  function corpseClaimer(corpse) {
    for (const o of list) {
      if (o === corpse) continue;
      if (o.hp <= 0 || o.combatMode === "dead") continue;
      if (!isVisibleNow(o)) continue;
      if (o.combatMode === "reviving" && o.combatTarget === corpse) return o;
      if (o.combatMode === "ufoing" && o.ufoReviveTarget === corpse) return o;
      // Anyone running a revive-potion errand for this body also
      // counts as a claimer — once they're committed (chest →
      // corpse) we don't want a second hero rushing the same grave.
      if (o.combatMode === "potionReviving" && o.combatTarget === corpse) return o;
    }
    return null;
  }

  // Closest fallen ally to this would-be reviver.  "Fallen" = combat
  // mode "dead", still on stage, AND not already claimed by some
  // other reviver — without that last check two mages would walk to
  // the same body, both channel for REVIVE_MS, and only the first
  // one's resurrect actually does anything; the second wastes the
  // entire cast standing on top of the corpse it was supposed to
  // help.  Skipping claimed bodies sends the second mage to the
  // *next* corpse over, or back to wandering if there isn't one.
  // Mid-approach hand-off: a reviver who's still walking toward a
  // corpse will look for a closer, safer, idle reviver and yield to
  // them.  The point is to stop the witch from jogging across the
  // entire lawn while the girl is standing two tiles from the body
  // doing nothing — visually you'd expect the closer one to call out
  // "I've got this!" and take over, and now she does.
  //
  // Conditions for a swap candidate `o`:
  //   • on stage, alive, knows how to channel a revive
  //   • currently idle (combatMode === "none") so we're not pulling
  //     them off a heal/fight/their own revive
  //   • not standing on top of a monster threat (so the swap doesn't
  //     just dump them into combat the second they pivot)
  //   • can safely cast on the corpse (relaxed for the girl)
  //   • clearly closer than the current reviver — at least 20 %
  //     shorter and 16 px of slack — so we don't ping-pong on
  //     near-ties but the swap actually triggers in practice.  The
  //     earlier 35 % / 40 px gate was so conservative that by the
  //     time a freed-up ally became eligible the original reviver
  //     had usually already closed the gap below the threshold; the
  //     hand-off shout almost never fired.  20 % / 16 px (~one hero
  //     tile) keeps near-ties from flapping while letting a clearly
  //     closer idler actually take over.
  // Returns the best candidate or null.
  const REVIVE_SWAP_THREAT_R = 70;
  const REVIVE_SWAP_FRAC     = 0.80;
  const REVIVE_SWAP_MIN_GAIN = 16;
  function closerSafeReviver(currentReviver, corpse) {
    const cx = corpse.x, cy = corpse.y;
    const curD = Math.hypot(currentReviver.x - cx, currentReviver.y - cy);
    let best = null, bestD = curD * REVIVE_SWAP_FRAC;
    for (const o of list) {
      if (o === currentReviver) continue;
      if (o === corpse) continue;
      if (o.hp <= 0 || o.combatMode === "dead") continue;
      if (!isVisibleNow(o)) continue;
      if (!canRevive(o)) continue;
      // Only steal from a reviver who's still en route — once the
      // candidate has committed to anything else (own revive, heal,
      // fleeing, brewing, fetching a potion, …) leave them alone.
      if (o.combatMode !== "none") continue;
      if (Monsters.anyThreat(o.x, o.y, REVIVE_SWAP_THREAT_R)) continue;
      const range = reviveRangeOf(o);
      if (!safeCastFrom(o, cx, cy, range, "revive")) continue;
      const d = Math.hypot(o.x - cx, o.y - cy);
      if (d > bestD) continue;
      if (curD - d < REVIVE_SWAP_MIN_GAIN) continue;
      best = o; bestD = d;
    }
    return best;
  }

  // Boss-aware corpse picker for the UFO.  The plain `nearestDeadAlly`
  // ranks by raw distance, which during a hydra fight produces a
  // pessimal pull order:
  //   • a melee corpse that fell next to the body gets revived first,
  //     stands up inside bite range, and dies again before the alien
  //     can finish the next sortie;
  //   • a ranged buddy who fell mid-stage with plenty of room to
  //     resume firing waits in the queue behind him.
  // This picker fixes both:
  //   1. Hard reject corpses sitting inside HEAD bite range of the
  //      hydra body (≤ HYDRA_HEAD_RANGE + 10 px).  Reviving them just
  //      feeds the heads.  If literally every corpse is in that
  //      ring we fall back to the closest one (better than letting
  //      the saucer give up and start patrolling).
  //   2. Among the survivors, pick the BEST tier in this order:
  //        a) ranged hero outside spit envelope (safe + immediately
  //           contributes from range);
  //        b) ranged hero inside spit envelope (still a damage win,
  //           even if they have to dodge);
  //        c) melee hero outside spit envelope (safe at least);
  //        d) melee hero inside spit envelope (last resort).
  //      Ties inside a tier broken by distance from the alien — the
  //      tractor beam still has to fly there.
  function bestBossCorpseForUfo(c) {
    if (!HydraPlan || !HydraPlan.active || !HydraPlan.active()) return null;
    const body = HydraPlan.body();
    if (!body) return null;
    const headBiteR = (Monsters.HYDRA_HEAD_RANGE || 95) + 10;
    // STICK-ON-CURRENT-TARGET: if the saucer already locked a corpse
    // (mid-channel or mid-approach), do NOT re-evaluate the tiered
    // pick.  Without this guard the tier ordering can shift between
    // ticks (a far ranged-tier-0 buddy gets nudged into tier-1 the
    // instant the body's spit envelope happens to cover him on a
    // pulse, etc.), which yanks `corpseNearby` to a different ref
    // and trips the `c.ufoReviveTarget !== corpseNearby` reset
    // downstream — the channel breaks, the saucer flies to the new
    // corpse, the new pick flips back, and the alien just thrashes
    // between bodies without ever finishing a revive.  Stay locked
    // until the current target is no longer a valid corpse (revived
    // by a teammate, claimed by someone else, faded offstage, etc.),
    // then re-pick fresh.
    const locked = c.ufoReviveTarget;
    if (locked) {
      const stillValid =
        locked.combatMode === "dead" &&
        locked.hp <= 0 &&
        isVisibleNow(locked) &&
        (!locked.selfReviveAt || locked.selfReviveAt <= 0);
      const claimer = stillValid ? corpseClaimer(locked) : null;
      const claimedByOther = claimer && claimer !== c;
      // Path veto on the locked body too — the saucer's altitude
      // doesn't actually keep it out of the head-bite ring (heads
      // are tall and `inSpitDanger` is computed by horizontal
      // distance with the same radius for ground and air), and
      // letting the lock survive a "the route now cuts across the
      // body" transition is exactly the user-reported "UFO
      // flew straight over the hydra and died" loop: the alien
      // committed to a far-side corpse, headed there in a
      // straight line, drifted under the heads on the way.
      // Releasing the lock here lets the picker fall through to
      // the candidates pass below (which has the same veto), so
      // the saucer either picks a same-side corpse, switches to
      // shooting if no safe body remains, or pulls back to the
      // recharge corner.
      const safeRoute = !hydraPathBlocked(c.x, c.y, locked.x, locked.y);
      if (stillValid && !claimedByOther && safeRoute) return locked;
    }
    const candidates = [];
    let fallback = null, fallbackD = Infinity;
    for (const o of list) {
      if (o === c) continue;
      if (o.combatMode !== "dead") continue;
      if (!isVisibleNow(o)) continue;
      const claimer = corpseClaimer(o);
      if (claimer && claimer !== c) continue;
      // Zombie self-revive pillar will handle this body anyway.
      if (o.selfReviveAt > 0) continue;
      const dToAlien = Math.hypot(o.x - c.x, o.y - c.y);
      // Path veto: a corpse on the far side of the boss looks
      // perfectly safe by `dToBody` alone (it's outside the bite
      // ring) but reaching it requires flying THROUGH the bite
      // ring.  Excluded from BOTH candidates AND the fallback —
      // the fallback path used to be "the absolute nearest
      // corpse, even one on the wrong side", which is precisely
      // what got the saucer killed when no clean-side body was
      // available.  Better to skip the revive this cycle and
      // let a ground courier or a future spawn handle that body
      // than to trade the alien for it.
      if (hydraPathBlocked(c.x, c.y, o.x, o.y)) continue;
      if (dToAlien < fallbackD) { fallbackD = dToAlien; fallback = o; }
      const dToBody = Math.hypot(o.x - body.x, o.y - body.y);
      if (dToBody <= headBiteR) continue; // would die on revive
      const ranged = isRanged(o);
      const safe = !HydraPlan.inSpitDanger(o.x, o.y);
      // Tier: lower index = strictly preferred.
      let tier;
      if (ranged && safe) tier = 0;
      else if (ranged)    tier = 1;
      else if (safe)      tier = 2;
      else                tier = 3;
      candidates.push({ o, tier, d: dToAlien });
    }
    if (candidates.length === 0) return fallback;
    candidates.sort((a, b) => (a.tier - b.tier) || (a.d - b.d));
    return candidates[0].o;
  }

  function nearestDeadAlly(c) {
    // Non-fighters (the girl) refuse corpses they can't reach without
    // walking through a melee — she'd just die mid-channel and the
    // body would still be on the ground.  Same long-range relaxation
    // as `neediestAlly`: she only needs the path to her revive
    // standoff tile to be clear, not the corpse itself, since she
    // channels the holy pillar from a few tiles back.  Fighters and
    // the alien ignore the safety filter entirely.
    const safetyRequired = nonFighter(c);
    const range = reviveRangeOf(c);
    const reviverHasChannel = canRevive(c);
    // Boss safety filter: during a hydra fight the witch / firemage
    // are CASTERS, not tanks — walking up to a corpse parked under
    // the hydra's heads to channel a 2.4 s revive is suicide (the
    // body picker has been used to pull the witch from her cauldron
    // straight into bite range, which is what produced the user-
    // visible "witch headed to the hydra with a bottle" loop).  Reject
    // corpses inside spit envelope OR within head-bite reach of the
    // body — the alien's UFO picker (bestBossCorpseForUfo) already
    // does the same dance for the saucer.  We DO allow it during
    // the push window AND only for the firemage (long range +
    // burst damage that breaks the head pressure further); the
    // witch always sits this one out and lets potion couriers /
    // the UFO handle hydra-adjacent corpses.
    const hydraOn = HydraPlan && HydraPlan.active && HydraPlan.active();
    const body = hydraOn ? HydraPlan.body() : null;
    const headBiteR = (Monsters.HYDRA_HEAD_RANGE || 95) + 10;
    const bossFilter = hydraOn && body
      && (c.name === "witch" || c.name === "firemage");
    let best = null, bestD = Infinity;
    for (const o of list) {
      if (o === c) continue;
      if (o.combatMode !== "dead") continue;
      if (!isVisibleNow(o)) continue;
      const claimer = corpseClaimer(o);
      if (claimer && claimer !== c) continue;
      // Zombie self-revive: the body is about to get up on its
      // own, so almost everyone should keep looking for a more
      // useful corpse.  Two narrow exceptions let a hero
      // pre-empt:
      //   • only non-potion revivers (canRevive — no chest run
      //     required, the channel just lands), AND
      //   • only when they're already a couple of steps away
      //     so the hand-revive lands before the necro pillar
      //     would have finished anyway.
      // Anyone else (potion couriers, distant revivers) just
      // skips this body and the green pillar handles it.
      if (o.selfReviveAt > 0) {
        if (!reviverHasChannel) continue;
        const dq = Math.hypot(o.x - c.x, o.y - c.y);
        if (dq > ZOMBIE_SELF_REVIVE_PREEMPT_R) continue;
      }
      if (bossFilter) {
        const inBite = Math.hypot(o.x - body.x, o.y - body.y) <= headBiteR;
        const inSpit = HydraPlan.inSpitDanger(o.x, o.y);
        // Witch never walks into the boss's hot zones for a revive.
        // Firemage may step into spit if the team's currently in the
        // push window (head pressure is low enough that the salvo
        // cap keeps him survivable), but bite range is always off.
        if (c.name === "witch") {
          if (inBite || inSpit) continue;
        } else {
          if (inBite) continue;
          if (inSpit && !HydraPlan.pushWindow()) continue;
        }
      }
      // Hydra body path veto: this is the user-reported "zombie
      // charges straight at the hydra with a revival bottle" case —
      // `tickPotionReviving`'s `toCorpse` safety check is gated on
      // `nonFighter(c)`, and the zombie / knight / samurai / robot /
      // etc. all have an `atk` so they push straight through bite
      // range carrying a revive bottle.  Apply to FIGHTERS only:
      // they walk to the corpse tile itself, so a corpse-line that
      // crosses the bite ring really does kill them.  The girl
      // never walks to the corpse (she stops at the standoff
      // GIRL_REVIVE_RANGE away), so checking the line to the corpse
      // rejects every body whose corpse pixel happens to land in
      // bite reach — even when the standoff is 64 px to the side
      // and the actual walk-to-standoff path is clean.  For her,
      // `safeCastFrom` below already checks the path to the
      // standoff, the bite-floor of the standoff itself, and the
      // bite-path veto from her current pos to the standoff.
      if (hydraOn && body && !nonFighter(c)
          && hydraPathBlocked(c.x, c.y, o.x, o.y)) continue;
      if (safetyRequired && !safeCastFrom(c, o.x, o.y, range, "revive")) continue;
      const d = Math.hypot(o.x - c.x, o.y - c.y);
      if (d < bestD) { bestD = d; best = o; }
    }
    return best;
  }

  // Companion picker for the GIRL's "should I summon the horse?"
  // decision.  When `nearestDeadAlly` rejects every corpse because
  // the walk-to-standoff line crosses head-bite reach, the gallop
  // can still rescue the body — `tickRideToCorpse` arcs around the
  // boss instead of going straight.  This picker drops only the
  // path-cross veto from `safeCastFrom` (the bite-floor on the
  // standoff itself stays — corpses with no safe standoff at all
  // are unrevivable, the gallop can't fix that).  Same return
  // contract as `nearestDeadAlly`.
  function nearestDeadAllyForHorse(c) {
    if (c.name !== "girl") return null;
    if (!HydraPlan || !HydraPlan.active || !HydraPlan.active()) return null;
    const body = HydraPlan.body();
    if (!body) return null;
    const range = reviveRangeOf(c);
    const headBiteR = (Monsters.HYDRA_HEAD_RANGE || 95) + 10;
    const biteFloor = headBiteR + 10;
    let best = null, bestD = Infinity;
    for (const o of list) {
      if (o === c) continue;
      if (o.combatMode !== "dead") continue;
      if (!isVisibleNow(o)) continue;
      const claimer = corpseClaimer(o);
      if (claimer && claimer !== c) continue;
      if (o.selfReviveAt > 0) continue;
      // At least one of the two standoff candidates must clear the
      // bite ring — otherwise after dismount she'd be inside head
      // reach for the channel and die on the first chomp.  Mirrors
      // standoff_safely_outside_bite from girl_revive_sim.py.
      const off = Math.max(8, range - 8);
      const margin = 12;
      const xL = Math.max(margin, Math.min(Scene.WIDTH - margin, o.x - off));
      const xR = Math.max(margin, Math.min(Scene.WIDTH - margin, o.x + off));
      const dL = Math.hypot(xL - body.x, o.y - body.y);
      const dR = Math.hypot(xR - body.x, o.y - body.y);
      if (Math.max(dL, dR) < biteFloor) continue;
      const d = Math.hypot(o.x - c.x, o.y - c.y);
      if (d < bestD) { bestD = d; best = o; }
    }
    return best;
  }

  // ----- combat: state entry points ------------------------------------

  function enterCombatMode(c, mode) {
    c.combatMode = mode;
    c.frame = 0;
    c.frameTimer = 0;
    // Combat trumps the peacetime flower errand — drop the flag so
    // the bloom isn't accidentally consumed when combat eventually
    // exits and the wander state resumes near the patch.  The fire
    // / grave warming detours are dropped too — combat trumps a
    // soak.
    c.flowerErrand = false;
    c.warmErrand = false;
    c.restErrand = false;
    c.chargeErrand = false;
  }

  function exitCombat(c) {
    c.combatMode = "none";
    c.combatTarget = null;
    c.drinkPhase = null;
    c.depositPhase = null;
    c.deliverPhase = null;
    c.deliverTarget = null;
    c.revivePhase = null;
    c.fleeRefuge = null;
    if (c.targetGroundPotion) {
      if (c.targetGroundPotion.claimer === c) c.targetGroundPotion.claimer = null;
      c.targetGroundPotion = null;
    }
    // Keep the witch's freshly-brewed bottle when combat ends — it
    // belongs to the brew-and-deposit cycle, not to the combat state.
    // Every other in-hand bottle (mid-drink, etc.) is a combat-only
    // prop and can safely be cleared.
    if (!c.brewReady) c.heldPotion = null;
    if (c.hp > 0) {
      c.state = "wandering";
      c.wandersLeft = 1;
      c.stateUntil = performance.now() + rr(...WANDER_STEP_MS);
      const [nx, ny] = randomLawnPoint(c);
      setTarget(c, nx, ny);
    }
  }

  // Boss-fight discipline for the witch.  Headless harness
  // (tools/headless-battle.js) showed that bouncing her OUT of the
  // fighting / fleeing / drinking / retreating ladders while the
  // hydra is live is worth +6.7 percentage points of team winrate
  // (~88.7% → ~95.3% on 150 paired headless episodes; McNemar
  // p ≪ 0.001) and +7.3 pp of witch survival — every one of those
  // modes pulls her off the cauldron into spit range on a
  // trajectory the team's boss AI isn't positioned to defend, so
  // "go drink a heal" / "retreat toward the girl" / "help the
  // fighter with a hex" decisions that look locally rational turn
  // out to be globally losing bets inside a boss window.
  //
  // Depositing, healing an ally, potion-revives and
  // channel-revives are untouched: the same sweep found they're
  // neutral-or-useful ("N-keep-support" scheme), and the user's
  // brief was "she should stay in the fight and help the team —
  // heal, brew, maybe snipe occasionally".  Peacetime (no
  // HydraPlan) is unchanged.
  //
  // We DON'T gate the start* entry points: letting them fire
  // preserves their useful side effects — setTarget(retreat goal),
  // fleeRefuge pick, drinkPhase bookkeeping — which the next tick
  // rides even after exitCombatToPost zeroes the mode bit.  A
  // harsher variant that snapped her back to activity.x/y dropped
  // the gain from +10 wins to +3 on the same 150-seed panel, so
  // we keep the soft exit.
  function witchSkipsCombatLadder(c) {
    return c && c.name === "witch" && HydraPlan.active();
  }

  // Boss-discipline exit used by the boss-discipline gate in update():
  // zero combat bookkeeping and flip state to "working" so the witch
  // keeps ticking brew progress.  We intentionally leave tx/ty alone:
  // the start* that fired this round already picked a SAFE direction
  // (away from the incoming monster); redirecting to the cauldron here
  // would make her walk back TOWARD the threat that just triggered the
  // retreat, which empirically costs ~25 pp of win-rate in A/B tests.
  function exitCombatToPost(c) {
    c.combatMode = "none";
    c.combatTarget = null;
    if (c.hp > 0 && c.state !== "offstage") {
      c.state = "working";
    }
  }

  // Centralized witch-vs-hydra veto.  The scattered combat-entry call
  // sites (damage() retaliation, tryAnswerHelp, buddyTarget pickup,
  // tickFighting's target-rotate-on-kill, mid-fight role retarget,
  // SELF_DEFENCE_R, the boss override) all forget to re-check the
  // witch boss exception in maybeEnterCombat.  The recurring
  // "THE WITCH ATTACKED THE HYDRA AGAIN" loop is one of those paths firing
  // — typically `damage()` after a head bites her, or a slime dying
  // mid-fight rotating her target onto the boss via HydraPlan.target
  // For.  Bullet-proof it here: hydra parts are NEVER an acceptable
  // engage target for the witch.  Earlier we let her take an
  // "opportunistic hex" if a head was already inside her 130 px range,
  // but tickFighting's standoff branch then actively walked her TO
  // (range − 6) = 124 px of the target, and since heads orbit ~30 px
  // around the body, that put her at ~94 px from the body — i.e. just
  // inside HYDRA_HEAD_RANGE (95 px) bite reach.  Net effect: she
  // committed to combat from the cauldron and visibly "marched at the
  // hydra" before getting eaten.  Refuse the engage unconditionally;
  // SELF_DEFENCE_R (36 px) still handles a head literally on top of
  // her face, but anything further is the support kit's problem (brew,
  // deposit, revive), not a fight she should walk into.
  function witchShouldSkipHydraTarget(c, target) {
    if (!c || c.name !== "witch" || !target) return false;
    if (target.kind !== "hydraBody" && target.kind !== "hydraHead") return false;
    return true;
  }

  function startFighting(c, target) {
    if (witchShouldSkipHydraTarget(c, target)) return;
    enterCombatMode(c, "fighting");
    c.combatTarget = target;
  }

  // Who, if anyone, currently owns the spot in front of the chest.
  // We treat a hero as "occupying" the chest while they're walking up
  // to it, holding the lid open, or stepping back off it with a fresh
  // bottle — i.e. while their sprite would visually sit on or over
  // the chest tile.  The post-backstep "drink" phase doesn't count
  // (they've moved aside) and the witch's "return" phase doesn't
  // either (she's already heading home).  Without this, two heroes
  // can call startDrinking on the same tick and both walk to the
  // exact same pixel, ending up perfectly stacked in front of the
  // chest with no way to separate.
  function chestInUseBy(c) {
    for (const o of list) {
      if (o === c) continue;
      if (o.hp <= 0 || o.combatMode === "dead") continue;
      if (!isVisibleNow(o)) continue;
      if (o.combatMode === "drinking") {
        const p = o.drinkPhase;
        if (p === "approach" || p === "open" || p === "backstep") return o;
      } else if (o.combatMode === "depositing") {
        const p = o.depositPhase;
        if (p === "approach" || p === "open") return o;
      } else if (o.combatMode === "potionReviving") {
        const p = o.revivePhase;
        // Only the chest-side phases count as occupying the chest.
        // Once they've stepped away with the bottle ("toCorpse" /
        // "use") the slot is free for the next user.
        if (p === "approachChest" || p === "openChest" || p === "backstep") return o;
      }
    }
    return null;
  }

  // Pick a "wait next to the chest" spot for a hero who arrived to
  // find someone else already using it.  We park the newcomer on the
  // *opposite* side from the current occupant so two waiters tend not
  // to pile onto the same tile, and clamp to lawn so we don't push
  // anybody into the pond on small screens.
  function chestWaitTarget(c, occupant) {
    const chest = Scene.chest();
    const side = occupant.x >= chest.x ? -1 : 1;
    let x = chest.x + side * 22;
    if (Scene.isInPond && Scene.isInPond(x, chest.y + 2)) {
      x = chest.x - side * 22;
    }
    return { x, y: chest.y + 2 };
  }

  // Pickup-and-drink for a bottle lying on the lawn (a witch
  // dropped it when she got killed, typically).  Reuses the same
  // "drinking" combat mode as the chest path so `tickDrinking`
  // already handles the "backstep + drink" tail; only the leading
  // approach phase is bottle-specific.
  function startPickupPotion(c, potion) {
    enterCombatMode(c, "drinking");
    c.heldPotion = null;
    c.drinkPhase = "approachGround";
    c.targetGroundPotion = potion;
    potion.claimer = c;
    setTarget(c, potion.x, potion.y);
  }

  // Find the closest free dropped HEAL bottle within pickup range
  // that `c` can actually walk to safely.  Caller guards on the
  // hero's own HP / role first; we only search.  Returns null if
  // there's nothing useful to grab right now.
  function findNearbyGroundHeal(c) {
    if (typeof Scene.listGroundPotions !== "function") return null;
    const pots = Scene.listGroundPotions();
    if (!pots.length) return null;
    let best = null, bestD = Infinity;
    for (const p of pots) {
      if (p.kind !== "heal") continue;
      if (p.claimer && p.claimer !== c && p.claimer.hp > 0) continue;
      const d = Math.hypot(p.x - c.x, p.y - c.y);
      if (d > GROUND_PICKUP_R) continue;
      if (d >= bestD) continue;
      // Defer the path-safety check until we've narrowed to the
      // closest candidate — safePathTo walks every monster, so
      // checking it inside the loop would be quadratic.
      bestD = d; best = p;
    }
    if (!best) return null;
    if (!safePathTo(c, best.x, best.y)) return null;
    return best;
  }

  // Ground-revive companion to findNearbyGroundHeal: any non-reviver
  // (the channel-revive crowd doesn't need a bottle) can spot a
  // dropped revive bottle and run it to the nearest corpse.  Same
  // pickup radius / safe-path / claimer logic as the heal version so
  // two heroes don't both sprint to the same bottle.  Caller is
  // expected to have already confirmed there IS a corpse to use it
  // on — we don't double-check here so the search can stay cheap.
  function findNearbyGroundRevive(c) {
    if (typeof Scene.listGroundPotions !== "function") return null;
    const pots = Scene.listGroundPotions();
    if (!pots.length) return null;
    let best = null, bestD = Infinity;
    for (const p of pots) {
      if (p.kind !== "revive") continue;
      if (p.claimer && p.claimer !== c && p.claimer.hp > 0) continue;
      const d = Math.hypot(p.x - c.x, p.y - c.y);
      if (d > GROUND_PICKUP_R) continue;
      if (d >= bestD) continue;
      bestD = d; best = p;
    }
    if (!best) return null;
    if (!safePathTo(c, best.x, best.y)) return null;
    return best;
  }

  // Ground-revive errand: walk to a dropped revive bottle, pick it
  // up, then proceed with the same toCorpse / use phases the chest-
  // bound revive errand uses.  We share `combatMode === "potionReviving"`
  // so all the existing scheduling, hand-off, and cleanup paths
  // already handle the runner; only the lead-in phase is new.
  function startPotionReviveFromGround(c, corpse, potion) {
    enterCombatMode(c, "potionReviving");
    c.combatTarget = corpse;
    c.combatUntil = 0;
    c.heldPotion = null;
    c.targetGroundPotion = potion;
    potion.claimer = c;
    c.revivePhase = "approachGround";
    setTarget(c, potion.x, potion.y);
  }

  // Start the full chest-drinking ritual: walk to the chest, flip the
  // lid up, take a bottle out, step aside, then actually drink it.
  // `heldPotion` stays null until we've grabbed one from the stock;
  // `drinkPhase` threads the sub-states together.  If the chest is
  // already occupied, we go into the "wait" phase instead and queue
  // up beside it until the previous user clears out.
  function startDrinking(c) {
    enterCombatMode(c, "drinking");
    c.heldPotion = null;
    c.combatUntil = 0;
    const occupant = chestInUseBy(c);
    if (occupant) {
      c.drinkPhase = "wait";
      const t = chestWaitTarget(c, occupant);
      setTarget(c, t.x, t.y);
    } else {
      c.drinkPhase = "approach";
      const chest = Scene.chest();
      setTarget(c, chest.x, chest.y + 2);
    }
  }

  // Self-drink a potion the hero is already carrying — used when a
  // witch en route to the chest with a fresh heal brew (or just
  // brewed and not yet started depositing) gets shot up enough that
  // walking the rest of the way is suicidal.  Skips the chest
  // entirely: she steps away from the nearest threat and tips the
  // bottle back where she stands.  The brew counter is cleared so
  // the cauldron starts a fresh cycle once combat exits.
  function startSelfDrink(c) {
    enterCombatMode(c, "drinking");
    c.combatUntil = 0;
    c.drinkPhase = "backstep";
    c.brewReady = false;
    c.brewKind = "heal";
    const [m] = nearestMonster(c, 9999);
    let dx;
    if (m) dx = (m.x > c.x) ? -18 : 18;
    else   dx = (c.x < Scene.WIDTH / 2) ? 18 : -18;
    const tx = Math.max(20, Math.min(Scene.WIDTH - 20, c.x + dx));
    setTarget(c, tx, c.y);
    Dialog.bark(c, "drink");
  }

  // True iff `c` is carrying a heal potion (typically the witch
  // mid-deposit) AND has been hurt enough that drinking it on the
  // spot makes more sense than continuing the deposit errand.
  // Two thresholds:
  //   • the standing 0.55 LOW_HP gate: any time she's at low HP and
  //     happens to be carrying a brew, drink it instead of stocking.
  //   • a more eager 0.75 gate when she's actively under fire (got
  //     hit within UNDER_FIRE_MS).  The user flagged the exact
  //     scenario this addresses: witch walking a bottle to the chest
  //     under attack at ~70% HP, the steady-state gate (0.55) never
  //     trips, she finishes the deposit and gets killed on the
  //     return walk holding nothing.  Bumping the threshold to 0.75
  //     while she's bleeding lets her drink the bottle she's already
  //     holding before the next hit lands — much better than dying
  //     with the potion in hand.  We DO require an explicit recent
  //     hit so off-combat deposit errands at 70% HP (e.g. she just
  //     walked to a flower bloom that healed her partly) still
  //     finish — the brew belongs in the chest unless she's actively
  //     in trouble.
  function shouldSelfDrinkHeld(c) {
    if (!c.heldPotion || c.heldPotion.potionKind !== "heal") return false;
    if (c.hp < c.maxHp * LOW_HP_FRACTION) return true;
    const underFire = (performance.now() - (c.lastDamagedAt || 0))
                       < UNDER_FIRE_MS;
    if (underFire && c.hp < c.maxHp * UNDER_FIRE_DRINK_FRAC) return true;
    return false;
  }

  // Wounded witch about to grab a chest potion: would heading home
  // and finishing her own brew actually be faster?  Compares the
  // total ms cost of "walk to cauldron + finish brew (at the active
  // emergency-stoke speed) + drink" against "walk to chest + drink".
  // Returns true when the cauldron route wins, so the caller can
  // commit the witch to brewing instead of jogging past her own kit
  // to the kiosk.  Gates on the same safety / state checks the inline
  // brew fallback below uses (no immediate threat, safe path home,
  // not already carrying a different brew, station present).
  function witchSelfBrewBeatsChest(c) {
    if (c.name !== "witch") return false;
    if (!c.activity) return false;
    if (c.brewReady) return false;
    if (c.heldPotion) return false;
    if (Monsters.anyThreat(c.x, c.y, 100)) return false;
    if (!safePathTo(c, c.activity.x, c.activity.y)) return false;
    const a = c.activity;
    const cauldronD = Math.hypot(c.x - a.x, c.y - a.y);
    // Brew speed mirrors tickWitchBrew: 1.6× when the chest is empty
    // of heals; 1.38× when stock is thin (same thresholds as
    // tickWitchBrew).  While we're considering this branch the witch
    // IS wounded, so the top tier kicks in whenever the chest doesn't
    // already have a heal waiting.
    const chestHealStock = (Scene.chestStockOf && Scene.chestStockOf("heal")) || 0;
    const reviveStock = (Scene.chestStockOf && Scene.chestStockOf("revive")) || 0;
    let brewSpeed = 1.0;
    if (chestHealStock <= 0) brewSpeed = 1.6;
    else if (
      chestHealStock < 2 ||
      (reviveStock < 1 && Scene.chestHasRoom())
    ) {
      brewSpeed = 1.38;
    }
    const remainBrewMs = Math.max(0, BREW_MS - (c.brewAccum || 0)) / brewSpeed;
    const SELF_DRINK_MS = 1500;
    const cauldronMs = (cauldronD / SPEED) * 1000 + remainBrewMs + SELF_DRINK_MS;
    if (chestHealStock <= 0) return true;     // chest is empty anyway
    const chest = Scene.chest && Scene.chest();
    if (!chest) return true;
    const chestD = Math.hypot(c.x - chest.x, c.y - chest.y);
    const chestMs = (chestD / SPEED) * 1000 + SELF_DRINK_MS;
    return cauldronMs < chestMs;
  }

  // Witch-specific no-go zone during a hydra fight: spit envelope
  // (always, regardless of push window — her job is brewing, not
  // tanking acid for a delivery) and head-bite reach of the body.
  // Used to gate hand-off / deposit / chase decisions so she
  // doesn't end up sprinting toward the boss carrying a bottle.
  // Returns false (i.e. NOT in danger) when no hydra is active.
  function witchInHydraDangerAt(x, y) {
    if (!HydraPlan || !HydraPlan.active || !HydraPlan.active()) return false;
    const body = HydraPlan.body();
    if (!body) return false;
    if (HydraPlan.inSpitDanger(x, y)) return true;
    const headBiteR = (Monsters.HYDRA_HEAD_RANGE || 95) + 10;
    if (Math.hypot(x - body.x, y - body.y) <= headBiteR) return true;
    return false;
  }

  // Straight-line path between two points that grazes the hydra's
  // head-bite ring.  `witchInHydraDangerAt` only checks endpoints,
  // so a courier whose start AND destination are both safe could
  // still get torn apart on the walk if her line cuts across the
  // body — the cauldron sits left of the lawn, the chest sits in
  // the middle, and the wounded ally she's running a bottle to
  // can be on the far side of the boss.  Used as a path-veto for
  // the witch's hand-off / mid-deliver checks (and the revive
  // detour) so she stays out of bite range while couriering.
  // Returns false outside boss fights.
  function hydraPathBlocked(x1, y1, x2, y2) {
    if (!HydraPlan || !HydraPlan.active || !HydraPlan.active()) return false;
    const body = HydraPlan.body && HydraPlan.body();
    if (!body) return false;
    const headBiteR = (Monsters.HYDRA_HEAD_RANGE || 95) + 10;
    return pathCrossesHydra(x1, y1, x2, y2, headBiteR);
  }

  // Mid-errand revive preempt: a fallen ally beats whatever the
  // caster is currently doing (depositing a brewed bottle, topping
  // off a wounded ally) — those tasks can resume after.  We only
  // trigger when `c` actually knows how to channel a revive (witch
  // / firemage / girl), the corpse exists and isn't already claimed
  // by someone else, and there's no monster in the immediate
  // bubble — running across a melee with the cast bar up just
  // stacks two corpses instead of unstacking the first.  The
  // threat radius matches maybeEnterCombat's reviveThreatR scale
  // so a graveyard-floor situation pushes the override through
  // even when monsters are still milling around.
  function shouldDropForRevive(c) {
    if (!canRevive(c)) return false;
    if (c.combatMode === "reviving") return false;
    const corpses = countCorpses();
    if (corpses === 0) return false;
    const reviveThreatR =
      corpses >= 3 ? 18 : corpses >= 2 ? 36 : 60;
    if (Monsters.anyThreat(c.x, c.y, reviveThreatR)) return false;
    const corpse = nearestDeadAlly(c);
    if (!corpse) return false;
    // Path-safety gate (non-fighters only — witch / firemage are
    // expected to brawl through if needed).  Without this the girl
    // would happily abandon a heal-in-progress to walk THROUGH a
    // slime to reach a corpse, only to flee at the last second when
    // tickReviving's per-tick safety check fired — wasting both
    // the cancelled heal AND the commute, and leaving the corpse
    // unrevived anyway.  If the corpse genuinely isn't reachable
    // safely right now, keep healing the live ally we already have.
    if (nonFighter(c)) {
      const range = reviveRangeOf(c);
      if (!safeCastFrom(c, corpse.x, corpse.y, range, "revive")) return false;
    }
    // Witch boss guard: even though she's a fighter, walking up to
    // a corpse parked under the hydra (especially with a freshly
    // brewed bottle still on her belt mid-deposit) is the textbook
    // way to lose her in the first half of the fight.  The corpse
    // picker (`nearestDeadAlly`) already filters hydra-danger
    // bodies for her, but a mid-deposit corpse that briefly drifts
    // into the danger ring (head regrow, spit pulse) would still
    // get reported here on the very next tick.  Belt-and-braces:
    // if the picked corpse currently sits in spit / bite, refuse
    // to abandon the deposit — the alien's UFO picker or a potion
    // courier handles hydra-adjacent revives.  Same cheap gate
    // applied to the firemage when he's NOT in the push window.
    const hydraOn = HydraPlan && HydraPlan.active && HydraPlan.active();
    if (hydraOn && (c.name === "witch" || c.name === "firemage")) {
      const body = HydraPlan.body();
      if (body) {
        const headBiteR = (Monsters.HYDRA_HEAD_RANGE || 95) + 10;
        const inBite = Math.hypot(corpse.x - body.x, corpse.y - body.y) <= headBiteR;
        const inSpit = HydraPlan.inSpitDanger(corpse.x, corpse.y);
        if (inBite) return false;
        if (inSpit && (c.name === "witch" || !HydraPlan.pushWindow())) return false;
        // Path veto for the witch only: even when the corpse itself
        // is parked clear of bite/spit, a straight-line jog from
        // her cauldron through the lair to reach it costs us the
        // brewer.  Same reasoning as the hand-off path veto.  The
        // firemage is a melee front-liner who's expected to be in
        // the hydra's face anyway, so we don't gate him here.
        if (c.name === "witch" && hydraPathBlocked(c.x, c.y, corpse.x, corpse.y)) {
          return false;
        }
      }
    }
    return true;
  }

  function startHealing(c, ally) {
    enterCombatMode(c, "healing");
    c.combatTarget = ally;
    // Aim straight at the standoff from frame one — otherwise non-
    // fighters spend the first frame walking toward the patient
    // (often into the monster chewing on the patient) before
    // tickHealing re-targets them on the next tick.
    const range = healRangeOf(c);
    const stand = standoffNear(c, ally.x, ally.y, range);
    setTarget(c, stand.x, stand.y - 2);
  }

  // Vertical lane offsets (delta-Y from the fleer's current row) we
  // sample when scoring exit corridors.  The original picker only
  // tried the row the hero was already standing on — a single slime
  // in front would force a left/right flip, which on a hydra fight
  // routinely meant flipping back THROUGH the boss.  Trying lanes
  // 60 / 120 / 180 px above and below the current Y means "duck
  // up around them" is now an option the scorer can choose
  // outright instead of needing the post-hoc sidestep beat to fix
  // a dumb pick.  Spacing > FLEE_PATH_CLEARANCE so two adjacent
  // lanes don't trivially share their blockers.
  const FLEE_LANE_OFFSETS = [-180, -120, -60, 0, 60, 120, 180];

  // Multi-candidate exit picker shared by startLeave (peacetime off-
  // to-lunch), startFleeing (panic), and the in-flight replan inside
  // tickFleeing.  Returns `{ goLeft, edgeX, edgeY, score }`.
  //
  // Algorithm:
  //   1. Build a candidate set of (edge, lane Y) tuples — both
  //      edges, several Y rows clamped to the lawn band.  This
  //      lifts the picker out of the binary "left vs right at my
  //      current Y" trap that was killing heroes when both rows
  //      at c.y were dirty but a row 60 px above was wide open.
  //   2. Score every candidate with a single weighted formula:
  //        - heavy penalty per blocker on the corridor (the
  //          "running through three slimes" anti-pattern);
  //        - bonus proportional to the distance to the FIRST
  //          blocker (more run-up before contact);
  //        - bonus when the corridor direction aligns with the
  //          aggregated away-from-threats vector, so we exit
  //          OUT THE SEAM between flankers instead of through
  //          one of them;
  //        - veto-grade penalties for healer-grave crossings
  //          (skeleton spawn corridor) and ANYONE crossing the
  //          live hydra body — both of which used to require
  //          ad-hoc "if the chosen direction is bad, flip"
  //          patches downstream;
  //        - tiny preference for staying near the current Y all
  //          else equal so we don't ping-pong vertically.
  //   3. Pick the highest-scoring candidate.
  //
  // The score is exposed in the returned object so the in-flight
  // replan can avoid jittering between near-equal candidates.
  function pickExitEdge(c) {
    const { w } = Sprites.size();
    const leftX  = -w - 4;
    const rightX = Scene.WIDTH + w + 4;
    const minY = (Scene.FLOOR_TOP || 40) + 10;
    const maxY = (Scene.FLOOR_BOTTOM || 280) - 6;
    const FLEE_AWAY_R = 260;
    const tv = Monsters.threatVector(c.x, c.y, FLEE_AWAY_R);
    const tvLen = Math.hypot(tv.dx, tv.dy);

    // Deduped, in-band lane Y candidates — the offset list can
    // produce duplicates after clamping when the hero is hugging
    // the lawn border.
    const lanes = [];
    for (const dy of FLEE_LANE_OFFSETS) {
      const ty = Math.max(minY, Math.min(maxY, c.y + dy));
      if (!lanes.some(l => Math.abs(l - ty) < 6)) lanes.push(ty);
    }

    function scoreCandidate(edgeX, ty, goLeft) {
      const blockers = Monsters.threatsOnPath(
        c.x, c.y, edgeX, ty, FLEE_PATH_CLEARANCE);
      const distFirst = Monsters.distToFirstOnPath(
        c.x, c.y, edgeX, ty, FLEE_PATH_CLEARANCE);
      const corridor = distFirst === Infinity ? 9999 : distFirst;
      let s = 0;
      // Density is the dominant term: one extra blocker has to be
      // worth more than any plausible corridor-distance bonus, or
      // the picker would happily route through three slimes if the
      // first one happened to be a tile farther than the alt's.
      s -= blockers * 220;
      s += Math.min(corridor, 600) * 0.6;
      // Away-vector alignment: dot product between the path unit
      // vector and the aggregated "away from threats" unit vector.
      // tvLen is the magnitude of the un-normalised aggregate; if
      // there are no threats in the bubble we skip this term.
      if (tv.count > 0 && tvLen > 1e-6) {
        const pdx = edgeX - c.x;
        const pdy = ty - c.y;
        const plen = Math.hypot(pdx, pdy) || 1;
        const dot = (pdx * tv.dx + pdy * tv.dy) / (plen * tvLen);
        // Up to ~+90 for a perfect alignment, down to -90 for a
        // path that points STRAIGHT INTO the threat centroid.
        s += dot * 90;
        // Nearest-threat sanity penalty: if maxClose says the
        // single closest monster is right on top of us, weight the
        // alignment slightly harder (going TOWARD an in-your-face
        // threat is the classic "ran back through the slime" line).
        if (tv.maxClose < 60) s += dot * 30;
      }
      // Healer-only grave veto — running across the gravestone in
      // panic spawns and aggroes skeletons every cycle, and adds a
      // headstone obstacle on the line.  Veto-grade so it dominates
      // any density / corridor bonus the grave path would earn.
      if (c.role === "healer" && pathCrossesGrave(c.x, c.y, edgeX, ty)) {
        s -= 220;
      }
      // Hydra body veto — applies to everyone.  No-op outside boss
      // fights.  This is what would have saved the girl from the
      // "flipped from left into the hydra" report: the right-side
      // candidates that cut through the body are now scored ~250
      // worse than any clean lane on either side.
      if (pathCrossesHydra(c.x, c.y, edgeX, ty)) {
        s -= 250;
      }
      // Tiny preference for staying near the current Y all else
      // equal — without this two equally clean lanes would be
      // picked at random per call, producing a visible Y-jitter on
      // ties during the in-flight replan.
      s -= Math.abs(ty - c.y) * 0.05;
      // Peacetime tiebreaker: nudge toward the closer edge, so a
      // hero on the left half of the lawn doesn't trek across the
      // whole stage to exit right when both corridors are equally
      // clean.  Magnitude is deliberately tiny — it loses to a
      // single blocker (220) or even a meaningful corridor-depth
      // difference, but it cleanly resolves the no-threats case
      // back to the old "exit on your own side" heuristic that
      // startLeave used before the multi-lane picker existed.
      s -= Math.abs(edgeX - c.x) * 0.01;
      return s;
    }

    let best = null;
    for (const goLeft of [true, false]) {
      const ex = goLeft ? leftX : rightX;
      for (const ty of lanes) {
        const s = scoreCandidate(ex, ty, goLeft);
        if (!best || s > best.score) {
          best = { score: s, goLeft, edgeX: ex, edgeY: ty };
        }
      }
    }
    if (!best) {
      const goLeft = c.x < Scene.WIDTH / 2;
      return { score: 0, goLeft, edgeX: goLeft ? leftX : rightX, edgeY: c.y };
    }
    return best;
  }

  function startFleeing(c) {
    // Zombie special case: dying near his gravestone arms the
    // green-pillar self-revive, which restores him to full HP at his
    // post in a few seconds.  An offstage flee ALSO restores full HP,
    // but burns the offstage timer AND drops his post for that long
    // — strictly worse than the self-revive line whenever the grave
    // is reachable.  Hijack the panic flee: hold ground (and engage
    // anything biting us) if we're already on the grave, walk back
    // to it if the path is clear, only fall through to a real
    // off-stage flee if the grave is too far / unreachable.
    if (c.name === "zombie") {
      const strat = zombieGraveDeathStrategy(c);
      if (strat === "hold") {
        const [m] = nearestMonster(c, AGGRO_RANGE);
        if (m) { startFighting(c, m); return; }
        // No threat in arm's reach — drop combat planning and let
        // the grave's passive regen tick him back up in place.
        exitCombat(c);
        return;
      }
      if (strat === "approach") {
        // Anything biting us right now gets engaged first; the
        // walk back happens on the NEXT tick once the bite is
        // settled.  Without this the zombie would turn his back
        // on a slime that's already in his face just to start the
        // walk home.
        const [biter] = nearestMonster(c, FIGHTER_ERRAND_BITE_R);
        if (biter) { startFighting(c, biter); return; }
        // Route him home as a rest errand: exitCombat sets state =
        // "wandering", then setTarget points him at the grave, and
        // the existing restErrand wander-arrival hook parks him
        // there in "working" so the grave's faster regen ticks
        // actually accumulate.  maybeEnterCombat keeps running on
        // every tick along the way, so any monster that wanders
        // into aggro on the journey gets engaged automatically.
        const grave = Scene.activity("zombie");
        exitCombat(c);
        c.restErrand = true;
        setTarget(c, grave.x + rr(-4, 4), grave.y + rr(-3, 3));
        return;
      }
      // strat === "flee" — fall through to the standard offstage flee.
    }

    enterCombatMode(c, "fleeing");
    const pick = pickExitEdge(c);
    const goLeft = pick.goLeft;
    const edgeX = pick.edgeX;
    // Picker already selected the best Y lane (current row, or
    // 60 / 120 / 180 px above/below) based on corridor scoring.
    // A small jitter so multiple heroes fleeing in the same beat
    // don't converge to a pixel-identical target.
    const edgeY = pick.edgeY + rr(-6, 6);
    void goLeft;
    // Refuge override: if the saucer (alien) or a safe healer /
    // reviver-capable ally (everyone else) is closer than the edge
    // and the path there is currently clear, head for THAT instead
    // of legging it off-stage.  tickFleeing handles arrival
    // (alien boards the UFO bypassing cooldown; everyone else
    // hands control back to maybeEnterCombat once parked next to
    // the friendly ally) and re-validates the route every
    // ~FLEE_REFUGE_RECHECK_MS in case a monster steps onto it.
    const refuge = findFleeRefuge(c, edgeX, edgeY);
    if (refuge) {
      refuge.edgeX = edgeX;
      refuge.edgeY = edgeY;
      refuge.checkAt = performance.now() + FLEE_REFUGE_RECHECK_MS;
      c.fleeRefuge = refuge;
      setTarget(c, refuge.x, refuge.y);
      Dialog.bark(c, "flee");
      return;
    }
    c.fleeRefuge = null;
    setTarget(c, edgeX, edgeY);
    // Honour the just-made decision for the initial commit window
    // so the very first tickFleeing replan (~FLEE_REPLAN_MS later)
    // can't undo a thoroughly-scored choice on noise.
    c._fleeFlipUntil = performance.now() + FLEE_FLIP_COOLDOWN_MS;
    Dialog.bark(c, "flee");
  }

  // Tactical retreat: pick a point that puts distance between us and
  // the nearest monster while nudging us toward a healer (or the
  // chest, if no healer is free).  Called when HP dropped below the
  // LOW threshold but we're not panicking yet.
  function startRetreating(c) {
    enterCombatMode(c, "retreating");
    c.combatTarget = null;
    c.retreatReplanAt = 0;
    updateRetreatTarget(c, performance.now());
  }

  function updateRetreatTarget(c, now) {
    // Witch delegates to WitchStrategy — chooseRetreatGoalNN when it
    // exists (the learned 36-param linear policy, which beats the
    // hand-tuned utility AI by 11-12% on held-out stand episodes),
    // otherwise chooseRetreatGoal (the utility AI).  Both consume the
    // same `world` snapshot; the NN path internally falls back to the
    // utility goal when its proposed target would land in the bite
    // ring, in the pond, or when the hydra isn't active (so we don't
    // give up haven-blend / sandwich-rescue during peacetime retreats).
    // If WitchStrategy isn't loaded at all — Node-only smoke suites
    // that include characters.js indirectly — fall through to the
    // in-place retreat implementation below.
    if (c.name === "witch" && typeof WitchStrategy !== "undefined" &&
        (WitchStrategy.chooseRetreatGoalNN || WitchStrategy.chooseRetreatGoal)) {
      const monsters = [];
      for (const o of Monsters.list) {
        if (!o || o.dying || o.fleeing) continue;
        const hidden = !!(Monsters.isHidden && Monsters.isHidden(o, c));
        monsters.push({ x: o.x, y: o.y, kind: o.kind, hidden });
      }
      const hydraOn = HydraPlan && HydraPlan.active && HydraPlan.active();
      const healer = findSafeHealer(c);
      const chestObj = Scene.chest && Scene.chest();
      const chestHealStock = (Scene.chestStockOf && Scene.chestStockOf("heal")) || 0;
      const havenChest = chestObj
        ? { x: chestObj.x, y: chestObj.y,
            healStock: chestHealStock + (witchDeliveringHeal() ? 1 : 0) }
        : null;
      // Friends = every other hero on the lawn that's still alive
      // and not fleeing offstage.  The learned NN uses the positions
      // of the two nearest ones (feature slots 18-23) to nudge the
      // retreat goal — "tuck behind a fighter if one is to your east"
      // is a weak but consistent signal on the stand.  We include
      // decoys as friends too: monsters aggro onto them, so
      // positionally they absorb damage just like a fighter does.
      const friends = [];
      for (const other of list) {
        if (other === c) continue;
        if (!other || other.dying || other.fleeing) continue;
        friends.push({ x: other.x, y: other.y, kind: other.name });
      }
      if (typeof decoys !== "undefined") {
        for (const d of decoys) {
          if (!d || d.fadeStartAt) continue;
          friends.push({ x: d.x, y: d.y, kind: "decoy" });
        }
      }
      const world = {
        witch: {
          x: c.x, y: c.y, hp: c.hp, hpMax: c.hpMax,
          activity: c.activity ? { x: c.activity.x, y: c.activity.y } : null,
          heldPotion: c.heldPotion || null,
        },
        monsters,
        friends,
        hydra: hydraOn ? {
          active: true,
          body: HydraPlan.body() || null,
          headRange: Monsters.HYDRA_HEAD_RANGE,
          spitR: HydraPlan.spitR ? HydraPlan.spitR()
                                 : (Monsters.HYDRA_SPIT_RANGE || 280),
          inSpitDanger: HydraPlan.inSpitDanger,
        } : { active: false },
        havens: {
          healer: healer ? { x: healer.x, y: healer.y } : null,
          chest: havenChest,
        },
        scene: {
          width: Scene.WIDTH,
          floorTop: Scene.FLOOR_TOP,
          floorBottom: Scene.FLOOR_BOTTOM,
          isInPond: Scene.isInPond,
          pondBounds: Scene.pondBounds,
        },
        tunables: {
          // Larger projection distance than the global RETREAT_STEP
          // (120): tuned via tools/witch-stand.js across 5 seeds ×
          // 5000 episodes — a 260-px step reduces per-episode damage
          // to the witch by a consistent 17–19% vs. 120, AND cuts the
          // worst-case damage (episode max) from ~117 to ~85.  The
          // effect comes from two places: (a) the away-vector goal
          // commits harder to one direction, reducing the mid-tick
          // replan that used to re-aim into a shifting threat, and
          // (b) the 16-ray escape sweep now evaluates longer rays,
          // so a cleanly-open direction at 220 px beats a
          // partially-blocked one at 120 px when the close band is
          // dirty.  Girl / fighters / alien still use the global
          // RETREAT_STEP — this tune is witch-specific because
          // she's the only hero whose death is a game-ender.
          retreatStep: 260,
          multiThreatR: 220,
          safeHavenBlend: SAFE_HAVEN_BLEND,
        },
      };
      const goal = WitchStrategy.chooseRetreatGoalNN
        ? WitchStrategy.chooseRetreatGoalNN(world)
        : WitchStrategy.chooseRetreatGoal(world);
      setTarget(c, goal.tx, goal.ty);
      c.retreatReplanAt = now + rr(...RETREAT_REPLAN_MS);
      return;
    }
    // Multi-threat away vector.  The earlier "step away from the
    // ONE nearest monster" goal was the source of the textbook
    // "retreated straight into the second slime" bug — with two
    // monsters flanking the hero, the away-from-nearest direction
    // points right through the other one.  We now poll every threat
    // inside MULTI_THREAT_R and let `Monsters.threatVector` build a
    // weighted away unit vector (1/d² fall-off so closer monsters
    // dominate) so the retreat goal points OUT THE SEAM between
    // multiple pursuers.  Falls back to the single-nearest-monster
    // direction (with a 9999 px search radius) when nothing's in
    // the multi-threat bubble — better to keep moving away from a
    // distant straggler than pick a blank goal that would make the
    // hero stand still.
    const MULTI_THREAT_R = 220;
    const tv = Monsters.threatVector(c.x, c.y, MULTI_THREAT_R);
    let awayX = c.x, awayY = c.y;
    let m = null;
    if (tv.count > 0 && (tv.dx !== 0 || tv.dy !== 0)) {
      // Threats average out to a non-degenerate seam — head OUT of
      // the cluster.  When count >= 2 we widen the y component a
      // little (×0.45 vs ×0.3) so a hero pinned between two slimes
      // sliding toward him along the same horizontal can still
      // dodge perpendicular into the seam, instead of being forced
      // back along the very axis the slimes are pinching.
      const yMul = (tv.count >= 2) ? 0.45 : 0.3;
      awayX = c.x + tv.dx * RETREAT_STEP;
      awayY = c.y + tv.dy * RETREAT_STEP * yMul;
      // Surface the closest contributing monster for the haven /
      // path checks below — they want a representative threat.
      [m] = nearestMonster(c, MULTI_THREAT_R);
    } else {
      [m] = nearestMonster(c, 9999);
      if (m) {
        const dx = c.x - m.x;
        const dy = c.y - m.y;
        const d = Math.hypot(dx, dy) || 1;
        awayX = c.x + (dx / d) * RETREAT_STEP;
        awayY = c.y + (dy / d) * RETREAT_STEP * 0.3;
      } else {
        // No monster on stage?  Nothing to run from — just rest near
        // the activity station.
        awayX = c.activity.x;
        awayY = c.activity.y;
      }
    }

    // Pick a safe haven: healer first, chest second.  The chest is
    // a haven when there's already a heal bottle waiting AND when
    // the witch is mid-deposit / about to deposit one — wounded
    // heroes loiter at the lid so they can grab the bottle the
    // moment it lands instead of pacing the lawn.
    const healer = findSafeHealer(c);
    let havenX = null, havenY = null;
    if (healer) {
      havenX = healer.x;
      havenY = healer.y;
    } else if (Scene.chestStockOf("heal") > 0 || witchDeliveringHeal()) {
      const ch = Scene.chest();
      havenX = ch.x;
      havenY = ch.y;
    }

    let tx = awayX, ty = awayY;
    if (havenX !== null) {
      // Don't blend toward a haven that requires walking PAST the
      // monster we're retreating from.  Without this guard the girl
      // would happily sprint into a slime to reach the witch
      // standing on the other side of it — the haven blend overrode
      // the away-from-monster vector and the result was "she
      // retreats straight into the bite".  We treat the haven as
      // valid only when (a) it's on the opposite side of us from
      // the threat (different x sign) OR (b) it's on the same side
      // but closer than the threat (we'd reach it before the
      // monster) OR (c) the straight-line path to it doesn't pass
      // anywhere near any monster.  Otherwise we drop the blend
      // and just retreat directly along the away vector — staying
      // on the lawn, looking for a fresh opening — instead of
      // pathing through the chew radius to a friendly corner.
      let havenUsable = true;
      if (m) {
        const havenSign  = Math.sign(havenX - c.x);
        const threatSign = Math.sign(m.x      - c.x);
        const havenDist  = Math.hypot(havenX - c.x, havenY - c.y);
        const threatDist = Math.hypot(m.x - c.x, m.y - c.y);
        const sameSide = havenSign !== 0 && havenSign === threatSign;
        const havenPast = havenDist > threatDist - 4;
        if (sameSide && havenPast) {
          // The "save us" tile is geometrically behind the bite.  If
          // a clear-line path actually exists (threat is well off
          // axis, etc.) we still take it; only veto when the corridor
          // itself is dirty.
          if (Monsters.anyOnPath(c.x, c.y, havenX, havenY, 30)) {
            havenUsable = false;
          }
        }
      }
      if (havenUsable) {
        tx = havenX * SAFE_HAVEN_BLEND + awayX * (1 - SAFE_HAVEN_BLEND);
        ty = havenY * SAFE_HAVEN_BLEND + awayY * (1 - SAFE_HAVEN_BLEND);
      }
    }

    // Keep us on the lawn.
    tx = Math.max(20, Math.min(Scene.WIDTH - 20, tx));
    ty = Math.max(Scene.FLOOR_TOP + 10, Math.min(Scene.FLOOR_BOTTOM - 10, ty));

    // Sandwich rescue: if the goal we just picked is ITSELF inside a
    // monster's bubble, OR the straight-line PATH to it passes through
    // a monster's bubble, OR (during a hydra fight) it sits inside the
    // body's bite/spit zone, the away-vector is steering us into one
    // of the surrounding pincers.  Cover ALL geometries — single side,
    // two-sided pinch, three-sided encirclement, full surround — by
    // delegating to the same angular-sweep evader that tickFleeing
    // uses: it samples 16 escape rays around the hero, scores each
    // by clean-path distance + endpoint safety, and returns the
    // best.  This is the practical answer to "if left, right, and down
    // are blocked, will she go up?" — the up ray genuinely is
    // clean and naturally wins the score, even though a summed
    // potential field would give a degenerate vector.  Endpoint-only
    // checks would miss the bounce case (target sits past the other
    // pincer with a clean endpoint and dirty path); anyOnPath catches
    // it.
    const goalUnsafe =
      Monsters.anyThreat(tx, ty, 36) ||
      (Monsters.anyOnPath && Monsters.anyOnPath(c.x, c.y, tx, ty, 30)) ||
      (HydraPlan && HydraPlan.active && HydraPlan.active() &&
        (HydraPlan.inSpitDanger(tx, ty) ||
         witchInHydraDangerAt(tx, ty)));
    if (goalUnsafe) {
      const best = bestEscapeDirection(c, RETREAT_STEP);
      if (best) {
        // Witch boss filter: never accept an evade that lands her in
        // hydra danger, even if the regular score said it was the
        // best ray (witchInHydraDangerAt is a stricter envelope
        // than the body-spit check baked into bestEscapeDirection).
        const witchHydraBad = c.name === "witch" &&
          witchInHydraDangerAt(best.x, best.y);
        if (!witchHydraBad) {
          tx = best.x; ty = best.y;
        } else {
          // Every escape ray is hydra-bad too.  Falling through to
          // the original (also unsafe) blended target is what the
          // user kept seeing as "heading toward the hydra again": the away vector
          // happened to point through the spit envelope, the haven
          // blend pulled her further toward the cauldron (which
          // sits inside spit reach during a hydra fight), and the
          // escape sweep couldn't find anything safer — but the
          // setTarget call below committed to the bad blend anyway.
          // Pin in place so the next tick re-evaluates after the
          // body has shifted, instead of marching her into spit /
          // bite this frame.
          tx = c.x; ty = c.y;
        }
      }
    }

    // If the blended target lands in the pond, flip to the opposite
    // bank so we walk around it rather than trying to wade in.
    if (Scene.isInPond(tx, ty, 8)) {
      const P = Scene.pondBounds();
      if (P) {
        ty = (c.y < P.cy) ? (P.cy - P.ry - 10) : (P.cy + P.ry + 10);
        ty = Math.max(Scene.FLOOR_TOP + 10,
                      Math.min(Scene.FLOOR_BOTTOM - 10, ty));
      }
    }

    setTarget(c, tx, ty);
    c.retreatReplanAt = now + rr(...RETREAT_REPLAN_MS);
  }

  // Collapse where you stand.  The body stays on the lawn until a
  // reviver comes along; `tx/ty` are nailed to the current spot so
  // any stale movement target doesn't drag the corpse around.  A
  // small puff sells the moment of falling over.
  function startDying(c) {
    c.ufoCrashAnim = null;
    enterCombatMode(c, "dead");
    c.combatTarget = null;
    c.partner = null;
    c.activeConvo = null;
    // Drop any social-deal state that depends on c being upright:
    // morale buff and pact lapse on death (the partner shouldn't
    // be running across the lawn looking for a corpse to flank
    // with).  Lookout sash also clears — a lookout who just hit
    // the ground isn't watching anything.  Affinity persists; the
    // pair still remembers each other when c gets revived.
    c.pact = null;
    c.moraleUntil = 0;
    c.lookoutUntil = 0;
    c._swapShift = false;
    // If the carrier is killed mid-errand, the bottle they were
    // walking goes onto the grass — any passer-by who needs it can
    // grab it.  Heal bottles are auto-routed via findNearbyGroundHeal
    // (any wounded hero in pickup range), revive bottles via
    // findNearbyGroundRevive (any non-reviver in pickup range, when
    // there's a corpse to use it on).  Dropped bottles persist on the
    // lawn indefinitely — they wait there until someone picks them up.
    if (c.heldPotion) {
      const kind = c.heldPotion.potionKind || c.heldPotion.kind || "heal";
      if (kind === "heal" || kind === "revive") {
        Scene.dropPotion(c.x, c.y, kind);
      }
    }
    c.heldPotion = null;
    // Spare revive bottle (carried passively after a chest drink — see
    // tickDrinking's "open" phase) also hits the dirt so the next non-
    // reviver in pickup range can grab it and finish a corpse run.  We
    // only ever model one spare per carrier, but multiple corpses worth
    // of bottles can pile up on the lawn naturally as several carriers
    // fall in the same fight.
    if (c.spareRevive) {
      Scene.dropPotion(c.x, c.y, "revive");
      c.spareRevive = false;
    }
    c.drinkPhase = null;
    c.depositPhase = null;
    c.deliverPhase = null;
    c.deliverTarget = null;
    c.revivePhase = null;
    // Release any ground-bottle reservation we were walking toward;
    // tickGroundPotions clears stale claimers too, but doing it here
    // means another hero can re-claim on the next tick instead of
    // waiting for the prune pass to notice.
    if (c.targetGroundPotion) {
      if (c.targetGroundPotion.claimer === c) c.targetGroundPotion.claimer = null;
      c.targetGroundPotion = null;
    }
    // Drop any UFO revive lock too — if the alien gets shot down (or
    // dies on foot mid-flight) and is later brought back, we don't
    // want him taking off again with a dangling pointer at a corpse
    // that might have been resurrected by someone else in the
    // meantime.  And it lets corpseClaimer release the body to the
    // next reviver immediately, without relying on the combatMode
    // gate alone.
    c.ufoReviveTarget = null;
    c.ufoReviveUntil = 0;
    // Alien shot down WHILE PILOTING the saucer (bite from a head
    // that reared up to flight altitude, ricochet, fall damage, …).
    // Without this branch the dome stays drawn with the dead pilot
    // (`ufo.piloted` never flips), the saucer hangs forever at its
    // last flight offset, and `c.x / c.y` are still synced to the
    // saucer — i.e. the corpse is "in the sky", out of reach for any
    // ground reviver.  User-reported "UFO just hangs there and does nothing"
    // is exactly this: tickUfoing no longer runs (combatMode is now
    // "dead"), tickDead does nothing for the alien (only zombies
    // self-revive there), so the saucer is stuck mid-air with a
    // dead pilot until the boss fight ends.
    //
    // Eject: snap the saucer down to wherever it currently is (so
    // the visual reads as "crashed where it died", not a teleport
    // back to the original landing pad), drop the body on the same
    // tile so revivers can reach it, and reset the saucer's pilot
    // state so a freshly-revived alien (or a different hero who
    // happens to revive on the spot) sees a clean unpiloted UFO.
    // Also kick off the standard ground cooldown so the just-
    // revived alien doesn't immediately try to board again mid-
    // rebirth.
    if (c.role === "alien" && c.boarded) {
      const ufo = Scene.ufo && Scene.ufo();
      if (ufo) {
        const newX = ufo.x + (ufo.flyDx || 0);
        const newY = ufo.y + (ufo.flyDy || 0);
        const minX = 30, maxX = (Scene.WIDTH || 720) - 30;
        const minY = (Scene.FLOOR_TOP || 40) + 10;
        const maxY = (Scene.FLOOR_BOTTOM || (Scene.FLOOR_TOP + 100)) - 10;
        ufo.x = Math.max(minX, Math.min(maxX, newX));
        ufo.y = Math.max(minY, Math.min(maxY, newY));
        ufo.flyDx = 0;
        ufo.flyDy = 0;
        ufo.flyTargetDx = 0;
        ufo.flyTargetDy = 0;
        ufo.ufoBoardLift = 0;
        ufo.piloted = false;
        c.x = ufo.x; c.y = ufo.y;
        if (Combat && Combat.puff) {
          Combat.puff(c.x, c.y - 18, "rgba(255,180,140,0.85)");
        }
      }
      c.boarded = false;
      c.sortieStartAt = null;
      c.ufoCooldownUntil = performance.now() + rr(...UFO_COOLDOWN_MS);
    }
    // Cancel any open "Help!" call so responders don't keep running
    // toward a corpse that's already past helping.
    c.helpRequestUntil = 0;
    c.helpAttacker = null;
    // Drop any in-flight flower errand — the bloom is forfeit, but
    // keeping the flag set here would have the corpse's next revive
    // drop them straight into a wander toward the garden.  Same
    // reasoning for the warming / resting detours.
    c.flowerErrand = false;
    c.warmErrand = false;
    c.restErrand = false;
    c.chargeErrand = false;
    // Girl killed mid-summon / mid-ride: drop the horse on the
    // spot.  The summon cooldown is reset to the short cancel value
    // so a freshly-revived girl isn't locked out of the mount for
    // 80 s on top of the death penalty itself.
    if (c.horseEntity) {
      c.horseEntity = null;
      c.horseCooldownUntil = performance.now() + HORSE_CANCEL_CD_MS;
    }
    c.mounted = false;
    c.mountedUntil = 0;
    // Mid-spin death: the decoy clearly never finished spawning, so
    // just clear the cast state and let her revival come back to a
    // fresh cooldown.  An already-spawned decoy is left to fade on
    // its own schedule — the clone is what monsters were chasing
    // when she went down, so dispelling it instantly looks worse
    // than letting it puff out a beat later.
    if (c.decoyCastUntil > 0) {
      c.decoyCastUntil = 0;
      c.decoyCooldownUntil = performance.now() + DECOY_CANCEL_CD_MS;
    }
    c.tx = c.x;
    c.ty = c.y;
    c.hp = 0;
    c.deathAt = performance.now();
    c.hitFlashUntil = 0;
    c.castFlashUntil = 0;
    // Zombie-only self-revive bookkeeping.  Always reset both
    // fields up front so a zombie who died far from his grave
    // (no self-revive) doesn't carry stale timers from a previous
    // life into this one — and so a freshly-revived zombie's
    // *next* death is evaluated cleanly.
    c.selfReviveAt = 0;
    c.selfReviveCastUntil = 0;
    if (c.name === "zombie") {
      const grave = Scene.activity && Scene.activity("zombie");
      if (grave) {
        const dg = Math.hypot(c.x - grave.x, c.y - grave.y);
        if (dg <= ZOMBIE_SELF_REVIVE_R) {
          c.selfReviveAt = performance.now() + ZOMBIE_SELF_REVIVE_DELAY_MS;
        }
      }
    }
    Dialog.cancel(c);
    Dialog.note("heroDown");
    Combat.deathPuff(c.x, c.y - 14);
  }

  function startReviving(c, corpse) {
    enterCombatMode(c, "reviving");
    c.combatTarget = corpse;
    c.revivePhase = "approach";
    c.combatUntil = 0;
    const range = reviveRangeOf(c);
    // Same threat-aware standoff as the heal path: stand on the side
    // of the corpse opposite to whatever monster is closest, so the
    // girl doesn't sprint TOWARD a slime camped on the body just to
    // "stand back".
    const stand = standoffNear(c, corpse.x, corpse.y, range);
    setTarget(c, stand.x, stand.y);
  }

  // Speed multiplier for a reviver running to a body — scales up
  // with how many bodies are on the ground so a triage situation
  // actually feels triaged.  Caps at ~1.6x to keep the sprite
  // animation readable.
  function reviverSpeedMul() {
    const corpses = countCorpses();
    if (corpses >= 3) return 1.6;
    if (corpses >= 2) return 1.4;
    return 1.2;
  }

  // Anyone (not just witch / firemage / girl) can run a revive
  // potion to a fallen ally.  The flow:
  //   1. walk to the chest        ("approachChest")
  //   2. open the lid             ("openChest")
  //   3. take the bottle, step    ("backstep")
  //      aside one tile so the
  //      next user can use the
  //      chest right after us
  //   4. carry it to the corpse   ("toCorpse")
  //   5. smash it on the body     ("use")  -> resurrect()
  // The runner picks up the heldPotion at step 3 and drops it at
  // step 5 (smash effect comes from Combat.potionReviveSmash).
  function startPotionRevive(c, corpse) {
    enterCombatMode(c, "potionReviving");
    c.combatTarget = corpse;
    c.combatUntil = 0;
    c.heldPotion = null;
    const occupant = chestInUseBy(c);
    if (occupant) {
      c.revivePhase = "waitChest";
      const t = chestWaitTarget(c, occupant);
      setTarget(c, t.x, t.y);
    } else {
      c.revivePhase = "approachChest";
      const chest = Scene.chest();
      setTarget(c, chest.x, chest.y + 2);
    }
  }

  // Spare-bottle revive: a non-reviver who picked up a revive at the
  // chest (alongside a heal — see tickDrinking's "open" phase) walks
  // straight to the corpse with the spare in hand.  No chest fetch /
  // queue / open beat — we just drop the carrier into the same
  // "toCorpse" → "use" sub-states the chest path would have ended at,
  // so all the existing approach safety checks, smash effect, and
  // resurrect handshake apply unchanged.  Clears the spare flag the
  // moment the bottle becomes a visible held item, so a death mid-
  // approach drops one bottle (the held one), not two.
  function startSpareRevive(c, corpse) {
    enterCombatMode(c, "potionReviving");
    c.combatTarget = corpse;
    c.combatUntil = 0;
    c.heldPotion = { kind: "deliver", potionKind: "revive" };
    c.spareRevive = false;
    c.revivePhase = "toCorpse";
    const side = corpse.x > c.x ? -1 : 1;
    setTarget(c, corpse.x + side * (REVIVE_RANGE - 6), corpse.y);
  }

  function startUfoing(c) {
    enterCombatMode(c, "ufoing");
    const ufo = Scene.ufo();
    // Walk to the UFO pad first; boarding flips c.boarded on in
    // tickUfoing once we've arrived.
    setTarget(c, ufo.x, ufo.y);
    c.combatUntil = 0;
    c.lastAttackAt = 0;
    c.boarded = false;
    c.ufoReviveTarget = null;
    c.ufoReviveUntil = 0;
    // Saucer takes off with whatever charge it accumulated on the
    // pad — see step()/tickStations recharge below.  Always cap to
    // MAX in case ground regen ran longer than needed.
    if (c.ufoEnergy == null) c.ufoEnergy = UFO_ENERGY_MAX;
    c.ufoEnergy = Math.min(UFO_ENERGY_MAX, c.ufoEnergy);
  }

  // ----- girl's horse mount --------------------------------------------
  //
  // Three combat sub-states + a runtime flag drive the whole feature:
  //   "summoningHorse"  brief stand-still cast (HORSE_CAST_MS).  A hit
  //                     during the cast cancels it onto the short
  //                     HORSE_CANCEL_CD_MS lockout; a successful cast
  //                     spawns the horseEntity and transitions to
  //                     "horseApproach".
  //   "horseApproach"   girl idles, horse trots in from
  //                     HORSE_SPAWN_OFFSET_X away.  When the horse is
  //                     within HORSE_MOUNT_R she mounts (sets the flag,
  //                     drops back to combatMode "none" so normal AI
  //                     resumes).  HORSE_APPROACH_TIMEOUT_MS is the
  //                     graceful escape for path failures.
  //   c.mounted (flag)  not a combatMode so the rest of the AI keeps
  //                     using its existing modes (healing, fleeing,
  //                     retreating).  moveStep multiplies speed by
  //                     HORSE_RIDE_SPEED_MUL while it's set, and the
  //                     heal cooldown / power are scaled in tickHealing
  //                     (the only "drive-by" cast we currently allow).
  //                     Auto-dismount at mountedUntil or when a fresh
  //                     corpse needs reviving.
  //   "dismounting"     short fade-out (HORSE_DISMOUNT_MS).  After it,
  //                     horseEntity is cleared and HORSE_COOLDOWN_MS
  //                     starts ticking down.

  function maybeSummonHorse(c, now, reason, ally) {
    if (c.name !== "girl") return false;
    if (!Sprites.hasExtra || !Sprites.hasExtra("horse")) return false;
    if (c.mounted || c.horseEntity) return false;
    if (now < c.horseCooldownUntil) return false;
    // Don't summon mid-channel of any "this character is busy" mode
    // — those have their own cleanup logic and would leak a horse
    // entity if interrupted by enterCombatMode.
    const m = c.combatMode;
    if (m === "reviving" || m === "drinking" || m === "depositing" ||
        m === "delivering" || m === "summoningHorse" ||
        m === "horseApproach" || m === "dismounting" || m === "dead") {
      return false;
    }
    if (reason === "commute") {
      if (!ally) return false;
      const d = Math.hypot(ally.x - c.x, ally.y - c.y);
      if (d < HORSE_COMMUTE_MIN_DIST) return false;
      // Already inside (most of) the heal range?  No point mounting
      // up — she'd waste the cast just to step 20 px closer.
      if (d < GIRL_HEAL_RANGE * 0.85) return false;
      // Ally must actually need the long-range gallop — a barely-
      // scratched friend at the other end of the lawn isn't worth
      // burning the long cooldown on.
      if (ally.hp >= ally.maxHp * HORSE_COMMUTE_HP_FRAC) return false;
    } else if (reason === "revive") {
      // `ally` here is the corpse (passed from the revive branch in
      // maybeEnterCombat).  Only justify the gallop if the corpse is
      // genuinely far away — short-walk revives don't need a mount.
      if (!ally) return false;
      const d = Math.hypot(ally.x - c.x, ally.y - c.y);
      if (d < HORSE_REVIVE_MIN_DIST) return false;
    } else if (reason === "panic") {
      if (c.hp >= c.maxHp * HORSE_PANIC_FRAC) return false;
      if (!Monsters.anyThreat(c.x, c.y, HORSE_PANIC_DANGER_R)) return false;
    } else if (reason === "boss") {
      // Boss-fight horse trigger.  The standard "panic" gate
      // requires a monster within HORSE_PANIC_DANGER_R (70 px),
      // which almost never holds during a hydra fight: the body
      // sits in the corner (>200 px from the healer pocket), the
      // spit lands as a projectile (anyThreat reads live monster
      // POSITIONS, not airborne hazards), and bites only happen
      // after a head has already chewed her once.  Result: the
      // healer was walking through acid on foot.  This branch
      // fires the gallop on the conditions that actually matter
      // for the boss:
      //   • HydraPlan must be active AND in engage phase (no point
      //     burning the 80 s cooldown during the rally walk-in);
      //   • either she's standing inside the spit envelope with no
      //     plan to heal someone right now (= she'd just eat the
      //     next acid ball idle), OR her HP is below the healer-
      //     pocket safety floor (HORSE_BOSS_HP_FRAC).
      // The cooldown is honest — one gallop per ~80 s, same as
      // the other reasons.
      if (!HydraPlan.active() || !HydraPlan.inEngage()) return false;
      const inAcid = HydraPlan.inSpitDanger(c.x, c.y);
      const lowEnough = c.hp < c.maxHp * HORSE_BOSS_HP_FRAC;
      if (!inAcid && !lowEnough) return false;
    } else {
      return false;
    }
    summonHorse(c, now);
    return true;
  }

  function summonHorse(c, now) {
    enterCombatMode(c, "summoningHorse");
    c.combatTarget = null;
    c.combatUntil = now + HORSE_CAST_MS;
    c.horseSummonAt = now;
    c.castFlashUntil = now + HORSE_CAST_MS;
    // Park the cast tile so moveStep doesn't drag her around during
    // the channel — `setTarget` would normally trigger a walk, but
    // pinning tx/ty to her current pixel makes moveStep no-op.
    setTarget(c, c.x, c.y);
    c.frame = 0;
    if (Combat.summonHorseAura) Combat.summonHorseAura(c, c.combatUntil);
    Dialog.bark(c, "summonHorse");
  }

  function cancelHorseSummon(c, now) {
    c.horseCooldownUntil = now + HORSE_CANCEL_CD_MS;
    c.castFlashUntil = 0;
    exitCombat(c);
  }

  function spawnHorseEntity(c, now) {
    const dirSign = c.dir === "l" ? -1 : 1;
    let sx = c.x + dirSign * HORSE_SPAWN_OFFSET_X;
    // Don't spawn the horse inside the pond — slide along the lawn
    // edge instead.  Tries the opposite side as a fallback if the
    // facing-side spawn would land in water; if both sides are wet
    // (vanishingly unlikely on a normal lawn) we just clip the
    // spawn to the canvas edge and let approach handle the rest.
    if (Scene.isInPond && Scene.isInPond(sx, c.y, 8)) {
      sx = c.x - dirSign * HORSE_SPAWN_OFFSET_X;
    }
    sx = Math.max(8, Math.min(Scene.WIDTH - 8, sx));
    c.horseEntity = {
      x: sx,
      y: c.y,
      // Face toward the rider so the gallop reads as "running TO her"
      // (will be overwritten every frame in tickHorseApproach).
      dir: sx >= c.x ? "l" : "r",
      frame: 0,
      frameTimer: 0,
      mode: "spawn",
      spawnStartAt: now,
      spawnUntil: now + 240,
      approachUntil: now + HORSE_APPROACH_TIMEOUT_MS,
    };
  }

  function tickSummoningHorse(c, dt, now) {
    if (now >= c.combatUntil) {
      spawnHorseEntity(c, now);
      enterCombatMode(c, "horseApproach");
      // enterCombatMode resets frame/timer; nothing else to do — the
      // approach tick takes over next frame.
      return;
    }
    // Stand and channel.  castFlashUntil keeps her sprite glowing for
    // the duration; the aura effect (Combat.summonHorseAura) draws the
    // sparkles + growing horse silhouette over her head.
    c.frame = 0;
  }

  function tickHorseApproach(c, dt, now) {
    const h = c.horseEntity;
    if (!h) {
      // Lost the entity somehow (spawn aborted, etc.) — bail out
      // cleanly rather than leaving the girl frozen.
      c.horseCooldownUntil = now + HORSE_CANCEL_CD_MS;
      exitCombat(c);
      return;
    }
    // Spawn shimmer is cosmetic only — the horse still trots while
    // the alpha tween plays so the entry doesn't feel laggy.
    //
    // Approach safety-valve: if pathing genuinely got stuck (girl
    // ended up unreachable across the pond, etc.) the trot bails
    // out and refunds the cast onto the SHORT cancel cooldown.
    // The previous behaviour ran startDismount, which paints a
    // dissolve and stamps the full 80 s cooldown — but no ride
    // ever happened, so charging her the full timer reads as "the
    // spell ate itself".  HORSE_APPROACH_TIMEOUT_MS is set
    // generously enough that this branch only ever triggers on a
    // genuinely stuck horse, but the refund matters when it does.
    if (now >= h.approachUntil) {
      c.horseEntity = null;
      c.horseCooldownUntil = now + HORSE_CANCEL_CD_MS;
      exitCombat(c);
      return;
    }
    const dx = c.x - h.x;
    const dy = c.y - h.y;
    const d = Math.hypot(dx, dy);
    if (d < HORSE_MOUNT_R) {
      mountUp(c, now);
      return;
    }
    if (h.mode === "spawn" && now >= h.spawnUntil) h.mode = "approach";
    // The girl walks toward the incoming horse too so the meeting
    // happens roughly twice as fast as the horse-only trot — standing
    // still during the approach left her exposed to anything already
    // biting her (the user-reported "horse comes but she just stands
    // there getting eaten").  We skip the step only when the straight
    // line to the horse would drag her THROUGH a live monster: in
    // that case holding position and letting the horse close the gap
    // is strictly safer than walking into a second set of teeth.
    // moveStep already honours root / chill / pond / cave, so nothing
    // extra is needed on the hero side.
    const pathBlocked = Monsters.anyOnPath &&
                        Monsters.anyOnPath(c.x, c.y, h.x, h.y, 22);
    if (!pathBlocked) {
      setTarget(c, h.x, h.y);
      moveStep(c, dt, 1.0);
    }
    const s = SPEED * HORSE_APPROACH_SPEED_MUL * dt / 1000;
    // Re-read the girl's position — she may have stepped toward the
    // horse this frame — so the horse aims at where she actually is,
    // not where she was at the top of the tick.
    const hdx = c.x - h.x;
    const hdy = c.y - h.y;
    const hd  = Math.hypot(hdx, hdy) || 1;
    const step = Math.min(hd, s);
    let nx = h.x + (hdx / hd) * step;
    let ny = h.y + (hdy / hd) * step;
    if (Scene.avoidPondStep) {
      [nx, ny] = Scene.avoidPondStep(h.x, h.y, nx, ny, c.x, c.y, h);
    }
    if (Scene.avoidCaveStep) {
      [nx, ny] = Scene.avoidCaveStep(h.x, h.y, nx, ny, c.x, c.y, h);
    }
    h.x = nx;
    h.y = ny;
    h.dir = hdx >= 0 ? "r" : "l";
    h.frameTimer += dt;
    // Faster cadence than the hero walk frames so the gallop reads
    // like a real run instead of a slow trot.
    if (h.frameTimer >= FRAME_MS / 2) {
      h.frameTimer = 0;
      h.frame ^= 1;
    }
    if (pathBlocked) {
      // Path-blocked fallback: we didn't move this tick, so keep the
      // "watching the horse arrive" idle pose instead of whatever
      // stale facing/frame a previous tick left behind.
      c.dir = h.x >= c.x ? "r" : "l";
      c.frame = 0;
    }
  }

  function mountUp(c, now) {
    c.mounted = true;
    // Ride duration: the constant HORSE_RIDE_MS (~11 s) was tuned for
    // the 800 px default canvas — at the mounted speed (SPEED *
    // HORSE_RIDE_SPEED_MUL ≈ 53 px/s) that's ~585 px, which is ~73 %
    // of an 800 px lawn but only ~49 % of a 1200 px one.  Recompute
    // the ride window per-mount from the live Scene.WIDTH so the
    // gallop reliably covers ~70 % of the lawn no matter what canvas
    // size the runtime ended up using.  We take whichever is longer
    // (the original constant or the width-derived minimum) so a hand-
    // tuned increase to HORSE_RIDE_MS never gets clipped, and add a
    // small extra cushion so the auto-dismount fires *after* she's
    // had time to actually arrive at her wander goal at the far
    // edge — without the cushion she'd sometimes dissolve mid-stride
    // a few pixels short of the destination.
    const mountedSpeed = SPEED * HORSE_RIDE_SPEED_MUL;
    const widthRideMs = (Scene.WIDTH * 0.70 / mountedSpeed) * 1000 + 800;
    c.mountedUntil = now + Math.max(HORSE_RIDE_MS, widthRideMs);
    // Fresh ride — restart the idle-grace clock so the auto-dismount
    // safety net gives her the full window to find an errand before
    // bailing.
    c.mountedBusyAt = now;
    if (c.horseEntity) {
      // Snap the horse to the rider's anchor so the first mounted
      // frame doesn't show a half-pixel offset between rider and
      // saddle.  All subsequent updates flow through moveStep.
      c.horseEntity.x = c.x;
      c.horseEntity.y = c.y;
      // Sync horse facing to the rider's facing.  During the trot-in
      // the horse was running TOWARD the girl, so its sprite faced
      // opposite of hers (she was looking at it); without this sync
      // the very first mounted frame would render the rider seated
      // backwards (head over the horse's tail) until the next walk
      // step in moveStep overwrote h.dir.  The stationary branch of
      // moveStep also re-syncs every frame so a turn-in-place while
      // mounted keeps both pointing the same way.
      c.horseEntity.dir = c.dir;
      c.horseEntity.mode = "ridden";
      c.horseEntity.frame = 0;
      c.horseEntity.frameTimer = 0;
    }
    // Drop back to normal AI — the heal/flee branches will pick the
    // next destination on the very next maybeEnterCombat tick.  We
    // intentionally do NOT call exitCombat here because that would
    // also clear horseEntity / mounted via no-op (it doesn't touch
    // those fields, but it does reset wandering, which we want).
    c.combatMode = "none";
    c.combatTarget = null;
    // Always seed a wander destination so the horse actually goes
    // somewhere, even when the situation that justified the summon
    // (panic threat, distant ally, distant corpse) resolved itself
    // between the cast and the mount.  Without this the rider would
    // sit on the saddle for one frame, get no errand from the next
    // maybeEnterCombat pass, and the idle-dismount safety net would
    // dissolve the horse a few seconds later — visually "appeared,
    // mounted, gone".  Real heal / revive errands still preempt
    // this on the very next tick via maybeEnterCombat; the wander
    // is just the fallback so the ride is never wasted.
    c.state = "wandering";
    c.wandersLeft = 1;
    c.stateUntil = now + rr(...WANDER_STEP_MS);
    const [nx, ny] = randomLawnPoint(c);
    setTarget(c, nx, ny);
    Dialog.bark(c, "mountUp");
  }

  function startDismount(c, now) {
    enterCombatMode(c, "dismounting");
    c.combatTarget = null;
    c.combatUntil = now + HORSE_DISMOUNT_MS;
    if (c.horseEntity) {
      c.horseEntity.mode = "fading";
      c.horseEntity.fadeStartAt = now;
      c.horseEntity.fadeUntil = now + HORSE_DISMOUNT_MS;
    }
    // Park during the dissolve so the rider doesn't moonwalk while
    // the horse melts under her.
    setTarget(c, c.x, c.y);
  }

  // Mounted-girl errand: gallop to a fallen ally, dismount on arrival.
  // The next maybeEnterCombat pass after dismount picks up the corpse
  // via the regular canRevive → startReviving path (mounted girls
  // can't channel revives, so the dismount has to happen FIRST).
  // Used by the "revive" reason of maybeSummonHorse so a far-away
  // corpse actually gets ridden toward instead of leaving the healer
  // stationary on the horse waiting for the ride timer to expire.
  function startRideToCorpse(c, corpse) {
    enterCombatMode(c, "ridingToCorpse");
    c.combatTarget = corpse;
    // Reset any latched detour direction from a previous gallop so
    // tickRideToCorpse picks fresh geometry.
    c.detourDir = 0;
    // Aim a touch off-axis so the dismount lands beside the body
    // rather than on top of it (matches the standoff trick the
    // ground reviver uses).  tickRideToCorpse refreshes this every
    // tick with role-aware standoff + hydra detour, so this is just
    // the first-tick aim.
    const range = reviveRangeOf(c);
    const side = corpse.x >= c.x ? -1 : 1;
    setTarget(c, corpse.x + side * (range - 6), corpse.y);
  }

  function tickRideToCorpse(c, dt, now) {
    const corpse = c.combatTarget;
    // Body got revived by someone else (or vanished offstage) — bail
    // and let the normal AI find the next thing to do.
    if (!corpse || corpse.combatMode !== "dead" || !isVisibleNow(corpse)) {
      startDismount(c, now);
      return;
    }
    // Drive-by heal mid-gallop: if a wounded ally is right under
    // the hooves, dismount-via-heal-redirect (startHealing flips
    // her into "healing" mode; tickHealing will channel the heal
    // mounted, then shouldDropForRevive will route her back to the
    // corpse afterward).  We don't want to gallop a half-dead
    // knight while mounted; one tick of holy rain costs us a few
    // hundred ms but is strictly better than ignoring him.
    if (maybePassingHeal(c, now)) return;
    // Use the role-aware revive range — the girl casts at
    // GIRL_REVIVE_RANGE (64 px), so dismounting at REVIVE_RANGE
    // (24 px) drops her dangerously close to the corpse and (when
    // the corpse is near the boss) inside head-bite reach.
    const range = reviveRangeOf(c);
    const hydraOn = HydraPlan && HydraPlan.active && HydraPlan.active();
    const body = hydraOn ? HydraPlan.body() : null;
    // Hydra-aware standoff for the dismount aim point.  Normally
    // she'd dismount on whichever side of the corpse already
    // contains her (shorter walk).  During a boss fight, prefer
    // the side AWAY from the body so the foot revive's standoff
    // path doesn't end up crossing back through bite range.
    let aimX, aimY;
    if (body) {
      const so = standoffNear(c, corpse.x, corpse.y, range);
      aimX = so.x; aimY = so.y;
    } else {
      const side = corpse.x >= c.x ? -1 : 1;
      aimX = corpse.x + side * (range - 6);
      aimY = corpse.y;
    }
    // Hydra detour: if the straight gallop to the dismount tile
    // cuts through head-bite reach, route via a TANGENT waypoint
    // around the body in a committed CW/CCW direction.  The legacy
    // perpendicular jump (`HYDRA_SPIT_RANGE * 0.85` ≈ 238 px off
    // axis) reliably overshot the lawn (220 px tall) and oscillated
    // between two clamped points — the user's "horse rocks back and
    // forth around the body" report.  The tangent steps along the
    // bite-ring chord by chord so each waypoint stays inside the
    // playfield, and `c.detourDir` is latched once per ride so the
    // next tick can't re-pick the opposite side.  Cleared whenever
    // the straight path is clean again so a future detour re-picks
    // based on fresh geometry.
    let goingViaWaypoint = false;
    const headBiteR = (Monsters.HYDRA_HEAD_RANGE || 95) + 10;
    if (body && pathCrossesHydra(c.x, c.y, aimX, aimY, headBiteR)) {
      const ringR = headBiteR + 20;
      const angP = Math.atan2(c.y - body.y, c.x - body.x);
      const angT = Math.atan2(aimY - body.y, aimX - body.x);
      // Latch direction the first tick the detour fires.  Score CW
      // and CCW by lawn-on-arc-coverage, prefer the one with more
      // on-lawn waypoints; tiebreak on shorter arc.
      const lawnXMin = 8, lawnXMax = Scene.WIDTH - 8;
      const lawnYMin = (Scene.FLOOR_TOP    || 40) + 8;
      const lawnYMax = (Scene.FLOOR_BOTTOM || (Scene.HEIGHT - 10)) - 8;
      if (!c.detourDir) {
        const score = (dir) => {
          const diff = (((angT - angP) * dir) % (2 * Math.PI)
                        + 2 * Math.PI) % (2 * Math.PI);
          const n = Math.max(1, Math.ceil(diff / (Math.PI / 4)));
          let on = 0;
          for (let i = 1; i <= n; i++) {
            const a = angP + dir * i * (diff / n);
            const wx = body.x + ringR * Math.cos(a);
            const wy = body.y + ringR * Math.sin(a);
            if (wx >= lawnXMin && wx <= lawnXMax
                && wy >= lawnYMin && wy <= lawnYMax) on++;
          }
          return [on, -diff];
        };
        const cwScore  = score(-1);
        const ccwScore = score(+1);
        const cwBetter = (cwScore[0] !== ccwScore[0])
          ? (cwScore[0] > ccwScore[0])
          : (cwScore[1] >= ccwScore[1]);
        c.detourDir = cwBetter ? -1 : 1;
      }
      const dir = c.detourDir;
      const diff = (((angT - angP) * dir) % (2 * Math.PI)
                    + 2 * Math.PI) % (2 * Math.PI);
      if (diff >= 0.05) {
        const step = dir * Math.min(diff, Math.PI / 4);
        const a = angP + step;
        let wx = body.x + ringR * Math.cos(a);
        let wy = body.y + ringR * Math.sin(a);
        wx = Math.max(lawnXMin, Math.min(lawnXMax, wx));
        wy = Math.max(lawnYMin, Math.min(lawnYMax, wy));
        aimX = wx; aimY = wy;
        goingViaWaypoint = true;
      }
    } else {
      c.detourDir = 0;
    }
    setTarget(c, aimX, aimY);
    const arrived = moveStep(c, dt, 1.0);
    const d = Math.hypot(corpse.x - c.x, corpse.y - c.y);
    // Bite-aware dismount guard: if the rider's current position
    // is still inside head-bite reach of the body, gallop one more
    // tick around the ring instead of dismounting.  Threshold
    // matches `safeCastFrom`'s revive bite-floor so the foot
    // revive that runs after dismount won't be vetoed on the
    // first tick.  Without this guard a corpse near the body
    // produces a dismount right next to the boss → safeCastFrom
    // rejects → exitCombat → wandering ("she rode there and just
    // walked away").
    let inBite = false;
    if (body) {
      const dBody = Math.hypot(c.x - body.x, c.y - body.y);
      if (dBody < headBiteR + 10) inBite = true;
    }
    if ((d <= range || (arrived && !goingViaWaypoint)) && !inBite) {
      // Dismount; next maybeEnterCombat pass handles the revive.
      startDismount(c, now);
    }
  }

  function tickDismount(c, dt, now) {
    if (now >= c.combatUntil) {
      c.mounted = false;
      c.horseEntity = null;
      c.horseCooldownUntil = now + HORSE_COOLDOWN_MS;
      exitCombat(c);
    }
  }

  // ----- decoy / "split" spell -----------------------------------------
  //
  // Healer-only escape trick.  See the DECOY_* constants block at
  // the top of the module for the high-level spec.  The flow is:
  //
  //   1. tickFleeing / tickRetreating call maybeStartDecoyCast()
  //      every tick the girl is escaping; it returns true iff the
  //      conditions line up (cooldown ready, no live decoy, not
  //      mounted, real pursuer in range) and starts the cast.
  //   2. While decoyCastUntil > now, tickFleeing / tickRetreating
  //      hand off to spinDuringDecoyCast() instead of moving — she
  //      flips facing direction every ~70 ms so the sprite reads as
  //      a quick spin in place.
  //   3. The first frame after the spin window, spawnDecoy() drops
  //      a translucent twin where she stood and stamps the cooldown.
  //   4. The decoy lives in the module-level `decoys` array, gets
  //      ticked once per frame in tickDecoys() (lifetime + fade-out
  //      bookkeeping), is drawn from drawWorld(), and is returned
  //      from listDecoys() so monsters can target it.
  //   5. damage(c, dmg) detects c.decoy === true and routes hits to
  //      damageDecoy() instead of the regular hero death pipeline.
  //   6. If the girl is hit mid-cast, cancelDecoyCast() pulls her
  //      out of the spin onto the short cancel cooldown.

  function canCastDecoy(c, now) {
    if (!c || c.name !== "girl") return false;
    if (c.mounted) return false;
    if (c.combatMode === "dead" || c.hp <= 0) return false;
    // Already mid-cast or already have a live decoy out there.
    if (c.decoyCastUntil > 0) return false;
    if (c.decoyActive && !c.decoyActive.fadeStartAt &&
        c.decoyActive.hp > 0) return false;
    if (now < c.decoyCooldownUntil) return false;
    // Only fire if there's actually something chasing her — burning
    // the cooldown on an empty lawn would be a waste.
    const [m] = nearestMonster(c, DECOY_TRIGGER_R);
    if (!m) return false;
    // Hydra-fight gate: the cast spin freezes her in place for
    // DECOY_CAST_MS, which is a death sentence inside the spit
    // envelope or while she's still trying to cross past the body.
    // The user-facing bug was "she runs INTO the hydra and casts
    // a phantom there" — so during a live boss we forbid the cast
    // in two situations:
    //   • her current move target is roughly in the hydra body's
    //     direction (dot product > 0.2 with the body offset, i.e.
    //     within ~78° of "forward into the boss");
    //   • her own position sits inside the spit envelope AND the
    //     body is closer than HYDRA_SPIT_RANGE * 0.6, so freezing
    //     to spin would leave her in the worst slice of the lair.
    // She keeps the decoy in reserve until she's actually clear of
    // / arcing around the hydra, at which point the spin happens
    // mid-flight and the clone draws the next salvo while she runs.
    if (HydraPlan && HydraPlan.active && HydraPlan.active()) {
      const body = HydraPlan.body && HydraPlan.body();
      if (body) {
        const bdx = body.x - c.x, bdy = body.y - c.y;
        const bd  = Math.hypot(bdx, bdy) || 1;
        // Inside-the-fire test: standing in spit AND body close.
        if (HydraPlan.inSpitDanger(c.x, c.y) && bd < (Monsters.HYDRA_SPIT_RANGE || 280) * 0.6) {
          return false;
        }
        // Heading-into-the-fire test: her current move vector
        // points roughly toward the body.  If she has no real
        // target (tx/ty equals current pos), skip this gate —
        // standing still while a head bites her is fine to decoy.
        const mvx = (c.tx ?? c.x) - c.x;
        const mvy = (c.ty ?? c.y) - c.y;
        const mvD = Math.hypot(mvx, mvy);
        if (mvD > 6) {
          const dot = (mvx / mvD) * (bdx / bd) + (mvy / mvD) * (bdy / bd);
          if (dot > 0.2) return false;
        }
      }
    }
    return true;
  }

  function startDecoyCast(c, now) {
    c.decoyCastUntil = now + DECOY_CAST_MS;
    c.castFlashUntil = c.decoyCastUntil;
    c.frame = 0;
    c.frameTimer = 0;
    if (Combat.decoyCast) Combat.decoyCast(c, c.decoyCastUntil);
    Dialog.bark(c, "decoyCast");
  }

  function spinDuringDecoyCast(c, now) {
    // Visible 4-flip spin: dir alternates every ~70 ms so over a
    // 280 ms cast we get L-R-L-R, reading as "she pivoted on the
    // spot".  Frame is pinned so the walk cycle doesn't fight the
    // spin animation.
    const phase = Math.floor(now / 70);
    c.dir = (phase & 1) ? "l" : "r";
    c.frame = 0;
    c.frameTimer = 0;
  }

  function spawnDecoy(c, now) {
    // Drop the clone exactly where she's standing, facing whichever
    // way she happened to land on the last spin frame — which makes
    // the "she split into two" visual line up: one girl stays
    // facing the threat, the other (her) sprints away.
    const d = {
      decoy: true,
      x: c.x,
      y: c.y,
      dir: c.dir,
      name: c.name,
      hp: DECOY_HP,
      maxHp: DECOY_HP,
      spawnedAt: now,
      expiresAt: now + DECOY_LIFETIME_MS,
      fadeStartAt: 0,
      fadeUntil: 0,
      hitFlashUntil: 0,
      owner: c,
    };
    decoys.push(d);
    c.decoyActive = d;
    c.decoyCooldownUntil = now + DECOY_COOLDOWN_MS;
    c.decoyCastUntil = 0;
    c.castFlashUntil = 0;
    if (Combat.decoyAppear) Combat.decoyAppear(d);
    else if (Combat.puff) Combat.puff(c.x, c.y - 16, "rgba(180,200,255,0.65)");
    // Force a real away-from-threat flee post-decoy.  Decoy is meant
    // to BUY ESCAPE TIME — but if we just decay back to whatever
    // movement target was already in flight (a retreat haven on the
    // wrong side of the slime, or, worse, the corpse we were
    // approaching to revive), the clone is wasted: the girl walks
    // straight past her own decoy and back into the bite while the
    // clone stands around in an empty patch of grass.  Re-running
    // startFleeing here repicks the exit using the threat-aware
    // path-clearance edge picker — guaranteed to point AWAY from
    // whatever monster triggered the cast.  Already-fleeing girls
    // get the same treatment because the original edge target may
    // have been chosen many seconds ago and the threat geometry
    // could have shifted while she spun.
    startFleeing(c);
  }

  function cancelDecoyCast(c, now) {
    c.decoyCastUntil = 0;
    c.castFlashUntil = 0;
    c.decoyCooldownUntil = Math.max(c.decoyCooldownUntil,
                                    now + DECOY_CANCEL_CD_MS);
  }

  // Single-shot helper that tickFleeing / tickRetreating call at the
  // top of every escape tick.  Always returns true on the spawn
  // frame: spawnDecoy now flips the girl into a real "fleeing"
  // combat mode (with the edge re-picked away from threats), and
  // the rest of the retreat tick — neediest-ally heal switch,
  // potion-restock check, retreat-replan, retreat moveStep —
  // would happily trample that fresh target if it kept running.
  // Costs us one stationary frame after the spawn; the very next
  // tick the dispatcher routes through tickFleeing where the run
  // resumes against the new edge target.
  function handleDecoyCast(c, dt, now) {
    if (c.decoyCastUntil > 0) {
      if (now >= c.decoyCastUntil) {
        spawnDecoy(c, now);
        return true;
      }
      spinDuringDecoyCast(c, now);
      return true;
    }
    if (canCastDecoy(c, now)) {
      startDecoyCast(c, now);
      spinDuringDecoyCast(c, now);
      return true;
    }
    return false;
  }

  function damageDecoy(d, dmg) {
    if (!d || d.fadeStartAt) return;
    d.hp = Math.max(0, d.hp - dmg);
    d.hitFlashUntil = performance.now() + 140;
    // Death is bookkept in tickDecoys so the fade-out sequence
    // happens uniformly (lifetime expiry vs. killed) — we just
    // mark hp <= 0 and let the next tick start the fade.
  }

  function tickDecoys(dt, now) {
    for (let i = decoys.length - 1; i >= 0; i--) {
      const d = decoys[i];
      if (d.fadeStartAt > 0) {
        if (now >= d.fadeUntil) {
          if (d.owner && d.owner.decoyActive === d) d.owner.decoyActive = null;
          decoys.splice(i, 1);
        }
        continue;
      }
      if (d.hp <= 0 || now >= d.expiresAt) {
        d.fadeStartAt = now;
        d.fadeUntil = now + DECOY_FADE_MS;
        // A small puff sells the dispel — heroes "see" the trick
        // resolve, monsters lose their target reference next frame
        // when nearestHero re-scans.
        if (Combat.puff) {
          Combat.puff(d.x, d.y - 14, "rgba(180,200,255,0.55)");
        }
      }
    }
  }

  function listDecoys() { return decoys; }

  // ----- per-tick combat updates ---------------------------------------

  function tickCombat(c, dt, now) {
    // Ranged heroes get a free snipe whenever they're between
    // dedicated combat actions (channelling, smashing a bottle, etc.)
    // — see snipeAllowed for the full list of when this is OK.
    // Doing it here (one chokepoint) keeps the per-mode tickers
    // focused on their own logic.
    if (snipeAllowed(c)) tryRangedSnipe(c, now);
    switch (c.combatMode) {
      case "fighting":    return tickFighting(c, dt, now);
      case "drinking":    return tickDrinking(c, dt, now);
      case "depositing":  return tickDepositing(c, dt, now);
      case "delivering":  return tickDelivering(c, dt, now);
      case "healing":     return tickHealing(c, dt, now);
      case "fleeing":     return tickFleeing(c, dt, now);
      case "retreating":  return tickRetreating(c, dt, now);
      case "dead":        return tickDead(c, dt, now);
      case "reviving":    return tickReviving(c, dt, now);
      case "potionReviving": return tickPotionReviving(c, dt, now);
      case "ufoing":      return tickUfoing(c, dt, now);
      case "summoningHorse": return tickSummoningHorse(c, dt, now);
      case "horseApproach":  return tickHorseApproach(c, dt, now);
      case "ridingToCorpse": return tickRideToCorpse(c, dt, now);
      case "dismounting":    return tickDismount(c, dt, now);
    }
  }

  // Look for the densest cluster of live monsters within `range` of
  // the firemage.  Returns `{ x, y, count }` for the centroid of the
  // best cluster, or null if no cluster meets `FIRE_RAIN_MIN_CLUSTER`.
  // O(M²) over Monsters.list — fine, the lawn caps out at <10 active
  // monsters and this only runs on the firemage's combat tick when
  // his AoE cooldown is up and the buff is active.
  function findFireRainTarget(c) {
    const range = c.atk.range;
    const list = Monsters.list;
    let bestCount = 0, bestSx = 0, bestSy = 0;
    for (let i = 0; i < list.length; i++) {
      const m1 = list[i];
      if (m1.dying || m1.fleeing) continue;
      if (Monsters.isHidden(m1)) continue;
      if (Math.hypot(m1.x - c.x, m1.y - c.y) > range) continue;
      let count = 0, sx = 0, sy = 0;
      for (let j = 0; j < list.length; j++) {
        const m2 = list[j];
        if (m2.dying || m2.fleeing) continue;
        if (Monsters.isHidden(m2)) continue;
        if (Math.hypot(m1.x - m2.x, m1.y - m2.y) > FIRE_RAIN_CLUSTER_R) continue;
        count++;
        sx += m2.x;
        sy += m2.y;
      }
      if (count > bestCount) {
        bestCount = count;
        bestSx = sx;
        bestSy = sy;
      }
    }
    if (bestCount < FIRE_RAIN_MIN_CLUSTER) return null;
    const cx = bestSx / bestCount;
    const cy = bestSy / bestCount;
    // Refuse the cast if the centroid is essentially at our feet
    // (would splash US — well, monsters around us — and look weird)
    // or way past our weapon range (we just confirmed at least one
    // member is in range, but the centroid can drift outside if the
    // cluster is half-in / half-out; a few extra px of grace is
    // fine, but not 1.3× range).
    const dCent = Math.hypot(cx - c.x, cy - c.y);
    if (dCent < 24) return null;
    if (dCent > c.atk.range * 1.05) return null;
    return { x: cx, y: cy, count: bestCount };
  }

  function castFireRain(c, target, now) {
    c.lastAoeAt = now;
    c.lastAttackAt = now;             // also gates regular fireball
                                      // briefly so the rain isn't
                                      // immediately followed by a
                                      // single shot in the same beat
    c.frame = 0;
    c.dir = target.x >= c.x ? "r" : "l";
    c.castFlashUntil = now + 520;     // long flash sells the channel
    // Build the impact list.  Each meteor lands somewhere inside a
    // disc of radius FIRE_RAIN_AOE_R around the centroid; the
    // sqrt(random) keeps the distribution roughly uniform across
    // the disc instead of clustering at the centre.  Stagger
    // delays so the volley falls as a shower over ~700-900 ms
    // rather than a single frame.
    const impacts = [];
    for (let i = 0; i < FIRE_RAIN_COUNT; i++) {
      const angle = Math.random() * Math.PI * 2;
      const r = FIRE_RAIN_AOE_R * Math.sqrt(Math.random()) * 0.95;
      const ix = Math.max(8, Math.min(Scene.WIDTH - 8,
                                      target.x + Math.cos(angle) * r));
      const iy = Math.max(Scene.FLOOR_TOP + 6,
                          Math.min(Scene.FLOOR_BOTTOM - 4,
                                   target.y + Math.sin(angle) * r * 0.6));
      impacts.push({
        x: ix, y: iy,
        delay: i * FIRE_RAIN_STAGGER_MS + Math.random() * 60,
      });
    }
    const dmg = Math.round(FIRE_RAIN_DMG * (c.dmgMul || 1));
    Combat.meteorRain(c, impacts, FIRE_RAIN_HIT_R, dmg);
    // Rain spends the firemage's ember stacks — they were a per-
    // fireball single-target bonus.  Reset ahead of the next kill
    // chain so the aura visibly drops to zero on cast.
    c.emberStacks = 0;
    // Small upward puff at the firemage's hands so the cast reads
    // as "throwing the spell up" before the meteors fall back down.
    Combat.puff(c.x + (c.dir === "r" ? 6 : -6), c.y - 22,
                "rgba(255,140,40,0.95)");
    Dialog.bark(c, "fireRain");
  }

  // ---- per-character active abilities ---------------------------------
  // Each tryX runs every fighting tick; they internally gate on
  // cooldown and trigger conditions and are otherwise a no-op.  Kept
  // separate from tickFighting so the dispatch reads as a flat
  // checklist instead of a giant conditional inside the move/swing
  // branch.

  // Knight active taunt: short rallying yell that pulls monster
  // aggro toward the knight for TAUNT_DURATION_MS.  Triggers when
  // (a) any nearby ally has dropped below 60% HP and is being
  // chewed on, OR (b) two or more monsters are clustered around
  // the knight himself.
  function tryTaunt(c, now) {
    if (c.name !== "knight") return;
    if (c.tauntCdUntil > now) return;
    if (c.tauntUntil  > now) return;
    let hot = 0, alliesInTrouble = false;
    for (const m of Monsters.list) {
      if (m.dying) continue;
      if (Math.hypot(m.x - c.x, m.y - c.y) < TAUNT_RANGE) hot++;
      if (m.target && m.target !== c &&
          m.target.role === "fighter" && m.target.hp / Math.max(1, m.target.maxHp) < 0.6 &&
          Math.hypot(c.x - m.target.x, c.y - m.target.y) < TAUNT_RANGE * 1.5) {
        alliesInTrouble = true;
      }
      if (m.target && m.target.role === "healer" &&
          Math.hypot(c.x - m.target.x, c.y - m.target.y) < TAUNT_RANGE * 1.6) {
        alliesInTrouble = true;
      }
    }
    if (hot < 2 && !alliesInTrouble) return;
    c.tauntUntil   = now + TAUNT_DURATION_MS;
    c.tauntCdUntil = now + TAUNT_COOLDOWN_MS;
    Combat.tauntFx(c.x, c.y - 18);
    Dialog.bark(c, "guardHealer");
  }

  // Knight block stance: short DR window when he's getting focused.
  //
  // Trigger logic — two independent paths into the block:
  //   (a) ≥2 normal monsters targeting the knight in melee range,
  //       the original "I'm being swarmed" reading.
  //   (b) at least ONE big attacker on him: hydra parts, or any
  //       monster with a slow heavy swing (cdMs ≥ 1000).  Without
  //       this branch the knight almost never blocked during boss
  //       fights — hydra heads have separate sectors so usually
  //       only one head is biting him at a time, which failed the
  //       old "≥2 attackers" gate even though each individual bite
  //       was the most dangerous incoming damage on the lawn.
  //
  // HP gating — the original "mid-band only (25 %–70 %)" cut blocked
  // proactive use at full HP.  That was wrong: a fresh knight eating
  // the opening burst of a boss can drop two thirds of his bar
  // before he ever crosses the 70 % threshold.  We keep the lower
  // 0.25 floor (under that he should be drinking / retreating, not
  // soaking another wave) but lift the upper cap entirely.
  function tryBlock(c, now) {
    if (c.name !== "knight") return;
    if (c.blockCdUntil > now) return;
    if (c.blockUntil   > now) return;
    if (c.hp / c.maxHp < 0.25) return;
    let onMe = 0;
    let bigOnMe = false;
    for (const m of Monsters.list) {
      if (m.dying) continue;
      if (m.target !== c) continue;
      if (Math.hypot(m.x - c.x, m.y - c.y) >= c.atk.range + 30) continue;
      onMe++;
      if (m.kind === "hydraHead" || m.kind === "hydraBody") {
        bigOnMe = true;
      } else if (m.atk && typeof m.atk.cdMs === "number" && m.atk.cdMs >= 1000) {
        bigOnMe = true;
      }
    }
    if (onMe < 2 && !bigOnMe) return;
    c.blockUntil   = now + BLOCK_DURATION_MS;
    c.blockDR      = BLOCK_DR;
    c.blockCdUntil = now + BLOCK_COOLDOWN_MS;
    Combat.shieldBeam(c, c, BLOCK_DURATION_MS);
  }

  // Viking berserk: brutal damage spike + DR when low.
  //
  // Boss-fight override: while HydraPlan is in the push window
  // (≤2 living heads), the viking is allowed to pop berserk even
  // at full HP.  The window is the team's "land real damage on the
  // body" beat — burning the cooldown here trades a defensive
  // panic button for a coordinated burst on the win condition.
  // We keep the lockout (berserkCdUntil) honest so it can't be
  // re-popped immediately after the head pressure resets.
  function tryBerserk(c, now) {
    if (c.name !== "viking") return;
    if (c.berserkUntil  > now) return;
    if (c.berserkCdUntil > now) return;
    const hpFrac = c.hp / Math.max(1, c.maxHp);
    const lowHp = hpFrac <= BERSERK_HP_FRAC;
    const bossPush = HydraPlan && HydraPlan.active && HydraPlan.active()
                  && HydraPlan.pushWindow && HydraPlan.pushWindow();
    if (!lowHp && !bossPush) return;
    c.berserkUntil   = now + BERSERK_DURATION_MS;
    c.berserkCdUntil = now + BERSERK_COOLDOWN_MS;
    Combat.embersAura(c.x, c.y - 18, 5);
    Dialog.bark(c, "kill");
  }

  // Ninja smoke bomb: brief invisible / aggro-reset when low.
  function trySmokeBomb(c, now) {
    if (c.name !== "ninja") return;
    if (c.smokeUntil   > now) return;
    if (c.smokeCdUntil > now) return;
    if (c.hp / Math.max(1, c.maxHp) > SMOKE_HP_FRAC) return;
    c.smokeUntil   = now + SMOKE_DURATION_MS;
    c.smokeCdUntil = now + SMOKE_COOLDOWN_MS;
    Combat.smokeBomb(c.x, c.y - 12);
    // Drop aggro from any monster currently targeting the ninja
    // within SMOKE_RADIUS.  They'll re-pick a target through
    // bestHeroFor next tick (and the ninja is invisible to it
    // until smokeUntil lapses; see threatScoreMonster).
    for (const m of Monsters.list) {
      if (m.dying) continue;
      if (m.target !== c) continue;
      if (Math.hypot(m.x - c.x, m.y - c.y) > SMOKE_RADIUS) continue;
      m.target = null;
    }
  }

  // Alien shield beam: protective DR ribbon to the lowest-HP buddy
  // (or the healer) within 100 px.  Fires on cooldown when there
  // IS a wounded ally.
  function tryShieldBeam(c, now) {
    if (c.name !== "alien") return;
    if (c.shieldCdUntil > now) return;
    let best = null, bestFrac = 1;
    for (const a of list) {
      if (a === c) continue;
      if (!isVisibleNow(a) || a.hp <= 0) continue;
      const d = Math.hypot(a.x - c.x, a.y - c.y);
      if (d > 100) continue;
      const frac = a.hp / Math.max(1, a.maxHp);
      const score = (a.role === "healer") ? frac - 0.2 : frac;
      if (score < bestFrac) { bestFrac = score; best = a; }
    }
    if (!best) return;
    if (bestFrac > 0.7) return;
    best.shieldUntil = now + SHIELD_DURATION_MS;
    c.shieldCdUntil  = now + SHIELD_COOLDOWN_MS;
    Combat.shieldBeam(c, best, SHIELD_DURATION_MS);
  }

  // Archer aimed-shot bookkeeping: if he hasn't moved or swung
  // recently, set a "next shot is buffed" flag.  Consumed in
  // Combat.heroAttack on the next bow shot.
  function tickAimedShot(c, now) {
    if (c.name !== "archer") return;
    if (c.aimedConsumeNext) return;
    if (c.aimedReadyAt === 0) {
      c.aimedReadyAt = now + AIMED_DELAY_MS;
      return;
    }
    if (now >= c.aimedReadyAt) {
      c.aimedConsumeNext = true;
    }
  }

  function tryAbilities(c, now) {
    tryTaunt(c, now);
    tryBlock(c, now);
    tryBerserk(c, now);
    trySmokeBomb(c, now);
    tryShieldBeam(c, now);
    tickAimedShot(c, now);
  }

  function tickFighting(c, dt, now) {
    const m = c.combatTarget;
    // If target invalid, pick another or go home.
    if (!m || m.dying) {
      // Boss-fight first: a CUTTER who just severed a head should
      // immediately rotate to the next head (or fall back to body),
      // a SMASHER whose head-of-opportunity died should resume
      // chipping the body, etc.  Without this, the bestMonsterFor
      // fallback would keep working (BOSS_PERCEPTION_R means it can
      // see hydra parts at any distance) but the target picked is
      // pure threat-weight, so a SMASHER would auto-flip to the
      // body even when a head is right next to him — wasting magic
      // hits on the resisted body bar instead of clearing pressure.
      let nm = null;
      if (HydraPlan.active()) {
        nm = HydraPlan.targetFor(c);
      }
      if (!nm || nm.dying) {
        [nm] = bestMonsterFor(c, AGGRO_RANGE * 1.3);
      }
      // Witch boss exception (mirrors the startFighting / maybeEnterCombat
      // gates): the on-kill rotation must NOT auto-flip her onto a
      // hydra part she'd have to walk toward.  Without this, killing
      // a slime mid-fight rotated her target to HydraPlan.targetFor
      // (= nearest head) and she happily marched at the boss.  Drop
      // the engage; wandering tick + stanceFor walk her back to the
      // cauldron.
      if (witchShouldSkipHydraTarget(c, nm)) { exitCombat(c); return; }
      if (nm) { c.combatTarget = nm; }
      else { exitCombat(c); return; }
    }
    // Imminent-threat re-pick.  Once a hero is locked into combat,
    // maybeEnterCombat (and its SELF_DEFENCE_R guard) no longer
    // runs — and damage()'s retaliation branch is gated on
    // combatMode === "none", so it's also a no-op mid-fight.  The
    // net effect was the user-reported "character died because they
    // stared at the hydra while other enemies hit them": a
    // firemage chucked fireballs at a hydra head while a slime
    // walked up and gnawed him to death, never noticing.  Same
    // failure outside boss fights — an archer plinking a far worm
    // got bitten by a bat without flinching.
    //
    // Fix: every IMMINENT_RETARGET_MS, scan for any non-hydra
    // monster that's already inside its bite envelope of us
    // (md ≤ atk.range + small pad).  If one exists and either
    //   (a) the current target is a hydra part — boss chip damage
    //       is never worth eating bites for — or
    //   (b) the imminent biter is closer than the current target
    //       (we're not actually trading blows with cur yet),
    // swap focus to the biter.  The score comparison below uses
    // threatScoreHero so a low-HP biter or a buddy-attacker still
    // outranks a fresh peer.  Once the biter dies the existing
    // "target invalid" branch above re-picks via HydraPlan.target
    // For → bestMonsterFor, naturally returning to the boss.
    //
    // Throttled to 500 ms so a 2-mob scrum doesn't bounce focus
    // every frame; biters move slowly enough that 500 ms is well
    // inside their walk-up window.  We DON'T gate on c.name
    // because every fighter has the same blind-spot here.
    const IMMINENT_RETARGET_MS = 500;
    if (now - (c._imminentRetargetAt || 0) > IMMINENT_RETARGET_MS) {
      c._imminentRetargetAt = now;
      // Wider awareness for ranged heroes whose CURRENT target is far
      // away.  The classic failure: hero stationary at the firing line
      // chipping at a 100-px target while a slime walks up and bites
      // his ankles.  The slime's OWN bite range is only ~14 px, so the
      // mRange+14 envelope below doesn't notice it until it's already
      // on top of him — and with a 1.4 s hex / 1.5 s fireball cooldown,
      // even a single missed retarget tick is several free bites.
      // Originally this widening was gated on curTarget being a hydra
      // part (boss-fight only); the user-reported "witch shooting a far
      // enemy while two mobs bite her behind, does NOTHING" repro is
      // the exact same blind-spot outside boss fights.  Now: any time
      // a ranged hero's current target is past ~half their weapon range,
      // promote awareness to ~70 % of weapon range so flankers get
      // peeled off the firing line.  For close current targets we keep
      // the tight envelope (no point thrashing focus when the cur is
      // already in self-defence range).
      const cur0 = c.combatTarget;
      const curIsHydra0 = cur0 &&
        (cur0.kind === "hydraBody" || cur0.kind === "hydraHead");
      const curD0 = cur0 ? Math.hypot(cur0.x - c.x, cur0.y - c.y) : 0;
      const widePerception = isRanged(c) &&
        (curIsHydra0 || curD0 > c.atk.range * 0.5);
      const heroAware = widePerception ? c.atk.range * 0.7 : 0;
      let imm = null, immS = Infinity, immD = Infinity;
      for (const m of Monsters.list) {
        if (!m || m.dying || m.fleeing) continue;
        if (m === c.combatTarget) continue;
        if (m.kind === "hydraBody" || m.kind === "hydraHead") continue;
        if (Monsters.isHidden && Monsters.isHidden(m, c)) continue;
        const md = Math.hypot(m.x - c.x, m.y - c.y);
        const mRange = (m.atk && m.atk.range) || 18;
        // Bite-envelope test (with a small pad so a slime that's
        // 2 px outside its own range and clearly closing in still
        // counts as "actively threatening", not "wandering past").
        // Widened to ~70 % of weapon range when a ranged hero is
        // chipping the boss — see comment above.
        if (md > Math.max(mRange + 14, heroAware)) continue;
        const s = threatScoreHero(c, m);
        if (s < immS) { immS = s; imm = m; immD = md; }
      }
      if (imm) {
        const cur = c.combatTarget;
        const curIsHydra = cur &&
          (cur.kind === "hydraBody" || cur.kind === "hydraHead");
        const curD = cur ? Math.hypot(cur.x - c.x, cur.y - c.y) : Infinity;
        if (curIsHydra || immD < curD) {
          c.combatTarget = imm;
        }
      }
    }
    // Mid-fight role retarget: if the active target is a hydra part
    // but no longer matches what the plan wants for this hero (e.g.
    // a fresh head reared into a TANK's face while he's mid-swing
    // at the body, or a SMASHER's head-of-opportunity drifted out
    // of close range), swap on the next tick instead of locking the
    // entire fight onto the original pick.  Throttled so we don't
    // re-pick every frame.
    if (HydraPlan.active() && c.combatTarget &&
        (c.combatTarget.kind === "hydraBody" || c.combatTarget.kind === "hydraHead") &&
        now - (c._hydraRetargetAt || 0) > 700) {
      c._hydraRetargetAt = now;
      const planT = HydraPlan.targetFor(c);
      if (planT && !planT.dying && planT !== c.combatTarget) {
        c.combatTarget = planT;
      }
    }
    // Witch boss exception: hydra parts are NEVER a valid combat
    // target for her (see witchShouldSkipHydraTarget for the full
    // rationale).  If she somehow ended up locked onto one anyway —
    // legacy save state, a code path that bypassed startFighting —
    // bail out unconditionally.  The wandering tick + stanceFor will
    // route her back to the cauldron where the brew clock runs.
    if (HydraPlan.active() && c.name === "witch" && c.combatTarget &&
        (c.combatTarget.kind === "hydraBody" || c.combatTarget.kind === "hydraHead")) {
      exitCombat(c);
      return;
    }
    // Witch boss exception (mid-fight): a slime that was safely
    // engageable at startFighting time can drift into hydra reach
    // mid-channel (the body roams toward heroes; the slime gets
    // chased onto the boss arena).  The maybeEnterCombat gate
    // refuses the original engage when standoff lands in spit/bite,
    // but once she's already in "fighting" mode tickFighting just
    // keeps walking to the new standoff every tick.  Re-check here
    // and bail BEFORE the move/kite/swing branch below — she'll
    // exit combat, the wandering tick will pull her back to the
    // cauldron, and re-engage will be re-evaluated against the
    // fresh hydra geometry.  We skip this guard for a slime in
    // self-defence range (≤ SELF_DEFENCE_R + 4 px) — at that range
    // not hexing the slime means eating its bite, which is worse
    // than a tick of spit damage.
    if (HydraPlan.active() && c.name === "witch" && c.combatTarget &&
        c.combatTarget.kind !== "hydraBody" &&
        c.combatTarget.kind !== "hydraHead") {
      const tgt2 = c.combatTarget;
      const tgtD = Math.hypot(tgt2.x - c.x, tgt2.y - c.y);
      if (tgtD > SELF_DEFENCE_R + 4) {
        const range2 = (c.atk && c.atk.range) || 130;
        const standoff2 = Math.max(10, range2 - 6);
        const dx2 = tgt2.x - c.x;
        const side2 = dx2 === 0 ? (c.dir === "l" ? 1 : -1) : Math.sign(dx2);
        const sx2 = tgt2.x - side2 * standoff2 * 0.6;
        const sy2 = Math.max(Scene.FLOOR_TOP + 8,
                              Math.min(Scene.FLOOR_BOTTOM - 6, tgt2.y));
        if (witchInHydraDangerAt(sx2, sy2) ||
            hydraPathBlocked(c.x, c.y, sx2, sy2)) {
          exitCombat(c);
          return;
        }
      }
    }
    // Per-character ability triggers run BEFORE the move/swing branch
    // below, so a hero who decides to taunt / block / berserk this
    // tick gets the aura up before the next monster bite.  Each
    // tryX is internally rate-limited and no-ops when its conditions
    // aren't met, so this is cheap.
    tryAbilities(c, now);

    // Hydra tail dodge.  If the body is winding (or mid-strike) the
    // tail and we're a non-TANK standing in the swipe arc, step out
    // for the rest of the window.  TANK is excluded — soaking the
    // swipe is part of his job, and pulling him out would collapse
    // the head ring he's holding.  We still take an opportunistic
    // ranged shot from the dodge spot if the cooldown is up, so
    // CUTTERs don't lose a full DPS beat to the sidestep.
    if (HydraPlan.active() && HydraPlan.shouldDodgeTail(c)) {
      const goal = HydraPlan.tailDodgeGoal(c);
      if (goal) {
        setTarget(c, goal.x, goal.y);
        moveStep(c, dt, 1.15);
        // Witch: only move — hex stops her in the danger arc during the window.
        if (c.name !== "witch" && isRanged(c) && c.combatTarget && !c.combatTarget.dying) {
          const tdx = c.combatTarget.x - c.x;
          const tdy = c.combatTarget.y - c.y;
          if (Math.hypot(tdx, tdy) <= c.atk.range &&
              now - c.lastAttackAt > effectiveCd(c)) {
            c.dir = tdx >= 0 ? "r" : "l";
            Combat.heroAttack(c, c.combatTarget);
            c.lastAttackAt = now;
            c.castFlashUntil = now + 160;
          }
        }
        return;
      }
    }

    const tgt = c.combatTarget;
    const dx = tgt.x - c.x, dy = tgt.y - c.y;
    const d = Math.hypot(dx, dy);

    // Firemage's "rain of fire" AoE — only available while infused
    // and gated on (a) its own cooldown and (b) at least
    // FIRE_RAIN_MIN_CLUSTER monsters bunched up within his weapon
    // range.  We check this BEFORE the kiting branch so a fresh
    // cluster of adds doesn't get postponed by a panic kite — the
    // rain is the firemage's group answer, kiting away from a 4-
    // monster blob without throwing it would be an obvious miss.
    if (c.name === "firemage" &&
        c.workBuffKind === "infused" &&
        now - (c.lastAoeAt || 0) > FIRE_RAIN_CD_MS * (c.cdMul || 1)) {
      const cluster = findFireRainTarget(c);
      if (cluster) { castFireRain(c, cluster, now); return; }
    }

    // Ninja vs. underground worm: the regular ranged shuriken bounces
    // off a mound of dirt, so we instead walk right up to the worm
    // and drive the katana through the soil.  This branch only fires
    // when the target is a worm in a non-attacking state — the
    // moment the worm surfaces the standard ranged kit takes over
    // because it now has a proper torso to throw shuriken at.
    if (c.name === "ninja" && tgt.kind === "worm" &&
        tgt.state !== "attacking") {
      const stabRange = NINJA_STAB_RANGE;
      if (d > stabRange) {
        // March in close.  Approach a touch off-axis so the sprite
        // ends up beside the mound rather than standing on top of it.
        const off = Math.sign(dx || 1) * 6;
        setTarget(c, tgt.x - off,
                     Math.max(Scene.FLOOR_TOP + 8,
                              Math.min(Scene.FLOOR_BOTTOM - 6, tgt.y)));
        moveStep(c, dt, 1.2);
        return;
      }
      c.frame = 0;
      c.dir = dx >= 0 ? "r" : "l";
      const stabCd = NINJA_STAB_CD_MS * (c.cdMul || 1);
      if (now - c.lastAttackAt > stabCd) {
        Combat.ninjaWormStab(c, tgt, NINJA_STAB_DMG);
        c.lastAttackAt = now;
        c.castFlashUntil = now + 280;
        Dialog.bark(c, "wormStab");
      }
      return;
    }

    // Ranged kiting: if a monster has shoved its way inside our
    // comfort radius (KITE_TRIGGER), commit to backing off for a
    // short burst (kiteUntil) while still shooting on cooldown.  We
    // commit for 0.7-1.3s so we don't oscillate forward/back every
    // frame, and we re-evaluate every ~600ms when not committed so
    // the choice between "stand and shoot" and "kite away" feels
    // organic rather than deterministic.  The kite ends early once
    // we've opened up to KITE_RELEASE so we don't waste shots
    // walking after we've already created the gap.
    if (isRanged(c) && tryKiteFromMonster(c, dt, now, tgt, dx, dy, d)) return;

    // Stand off just inside attack range so we're not overlapping.
    // Boss-fight tweak: ranged heroes shooting a hydra body or head
    // also get an "outside the bite envelope" floor — sitting at
    // weapon-range minus 6 is a hair outside HYDRA_HEAD_RANGE for a
    // long-ranged bow (archer 170 → standoff 164 px, 69 px clear of
    // the head lunge) but for the ninja (120 → 114 px) it's only a
    // 19 px buffer, so any head that swivels his way bites him.
    // Push the standoff out to (head reach + 25) px when feasible,
    // capped by actual weapon range so the hero can still fire.
    let standoff = Math.max(10, c.atk.range - 6);
    if (HydraPlan.active() && isRanged(c) &&
        (tgt.kind === "hydraBody" || tgt.kind === "hydraHead")) {
      const safe = (Monsters.HYDRA_HEAD_RANGE || 95) + 25;
      standoff = Math.min(c.atk.range, Math.max(standoff, safe));
    }
    if (d > standoff) {
      // Pick which side of the target to approach from.  Math.sign(dx)
      // can be 0 when the hero and the target are in the same column
      // (rare but real — a worm that surfaces directly above/below the
      // hero, a target re-pick that lands on a monster aligned with
      // us).  Without a fallback, the standoff goal collapses onto
      // the target's exact position and the hero walks straight onto
      // the bite.  Default to whichever side we're already facing.
      const side = dx === 0 ? (c.dir === "l" ? 1 : -1) : Math.sign(dx);
      setTarget(c, tgt.x - side * standoff * 0.6,
                   Math.max(Scene.FLOOR_TOP + 8,
                            Math.min(Scene.FLOOR_BOTTOM - 6, tgt.y)));
      moveStep(c, dt, 1.1);
      // Opportunistic shot while we're still closing the standoff
      // gap.  The standoff line sits 6 px inside actual weapon range,
      // so any target in (standoff, c.atk.range] is technically
      // already shootable — and a target that drifts back out past
      // standoff between cooldowns (a slime kiting away at nearly
      // hero-speed, a fresh re-pick from nearestMonster's wider
      // AGGRO_RANGE * 1.3 net, or a worm that briefly burrowed) used
      // to leave the hero chasing forever without ever firing.
      // Snap the facing like stepAwayFrom does — we're moving anyway,
      // the pivot stun would cancel the chase progress.
      if (isRanged(c) && d <= c.atk.range &&
          now - c.lastAttackAt > effectiveCd(c)) {
        c.dir = dx >= 0 ? "r" : "l";
        Combat.heroAttack(c, tgt);
        c.lastAttackAt = now;
        c.castFlashUntil = now + 160;
      }
      return;
    }
    // Ranged spacing: if the monster has crept inside the comfortable
    // firing band (≤ 85% of standoff), drift back toward the standoff
    // line while still shooting on cooldown.  Without this the slow-
    // cooldown casters (firemage 1.5s, witch 1.4s) just stand at the
    // standoff line waiting for their next shot, and any monster that
    // walks 30 px in 1s ends up biting their kneecaps before the
    // probabilistic kite (which only triggers at d < 50) decides to
    // back away.  This is the deterministic "hold the line" behaviour;
    // tryKiteFromMonster above is the panic kite for when the monster
    // has already broken through.
    if (isRanged(c) && d < standoff * 0.85) {
      stepAwayFrom(c, dt, now, tgt, dx, dy);
      return;
    }
    c.frame = 0;
    const desired = dx >= 0 ? "r" : "l";
    // Ranged fighters pay the pivot tax if the target slipped
    // behind them between cooldowns.  Melee fighters keep the
    // direct snap-flip — a sword swing already commits the body
    // weight and a 280 ms pause inside arm's reach would just
    // get them bitten.
    if (isRanged(c)) {
      if (!turnToFace(c, desired, now)) return;
    } else {
      c.dir = desired;
    }
    if (now - c.lastAttackAt > effectiveCd(c)) {
      Combat.heroAttack(c, tgt);
      c.lastAttackAt = now;
      // Dwarf's axe swing is a longer animation; sync his cast-
      // flash so the sprite glows for the whole chop instead of
      // winking off half-way through.
      c.castFlashUntil = now + (c.atk.kind === "axe" ? 320 : 160);
    }
  }

  // Returns true when the hero is currently kiting (handled the tick)
  // so tickFighting should bail out.  See KITE_* tuning below for the
  // distance / probability knobs.
  function tryKiteFromMonster(c, dt, now, tgt, dx, dy, d) {
    const range = c.atk.range;
    // The active spacing branch in tickFighting holds the firing line
    // at ~85% of standoff; this kite is the *panic* fallback for when
    // a monster has shoved through that line.  Caps were 50 / 90, but
    // for long-range casters (firemage 150, archer 170) that left a
    // huge dead-zone where the hero stood still and bled.  Bumping
    // them to a larger fraction of weapon range lets the kite fire at
    // a sensible distance for any ranged kit.
    const KITE_TRIGGER = Math.min(75, range * 0.5);
    const KITE_RELEASE = Math.min(115, range * 0.78);
    const KITE_PROB = 0.85;
    const KITE_DECIDE_COOLDOWN = 600;
    const KITE_DURATION_MS = [700, 1300];

    if (now < c.kiteUntil) {
      if (d > KITE_RELEASE) { c.kiteUntil = 0; return false; }
      stepAwayFrom(c, dt, now, tgt, dx, dy);
      return true;
    }
    if (d >= KITE_TRIGGER) return false;
    if (now < c.kiteDecideAt) return false;
    c.kiteDecideAt = now + KITE_DECIDE_COOLDOWN;
    if (Math.random() >= KITE_PROB) return false;
    c.kiteUntil = now + rr(...KITE_DURATION_MS);
    stepAwayFrom(c, dt, now, tgt, dx, dy);
    return true;
  }

  // One frame of "back away while still shooting".  Aim a step roughly
  // opposite the monster, clamp to the lawn, route around the pond,
  // fire on cooldown, and keep the sprite facing the target so the
  // shot reads as a deliberate retreat-and-fire instead of a flee.
  function stepAwayFrom(c, dt, now, tgt, dx, dy) {
    const len = Math.hypot(dx, dy) || 1;
    const stepGoal = 60;
    let gx = c.x - (dx / len) * stepGoal;
    let gy = c.y - (dy / len) * stepGoal * 0.4;
    gx = Math.max(12, Math.min(Scene.WIDTH - 12, gx));
    gy = Math.max(Scene.FLOOR_TOP + 10,
                  Math.min(Scene.FLOOR_BOTTOM - 8, gy));
    setTarget(c, gx, gy);
    moveStep(c, dt, 1.05);
    c.dir = dx >= 0 ? "r" : "l";
    if (now - c.lastAttackAt > effectiveCd(c)) {
      Combat.heroAttack(c, tgt);
      c.lastAttackAt = now;
      c.castFlashUntil = now + 160;
    }
  }

  function tickDrinking(c, dt, now) {
    // Phase machine:
    //   approachGround -- walking to a bottle dropped on the lawn
    //   wait      -- chest was busy when we got there; queue beside it
    //   approach  -- walk to the chest
    //   open      -- stand still while the lid lifts
    //   backstep  -- side-step off the chest with the bottle in hand
    //   drink     -- stand still, Combat draws the sparkle, heal at the end
    //
    // Early bail: this errand was triggered because hp dropped below
    // LOW_HP_FRACTION.  If the healer (a flower bloom, the campfire,
    // a buddy's hand-off) topped us back up above that threshold while
    // we were still walking to the chest / queueing / detouring to a
    // ground bottle, the trigger no longer holds — drop the run so
    // someone else can use the chest slot, the queued bottle stays on
    // the shelf for the next casualty, and we go back to wandering /
    // working / actually fighting.  Hysteresis (+0.15 over the trigger)
    // keeps a single regen tick from oscillating us in and out.  Only
    // bail during the WALKING phases — once the lid is open or the
    // bottle is in our hand we're committed: closing the chest empty-
    // handed mid-rummage or putting a held bottle back would look
    // wrong, and the drink beat itself is a one-frame finisher.
    if ((c.drinkPhase === "approachGround"
         || c.drinkPhase === "wait"
         || c.drinkPhase === "approach")
        && c.hp >= c.maxHp * (LOW_HP_FRACTION + 0.15)) {
      // Release any ground-bottle claim so a still-wounded buddy can
      // grab it on the next maybeEnterCombat tick.  exitCombat does
      // this defensively as well, but spelling it out here keeps the
      // intent obvious next to the dialog cue.
      if (c.targetGroundPotion) {
        if (c.targetGroundPotion.claimer === c) c.targetGroundPotion.claimer = null;
        c.targetGroundPotion = null;
      }
      Dialog.bark(c, "cancelDrink");
      exitCombat(c);
      return;
    }
    if (c.drinkPhase === "approachGround") {
      const p = c.targetGroundPotion;
      if (!p || !Scene.groundPotionExists(p)) {
        // Bottle vanished (someone else snagged it, or it expired)
        // — bail and let maybeEnterCombat re-pick on the next tick.
        c.targetGroundPotion = null;
        if (c.hp < c.maxHp * PANIC_HP_FRACTION) startFleeing(c);
        else exitCombat(c);
        return;
      }
      // Abort the detour if a monster has stepped onto our route —
      // dying to a goblin while reaching for a heal bottle is the
      // exact opposite of "drinking made me feel better".
      if (Monsters.anyThreat(c.x, c.y, 50)) {
        if (p.claimer === c) p.claimer = null;
        c.targetGroundPotion = null;
        if (c.hp < c.maxHp * PANIC_HP_FRACTION) startFleeing(c);
        else startRetreating(c);
        return;
      }
      setTarget(c, p.x, p.y);
      const arrived = moveStep(c, dt, 1.1);
      const within  = Math.hypot(p.x - c.x, p.y - c.y) < 6;
      if (arrived || within) {
        if (Scene.takeGroundPotion(p)) {
          c.heldPotion = { kind: "drink", potionKind: p.kind };
          c.targetGroundPotion = null;
          c.drinkPhase = "backstep";
          const dx = (c.x < Scene.WIDTH / 2) ? 14 : -14;
          setTarget(c, c.x + dx, c.y);
        } else {
          // Lost the race — bottle was already gone when we arrived.
          c.targetGroundPotion = null;
          exitCombat(c);
        }
      }
      return;
    }
    if (c.drinkPhase === "wait") {
      if (Scene.chestStockOf("heal") <= 0) {
        // No heal bottles left while we were queueing — bail
        // (panic if our HP is low, otherwise just go home).
        // We check the heal kind specifically: a chest stocked
        // ONLY with revives is "empty" from the drinker's
        // perspective, since they can't drink a revive on the spot.
        if (c.hp < c.maxHp * PANIC_HP_FRACTION) startFleeing(c);
        else exitCombat(c);
        return;
      }
      const occupant = chestInUseBy(c);
      if (!occupant) {
        c.drinkPhase = "approach";
        const chest = Scene.chest();
        setTarget(c, chest.x, chest.y + 2);
        return;
      }
      // Walk to the wait spot if not there yet, then idle.  We
      // re-pick the wait side every tick so the queue spot follows
      // the current occupant if they shuffle around (backstep, etc.).
      const t = chestWaitTarget(c, occupant);
      setTarget(c, t.x, t.y);
      moveStep(c, dt, 0.9);
      return;
    }
    if (c.drinkPhase === "approach") {
      const arrived = moveStep(c, dt, 1.2);
      if (arrived) {
        if (Scene.chestStockOf("heal") <= 0) {
          // Someone else cleaned out the heals before we got here.
          if (c.hp < c.maxHp * PANIC_HP_FRACTION) startFleeing(c);
          else exitCombat(c);
          return;
        }
        // Two heroes can have entered "approach" on the same tick
        // (chestInUseBy returned null for both).  The slower arrival
        // bumps into a now-occupied chest — slip into the wait
        // queue instead of stacking on top of the current user.
        const occupant = chestInUseBy(c);
        if (occupant) {
          c.drinkPhase = "wait";
          const t = chestWaitTarget(c, occupant);
          setTarget(c, t.x, t.y);
          return;
        }
        c.drinkPhase = "open";
        c.combatUntil = now + CHEST_OPEN_MS;
        Scene.openChest(CHEST_OPEN_MS + 160);
        c.frame = 0;
        Dialog.bark(c, "chestOpen");
      }
      return;
    }
    if (c.drinkPhase === "open") {
      // Keep the lid held up while we're rummaging.
      Scene.openChest(120);
      if (now >= c.combatUntil) {
        if (Scene.takePotionFromChest("heal")) {
          c.heldPotion = { kind: "drink", potionKind: "heal" };
          // Spare revive grab: the lid is already up and we're rummaging
          // anyway, so a non-reviver (anyone who can't channel a revive
          // themselves — i.e. not witch / firemage / girl) takes a
          // revive bottle along too if the chest has one and they aren't
          // already carrying a spare.  If they die later, that bottle
          // drops onto the lawn (see startDying); if an ally falls while
          // they're still on their feet, they skip the chest run and use
          // the spare on the corpse directly (see maybeEnterCombat).
          // NB: `isChannelReviver`, not `canRevive` — a mounted girl on
          // a chest drink run still has the revive spell in her kit and
          // shouldn't grab a spare bottle "because the mount gates her
          // channel right now".
          if (!isChannelReviver(c) && !c.spareRevive
              && Scene.chestStockOf("revive") > 0
              && Scene.takePotionFromChest("revive")) {
            c.spareRevive = true;
          }
          c.drinkPhase = "backstep";
          const dx = (c.x < Scene.WIDTH / 2) ? 18 : -18;
          setTarget(c, c.x + dx, c.y);
        } else {
          // Ran out between "open" and "grab" — bail.
          if (c.hp < c.maxHp * PANIC_HP_FRACTION) startFleeing(c);
          else exitCombat(c);
        }
      }
      return;
    }
    if (c.drinkPhase === "backstep") {
      const arrived = moveStep(c, dt, 1.0);
      if (arrived) {
        c.drinkPhase = "drink";
        c.combatUntil = now + DRINK_MS;
        c.frame = 0;
      }
      return;
    }
    if (c.drinkPhase === "drink") {
      if (now >= c.combatUntil) {
        Combat.healHero(c, POTION_HEAL, "drink");
        c.heldPotion = null;
        exitCombat(c);
        Dialog.bark(c, "drink");
      } else {
        c.frame = 0;
      }
      return;
    }
  }

  // Witch carrying a freshly brewed potion over to the chest.  Same
  // lid-lifting routine as drinking, but she puts a bottle *in*
  // instead of taking one out, and then walks back to her cauldron.
  // Hydra-aware veto for any witch chest run.  Returns true when the
  // straight-line walk from her current spot to the chest would cross
  // the head-bite ring, OR the chest tile itself sits inside it.  Used
  // at entry (`startDepositing`) so we don't commit to an unreachable
  // destination.  Mid-walk we use `witchTargetPathBlockedByHydra`
  // instead, because the "return" sub-phase is walking AWAY from the
  // chest and back to the cauldron.
  function witchChestPathBlockedByHydra(c) {
    if (!c || c.name !== "witch") return false;
    if (!HydraPlan || !HydraPlan.active || !HydraPlan.active()) return false;
    const chest = Scene.chest && Scene.chest();
    if (!chest) return false;
    if (witchInHydraDangerAt(chest.x, chest.y + 2)) return true;
    return hydraPathBlocked(c.x, c.y, chest.x, chest.y + 2);
  }

  // Generic mid-walk veto: any time the witch is committed to a target
  // tile during a hydra fight, abort if the body has crept onto the
  // line between her and that tile (or onto the tile itself).  The
  // body roams ~10–15 px/s and the witch's commutes are 4–5 s long, so
  // the situation can flip mid-walk even after a clean entry check.
  function witchTargetPathBlockedByHydra(c) {
    if (!c || c.name !== "witch") return false;
    if (c.tx == null || c.ty == null) return false;
    if (!HydraPlan || !HydraPlan.active || !HydraPlan.active()) return false;
    if (witchInHydraDangerAt(c.tx, c.ty)) return true;
    return hydraPathBlocked(c.x, c.y, c.tx, c.ty);
  }

  function startDepositing(c) {
    // Same path veto as the brew→deposit gate in maybeEnterCombat:
    // refuse to commit if the chest is either unreachable (path
    // crosses the bite ring) or itself sitting inside it.  Other
    // entry points (delivery bail-outs, mid-fight resumes) used to
    // skip this check and march the witch straight at the boss —
    // see tools/witch_path_sim.py, which catches ~55% of random
    // hydra positions making the cauldron↔chest line unsafe.
    // Keep the bottle on her belt; she'll re-attempt next tick once
    // the body shifts.
    if (witchChestPathBlockedByHydra(c)) {
      if (c.brewReady && !c.heldPotion) {
        c.heldPotion = { kind: "deliver", potionKind: c.brewKind || "heal" };
      }
      // Drop out so maybeEnterCombat's home-base branch can take
      // over (retreats if she's currently in danger, otherwise pulls
      // her toward the cauldron via a path check).
      exitCombat(c);
      return;
    }
    enterCombatMode(c, "depositing");
    c.combatUntil = 0;
    // An earlier combat interruption (e.g. a retreat triggered mid-
    // brew) may have cleared the visible bottle token even though the
    // brew itself is still "ready".  Re-hydrate it so the witch walks
    // to the chest with the potion visible in hand.
    if (c.brewReady && !c.heldPotion) {
      c.heldPotion = { kind: "deliver", potionKind: c.brewKind || "heal" };
    }
    const occupant = chestInUseBy(c);
    if (occupant) {
      c.depositPhase = "wait";
      const t = chestWaitTarget(c, occupant);
      setTarget(c, t.x, t.y);
    } else {
      c.depositPhase = "approach";
      const chest = Scene.chest();
      setTarget(c, chest.x, chest.y + 2);
    }
  }

  function tickDepositing(c, dt, now) {
    // Carrying a heal bottle and bleeding?  Don't be a hero —
    // skip the chest run, step out of the line of fire, and drink
    // the brew you're already holding.  We only override during
    // the "walking" phases; once the lid is open the deposit is
    // committed and finishes in a single beat anyway.  Important:
    // includes the "return" phase too, because a witch who already
    // dropped the bottle in the chest BUT is walking home wounded
    // through a bite zone needs to be able to stop and engage / be
    // engaged by maybeEnterCombat — without this the user-reported
    // "she deposited and was killed on the way back" sequence is
    // unrecoverable.  shouldSelfDrinkHeld will short-circuit on the
    // return walk since heldPotion is already null at that point;
    // the fighter-bite engagement below is what handles return.
    // Hydra crept into the cauldron↔chest corridor mid-commute?  Abort
    // the run, keep the bottle on her belt (brewReady stays true so
    // exitCombat preserves heldPotion), and let maybeEnterCombat's
    // home-base branch retreat her to safe ground.  Without this the
    // witch happily finishes the chest run by walking under the
    // mouth — reproّd in tools/witch_path_sim.py at ~55% of random
    // hydra positions.  Skip during the "open" beat (lid is up, the
    // deposit is one frame from done) — bailing then would just lose
    // the potion mid-animation.
    if ((c.depositPhase === "approach"
         || c.depositPhase === "wait"
         || c.depositPhase === "return")
        && witchTargetPathBlockedByHydra(c)) {
      exitCombat(c);
      return;
    }
    if ((c.depositPhase === "approach" || c.depositPhase === "wait")
        && shouldSelfDrinkHeld(c)) {
      startSelfDrink(c);
      return;
    }
    // Fighter mid-deposit getting bitten?  Stop walking past the
    // monster and engage.  The witch / firemage / knight all carry
    // brews to the chest at various points; the user reported the
    // witch in particular tanking hits all the way to the chest,
    // depositing, and dying without ever swinging back — exactly
    // the case this branch fixes.  We allow the engagement during
    // every walking sub-phase (approach / wait / return); the
    // "open" beat is just 260 ms and lid-up frames don't gain
    // anything from a flip.  brewReady stays true so the held
    // bottle survives the combat round (exitCombat preserves
    // heldPotion when brewReady is set), and the next
    // maybeEnterCombat pass will resume the deposit run after the
    // monster is down.  Skipped at panic HP — startFighting at
    // <PANIC_HP would be a death sentence, the panic-flee branch
    // below should take over.
    if ((c.depositPhase === "approach"
         || c.depositPhase === "wait"
         || c.depositPhase === "return")
        && !nonFighter(c) && c.atk
        && c.hp >= c.maxHp * PANIC_HP_FRACTION) {
      const [biter] = nearestMonster(c, FIGHTER_ERRAND_BITE_R);
      if (biter) {
        startFighting(c, biter);
        return;
      }
    }
    // Friend on the ground while we're walking a bottle to the
    // chest?  The shelf can wait — the corpse can't.  We hand the
    // brew back to the witch's belt (brewReady stays true so the
    // potion isn't lost; she'll resume the deposit run after the
    // resurrection) and switch into the channel.  Same "approach
    // / wait" gate as self-drink — once the lid is open the deposit
    // is one frame from done, no point aborting it.
    if ((c.depositPhase === "approach" || c.depositPhase === "wait")
        && shouldDropForRevive(c)) {
      const corpse = nearestDeadAlly(c);
      if (corpse) { startReviving(c, corpse); return; }
    }
    // Wounded ally close to the route?  Hand the bottle over directly
    // instead of stocking it for them to fetch later.  Same approach /
    // wait gate as the other detours: once the lid is open the deposit
    // is one frame from done, no point peeling off then.  Throttled by
    // HANDOFF_CHECK_MS so we're not running findHandoffRecipient
    // (path-safety + linear ally scan) every frame.
    if ((c.depositPhase === "approach" || c.depositPhase === "wait")
        && c.heldPotion
        && c.heldPotion.potionKind === "heal"
        && now - (c.handoffCheckAt || 0) >= HANDOFF_CHECK_MS) {
      c.handoffCheckAt = now;
      const recipient = findHandoffRecipient(c);
      if (recipient) { startDelivering(c, recipient, now); return; }
    }
    if (c.depositPhase === "wait") {
      if (!Scene.chestHasRoom()) {
        c.depositPhase = "return";
        const home = c.activity;
        setTarget(c, home.x, home.y);
        return;
      }
      const occupant = chestInUseBy(c);
      if (!occupant) {
        c.depositPhase = "approach";
        const chest = Scene.chest();
        setTarget(c, chest.x, chest.y + 2);
        return;
      }
      const t = chestWaitTarget(c, occupant);
      setTarget(c, t.x, t.y);
      moveStep(c, dt, 0.9);
      return;
    }
    if (c.depositPhase === "approach") {
      const arrived = moveStep(c, dt, 1.0);
      if (arrived) {
        if (!Scene.chestHasRoom()) {
          // Chest filled up while we were walking — keep the potion
          // for next time and head home.
          c.depositPhase = "return";
          const home = c.activity;
          setTarget(c, home.x, home.y);
          return;
        }
        // Got beaten to the chest — queue beside it instead of
        // standing on the current user.
        const occupant = chestInUseBy(c);
        if (occupant) {
          c.depositPhase = "wait";
          const t = chestWaitTarget(c, occupant);
          setTarget(c, t.x, t.y);
          return;
        }
        c.depositPhase = "open";
        c.combatUntil = now + DEPOSIT_OPEN_MS;
        Scene.openChest(DEPOSIT_OPEN_MS + 160);
        c.frame = 0;
      }
      return;
    }
    if (c.depositPhase === "open") {
      Scene.openChest(120);
      if (now >= c.combatUntil) {
        const kind = (c.heldPotion && c.heldPotion.potionKind) || c.brewKind || "heal";
        if (Scene.depositPotionToChest(kind)) {
          c.heldPotion = null;
          c.brewReady = false;
          c.brewKind = "heal";
          Dialog.bark(c, "chestDeposit");
        }
        c.depositPhase = "return";
        const home = c.activity;
        setTarget(c, home.x, home.y);
      }
      return;
    }
    if (c.depositPhase === "return") {
      const arrived = moveStep(c, dt, 1.0);
      if (arrived) exitCombat(c);
      return;
    }
  }

  // States in which an ally cannot accept a hand-off (already busy
  // with their own potion / chest / corpse / UFO ride / heal cast).
  // Excludes "fighting" and "retreating" deliberately — wounded
  // brawlers are exactly who needs the bottle the most, even if it
  // means interrupting a swing.
  const HANDOFF_BLOCKED_MODES = new Set([
    "drinking", "depositing", "delivering",
    "potionReviving", "reviving",
    "ufoing", "dead", "fleeing", "healing",
  ]);

  // Pick the most-wounded eligible ally within the witch's hand-off
  // bubble.  Eligibility: alive, on stage, not mid-conversation, not
  // already holding a bottle, not in any of the chest / corpse /
  // potion / UFO sub-flows above, hp below the same threshold the
  // rest of the team uses to decide they need a potion, and reachable
  // along a safe path (no monsters camped between us and them).
  function findHandoffRecipient(c) {
    if (!c.heldPotion || c.heldPotion.potionKind !== "heal") return null;
    let best = null, bestRatio = 1;
    for (const o of list) {
      if (o === c) continue;
      if (o.hp <= 0) continue;
      // Robot's chassis won't metabolise a heal potion — don't waste
      // the brew on him.  (Same reason he skips the chest run.)
      if (o.name === "robot") continue;
      if (HANDOFF_BLOCKED_MODES.has(o.combatMode)) continue;
      if (o.heldPotion) continue;
      if (o.state === "talking") continue;
      if (o.hp >= o.maxHp * HANDOFF_HP_FRACTION) continue;
      const dx = c.x - o.x, dy = c.y - o.y;
      if (dx * dx + dy * dy > HANDOFF_R * HANDOFF_R) continue;
      if (!safePathTo(c, o.x, o.y)) continue;
      // Boss-fight veto: never march the witch into spit/bite range
      // to deliver a bottle — even during a "push window" when
      // safePathTo is lenient.  The hand-off can wait; she can't
      // brew (or hand off anyone else) if she's getting her face
      // chewed off by a head.  Same gate also blocks bottle-deliveries
      // to a recipient currently standing in those zones (the courier
      // would have to step into the danger to mime the give).
      if (c.name === "witch" &&
          (witchInHydraDangerAt(c.x, c.y) || witchInHydraDangerAt(o.x, o.y))) {
        continue;
      }
      // Path veto: even if both endpoints are safe, a straight-line
      // walk between cauldron-side witch and a far-side recipient
      // can graze the boss's head-bite ring.  `safePathTo` above
      // doesn't catch this — its monster-on-path scan uses a
      // PATH_CLEARANCE (~38 px) much tighter than head reach
      // (~95 px), so a path that threads the needle past the body
      // reads as clear right up until the first bite lands.
      if (c.name === "witch" && hydraPathBlocked(c.x, c.y, o.x, o.y)) {
        continue;
      }
      const ratio = o.hp / o.maxHp;
      if (ratio < bestRatio) { bestRatio = ratio; best = o; }
    }
    return best;
  }

  // Switch the witch from depositing to a hand-off detour.  We keep
  // the bottle visible in her hand for the entire approach so the
  // intent reads on screen, then transfer it during the "give" beat.
  function startDelivering(c, recipient, now) {
    enterCombatMode(c, "delivering");
    c.combatTarget = null;
    c.combatUntil = 0;
    c.depositPhase = null;
    c.deliverTarget = recipient;
    c.deliverPhase = "approach";
    c.deliverStartAt = now;
    setTarget(c, recipient.x, recipient.y);
    Dialog.bark(c, "handoffGive");
  }

  function tickDelivering(c, dt, now) {
    const r = c.deliverTarget;
    // Recipient bailed mid-detour — went to drink something else, got
    // grabbed by the UFO, fell over, etc.  Salvage the bottle by
    // resuming the chest run (or ending combat if the bottle is
    // somehow gone).
    const recipientGone = !r
      || r.hp <= 0
      || HANDOFF_BLOCKED_MODES.has(r.combatMode)
      || r.heldPotion
      || !isVisibleNow(r)
      || r.hp >= r.maxHp;
    if (recipientGone) {
      c.deliverTarget = null;
      c.deliverPhase = null;
      if (c.heldPotion) startDepositing(c);
      else exitCombat(c);
      return;
    }
    // Boss-fight bail-out: if the recipient drifted into the
    // hydra's bite/spit envelope during our approach, OR the chase
    // dragged the witch herself into the head-bite ring, abort the
    // hand-off and head back to deposit.  Without this guard the
    // user-reported "witch went for the hydra again" repro happens
    // every push window — safePathTo lets her cross the spit zone
    // when the plan flags push, and the recipient (a tank holding
    // line) is by definition standing where the fight is.
    if (c.name === "witch" && HydraPlan && HydraPlan.active && HydraPlan.active()) {
      const recipientUnsafe = witchInHydraDangerAt(r.x, r.y);
      // Mirror `findHandoffRecipient`'s entry gate: the witch self-
      // check needs to cover BOTH bite AND spit, not just the bite
      // ring.  An earlier version compared only against
      // HYDRA_HEAD_RANGE+10, which let the body roam laterally into
      // the cauldron↔recipient corridor mid-walk: the witch (and the
      // recipient she was running the bottle to) ended up ~140 px
      // from the body — clear of bite but deep in spit — and she
      // kept marching right up to him to mime the give.  Reproduced
      // by user screenshot: witch and firemage standing side-by-side
      // ~140 px south of the hydra, both inside the spit envelope.
      const witchUnsafe = witchInHydraDangerAt(c.x, c.y);
      // Same path veto as `findHandoffRecipient`: a straight-line
      // walk from a safe cauldron-side witch to a safe far-side
      // recipient can still cut across the boss's head-bite ring.
      // Without this, the chase commits the moment both endpoints
      // happen to be in clear tiles and re-evaluates only on
      // recipient/witch position changes — meanwhile the witch is
      // already crossing under the heads.
      const pathThroughBody = hydraPathBlocked(c.x, c.y, r.x, r.y);
      if (recipientUnsafe || witchUnsafe || pathThroughBody) {
        c.deliverTarget = null;
        c.deliverPhase = null;
        if (c.heldPotion) startDepositing(c);
        else exitCombat(c);
        return;
      }
    }
    // Same self-preservation reflexes as tickDepositing: if the
    // courier is holding a heal brew AND her own HP just dropped
    // (or she's actively bleeding under fire), drink it on the
    // spot — the recipient can wait, the wound can't.  Engagement
    // during walking phases is gated on PANIC_HP so a near-dead
    // witch falls through to the panic-flee path instead of
    // committing to a fight she can't win.
    if ((c.deliverPhase === "approach" || c.deliverPhase === "return")
        && shouldSelfDrinkHeld(c)) {
      startSelfDrink(c);
      return;
    }
    if ((c.deliverPhase === "approach" || c.deliverPhase === "return")
        && !nonFighter(c) && c.atk
        && c.hp >= c.maxHp * PANIC_HP_FRACTION) {
      const [biter] = nearestMonster(c, FIGHTER_ERRAND_BITE_R);
      if (biter) {
        startFighting(c, biter);
        return;
      }
    }

    if (c.deliverPhase === "approach") {
      // Re-target every tick so a recipient who shuffles around
      // (talking to someone, finishing a swing, drifting on patrol)
      // still gets caught up to.  Generous arrival radius — we just
      // need to be close enough to mime a hand-off, not standing on
      // their toes.
      setTarget(c, r.x, r.y);
      const arrived = moveStep(c, dt, 1.1);
      const close = Math.hypot(c.x - r.x, c.y - r.y) < 18;
      // Long-running chase?  Recipient is probably on their own
      // errand and we should stop chasing them across the lawn.
      if (now - (c.deliverStartAt || now) > HANDOFF_APPROACH_TIMEOUT_MS) {
        c.deliverTarget = null;
        c.deliverPhase = null;
        if (c.heldPotion) startDepositing(c);
        else exitCombat(c);
        return;
      }
      if (arrived || close) {
        c.deliverPhase = "give";
        c.combatUntil = now + HANDOFF_GIVE_MS;
        c.frame = 0;
        c.dir = (r.x >= c.x) ? "r" : "l";
      }
      return;
    }

    if (c.deliverPhase === "give") {
      if (now >= c.combatUntil) {
        // Confirm recipient is still good to receive on the beat we
        // actually transfer (they may have taken a hit and entered
        // a blocked mode in the last 260 ms).
        const stillOk = r && r.hp > 0
          && !HANDOFF_BLOCKED_MODES.has(r.combatMode)
          && !r.heldPotion
          && isVisibleNow(r);
        if (stillOk) {
          const potion = c.heldPotion
            || { kind: "drink", potionKind: "heal" };
          c.heldPotion = null;
          c.brewReady = false;
          c.brewKind = "heal";
          receiveHandoffPotion(r, potion, now);
          Dialog.bark(r, "handoffThanks");
        } else if (c.heldPotion) {
          // Recipient wandered off in the last beat — fall back to
          // the original chest run instead of dropping the brew.
          c.deliverTarget = null;
          c.deliverPhase = null;
          startDepositing(c);
          return;
        }
        c.deliverPhase = "return";
        c.deliverTarget = null;
        const home = c.activity || c;
        setTarget(c, home.x, home.y);
      }
      return;
    }

    if (c.deliverPhase === "return") {
      // Return walk back to the cauldron after a successful hand-off.
      // Same mid-walk hydra veto as tickDepositing — the body may have
      // shifted in the seconds since we set off, putting the line back
      // to home through the bite ring.  Drop combat and let the home-
      // base branch in maybeEnterCombat steer her around safely.
      if (witchTargetPathBlockedByHydra(c)) { exitCombat(c); return; }
      const arrived = moveStep(c, dt, 1.0);
      if (arrived) exitCombat(c);
      return;
    }
  }

  // Recipient side of a hand-off: take the witch's bottle and skip
  // straight to the "drink" sub-phase of tickDrinking — there's no
  // chest to walk to and no backstep to perform, the bottle is
  // already in their hand.  Cleans up any state that would interfere
  // (an ongoing chat, a stale combat target) so the drink beat reads
  // clean instead of the ally swinging at thin air mid-sip.
  function receiveHandoffPotion(c, potion, now) {
    if (c.state === "talking") endTalking(c);
    enterCombatMode(c, "drinking");
    c.combatTarget = null;
    c.heldPotion = potion;
    c.drinkPhase = "drink";
    c.combatUntil = now + DRINK_MS;
    c.frame = 0;
  }

  function tickHealing(c, dt, now) {
    // Mounted girl + a revive obligation that actually beats her
    // current heal → dismount.  We can't channel a revive from
    // horseback (canRevive blocks it).  Use shouldDropForRevive, not
    // a bare corpse count: any fallen ally on the lawn used to trip
    // this every tick while she healed someone else, so the horse
    // vanished the frame after mount ("galloped in, poof, no ride").
    // The dismount transitions her to "dismounting"; the next tick
    // exits combat, and the maybeEnterCombat pass right after that
    // picks up the corpse via the normal shouldDropForRevive path.
    if (c.mounted && c.name === "girl" && shouldDropForRevive(c)) {
      startDismount(c, now);
      return;
    }
    // Corpse on the lawn beats a top-up: dead means dead until
    // someone channels, and a 90% ally can survive another beat
    // without us.  Witch / firemage qualify (canRevive); the girl
    // qualifies too, so she'll abandon a heal-in-progress to run
    // for a body when one drops mid-cast.
    if (shouldDropForRevive(c)) {
      const corpse = nearestDeadAlly(c);
      if (corpse) { startReviving(c, corpse); return; }
    }
    let ally = c.combatTarget;
    if (!ally || ally.hp >= ally.maxHp || !isVisibleNow(ally)) {
      ally = neediestAlly(c);
      c.combatTarget = ally;
      if (!ally) {
        // No one to heal.  If a monster is right next to us we
        // have to bail; otherwise just go back to wandering.
        // We *retreat* (stay onstage, look for openings) instead
        // of fleeing offstage — the previous startFleeing here was
        // the main way the healer would vanish from a fight she
        // could still help with.  Only true panic HP escalates to
        // a real exit-stage flee.
        if (Monsters.anyThreat(c.x, c.y, 48)) {
          if (c.hp < c.maxHp * PANIC_HP_FRACTION) startFleeing(c);
          else startRetreating(c);
        } else exitCombat(c);
        return;
      }
    }
    // Per-character cast range: the girl pelts heals from way back
    // (GIRL_HEAL_RANGE), anyone else falls back to the melee value.
    const range = healRangeOf(c);
    // Non-fighters re-check safety every tick — but only against
    // their own standoff tile, not the patient's.  The whole point
    // of a long-range heal is that the patient can be inside the
    // melee while the caster stays outside.  When the cast tile
    // becomes unsafe mid-channel we tactically retreat (keeps her
    // on stage and lets the next maybeEnterCombat tick re-pick a
    // safer patient) instead of bolting offstage — the previous
    // startFleeing here was a major reason the healer "never
    // healed": as soon as a slime drifted into the corridor
    // between her and the patient she'd abandon the cast and
    // sprint for the lawn edge.
    // Two-tier mid-cast bail.  The standard `safeCastFrom` only
    // looks at a 38-px corridor between the caster and her standoff
    // — wide enough for a stationary slime in the way, but a slime
    // hopping in from 50 px to her flank stays "off-corridor" right
    // up until the bite lands, by which point she's also stopped
    // moving (already at the standoff) and the heal-cooldown beat
    // pins her in place to eat another swing.  Add a second
    // wider-radius personal-bubble check on her own tile so any
    // monster genuinely closing on HER (not just on the corridor)
    // also breaks the cast.  60 px ≈ two slime hops of margin —
    // matches the same bubble the maybeEnterCombat / tickRetreating
    // healer-panic checks already use, so the three code paths
    // agree on what counts as "too close".  Without this the
    // pink-haired girl just stands there casting heals while the
    // monster strolls into bite range, then dies on the cooldown
    // tick instead of stepping back even one tile.
    if (nonFighter(c) && (
        !safeCastFrom(c, ally.x, ally.y, range, "heal") ||
        Monsters.anyThreat(c.x, c.y, 60))) {
      // Cast tile became unsafe mid-channel.  Retreat (stays
      // onstage, lets tickRetreating re-pick a heal target as the
      // brawl shifts).  Only flee for real if HP is in panic
      // territory — fleeing means leaving the lawn entirely and
      // is the wrong reflex while she still has ~60% bar.
      if (c.hp < c.maxHp * PANIC_HP_FRACTION) startFleeing(c);
      else startRetreating(c);
      return;
    }
    const stand = standoffNear(c, ally.x, ally.y, range);
    setTarget(c, stand.x, stand.y - 2);
    const arrived = moveStep(c, dt, 1.0);
    const within = Math.hypot(ally.x - c.x, ally.y - c.y) < range;
    if (arrived || within) {
      c.frame = 0;
      // Foot heal: pivot to face the patient as you'd expect of a
      // priest pouring out the cast.  Mounted heal: keep the
      // rider locked to the horse's facing — a girl on a galloping
      // horse swivelling backwards in the saddle to aim a holy
      // rain reads like a sprite glitch, not a spell.  moveStep
      // already kept c.dir tracking the gallop direction; leaving
      // it alone here is what the user actually expects ("faces the
      // direction the horse is moving").
      if (!c.mounted) c.dir = ally.x >= c.x ? "r" : "l";
      // Drive-by heals (cast while mounted) tick slower and heal less
      // — the mount is supposed to be rescue mobility, not a free
      // damage-up, so trading raw heal output for the convenience of
      // staying on the gallop keeps the stationary cast still worth
      // dismounting for.
      const healCdMul = c.mounted ? MOUNTED_HEAL_CD_MUL : 1;
      if (now - c.lastHealAt > HEAL_COOLDOWN_MS * healCdMul) {
        const baseHeal = effectiveHeal(c, GIRL_HEAL);
        const amt = c.mounted
          ? Math.max(1, Math.round(baseHeal * MOUNTED_HEAL_MUL))
          : baseHeal;
        Combat.healHero(ally, amt, "heal");
        c.lastHealAt = now;
        // Holy rain over the patient + a brief cast glow on the
        // caster so the spell actually reads as a spell, not a
        // silent stat tick.  Healers only — when a fighter ever
        // ends up in this branch (no current paths, but cheap to
        // gate) they shouldn't get the priest VFX.
        if (c.role === "healer") {
          // Pass the patient ref instead of frozen coords so the
          // cloud follows them if they shift mid-cooldown.
          Combat.holyRain(ally, HEAL_COOLDOWN_MS);
          c.castFlashUntil = now + 360;
        }
        // Patient acknowledges the heal — short, gated by the
        // dialog system's per-kind cooldown so it fires roughly once
        // per healing "session" rather than every 1.6 s tick.  When
        // it actually lands, the healer answers a beat later with
        // her own warm "you're welcome" so the moment reads as a
        // back-and-forth instead of a silent stat tick.  The
        // healer's reply is gated by its own per-kind cooldown +
        // probability inside Dialog.bark, so a long heal session
        // doesn't turn into a chatty stream of welcomes either.
        if (Dialog.bark(ally, "healThanks") && c.role === "healer") {
          setTimeout(() => Dialog.bark(c, "healWelcome"), 700);
        }
      }
    }
  }

  // Angular sweep evasion.  Sampling-based "best open direction"
  // picker — sweeps N rays around the hero (every 360/N degrees),
  // scores each by how far it travels before hitting a threat (with
  // bonuses for a clean endpoint and penalties for hydra envelopes /
  // pond / lawn clamping), and returns the best candidate.  This is
  // the practical answer to "if left, right, and down are blocked, will she
  // go up?" — the up ray genuinely IS clean, scores ~step,
  // every blocked ray gets capped at its first-hit distance, and the
  // best sample wins.  Works for any threat geometry (single side,
  // two-sided pinch, three-sided encirclement, fully surrounded) and
  // doesn't suffer the "potential field cancels out on symmetry"
  // failure mode of summed inverse-square repulsion vectors.
  //
  // step = how far we project each ray (px); larger gives a better
  // long-distance picture but costs more to score (path corridor
  // walks every monster in the scene per ray).
  function bestEscapeDirection(c, step) {
    const N = 16; // 22.5° increments — fine enough to thread a 30-px gap
    const minY = (Scene.FLOOR_TOP || 40) + 14;
    const maxY = (Scene.FLOOR_BOTTOM || 280) - 14;
    const minX = 20, maxX = Scene.WIDTH - 20;
    const hydraOn = HydraPlan && HydraPlan.active && HydraPlan.active();
    let best = null, bestScore = -Infinity;
    for (let i = 0; i < N; i++) {
      const ang = (i / N) * Math.PI * 2;
      const dx = Math.cos(ang), dy = Math.sin(ang);
      const rawEx = c.x + dx * step;
      const rawEy = c.y + dy * step;
      const ex = Math.max(minX, Math.min(maxX, rawEx));
      const ey = Math.max(minY, Math.min(maxY, rawEy));
      // Pond is impassable, skip outright.
      if (Scene.isInPond && Scene.isInPond(ex, ey, 8)) continue;
      let first = Monsters.distToFirstOnPath(
        c.x, c.y, ex, ey, FLEE_PATH_CLEARANCE);
      // Hydra-aware corridor: the regular monster-on-path scan uses a
      // ~38 px clearance, but the boss head-bite ring is 105 px.  A
      // retreat ray that "looks clean" with the generic clearance
      // can still hug the boss body 50 px away — well inside bite
      // reach.  Add the body explicitly with its full bite radius
      // so corridor scoring reflects what actually kills the witch.
      // Mirrors `tools/witch_walks_to_hydra_sim.py`'s `hydra_aware`
      // path scan: a baseline 5.9% rate of the witch retreating
      // INTO bite goes to 0% with this gate in place.
      const headBiteR = (Monsters.HYDRA_HEAD_RANGE || 95) + 10;
      if (hydraOn) {
        const body = HydraPlan.body && HydraPlan.body();
        if (body) {
          const dxC = ex - c.x, dyC = ey - c.y;
          const seg2 = dxC * dxC + dyC * dyC;
          if (seg2 > 0) {
            let t = ((body.x - c.x) * dxC + (body.y - c.y) * dyC) / seg2;
            if (t < 0) t = 0;
            if (t > 1) t = 1;
            const px = c.x + t * dxC, py = c.y + t * dyC;
            if (Math.hypot(px - body.x, py - body.y) < headBiteR) {
              const distHydra = t * Math.sqrt(seg2);
              if (distHydra < first) first = distHydra;
            }
          }
        }
      }
      // Reward a clean ray with the full projection length plus a
      // headroom bonus, so a perfectly open direction comfortably
      // outscores any partially-blocked one even if the latter gets
      // luckier endpoint conditions.
      let s = (first === Infinity) ? step + 140 : Math.min(first, step + 140);
      // Endpoint penalties — a ray that lands right on top of a
      // monster (or in spit) is a bad commit even if the path was
      // briefly clearer along the way.
      if (Monsters.anyThreat(ex, ey, 36)) s -= 160;
      if (hydraOn && HydraPlan.inSpitDanger && HydraPlan.inSpitDanger(ex, ey)) {
        // Spit penalty was -70 originally, but the +140 headroom
        // bonus a clean ray gets means a clean-but-in-spit ray
        // still beats a clean-but-safe ray that scored slightly
        // lower on tie-breakers.  Bump to -120 so spit endpoints
        // are clearly suboptimal but not as catastrophic as bite
        // (which gets -300 below).
        s -= 120;
      }
      if (hydraOn) {
        const body = HydraPlan.body && HydraPlan.body();
        if (body && Math.hypot(ex - body.x, ey - body.y) <= headBiteR) {
          // Hard NO: don't retreat into the boss's mouth.  Heavier
          // than monster-endpoint penalty (-160) because a slime
          // bite costs ~12 hp, a head bite costs ~20 hp AND chains
          // into the next bite while the witch is stuck mid-step.
          s -= 300;
        }
      }
      // Tie-breaker: among rays whose corridors score equally well
      // (typical case once you've ruled out blocked / endpoint-on-
      // monster directions, several rays all hit the headroom cap),
      // prefer the endpoint that sits FURTHEST from every live
      // threat.  Without this, iteration order alone picked the
      // first 22.5°-spaced clean ray clockwise from due-east, which
      // could easily be a diagonal heading TOWARD an off-axis
      // enemy — exactly the "she ran toward the enemy" report.  The 200-
      // px cap keeps the bonus from dominating raw corridor
      // cleanliness; the 0.4 weight scales a 200 px gap up to +80,
      // less than the +140 headroom granted to a clean ray, so a
      // clean-but-close direction still loses to a clean-and-far
      // one but a partially-blocked far ray can't beat a clean
      // near one.  Verified end-to-end with tools/escape_sim.py.
      const nearestEnd = Monsters.nearestThreatDist(ex, ey, 200);
      s += Math.min(nearestEnd, 200) * 0.4;
      // Tax candidates that got clamped hard against the lawn edge —
      // they read as "the lawn cut off the ray, not because that
      // direction is genuinely clear".  Encourages the picker to
      // prefer interior directions when scores are otherwise close.
      const clampPx = Math.hypot(ex - rawEx, ey - rawEy);
      s -= clampPx * 0.5;
      if (s > bestScore) {
        bestScore = s;
        best = { x: ex, y: ey, score: s, dx, dy, first };
      }
    }
    return best;
  }

  // Pinch override for the panic flee.  The standard pickExitEdge
  // optimises for a clean corridor TO THE LAWN EDGE; if every edge ×
  // Y-lane combination is blocked by the same nearby enemies, every
  // candidate scores similarly bad and the replanner just bounces
  // left/right between them — exactly the "girl darts horizontally back
  // and forth" report.  When that happens (chosen path STILL ends
  // in an imminent bite), we hand the steering off to bestEscape‑
  // Direction's angular sweep, which scores a full ring of escape
  // rays and naturally finds an open vertical slot when left+right
  // (or left+right+down) are all blocked.  The override target
  // becomes a transient evade waypoint; once the hero clears the
  // pinch (distAhead reopens) the regular edge picker re-takes the
  // wheel.
  function tryPanicEvade(c, now) {
    if (!c || c.tx == null || c.ty == null) return false;
    const distAhead = Monsters.distToFirstOnPath(
      c.x, c.y, c.tx, c.ty, FLEE_PATH_CLEARANCE);
    if (distAhead === Infinity || distAhead > FLEE_FLIP_PANIC_R + 12) {
      return false;
    }
    const best = bestEscapeDirection(c, 110);
    if (!best) return false;
    // Refuse the override unless the swept direction is clearly
    // better than the current corridor — otherwise we'd burn the
    // edge progress just to swap one bad commit for another.
    if (best.score < distAhead + 24) return false;
    setTarget(c, best.x, best.y);
    // Lock the commit window so the replanner doesn't immediately
    // unpick the slip on the very next tick.
    c._fleeFlipUntil = now + FLEE_FLIP_COOLDOWN_MS;
    return true;
  }

  function tickFleeing(c, dt, now) {
    // Drive-by snipe: a panicked archer / firemage / robot / witch
    // sprinting past a slime that's right in her face used to silently
    // jog by — `snipeAllowed` vetoes the regular tickCombat snipe in
    // "fleeing" because pivoting would cost her movement.  This
    // helper fires forward only (no turn-stun), so the shot is free
    // and actually thins blockers in her own corridor.
    tryFleeSnipe(c, now);
    // Healer-only: panic-summon the horse if a monster is still
    // closing in.  Without this the horse cooldown is only checked
    // by maybeEnterCombat, which never fires while she's already
    // mid-flee — so a healer who panicked on foot at 80% HP would
    // run all the way to the edge instead of mounting up partway.
    if (c.role === "healer" && !c.mounted && !c.horseEntity
        && now >= (c._horsePanicCheckAt || 0)) {
      c._horsePanicCheckAt = now + HORSE_FLEE_RECHECK_MS;
      if (maybeSummonHorse(c, now, "panic")) return;
      // Boss fallback: in a hydra fight the standard "panic" trigger
      // almost never fires (boss is too far for the 70 px threat
      // gate, spit is airborne).  The "boss" reason has its own
      // hydra-aware checks (in spit envelope OR hp<HORSE_BOSS_HP_FRAC).
      if (maybeSummonHorse(c, now, "boss")) return;
    }
    // Healer-only: if she can throw down a decoy (cooldown ready,
    // pursuer in range, not mounted, no live clone), spend the tick
    // spinning in place; the decoy lands the tick after the spin
    // window closes and movement resumes the same frame.
    if (handleDecoyCast(c, dt, now)) return;
    // Healer-only: abort the flee if the area has gone quiet AND a
    // wounded ally is close enough to be worth helping.  A panic
    // run is meant to GET HER OUT OF DANGER — once the danger is
    // past, sprinting offstage past a half-HP buddy at the cauldron
    // is the dumb behaviour the user flagged ("she ran past the
    // witch and rushed off-screen").  We exit fleeing only when:
    //   • her own HP is comfortably above the panic threshold
    //     (she'd just retreat below that, which is a different
    //     state machine);
    //   • there is no monster in a wide bubble around her
    //     (FLEE_ABORT_THREAT_R), so she isn't actually being
    //     chased anymore — the trigger that started the flee has
    //     either died or wandered off;
    //   • a real heal target exists within FLEE_ABORT_ALLY_R and
    //     she can safely land the cast on it (safeCastFrom keeps
    //     her from running into a fresh brawl in the patient's
    //     tile).
    // Throttled to a light cadence so we're not re-scanning every
    // single frame; one check every ~250 ms is plenty given how
    // far she travels in that window.  Once we abort, exitCombat
    // sets her back to "wandering" and the next maybeEnterCombat
    // pass will route her into startHealing the same frame.
    if (c.role === "healer" && !c.mounted
        && c.hp >= c.maxHp * LOW_HP_FRACTION
        && now >= (c._fleeAbortCheckAt || 0)) {
      c._fleeAbortCheckAt = now + FLEE_ABORT_CHECK_MS;
      if (!Monsters.anyThreat(c.x, c.y, FLEE_ABORT_THREAT_R)) {
        const ally = neediestAlly(c);
        if (ally && ally.hp < ally.maxHp * GIRL_HEAL_TARGET_FRAC
            && Math.hypot(ally.x - c.x, ally.y - c.y) <= FLEE_ABORT_ALLY_R) {
          c.fleeRefuge = null;
          exitCombat(c);
          return;
        }
      }
    }
    // Refuge-flee: head for a closer safe destination on the lawn
    // (the saucer for the alien, a healer / reviver for everyone
    // else) instead of bolting off-stage.  Three things can happen
    // each tick:
    //   1. Path / refuge becomes invalid (a slime stepped onto the
    //      route, the ally went down, the saucer lifted off) —
    //      drop the refuge and revert to the original edge target
    //      so we still escape the bite.
    //   2. We're close enough to the refuge to count it as reached
    //      — the alien bypasses his cooldown and boards the UFO
    //      right away, everyone else hands control back to
    //      maybeEnterCombat (which will pick a healer / chest run
    //      now that we're standing next to safety).
    //   3. Otherwise just keep walking toward it; pursuers can
    //      still catch up but at least we're heading somewhere
    //      that helps.
    if (c.fleeRefuge) {
      const r = c.fleeRefuge;
      let valid = true;
      if (now >= r.checkAt) {
        r.checkAt = now + FLEE_REFUGE_RECHECK_MS;
        if (r.kind === "ally") {
          const a = r.ref;
          if (!a || a.hp <= 0 || !isVisibleNow(a)) valid = false;
          else if (a.combatMode === "fleeing" ||
                   a.combatMode === "dead" ||
                   a.combatMode === "ufoing") valid = false;
          else { r.x = a.x; r.y = a.y; }
        } else if (r.kind === "ufo") {
          const ufo = Scene.ufo();
          if (!ufo) valid = false;
          else { r.x = ufo.x; r.y = ufo.y; }
        }
        if (valid && !safePathTo(c, r.x, r.y)) valid = false;
      }
      if (!valid) {
        c.fleeRefuge = null;
        setTarget(c, r.edgeX, r.edgeY);
      } else {
        const dr = Math.hypot(r.x - c.x, r.y - c.y);
        if (dr <= FLEE_REFUGE_ARRIVE_R) {
          if (r.kind === "ufo" && c.role === "alien") {
            // Panic-board: reset the cooldown so the alien doesn't
            // stand exposed at the saucer waiting it out, then hand
            // off to the regular UFO state machine.
            c.fleeRefuge = null;
            c.ufoCooldownUntil = 0;
            startUfoing(c);
            return;
          }
          c.fleeRefuge = null;
          exitCombat(c);
          return;
        }
        setTarget(c, r.x, r.y);
        moveStep(c, dt, 1.35);
        return;
      }
    }
    const { w } = Sprites.size();
    // Mid-flight replan.  Monsters keep moving while the hero
    // sprints — a slime that wasn't on the corridor at startFleeing
    // time can shuffle into bite range before she reaches it.  We
    // delegate the actual scoring to `pickExitEdge`, which now
    // evaluates BOTH edges across SEVERAL Y lanes (current row,
    // ±60, ±120, ±180 px, clamped to the lawn band) under a single
    // weighted formula — density, corridor depth, away-vector
    // alignment, hydra/grave vetoes.  Replacing the old "compare
    // current row on left vs right and maybe sidestep" decision
    // tree with one consistent picker fixes the user-reported
    // "ran left, met an enemy, flipped right INTO the hydra,
    // died, instead of just ducking up a row" tableau: the
    // hydra-cross veto is now scored at every candidate, not
    // bolted on after the fact, so the picker simply never
    // returns the suicidal flip.  Locked off when she's almost
    // at her chosen edge — any walk shorter than the turnaround
    // beats re-evaluation.
    if (now >= (c._fleeReplanAt || 0)) {
      c._fleeReplanAt = now + FLEE_REPLAN_MS;
      const leftEdge  = -w - 4;
      const rightEdge = Scene.WIDTH + w + 4;
      const goingLeft = c.tx < c.x;
      const myEdge  = goingLeft ? leftEdge  : rightEdge;
      const remainingMine = Math.abs(myEdge - c.x);
      if (remainingMine > FLEE_REPLAN_EDGE_LOCK) {
        // Score the path she's currently committed to (where she
        // IS, with the Y she's currently aiming for) so we can
        // gate the replan on "is this actually getting bad?".
        const distMine = Monsters.distToFirstOnPath(
          c.x, c.y, myEdge, c.ty, FLEE_PATH_CLEARANCE);
        const blockedAhead = distMine !== Infinity
                          && distMine < FLEE_REPLAN_BLOCKED_R;
        const inCommitWindow = now < (c._fleeFlipUntil || 0);
        const imminentBite = distMine !== Infinity
                          && distMine < FLEE_FLIP_PANIC_R;
        // Only re-pick when something's actually wrong with the
        // chosen route.  Without this gate the commit window is
        // useless — every tick would re-pick and small per-frame
        // jitter would cause oscillation.  imminentBite blasts
        // through the commit window because staying the course
        // at <26 px to a slime literally kills us.
        if (blockedAhead && (!inCommitWindow || imminentBite)) {
          const pick = pickExitEdge(c);
          const newEdgeX = pick.edgeX;
          const newEdgeY = pick.edgeY;
          const distNew = Monsters.distToFirstOnPath(
            c.x, c.y, newEdgeX, newEdgeY, FLEE_PATH_CLEARANCE);
          // The new pick has to be meaningfully better than what
          // we were doing — Infinity (perfectly clean) trumps any
          // finite blocker distance, otherwise demand the same
          // FLEE_REPLAN_GAIN headroom we used to require for a
          // direction flip.  Comparing scored corridors AT THE
          // RESPECTIVE Y lanes, not both at c.y, is what lets the
          // "duck up to a clean row" decision actually happen here:
          // distMine is along the row she was aiming for (often
          // the dirty one), distNew is along the lane the picker
          // chose (often a different row that's actually clear).
          const corridorBetter = distNew === Infinity
            || (distMine !== Infinity
                && distNew > distMine + FLEE_REPLAN_GAIN);
          if (corridorBetter) {
            const flipping = (newEdgeX < c.x) !== goingLeft;
            setTarget(c, newEdgeX, newEdgeY + rr(-6, 6));
            if (flipping) {
              // Direction reversal warrants a fresh commit window
              // and a flee bark — both signal "I made a real call
              // here, don't undo it on the next replan tick".  A
              // pure same-edge lane-shift doesn't refresh the
              // commit window, so the next tick can still re-route
              // again if the new lane goes bad too.
              c._fleeFlipUntil = now + FLEE_FLIP_COOLDOWN_MS;
              Dialog.bark(c, "flee");
            }
          }
        }
      }
    }
    // Pinch override: if the chosen path STILL ends in a slime within
    // bite-imminent range (FLEE_FLIP_PANIC_R + a small pad), the
    // edge-picker has nothing better to offer — both corridors and
    // every Y lane are blocked by the same enemies.  Without this the
    // hero just bounces left/right between two flanking slimes (the
    // exact "girl darts horizontally back and forth" report) because the replan
    // keeps flipping to whatever side scored ε higher this tick.
    // Insert a transient perpendicular evade waypoint that pushes her
    // OFF the seam first; once she's clear, distAhead opens back up
    // and the regular replan resumes routing toward an edge.
    tryPanicEvade(c, now);
    moveStep(c, dt, 1.35);
    if (c.x < -w - 1 || c.x > Scene.WIDTH + w + 1) {
      c.state = "offstage";
      c.lastStageExit = now;
      c.hp = c.maxHp;
      c.combatMode = "none";
      c.combatTarget = null;
      c.x = offstageParkX();
      c._fleeReplanAt = 0;
      // Walking off-stage drops the social bonds — the partner can't
      // hear "stand with me" from someone who isn't on the lawn.
      // Affinity persists across exits, so a returning hero is still
      // remembered as a friend by anyone who chatted with them.
      c.pact = null;
      c.moraleUntil = 0;
      c.lookoutUntil = 0;
      c._swapShift = false;
    }
  }

  function tickRetreating(c, dt, now) {
    // Escalate to full panic if we're taking more hits on the way out.
    if (c.hp <= 0) { startDying(c); return; }
    if (c.hp < c.maxHp * PANIC_HP_FRACTION) { startFleeing(c); return; }
    // Surrounded escalation: a tactical retreat assumes ONE direction
    // is meaningfully safer.  When three or more threats are inside
    // a tight bubble (or two are biting from arm's reach), the
    // away-vector seam is too narrow to walk and we'll just bounce
    // bite-to-bite as the monsters herd.  Commit to the off-stage
    // flee instead — `startFleeing`'s edge picker uses density
    // scoring to pick the cleanest exit corridor, which is exactly
    // the right answer in this geometry.  Robot is excluded: he
    // can't actually run for the edge (no flee state in his role
    // wiring) so he'd just stall.
    if (c.name !== "robot") {
      const surrounded =
        Monsters.countThreats(c.x, c.y, 70) >= 3 ||
        Monsters.countThreats(c.x, c.y, 36) >= 2;
      if (surrounded) { startFleeing(c); return; }
    }
    // Same panic-summon recheck as tickFleeing — a healer already
    // walking out from an earlier threat shouldn't keep walking
    // when a fresh monster catches up to her.  maybeEnterCombat
    // won't re-trigger here (combatMode === "retreating", not
    // "none"), so the horse window only opens through this hook.
    if (c.role === "healer" && !c.mounted && !c.horseEntity
        && now >= (c._horsePanicCheckAt || 0)) {
      c._horsePanicCheckAt = now + HORSE_FLEE_RECHECK_MS;
      if (maybeSummonHorse(c, now, "panic")) return;
      if (maybeSummonHorse(c, now, "boss")) return;
    }
    // Same decoy hook as the panic-flee branch — a wounded girl who
    // already broke contact still benefits from dropping a clone if
    // a pursuer catches up to her on the way back to safety.
    if (handleDecoyCast(c, dt, now)) return;

    // Healer on the move: don't walk past a wounded ally she could
    // safely top up.  This is what stops "the girl just runs to the
    // edge ignoring everyone bleeding around her" — without this
    // hook a retreat commits her to her safe-haven tile and she
    // doesn't re-evaluate for heal targets until she arrives.
    // `neediestAlly` already filters by `safeCastFrom`, so an ally
    // surrounded by monsters won't pull her back into the brawl.
    // Throttled to a light cadence (~250 ms) so we don't rescan
    // every single frame; that's still 4 chances per second to
    // catch a freshly-wounded buddy.
    if (c.role === "healer" && now >= (c._retreatHealCheckAt || 0)) {
      c._retreatHealCheckAt = now + 250;
      // Don't bounce back into healing while we're still actively
      // under attack: either a monster is in our wider personal
      // bubble OR we ate a hit in the last ~1.2 s.  Without these
      // gates the healer plays bumper-cars between healing and
      // retreating — `neediestAlly`'s 38-px path-clearance check
      // says "corridor clear" the second the monster slides ~5 px
      // off-axis, she re-commits to the SAME standoff she just
      // got bitten at, walks straight back into the bite, retreats
      // 10 px again, re-engages 250 ms later, and the loop keeps
      // her glued to the brawl until she dies (the user-reported
      // "pink-haired girl runs at the enemy and dies over and over"
      // case, with bubbles of "Stop it, stop it!" all
      // the way down).  80 px ≈ comfortably outside slime-hop +
      // bite reach; 1200 ms ≈ enough to actually break contact
      // before risking another commute through the same tile.
      const recentlyHit  = (now - (c.lastDamagedAt || 0)) < 1200;
      const stillBubbled = Monsters.anyThreat(c.x, c.y, 80);
      if (!recentlyHit && !stillBubbled) {
        const ally = neediestAlly(c);
        if (ally && ally.hp < ally.maxHp * GIRL_HEAL_TARGET_FRAC) {
          startHealing(c, ally);
          return;
        }
      }
    }

    // Recovered enough HP (a healer caught up to us, or a potion
    // topped us off)?  Drop back to normal combat planning.
    //
    // Healer special case: even at full HP, hold the retreat while a
    // monster is still inside her personal bubble.  Without this
    // guard `maybeEnterCombat` would re-trigger her 50 px panic
    // check on the very next tick and call startRetreating again,
    // which would exit again, etc — a per-frame thrash that looks
    // like "she just stands there twitching".  Once the bubble is
    // clear AND HP is fine, we drop back to wandering as before.
    if (c.hp >= c.maxHp * RETREAT_RESUME_HP) {
      const stillInBubble = c.role === "healer" &&
                            Monsters.anyThreat(c.x, c.y, 60);
      if (!stillInBubble) { exitCombat(c); return; }
    }

    // Heal potion restocked mid-retreat AND nobody's right on top of
    // us?  Ditch the retreat and commit to the chest run instead.
    // Robot skips this — heal potions don't help him (see the
    // matching gate in maybeEnterCombat).
    if (c.name !== "robot"
        && Scene.chestStockOf("heal") > 0
        && !Monsters.anyThreat(c.x, c.y, 60)) {
      startDrinking(c); return;
    }

    // Periodically re-evaluate where "safe" is as the board changes
    // (the monster moves, the healer moves, other heroes die, etc.).
    if (now >= c.retreatReplanAt) updateRetreatTarget(c, now);

    const arrived = moveStep(c, dt, 1.2);
    if (arrived) {
      // Made it to the current safe spot — pause a beat and re-plan.
      c.retreatReplanAt = now + 400;
    }
  }

  function tickDead(c, dt, now) {
    // Corpse sits where it fell and waits for a reviver.  Movement
    // is frozen (tx/ty were pinned to the current spot in startDying)
    // but we still run moveStep so the facing + shadow bookkeeping
    // stays sane for the drawing code.
    c.frame = 0;
    c.frameTimer = 0;

    // Zombie-only: self-revive at the grave.  Two phases live on
    // top of the regular "dead" combat mode so the corpse stays
    // visible and the grave marker (drawGraveMarker) keeps
    // rendering until the green pillar pulls him up.
    //   1. Wait window (selfReviveAt > now): nothing on screen yet,
    //      just the timer.  If a hero successfully revives him
    //      first, resurrect() clears combatMode "dead" and we
    //      never get here again.
    //   2. Channel window (selfReviveCastUntil > 0): the green
    //      necromantic pillar is already playing.  When it expires
    //      we resurrect ourselves; the reviver argument is the
    //      corpse itself so the existing thanks/welcome handshake
    //      gracefully no-ops (resurrect() guards on `reviver !==
    //      corpse`).
    if (c.name === "zombie" && c.selfReviveAt > 0) {
      if (c.selfReviveCastUntil === 0) {
        if (now >= c.selfReviveAt) {
          c.selfReviveCastUntil = now + ZOMBIE_SELF_REVIVE_CAST_MS;
          if (Combat.necroLight) {
            Combat.necroLight(c.x, c.y, ZOMBIE_SELF_REVIVE_CAST_MS);
          }
        }
      } else if (now >= c.selfReviveCastUntil) {
        c.selfReviveAt = 0;
        c.selfReviveCastUntil = 0;
        resurrect(c, now, c);
      }
    }
  }

  // Passing-heal hook used by the revive-approach paths.  When the
  // healer is jogging toward a corpse (channel revive, mounted ride,
  // potion run) and a wounded ally happens to be RIGHT next to her,
  // it's silly to walk past them with a heal in the chamber.  We
  // briefly switch to "healing" and let the regular tickHealing
  // pipeline handle the cast; once the heal completes,
  // shouldDropForRevive in tickHealing flips her straight back to
  // reviving the original corpse on the very next tick.
  //
  // The radius is intentionally tight (about 70% of her cast range)
  // so this only fires when the patient really is on her path —
  // a half-screen detour to top someone up would just waste the
  // revive timer.  Throttled to ~3 Hz so we don't rescan every
  // single frame.
  const PASSING_HEAL_CHECK_MS = 280;
  const PASSING_HEAL_RANGE_MUL = 0.75;
  const PASSING_HEAL_HP_FRAC   = 0.85;
  function passingHealTarget(c) {
    if (c.role !== "healer") return null;
    const range = healRangeOf(c);
    const passR = range * PASSING_HEAL_RANGE_MUL;
    let best = null, bestFrac = PASSING_HEAL_HP_FRAC;
    for (const o of list) {
      if (o === c) continue;
      if (!isVisibleNow(o) || o.hp <= 0) continue;
      if (o.combatMode === "ufoing" || o.combatMode === "dead") continue;
      const d = Math.hypot(o.x - c.x, o.y - c.y);
      if (d > passR) continue;
      const f = o.hp / o.maxHp;
      if (f >= bestFrac) continue;
      if (!safeCastFrom(c, o.x, o.y, range, "heal")) continue;
      bestFrac = f; best = o;
    }
    return best;
  }
  // Returns true iff we switched modes to handle a passing heal —
  // callers should `return` immediately so the rest of their tick
  // doesn't re-target/move the freshly-redirected hero.
  function maybePassingHeal(c, now) {
    if (c.role !== "healer") return false;
    if (now < (c._passingHealCheckAt || 0)) return false;
    c._passingHealCheckAt = now + PASSING_HEAL_CHECK_MS;
    const ally = passingHealTarget(c);
    if (!ally) return false;
    startHealing(c, ally);
    return true;
  }

  function tickReviving(c, dt, now) {
    const corpse = c.combatTarget;
    if (!corpse || corpse.combatMode !== "dead") {
      exitCombat(c);
      return;
    }
    if (c.revivePhase === "approach") {
      // Drive-by heal: scoop up a wounded ally she's about to step
      // through before continuing to the corpse.  See
      // maybePassingHeal for the geometry.  Skipped for the witch /
      // firemage (they're not healers and the helper no-ops on them
      // anyway).
      if (maybePassingHeal(c, now)) return;
      // Non-fighters re-check the route every tick: if a monster has
      // wandered into the path or onto her standoff tile since we
      // committed, abort the revive and bolt.  We use the relaxed
      // `safeCastFrom` (path to standoff, not to the corpse) so a
      // slime camping the body itself doesn't disqualify the body
      // — the girl just channels from a tile back.  Fighters
      // (witch, firemage) push through; they can defend themselves
      // if anything jumps them mid-channel.
      const range = reviveRangeOf(c);
      if (nonFighter(c) && !safeCastFrom(c, corpse.x, corpse.y, range, "revive")) {
        startFleeing(c);
        return;
      }
      // Witch on a hydra-fight revive run: if the straight line to
      // the corpse cuts through the boss's head-bite ring (the
      // body drifts; her own X migrates as she steps; the corpse
      // settles into a tile that's clear but on the far side of
      // the lair), abort and fall back to the deposit / wander
      // path.  Same reasoning as the hand-off path veto — we'd
      // rather leave a corpse for one more cycle than trade the
      // brewer for it.  Firemage skipped: he's a melee front-liner
      // expected to be eating bites anyway.
      if (c.name === "witch" && hydraPathBlocked(c.x, c.y, corpse.x, corpse.y)) {
        if (c.heldPotion && c.brewReady) startDepositing(c);
        else exitCombat(c);
        return;
      }
      // Fighter (witch / firemage) on a revive run: if a monster has
      // closed inside FIGHTER_ERRAND_BITE_R the right move is to STOP
      // running past it and engage — a ranged snipe every 1500 ms while
      // sprinting through bite range looks dumb and gets the reviver
      // chewed.  Switch to fighting; the corpse stays on the lawn and
      // the next maybeEnterCombat pass will resume the revive.  Skip
      // the swap if a flip pivot would only delay the engagement —
      // tickFighting handles facing on its own.
      if (!nonFighter(c) && c.atk) {
        const [biter] = nearestMonster(c, FIGHTER_ERRAND_BITE_R);
        if (biter) {
          startFighting(c, biter);
          return;
        }
      }
      // Hand-off check (~3 Hz): if a closer idle reviver is standing
      // around safely, let them shout "I've got this!" and take the
      // job.  The original mutters an acknowledgement and is dropped
      // back to wandering, free to pick a different target on the
      // next maybeEnterCombat pass.
      if (now >= (c._reviveSwapCheckAt || 0)) {
        c._reviveSwapCheckAt = now + 320;
        const taker = closerSafeReviver(c, corpse);
        if (taker) {
          Dialog.bark(taker, "claimRevive", { force: true });
          Dialog.bark(c, "yieldRevive");
          exitCombat(c);
          startReviving(taker, corpse);
          return;
        }
      }
      const stand = standoffNear(c, corpse.x, corpse.y, range);
      setTarget(c, stand.x, stand.y);
      const arrived = moveStep(c, dt, reviverSpeedMul());
      const within = Math.hypot(corpse.x - c.x, corpse.y - c.y) < range;
      if (arrived || within) {
        c.revivePhase = "channel";
        c.combatUntil = now + REVIVE_MS;
        c.castFlashUntil = now + REVIVE_MS;
        c.dir = corpse.x >= c.x ? "r" : "l";
        c.frame = 0;
        Combat.holyLight(corpse.x, corpse.y, REVIVE_MS);
      }
      return;
    }
    if (c.revivePhase === "channel") {
      // Mid-channel safety abort (non-fighters only): a monster that
      // wandered into our bite radius while we stand still casting
      // will eat us alive before the spell lands — and a girl
      // chewed to death mid-revive leaves TWO corpses on the lawn,
      // not zero.  Bail out the same way as the approach phase
      // (startFleeing → tickFleeing's horse-summon and decoy hooks
      // pick up the escape from there).  Witch and firemage push
      // through; they have damage to trade and the channel is
      // shorter for them in practice anyway.
      if (nonFighter(c) && Monsters.anyThreat(c.x, c.y, REVIVE_CHANNEL_BITE_R)) {
        startFleeing(c);
        return;
      }
      c.frame = 0;
      c.dir = corpse.x >= c.x ? "r" : "l";
      if (now >= c.combatUntil) {
        resurrect(corpse, now, c);
        exitCombat(c);
      }
    }
  }

  // Potion-based revive: anyone can fetch the bottle from the chest
  // and use it on a fallen friend.  No channelling — just a quick
  // smash + sparkle and the corpse pops back up.  See startPotionRevive
  // for the high-level state-machine description.
  const POTION_REVIVE_USE_MS = 600;
  function tickPotionReviving(c, dt, now) {
    const corpse = c.combatTarget;
    // Corpse vanished (revived by someone else, or somehow off-stage)?
    // Drop the errand.  Preserve the in-hand revive bottle as a spare
    // for non-revivers so a wasted approach doesn't burn a chest brew
    // — they'll use it on the next corpse instead.  Ground-bottle
    // pickup runs (revivePhase "approachGround") have nothing in hand
    // yet and so can't restash; the chest-fetch and "toCorpse" phases
    // do.
    if (!corpse || corpse.combatMode !== "dead" || !isVisibleNow(corpse)) {
      if (!isChannelReviver(c) && !c.spareRevive
          && c.heldPotion && c.heldPotion.potionKind === "revive") {
        c.spareRevive = true;
      }
      c.heldPotion = null;
      exitCombat(c);
      return;
    }

    if (c.revivePhase === "approachGround") {
      const p = c.targetGroundPotion;
      // Bottle was claimed by someone else, picked up before we got
      // there, or expired.  Bail — maybeEnterCombat will look for a
      // fresh option (chest stock, another bottle) on the next pass.
      if (!p || !Scene.groundPotionExists(p) || p.kind !== "revive") {
        if (p && p.claimer === c) p.claimer = null;
        c.targetGroundPotion = null;
        c.heldPotion = null;
        exitCombat(c);
        return;
      }
      // Refresh the path target each tick — the bottle itself is
      // stationary but the runner could have been pushed around by
      // pond-avoid steps inside moveStep.
      setTarget(c, p.x, p.y);
      const arrived = moveStep(c, dt, 1.15);
      if (arrived) {
        if (Scene.takeGroundPotion(p)) {
          c.heldPotion = { kind: "deliver", potionKind: "revive" };
          c.targetGroundPotion = null;
          c.revivePhase = "toCorpse";
          // Same offset trick the chest path uses so the smash effect
          // doesn't sit underneath the carrier sprite.
          const side = corpse.x > c.x ? -1 : 1;
          setTarget(c, corpse.x + side * (REVIVE_RANGE - 6), corpse.y);
        } else {
          // Bottle vanished between the existence check and the take
          // (rare race with another picker).  Drop the errand.
          c.heldPotion = null;
          c.targetGroundPotion = null;
          exitCombat(c);
        }
      }
      return;
    }

    if (c.revivePhase === "waitChest") {
      if (Scene.chestStockOf("revive") <= 0) { c.heldPotion = null; exitCombat(c); return; }
      const occupant = chestInUseBy(c);
      if (!occupant) {
        c.revivePhase = "approachChest";
        const chest = Scene.chest();
        setTarget(c, chest.x, chest.y + 2);
        return;
      }
      const t = chestWaitTarget(c, occupant);
      setTarget(c, t.x, t.y);
      moveStep(c, dt, 0.9);
      return;
    }

    if (c.revivePhase === "approachChest") {
      const arrived = moveStep(c, dt, 1.2);
      if (arrived) {
        if (Scene.chestStockOf("revive") <= 0) {
          // Someone else grabbed the last revive while we were
          // walking — bail.
          c.heldPotion = null;
          exitCombat(c);
          return;
        }
        const occupant = chestInUseBy(c);
        if (occupant) {
          c.revivePhase = "waitChest";
          const t = chestWaitTarget(c, occupant);
          setTarget(c, t.x, t.y);
          return;
        }
        c.revivePhase = "openChest";
        c.combatUntil = now + CHEST_OPEN_MS;
        Scene.openChest(CHEST_OPEN_MS + 160);
        c.frame = 0;
        Dialog.bark(c, "chestOpen");
      }
      return;
    }

    if (c.revivePhase === "openChest") {
      Scene.openChest(120);
      if (now >= c.combatUntil) {
        if (Scene.takePotionFromChest("revive")) {
          c.heldPotion = { kind: "deliver", potionKind: "revive" };
          c.revivePhase = "backstep";
          const dx = (c.x < Scene.WIDTH / 2) ? 14 : -14;
          setTarget(c, c.x + dx, c.y);
        } else {
          c.heldPotion = null;
          exitCombat(c);
        }
      }
      return;
    }

    if (c.revivePhase === "backstep") {
      const arrived = moveStep(c, dt, 1.0);
      if (arrived) {
        c.revivePhase = "toCorpse";
        // Walk to the side of the body so the smash effect doesn't
        // sit underneath the carrier sprite — same offset trick the
        // ground reviver uses (REVIVE_RANGE - 6).
        const side = corpse.x > c.x ? -1 : 1;
        setTarget(c, corpse.x + side * (REVIVE_RANGE - 6), corpse.y);
      }
      return;
    }

    if (c.revivePhase === "toCorpse") {
      // Non-fighters re-check the route every tick — same paranoia
      // as tickReviving's "approach" phase.  If a monster has moved
      // onto the path or onto the corpse, abort the errand and bolt.
      // Same restash trick as the corpse-vanished bail above: keep
      // the bottle on the carrier's belt as a spare so a panic flee
      // doesn't burn a fresh brew.
      if (nonFighter(c) && !safePathTo(c, corpse.x, corpse.y)) {
        if (!isChannelReviver(c) && !c.spareRevive
            && c.heldPotion && c.heldPotion.potionKind === "revive") {
          c.spareRevive = true;
        }
        c.heldPotion = null;
        startFleeing(c);
        return;
      }
      // Fighter potion couriers (zombie, knight, samurai, robot, …)
      // get a hydra-path safety net here.  The picker in
      // `nearestDeadAlly` already vetoes corpses on the far side of
      // the boss at decision time, but the boss body drifts, the
      // courier himself is moving, and the corpse can drag during
      // its falling-over animation — between picker and arrival the
      // straight line can cross into bite range.  Same restash:
      // park the bottle on his belt as a spare and exitCombat back
      // to wandering; a safer courier (or a UFO beam) takes the
      // body next cycle.  No-op outside boss fights.
      if (!nonFighter(c) && hydraPathBlocked(c.x, c.y, corpse.x, corpse.y)) {
        if (!isChannelReviver(c) && !c.spareRevive
            && c.heldPotion && c.heldPotion.potionKind === "revive") {
          c.spareRevive = true;
        }
        c.heldPotion = null;
        exitCombat(c);
        return;
      }
      const arrived = moveStep(c, dt, reviverSpeedMul());
      const within = Math.hypot(corpse.x - c.x, corpse.y - c.y) < REVIVE_RANGE;
      if (arrived || within) {
        c.revivePhase = "use";
        c.combatUntil = now + POTION_REVIVE_USE_MS;
        c.dir = corpse.x >= c.x ? "r" : "l";
        c.frame = 0;
        Dialog.bark(c, "usePotionRevive");
        Combat.potionReviveSmash(corpse.x, corpse.y);
      }
      return;
    }

    if (c.revivePhase === "use") {
      c.frame = 0;
      c.dir = corpse.x >= c.x ? "r" : "l";
      if (now >= c.combatUntil) {
        c.heldPotion = null;
        resurrect(corpse, now, c);
        exitCombat(c);
      }
    }
  }

  // Shared resurrection body.  Used by the ground reviver's channel
  // finish AND by the UFO when it finishes a tractor-beam revive —
  // the "how you came back" differs but "you're back" is the same:
  // HP refilled, combat flags cleared, back to wandering, revive
  // flash played.
  function resurrect(corpse, now, reviver) {
    corpse.hp = corpse.maxHp;
    corpse.combatMode = "none";
    corpse.combatTarget = null;
    corpse.state = "wandering";
    corpse.stateUntil = now + rr(...WANDER_STEP_MS);
    corpse.deathAt = 0;
    corpse.hitFlashUntil = 0;
    corpse.castFlashUntil = 0;
    // Clear pending self-revive bookkeeping so a hero pre-empt
    // (or a UFO beam, or a chest revive) doesn't leave a stale
    // necromantic timer behind to fire after he's already on his
    // feet.  startDying re-arms it next time he dies near home.
    corpse.selfReviveAt = 0;
    corpse.selfReviveCastUntil = 0;
    corpse.wandersLeft = 1 + Math.floor(Math.random() * 2);
    const [nx, ny] = randomLawnPoint(corpse);
    setTarget(corpse, nx, ny);
    Combat.reviveBurst(corpse.x, corpse.y);
    // Tell the Director the team just clawed back a body so it can
    // push the next wave out — gives the just-revived hero a beat
    // to actually walk before the next pack arrives.
    if (typeof Director !== "undefined" && Director.notifyRevive) {
      Director.notifyRevive(now);
    }
    // A quick, grateful "thanks!" bubble above the just-revived hero
    // so revives feel like a social beat, not just an HP reset.  The
    // bubble is a one-shot reaction line (see Dialog.thanks) — it
    // doesn't hook into the conversation system and can't block the
    // AI from immediately going back to wandering / combat.
    //
    // Self-revive (zombie clawing his way out of his own grave) is
    // the one case where there is no one to thank — passing the
    // corpse as its own reviver is just the bookkeeping marker for
    // "this came back on its own".  Suppress both the thanks AND
    // the welcome handshake in that case so the necromancer doesn't
    // chirp "thank you!" at the empty lawn.
    const selfRevived = !reviver || reviver === corpse;
    if (!selfRevived) {
      Dialog.thanks(corpse);
      // The reviver answers the "thanks!" with a "you're welcome"
      // a beat later so the moment lands as a back-and-forth.  We
      // also park both heroes on the post-conversation cooldown so
      // they don't immediately roll into a full hello/goodbye
      // small-talk convo right on top of the gratitude exchange —
      // they can chat again normally once the cooldown expires.
      Dialog.welcome(reviver);
      reviver.lastConvoAt = now;
      corpse.lastConvoAt = now;
      reviver.lastConvoPartner = corpse;
      reviver.lastConvoPartnerAt = now;
      corpse.lastConvoPartner = reviver;
      corpse.lastConvoPartnerAt = now;
    }
    Dialog.note("revive");
  }

  // Fatal hit while piloting: ease the saucer to the lawn, eject the
  // pilot sprite, then hand off to startDying — same end state as the
  // old instant snap in startDying, but readable as "crash" instead of
  // a frozen UFO in the sky.
  function tickUfoCrash(c, dt, now) {
    const ufo = Scene.ufo();
    const anim = c.ufoCrashAnim;
    if (!ufo || !anim) {
      c.ufoCrashAnim = null;
      startDying(c);
      return;
    }
    const minX = 30, maxX = (Scene.WIDTH || 720) - 30;
    const minY = (Scene.FLOOR_TOP || 40) + 10;
    const maxY = (Scene.FLOOR_BOTTOM || (Scene.FLOOR_TOP + 100)) - 10;

    if (anim.phase === "descend") {
      const u = Math.min(1, (now - anim.t0) / UFO_CRASH_DESCEND_MS);
      const e = u * u * (3 - 2 * u);
      ufo.ufoBoardLift = (anim.liftStart || 0) * (1 - e);
      ufo.flyDx = (anim.flyDx0 || 0) * (1 - e);
      ufo.flyDy = (anim.flyDy0 || 0) * (1 - e);
      c.x = ufo.x + ufo.flyDx;
      c.y = ufo.y + ufo.flyDy;
      if (u >= 1) {
        const newX = ufo.x + (ufo.flyDx || 0);
        const newY = ufo.y + (ufo.flyDy || 0);
        ufo.x = Math.max(minX, Math.min(maxX, newX));
        ufo.y = Math.max(minY, Math.min(maxY, newY));
        ufo.flyDx = 0;
        ufo.flyDy = 0;
        ufo.flyTargetDx = 0;
        ufo.flyTargetDy = 0;
        ufo.ufoBoardLift = 0;
        ufo.piloted = false;
        ufo.nextCourseAt = 0;
        c.sortieStartAt = null;
        c.sortieEndAt = null;
        c.boarded = false;
        const fallFromY = ufo.y - 34;
        c.x = ufo.x;
        c.y = fallFromY;
        anim.phase = "fall";
        anim.t0 = now;
        anim.fallFromY = fallFromY;
        anim.groundY = ufo.y;
        if (Combat && Combat.puff) {
          Combat.puff(c.x, c.y - 8, "rgba(180,255,220,0.65)");
        }
      }
      return;
    }
    if (anim.phase === "fall") {
      const u = Math.min(1, (now - anim.t0) / UFO_CRASH_FALL_MS);
      const e = u * u;
      c.y = anim.fallFromY + (anim.groundY - anim.fallFromY) * e;
      c.x = ufo.x;
      if (u >= 1) {
        c.ufoCrashAnim = null;
        c.x = ufo.x;
        c.y = ufo.y;
        c.sortieStartAt = null;
        c.ufoCooldownUntil = now + rr(...UFO_COOLDOWN_MS);
        startDying(c);
      }
    }
  }

  function tickUfoing(c, dt, now) {
    const ufo = Scene.ufo();
    if (c.ufoCrashAnim) {
      tickUfoCrash(c, dt, now);
      return;
    }

    // ---- phase 1: walk to the saucer on foot -----------------------
    if (!c.boarded) {
      // Re-check the corridor every ~250 ms: if the alien is wounded
      // AND a monster has stepped onto the line between him and the
      // saucer, abort the casual jog to the pad (where the only damage
      // response is a 1.1 s snipe cycle) and bail out into the regular
      // combat ladder.  maybeEnterCombat will then route him through
      // panic-flee / retreat depending on his current HP, both of
      // which react faster than the unconditional pad walk.
      if (c.hp < c.maxHp * LOW_HP_FRACTION) {
        if (now - (c._ufoWalkSafetyAt || 0) > 250) {
          c._ufoWalkSafetyAt = now;
          if (!safePathTo(c, ufo.x, ufo.y)) {
            exitCombat(c);
            // exitCombat resets to wandering; the next maybeEnterCombat
            // tick (within 180 ms) will pick the right reaction.
            return;
          }
        }
      }
      const arrived = moveStep(c, dt, 1.2);
      if (!arrived) return;
      // Board: lift the saucer, show the pilot, lock in the sortie
      // duration, and clear any drift from a previous flight.  The
      // sortie cap (sortieEndAt) is an absolute ceiling on air time
      // — monsters or no monsters, the alien comes out when it hits.
      c.combatUntil = now + 6000 + Math.random() * 2000;
      c.sortieEndAt = now + rr(...UFO_SORTIE_MAX_MS);
      c.sortieStartAt = now;
      c.lastAttackAt = 0;
      c.boarded = true;
      ufo.ufoBoardLift = 18;
      ufo.piloted = true;
      ufo.flyDx = 0;
      ufo.flyDy = 0;
      ufo.flyTargetDx = 0;
      ufo.flyTargetDy = -24;
      ufo.nextCourseAt = now + 900;
      Combat.puff(c.x, c.y - 18, "rgba(180,255,255,0.7)");
      // Keep c.x / c.y in sync with the saucer so the beam + AI use
      // the right position from here on.
      c.x = ufo.x; c.y = ufo.y;
      Dialog.bark(c, "boardUfo");
      return;
    }

    // ---- phase 2: end of sortie, land and eject ---------------------
    // Landing logic — never abandon the saucer with a monster right
    // under it, and never bail out mid-revive.  Three legitimate ways
    // down:
    //   * soft patrol timer expired AND the lawn is quiet (no
    //     monsters anywhere, no bodies to revive) — a relaxed
    //     touchdown after the fight is already over;
    //   * battery is too low to fire AND there's no monster within
    //     UFO_DEPLETED_LAND_DIST — set down on a clear patch and
    //     recharge on the pad;
    //   * absolute failsafe: been airborne for UFO_PATROL_FAILSAFE_MS
    //     AND no monster is right under the saucer (so a perfectly
    //     paced pilot can't camp the sky forever, but the timer
    //     waits for a safe moment instead of dumping him on top of
    //     a slime).
    //
    // All three are additionally gated on `!corpseNearby && !reviveActive`:
    // a fallen ally is the most important job the saucer has, and the
    // revive channel doesn't burn laser energy anyway, so neither
    // softCap, an empty battery, nor the failsafe is a good reason to
    // abort the tractor beam mid-pull.  Without this guard the alien
    // would eject from the saucer right as he was hauling somebody
    // back to life — the channel would silently break and the body
    // would just stay on the ground.
    // Boss-time corpse priority: ranged buddies who fell OUTSIDE the
    // hydra's spit envelope get revived first, so they stand up and
    // immediately resume contributing from range.  Melee corpses
    // standing inside head-bite range are skipped — reviving them
    // just feeds the heads.  Outside the boss fight (or if the
    // boss-aware picker has nothing to offer) we fall back to plain
    // nearest-dead-ally.
    const bossPick = (c.name === "alien")
      ? bestBossCorpseForUfo(c)
      : null;
    const corpseNearby = bossPick || nearestDeadAlly(c);
    const reviveActive = !!c.ufoReviveTarget && now < c.ufoReviveUntil;
    const hasBusiness = Monsters.count() > 0 || !!corpseNearby;
    const softCap = now >= c.combatUntil;
    const energyOut = c.ufoEnergy < UFO_ENERGY_PER_SHOT;
    // Wounded pilots need a much wider safety bubble before touching
    // down — a 110 px clearance is fine when there's HP to spare for
    // trading hits, but at low HP the post-landing UFO_COOLDOWN_MS
    // lockout is effectively a death sentence if a slime is 130 px
    // away when the saucer settles.  Doubling the radius (and never
    // dropping below 220 px) gives him room to either get healed or
    // retreat before the cooldown elapses.
    const lowHp = c.hp < c.maxHp * LOW_HP_FRACTION;
    const landSafetyR = lowHp
      ? Math.max(UFO_DEPLETED_LAND_DIST * 2, 220)
      : UFO_DEPLETED_LAND_DIST;
    const safeBelow = !Monsters.anyThreat(c.x, c.y, landSafetyR);
    if (c.sortieStartAt == null) c.sortieStartAt = now;
    const failsafe = (now - c.sortieStartAt) >= UFO_PATROL_FAILSAFE_MS;
    // The "soft cap met, lawn is quiet" branch normally lands without
    // a clearance check (no monsters anywhere), but at low HP we add
    // safeBelow anyway as a paranoid extra guard against a stray
    // worm / skeleton spawning right under him on the same tick.
    // Boss override.  During an active hydra fight the saucer is
    // a CUTTER from the air with no exposure to bites, the spit
    // doesn't reach his altitude, and the ground cooldown
    // (UFO_COOLDOWN_MS = 6-10 s) followed by a walk back to the
    // pad costs the team his entire DPS contribution.  At
    // UFO_ENERGY_AIR_REGEN_PER_S = 9 he refills one shot every
    // ~3.1 s while airborne — slower than the ground regen, but
    // a full beam every 3 s is far better than nothing for the
    // duration of the fight.
    //
    // What we KEEP enabled during the boss:
    //   • corpse-revive precedence (already gates wantLand);
    //   • hard failsafe (PATROL_FAILSAFE_MS) — a stuck patrol
    //     that's been up for 28 s still gets to land if it can do
    //     so safely, so a soft-locked sortie can't last forever.
    // What we SKIP during the boss:
    //   • softCap "lawn is quiet" — the lawn is never quiet here;
    //   • energyOut landing — recharge IN THE AIR instead.
    const bossActive = HydraPlan && HydraPlan.active && HydraPlan.active();
    const wantLand =
      !corpseNearby && !reviveActive && (
        (!bossActive && softCap && !hasBusiness && (!lowHp || safeBelow)) ||
        (!bossActive && energyOut && safeBelow) ||
        (failsafe && safeBelow)
      );
    if (wantLand) {
      // Touch down RIGHT WHERE THE SAUCER CURRENTLY IS, not back at
      // the original landing pad — snapping the UFO 100 px sideways
      // in a single frame the moment the alien ejects looked like a
      // teleport.  We bake the current flight offset into the
      // activity's own (x, y) so the saucer's pixel position doesn't
      // change at all on landing; on the next sortie the alien just
      // walks to this new parking spot and lifts off from here.
      // Clamp the new pad to the lawn so consecutive landings can't
      // drift the saucer off-screen, into the pond, or up into the
      // sky.
      const newX = ufo.x + (ufo.flyDx || 0);
      const newY = ufo.y + (ufo.flyDy || 0);
      const minX = 30, maxX = Scene.WIDTH - 30;
      const minY = Scene.FLOOR_TOP + 10, maxY = Scene.FLOOR_BOTTOM - 10;
      ufo.x = Math.max(minX, Math.min(maxX, newX));
      ufo.y = Math.max(minY, Math.min(maxY, newY));
      ufo.flyDx = 0;
      ufo.flyDy = 0;
      ufo.flyTargetDx = 0;
      ufo.flyTargetDy = 0;
      ufo.ufoBoardLift = 0;
      ufo.piloted = false;
      c.boarded = false;
      c.x = ufo.x; c.y = ufo.y;
      Combat.puff(c.x, c.y - 18, "rgba(180,255,255,0.7)");
      // Ground cooldown — the alien has to walk around for a bit
      // before he's allowed back in the saucer.
      c.ufoCooldownUntil = now + rr(...UFO_COOLDOWN_MS);
      c.ufoReviveTarget = null;
      c.ufoReviveUntil = 0;
      c.sortieStartAt = null;
      exitCombat(c);
      Dialog.bark(c, "landUfo");
      return;
    }
    if (softCap) {
      const extend = 3000 + Math.random() * 2000;
      c.combatUntil = Math.min(c.sortieEndAt, now + extend);
    }

    // Battery regen while airborne — slow on purpose so the saucer
    // can't hold a stationary monster down with continuous fire.
    c.ufoEnergy = Math.min(
      UFO_ENERGY_MAX,
      (c.ufoEnergy || 0) + UFO_ENERGY_AIR_REGEN_PER_S * dt / 1000,
    );

    // ---- phase 3: actual flight patrol ------------------------------
    // Pick what the saucer is focused on this frame.  Corpse revive
    // wins over shooting monsters: you can kill the next monster any
    // time, but a buddy who just hit 0 HP really wants beamed back up
    // NOW.  We still fly on and shoot if there are no bodies left.
    const focus = corpseNearby || null;
    const isReviveFocus = !!corpseNearby;

    // If the body we were tractor-beaming vanished (someone else
    // resurrected them, they despawned) reset the channel.
    if (c.ufoReviveTarget && c.ufoReviveTarget !== corpseNearby) {
      c.ufoReviveTarget = null;
      c.ufoReviveUntil = 0;
    }

    // Steer toward (flyTargetDx, flyTargetDy) offsets — i.e. an offset
    // relative to the UFO's landing pad.
    const steerSpeed = 70; // px/s toward target offset
    const tdx = ufo.flyTargetDx - ufo.flyDx;
    const tdy = ufo.flyTargetDy - ufo.flyDy;
    const dlen = Math.hypot(tdx, tdy) || 1;
    const move = Math.min(dlen, steerSpeed * dt / 1000);
    ufo.flyDx += (tdx / dlen) * move;
    ufo.flyDy += (tdy / dlen) * move;

    if (now >= ufo.nextCourseAt || dlen < 4) {
      // Sync c.x/c.y first so nearestMonster uses the saucer position.
      c.x = ufo.x + ufo.flyDx;
      c.y = ufo.y + ufo.flyDy;
      let hoverOn = focus;
      // For combat patrol we hover high (target offset = -40 → the
      // saucer floats 40 px above whatever it's strafing).  For a
      // revive we want to be DOWN on top of the corpse, so the cone
      // is short and reads as "I'm picking him up", not as a
      // searchlight — aim ~28 px above the body.
      let hoverDyOffset = -40;
      if (isReviveFocus) {
        hoverDyOffset = -28;
      } else {
        const [m, ] = bestMonsterFor(c, 260);
        hoverOn = m;
      }

      // Boss recharge park: when the hydra is up AND the battery is
      // too low to fire AND we're not in the middle of a revive
      // pull, fly OUT of the spit envelope and just hover until the
      // air-regen tops us back up to a usable shot.  This is the
      // "stay in the saucer and wait" strategy — way better than
      // dropping the alien on the pad for a 6-10 s ground cooldown
      // followed by a walk back to the saucer (= zero contribution
      // for the duration).  Park spot is the corner of the lawn
      // farthest from the body, kept inside the canvas so the
      // saucer doesn't drift off-screen.
      if (bossActive && energyOut && !isReviveFocus) {
        const body = HydraPlan.body();
        if (body) {
          const W = Scene.WIDTH || 720;
          const top = (Scene.FLOOR_TOP || 40);
          const bot = (Scene.FLOOR_BOTTOM || (top + 100));
          // Pick the lawn corner farthest from the body.  Body is in
          // the upper-left lair, so this almost always resolves to
          // the bottom-right; the explicit max() keeps the logic
          // robust if the body ever wanders or the lair moves.
          const cornersX = [40, W - 40];
          const cornersY = [top + 30, bot - 30];
          let bestX = cornersX[1], bestY = cornersY[1], bestD = -1;
          for (const cx of cornersX) {
            for (const cy of cornersY) {
              const d = Math.hypot(cx - body.x, cy - body.y);
              if (d > bestD) { bestD = d; bestX = cx; bestY = cy; }
            }
          }
          // Park altitude tucked just under the upper clamp so the
          // saucer reads as "hovering high, waiting" rather than
          // diving down toward the lawn.
          const parkDx = bestX - ufo.x;
          const parkDy = bestY - ufo.y;
          ufo.flyTargetDx = Math.max(-200, Math.min(200, parkDx));
          ufo.flyTargetDy = Math.max(-80,  Math.min(-20, parkDy));
          ufo.nextCourseAt = now + 1400 + Math.random() * 600;
          // Skip the regular hoverOn / random patrol below: we're
          // committing to the park slot until the battery recovers.
          hoverOn = null;
          // Sentinel so the if-tree below doesn't overwrite the park
          // target with a random patrol point.
          ufo._parking = true;
        }
      } else {
        ufo._parking = false;
      }

      if (!ufo._parking) {
        if (hoverOn) {
          // Hydra perimeter snipe: when shooting a hydra part, don't
          // hover directly OVER the boss — that's the user-reported
          // "UFO is circling right next to the hydra again, why doesn't it
          // go around".  Beam range is only UFO_BEAM_MAX_RANGE (~88 px)
          // so we can't snipe from the corner, but we can sit on the
          // lawn-SIDE of the targeted part, away from the body /
          // lair, at near-max beam range.  Reads as "strafing from
          // outside the boss area" instead of "crowding the bite
          // ring".  Skipped for revive (tractor beam wants to be on
          // top of the corpse) and non-hydra targets (their sweep is
          // fine as-is).
          const isHydraTgt = !isReviveFocus && bossActive &&
            (hoverOn.kind === "hydraBody" || hoverOn.kind === "hydraHead");
          if (isHydraTgt) {
            const body = (HydraPlan.body && HydraPlan.body()) || hoverOn;
            // Outward direction from body through the targeted part —
            // approach FROM that side.  Body itself coincides with
            // body, so default outward = down-right (lawn quadrant).
            let ox = hoverOn.x - body.x;
            let oy = hoverOn.y - body.y;
            let ol = Math.hypot(ox, oy);
            if (ol < 6) { ox = 1; oy = 0.7; ol = Math.hypot(ox, oy); }
            ox /= ol; oy /= ol;
            // Sit just inside beam range so the laser still lands.
            const PERIM = Math.min(UFO_BEAM_MAX_RANGE - 14, 70);
            const desiredX = hoverOn.x + ox * PERIM;
            // Stay airborne (above the part) so visually we read as
            // hovering, not buzz-strafing the head.
            const desiredY = hoverOn.y + oy * PERIM - 10;
            const rawDx = desiredX - ufo.x;
            const rawDy = desiredY - ufo.y;
            ufo.flyTargetDx = Math.max(-200, Math.min(200, rawDx));
            ufo.flyTargetDy = Math.max(-80,  Math.min(-12, rawDy));
          } else {
            const rawDx = (hoverOn.x - ufo.x);
            const rawDy = (hoverOn.y - ufo.y) + hoverDyOffset;
            ufo.flyTargetDx = Math.max(-160, Math.min(160, rawDx));
            // Vertical clamp depends on what we're doing: combat sweeps
            // stay high (-60..-8 → always at least 8 px above the saucer
            // pad, never dipping below it), but a revive needs the
            // saucer to descend well below its landing pad to reach a
            // corpse on the lower lawn — relax the upper bound to +200
            // so the saucer can actually drop down on top of the body.
            const dyMax = isReviveFocus ? 200 : -8;
            ufo.flyTargetDy = Math.max(-60, Math.min(dyMax, rawDy));
          }
        } else {
          ufo.flyTargetDx = rr(-140, 140);
          ufo.flyTargetDy = rr(-45, -10);
        }
        // Revive pass needs a tighter orbit so we don't slew off-station
        // mid-channel — re-plan more often when there's a body below us.
        ufo.nextCourseAt = now +
          (isReviveFocus ? 700 + Math.random() * 500
                         : 1600 + Math.random() * 1200);
      }
    }

    // Sync the alien's bookkeeping position to the saucer so all the
    // other systems (hit detection, HP bar placement, etc.) agree on
    // where "the alien" is right now.
    c.x = ufo.x + ufo.flyDx;
    c.y = ufo.y + ufo.flyDy;

    // ---- action: revive channel OR laser pulse ---------------------
    if (isReviveFocus && corpseNearby) {
      // On station?  Channel the beam.  "On station" = roughly over
      // the body and above it (never beam a corpse from the side).
      const dxh = corpseNearby.x - c.x;
      const dyh = corpseNearby.y - c.y;
      // "On station" = the corpse is directly below us (small dx) AND
      // we've descended to the right altitude band (16..52 px above
      // the body — not so high the cone stretches halfway up the
      // lawn, not so low the saucer is sitting on the tombstone).
      const onStation =
        Math.abs(dxh) < UFO_REVIVE_HOVER_DX &&
        dyh > UFO_REVIVE_HOVER_DY_MIN &&
        dyh < UFO_REVIVE_HOVER_DY_MAX;
      if (onStation) {
        if (c.ufoReviveTarget !== corpseNearby) {
          c.ufoReviveTarget = corpseNearby;
          c.ufoReviveUntil = now + UFO_REVIVE_MS;
        }
        // Pulse a ray overlapping the next one so the rings keep
        // sliding down the column continuously.
        const baseCd = effectiveCd(c);
        const pulseCd = baseCd * 0.5;
        if (now - c.lastAttackAt > pulseCd) {
          const uc = Scene.ufoCenter();
          Combat.ufoRay(uc.x, uc.y,
                        corpseNearby.x, corpseNearby.y - 2,
                        baseCd * 0.95);
          c.lastAttackAt = now;
        }
        if (now >= c.ufoReviveUntil) {
          resurrect(corpseNearby, now, c);
          c.ufoReviveTarget = null;
          c.ufoReviveUntil = 0;
        }
      } else {
        // Still closing on the corpse — restart the channel once we
        // actually arrive so the ray isn't pre-charged in transit.
        c.ufoReviveUntil = 0;
      }
    } else if (now - c.lastAttackAt > effectiveCd(c)
               && c.ufoEnergy >= UFO_ENERGY_PER_SHOT) {
      const [m, ] = bestMonsterFor(c, UFO_BEAM_MAX_RANGE);
      if (m) {
        const uc = Scene.ufoCenter();
        Combat.ufoBeam(uc.x, uc.y, m);
        c.lastAttackAt = now;
        c.ufoEnergy -= UFO_ENERGY_PER_SHOT;
      }
    }

    // Surface the live charge to the saucer so drawUfo can render
    // the battery indicator on the hull.
    ufo.ufoEnergy = c.ufoEnergy;
    ufo.ufoEnergyMax = UFO_ENERGY_MAX;
  }

  // Witch brewing at her cauldron.  Progress only accumulates when
  // she's actually standing at her station (within a small radius),
  // so the timer tracks "time at work" rather than wall-clock time.
  // When the brew finishes she picks up a `deliver` potion token and
  // maybeEnterCombat will route her toward the chest to stock it.
  function tickWitchBrew(c, dt) {
    if (c.brewReady) return;
    // Brew normally only progresses while she's idle at her station
    // (working / wandering).  Boss exception: during an active hydra
    // fight we KEEP the brew ticking even while she's `fighting`, so
    // long as she's actually standing at the cauldron.  This is what
    // makes "arc back to the cauldron between hexes to finish a heal/
    // revive bottle" a real strategy instead of a stalled timer that
    // resets every time she takes a swing.
    const inBoss = HydraPlan && HydraPlan.active && HydraPlan.active();
    const okState = c.state === "working" || c.state === "wandering"
                 || (inBoss && c.combatMode === "fighting");
    if (!okState) return;
    const a = c.activity;
    if (!a) return;
    const atHome = Math.hypot(c.x - a.x, c.y - a.y) < 24;
    if (!atHome) return;
    // Emergency stoking: when allies are wounded and the chest has
    // no heal bottles to grab, the cauldron bubbles ~1.6× faster so
    // help actually arrives in time for the brawl that's already
    // happening, instead of after it's too late.
    //
    // Boss stoking: a live hydra is "wounded allies imminent" by
    // definition.  Same multiplier so a witch arc'ing to the cauldron
    // mid-fight actually finishes a bottle inside the engagement
    // window instead of one cycle too late.
    //
    // Supply stoking: when the kiosk is thin on heals or missing a
    // revive (with shelf room), bubble faster so her primary job
    // keeps pace even between emergencies.
    const healN = Scene.chestStockOf("heal");
    const reviveN = Scene.chestStockOf("revive");
    const needHealNow = anyHurtAlly() && healN <= 0;
    const needStock =
      healN < 2 ||
      (reviveN < 1 && Scene.chestHasRoom());
    let speed = 1.0;
    if (needHealNow || inBoss) speed = 1.6;
    else if (needStock) speed = 1.38;
    c.brewAccum = (c.brewAccum || 0) + dt * speed;
    if (c.brewAccum >= BREW_MS) {
      c.brewAccum = 0;
      c.brewReady = true;
      // Decide what came out of the cauldron this time.  Default is
      // a heal potion; with REVIVE_BREW_PROB chance it's a revive
      // instead — but only if the chest doesn't already have one
      // waiting, so the witch isn't burning brews making spares
      // nobody's used yet.  (The shelf only fits POTION_CAP bottles
      // total, and revives shouldn't crowd out the heals.)
      //
      // Override: if any ally is wounded right now and the chest
      // has no heal to drink, the next bottle is a heal no matter
      // what — the revive lottery shouldn't beat people bleeding
      // out in front of her.
      let kind = "heal";
      const haveRevive = reviveN > 0;
      // Hard override: an ally is on the ground RIGHT NOW and the
      // chest can't even spawn a revive errand — make this bottle a
      // revive, regardless of the heal-pressure or RNG branches
      // below.  Without this, revives stay stuck behind a 35% roll
      // gated by "no wounded allies" and effectively never appear.
      const corpseWaiting = (typeof countCorpses === "function" && countCorpses() > 0);
      if (!haveRevive && corpseWaiting) {
        kind = "revive";
      } else if (!needHealNow && !haveRevive) {
        const reviveRoll =
          healN >= 1 ? REVIVE_BREW_PROB_WHEN_HEAL_OK : REVIVE_BREW_PROB;
        if (Math.random() < reviveRoll) kind = "revive";
      }
      c.brewKind = kind;
      c.heldPotion = { kind: "deliver", potionKind: kind };
      c.brewedAt = performance.now();
    }
  }

  // ----- combat: deciding when to enter a combat mode ------------------

  function maybeEnterCombat(c, now) {
    if (c.combatMode !== "none") return false;
    if (c.state === "offstage") return false;
    // Leaving for the day: fighters get a clean exit (a knight who
    // clocked out shouldn't get yanked back into the meat grinder
    // by every passing slime), but healers and revive-capable
    // casters keep their eyes open on the way out.  The reported
    // "girl jogged past the half-HP witch at the cauldron and
    // left" was exactly this gate firing too aggressively: the
    // moment LEAVE_AFTER_WORK_P flipped her into "leaving",
    // maybeEnterCombat went silent and the heal target / corpse /
    // panic-defence branches below never got to run.  Letting the
    // healer / reviver fall through means a wounded buddy on the
    // exit corridor gets topped up, a fresh corpse on the lawn
    // gets a revive, and a slime that intercepts her on the walk
    // out triggers a real defensive response instead of a silent
    // walk into the bite.  Once the intervention finishes,
    // exitCombat resets state to "wandering" and the normal
    // wander → work → leave cycle re-fires naturally.
    if (c.state === "leaving" && !HydraPlan.active()
        && c.role !== "healer" && !canRevive(c)) {
      return false;
    }

    // Already down?  Leave the corpse alone — tickDead handles it.
    if (c.hp <= 0) { startDying(c); return true; }

    // When the lawn is a graveyard the reviver should drop almost
    // anything else to triage.  We narrow the "wait until it's safe"
    // threat radius based on how many bodies are on the ground (and
    // skip the talking-state veto entirely once corpses pile up) so
    // the witch / firemage / girl don't stand around chatting while
    // their friends bleed out.
    const corpses = countCorpses();
    const reviveThreatR =
      corpses >= 3 ? 18 : corpses >= 2 ? 36 : 60;
    // Talking veto: chatting heroes normally don't drop the convo to
    // fight, but a corpse on the ground OR an open help call from a
    // friend in trouble both override it — gossip can wait.
    const corpseSkipsTalk = corpses > 0;
    const helpSkipsTalk = !!nearestHelpCall(c, now);
    if (c.state === "talking" && !corpseSkipsTalk && !helpSkipsTalk
        && !HydraPlan.active()) return false;

    // Mounted-girl revive: she summoned the horse for a far-away
    // corpse.  canRevive() returns false while she's mounted (the
    // channel is dismounted), so the regular reviver-dibs branch
    // below would skip her.  Instead, gallop straight to the body
    // and dismount on arrival; the next maybeEnterCombat pass after
    // dismount will start the actual revive channel.
    if (c.mounted && c.name === "girl" &&
        !Monsters.anyThreat(c.x, c.y, reviveThreatR)) {
      // While mounted she can ARC around the boss — `tickRideToCorpse`
      // routes via a tangent waypoint when the straight gallop crosses
      // the bite ring.  Use the horse-aware picker so she doesn't
      // sit on the saddle wandering when a corpse is on the far side
      // of the body.
      const corpse = nearestDeadAlly(c) || nearestDeadAllyForHorse(c);
      if (corpse) {
        if (c.state === "talking") endTalking(c);
        startRideToCorpse(c, corpse);
        return true;
      }
    }

    // Reviver dibs: if this hero can cast the revive spell and there's
    // a fallen ally on the lawn, go handle it before anything else —
    // unless there's an immediate monster breathing down the reviver's
    // neck, in which case combat with that monster takes priority.
    const hydraReviveOpen = HydraPlan.active() && HydraPlan.pushWindow();
    if (canRevive(c) && (!Monsters.anyThreat(c.x, c.y, reviveThreatR) || hydraReviveOpen)) {
      const corpse = nearestDeadAlly(c);
      // Horse-summon picker: when the on-foot picker rejected every
      // corpse because the walk-to-standoff line crosses head-bite
      // reach, the gallop can still rescue the body (it arcs around
      // the boss instead).  `nearestDeadAllyForHorse` only drops
      // corpses that have NO safe standoff at all.  Falls back to
      // the foot pick when she's already close.
      const horseCorpse = corpse || nearestDeadAllyForHorse(c);
      if (horseCorpse) {
        // Try horse first (regardless of foot reachability).  If it
        // fires, the path question goes away — she gallops over the
        // threats.  HORSE_REVIVE_MIN_DIST gates this on real distance
        // so a 100 px walk doesn't burn the 80 s cooldown.
        if (maybeSummonHorse(c, now, "revive", horseCorpse)) {
          if (c.state === "talking") endTalking(c);
          return true;
        }
      }
      if (corpse) {
        // No horse this turn.  Only commit to the foot revive if the
        // corpse is actually reachable safely.  The previous code
        // skipped this check, so the girl would commit to a revive
        // even when the only route to the body went straight through
        // a slime — she'd march forward, tickReviving's per-tick
        // safety check would catch it on arrival, she'd bolt
        // fleeing, the heal she abandoned was wasted, and the corpse
        // stayed unrevived anyway.  Fighters (witch / firemage) keep
        // the old aggressive behaviour: they can brawl through
        // anything in the way and defend themselves mid-channel.
        const range = reviveRangeOf(c);
        const reachable =
          !nonFighter(c) || safeCastFrom(c, corpse.x, corpse.y, range, "revive");
        if (reachable) {
          if (c.state === "talking") endTalking(c);
          startReviving(c, corpse);
          return true;
        }
        // Else fall through — keep healing live allies we CAN reach,
        // and re-evaluate next tick (the slime might have moved off
        // the corridor by then).
      }
    }

    // Spare-bottle revive: this hero is already carrying a revive
    // they grabbed at the chest on a previous heal run (see
    // tickDrinking's "open" phase) — skip the chest entirely and use
    // it on the body in front of them.  Same threat-radius gate as
    // the chest-bound branch below so the carrier doesn't walk the
    // bottle through a melee.  Sits ABOVE the chest branch so a
    // carried spare always wins over a fresh chest fetch.
    if (!canRevive(c) && c.spareRevive
        && (!Monsters.anyThreat(c.x, c.y, reviveThreatR) || hydraReviveOpen)) {
      const corpse = nearestDeadAlly(c);
      if (corpse) {
        if (c.state === "talking") endTalking(c);
        startSpareRevive(c, corpse);
        return true;
      }
    }

    // Potion-revive errand: ANY hero (fighter, healer, etc. — even
    // the alien if he's grounded) can run a revive bottle from the
    // chest to a fallen ally if one is brewed and waiting.  We gate
    // this on the same "no immediate threat" rule as the casters
    // above (with the same corpse-count scaling), since carrying the
    // bottle through a melee gets the runner killed and the corpse
    // stays dead.  We also skip it for characters who already
    // qualified for the channel revive — they don't need to burn a
    // bottle to do what they can cast for free.
    if (!canRevive(c) && (!Monsters.anyThreat(c.x, c.y, reviveThreatR) || hydraReviveOpen)
        && Scene.chestStockOf("revive") > 0) {
      const corpse = nearestDeadAlly(c);
      if (corpse) {
        if (c.state === "talking") endTalking(c);
        startPotionRevive(c, corpse);
        return true;
      }
    }

    // Ground-revive errand: if the chest is dry but a revive bottle
    // is lying on the lawn (the witch was killed mid-deposit and
    // dropped it on the way), any non-reviver in pickup range can
    // grab THAT and finish the run instead of waiting for a fresh
    // brew.  Same threat-radius gate as the chest path so the runner
    // doesn't bottle-courier through a melee.
    if (!canRevive(c) && (!Monsters.anyThreat(c.x, c.y, reviveThreatR) || hydraReviveOpen)) {
      const corpse = nearestDeadAlly(c);
      if (corpse) {
        const ground = findNearbyGroundRevive(c);
        if (ground) {
          if (c.state === "talking") endTalking(c);
          startPotionReviveFromGround(c, corpse, ground);
          return true;
        }
      }
    }

    // "Help!" answer: if a friend is yelling for backup (HELP_RADIUS,
    // HELP_LIFETIME_MS) and `c` is an idle fighter in shape to brawl,
    // drop wandering / chatting / the witch's brewing routine and
    // jump on whatever's mauling them.  Inside `tryAnswerHelp`:
    // ranged answer freely, melee only if HP >= HELP_ANSWER_HP_FRACTION
    // (otherwise they'd just become the next corpse), the girl /
    // alien skip the branch (they don't have an attack to bring or
    // are handled elsewhere), and we set the responder's combat
    // target to the caller's attacker so everyone gangs up on the
    // same monster instead of scattering.
    if (tryAnswerHelp(c, now)) return true;

    // No corpses or callers to handle — fall through.  Talking is
    // a peacetime state, so anything below this point is combat-only
    // and shouldn't interrupt a chat.
    if (c.state === "talking") return false;

    // "My friend is in trouble" lookup used by every branch below.
    // If a comrade is brawling within earshot we either pile in (for
    // fighters / alien) or pivot toward support (healer).  We pick
    // the ally's own combat target first so we gang up on one monster
    // instead of scattering; if their target is gone we fall back to
    // whatever monster is closest to the ally.
    //
    // Pact override: if `c` swore an ambush pact and the partner is
    // currently mid-fight, we promote the partner above any closer
    // brawl so the two pact-mates lock onto the same threat — the
    // visible payoff of having shaken on it back at the last chat.
    let buddy = null;
    const pactBuddy = c.pact && c.pact.until > now ? c.pact.partner : null;
    if (pactBuddy && pactBuddy.combatMode === "fighting"
        && pactBuddy.combatTarget && !pactBuddy.combatTarget.dying
        && isVisibleNow(pactBuddy)
        && Math.hypot(pactBuddy.x - c.x, pactBuddy.y - c.y) <= BUDDY_RANGE * 1.4) {
      buddy = pactBuddy;
    } else {
      buddy = nearestFightingAlly(c, BUDDY_RANGE);
    }
    let buddyTarget = null;
    if (buddy) {
      buddyTarget = buddy.combatTarget;
      if (!buddyTarget || buddyTarget.dying) {
        const [nm] = nearestMonster(buddy, AGGRO_RANGE * 1.5);
        buddyTarget = nm;
      }
    }

    // Alien: strong preference for the UFO, but only when the sortie
    // cooldown has elapsed.  Between flights he stays on the ground
    // and fights on foot with his laser so the tarelka isn't his
    // permanent office.
    if (c.role === "alien") {
      // The alien also scrambles the saucer for revives — if a buddy
      // is down somewhere on the lawn, that's a reason to lift off
      // even with no monsters in sight.  (`canRevive` excludes him
      // because he doesn't walk up and channel — he beams from above
      // via the UFO revive handled inside tickUfoing.)
      const wantSky =
        Monsters.anyThreat(c.x, c.y, 220) ||
        !!buddyTarget ||
        Monsters.count() >= 1 ||
        !!nearestDeadAlly(c);
      const canBoard = !c.ufoCooldownUntil || now >= c.ufoCooldownUntil;
      // ---- HP-aware ladder (mirrors the generic one below) ---------
      // The original alien branch went straight to startFighting the
      // moment a monster strayed inside AGGRO_RANGE — even at 5 HP
      // with the saucer right there but on cooldown.  That produced
      // the "alien climbed out of the UFO straight at the slime, took
      // three bites, never fired a shot" sequence.  Two-tier fallback:
      //
      //   * Critical (< PANIC_HP_FRACTION) — life beats UFO discipline.
      //     Drop the cooldown and panic-board.  If the saucer is
      //     unreachable (monsters across the path) startFleeing; the
      //     refuge picker will route to the UFO when it can or to the
      //     screen edge otherwise.
      //   * Wounded (< LOW_HP_FRACTION) — board if available, else
      //     retreat instead of brawling.  Retreating still allows
      //     opportunistic snipe (snipeAllowed returns true), so the
      //     laser keeps firing while he backs off toward a healer or
      //     the chest, and he's never just standing there eating hits.
      if (c.hp < c.maxHp * PANIC_HP_FRACTION) {
        const ufo = Scene.ufo();
        if (ufo && safePathTo(c, ufo.x, ufo.y)) {
          // Override the cooldown — at this HP a fresh sortie is the
          // only safe move, even if it cuts the recharge short.
          c.ufoCooldownUntil = 0;
          startUfoing(c);
          return true;
        }
        // Saucer is across a melee — bolt for the edge instead.  The
        // refuge picker inside startFleeing will still try the UFO if
        // the path opens up before he reaches the edge.
        startFleeing(c);
        return true;
      }
      if (c.hp < c.maxHp * LOW_HP_FRACTION) {
        const ufo = Scene.ufo();
        // Only commit to the saucer walk if the corridor is clear —
        // wounded and walking THROUGH a slime to reach the pad is the
        // exact bug we're trying to stop.
        if (canBoard && ufo && safePathTo(c, ufo.x, ufo.y)) {
          startUfoing(c);
          return true;
        }
        // Cooldown still locking him out, OR the saucer's behind a
        // monster: don't go toe-to-toe with the laser, slide away
        // from the nearest monster while sniping on cooldown until
        // either the saucer's free or the corridor opens up.
        const [mLow, ] = nearestMonster(c, AGGRO_RANGE * 1.5);
        if (mLow) { startRetreating(c); return true; }
      }
      if (wantSky && canBoard) { startUfoing(c); return true; }
      // Grounded (or on cooldown) — fight on foot if a monster is
      // close, otherwise fall through to regular wandering.
      const [m, ] = bestMonsterFor(c, AGGRO_RANGE);
      if (m) { startFighting(c, m); return true; }
      return false;
    }

    // Hurt?  Three steps on the ladder:
    //   1. Chest has stock -> go drink a potion.
    //   2. HP critical     -> full panic, bolt offstage.
    //   3. Otherwise       -> tactical retreat: back away from the
    //                         nearest monster and angle toward the
    //                         girl (or the chest) in hopes of help.
    if (c.hp < c.maxHp * LOW_HP_FRACTION) {
      // Witch already holding a fresh heal brew?  Drink her own
      // bottle on the spot rather than walking past it to the
      // chest — the kiosk can wait, the wound can't.
      if (shouldSelfDrinkHeld(c)) { startSelfDrink(c); return true; }
      // Free heal bottle dropped on the lawn (typically because a
      // carrier got killed mid-deposit)?  Grab THAT before walking
      // all the way to the chest or kicking the cauldron back to
      // life.  Robot is excluded for the same reason as the chest
      // branch: heal glop does nothing for a hunk of metal.
      if (c.name !== "robot") {
        const ground = findNearbyGroundHeal(c);
        if (ground) {
          if (c.state === "talking") endTalking(c);
          startPickupPotion(c, ground);
          return true;
        }
      }
      // Witch: if her own cauldron is the FASTER source of a heal
      // right now (brewing already in progress, or the chest is
      // simply farther away than the cauldron), commit to brewing
      // instead of jogging past her own kit to the chest.  Without
      // this the witch would dutifully run all the way to the chest
      // even when she's standing two tiles from a cauldron that's
      // 80% of the way to a fresh bottle.
      if (witchSelfBrewBeatsChest(c)) {
        const a = c.activity;
        if (c.state === "talking") endTalking(c);
        c.state = "working";
        c.stateUntil = now + 12000;
        setTarget(c, a.x, a.y);
        return true;
      }
      // Zombie's "self-brew" equivalent: the gravestone IS his
      // healing station, with its own faster regen tick (see
      // GRAVE_REGEN_* in tickStations).  Mirrors the witch's
      // self-stoke fallback above — if home is reachable AND
      // we're inside the same walk-back radius the panic-flee
      // hijack uses (ZOMBIE_GRAVE_WALK_BACK_R), commit to
      // parking there instead of jogging across the lawn to
      // the chest.  Without this branch the LOW_HP ladder
      // either peeled him off into "drinking" (combatMode !=
      // none, so damage()'s fighter retaliation went silent
      // too) or dropped him into "retreating" (walk away from
      // the threat, never swing back) — that's the user-
      // reported "stands by the grave and doesn't fight back" loop, where
      // the regen tick keeps capping him just below
      // LOW_HP_FRACTION and the LOW_HP ladder re-fires every
      // 180 ms.
      //
      // Defence comes FIRST: the regular fighter branch lower
      // down never gets to run once the LOW_HP ladder returns
      // true, so we have to engage threats ourselves before
      // committing to the homecoming.  Same AGGRO_RANGE the
      // "hold" arm of zombieGraveDeathStrategy uses for the
      // same situation (panic-flee at the grave) so the two
      // code paths agree on what counts as "in reach".
      //
      // Note: this also covers HP < PANIC for him — parking
      // here instead of fleeing is strictly better, since
      // dying inside ZOMBIE_SELF_REVIVE_R arms the green-
      // pillar self-revive (~9 s) and brings him back at full
      // HP at his post.  The PANIC branch below is therefore
      // a deliberate fall-through: only used when home is
      // unreachable.
      if (c.name === "zombie" && c.activity) {
        const grave = c.activity;
        const dg = Math.hypot(c.x - grave.x, c.y - grave.y);
        const homeReachable =
          dg < GRAVE_REGEN_R || safePathTo(c, grave.x, grave.y);
        if (dg <= ZOMBIE_GRAVE_WALK_BACK_R && homeReachable) {
          const [m] = bestMonsterFor(c, AGGRO_RANGE);
          if (m) { startFighting(c, m); return true; }
          if (c.state === "talking") endTalking(c);
          if (dg < GRAVE_REGEN_R) {
            // Already inside the regen radius — pin in place
            // so moveStep can't pull him off the tile chasing
            // a stale wander goal from before he got hit.
            c.state = "working";
            c.stateUntil = now + rr(...REST_DURATION_MS);
            setTarget(c, c.x, c.y);
          } else {
            // Walk home as a rest errand.  arrivedAt's
            // restErrand hook (see the wander branch around
            // line 1326) flips us into "working" the moment
            // we touch down; the next maybeEnterCombat tick
            // (within 180 ms) keeps re-evaluating along the
            // way, so a fresh slime stepping into aggro on
            // the journey gets engaged via the
            // nearestMonster check above on the very next
            // pass instead of being eaten silently.
            c.restErrand = true;
            c.state = "wandering";
            setTarget(c, grave.x + rr(-4, 4), grave.y + rr(-3, 3));
          }
          return true;
        }
        // Out of range OR no safe corridor home — fall through
        // to the chest / retreat ladder below.  The grave just
        // isn't an option this beat.
      }
      // Robot is mechanical — heal potions are biological glop and do
      // nothing for him, so he skips the chest run entirely.  His
      // restoration path is the oilcan (cooldown buff) and any
      // ambient regen that doesn't go through Combat.healHero.
      if (c.name !== "robot" && Scene.chestStockOf("heal") > 0) {
        startDrinking(c); return true;
      }
      if (c.hp < c.maxHp * PANIC_HP_FRACTION) { startFleeing(c); return true; }
      // Witch with no heal in hand AND no heal in the chest, but
      // the lawn is calm enough to walk?  Don't sprint offstage —
      // head back to the cauldron and stoke her own brew.  The
      // emergency-stoke speedup in tickWitchBrew (a wounded ally
      // + empty chest = 1.6× rate) makes it ~6s of standing still
      // instead of ~9.5s at base speed, and the moment the bottle finishes the
      // existing shouldSelfDrinkHeld branch above will fire on
      // the next tick and drink it on the spot.  Constructive
      // beats fleeing — fleeing means she leaves the stage and
      // the team has no brewer for the next emergency either.
      // We require:
      //   * her station exists (c.activity),
      //   * she isn't already carrying a brew (would be the heal
      //     we drink in shouldSelfDrinkHeld; a revive bottle blocks
      //     this branch on purpose, that's a deliberate hand-back
      //     to the team),
      //   * the immediate bubble is safe (100 px), and
      //   * the path to the cauldron is clear — same safePathTo
      //     gate the girl uses for healing, since a wounded witch
      //     walking through a slime cluster is the same suicide.
      if (c.name === "witch" && c.activity && !c.brewReady &&
          !Monsters.anyThreat(c.x, c.y, 100) &&
          safePathTo(c, c.activity.x, c.activity.y)) {
        const a = c.activity;
        if (c.state === "talking") endTalking(c);
        c.state = "working";
        c.stateUntil = now + 10000;
        setTarget(c, a.x, a.y);
        return true;
      }
      startRetreating(c); return true;
    }

    // Witch carrying a heal brew + a wounded ally is within hand-off
    // range?  Walk it over directly instead of jogging past them to
    // the chest (or sitting on it while wandering).  This used to fire
    // only mid-deposit (see findHandoffRecipient call inside tick‑
    // Depositing), so a witch carrying a bottle while the kiosk was
    // already full would just keep wandering past wounded allies.  We
    // now check it from idle too — same throttle, same safety bubble,
    // same path-safety gate the deposit-time detour uses.  Sits above
    // the deposit branch so a wounded friend always beats a shelf
    // restock.  (Self-drink for the witch herself was already handled
    // by the earlier shouldSelfDrinkHeld branch above.)
    {
      const hydraOn = HydraPlan && HydraPlan.active && HydraPlan.active();
      const bubbleClear = hydraOn
        ? !anyNonHydraThreatNear(c.x, c.y, 120)
        : !Monsters.anyThreat(c.x, c.y, 120);
      if (c.name === "witch" && c.heldPotion
          && c.heldPotion.potionKind === "heal"
          && bubbleClear
          && now - (c.handoffCheckAt || 0) >= HANDOFF_CHECK_MS) {
        c.handoffCheckAt = now;
        const recipient = findHandoffRecipient(c);
        if (recipient) {
          if (c.state === "talking") endTalking(c);
          startDelivering(c, recipient, now);
          return true;
        }
      }
    }

    // Witch: brewed a potion and the chest has room?  Drop combat
    // planning and go stock the kiosk first.  We gate this behind
    // "no immediate threat" so she doesn't stroll into a melee with
    // a bottle in her hand.  We *also* gate it on actual chest need:
    // if the kiosk already has stock of this brew kind AND she just
    // brewed it (within WITCH_CARRY_DEPOSIT_MS), she keeps the
    // bottle on her belt for opportunistic use (self-drink, hand-
    // off) instead of running it straight to the shelf.  The carry
    // timeout still forces a deposit eventually so brews don't sit
    // in her pocket indefinitely on a calm lawn.
    if (c.name === "witch" && c.brewReady && Scene.chestHasRoom()) {
      const hydraOn = HydraPlan && HydraPlan.active && HydraPlan.active();
      const chest = Scene.chest && Scene.chest();
      // Bubble: under boss, ignore hydra parts (we'd never leave
      // otherwise — heads orbit close to the cauldron the whole fight)
      // and instead require the courier line to the chest to clear
      // the body's bite ring.  This is the user-reported "hydra is
      // busy with others, the arc to the chest is open, but she just
      // stands at the cauldron" fix: the old gate counted the heads
      // hovering ~95 px from her as a threat and blocked the run.
      const bubbleClear = hydraOn
        ? !anyNonHydraThreatNear(c.x, c.y, 120)
        : !Monsters.anyThreat(c.x, c.y, 120);
      const chestPathOk = (!hydraOn || !chest)
        ? true
        : !hydraPathBlocked(c.x, c.y, chest.x, chest.y + 2);
      if (bubbleClear && chestPathOk) {
        const kind = c.brewKind || "heal";
        const stocked = (Scene.chestStockOf && Scene.chestStockOf(kind)) || 0;
        const carriedMs = now - (c.brewedAt || now);
        // Empty kiosk for this kind, OR she's been carrying long
        // enough — restock.  Revives don't get the carry-around
        // grace: a fresh revive is most useful sitting in the chest
        // ready for any courier (ground reviver bottle pickup), since
        // the witch herself doesn't deliver them by hand.
        if (kind !== "heal" || stocked <= 0 ||
            carriedMs >= WITCH_CARRY_DEPOSIT_MS) {
          startDepositing(c); return true;
        }
      }
    }

    // Witch (still brewing): rush back to the cauldron when stocking
    // is the right call — emergency (hurt allies + no heals in the
    // chest) OR routine supply (fewer than 2 heals, or no revive while
    // the shelf still has room).  The brew tick only advances at the
    // station, so wandering costs throughput; peacetime used to skip
    // this entirely unless someone was already bleeding, which left
    // her hexing slimes instead of filling the kiosk.
    if (c.name === "witch" && !c.brewReady && c.activity &&
        !(HydraPlan && HydraPlan.active && HydraPlan.active()
          ? anyNonHydraThreatNear(c.x, c.y, 100)
          : Monsters.anyThreat(c.x, c.y, 100))) {
      const healStock = Scene.chestStockOf("heal");
      const reviveStock = Scene.chestStockOf("revive");
      const needEmergency = anyHurtAlly() && healStock <= 0;
      const needSupply =
        healStock < 2 ||
        (reviveStock < 1 && Scene.chestHasRoom());
      const a = c.activity;
      const atHome = Math.hypot(c.x - a.x, c.y - a.y) < 24;
      if (!atHome && (needEmergency || needSupply) &&
          safePathTo(c, a.x, a.y)) {
        if (c.state === "talking") endTalking(c);
        c.state = "working";
        c.stateUntil = now + 6000;
        setTarget(c, a.x, a.y);
        return true;
      }
    }

    // Witch boss home-base: during a hydra fight, her job is to
    // brew bottles and channel revives — both of which require her
    // physically standing at the cauldron.  The earlier "chest
    // empty + ally hurt" gate only fires under specific conditions
    // and used to leave her wandering randomly the rest of the
    // time, often drifting into spit / bite range.  This branch
    // unconditionally walks her back to the station any time she's
    // away from it during a boss fight, as long as she's not
    // already busy carrying a fresh brew (deposit first) and isn't
    // being bitten right now (self-defence already handled above).
    // The cauldron's ~190 px from the hydra body — outside bite
    // and tail reach, inside spit envelope but a low-priority
    // target — which is the safest spot from which she can still
    // contribute heal/revive throughput.
    // Witch self-rescue (fires regardless of brewReady — without this,
    // a witch who aborted a chest run mid-walk would just stand frozen
    // in the bite ring, since both the brewing branch (chestPathOk
    // false) and the home-base pull (gated on !brewReady) would skip
    // her).  If she's currently standing in the hydra's danger
    // envelope OR the cauldron is itself unsafe OR the straight-line
    // walk home crosses the bite ring, retreat to safer ground using
    // the angular-sweep evader.
    if (c.name === "witch" && c.activity && HydraPlan.active()) {
      const a = c.activity;
      const homeUnsafe = witchInHydraDangerAt(a.x, a.y);
      const pathHomeBlocked = hydraPathBlocked(c.x, c.y, a.x, a.y);
      if (witchInHydraDangerAt(c.x, c.y) || homeUnsafe || pathHomeBlocked) {
        if (c.combatMode === "fighting"
            || c.combatMode === "depositing"
            || c.combatMode === "delivering") {
          exitCombat(c);
        }
        if (c.combatMode !== "retreating" && c.combatMode !== "fleeing") {
          startRetreating(c);
        }
        return true;
      }
    }

    // Witch boss home-base: during a hydra fight, her job is to
    // brew bottles and channel revives — both of which require her
    // physically standing at the cauldron.  The earlier "chest
    // empty + ally hurt" gate only fires under specific conditions
    // and used to leave her wandering randomly the rest of the
    // time, often drifting into spit / bite range.  This branch
    // unconditionally walks her back to the station any time she's
    // away from it during a boss fight, as long as she's not
    // already busy carrying a fresh brew (deposit first) and isn't
    // being bitten right now (self-defence already handled above).
    // The cauldron's ~190 px from the hydra body — outside bite
    // and tail reach, inside spit envelope but a low-priority
    // target — which is the safest spot from which she can still
    // contribute heal/revive throughput.
    if (c.name === "witch" && c.activity && HydraPlan.active() &&
        !c.brewReady && !Monsters.anyThreat(c.x, c.y, 60)) {
      const a = c.activity;
      const atHome = Math.hypot(c.x - a.x, c.y - a.y) < 24;
      if (!atHome) {
        if (c.state === "talking") endTalking(c);
        c.state = "working";
        c.stateUntil = now + 6000;
        setTarget(c, a.x, a.y);
        return true;
      }
    }

    // Zombie boss home-base (mirrors witch branch above).  During
    // a hydra fight the boss override no longer drags him to the
    // body (see zombieSkipBoss in the HydraPlan section), but
    // without a positive "stay home" pull he'd just keep doing
    // his idle wander loop — drifting up to ZOMBIE_GRAVE_WALK_BACK_R
    // away from the grave between visits.  That leaves the
    // gravestone undefended for ~6 s at a time, which is exactly
    // long enough for a freshly-spawned skeleton to peel off and
    // attack the witch / girl at her cauldron.  Pin him to the
    // grave whenever the fight is on, no local threat is in
    // arm's reach (SELF_DEFENCE_R already handled), and he isn't
    // already standing on the regen tile.  GRAVE_REGEN_R - 4
    // matches the same "I'm home" predicate maybeRestAtGrave
    // uses, so we don't fight that tick's regen logic.
    if (c.name === "zombie" && c.activity && HydraPlan.active() &&
        !Monsters.anyThreat(c.x, c.y, 60)) {
      const grave = c.activity;
      const dg = Math.hypot(c.x - grave.x, c.y - grave.y);
      const atHome = dg < GRAVE_REGEN_R - 4;
      if (!atHome &&
          (dg < GRAVE_REGEN_R || safePathTo(c, grave.x, grave.y))) {
        if (c.state === "talking") endTalking(c);
        c.restErrand = true;
        c.state = "wandering";
        setTarget(c, grave.x + rr(-4, 4), grave.y + rr(-3, 3));
        return true;
      }
    }

    // Healer: head to whichever ally is hurt.  If nobody's hurt but a
    // comrade is brawling nearby and there's a monster in biting
    // distance, the girl can't swing back — she runs for the edge.
    // Otherwise she just sits tight waiting for someone to need heals.
    //
    // Personal-bubble distance: 50 px, just outside arm's reach for
    // any melee monster.  Earlier code used 80 here, which on a
    // crowded 800-px lawn meant she was almost always within 80 px
    // of *something* and would re-flee every tick before ever
    // committing to a heal target — the net effect was that the
    // healer never actually healed.  50 still bails BEFORE the
    // slime is biting her (slime hops are ~22 px) but lets her hold
    // ground when the brawl is half a screen away.
    if (c.role === "healer") {
      // Personal-bubble breach: retreat (stays onstage so she can
      // still cast on the next opening) unless HP has dropped into
      // panic territory, in which case we commit to the lawn-edge
      // exit.  The previous unconditional `startFleeing` here was
      // the main reason the healer "ran for the edge instead of
      // healing" — a single passing slime was enough to blow the
      // session even at full HP.
      //
      // Surrounded escalation: a single drifting slime in the 50 px
      // bubble = retreat (she keeps casting on the next opening).
      // But two+ monsters inside a wider 90 px ring is genuinely
      // "she's about to be flanked", so we skip straight to a
      // panic flee even at full HP — a tactical sidestep won't
      // shake two pursuers, and standing still to evaluate a heal
      // target ends with her sandwiched.
      const bubble = Monsters.anyThreat(c.x, c.y, 50);
      const swarm  = Monsters.countThreats(c.x, c.y, 90) >= 2;
      if (bubble || swarm) {
        // Panic-flee horse summon: low HP + a monster in close range
        // is exactly the situation where galloping out beats trying
        // to retreat on foot.  Falls through to the standard flee /
        // retreat branches if the cooldown isn't ready.
        if (maybeSummonHorse(c, now, "panic")) return true;
        if (swarm || c.hp < c.maxHp * PANIC_HP_FRACTION) startFleeing(c);
        else startRetreating(c);
        return true;
      }
      // Hydra fight: the spit envelope reaches into roughly the
      // healer's normal idle area.  If she's standing inside it with
      // nothing to heal, pull her back to the planned healer pocket
      // BEFORE the next acid lob — otherwise she's just a free spit
      // target with no heals to cast and she dies idle.
      if (HydraPlan.active() && HydraPlan.inSpitDanger(c.x, c.y)) {
        const ally = neediestAlly(c);
        const wantHeal = ally && ally.hp < ally.maxHp * GIRL_HEAL_TARGET_FRAC;
        if (!wantHeal) {
          // Boss-priority gallop: standing in acid with nothing to do
          // is the textbook horse moment in a hydra fight.  Cooldown
          // gates this, so it won't spam — but when it's available it
          // beats walking through 11-dmg spit balls back to pocket.
          if (maybeSummonHorse(c, now, "boss")) return true;
          const stance = HydraPlan.stanceFor(c);
          if (stance) {
            if (c.state === "talking") endTalking(c);
            c.state = "wandering";
            c.stateUntil = now + 2200;
            setTarget(c, stance.x, stance.y);
            return true;
          }
        }
      }
      const ally = neediestAlly(c);
      if (ally && ally.hp < ally.maxHp * GIRL_HEAL_TARGET_FRAC) {
        // Long-commute horse summon: a wounded ally on the far side
        // of the lawn is worth a gallop instead of a slow walk —
        // every second we save shaving off the commute is a second
        // ticked off her heal cooldown over the patient.
        if (maybeSummonHorse(c, now, "commute", ally)) return true;
        startHealing(c, ally); return true;
      }
      // Nothing to heal, but someone's fighting near her: pull back
      // (or, at panic HP, bolt) if a monster is in the wider radius;
      // otherwise just hold position and wait for a heal target.
      if (buddy && Monsters.anyThreat(c.x, c.y, 140)) {
        if (c.hp < c.maxHp * PANIC_HP_FRACTION) startFleeing(c);
        else startRetreating(c);
        return true;
      }
      // Boss holding pattern: if nobody urgently needs a heal, stay in
      // the designated pocket near the front instead of drifting back
      // to flowers / chats / random wandering.  The previous version
      // only nudged her OUT of spit danger; that still let her idle far
      // away from the brawl, which meant the first ally to get chunked
      // died before she finished the commute.  Here we proactively hold
      // a useful support position as long as the path is sane.
      if (HydraPlan.active()) {
        const stance = HydraPlan.stanceFor(c);
        if (stance && Math.hypot(stance.x - c.x, stance.y - c.y) > 18) {
          if (safePathTo(c, stance.x, stance.y) || safeCastFrom(c, stance.x, stance.y, 16, "heal")) {
            if (c.state === "talking") endTalking(c);
            c.state = "wandering";
            c.stateUntil = now + 2200;
            setTarget(c, stance.x, stance.y);
            return true;
          }
        }
      }
      return false;
    }

    // Fighter: pick the closest monster in aggro range; if nothing is
    // in our personal aggro but a comrade is brawling nearby, run
    // over to back them up on the same target.  Ranged fighters use
    // their own weapon range as the engage threshold (when it's
    // wider than AGGRO_RANGE) — an archer who can hit at 170 px
    // shouldn't ignore a slime charging him from 160 just because
    // the generic aggro radius is 140.  Otherwise the snipe path
    // handles those mid-range plinks but the hero never commits to
    // backing off / kiting, so the monster keeps closing the gap
    // until it bites him in the ankles.
    const aggroR = isRanged(c)
      ? Math.max(AGGRO_RANGE, c.atk.range)
      : AGGRO_RANGE;
    // Use the threat-aware picker here (not raw nearestMonster) so a
    // wounded straggler / a monster currently mauling our healer
    // outranks a fresh tank that just happens to be one pixel
    // closer.  Falls back to distance-only if Phase-0 helpers are
    // somehow unavailable.
    const [m, mDist] = bestMonsterFor(c, aggroR);
    // Self-defence trumps everything else — a monster already in
    // arm's reach gets engaged before we peel off to defend the
    // healer (otherwise we just turn our back on a slime that's
    // about to bite us).  Anything farther falls through to the
    // healer-guard check below.
    if (m && mDist < SELF_DEFENCE_R) { startFighting(c, m); return true; }
    // Healer guard: any monster crowding a nearby healer outranks a
    // passive aggro pick.  This is where the "patient defends the
    // healer" beat lands too — a fighter currently being healed
    // stands inside the healer's GIRL_HEAL_RANGE, which is well
    // under HEALER_GUARD_DEFENDER_R, so as soon as his combat tick
    // reaches this point he commits to whatever is chasing his
    // medic instead of going back to wandering.
    const guardTarget = monsterChasingHealer(c);
    if (guardTarget) {
      startFighting(c, guardTarget);
      Dialog.bark(c, "guardHealer");
      return true;
    }
    // Boss override: when the hydra is up, the team-level coordinator
    // gets the final say over which part of the boss this hero
    // commits to.  Without this, a TANK running into the bite cone
    // would lock onto the body (highest THREAT_WEIGHT) and ignore
    // the head currently chewing on him; a CUTTER would chip the
    // body's magic-resisted HP bar instead of severing heads to
    // open a push window.  We only override when the regular pick
    // (`m`) is either nothing or already a hydra part — the SELF_
    // DEFENCE_R guard above still wins for anything in arm's reach,
    // so a goblin-add that wandered onto the boss arena gets dealt
    // with first.
    if (HydraPlan.active()) {
      const planT = HydraPlan.targetFor(c);
      if (planT && !planT.dying) {
        // Witch boss exception: she's a brewer/reviver in disguise,
        // not a true CUTTER.  The general boss override would walk
        // her from the cauldron all the way to standoff range from
        // a head (~124 px), which puts her INSIDE the spit envelope
        // and within bite reach — exactly the "witch dies in the
        // first 20 s" failure mode.  Only commit to the engage if
        // the planned target is ALREADY in her hex range from where
        // she's currently standing; otherwise fall through (no
        // combat entry → wandering tick → stanceFor pulls her back
        // to the cauldron where the brew tick can finish a bottle).
        // Self-defence at SELF_DEFENCE_R is already handled above,
        // so a head that lunges into her face still gets hexed.
        const witchSkipBoss =
          (c.name === "witch") &&
          (planT.kind === "hydraBody" || planT.kind === "hydraHead");
        // Zombie boss exception (mirrors the witch fix above): the
        // gravestone is his station — skeletons spawn from it and
        // it's also his self-revive tile (dying inside
        // ZOMBIE_SELF_REVIVE_R brings him back at full HP within
        // ~9 s).  HydraPlan flags him as a SMASHER and points him
        // at the hydra body, but the body sits at the cave on the
        // far LEFT of the lawn while the grave is anchored at
        // xr=0.86 on the far RIGHT (~1100 px apart on a default
        // canvas).  Without this guard the override at the bottom
        // of this branch made him march the full width of the
        // lawn, leaving the grave undefended exactly when fresh
        // skeletons claw out of it — which is the user-reported
        // "zombie on the grave not fighting again" loop.  Only commit
        // to the engage if the planned hydra part is already
        // within local-aggro range from where he's standing;
        // otherwise fall through, let the local-`m` branch below
        // pick a skeleton in AGGRO_RANGE, or wander/rest near the
        // grave.  SELF_DEFENCE_R earlier in this function still
        // handles a head that lunges into bite reach.
        const zombieSkipBoss =
          (c.name === "zombie" && c.activity) &&
          (planT.kind === "hydraBody" || planT.kind === "hydraHead") &&
          (Math.hypot(planT.x - c.x, planT.y - c.y) > AGGRO_RANGE);
        if (!witchSkipBoss && !zombieSkipBoss) {
          startFighting(c, planT); return true;
        }
      }
    }
    // Witch boss exception (continued): the local-aggro `m` branch
    // below would also yank her across the lawn after a stray slime
    // — and during a hydra fight the only walks she should take are
    // "to the cauldron" and "to a corpse for revive".  Anything
    // outside her current hex range gets ignored; SELF_DEFENCE_R
    // earlier in this function still handles things in arm's reach.
    // Hydra parts get a hard "never engage" — even if `m` happens to
    // be a head/body inside her hex range, we refuse the entry so
    // tickFighting can't subsequently walk her into the bite ring
    // (see witchShouldSkipHydraTarget for the full rationale).
    if (HydraPlan.active() && c.name === "witch" && m) {
      if (m.kind === "hydraBody" || m.kind === "hydraHead") return false;
      const range = (c.atk && c.atk.range) || 130;
      if (Math.hypot(m.x - c.x, m.y - c.y) > range * 0.95) {
        return false;
      }
      // Standoff-tile veto: tickFighting walks her to a position
      // ~0.6 * (range - 6) px from the slime on whichever side she
      // currently faces.  When the slime is orbiting the hydra body
      // (slimes get aggro'd into the boss arena and end up adjacent
      // to it), that walk advances 50-70 px straight at the boss
      // and lands her INSIDE spit / bite reach.  The user-reported
      // "witch is shooting near the hydra again" repro is this branch
      // firing — she's not chasing the hydra, she's chasing a slime
      // standing next to the hydra, and the standoff math doesn't
      // know the difference.  Mirrors tools/witch_fires_in_spit_sim.py
      // — base rate 37.6 % of engagements commit to spit/bite, fix
      // drops it to ~5 % (remaining cases are all SELF_DEFENCE_R
      // engages where the slime is literally in her face and she
      // has no choice but to hex it).
      const standoff = Math.max(10, range - 6);
      const dx = m.x - c.x;
      const side = dx === 0 ? (c.dir === "l" ? 1 : -1) : Math.sign(dx);
      const sx = m.x - side * standoff * 0.6;
      const sy = Math.max(Scene.FLOOR_TOP + 8,
                           Math.min(Scene.FLOOR_BOTTOM - 6, m.y));
      if (witchInHydraDangerAt(sx, sy)) return false;
      // Path-to-standoff bite ring veto.  Even when the standoff
      // itself clears the danger envelopes, the straight-line walk
      // from her current tile to the standoff might cut across the
      // body — same failure mode as the chest-deposit / cauldron-
      // walk branches that already use hydraPathBlocked.  Without
      // this gate she happily marches THROUGH bite reach to reach
      // a standoff that's technically outside it.
      if (hydraPathBlocked(c.x, c.y, sx, sy)) return false;
    }
    if (m) { startFighting(c, m); return true; }
    if (buddyTarget) { startFighting(c, buddyTarget); return true; }

    return false;
  }

  // ----- main step -----------------------------------------------------

  function step(c, dt, now) {
    // Station bookkeeping always runs first: it refreshes the buff
    // multipliers used by combat math this frame, drives the regen
    // ticks at the campfire / gravestone, and grows the lawn's
    // background props (logs piling on the stump, blooms in the
    // garden, the fire being fed).  It's safe to run for offstage
    // characters too — they won't get a buff and their visuals are
    // gated separately — so we run it before the early returns.
    tickStations(c, dt, now);

    // Mount auto-expiry: ride timer ran out (or we somehow ended up
    // mounted while dying / offstage) — kick into the dissolve
    // animation and let the regular combat tick run it.  Skipping
    // when already in "dismounting" avoids resetting the fade timer
    // on every frame.
    if (c.mounted && now > c.mountedUntil &&
        c.combatMode !== "dismounting" && c.combatMode !== "dead") {
      startDismount(c, now);
    }

    // Idle-mount safety: if she's mounted and just sitting in
    // combatMode "none" (no heal/revive/flee target picked up yet,
    // no riding-to-corpse errand running), give her a brief grace
    // window to find work and otherwise dismount.  This is what
    // stops the "she summoned the horse and didn't ride anywhere"
    // case where the situation that justified the cast resolved
    // before she finished mounting up.  Re-stamps the timer any
    // tick she IS busy (combat, healing, fleeing, etc.) so genuine
    // mounted activity isn't interrupted.
    if (c.mounted && c.combatMode !== "dismounting" &&
        c.combatMode !== "dead" && c.name === "girl") {
      // "Busy" = anything that justifies the saddle.  In addition to
      // an active combat sub-state (heal/flee/retreat/etc.), a girl
      // currently galloping toward a wander goal also counts —
      // mountUp seeds a wander destination precisely so the ride is
      // never wasted, and an idle-dismount in the middle of that
      // gallop would dissolve the horse out from under her well
      // before HORSE_RIDE_MS expired.  Genuine idle = combat mode
      // "none" AND not actively walking somewhere.
      const isWanderingTo = c.state === "wandering"
        && (c.tx !== c.x || c.ty !== c.y);
      const isBusy = c.combatMode !== "none" || isWanderingTo;
      if (isBusy) {
        c.mountedBusyAt = now;
      } else {
        if (!c.mountedBusyAt) c.mountedBusyAt = now;
        if (now - c.mountedBusyAt > HORSE_IDLE_DISMOUNT_MS) {
          startDismount(c, now);
        }
      }
    }

    if (c.state === "offstage") return;
    if (c.state === "talking") {
      // Conversation interrupts, in priority order.  Each one breaks
      // the chat (cleanly, via excuseFromConvo) so the next tick re-
      // routes through the regular AI ladder (maybeEnterCombat etc.).
      //
      //   1. Monster within striking distance — silent, no apology.
      //      Same as the original behaviour: the character is about
      //      to get bitten, blurting "Sorry, must dash!" while a
      //      slime closes the gap reads as cluelessness, not
      //      politeness.  applyDamage handles the cancel for actual
      //      hits; this catches the "monster is approaching but
      //      hasn't bitten yet" gap.
      //   2. Wounded self (HP < LOW_HP_FRACTION) — apologize and bail
      //      so the LOW_HP combat ladder (chest run / drink / panic
      //      flee) can take over on the next tick.  The cancelDrink
      //      / startFleeing / startRetreating logic downstream still
      //      vets safety; we just need to stop standing in place
      //      saying "Hi, friend!" while bleeding.
      //   3. Corpse on the ground that we can do something about —
      //      either we channel-revive (canRevive), or we can run a
      //      fresh revive bottle from the chest, or we're the alien
      //      who scrambles the saucer for body recovery.  Dropping
      //      the chat now lets maybeEnterCombat's reviver-dibs branch
      //      see us as idle and route the recovery.
      //   4. Open help call from a friend in trouble — armed heroes
      //      bail to answer.  The alien gets handled via his own UFO
      //      ladder and skips this branch (matches tryAnswerHelp).
      //   5. Buddy already brawling within BUDDY_RANGE — the ally is
      //      visibly swinging at a monster a few sprites away; standing
      //      there finishing a chat (especially as a ranged hero who
      //      could just nock an arrow) reads as oblivious.  Tough
      //      callers (knight / viking) don't yell for help until they
      //      hit 30 % HP, so without this branch two archers next to a
      //      dwarf getting mauled keep gossiping for a full health bar.
      //      Mirrors the `nearestFightingAlly` pickup in the wandering
      //      combat ladder so talking and wandering heroes converge on
      //      the same brawl rather than the chat acting as a silent
      //      "do-not-disturb" sign.
      //   6. Healer with another ally in genuine need of patching
      //      (anyHurtAlly with a tighter threshold than the chat
      //      veto's default).  Without this, two healers who paired
      //      off for a chat could keep gossiping while a knight
      //      bled out across the lawn.
      if (Monsters.anyThreat(c.x, c.y, 170)) {
        Dialog.cancel(c);
        return;
      }
      if (c.hp < c.maxHp * LOW_HP_FRACTION) {
        excuseFromConvo(c, "excuseConvo");
        return;
      }
      const corpseHere = nearestDeadAlly(c);
      const corpseDuty = !!corpseHere && (
        canRevive(c)
        || (c.role !== "alien" && Scene.chestStockOf("revive") > 0)
        || c.role === "alien"
      );
      if (corpseDuty) {
        excuseFromConvo(c, "excuseConvo");
        return;
      }
      if (c.atk && c.role !== "alien" && nearestHelpCall(c, now)) {
        excuseFromConvo(c, "excuseConvo");
        return;
      }
      if (c.atk && c.role !== "alien" && nearestFightingAlly(c, BUDDY_RANGE)) {
        excuseFromConvo(c, "excuseConvo");
        return;
      }
      if (c.role === "healer" && anyHurtAlly(0.6)) {
        excuseFromConvo(c, "excuseConvo");
        return;
      }
      return;
    }

    // Boss-fight discipline: whenever the witch lands in one of
    // the losing ladders while the hydra is live, zero the combat
    // bit BEFORE tickCombat gets to run it.  start* still fires
    // from maybeEnterCombat / retaliation / the ranged-snipe path
    // so useful side effects (retreat tx/ty, fleeRefuge,
    // drinkPhase) get a single tick to settle, and then we
    // bounce her back to "working" so tickWitchBrew advances
    // instead of the doomed mode.  See witchSkipsCombatLadder for
    // the +6.7 pp winrate that motivates this gate.
    if (witchSkipsCombatLadder(c)
        && (c.combatMode === "fighting" || c.combatMode === "fleeing"
         || c.combatMode === "drinking" || c.combatMode === "retreating")) {
      exitCombatToPost(c);
    }

    // Combat takes priority over routine.
    if (c.combatMode !== "none") {
      tickCombat(c, dt, now);
      return;
    }

    // Witch brew progress ticks independently of combat checks: she
    // only makes progress while idle at her cauldron, but we advance
    // the timer every frame so the book-keeping stays simple.
    if (c.name === "witch") tickWitchBrew(c, dt);

    // Monsters on stage?  Maybe this character reacts.
    if (now - c.lastThreatCheck > 180) {
      c.lastThreatCheck = now;
      if (maybeEnterCombat(c, now)) return;
      // No combat to enter — but maybe the patch over yonder has a
      // bloom worth detouring for.  Cheap throttled check; on a hit
      // it just re-points the wander target at the flower patch.
      maybeFlowerErrand(c, now);
      // Same idea, but for the hero's own training station: if we
      // happen to be wandering past it with no buff on the clock
      // and the area is calm, redirect to the training spot for a
      // quick top-up.  Skipped while running revives, fetching a
      // potion, etc. — `maybeTrainErrand` checks all of that.
      maybeTrainErrand(c, now);
      // Wounded but the lawn is calm and nobody's panicking — make
      // a beeline for the campfire (or, for the zombie, his
      // gravestone) and park there long enough for the passive
      // regen tick to top us off.  Without these, the slow regen
      // hexes were drive-by-only: heroes ticked 1 HP back as they
      // happened to brush past the fire, which barely registered.
      maybeWarmAtFire(c, now);
      maybeRestAtGrave(c, now);
      // Firemage with a stale (or empty) "infused" buff: detour back
      // to the campfire to soak heat before the next encounter.
      maybeChargeAtFire(c, now);
    }

    // Peacetime ranged snipe: an archer / firemage strolling past a
    // monster that's beyond AGGRO_RANGE but still inside their own
    // weapon range (arrows reach 170 px, fireballs 150) shouldn't
    // just walk on by — let them plink at it without dropping into
    // a full "fighting" state machine.  Inside aggro range
    // maybeEnterCombat will already have promoted them to fighting,
    // so this path only matters at the long-range edge.
    if (c.state !== "leaving") tryRangedSnipe(c, now);

    // Non-fighter wander route re-check.  randomLawnPoint vets the
    // route at plan time, but a slime that crawls into the corridor
    // 50 ms later won't bump the girl off course until the next
    // 180 ms aggro tick — and that tick only fires when the monster
    // is within 80 px of HER, not her path.  So every frame, while
    // she's walking, verify the line from her to her current target
    // is still clear.  If it isn't, try to pick a fresh safe goal;
    // if nothing safe is reachable AND something is nearby, bolt
    // for the edge instead of plodding into the bite.
    if (nonFighter(c) && c.state === "wandering") {
      if (!safePathTo(c, c.tx, c.ty)) {
        const [nx, ny] = randomLawnPoint(c);
        if (Math.hypot(nx - c.x, ny - c.y) < 6 &&
            Monsters.anyThreat(c.x, c.y, 110)) {
          startFleeing(c);
          return;
        }
        setTarget(c, nx, ny);
      }
    }

    const arrived = moveStep(c, dt, 1.0);
    if (arrived) arrivedAt(c);

    // Now that moveStep has finished writing to c.frame for this
    // tick, run the training visual pass on top.  When the hero is
    // working at his own station this will overwrite the freshly-
    // zeroed frame with a swing/draw cycle, and (for the archer)
    // launch a practice arrow at the bullseye.
    tickTrainingFx(c, dt, now);

    if (c.state === "leaving") {
      const { w } = Sprites.size();
      if (c.x < -w - 1 || c.x > Scene.WIDTH + w + 1) {
        c.state = "offstage";
        c.lastStageExit = now;
        c.x = offstageParkX();
        // Same off-stage social-state reset as the panic-flee exit
        // above: pact / morale / lookout don't survive a walk-off,
        // affinity does.
        c.pact = null;
        c.moraleUntil = 0;
        c.lookoutUntil = 0;
        c._swapShift = false;
      }
    }

    if (c.state === "working" && now > c.stateUntil) {
      if (Math.random() < LEAVE_AFTER_WORK_P && !(c.name === "witch" && HydraPlan.active())) {
        startLeave(c);
      } else {
        c.state = "wandering";
        c.wandersLeft = 1 + Math.floor(Math.random() * 3);
        c.stateUntil = now + rr(...WANDER_STEP_MS);
        const [nx, ny] = randomLawnPoint(c);
        setTarget(c, nx, ny);
      }
    }

    // Cross-cutting: any time we're wandering and our combat target
    // disappeared (combat just ended on a wander leg) we've already
    // handled it via exitCombat.  Nothing further to do here.
  }

  // ----- public damage/heal --------------------------------------------

  function damage(c, dmg, attacker) {
    // Decoy clones aren't real characters — they have only x/y/hp/
    // dir, no combat state, no dialog, no death pipeline.  Route
    // their hits through damageDecoy() and stop here so the rest
    // of this function (curse barks, retaliation, startDying, …)
    // doesn't trip over missing fields.
    if (c && c.decoy === true) {
      damageDecoy(c, dmg);
      return;
    }
    if (c.hp <= 0) return;
    const now = performance.now();
    // Damage reduction: the highest active DR source applies (they
    // don't stack — a knight in block stance who is also under an
    // alien shield uses whichever is bigger, not the sum).  Sources:
    //   • Heavy-fighter passive armor (ARMOR_DR, knight/viking/robot)
    //   • Knight tryBlock (BLOCK_DR for BLOCK_DURATION_MS)
    //   • Alien shieldBeam recipient (SHIELD_DR for SHIELD_DURATION_MS)
    //   • Viking berserk DR component (BERSERK_DR for the duration)
    let dr = 0;
    if (hasArmor(c))           dr = Math.max(dr, ARMOR_DR);
    if (c.blockUntil  > now)   dr = Math.max(dr, c.blockDR || BLOCK_DR);
    if (c.shieldUntil > now)   dr = Math.max(dr, SHIELD_DR);
    if (c.berserkUntil > now)  dr = Math.max(dr, BERSERK_DR);
    // Vulnerable (acid debuff): increases incoming damage.  Applied
    // BEFORE damage reduction so a blocking knight under vulnerable
    // still benefits from his block — the debuff just makes the raw
    // hit bigger.
    let rawDmg = dmg;
    if (c.vulnerableUntil && c.vulnerableUntil > now) {
      rawDmg = Math.round(rawDmg * (c.vulnerableMul || 1.25));
    }
    const incoming = Math.max(1, Math.round(rawDmg * (1 - dr)));
    c.hp = Math.max(0, c.hp - incoming);
    c.hitFlashUntil = now + 140;
    c.lastDamagedAt = now;
    c.lastDamagedSelfAt = now;

    // Don't just stand there chatting while being bitten — flip the
    // bubble into a cartoon swear and drop the conversation so the
    // combat AI takes over on the next step.
    if (c.state === "talking") {
      const p = c.partner;
      Dialog.cancel(c);
      c.state = "wandering";
      c.partner = null;
      c.activeConvo = null;
      if (p) {
        p.partner = null;
        p.state = "wandering";
        p.activeConvo = null;
      }
    }

    // Killed by this hit?  Skip the curse bubble and go straight to
    // the death flow; the corpse is untargetable from here until a
    // reviver walks up.
    if (c.hp <= 0) {
      if (c.role === "alien" && c.combatMode === "ufoing" && c.boarded) {
        const ufo = Scene.ufo && Scene.ufo();
        if (ufo) {
          c.ufoReviveTarget = null;
          c.ufoReviveUntil = 0;
          c.ufoCrashAnim = {
            phase: "descend",
            t0: now,
            liftStart: ufo.ufoBoardLift || 0,
            flyDx0: ufo.flyDx || 0,
            flyDy0: ufo.flyDy || 0,
          };
          return;
        }
      }
      startDying(c);
      return;
    }

    // Hit during the horse-summon channel cancels the cast onto the
    // forgiving short cooldown — the spell never landed, so we don't
    // punish the girl with the full 80 s lockout.
    if (c.combatMode === "summoningHorse") {
      cancelHorseSummon(c, now);
    }
    // Same forgiving-cancel rule for the decoy cast: a hit mid-spin
    // aborts the spell onto the short DECOY_CANCEL_CD_MS timer
    // instead of burning the full cooldown for nothing.
    if (c.decoyCastUntil > 0) {
      cancelDecoyCast(c, now);
    }

    Dialog.curse(c);

    // Yell for help when the situation is genuinely bad: the girl
    // (no attack of her own) screams the moment anything bites her,
    // and an armed hero screams once their HP drops below the "go
    // for a potion" threshold.  Fighter retaliation still happens
    // below — the call is additive, not a replacement.
    if (attacker && !attacker.dying &&
        (!c.atk || c.hp < c.maxHp * helpHpFractionFor(c))) {
      tryCallForHelp(c, attacker, now);
    }

    // Retaliate right away.  Fighters lock onto the specific attacker
    // (arrow-from-behind situations etc.), everyone else falls through
    // to the usual role-appropriate reaction picker.
    if (c.combatMode === "none") {
      if (attacker && !attacker.dying && c.role === "fighter") {
        startFighting(c, attacker);
      } else {
        maybeEnterCombat(c, now);
      }
    }
  }

  // ----- update / pair-check -------------------------------------------

  // ---- elemental debuff constants ------------------------------------
  const BURN_TICK_MS          = 600;   // burn DoT interval
  const POISON_DPS_PER_STACK  = 1.5;  // dmg/s per poison stack
  const POISON_TICK_MS        = 700;

  // Per-frame debuff processor: burns, poison, and expiry sweeps.
  // Called once per frame from update() AFTER all hero steps, so
  // debuff damage doesn't double-tick on the same frame it lands.
  function tickHeroDebuffs(dt, now) {
    for (const c of list) {
      if (c.hp <= 0 || c.combatMode === "dead") continue;

      // ---- Burn DoT (fire bite) ------------------------------------
      if (c.burnUntil > now && c.burnDps > 0) {
        const tick = c.lastDebuffTickAt || 0;
        if (now - tick >= BURN_TICK_MS) {
          c.lastDebuffTickAt = now;
          const dmg = Math.max(1, Math.round(c.burnDps * BURN_TICK_MS / 1000));
          damage(c, dmg, null);
          if (typeof Combat !== "undefined" && Combat.spawnDamageNumberPub) {
            Combat.spawnDamageNumberPub(c.x, c.y - 28, dmg, "burn");
          }
        }
      }

      // ---- Poison stacks (poison bite/spit) ------------------------
      // Expire stale stacks first.
      if (c.poisonStackExpiry && c.poisonStackExpiry.length > 0) {
        c.poisonStackExpiry = c.poisonStackExpiry.filter(exp => exp > now);
        c.poisonStacks = c.poisonStackExpiry.length;
      }
      if (c.poisonStacks > 0) {
        const ptick = c._lastPoisonTickAt || 0;
        if (now - ptick >= POISON_TICK_MS) {
          c._lastPoisonTickAt = now;
          const dmg = Math.max(1, Math.round(
            c.poisonStacks * POISON_DPS_PER_STACK * POISON_TICK_MS / 1000));
          damage(c, dmg, null);
          if (typeof Combat !== "undefined" && Combat.spawnDamageNumberPub) {
            Combat.spawnDamageNumberPub(c.x, c.y - 28, dmg, "poison");
          }
        }
      }
    }
  }

  // Public API to apply an elemental debuff from outside (combat.js).
  // Kind is one of "burn" | "vulnerable" | "chill" | "poison" | "root".
  function applyDebuff(c, kind, now) {
    if (!c || c.hp <= 0 || c.combatMode === "dead") return;
    switch (kind) {
      case "burn":
        c.burnUntil = now + 3000;
        c.burnDps   = 2;
        break;
      case "vulnerable":
        c.vulnerableUntil = now + 4000;
        c.vulnerableMul   = 1.25;
        break;
      case "chill":
        c.chillUntil = now + 3000;
        c.chillMul   = 0.55;
        break;
      case "poison": {
        // Add one stack, cap at 3.  Each stack expires independently
        // in POISON_TICK_MS × N s so fresh stacks don't reset old ones.
        const MAX_STACKS = 3;
        if (!c.poisonStackExpiry) c.poisonStackExpiry = [];
        if (c.poisonStacks < MAX_STACKS) {
          c.poisonStackExpiry.push(now + 5000);
          c.poisonStacks = c.poisonStackExpiry.filter(e => e > now).length;
        } else {
          // Refresh the oldest stack.
          c.poisonStackExpiry.sort((a, b) => a - b);
          c.poisonStackExpiry[0] = now + 5000;
        }
        break;
      }
      case "root":
        c.rootUntil = now + 900;
        break;
    }
  }

  function update(dt) {
    const now = performance.now();
    // Walk the boss-fight phase machine ONCE per frame, BEFORE any
    // per-hero step.  This way `step()` sees the freshly-updated
    // phase (rally → engage transition) and the war-cry buff fired
    // at the moment of transition is in place when station/combat
    // multipliers are recomputed for each hero this tick.
    HydraPlan.tickPlan(now);
    for (const c of list) step(c, dt, now);
    tickDecoys(dt, now);
    tickHeroDebuffs(dt, now);
    // Lapse expired pacts so we don't carry stale partner refs into
    // later combat ticks.  Cheap O(n) sweep; the field is null on
    // anyone who never made a pact in the first place.
    for (const c of list) {
      if (c.pact && c.pact.until <= now) c.pact = null;
    }

    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      if (!canStartConvo(a, now)) continue;
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j];
        if (!canStartConvo(b, now)) continue;
        if (!canChatWith(a, b, now)) continue;
        if (Math.hypot(a.x - b.x, a.y - b.y) < TALK_DIST) {
          startTalking(a, b);
          break;
        }
      }
    }
  }

  function canStartConvo(c, now) {
    if (c.state !== "wandering" && c.state !== "working") return false;
    if (c.combatMode !== "none") return false;
    if (now - c.lastConvoAt < POST_CONVO_COOLDOWN_MS) return false;
    if (c.x < 10 || c.x > Scene.WIDTH - 10) return false;
    // Don't start small-talk when monsters are brawling nearby.
    if (Monsters.anyThreat(c.x, c.y, 180)) return false;
    // Don't start small-talk while wounded — the LOW_HP combat ladder
    // (chest run / drink / panic) is about to fire on the next combat
    // tick, and a fresh chat would just have to be excused-from on
    // the very next step.  Keeps the bookkeeping clean and matches
    // the "wounded heroes apologize and head for healing" rule of the
    // talking-state interrupt above.
    if (c.hp < c.maxHp * LOW_HP_FRACTION) return false;
    // Don't start small-talk while there's serious work pending —
    // a corpse on the lawn, an open help call, or another ally
    // bleeding badly while we're a healer.  Same triggers as the
    // talking-state excuse-me checks; gating them HERE as well keeps
    // a chat from starting on the same tick a friend hits 0 HP only
    // to be cancelled a beat later.
    if (nearestDeadAlly(c)) return false;
    if (c.atk && c.role !== "alien" && nearestHelpCall(c, now)) return false;
    if (c.atk && c.role !== "alien" && nearestFightingAlly(c, BUDDY_RANGE)) return false;
    if (c.role === "healer" && anyHurtAlly(0.6)) return false;
    return true;
  }

  function canChatWith(a, b, now) {
    // Pair-specific guard on top of the per-character canStartConvo:
    // the same two heroes don't replay hello/goodbye immediately.
    if (a.lastConvoPartner === b &&
        now - a.lastConvoPartnerAt < PAIR_COOLDOWN_MS) return false;
    if (b.lastConvoPartner === a &&
        now - b.lastConvoPartnerAt < PAIR_COOLDOWN_MS) return false;
    return true;
  }

  // ----- drawing -------------------------------------------------------

  // Reusable offscreen buffer for sprite tinting.  We draw the sprite
  // into it, then use `source-atop` compositing so the tint only lands
  // on opaque sprite pixels instead of the whole 26×32 bounding box.
  // Without this, a hit/cast/KO overlay would stain the transparent
  // halo around the character and look like a coloured rectangle on
  // the lawn.
  var tintBuf = null;
  var tintCtx = null;

  function getTintBuf(w, h) {
    if (!tintBuf) {
      tintBuf = document.createElement("canvas");
      tintCtx = tintBuf.getContext("2d");
    }
    if (tintBuf.width !== w || tintBuf.height !== h) {
      tintBuf.width = w;
      tintBuf.height = h;
    }
    return tintCtx;
  }

  // Tombstone painted where a character fell.  The stone pops up
  // over the first ~220ms of death (little dirt spray moment) and
  // then just sits there.  The robot gets a different marker — a
  // riveted steel plate with an engraved "0" instead of the usual
  // stone tablet with a cross — so it reads as a machine's grave,
  // not a man's.  Both shapes are kept short and broad (10 wide ×
  // ~13 tall) so they read as a buried headstone instead of an
  // overlong slab — the latter visually conflicts with the heroes
  // standing next to them.
  function drawGraveMarker(ctx, c, now) {
    const cx = Math.round(c.x);
    const cy = Math.round(c.y);
    const age = Math.max(0, now - (c.deathAt || now));
    const pop = Math.min(1, age / 220);
    const liftBase = 13;
    const lift = Math.round(liftBase * pop);

    // Dirt mound with a darker rim on top for shading.  Same earth
    // for everyone — the robot is buried in the same lawn.
    ctx.fillStyle = "rgba(0,0,0,0.28)";
    ctx.fillRect(cx - 11, cy - 1, 22, 3);
    ctx.fillStyle = "#5a3a1e";
    ctx.fillRect(cx - 10, cy - 3, 20, 3);
    ctx.fillStyle = "#6e4628";
    ctx.fillRect(cx - 8, cy - 4, 16, 1);

    if (lift <= 0) return;

    if (c.name === "robot") {
      // Steel headplate: cooler, slightly bluer greys than the stone
      // tablet, with a bright top-left highlight, a dark right-edge
      // shadow, and four rivets at the inner corners to sell the
      // "metal panel bolted in place" reading.
      ctx.fillStyle = "#7d848c";
      ctx.fillRect(cx - 5, cy - 3 - lift, 10, lift);
      ctx.fillRect(cx - 4, cy - 4 - lift, 8, 2);
      ctx.fillStyle = "#c4cad2";
      ctx.fillRect(cx - 5, cy - 3 - lift, 1, lift);
      ctx.fillRect(cx - 4, cy - 4 - lift, 8, 1);
      ctx.fillStyle = "#4a4f55";
      ctx.fillRect(cx + 4, cy - 3 - lift, 1, lift);
      ctx.fillStyle = "#2c3036";
      ctx.fillRect(cx - 4, cy - 2 - lift, 1, 1);
      ctx.fillRect(cx + 3, cy - 2 - lift, 1, 1);
      ctx.fillRect(cx - 4, cy - 4,        1, 1);
      ctx.fillRect(cx + 3, cy - 4,        1, 1);
      // Engraved "0": a hollow 4×5 pixel ring centred in the plate.
      if (lift >= 8) {
        ctx.fillStyle = "#202428";
        const gx = cx, gy = cy - lift + 3;
        ctx.fillRect(gx - 1, gy,     2, 1); // top
        ctx.fillRect(gx - 1, gy + 4, 2, 1); // bottom
        ctx.fillRect(gx - 2, gy + 1, 1, 3); // left
        ctx.fillRect(gx + 1, gy + 1, 1, 3); // right
      }
      return;
    }

    // Stone tablet (rounded by clipping the top corners) with a
    // soft left-edge highlight and a small plus-shaped cross — the
    // standard grave for every flesh-and-blood hero.  The cross is
    // intentionally compact: 2 rows above the bar, 1-row crossbar,
    // 3 rows below.  That reads as a plus with the bottom arm a
    // touch longer (which is what makes it a cross at all instead
    // of a perfectly symmetric +), without the stretched-Latin
    // proportions that made earlier versions feel too tall for the
    // stone.
    ctx.fillStyle = "#8a8a8a";
    ctx.fillRect(cx - 5, cy - 3 - lift, 10, lift);
    ctx.fillRect(cx - 4, cy - 2 - lift - 2, 8, 2);
    ctx.fillStyle = "#a3a3a3";
    ctx.fillRect(cx - 5, cy - 3 - lift, 1, lift);
    if (lift >= 8) {
      ctx.fillStyle = "#3d3d3d";
      const gx = cx;
      const top = cy - lift + 2;
      const spineH = 6;                                 // 2 above + crossbar row + 3 below
      ctx.fillRect(gx - 1, top, 2, spineH);             // vertical spine
      const cb = top + 2;                               // crossbar 2 rows from top
      ctx.fillRect(gx - 2, cb, 4, 1);                   // narrow crossbar (plus-like)
    }
  }

  // Pixel-art horse renderer.  `h` is the horseEntity created in
  // spawnHorseEntity — `{x, y, dir, frame, mode, ...}`.  The mode
  // controls a thin alpha tween:
  //   "spawn"    fade-in from 0 → 1 over 240 ms with white sparkle
  //              dust on the silhouette as it materialises.
  //   "approach" full opacity, gallop frames cycling every FRAME_MS/2.
  //   "ridden"   same as approach but the rider is stacked on top in
  //              drawOne; called from there (not from drawWorld).
  //   "fading"   alpha tween 1 → 0 with rising sparkles for the
  //              dissolve at dismount.
  // Translucent twin dropped by the healer's split spell.  Painted
  // very much like drawOne(), but with:
  //   • base alpha around ~0.55 so it reads as ghostly-not-real
  //     (drops further once the death/expire fade kicks in)
  //   • a faint cool-blue ring at the feet to mark it as conjured
  //   • no held-bottle / aura / HUD pip clutter — none of those
  //     fields exist on a decoy anyway
  //   • no tint buffer hit-flash; we just dim the alpha briefly so
  //     a hit on the clone reads without a red wash that would
  //     break the "ghost" look
  // The frame is pinned to the idle pose because the decoy is
  // explicitly inert — the spec is "stand still, go nowhere".
  function drawDecoy(ctx, d, now) {
    const { w, h } = Sprites.size();
    const img = Sprites.get(d.name, d.dir, 0);
    if (!img) return;
    const dx = Math.round(d.x - w / 2);
    const dy = Math.round(d.y - h);

    // Lifecycle alpha: spawn-in pop over the first 200 ms, steady
    // ghostly band, fade-out over DECOY_FADE_MS.
    let alpha = 0.55;
    const age = now - d.spawnedAt;
    if (age < 200) alpha *= Math.max(0, age / 200);
    if (d.fadeStartAt > 0) {
      const span = (d.fadeUntil || 1) - d.fadeStartAt;
      const p = span > 0 ? (now - d.fadeStartAt) / span : 1;
      alpha *= Math.max(0, 1 - p);
    }
    // Hit pulse: brief dim instead of red flash, so the ghost still
    // reads as a ghost when it eats a bite.
    if (now < d.hitFlashUntil) alpha *= 0.55;

    if (alpha <= 0.02) return;

    // Faint blue conjure ring at the feet — sells the "magical
    // construct" reading even before you notice the alpha.
    const prevA = ctx.globalAlpha;
    ctx.globalAlpha = prevA * Math.min(0.45, alpha);
    ctx.fillStyle = "rgba(150,200,255,0.9)";
    const ringPulse = (Math.sin(now / 220) + 1) * 0.5; // 0..1
    const ringR = 6 + Math.round(ringPulse * 2);
    ctx.fillRect(Math.round(d.x) - ringR, dy + h - 1, 1, 1);
    ctx.fillRect(Math.round(d.x) + ringR, dy + h - 1, 1, 1);
    ctx.fillRect(Math.round(d.x) - 2,     dy + h,     5, 1);

    // Sprite body.
    ctx.globalAlpha = prevA * alpha;
    ctx.drawImage(img, dx, dy);

    // Light cool-blue overlay clipped to the sprite silhouette so
    // the colour shift only lands on opaque pixels.  We re-use the
    // shared tint buffer the hero hit/cast flash uses.
    const bctx = getTintBuf(w, h);
    bctx.clearRect(0, 0, w, h);
    bctx.globalCompositeOperation = "source-over";
    bctx.drawImage(img, 0, 0);
    bctx.globalCompositeOperation = "source-atop";
    bctx.fillStyle = "rgba(150,200,255,0.35)";
    bctx.fillRect(0, 0, w, h);
    bctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = prevA * alpha * 0.6;
    ctx.drawImage(tintBuf, dx, dy);

    ctx.globalAlpha = prevA;
  }

  function drawHorse(ctx, h, now) {
    if (!Sprites.getExtra) return;
    const img = Sprites.getExtra("horse", h.dir, h.frame);
    if (!img) return;
    const hw = img.width;
    const hh = img.height;
    const dx = Math.round(h.x - hw / 2);
    const dy = Math.round(h.y - hh);
    ctx.fillStyle = "rgba(0,0,0,0.28)";
    ctx.fillRect(dx + 4, dy + hh - 2, hw - 8, 3);

    let alpha = 1;
    if (h.mode === "spawn") {
      const span = (h.spawnUntil || 1) - (h.spawnStartAt || 0);
      const p = span > 0 ? (now - (h.spawnStartAt || 0)) / span : 1;
      alpha = Math.max(0, Math.min(1, p));
    } else if (h.mode === "fading") {
      const span = (h.fadeUntil || 1) - (h.fadeStartAt || 0);
      const p = span > 0 ? (now - (h.fadeStartAt || 0)) / span : 1;
      alpha = Math.max(0, 1 - p);
    }

    const prevA = ctx.globalAlpha;
    ctx.globalAlpha = prevA * alpha;
    ctx.drawImage(img, dx, dy);
    ctx.globalAlpha = prevA;

    // Spawn / dissolve sparkles overlaid on the silhouette so the
    // tween reads as "magic at work" instead of a silent fade.
    if (h.mode === "spawn" || h.mode === "fading") {
      const sparkleA = h.mode === "spawn"
        ? Math.max(0, 1 - alpha)
        : Math.max(0, 1 - alpha) * 0.9;
      ctx.fillStyle = `rgba(255,250,200,${0.85 * sparkleA})`;
      // Five dusty pixels seeded by `now` so they twinkle each frame
      // — the modulo on hw / hh keeps them inside the silhouette
      // bounds without needing to sample the actual image alpha.
      for (let i = 0; i < 5; i++) {
        const sx = dx + 3 + Math.floor(((now / 70 + i * 7) % Math.max(1, hw - 6)));
        const sy = dy + 2 + Math.floor(((now / 80 + i * 11) % Math.max(1, hh - 4)));
        ctx.fillRect(sx, sy, 1, 1);
      }
    }
  }

  function drawOne(ctx, c, now) {
    if (c.combatMode === "dead") {
      drawGraveMarker(ctx, c, now);
      return;
    }
    const { w, h } = Sprites.size();
    // Mounted rider sits HORSE_SADDLE_OFFSET pixels above the ground.
    // All anchored draws (sprite body, buff aura, held bottle) use
    // `footY` instead of `c.y` so they travel with the saddle while
    // c.x/c.y remain the canonical "where the unit is" — the AI,
    // collision, monster targeting and y-sort logic all keep using
    // the ground anchor unchanged.  The horse itself is drawn FIRST
    // (foot-anchored at c.y) so the rider stacks on top in the
    // painter's order.
    const rideMode = c.mounted && c.horseEntity &&
                     c.horseEntity.mode === "ridden";
    if (rideMode) drawHorse(ctx, c.horseEntity, now);
    const footY = rideMode
      ? c.y - HORSE_SADDLE_OFFSET + HORSE_RIDER_Y_DROP
      : c.y;
    // Sit toward the rear of the horse when mounted: shift the sprite
    // anchor opposite to the facing direction so the head end stays
    // exposed.  c.x is unchanged so AI / collision / y-sort keep the
    // canonical position.
    const riderShiftX = rideMode
      ? (c.dir === "r" ? -HORSE_RIDER_X_OFFSET : HORSE_RIDER_X_OFFSET)
      : 0;

    // Melee swing lunge: 1-2 px forward shove that fires from
    // Combat.heroAttack and decays linearly over ~180 ms.  Eases
    // OUT (cosine) so the strike pops forward fast and snaps back
    // a touch slower — matches how the FX layer's slash/pow/axe
    // arc lands during the same window.  No effect on c.x itself
    // (collision / AI stay on the canonical position), this is
    // purely a render-only cue.
    let lungeDx = 0;
    if (c.swingUntil && now < c.swingUntil) {
      const SWING_MS = 180;
      const remain = c.swingUntil - now;
      const k = Math.max(0, Math.min(1, remain / SWING_MS));
      const dirS = c.dir === "r" ? 1 : -1;
      lungeDx = Math.round(dirS * 2 * Math.sin(k * Math.PI));
    }

    const img = Sprites.get(c.name, c.dir, c.frame);
    const dx = Math.round(c.x - w / 2 + riderShiftX + lungeDx);
    const dy = Math.round(footY - h);
    // Don't double up the foot shadow when riding — the horse drew
    // its own under its hooves.
    if (!rideMode) {
      ctx.fillStyle = "rgba(0,0,0,0.25)";
      ctx.fillRect(dx + 4, dy + h - 2, w - 8, 3);
    }

    const hitFlash = now < c.hitFlashUntil;
    const castFlash = !hitFlash && now < c.castFlashUntil;

    if (!hitFlash && !castFlash) {
      ctx.drawImage(img, dx, dy);
    } else {
      // Composite the sprite + tint in an offscreen buffer so the
      // overlay clips to the sprite silhouette only.
      const bctx = getTintBuf(w, h);
      bctx.clearRect(0, 0, w, h);
      bctx.globalCompositeOperation = "source-over";
      bctx.drawImage(img, 0, 0);
      bctx.globalCompositeOperation = "source-atop";
      if (hitFlash) {
        bctx.fillStyle = "rgba(255,80,80,0.55)";
        bctx.fillRect(0, 0, w, h);
      } else if (castFlash) {
        // Casting glow is concentrated on the upper body so it reads
        // as "magic swirling around the hands/head" rather than a
        // full-body wash; clamp to the sprite's top third before the
        // atop clip.
        bctx.fillStyle = "rgba(200,200,255,0.45)";
        bctx.fillRect(2, 4, w - 4, Math.ceil(h / 3));
      }
      bctx.globalCompositeOperation = "source-over";
      ctx.drawImage(tintBuf, dx, dy);
    }

    // Buff aura: a tiny coloured pip pulsing above the head while
    // a station buff is active.  We use the same colour palette as
    // the matching station decoration (atkBoost = warm sword red,
    // rapidFire = bow-string yellow, oiled = brassy gold, healPower
    // = bloom pink) so the aura visually echoes where it came from.
    if (c.workBuffKind && now < (c.workBuffUntil || 0)) {
      const remain = c.workBuffUntil - now;
      const fade = Math.min(1, remain / 800); // smooth out the last 800ms
      const blink = Math.floor(now / 220) % 2;
      let col = "#ffd142";
      switch (c.workBuffKind) {
        case "atkBoost":  col = "#ff7a3a"; break;
        case "rapidFire": col = "#ffe060"; break;
        case "oiled":     col = "#f0c84a"; break;
        case "healPower": col = "#ff8eb4"; break;
        case "infused":   col = "#ff5418"; break;
      }
      const ax = Math.round(c.x + riderShiftX);
      const ay = Math.round(footY - h - 2);
      ctx.fillStyle = col;
      const a = ctx.globalAlpha;
      ctx.globalAlpha = (0.85 * fade) * (blink ? 1 : 0.55);
      ctx.fillRect(ax - 1, ay - 2, 2, 1);
      ctx.fillRect(ax - 2, ay - 1, 4, 1);
      ctx.fillRect(ax - 1, ay,     2, 1);
      ctx.globalAlpha = a;
    }

    // Robot-only oil-charge meter.  Always visible above his head:
    //   • full bar, brassy gold while the "oiled" buff is up or he
    //     just topped up at the can
    //   • slowly drains over OIL_DECAY_MS, shifting from gold →
    //     orange → red as he gets thirsty
    //   • hits empty at the moment the rust penalty kicks in
    // Without this the only visible oil cue was a 4-pixel pulsing
    // pip during the buff window — easy to miss and gone the moment
    // the buff lapses.
    if (c.name === "robot") {
      let charge;
      if (c.workBuffKind === "oiled" && now < (c.workBuffUntil || 0)) {
        charge = 1;
      } else if ((c.lastOilAt || 0) > 0) {
        charge = 1 - Math.min(1, (now - c.lastOilAt) / OIL_DECAY_MS);
      } else {
        charge = 0;
      }
      const W = 14, H = 2;
      const mx = Math.round(c.x - W / 2);
      const my = Math.round(c.y - h - 6);
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      ctx.fillRect(mx - 1, my - 1, W + 2, H + 2);
      ctx.fillStyle = "#3a2a10";
      ctx.fillRect(mx, my, W, H);
      let fillCol;
      if (charge > 0.66)      fillCol = "#f0c84a"; // brassy gold
      else if (charge > 0.33) fillCol = "#e08a30"; // orange
      else                    fillCol = "#c63a2a"; // rust red
      const fillW = Math.max(0, Math.round(W * charge));
      if (fillW > 0) {
        ctx.fillStyle = fillCol;
        ctx.fillRect(mx, my, fillW, H);
        ctx.fillStyle = "rgba(255,255,255,0.35)";
        ctx.fillRect(mx, my, fillW, 1);
      }
    }

    // Bottle in hand: tiny potion bobbing just past the shoulder.  We
    // skip this while drinking because then the hero is literally
    // tipping the bottle back — the sparkle effect in Combat.js
    // represents that.
    if (c.heldPotion
        && !(c.combatMode === "drinking" && c.drinkPhase === "drink")
        && !(c.combatMode === "potionReviving" && c.revivePhase === "use")) {
      const side = c.dir === "l" ? -1 : 1;
      const bob = Math.sin(now / 180) * 1;
      Scene.drawPotion(ctx, {
        x: c.x + riderShiftX + side * 6,
        y: dy + Math.round(10 + bob),
        kind: c.heldPotion.potionKind || "heal",
      });
    }
    // Spare revive bottle on the off-shoulder.  Drawn whenever the
    // carrier isn't actively holding a primary bottle, so the player
    // can see who's currently carrying a passive spare from the chest
    // — and after a death the dropped bottle on the lawn matches the
    // sprite the carrier was wearing.  Bobbing offset is opposite to
    // the active hand so the two never overlap when both are visible.
    if (c.spareRevive && !c.heldPotion) {
      const side = c.dir === "l" ? 1 : -1;
      const bob = Math.cos(now / 200) * 1;
      Scene.drawPotion(ctx, {
        x: c.x + riderShiftX + side * 6,
        y: dy + Math.round(10 + bob),
        kind: "revive",
      });
    }

    // Healer-only mount cooldown pip.  Tiny "horseshoe" U-shape that
    // fades in over the last ~1.5 s before the cooldown is up so the
    // player can see when the next gallop is available without
    // cluttering the HUD the rest of the time.  Hidden entirely
    // while the spell is on full cooldown OR she's actively riding.
    if (c.name === "girl" && !c.mounted && !c.horseEntity) {
      const remain = c.horseCooldownUntil - now;
      if (remain > -300) {                                   // small post-ready buffer for a flash
        const fade = remain <= 0
          ? Math.max(0, 1 - (-remain) / 600)                 // ready: full pip, fade out
          : Math.max(0, 1 - remain / 1500);                  // last 1.5 s: fade in
        if (fade > 0.05) {
          const px = Math.round(c.x);
          const py = Math.round(footY - h - 6);
          const a = ctx.globalAlpha;
          ctx.globalAlpha = a * fade * 0.9;
          ctx.fillStyle = remain <= 0 ? "#fff8c0" : "#dadada";
          ctx.fillRect(px - 2, py, 1, 2);                    // left leg
          ctx.fillRect(px + 1, py, 1, 2);                    // right leg
          ctx.fillRect(px - 2, py - 1, 4, 1);                // arch
          ctx.globalAlpha = a;
        }
      }
    }

    // Healer-only decoy cooldown pip.  A 3-pixel "double-girl" pair
    // that fades in over the last ~1.5 s before the cooldown is up,
    // mirroring the horseshoe pip's reveal logic so both readouts
    // sit in the same HUD slot but two pixels lower.  Hidden while
    // a clone is currently on stage (the live ghost IS the readout)
    // OR while she's mid-cast.
    if (c.name === "girl" && c.decoyCastUntil === 0 &&
        (!c.decoyActive || c.decoyActive.fadeStartAt > 0)) {
      const remain = c.decoyCooldownUntil - now;
      if (remain > -300) {
        const fade = remain <= 0
          ? Math.max(0, 1 - (-remain) / 600)
          : Math.max(0, 1 - remain / 1500);
        if (fade > 0.05) {
          const px = Math.round(c.x);
          const py = Math.round(footY - h - 9);
          const a = ctx.globalAlpha;
          ctx.fillStyle = remain <= 0 ? "#cfe6ff" : "#9aa6b8";
          // Two side-by-side 1x2 silhouettes — the visual joke is
          // "two of her", which is exactly what the spell does.
          ctx.globalAlpha = a * fade * 0.9;
          ctx.fillRect(px - 2, py,     1, 2);
          ctx.fillRect(px,     py,     1, 2);
          ctx.fillRect(px - 2, py - 1, 1, 1);
          ctx.fillRect(px,     py - 1, 1, 1);
          ctx.globalAlpha = a;
        }
      }
    }
  }

  // The old draw() iterated characters + their activity items and
  // sorted by y.  Now the main loop assembles a world list that mixes
  // in monsters + potions too; see main.js.  We keep legacy draw()
  // as a thin wrapper that delegates to the new drawWorld so older
  // callers still work.
  function draw(ctx, t) { drawWorld(ctx, t); }

  function drawWorld(ctx, now) {
    const drawables = [];
    for (const c of list) {
      // Painter's algorithm sorts by feet-y, but a UFO in flight is
      // visually "in front of" everything on the ground regardless of
      // where its landing pad sits — pin it to the top of the draw
      // order whenever the saucer is airborne so it actually occludes
      // the chest / characters / monsters under it instead of slipping
      // behind them.
      const a = c.activity;
      const airborne = a.item === "ufo" && (a.ufoBoardLift || 0) > 0;
      const ay = airborne ? Number.POSITIVE_INFINITY : a.y;
      drawables.push({ y: ay, fn: () => Scene.drawItem(ctx, a, now) });
      if (isVisibleNow(c)) {
        drawables.push({ y: c.y, fn: () => drawOne(ctx, c, now) });
      }
      // Detached horse (approach trot + post-dismount dissolve) is
      // drawn from drawWorld so painter's order treats it like any
      // other ground unit.  While ridden ("mode === 'ridden'") it's
      // drawn from drawOne (stacked under the rider) so the rider
      // and mount stay glued together regardless of who else is on
      // the same y row.
      if (c.horseEntity && c.horseEntity.mode !== "ridden" &&
          isVisibleNow(c)) {
        const he = c.horseEntity;
        drawables.push({ y: he.y, fn: () => drawHorse(ctx, he, now) });
      }
    }
    for (const m of Monsters.list) {
      // Painter's-algorithm sort key from Monsters.sortY: foot
      // baseline for normal mobs (= m.y), but corrected to the
      // sprite-feet position for hydra parts whose draw is
      // centred on m.y rather than anchored to it.  Without this
      // graves and lower-lawn characters drew on top of the hydra
      // even when she was visually crawling in front of them.
      const my = (Monsters.sortY ? Monsters.sortY(m) : m.y);
      drawables.push({ y: my, fn: () => Monsters.drawOne(ctx, m, now) });
    }
    for (const d of decoys) {
      drawables.push({ y: d.y, fn: () => drawDecoy(ctx, d, now) });
    }
    if (Scene.listGroundPotions) {
      for (const p of Scene.listGroundPotions()) {
        drawables.push({ y: p.y, fn: () => Scene.drawGroundPotion(ctx, p, now) });
      }
    }
    drawables.sort((a, b) => a.y - b.y);
    for (const d of drawables) d.fn();
  }

  function countOnStage() {
    let n = 0;
    for (const c of list) if (isOnStage(c)) n++;
    return n;
  }
  // Count of "graves on the lawn" — used by the Director (to spawn
  // replacements faster when the body count climbs) and by the
  // reviver gating in maybeEnterCombat (to push past the usual
  // no-monsters-nearby gate when there's real triage to do).
  function countCorpses() {
    let n = 0;
    for (const c of list) if (c.combatMode === "dead") n++;
    return n;
  }
  function offstageChars() {
    return list.filter((c) => c.state === "offstage");
  }

  // Council host: pick 2-3 idle, calm wanderers near the campfire,
  // run them through a curated round-robin via Dialog.beginCouncil,
  // and on completion stamp the lookout buff on whoever's healthiest.
  // Returns true if the council was actually convened (Director uses
  // this to set its next-attempt timer); false means there weren't
  // enough takers this tick and we'll quietly try again later.
  function tryHostCouncil() {
    const now = performance.now();
    if (!Scene.campfireBurning || !Scene.campfireBurning()) return false;
    const fire = Scene.activity && Scene.activity("firemage");
    if (!fire) return false;
    if (Monsters.count() > 0) return false;
    if (Monsters.anyThreat(fire.x, fire.y, 200)) return false;
    // Roll the candidate pool: alive, on-stage, can fight, not
    // mid-deal, not already chatting / fighting / fleeing / etc.
    const eligible = list.filter((c) => {
      if (!c.atk) return false;
      if (c.role === "alien") return false;
      if (c.hp <= 0) return false;
      if (!isOnStage(c)) return false;
      if (c.combatMode !== "none") return false;
      if (c.state !== "wandering" && c.state !== "working") return false;
      if (c.partner) return false;
      if (c.heldPotion || c.brewReady) return false;
      if (now - (c.lastConvoAt || 0) < 4000) return false;
      // Already wearing the lookout sash with plenty left?  Skip —
      // re-electing the same hero a few seconds in is silly.
      if (c.lookoutUntil > now + LOOKOUT_DURATION_MS / 2) return false;
      return true;
    });
    if (eligible.length < 2) return false;
    // Prefer attendees already nearby so we don't drag the whole
    // cast across the lawn for a 5-line bubble swap.  Sort by
    // distance to the fire and take the closest 2-3.
    eligible.sort((c1, c2) =>
      Math.hypot(c1.x - fire.x, c1.y - fire.y) -
      Math.hypot(c2.x - fire.x, c2.y - fire.y));
    const attendees = eligible.slice(0, Math.min(3, eligible.length));
    if (attendees.length < 2) return false;
    if (!Dialog.beginCouncil) return false;
    // March everyone to the fire.  We use the same "talking" state
    // hold the chat machinery uses so the rest of the engine treats
    // them as politely engaged (no walking off mid-sentence, combat
    // checks bypass them unless something actually attacks).
    for (let i = 0; i < attendees.length; i++) {
      const c = attendees[i];
      if (c.state === "talking") endTalking(c);
      c.state = "talking";
      c.partner = attendees[(i + 1) % attendees.length];
      c.lastConvoAt = now;
      // Spread the trio in a small arc around the fire so their
      // bubbles don't pile on top of each other.
      const ang = (i / attendees.length) * Math.PI * 2;
      setTarget(c,
        fire.x + Math.cos(ang) * 26 + rr(-3, 3),
        fire.y + Math.sin(ang) * 14 + rr(-3, 3));
      c.dir = c.x >= fire.x ? "l" : "r";
    }
    function resetAttendees() {
      const t = performance.now();
      for (const c of attendees) {
        c.partner = null;
        c.activeConvo = null;
        if (c.state === "talking") {
          c.state = "wandering";
          c.wandersLeft = 1;
          c.stateUntil = t + rr(...WANDER_STEP_MS);
          const [nx, ny] = randomLawnPoint(c);
          setTarget(c, nx, ny);
        }
      }
    }
    Dialog.beginCouncil(attendees, {
      onElect: () => {
        // Stamp the lookout sash and bond every pair as a small
        // group trust event.  Critically, we DON'T touch state /
        // partner here — the council script still has bubbles to
        // play and freeing the attendees mid-script would let
        // canStartConvo pick them up for fresh chats that overlap
        // the unfinished closer line.  The wander-reset is done
        // once in onComplete below, after the loop has finished.
        const elected = electLookout(attendees);
        for (let i = 0; i < attendees.length; i++) {
          for (let j = i + 1; j < attendees.length; j++) {
            bumpAffinity(attendees[i], attendees[j], +0.6);
          }
        }
        return elected;
      },
      // Always fired — natural completion AND interruption — so a
      // council that gets cancelled mid-script (monster slap,
      // attendee wiped) cleans up the third hero too instead of
      // leaving them frozen in "talking" forever.
      onComplete: () => resetAttendees(),
    });
    return true;
  }

  return {
    init, update, draw, drawWorld, list, endTalking,
    startEnter, reassignActivities,
    countOnStage, countCorpses, offstageChars,
    isOnStage, isVisibleNow,
    damage, applyDebuff,
    listDecoys,
    affinityBetween: getAffinity,
    tryHostCouncil,
    bestMonsterFor, bestHeroFor,
    threatScoreHero, threatScoreMonster,
    // Boss coordinator — see HydraPlan definition near the top of
    // this module for the role/stance/push-window contract.  Used
    // by Monsters.maybeSeedHydra (activate) and killHydraBody
    // (deactivate) to bracket the team behaviour around the fight.
    HydraPlan,
  };
})();


/*
 * Director: decides when a new character walks on AND when a new
 * monster wave spawns.  Two independent schedulers share one tick().
 *
 * Character spawn pacing is soft, not hard: the soft target is the
 * population the lawn settles at most of the time, and the spawn
 * probability per slot tails off sharply past it so going one over
 * is a "look, the lawn is busy today" moment rather than the
 * default, and going two over is rare enough to feel special.
 * Above the hard cap we never spawn at all.
 *
 * Both caps scale with viewport width: the original 3 / 5 numbers
 * were tuned for an ~800 px stage — give the scene a wider canvas
 * and there's room for more concurrent heroes without crowding the
 * frame.  See `caps()` for the exact ramp.
 *
 * Monster waves are paced so the stage has quiet stretches: after a
 * wave is fully cleared (or has wandered off), we wait a random
 * cooldown before trying again, and we only spawn when there's
 * actually at least one hero on stage to fight (otherwise there's
 * nothing to watch).  Waves scale with the number of heroes visible.
 */
const Director = (() => {
  const MIN_REENTRY_MS = 4000;
  const SPAWN_INTERVAL_MS = 900;

  // Stage-population caps as a function of canvas width.  The
  // original 3 / 5 were tuned at ~800 px; every WIDTH_PER_HERO
  // pixels of extra width buys one more soft slot AND one more hard
  // slot, so a 1300 px scene comfortably runs ~5 heroes most of the
  // time and tops out at 7 instead of feeling sparse.  Hard cap is
  // also bounded by the cast size — ABS_HARD_MAX heroes total,
  // since there's only ten characters defined in the first place.
  const BASE_WIDTH       = 800;
  const WIDTH_PER_HERO   = 250;
  const BASE_SOFT_MAX    = 3;
  const BASE_HARD_MAX    = 5;
  const ABS_SOFT_MAX     = 8;
  const ABS_HARD_MAX     = 10;
  function caps() {
    const w = (typeof Scene !== "undefined" && Scene.WIDTH) || BASE_WIDTH;
    const extra = Math.max(0, Math.floor((w - BASE_WIDTH) / WIDTH_PER_HERO));
    const soft = Math.min(ABS_SOFT_MAX, BASE_SOFT_MAX + extra);
    const hard = Math.min(ABS_HARD_MAX, BASE_HARD_MAX + extra);
    return { soft, hard };
  }

  // Per-tick probability of spawning a new hero, given the current
  // effective slot index and the stage's caps for this frame.  The
  // shape mirrors the old hard-coded SPAWN_PROB = [0.80, 0.50,
  // 0.25, 0.04, 0.008] table: aggressive top-up below the soft
  // cap, a smaller bump AT the soft cap, then a sharp tail past it
  // (one-over: rare, two-over: very rare).  At the hard cap the
  // probability is 0 so the loop above just won't spawn.
  function spawnProbFor(slot, soft, hard) {
    if (slot >= hard) return 0;
    if (slot < soft - 1) {
      const denom = Math.max(1, soft - 1);
      return Math.min(0.80, 0.50 + 0.30 * (1 - slot / denom));
    }
    if (slot === soft - 1) return 0.25;
    if (slot === soft) return 0.04;
    return 0.008;
  }

  // Monster wave pacing.
  const WAVE_COOLDOWN_MS = [9000, 18000];
  const FIRST_WAVE_DELAY_MS = 6000;
  let nextWaveAt = 0;
  // Pre-wave telegraph: ~1500 ms before nextWaveAt fires we set the
  // dialog tone to "uneasy" so heroes mid-chat audibly tense up
  // (lines shorten, openers darken).  Stamped with the timestamp the
  // alarm fired so we don't re-emit every frame.
  const PRE_WAVE_ALARM_MS = 1500;
  let lastAlarmFor = 0;
  // After ANY revive (zombie self-revive included), push the wave
  // clock out so the team gets a real "breather" beat instead of
  // immediately eating another pack at half HP.  The Characters
  // module pings notifyRevive() at the end of every revive flow.
  const POST_REVIVE_BREATHER_MS = 7000;

  // Campfire council pacing.  The Director periodically tries to
  // host a small "who's standing watch?" round between idle heroes
  // by the fire; if nobody's available right now we just back off
  // for a beat and try again.  Numbers are deliberately conservative
  // so the council reads as a special downtime moment, not the
  // default activity at the campfire.
  const COUNCIL_FIRST_DELAY_MS = 22000;
  const COUNCIL_RETRY_MS       = [55000, 95000];
  const COUNCIL_BACKOFF_MS     = 8000;
  let nextCouncilAt = 0;

  let lastSpawnTick = 0;

  function tick(now) {
    const { soft, hard } = caps();

    // ---- hero spawns ----
    if (now - lastSpawnTick >= SPAWN_INTERVAL_MS) {
      lastSpawnTick = now;
      const onstage = Characters.countOnStage();
      if (onstage < hard) {
        const eligible = Characters.offstageChars().filter(
          (c) => now - c.lastStageExit > MIN_REENTRY_MS
        );
        if (eligible.length) {
          // Bodies on the ground don't count as "characters on
          // stage" (countOnStage already excludes them), but they
          // also push the spawn cadence faster: each grave drops
          // the effective slot index by one so the spawn-prob
          // curve reads as if the lawn were even more empty than
          // the alive count alone suggests.  This way a wipe-style
          // event refills aggressively instead of leaving the
          // stage half-dead waiting for the slow-drip near-cap
          // probability.
          const corpses = Characters.countCorpses();
          const slot = Math.max(0, onstage - corpses);
          const p = spawnProbFor(slot, soft, hard);
          if (Math.random() < p) {
            const pick = eligible[Math.floor(Math.random() * eligible.length)];
            Characters.startEnter(pick);
          }
        }
      }
    }

    // ---- campfire council ----
    if (nextCouncilAt === 0) {
      nextCouncilAt = now + COUNCIL_FIRST_DELAY_MS;
    }
    if (now >= nextCouncilAt) {
      const ok = Characters.tryHostCouncil && Characters.tryHostCouncil();
      if (ok) {
        const [lo, hi] = COUNCIL_RETRY_MS;
        nextCouncilAt = now + lo + Math.random() * (hi - lo);
      } else {
        nextCouncilAt = now + COUNCIL_BACKOFF_MS;
      }
    }

    // ---- monster waves ----
    if (nextWaveAt === 0) {
      nextWaveAt = now + FIRST_WAVE_DELAY_MS;
    }

    // Pre-wave alarm telegraph.  Fired once per scheduled wave (the
    // lastAlarmFor stamp tracks which `nextWaveAt` we already
    // alarmed for) so heroes have a beat to react.  Tone bump is
    // very lightweight — Dialog.note picks it up and biases the
    // next chat line.  No-op on the very first wave (the natural
    // FIRST_WAVE_DELAY_MS already serves as the "warm-up" period).
    if (lastAlarmFor !== nextWaveAt &&
        now >= nextWaveAt - PRE_WAVE_ALARM_MS &&
        Monsters.count() === 0 &&
        Characters.countOnStage() > 0) {
      lastAlarmFor = nextWaveAt;
      if (Dialog && Dialog.note) Dialog.note("alarm");
    }

    if (now >= nextWaveAt && Monsters.count() === 0) {
      const heroes = Characters.countOnStage();
      if (heroes > 0) {
        // Average team-HP fraction lets a wiped or beaten-up team
        // catch a smaller wave; a fresh team gets the standard
        // ramp.  Corpses (graves on the lawn) read as immediate
        // attrition and likewise damp the chain-wave odds.
        let sumFrac = 0, alive = 0;
        for (const c of Characters.list) {
          if (!Characters.isVisibleNow(c)) continue;
          if (c.hp <= 0) continue;
          sumFrac += c.hp / Math.max(1, c.maxHp);
          alive++;
        }
        const avgHp   = alive ? (sumFrac / alive) : 1;
        const corpses = Characters.countCorpses();
        const stress  = Math.max(0, Math.min(1, (1 - avgHp) + corpses * 0.25));
        // Chained-wave odds scale DOWN under stress so a beaten-up
        // team doesn't get a 3-wave salvo on top of their own
        // problems.  At full HP the multiplier is 1.0 (legacy
        // behaviour); at 50% avg HP with 2 corpses it tucks in to
        // about 0.0 — a single wave only, no chain.
        const chainMul = Math.max(0, 1 - stress);
        Monsters.spawnWave();
        if (heroes >= 2 && Math.random() < 0.30 * chainMul) Monsters.spawnWave();
        if (heroes >= 4 && Math.random() < 0.25 * chainMul) Monsters.spawnWave();
        const [lo, hi] = WAVE_COOLDOWN_MS;
        // Stress also adds a small breather to the cooldown — even
        // the next wave is pushed out a bit so the team has time
        // to drink/heal.
        nextWaveAt = now + lo + Math.random() * (hi - lo) + stress * 4000;
      } else {
        nextWaveAt = now + 3000;
      }
    }
  }

  // Hook used by Characters whenever a revive (any kind) lands.  Pushes
  // the next wave out by POST_REVIVE_BREATHER_MS unless we're already
  // even further out.  Cheap, safe to call multiple times per revive.
  function notifyRevive(now) {
    const target = now + POST_REVIVE_BREATHER_MS;
    if (nextWaveAt < target) nextWaveAt = target;
  }

  return { tick, notifyRevive };
})();
