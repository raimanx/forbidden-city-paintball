/**
 * Headless tests for the match economy: finite paint, and the crate that tops
 * it up.
 *
 * Runs against the *compound*, not the test course — the course is deliberately a
 * sandbox with unlimited paint and no crate, which is the first thing asserted
 * here.
 *
 * Usage: node tools/match-test.mjs [url]
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
  args: [
    '--enable-unsafe-swiftshader',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--disable-dev-shm-usage',
  ],
});
const page = await browser.newPage({ viewport: { width: 1024, height: 576 } });
const consoleErrors = [];
page.on('pageerror', (e) => consoleErrors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

/** Claims the sim clock before boot starts the loop. See Game.stepSim. */
async function openManual(target) {
  await page.goto(target, { waitUntil: 'load' });
  await page.waitForFunction(() => Boolean(window.__paintball), { timeout: 30_000 });
  await page.evaluate(() => {
    if (!window.__paintball.setManualSim) {
      throw new Error('this build predates the sim step hook — rebuild it');
    }
    window.__paintball.setManualSim(true);
  });
  await page.waitForFunction(() => window.__paintball && !document.querySelector('#loader'), {
    timeout: 30_000,
  });
}

/**
 * Clicks until the canvas has pointer lock, which fire input needs.
 *
 * Retried rather than clicked once, because Chrome refuses a lock request that
 * comes too soon after the previous lock ended — and navigating away from a
 * locked page ends one. A single click plus a fixed wait passes on the first
 * page of a run and silently swallows every shot on the second.
 */
async function lockPointer(what) {
  for (let attempt = 0; attempt < 5; attempt++) {
    await page.mouse.click(512, 288);
    await page.waitForTimeout(500);
    if (await page.evaluate(() => window.__paintball.game.input.isLocked)) return;
  }
  console.error(`FATAL: pointer lock was not granted on ${what}; fire input cannot be tested`);
  await browser.close();
  process.exit(1);
}

await openManual(url);
await lockPointer('the compound');

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const stepSim = (seconds) => page.evaluate((s) => window.__paintball.stepSim(s), seconds);
const playerAmmo = () => page.evaluate(() => window.__paintball.match.ammo.get('player'));

/**
 * Parks the player somewhere quiet before measuring.
 *
 * The bots are live and shooting throughout, so a measurement taken in the
 * middle of the plaza has six other people spending paint into it.
 */
async function retreat() {
  await page.evaluate(() => {
    const { player, state } = window.__paintball;
    player.teleport(new (state.position.constructor)(-150, 3, -20));
    state.pitch = -0.1;
  });
  await stepSim(0.4);
}

// Where everybody stands before a shot has been fired. Kept for the restart
// check at the bottom: a second round that leaves seven people wherever the
// whistle caught them is not a second round.
const spawnPositions = await page.evaluate(() =>
  Object.fromEntries(window.__paintball.characters.allBots
    .map((b) => [b.id, [b.position.x, b.position.z]])
    .concat([['player', [window.__paintball.state.position.x,
                         window.__paintball.state.position.z]]])));

// --- Everyone starts with a finite load ------------------------------------
const start = await page.evaluate(() => ({
  entries: [...window.__paintball.match.ammo.entries()],
  sandbox: window.__paintball.match.sandbox,
}));
check('the compound is not a sandbox', start.sandbox === false);
check(
  'every character starts with the same finite load',
  start.entries.length === 9 && start.entries.every(([, n]) => n === 100),
  start.entries.map(([id, n]) => `${id}:${n}`).join(' '),
);

// --- Firing spends it ------------------------------------------------------
await retreat();
const beforeBurst = await playerAmmo();
await page.mouse.down();
await stepSim(1.0);
await page.mouse.up();
await stepSim(0.2);
const afterBurst = await playerAmmo();
const spent = beforeBurst - afterBurst;
// 1.0s at a 0.14s interval is 7 shots, give or take where the cooldown lands.
check('firing spends paint', spent >= 6 && spent <= 8, `${spent} rounds for 1.0s of fire`);

// --- The HUD shows the real number, not a copy -----------------------------
const shown = await page.evaluate(() =>
  Number(document.querySelector('[data-ammo]').textContent));
check('the HUD ammo counter matches the match state', shown === afterBurst,
      `shown ${shown}, actual ${afterBurst}`);

