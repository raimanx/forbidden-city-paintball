import {
  DirectionalLight,
  Fog,
  Group,
  HemisphereLight,
  Matrix4,
  Mesh,
  Object3D,
  Vector3,
  type BufferGeometry,
  type Material,
} from 'three';
import { palette } from '../core/Config';
import type { GameContext, System } from '../core/System';
import type { SurfaceRegistry } from '../paint/SurfaceRegistry';
import { createCelMaterial } from '../render/CelMaterial';
import { shadowMapSize } from '../render/Renderer';
import { Sky } from '../render/Sky';
import { Backdrop } from './Backdrop';
import { CITY_COLORS, buildStructure, type BoxCollider } from './CityBuilding';
import { CityProps } from './CityProps';
import {
  GOLDEN_RIVER,
  GROUND_HALF_X,
  GROUND_HALF_Z,
  IMPERIAL_WAY,
  INTERIOR,
  MOAT,
  RIVER_BRIDGES,
  TERRACE,
  WALL,
  heightAt,
  planLength,
  planX,
  planZ,
} from './CityLayout';
import { STRUCTURES, type Structure } from './CityPlan';
import { MeshBuilder } from './MeshBuilder';
import { Terrain } from './Terrain';
import { Water } from './Water';

/**
 * The Forbidden City arena.
 *
 * Assembles the ground, the compound's 798 structures, the perimeter wall, the
 * great terrace and the moat into a playable map, and registers every collider
 * with the paint system so that anything you can shoot, you can paint.
 *
 * ## Districts
 *
 * Buildings are generated, not instanced — see `CityBuilding` for why — and
 * merged into a small number of meshes. Merging everything into one would be
 * fewest draw calls and the worst possible frustum culling: the whole city would
 * be submitted every frame from inside a courtyard that can see three buildings.
 * So geometry is merged per **district**, a grid of roughly 110m cells, and
 * within a district by material. A dozen districts times three materials is a
 * few dozen draw calls, and standing in the Inner Court submits the Inner Court.
 */

/**
 * The sun: south-west, and high.
 *
 * Higher than the park's, which sat at about 35 degrees for long shadows down
 * the Mall. That elevation does not survive contact with this architecture: the
 * eaves overhang by well over a metre, and a low sun puts the entire upper half
 * of every red wall — the doors, the lattice, the painted frieze — into its own
 * shadow. At 55 degrees the courtyards are lit, the eave still throws a band of
 * shade under itself, and the roofs keep their gold.
 */
const SUN_DIRECTION = new Vector3(-0.34, 0.86, 0.46).normalize();

/**
 * Half-extent of the shadow camera, in metres.
 *
 * Player-centred rather than sized to the map, as the park's was: at 470m across
 * a single frustum would spread 2048 texels over the lot, and the crisp shadow
 * of an eave would turn to grey smear. Nothing beyond this casts a shadow anyone
 * can read anyway.
 */
const SHADOW_EXTENT = 82;

/** Side of a district cell, in metres. */
const DISTRICT = 110;

/** Which material a merged mesh is drawn with. */
type Surface = 'roof' | 'timber' | 'stone';

const SURFACE_COLORS: Record<Surface, number> = {
  // Vertex colours carry the real hue; the material tint stays white so it
  // does not multiply them down.
  roof: 0xffffff,
  timber: 0xffffff,
  stone: 0xffffff,
};

interface District {
  roof: MeshBuilder;
  timber: MeshBuilder;
  stone: MeshBuilder;
}

export class CityArenaSystem implements System {
  readonly name = 'city-arena';

  private terrain?: Terrain;
  private water?: Water;
  private backdrop?: Backdrop;
  private props?: CityProps;
  private sky?: Sky;
  private sun?: DirectionalLight;
  private sunTarget?: Object3D;

  private readonly disposables: Array<{ dispose(): void }> = [];
  private readonly group = new Group();
  /** Kept so the paint system's receivers stay alive as long as the map does. */
  private readonly geometries: BufferGeometry[] = [];

