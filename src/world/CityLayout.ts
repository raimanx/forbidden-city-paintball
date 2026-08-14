import { Color } from 'three';
import { fbmSigned, fbm2D } from '../core/Noise';
import { clamp, lerp, smoothstep } from '../core/MathUtils';

/**
 * The Forbidden City, laid out from the survey.
 *
 * Origin is the geometric centre of the walled compound — which lands, pleasingly,
 * on the Hall of Central Harmony in the middle of the three great halls. `-Z` is
 * north toward the Gate of Divine Might and Jingshan; `+Z` is south down the axis
 * to the Meridian Gate. `+X` is east.
 *
 * This module is the single source of truth for the ground: the terrain mesh, its
 * collider, the navgrid and every structure placement read `heightAt`, so nothing
 * can drift out of alignment with what the player walks on.
 *
 * ## Scale
 *
 * The compound is 961m by 753m. At a 4.4 m/s walk that is three and a half
 * minutes end to end, which is dead time in a paintball match, so the map is
 * built at **0.45 uniform scale** — 417m by 319m inside the walls, close to the
 * footprint of the Central Park map this replaces.
 *
 * Uniform, in all three axes, deliberately. Compressing the courtyards harder
 * than the buildings in them is tempting — the real courts are ceremonial voids
 * — but it silently breaks every local relationship in the plan: two galleries
 * 5m apart become two galleries overlapping by 2m, and the dense courtyard grids
 * of the Six Palaces turn to mush. Uniform scaling keeps every doorway, gap and
 * alley in proportion to itself.
 *
 * The one thing scaled off-true is the perimeter wall, at `WALL.height` — see
 * there for why.
 *
 * ## Three rings
 *
 * - **The compound**, inside the wall. Courtyard brick, the terraces, and the
 *   783 structures of `CityPlan`. Everything the fight happens in.
 * - **The moat ring**, wall to far bank. A road, the water, and the outer
 *   embankment. Walkable at the corners and along the road; the water is not.
 * - **Beyond**, backdrop only: Jingshan on the axis to the north, and the grey
 *   roofscape of the old city elsewhere. Not walkable, not in the navgrid.
 */

/** Metres in the game per metre in Beijing. */
export const SCALE = 0.45;

/**
 * True-north offset of the game's origin, in real metres.
 *
 * `CityPlan` coordinates are relative to the Hall of Supreme Harmony, because
 * that is where the survey was anchored. The map wants its origin at the middle
 * of the compound instead, so the world is roughly symmetrical about it and the
 * navgrid does not waste half its cells on empty ground.
 */
const PLAN_Z_OFFSET = 127;

/** Converts a true east-west coordinate from `CityPlan` into world metres. */
export function planX(x: number): number {
  return x * SCALE;
}

/** Converts a true north-south coordinate from `CityPlan` into world metres. */
export function planZ(z: number): number {
  return (z + PLAN_Z_OFFSET) * SCALE;
}

/** Converts a true length — a footprint, a height — into world metres. */
export function planLength(metres: number): number {
  return metres * SCALE;
}

/**
 * The perimeter wall, at its centreline.
 *
 * 961m by 753m is measured to the outer faces, so the centreline rectangle is
 * half a wall thickness in from that.
 */
export const WALL = {
  halfX: planLength(753 / 2 - 8.62 / 2),
  halfZ: planLength(961 / 2 - 8.62 / 2),
  /** Thickness at the base. The real wall batters in to 6.66m at the top. */
  thickness: planLength(8.62),
  /**
   * Height, and the one number in this file that is not at scale.
   *
   * The real wall is 10m, which at 0.45 is 4.5m — a wall a player reads as
   * something to vault rather than as the edge of the world, and one that stops
   * looking like a fortification the moment you stand next to it. The
   * containment boundary has a job to do that scale fidelity would undermine, so
   * it is built at 6.4m: still shorter than the halls it surrounds, still
   * unjumpable, and imposing from the courtyard side, which is the only side
   * anyone sees it from.
   */
  height: 6.4,
  /** The stone base course the red wall stands on. */
  baseHeight: 1.1,
} as const;

