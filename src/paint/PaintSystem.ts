import {
  BufferAttribute,
  BufferGeometry,
  Color,
  Euler,
  Mesh,
  MeshToonMaterial,
  Quaternion,
  Vector3,
} from 'three';
import { DecalGeometry } from 'three/examples/jsm/geometries/DecalGeometry.js';
import { paint as paintConfig } from '../core/Config';
import { clamp, remap } from '../core/MathUtils';
import type { GameContext, System } from '../core/System';
import { getCelGradient } from '../render/CelMaterial';
import { SplatAtlas } from './SplatAtlas';
import type { SurfaceRegistry } from './SurfaceRegistry';

/** Total vertex budget for all world paint. ~150k verts is about 3.6MB. */
const MAX_VERTS = 150_000;
/** A single decal producing more than this is skipped as pathological. */
const MAX_VERTS_PER_DECAL = 512;
/** When the buffer fills, drop this fraction of the oldest paint and repack. */
const EVICT_FRACTION = 0.25;
/** How deep the decal box projects through the receiving surface. */
const PROJECTION_DEPTH = 0.5;

interface DecalRecord {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  tint: [number, number, number];
  tile: [number, number, number];
  vertexCount: number;
}

/**
 * World paint, accumulated as batched decals.
 *
 * PLAN CHANGE, deliberate: the plan called for texture-space accumulation —
 * every surface unwrapped into a shared 4096 atlas, splats stamped at the
 * impact UV. The arithmetic kills it. The test course's ground alone is
 * 100x100m; the Phase 4 arena is 130x130m. Packing that into a 4096 atlas
 * leaves roughly 5 texels per metre, so a 34cm splat would land on under two
 * texels. Texture-space accumulation is the right technique for a corridor
 * shooter, not for an open park.
 *
 * Decals invert the trade: resolution is independent of world size, so splats
 * stay crisp at any scale, and the cost moves from texture memory to vertex
 * count — which is cheap and bounded. Everything merges into one buffer with
 * per-vertex tint and atlas-tile attributes, so all the paint in the world is a
 * single draw call.
 *
 * The thing genuinely lost is unlimited permanence: paint is capped and the
 * oldest is evicted. At 2000-odd splats that's a long match.
 *
 * Characters are NOT painted here. Decals are baked against static geometry and
 * would need reprojecting every frame on an animated mesh; character paint uses
 * a per-character render target and lands in phase 5 with the real rig.
 */
export class PaintSystem implements System {
  readonly name = 'paint';

  private atlas?: SplatAtlas;
  private geometry?: BufferGeometry;
  private mesh?: Mesh;
  private material?: MeshToonMaterial;

  private positions!: Float32Array;
  private normals!: Float32Array;
  private uvs!: Float32Array;
  private tints!: Float32Array;
  private tiles!: Float32Array;

  private records: DecalRecord[] = [];
  private writeOffset = 0;
  private dirty = false;

  private readonly orientation = new Euler();
  private readonly quaternion = new Quaternion();
  private readonly rollQuaternion = new Quaternion();
  private readonly decalSize = new Vector3();
  private readonly color = new Color();
  /**
   * Stand-in receiver handed to DecalGeometry, which only ever reads
   * `geometry` and `matrixWorld`. Using a proxy lets instanced props be painted
   * per-instance, since an InstancedMesh has a single matrixWorld for the batch.
   * Never added to the scene, so nothing recomputes its transform.
   */
  private readonly proxy = new Mesh();

  /** Splats placed since load, including any since evicted. */
  private totalPlaced = 0;

  /**
   * The splat atlas is shared, not owned. Generating it costs ~50ms and it is
   * needed by world paint, character paint and the lens splash — three
   * independent copies was 150ms of identical work at boot.
   */
  constructor(
    private readonly surfaces: SurfaceRegistry,
    private readonly sharedAtlas: SplatAtlas,
  ) {}