  constructor(private readonly surfaces: SurfaceRegistry) {}

  async init(ctx: GameContext): Promise<void> {
    const { scene } = ctx;

    // Beijing's air does the aerial perspective for free, and across a compound
    // this deep it is what separates the near courtyard from the far one. The
    // near bound sits past the largest courtyard so nothing you are fighting in
    // is hazed.
    scene.fog = new Fog(palette.fogNear, 130, 720);
    this.sky = new Sky(SUN_DIRECTION);
    scene.add(this.sky.mesh);
    this.addLights(ctx);

    ctx.events.emit('load:progress', { phase: 'ground', progress: 0.35 });
    this.terrain = new Terrain(ctx.physics);
    scene.add(this.terrain.mesh);
    this.surfaces.registerMesh(this.terrain.collider.handle, this.terrain.mesh);

    this.water = new Water();
    scene.add(this.water.mesh);

    ctx.events.emit('load:progress', { phase: 'the palace', progress: 0.5 });
    this.buildCompound(ctx);

    // Beyond the moat: Jingshan on the axis, and the grey roofscape of the old
    // city. Scenery only — no colliders, and the navgrid never sees it.
    this.backdrop = new Backdrop(ctx.rng);
    scene.add(this.backdrop.group);

    // The furniture: vats, lions, the rockery. Authored in Blender, because
    // unlike the buildings these repeat at a fixed size — see CityProps.
    this.props = new CityProps();
    await this.props.load(ctx, this.surfaces, ctx.rng);
    scene.add(this.props.group);

    scene.add(this.group);
    ctx.events.emit('load:progress', { phase: 'the palace', progress: 0.8 });
  }

  private addLights(ctx: GameContext): void {
    // Warm key, cool fill — the pairing that gives warm light and blue-violet
    // shadow with no shader involvement.
    //
    // Lifted well off the park's values. Half this map is red wall and gold
    // tile in a courtyard with nothing green to bounce light back, and at the
    // park's ambient the shaded faces of every hall went to brown mud.
    const hemi = new HemisphereLight(0xa8c8e8, 0xbfa588, 1.45);
    ctx.scene.add(hemi);

    const sun = new DirectionalLight(palette.sunWarm, 2.5);
    sun.castShadow = true;
    sun.shadow.mapSize.setScalar(shadowMapSize());
    sun.shadow.camera.near = 10;
    sun.shadow.camera.far = 420;
    sun.shadow.camera.left = -SHADOW_EXTENT;
    sun.shadow.camera.right = SHADOW_EXTENT;
    sun.shadow.camera.top = SHADOW_EXTENT;
    sun.shadow.camera.bottom = -SHADOW_EXTENT;
    sun.shadow.bias = -0.0012;
    sun.shadow.normalBias = 0.03;

    // A directional light points at its target, and the target must be in the
    // scene for its world matrix to update. Moving the pair together each frame
    // is what lets the shadow frustum follow the player.
    this.sunTarget = new Object3D();
    ctx.scene.add(this.sunTarget);
    sun.target = this.sunTarget;
    sun.position.copy(SUN_DIRECTION).multiplyScalar(190);

    ctx.scene.add(sun);
    this.sun = sun;
    this.disposables.push(sun);
  }

  // --- the compound ---------------------------------------------------------

