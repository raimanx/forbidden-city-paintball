/**
 * Headless tests on the compound's 783 structures.
 *
 * The three things a building owes the game before anything else is asked of
 * it: it stands on the ground, it does not stand inside another building, and
 * you cannot walk into it. None of the three is visible in a screenshot taken
 * from anywhere in particular — a gate hovering 0.9m over its own courtyard
 * looks like a gate until you walk under it, and a wall run passing through a
 * hall is hidden by the hall — so all three are checked here, exhaustively,
 * rather than looked for by eye.
 *
 * Runs in Node against the real world modules, loaded through Vite so the
 * TypeScript is the same TypeScript the game ships. No browser, no physics: the
 * geometry and the colliders are both worked out by `CityBuilding`, and that is
 * what is under test. The arena's own pieces — the perimeter wall, the great
 * terrace, the bridges — are `tools/arena-test.mjs`'s job, because they are only
 * true once a player is standing on them.
 *
 * Usage: node tools/structure-test.mjs
 */
import { createServer } from 'vite';

const server = await createServer({
  configFile: false,
  root: process.cwd(),
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'error',
});

const { STRUCTURES } = await server.ssrLoadModule('/src/world/CityPlan.ts');
const { COLLIDER_MARGIN, buildStructure, surroundings } =
  await server.ssrLoadModule('/src/world/CityBuilding.ts');
const { MeshBuilder } = await server.ssrLoadModule('/src/world/MeshBuilder.ts');
const { heightAt, inField, onTheGreatTerrace, planLength, planX, planZ } =
  await server.ssrLoadModule('/src/world/CityLayout.ts');

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const named = (s) => s.zh || s.en || `${s.kind} at (${s.x}, ${s.z})`;

/** Buildings proper: the kinds that are a solid you can walk into. */
const SOLID = new Set(['hall', 'gate', 'tower', 'kiosk', 'range', 'gallery']);

/**
 * Whether anything can reach this structure.
 *
 * Two thirds of the compound is now outside the field a match is played in —
 * see `CityLayout.FIELD` — and scenery well beyond the netting carries no
 * colliders at all, deliberately. So the checks that are about *walking into*
 * a building apply where a player can be, and the far city is checked only for
 * the things that are true of it as a picture.
 */
const reachable = (entry) => inField(entry.cx, entry.cz, COLLIDER_MARGIN);

// --- build the city, exactly as the arena does -----------------------------

const around = surroundings(heightAt);
const built = [];
for (const s of STRUCTURES) {
  const cx = planX(s.x);
  const cz = planZ(s.z);
  // The arena drops the survey's tracings of the great terrace, which is
  // terrain here. See CityLayout.onTheGreatTerrace.
  if (s.kind === 'platform' && onTheGreatTerrace(cx, cz)) continue;

  const target = {
    roof: new MeshBuilder(), timber: new MeshBuilder(), stone: new MeshBuilder(),
    // The roofs' colliders, which this suite does not inspect: they are hulls
    // rather than boxes, and what they owe the game — paint sticking to a roof
    // — is checked by firing at one in tools/arena-test.mjs.
    hulls: [],
  };
  const colliders = buildStructure(s, heightAt, target, around);

  let lowest = Infinity;
  for (const key of ['roof', 'timber', 'stone']) {
    const geometry = target[key].finish();
    if (!geometry) continue;
    const position = geometry.getAttribute('position');
    for (let i = 0; i < position.count; i++) lowest = Math.min(lowest, position.getY(i));
    geometry.dispose();
  }

  built.push({
    s, colliders, lowest,
    cx, cz, hw: planLength(s.w) / 2, hd: planLength(s.d) / 2,
  });
}
console.log(`built ${built.length} structures, ${built.reduce((n, b) => n + b.colliders.length, 0)} colliders\n`);

// --- nothing floats --------------------------------------------------------
// The lowest ground under a footprint, on a fine grid rather than at the four
// corners: a footprint that straddles the terrace skirt has its low point in
// the middle of an edge as often as at a corner.

function lowestGroundUnder(cx, cz, hw, hd) {
  let low = Infinity;
  for (let a = -1; a <= 1; a += 0.2) {
    for (let b = -1; b <= 1; b += 0.2) {
      low = Math.min(low, heightAt(cx + a * hw, cz + b * hd));
    }
  }
  return low;
}

/** The platform a structure stands on, if it stands on one. */
function platformUnder(entry) {
  const area = 4 * entry.hw * entry.hd;
  let top;
  for (const p of around.platforms) {
    const ox = Math.min(entry.cx + entry.hw, p.cx + p.hw) - Math.max(entry.cx - entry.hw, p.cx - p.hw);
    const oz = Math.min(entry.cz + entry.hd, p.cz + p.hd) - Math.max(entry.cz - entry.hd, p.cz - p.hd);
    if (ox <= 0 || oz <= 0 || (ox * oz) / area < 0.85) continue;
    if (top === undefined || p.top > top) top = p.top;
  }
  return top;
}

