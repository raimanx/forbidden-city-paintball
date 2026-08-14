/**
 * Gameplay video recorder.
 *
 * Records a choreographed run through the park as a numbered frame sequence,
 * then hands it to `tools/encode.mjs` to cut into the clips that actually get
 * posted.
 *
 * Frames are stepped, not filmed. The game is put into manual-sim mode and
 * advanced by exactly 1/fps per captured frame, so the output runs at a
 * perfectly even rate no matter how long a screenshot takes to come back. A
 * real-time screen capture of a browser is at the mercy of whatever else the
 * machine is doing; this is not. It also means the footage is reproducible —
 * the same beats produce the same run twice, which is what makes it possible
 * to re-cut a clip after changing one shot rather than re-shooting everything.
 *
 * Choreography lives in BEATS. Each beat teleports the player somewhere, then
 * drives the controls per frame through the same surfaces a thumb would use —
 * `setTouchMove` for analogue movement, `setTouchAction` for the trigger — so
 * the recording exercises the real controller, physics and weapon rather than
 * a camera flown through the scene on rails.
 *
 * Usage: node tools/record.mjs [--out DIR] [--fps N] [--width N] [--height N]
 *                             [--only beat,beat] [--url URL]
 */
import { chromium } from 'playwright-core';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

// --- options ---------------------------------------------------------------

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};

const OUT = opt('out', 'captures/video');
const FPS = Number(opt('fps', 30));
const WIDTH = Number(opt('width', 1920));
const HEIGHT = Number(opt('height', 1080));
const URL = opt('url', 'http://localhost:4173/');
const ONLY = opt('only', null)?.split(',').map((s) => s.trim());

const FRAMES = join(OUT, 'frames');
const DT = 1 / FPS;

// --- choreography ----------------------------------------------------------
//
// `at` is a spawn: the player is dropped there and left to settle before the
// beat is recorded, so a shot stays framed if the terrain under it changes.
// `drive(u, t)` returns the controls for one frame, where `u` runs 0..1 across
// the beat and `t` is seconds into it.
//
// Landmark coordinates come from src/world/CityLayout.ts and CityPlan.ts.

/** Eased 0..1, for camera moves that shouldn't start or stop abruptly. */
const ease = (u) => u * u * (3 - 2 * u);
/** Interpolate between two angles the short way round. */
const lerp = (a, b, u) => a + (b - a) * u;
/** A slow figure-of-eight on the look axis — the drift of a hand on a mouse. */
const sway = (t, amp = 0.05, rate = 0.45) =>
  Math.sin(t * rate) * amp + Math.sin(t * rate * 1.7 + 1) * amp * 0.4;

