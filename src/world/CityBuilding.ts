import { Color, Vector3 } from 'three';
import { clamp, lerp } from '../core/MathUtils';
import type { MeshBuilder } from './MeshBuilder';
import { STRUCTURES, type RoofForm, type Structure } from './CityPlan';
import { SCALE, WALL, inField, onTheGreatTerrace, planLength, planX, planZ } from './CityLayout';

/**
 * One building, generated from its footprint.
 *
 * ## Why this is code and not a model
 *
 * There are 783 structures inside the walls and no two footprints are the same.
 * A Blender kit placed by instancing would have to stretch a hip roof from 6m to
 * 190m wide, and a stretched hip roof is instantly wrong: the pitch flattens,
 * the eave curve smears, and the tile courses turn to stripes of different
 * widths on the same building. Generating each roof to fit keeps every pitch,
 * every overhang and every eave lift correct at any size, for less code than the
 * placement tables would have taken — and nothing to download.
 *
 * Blender's work is the detail that *is* size-invariant and is placed on top of
 * this: the bracket sets, the ridge beasts, the balustrades, the lions and vats.
 *
 * ## What a building is made of
 *
 * Bottom to top, which is also the order it is built in:
 *
 * - A **plinth** (台基) of grey stone or, for the first rank, white marble.
 *   Nothing in the Forbidden City sits on the ground.
 * - A **body**: red wall, or a colonnade of red columns when the building is
 *   grand enough to be open at the front.
 * - A **frieze** — the blue-green polychrome band under the eaves. Two hundred
 *   triangles across the whole city and it does more for the look than anything
 *   else here.
 * - A **roof**: yellow glazed tile, deep overhanging eaves that lift at the
 *   edge, and a heavy ridge with a beast at each end.
 */

/** Colours. Sampled from photographs rather than from the heraldic ideal. */
export const CITY_COLORS = {
  /** Imperial yellow glazed tile, and its shaded underside. */
  tile: new Color(0xd9a12c),
  tileDeep: new Color(0xb07d1c),
  /** The library's black tiles, and the crown prince's green ones. */
  tileBlack: new Color(0x3b3a3f),
  tileGreen: new Color(0x4a7350),
  /** Ridges are a darker, greyer glaze than the field of the roof. */
  ridge: new Color(0xa8813a),
  /** Cinnabar. The walls, the columns, the doors. */
  red: new Color(0xa8382b),
  redDeep: new Color(0x8a2a20),
  /** The polychrome band under the eaves. */
  friezeBlue: new Color(0x3d6579),
  friezeGreen: new Color(0x3a6b55),
  /** Grey brick and stone: plinths, courtyard walls, the wall's base course. */
  stone: new Color(0x8f8a80),
  stoneDark: new Color(0x6a665f),
  /** White marble: the great terrace, balustrades, bridges. */
  marble: new Color(0xece7da),
  marbleShade: new Color(0xd2ccbb),
  /**
   * Timber under the eaves.
   *
   * Lighter than the real thing looks in a photograph, and on purpose: it is
   * almost always in the eave's own shadow, and a truthful dark brown lands on
   * the bottom band of the cel ramp and reads as a hole in the building.
   */
  timber: new Color(0x9c5a3c),
  /**
   * Lattice doors and windows — 隔扇. Timber frame over paper, which catches
   * the light and is the one warm pale note on an otherwise red wall.
   */
  lattice: new Color(0xc9a469),
} as const;

/**
 * How far outside the field a building still gets the full treatment.
 *
 * The match is played in the central spine — see `CityLayout.FIELD` — and the
 * other two thirds of the compound is scenery: seen from inside the netting,
 * across a courtyard, at fifty metres and up. Three things are spent on
 * proximity rather than on every one of the 783 structures:
 *
 * - **Joinery** — bracket courses, doors, lattice panels, painted friezes — is
 *   most of the city's triangle count and none of it resolves past about 40m.
 * - **Roof colliders**, which only matter where a ball can reach the roof.
 * - **Colliders at all**, which only matter where a player or a ball can be.
 *
 * The margins are generous on purpose: a building just outside the netting is
 * looked at closely and shot at often, and the moment a player notices the
 * detail changing they cannot stop noticing it.
 */
const DETAIL_MARGIN = 28;
const ROOF_COLLIDER_MARGIN = 45;
/** Exported so `tools/structure-test.mjs` checks the same buildings this does. */
export const COLLIDER_MARGIN = 85;

/** Which merged mesh a piece of the city is drawn into. */
export type Surface = 'roof' | 'timber' | 'stone';

/** An axis-aligned box collider, in world space. */
export interface BoxCollider {
  cx: number;
  cy: number;
  cz: number;
  hw: number;
  hh: number;
  hd: number;
  /**
   * The material this box was drawn in, where it is known.
   *
   * Carried so paint can be projected against the mesh that actually holds the
   * triangles it hit. Geometry is merged by material, so a plinth's collider
   * registered against the timber mesh finds no stone under the impact and the
   * splat is dropped — which was every plinth, coping and stone base in the
   * compound.
   */
  surface?: Surface;
}

/** A footprint in world space — what a structure occupies on the ground. */
export interface Footprint {
  cx: number;
  cz: number;
  hw: number;
  hd: number;
}

/**
 * What else stands nearby, so a structure can be built against its neighbours
 * rather than through them.
 *
 * The survey is a set of independent outlines and says nothing about how they
 * meet. Two things need to know:
 *
 * - **Courtyard walls** run *between* buildings in the real compound — a range
 *   closes the side of a court and the wall stops at its gable. Built from the
 *   outline alone, 265 wall runs pass straight through a building, and each one
 *   is a red wall growing out of a red wall halfway up its own roof.
 * - **Platforms** are the stone bases a group of halls stands on. A hall
 *   levelled onto the terrain instead of onto its base has its plinth buried in
 *   the slab it is meant to be standing on.
 */
export interface Surroundings {
  /** Buildings a courtyard wall has to stop at. */
  solids: readonly Footprint[];
  /** Stone platforms, with the height of the surface they present. */
  platforms: readonly (Footprint & { top: number })[];
}

/**
 * Reads the whole plan once and works out what stands where.
 *
 * Exported because the arena and `tools/structure-test.mjs` have to agree about
 * it exactly: a test that built the city from a different set of neighbours
 * would be checking a city nobody plays.
 */
export function surroundings(groundAt: (x: number, z: number) => number): Surroundings {
  const solids: Footprint[] = [];
  const platforms: Array<Footprint & { top: number }> = [];

  for (const s of STRUCTURES) {
    const cx = planX(s.x);
    const cz = planZ(s.z);
    const hw = planLength(s.w) / 2;
    const hd = planLength(s.d) / 2;
    if (s.kind === 'courtwall') continue;
    if (s.kind === 'platform') {
      // The survey's tracings of the great terrace are not built — the terrace
      // is terrain — so nothing stands on them either.
      if (onTheGreatTerrace(cx, cz)) continue;
      platforms.push({ cx, cz, hw, hd, top: platformTop(cx, cz, hw, hd, s.height * SCALE, groundAt) });
      continue;
    }
    solids.push({ cx, cz, hw, hd });
  }

  return { solids, platforms };
}

/** Where a building's geometry goes, split by the material it is drawn with. */
export interface BuildTarget {
  /** Glazed tile: roofs and ridges. */
  roof: MeshBuilder;
  /** Painted timber: walls, columns, friezes, doors. */
  timber: MeshBuilder;
  /** Stone and marble: plinths, terraces, paving, balustrades. */
  stone: MeshBuilder;
  /**
   * Convex hulls for the roofs, as flat `[x, y, z, …]` corner lists.
   *
   * Roofs cannot be colliders in the same breath as the rest of a building: a
   * box round one is an invisible ceiling hanging two metres out over the
   * courtyard. So they are collected here and built as hulls of their own real
   * shape — see `PhysicsWorld.createStaticHulls`.
   */
  hulls: Float32Array[];
}

