import { Color, Vector3 } from 'three';
import { clamp, lerp } from '../core/MathUtils';
import type { MeshBuilder } from './MeshBuilder';
import type { RoofForm, Structure } from './CityPlan';
import { SCALE, WALL, planLength, planX, planZ } from './CityLayout';

/**
 * One building, generated from its footprint.
 *
 * ## Why this is code and not a model
 *
 * There are 798 structures inside the walls and no two footprints are the same.
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

/** An axis-aligned box collider, in world space. */
export interface BoxCollider {
  cx: number;
  cy: number;
  cz: number;
  hw: number;
  hh: number;
  hd: number;
}

/** Where a building's geometry goes, split by the material it is drawn with. */
export interface BuildTarget {
  /** Glazed tile: roofs and ridges. */
  roof: MeshBuilder;
  /** Painted timber: walls, columns, friezes, doors. */
  timber: MeshBuilder;
  /** Stone and marble: plinths, terraces, paving, balustrades. */
  stone: MeshBuilder;
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
): BoxCollider[] {
  const cx = planX(s.x);
  const cz = planZ(s.z);
  const hw = planLength(s.w) / 2;
  const hd = planLength(s.d) / 2;
  const height = s.height * SCALE;

  if (s.kind === 'courtwall') {
    return buildCourtWall(cx, cz, hw, hd, groundAt, out);
  }
  if (s.kind === 'platform') {
    return buildPlatform(cx, cz, hw, hd, height, groundAt, out);
  }

  // Level onto the highest ground under the footprint; the plinth reaches down
  // to the lowest.
  const corners = [
    groundAt(cx, cz),
    groundAt(cx - hw, cz - hd), groundAt(cx + hw, cz - hd),
    groundAt(cx - hw, cz + hd), groundAt(cx + hw, cz + hd),
  ];
  // The corner towers stand *on* the wall at its four corners, not beside it,
  // so they are levelled onto the wall's head rather than onto the ground the
  // wall stands on. Everything else takes the highest ground under its own
  // footprint.
  const onWall = s.kind === 'tower' && s.roof === 'triple';
  const top = onWall ? WALL.height : Math.max(...corners);
  const bottom = Math.min(...corners);

  const grand = s.kind === 'hall' || s.kind === 'gate' || s.kind === 'tower';
  // Plinths are human-scale furniture, not part of the mass, so they are sized
  // in absolute metres rather than scaled with the building. A 0.4m step is a
  // step at any map scale; the same step at 0.45 would be a kerb.
  const plinthTop = grand ? 0.9 : 0.45;
  const plinthHeight = plinthTop + (top - bottom);
  const plinthY = top + plinthTop - plinthHeight / 2;
  const plinthColor = s.kind === 'hall' && s.w > 40 ? CITY_COLORS.marble : CITY_COLORS.stone;
  // The plinth oversails the walls but stops short of the eaves.
  const plinthHw = hw * 0.94;
  const plinthHd = hd * 0.94;
  // Gates get no plinth: they are pierced, and a plinth across the archway is a
  // step you have to hop over to walk through your own gate.
  if (s.kind !== 'gate') {
    out.stone.box(cx, plinthY, cz, plinthHw, plinthHeight / 2, plinthHd, plinthColor);
  }

  const baseY = top + plinthTop;
  const roofHeight = height * roofFraction(s.kind, s.roof);
  const bodyHeight = Math.max(height - roofHeight, 1.2);

  // The survey traces eaves, not walls, so the body is inset by the overhang.
  const overhang = clamp(height * 0.13, 0.5, 2.4);
  const bodyHw = Math.max(hw - overhang, hw * 0.35);
  const bodyHd = Math.max(hd - overhang, hd * 0.35);

  // Gates are pierced; everything else is solid.
  //
  // A gate is a hole in a wall. Built solid — which is what a footprint alone
  // says — the Gate of Supreme Harmony seals the great court off from the outer
  // one, the Meridian Gate seals the whole compound, and a map with a wall
  // round it and no way through becomes a box with the player inside it. The
  // archways are what make the plan a route rather than a picture.
  const gateColliders = s.kind === 'gate'
    ? buildGateBody(s, cx, cz, bodyHw, bodyHd, baseY, bodyHeight, out)
    : null;
  if (!gateColliders) {
    buildBody(s, cx, cz, bodyHw, bodyHd, baseY, bodyHeight, out);
  }

  const eaveY = baseY + bodyHeight;
  if (s.roof === 'triple') {
    // The corner towers, and nothing else on the map. Three tiers of eaves,
    // each storey set inside the one below, which is the shape everybody has
    // seen reflected in the moat even if they have never heard the name.
    let y = eaveY;
    let tierHw = hw;
    let tierHd = hd;
    for (let tier = 0; tier < 3; tier++) {
      const tierRoofH = roofHeight * (tier === 2 ? 0.9 : 0.5);
      roofShell(out.roof, cx, cz, tierHw, tierHd, y, tierRoofH, 'hip', roofColor(s),
        tierHw * 0.8, tierHd * 0.8);
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
    roofShell(out.roof, cx, cz, hw, hd, eaveY, lowerRoofH, 'hip', roofColor(s),
      bodyHw, bodyHd);

    // The upper storey stands inside the lower roof's ridge line.
    const upperHw = Math.max(hw - lowerRoofH * 0.62, hw * 0.5);
    const upperHd = Math.max(hd - lowerRoofH * 0.62, hd * 0.5);
    const upperBase = eaveY + lowerRoofH * 0.62;
    const upperBodyH = Math.max(bodyHeight * 0.34, 1.4);
    buildBody(s, cx, cz, upperHw * 0.86, upperHd * 0.86, upperBase, upperBodyH, out);
    roofShell(
      out.roof, cx, cz, upperHw, upperHd,
      upperBase + upperBodyH, roofHeight * 0.8, 'hip', roofColor(s),
      upperHw * 0.86, upperHd * 0.86,
    );
  } else {
    roofShell(out.roof, cx, cz, hw, hd, eaveY, roofHeight, s.roof, roofColor(s),
      bodyHw, bodyHd);
  }

  // One collider for the plinth step, and either one for a solid body or one
  // per pier for a pierced gate. The roof is not a collider: it overhangs by up
  // to 2.4m, and a box around it would be an invisible ceiling you bounce paint
  // off two metres from the wall.
  //
  // A gate's plinth is left out entirely — it would be a step across the
  // archway you have to hop over to walk through your own gate.
  return gateColliders ?? [
    { cx, cy: plinthY, cz, hw: plinthHw, hh: plinthHeight / 2, hd: plinthHd },
    { cx, cy: baseY + bodyHeight / 2, cz, hw: bodyHw, hh: bodyHeight / 2, hd: bodyHd },
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
  const ranked = s.kind === 'hall' || s.kind === 'gate' || s.kind === 'tower'
    || s.kind === 'kiosk' || hw > 9;

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
    for (let i = 0; i < bays; i++) {
      const x = cx - hw * 0.9 + bayW * (i + 0.5);
      for (const side of [-1, 1]) {
        // Alternating door and lattice panel. Both stand proud of the wall, so
        // each casts its own thin line of shadow and the facade gets the
        // vertical rhythm that a flat red box has no way to suggest.
        out.timber.box(
          x, baseY + doorH / 2, cz + side * (hd + 0.05),
          bayW * 0.38, doorH / 2, 0.06,
          i % 2 === 0 ? CITY_COLORS.redDeep : CITY_COLORS.lattice,
        );
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
  out: BuildTarget,
): BoxCollider[] {
  const alongX = hw >= hd;
  const span = alongX ? hw : hd;
  const thickness = alongX ? hd : hw;
  const count = span > 13 ? 3 : 1;
  const openHalf = Math.min(2.3, span / (count * 3.4));
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
    colliders.push({ cx: px, cy: y, cz: pz, hw: phw, hh: halfHeight, hd: phd });
  };

  for (const [a, b] of piers) {
    if (b - a < 0.2) continue;
    place((a + b) / 2, (b - a) / 2, baseY + height / 2, height / 2);
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
): BoxCollider[] {
  // Courtyard walls in the Forbidden City are about 4m — head height and then
  // some, which is what makes the compound a maze rather than a plan.
  const height = 3.6;
  const half = 0.55;
  const colliders: BoxCollider[] = [];

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
    const y = groundAt(rx, rz);
    out.timber.box(rx, y + height / 2, rz, rhw, height / 2, rhd, CITY_COLORS.red, 0.08);
    // The tiled coping, oversailing both faces.
    out.roof.box(rx, y + height + 0.14, rz, rhw + 0.2, 0.14, rhd + 0.2, CITY_COLORS.tile);
    colliders.push({ cx: rx, cy: y + height / 2, cz: rz, hw: rhw, hh: height / 2, hd: rhd });
  };

  /**
   * One side of the enclosure, with a doorway through the middle of it.
   *
   * The doorway is not decoration. A courtyard wall traced as a closed outline
   * and built as four unbroken runs is a sealed box, and the compound has a
   * hundred and forty-five of them: whole quarters of the Inner Court came out
   * as pockets no one could enter, the navgrid's flood fill pruned six thousand
   * cells as unreachable, and the two bots that spawned inside the Six Palaces
   * stood in the dark for the entire round.
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
    if (half < 5) {
      segment(rx, rz, rhw, rhd);
      return;
    }
    const wing = (half - DOOR) / 2;
    for (const side of [-1, 1]) {
      const offset = side * (DOOR + wing);
      segment(
        alongX ? rx + offset : rx,
        alongX ? rz : rz + offset,
        alongX ? wing : rhw,
        alongX ? rhd : wing,
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
  const y = groundAt(cx, cz);
  const h = Math.max(height, 0.6);
  out.stone.box(cx, y + h / 2, cz, hw, h / 2, hd, CITY_COLORS.stone, 0.04);
  // A pale coping course along the top edge, so the platform has a lip rather
  // than fading into the paving it stands on.
  out.stone.box(cx, y + h + 0.08, cz, hw + 0.12, 0.08, hd + 0.12, CITY_COLORS.marbleShade);
  return [{ cx, cy: y + h / 2, cz, hw, hh: h / 2, hd }];
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
  out: MeshBuilder,
  cx: number, cz: number,
  hw: number, hd: number,
  eaveY: number, height: number,
  form: RoofForm,
  color: Color,
  /** Half-extents of the wall below, so the soffit is a frame and not a lid. */
  innerHw = hw * 0.72,
  innerHd = hd * 0.72,
): void {
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