const BEATS = [
  {
    // Opens on the great court from its south end, drifting north toward the
    // terrace. The first three seconds decide whether anyone watches the rest,
    // so this is the postcard: marble, gold roofs and a courtyard you could
    // land an aircraft in.
    //
    // The drift is slow on purpose. An earlier cut walked in at full pace and
    // arrived in the basin four seconds early, which turned the establishing
    // shot into a shot of the far shore.
    name: 'great-court-reveal',
    seconds: 7,
    at: { x: 0, y: 8, z: 150, yaw: 0.06, pitch: 0.03 },
    drive: (u, t) => ({
      move: [0, 0.18],
      yaw: lerp(0.42, 0.05, ease(u)),
      pitch: lerp(0.05, -0.07, ease(u)) + sway(t, 0.012),
    }),
  },
  {
    // Walks south off the plaza toward the arcade colonnade.
    //
    // It used to climb the terrace stair. It should not: the stair is a steep
    // slope with the camera three metres behind and below the player, so the
    // whole frame became the hillside they were standing on. Approaching the
    // arches on the flat keeps the architecture in shot and the camera out of
    // the ground.
    name: 'terrace-approach',
    seconds: 6,
    at: { x: 0, y: 8, z: 96, yaw: 0.0, pitch: 0.05 },
    drive: (u, t) => ({
      move: [Math.sin(t * 0.7) * 0.1, 0.26],
      yaw: Math.PI + lerp(0.12, -0.08, ease(u)) + sway(t, 0.04, 0.5),
      pitch: lerp(0.08, -0.02, ease(u)) + sway(t, 0.015, 0.9),
    }),
  },
  {
    // First contact, staged nine metres up the axis in the great court.
    //
    // Staged rather than "walk at whoever is nearest": the first version of
    // this beat picked up whichever bot happened to be closest to where the
    // last shot left off, which was one standing against the terrace wall —
    // the spring arm collapsed into the stonework and the whole frame became
    // the back of the player's head. Fights are placed in the open now, and
    // the allée is the most photogenic open ground on the map.
    name: 'duel-great-court',
    seconds: 12,
    stage: { player: [0, 52], bot: [0, 43] },
    hold: 1.2,
    drive: (u, t) => ({
      move: [Math.sin(t * 0.8) * 0.5, t < 2.5 ? 0.35 : 0],
      aim: t > 1.4,
      fire: (t > 2.4 && t < 3.6) || (t > 5.0 && t < 6.2) || (t > 7.6 && t < 8.8),
      track: { damping: 5.5, aimHeight: 1.05, bias: 0.075 },
    }),
  },
  {
    // Bow Bridge, three-quarters on from the west bank. Pure scenery: water,
    // ironwork and the far shore.
    name: 'corner-tower',
    seconds: 7,
    // A pan from a standing start, and deliberately no walking at all.
    //
    // The west bank is a narrow shelf between the bridge approach embankment
    // and the water. Walking forward at any pace puts the player on the ramp
    // and the camera — three metres behind and below — inside the embankment;
    // walking far enough puts them under the span and in the lake. Both were
    // tried and both came back unusable. Standing still is what the matching
    // press still does, and that one frames cleanly.
    at: { x: 168, y: 8, z: 240, yaw: 0.85, pitch: -0.04 },
    drive: (u, t) => ({
      move: [0, 0],
      yaw: lerp(-1.02, -0.48, ease(u)) + sway(t, 0.025, 0.5),
      pitch: lerp(-0.11, 0.02, ease(u)) + sway(t, 0.015, 0.7),
    }),
  },
  {
    // Close quarters in an alley of the Six Eastern Palaces, strafing hard
    // around the target with the
    // skyline behind it. This is the shot that has to sell that it is a game.
    name: 'duel-palace-alley',
    seconds: 12,
    stage: { player: [-50, 36], bot: [-50, 44] },
    hold: 1.4,
    drive: (u, t) => ({
      move: [Math.cos(t * 0.95) * 0.85, Math.sin(t * 0.5) * 0.25],
      aim: true,
      fire: (t > 1.2 && t < 2.4) || (t > 4.0 && t < 5.2) || (t > 7.2 && t < 8.6),
      jump: Math.abs(t - 6.4) < DT,
      track: { damping: 7, aimHeight: 1.0, bias: 0.08 },
    }),
  },
  {
    // The north end of the axis, with Jingshan over the wall behind it — the
    // shot that
    // says where this is set.
    name: 'jingshan-over-the-wall',
    seconds: 6,
    at: { x: 0, y: 8, z: -60, yaw: Math.PI, pitch: 0.12 },
    drive: (u, t) => ({
      move: [0, 0.8],
      sprint: u > 0.35,
      yaw: Math.PI + lerp(-0.35, 0.25, ease(u)),
      pitch: lerp(0.10, -0.02, ease(u)) + sway(t, 0.02),
    }),
  },
  {
    // Sprinting north up the axis from the Meridian Gate. Sprint widens the FOV and
    // the tunnel of trees does the rest.
    // Started from the south end: a sprint covers forty metres in six seconds,
    // and from z=66 that ends the shot nose-first against the terrace wall.
    name: 'axis-sprint',
    seconds: 6,
    at: { x: 0, y: 8, z: 190, yaw: 0, pitch: -0.02 },
    drive: (u, t) => ({
      move: [0, 1],
      sprint: true,
      yaw: sway(t, 0.13, 0.55),
      pitch: -0.03 + sway(t, 0.025, 0.8),
    }),
  },
  {
    // Last exchange, at longer range and on the open east flank, so the three
    // fights in the cut are not all the same distance in the same light.
    name: 'duel-open',
    seconds: 10,
    stage: { player: [44, 10], bot: [44, -6] },
    // Pinned like the others in the end. Left free, this one closed sixteen
    // metres in three seconds and spent the shot standing inside the player's
    // avatar with the camera arm folded flat.
    hold: 1.2,
    drive: (u, t) => ({
      // Closes for three seconds, then holds the range.
      //
      // Advancing for the whole ten seconds covers twenty-six metres against a
      // target staged at sixteen, so the beat ended with the player standing
      // inside the bot. Pinning the bot harder was the wrong fix: it was never
      // the one doing the closing.
      move: [Math.sin(t * 0.6) * 0.4, t < 3 ? 0.45 : 0],
      aim: t > 1.2,
      fire: (t > 2.0 && t < 3.2) || (t > 4.8 && t < 6.0) || (t > 7.4 && t < 8.6),
      track: { damping: 5, aimHeight: 1.05, bias: 0.07 },
    }),
  },
  {
    // The lake from the south shore, on the way out.
    name: 'golden-water-river',
    seconds: 6,
    at: { x: -20, y: 8, z: 186, yaw: 0.22, pitch: -0.06 },
    drive: (u, t) => ({
      move: [0.25, 0.3],
      yaw: lerp(0.15, 0.62, ease(u)) + sway(t, 0.02),
      pitch: lerp(-0.10, 0.02, ease(u)),
    }),
  },
  {
    // The end card: the line-up, with everyone's scores and paint already on.
    // Set up in `finale` below rather than driven, because getting here means
    // running the clock out.
    name: 'results',
    seconds: 8,
    finale: true,
    drive: () => ({ move: [0, 0] }),
  },
];