  private buildCompound(ctx: GameContext): void {
    const districts = new Map<string, District>();
    const colliders: BoxCollider[] = [];
    /** Which district each collider belongs to, so paint can find its mesh. */
    const colliderDistrict: string[] = [];

    const districtOf = (x: number, z: number): string =>
      `${Math.floor(x / DISTRICT)},${Math.floor(z / DISTRICT)}`;

    const targetFor = (key: string): District => {
      let d = districts.get(key);
      if (!d) {
        d = { roof: new MeshBuilder(), timber: new MeshBuilder(), stone: new MeshBuilder() };
        districts.set(key, d);
      }
      return d;
    };

    for (const structure of STRUCTURES) {
      // The great terrace is built here, from `CityLayout.TERRACE`, because the
      // navgrid needs its top surface to be ground. The survey has it too — as
      // two big unnamed platform polygons — and building those as well laid a
      // second slab 0.7m above the first, overhanging the stairs by thirteen
      // metres. From the courtyard it was invisible; walking up the stairs you
      // stopped dead halfway with clear air ahead of you.
      if (structure.kind === 'platform' && onTheGreatTerrace(structure)) continue;

      const key = districtOf(planX(structure.x), planZ(structure.z));
      const boxes = buildStructure(structure, heightAt, targetFor(key));
      for (const box of boxes) {
        colliders.push(box);
        colliderDistrict.push(key);
      }
    }

    // The wall, the terrace and the imperial way are not in the survey's
    // building list: they are the ground plan itself.
    this.buildWall(targetFor('wall'), colliders, colliderDistrict);
    this.buildTerrace(targetFor('terrace'), colliders, colliderDistrict);
    this.buildImperialWay(targetFor('way'));
    this.buildRiverBridges(targetFor('bridge'), colliders, colliderDistrict);
    this.buildContainment(colliders, colliderDistrict);

    // One mesh per district per material.
    let meshes = 0;
    const byKeyAndSurface = new Map<string, Mesh>();
    for (const [key, district] of districts) {
      for (const surface of ['roof', 'timber', 'stone'] as Surface[]) {
        const geometry = district[surface].finish();
        if (!geometry) continue;
        const material = createCelMaterial({ color: SURFACE_COLORS[surface] });
        material.vertexColors = true;
        const mesh = new Mesh(geometry, material);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.matrixAutoUpdate = false;
        this.group.add(mesh);
        this.disposables.push(material as unknown as Material & { dispose(): void });
        this.geometries.push(geometry);
        byKeyAndSurface.set(`${key}/${surface}`, mesh);
        meshes++;
      }
    }

    // Colliders in one batch, then wired back to the mesh that drew them so a
    // splat lands on the district it hit.
    const created = ctx.physics.createStaticBoxes(
      colliders.map((b) => ({
        position: { x: b.cx, y: b.cy, z: b.cz },
        halfExtents: { x: b.hw, y: b.hh, z: b.hd },
      })),
    );
    const identity = new Matrix4();
    created.forEach((collider, i) => {
      const key = colliderDistrict[i]!;
      // Paint projects against whichever district mesh covers this collider.
      // Walls and plinths are drawn in different materials, so the timber mesh
      // is the receiver where there is one and the stone mesh otherwise —
      // between them they hold every triangle of the building that was hit.
      const mesh = byKeyAndSurface.get(`${key}/timber`) ?? byKeyAndSurface.get(`${key}/stone`);
      if (!mesh) return;
      this.surfaces.register(collider.handle, { geometry: mesh.geometry, matrixWorld: identity });
    });

    const triangles: Record<string, number> = {};
    for (const [key, district] of districts) {
      for (const surface of ['roof', 'timber', 'stone'] as Surface[]) {
        triangles[surface] = (triangles[surface] ?? 0) + district[surface].triangleCount;
      }
      void key;
    }
    console.info(
      `city: ${STRUCTURES.length} structures, ${meshes} meshes, ${created.length} colliders, ` +
      `triangles ${JSON.stringify(triangles)}`,
    );
  }

