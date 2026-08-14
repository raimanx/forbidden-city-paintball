/**
 * Headless character tests.
 *
 * Covers hit routing (person vs. world), the grace window, scoring, and that
 * paint actually lands on a body. The grace-window check matters specifically:
 * it was being decremented on render-frame time rather than simulation time, so
 * it expired several times too fast on a slow machine.
 *
 * Usage: node tools/character-test.mjs [url]
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

const stats = () => page.evaluate(() =>
  window.__paintball.characters.allCharacters.map((c) => ({
    id: c.id, taken: c.hitsTaken, given: c.hitsGiven, splats: c.paint.splatCount,
  })));

// --- Roster ----------------------------------------------------------------
const roster = await stats();
check('the player and a bot roster exist', roster.length >= 4 && roster[0].id === 'player',
      roster.map((r) => r.id).join(', '));

// --- Rig geometry ----------------------------------------------------------
const rig = await page.evaluate(() => {
  const c = window.__paintball.characters.playerCharacter;
  const g = c.rig.geometry;
  return {
    verts: g.getAttribute('position').count,
    tris: g.getIndex().count / 3,
    hasJoint: Boolean(g.getAttribute('aJoint')),
    // Part colours ride on the geometry; the material draws with vertexColors.
    hasColor: Boolean(g.getAttribute('color')),
    // Deliberately absent. Paint is placed in the joint's frame from `position`,
    // so nothing samples a texture by surface UV and the attribute would be
    // dead weight — see CharacterPaint.
    hasUv: Boolean(g.getAttribute('uv')),
    joints: c.rig.jointMatrices.length,
  };
});
check('rig geometry is one skinned mesh',
      rig.hasJoint && rig.hasColor && !rig.hasUv && rig.joints === 9
        && rig.verts === rig.tris * 2,
      `${rig.verts} verts, ${rig.tris} tris, ${rig.joints} joints`);

// --- Outline integrity -----------------------------------------------------
// Both failures here were silent. The prepass used scene.overrideMaterial,
// which discards the rig's skinning vertex shader, so characters landed in the
// normal buffer in bind pose — no outline on the body, a phantom one at the
// legs, and background outlines drawn through the figure. And the hull's shader
// referenced a variable MeshBasicMaterial never declares, so it failed to
// compile and simply did not draw.
const outline = await page.evaluate(() => {
  const c = window.__paintball.characters.playerCharacter;
  return {
    hasNormalVariant: Boolean(c.mesh.userData.normalMaterial),
    hasHull: Boolean(c.hull),
    hullSharesGeometry: c.hull?.geometry === c.mesh.geometry,
    // The hull must be off the outline prepass layer, or the shell registers as
    // a second edge and every line doubles.
    hullExcludedFromPrepass: c.hull?.layers.mask === (1 << 2),
    // And after a rendered frame the body must be back on its own material.
    bodyMaterialRestored: c.mesh.material.type === 'MeshToonMaterial',
  };
});
check('characters publish a skinned normal-material variant', outline.hasNormalVariant);
check('characters carry an inverted-hull shell',
      outline.hasHull && outline.hullSharesGeometry, 'shares the rig geometry');
check('the hull is excluded from the outline prepass', outline.hullExcludedFromPrepass);
check('prepass restores materials after rendering', outline.bodyMaterialRestored,
      `material is ${await page.evaluate(() =>
        window.__paintball.characters.playerCharacter.mesh.material.type)}`);

// The hull shader must actually have compiled. A failed program logs to the
// console, which is asserted clean at the end, but check it drew as well.
const hullDrew = await page.evaluate(() => {
  const c = window.__paintball.characters.playerCharacter;
  return c.hull.visible && c.hull.material.type === 'MeshBasicMaterial';
});
check('the hull is live in the scene', hullDrew);

// --- Hit routing: person, not architecture ---------------------------------
// Bots wander, so rather than firing at a fixed coordinate, step up to whichever
// bot is nearest and re-aim at its live chest position between bursts.
const totalBotHits = () => page.evaluate(() =>
  window.__paintball.characters.allBots.reduce((s, b) => s + b.character.hitsTaken, 0));
const botSplats = () => page.evaluate(() =>
  window.__paintball.characters.allBots.reduce((s, b) => s + b.character.paint.splatCount, 0));

const hitsBefore = await totalBotHits();
const splatsBefore = await botSplats();
let landed = false;

for (let attempt = 0; attempt < 6 && !landed; attempt++) {
  // Plant ourselves a few metres from the closest bot, facing it.
  await page.evaluate(() => {
    const { player, state, characters } = window.__paintball;
    let best = null;
    let bestD = Infinity;
    for (const b of characters.allBots) {
      const d = Math.hypot(b.position.x - state.position.x, b.position.z - state.position.z);
      if (d < bestD) { bestD = d; best = b; }
    }
    if (!best) return;
    const dx = best.position.x - state.position.x;
    const dz = best.position.z - state.position.z;
    const len = Math.hypot(dx, dz) || 1;
    // Stand 6m short of the bot, on the line between us.
    const stand = new (state.position.constructor)(
      best.position.x - (dx / len) * 6, 2, best.position.z - (dz / len) * 6);
    player.teleport(stand);
    state.yaw = Math.atan2(-(dx / len), -(dz / len));
    state.pitch = 0.02;
  });
  await waitSim(0.6);
  // Re-aim at the live position, since it moved while we settled.
  await page.evaluate(() => {
    const { state, characters } = window.__paintball;
    let best = null;
    let bestD = Infinity;
    for (const b of characters.allBots) {
      const d = Math.hypot(b.position.x - state.position.x, b.position.z - state.position.z);
      if (d < bestD) { bestD = d; best = b; }
    }
    if (!best) return;
    const dx = best.position.x - state.position.x;
    const dz = best.position.z - state.position.z;
    state.yaw = Math.atan2(-dx, -dz);
  });
  await page.mouse.down();
  await waitSim(0.8);
  await page.mouse.up();
  await waitSim(1.0);
  landed = (await totalBotHits()) > hitsBefore;
}

const playerRow = (await stats()).find((c) => c.id === 'player');
check('shooting a character registers on that character', landed,
      `bot hits ${hitsBefore} -> ${await totalBotHits()}`);
check('paint lands on the body', (await botSplats()) > splatsBefore,
      `bot splats ${splatsBefore} -> ${await botSplats()}`);
check('the shooter is credited', playerRow.given > 0, `player given ${playerRow.given}`);

// --- Grace window, measured in simulation time ------------------------------
// Drive the event path directly at a fixed rate: 40 hits over 4 simulated
// seconds against a 1s window should register about 4, not 40. Firing a real
// gun at a moving bot cannot measure this cleanly.
const graceResult = await page.evaluate(async () => {
  const { game, characters, state } = window.__paintball;
  const bot = characters.allBots[0];
  const V = state.position.constructor;
  const before = bot.character.hitsTaken;
  for (let i = 0; i < 40; i++) {
    game.events.emit('hit:character', {
      targetId: bot.id, shooterId: 'player', color: 0xff3d81,
      point: new V(bot.position.x, bot.position.y + 1.2, bot.position.z),
      normal: new V(0, 0, 1), impactSpeed: 30,
    });
    // 0.1s of simulation between hits, ticked explicitly.
    bot.character.tickGameplay(0.1);
  }
  return bot.character.hitsTaken - before;
});
check('grace window throttles hits in sim time',
      graceResult >= 3 && graceResult <= 6,
      `${graceResult} of 40 hits registered across 4s of simulated grace time`);

// --- The player's own body can be painted ----------------------------------
// Third-person means paint on your own back is a headline feature, so it needs
// its own check; nothing shoots the player yet.
const playerPaintBefore = await page.evaluate(() =>
  window.__paintball.characters.playerCharacter.paint.splatCount);
await page.evaluate(() => {
  const { game, state, characters } = window.__paintball;
  const Vec = state.position.constructor;
  const p = state.position;
  // A bot may have tagged us moments ago; clear the grace window so this
  // synthetic hit is not silently swallowed.
  characters.playerCharacter.tickGameplay(5);
  game.events.emit('hit:character', {
    targetId: 'player',
    shooterId: 'dummy-a',
    color: 0x00d4e8,
    // Chest height, just in front of the torso.
    point: new Vec(p.x, p.y + 1.1, p.z - 0.2),
    normal: new Vec(0, 0, -1),
    impactSpeed: 34,
  });
});
await waitSim(0.4);
const playerPaintAfter = await page.evaluate(() =>
  window.__paintball.characters.playerCharacter.paint.splatCount);
const playerTaken = (await stats()).find((c) => c.id === 'player').taken;
check('the player character can be painted', playerPaintAfter > playerPaintBefore,
      `${playerPaintBefore} -> ${playerPaintAfter} splats`);
check('being hit increments the player counter', playerTaken > 0, `taken ${playerTaken}`);

// --- The splat list is bounded ---------------------------------------------
// Paint used to accumulate into a render target and so had no ceiling. It is a
// fixed-size uniform buffer now, and the fragment loop trusts the published
// count — so overrunning it has to evict the oldest, not grow or wrap.
const cap = await page.evaluate(() => {
  const { game, state, characters } = window.__paintball;
  const character = characters.playerCharacter;
  const Vec = state.position.constructor;
  const max = character.paint.max;
  character.paint.clear();

  let peak = 0;
  for (let i = 0; i < max + 8; i++) {
    // Each hit needs the grace window cleared or it is silently swallowed.
    character.tickGameplay(5);
    const p = state.position;
    game.events.emit('hit:character', {
      targetId: 'player',
      shooterId: 'dummy-a',
      color: 0x00d4e8,
      point: new Vec(p.x, p.y + 1.1, p.z - 0.2),
      normal: new Vec(0, 0, -1),
      impactSpeed: 34,
    });
    peak = Math.max(peak, character.paint.splatCount);
  }
  return { max, peak, final: character.paint.splatCount };
});
check('the splat list is bounded', cap.peak === cap.max && cap.final === cap.max,
      `${cap.max + 8} hits -> ${cap.final} splats, cap ${cap.max}`);

// --- Animation responds to state -------------------------------------------
// Must go through real input: PlayerController rewrites state.crouching from
// the input map every fixed step, so poking the flag directly does nothing.
const pelvisY = () => page.evaluate(() =>
  window.__paintball.characters.playerCharacter.rig.joints[1].position.y);
const standingPelvis = await pelvisY();
await page.keyboard.down('Control');
await waitSim(0.8);
const crouchedPelvis = await pelvisY();
await page.keyboard.up('Control');
await waitSim(0.6);
const recoveredPelvis = await pelvisY();

check('crouch lowers the pelvis', crouchedPelvis < standingPelvis - 0.2,
      `${standingPelvis.toFixed(3)} -> ${crouchedPelvis.toFixed(3)}`);
check('standing back up restores the pelvis',
      recoveredPelvis > crouchedPelvis + 0.2,
      `${crouchedPelvis.toFixed(3)} -> ${recoveredPelvis.toFixed(3)}`);

// --- Paint that is recorded is paint that is drawn ---------------------------
//
// The oldest complaint in FEEDBACK_0: the score moves and no paint appears.
// `splatCount` cannot see it — that counts what went into the buffer, and every
// candidate cause dropped the splat *after* that, in the shader. So this reads
// the framebuffer: paint the body, photograph it, take the paint off, photograph
// it again, and count the pixels that changed. Angles are swept one at a time
// because the failure was never all-or-nothing — impacts arrive on the capsule,
// which is 0.35m in radius where the torso is 0.13m deep, so how far off the
// body a splat landed depended entirely on which way the shot came in.
/**
 * Photographs the frame, then reports how much of the next one differs.
 *
 * A difference, not a colour match: paint is cel-shaded and fogged like
 * everything else, so its hue on screen is the paint colour times a warm sun
 * and a blue sky, and a hue window tight enough to exclude the park excludes
 * half the splat with it. Measured that way, a clearly visible splat scored
 * 0.02% of the frame against a 0.22% background — worse than useless.
 *
 * The catch with differencing is that everything in this park moves, so the
 * pair of frames is taken one *simulation step* apart — 16ms, during which the
 * canopies and the fountain move a pixel or two — and that residue is measured
 * once as a noise floor and required to be small.
 */
