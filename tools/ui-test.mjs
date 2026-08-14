/**
 * Headless UI and audio tests.
 *
 * The HUD is the only part of the game the player reads rather than plays, so
 * these check that it reflects real state rather than a copy of it. Audio is
 * checked for the thing that actually breaks in practice: browsers refuse to
 * start a context without a user gesture, and a context created too early
 * stays permanently suspended with no error.
 *
 * Usage: node tools/ui-test.mjs [url]
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
  // Deliberately NOT passing --autoplay-policy: the point is to prove audio
  // starts under the browser's real gesture requirement.
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

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

/** Advances the simulation by `seconds`, stepping it directly. */
async function waitSim(seconds) {
  await page.evaluate((s) => window.__paintball.stepSim(s), seconds);
}

// --- Audio must not start before a gesture ---------------------------------
const beforeGesture = await page.evaluate(() => window.__paintball.audio.engine.isReady);
check('audio stays silent before any user gesture', beforeGesture === false);

await page.mouse.click(512, 288);
await page.waitForTimeout(700);
const afterGesture = await page.evaluate(() => ({
  ready: window.__paintball.audio.engine.isReady,
  state: window.__paintball.audio.engine.ctx?.state ?? 'none',
}));
check('audio unlocks on the click that grants pointer lock',
      afterGesture.ready === true, `context state: ${afterGesture.state}`);

// --- HUD presence ----------------------------------------------------------
const present = await page.evaluate(() => ({
  hud: Boolean(document.querySelector('.hud')),
  splash: Boolean(document.querySelector('.splash-overlay')),
  crosshair: Boolean(document.querySelector('.hud__viewport-crosshair')),
  // The HUD must never swallow clicks, or pointer lock breaks.
  hudEvents: getComputedStyle(document.querySelector('.hud')).pointerEvents,
  splashEvents: getComputedStyle(document.querySelector('.splash-overlay')).pointerEvents,
}));
check('HUD, splash and the viewport crosshair exist',
      present.hud && present.splash && present.crosshair);
check('overlays do not intercept pointer events',
      present.hudEvents === 'none' && present.splashEvents === 'none',
      `hud=${present.hudEvents} splash=${present.splashEvents}`);

// --- Counters track character state ----------------------------------------
await page.evaluate(() => {
  const { game, state, characters } = window.__paintball;
  const V = state.position.constructor;
  const bot = characters.allBots[0];
  for (let i = 0; i < 3; i++) {
    bot.character.tickGameplay(5);
    game.events.emit('hit:character', {
      targetId: bot.id, shooterId: 'player', color: 0xff3d81,
      point: new V(bot.position.x, bot.position.y + 1.2, bot.position.z),
      normal: new V(0, 0, 1), impactSpeed: 32,
    });
  }
});
await waitSim(0.5);
const counters = await page.evaluate(() => ({
  shown: Number(document.querySelector('[data-given]').textContent),
  actual: window.__paintball.characters.playerCharacter.hitsGiven,
}));
check('the counter reflects the character, not a private tally',
      counters.shown === counters.actual && counters.shown >= 3,
      `shown ${counters.shown}, actual ${counters.actual}`);

// --- Lens splash on being tagged -------------------------------------------
await page.evaluate(() => {
  const { game, state, characters } = window.__paintball;
  const V = state.position.constructor;
  characters.playerCharacter.tickGameplay(5);
  const p = state.position;
  game.events.emit('hit:character', {
    targetId: 'player', shooterId: 'bot-a', color: 0x00d4e8,
    point: new V(p.x, p.y + 1.2, p.z - 0.2), normal: new V(0, 0, -1), impactSpeed: 34,
  });
});
const splashPixels = () => page.evaluate(() => {
  const c = document.querySelector('.splash-overlay');
  const ctx = c.getContext('2d');
  const { data } = ctx.getImageData(0, 0, c.width, c.height);
  let opaque = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] > 12) opaque++;
  return opaque;
});

const blobsQueued = await page.evaluate(() => window.__paintball.hud.lensSplash.blobCount);
check('being tagged queues lens paint', blobsQueued > 0, `${blobsQueued} blobs`);

// And it must actually reach the canvas, which the HUD repaints as the
// simulation advances.
await waitSim(0.3);
const afterHit = await splashPixels();
check('the splash renders to the canvas', afterHit > 0, `${afterHit} painted pixels`);

// It must also drip away rather than staying forever. Bots keep shooting, so
// retreat to a quiet corner first — otherwise fresh splashes keep arriving and
// the measurement never sees an empty lens.
await page.evaluate(() => {
  const { player, state, characters } = window.__paintball;
  const V = state.position.constructor;
  player.teleport(new V(-150, 3, -20));
  // And the bots to the far corner. The drip below is measured over five
  // simulated seconds, and a bot that finds the player inside that window puts
  // *new* blobs on the lens — the count comes back unchanged and the check
  // fails claiming paint never fades.
  for (const bot of characters.allBots) {
    bot.respawn(new V(bot.position.x + 260, bot.position.y, bot.position.z + 260));
  }
});
await waitSim(2.5);
await page.evaluate(() => {
  const { hud, state, game, characters } = window.__paintball;
  hud.lensSplash.clear();
  characters.playerCharacter.tickGameplay(5);
  const p = state.position;
  const V = p.constructor;
  game.events.emit('hit:character', {
    targetId: 'player', shooterId: 'bot-a', color: 0x00d4e8,
    point: new V(p.x, p.y + 1.2, p.z - 0.2), normal: new V(0, 0, -1), impactSpeed: 34,
  });
});
await waitSim(0.2);
const blobsAfterHit = await page.evaluate(() => window.__paintball.hud.lensSplash.blobCount);
await waitSim(5);
const blobsAfterDrip = await page.evaluate(() => window.__paintball.hud.lensSplash.blobCount);
check('lens paint drips away', blobsAfterHit > 0 && blobsAfterDrip < blobsAfterHit,
      `${blobsAfterHit} blobs -> ${blobsAfterDrip}`);