/** How much of a building's height is roof, by what the building is. */
function roofFraction(kind: Structure['kind'], form: RoofForm): number {
  if (form === 'double') return 0.4;
  switch (kind) {
    case 'hall':
    case 'gate':
      // Over half. On a Chinese hall the roof is the building — the wall is a
      // low red band under it — and anything less reads as a shed with a hat.
      return 0.56;
    case 'kiosk':
      return 0.55;
    case 'tower':
      return 0.34;
    default:
      return 0.48;
  }
}

/**
 * Builds one structure into the target buffers, returning its colliders.
 *
 * `groundAt` is the terrain sampler; the building is levelled onto the highest
 * ground under its footprint and its plinth is deepened to reach the lowest, so
 * nothing floats and nothing is buried on the handful of footprints that
 * straddle the terrace skirt.
 */
export function buildStructure(
  s: Structure,
  groundAt: (x: number, z: number) => number,
  out: BuildTarget,
  around: Surroundings,
): BoxCollider[] {
  const cx = planX(s.x);
  const cz = planZ(s.z);
  const hw = planLength(s.w) / 2;
  const hd = planLength(s.d) / 2;
  const height = s.height * SCALE;

  /** Whether anything can reach this structure — see COLLIDER_MARGIN. */
  const reachable = inField(cx, cz, COLLIDER_MARGIN);

  if (s.kind === 'courtwall') {
    const boxes = buildCourtWall(cx, cz, hw, hd, groundAt, out, around);
    return reachable ? boxes : [];
  }
  if (s.kind === 'platform') {
    const boxes = buildPlatform(cx, cz, hw, hd, height, groundAt, out);
    return reachable ? boxes : [];
  }

  // Level onto the highest ground under the footprint; the plinth reaches down
  // to the lowest.
  //
  // Sampled over a grid rather than at the four corners, which is what this used
  // to do. A footprint that straddles the terrace skirt has its extremes in the
  // middle of an edge as often as at a corner, and a corner-only sample put the
  // Gate of the Rear Left 4.5m in the air over the ramp it stands on.
  const ground = groundRange(cx, cz, hw, hd, groundAt);
  // The corner towers stand *on* the wall at its four corners, not beside it,
  // so they are levelled onto the wall's head rather than onto the ground the
  // wall stands on. A building on a stone platform stands on the platform.
  // Everything else takes the highest ground under its own footprint.
  const onWall = s.kind === 'tower' && s.roof === 'triple';
  const platform = highestPlatformUnder(around, cx, cz, hw, hd);
  const top = onWall ? WALL.height : Math.max(ground.top, platform ?? -Infinity);
  const bottom = platform ?? ground.bottom;

  const grand = s.kind === 'hall' || s.kind === 'gate' || s.kind === 'tower';
  // Plinths are human-scale furniture, not part of the mass, so they are sized
  // in absolute metres rather than scaled with the building. A 0.4m step is a
  // step at any map scale; the same step at 0.45 would be a kerb.
  const plinthTop = grand ? 0.9 : 0.45;
  const plinthHeight = plinthTop + (top - bottom);
  const plinthY = top + plinthTop - plinthHeight / 2;
  const plinthColor = s.kind === 'hall' && s.w > 40 ? CITY_COLORS.marble : CITY_COLORS.stone;

  const baseY = top + plinthTop;
  const roofHeight = height * roofFraction(s.kind, s.roof);
  const bodyHeight = Math.max(height - roofHeight, 1.2);

  // The survey traces eaves, not walls, so the body is inset by the overhang.
  const overhang = clamp(height * 0.13, 0.5, 2.4);
  const bodyHw = Math.max(hw - overhang, hw * 0.35);
  const bodyHd = Math.max(hd - overhang, hd * 0.35);

  // The plinth oversails the walls but stops short of the eaves — and it has to
  // *carry* them. At 94% of a small footprint it came out 15cm narrower than
  // the wall standing on it, which leaves a hand's breadth of wall with nothing
  // under it all the way round the building.
  const plinthHw = Math.max(hw * 0.94, bodyHw + 0.2);
  const plinthHd = Math.max(hd * 0.94, bodyHd + 0.2);
  // Gates get no plinth: they are pierced, and a plinth across the archway is a
  // step you have to hop over to walk through your own gate.
  if (s.kind !== 'gate') {
    out.stone.box(cx, plinthY, cz, plinthHw, plinthHeight / 2, plinthHd, plinthColor);
  }

  // Gates are pierced; everything else is solid.
  //
  // A gate is a hole in a wall. Built solid — which is what a footprint alone
  // says — the Gate of Supreme Harmony seals the great court off from the outer
  // one, the Meridian Gate seals the whole compound, and a map with a wall
  // round it and no way through becomes a box with the player inside it. The
  // archways are what make the plan a route rather than a picture.
  const gateColliders = s.kind === 'gate'
    ? buildGateBody(s, cx, cz, bodyHw, bodyHd, baseY, bodyHeight, bottom, out)
    : null;

  /**
   * Whether this building is hollow — a shell you can walk into rather than a
   * solid block with a roof on it.
   *
   * The compound is 783 structures and a player could not get inside one of
   * them: every hall on the axis was a red box, and the only interior on the
   * map was a shipping container somebody trucked in. A hall's whole
   * architecture is an open colonnade in front of a hall you walk into, so it
   * is also the truer building.
   *
   * Not all of them. It has to be a ranked building — a hall, a kiosk, a
   * belvedere, one of the big ranges — near enough to the field to be entered,
   * and big enough inside to turn round in once its walls are 0.3m thick.
   */
  const hollow = !gateColliders
    && !onWall
    && (s.kind === 'hall' || s.kind === 'kiosk' || s.kind === 'tower' || s.kind === 'range')
    && bodyHw >= 4.5 && bodyHd >= 3.4 && bodyHeight >= 2.9
    // Inside the netting, or close enough to it that a player can see in.
    && inField(cx, cz, 12);

  const shellColliders = hollow
    ? buildHollowBody(cx, cz, bodyHw, bodyHd, baseY, bodyHeight, {
        plinthHw, plinthHd, plinthTop, ground: top, out, around,
      })
    : null;
  if (!gateColliders) {
    buildBody(s, cx, cz, bodyHw, bodyHd, baseY, bodyHeight, out, Boolean(shellColliders));
  }

  const eaveY = baseY + bodyHeight;
  // Head height over the ground this building stands on: no roof collider
  // reaches below it. See roofShell.
  //
  // A player who climbs onto a building's own plinth can still bump the eave of
  // a low gallery, which is what would happen to them in Beijing. What this
  // line rules out is an invisible ceiling over ground anyone walks on.
  // Beyond the field a roof is scenery: nothing can reach it, so it gets no
  // collider at all, which is what an infinite floor line means here.
  const hullFloor = inField(cx, cz, ROOF_COLLIDER_MARGIN) ? bottom + 1.95 : Infinity;
  /** Whether the roof gets its tile courses — see roofShell. */
  const courses = inField(cx, cz, DETAIL_MARGIN);
  if (s.roof === 'triple') {
    // The corner towers, and nothing else on the map. Three tiers of eaves,
    // each storey set inside the one below, which is the shape everybody has
    // seen reflected in the moat even if they have never heard the name.
    let y = eaveY;
    let tierHw = hw;
    let tierHd = hd;
    for (let tier = 0; tier < 3; tier++) {
      const tierRoofH = roofHeight * (tier === 2 ? 0.9 : 0.5);
      roofShell(out, cx, cz, tierHw, tierHd, y, tierRoofH, 'hip', roofColor(s),
        hullFloor, courses, tierHw * 0.8, tierHd * 0.8);
      if (tier === 2) break;
      const nextHw = tierHw * 0.76;
      const nextHd = tierHd * 0.76;
      const storey = Math.max(bodyHeight * 0.42, 1.2);
      const storeyBase = y + tierRoofH * 0.6;
      buildBody(s, cx, cz, nextHw * 0.86, nextHd * 0.86, storeyBase, storey, out);
      y = storeyBase + storey;
      tierHw = nextHw;
      tierHd = nextHd;
    }
  } else if (s.roof === 'hip2' || s.roof === 'double') {
    // 重檐 — the double eave, and the mark of the very top of the hierarchy.
    //
    // Two roofs and *two storeys*, not one wall with a skirt halfway up it. The
    // lower roof sits on the wall at full width; a second, inset wall rises out
    // of it carrying its own bracket course; and the upper roof caps that. Built
    // as a skirt instead — which is how it looks in a photograph if you do not
    // look twice — the lower roof reads as an awning and the building loses the
    // stacked mass that makes it monumental.
    // Tall enough, and the upper storey set in only a little, so the lower
    // roof's tiles clear the shadow the upper roof throws down onto them. At a
    // deeper inset the entire lower roof sits in that shadow and reads as a
    // brown apron rather than as gold.
    const lowerRoofH = roofHeight * 0.62;
    roofShell(out, cx, cz, hw, hd, eaveY, lowerRoofH, 'hip', roofColor(s),
      hullFloor, courses, bodyHw, bodyHd);

    // The upper storey stands inside the lower roof's ridge line.
    const upperHw = Math.max(hw - lowerRoofH * 0.62, hw * 0.5);
    const upperHd = Math.max(hd - lowerRoofH * 0.62, hd * 0.5);
    const upperBase = eaveY + lowerRoofH * 0.62;
    const upperBodyH = Math.max(bodyHeight * 0.34, 1.4);
    buildBody(s, cx, cz, upperHw * 0.86, upperHd * 0.86, upperBase, upperBodyH, out);
    roofShell(
      out, cx, cz, upperHw, upperHd,
      upperBase + upperBodyH, roofHeight * 0.8, 'hip', roofColor(s),
      hullFloor, courses, upperHw * 0.86, upperHd * 0.86,
    );
  } else {
    roofShell(out, cx, cz, hw, hd, eaveY, roofHeight, s.roof, roofColor(s),
      hullFloor, courses, bodyHw, bodyHd);
  }

  // One collider for the plinth step, and either one for a solid body or one
  // per pier for a pierced gate. The roof is not among them: it is a convex
  // hull, pushed to `out.hulls` by roofShell, because a box around an eave that
  // overhangs by 2.4m is an invisible ceiling out over the courtyard.
  //
  // A gate's plinth is left out entirely — it would be a step across the
  // archway you have to hop over to walk through your own gate.
  // Nothing far outside the field is collided at all. A player cannot reach it,
  // a ball cannot carry to it, and the compound's outer three quarters is 1,400
  // boxes that exist only to be queried and never hit.
  if (!reachable) return [];

  if (gateColliders) return gateColliders;

  const plinth: BoxCollider = {
    cx, cy: plinthY, cz, hw: plinthHw, hh: plinthHeight / 2, hd: plinthHd, surface: 'stone',
  };
  if (shellColliders) return [plinth, ...shellColliders];
  return [
    plinth,
    {
      cx, cy: baseY + bodyHeight / 2, cz,
      hw: bodyHw, hh: bodyHeight / 2, hd: bodyHd, surface: 'timber',
    },
  ];
}