  /**
   * The perimeter wall, in segments.
   *
   * Not a closed rectangle: the four gates stand *in* the wall rather than
   * beside it, and the Meridian Gate's wings project south of it. So the wall is
   * built as runs between the gaps the gate structures occupy, which are found
   * from the plan rather than hardcoded — if the survey ever moves a gate, the
   * hole moves with it.
   */
  private buildWall(out: District, colliders: BoxCollider[], keys: string[]): void {
    const gaps = wallGaps();
    const half = WALL.thickness / 2;

    const run = (
      fixed: number, from: number, to: number, along: 'x' | 'z',
      openings: Array<[number, number]>,
    ): void => {
      // Cut the openings out of the run, front to back.
      const sorted = [...openings].sort((a, b) => a[0] - b[0]);
      let cursor = from;
      const spans: Array<[number, number]> = [];
      for (const [a, b] of sorted) {
        if (b < cursor || a > to) continue;
        if (a > cursor) spans.push([cursor, Math.min(a, to)]);
        cursor = Math.max(cursor, b);
      }
      if (cursor < to) spans.push([cursor, to]);

      for (const [a, b] of spans) {
        if (b - a < 1) continue;
        const mid = (a + b) / 2;
        const halfLength = (b - a) / 2;
        const cx = along === 'x' ? mid : fixed;
        const cz = along === 'x' ? fixed : mid;
        const hw = along === 'x' ? halfLength : half;
        const hd = along === 'x' ? half : halfLength;
        const groundY = heightAt(cx, cz);

        // A grey stone base course, then the red wall above it, battered in.
        out.stone.box(cx, groundY + WALL.baseHeight / 2, cz, hw, WALL.baseHeight / 2, hd,
          CITY_COLORS.stoneDark);
        const bodyH = WALL.height - WALL.baseHeight;
        out.timber.box(cx, groundY + WALL.baseHeight + bodyH / 2, cz, hw, bodyH / 2, hd,
          CITY_COLORS.red, 0.12);
        // Tiled coping along the top.
        out.roof.box(cx, groundY + WALL.height + 0.22, cz,
          hw + 0.3, 0.22, hd + 0.3, CITY_COLORS.tile);

        colliders.push({ cx, cy: groundY + WALL.height / 2, cz, hw, hh: WALL.height / 2, hd });
        keys.push('wall');
      }
    };

    run(-WALL.halfZ, -WALL.halfX, WALL.halfX, 'x', gaps.north);
    run(WALL.halfZ, -WALL.halfX, WALL.halfX, 'x', gaps.south);
    run(-WALL.halfX, -WALL.halfZ, WALL.halfZ, 'z', gaps.west);
    run(WALL.halfX, -WALL.halfZ, WALL.halfZ, 'z', gaps.east);
  }