// --- Toast -----------------------------------------------------------------
const toastVisible = await page.evaluate(() => {
  const { game, state } = window.__paintball;
  const V = state.position.constructor;
  game.events.emit('hit:character', {
    targetId: 'bot-b', shooterId: 'player', color: 0xa8e337,
    point: new V(0, 1, 0), normal: new V(0, 0, 1), impactSpeed: 30,
  });
  return new Promise((r) => setTimeout(() =>
    r(document.querySelector('[data-toast]').classList.contains('is-visible')), 120));
});
check('landing a hit shows a toast', toastVisible === true);

// --- Scoreboard ------------------------------------------------------------
await page.keyboard.down('Tab');
await waitSim(0.35);
const board = await page.evaluate(() => ({
  visible: document.querySelector('[data-scoreboard]').classList.contains('is-visible'),
  rows: document.querySelectorAll('.hud__score-row').length,
  characters: window.__paintball.characters.allCharacters.length,
  sortedDescending: [...document.querySelectorAll('.hud__score-given')]
    .map((e) => Number(e.textContent))
    .every((v, i, a) => i === 0 || a[i - 1] >= v),
}));
await page.keyboard.up('Tab');
await waitSim(0.25);
const boardClosed = await page.evaluate(() =>
  document.querySelector('[data-scoreboard]').classList.contains('is-visible'));

check('Tab opens the scoreboard', board.visible === true);
check('the scoreboard lists every character', board.rows === board.characters,
      `${board.rows} rows for ${board.characters} characters`);
check('the scoreboard is ranked', board.sortedDescending === true);
check('releasing Tab closes it', boardClosed === false);

// --- Pointer lock survived it all ------------------------------------------
const stillLocked = await page.evaluate(() => window.__paintball.game.input.isLocked);
check('pointer lock survives Tab', stillLocked === true,
      'Tab would otherwise move focus and silently kill input');

// --- Pause -----------------------------------------------------------------
//
// Esc is not pressed here. Leaving a pointer lock is browser UI rather than a
// page event: headless Chrome ignores a synthetic Escape, and the real one is
// never delivered to the page at all. Both end in the same place — the lock is
// gone — which is what the pause actually keys off, so that is what is done.
const beforePause = await page.evaluate(() => window.__paintball.match.timeLeft);
await page.evaluate(() => document.exitPointerLock());
await page.waitForTimeout(300);
const paused = await page.evaluate(() => ({
  phase: window.__paintball.match.phase,
  card: document.querySelector('.pause')?.classList.contains('is-visible'),
  clock: document.querySelector('[data-pause-clock]')?.textContent,
  // The card has to take clicks; every other overlay must not.
  events: getComputedStyle(document.querySelector('.pause')).pointerEvents,
  hintHidden: document.querySelector('[data-hint]').classList.contains('is-hidden'),
}));
check('losing the pointer mid-round raises the pause card',
      paused.phase === 'paused' && paused.card === true,
      `phase=${paused.phase} card=${paused.card}`);
check('the pause card takes clicks', paused.events === 'auto', paused.events);
check('the pause card shows the clock it stopped', /^\d:\d\d$/.test(paused.clock ?? ''),
      paused.clock);
check('the HUD hint stays down behind the card', paused.hintHidden === true);

// The whole point: a pause has to actually stop the round.
await waitSim(5);
const heldFor = await page.evaluate(() => window.__paintball.match.timeLeft);
check('the clock does not run while paused', heldFor === beforePause,
      `${beforePause.toFixed(2)}s -> ${heldFor.toFixed(2)}s over 5 simulated seconds`);

// The repo link is the one thing on the card that must not resume — grabbing
// the pointer as a new tab opens would be a small hostage situation.
// A pointerdown, because that is what the card listens for — see the note on
// PauseOverlay.onPointerDown. A synthetic click would sail past the guard
// without ever touching it.
await page.evaluate(() => {
  const link = document.querySelector('.pause .fork-badge');
  link.removeAttribute('href');
  link.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
});
await page.waitForTimeout(150);
check('the repo link does not resume the round',
      (await page.evaluate(() => window.__paintball.match.phase)) === 'paused');

// Clear of the second or so in which a browser refuses a lock after Esc.
await page.waitForTimeout(1600);
await page.click('[data-pause-resume]');
await page.waitForTimeout(500);
const resumed = await page.evaluate(() => ({
  phase: window.__paintball.match.phase,
  locked: window.__paintball.game.input.isLocked,
  card: document.querySelector('.pause').classList.contains('is-visible'),
}));
check('clicking the card gives the pointer back and restarts the clock',
      resumed.phase === 'playing' && resumed.locked === true && resumed.card === false,
      `phase=${resumed.phase} locked=${resumed.locked} card=${resumed.card}`);
await waitSim(2);
const afterResume = await page.evaluate(() => window.__paintball.match.timeLeft);
check('the round runs again once resumed', afterResume < heldFor,
      `${heldFor.toFixed(2)}s -> ${afterResume.toFixed(2)}s`);

check('no console or page errors', consoleErrors.length === 0, consoleErrors[0] ?? 'clean');

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
