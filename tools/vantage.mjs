/**
 * Vantage points: teleport to a list of positions and screenshot each.
 *
 * The difference from `tools/stills.mjs` is intent. Stills are framed to sell
 * the game and are shot at 2x; these are framed to *check* it — one from each
 * distinct piece of the compound, at the resolution it is played at, cheap
 * enough to re-run after every change to the geometry. Every position is a spot
 * the plan says is clear of buildings, so nothing here lands on a roof.
 *
 * Usage: node tools/vantage.mjs [outdir] [url]
 */
import { chromium } from 'playwright-core';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const OUT = process.argv[2] ?? '/home/mab/.claude/jobs/f22e4638/tmp/shots';
const URL = process.argv[3] ?? 'http://localhost:4173/';
mkdirSync(OUT, { recursive: true });

const EXECUTABLE = process.env.CHROME_PATH ??
  ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(existsSync);

const browser = await chromium.launch({
  executablePath: EXECUTABLE,
  args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader',
         '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

const t0 = Date.now();
await page.goto(URL, { waitUntil: 'load' });
await page.waitForFunction(() => Boolean(window.__paintball), { timeout: 60_000 });
await page.evaluate(() => window.__paintball.setManualSim(true));
await page.waitForFunction(() => !document.querySelector('#loader'), { timeout: 120_000 });
console.log(`ready in ${Date.now() - t0}ms`);
console.log('boot:', JSON.stringify(await page.evaluate(() => window.__paintball.bootTimings())));

await page.mouse.click(640, 360);
await page.evaluate((s) => window.__paintball.stepSim(s), 0.5);

// x, z, yaw (radians, 0 = looking toward -Z / north), pitch
const SHOTS = [
  ['01-great-court', 0, 110, 0, 0.02],
  ['02-taihe-gate-court', 0, 160, 0, 0.03],
  ['03-on-the-terrace', -0.8, 28.2, 3.14, 0.02],
  ['04-inner-court', -3.7, -46.5, 0, 0.02],
  ['05-six-palaces', 62, -100, 1.57, 0.0],
  ['06-garden', -5.8, -201.3, 3.14, 0.02],
  ['07-meridian-gate', 0, 190, 3.14, 0.16],
  ['08-west-flank', -72, 128, 1.57, 0.02],
  ['09-north-gate', -2.3, -200.5, 3.14, 0.05],
  ['10-wall-walk', -150, 0, 1.57, 0.03],
  ['11-terrace-from-court', 0, 110, 3.14, 0.10],
  ['12-east-flank', 68, 121, -1.57, 0.02],
];

for (const [name, x, z, yaw, pitch] of SHOTS) {
  await page.evaluate(({ x, z, yaw, pitch }) => {
    const { player, state } = window.__paintball;
    const V = state.position.constructor;
    player.teleport(new V(x, 12, z));
    state.yaw = yaw;
    state.pitch = pitch;
  }, { x, z, yaw, pitch });
  await page.evaluate((s) => window.__paintball.stepSim(s), 1.2);
  await page.waitForTimeout(220);
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  const y = await page.evaluate(() => window.__paintball.state.position.y);
  console.log(`${name}: standing at y=${y.toFixed(2)}`);
}

const info = await page.evaluate(() => {
  const r = window.__paintball.game.render.renderer.info;
  return { calls: r.render.calls, tris: r.render.triangles };
});
console.log('render:', JSON.stringify(info));
console.log('errors:', errors.length ? errors.slice(0, 5) : 'none');
await browser.close();
