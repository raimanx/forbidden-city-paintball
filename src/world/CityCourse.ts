import { Color } from 'three';
import type { Rng } from '../core/Random';
import type { BoxCollider, BuildTarget, Surroundings } from './CityBuilding';
import {
  IMPERIAL_WAY,
  INTERIOR,
  heightAt,
  riverMask,
  terraceMask,
} from './CityLayout';

/**
 * The paintball course, dropped into the courtyards.
 *
 * Somebody has hired the Forbidden City for the afternoon. The pieces here are
 * what they brought in a lorry: shipping containers with a door cut in one end,
 * scaffold towers with a plank deck, plywood barricades on A-frames, stacked
 * pallets, cable drums and oil drums, and a canopy over the staging table.
 *
 * ## Why they are here at all
 *
 * The compound is superb at long sightlines and hopeless at cover. Its courts
 * are ceremonial voids — the great court is 90m of flat brick with nothing on it
 * but the imperial way — and a fight in one comes down to whoever saw the other
 * first across sixty metres of open ground. Every piece here is a thing to get
 * behind, shoot around, or stand on, placed in the middle of exactly those
 * voids. The container is the important one: it is the only structure on the map
 * you can be *inside*, with a door at one end and a slit down one side.
 *
 * ## Why they look wrong on purpose
 *
 * Corrugated steel in shipping blue, orange safety netting and scaffold tube,
 * against six hundred years of cinnabar and gold. That contrast is the joke the
 * whole game is built on, and softening it — weathering them, or painting them
 * imperial yellow — would throw away the one thing that says a match is being
 * played here rather than a dynasty being run.
 *
 * ## Where they go
 *
 * Scattered, not placed by hand. Each zone below is a courtyard that the plan
 * says is open ground, and pieces are dealt into it from the seeded rng with
 * anything that lands on a building, a terrace skirt, the river or the axis
 * rejected. Authored coordinates would be exact until the day the survey is
 * re-fetched and a hall moves three metres.
 */

/** Kinds of thing in the lorry. */
export type CourseKind =
  | 'container'
  | 'tower'
  | 'barricade'
  | 'crates'
  | 'spool'
  | 'drums'
  | 'canopy';

export interface CourseSite {
  kind: CourseKind;
  x: number;
  z: number;
  /** Long axis east-west. Pieces are axis-aligned; this is the only turn. */
  alongX: boolean;
}

/** Shipping steel, scaffold tube, plywood and tarpaulin. */
const COURSE_COLORS = {
  containerBlue: new Color(0x35667a),
  containerRust: new Color(0x9d5334),
  containerGrey: new Color(0x7b8288),
  /** Galvanised scaffold, and the drums. */
  steel: new Color(0x969ba1),
  drum: new Color(0xa8452f),
  /** Sawn ply and pallet timber — the one warm note, and it is not palace warm. */
  ply: new Color(0xbb9457),
  pallet: new Color(0xa4854f),
  /** Safety orange. There is nothing else this colour within a kilometre. */
  hazard: new Color(0xd4762a),
  tarp: new Color(0x5f7480),
} as const;

/** Half-extents of the footprint each kind needs kept clear, in metres. */
const FOOTPRINT: Record<CourseKind, { hw: number; hd: number }> = {
  container: { hw: 3.2, hd: 1.4 },
  tower: { hw: 2.6, hd: 1.9 },
  barricade: { hw: 1.4, hd: 0.7 },
  crates: { hw: 1.3, hd: 1.3 },
  spool: { hw: 1.2, hd: 1.2 },
  drums: { hw: 1.1, hd: 1.1 },
  canopy: { hw: 3.2, hd: 2.2 },
};

/**
 * The courtyards worth setting up in, and what goes in each.
 *
 * The counts are a judgement about the fight rather than about the furniture: a
 * court you cross under fire wants something to break the crossing into two
 * runs, and the great court — the largest open ground on the map, overlooked by
 * the terrace — wants the most.
 */
