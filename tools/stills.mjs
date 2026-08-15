/**
 * Marketing stills.
 *
 * Distinct from `tools/capture.mjs`, which exists to *measure* the look and
 * whose shot list is pinned so two passes can be compared. These are chosen to
 * sell it: framed wide, shot at 2x resolution and saved as PNG, so they hold up
 * on a store page or a press kit rather than in a metrics table.
 *
 * A still is not just a paused frame. Each shot below sets its scene first —
 * puts the fight where it can be seen, gets paint onto a body, waits out the
 * camera's spring arm — and only then keeps a frame. The scene is driven
 * through the same manual-step mode `tools/record.mjs` uses, so a shot lands on
 * exactly the moment it was aimed at instead of whenever the screenshot came
 * back.
 *
 * Usage: node tools/stills.mjs [--out DIR] [--scale N] [--url URL]
 */
import { chromium } from 'playwright-core';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};

const OUT = opt('out', 'captures/press');
// 2x of 1280x720. Shooting at 2560x1440 and letting the publisher downscale is
// what keeps the ink lines crisp — this renderer's edge pass is a screen-space
// effect, so a still shot at final size has lines a pixel wide that turn to
// mush the moment anything resizes it.
const SCALE = Number(opt('scale', 2));
const URL = opt('url', 'http://localhost:4173/');
const WIDTH = 1280 * SCALE;
const HEIGHT = 720 * SCALE;

/**
 * The shot list.
 *
 * `settle` is simulated seconds to run before the frame is kept — long enough
 * for the drop to land and the spring arm to stop easing, and for the moat to
 * be mid-ripple rather than at its rest pose.
 */
const SHOTS = [
  {
    // From the middle of the great court, looking north at the terrace with the
    // Hall of Supreme Harmony standing on it. The postcard view of the place.
    name: '01-great-court',
    caption: 'The Hall of Supreme Harmony across the great court',
    at: { x: 0, z: 110, yaw: 0.0, pitch: 0.02 },
    settle: 3.0,
  },
  {
    // Looking back south at the Gate of Supreme Harmony: three archways, a
    // double eave, and the bracket course under it.
    name: '02-gate-of-supreme-harmony',
    caption: 'The Gate of Supreme Harmony',
    at: { x: 0, z: 118, yaw: Math.PI, pitch: 0.08 },
    settle: 3.0,
  },
  {
    // Low on the stair, looking up the marble at the hall standing over it.
    // The only shot in the set with any elevation in it, and the one that
    // shows the terrace is high ground rather than a step.
    name: '03-great-stair',
    caption: 'The stair up to the Hall of Supreme Harmony',
    at: { x: 0, z: 74, yaw: 0, pitch: 0.10 },
    settle: 3.0,
  },
  {
    // Standing *on* the terrace, looking back south over the outer court.
    //
    // It used to stand at z=28 facing north, which is a metre from the back
    // wall of the great hall: the frame was two thirds flat maroon. The hall
    // is not photographable from its own doorstep — the shot that sells the
    // terrace is the one looking off it, over every roof in the outer court.
    name: '04-on-the-terrace',
    caption: 'On the marble terrace, over the roofs of the outer court',
    at: { x: 0, z: 55, yaw: Math.PI, pitch: 0.02 },
    settle: 3.0,
  },
  {
    // The alleys between the walled quarters: red wall, gold coping, and a
    // three-metre gap. The best close-quarters ground on the map.
    name: '05-six-palaces',
    caption: 'The alleys of the Six Eastern Palaces',
    at: { x: 62, z: -100, yaw: 1.57, pitch: 0.0 },
    settle: 3.0,
  },
  {
    name: '06-meridian-gate',
    caption: 'Under the Meridian Gate',
    at: { x: 0, z: 190, yaw: Math.PI, pitch: 0.16 },
    settle: 3.0,
  },
  {
    // The money shot: a target covered in paint, at fighting range, mid-burst.
    name: '07-firefight',
    caption: 'Tagging a bot in the great court',
    duel: { player: [0, 112], bot: [0, 107] },
    settle: 1.2,
    // Fire for a moment so the burst is in the air and the splats have landed.
    burst: 1.1,
  },
  {
    // Open courtyard rather than the shade under an eave: the subject is the
    // paint, and paint in shadow reads as a dark patch.
    name: '08-painted-bot',
    caption: 'Nobody dies. Hits are counters, and paint.',
    // Closer than the firefight shot. The subject is the splats on the body,
    // and the aimed camera sits 2.2m behind the player's own shoulder — at six
    // metres the target is a third the size of the head in front of it.
    duel: { player: [-20, 112], bot: [-20, 108] },
    settle: 1.0,
    // Painted rather than shot at — see the director's `paintTarget`.
    paint: 16,
    // Long enough for the flinch the hits trigger to play out, with the
    // trigger off so the frame is the painted body rather than a muzzle flash.
    after: 0.9,
  },
  {
    name: '09-results',
    caption: 'End of round',
    finale: true,
  },
];

const EXECUTABLE =
  process.env.CHROME_PATH ??
  ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(existsSync);
if (!EXECUTABLE) throw new Error('No system Chrome found. Set CHROME_PATH.');

const browser = await chromium.launch({
  executablePath: EXECUTABLE,
  args: [
    '--use-angle=vulkan', '--enable-gpu', '--ignore-gpu-blocklist',
    '--enable-unsafe-swiftshader', '--disable-dev-shm-usage', '--hide-scrollbars',
  ],
});
const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

