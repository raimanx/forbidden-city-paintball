import {
  Group,
  InstancedMesh,
  Matrix4,
  Quaternion,
  Vector3,
  type BufferGeometry,
  type Material,
  type Mesh,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { Rng } from '../core/Random';
import type { GameContext } from '../core/System';
import type { SurfaceRegistry } from '../paint/SurfaceRegistry';
import { createCelMaterial } from '../render/CelMaterial';
import { IMPERIAL_WAY, TERRACE, heightAt, planX, planZ } from './CityLayout';
import { STRUCTURES } from './CityPlan';

/**
 * The furniture of the compound: the things that stand *in* the courtyards.
 *
 * ## Why these are models and the buildings are not
 *
 * The buildings are generated because no two footprints are the same size and a
 * stretched roof is a wrong roof. These are the opposite case. A bronze vat is a
 * bronze vat wherever it stands — 308 of them about the palace, all the same
 * size — and a guardian lion has a shape that no amount of parameter-fiddling
 * would arrive at. They are size-invariant, they repeat, and they want an
 * author. So they come from Blender, in one 78KB file, and every copy of each is
 * one instanced draw call.
 *
 * ## What is here
 *
 * - **铜缸**, the bronze water vats, kept full against fire.
 * - **石狮**, the guardian lions, in pairs at the gates that matter.
 * - **华表**, the carved marble columns.
 * - **日晷** and the incense burners, on the great terrace where the court
 *   assembled.
 * - **太湖石**, the eroded Lake Tai stones, and the cypresses of the Imperial
 *   Garden.
 */

/** Where the prop set lives, under `BASE_URL` so the Pages deployment finds it. */
const MODEL_URL = `${import.meta.env.BASE_URL}models/city-props.glb`;

interface Placement {
  x: number;
  z: number;
  rotationY: number;
  scale: number;
}

/** A prop type: its colour, its rough collider size, and where it goes. */
interface PropSpec {
  color: number;
  /** Half-extents of the box that stops a player and a paintball. */
  half: { x: number; y: number; z: number };
  /** Height of the collider's centre above the prop's foot. */
  centerY: number;
}

const SPECS: Record<string, PropSpec> = {
  vat: { color: 0x8a6a3c, half: { x: 0.9, y: 0.6, z: 0.9 }, centerY: 0.6 },
  lion: { color: 0xa9a396, half: { x: 0.6, y: 0.8, z: 0.4 }, centerY: 0.8 },
  // Sized to the shaft rather than to the cloud disc at its head: at 0.45 the
  // box stood 20cm proud of the marble, and a paintball that stops 20cm off a
  // column stops in mid-air with nothing near enough to take the splat.
  huabiao: { color: 0xd8d2c2, half: { x: 0.28, y: 2.5, z: 0.28 }, centerY: 2.5 },
  sundial: { color: 0xd8d2c2, half: { x: 0.5, y: 0.65, z: 0.5 }, centerY: 0.65 },
  burner: { color: 0x7d6236, half: { x: 0.45, y: 0.5, z: 0.45 }, centerY: 0.5 },
  rock_a: { color: 0x8b8578, half: { x: 0.8, y: 1.1, z: 0.7 }, centerY: 1.1 },
  rock_b: { color: 0x807a6d, half: { x: 1.0, y: 1.5, z: 0.9 }, centerY: 1.5 },
  rock_c: { color: 0x938c7e, half: { x: 0.6, y: 0.8, z: 0.55 }, centerY: 0.8 },
  cypress: { color: 0x3f5c3a, half: { x: 0.35, y: 2.2, z: 0.35 }, centerY: 2.2 },
};

const UP = new Vector3(0, 1, 0);

export class CityProps {
  readonly group = new Group();
  private readonly disposables: Array<{ dispose(): void }> = [];
  /** Instances placed, for the boot log. */
  placed = 0;

  async load(ctx: GameContext, surfaces: SurfaceRegistry, rng: Rng): Promise<void> {
    const loader = new GLTFLoader();
    const gltf = await loader.loadAsync(MODEL_URL, (event) => {
      if (event.total > 0) {
        ctx.events.emit('load:progress', {
          phase: 'the palace',
          progress: 0.8 + 0.1 * (event.loaded / event.total),
        });
      }
    });

    const geometries = new Map<string, BufferGeometry>();
    gltf.scene.traverse((child) => {
      const mesh = child as Mesh;
      if (mesh.isMesh) geometries.set(mesh.name, mesh.geometry);
    });

    const missing = Object.keys(SPECS).filter((name) => !geometries.has(name));
    if (missing.length > 0) {
      throw new Error(`CityProps: prop set is missing ${missing.join(', ')}`);
    }

    for (const [name, placements] of Object.entries(layout(rng))) {
      this.place(ctx, surfaces, geometries.get(name)!, name, placements);
    }
  }

  private place(
    ctx: GameContext,
    surfaces: SurfaceRegistry,
    geometry: BufferGeometry,
    name: string,
    placements: Placement[],
  ): void {
    if (placements.length === 0) return;
    const spec = SPECS[name]!;
    const material = createCelMaterial({ color: spec.color });
    const mesh = new InstancedMesh(geometry, material, placements.length);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.group.add(mesh);
    this.disposables.push(material as unknown as Material & { dispose(): void });

    const matrix = new Matrix4();
    const quaternion = new Quaternion();
    const scale = new Vector3();
    const position = new Vector3();
    const boxes: Array<{
      position: { x: number; y: number; z: number };
      halfExtents: { x: number; y: number; z: number };
    }> = [];
    const matrices: Matrix4[] = [];

    placements.forEach((placement, i) => {
      const y = heightAt(placement.x, placement.z);
      position.set(placement.x, y, placement.z);
      quaternion.setFromAxisAngle(UP, placement.rotationY);
      scale.setScalar(placement.scale);
      matrix.compose(position, quaternion, scale);
      mesh.setMatrixAt(i, matrix);
      matrices.push(matrix.clone());

      boxes.push({
        position: { x: placement.x, y: y + spec.centerY * placement.scale, z: placement.z },
        halfExtents: {
          x: spec.half.x * placement.scale,
          y: spec.half.y * placement.scale,
          z: spec.half.z * placement.scale,
        },
      });
    });

    mesh.instanceMatrix.needsUpdate = true;

    // Box colliders rather than trimeshes: what a vat owes the game is that you
    // cannot walk through it and a paintball stops at it, and a box delivers
    // that for a fraction of the BVH. Paint still projects against the prop's
    // real geometry — the registry takes geometry and a transform, and they do
    // not have to be the collider's.
    const colliders = ctx.physics.createStaticBoxes(boxes);
    colliders.forEach((collider, i) => {
      surfaces.registerInstance(collider.handle, geometry, matrices[i]!);
    });
    this.placed += placements.length;
  }

  dispose(): void {
    for (const item of this.disposables) item.dispose();
    this.group.clear();
  }
}

/** Finds a structure by its Chinese name. */
function find(zh: string): { x: number; z: number; w: number; d: number } | undefined {
  const s = STRUCTURES.find((entry) => entry.zh === zh);
  return s ? { x: planX(s.x), z: planZ(s.z), w: s.w * 0.45, d: s.d * 0.45 } : undefined;
}

/**
 * Where everything stands.
 *
 * Anchored to named buildings rather than to bare coordinates, so the furniture
 * follows the architecture if the survey is ever re-fetched and something moves.
 */
function layout(rng: Rng): Record<string, Placement[]> {
  const vats: Placement[] = [];
  const lions: Placement[] = [];
  const huabiao: Placement[] = [];
  const sundial: Placement[] = [];
  const burner: Placement[] = [];
  const rock_a: Placement[] = [];
  const rock_b: Placement[] = [];
  const rock_c: Placement[] = [];
  const cypress: Placement[] = [];

  // Lions flank the gates of consequence, facing out from them.
  for (const zh of ['太和门', '乾清门', '神武门']) {
    const gate = find(zh);
    if (!gate) continue;
    for (const side of [-1, 1]) {
      lions.push({
        x: gate.x + side * (gate.w / 2 + 3.2),
        z: gate.z + gate.d / 2 + 2.4,
        rotationY: Math.PI,
        scale: 1.15,
      });
    }
  }

  // Vats stand in pairs against the long buildings, where a fire would start.
  for (const zh of ['太和门', '保和殿', '乾清宫', '坤宁宫', '文华殿', '武英殿']) {
    const hall = find(zh);
    if (!hall) continue;
    for (const side of [-1, 1]) {
      vats.push({
        x: hall.x + side * (hall.w / 2 + 1.8),
        z: hall.z + hall.d / 2 + 1.6,
        rotationY: rng.range(0, Math.PI * 2),
        scale: 1,
      });
    }
  }

  // The terrace furniture, on the axis outside the Hall of Supreme Harmony:
  // the sundial to the east, the grain measure to the west — here a second
  // sundial, since the two are the same silhouette at this size — and burners
  // in a row between them.
  const taihe = find('太和殿');
  if (taihe) {
    const front = taihe.z + taihe.d / 2 + 5;
    sundial.push({ x: taihe.x + 11, z: front, rotationY: Math.PI, scale: 1 });
    sundial.push({ x: taihe.x - 11, z: front, rotationY: Math.PI, scale: 1 });
    for (const offset of [-5.5, -2, 2, 5.5]) {
      burner.push({ x: taihe.x + offset, z: front + 1.5, rotationY: 0, scale: 1 });
    }
    for (const side of [-1, 1]) {
      vats.push({ x: taihe.x + side * 17, z: front - 1, rotationY: rng.range(0, 6.28), scale: 1.1 });
    }
  }

  // 华表 in front of the Meridian Gate, on the axis, where the court entered.
  const wumen = find('午门');
  if (wumen) {
    for (const side of [-1, 1]) {
      huabiao.push({
        x: IMPERIAL_WAY.x + side * 9,
        z: wumen.z - wumen.d / 2 - 8,
        rotationY: 0,
        scale: 1,
      });
    }
  }

  // The Imperial Garden: rockery and old cypresses, scattered rather than
  // placed, because that is the one part of the compound with no grid in it.
  const gardenZ = planZ(-508);
  for (let i = 0; i < 26; i++) {
    const x = rng.range(-58, 58);
    const z = gardenZ + rng.range(-26, 26);
    // Clear of the axis, which stays open from the Gate of Earthly Tranquility
    // to the Gate of Divine Might.
    if (Math.abs(x - IMPERIAL_WAY.x) < 7) continue;
    const spot = { x, z, rotationY: rng.range(0, Math.PI * 2), scale: rng.range(0.8, 1.3) };
    if (i % 3 === 0) rock_b.push(spot);
    else if (i % 3 === 1) rock_a.push(spot);
    else rock_c.push(spot);
  }
  for (let i = 0; i < 22; i++) {
    const x = rng.range(-62, 62);
    const z = gardenZ + rng.range(-30, 30);
    if (Math.abs(x - IMPERIAL_WAY.x) < 8) continue;
    cypress.push({ x, z, rotationY: rng.range(0, Math.PI * 2), scale: rng.range(0.85, 1.25) });
  }

  // A pair of cypresses at the foot of the terrace stairs, for scale.
  for (const side of [-1, 1]) {
    cypress.push({
      x: side * 26,
      z: TERRACE.southZ + 6,
      rotationY: rng.range(0, Math.PI * 2),
      scale: 1.2,
    });
  }

  return { vat: vats, lion: lions, huabiao, sundial, burner, rock_a, rock_b, rock_c, cypress };
}
