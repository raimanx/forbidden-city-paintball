import { Color, Group, Mesh, Vector3, type BufferGeometry, type Material } from 'three';
import { fbmSigned } from '../core/Noise';
import type { Rng } from '../core/Random';
import { clamp } from '../core/MathUtils';
import { createCelMaterial } from '../render/CelMaterial';
import { NO_OUTLINE_LAYER } from '../render/NprPipeline';
import { CITY_COLORS } from './CityBuilding';
import {
  GROUND_HALF_X,
  GROUND_HALF_Z,
  JINGSHAN,
  PINE,
  PINE_LIT,
  planLength,
} from './CityLayout';
import { MeshBuilder } from './MeshBuilder';

/**
 * Everything outside the moat.
 *
 * ## Why it matters
 *
 * The Forbidden City is not a fort in a field. It is the middle of a walled
 * capital, and from inside it you are always aware of that — most of all to the
 * north, where **Jingshan** stands directly on the axis with the Wanchun
 * Pavilion on its crown. It is the one thing visible over the wall from
 * anywhere in the compound, and it is what tells you which way you are facing
 * when every courtyard looks like the last one. The park's Manhattan skyline did
 * exactly this job; this is the same idea with a hill instead of a wall of glass.
 *
 * ## What it is
 *
 * A hill and some roofs. No colliders, nothing walkable, nothing that the
 * navgrid or the paint system ever hears about. It is scenery, and it is built
 * to be cheap: one merged mesh for the hill, one for the roofscape, both of them
 * beyond the fog's far bound where the eye is reading silhouette and colour and
 * nothing else.
 */
export class Backdrop {
  readonly group = new Group();
  private readonly geometries: BufferGeometry[] = [];
  private readonly materials: Material[] = [];

  constructor(rng: Rng) {
    this.buildHill();
    this.buildRoofscape(rng);
  }

  /**
   * Jingshan — 景山 — the hill made from the spoil of the moat.
   *
   * A cone of rings with a noisy skirt, wooded, with a small pavilion on top.
   * Its silhouette is the whole point, so the profile is shaped rather than
   * conical: steep flanks, a broad shoulder, and a distinct crown for the
   * pavilion to sit on.
   */
  private buildHill(): void {
    const builder = new MeshBuilder();
    const SECTORS = 28;
    const RINGS = 6;
    const base = -1.2;

    // The pavilion sits at the top of the profile below.
    const profile = (t: number) => Math.pow(1 - t, 1.7);

    const ringAt = (ring: number): Vector3[] => {
      const t = ring / RINGS;
      const radius = JINGSHAN.radius * (1 - t);
      const points: Vector3[] = [];
      for (let s = 0; s < SECTORS; s++) {
        const angle = (s / SECTORS) * Math.PI * 2;
        // The skirt wanders; the crown does not, or the pavilion stands on a
        // slope.
        const wobble = 1 + fbmSigned(Math.cos(angle) * 2.1, Math.sin(angle) * 2.1, 3, 77)
          * 0.16 * (1 - t);
        const r = radius * wobble;
        const y = base + JINGSHAN.height * profile(t)
          + fbmSigned(Math.cos(angle) * 3.3, Math.sin(angle) * 3.3 + t * 4, 2, 41) * 2.4 * (1 - t);
        points.push(new Vector3(JINGSHAN.x + Math.cos(angle) * r, y, JINGSHAN.z + Math.sin(angle) * r));
      }
      return points;
    };

    const rings: Vector3[][] = [];
    for (let ring = 0; ring <= RINGS; ring++) rings.push(ringAt(ring));

    const wooded = new Color();
    for (let ring = 0; ring < RINGS; ring++) {
      const lower = rings[ring]!;
      const upper = rings[ring + 1]!;
      for (let s = 0; s < SECTORS; s++) {
        const next = (s + 1) % SECTORS;
        // Pines below, thinning to bare crown colour at the top.
        wooded.copy(PINE).lerp(PINE_LIT, clamp(0.25 + (s % 3) * 0.16 + ring * 0.06, 0, 1));
        builder.quad(upper[s]!, upper[next]!, lower[next]!, lower[s]!, wooded);
      }
    }
    // Cap the crown.
    builder.polygon([...rings[RINGS]!].reverse(), PINE_LIT);

    // 万春亭, the Wanchun Pavilion: the gold-roofed kiosk on the summit, and the
    // one piece of the backdrop anybody will actually look at.
    const crownY = base + JINGSHAN.height;
    const pavilionR = planLength(11);
    builder.box(JINGSHAN.x, crownY + 3, JINGSHAN.z, pavilionR, 3, pavilionR, CITY_COLORS.red);
    for (let tier = 0; tier < 2; tier++) {
      const r = pavilionR * (1.5 - tier * 0.45);
      const y = crownY + 6 + tier * 4.5;
      builder.box(JINGSHAN.x, y, JINGSHAN.z, r, 0.5, r, CITY_COLORS.tile);
      builder.prism(JINGSHAN.x, JINGSHAN.z, y, y + 3.4, r * 0.8, 4, CITY_COLORS.tile, 0.4);
    }

    this.add(builder, 'jingshan');
  }