const snap = () => page.evaluate(() => new Promise((resolve) => {
  requestAnimationFrame(() => {
    const probe = document.createElement('canvas');
    probe.width = 320;
    probe.height = 180;
    const ctx = probe.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(document.querySelector('canvas.game-canvas'), 0, 0, 320, 180);
    window.__ref = ctx.getImageData(0, 0, 320, 180).data;
    resolve(true);
  });
}));

const diffSnap = () => page.evaluate(() => new Promise((resolve) => {
  requestAnimationFrame(() => {
    const probe = document.createElement('canvas');
    probe.width = 320;
    probe.height = 180;
    const ctx = probe.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(document.querySelector('canvas.game-canvas'), 0, 0, 320, 180);
    const now = ctx.getImageData(0, 0, 320, 180).data;
    const before = window.__ref;
    let changed = 0;
    for (let i = 0; i < now.length; i += 4) {
      if (Math.abs(now[i] - before[i]) +
          Math.abs(now[i + 1] - before[i + 1]) +
          Math.abs(now[i + 2] - before[i + 2]) > 60) changed++;
    }
    resolve(+(changed / (now.length / 4)).toFixed(4));
  });
}));

/** One fixed step: enough for a paint change to reach the shader, and no more. */
const stepOnce = () => page.evaluate(() => window.__paintball.stepSim(1 / 60));