/** Inside face of the wall — the walkable limit of the compound proper. */
export const INTERIOR = {
  halfX: WALL.halfX - WALL.thickness / 2,
  halfZ: WALL.halfZ - WALL.thickness / 2,
} as const;

/**
 * The moat — 筒子河, the "tube river" — and the road between it and the wall.
 *
 * 52m wide and 6m deep, set back far enough from the wall to leave the service
 * road that rings the whole compound.
 */
export const MOAT = {
  /** Inner bank: this far out from centre, the ground starts to fall away. */
  innerX: WALL.halfX + WALL.thickness / 2 + planLength(38),
  innerNorthZ: WALL.halfZ + WALL.thickness / 2 + planLength(38),
  /**
   * The south arm is set back much further than the other three.
   *
   * The Meridian Gate is not a doorway in the south wall — it is a U, and its
   * two wings project 85m *south* of the wall to embrace a forecourt. A moat
   * ring at the same 38m setback as the flanks would run straight through the
   * middle of it. The real moat bows south around that forecourt, and so does
   * this one.
   */
  innerSouthZ: WALL.halfZ + WALL.thickness / 2 + planLength(112),
  width: planLength(52),
  /**
   * Water surface.
   *
   * Set below the road that rings the wall with enough freeboard that the
   * road's camber and the ground noise cannot dip under it. The water is one
   * plane across the whole map — the shader discards wherever the ground stands
   * above it — so anything lower than this line anywhere is flooded, and the
   * road is the tightest case.
   */
  waterY: -1.35,
  bedY: -3.4,
} as const;

/** Water plane height. Read by the navgrid to reject anything in the moat. */
export const WATER_Y = MOAT.waterY;

/** Outer bank of the moat. Ground continues a little past it, then stops. */
export const MOAT_OUTER_X = MOAT.innerX + MOAT.width;
export const MOAT_OUTER_NORTH_Z = MOAT.innerNorthZ + MOAT.width;
export const MOAT_OUTER_SOUTH_Z = MOAT.innerSouthZ + MOAT.width;

/** Half-extents of the terrain mesh and its collider. */
export const GROUND_HALF_X = MOAT_OUTER_X + planLength(60);
export const GROUND_HALF_Z = MOAT_OUTER_SOUTH_Z + planLength(60);

/**
 * The field: the part of the compound a match is actually played in.
 *
 * The whole walled compound is 331m by 425m — 140,000 square metres of
 * courtyard, alley and gallery. Nine players in that is nobody in it: two
 * minutes of walking between contacts, whole quarters that go a round without
 * anyone in them, and a map that reads as a place to tour rather than a place to
 * fight over. So the match is bounded to the central spine, and the rest of the
 * palace is scenery you can see and shoot at but not walk into.
 *
 * 156m by 268m — 42,000 square metres, about 4,600 per player, which for
 * ground this dense with walls and gates is a large woodsball field rather than
 * a stadium. What it contains is the best of the compound and the whole of its
 * composition:
 *
 * - the **Meridian Gate** across the south end, which is the boundary there;
 * - the **outer court**, the Golden Water River and its five bridges;
 * - the **Gate of Supreme Harmony** and the great court behind it;
 * - the **great terrace** and the three great halls on it;
 * - the flanking belvederes, galleries and side gates of both courts;
 * - the **Gate of Heavenly Purity** across the north end, which is the boundary
 *   there.
 *
 * The edges that are not architecture are netted — see `CityCourse.fieldEdge`.
 * Everything here is in world metres.
 */
export const FIELD = {
  minX: -78,
  maxX: 78,
  /** The north face of the Gate of Heavenly Purity. */
  minZ: -64,
  /** The north face of the Meridian Gate. */
  maxZ: 204,
} as const;

/** True inside the field, with an optional margin outside it. */
export function inField(x: number, z: number, margin = 0): boolean {
  return x > FIELD.minX - margin && x < FIELD.maxX + margin
    && z > FIELD.minZ - margin && z < FIELD.maxZ + margin;
}

