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
  // Inside the field, which is where a match is played — see CityLayout.FIELD.
  ['great court', 0, 110], ['court of the Gate of Supreme Harmony', 0, 160],
  ['on the great terrace', -0.8, 28.2], ['court of the Gate of Heavenly Purity', -3.7, -46.5],
  ['outer court, west', -50, 190], ['outer court, east', 55, 190],
  ['under the Meridian Gate', 0, 196],
  ['west flank', -72, 128], ['east flank', 68, 121],
  ['alley east of the terrace', 45, -18], ['alley west of the terrace', -47, -18],
  // And outside it. Nobody plays here, but the scenery still has to have ground
  // under it: a stray respawn or a spectator camera that falls through the world
  // is the same bug wherever it happens.
  ['Six Eastern Palaces', 62, -100], ['Imperial Garden', 34, -171],
  ['moat road, west', -180, 0],
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

// --- The dragon ramp is stone, not scenery ---------------------------------
// 御路石 runs up the middle of the great staircase between its two flights, and
// nobody has ever walked on it — it is carved. It was drawn and never collided,
// so the one object standing in the middle of the biggest stair on the map was
// something the player walked into and then stood inside.
const intoTheRamp = await walkFrom(-1.8, 86, 0, 8.0);
check('the carved ramp splits the terrace stairs',
      intoTheRamp.y < 1.2,
      `stopped at y=${intoTheRamp.y.toFixed(2)}, z=${intoTheRamp.z.toFixed(1)}`);

// --- The gates are gates ---------------------------------------------------
// A gate is a hole in a wall. Built from its footprint alone it is a solid
// block, which seals the great court off from the outer one and turns the whole
// plan from a route into a picture. Walking through one is the only check that
// catches it.
const throughTaihemen = await walkFrom(-4, 152, 0, 6.0);
check('the Gate of Supreme Harmony can be walked through',
      throughTaihemen.grounded && throughTaihemen.z < 128,
      `reached z=${throughTaihemen.z.toFixed(1)}`);

// --- The field is closed ----------------------------------------------------
// The match is bounded to the compound's central spine — the whole walled city
// is 140,000 square metres and nine players in that is nobody in it. Two thirds
// of the boundary is the palace itself; the rest is debris netting. Both have to
// hold, and the check is the same one: sprint at it and see where you end up.
const atTheGate = await walkFrom(6, 194, Math.PI, 8.0);
check('the Meridian Gate closes the south end of the field',
      atTheGate.grounded && atTheGate.z < 209,
      `reached z=${atTheGate.z.toFixed(1)}`);

const escapesField = [];
for (const [name, x, z, yaw] of [
  ['east', 60, 110, -Math.PI / 2], ['west', -60, 110, Math.PI / 2],
  ['north', 0, -40, 0], ['south-west', -60, 180, Math.PI],
]) {
  await page.evaluate(({ x, z, yaw }) => {
    const { player, state } = window.__paintball;
    state.yaw = yaw;
    player.teleport(new (state.position.constructor)(x, 2, z));
  }, { x, z, yaw });
  await waitSim(1.0);
  await page.keyboard.down('w');
  await page.keyboard.down('Shift');
  await waitSim(9.0);
  await page.keyboard.up('w');
  await page.keyboard.up('Shift');
  await waitSim(0.4);
  const at = await read();
  // A metre and a half of slack for the capsule resting against the netting.
  const out = at.x > 79.5 || at.x < -79.5 || at.z > 205.5 || at.z < -65.5;
  if (out) escapesField.push(`${name} -> (${at.x.toFixed(1)}, ${at.z.toFixed(1)})`);
}
check('the netting holds the player inside the field', escapesField.length === 0,
      escapesField.length ? escapesField.join('; ') : 'no escapes');

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

// --- The paintball course --------------------------------------------------
// The containers and scaffold towers trucked into the courtyards are the only
// cover on ninety metres of ceremonial brick, and the container is the one
// structure on the map with an inside. Both promises are worth checking by
// walking, because both are one arithmetic slip from a solid block: a doorway
// narrower than the player, or a stair whose first step is 1.35m.
const course = await page.evaluate(() => window.__paintball.course());
check('the course is set up in the courtyards', course.length >= 20,
      `${course.length} pieces`);

const container = course.find((piece) => piece.kind === 'container');
if (container) {
  // In through the door, which is at the far end from where this starts.
  // The door is at the far end of the long axis, so the approach is from
  // outside it walking back along that axis: yaw 0 is north, +PI/2 is west.
  const doorSide = container.alongX ? [container.x + 6, container.z] : [container.x, container.z + 6];
  const yaw = container.alongX ? Math.PI / 2 : 0;
  const inside = await walkFrom(doorSide[0], doorSide[1], yaw, 3.5);
  const dx = Math.abs(inside.x - container.x);
  const dz = Math.abs(inside.z - container.z);
  check('a player can get inside a container',
        inside.grounded && dx < (container.alongX ? 3.0 : 1.2)
        && dz < (container.alongX ? 1.2 : 3.0),
        `ended at (${inside.x.toFixed(1)}, ${inside.z.toFixed(1)}) ` +
        `against (${container.x.toFixed(1)}, ${container.z.toFixed(1)})`);
}