/** Roof colour: yellow, unless the building is one of the famous exceptions. */
function roofColor(s: Structure): Color {
  // 文渊阁, the imperial library, is roofed in black — the colour of water, on
  // the building most in need of not burning down.
  if (s.zh.includes('文渊阁')) return CITY_COLORS.tileBlack;
  // The outer service ranges along the walls are grey-tiled, not glazed.
  if (s.kind === 'gallery' && Math.abs(s.x) > 300) return CITY_COLORS.stoneDark;
  return CITY_COLORS.tile;
}

/**
 * The body: a red wall, or a colonnade where the building is grand enough to
 * stand open.
 */
function buildBody(
  s: Structure,
  cx: number, cz: number,
  hw: number, hd: number,
  baseY: number, height: number,
  out: BuildTarget,
  /** Set when the caller has already built the wall as piers around an arch. */
  wallDrawn = false,
): void {
  const grand = !wallDrawn && (s.kind === 'hall' || s.kind === 'gate') && hw > 6 && height > 4;
  /**
   * Whether this building gets its joinery.
   *
   * The compound is 486 galleries and 21 ranges — long low buildings that form
   * the *walls* of the courtyards — and 90-odd halls, gates and towers that are
   * meant to be looked at. Giving all of them brackets, doors and painted panels
   * put 800,000 triangles in frame from the north end of the axis, four fifths
   * of them on buildings whose entire job is to be a red line closing a
   * courtyard. The ranked buildings keep every detail; the galleries keep their
   * frieze, which is the only part of it visible from across a courtyard anyway.
   */
  const ranked = (s.kind === 'hall' || s.kind === 'gate' || s.kind === 'tower'
    || s.kind === 'kiosk' || hw > 9)
    // And near enough to the field to be looked at. Two thirds of the compound
    // is now scenery beyond the netting — see DETAIL_MARGIN.
    && inField(cx, cz, DETAIL_MARGIN);

  // Halls are colonnaded along their long side; everything else is a plain
  // wall. Gates have had theirs built already, as piers around the archways.
  if (!wallDrawn) {
    out.timber.box(
      cx, baseY + height / 2, cz, hw, height / 2, hd,
      s.kind === 'gate' ? CITY_COLORS.redDeep : CITY_COLORS.red,
      0.02,
    );
  }

  if (grand) {
    // A row of columns standing proud of the wall, under the eave. Eight-sided
    // rather than round: at this size a cylinder costs triangles nobody can see
    // and the flat facets take the cel banding better.
    const columns = clamp(Math.round(hw / 1.9), 3, 11);
    const spacing = (hw * 1.86) / (columns - 1);
    const radius = clamp(height * 0.045, 0.18, 0.42);
    for (let i = 0; i < columns; i++) {
      const x = cx - hw * 0.93 + i * spacing;
      for (const side of [-1, 1]) {
        out.timber.prism(
          x, cz + side * hd * 1.02, baseY, baseY + height * 0.97,
          radius, 8, CITY_COLORS.red,
        );
      }
    }
  }

  // The polychrome band under the eaves — 彩画. A thin frieze, alternating in
  // colour along its length so it reads as painted panels rather than a stripe.
  const friezeH = clamp(height * 0.1, 0.25, 0.9);
  const friezeY = baseY + height - friezeH / 2;
  const panels = ranked ? clamp(Math.round(hw / 2.2), 2, 14) : 1;
  const panelW = (hw * 2) / panels;
  for (let i = 0; i < panels; i++) {
    const x = cx - hw + panelW * (i + 0.5);
    const color = i % 2 === 0 ? CITY_COLORS.friezeBlue : CITY_COLORS.friezeGreen;
    for (const side of [-1, 1]) {
      out.timber.box(
        x, friezeY, cz + side * (hd + 0.06),
        panelW * 0.46, friezeH / 2, 0.08, color,
      );
    }
  }
  // 斗拱 — the bracket sets that carry the eave. A course of stubby blocks
  // stepping out from the wall head, close-spaced, in the same blue-green as
  // the frieze with a gold face. At any distance they read as the dense
  // corbelled band that no other architecture has; up close they are boxes,
  // which is exactly what the ink-line look wants.
  if (ranked && hw > 3 && height > 3) {
    const bracketY = baseY + height + friezeH * 0.15;
    const bracketH = clamp(height * 0.035, 0.1, 0.26);
    // Close-spaced. A dougong course is dense — the blocks nearly touch — and
    // spacing them out turns the most recognisable band on the building into a
    // row of teal pegs.
    const step = clamp(hw / 9, 0.55, 1.1);
    for (let x = cx - hw + step * 0.5; x < cx + hw; x += step) {
      for (const side of [-1, 1]) {
        out.timber.box(
          x, bracketY, cz + side * (hd + bracketH * 0.9),
          bracketH * 0.55, bracketH, bracketH * 1.1, CITY_COLORS.friezeBlue,
        );
      }
    }
    for (let z = cz - hd + step * 0.5; z < cz + hd; z += step) {
      for (const side of [-1, 1]) {
        out.timber.box(
          cx + side * (hw + bracketH * 0.9), bracketY, z,
          bracketH * 1.1, bracketH, bracketH * 0.55, CITY_COLORS.friezeBlue,
        );
      }
    }
  }

  // Doors and lattice windows, on the two long faces. A row of tall dark
  // panels standing a little proud of the wall: at a distance the wall reads
  // as timber-framed rather than as one flat red slab, which is the single
  // thing that gives away a box pretending to be a building.
  if (ranked && !wallDrawn && height > 3 && hw > 2.5) {
    const bays = clamp(Math.round(hw / 1.6), 3, 15);
    const bayW = (hw * 1.8) / bays;
    const doorH = height * 0.62;
    // Close in, the lattice gets its bars: 隔扇 is a timber grid over paper,
    // and three mullions is the difference between a window and a beige
    // rectangle. Only inside the field — past about forty metres they are two
    // pixels apart and cost more than they show.
    const close = inField(cx, cz, 6);
    for (let i = 0; i < bays; i++) {
      const x = cx - hw * 0.9 + bayW * (i + 0.5);
      const lattice = i % 2 !== 0;
      for (const side of [-1, 1]) {
        // Alternating door and lattice panel. Both stand proud of the wall, so
        // each casts its own thin line of shadow and the facade gets the
        // vertical rhythm that a flat red box has no way to suggest.
        out.timber.box(
          x, baseY + doorH / 2, cz + side * (hd + 0.05),
          bayW * 0.38, doorH / 2, 0.06,
          lattice ? CITY_COLORS.lattice : CITY_COLORS.redDeep,
        );
        if (!close) continue;
        if (lattice) {
          for (const bar of [-0.5, 0, 0.5]) {
            out.timber.box(
              x + bar * bayW * 0.5, baseY + doorH / 2, cz + side * (hd + 0.09),
              bayW * 0.045, doorH / 2, 0.04, CITY_COLORS.timber,
            );
          }
          continue;
        }
        // 门钉 — the studs on a palace door, in two rows. Gold on cinnabar, and
        // the one thing on a red wall that catches the sun.
        for (const row of [0.36, 0.62]) {
          for (const col of [-0.45, 0, 0.45]) {
            out.timber.box(
              x + col * bayW * 0.5, baseY + doorH * row, cz + side * (hd + 0.1),
              bayW * 0.05, 0.05, 0.03, CITY_COLORS.ridge,
            );
          }
        }
      }
    }
  }

  const endPanels = ranked ? clamp(Math.round(hd / 2.2), 1, 10) : 1;
  const endPanelD = (hd * 2) / endPanels;
  for (let i = 0; i < endPanels; i++) {
    const z = cz - hd + endPanelD * (i + 0.5);
    const color = i % 2 === 0 ? CITY_COLORS.friezeGreen : CITY_COLORS.friezeBlue;
    for (const side of [-1, 1]) {
      out.timber.box(
        cx + side * (hw + 0.06), friezeY, z,
        0.08, friezeH / 2, endPanelD * 0.46, color,
      );
    }
  }
}