/**
 * The three-tiered marble terrace — 三台 — carrying the great halls.
 *
 * One platform, 8.13m of white marble in three stepped tiers, running from the
 * Gate of Supreme Harmony's court up to the back of the Hall of Preserving
 * Harmony. It is the single most important piece of relief on an otherwise dead
 * flat map: high ground in the centre, reached by stairs, overlooking the
 * largest courtyard in the game.
 */
export const TERRACE = {
  halfX: planLength(65),
  northZ: planZ(-195),
  southZ: planZ(25),
  height: planLength(8.13),
  /** Width of the stepped skirt where the tiers fall to the courtyard. */
  skirt: planLength(9),
} as const;

/**
 * The Inner Golden Water River — 内金水河 — and its five marble bridges.
 *
 * A bow-shaped channel across the first courtyard, north of the Meridian Gate.
 * Shallow, crossable at the bridges, and the only water inside the walls.
 */
export const GOLDEN_RIVER = {
  centerZ: planZ(253),
  /** Half-width of the channel at the axis. */
  halfDepth: planLength(11),
  halfSpan: planLength(100),
  /** How far the bow sags south at its ends, relative to the axis. */
  bow: planLength(14),
  waterY: -0.9,
  bedY: -1.9,
} as const;

/** The five bridges, by their centre X. The widest is the imperial one. */
export const RIVER_BRIDGES: ReadonlyArray<{ x: number; halfWidth: number }> = [
  { x: planX(-64), halfWidth: planLength(3.2) },
  { x: planX(-33), halfWidth: planLength(3.6) },
  { x: planX(2), halfWidth: planLength(5.4) },
  { x: planX(37), halfWidth: planLength(3.6) },
  { x: planX(68), halfWidth: planLength(3.2) },
];

/**
 * Jingshan, north of the moat on the axis.
 *
 * Not walkable and not in the navgrid — it is beyond the water — but it is the
 * view from every courtyard on the axis and the thing that tells you which way
 * you are facing. Built as terrain rather than as a prop so its silhouette sits
 * behind the Gate of Divine Might properly.
 */
export const JINGSHAN = {
  x: planX(-38),
  z: planZ(-983),
  /** Radius of the hill's skirt. */
  radius: planLength(230),
  height: planLength(45.7),
} as const;

/**
 * Places a paint crate can hide, one picked per round.
 *
 * Hand-authored from named structures rather than drawn from the navgrid, which
 * would land in the middle of the great courtyard about as often as anywhere and
 * is neither hidden nor interesting. Every entry is somewhere with a reason to be
 * there — behind something, under something, round a corner — and all of them sit
 * inside the walls, where the navgrid is, because a crate a bot cannot path to
 * would stall the "everyone is out of paint" rule.
 *
 * Each is still validated against the navgrid at spawn, so a spot that drifts
 * inside a building — or outside the field, now that the match is bounded to
 * one — is skipped rather than quietly dropping the crate somewhere no one can
 * reach.
 */
export const LOOT_SPOTS: ReadonlyArray<{ x: number; z: number; where: string }> = [
  { x: planX(-1), z: planZ(290), where: 'under the Meridian Gate, in the shadow of the arch' },
  { x: planX(-120), z: planZ(250), where: 'the south-west corner of the outer court' },
  { x: planX(115), z: planZ(245), where: 'the south-east corner of the outer court' },
  { x: planX(-140), z: planZ(190), where: 'the west colonnade of the outer court' },
  { x: planX(150), z: planZ(190), where: 'the east colonnade, by the Gate of Blending Harmony' },
  { x: planX(103), z: planZ(30), where: 'the Belvedere of Embodying Benevolence, east colonnade' },
  { x: planX(-101), z: planZ(30), where: 'the Belvedere of Spreading Righteousness, west colonnade' },
  { x: planX(-150), z: planZ(60), where: 'the west gallery of the great court' },
  { x: planX(0), z: planZ(-215), where: 'the north face of the great terrace' },
  { x: planX(100), z: planZ(-60), where: 'the alley east of the great terrace' },
  { x: planX(-105), z: planZ(-60), where: 'the alley west of the great terrace' },
  { x: planX(60), z: planZ(-260), where: 'the court of the Gate of Heavenly Purity, east side' },
];