// --- browser ---------------------------------------------------------------

const EXECUTABLE =
  process.env.CHROME_PATH ??
  ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(existsSync);
if (!EXECUTABLE) throw new Error('No system Chrome found. Set CHROME_PATH.');

// Real GPU first. This is a third-person renderer with a post pipeline, and
// under SwiftShader a single 1080p frame costs about four seconds — a hundred
// seconds of footage would take four hours. The flags fall back to software on
// a machine without a card, just far more slowly.
const browser = await chromium.launch({
  executablePath: EXECUTABLE,
  args: [
    '--use-angle=vulkan',
    '--enable-gpu',
    '--ignore-gpu-blocklist',
    '--enable-unsafe-swiftshader',
    '--disable-dev-shm-usage',
    '--hide-scrollbars',
  ],
});

const page = await browser.newPage({
  viewport: { width: WIDTH, height: HEIGHT },
  deviceScaleFactor: 1,
});
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

console.log(`recording ${WIDTH}x${HEIGHT} @ ${FPS}fps -> ${FRAMES}/`);
await page.goto(URL, { waitUntil: 'load' });
await page.waitForFunction(() => window.__paintball && !document.querySelector('#loader'),
                           { timeout: 120_000 });

const gpu = await page.evaluate(() => {
  const gl = document.querySelector('canvas.game-canvas').getContext('webgl2');
  const d = gl.getExtension('WEBGL_debug_renderer_info');
  return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : 'unknown';
});
console.log(`gpu: ${gpu}\n`);

// --- the director ----------------------------------------------------------
//
// Shared with tools/stills.mjs — see tools/director.js for what it does and
// why it runs inside the page rather than out here.
await page.addScriptTag({ path: 'tools/director.js' });
await page.evaluate(() => {
  // Audio needs the same user gesture pointer lock does. Emitting the event
  // directly grants it without a real lock, which headless will not give us —
  // and it is a no-op for the match, which is already playing.
  window.__paintball.game.events.emit('input:lockChanged', { locked: true });
  window.__paintball.setManualSim(true);
});

// --- record ----------------------------------------------------------------

rmSync(FRAMES, { recursive: true, force: true });
mkdirSync(FRAMES, { recursive: true });

const manifest = { fps: FPS, width: WIDTH, height: HEIGHT, beats: [], errors };
let frameIndex = 0;
const started = Date.now();