const ZONES: ReadonlyArray<{
  name: string;
  minX: number; maxX: number; minZ: number; maxZ: number;
  pieces: CourseKind[];
}> = [
  {
    // Between the Gate of Supreme Harmony and the foot of the great terrace.
    name: 'the great court',
    minX: -52, maxX: 52, minZ: 82, maxZ: 124,
    pieces: ['container', 'container', 'tower', 'barricade', 'barricade', 'crates', 'spool', 'drums'],
  },
  {
    // The outer court, north of the Meridian Gate and clear of the river.
    name: 'the outer court',
    minX: -74, maxX: 74, minZ: 184, maxZ: 200,
    pieces: ['container', 'canopy', 'barricade', 'crates', 'drums'],
  },
  {
    // The court of the Gate of Heavenly Purity, where the Inner Court begins.
    name: 'the inner court',
    minX: -38, maxX: 38, minZ: -60, maxZ: -36,
    pieces: ['container', 'tower', 'barricade', 'spool'],
  },
  {
    // The north end of the axis, in front of the Gate of Divine Might.
    name: 'the north court',
    minX: -42, maxX: 42, minZ: -214, maxZ: -196,
    pieces: ['container', 'barricade', 'crates', 'drums'],
  },
  {
    name: 'the east flank',
    minX: 58, maxX: 86, minZ: 100, maxZ: 140,
    pieces: ['container', 'barricade', 'crates'],
  },
  {
    name: 'the west flank',
    minX: -86, maxX: -58, minZ: 100, maxZ: 140,
    pieces: ['container', 'barricade', 'spool'],
  },
];

/**
 * Deals the pieces into the courtyards.
 *
 * Every candidate is checked against the plan before it is kept, and a piece
 * that cannot find a spot in thirty tries is dropped rather than forced: a
 * container standing in the Hall of Supreme Harmony would be a worse joke than
 * no container at all.
 */
export function courseSites(rng: Rng, around: Surroundings): CourseSite[] {
  const sites: CourseSite[] = [];

  for (const zone of ZONES) {
    for (const kind of zone.pieces) {
      const size = FOOTPRINT[kind];
      for (let attempt = 0; attempt < 30; attempt++) {
        const alongX = rng.bool(0.55);
        const hw = alongX ? size.hw : size.hd;
        const hd = alongX ? size.hd : size.hw;
        const x = rng.range(zone.minX + hw, zone.maxX - hw);
        const z = rng.range(zone.minZ + hd, zone.maxZ - hd);
        if (!isClear(x, z, hw, hd, around, sites)) continue;
        sites.push({ kind, x, z, alongX });
        break;
      }
    }
  }

  return sites;
}

/**
 * True where a piece can stand: flat courtyard, inside the walls, and clear of
 * everything the plan and the other pieces have already claimed.
 */