// --- masks ------------------------------------------------------------------

/**
 * Distance outside the wall's centreline rectangle, in metres.
 *
 * Negative inside. Rectangular rather than radial: the compound is a rectangle,
 * and a radial falloff would put the moat closer at the corners than on the
 * flanks, which is exactly the tell that a map was generated rather than built.
 */
function outsideWall(x: number, z: number): number {
  const dx = Math.abs(x) - WALL.halfX;
  const dz = Math.abs(z) - WALL.halfZ;
  if (dx <= 0 && dz <= 0) return Math.max(dx, dz);
  return Math.hypot(Math.max(dx, 0), Math.max(dz, 0));
}

/** The great terrace's coverage, 0 (courtyard) to 1 (up on the marble). */
export function terraceMask(x: number, z: number): number {
  const acrossX = 1 - smoothstep(TERRACE.halfX - TERRACE.skirt, TERRACE.halfX, Math.abs(x));
  const centerZ = (TERRACE.northZ + TERRACE.southZ) / 2;
  const halfZ = (TERRACE.southZ - TERRACE.northZ) / 2;
  const alongZ = 1 - smoothstep(halfZ - TERRACE.skirt, halfZ, Math.abs(z - centerZ));
  return acrossX * alongZ;
}

/** Centreline of the Golden Water River at a given x — a shallow bow. */
function riverCenterZ(x: number): number {
  const t = clamp(Math.abs(x) / GOLDEN_RIVER.halfSpan, 0, 1);
  return GOLDEN_RIVER.centerZ + GOLDEN_RIVER.bow * t * t;
}

/** Golden Water River coverage, 0 (paving) to 1 (channel). */
export function riverMask(x: number, z: number): number {
  if (Math.abs(x) > GOLDEN_RIVER.halfSpan) return 0;
  const dz = Math.abs(z - riverCenterZ(x));
  const channel = 1 - smoothstep(GOLDEN_RIVER.halfDepth * 0.55, GOLDEN_RIVER.halfDepth, dz);
  // The bridges carry the paving straight over the channel.
  let deck = 0;
  for (const bridge of RIVER_BRIDGES) {
    const d = 1 - smoothstep(bridge.halfWidth * 0.8, bridge.halfWidth * 1.25, Math.abs(x - bridge.x));
    if (d > deck) deck = d;
  }
  return channel * (1 - deck);
}

/**
 * Distance outside the moat's inner bank, in metres. Negative on the road side.
 *
 * A rectangle in its own right rather than an offset of the wall, because its
 * south arm stands much further out — see `MOAT.innerSouthZ`.
 */
export function outsideMoat(x: number, z: number): number {
  const dx = Math.abs(x) - MOAT.innerX;
  const dz = z >= 0 ? z - MOAT.innerSouthZ : -z - MOAT.innerNorthZ;
  if (dx <= 0 && dz <= 0) return Math.max(dx, dz);
  return Math.hypot(Math.max(dx, 0), Math.max(dz, 0));
}

/** Moat coverage, 0 (bank) to 1 (open water). */
export function moatMask(x: number, z: number): number {
  const out = outsideMoat(x, z);
  const bank = planLength(6);
  const rise = smoothstep(0, bank, out);
  const fall = 1 - smoothstep(MOAT.width - bank, MOAT.width, out);
  return rise * fall;
}

/**
 * The imperial way — 御路 — running the length of the axis.
 *
 * A centre strip of pale stone, flanked by the grey brick everyone else walked
 * on. It is the strongest line on the map and the reason the compound reads as
 * one composition from the Meridian Gate to the garden.
 *
 * Laid as geometry by the arena rather than painted into the terrain: it is 4m
 * wide against a ground grid whose lines are metres apart, and a vertex-coloured
 * strip that narrow comes out as a dotted smear.
 */