/**
 * A building with an inside.
 *
 * Four walls, a doorway or three through the front and one through the back, a
 * ceiling, and a row of columns down the middle. Everything a player needs to
 * be able to stand in a hall and shoot out of it — which no building in the
 * compound could offer before, so the only interior on the map was a shipping
 * container.
 *
 * The dimensions are the building's, not a room's. Doorways are 2.6m because
 * that is roughly a bay of the real thing and because anything narrower than
 * about three metres is a doorway the navgrid cannot see: cells are 2m and each
 * is probed at five points. The ceiling matters more than it sounds — the roof
 * above is a single-sided shell, so without one the view from inside a hall is
 * of the sky through its own tiles.
 */
function buildHollowBody(
  cx: number, cz: number,
  hw: number, hd: number,
  baseY: number, height: number,
  plan: {
    plinthHw: number; plinthHd: number; plinthTop: number;
    /** The levelled ground the plinth stands on. */
    ground: number;
    out: BuildTarget;
    /** The neighbours, so an entrance stair does not grow into one. */
    around: Surroundings;
  },
): BoxCollider[] {
  const { out } = plan;
  const colliders: BoxCollider[] = [];
  const thickness = 0.3;
  const doorHalf = 1.3;
  const doorTop = Math.min(height * 0.74, 2.7);

  const wall = (
    wx: number, wy: number, wz: number,
    whw: number, whh: number, whd: number,
    color: Color = CITY_COLORS.red,
  ): void => {
    out.timber.box(wx, wy, wz, whw, whh, whd, color, 0.02);
    colliders.push({ cx: wx, cy: wy, cz: wz, hw: whw, hh: whh, hd: whd, surface: 'timber' });
  };

  /** Where the doors go along a face, as offsets from its centre. */
  const doorCentres = (span: number, count: number): number[] => {
    const centres: number[] = [];
    for (let i = 0; i < count; i++) {
      centres.push(count === 1 ? 0 : (((i + 0.5) / count) * 2 - 1) * (span - doorHalf - 0.6));
    }
    return centres;
  };

  /** One pierced face: piers between the doorways, and a lintel over them. */
  const face = (alongX: boolean, side: -1 | 1, count: number): number[] => {
    const span = alongX ? hw : hd;
    const centres = doorCentres(span, count);
    let spans: Array<[number, number]> = [[-span, span]];
    for (const at of centres) spans = subtractSpan(spans, at - doorHalf, at + doorHalf);

    const fixed = (alongX ? cz : cx) + side * ((alongX ? hd : hw) - thickness / 2);
    for (const [a, b] of spans) {
      if (b - a < 0.15) continue;
      const mid = (a + b) / 2;
      const half = (b - a) / 2;
      wall(
        alongX ? cx + mid : fixed,
        baseY + height / 2,
        alongX ? fixed : cz + mid,
        alongX ? half : thickness / 2,
        height / 2,
        alongX ? thickness / 2 : half,
      );
    }
    // The lintel across the doorways, which is what makes an opening a doorway
    // rather than a gap between two walls.
    const lintel = (height - doorTop) / 2;
    if (lintel > 0.1) {
      wall(
        alongX ? cx : fixed,
        baseY + doorTop + lintel,
        alongX ? fixed : cz,
        alongX ? span : thickness / 2,
        lintel,
        alongX ? thickness / 2 : span,
      );
    }
    return centres;
  };

  // The front — the long south face, which is the one every hall in the
  // compound is entered from — gets a doorway per bay. The back gets one, so a
  // hall is a route rather than a dead end: a room with a single door is a room
  // nobody who is being shot at will ever walk into.
  const bays = clamp(Math.round(hw / 5), 1, 3);
  const front = face(true, 1, bays);
  face(true, -1, 1);
  // The ends are closed.
  for (const side of [-1, 1] as const) {
    wall(
      cx + side * (hw - thickness / 2), baseY + height / 2, cz,
      thickness / 2, height / 2, Math.max(hd - thickness, 0.2),
    );
  }

  // 匾额 — the name board over the central doorway, gold characters on a black
  // lacquer ground with a gilt frame. Every hall in the compound has one, it is
  // always in the same place, and at three boxes it is the cheapest thing in
  // this file that says *palace* rather than *building*.
  {
    const boardHalf = Math.min(hw * 0.28, 1.5);
    const boardY = baseY + Math.min(doorTop + 0.55, height - 0.35);
    const boardZ = cz + hd - thickness * 0.4;
    out.timber.box(cx, boardY, boardZ, boardHalf, 0.34, 0.06, CITY_COLORS.tileBlack);
    out.timber.box(cx, boardY, boardZ + 0.02, boardHalf * 0.86, 0.22, 0.05, CITY_COLORS.ridge);
  }

  // The ceiling. Not a collider: nothing can get above it that is not already
  // standing on the roof.
  out.timber.box(cx, baseY + height - 0.09, cz, hw - thickness, 0.09, hd - thickness,
    CITY_COLORS.timber);

  // 金柱, the interior columns. Cover inside the hall, and the thing that stops
  // an interior reading as a shed: a Chinese hall is a forest of columns.
  const columns = clamp(Math.round(hw / 4), 2, 5);
  for (let i = 0; i < columns; i++) {
    const x = cx + (((i + 0.5) / columns) * 2 - 1) * (hw - 1.4);
    for (const side of [-1, 1] as const) {
      const z = cz + side * (hd - thickness) * 0.45;
      out.timber.prism(x, z, baseY, baseY + height - 0.18, 0.24, 8, CITY_COLORS.red);
      colliders.push({
        cx: x, cy: baseY + height / 2, cz: z,
        hw: 0.22, hh: height / 2, hd: 0.22, surface: 'timber',
      });
    }
  }

  // And the steps up to the doorways. A hall stands on a plinth 0.9m high,
  // which is twice what a player can step onto: without these the interior is
  // there and unreachable, which is worse than not having built it.
  const rise = 0.3;
  const treads = Math.max(1, Math.round(plan.plinthTop / rise));
  const run = 0.42;
  for (const at of front) {
    // Not where the neighbour is standing. The Hall of Ancestral Worship has a
    // gallery a metre and a half off its front, and a flight of steps laid
    // without looking is a staircase growing out of somebody else's wall.
    const blocked = plan.around.solids.some((b) => {
      if (Math.abs(b.cx - cx) < b.hw && Math.abs(b.cz - cz) < b.hd) return false;
      return Math.abs(b.cx - (cx + at)) < b.hw + doorHalf + 0.6
        && Math.abs(b.cz - (cz + plan.plinthHd + run * treads * 0.5))
           < b.hd + run * treads * 0.5;
    });
    if (blocked) continue;
    for (let i = 0; i < treads; i++) {
      // The tallest tread stands against the plinth; each one out from it is a
      // step lower.
      const top = (plan.plinthTop * (treads - i)) / treads;
      const stepZ = cz + plan.plinthHd + run * (i + 0.5);
      const stepH = plan.ground + top - (plan.ground - 0.05);
      out.stone.box(cx + at, plan.ground + top - stepH / 2, stepZ,
        doorHalf + 0.5, stepH / 2, run / 2, CITY_COLORS.stone);
      colliders.push({
        cx: cx + at, cy: plan.ground + top - stepH / 2, cz: stepZ,
        hw: doorHalf + 0.5, hh: stepH / 2, hd: run / 2, surface: 'stone',
      });
    }
  }

  return colliders;
}