const tower = course.find((piece) => piece.kind === 'tower');
if (tower) {
  // Up the pallet stair, which climbs from the south.
  const onTop = await walkFrom(tower.x, tower.z + 6.2, 0, 7.0);
  check('the scaffold tower can be climbed',
        onTop.grounded && onTop.y > 1.5,
        `reached y=${onTop.y.toFixed(2)} at z=${onTop.z.toFixed(1)}`);
}

// --- The halls have insides -------------------------------------------------
// Seven of the buildings near the field are hollow: walls with doorways through
// them, a floor, a ceiling and a row of columns, rather than a solid block with
// a roof on it. Getting in means climbing the plinth — 0.9m, twice what a
// player can step onto — so the entrance steps are as much a part of this as the
// doorway is, and both are checked by walking at one.
// The Belvedere of Embodying Benevolence, on the east side of the great court.
// Its doorways are on the bays either side of centre, which is where the steps
// are: walking at the middle of a hall's front walks at the wall between two
// doors.
// Started close in, because the great court is furnished: a barricade or a
// stack of drums dealt into the courtyard between here and the steps is cover
// doing its job, and it would stop this walk for a reason that has nothing to
// do with the doorway being open.
const intoTheBelvedere = await walkFrom(42.6, 104.5, 0, 5.0);
check('a hall can be walked into',
      intoTheBelvedere.grounded && intoTheBelvedere.z < 100 && intoTheBelvedere.y > 0.7,
      `ended at (${intoTheBelvedere.x.toFixed(1)}, ${intoTheBelvedere.y.toFixed(2)}, ` +
      `${intoTheBelvedere.z.toFixed(1)})`);

// And its side wall is a wall. An interior open on every side is a canopy, and
// the thing that makes a hall worth being inside is that most of it stops paint.
const intoTheSide = await walkFrom(46.3, 88, -Math.PI / 2, 4.0);
check('a hall is walled at the sides',
      intoTheSide.x < 55,
      `reached x=${intoTheSide.x.toFixed(1)}`);

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

// --- including the imperial way --------------------------------------------
// The strip of pale stone down the axis is the longest, most-walked and
// most-shot-at line on the map, and it stood 12cm proud of the brick with no
// collider under it: balls went through it into the terrain, and a splat
// projected onto ground 12cm below the strip is a splat hidden by the strip.
// Fired straight down onto it, and the impact height is what says which of the
// two was hit.
await page.evaluate(() => {
  const { player, state } = window.__paintball;
  state.yaw = 0;
  state.pitch = -1.25;
  window.__paintball.impacts.length = 0;
  player.teleport(new (state.position.constructor)(-1.8, 2, 100));
});
await waitSim(1.5);
const beforeWay = await page.evaluate(() => window.__paintball.paint.placedCount);
await page.mouse.down();
await waitSim(0.2);
await page.mouse.up();
await waitSim(1.5);
const way = await page.evaluate(() => ({
  placed: window.__paintball.paint.placedCount,
  hits: window.__paintball.impacts.map((i) => i.y),
}));
check('the imperial way takes paint',
      way.placed > beforeWay && way.hits.some((y) => y > 0.08),
      `${way.placed - beforeWay} splats, impacts at y=${way.hits.map((y) => y.toFixed(2)).join(', ')}`);

// --- and it sticks to every surface, not most of them ----------------------
// The compound's geometry is merged by material — tile, timber, stone — and its
// colliders do not line up one-to-one with those meshes: a wall is a stone base
// with a red body and a tiled coping, and a hall is a stone plinth under a
// timber wall under a tiled roof. When a collider was registered against a
// single mesh, a hit anywhere on the other two found no triangles to project
// onto and the splat was quietly dropped, which looks exactly like a paintball
// that missed.
//
// So this fires in every direction from four places and asks a blunt question:
// did everything that hit the world leave a mark? Position-independent on
// purpose — it does not matter which surface is in front of the muzzle, only
// that whatever is takes paint.
await page.evaluate(() => { window.__paintball.impacts.length = 0; });
const before = await page.evaluate(() => ({
  placed: window.__paintball.paint.placedCount,
  impacts: window.__paintball.impacts.length,
}));
for (const [x, z] of [[0, 120], [-4, 40], [60, -100], [0, 196]]) {
  for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
    for (const pitch of [0.55, 0.15, -0.1]) {
      await page.evaluate(({ x, z, yaw, pitch }) => {
        const { player, state } = window.__paintball;
        state.yaw = yaw;
        state.pitch = pitch;
        player.teleport(new (state.position.constructor)(x, 2.2, z));
      }, { x, z, yaw, pitch });
      await waitSim(0.5);
      await page.mouse.down();
      await waitSim(0.12);
      await page.mouse.up();
      await waitSim(1.2);
    }
  }
}
const after = await page.evaluate(() => ({
  placed: window.__paintball.paint.placedCount,
  impacts: window.__paintball.impacts.length,
  high: window.__paintball.impacts.filter((i) => i.y > 5).length,
}));
const hits = after.impacts - before.impacts;
const painted = after.placed - before.placed;
check('every surface the ball hits takes paint',
      hits > 20 && painted >= hits * 0.95,
      `${painted}/${hits} hits painted, ${after.high} of them above 5m`);
// Firing up at 30 degrees from inside a courtyard is firing at roofs, and a
// roof that no ball ever reaches is a roof with no collider.
check('paintballs hit the roofs', after.high > 0, `${after.high} hits above 5m`);

check('no console or page errors', consoleErrors.length === 0, consoleErrors[0] ?? 'clean');

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