  /**
   * The three-tiered marble terrace.
   *
   * Its top surface is terrain — see `CityLayout.heightAt` for why the navgrid
   * needs it there — so what is built here is the *facing*: the marble wall that
   * holds the platform up, and the stairs that are the only way onto it.
   */
  private buildTerrace(out: District, colliders: BoxCollider[], keys: string[]): void {
    const centerZ = (TERRACE.northZ + TERRACE.southZ) / 2;
    const halfZ = (TERRACE.southZ - TERRACE.northZ) / 2;
    const stairHalfWidth = planLength(18);

    // Three tiers, each stepped back from the one below, each with a balustrade
    // course on top. This is the shape everybody knows from the photographs.
    for (let tier = 0; tier < 3; tier++) {
      const t = tier / 3;
      const inset = t * TERRACE.skirt;
      const hx = TERRACE.halfX - inset;
      const hz = halfZ - inset;
      const top = (TERRACE.height / 3) * (tier + 1);
      const faceH = TERRACE.height / 3;
      const cy = top - faceH / 2;

      // Four faces of the tier, as slabs rather than one box, so the terrace is
      // hollow and costs four boxes a tier instead of a solid volume of them.
      //
      // The south face is built in two, with the stair opening cut out of the
      // middle. Every tier has to be cut, not just the bottom one: the stairs
      // climb through all three, and a facing left whole across the opening is
      // an invisible wall two thirds of the way up your own staircase.
      const t2 = planLength(2.2);
      const face = (cx1: number, cz1: number, fhw: number, fhd: number): void => {
        out.stone.box(cx1, cy, cz1, fhw, faceH / 2, fhd, CITY_COLORS.marble);
        colliders.push({ cx: cx1, cy, cz: cz1, hw: fhw, hh: faceH / 2, hd: fhd });
        keys.push('terrace');
      };
      face(0, centerZ - hz, hx, t2 / 2);
      const shoulder = (hx - stairHalfWidth) / 2;
      if (shoulder > 0.2) {
        for (const side of [-1, 1]) {
          face(side * (stairHalfWidth + shoulder), centerZ + hz, shoulder, t2 / 2);
        }
      }
      for (const side of [-1, 1]) {
        face(side * hx, centerZ, t2 / 2, hz);
      }

      // The balustrade — 栏杆. Three pieces, not one: a solid kerb along the
      // rim, a post every couple of metres, and a continuous rail across their
      // heads. Posts alone read as a picket fence from thirty metres, which is
      // where this is looked at from; it is the unbroken horizontal of the rail
      // that makes marble balustrade read as marble balustrade.
      const kerbY = top + 0.16;
      const postY = top + 0.62;
      const railY = top + 1.06;
      const spacing = 2.4;

      const rim = (along: 'x' | 'z', fixed: number, from: number, to: number): void => {
        const mid = (from + to) / 2;
        const halfLength = (to - from) / 2;
        const hx1 = along === 'x' ? halfLength : 0.17;
        const hz1 = along === 'x' ? 0.17 : halfLength;
        const cx1 = along === 'x' ? mid : fixed;
        const cz1 = along === 'x' ? fixed : mid;
        out.stone.box(cx1, kerbY, cz1, hx1, 0.16, hz1, CITY_COLORS.marble);
        out.stone.box(cx1, railY, cz1, hx1, 0.11, hz1, CITY_COLORS.marble);
        for (let t = from; t <= to; t += spacing) {
          const px = along === 'x' ? t : fixed;
          const pz = along === 'x' ? fixed : t;
          out.stone.box(px, postY, pz, 0.13, 0.3, 0.13, CITY_COLORS.marbleShade);
        }
      };

      // The south rim is broken by the stairs; the rail either side of them
      // stops at the opening rather than running across it.
      rim('x', centerZ - hz, -hx, hx);
      rim('x', centerZ + hz, -hx, -stairHalfWidth);
      rim('x', centerZ + hz, stairHalfWidth, hx);
      rim('z', -hx, centerZ - hz, centerZ + hz);
      rim('z', hx, centerZ - hz, centerZ + hz);

    }

    // The stairs up the south face, flanked by the carved dragon ramp that runs
    // between the two flights on the imperial axis.
    const steps = 14;
    const stepRise = TERRACE.height / steps;
    const stepRun = planLength(1.4);
    // The top step lands where the *terrain* reaches full terrace height, not
    // at the terrace's nominal edge. `heightAt` ramps the terrace up over its
    // skirt, so a flight ending at the edge drops the player 1.8m onto that
    // ramp and leaves them grinding up a slope with a staircase behind them.
    const z0 = centerZ + halfZ - TERRACE.skirt + 0.4;
    for (let i = 0; i < steps; i++) {
      const y = stepRise * (i + 0.5);
      const z = z0 + stepRun * (steps - i - 0.5);
      out.stone.box(0, y, z, stairHalfWidth, stepRise / 2, stepRun / 2, CITY_COLORS.marble);
      colliders.push({
        cx: 0, cy: y, cz: z, hw: stairHalfWidth, hh: stepRise / 2, hd: stepRun / 2,
      });
      keys.push('terrace');
    }
    // 御路石: the ramp of carved stone up the middle, which nobody walks on.
    out.stone.box(
      IMPERIAL_WAY.x, TERRACE.height / 2, z0 + (stepRun * steps) / 2,
      planLength(3), TERRACE.height / 2, (stepRun * steps) / 2,
      CITY_COLORS.marbleShade,
    );
  }

