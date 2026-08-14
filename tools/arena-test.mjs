/**
 * Headless arena tests.
 *
 * The map's job is to be walkable and inescapable. These check that the player
 * lands on solid ground everywhere they might spawn or fight, that the great
 * terrace can be climbed by its stairs and not up its sides, that the gates are
 * holes rather than blocks, that the moat contains them, and that paint sticks
 * to the compound.
 *
 * Usage: node tools/arena-test.mjs [url]
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

const startedAt = Date.now();
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
const readyMs = Date.now() - startedAt;

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

const read = () => page.evaluate(() => {
  const s = window.__paintball.state;
  return { x: s.position.x, y: s.position.y, z: s.position.z, grounded: s.grounded };
});

/** Drops the player from a height above a point and reports where they settle. */
async function dropAt(x, z, from = 20) {
  await page.evaluate(({ x, z, from }) => {
    const { player, state } = window.__paintball;
    player.teleport(new (state.position.constructor)(x, from, z));
  }, { x, z, from });
  await waitSim(3.4);
  return read();
}

check('loads within budget', readyMs < 5000, `${readyMs}ms`);

// --- Landing on solid ground across the compound ---------------------------
// One probe from each distinct piece of the plan. Every position here is one
// the plan says is clear of buildings; anything that falls through the world
// ends up far below, and anything unreachable never grounds.
const probes = [
  ['great court', 0, 110], ['court of the Gate of Supreme Harmony', 0, 160],
  ['on the great terrace', -0.8, 28.2], ['inner court', -3.7, -46.5],
  ['Six Eastern Palaces', 62, -100], ['Six Western Palaces', -60.6, -106.6],
  ['Imperial Garden', 34, -171], ['under the Meridian Gate', 0, 190],
  ['west flank', -72, 128], ['east flank', 68, 121],
  ['north end of the axis', -2.3, -200.5], ['west wall walk', -150, 0],
  // Outside the wall: the road that rings the moat, which a player who walks
  // out through a gate ends up on.
  ['moat road, west', -180, 0], ['moat road, north', 0, -226],
];
let landed = 0;
const failures = [];
for (const [name, x, z] of probes) {
  const at = await dropAt(x, z);
  const ok = at.grounded && at.y > -6 && Number.isFinite(at.y);
  if (ok) landed++; else failures.push(`${name} y=${at.y.toFixed(1)} grounded=${at.grounded}`);
}
check('player lands on solid ground everywhere', landed === probes.length,
      failures.length ? failures.join('; ') : `${landed}/${probes.length} regions`);

/** Walks forward from a position and reports where the player ends up. */
async function walkFrom(x, z, yaw, seconds, drop = 1) {
  await page.evaluate(({ x, z, yaw, drop }) => {
    const { player, state } = window.__paintball;
    state.yaw = yaw;
    player.teleport(new (state.position.constructor)(x, drop, z));
  }, { x, z, yaw, drop });
  await waitSim(1.0);
  await page.keyboard.down('w');
  await waitSim(seconds);
  await page.keyboard.up('w');
  await waitSim(0.4);
  return read();
}

// The bots go to the far corner of the compound first. Several of these probes
// have to walk a specific line rather than fall straight down, and a bot
// standing in an archway is a wall: the walk would stop short for reasons that
// have nothing to do with the architecture being tested.
await page.evaluate(() => {
  const { characters, state } = window.__paintball;
  const V = state.position.constructor;
  for (const bot of characters.allBots) {
    bot.respawn(new V(bot.position.x + 300, bot.position.y, bot.position.z + 300));
  }
});

// --- The great terrace can be climbed, and only by its stairs --------------
// The terrace is the centrepiece of the map: high ground in the middle of the
// largest courtyard, carrying the three great halls. It is *ground* rather than
// a prop, because the navgrid is a heightfield and a bot can only stand on what
// heightAt returns — so the thing that has to be checked is that the marble
// facing stops you walking up the sides, and that the stairs do not.
// Twelve seconds, not six. Fourteen 0.26m steps at 0.63m apiece is a lot of
// autostepping, and the climb runs at half walking pace.
const upTheStairs = await walkFrom(-4, 86, 0, 12.0);
check('the terrace stairs climb from the great court',
      upTheStairs.grounded && upTheStairs.y > 3.0 && upTheStairs.z < 66,
      `reached (${upTheStairs.x.toFixed(1)}, ${upTheStairs.y.toFixed(2)}, ${upTheStairs.z.toFixed(1)})`);