const floating = [];
for (const entry of built) {
  if (!Number.isFinite(entry.lowest)) continue;
  // A building on a stone base stands on the base, which is itself on the
  // ground; the corner towers stand on the perimeter wall.
  if (entry.s.kind === 'tower' && entry.s.roof === 'triple') continue;
  const floor = platformUnder(entry) ?? lowestGroundUnder(entry.cx, entry.cz, entry.hw, entry.hd);
  const gap = entry.lowest - floor;
  if (gap > 0.15) floating.push(`${named(entry.s)} +${gap.toFixed(2)}m`);
}
check('every structure reaches the ground', floating.length === 0,
      floating.length ? `${floating.length}: ${floating.slice(0, 6).join(', ')}` : `${built.length} checked`);

// --- no building stands inside another -------------------------------------
// Courtyard walls and platforms are exempt, and both for the same reason: they
// are not solids competing for the same ground. A courtyard wall is an outline
// that crosses its neighbours' outlines at the corners of the maze, and a
// platform is the stone base other things are meant to be standing on — a hall's
// plinth inside its own base is the plinth doing its job.

const cells = new Map();
const CELL = 20;
built.forEach((entry, index) => {
  for (const box of entry.colliders) {
    for (let x = Math.floor((box.cx - box.hw) / CELL); x <= Math.floor((box.cx + box.hw) / CELL); x++) {
      for (let z = Math.floor((box.cz - box.hd) / CELL); z <= Math.floor((box.cz + box.hd) / CELL); z++) {
        const key = `${x},${z}`;
        let list = cells.get(key);
        if (!list) cells.set(key, list = []);
        list.push({ index, box });
      }
    }
  }
});

const clashes = new Map();
for (const list of cells.values()) {
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i];
      const b = list[j];
      if (a.index === b.index) continue;
      if (!SOLID.has(built[a.index].s.kind) || !SOLID.has(built[b.index].s.kind)) continue;
      const ox = Math.min(a.box.cx + a.box.hw, b.box.cx + b.box.hw)
               - Math.max(a.box.cx - a.box.hw, b.box.cx - b.box.hw);
      const oy = Math.min(a.box.cy + a.box.hh, b.box.cy + b.box.hh)
               - Math.max(a.box.cy - a.box.hh, b.box.cy - b.box.hh);
      const oz = Math.min(a.box.cz + a.box.hd, b.box.cz + b.box.hd)
               - Math.max(a.box.cz - a.box.hd, b.box.cz - b.box.hd);
      // A hand's breadth of tolerance: two buildings that share a party wall
      // are not two buildings inside each other.
      if (ox <= 0.1 || oy <= 0.1 || oz <= 0.1) continue;
      const key = `${Math.min(a.index, b.index)}-${Math.max(a.index, b.index)}`;
      clashes.set(key, (clashes.get(key) ?? 0) + ox * oy * oz);
    }
  }
}
const worst = [...clashes.entries()]
  .sort((x, y) => y[1] - x[1])
  .slice(0, 5)
  .map(([key, volume]) => {
    const [i, j] = key.split('-').map(Number);
    return `${named(built[i].s)} × ${named(built[j].s)} (${volume.toFixed(0)}m³)`;
  });
check('no building stands inside another building', clashes.size === 0,
      clashes.size ? `${clashes.size} pairs: ${worst.join('; ')}` : 'clear');

// --- you cannot walk into a building ---------------------------------------
// Every solid needs a collider standing across it at head height. The failure
// this catches is a whole class: a structure drawn but never registered, a
// collider left at the plinth's height while the walls went up, a gate whose
// piers were built and whose colliders were not.

const HEAD = 1.6;

/**
 * The height reached by the union of colliders standing over a point.
 *
 * The union, not any single box: a building is a plinth with a wall on top of
 * it, and neither alone reaches from the pavement to head height. A centimetre
 * of slack between one box and the next, because a plinth's top and the wall's
 * foot are the same number arrived at by two different sums and they do not
 * always land on the same float.
 */
function reachOver(entry, x, z, floor) {
  const spans = entry.colliders
    .filter((box) => Math.abs(box.cx - x) < box.hw && Math.abs(box.cz - z) < box.hd)
    .map((box) => [box.cy - box.hh, box.cy + box.hh])
    .sort((a, b) => a[0] - b[0]);
  let reach = floor + 0.15;
  for (const [low, high] of spans) {
    if (low > reach + 0.01) break;
    reach = Math.max(reach, high);
  }
  return reach;
}

