/**
 * Headless geometry tests for the city's mesh builder.
 *
 * These exist because of a bug that cost an afternoon: `MeshBuilder.box` was
 * wound inside-out, so every wall, plinth and courtyard wall in the compound —
 * some sixteen thousand faces — had its normal pointing into the building. An
 * inside-out box does not look inside-out. It looks like a box lit from within,
 * which is to say it looks like a slightly disappointing box, and there is
 * nothing in the frame to point at. A face normal is exactly the kind of thing
 * a machine should check and an eye should not have to.
 *
 * Runs in the browser because the geometry is TypeScript that imports three.
 *
 * Usage: node tools/geometry-test.mjs [url]
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
const page = await browser.newPage({ viewport: { width: 800, height: 450 } });
await page.goto(url, { waitUntil: 'load' });
await page.waitForFunction(() => Boolean(window.__paintball), { timeout: 60_000 });
await page.evaluate(() => window.__paintball.setManualSim(true));
await page.waitForFunction(() => !document.querySelector('#loader'), { timeout: 120_000 });

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

/**
 * A box and a prism, built by the real class, with every face checked.
 *
 * This is the test that would have caught the bug. It is exact rather than
 * statistical: a box centred on the origin has six faces, and every one of them
 * must have its normal pointing away from that origin. The merged city meshes
 * cannot be checked this way — half the walls in a district legitimately face
 * its centre — which is precisely why the check belongs on the primitive.
 */
const primitives = await page.evaluate(() => {
  const { MeshBuilder } = window.__paintball;
  const WHITE = { r: 1, g: 1, b: 1 };

  const inspect = (build) => {
    const builder = new MeshBuilder();
    build(builder);
    const geometry = builder.finish();
    const pos = geometry.getAttribute('position');
    const nor = geometry.getAttribute('normal');
    const index = geometry.index;

    let inward = 0;
    let faces = 0;
    for (let i = 0; i < index.count; i += 3) {
      const a = index.getX(i);
      const b = index.getX(i + 1);
      const c = index.getX(i + 2);
      const cx = (pos.getX(a) + pos.getX(b) + pos.getX(c)) / 3;
      const cy = (pos.getY(a) + pos.getY(b) + pos.getY(c)) / 3;
      const cz = (pos.getZ(a) + pos.getZ(b) + pos.getZ(c)) / 3;
      const dot = nor.getX(a) * cx + nor.getY(a) * cy + nor.getZ(a) * cz;
      faces++;
      if (dot <= 0) inward++;
    }
    geometry.dispose();
    return { faces, inward };
  };

  return {
    box: inspect((b) => b.box(0, 0, 0, 2, 3, 4, WHITE)),
    'tapered box': inspect((b) => b.box(0, 0, 0, 2, 3, 4, WHITE, 0.2)),
    prism: inspect((b) => b.prism(0, 0, -2, 2, 1.5, 8, WHITE)),
  };
});

for (const [name, result] of Object.entries(primitives)) {
  check(
    `${name} faces point outward`,
    result.inward === 0 && result.faces > 0,
    `${result.faces - result.inward}/${result.faces} outward`,
  );
}

/**
 * And the city's own geometry, for the failures a primitive cannot show: a
 * normal that came out NaN or zero-length from a degenerate polygon.
 */
const cityNormals = await page.evaluate(() => {
  const scene = window.__paintball.game.render.scene;
  let nan = 0;
  let degenerate = 0;
  let sampled = 0;
  scene.traverse((object) => {
    const geometry = object.geometry;
    if (!object.isMesh || !geometry?.index || !geometry.getAttribute('color')) return;
    if (geometry.index.count < 600) return;
    const nor = geometry.getAttribute('normal');
    const index = geometry.index;
    const stride = Math.max(3, Math.floor(index.count / 3000) * 3);
    for (let i = 0; i < index.count; i += stride) {
      const a = index.getX(i);
      const x = nor.getX(a);
      const y = nor.getY(a);
      const z = nor.getZ(a);
      sampled++;
      if (Number.isNaN(x) || Number.isNaN(y) || Number.isNaN(z)) { nan++; continue; }
      if (Math.hypot(x, y, z) < 0.5) degenerate++;
    }
  });
  return { nan, degenerate, sampled };
});

check('no NaN normals in the city geometry', cityNormals.nan === 0,
      `${cityNormals.nan} of ${cityNormals.sampled} sampled`);
check('no zero-length normals', cityNormals.degenerate === 0,
      `${cityNormals.degenerate} of ${cityNormals.sampled} sampled`);

/** Nothing should be lit from behind: the roofs, in particular, must face up. */
const roofsUp = await page.evaluate(() => {
  const scene = window.__paintball.game.render.scene;
  let up = 0;
  let total = 0;
  scene.traverse((object) => {
    const geometry = object.geometry;
    if (!object.isMesh || !geometry?.index || !geometry.getAttribute('color')) return;
    if (geometry.index.count < 600) return;
    const pos = geometry.getAttribute('position');
    const nor = geometry.getAttribute('normal');
    const index = geometry.index;
    const stride = Math.max(3, Math.floor(index.count / 2000) * 3);
    for (let i = 0; i < index.count; i += stride) {
      const a = index.getX(i);
      // Faces well above the courtyard that are steeply inclined are roof.
      if (pos.getY(a) < 6) continue;
      const ny = nor.getY(a);
      if (Math.abs(ny) < 0.35) continue;
      total++;
      if (ny > 0) up++;
    }
  });
  return { up, total };
});
check(
  'roof faces point at the sky',
  roofsUp.total === 0 || roofsUp.up / roofsUp.total > 0.55,
  `${roofsUp.up}/${roofsUp.total} up`,
);

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