const atTheFacing = await walkFrom(-26, 90, 0, 6.0);
check('the terrace facing cannot be walked up',
      atTheFacing.y < 2.0,
      `stopped at y=${atTheFacing.y.toFixed(2)}, z=${atTheFacing.z.toFixed(1)}`);

// --- The gates are gates ---------------------------------------------------
// A gate is a hole in a wall. Built from its footprint alone it is a solid
// block, which seals the great court off from the outer one and turns the whole
// plan from a route into a picture. Walking through one is the only check that
// catches it.
const throughTaihemen = await walkFrom(-4, 152, 0, 6.0);
check('the Gate of Supreme Harmony can be walked through',
      throughTaihemen.grounded && throughTaihemen.z < 128,
      `reached z=${throughTaihemen.z.toFixed(1)}`);

// And the Meridian Gate leads out of the compound entirely, onto the road that
// rings the moat.
const throughWumen = await walkFrom(6, 200, Math.PI, 8.0);
check('the Meridian Gate leads out of the compound',
      throughWumen.grounded && throughWumen.z > 232,
      `reached z=${throughWumen.z.toFixed(1)}`);

// --- Containment -----------------------------------------------------------
// Sprint at each edge for long enough to cross the map, and confirm we are
// still inside it. The moat is the last thing between the player and the
// backdrop, and the backdrop has no ground under it.
const escapes = [];
for (const [name, x, z, yaw] of [
  ['north', 0, -150, 0], ['south', 0, 150, Math.PI],
  ['west', -120, 0, Math.PI / 2], ['east', 120, 0, -Math.PI / 2],
]) {
  await page.evaluate(({ x, z, yaw }) => {
    const { player, state } = window.__paintball;
    state.yaw = yaw;
    player.teleport(new (state.position.constructor)(x, 12, z));
  }, { x, z, yaw });
  await waitSim(2.0);
  await page.keyboard.down('w');
  await page.keyboard.down('Shift');
  await waitSim(9.0);
  await page.keyboard.up('w');
  await page.keyboard.up('Shift');
  await waitSim(0.4);
  const at = await read();
  // The containment stands three metres inside the ground mesh's edge, at
  // 237m east-west and 284m north-south. A couple of metres of slack covers the
  // capsule resting against it.
  const outside = Math.abs(at.x) > 236 || Math.abs(at.z) > 283 || at.y < -8;
  if (outside) escapes.push(`${name} -> (${at.x.toFixed(1)}, ${at.y.toFixed(1)}, ${at.z.toFixed(1)})`);
}
check('the moat contains the player on all four sides', escapes.length === 0,
      escapes.length ? escapes.join('; ') : 'no escapes');

// --- Paint sticks to the compound ------------------------------------------
// Fired at the Gate of Supreme Harmony from the great court, which is one of
// the merged district meshes rather than a prop — the case that would break if
// a collider were ever registered against a mesh it is not part of.
await page.evaluate(() => {
  const { player, state } = window.__paintball;
  state.yaw = Math.PI; state.pitch = -0.05;
  player.teleport(new (state.position.constructor)(0, 3, 120));
});
await waitSim(2.0);
const beforePaint = await page.evaluate(() => window.__paintball.paint.splatCount);
await page.mouse.down();
await waitSim(1.0);
await page.mouse.up();
await waitSim(1.6);
const afterPaint = await page.evaluate(() => window.__paintball.paint.splatCount);
check('paint sticks to arena geometry', afterPaint > beforePaint,
      `${beforePaint} -> ${afterPaint} splats`);

check('no console or page errors', consoleErrors.length === 0, consoleErrors[0] ?? 'clean');

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