// --- Empty means empty -----------------------------------------------------
await page.evaluate(() => {
  window.__paintball.match.ammo.set('player', 2);
  window.__dry = 0;
  window.__paintball.game.events.on('weapon:dry', () => { window.__dry++; });
});
await retreat();
await page.mouse.down();
await stepSim(1.2);
const emptied = await playerAmmo();
await page.mouse.up();
await stepSim(0.1);
check('the marker stops at zero rather than going negative', emptied === 0, `${emptied} left`);

const dryCount = await page.evaluate(() => window.__dry);
// One click per trigger pull, not one per fire interval — the whole point of
// the latch in WeaponSystem. 1.2s of held trigger past empty is ~8 intervals.
check('an empty marker clicks once per trigger pull', dryCount === 1, `${dryCount} dry events`);

// A second pull is a second click.
await page.mouse.down();
await stepSim(0.3);
await page.mouse.up();
await stepSim(0.1);
const dryAfterTwo = await page.evaluate(() => window.__dry);
check('a second pull clicks again', dryAfterTwo === 2, `${dryAfterTwo} dry events after two pulls`);

// --- The crate ------------------------------------------------------------
const crate = await page.evaluate(() => {
  const { loot } = window.__paintball;
  return loot.position
    ? { x: loot.position.x, y: loot.position.y, z: loot.position.z, rounds: loot.rounds }
    : null;
});
check('a crate is out there', crate !== null && crate.rounds === 20,
      crate ? `${crate.rounds} rounds at ${crate.x.toFixed(0)},${crate.z.toFixed(0)}` : 'none');

// It must be somewhere a bot could also reach, or the round-end rule can stall.
const reachable = await page.evaluate(() => {
  const { characters, loot } = window.__paintball;
  const nav = characters.navGrid;
  return nav && loot.position ? nav.isWalkable(loot.position.x, loot.position.z) : false;
});
check('the crate sits on walkable ground', reachable === true);

if (crate) {
  const ammoBefore = await playerAmmo();
  await page.evaluate(({ x, y, z }) => {
    const { player, state } = window.__paintball;
    player.teleport(new (state.position.constructor)(x, y + 1, z));
  }, crate);
  await stepSim(0.5);
  const ammoAfter = await playerAmmo();
  check('walking into the crate grants its paint', ammoAfter === ammoBefore + 20,
        `${ammoBefore} -> ${ammoAfter}`);

  const gone = await page.evaluate(() => window.__paintball.loot.position === null);
  check('a taken crate leaves the world', gone === true);

  // Standing on the empty spot must not keep granting paint.
  await stepSim(1.0);
  const ammoLater = await playerAmmo();
  check('the crate can only be taken once', ammoLater === ammoAfter, `${ammoLater} rounds`);
}

// --- A dry bot goes and gets more -----------------------------------------
// The path bots take to a crate is the riskiest new behaviour here: a navgrid
// path ends on a 2m cell centre, which is not necessarily inside the 1.4m
// pickup radius, so the last stretch is walked by hand.
await page.evaluate(() => {
  const { lootSystem } = window.__paintball;
  lootSystem.respawn();
});
const restock = await page.evaluate(() => {
  const { characters, game, loot, match, player, state } = window.__paintball;
  const bot = characters.allBots[0];
  const nav = characters.navGrid;
  // Empty it, and stand it a short walk from the crate — inside the range at
  // which it is allowed to notice one, but well outside grabbing distance.
  match.ammo.set(bot.id, 0);
  const from = nav.nearestWalkable(loot.position.x + 9, loot.position.z + 3)
    ?? nav.nearestWalkable(loot.position.x - 9, loot.position.z);
  bot.position.copy(from);
  // Keep the player out of it, so the player cannot take the crate first.
  player.teleport(new (state.position.constructor)(-150, 3, -20));
  // Watched as an event, not as a final ammo count: a bot that restocks then
  // finds someone to shoot at will have spent some of it by the time we look.
  window.__taker = null;
  game.events.on('loot:taken', ({ characterId }) => { window.__taker = characterId; });
  return { id: bot.id, distance: bot.position.distanceTo(loot.position) };
});
await stepSim(12);
const restocked = await page.evaluate(() => ({
  taker: window.__taker,
  crateGone: window.__paintball.loot.position === null,
}));
check('a bot out of paint walks to the crate and takes it',
      restocked.taker === restock.id && restocked.crateGone,
      `${restock.id} started 0 rounds and ${restock.distance.toFixed(1)}m away;` +
        ` crate taken by ${restocked.taker ?? 'nobody'}`);

