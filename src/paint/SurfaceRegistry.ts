import { Matrix4, type BufferGeometry, type Mesh } from 'three';

/**
 * Everything the paint system needs to project a decal onto a surface.
 *
 * Geometry plus a world transform rather than a Mesh, because a large share of
 * the park's props are instanced. An InstancedMesh has one matrixWorld for the
 * whole batch, so a decal projected against it would land on whichever instance
 * happened to be at the origin. Storing the per-instance matrix here lets paint
 * work on instanced props exactly as it does on individual ones.
 */
export interface PaintReceiver {
  geometry: BufferGeometry;
  matrixWorld: Matrix4;
}

/**
 * Maps Rapier collider handles back to the surfaces that own them.
 *
 * Physics knows what a paintball hit; rendering needs to know what to paint.
 * Nothing else bridges the two, so world geometry registers here at build time
 * and the paint system looks up receivers on impact.
 */
export class SurfaceRegistry {
  private byHandle = new Map<number, PaintReceiver[]>();

  register(colliderHandle: number, receiver: PaintReceiver): void {
    this.byHandle.set(colliderHandle, [receiver]);
  }

  /**
   * Registers a collider against several candidate surfaces, best first.
   *
   * The city's geometry is merged by *material* — tile, timber, stone — and one
   * collider often stands behind more than one of them: the perimeter wall is a
   * stone base course with a red wall on it and a tiled coping over that, and
   * all three are different meshes. Paint projects against triangles, so a
   * splat on the base course of a wall registered as timber finds nothing near
   * the impact and is silently dropped. Handing over every mesh the collider
   * could have been drawn by, in the order it most likely was, is what makes
   * every face of a building take paint rather than most of them.
   */
  registerAll(colliderHandle: number, receivers: PaintReceiver[]): void {
    if (receivers.length > 0) this.byHandle.set(colliderHandle, receivers);
  }

  /** Convenience for an ordinary mesh. Its world matrix is resolved now. */
  registerMesh(colliderHandle: number, mesh: Mesh): void {
    mesh.updateMatrixWorld(true);
    this.byHandle.set(colliderHandle, [{
      geometry: mesh.geometry,
      matrixWorld: mesh.matrixWorld.clone(),
    }]);
  }

  /** Registers one instance of an instanced prop. */
  registerInstance(
    colliderHandle: number,
    geometry: BufferGeometry,
    instanceMatrix: Matrix4,
  ): void {
    this.byHandle.set(colliderHandle, [{
      geometry,
      matrixWorld: instanceMatrix.clone(),
    }]);
  }

  /** Every surface this collider might have been drawn by, best first. */
  get(colliderHandle: number): readonly PaintReceiver[] | undefined {
    return this.byHandle.get(colliderHandle);
  }

  get size(): number {
    return this.byHandle.size;
  }

  clear(): void {
    this.byHandle.clear();
  }
}