/**
 * Takes the paint off the player and reports how much of the frame that
 * removed. Removal rather than addition, because taking paint off animates
 * nothing — where landing a hit flinches the whole body.
 */
async function clearAndDiff() {
  await page.evaluate(() => window.__paintball.characters.playerCharacter.paint.clear());
  await stepOnce();
  return diffSnap();
}

// Standing in the great court with the Gate of Supreme Harmony behind the
// player, which is the best still backdrop on this map: painted timber and
// glazed tile, none of which moves. The old spot — the plaza in front of the
// terrace — is now *inside* the great marble terrace, whose top is 3.7m up, so
// a teleport to 1.5m there dropped the player through the world and every
// frame-difference measurement in this file read as noise.
//
// The camera sits behind the player, so this puts their back to the gate.
await page.evaluate(() => {
  const { player, state, characters } = window.__paintball;
  const V = state.position.constructor;
  player.teleport(new V(0, 1.5, 110));
  state.yaw = Math.PI;
  // Looking down a little, so the shoulders and the top of the head are in
  // frame. A level camera cannot see the crown at all, and a splat there is
  // then correctly drawn and correctly invisible, which no measurement can
  // tell apart from a splat that was dropped.
  state.pitch = 0.32;
  characters.playerCharacter.paint.clear();

  // And the compound to itself. Eight bots wander this map with live triggers,
  // and over the eight simulated seconds this sweep takes they will find the
  // player, shoot them, and flinch them mid-measurement. Sent to the far
  // corner rather than frozen: there is no freeze switch, and respawn() is
  // exactly the "put this bot somewhere and forget what it was doing" call.
  for (const bot of characters.allBots) {
    bot.respawn(new V(bot.position.x + 260, bot.position.y, bot.position.z + 260));
  }
});
await waitSim(1.2);