// --- ...and gives up on one it cannot reach -------------------------------
// A crate the navgrid cannot route to used to mean a bot repathing every single
// step, forever, because an exhausted path was itself the repath trigger.
const stranded = await page.evaluate(() => {
  const { characters, loot, match } = window.__paintball;
  const bot = characters.allBots[1];
  match.ammo.set(bot.id, 0);
  // Out in the middle of the lake: inside noticing range, and unwalkable, so no
  // path to it exists.
  const V = bot.position.constructor;
  loot.position = new V(bot.position.x, bot.position.y, bot.position.z - 14);
  loot.rounds = 20;
  const nav = characters.navGrid;
  return {
    id: bot.id,
    reachable: nav.isWalkable(loot.position.x, loot.position.z),
  };
});
await stepSim(3);
const whileTrying = await page.evaluate((id) =>
  window.__paintball.characters.allBots.find((b) => b.id === id).state, stranded.id);
await stepSim(16);
const afterGivingUp = await page.evaluate((id) =>
  window.__paintball.characters.allBots.find((b) => b.id === id).state, stranded.id);
check('a bot gives up on a crate it cannot reach',
      afterGivingUp !== 'restock',
      `${stranded.id} went "${whileTrying}" then "${afterGivingUp}"` +
        `${stranded.reachable ? ' (warning: the decoy spot was walkable)' : ''}`);

// --- The round has a clock ------------------------------------------------
// Driven by moving `timeLeft` rather than by stepping five minutes of
// simulation: the rule under test is "counts down, warns, then ends", and
// 18,000 fixed steps would prove nothing extra at a hundred times the cost.
const clockStart = await page.evaluate(() => {
  const { match } = window.__paintball;
  match.timeLeft = 120;
  return match.timeLeft;
});
await stepSim(2);
const ticked = await page.evaluate(() => ({
  left: window.__paintball.match.timeLeft,
  shown: document.querySelector('[data-clock]').textContent,
}));
check('the clock counts down in simulated time',
      Math.abs(clockStart - ticked.left - 2) < 0.1,
      `${clockStart}s -> ${ticked.left.toFixed(2)}s`);

// Checked from a deliberately non-integer time. 120 steps of 1/60 do not sum to
// exactly 2, so `timeLeft` lands a hair above 118 and the displayed value —
// rounded up, so the clock never reads 0:00 while there is still time — is
// legitimately either 1:58 or 1:59. Asserting the format at 95.4s has one answer.
await page.evaluate(() => { window.__paintball.match.timeLeft = 95.4; });
await stepSim(1 / 60);
const format = await page.evaluate(() => document.querySelector('[data-clock]').textContent);
check('the HUD clock reads m:ss', format === '1:36', `95.4s left shows "${format}"`);

// --- ...and warns before it runs out --------------------------------------
await page.evaluate(() => {
  window.__warned = [];
  window.__paintball.game.events.on('match:warning', ({ secondsLeft }) => {
    window.__warned.push(secondsLeft);
  });
  window.__paintball.match.timeLeft = 61;
});
await stepSim(2);
const warned = await page.evaluate(() => window.__warned);
check('a warning goes out once at the one-minute mark',
      warned.length === 1 && warned[0] === 60, `warnings: ${JSON.stringify(warned)}`);

// --- Time up ends the round ----------------------------------------------
// Paint the player first, while hits still count, so the restart below has
// something to prove it wiped.
const wornBefore = await page.evaluate(() => {
  const { characters, game, state } = window.__paintball;
  const player = characters.playerCharacter;
  player.tickGameplay(5);
  const p = state.position;
  const V = p.constructor;
  game.events.emit('hit:character', {
    targetId: 'player', shooterId: 'bot-a', color: 0x00d4e8,
    point: new V(p.x, p.y + 1.2, p.z - 0.2), normal: new V(0, 0, -1), impactSpeed: 34,
  });
  return player.paint.splatCount;
});
check('the player wears the paint they were tagged with', wornBefore > 0,
      `${wornBefore} splats`);