function isClear(
  x: number, z: number, hw: number, hd: number,
  around: Surroundings,
  placed: readonly CourseSite[],
): boolean {
  const margin = 1.2;
  if (Math.abs(x) > INTERIOR.halfX - 6 || Math.abs(z) > INTERIOR.halfZ - 6) return false;

  // Flat ground only. The corners are sampled as well as the centre, so a piece
  // cannot straddle the terrace skirt with one end in the air.
  for (const [dx, dz] of [[0, 0], [-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
    const px = x + dx * hw;
    const pz = z + dz * hd;
    if (Math.abs(heightAt(px, pz)) > 0.35) return false;
    if (terraceMask(px, pz) > 0.01 || riverMask(px, pz) > 0.01) return false;
  }

  // The imperial way stays clear. It is the strongest line on the map and the
  // one piece of the composition a lorry-load of scaffolding could actually
  // spoil — and it is also the route everyone walks, which is the game reason.
  if (Math.abs(x - IMPERIAL_WAY.x) < hw + IMPERIAL_WAY.halfWidth + 2.5) return false;

  for (const b of around.solids) {
    if (Math.abs(b.cx - x) < b.hw + hw + margin && Math.abs(b.cz - z) < b.hd + hd + margin) {
      return false;
    }
  }
  for (const p of around.platforms) {
    if (Math.abs(p.cx - x) < p.hw + hw && Math.abs(p.cz - z) < p.hd + hd) return false;
  }
  for (const other of placed) {
    const o = FOOTPRINT[other.kind];
    const ohw = other.alongX ? o.hw : o.hd;
    const ohd = other.alongX ? o.hd : o.hw;
    // Four metres apart at the closest, so two pieces are two pieces of cover
    // rather than one lump, and there is room to run between them.
    if (Math.abs(other.x - x) < ohw + hw + 4 && Math.abs(other.z - z) < ohd + hd + 4) {
      return false;
    }
  }
  return true;
}

/** Builds one piece, returning its colliders. */
export function buildCoursePiece(
  site: CourseSite,
  groundAt: (x: number, z: number) => number,
  out: BuildTarget,
  rng: Rng,
): BoxCollider[] {
  const y = groundAt(site.x, site.z);
  switch (site.kind) {
    case 'container': return buildContainer(site, y, out, rng);
    case 'tower': return buildTower(site, y, out);
    case 'barricade': return buildBarricade(site, y, out);
    case 'crates': return buildCrates(site, y, out, rng);
    case 'spool': return buildSpool(site, y, out);
    case 'drums': return buildDrums(site, y, out, rng);
    case 'canopy': return buildCanopy(site, y, out);
  }
}

/**
 * A twenty-foot shipping container, with a door at one end and a slit down one
 * side.
 *
 * The only interior on the map. Built as six pieces rather than a box — two
 * sides, a back, two door jambs with a header over them, and a roof — because
 * the point of it is that a player can stand inside and shoot out, and be shot
 * at through the slit while they do. True size, 6.06 by 2.44 by 2.59, which
 * makes it the one object in the compound whose scale a player already knows.
 */
function buildContainer(
  site: CourseSite, y: number, out: BuildTarget, rng: Rng,
): BoxCollider[] {
  const colliders: BoxCollider[] = [];
  const hue = rng.pick([
    COURSE_COLORS.containerBlue, COURSE_COLORS.containerRust, COURSE_COLORS.containerGrey,
  ]);
  const halfLength = 3.03;
  const halfWidth = 1.22;
  const height = 2.59;
  const wall = 0.09;
  /** Half-width of the doorway, and of the firing slit. */
  const doorHalf = 0.72;
  const doorHeight = 2.0;

  // Local axes: `l` runs along the container, `t` across it.
  const along = (l: number, t: number): [number, number] =>
    site.alongX ? [site.x + l, site.z + t] : [site.x + t, site.z + l];
  const halfOf = (hl: number, ht: number): [number, number] =>
    site.alongX ? [hl, ht] : [ht, hl];

  const slab = (
    l: number, t: number, hl: number, ht: number,
    cy: number, hh: number, color: Color,
  ): void => {
    const [cx, cz] = along(l, t);
    const [hw, hd] = halfOf(hl, ht);
    out.timber.box(cx, cy, cz, hw, hh, hd, color);
    colliders.push({ cx, cy, cz, hw, hh, hd, surface: 'timber' });
  };

  // Long sides, with the firing slit cut out of one of them: a metre-eighty of
  // opening at chest height, which is a rifle port from inside and a very small
  // target from outside.
  const slitBottom = 1.15;
  const slitTop = 1.62;
  const slitHalf = 0.9;
  for (const side of [-1, 1]) {
    if (side < 0) {
      // The plain side.
      slab(0, side * (halfWidth - wall), halfLength, wall, y + height / 2, height / 2, hue);
      continue;
    }
    const t = side * (halfWidth - wall);
    // Below the slit, above it, and the two returns either side.
    slab(0, t, halfLength, wall, y + slitBottom / 2, slitBottom / 2, hue);
    slab(0, t, halfLength, wall, y + (slitTop + height) / 2, (height - slitTop) / 2, hue);
    const wing = (halfLength - slitHalf) / 2;
    for (const end of [-1, 1]) {
      slab(end * (slitHalf + wing), t, wing, wall,
           y + (slitBottom + slitTop) / 2, (slitTop - slitBottom) / 2, hue);
    }
  }

  // The closed end.
  slab(-(halfLength - wall), 0, wall, halfWidth, y + height / 2, height / 2, hue);

  // The door end: two jambs and a header, so the doorway is a hole you walk
  // through rather than a gap you have to jump.
  const jamb = (halfWidth - doorHalf) / 2;
  for (const side of [-1, 1]) {
    slab(halfLength - wall, side * (doorHalf + jamb), wall, jamb,
         y + height / 2, height / 2, hue);
  }
  slab(halfLength - wall, 0, wall, halfWidth,
       y + (doorHeight + height) / 2, (height - doorHeight) / 2, hue);

  // The roof. Standing on a container is worth a metre and a half of view over
  // a courtyard wall, and the only way up is the crate stack beside it.
  slab(0, 0, halfLength, halfWidth, y + height + 0.06, 0.06, hue);

  // Corrugation: a rib every 30cm down both sides, which is most of what makes
  // a blue box read as a shipping container rather than as a blue box.
  const ribColor = new Color().copy(hue).multiplyScalar(0.86);
  for (let l = -halfLength + 0.3; l < halfLength - 0.2; l += 0.42) {
    for (const side of [-1, 1]) {
      const [cx, cz] = along(l, side * halfWidth);
      const [hw, hd] = halfOf(0.06, 0.03);
      out.timber.box(cx, y + height / 2, cz, hw, height / 2 - 0.12, hd, ribColor);
    }
  }
  // And the hazard stripe along the door end, because a container that has been
  // hired for the day has been marked up by somebody.
  {
    const [cx, cz] = along(halfLength - wall * 0.5, 0);
    const [hw, hd] = halfOf(0.04, halfWidth);
    out.timber.box(cx, y + height - 0.28, cz, hw, 0.12, hd, COURSE_COLORS.hazard);
  }

  return colliders;
}

/**
 * A scaffold tower with a plank deck, and a stack of pallets to get onto it.
 *
 * High ground. The compound is flat, the great terrace is the only rise on the
 * map, and a 1.8m deck in the middle of a courtyard changes how the courtyard
 * plays more than anything else in this file. The steps are 0.45m — exactly the
 * player's autostep — so getting up is a matter of walking at it.
 */
function buildTower(site: CourseSite, y: number, out: BuildTarget): BoxCollider[] {
  const colliders: BoxCollider[] = [];
  const deckY = y + 1.75;
  const half = 1.5;

  const box = (
    cx: number, cy: number, cz: number, hw: number, hh: number, hd: number,
    color: Color, solid = true,
  ): void => {
    out.timber.box(cx, cy, cz, hw, hh, hd, color);
    if (solid) colliders.push({ cx, cy, cz, hw, hh, hd, surface: 'timber' });
  };

  // Four legs and the braces between them, in scaffold tube.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      box(site.x + sx * half, y + 1.35, site.z + sz * half, 0.09, 1.35, 0.09,
          COURSE_COLORS.steel, false);
    }
  }
  for (const sz of [-1, 1]) {
    box(site.x, y + 0.9, site.z + sz * half, half, 0.07, 0.07, COURSE_COLORS.steel, false);
  }

  // The deck, and a kick rail round three sides of it so it reads as a platform
  // and gives someone kneeling on it something to shoot over.
  box(site.x, deckY, site.z, half, 0.09, half, COURSE_COLORS.ply);
  for (const sx of [-1, 1]) {
    box(site.x + sx * half, deckY + 0.55, site.z, 0.06, 0.45, half,
        COURSE_COLORS.hazard);
  }
  box(site.x, deckY + 0.55, site.z - half, half, 0.45, 0.06, COURSE_COLORS.hazard);

  // The stair: three pallet stacks, tallest against the tower and each one a
  // step below the last, so it is climbed from the courtyard inwards. Built the
  // other way round — which is the order the loop wants to be written — the
  // first thing anyone meets walking up to it is a 1.35m wall.
  for (let step = 0; step < 3; step++) {
    const h = 0.45 * (3 - step);
    const z = site.z + half + 0.5 + step * 0.9;
    box(site.x, y + h / 2, z, half * 0.8, h / 2, 0.45, COURSE_COLORS.pallet);
  }

  return colliders;
}