export const IMPERIAL_WAY = {
  x: planX(-4),
  halfWidth: planLength(4.5),
  /** A hand's breadth proud of the brick either side. */
  rise: 0.12,
} as const;

/** Courtyard paving coverage — everything inside the walls that is not terrace. */
export function courtyardMask(x: number, z: number): number {
  return 1 - smoothstep(-planLength(10), 0, outsideWall(x, z));
}

// --- ground -----------------------------------------------------------------

/** Courtyard level. Everything inside the walls stands on this. */
const COURT_Y = 0;
/**
 * The compound sits on a plinth above the ground outside its walls.
 *
 * Shallower than it looks like it should be, and deliberately: the moat's water
 * plane is a single surface across the whole map, so every metre this drops is a
 * metre of freeboard lost on the road that rings the wall.
 */
const OUTSIDE_Y = -0.8;

/**
 * Ground height at a world position.
 *
 * The Forbidden City is built on the North China Plain and is, to within a few
 * centimetres, dead flat: the drama is entirely in the buildings and the
 * terraces, not in the landform. That makes this function far simpler than the
 * park's — and puts the whole burden of making the map readable on the
 * structures, which is exactly where it belongs.
 */
export function heightAt(x: number, z: number): number {
  const out = outsideWall(x, z);

  // Inside the walls: flat paving, with the great terrace standing on it.
  //
  // The terrace is in the *ground* rather than in the props, unlike every other
  // hard edge on the map, because the navgrid is a heightfield: a bot can only
  // stand on what `heightAt` returns. Built as a prop it would be a 3.7m block
  // that bots refuse to climb and the player has to be pushed onto, which is no
  // way to treat the centrepiece of the compound. The marble facing and the
  // stairs are geometry laid over this, and it is the facing — not the slope
  // here — that stops anyone walking up the sides.
  let h = COURT_Y;
  h += terraceMask(x, z) * TERRACE.height;

  // A whisper of unevenness in the paving. Six hundred years of frost heave,
  // and without it the courtyards read as a polished floor.
  const paving = 1 - smoothstep(0, planLength(20), out);
  h += paving * fbmSigned(x * 0.06, z * 0.06, 2, 419) * 0.07;

  // Outside the walls the ground steps down off the plinth, under the wall's
  // own footprint where the drop cannot be seen.
  h = lerp(h, OUTSIDE_Y, smoothstep(-WALL.thickness * 0.4, WALL.thickness * 0.9, out));

  // The road between wall and water, on a gentle camber toward the moat.
  const moatOut = outsideMoat(x, z);
  h -= smoothstep(-planLength(30), 0, moatOut) * 0.2;

  // Carve the moat. This overrides whatever the ground outside said.
  h = lerp(h, MOAT.bedY, moatMask(x, z));

  // Beyond the far bank the ground rises slightly and roughens — the edge of
  // the old city, which is backdrop and never walked on.
  const beyond = smoothstep(MOAT.width, MOAT.width + planLength(40), moatOut);
  h += beyond * (1.2 + fbmSigned(x * 0.02, z * 0.02, 3, 733) * 1.6);

  // Jingshan is not here: it stands 385m north of the origin, well outside the
  // terrain, and is built by the backdrop as its own mesh.

  // The Golden Water River, cut into the first courtyard's paving.
  h = lerp(h, GOLDEN_RIVER.bedY, riverMask(x, z));

  return h;
}

// --- the terrain grid -------------------------------------------------------

/**
 * Base spacing of the ground mesh, in metres, at a distance `out` outside the
 * wall. Fine inside the compound where the fight is; coarse over the moat ring,
 * which is a bank, a strip of water and another bank.
 */
function gridSpacing(out: number): number {
  if (out < 0) return 3.4;
  if (out < MOAT.width * 2) return 4.5;
  return 8;
}

