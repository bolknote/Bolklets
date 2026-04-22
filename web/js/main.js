/*
 * Main entry point: boots the scene, loads assets, kicks off the loop.
 *
 * In bundled mode ("bolklets.js") all the scripts are concatenated and
 * wrapped in an IIFE; in un-bundled mode each script is loaded with
 * `defer` so they execute in order after the host page's main content
 * has parsed.  Either way, by the time main runs the DOM is ready and
 * the other modules are defined.
 */
(async () => {
  const canvas = document.getElementById("bolklets-scene");
  if (!canvas) return;
  const stage = document.getElementById("bolklets-stage");

  // Size the canvas to match the stage's actual CSS width so 1 canvas
  // pixel == 1 CSS pixel (no blurry browser scaling).  Height stays at
  // 300 as requested.
  function sizeCanvas() {
    const cssW = Math.max(320, Math.round(stage.clientWidth));
    const cssH = 300;
    canvas.width = cssW;
    canvas.height = cssH;
  }
  sizeCanvas();

  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;

  const hud = document.getElementById("bolklets-hud");
  const status = document.getElementById("bolklets-status");
  if (status) status.textContent = "loading assets…";

  // One PNG holds both the character sprites and the Markov dialogue
  // model.  Fetch + decode it once, then hand each section to the
  // module that owns it.  If the model section is broken or missing
  // we still let the scene boot (with placeholder dialogue) so the
  // sprites at least render.
  const base = (typeof BOLKLETS_BASE !== "undefined") ? BOLKLETS_BASE : "";
  await Payload.load(base + "bolklets_code.png");

  await Sprites.loadAll();

  if (status) status.textContent = "loading dialogue…";
  try {
    Markov.init(Payload.bytes("model"));
    // Act-metadata is a separate light JSON section ("act") that carries
    // per-act start pools, act_trans matrix, and act_lex.  Optional: if
    // the payload was built without it we silently skip.
    const actBytes = Payload.bytes("act");
    if (actBytes && actBytes.length) {
      try {
        Markov.initAct(JSON.parse(new TextDecoder().decode(actBytes)));
      } catch (e) {
        console.warn("act section unavailable:", e);
      }
    }
  } catch (err) {
    console.warn("markov model unavailable, using fallback", err);
  }

  const { activities } = Scene.init(canvas.width, canvas.height);
  Characters.init(activities);

  if (hud) hud.classList.add("bolklets-hidden");

  // Re-initialise the scene if the browser window width changes
  // meaningfully (debounced so we don't re-paint on every resize tick).
  let resizeTimer = null;
  let lastW = canvas.width;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const newW = Math.max(320, Math.round(stage.clientWidth));
      if (Math.abs(newW - lastW) < 20) return;
      lastW = newW;
      canvas.width = newW;
      canvas.height = 300;
      ctx.imageSmoothingEnabled = false;
      const fresh = Scene.init(canvas.width, canvas.height);
      Characters.reassignActivities(fresh.activities);
    }, 250);
  });

  let last = performance.now();
  function frame(now) {
    const dt = Math.min(64, now - last);
    last = now;
    Director.tick(now);
    Monsters.tick(dt, now);
    Characters.update(dt);
    Combat.tick(dt);
    Scene.tickGroundPotions(now);
    // Apply the global screen shake by translating ALL world layers
    // together — background, characters, projectiles and effects all
    // jolt as one piece.  HUD-style overlays (none yet) would draw
    // outside the save/restore so they stay rock-steady.
    const sh = Scene.shakeOffset(now);
    if (sh.x || sh.y) {
      ctx.save();
      ctx.translate(sh.x, sh.y);
      Scene.draw(ctx, now);
      Characters.drawWorld(ctx, now);
      Combat.draw(ctx, now);
      ctx.restore();
    } else {
      Scene.draw(ctx, now);
      Characters.drawWorld(ctx, now);
      Combat.draw(ctx, now);
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