// The sweep covers the *capsule*, cap included, because that is the surface
// impacts are reported on and its shape is the whole problem: a shot into the
// upper cap comes back with a normal tilted 40 degrees skyward, which agrees
// with no face of the blocky head underneath it.
//
// Yaw is kept inside +-75 degrees of straight behind so everything measured is
// on the half of the body the third-person camera can see.
const SPOTS = [
  { name: 'chest-left', yaw: -55, height: 1.15, tilt: 0 },
  { name: 'chest', yaw: 0, height: 1.15, tilt: 0 },
  { name: 'chest-right', yaw: 55, height: 1.15, tilt: 0 },
  { name: 'hip', yaw: -20, height: 0.95, tilt: 0 },
  // Not lower than this: the aimed camera crops the shins out of frame, and a
  // splat off the bottom edge is invisible for reasons that are nothing to do
  // with paint.
  { name: 'thigh', yaw: 15, height: 0.72, tilt: 0 },
  { name: 'shoulder', yaw: -40, height: 1.25, tilt: 0 },
  // On the cap: `tilt` is degrees up from horizontal, and the point rides the
  // sphere the normal belongs to.
  { name: 'neck-cap', yaw: 0, height: 1.25, tilt: 30 },
  { name: 'head-cap', yaw: 30, height: 1.25, tilt: 45 },
  { name: 'crown', yaw: -15, height: 1.25, tilt: 58 },
];