/**
 * A gate: piers, archways, and a lintel across the top.
 *
 * The openings run through the *short* way — you walk across a gate's width,
 * not along it — so a gate 72m wide and 53m deep is pierced north to south with
 * its archways spaced along its width. Three of them on the great gates, one on
 * the small ones, which is close enough to a hierarchy that runs from the
 * Meridian Gate's five down to a single door.
 *
 * Returns the piers as colliders, and the lintel above the arches, so a
 * paintball fired through an archway goes through and one fired at the wall
 * beside it does not.
 */
function buildGateBody(
  s: Structure,
  cx: number, cz: number,
  hw: number, hd: number,
  baseY: number, height: number,
  /** Lowest ground under the footprint: where the piers have to reach. */
  bottom: number,
  out: BuildTarget,
): BoxCollider[] {
  const alongX = hw >= hd;
  const span = alongX ? hw : hd;
  const thickness = alongX ? hd : hw;
  const count = span > 13 ? 3 : 1;
  /**
   * Half-width of each archway.
   *
   * Floored as well as capped, and the floor is the important half: the navgrid
   * works in 2m cells probed at five points, so an opening much under three
   * metres straddles two cells and both come back blocked. Before the piers
   * reached the ground a bot could walk under any gate anywhere along its
   * frontage, which hid the problem; now that they do, an archway a bot cannot
   * path through seals the courtyard behind it.
   *
   * The floor gives way on the smallest gates rather than eating them: at four
   * metres wide overall, a 3.4m opening leaves two 30cm stubs holding up a roof.
   */
  const openHalf = clamp(span / (count * 3.4), Math.min(1.7, span * 0.5), 2.4);
  const openTop = Math.min(height * 0.78, 5.4);

  // Centres of the archways, spread across the span.
  const centres: number[] = [];
  for (let i = 0; i < count; i++) {
    centres.push(count === 1 ? 0 : ((i - (count - 1) / 2) * span) / count * 1.15);
  }

  // Piers: what is left of the span once the archways are cut out of it.
  const cuts = centres.map((c) => [c - openHalf, c + openHalf] as const)
    .sort((a, b) => a[0] - b[0]);
  const piers: Array<[number, number]> = [];
  let cursor = -span;
  for (const [a, b] of cuts) {
    if (a > cursor) piers.push([cursor, a]);
    cursor = Math.max(cursor, b);
  }
  if (cursor < span) piers.push([cursor, span]);

  const colliders: BoxCollider[] = [];
  const place = (
    along: number, alongHalf: number, y: number, halfHeight: number,
  ): void => {
    const px = alongX ? cx + along : cx;
    const pz = alongX ? cz : cz + along;
    const phw = alongX ? alongHalf : thickness;
    const phd = alongX ? thickness : alongHalf;
    out.timber.box(px, y, pz, phw, halfHeight, phd, CITY_COLORS.redDeep, 0.02);
    colliders.push({ cx: px, cy: y, cz: pz, hw: phw, hh: halfHeight, hd: phd, surface: 'timber' });
  };

  // The piers stand on the ground, not on the plinth line every other building
  // is levelled onto.
  //
  // A gate gets no plinth — a step across the archway is something to hop over
  // to walk through your own gate — and for five iterations that meant its piers
  // began 0.9m up with nothing under them. Every gate on the map floated, and
  // since the gap ran the whole width of the footprint rather than only across
  // the arches, a player could walk *under* the Meridian Gate anywhere along its
  // 86m frontage. The stone base course below is what a gate really stands on.
  const baseTop = Math.min(baseY + 0.5, baseY + height * 0.2);
  for (const [a, b] of piers) {
    if (b - a < 0.2) continue;
    const along = (a + b) / 2;
    const alongHalf = (b - a) / 2;
    const wallH = baseY + height - baseTop;
    place(along, alongHalf, baseTop + wallH / 2, wallH / 2);
    // 须弥座 — the moulded stone base, which is also what fills the gap down to
    // the ground where the footprint straddles uneven going.
    const px = alongX ? cx + along : cx;
    const pz = alongX ? cz : cz + along;
    const phw = alongX ? alongHalf : thickness;
    const phd = alongX ? thickness : alongHalf;
    const baseH = baseTop - bottom;
    if (baseH > 0.05) {
      out.stone.box(px, bottom + baseH / 2, pz, phw * 1.02, baseH / 2, phd * 1.02,
        CITY_COLORS.stone);
      colliders.push({
        cx: px, cy: bottom + baseH / 2, cz: pz,
        hw: phw * 1.02, hh: baseH / 2, hd: phd * 1.02, surface: 'stone',
      });
    }
  }
  // The lintel band over the archways, spanning the lot.
  const lintelH = (height - openTop) / 2;
  if (lintelH > 0.15) {
    place(0, span, baseY + openTop + lintelH, lintelH);
  }

  // The dark recess of each archway, so an opening reads as a passage rather
  // than as a gap between two walls.
  for (const centre of centres) {
    const ax = alongX ? cx + centre : cx;
    const az = alongX ? cz : cz + centre;
    const ahw = alongX ? openHalf : thickness * 0.96;
    const ahd = alongX ? thickness * 0.96 : openHalf;
    out.timber.box(ax, baseY + openTop - 0.12, az, ahw, 0.12, ahd, CITY_COLORS.timber);
  }

  // Everything above the wall — frieze, brackets — is the same as any building.
  buildBody(s, cx, cz, hw, hd, baseY, height, out, true);
  return colliders;
}