  /**
   * The edge of the world, at the far bank of the moat.
   *
   * The compound has a wall and the wall has gates, so a player who walks out
   * through one is meant to end up on the ring road — that is where the moat
   * and the corner towers are best seen from, and it is the one part of the map
   * that feels like standing outside the story. What they must not be able to do
   * is keep going, into a roofscape with no ground under it.
   *
   * Invisible, unlike the park's, which used a visible stone lip: here there is
   * already a moat between the player and this line, and drawing a wall in the
   * water would be the only thing on the map that admits to being a game
   * boundary.
   */
  private buildContainment(colliders: BoxCollider[], keys: string[]): void {
    const edgeX = GROUND_HALF_X - 3;
    const edgeZ = GROUND_HALF_Z - 3;
    const height = 14;

    for (const [sx, sz] of [[0, -1], [0, 1], [-1, 0], [1, 0]] as const) {
      const horizontal = sz !== 0;
      colliders.push({
        cx: sx * edgeX,
        cy: height / 2 - 4,
        cz: sz * edgeZ,
        hw: horizontal ? edgeX + 2 : 1,
        hh: height / 2,
        hd: horizontal ? 1 : edgeZ + 2,
      });
      keys.push('containment');
    }
  }

  /**
   * The five bridges over the Inner Golden Water River.
   *
   * The layout already parts the water for them — `riverMask` leaves the paving
   * unbroken where a bridge crosses — so what is missing is the thing that makes
   * a crossing read as a bridge rather than as a gap in a ditch: a marble deck a
   * hand above the paving, and a balustrade down both sides. The middle one is
   * the imperial bridge and is the widest of the five.
   */
  private buildRiverBridges(out: District, colliders: BoxCollider[], keys: string[]): void {
    const railHeight = 0.9;
    for (const bridge of RIVER_BRIDGES) {
      const centerZ = GOLDEN_RIVER.centerZ
        + GOLDEN_RIVER.bow * Math.pow(Math.min(Math.abs(bridge.x) / GOLDEN_RIVER.halfSpan, 1), 2);
      const halfDepth = GOLDEN_RIVER.halfDepth + planLength(6);

      // The deck, standing a little proud of the courtyard either side.
      out.stone.box(bridge.x, 0.14, centerZ, bridge.halfWidth, 0.14, halfDepth,
        CITY_COLORS.marble);
      colliders.push({
        cx: bridge.x, cy: 0.14, cz: centerZ,
        hw: bridge.halfWidth, hh: 0.14, hd: halfDepth,
      });
      keys.push('bridge');

      // A balustrade down both sides: kerb, posts, rail — the same three pieces
      // the terrace uses, at the same human size.
      for (const side of [-1, 1]) {
        const x = bridge.x + side * (bridge.halfWidth - 0.12);
        out.stone.box(x, 0.42, centerZ, 0.14, 0.28, halfDepth, CITY_COLORS.marble);
        out.stone.box(x, railHeight, centerZ, 0.16, 0.1, halfDepth, CITY_COLORS.marble);
        for (let z = centerZ - halfDepth; z <= centerZ + halfDepth; z += 1.8) {
          out.stone.box(x, 0.7, z, 0.12, 0.24, 0.12, CITY_COLORS.marbleShade);
        }
        colliders.push({
          cx: x, cy: 0.5, cz: centerZ, hw: 0.18, hh: 0.5, hd: halfDepth,
        });
        keys.push('bridge');
      }
    }
  }

  /** The imperial way: a strip of pale stone the length of the axis. */
  private buildImperialWay(out: District): void {
    const step = 14;
    for (let z = -INTERIOR.halfZ; z < INTERIOR.halfZ; z += step) {
      const y = heightAt(IMPERIAL_WAY.x, z + step / 2);
      // Skipped where the terrace already carries the axis — the way runs over
      // its stairs, not through its side.
      if (y > 0.4) continue;
      out.stone.box(
        IMPERIAL_WAY.x, y + IMPERIAL_WAY.rise / 2, z + step / 2,
        IMPERIAL_WAY.halfWidth, IMPERIAL_WAY.rise / 2, step / 2,
        CITY_COLORS.marbleShade,
      );
    }
  }