await page.evaluate(() => {
  window.__ended = null;
  window.__paintball.game.events.on('match:ended', (e) => {
    window.__ended = e;
    // Read here, not later: the line-up turns continuously once it is up, so
    // "faces the camera" is only an invariant at the moment it is presented.
    // Registered after ResultsSystem's own handler, so the stage is already set.
    window.__facingAtPresent =
      window.__paintball.characters.playerCharacter.rig.root.rotation.y;
  });
  window.__paintball.match.timeLeft = 0.5;
});
await stepSim(1.5);
const ended = await page.evaluate(() => ({
  event: window.__ended,
  phase: window.__paintball.match.phase,
  endedBy: window.__paintball.match.endedBy,
  cardVisible: document.querySelector('.results').classList.contains('is-visible'),
  rows: document.querySelectorAll('.results__row').length,
  awards: [...document.querySelectorAll('.results__award-label')].map((e) => e.textContent),
  // The line-up takes the characters out of the world and stands them on the
  // stage, so their rigs must no longer be parented into the game scene.
  onStage: window.__paintball.characters.allCharacters
    .filter((c) => c.rig.root.parent !== window.__paintball.game.render.scene).length,
  facing: +window.__facingAtPresent.toFixed(3),
  locked: window.__paintball.game.input.isLocked,
  clock: document.querySelector('[data-clock]').textContent,
}));
check('running out of time ends the round',
      ended.phase === 'ended' && ended.endedBy === 'time' && ended.event?.reason === 'time',
      `phase=${ended.phase} by=${ended.endedBy}`);
check('the results card is shown, with everyone on it',
      ended.cardVisible && ended.rows === 9, `${ended.rows} rows`);
check('every character is taken out of the world and onto the stage',
      ended.onStage === 9, `${ended.onStage}/9 reparented`);
// Facing -Z, camera at +Z: a line-up at rotation 0 presents its back, and every
// splat on a chest is hidden behind the character wearing it.
check('the line-up starts facing the camera', Math.abs(ended.facing - Math.PI) < 0.001,
      `rotation.y = ${ended.facing}`);
check('the awards are handed out',
      ended.awards.includes('sharpshooter') && ended.awards.includes('cleanest'),
      ended.awards.join(', ') || 'none');
check('the clock stops at 0:00', ended.clock === '0:00', `shows "${ended.clock}"`);
check('the cursor is handed back so the board can be read', ended.locked === false);

// --- Nothing counts after the whistle ------------------------------------
const frozen = await page.evaluate(() => {
  const { characters, game, match, state } = window.__paintball;
  const before = characters.playerCharacter.hitsGiven;
  const bot = characters.allBots[0];
  const takenBefore = bot.character.hitsTaken;
  match.ammo.set('player', 50);
  const V = state.position.constructor;
  // A hit event that would have scored during play.
  bot.character.tickGameplay(5);
  game.events.emit('hit:character', {
    targetId: bot.id, shooterId: 'player', color: 0xff3d81,
    point: new V(bot.position.x, bot.position.y + 1.2, bot.position.z),
    normal: new V(0, 0, 1), impactSpeed: 34,
  });
  return { before, takenBefore, after: characters.playerCharacter.hitsGiven,
           takenAfter: bot.character.hitsTaken };
});
check('hits stop scoring once the round is over',
      frozen.after === frozen.before && frozen.takenAfter === frozen.takenBefore,
      `given ${frozen.before}->${frozen.after}, taken ${frozen.takenBefore}->${frozen.takenAfter}`);

const ammoBeforeIdle = await playerAmmo();
await page.mouse.down();
await stepSim(1.0);
await page.mouse.up();
const ammoAfterIdle = await playerAmmo();
check('the trigger does nothing once the round is over',
      ammoAfterIdle === ammoBeforeIdle, `${ammoBeforeIdle} -> ${ammoAfterIdle}`);

// --- Clicking starts another round ---------------------------------------
// Read with no simulation stepped in between, on purpose: the reset happens
// synchronously in the lock handler, and half a second of live play is half a
// second in which a bot can tag the player and put paint straight back on.
await page.mouse.click(512, 288);
await page.waitForTimeout(400);
const restarted = await page.evaluate(() => ({
  phase: window.__paintball.match.phase,
  timeLeft: window.__paintball.match.timeLeft,
  ammo: window.__paintball.match.ammo.get('player'),
  given: window.__paintball.characters.playerCharacter.hitsGiven,
  splats: window.__paintball.characters.playerCharacter.paint.splatCount,
  crate: window.__paintball.loot.position !== null,
  cardVisible: document.querySelector('.results').classList.contains('is-visible'),
  inWorld: window.__paintball.characters.allCharacters
    .filter((c) => c.rig.root.parent === window.__paintball.game.render.scene).length,
}));
check('clicking after the whistle starts a fresh round',
      restarted.phase === 'playing' && restarted.timeLeft > 290,
      `phase=${restarted.phase} clock=${restarted.timeLeft.toFixed(0)}s`);