/**
 * A courtyard enclosure: four red walls around the traced outline.
 *
 * The survey gives these as closed ways — the outline of a courtyard, not a
 * solid — and one of them is 165m by 162m. Built as a box, as every other
 * footprint here is, that single entry becomes a red cliff a hundred and sixty
 * metres square dropped on the west flank of the compound. Four runs around the
 * perimeter is both what the tag means and what the place is: the Forbidden City
 * is a maze of walled courtyards, and this is the geometry that makes it one.
 *
 * Outlines that are already thin — a length of wall traced on its own, 220m by
 * 12m — come out of the same code as a long run with two short returns, which
 * is close enough to right.
 */
function buildCourtWall(
  cx: number, cz: number,
  hw: number, hd: number,
  groundAt: (x: number, z: number) => number,
  out: BuildTarget,
  around: Surroundings,
): BoxCollider[] {
  // Courtyard walls in the Forbidden City are about 4m — head height and then
  // some, which is what makes the compound a maze rather than a plan.
  const height = 3.6;
  const half = 0.55;
  const colliders: BoxCollider[] = [];

  // Only the buildings this outline can actually reach. 146 enclosures against
  // 600 buildings is 350,000 tests otherwise, and all but a handful of them are
  // on the other side of the compound.
  const near = around.solids.filter(
    (b) => Math.abs(b.cx - cx) < hw + b.hw + 2 && Math.abs(b.cz - cz) < hd + b.hd + 2,
  );

  /**
   * Half-width of the doorway cut through the middle of a long run.
   *
   * Five metres of opening, which is wider than a doorway wants to look, and
   * sized for the navgrid rather than for the eye: cells are 2m and each is
   * probed at five points, so an opening much under this straddles two cells
   * and both of them come back blocked. A door a bot cannot path through is the
   * same as no door.
   */
  const DOOR = 2.6;

  const segment = (rx: number, rz: number, rhw: number, rhd: number): void => {
    if (rhw < 0.2 || rhd < 0.2) return;
    // Level along its length, and down to the lowest ground under it, so a run
    // that crosses the terrace skirt neither floats at one end nor sinks at the
    // other.
    const ground = groundRange(rx, rz, rhw, rhd, groundAt);
    const top = ground.top + height;
    const h = top - ground.bottom;
    out.timber.box(rx, top - h / 2, rz, rhw, h / 2, rhd, CITY_COLORS.red, 0.08);
    // The tiled coping, oversailing both faces.
    out.roof.box(rx, top + 0.14, rz, rhw + 0.2, 0.14, rhd + 0.2, CITY_COLORS.tile);
    colliders.push({
      cx: rx, cy: top - h / 2, cz: rz, hw: rhw, hh: h / 2, hd: rhd, surface: 'timber',
    });
  };

  /**
   * One side of the enclosure: a doorway through the middle, and a gap wherever
   * a building stands in the way.
   *
   * The doorway is not decoration. A courtyard wall traced as a closed outline
   * and built as four unbroken runs is a sealed box, and the compound has a
   * hundred and forty-six of them: whole quarters of the Inner Court came out
   * as pockets no one could enter, the navgrid's flood fill pruned six thousand
   * cells as unreachable, and the two bots that spawned inside the Six Palaces
   * stood in the dark for the entire round.
   *
   * The buildings are the other half of the same idea. In the real compound a
   * courtyard wall runs *between* buildings and stops at the gable of each: the
   * range closes that side of the court and the wall picks up again beyond it.
   * The survey has no way to say so, so 265 runs were passing straight through a
   * building — a red wall growing out of a red wall halfway up its own roof.
   * Cutting the building's footprint out of the run is both what the place looks
   * like and, since half of those buildings are the gate-houses of their own
   * courtyards, several hundred more ways through the maze.
   *
   * Short runs are left solid — a 4m return with a 3.4m hole in it is not a
   * wall — which is also why this cuts every long side rather than only the
   * south one: with only one opening per courtyard, a nested enclosure can
   * still seal a pocket, and a wall with two doors is a great deal more
   * faithful to the place than a wall with none.
   */
  const run = (rx: number, rz: number, rhw: number, rhd: number): void => {
    const alongX = rhw > rhd;
    const half = alongX ? rhw : rhd;
    const centre = alongX ? rx : rz;
    const across = alongX ? rhd : rhw;

    // Spans of the run that survive, in metres either side of its centre.
    let spans: Array<[number, number]> = [[-half, half]];
    // A doorway every eighteen metres or so of run, evenly spaced. One in the
    // middle of each side — which is what this used to cut — leaves a 60m wall
    // you walk the length of twice, and left the flood fill pruning a quarter
    // of the compound as unreachable, because a courtyard whose one door opens
    // into another sealed courtyard is still sealed.
    if (half >= 5) {
      const doors = clamp(Math.round(half / 7), 1, 5);
      for (let i = 0; i < doors; i++) {
        const at = (((i + 0.5) / doors) * 2 - 1) * half;
        spans = subtractSpan(spans, at - DOOR, at + DOOR);
      }
    }
    for (const b of near) {
      // Only where the building actually stands in this run's line.
      const offAxis = alongX ? Math.abs(b.cz - rz) : Math.abs(b.cx - rx);
      if (offAxis > across + (alongX ? b.hd : b.hw)) continue;
      const at = (alongX ? b.cx : b.cz) - centre;
      const reach = (alongX ? b.hw : b.hd) + 0.3;
      spans = subtractSpan(spans, at - reach, at + reach);
    }

    for (const [a, b] of spans) {
      // Anything shorter than this is a stub between two buildings that stand
      // nearly shoulder to shoulder, and it reads as a lump rather than a wall.
      if (b - a < 1.2) continue;
      const mid = (a + b) / 2;
      const length = (b - a) / 2;
      segment(
        alongX ? rx + mid : rx,
        alongX ? rz : rz + mid,
        alongX ? length : rhw,
        alongX ? rhd : length,
      );
    }
  };

  // North and south runs the full width; east and west between them.
  run(cx, cz - hd + half, hw, half);
  run(cx, cz + hd - half, hw, half);
  const innerHd = Math.max(hd - half * 2, 0);
  run(cx - hw + half, cz, half, innerHd);
  run(cx + hw - half, cz, half, innerHd);

  return colliders;
}