/** A plywood barricade on an A-frame — chest-high cover, and nothing else. */
function buildBarricade(site: CourseSite, y: number, out: BuildTarget): BoxCollider[] {
  const colliders: BoxCollider[] = [];
  const halfLength = site.alongX ? 1.25 : 0.09;
  const halfDepth = site.alongX ? 0.09 : 1.25;
  const height = 1.25;

  out.timber.box(site.x, y + height / 2, site.z, halfLength, height / 2, halfDepth,
    COURSE_COLORS.ply);
  colliders.push({
    cx: site.x, cy: y + height / 2, cz: site.z,
    hw: halfLength, hh: height / 2, hd: halfDepth, surface: 'timber',
  });

  // A batten across the top and the two feet, in scaffold tube.
  out.timber.box(site.x, y + height + 0.05, site.z, halfLength + 0.05, 0.05,
    halfDepth + 0.05, COURSE_COLORS.hazard);
  for (const side of [-1, 1]) {
    const fx = site.alongX ? site.x + side * (halfLength - 0.2) : site.x;
    const fz = site.alongX ? site.z : site.z + side * (halfDepth - 0.2);
    out.timber.box(fx, y + 0.06, fz, 0.12, 0.06, 0.5, COURSE_COLORS.steel);
  }
  return colliders;
}

/**
 * A stack of pallet crates.
 *
 * Stepped rather than square, so it is cover from one side and a way onto the
 * container roof from the other.
 */