// Aiming, held for the whole sweep. It pulls the camera in from 3.6m to 2.2m
// and narrows the field of view, which roughly quadruples the character's area
// on screen — and the thing being measured here is a mark a few centimetres
// across on a body that is otherwise 80 pixels tall.
await page.mouse.down({ button: 'right' });
await waitSim(1.0);

// The noise floor: one step of animation with no paint involved at all.
await page.evaluate(() => window.__paintball.characters.playerCharacter.paint.clear());
await waitSim(0.3);
await snap();
await stepOnce();
const floor = await diffSnap();
const threshold = Math.max(0.0028, floor * 3);
check('a still frame of the compound is nearly still',
      floor < 0.01, `${(floor * 100).toFixed(3)}% of frame moves per step`);

const paintBySpot = [];
for (const spot of SPOTS) {
  const splats = await page.evaluate((spot) => {
    const { game, state, characters } = window.__paintball;
    const V = state.position.constructor;
    const character = characters.playerCharacter;
    character.tickGameplay(5);

    // Measured from directly behind the character, whichever way they face.
    // Three hits in a cluster rather than one. A single splat covers about a
    // tenth of a percent of the frame at this range, which is only twice the
    // noise floor — visible to a person, but not a number to assert on.
    for (const nudge of [-9, 0, 9]) {
      const yaw = state.yaw + ((spot.yaw + nudge) * Math.PI) / 180;
      const tilt = (spot.tilt * Math.PI) / 180;
      const nx = Math.sin(yaw) * Math.cos(tilt);
      const ny = Math.sin(tilt);
      const nz = Math.cos(yaw) * Math.cos(tilt);
      character.tickGameplay(5);
      game.events.emit('hit:character', {
        targetId: 'player',
        shooterId: 'dummy-a',
        color: 0x9b5de5,
        point: new V(
          state.position.x + nx * 0.35,
          state.position.y + spot.height + ny * 0.35,
          state.position.z + nz * 0.35,
        ),
        normal: new V(nx, ny, nz),
        impactSpeed: 40,
      });
    }
    return character.paint.splatCount;
  }, spot);
  // Long enough for the flinch the hit triggers to play out. Snapping before
  // it settles measures the *animation*, which moves about half a percent of
  // the frame whether or not any paint was drawn — every spot scored an
  // identical 0.5% that way, including ones drawing nothing at all.
  await waitSim(0.7);
  await snap();
  const visible = await clearAndDiff();
  paintBySpot.push({ ...spot, splats, visible });
}

// --- and the impact that has no surface to speak of --------------------------
//
// This is the one the complaint was about. `sweep()` casts the ball's shape
// with `stopAtPenetration`, so a shot that starts a step already overlapping
// its target — which is what point-blank means at 63 m/s and a 1.05m step —
// comes back with time_of_impact 0 and a *degenerate* contact normal. The hit
// is real, the score moves, and the splat is recorded with an axis of zero
// length, against which every face of the body fails the grazing-angle guard.
// Nothing anywhere reports a problem; the paint simply is not there.
for (const nasty of [
  { name: 'zero-normal', normal: [0, 0, 0], inside: 0 },
  { name: 'point-blank', normal: [0, 0, 0], inside: 0.3 },
  { name: 'normal-from-behind', normal: 'reversed', inside: 0.2 },
]) {
  const splats = await page.evaluate((nasty) => {
    const { game, state, characters } = window.__paintball;
    const V = state.position.constructor;
    const character = characters.playerCharacter;
    character.paint.clear();
    character.tickGameplay(5);
    // Straight into the chest from behind, from `inside` metres past the
    // surface — the deeper the overlap, the more the cast degenerates.
    const nx = Math.sin(state.yaw);
    const nz = Math.cos(state.yaw);
    const normal = nasty.normal === 'reversed'
      ? new V(-nx, 0, -nz)
      : new V(nasty.normal[0], nasty.normal[1], nasty.normal[2]);
    for (const height of [1.0, 1.15, 1.3]) {
      character.tickGameplay(5);
      game.events.emit('hit:character', {
        targetId: 'player',
        shooterId: 'dummy-a',
        color: 0x9b5de5,
        point: new V(
          state.position.x + nx * (0.35 - nasty.inside),
          state.position.y + height,
          state.position.z + nz * (0.35 - nasty.inside),
        ),
        normal,
        impactSpeed: 55,
      });
    }
    return character.paint.splatCount;
  }, nasty);
  await waitSim(0.7);
  await snap();
  const visible = await clearAndDiff();
  paintBySpot.push({ ...nasty, splats, visible });
}