  update(_dt: number, _alpha: number, ctx: GameContext): void {
    this.sky?.update(ctx.camera, ctx.elapsed);
    this.water?.update(ctx.elapsed);

    // The shadow frustum follows the player, so its texels stay where they can
    // be seen. Snapped to a grid, or the whole map's shadows shimmer as it moves.
    if (this.sun && this.sunTarget) {
      const camera = ctx.camera.position;
      const snap = 2;
      const x = Math.round(camera.x / snap) * snap;
      const z = Math.round(camera.z / snap) * snap;
      this.sunTarget.position.set(x, 0, z);
      this.sun.position.set(
        x + SUN_DIRECTION.x * 190,
        SUN_DIRECTION.y * 190,
        z + SUN_DIRECTION.z * 190,
      );
    }
  }

  dispose(): void {
    this.terrain?.dispose();
    this.water?.dispose();
    this.backdrop?.dispose();
    this.props?.dispose();
    this.sky?.dispose();
    for (const geometry of this.geometries) geometry.dispose();
    for (const item of this.disposables) item.dispose();
    this.group.clear();
  }
}

/**
 * Where the wall has to be left open, worked out from the plan.
 *
 * A structure whose footprint straddles a wall line is a gate in that wall —
 * that is what being a gate means here — so the openings are derived rather than
 * listed. The margin either side stops the wall meeting the gate in a hairline
 * seam that z-fights.
 */
function wallGaps(): {
  north: Array<[number, number]>;
  south: Array<[number, number]>;
  east: Array<[number, number]>;
  west: Array<[number, number]>;
} {
  const gaps = {
    north: [] as Array<[number, number]>,
    south: [] as Array<[number, number]>,
    east: [] as Array<[number, number]>,
    west: [] as Array<[number, number]>,
  };
  const margin = 1.5;

  for (const s of STRUCTURES) {
    if (s.kind !== 'gate') continue;
    const x = planX(s.x);
    const z = planZ(s.z);
    const hw = planLength(s.w) / 2;
    const hd = planLength(s.d) / 2;

    if (crosses(z, hd, -WALL.halfZ)) gaps.north.push([x - hw - margin, x + hw + margin]);
    if (crosses(z, hd, WALL.halfZ)) gaps.south.push([x - hw - margin, x + hw + margin]);
    if (crosses(x, hw, -WALL.halfX)) gaps.west.push([z - hd - margin, z + hd + margin]);
    if (crosses(x, hw, WALL.halfX)) gaps.east.push([z - hd - margin, z + hd + margin]);
  }
  return gaps;
}

/**
 * True when a platform from the survey is part of the great terrace.
 *
 * Generous on purpose: these polygons trace the terrace's aprons, which run a
 * little past the terrace's own bounds, and half-covering it is worse than not
 * covering it at all.
 */
function onTheGreatTerrace(s: Structure): boolean {
  const z = planZ(s.z);
  const centerZ = (TERRACE.northZ + TERRACE.southZ) / 2;
  const halfZ = (TERRACE.southZ - TERRACE.northZ) / 2 + planLength(30);
  return Math.abs(planX(s.x)) < TERRACE.halfX + planLength(20)
    && Math.abs(z - centerZ) < halfZ;
}

/** True when a footprint centred at `c` with half-extent `h` spans `line`. */
function crosses(c: number, h: number, line: number): boolean {
  return c - h < line && c + h > line;
}

/** Re-exported for the tests, which assert the map is built where it says. */
export const CITY_BOUNDS = {
  interiorHalfX: INTERIOR.halfX,
  interiorHalfZ: INTERIOR.halfZ,
  groundHalfX: GROUND_HALF_X,
  groundHalfZ: GROUND_HALF_Z,
  moatInnerX: MOAT.innerX,
} as const;

/** Kept for the arena test, which needs to know what a structure looks like. */
export type { Structure };