check('a fresh round refills, rescores and puts out a new crate',
      restarted.ammo === 100 && restarted.given === 0 && restarted.splats === 0 && restarted.crate,
      `ammo ${restarted.ammo}, given ${restarted.given}, splats ${restarted.splats},` +
        ` crate ${restarted.crate}`);
check('the results card is put away', restarted.cardVisible === false);
check('the characters go back into the world',
      restarted.inWorld === 9, `${restarted.inWorld}/9 back in the world`);

// --- and back to where they started ----------------------------------------
const displaced = await page.evaluate((spawns) => {
  const { characters, state } = window.__paintball;
  const now = { player: [state.position.x, state.position.z] };
  for (const bot of characters.allBots) now[bot.id] = [bot.position.x, bot.position.z];
  return Object.entries(spawns).map(([id, [x, z]]) => ({
    id, away: +Math.hypot(now[id][0] - x, now[id][1] - z).toFixed(1),
  }));
}, spawnPositions);
const strays = displaced.filter((d) => d.away > 2.5);
check('everyone is back at their spawn for the new round', strays.length === 0,
      displaced.map((d) => `${d.id}:${d.away}m`).join(' '));

// --- The other ending: the last paintball in the compound ----------------
await page.evaluate(() => {
  const { loot, match } = window.__paintball;
  window.__ended = null;
  for (const id of match.ammo.keys()) match.ammo.set(id, 0);
  // Somebody has already taken the crate; its rounds no longer count.
  loot.position = null;
  loot.rounds = 0;
});
await stepSim(1.0);
const ranDry = await page.evaluate(() => ({
  phase: window.__paintball.match.phase,
  endedBy: window.__paintball.match.endedBy,
  timeLeft: window.__paintball.match.timeLeft,
}));
check('running out of paint ends the round early',
      ranDry.phase === 'ended' && ranDry.endedBy === 'ammo',
      `phase=${ranDry.phase} by=${ranDry.endedBy} with ${ranDry.timeLeft.toFixed(0)}s left`);

// A crate still out there means the paint is not gone, only put down.
await page.mouse.click(512, 288);
await page.waitForTimeout(400);
await stepSim(0.5);
const withCrateOut = await page.evaluate(() => {
  const { loot, match } = window.__paintball;
  for (const id of match.ammo.keys()) match.ammo.set(id, 0);
  return { crate: loot.position !== null, phase: match.phase };
});
await stepSim(1.0);
const stillPlaying = await page.evaluate(() => window.__paintball.match.phase);
check('an unclaimed crate keeps the round alive',
      withCrateOut.crate === true && stillPlaying === 'playing',
      `crate out: ${withCrateOut.crate}, phase after: ${stillPlaying}`);

check('no console or page errors', consoleErrors.length === 0, consoleErrors[0] ?? 'clean');

// --- The test course stays a sandbox ---------------------------------------
consoleErrors.length = 0;
await openManual(`${url}?scene=course`);
const sandbox = await page.evaluate(() => ({
  sandbox: window.__paintball.match.sandbox,
  crate: window.__paintball.loot.position,
  shown: document.querySelector('[data-ammo]').textContent,
}));
check('the test course is a sandbox', sandbox.sandbox === true);
check('the sandbox has no crate to find', sandbox.crate === null);

await lockPointer('the test course');
await page.mouse.down();
await stepSim(1.0);
await page.mouse.up();
const sandboxShots = await page.evaluate(() =>
  window.__paintball.impacts.filter((i) => i.shooterId === 'player').length);
check('the sandbox never runs out', sandboxShots > 0, `${sandboxShots} impacts`);
check('the sandbox HUD reads as unlimited', sandbox.shown === '∞', `shows "${sandbox.shown}"`);

check('no console or page errors on the course', consoleErrors.length === 0,
      consoleErrors[0] ?? 'clean');

await browser.close();

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