  init(ctx: GameContext): void {
    this.atlas = this.sharedAtlas;

    this.positions = new Float32Array(MAX_VERTS * 3);
    this.normals = new Float32Array(MAX_VERTS * 3);
    this.uvs = new Float32Array(MAX_VERTS * 2);
    this.tints = new Float32Array(MAX_VERTS * 3);
    this.tiles = new Float32Array(MAX_VERTS * 3);

    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(this.positions, 3));
    geometry.setAttribute('normal', new BufferAttribute(this.normals, 3));
    geometry.setAttribute('uv', new BufferAttribute(this.uvs, 2));
    geometry.setAttribute('aTint', new BufferAttribute(this.tints, 3));
    geometry.setAttribute('aTile', new BufferAttribute(this.tiles, 3));
    geometry.setDrawRange(0, 0);
    this.geometry = geometry;

    this.material = this.createMaterial();

    const mesh = new Mesh(geometry, this.material);
    // Paint sits flush on surfaces it did not author; without an offset it
    // z-fights the wall it's painted on.
    mesh.frustumCulled = false;
    mesh.receiveShadow = true;
    mesh.renderOrder = 1;
    ctx.scene.add(mesh);
    this.mesh = mesh;

    ctx.events.on('hit:world', (impact) => this.paint(impact, ctx));
  }

  /** Splats currently held in the buffer. */
  get splatCount(): number {
    return this.records.length;
  }

  get placedCount(): number {
    return this.totalPlaced;
  }

  get vertexCount(): number {
    return this.writeOffset;
  }

  private paint(
    impact: {
      point: Vector3;
      normal: Vector3;
      color: number;
      impactSpeed: number;
      colliderHandle: number;
    },
    ctx: GameContext,
  ): void {
    const receivers = this.surfaces.get(impact.colliderHandle);
    if (!receivers || receivers.length === 0 || !this.atlas) return;

    // Faster hits splash wider.
    const speedScale = clamp(
      remap(
        impact.impactSpeed,
        paintConfig.splatSpeedMin,
        paintConfig.splatSpeedMax,
        paintConfig.minSplatScale,
        paintConfig.maxSplatScale,
      ),
      paintConfig.minSplatScale,
      paintConfig.maxSplatScale,
    );
    const radius = paintConfig.baseSplatRadius * speedScale;

    // Orient the decal box so it projects along the surface normal, with a
    // random roll so repeated hits on one wall don't stamp identically.
    this.quaternion.setFromUnitVectors(FORWARD, impact.normal);
    this.rollQuaternion.setFromAxisAngle(FORWARD, ctx.rng.range(0, Math.PI * 2));
    this.quaternion.multiply(this.rollQuaternion);
    this.orientation.setFromQuaternion(this.quaternion);

    this.decalSize.set(radius * 2, radius * 2, PROJECTION_DEPTH);

    // A collider can stand behind more than one merged mesh — a wall is a stone
    // base, a red body and a tiled coping, drawn in three different materials —
    // so the candidates are tried in turn and the first one with triangles
    // under the impact wins. All but the first cost nothing in the common case,
    // where the surface the collider was tagged with is the one that was hit.
    let decal: DecalGeometry | undefined;
    let vertexCount = 0;
    for (const receiver of receivers) {
      this.proxy.geometry = receiver.geometry;
      this.proxy.matrixWorld.copy(receiver.matrixWorld);
      const candidate = new DecalGeometry(
        this.proxy,
        impact.point,
        this.orientation,
        this.decalSize,
      );
      const count = candidate.getAttribute('position').count;
      if (count > 0 && count <= MAX_VERTS_PER_DECAL) {
        decal = candidate;
        vertexCount = count;
        break;
      }
      candidate.dispose();
    }

    // Nothing clipped by any of them means the impact point missed every
    // receiver's triangles — nothing to draw.
    if (!decal) return;

    const variant = ctx.rng.int(0, this.atlas.variants);
    const tile = this.atlas.getTileTransform(variant);
    this.color.setHex(impact.color);

    const record: DecalRecord = {
      positions: new Float32Array(decal.getAttribute('position').array as Float32Array),
      normals: new Float32Array(decal.getAttribute('normal').array as Float32Array),
      uvs: new Float32Array(decal.getAttribute('uv').array as Float32Array),
      tint: [this.color.r, this.color.g, this.color.b],
      tile: [tile.offsetX, tile.offsetY, tile.scale],
      vertexCount,
    };
    decal.dispose();

    if (this.writeOffset + vertexCount > MAX_VERTS) this.evictOldest();
    if (this.writeOffset + vertexCount > MAX_VERTS) return;

    this.append(record);
    this.records.push(record);
    this.totalPlaced++;
    this.dirty = true;
  }

  /** Copies one decal's vertices into the shared buffer at the write cursor. */
  private append(record: DecalRecord): void {
    const start = this.writeOffset;
    this.positions.set(record.positions, start * 3);
    this.normals.set(record.normals, start * 3);
    this.uvs.set(record.uvs, start * 2);

    for (let i = 0; i < record.vertexCount; i++) {
      const t3 = (start + i) * 3;
      this.tints[t3] = record.tint[0];
      this.tints[t3 + 1] = record.tint[1];
      this.tints[t3 + 2] = record.tint[2];
      this.tiles[t3] = record.tile[0];
      this.tiles[t3 + 1] = record.tile[1];
      this.tiles[t3 + 2] = record.tile[2];
    }

    this.writeOffset += record.vertexCount;
  }

  /**
   * Drops the oldest paint and repacks. Freed space is at the front of the
   * buffer, not the end, so there's no way to reuse it without a rewrite —
   * but this happens rarely enough that a full repack is the simplest correct
   * answer.
   */
  private evictOldest(): void {
    const dropCount = Math.max(1, Math.floor(this.records.length * EVICT_FRACTION));
    this.records.splice(0, dropCount);

    this.writeOffset = 0;
    for (const record of this.records) this.append(record);
    this.dirty = true;
  }

  update(): void {
    if (!this.dirty || !this.geometry) return;
    this.dirty = false;

    for (const name of ['position', 'normal', 'uv', 'aTint', 'aTile']) {
      this.geometry.getAttribute(name).needsUpdate = true;
    }
    this.geometry.setDrawRange(0, this.writeOffset);
    // The bounding sphere is meaningless for a buffer that grows across the
    // whole map, and frustum culling is off, so don't pay to recompute it.
  }

  /**
   * Toon-shaded, with the splat atlas driving coverage and a per-vertex tint.
   * Patched rather than written from scratch so paint keeps receiving the same
   * scene lighting as the surface underneath it.
   */
  private createMaterial(): MeshToonMaterial {
    const material = new MeshToonMaterial({
      gradientMap: getCelGradient(),
      transparent: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
      depthWrite: true,
    });

    material.onBeforeCompile = (shader) => {
      shader.uniforms.uSplatAtlas = { value: this.atlas!.texture };

      // NB: three only emits its own `vUv` varying when a material actually
      // uses a map. This one doesn't, so we carry our own.

      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
           attribute vec3 aTint;
           attribute vec3 aTile;
           varying vec3 vTint;
           varying vec3 vTile;
           varying vec2 vSplatUv;`,
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
           vTint = aTint;
           vTile = aTile;
           vSplatUv = uv;`,
        );

      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
           uniform sampler2D uSplatAtlas;
           varying vec3 vTint;
           varying vec3 vTile;
           varying vec2 vSplatUv;`,
        )
        .replace(
          '#include <map_fragment>',
          `vec2 splatUv = vSplatUv * vTile.z + vTile.xy;
           vec4 splat = texture2D( uSplatAtlas, splatUv );
           // Alpha-tested rather than blended: blending would need sorting, and
           // sorting thousands of coplanar decals is not worth it.
           if ( splat.a < 0.4 ) discard;
           // splat.r rises toward the interior, so this darkens the wet rim.
           diffuseColor.rgb = vTint * ( 0.74 + 0.26 * splat.r );
           diffuseColor.a = 1.0;`,
        );
    };

    // Changing onBeforeCompile invalidates any cached program.
    material.customProgramCacheKey = () => 'paint-decal-v1';
    return material;
  }

  dispose(): void {
    this.mesh?.removeFromParent();
    this.geometry?.dispose();
    this.material?.dispose();
    // The atlas is shared; its owner disposes it.
    this.records = [];
  }
}

/** DecalGeometry projects along +Z of the supplied orientation. */
const FORWARD = new Vector3(0, 0, 1);
