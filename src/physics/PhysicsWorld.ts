import type * as RapierNS from '@dimforge/rapier3d';
import type { Vector3 } from 'three';
import { DEG2RAD } from '../core/MathUtils';
import { physics as physicsConfig, player as playerConfig } from '../core/Config';

export type Rapier = typeof RapierNS;

export interface RaycastHit {
  point: { x: number; y: number; z: number };
  normal: { x: number; y: number; z: number };
  distance: number;
  collider: RapierNS.Collider;
}

/**
 * Wraps the Rapier world.
 *
 * Rapier's WebAssembly is the single largest thing this game loads. It is
 * imported dynamically so the shell can paint and the loading card can show
 * before it arrives.
 *
 * This uses the non-compat package deliberately. `rapier3d-compat` embeds the
 * same wasm as base64 inside a JS module, which gzips to 842 KB against 570 KB
 * for the raw binary — base64 wastes a third of its bytes and compresses
 * poorly on top of that. The real `.wasm` also goes through the browser's
 * streaming compiler rather than being decoded from a string at runtime.
 */
export class PhysicsWorld {
  private rapier?: Rapier;
  private world?: RapierNS.World;

  async init(onProgress?: (progress: number) => void): Promise<void> {
    onProgress?.(0);
    // No explicit init() call: the non-compat package instantiates its wasm as
    // part of the module's own top-level await.
    const RAPIER = await import('@dimforge/rapier3d');
    onProgress?.(0.6);
    this.rapier = RAPIER;
    this.world = new RAPIER.World({ x: 0, y: physicsConfig.gravity, z: 0 });
    onProgress?.(1);
  }

  /** Throws if called before init resolves. */
  get api(): Rapier {
    if (!this.rapier) throw new Error('PhysicsWorld: init() has not completed');
    return this.rapier;
  }

  get w(): RapierNS.World {
    if (!this.world) throw new Error('PhysicsWorld: init() has not completed');
    return this.world;
  }

  get isReady(): boolean {
    return this.world !== undefined;
  }

  /**
   * Steps the simulation. The caller drives this from the fixed-timestep loop,
   * so `dt` is always FIXED_DT and the simulation stays deterministic.
   */
  step(dt: number): void {
    const world = this.w;
    world.timestep = dt;
    world.step();
  }

  /**
   * Brings spatial queries up to date with colliders created since the last
   * step.
   *
   * Rapier's scene queries — raycasts, shape casts, intersection tests — run
   * against acceleration structures that are only rebuilt inside `step()`. A
   * collider created after the last step is therefore invisible to every query
   * until the next one. That is silent and easy to miss: the navgrid built
   * during init saw an *empty world*, marked the entire park walkable, and bots
   * happily pathed through the fountain.
   *
   * Anything that queries the world before the loop starts must call this first.
   */
  refreshQueries(): void {
    const previous = this.w.timestep;
    // A negligible timestep: we want the query structures rebuilt, not the
    // simulation advanced.
    this.w.timestep = 1e-6;
    this.w.step();
    this.w.timestep = previous;
  }

  /** Static trimesh collider, used for terrain and baked map geometry. */
  createTrimesh(vertices: Float32Array, indices: Uint32Array): RapierNS.Collider {
    const body = this.w.createRigidBody(this.api.RigidBodyDesc.fixed());
    const desc = this.api.ColliderDesc.trimesh(vertices, indices);
    return this.w.createCollider(desc, body);
  }

  /**
   * Static trimesh placed by body transform rather than by baking the transform
   * into the vertices — so many instances of one prop share a single vertex
   * buffer instead of each carrying its own transformed copy.
   */
  createTrimeshAt(
    vertices: Float32Array,
    indices: Uint32Array,
    position: { x: number; y: number; z: number },
    rotation: { x: number; y: number; z: number; w: number },
    scale = 1,
  ): RapierNS.Collider {
    const body = this.w.createRigidBody(
      this.api.RigidBodyDesc.fixed()
        .setTranslation(position.x, position.y, position.z)
        .setRotation(rotation),
    );
    let verts = vertices;
    if (scale !== 1) {
      verts = new Float32Array(vertices.length);
      for (let i = 0; i < vertices.length; i++) verts[i] = vertices[i]! * scale;
    }
    const desc = this.api.ColliderDesc.trimesh(verts, indices);
    return this.w.createCollider(desc, body);
  }

  /** Static box collider. `halfExtents` are half-widths, per Rapier convention. */
  createStaticBox(
    position: { x: number; y: number; z: number },
    halfExtents: { x: number; y: number; z: number },
    rotation?: { x: number; y: number; z: number; w: number },
  ): RapierNS.Collider {
    let desc = this.api.RigidBodyDesc.fixed().setTranslation(
      position.x,
      position.y,
      position.z,
    );
    if (rotation) desc = desc.setRotation(rotation);
    const body = this.w.createRigidBody(desc);
    const collider = this.api.ColliderDesc.cuboid(
      halfExtents.x,
      halfExtents.y,
      halfExtents.z,
    );
    return this.w.createCollider(collider, body);
  }

