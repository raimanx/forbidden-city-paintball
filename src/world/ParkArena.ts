import {
  BoxGeometry,
  type BufferGeometry,
  DirectionalLight,
  Fog,
  Group,
  HemisphereLight,
  InstancedMesh,
  type Material,
  Matrix4,
  Mesh,
  Object3D,
  Quaternion,
  Vector3,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { palette } from '../core/Config';
import type { Rng } from '../core/Random';
import type { GameContext, System } from '../core/System';
import type { SurfaceRegistry } from '../paint/SurfaceRegistry';
import { createCelMaterial } from '../render/CelMaterial';
import { NO_OUTLINE_LAYER } from '../render/NprPipeline';
import { PLAQUE_ASPECT, createSignPlaqueTexture } from '../render/SignPlaque';
import { shadowMapSize } from '../render/Renderer';
import { Sky } from '../render/Sky';
import { Birds } from './Birds';
import { Cityscape } from './Cityscape';
import { Foliage, type TreeSpec } from './Foliage';
import { Fountain } from './Fountain';
import {
  ARCADE,
  BRIDGE,
  BRIDGE_APPROACH_Y,
  ISLAND,
  PARK_HALF,
  PLAZA,
  TERRACE,
  heightAt,
  lakeMask,
  meadowMask,
  plazaMask,
  rambleMask,
  walkMask,
  woodlandDensity,
} from './ParkLayout';
import { Terrain } from './Terrain';
import { TrunkLibrary, type Species } from './TreeGeometry';
import { Water } from './Water';

/**
 * Built from `BASE_URL` rather than written as a root-absolute path. The
 * deployment is a GitHub Pages project site under `/forbidden-city-paintball/`,
 * where a bare `/models/...` would miss the build entirely. `BASE_URL` always
 * carries a trailing slash.
 */
const MODEL_URL = `${import.meta.env.BASE_URL}models/park-props.glb`;

/** Mid-afternoon sun, low enough for long shadows down the Mall. */
const SUN_DIRECTION = new Vector3(0.42, 0.58, 0.36).normalize();

/**
 * Half-extent of the shadow camera, in metres.
 *
 * Fixed and player-centred rather than sized to the map. The arena used to fit
 * inside one shadow frustum; at 336m across it no longer does, and stretching
 * the frustum to cover the whole park would spread 2048 texels over 336m — six
 * per metre, which turns the ink-crisp shadow of a balustrade into a grey
 * smear. Following the player keeps the density at 23 texels per metre where
 * anyone can see it, and nothing outside 88m casts a shadow that reads anyway.
 */
const SHADOW_EXTENT = 88;

/** Perimeter wall: stone base plus railing. Enough that nobody jumps it. */
const WALL_HEIGHT = 3.4;

/**
 * The grand stairs, from the fountain plaza up to the terrace.
 *
 * They used to be placed on the plateau *south* of the terrace, climbing
 * northward down a slope that rises from 0.9m to 3.8m over the same ground: the
 * bottom flight was buried whole, the middle one half sunk, and the top one
 * stood in mid-air — three flights that led nowhere and could not be climbed.
 *
 * The real arrangement is the fix. Bethesda's stairs flank the arcade on the
 * *plaza* side and climb south onto the terrace, which is the one route the map
 * was missing: the terrace slab is a walkable roof 4.2m up, and until now the
 * only way onto it was to walk round to the plateau behind it.
 *
 * `stair_flight` is 8m wide and rises 1.68m over 2.58m of tread. Three of them
 * overshoot the terrace, so the prop is scaled to fit exactly rather than left
 * at 1:1 with a step at the top — see `placeStairs`.
 */
const STAIRS = {
  /** Distance either side of the centre line. Clear of the arcade bays. */
  x: 19,
  flights: 3,
  /** Prop dimensions at 1:1, from the GLB. */
  propRise: 1.68,
  propDepth: 2.58,
  propWidth: 8,
};

/**
 * Ground level at the foot of the stairs.
 *
 * The plaza paving is dead flat at y=0 but only out to a radius of 20m around
 * (0, 2); the stair foot at (±19, 9) is just outside it, on ground that
 * `heightAt` puts at -0.4 to -0.55. Taken as a constant rather than sampled per
 * side so both flights of stairs are identical, and set to the low end so the
 * bottom step is slightly buried rather than slightly floating.
 */
const STAIR_BASE_Y = -0.55;

/**
 * Approach ramps at both ends of Bow Bridge.
 *
 * The bridge's abutments are solid blocks with their tops 2.4m above its own
 * origin — 2.5m in world terms — while the ground the corridor levels for it
 * sits at 0.5m at the south end and dips to 1.0m at the north. Both ends were
 * therefore a two-metre wall you could see a bridge on top of and not get onto.
 * These are the stone embankments that carry the approach up to the deck.
 *
 * Each runs from `fromZ` to `toZ` and both must be written north to south —
 * `fromZ < toZ` — because the slab's pitch is solved with `atan2` and a run
 * given backwards comes out near pi, which turns the ramp upside down.
 */
const BRIDGE_RAMPS = [
  // North, into the Ramble, where the hillside already climbs to meet the deck
  // — this one is a causeway across the dip rather than a ramp.
  { fromZ: -48.2, fromY: 2.62, toZ: -45.0, toY: 2.5, thickness: 2.8 },
  // South, off the lakeside walk: 2.25m over 7.5m, about 17 degrees.
  { fromZ: -15.0, fromY: 2.5, toZ: -7.5, toY: 0.25, thickness: 2.4 },
] as const;
/** Ramp width, matching the bridge deck between its parapets. */
const BRIDGE_RAMP_WIDTH = 4.6;

/**
 * The dedication sign.
 *
 * On the plaza paving at its south-east rim, facing the fountain: the plaza is
 * where the round starts and where the sightlines cross, so a sign here is one
 * anyone will walk past, and standing off the axis between the spawn and the
 * fountain keeps it out of the opening shot of the map.
 *
 * The board is sized from the plaque's own proportions rather than by eye, so
 * the lettering is never stretched — see SignPlaque.
 */
const SIGN = {
  // Kept a few metres clear of the undercroft wall: the terrace throws a shadow
  // three metres out onto the paving all afternoon, and a lettered board read
  // in that band is a dark green rectangle.
  x: 10.5,
  z: 9.0,
  boardWidth: 2.4,
  postColor: 0x6d5a41,
  /** Matches the plaque's painted ground, so the lit board reads as one thing. */
  boardColor: 0x2c4636,
};

interface Placement {
  position: Vector3;
  rotationY: number;
  scale: number;
}

/** A tree, before it is split into trunk instance and canopy cards. */
interface TreePlan {
  x: number;
  z: number;
  /** Overall height in metres, from root flare to the top of the crown. */
  height: number;
  species: Species;
  canopyRadius: number;
  cards: number;
  hue: number;
  lightness: number;
  /** Woodland-belt trees use the cheap trunk build and cast no shadow. */
  far: boolean;
}

/**
 * The Central Park arena.
 *
 * Assembles the ground, the lake, the Blender prop set, the foliage, the
 * woodland belt and the city ring into a playable map, and registers every
 * collider with the paint system so anything you can shoot, you can paint.
 *
 * Props authored in Blender are placed here rather than baked into a single
 * scene file, so layout is data in one readable place and repeated props can be
 * instanced.
 */
export class ParkArenaSystem implements System {
  readonly name = 'park-arena';

  private terrain?: Terrain;
  private water?: Water;
  private fountain?: Fountain;
  private birds?: Birds;
  private foliage?: Foliage;
  private sky?: Sky;
  private city?: Cityscape;
  private readonly trunkLibraries: TrunkLibrary[] = [];
  private sun?: DirectionalLight;
  private sunTarget?: Object3D;

  private readonly disposables: Array<{ dispose(): void }> = [];
  private readonly group = new Group();

  /** Prop geometries keyed by their Blender object name. */
  private props = new Map<string, BufferGeometry>();

  constructor(private readonly surfaces: SurfaceRegistry) {}

  async init(ctx: GameContext): Promise<void> {
    const { scene, rng } = ctx;

    // Aerial perspective across a map this deep does most of the work of
    // separating the lawns from the treeline from the skyline. The near bound
    // sits beyond the play area so nothing you are actually fighting is hazed.
    scene.fog = new Fog(palette.fogNear, 110, 620);
    this.sky = new Sky(SUN_DIRECTION);
    scene.add(this.sky.mesh);
    this.addLights(ctx);

    this.terrain = new Terrain(ctx.physics);
    scene.add(this.terrain.mesh);
    this.surfaces.registerMesh(this.terrain.collider.handle, this.terrain.mesh);

    this.water = new Water();
    scene.add(this.water.mesh);

    this.city = new Cityscape(rng);
    scene.add(this.city.group);

    await this.loadProps(ctx);

    scene.add(this.group);
    // Gunfire puts the nearby birds up. Subscribed here rather than inside
    // Birds so the flock stays a piece of scenery with no idea a game is going
    // on around it.
    ctx.events.on('shot:fired', ({ origin }) => {
      this.birds?.scatter(origin.x, origin.z);
    });
    this.placeArchitecture(ctx);
    this.placeFurniture(ctx, rng);
    this.placeNature(ctx, rng);
    this.buildContainment(ctx);
  }

  private addLights(ctx: GameContext): void {
    // Warm key, cool fill — the pairing that produces warm light and
    // blue-violet shadow without any shader involvement.
    //
    // The sky colour is what every upward-facing surface gets in shadow, which
    // on a map that is mostly ground means it sets the colour of every shaded
    // lawn. Pushed a little off full saturation for that reason: at 0x8fb4e8
    // the shade under the allée came out blue-grey rather than deep green.
    // Lifted from 1.0 when the map grew a closed woodland canopy. Ambient is
    // the only light reaching ground under the allée and inside the belt, and
    // at 1.0 both read as near-black teal instead of the bright dappled green
    // every photograph of the Mall shows.
    const hemi = new HemisphereLight(0x9dc2e4, 0xc9ad84, 1.28);
    ctx.scene.add(hemi);

    const sun = new DirectionalLight(palette.sunWarm, 2.4);
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

    // A directional light points at its target, and the target has to be in the
    // scene for its world matrix to be updated. Moving the pair together each
    // frame is what lets the shadow frustum follow the player.
    this.sunTarget = new Object3D();
    ctx.scene.add(this.sunTarget);
    sun.target = this.sunTarget;
    sun.position.copy(SUN_DIRECTION).multiplyScalar(190);

    ctx.scene.add(sun);
    this.sun = sun;
    this.disposables.push(sun);
  }

  private async loadProps(ctx: GameContext): Promise<void> {
    const loader = new GLTFLoader();
    const gltf = await loader.loadAsync(MODEL_URL, (event) => {
      if (event.total > 0) {
        ctx.events.emit('load:progress', {
          phase: 'park',
          progress: 0.4 + 0.4 * (event.loaded / event.total),
        });
      }
    });

    gltf.scene.traverse((child) => {
      if ((child as Mesh).isMesh) {
        const mesh = child as Mesh;
        this.props.set(mesh.name, mesh.geometry);
      }
    });

    // `elm_trunk` is deliberately absent from this list. The asset is still in
    // the GLB but nothing places it any more: its limbs were built converging
    // toward the trunk axis as they rose, over a bole that flared toward the
    // crown, so every tree in the park stood on its head. Trunks are generated
    // now — see TreeGeometry.
    const missing = [
      'arcade_bay', 'balustrade', 'bethesda_fountain', 'bow_bridge',
      'lamp_post', 'park_bench', 'rock_0', 'rock_1', 'rock_2',
      'stair_flight',
    ].filter((n) => !this.props.has(n));
    if (missing.length > 0) {
      throw new Error(`ParkArena: prop set is missing ${missing.join(', ')}`);
    }
  }

  // --- individual props ----------------------------------------------------

  /**
   * Places a single prop as its own mesh, with a trimesh collider and paint
   * registration. Used for large landmarks, where one extra draw call is
   * nothing and per-surface paint matters.
   */
  private placeSingle(
    ctx: GameContext,
    propName: string,
    position: Vector3,
    rotationY = 0,
    color: number = palette.stoneLit,
    scale = 1,
  ): Mesh {
    const geometry = this.props.get(propName)!;
    const material = createCelMaterial({ color });
    const mesh = new Mesh(geometry, material);
    mesh.position.copy(position);
    mesh.rotation.y = rotationY;
    mesh.scale.setScalar(scale);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.group.add(mesh);
    this.disposables.push(material);

    const quaternion = new Quaternion().setFromAxisAngle(UP, rotationY);
    const collider = ctx.physics.createTrimeshAt(
      geometry.getAttribute('position').array as Float32Array,
      geometry.getIndex()!.array as Uint32Array,
      position,
      quaternion,
      scale,
    );
    this.surfaces.registerMesh(collider.handle, mesh);
    return mesh;
  }

  /**
   * Places many copies of one prop as a single instanced draw call, with a
   * collider and per-instance paint registration for each.
   */
  private placeInstanced(
    ctx: GameContext,
    propName: string,
    placements: Placement[],
    color: number,
  ): void {
    if (placements.length === 0) return;
    const geometry = this.props.get(propName)!;
    const material = createCelMaterial({ color });
    const mesh = new InstancedMesh(geometry, material, placements.length);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.group.add(mesh);
    this.disposables.push(material);

    const positions = geometry.getAttribute('position').array as Float32Array;
    const indices = geometry.getIndex()!.array as Uint32Array;
    const matrix = new Matrix4();
    const quaternion = new Quaternion();
    const scaleVec = new Vector3();

    placements.forEach((placement, i) => {
      quaternion.setFromAxisAngle(UP, placement.rotationY);
      scaleVec.setScalar(placement.scale);
      matrix.compose(placement.position, quaternion, scaleVec);
      mesh.setMatrixAt(i, matrix);

      const collider = ctx.physics.createTrimeshAt(
        positions,
        indices,
        placement.position,
        quaternion,
        placement.scale,
      );
      // Per-instance matrix, so a decal lands on the copy that was actually hit.
      this.surfaces.registerInstance(collider.handle, geometry, matrix);
    });

    mesh.instanceMatrix.needsUpdate = true;
  }

  /**
   * A plain box with matching collider — used for slabs, walls and ramps.
   *
   * `pitch` tilts it about X, which is all a ramp needs and keeps the collider
   * exactly the thing that was drawn: a sloped surface built from stacked
   * axis-aligned boxes would be a staircase you could catch a toe on.
   */
  private placeBox(
    ctx: GameContext,
    size: Vector3,
    position: Vector3,
    color: number,
    paintable = true,
    pitch = 0,
  ): Mesh {
    const geometry = new BoxGeometry(size.x, size.y, size.z);
    const material = createCelMaterial({ color });
    const mesh = new Mesh(geometry, material);
    mesh.position.copy(position);
    mesh.rotation.x = pitch;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.group.add(mesh);
    this.disposables.push(geometry, material);

    const collider = ctx.physics.createStaticBox(
      position,
      { x: size.x / 2, y: size.y / 2, z: size.z / 2 },
      pitch === 0 ? undefined : new Quaternion().setFromAxisAngle(RIGHT, pitch),
    );
    if (paintable) this.surfaces.registerMesh(collider.handle, mesh);
    return mesh;
  }

  // --- layout --------------------------------------------------------------

  private placeArchitecture(ctx: GameContext): void {
    // Upper terrace slab — a walkable roof over the arcade undercroft.
    const slabZ = (TERRACE.northZ + TERRACE.southZ) / 2;
    const slabDepth = TERRACE.southZ - TERRACE.northZ;
    this.placeBox(
      ctx,
      new Vector3(TERRACE.halfWidth * 2, TERRACE.slabThickness, slabDepth),
      new Vector3(0, TERRACE.y - TERRACE.slabThickness / 2, slabZ),
      palette.stoneLit,
    );

    // Arcade colonnade across the undercroft's north face.
    const half = ((ARCADE.bays - 1) * ARCADE.bayWidth) / 2;
    for (let i = 0; i < ARCADE.bays; i++) {
      const x = -half + i * ARCADE.bayWidth;
      this.placeSingle(ctx, 'arcade_bay', new Vector3(x, 0, ARCADE.z), 0, palette.stoneLit);
    }

    // Side walls closing the undercroft, either side of the colonnade — in two
    // segments, because the grand stairs now land on the terrace between them.
    // The gap is not a hole: the top flight fills it from the plaza floor to
    // the slab.
    const stairGap = this.stairFootprint();
    for (const side of [-1, 1]) {
      const innerX = half + ARCADE.bayWidth / 2 + 0.6;
      const outerX = TERRACE.halfWidth;
      for (const [from, to] of [
        [innerX, stairGap.from],
        [stairGap.to, outerX],
      ] as const) {
        if (to - from < 0.4) continue;
        this.placeBox(
          ctx,
          new Vector3(to - from, TERRACE.y, 1.2),
          new Vector3((side * (from + to)) / 2, TERRACE.y / 2, ARCADE.z),
          palette.stoneShade,
        );
      }
    }

    this.placeStairs(ctx);

    // Balustrade along the terrace's north edge, with a gap over the arcade so
    // the view down to the fountain stays open, and another at each stair head.
    const balustrades: Placement[] = [];
    for (let x = -TERRACE.halfWidth + 1; x < TERRACE.halfWidth; x += 2) {
      if (Math.abs(x) < half + ARCADE.bayWidth / 2) continue;
      if (Math.abs(x) > stairGap.from - 1 && Math.abs(x) < stairGap.to + 1) continue;
      balustrades.push({
        position: new Vector3(x, TERRACE.y, TERRACE.northZ + 0.4),
        rotationY: 0,
        scale: 1,
      });
    }
    this.placeShoreRailing(balustrades);
    this.placeInstanced(ctx, 'balustrade', balustrades, palette.stoneLit);

    // Bethesda Fountain, at the origin.
    this.placeSingle(ctx, 'bethesda_fountain', new Vector3(0, 0, 0), 0, 0xc8bda4);
    this.fountain = new Fountain();
    ctx.scene.add(this.fountain.group);

    // Bow Bridge, rotated a quarter turn so its span runs north-south across
    // the lake's western arm.
    this.placeSingle(
      ctx,
      'bow_bridge',
      new Vector3(BRIDGE.x, BRIDGE_APPROACH_Y - 0.4, BRIDGE.z),
      Math.PI / 2,
      0xd9cfba,
    );
    for (const ramp of BRIDGE_RAMPS) {
      // A ramp is one tilted slab: the top face is the walking surface, and the
      // slab is thick enough that its low end buries itself in the bank rather
      // than leaving a lip to trip over.
      const run = ramp.toZ - ramp.fromZ;
      const rise = ramp.toY - ramp.fromY;
      const pitch = -Math.atan2(rise, run);
      const normalY = Math.cos(pitch);
      const normalZ = Math.sin(pitch);
      this.placeBox(
        ctx,
        new Vector3(BRIDGE_RAMP_WIDTH, ramp.thickness, Math.hypot(run, rise)),
        new Vector3(
          BRIDGE.x,
          (ramp.fromY + ramp.toY) / 2 - (normalY * ramp.thickness) / 2,
          (ramp.fromZ + ramp.toZ) / 2 - (normalZ * ramp.thickness) / 2,
        ),
        0xd9cfba,
        true,
        pitch,
      );
    }
  }

  /** The x band the stairs occupy on each side, as positive distances. */
  private stairFootprint(): { from: number; to: number } {
    const scale = this.stairScale();
    const halfWidth = (STAIRS.propWidth * scale) / 2;
    return { from: STAIRS.x - halfWidth - 0.2, to: STAIRS.x + halfWidth + 0.2 };
  }

  /**
   * Scale that makes `STAIRS.flights` flights climb exactly from the plaza to
   * the terrace slab, so neither end needs a step to finish the job.
   */
  private stairScale(): number {
    const rise = TERRACE.y - STAIR_BASE_Y;
    return rise / (STAIRS.flights * STAIRS.propRise);
  }

  /**
   * The grand stairs: three flights a side, plus the solid mass beneath them.
   *
   * The vault matters. A flight is a stepped solid from its own base upward, so
   * flights two and three would otherwise float over an open void with the
   * undercroft visible through it — the stairs read as a stone mass from the
   * plaza, and a stone mass is what stops shots as well.
   */
  private placeStairs(ctx: GameContext): void {
    const scale = this.stairScale();
    const rise = STAIRS.propRise * scale;
    const depth = STAIRS.propDepth * scale;
    const width = STAIRS.propWidth * scale;
    // Local +Z is the top of the flight, so no rotation: they climb south.
    const topEdge = (STAIRS.propDepth / 2) * scale;

    for (const side of [-1, 1]) {
      for (let flight = 0; flight < STAIRS.flights; flight++) {
        const z = TERRACE.northZ - topEdge - (STAIRS.flights - 1 - flight) * depth;
        const y = STAIR_BASE_Y + flight * rise;
        this.placeSingle(
          ctx,
          'stair_flight',
          new Vector3(side * STAIRS.x, y, z),
          0,
          palette.stoneLit,
          scale,
        );
        if (flight === 0) continue;
        // Fill from below the ground up to this flight's own base.
        const vaultTop = y;
        const vaultBottom = STAIR_BASE_Y - 1.2;
        this.placeBox(
          ctx,
          new Vector3(width, vaultTop - vaultBottom, depth),
          new Vector3(side * STAIRS.x, (vaultTop + vaultBottom) / 2, z),
          palette.stoneShade,
        );
      }
    }
  }

  /**
   * The railing along the plaza's lakeside edge.
   *
   * Placed by walking the actual waterline rather than by sweeping an arc of
   * fixed radius, which is what put a run of balustrade 25m out into the lake,
   * standing on the bed 3.4m under the surface. The shoreline here is a noise
   * -wobbled ellipse whose radius from the plaza varies between 12m and 20m
   * over the same sweep, so no single radius can follow it.
   */
  private placeShoreRailing(into: Placement[]): void {
    const points: Array<{ x: number; z: number }> = [];
    for (let a = -1.2; a <= 1.2; a += 0.03) {
      let radius = 21;
      for (let r = 8; r <= 24; r += 0.25) {
        if (lakeMask(Math.sin(a) * r, -Math.cos(a) * r - 4) > 0.03) {
          radius = r;
          break;
        }
      }
      // Stood back from the water so the railing is on the bank, not in it.
      radius = Math.max(8, radius - 1.1);
      points.push({ x: Math.sin(a) * radius, z: -Math.cos(a) * radius - 4 });
    }

    // Then step along that polyline at the prop's own width, so the run is
    // evenly spaced whatever the shoreline does.
    const SPAN = 2;
    let carried = 0;
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i]!;
      const b = points[i + 1]!;
      const length = Math.hypot(b.x - a.x, b.z - a.z);
      carried += length;
      if (carried < SPAN) continue;
      carried = 0;
      const x = (a.x + b.x) / 2;
      const z = (a.z + b.z) / 2;
      into.push({
        position: new Vector3(x, heightAt(x, z), z),
        // The prop runs along its own X, and +X swings toward -Z as yaw rises.
        rotationY: Math.atan2(-(b.z - a.z), b.x - a.x),
        scale: 1,
      });
    }
  }

  /**
   * Whether a piece of park furniture may stand here.
   *
   * Benches and lamps were laid out on rings and polylines with no knowledge of
   * the buildings those rings pass through, so the plaza ring put two benches
   * inside the arcade's side walls and two lamp posts under the terrace slab —
   * a 4.7m post in a 3.5m undercroft. The rings are still the right way to lay
   * furniture out; they just have to be told what is already there.
   *
   * Read as "is this square metre free", not "is this a good spot": tree
   * planting has its own predicate with its own rules, and merging the two
   * would give the benches a horror of Sheep Meadow.
   */
  private isClearForFurniture(x: number, z: number): boolean {
    // Not in the water, and not out on the lake bed pretending to be.
    if (lakeMask(x, z) > 0.05) return false;
    // Not inside the fountain basin, which is 6m across at the rim.
    if (Math.hypot(x, z) < 7.5) return false;
    // Not under the terrace, on it, or inside the arcade's colonnade.
    if (Math.abs(x) < TERRACE.halfWidth + 1.5 && z > ARCADE.z - 2.5 && z < TERRACE.southZ + 2) {
      return false;
    }
    // Not on the grand stairs or the ground they climb from.
    const stairs = this.stairFootprint();
    if (Math.abs(x) > stairs.from - 1 && Math.abs(x) < stairs.to + 1 && z > 7 && z < ARCADE.z) {
      return false;
    }
    // Not on the sign, which is its own three colliders on the paving.
    if (Math.hypot(x - SIGN.x, z - SIGN.z) < 2.2) return false;
    return true;
  }

  private placeFurniture(ctx: GameContext, rng: Rng): void {
    const benches: Placement[] = [];
    const lamps: Placement[] = [];
    const bench = (x: number, z: number, rotationY: number): void => {
      if (!this.isClearForFurniture(x, z)) return;
      benches.push({ position: new Vector3(x, heightAt(x, z), z), rotationY, scale: 1 });
    };
    const lamp = (x: number, z: number): void => {
      if (!this.isClearForFurniture(x, z)) return;
      lamps.push({ position: new Vector3(x, heightAt(x, z), z), rotationY: 0, scale: 1 });
    };

    // Down both sides of the Mall, facing the path.
    for (let z = 30; z <= 82; z += 7) {
      for (const side of [-1, 1]) {
        bench(side * 8.5, z, side > 0 ? -Math.PI / 2 : Math.PI / 2);
      }
      lamp(-15, z);
      lamp(15, z);
    }

    // Around the plaza rim, looking in at the fountain.
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + 0.4;
      const r = 16;
      bench(Math.cos(a) * r, Math.sin(a) * r + 2, -a + Math.PI / 2);
      lamp(Math.cos(a) * 20, Math.sin(a) * 20 + 2);
    }

    // Benches along the made walks, facing whatever the walk looks out at.
    for (const [x, z] of [
      [-14, -14], [18, -16], [-52, -14], [30, -13], [-30, 26], [-28, 46],
      [36, 30], [36, 52], [-64, 30], [-70, 52], [-46, 74], [8, -76],
    ] as const) {
      bench(x, z, Math.atan2(x, z) + Math.PI);
    }

    // Lamps down the made walks. The park's cast-iron posts are its other
    // signature after the benches, and a walk without them reads as a dirt
    // track rather than something maintained.
    for (const [x, z] of [
      [-24, 10], [-30, 28], [-27, 44], [-32, 62], [-41, 74],
      [26, 12], [36, 28], [38, 46], [35, 62], [42, 78],
      [12, -15], [-16, -16], [-36, -16], [-44, -22], [-44, -40],
    ] as const) {
      lamp(x, z);
    }

    void rng;
    this.placeInstanced(ctx, 'park_bench', benches, 0x7d6a4f);
    this.placeInstanced(ctx, 'lamp_post', lamps, 0x3c3b46);
    this.placeSign(ctx);
  }

  /**
   * The park's dedication sign: a lettered board on two posts.
   *
   * Built from boxes here rather than added to the Blender prop set, because
   * the only thing that makes it a sign is the plaque texture, and that is
   * generated (SignPlaque). A modelled board would be the same three boxes with
   * a download attached.
   *
   * Both posts and board are ordinary colliders registered for paint, so the
   * sign stops a paintball, blocks a bot, and takes a splat like anything else
   * in the park — being the credits doesn't make it scenery.
   */
  private placeSign(ctx: GameContext): void {
    const base = new Vector3(SIGN.x, heightAt(SIGN.x, SIGN.z), SIGN.z);
    // Turned to face the fountain, which is what anyone standing in front of
    // the sign is looking past it at.
    const rotationY = Math.atan2(PLAZA.x - SIGN.x, PLAZA.z - SIGN.z);
    const quaternion = new Quaternion().setFromAxisAngle(UP, rotationY);

    const plaque = createSignPlaqueTexture();
    const boardMaterial = createCelMaterial({ color: SIGN.boardColor });
    const postMaterial = createCelMaterial({ color: SIGN.postColor });
    // White base colour: the plaque already carries every colour on the board,
    // and toon shading multiplies the two.
    const faceMaterial = createCelMaterial({ color: 0xffffff });
    faceMaterial.map = plaque;
    this.disposables.push(plaque, boardMaterial, postMaterial, faceMaterial);

    const place = (
      size: Vector3,
      local: Vector3,
      material: Material | Material[],
    ): void => {
      const geometry = new BoxGeometry(size.x, size.y, size.z);
      const mesh = new Mesh(geometry, material);
      mesh.position.copy(local).applyAxisAngle(UP, rotationY).add(base);
      mesh.rotation.y = rotationY;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.group.add(mesh);
      this.disposables.push(geometry);

      const collider = ctx.physics.createStaticBox(
        mesh.position,
        { x: size.x / 2, y: size.y / 2, z: size.z / 2 },
        quaternion,
      );
      this.surfaces.registerMesh(collider.handle, mesh);
    };

    const boardHeight = SIGN.boardWidth / PLAQUE_ASPECT;
    // Board top at 2.22m: above head height, so it reads over a crowd, and low
    // enough that the small print is legible from in front of it.
    const boardY = 2.22 - boardHeight / 2;

    // Posts run past the board top and 0.2m into the ground, so neither end
    // floats when the paving isn't perfectly level.
    for (const side of [-1, 1]) {
      place(
        new Vector3(0.14, 2.5, 0.14),
        new Vector3(side * (SIGN.boardWidth / 2 - 0.3), 1.05, -0.09),
        postMaterial,
      );
    }

    // BoxGeometry groups run +X, -X, +Y, -Y, +Z, -Z. Only the +Z face is
    // lettered; the rest is painted board.
    place(
      new Vector3(SIGN.boardWidth, boardHeight, 0.12),
      new Vector3(0, boardY, 0),
      [boardMaterial, boardMaterial, boardMaterial, boardMaterial, faceMaterial, boardMaterial],
    );
  }

  // --- trees ---------------------------------------------------------------

  /**
   * Whether a tree may stand here.
   *
   * One predicate rather than a condition repeated at every scatter site: they
   * all want the same thing (not in the water, not on the paving, not across a
   * walk), and the previous per-site copies had already drifted apart.
   */
  private canPlant(x: number, z: number): boolean {
    if (lakeMask(x, z) > 0.05) return false;
    if (plazaMask(x, z) > 0.05) return false;
    if (walkMask(x, z) > 0.15) return false;
    // Sheep Meadow is kept clear on purpose: it is the map's one long sightline.
    if (meadowMask(x, z) > 0.35) return false;
    // Keep clear of the terrace — a canopy planted at ground level beside it
    // engulfs anyone standing on the slab 4.2m up.
    if (Math.abs(x) < TERRACE.halfWidth + 6 && z > TERRACE.northZ - 8 && z < TERRACE.southZ + 8) {
      return false;
    }
    return true;
  }

  private placeNature(ctx: GameContext, rng: Rng): void {
    const plans: TreePlan[] = [];
    const rocks: Placement[][] = [[], [], []];

    const plant = (
      x: number,
      z: number,
      height: number,
      species: Species,
      cards = 9,
      far = false,
    ): void => {
      if (!this.canPlant(x, z)) return;
      plans.push({
        x,
        z,
        height,
        species,
        far,
        // Crown radius tracks height, and has to reach *past* where the limbs
        // end. Sized to the branch structure rather than picked by eye: an
        // undersized crown leaves the twigs sticking out through the leaves,
        // and because every twig is thin enough to be almost entirely ink, the
        // tree reads as a dead thicket with a few green blobs stuck to it.
        //
        // Scrub gets the widest ratio of the three. It is short, so a crown
        // proportional to its height is small in absolute terms, and with only
        // four cards a small crown leaves a bare Y of branches standing in the
        // understorey — the belt read as a plantation of dead sticks.
        canopyRadius: height * (species === 'elm' ? 0.52 : species === 'oak' ? 0.66 : 0.78),
        cards,
        // Mixed greens across the stand. Photographs of the park in leaf carry
        // yellow-greens, blue-greens and the odd copper together in one line.
        hue: rng.spread(0.045),
        lightness: rng.spread(0.07),
      });
    };

    // The Mall's elm allée: two formal rows, the park's most photographed line,
    // running the full length of the extended Mall.
    //
    // Set out at 12.5m from the centreline rather than 10.5. Crowns are 9-10m
    // across, so the narrower spacing closed the vault completely and left the
    // whole path in unbroken shade — flat, near-black teal, and nothing like
    // the photographs, which are all about dappled light on the walk. At 12.5
    // the canopies still meet overhead but leave a gap down the middle.
    for (let z = 29; z <= 84; z += 5.2) {
      for (const side of [-1, 1]) {
        plant(side * 12.5 + rng.spread(0.6), z + rng.spread(0.8), rng.range(16, 20), 'elm');
      }
    }

    // The Ramble: dense, irregular, wooded, on the rough ground north of the
    // Lake. The park's cover maze.
    for (let i = 0; i < 150; i++) {
      const x = rng.range(-88, 60);
      const z = rng.range(-92, -50);
      if (rambleMask(x, z) < 0.3) continue;
      plant(x, z, rng.range(8, 15), rng.bool(0.45) ? 'oak' : 'scrub');
    }

    // The Lake's island, thick with trees — visible from the whole south shore
    // and reachable by nobody, which is exactly its job as a backdrop.
    for (let i = 0; i < 14; i++) {
      const a = rng.range(0, Math.PI * 2);
      const r = rng.range(0, ISLAND.radius * 0.7);
      plant(ISLAND.x + Math.cos(a) * r, ISLAND.z + Math.sin(a) * r, rng.range(9, 14), 'oak');
    }

    // Eastern woods along the wooded rise.
    for (let i = 0; i < 90; i++) {
      const x = rng.range(30, 88);
      const z = rng.range(-88, 88);
      plant(x, z, rng.range(10, 17), rng.bool(0.5) ? 'oak' : 'elm');
    }

    // Specimens scattered on the lawns, and the belt of trees that frames
    // Sheep Meadow without standing in it.
    for (let i = 0; i < 110; i++) {
      const x = rng.range(-88, 40);
      const z = rng.range(-40, 88);
      if (Math.abs(x) < 13 && z > 24) continue; // keep the allée clear
      plant(x, z, rng.range(11, 18), rng.bool(0.4) ? 'elm' : 'oak');
    }

    this.scatterWoodland(rng, plant);

    // Ramble outcrops, plus a few boulders on the shoreline. Manhattan schist
    // breaking through is the one geological fact the park cannot hide.
    for (let i = 0; i < 46; i++) {
      const x = rng.range(-88, 50);
      const z = rng.range(-92, -40);
      if (rambleMask(x, z) < 0.3 || lakeMask(x, z) > 0.2) continue;
      const variant = rng.int(0, 3);
      rocks[variant]!.push({
        position: new Vector3(x, heightAt(x, z) - 0.4, z),
        rotationY: rng.range(0, Math.PI * 2),
        scale: rng.range(0.5, 1.05),
      });
    }
    for (let v = 0; v < 3; v++) {
      this.placeInstanced(ctx, `rock_${v}`, rocks[v]!, 0x9a927f);
    }

    this.buildTrees(ctx, plans, rng);
  }

  /**
   * The woodland belt beyond the play area.
   *
   * Density is driven by noise rather than being uniform, which is what
   * produces glades: a forest at constant spacing reads as an orchard, and an
   * orchard you can see through is not somewhere anyone wants to explore. The
   * clearings are also the only thing that makes the belt navigable on foot.
   */
  private scatterWoodland(
    rng: Rng,
    plant: (
      x: number, z: number, height: number, species: Species, cards?: number, far?: boolean,
    ) => void,
  ): void {
    // Sampled on a jittered lattice rather than by rejection over the whole
    // square: the belt is a ring, and uniform rejection sampling would throw
    // away the 30% of every draw that lands in the play area.
    const STEP = 8.4;
    for (let x = -PARK_HALF + 6; x < PARK_HALF - 6; x += STEP) {
      for (let z = -PARK_HALF + 6; z < PARK_HALF - 6; z += STEP) {
        const px = x + rng.spread(STEP * 0.48);
        const pz = z + rng.spread(STEP * 0.48);
        if (rng.next() > woodlandDensity(px, pz)) continue;

        // Understorey scrub is much more common than canopy trees, and it is
        // what makes the belt feel thick at eye height rather than at 15m.
        const species: Species = rng.bool(0.42) ? 'scrub' : rng.bool(0.5) ? 'oak' : 'elm';
        const height = species === 'scrub' ? rng.range(4.5, 8) : rng.range(11, 19);
        // Five cards, not nine. At belt distances a crown needs a silhouette,
        // not a volume, and the belt holds more trees than the park does.
        plant(px, pz, height, species, species === 'scrub' ? 4 : 5, true);
      }
    }
  }

  /**
   * Turns tree plans into geometry: one instanced draw call per trunk variant,
   * one cylinder collider each, and every crown handed to the foliage batch.
   */
  private buildTrees(ctx: GameContext, plans: TreePlan[], rng: Rng): void {
    // Two libraries, two budgets. See TreeGeometry's Detail comment.
    const near = new TrunkLibrary(0x7ee5, 'near', 4);
    const far = new TrunkLibrary(0x1eaf, 'far', 3);
    this.trunkLibraries.push(near, far);

    /** Instances keyed by `${far ? 'f' : 'n'}:${variant}`. */
    const byVariant = new Map<string, Array<{ matrix: Matrix4; plan: TreePlan }>>();
    const canopies: TreeSpec[] = [];

    const variantsBySpecies = new Map<string, number[]>();
    for (const library of [near, far]) {
      for (const species of ['elm', 'oak', 'scrub'] as const) {
        variantsBySpecies.set(
          `${library === far ? 'f' : 'n'}:${species}`,
          library.indicesOf(species),
        );
      }
    }

    const matrix = new Matrix4();
    const position = new Vector3();
    const quaternion = new Quaternion();
    const scale = new Vector3();

    for (const plan of plans) {
      const prefix = plan.far ? 'f' : 'n';
      const options = variantsBySpecies.get(`${prefix}:${plan.species}`)!;
      const variant = options[rng.int(0, options.length)]!;
      const y = heightAt(plan.x, plan.z);

      position.set(plan.x, y, plan.z);
      quaternion.setFromAxisAngle(UP, rng.range(0, Math.PI * 2));
      scale.setScalar(plan.height);
      matrix.compose(position, quaternion, scale);

      const key = `${prefix}:${variant}`;
      let bucket = byVariant.get(key);
      if (!bucket) byVariant.set(key, (bucket = []));
      bucket.push({ matrix: matrix.clone(), plan });

      canopies.push({
        position: new Vector3(plan.x, y, plan.z),
        radius: plan.canopyRadius,
        // The crown sits over the crotch, not over the ground: high enough to
        // clear a player's head, low enough that the limbs disappear into it.
        crownHeight: plan.height * (plan.species === 'elm' ? 0.8 : plan.species === 'oak' ? 0.66 : 0.58),
        kind: plan.species === 'elm' ? 0 : 1,
        cards: plan.cards,
        hue: plan.hue,
        lightness: plan.lightness,
      });
    }

    for (const [key, instances] of byVariant) {
      const isFar = key.startsWith('f:');
      const library = isFar ? far : near;
      const { geometry, baseRadius } = library.variants[Number(key.slice(2))]!;
      const material = createCelMaterial({ color: 0xffffff });
      material.vertexColors = true;
      const mesh = new InstancedMesh(geometry, material, instances.length);
      // Belt trunks neither cast shadows nor take an ink line. Both passes are
      // whole extra draws of a thousand trees, and neither is legible past the
      // treeline: the canopy above already lays a shadow on the forest floor,
      // and the crowns themselves carry no outline either (see Foliage).
      mesh.castShadow = !isFar;
      mesh.receiveShadow = true;
      if (isFar) mesh.layers.set(NO_OUTLINE_LAYER);
      mesh.frustumCulled = false;
      this.group.add(mesh);
      this.disposables.push(material);

      instances.forEach(({ matrix: m, plan }, i) => {
        mesh.setMatrixAt(i, m);

        // Collision as a single upright cylinder over the bole. Sized a little
        // over the modelled radius: a trunk you can clip the corner of is worse
        // than one that stops you slightly early.
        const radius = Math.max(0.22, plan.height * baseRadius * 1.15);
        const halfHeight = plan.height * 0.32;
        const collider = ctx.physics.createStaticCylinder(
          { x: plan.x, y: heightAt(plan.x, plan.z) + halfHeight, z: plan.z },
          halfHeight,
          radius,
        );
        this.surfaces.registerInstance(collider.handle, geometry, m);
      });

      mesh.instanceMatrix.needsUpdate = true;
    }

    // Hedges along the perimeter wall, so it reads as an overgrown park edge
    // rather than as the side of an arena.
    for (let along = -PARK_HALF + 4; along <= PARK_HALF - 4; along += 4.2) {
      for (const [hx, hz] of [
        [along, -PARK_HALF + 4.5],
        [along, PARK_HALF - 4.5],
        [-PARK_HALF + 4.5, along],
        [PARK_HALF - 4.5, along],
      ] as const) {
        canopies.push({
          position: new Vector3(hx, heightAt(hx, hz), hz),
          radius: rng.range(2.6, 3.8),
          crownHeight: rng.range(3.0, 4.4),
          kind: 1,
          cards: 4,
          hue: rng.spread(0.03),
          lightness: rng.spread(0.05),
        });
      }
    }

    this.foliage = new Foliage(canopies, rng);
    ctx.scene.add(this.foliage.mesh);

    // Birds perch in the crowns, so they are placed from the same list the
    // canopies are built from — a bird sitting in mid-air where a tree used to
    // be is the one failure mode worth designing out.
    //
    // Only trees inside the play area: the belt is a backdrop, and a bird that
    // flits between two trees 150m away is a pixel nobody will ever see moving.
    const perches = plans
      .filter((plan) => !plan.far && Math.hypot(plan.x, plan.z) < 96)
      .map((plan) => ({
        // The crown's own centre, which is where the canopy cards are hung —
        // see the `crownHeight` given to `TreeSpec` a few lines above. Birds
        // are placed from the same numbers so one can never sit in the air
        // where a tree used to be.
        point: new Vector3(
          plan.x,
          heightAt(plan.x, plan.z)
            + plan.height * (plan.species === 'elm' ? 0.8 : plan.species === 'oak' ? 0.66 : 0.58),
          plan.z,
        ),
        radius: plan.canopyRadius,
      }));
    this.birds = new Birds(perches, rng);
    ctx.scene.add(this.birds.mesh);
  }

  /**
   * Perimeter containment.
   *
   * A low stone retaining wall carrying an iron railing, standing on the park's
   * perimeter shelf — which is what the real park's boundary is, and reads as a
   * boundary you are looking *over* rather than a lid you are under. Flat and
   * vertical, deliberately: phase 1 established that the character capsule can
   * roll over ledges above the autostep height depending on approach angle, so
   * terrain is not a reliable boundary and only a wall blocks every time.
   *
   * 3.4m is comfortably beyond a 1.15m jump, so nothing here is an invisible
   * barrier — the collider is exactly as tall as the thing you can see.
   */
  private buildContainment(ctx: GameContext): void {
    const edge = PARK_HALF - 2;
    const span = edge * 2 + 4;
    const base = heightAt(edge, 0);

    for (const [sx, sz] of [[0, -1], [0, 1], [-1, 0], [1, 0]] as const) {
      const horizontal = sz !== 0;
      const size = horizontal
        ? new Vector3(span, WALL_HEIGHT, 1.6)
        : new Vector3(1.6, WALL_HEIGHT, span);
      const position = new Vector3(sx * edge, base + WALL_HEIGHT / 2 - 1.2, sz * edge);
      this.placeBox(ctx, size, position, 0xaea48d);
    }
  }

  update(dt: number, _alpha: number, ctx: GameContext): void {
    this.sky?.update(ctx.camera, ctx.elapsed);
    this.water?.update(ctx.elapsed);
    this.fountain?.update(ctx.elapsed);
    this.foliage?.update(ctx.elapsed);
    this.birds?.update(dt, ctx.elapsed);

    // Keep the shadow frustum over the player. Snapped to whole metres, because
    // sliding it continuously makes every shadow edge crawl as you walk.
    if (this.sun && this.sunTarget) {
      const focusX = Math.round(ctx.camera.position.x);
      const focusZ = Math.round(ctx.camera.position.z);
      this.sunTarget.position.set(focusX, 0, focusZ);
      this.sun.position.set(
        focusX + SUN_DIRECTION.x * 190,
        SUN_DIRECTION.y * 190,
        focusZ + SUN_DIRECTION.z * 190,
      );
    }
  }

  dispose(): void {
    this.group.removeFromParent();
    this.terrain?.mesh.removeFromParent();
    this.terrain?.dispose();
    this.water?.mesh.removeFromParent();
    this.water?.dispose();
    this.fountain?.group.removeFromParent();
    this.fountain?.dispose();
    this.birds?.mesh.removeFromParent();
    this.birds?.dispose();
    this.foliage?.mesh.removeFromParent();
    this.foliage?.dispose();
    this.sky?.mesh.removeFromParent();
    this.sky?.dispose();
    this.city?.dispose();
    for (const library of this.trunkLibraries) library.dispose();
    this.sunTarget?.removeFromParent();
    for (const item of this.disposables) item.dispose();
  }
}

const UP = new Vector3(0, 1, 0);
const RIGHT = new Vector3(1, 0, 0);