/**
 * A raised stone platform — the base a group of halls stands on.
 *
 * No walls, no roof: a slab with a moulded edge, which is what these are.
 */
function buildPlatform(
  cx: number, cz: number,
  hw: number, hd: number,
  height: number,
  groundAt: (x: number, z: number) => number,
  out: BuildTarget,
): BoxCollider[] {
  // Level top, base to the lowest ground under it. Taking the height at the
  // centre — which is what this used to do — left the two platforms that reach
  // onto the terrace skirt standing 3.7m clear of the courtyard on their low
  // side.
  const ground = groundRange(cx, cz, hw, hd, groundAt);
  const top = platformTop(cx, cz, hw, hd, height, groundAt);
  const h = top - ground.bottom;
  out.stone.box(cx, top - h / 2, cz, hw, h / 2, hd, CITY_COLORS.stone, 0.04);
  // A pale coping course along the top edge, so the platform has a lip rather
  // than fading into the paving it stands on.
  out.stone.box(cx, top + 0.08, cz, hw + 0.12, 0.08, hd + 0.12, CITY_COLORS.marbleShade);
  return [{ cx, cy: top - h / 2, cz, hw, hh: h / 2, hd, surface: 'stone' }];
}

/** The surface a platform presents: level, and clear of the highest ground. */
function platformTop(
  cx: number, cz: number, hw: number, hd: number, height: number,
  groundAt: (x: number, z: number) => number,
): number {
  return groundRange(cx, cz, hw, hd, groundAt).top + Math.max(height, 0.6);
}

/** Cuts `[from, to]` out of a set of spans, keeping them sorted and disjoint. */
function subtractSpan(
  spans: Array<[number, number]>, from: number, to: number,
): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const [a, b] of spans) {
    if (to <= a || from >= b) { out.push([a, b]); continue; }
    if (from > a) out.push([a, from]);
    if (to < b) out.push([to, b]);
  }
  return out;
}

/** The lowest and highest ground under a footprint, sampled on a grid. */
function groundRange(
  cx: number, cz: number, hw: number, hd: number,
  groundAt: (x: number, z: number) => number,
): { top: number; bottom: number } {
  let top = -Infinity;
  let bottom = Infinity;
  for (let a = -1; a <= 1; a += 0.5) {
    for (let b = -1; b <= 1; b += 0.5) {
      const y = groundAt(cx + a * hw * 0.99, cz + b * hd * 0.99);
      if (y > top) top = y;
      if (y < bottom) bottom = y;
    }
  }
  return { top, bottom };
}

/**
 * The surface of the platform a building stands on, if it stands on one.
 *
 * "Stands on" is most of its footprint rather than all of it: the survey traces
 * eaves, and a hall's eaves oversail the edge of its own base by a metre or two
 * at every corner. Demanding containment left the Palace of Heavenly Purity
 * levelled onto the courtyard with its plinth inside the platform it is built
 * on. The highest wins, because the Inner Court's bases are stacked.
 */
function highestPlatformUnder(
  around: Surroundings, cx: number, cz: number, hw: number, hd: number,
): number | undefined {
  let best: number | undefined;
  const area = 4 * hw * hd;
  for (const p of around.platforms) {
    const ox = Math.min(cx + hw, p.cx + p.hw) - Math.max(cx - hw, p.cx - p.hw);
    const oz = Math.min(cz + hd, p.cz + p.hd) - Math.max(cz - hd, p.cz - p.hd);
    if (ox <= 0 || oz <= 0 || (ox * oz) / area < 0.85) continue;
    if (best === undefined || p.top > best) best = p.top;
  }
  return best;
}

/**
 * A roof.
 *
 * Built as a stack of rectangular rings from the eave up to the ridge, each one
 * narrower and higher than the last, with quads between them. Three things make
 * it read as Chinese rather than as a pyramid with a hat:
 *
 * - The profile is **convex**: shallow at the eave, steep at the ridge. A
 *   straight-sided roof is a barn anywhere in the world.
 * - The eave **lifts** at its very edge — 反宇, the upturned lip — so the
 *   lowest line of the roof is a little inside its outermost line.
 * - The overhang is **deep**, and the underside is dark, so the building wears
 *   a band of shadow between its red wall and its gold roof.
 */