  /**
   * Many static boxes on one rigid body.
   *
   * The city is 798 buildings and about 1,700 boxes. Giving each its own body,
   * as `createStaticBox` does, means 1,700 bodies in the island manager and
   * 1,700 transforms integrated on a step that will never move any of them.
   * They are all static and all in world space, so one body at the origin can
   * carry the lot with the position baked into each collider instead.
   *
   * Returns the colliders in the order given, so callers can map each back to
   * the surface it belongs to.
   */
  createStaticBoxes(
    boxes: ReadonlyArray<{
      position: { x: number; y: number; z: number };
      halfExtents: { x: number; y: number; z: number };
    }>,
  ): RapierNS.Collider[] {
    const body = this.w.createRigidBody(this.api.RigidBodyDesc.fixed());
    return boxes.map(({ position, halfExtents }) => {
      const desc = this.api.ColliderDesc
        .cuboid(halfExtents.x, halfExtents.y, halfExtents.z)
        .setTranslation(position.x, position.y, position.z);
      return this.w.createCollider(desc, body);
    });
  }

  /**
   * Many static convex hulls on one rigid body — the city's roofs.
   *
   * A roof is the largest thing on any building here and, until this existed,
   * the only part of one a paintball flew straight through: the eave overhangs
   * by up to 2.4m, so a box around it is an invisible ceiling out over the
   * courtyard, and nobody wants to bump their head on a hall they are walking
   * past. A hull of the roof's own corners is the actual shape — sloped,
   * narrowing to the ridge, and stopping at the eave — for one collider.
   *
   * Points come in as a flat `[x, y, z, …]` array. A hull that Rapier refuses to
   * build — degenerate, coplanar — is skipped rather than throwing, and its slot
   * comes back `null` so the caller can still line results up with its input.
   */
  createStaticHulls(hulls: readonly Float32Array[]): Array<RapierNS.Collider | null> {
    const body = this.w.createRigidBody(this.api.RigidBodyDesc.fixed());
    return hulls.map((points) => {
      const desc = this.api.ColliderDesc.convexHull(points);
      return desc ? this.w.createCollider(desc, body) : null;
    });
  }

  /**
   * Static upright cylinder, centred on `position`.
   *
   * Used for tree trunks. A trimesh of the branch geometry would be exact, but
   * the woodland belt holds well over a thousand trees and a trimesh apiece
   * means a thousand BVHs to build at load and to query on every shot. What a
   * trunk owes the game is "you cannot walk through this and paintballs stop
   * here", and a cylinder at bole radius delivers that for one shape.
   */
  createStaticCylinder(
    position: { x: number; y: number; z: number },
    halfHeight: number,
    radius: number,
  ): RapierNS.Collider {
    const body = this.w.createRigidBody(
      this.api.RigidBodyDesc.fixed().setTranslation(position.x, position.y, position.z),
    );
    return this.w.createCollider(this.api.ColliderDesc.cylinder(halfHeight, radius), body);
  }

  /**
   * Kinematic character controller, configured from Config.player.
   * Phase 1 drives this; created here so physics setup stays in one place.
   */
  createCharacterController(): RapierNS.KinematicCharacterController {
    const controller = this.w.createCharacterController(physicsConfig.characterOffset);
    controller.setUp({ x: 0, y: 1, z: 0 });
    // Autostep lets the character walk up curbs and terrace stairs without a
    // jump. minWidth guards against stepping onto ledges too thin to stand on.
    controller.enableAutostep(playerConfig.maxStepHeight, 0.2, true);
    // Snapping keeps the character glued to the ground over crests, instead of
    // launching into a brief unwanted hop every time terrain curves away.
    controller.enableSnapToGround(0.4);
    controller.setMaxSlopeClimbAngle(playerConfig.maxSlopeClimb * DEG2RAD);
    controller.setMinSlopeSlideAngle(playerConfig.minSlopeSlide * DEG2RAD);
    controller.setApplyImpulsesToDynamicBodies(true);
    controller.setCharacterMass(75);
    // Without this the controller stops dead against walls instead of sliding
    // along them, which feels awful at speed.
    controller.setSlideEnabled(true);
    return controller;
  }

  /**
   * Ray query against the world. Returns the nearest hit, or null.
   * `exclude` skips a collider — normally the shooter's own body.
   */
  raycast(
    origin: Vector3,
    direction: Vector3,
    maxDistance: number,
    exclude?: RapierNS.Collider,
  ): RaycastHit | null {
    const ray = new this.api.Ray(
      { x: origin.x, y: origin.y, z: origin.z },
      { x: direction.x, y: direction.y, z: direction.z },
    );
    const hit = this.w.castRayAndGetNormal(
      ray,
      maxDistance,
      true,
      undefined,
      undefined,
      exclude,
    );
    if (!hit) return null;
    const point = ray.pointAt(hit.timeOfImpact);
    return {
      point: { x: point.x, y: point.y, z: point.z },
      normal: { x: hit.normal.x, y: hit.normal.y, z: hit.normal.z },
      distance: hit.timeOfImpact,
      collider: hit.collider,
    };
  }

  dispose(): void {
    this.world?.free();
    this.world = undefined;
  }
}