for (const beat of BEATS) {
  if (ONLY && !ONLY.includes(beat.name)) continue;

  // --- set the beat up ---------------------------------------------------
  await page.evaluate(() => window.__director.release());

  if (beat.at) {
    const { x, y, z, yaw, pitch } = beat.at;
    await page.evaluate(([x, y, z, yaw, pitch]) =>
      window.__director.teleport(x, y, z, yaw, pitch), [x, y, z, yaw, pitch]);
    await page.evaluate(() => window.__director.frame({ move: [0, 0] }, 1.2));
  }

  if (beat.stage) {
    const { player: p, bot: b } = beat.stage;
    const placed = await page.evaluate(([px, pz, bx, bz]) =>
      window.__director.stage(px, pz, bx, bz), [p[0], p[1], b[0], b[1]]);
    // Let both of them settle onto the ground and the spring arm ease out
    // before the first frame is kept — a teleport takes the best part of a
    // second to stop moving the camera on its own.
    await page.evaluate(() => window.__director.frame({ move: [0, 0] }, 1.0));
    if (beat.pin !== false) {
      await page.evaluate(() => window.__director.pin(window.__director.target));
    }
    if (placed) console.log(`  ${beat.name.padEnd(18)} staged vs ${placed.id} @ ${placed.range}m`);
  } else if (!beat.finale) {
    await page.evaluate(() => { window.__director.target = null; });
  }

  if (beat.finale) await setUpFinale(page);

  // --- shoot it ----------------------------------------------------------
  const total = Math.round(beat.seconds * FPS);
  const first = frameIndex;

  let sinceHold = 0;

  for (let f = 0; f < total; f++) {
    const t = f * DT;

    // Re-pin the target every so often, for beats that asked to hold one.
    //
    // A staged fight is only staged for the first second: some personalities
    // charge, and a bot that closes to arm's length pushes the spring arm into
    // the player's back, fades the avatar out and fills the frame with itself.
    // Re-pinning is invisible — it puts the bot back exactly where it already
    // is — but it drops the path, so it stays in the shot it was placed in.
    if (beat.hold) {
      sinceHold += DT;
      if (sinceHold >= beat.hold) {
        sinceHold = 0;
        await page.evaluate(() => window.__director.pin(window.__director.target));
      }
    }

    const cmd = beat.drive(f / total, t);
    await page.evaluate(([cmd, dt]) => window.__director.frame(cmd, dt), [cmd, DT]);
    await page.screenshot({
      path: join(FRAMES, `${String(frameIndex).padStart(6, '0')}.jpg`),
      type: 'jpeg',
      quality: 92,
    });
    frameIndex++;
  }

  manifest.beats.push({ name: beat.name, first, count: total, seconds: beat.seconds });
  const elapsed = ((Date.now() - started) / 1000).toFixed(0);
  console.log(`  ${beat.name.padEnd(18)} ${String(total).padStart(4)} frames  ` +
              `(${first}..${frameIndex - 1})  ${elapsed}s elapsed`);
}

manifest.frames = frameIndex;
writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));

await browser.close();

console.log(`\n${frameIndex} frames (${(frameIndex / FPS).toFixed(1)}s) in ` +
            `${((Date.now() - started) / 1000).toFixed(0)}s`);
if (errors.length) console.log(`page errors: ${errors.length}\n  ${errors.slice(0, 5).join('\n  ')}`);
console.log(`\nnext: node tools/encode.mjs --in ${OUT}`);

/**
 * Dresses the line-up and runs the clock out.
 *
 * Scores come from a fixed table rather than from however the recorded run
 * happened to go, so the end card reads the same in every cut, and every body
 * gets real paint on it — the results stage is the only close-up of seven
 * painted characters in the game and it is worth showing that way.
 */
async function setUpFinale(page) {
  await page.evaluate(() => {
    const { game, match, characters, state } = window.__paintball;
    const V = state.position.constructor;

    characters.allCharacters.forEach((character, index) => {
      character.hitsGiven = [12, 9, 8, 7, 5, 4, 3][index] ?? 4;
      character.hitsTaken = [3, 5, 6, 6, 8, 9, 11][index] ?? 6;
    });

    for (const bot of characters.allBots) {
      for (let i = 0; i < 7; i++) {
        const angle = i * 0.9;
        bot.character.tickGameplay(5);
        game.events.emit('hit:character', {
          targetId: bot.id,
          shooterId: 'player',
          color: [0xff3d81, 0xa8e337, 0x00d4e8][i % 3],
          point: new V(
            bot.position.x + Math.sin(angle) * 0.35,
            bot.position.y + 0.85 + (i % 3) * 0.32,
            bot.position.z + Math.cos(angle) * 0.35,
          ),
          normal: new V(Math.sin(angle), 0, Math.cos(angle)),
          impactSpeed: 40,
        });
      }
    }
    match.timeLeft = 0.2;
  });
  // Enough simulated time for the whistle, the phase change and the stage to
  // build; the panel animates on wall clock once it is up.
  await page.evaluate(() => window.__director.frame({ move: [0, 0] }, 1.0));
  await page.waitForTimeout(1800);
}
