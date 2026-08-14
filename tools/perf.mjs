/**
 * Real-GPU performance harness.
 *
 * Every frame-time figure before this was SwiftShader, which says nothing about
 * whether the game hits 60fps. Headless Chrome will use the real device given
 * the right flags, so these numbers are the first meaningful ones.
 *
 * Usage: node tools/perf.mjs [url]
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
  args: ['--use-angle=vulkan', '--enable-features=Vulkan', '--ignore-gpu-blocklist',
         '--enable-gpu-rasterization', '--disable-dev-shm-usage',
         // Uncapped: with vsync on, every median lands on the 16.67ms refresh
         // interval and the actual cost of a frame is invisible.
         '--disable-gpu-vsync', '--disable-frame-rate-limit'],
});
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

const device = await page.evaluate.bind(page);
const t0 = Date.now();
await page.goto(url, { waitUntil: 'load' });
await page.waitForFunction(() => window.__paintball && !document.querySelector('#loader'),
                           { timeout: 90_000 });
const readyMs = Date.now() - t0;
await page.mouse.click(960, 540);
await page.waitForTimeout(500);

const gpu = await page.evaluate(() => {
  const gl = document.querySelector('canvas.game-canvas').getContext('webgl2');
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  return dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'unknown';
});
console.log(`\ngpu: ${gpu}`);
console.log(`viewport: 1920x1080`);
console.log(`load to playable: ${readyMs}ms\n`);

const boot = await page.evaluate(() => window.__paintball.bootTimings());
console.log('boot breakdown:');
for (const b of boot.sort((a, x) => x.ms - a.ms)) {
  if (b.ms < 1 && b.phase !== 'TOTAL') continue;
  console.log(`  ${String(b.phase).padEnd(16)} ${b.ms.toFixed(0)}ms`);
}

async function waitSim(seconds) {
  const start = await page.evaluate(() => window.__paintball.simTime());
  await page.waitForFunction(({ start, seconds }) =>
    window.__paintball.simTime() - start >= seconds, { start, seconds },
    { timeout: 120_000, polling: 30 });
}

/** Samples frame intervals over a stretch of real time. */
const sample = (frames) => page.evaluate((n) => new Promise((resolve) => {
  const times = [];
  let last = performance.now();
  let count = 0;
  const tick = () => {
    const now = performance.now();
    times.push(now - last);
    last = now;
    if (++count < n) { requestAnimationFrame(tick); return; }
    // Drop the first few: they include the first-frame shader warmup.
    const warm = times.slice(5).sort((a, b) => a - b);
    const info = window.__paintball.game.render.renderer.info;
    resolve({
      median: warm[Math.floor(warm.length * 0.5)],
      p95: warm[Math.floor(warm.length * 0.95)],
      worst: warm[warm.length - 1],
      calls: info.render.calls,
      tris: info.render.triangles,
    });
  };
  requestAnimationFrame(tick);
}), frames);

/**
 * Four vantages, chosen for what they cost rather than for what they look like.
 *
 * `great-court` is the worst case the game actually puts a player in: the
 * largest open courtyard on the map, looking north up the axis with the terrace,
 * the three great halls and half the Inner Court's roofs in frame at once.
 * `palace-alley` is the opposite — two walls and a strip of sky — and is what
 * most of the compound is really like. The other two sit between them.
 */
const SPOTS = [
  { name: 'great-court', x: 0, z: 110, yaw: 0, pitch: 0.02 },
  { name: 'axis-south', x: 0, z: 190, yaw: 0, pitch: 0.03 },
  { name: 'palace-alley', x: 62, z: -100, yaw: Math.PI, pitch: 0 },
  { name: 'moat-corner', x: 185, z: 240, yaw: 0.85, pitch: 0.02 },
];

console.log('\nframe time (ms, lower is better):');
console.log('  spot              median    p95     worst   calls    tris');
const rows = [];
for (const spot of SPOTS) {
  await page.evaluate(({ x, z, yaw, pitch }) => {
    const { player, state } = window.__paintball;
    state.yaw = yaw; state.pitch = pitch;
    player.teleport(new (state.position.constructor)(x, 8, z));
  }, spot);
  await waitSim(2.2);
  const m = await sample(150);
  rows.push({ name: spot.name, ...m });
  console.log(`  ${spot.name.padEnd(18)}${m.median.toFixed(2).padEnd(10)}` +
              `${m.p95.toFixed(2).padEnd(8)}${m.worst.toFixed(2).padEnd(8)}` +
              `${String(m.calls).padEnd(9)}${(m.tris / 1000).toFixed(0)}k`);
}

const worstMedian = Math.max(...rows.map((r) => r.median));
console.log(`\nworst median: ${worstMedian.toFixed(2)}ms ` +
            `(${(1000 / worstMedian).toFixed(0)} fps)  ` +
            `budget at 60fps is 16.67ms`);
console.log(`errors: ${errors.length ? errors[0] : 'none'}`);
void device;
await browser.close();