/**
 * Where the ground mesh puts its lines along one axis.
 *
 * Not a uniform grid. The compound is dead flat except at a handful of hard
 * edges — the terrace skirt, the moat banks, the river channel — and a uniform
 * grid fine enough to resolve those would spend fifty thousand vertices
 * describing a car park. Instead the spacing is coarse by default and every
 * feature edge is *forced* onto a line, so each edge lands exactly where it
 * should with no vertices wasted between them.
 *
 * `features` are the coordinates that must appear; each is bracketed by a pair
 * of lines a hand's width either side, which is what makes an edge sharp rather
 * than a ramp to the next general-purpose line.
 */
function buildAxis(half: number, wallHalf: number, features: number[]): Float32Array {
  const lines = new Set<number>();
  const round = (v: number) => Math.round(v * 100) / 100;

  for (let v = -half; v < half; ) {
    lines.add(round(v));
    v += gridSpacing(Math.abs(v) - wallHalf);
  }
  lines.add(round(half));

  for (const f of features) {
    if (Math.abs(f) > half) continue;
    lines.add(round(f - 0.5));
    lines.add(round(f));
    lines.add(round(f + 0.5));
  }

  const sorted = [...lines].sort((a, b) => a - b);
  return Float32Array.from(sorted);
}

/** Edges the ground mesh has to resolve, east-west. */
function featuresX(): number[] {
  const f: number[] = [];
  for (const sign of [-1, 1]) {
    f.push(sign * TERRACE.halfX, sign * (TERRACE.halfX - TERRACE.skirt));
    f.push(sign * WALL.halfX, sign * INTERIOR.halfX);
    f.push(sign * MOAT.innerX, sign * MOAT_OUTER_X);
  }
  return f;
}

/** True where the ground is the flat courtyard the compound is paved with. */
export function isCourtyard(x: number, z: number): boolean {
  return outsideWall(x, z) < -WALL.thickness / 2;
}

/**
 * True for a point on the great terrace, its aprons included.
 *
 * Generous on purpose. The survey traces the terrace as two big unnamed
 * platform polygons that run a little past the terrace's own bounds, and the
 * arena has to drop those on the floor: the terrace is *terrain* here, and
 * building the survey's slabs as well lays a second platform 0.7m above the
 * first, overhanging the stairs by thirteen metres — invisible from the
 * courtyard, and a dead stop halfway up your own staircase.
 */
export function onTheGreatTerrace(x: number, z: number): boolean {
  const centerZ = (TERRACE.northZ + TERRACE.southZ) / 2;
  const halfZ = (TERRACE.southZ - TERRACE.northZ) / 2 + planLength(30);
  return Math.abs(x) < TERRACE.halfX + planLength(20) && Math.abs(z - centerZ) < halfZ;
}

/** Edges the ground mesh has to resolve, north-south. */
function featuresZ(): number[] {
  const f: number[] = [];
  f.push(TERRACE.northZ, TERRACE.northZ + TERRACE.skirt);
  f.push(TERRACE.southZ, TERRACE.southZ - TERRACE.skirt);
  f.push(GOLDEN_RIVER.centerZ - GOLDEN_RIVER.halfDepth, GOLDEN_RIVER.centerZ);
  f.push(GOLDEN_RIVER.centerZ + GOLDEN_RIVER.halfDepth + GOLDEN_RIVER.bow);
  for (const sign of [-1, 1]) {
    f.push(sign * WALL.halfZ, sign * INTERIOR.halfZ);
  }
  f.push(-MOAT.innerNorthZ, -MOAT_OUTER_NORTH_Z);
  f.push(MOAT.innerSouthZ, MOAT_OUTER_SOUTH_Z);
  return f;
}

/** Grid lines for the ground mesh, east-west. */
export function terrainAxisX(): Float32Array {
  return buildAxis(GROUND_HALF_X, WALL.halfX, featuresX());
}

/** Grid lines for the ground mesh, north-south. */
export function terrainAxisZ(): Float32Array {
  return buildAxis(GROUND_HALF_Z, WALL.halfZ, featuresZ());
}

/** Central-difference surface normal steepness, 0 (flat) to 1 (vertical). */
export function slopeAt(x: number, z: number, eps = 1.0): number {
  const hx = heightAt(x + eps, z) - heightAt(x - eps, z);
  const hz = heightAt(x, z + eps) - heightAt(x, z - eps);
  const gradient = Math.hypot(hx, hz) / (2 * eps);
  return clamp(gradient / (gradient + 1), 0, 1);
}