function buildCrates(
  site: CourseSite, y: number, out: BuildTarget, rng: Rng,
): BoxCollider[] {
  const colliders: BoxCollider[] = [];
  let base = y;
  const count = rng.int(2, 4);
  for (let i = 0; i < count; i++) {
    const half = 0.6 - i * 0.08;
    const height = 0.55;
    const jitterX = rng.range(-0.12, 0.12);
    const jitterZ = rng.range(-0.12, 0.12);
    const cx = site.x + jitterX;
    const cz = site.z + jitterZ;
    out.timber.box(cx, base + height / 2, cz, half, height / 2, half,
      i % 2 === 0 ? COURSE_COLORS.pallet : COURSE_COLORS.ply);
    colliders.push({
      cx, cy: base + height / 2, cz, hw: half, hh: height / 2, hd: half,
      surface: 'timber',
    });
    base += height;
  }
  return colliders;
}

/** A timber cable drum, on its side. Round cover, which nothing else here is. */
function buildSpool(site: CourseSite, y: number, out: BuildTarget): BoxCollider[] {
  const radius = 1.05;
  const height = 1.3;
  out.timber.prism(site.x, site.z, y, y + height, radius, 12, COURSE_COLORS.pallet);
  // The hub, a little proud of the cheeks.
  out.timber.prism(site.x, site.z, y + height, y + height + 0.06, radius * 0.35, 8,
    COURSE_COLORS.ply);
  // A cuboid inside the cylinder rather than around it: a box at full radius
  // would stop a paintball in the air at the corners, where there is no drum.
  const half = radius * 0.78;
  return [{
    cx: site.x, cy: y + height / 2, cz: site.z,
    hw: half, hh: height / 2, hd: half, surface: 'timber',
  }];
}

/** Three oil drums, close enough to shelter behind and far enough to see past. */
function buildDrums(
  site: CourseSite, y: number, out: BuildTarget, rng: Rng,
): BoxCollider[] {
  const colliders: BoxCollider[] = [];
  const height = 0.88;
  for (let i = 0; i < 3; i++) {
    const angle = (i / 3) * Math.PI * 2 + rng.range(0, 1);
    const cx = site.x + Math.cos(angle) * 0.5;
    const cz = site.z + Math.sin(angle) * 0.5;
    out.timber.prism(cx, cz, y, y + height, 0.3, 10,
      i === 1 ? COURSE_COLORS.hazard : COURSE_COLORS.drum);
    colliders.push({
      cx, cy: y + height / 2, cz, hw: 0.23, hh: height / 2, hd: 0.23, surface: 'timber',
    });
  }
  return colliders;
}

/**
 * The staging canopy: a tarpaulin on four poles, with the trestle table under
 * it that the paint and the masks came out of.
 *
 * No walls. It is shade and a silhouette to shoot past rather than cover, and
 * the one piece here that says a person organised this.
 */
function buildCanopy(site: CourseSite, y: number, out: BuildTarget): BoxCollider[] {
  const colliders: BoxCollider[] = [];
  const hw = site.alongX ? 3.0 : 2.0;
  const hd = site.alongX ? 2.0 : 3.0;
  const eave = 2.3;

  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const cx = site.x + sx * (hw - 0.15);
      const cz = site.z + sz * (hd - 0.15);
      out.timber.box(cx, y + eave / 2, cz, 0.07, eave / 2, 0.07, COURSE_COLORS.steel);
      colliders.push({
        cx, cy: y + eave / 2, cz, hw: 0.1, hh: eave / 2, hd: 0.1, surface: 'timber',
      });
    }
  }

  // A shallow ridge to the tarpaulin, so it sheds rain the way a real one does.
  out.timber.box(site.x, y + eave + 0.12, site.z, hw, 0.06, hd, COURSE_COLORS.tarp);
  out.timber.box(site.x, y + eave + 0.3, site.z, hw * 0.45, 0.12, hd * 0.45,
    COURSE_COLORS.tarp);
  colliders.push({
    cx: site.x, cy: y + eave + 0.18, cz: site.z,
    hw, hh: 0.18, hd, surface: 'timber',
  });

  // The trestle table, and a crate of paint under it.
  const tableY = y + 0.78;
  out.timber.box(site.x, tableY, site.z - hd * 0.45, hw * 0.5, 0.05, 0.35,
    COURSE_COLORS.ply);
  colliders.push({
    cx: site.x, cy: tableY, cz: site.z - hd * 0.45,
    hw: hw * 0.5, hh: 0.05, hd: 0.35, surface: 'timber',
  });
  for (const side of [-1, 1]) {
    out.timber.box(site.x + side * hw * 0.42, (y + tableY) / 2, site.z - hd * 0.45,
      0.05, (tableY - y) / 2, 0.3, COURSE_COLORS.steel);
  }
  out.timber.box(site.x - hw * 0.2, y + 0.28, site.z - hd * 0.45, 0.4, 0.28, 0.28,
    COURSE_COLORS.hazard);

  return colliders;
}
