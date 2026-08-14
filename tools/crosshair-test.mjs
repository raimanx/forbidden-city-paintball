/**
 * Headless tests for the aiming pair.
 *
 * The one that matters is the round trip: predict where a shot will land, fire
 * that exact shot, and check the ball arrives where the prediction said. That
 * is a direct test that `BallisticsSystem.predict()` and the live integrator
 * have not drifted apart — the failure this whole feature depends on not
 * happening, since a scene crosshair running on its own copy of the physics
 * would drift silently and start lying about where you are aiming.
 *
 * It needs no test hooks: `shot:fired` already carries the real origin and
 * direction, spread included, so the prediction is made from the shot that was
 * actually fired rather than an idealised one.
 *
 * Usage: node tools/crosshair-test.mjs [url]
 */
import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';

const url = process.argv[2] ?? 'http://localhost:4173/';
const EXECUTABLE =
  process.env.CHROME_PATH ??
  ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(existsSync);
if (!EXECUTABLE) throw new Error('No system Chrome found. Set CHROME_PATH.');

const browser = await chromium.launch({
  executablePath: EXECUTABLE,
  args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader',
         '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 1024, height: 576 } });
const consoleErrors = [];
page.on('pageerror', (e) => consoleErrors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

await page.goto(url, { waitUntil: 'load' });

// Simulated time is driven from here rather than by rendered frames. These
// headless frames are software-rasterised and land well under the ~12fps
// `simElapsed` needs to keep pace with the wall clock, so waiting on frames for
// simulated seconds cost minutes per test. See Game.stepSim.
//
// Claimed before boot starts the loop, so a run begins from the same world
// every time rather than from however far the bots wandered while the page
// was still loading.
await page.waitForFunction(() => Boolean(window.__paintball), { timeout: 30_000 });
await page.evaluate(() => {
  if (!window.__paintball.setManualSim) {
    throw new Error('this build predates the sim step hook — rebuild it');
  }
  window.__paintball.setManualSim(true);
});
await page.waitForFunction(() => window.__paintball && !document.querySelector('#loader'),
                           { timeout: 60_000 });

await page.mouse.click(512, 288);
await page.waitForTimeout(400);

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

/** Advances the simulation by `seconds`, stepping it directly. */
async function waitSim(seconds) {
  await page.evaluate((s) => window.__paintball.stepSim(s), seconds);
}

// Pair each shot with its own impact by firing one at a time. Shots overlap in
// flight at the normal fire rate, and the impact events carry no shot id, so
// FIFO pairing would silently mismatch a close shot against a distant one.
await page.evaluate(() => {
  const { game, ballistics, state } = window.__paintball;
  window.__pairing = { armed: false, pending: null, pairs: [],
                       out: ballistics.newPrediction() };

  // `armed` narrows capture to exactly one shot per iteration. Holding the
  // button for a single fire interval is not reliable across the round trip to
  // the browser, so a burst can be two shots, and pairing the first
  // prediction with the second shot's impact would look like drift.
  game.events.on('shot:fired', ({ shooterId, origin, direction }) => {
    if (shooterId !== 'player' || !window.__pairing.armed) return;
    window.__pairing.armed = false;
    const out = window.__pairing.out;
    const ok = ballistics.predict(
      game.physics, origin, direction, out, state.collider ?? undefined);
    window.__pairing.pending = ok
      ? { x: out.point.x, y: out.point.y, z: out.point.z,
          flightTime: out.flightTime, distance: out.distance,
          characterId: out.characterId, points: out.pointCount }
      : null;
  });

  // Bots fire constantly, and their impacts raise the same events. Without the
  // shooter filter every bot splat downrange pairs with our pending prediction.
  const record = (shooterId, point) => {
    const p = window.__pairing.pending;
    if (!p || shooterId !== 'player') return;
    window.__pairing.pending = null;
    window.__pairing.pairs.push({
      predicted: p,
      actual: { x: point.x, y: point.y, z: point.z },
      error: Math.hypot(point.x - p.x, point.y - p.y, point.z - p.z),
    });
  };
  game.events.on('hit:world', ({ shooterId, point }) => record(shooterId, point));
  game.events.on('hit:character', ({ shooterId, point }) => record(shooterId, point));
});

// --- Round trip: predicted impact vs. real impact ---------------------------
// Sweep pitch so the sample covers flat shots, lobs and everything between.
const PITCHES = [-0.35, -0.2, -0.08, 0.0, 0.05, 0.12, 0.25, 0.4];
await page.evaluate(() => {
  const { player, state } = window.__paintball;
  player.teleport(new (state.position.constructor)(0, 2, 120));
});
await waitSim(1.0);

for (let i = 0; i < PITCHES.length; i++) {
  await page.evaluate(({ pitch, i }) => {
    const { state } = window.__paintball;
    state.pitch = pitch;
    state.yaw = (i / 8) * Math.PI * 2;
  }, { pitch: PITCHES[i], i });
  await waitSim(0.35);
  await page.evaluate(() => { window.__pairing.armed = true; });
  await page.mouse.down();
  await waitSim(0.1);
  await page.mouse.up();
  // Long enough for the longest lob in the set to land.
  await waitSim(2.2);
  await page.evaluate(() => { window.__pairing.armed = false; });
}

const pairs = await page.evaluate(() => window.__pairing.pairs);
const errors = pairs.map((p) => p.error).sort((a, b) => a - b);
const worst = errors[errors.length - 1] ?? Infinity;
const median = errors[Math.floor(errors.length / 2)] ?? Infinity;

console.log(`\n  paired ${pairs.length} shots`);
for (const p of pairs) {
  console.log(`    range ${p.predicted.distance.toFixed(1)}m  flight ` +
              `${p.predicted.flightTime.toFixed(2)}s  error ${(p.error * 100).toFixed(1)}cm`);
}
console.log('');

check('every shot was paired with an impact', pairs.length >= PITCHES.length - 1,
      `${pairs.length}/${PITCHES.length}`);
// A perfect prediction still shows ~10cm here, and the residual is understood
// rather than drift: the live path reports the ball's *centre* at contact,
// which sits one 5.5cm radius off the surface, while the prediction reports the
// surface itself. On a shallow ground impact that gap is amplified by
// 1/sin(incidence), which at 10-15 degrees reaches ~25cm. Shortening the
// collision chord does not move these numbers, which is the evidence: sag is
// not what this is.
//
// Real divergence between the two integrators is not a near-miss — when bot
// impacts were mistakenly paired here, errors ran from 5m to 47m. So the median
// is the sensitive assertion and the worst case only needs to be sane.
check('predicted impact tracks the real one', median < 0.2 && worst < 0.4,
      `median ${(median * 100).toFixed(1)}cm, worst ${(worst * 100).toFixed(1)}cm`);

// --- The prediction is a real arc, not a straight line ----------------------
// If the predictor ever collapsed to a ray, the round trip above would still
// pass at point-blank range. Assert the drop explicitly.
const arc = await page.evaluate(() => {
  const { ballistics, game, state } = window.__paintball;
  const V = state.position.constructor;
  const out = ballistics.newPrediction();
  const origin = new V(0, 40, 20);
  const dir = new V(0, 0, -1);
  ballistics.predict(game.physics, origin, dir, out);
  const pts = out.points.slice(0, out.pointCount).map((p) => ({ x: p.x, y: p.y, z: p.z }));
  // Drop measured against the flat launch direction, at fixed horizontal ranges.
  const dropAt = (range) => {
    for (const p of pts) if (20 - p.z >= range) return 40 - p.y;
    return null;
  };
  return { hit: out.hit, count: out.pointCount,
           d8: dropAt(8), d15: dropAt(15), monotonic: pts.every((p, i) =>
             i === 0 || p.y <= pts[i - 1].y + 1e-6) };
});
// Both figures are measured against ballistics.muzzleSpeed = 63 and must be
// re-derived if it moves: they were 0.46 and 1.73 when it was 42.
check('the traced path drops like the real flight model',
      arc.d8 !== null && arc.d15 !== null &&
      Math.abs(arc.d8 - 0.21) < 0.04 && Math.abs(arc.d15 - 0.80) < 0.1,
      `drop 8m ${arc.d8?.toFixed(2)}m (want 0.21), 15m ${arc.d15?.toFixed(2)}m (want 0.80)`);
check('a horizontal shot only ever falls', arc.monotonic);

// --- The pair disagrees, and by more with range -----------------------------
// This is the entire feature: the viewport crosshair sits at screen centre, and
// the scene crosshair has to sit *below* it by the drop. If these ever
// coincide, something has started compensating the shot and the scene
// crosshair is redundant.
// Driven through the live camera, because the claim is about what the player
// sees, not about the numbers. The camera has to be given a settled pose first
// — reading it straight after a teleport measures the previous frame's view.
await page.evaluate(() => {
  const { player, state } = window.__paintball;
  // South edge of the plaza looking north up the arcade: ~17m of clear ground,
  // which is where the drop is worth seeing.
  player.teleport(new (state.position.constructor)(0, 2, 104));
  state.yaw = Math.PI;
  state.pitch = 0.02;
});
await waitSim(1.5);

const separation = await page.evaluate(() => {
  const { ballistics, game, state } = window.__paintball;
  const V = state.position.constructor;
  const out = ballistics.newPrediction();
  const cam = game.render.camera;
  const dir = new V(0, 0, -1).applyQuaternion(cam.quaternion);
  const origin = cam.position.clone();
  if (!ballistics.predict(game.physics, origin, dir, out)) return null;

  const toScreen = (p) => {
    const v = p.clone().project(cam);
    return { x: (v.x * 0.5 + 0.5) * window.innerWidth,
             y: (-v.y * 0.5 + 0.5) * window.innerHeight };
  };
  // Screen centre is exactly where the launch direction points, because the
  // shot is fired from the camera along its own forward axis.
  const centre = toScreen(origin.clone().addScaledVector(dir, out.distance));
  const scenePoint = toScreen(out.point);
  return { range: +out.distance.toFixed(1),
           viewportY: +centre.y.toFixed(0), sceneY: +scenePoint.y.toFixed(0),
           gapPx: +(scenePoint.y - centre.y).toFixed(0),
           height: window.innerHeight };
});

console.log(`\n  at ${separation?.range}m the scene crosshair sits ` +
            `${separation?.gapPx}px below the viewport crosshair\n`);
check('the scene crosshair sits below the viewport crosshair',
      separation !== null && separation.gapPx > 10,
      separation ? `${separation.gapPx}px at ${separation.range}m` : 'no impact predicted');

// --- A shot lined up on a person is reported as such ------------------------
// Drives the scene crosshair's white "you are on target" state, and proves the
// collider lookup survives the switch from swept-sphere to ray.
const onTarget = await page.evaluate(() => {
  const { ballistics, game, characters, state } = window.__paintball;
  const V = state.position.constructor;
  const out = ballistics.newPrediction();
  const bot = characters.allBots[0];
  // Straight down onto the bot from a metre over its head. Deterministic, and
  // close enough that nothing can get between the two — from four metres up it
  // could, and did: a bot that wandered into the arcade undercroft was under a
  // terrace slab whose underside is 3.5m up, so the trace reported the ceiling
  // and the check failed for a reason that had nothing to do with what it was
  // testing. The head tops out at 1.94m, the chest reference is 1.25m.
  const origin = new V(bot.chest.x, bot.chest.y + 1.0, bot.chest.z);
  ballistics.predict(game.physics, origin, new V(0, -1, 0), out);
  return { hit: out.hit, characterId: out.characterId, expected: bot.id };
});
check('a shot lined up on a bot reports that bot',
      onTarget.hit && onTarget.characterId === onTarget.expected,
      `got ${onTarget.characterId ?? 'none'}, expected ${onTarget.expected}`);

// --- Aiming at the sky yields no impact ------------------------------------
const sky = await page.evaluate(() => {
  const { ballistics, game, state } = window.__paintball;
  const V = state.position.constructor;
  const out = ballistics.newPrediction();
  // Straight up from high above the compound: nothing to hit inside the budget.
  const ok = ballistics.predict(game.physics, new V(0, 400, 0), new V(0, 1, 0), out);
  return { ok, hit: out.hit, points: out.pointCount };
});
check('an unobstructed shot reports no impact', !sky.ok && !sky.hit,
      `hit=${sky.hit}, traced ${sky.points} points`);

// --- Cost -------------------------------------------------------------------
const cost = await page.evaluate(() => {
  const { ballistics, game, state } = window.__paintball;
  const V = state.position.constructor;
  const out = ballistics.newPrediction();
  const origin = new V(state.position.x, state.position.y + 1.35, state.position.z);
  const dir = new V(0, 0.05, -1);
  // Warm up, then measure.
  for (let i = 0; i < 20; i++) ballistics.predict(game.physics, origin, dir, out);
  const t0 = performance.now();
  const N = 200;
  for (let i = 0; i < N; i++) ballistics.predict(game.physics, origin, dir, out);
  return (performance.now() - t0) / N;
});
// One prediction per fixed step; a fixed step's whole budget is 16.6ms.
check('a prediction costs well under a frame', cost < 1.5, `${cost.toFixed(3)}ms per solve`);

check('no console or page errors', consoleErrors.length === 0, consoleErrors[0] ?? 'clean');

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