mkdirSync(OUT, { recursive: true });
console.log(`stills ${WIDTH}x${HEIGHT} -> ${OUT}/\n`);

await page.goto(URL, { waitUntil: 'load' });
await page.waitForFunction(() => window.__paintball && !document.querySelector('#loader'),
                           { timeout: 120_000 });

// Same director the recorder installs, for the same reasons — see its header.
await page.addScriptTag({ path: 'tools/director.js' });
await page.evaluate(() => {
  window.__paintball.game.events.emit('input:lockChanged', { locked: true });
  window.__paintball.setManualSim(true);
});

for (const shot of SHOTS) {
  if (shot.at) {
    const { x, z, yaw, pitch } = shot.at;
    await page.evaluate(([x, z, yaw, pitch]) =>
      window.__director.teleport(x, 8, z, yaw, pitch), [x, z, yaw, pitch]);
    // Nobody else in the postcard. The scenery shots are about the park.
    await page.evaluate(() => window.__director.clearField());
  }

  // Aimed throughout, so the camera is over the shoulder with a tight reticle,
  // and tracking throughout, so the target stays framed while it settles.
  const TRACK = { aim: true, track: { damping: 8, aimHeight: 1.0, bias: 0.08 } };

  if (shot.duel) {
    const { player: p, bot: b } = shot.duel;
    const args = [p[0], p[1], b[0], b[1]];
    await page.evaluate(([px, pz, bx, bz]) => window.__director.stage(px, pz, bx, bz), args);
    // Settle, re-stage, pin. The drop takes a moment to land and the bot walks
    // the whole time — the first version of these shots staged at six metres
    // and photographed a figure fourteen metres away, because the range was
    // measured before anybody had stopped moving.
    await page.evaluate((c) => window.__director.frame(c, 0.9), TRACK);
    await page.evaluate(([px, pz, bx, bz]) => window.__director.stage(px, pz, bx, bz), args);
    await page.evaluate(() => window.__director.pin(window.__director.target));
  }

  if (shot.finale) await finale(page);
  else {
    await run(shot.duel ? TRACK : { move: [0, 0] }, shot.settle, !!shot.duel);
    if (shot.burst) await run({ ...TRACK, fire: true }, shot.burst, true);
    if (shot.paint) await page.evaluate((n) => window.__director.paintTarget(n), shot.paint);
    // A beat with the trigger off, so the frame is the painted body rather
    // than the muzzle flash in front of it.
    if (shot.after) await run(TRACK, shot.after, true);
  }

  await page.screenshot({ path: join(OUT, `${shot.name}.png`) });
  console.log(`  ${shot.name.padEnd(20)} ${shot.caption}`);
}

await browser.close();
console.log(`\n${SHOTS.length} stills in ${OUT}/`);
if (errors.length) console.log(`page errors: ${errors.length}\n  ${errors.slice(0, 5).join('\n  ')}`);

/**
 * Runs the sim for `seconds`, optionally re-pinning the target as it goes.
 *
 * Stepping in short chunks with a pin between them is what keeps a staged
 * range honest. Pinning once at the top is not enough: a still takes three or
 * four simulated seconds to set up, and a bot with a charging personality
 * covers ten metres in that time — which is how the first pass at the painted
 * close-up came back with the target a dozen metres away and two pixels tall.
 */
async function run(cmd, seconds, hold) {
  const CHUNK = 0.3;
  for (let done = 0; done < seconds; done += CHUNK) {
    const step = Math.min(CHUNK, seconds - done);
    if (hold) await page.evaluate(() => window.__director.pin(window.__director.target));
    await page.evaluate(([c, s]) => window.__director.frame(c, s), [cmd, step]);
  }
}

/** Dresses the line-up and runs the clock out. See record.mjs's `setUpFinale`. */
async function finale(page) {
  await page.evaluate(() => {
    const { game, match, characters, state } = window.__paintball;
    const V = state.position.constructor;
    for (const bot of characters.allBots) {
      for (let i = 0; i < 7; i++) {
        const angle = i * 0.9;
        bot.character.tickGameplay(5);
        game.events.emit('hit:character', {
          targetId: bot.id,
          shooterId: 'player',
          color: [0xff3d81, 0xa8e337, 0x00d4e8][i % 3],
          point: new V(bot.position.x + Math.sin(angle) * 0.35,
                       bot.position.y + 0.85 + (i % 3) * 0.32,
                       bot.position.z + Math.cos(angle) * 0.35),
          normal: new V(Math.sin(angle), 0, Math.cos(angle)),
          impactSpeed: 40,
        });
      }
    }
    // Scores go on *after* the paint, not before.
    //
    // Every splat above is emitted with `shooterId: 'player'`, and the match
    // credits each one — dressing the line-up first meant the seven-a-side
    // table was immediately overwritten by 12 + 56, and the end card went out
    // reading "you — 68 tagged" against a best bot score of nine.
    characters.allCharacters.forEach((character, index) => {
      character.hitsGiven = [12, 9, 8, 7, 5, 4, 3][index] ?? 4;
      character.hitsTaken = [3, 5, 6, 6, 8, 9, 11][index] ?? 6;
    });
    match.timeLeft = 0.2;
  });
  await page.evaluate(() => window.__director.frame({ move: [0, 0] }, 1.0));
  // The panel animates in on wall clock once the phase has changed.
  await page.waitForTimeout(2200);
}