await page.mouse.up({ button: 'right' });

const missingSplat = paintBySpot.filter((r) => r.splats !== 3);
const invisible = paintBySpot.filter((r) => r.visible < threshold);
check('every impact on the capsule records its splats', missingSplat.length === 0,
      paintBySpot.map((r) => `${r.name}:${r.splats}`).join(' '));
check('every recorded splat is actually drawn', invisible.length === 0,
      `floor ${(floor * 100).toFixed(2)}% | ` +
      paintBySpot.map((r) => `${r.name}:${(r.visible * 100).toFixed(2)}%`).join(' '));

// --- The ball leaves the barrel we drew --------------------------------------
//
// `AimSolver.computeMuzzle` is analytic — it runs a frame ahead of the pose, so
// it cannot read the rig — which means the two can drift apart silently, and did
// once already when the marker moved onto its own joint. Nothing in the game
// notices; it just looks like paint coming out of a shoulder.
await page.evaluate(() => {
  window.__shotOrigin = null;
  window.__paintball.game.events.on('shot:fired', ({ origin, shooterId }) => {
    if (shooterId === 'player' && !window.__shotOrigin) window.__shotOrigin = origin.clone();
  });
});

// Held down through the measurement, both of them: the aim pose is what brings
// the marker level, and reading the rig after the trigger is released measures
// a gun that has already dropped back to the hip.
await page.mouse.down({ button: 'right' });
await page.mouse.down();
await waitSim(0.5);

const agreement = await page.evaluate(() => {
  const { state, characters } = window.__paintball;
  const V = state.position.constructor;
  const character = characters.playerCharacter;
  const origin = window.__shotOrigin;
  if (!origin) return null;

  // The marker's own barrel, read off the posed rig: joint 8 is GUN, and the
  // muzzle sits at (0, 0.09, -0.56) in its frame.
  const jointMatrix = character.rig.jointMatrices[8];
  const muzzle = character.rig.root.localToWorld(
    new V(0, 0.09, -0.56).applyMatrix4(jointMatrix));
  const breech = character.rig.root.localToWorld(
    new V(0, 0.09, 0).applyMatrix4(jointMatrix));

  // Distance from the shot's origin to the barrel's axis. Not to the muzzle
  // itself: the ball is deliberately spawned partway down the barrel so a
  // player hugging cover cannot shoot through it.
  const axis = muzzle.clone().sub(breech).normalize();
  const toOrigin = origin.clone().sub(breech);
  const along = toOrigin.dot(axis);
  const offAxis = toOrigin.addScaledVector(axis, -along).length();
  return { offAxis: +offAxis.toFixed(3), along: +along.toFixed(3) };
});

await page.mouse.up();
await page.mouse.up({ button: 'right' });
await waitSim(0.2);
check('the ball leaves the barrel the marker is drawn with',
      agreement !== null && agreement.offAxis < 0.18 && agreement.along > 0,
      agreement ? `${agreement.offAxis}m off the barrel axis, ${agreement.along}m along it`
                : 'no shot observed');

check('no console or page errors', consoleErrors.length === 0, consoleErrors[0] ?? 'clean');

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