// --- colour -----------------------------------------------------------------

const SCRATCH = new Color();
/**
 * Courtyard brick. The Forbidden City's courts are paved in grey fired brick —
 * 金砖, "golden bricks", despite being grey — laid in courses and worn pale
 * along the lines everyone walks.
 */
const BRICK_LIT = new Color(0xb3ada0);
const BRICK_DEEP = new Color(0x67635c);
const BRICK_WARM = new Color(0xa08f76);
/** White marble: the terraces, the balustrades, the bridges. */
const MARBLE = new Color(0xe4dfd2);
const MARBLE_SHADE = new Color(0xc0b9a8);
/** The pale stone of the imperial way, laid as geometry by the arena. */
export const IMPERIAL_STONE = new Color(0xd8cdb6);
/** Bare earth and gravel outside the walls. */
const EARTH = new Color(0x8d7f68);
const MOAT_BED = new Color(0x59614f);
const RIVER_BED = new Color(0x6b7160);
/** Jingshan's wooded flank, used by the backdrop that builds the hill. */
export const PINE = new Color(0x4c6b45);
export const PINE_LIT = new Color(0x76914f);
/** Scratch for the two mixes that need one, so colouring costs no allocation. */
const MIX = new Color();

/**
 * Ground colour at a point.
 *
 * Vertex colours rather than textures, as the park did: the palette varies over
 * tens of metres, which is the scale vertex interpolation handles well, and it
 * costs no download and no UV unwrap.
 */
export function groundColorAt(x: number, z: number, height: number, slope: number): Color {
  const out = outsideWall(x, z);

  // Three scales of variation, so a courtyard the size of a football pitch
  // never reads as one flat fill — the single fastest way to make paving look
  // like a placeholder.
  const broad = fbm2D(x * 0.016, z * 0.016, 3, 11);
  const mid = fbm2D(x * 0.07, z * 0.07, 3, 47);
  const fine = fbm2D(x * 0.19, z * 0.19, 2, 29);

  SCRATCH.copy(BRICK_DEEP).lerp(BRICK_LIT, clamp((broad - 0.26) * 1.8, 0, 1));
  SCRATCH.lerp(BRICK_WARM, clamp((mid - 0.5) * 1.6, 0, 1) * 0.45);
  SCRATCH.lerp(BRICK_LIT, clamp((fine - 0.6) * 1.7, 0, 1) * 0.3);

  // Courses. Broad bands only — vertex colours are sampled on a ~2m grid, so
  // anything with a period under about 4m aliases into noise rather than
  // reading as brickwork.
  const course = Math.sin(z * 0.42) * 0.5 + 0.5;
  SCRATCH.lerp(BRICK_DEEP, course * 0.12);

  // The great terrace, and its stepped skirt.
  const terrace = terraceMask(x, z);
  if (terrace > 0.01) {
    const veins = fbm2D(x * 0.12, z * 0.12, 2, 313);
    MIX.copy(MARBLE).lerp(MARBLE_SHADE, clamp((0.5 - veins) * 1.4, 0, 1));
    SCRATCH.lerp(MIX, terrace * 0.95);
  }

  // Outside the walls: earth, then the river beds.
  SCRATCH.lerp(EARTH, smoothstep(0, planLength(14), out) * 0.9);
  SCRATCH.lerp(MOAT_BED, smoothstep(0.15, 0.6, moatMask(x, z)));
  SCRATCH.lerp(RIVER_BED, smoothstep(0.2, 0.7, riverMask(x, z)));

  // Anything steep enough to be a bank rather than a floor loses its paving.
  SCRATCH.lerp(EARTH, smoothstep(0.3, 0.6, slope) * 0.7);
  // And anything below the waterline is bed, whatever it was before.
  SCRATCH.lerp(MOAT_BED, smoothstep(WATER_Y - 0.2, WATER_Y - 1.6, height) * 0.7);

  return SCRATCH;
}