  /**
   * The old city: a grey roofscape ringing the moat, thinning into the haze.
   *
   * Single-storey courtyard houses — 四合院 — which is what surrounded the
   * palace and which read, at this distance, as a grey field with a grain to it.
   * Deliberately low and deliberately dull: anything tall or coloured out here
   * competes with the compound, and the compound is the subject.
   */
  private buildRoofscape(rng: Rng): void {
    const builder = new MeshBuilder();
    const near = Math.max(GROUND_HALF_X, GROUND_HALF_Z) * 0.86;
    const far = near + 260;
    const grey = new Color();

    for (let i = 0; i < 900; i++) {
      const angle = rng.range(0, Math.PI * 2);
      // Biased outward, so the near edge is not a wall of houses.
      const t = Math.sqrt(rng.range(0, 1));
      const radius = near + (far - near) * t;
      const x = Math.cos(angle) * radius;
      const z = Math.sin(angle) * radius * 1.12;

      // Nothing inside the moat ring, and nothing on Jingshan.
      if (Math.abs(x) < GROUND_HALF_X * 0.92 && Math.abs(z) < GROUND_HALF_Z * 0.92) continue;
      if (Math.hypot(x - JINGSHAN.x, z - JINGSHAN.z) < JINGSHAN.radius * 1.15) continue;

      const w = rng.range(6, 17);
      const d = rng.range(5, 12);
      const h = rng.range(2.6, 4.4);
      const y = 0.6;

      grey.setHSL(0.09, 0.05, rng.range(0.3, 0.44));
      builder.box(x, y + h / 2, z, w / 2, h / 2, d / 2, grey);
      // A grey tiled roof with a ridge, so the field has a texture rather than
      // being a plain of cubes.
      grey.setHSL(0.09, 0.04, rng.range(0.36, 0.5));
      builder.box(x, y + h + 0.5, z, w / 2 + 0.6, 0.5, d / 2 + 0.6, grey);
      builder.box(x, y + h + 1.2, z, w / 2 * 0.5, 0.4, d / 2 * 0.4, grey);
    }

    this.add(builder, 'roofscape');
  }

  private add(builder: MeshBuilder, name: string): void {
    const geometry = builder.finish();
    if (!geometry) return;
    const material = createCelMaterial({ color: 0xffffff, rimStrength: 0 });
    material.vertexColors = true;
    const mesh = new Mesh(geometry, material);
    mesh.name = name;
    // Backdrop: it neither casts nor receives. The shadow frustum is 82m and
    // this starts 200m out, so it would cost a pass over the whole map for
    // shadows that could never land anywhere anyone can see.
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.matrixAutoUpdate = false;
    // Out of the ink prepass too. At 200m and beyond, an outline pass over a
    // field of nine hundred rooftops costs a second draw of all of them to
    // produce a grey mush of lines a pixel apart.
    mesh.layers.set(NO_OUTLINE_LAYER);
    this.group.add(mesh);
    this.geometries.push(geometry);
    this.materials.push(material);
  }

  dispose(): void {
    for (const geometry of this.geometries) geometry.dispose();
    for (const material of this.materials) material.dispose();
    this.group.clear();
  }
}
