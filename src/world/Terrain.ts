import type * as RapierNS from '@dimforge/rapier3d';
import { BufferAttribute, BufferGeometry, Mesh, type MeshToonMaterial } from 'three';
import type { PhysicsWorld } from '../physics/PhysicsWorld';
import { createCelMaterial } from '../render/CelMaterial';
import { groundColorAt, heightAt, slopeAt, terrainAxisX, terrainAxisZ } from './CityLayout';

/**
 * The ground: one mesh, vertex-coloured, with a matching trimesh collider.
 *
 * Mesh and collider are generated from the same `heightAt` samples in one pass,
 * so there is no way for what you see to disagree with what you walk on.
 *
 * The grid is irregular. `CityLayout` decides where the lines go — coarse across
 * the flat courtyards, forced onto the terrace skirt, the moat banks and the
 * river channel — because the Forbidden City's ground is a paved plain with a
 * handful of hard edges, and a uniform grid fine enough for the edges would
 * spend most of its vertices describing a flat floor.
 */
export class Terrain {
  readonly mesh: Mesh;
  readonly collider: RapierNS.Collider;
  readonly material: MeshToonMaterial;
  /** Vertices in the ground mesh, for the boot log and the perf tools. */
  readonly vertexCount: number;

  constructor(physics: PhysicsWorld) {
    const axisX = terrainAxisX();
    const axisZ = terrainAxisZ();
    const cols = axisX.length;
    const rows = axisZ.length;
    const vertexCount = cols * rows;

    const positions = new Float32Array(vertexCount * 3);
    const colors = new Float32Array(vertexCount * 3);
    const indices = new Uint32Array((cols - 1) * (rows - 1) * 6);

    for (let iz = 0; iz < rows; iz++) {
      const z = axisZ[iz]!;
      for (let ix = 0; ix < cols; ix++) {
        const i = iz * cols + ix;
        const x = axisX[ix]!;
        const y = heightAt(x, z);

        positions[i * 3] = x;
        positions[i * 3 + 1] = y;
        positions[i * 3 + 2] = z;

        const color = groundColorAt(x, z, y, slopeAt(x, z));
        colors[i * 3] = color.r;
        colors[i * 3 + 1] = color.g;
        colors[i * 3 + 2] = color.b;
      }
    }

    let t = 0;
    for (let iz = 0; iz < rows - 1; iz++) {
      for (let ix = 0; ix < cols - 1; ix++) {
        const a = iz * cols + ix;
        const b = a + 1;
        const c = a + cols;
        const d = c + 1;
        // Counter-clockwise when viewed from above, so normals point up.
        indices[t++] = a;
        indices[t++] = c;
        indices[t++] = b;
        indices[t++] = b;
        indices[t++] = c;
        indices[t++] = d;
      }
    }

    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(positions, 3));
    geometry.setAttribute('color', new BufferAttribute(colors, 3));
    geometry.setIndex(new BufferAttribute(indices, 1));
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();

    // No rim on the ground: a Fresnel term across a surface this large just
    // produces a bright horizon band.
    this.material = createCelMaterial({ color: 0xffffff, rimStrength: 0 });
    this.material.vertexColors = true;

    this.mesh = new Mesh(geometry, this.material);
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = false;

    this.vertexCount = vertexCount;
    this.collider = physics.createTrimesh(positions, indices);
  }

  /** Height of the ground at a world position — the same source the mesh used. */
  sample(x: number, z: number): number {
    return heightAt(x, z);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