const walkable = [];
for (const entry of built) {
  if (!SOLID.has(entry.s.kind)) continue;
  // A gate is a hole by design and is answered by the next check instead.
  if (entry.s.kind === 'gate') continue;
  if (!reachable(entry)) continue;
  // Measured from whatever the building stands on — the pavement, or the stone
  // base under the Inner Court's halls.
  const ground = platformUnder(entry) ?? heightAt(entry.cx, entry.cz);

  // Round the walls rather than through the middle. The halls near the field
  // are hollow now — you can walk into them — so the centre of one is supposed
  // to be air, and what has to be solid is the wall line.
  //
  // The wall line is read back off the colliders rather than recomputed from
  // the footprint: the survey traces eaves, so a building's walls stand a metre
  // or two inside its outline, and a test that sampled the outline would be
  // asking whether the *air under the eaves* is solid.
  const head = ground + HEAD;
  const standing = entry.colliders.filter((b) => b.cy - b.hh <= head && b.cy + b.hh >= head);
  if (standing.length === 0) {
    walkable.push(`${named(entry.s)} (nothing at head height)`);
    continue;
  }
  const wall = {
    minX: Math.min(...standing.map((b) => b.cx - b.hw)),
    maxX: Math.max(...standing.map((b) => b.cx + b.hw)),
    minZ: Math.min(...standing.map((b) => b.cz - b.hd)),
    maxZ: Math.max(...standing.map((b) => b.cz + b.hd)),
  };
  const inset = 0.16;
  let solidPoints = 0;
  let points = 0;
  const sample = (x, z) => {
    points++;
    if (reachOver(entry, x, z, ground) >= head) solidPoints++;
  };
  for (let i = 0; i <= 4; i++) {
    const tx = wall.minX + inset + ((wall.maxX - wall.minX - inset * 2) * i) / 4;
    const tz = wall.minZ + inset + ((wall.maxZ - wall.minZ - inset * 2) * i) / 4;
    sample(tx, wall.minZ + inset);
    sample(tx, wall.maxZ - inset);
    sample(wall.minX + inset, tz);
    sample(wall.maxX - inset, tz);
  }
  // Three fifths, because a doorway is a hole in the wall line on purpose and a
  // hall's front is mostly doorway.
  if (solidPoints / points < 0.6) {
    walkable.push(`${named(entry.s)} (${solidPoints}/${points} of its wall line)`);
  }
}
check('every building is solid at head height', walkable.length === 0,
      walkable.length ? `${walkable.length}: ${walkable.slice(0, 6).join(', ')}` : 'all solid');

// --- and the gates are still holes ------------------------------------------
// The other half of the same coin. A gate whose piers reach the ground is only
// right if the archways between them do not: this walks the centreline of every
// gate and asks for a gap wide enough to fit through.

const sealed = [];
const hollow = [];
for (const entry of built) {
  if (entry.s.kind !== 'gate' || !reachable(entry)) continue;
  const alongX = entry.hw >= entry.hd;
  const span = alongX ? entry.hw : entry.hd;
  const ground = heightAt(entry.cx, entry.cz);
  let open = 0;
  let widest = 0;
  let solidSamples = 0;
  let samples = 0;
  const step = 0.25;
  for (let t = -span; t <= span; t += step) {
    const x = alongX ? entry.cx + t : entry.cx;
    const z = alongX ? entry.cz : entry.cz + t;
    const blocked = entry.colliders.some((box) =>
      Math.abs(box.cx - x) < box.hw && Math.abs(box.cz - z) < box.hd
      && box.cy - box.hh < ground + 0.3 && box.cy + box.hh > ground + 1.0);
    open = blocked ? 0 : open + step;
    widest = Math.max(widest, open);
    samples++;
    if (blocked) solidSamples++;
  }
  // A shoulder's width plus the room to aim through it.
  if (widest < 1.2) sealed.push(`${named(entry.s)} (${widest.toFixed(1)}m)`);
  // And the other way about: a gate is piers with openings between them, not an
  // opening with a roof over it. Anything under a third solid has lost its
  // piers, which is a gate you can walk through anywhere along its frontage.
  if (solidSamples / samples < 0.33) {
    hollow.push(`${named(entry.s)} (${Math.round((solidSamples / samples) * 100)}% solid)`);
  }
}
check('every gate can be walked through', sealed.length === 0,
      sealed.length ? `${sealed.length} sealed: ${sealed.slice(0, 6).join(', ')}` : 'all pierced');
check('every gate still has its piers', hollow.length === 0,
      hollow.length ? `${hollow.length} hollow: ${hollow.slice(0, 6).join(', ')}` : 'all standing');

// --- and the far city costs nothing it does not have to ---------------------
// The scenery beyond the netting is looked at and never touched, so it carries
// no colliders. This is the other half of that bargain: if a structure inside
// the field ever lost its colliders the check above would catch it, and if the
// far city ever got them back, this one will.
const nearby = built.filter(reachable);
const farWithColliders = built.filter((e) => !reachable(e) && e.colliders.length > 0);
check('only the reachable city is collided',
      farWithColliders.length === 0 && nearby.length > 60,
      `${nearby.length} of ${built.length} structures collided, ` +
      `${farWithColliders.length} beyond reach`);

await server.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