function roofShell(
  target: BuildTarget,
  cx: number, cz: number,
  hw: number, hd: number,
  eaveY: number, height: number,
  form: RoofForm,
  color: Color,
  /**
   * The lowest a roof's collider may reach — head height over whatever the
   * building stands on.
   *
   * A roof is a collider so that paint sticks to it, and it is a *hull* rather
   * than a box so that the collider is the roof's own sloped shape instead of a
   * lid out over the courtyard. That still leaves the eave itself, which on a
   * low gallery hangs about 2.1m up: a player who steps onto the plinth under
   * one would walk their head into it. So the hull is cut off below this line,
   * and a roof entirely below it gets none.
   */
  hullFloor: number,
  /** Whether the tile courses are drawn — see the ribs below. */
  courses: boolean,
  /** Half-extents of the wall below, so the soffit is a frame and not a lid. */
  innerHw = hw * 0.72,
  innerHd = hd * 0.72,
): void {
  const out = target.roof;
  const RINGS = 4;
  // Where the ridge sits, as a fraction of the footprint.
  const ridgeHw = form === 'pyramid'
    ? 0
    : form === 'gable'
      ? hw * 0.9
      : Math.max(hw - hd, hw * 0.14);
  const ridgeHd = form === 'gable' ? hd * 0.12 : 0;

  // The eave: an outer lip, then the true low line just inside it.
  const lift = clamp(height * 0.1, 0.12, 0.9);
  const lipHw = hw;
  const lipHd = hd;
  const eaveHw = hw * 0.93;
  const eaveHd = hd * 0.93;

  const ring = (halfW: number, halfD: number, y: number) => ({ halfW, halfD, y });
  const rings = [ring(lipHw, lipHd, eaveY + lift), ring(eaveHw, eaveHd, eaveY)];
  for (let k = 1; k <= RINGS; k++) {
    const t = k / RINGS;
    rings.push(ring(
      lerp(eaveHw, ridgeHw, t),
      lerp(eaveHd, ridgeHd, t),
      eaveY + height * Math.pow(t, 1.55),
    ));
  }

  const corner = (r: { halfW: number; halfD: number; y: number }, sx: number, sz: number) =>
    new Vector3(cx + sx * r.halfW, r.y, cz + sz * r.halfD);

  // The collider: one hull per band of the roof, from the eave up.
  //
  // Per band rather than one hull for the whole roof, because the profile is
  // *concave* — shallow at the eave, steep at the ridge, which is what stops a
  // Chinese roof reading as a barn — and the convex hull of a dished curve cuts
  // the corner. It came out as much as a metre inside the tiles, so a ball
  // stopped in mid-air short of the roof and the splat, projected at the impact,
  // found no roof within reach and was dropped. A band between two rings is a
  // frustum, which is convex, so its hull is the surface exactly.
  //
  // The lip band — the first, which tilts down and out — is left off: it is the
  // underside of the eave rather than the roof.
  for (let i = 1; i < rings.length - 1; i++) {
    const lower = rings[i]!;
    const upper = rings[i + 1]!;
    if (lower.y < hullFloor) continue;
    const points: number[] = [];
    for (const r of [lower, upper]) {
      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
          points.push(cx + sx * r.halfW, r.y, cz + sz * r.halfD);
        }
      }
    }
    target.hulls.push(new Float32Array(points));
  }

  const shade = new Color().copy(color).multiplyScalar(0.82);

  // The soffit: the ceiling of the porch, under the overhang, facing down.
  //
  // Needed because the roof slopes are single-sided. Standing on the porch and
  // looking up, the slopes above are back-faces and cull away, leaving a view
  // of the sky through a solid roof.
  //
  // A frame rather than a lid. Covering the whole footprint would be one quad
  // instead of four, but on a double-eaved hall the upper roof's soffit would
  // then be a broad brown ceiling laid straight over the lower roof's tiles,
  // hiding the very thing that makes the building double-eaved.
  {
    const y = eaveY - 0.02;
    const ihw = Math.min(innerHw, eaveHw * 0.98);
    const ihd = Math.min(innerHd, eaveHd * 0.98);
    const p = (x: number, z: number) => new Vector3(x, y, z);
    // North and south runs, then the two ends between them.
    out.quad(p(-eaveHw + cx, cz - eaveHd), p(eaveHw + cx, cz - eaveHd),
             p(cx + ihw, cz - ihd), p(cx - ihw, cz - ihd), CITY_COLORS.timber);
    out.quad(p(cx + ihw, cz + ihd), p(cx + eaveHw, cz + eaveHd),
             p(cx - eaveHw, cz + eaveHd), p(cx - ihw, cz + ihd), CITY_COLORS.timber);
    out.quad(p(cx + eaveHw, cz - eaveHd), p(cx + eaveHw, cz + eaveHd),
             p(cx + ihw, cz + ihd), p(cx + ihw, cz - ihd), CITY_COLORS.timber);
    out.quad(p(cx - ihw, cz - ihd), p(cx - ihw, cz + ihd),
             p(cx - eaveHw, cz + eaveHd), p(cx - eaveHw, cz - eaveHd), CITY_COLORS.timber);
  }

  for (let i = 0; i < rings.length - 1; i++) {
    const a = rings[i]!;
    const b = rings[i + 1]!;
    // The first band is the flying lip, and it tilts *down and out*: from under
    // the eaves — which is where a player spends the whole game — it is the
    // only part of the roof they see, and it is not tile. It is the painted
    // underside of the rafters, and it wants to be dark timber, not gold. This
    // one line is most of the difference between "temple" and "yellow shed".
    const band = i === 0 ? CITY_COLORS.timber : i === 1 ? shade : color;

    // North and south slopes. Wound from the *upper* ring back to the lower one,
    // which is what puts the face's normal up and out. Wound the other way — the
    // order these rings are built in, and the obvious one to write — every roof
    // in the city is lit from underneath and comes out the colour of dried
    // blood, with a clear blue sky overhead.
    out.quad(corner(b, -1, -1), corner(b, 1, -1), corner(a, 1, -1), corner(a, -1, -1), band);
    out.quad(corner(b, 1, 1), corner(b, -1, 1), corner(a, -1, 1), corner(a, 1, 1), band);
    // East and west hips. On a gable roof these stop short and are closed off
    // by the gable panel below.
    out.quad(corner(b, 1, -1), corner(b, 1, 1), corner(a, 1, 1), corner(a, 1, -1), band);
    out.quad(corner(b, -1, 1), corner(b, -1, -1), corner(a, -1, -1), corner(a, -1, 1), band);

    // 筒瓦 — the barrel tile courses, on the band of roof nearest the eave.
    //
    // A Chinese roof is not a gold plane, it is a comb: half-round tiles laid
    // in ridges from ridge to eave, and the shadow between every pair is most of
    // what makes the gold read as gold at any distance. Drawn as a raised rib
    // per course, on the one band a player standing in the courtyard is looking
    // at, and only on the buildings near enough for the ribs to be more than a
    // pixel apart. A whole roof of them would be twenty times the triangles for
    // detail nobody can see past the eave line.
    if (i === 1 && courses && hw > 2) {
      const step = 0.62;
      const rib = 0.1;
      const lift = 0.05;
      for (const sz of [-1, 1] as const) {
        const zA = cz + sz * a.halfD;
        const zB = cz + sz * b.halfD;
        for (let x = cx - a.halfW + step * 0.5; x < cx + a.halfW; x += step) {
          const xB = clamp(x, cx - b.halfW, cx + b.halfW);
          out.quad(
            new Vector3(xB - rib, b.y + lift, zB),
            new Vector3(xB + rib, b.y + lift, zB),
            new Vector3(x + rib, a.y + lift, zA),
            new Vector3(x - rib, a.y + lift, zA),
            sz > 0 ? shade : color,
          );
        }
      }
    }
  }

  // 垂脊 — the hip ridges running from the ends of the main ridge down to the
  // four eave corners. In a photograph of any hall in the compound these four
  // diagonals are the strongest lines on the roof after the ridge itself: they
  // are what stops a hipped roof reading as a tent. Built as a raised ribbon
  // following the corner of each ring, which costs four narrow quads a band.
  if (form !== 'pyramid' && hw > 2.5) {
    const ridgeW = clamp(height * 0.09, 0.14, 0.5);
    const lift = 0.06;
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        for (let i = 1; i < rings.length - 1; i++) {
          const a = rings[i]!;
          const b = rings[i + 1]!;
          const outerA = corner(a, sx, sz);
          const outerB = corner(b, sx, sz);
          const innerA = new Vector3(
            outerA.x - sx * ridgeW, outerA.y + lift, outerA.z - sz * ridgeW,
          );
          const innerB = new Vector3(
            outerB.x - sx * ridgeW, outerB.y + lift, outerB.z - sz * ridgeW,
          );
          outerA.y += lift;
          outerB.y += lift;
          // Wound so the ribbon faces up whichever corner it is on.
          if (sx * sz > 0) out.quad(outerA, outerB, innerB, innerA, CITY_COLORS.ridge);
          else out.quad(innerA, innerB, outerB, outerA, CITY_COLORS.ridge);
        }
      }
    }
  }

  const top = rings[rings.length - 1]!;
  if (form === 'gable') {
    // 歇山: the upper roof is a gable, its ends closed by a vertical panel that
    // sits back from the hips below.
    for (const sx of [-1, 1]) {
      out.polygon(
        [corner(top, sx, -1), corner(top, sx, 1), new Vector3(cx + sx * top.halfW, top.y + height * 0.1, cz)],
        shade,
      );
    }
  }

  // The ridge — 正脊 — a heavy tiled beam along the top, with a beast at each
  // end. Prominent enough on the real thing to be most of the silhouette.
  const ridgeH = clamp(height * 0.1, 0.12, 0.7);
  if (form === 'pyramid') {
    // A gilt finial instead of a ridge.
    out.prism(cx, cz, top.y, top.y + ridgeH * 2.4, ridgeH * 0.9, 8, CITY_COLORS.ridge, ridgeH * 0.3);
  } else {
    out.box(
      cx, top.y + ridgeH / 2, cz,
      top.halfW + ridgeH * 0.4, ridgeH, Math.max(top.halfD, ridgeH * 0.5),
      CITY_COLORS.ridge,
    );
    // 鸱吻, the beasts that swallow the ends of the ridge.
    if (top.halfW > 1.5) {
      for (const sx of [-1, 1]) {
        out.box(
          cx + sx * (top.halfW + ridgeH * 0.4), top.y + ridgeH * 1.5, cz,
          ridgeH * 0.75, ridgeH * 1.5, Math.max(top.halfD, ridgeH * 0.7),
          CITY_COLORS.ridge,
        );
      }
    }
  }
}
