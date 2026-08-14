import { BufferAttribute, BufferGeometry, Color, Vector3 } from 'three';

/**
 * A growable triangle soup in world space.
 *
 * The city is 798 buildings. Instancing them is not on — every footprint is a
 * different size, and a hip roof scaled to fit would have its pitch and its eave
 * curve stretched with it — so geometry is generated per building and merged.
 * This is what it merges into: plain arrays that grow, and one `finish()` at the
 * end.
 *
 * Everything is written in world coordinates. Merged geometry has no transform
 * of its own, so there is nowhere else for the position to live, and it makes
 * the paint system's job trivial: a receiver is this geometry and an identity
 * matrix.
 */
export class MeshBuilder {
  private positions: number[] = [];
  private normals: number[] = [];
  private colors: number[] = [];
  private indices: number[] = [];

  /** Triangles written so far. */
  get triangleCount(): number {
    return this.indices.length / 3;
  }

  get isEmpty(): boolean {
    return this.indices.length === 0;
  }

  /**
   * Adds one convex polygon as a fan, with a flat normal.
   *
   * Flat-shaded on purpose: the whole look is ink lines over flat colour, and
   * a smoothed normal across a roof plane just muddies the cel bands.
   */
  polygon(points: Vector3[], color: Color): void {
    if (points.length < 3) return;

    // Newell's method rather than the cross product of the first three points.
    //
    // A roof's top band collapses to a line — the ridge — so two of its four
    // corners are the same point, and the obvious cross product there is the
    // cross product of a zero vector: zero, which `normalize()` turns into NaN.
    // A single NaN normal is not a single black triangle either. It goes into
    // the normal buffer, the edge pass reads that buffer through a kernel, and
    // the NaN spreads to every neighbouring texel until the whole frame is
    // black. Newell's sums over all edges, so a degenerate corner contributes
    // nothing instead of poisoning the result.
    NORMAL.set(0, 0, 0);
    for (let i = 0; i < points.length; i++) {
      const p = points[i]!;
      const q = points[(i + 1) % points.length]!;
      NORMAL.x += (p.y - q.y) * (p.z + q.z);
      NORMAL.y += (p.z - q.z) * (p.x + q.x);
      NORMAL.z += (p.x - q.x) * (p.y + q.y);
    }
    // Fully degenerate — a line or a point. It would draw nothing anyway.
    if (NORMAL.lengthSq() < 1e-12) return;
    NORMAL.normalize();

    const base = this.positions.length / 3;

    for (const p of points) {
      this.positions.push(p.x, p.y, p.z);
      this.normals.push(NORMAL.x, NORMAL.y, NORMAL.z);
      this.colors.push(color.r, color.g, color.b);
    }
    for (let i = 1; i < points.length - 1; i++) {
      this.indices.push(base, base + i, base + i + 1);
    }
  }

  /** Adds a quad, wound so the normal comes out of the front face. */
  quad(a: Vector3, b: Vector3, c: Vector3, d: Vector3, color: Color): void {
    this.polygon([a, b, c, d], color);
  }

  /**
   * Adds an axis-aligned box.
   *
   * `taper` shrinks the top face by that fraction of the base — the batter a
   * Chinese wall is built with, and the difference between a wall and a slab.
   */
  box(
    cx: number, cy: number, cz: number,
    hw: number, hh: number, hd: number,
    color: Color,
    taper = 0,
  ): void {
    const y0 = cy - hh;
    const y1 = cy + hh;
    const tw = hw * (1 - taper);
    const td = hd * (1 - taper);

    const b000 = new Vector3(cx - hw, y0, cz - hd);
    const b100 = new Vector3(cx + hw, y0, cz - hd);
    const b101 = new Vector3(cx + hw, y0, cz + hd);
    const b001 = new Vector3(cx - hw, y0, cz + hd);
    const t000 = new Vector3(cx - tw, y1, cz - td);
    const t100 = new Vector3(cx + tw, y1, cz - td);
    const t101 = new Vector3(cx + tw, y1, cz + td);
    const t001 = new Vector3(cx - tw, y1, cz + td);

    // Wound counter-clockwise seen from *outside* each face, which is what puts
    // the normal outward. Worth stating because the obvious order — bottom edge
    // first, left to right, then up — produces exactly the opposite on four of
    // the six, and an inside-out box does not look inside-out. It looks like a
    // box lit from within: every wall in the city a shade too dark, with no
    // single thing wrong enough to point at.
    this.quad(t001, t101, t100, t000, color); // top
    this.quad(b000, b100, b101, b001, color); // bottom
    this.quad(t000, t100, b100, b000, color); // north
    this.quad(t101, t001, b001, b101, color); // south
    this.quad(t100, t101, b101, b100, color); // east
    this.quad(t001, t000, b000, b001, color); // west
  }

  /** A vertical prism — a column, when `sides` is 8 and it is thin. */
  prism(
    cx: number, cz: number, y0: number, y1: number,
    radius: number, sides: number, color: Color,
    topRadius = radius,
  ): void {
    const ring0: Vector3[] = [];
    const ring1: Vector3[] = [];
    for (let i = 0; i < sides; i++) {
      const a = (i / sides) * Math.PI * 2;
      ring0.push(new Vector3(cx + Math.cos(a) * radius, y0, cz + Math.sin(a) * radius));
      ring1.push(new Vector3(cx + Math.cos(a) * topRadius, y1, cz + Math.sin(a) * topRadius));
    }
    for (let i = 0; i < sides; i++) {
      const j = (i + 1) % sides;
      // Top ring first, for the same reason the box's faces are — see there.
      this.quad(ring1[i]!, ring1[j]!, ring0[j]!, ring0[i]!, color);
    }
    // The cap, reversed: the ring is generated by increasing angle, which is
    // clockwise seen from above, so taken in order its normal points at the
    // ground.
    this.polygon([...ring1].reverse(), color);
  }

  /**
   * Bakes the soup into a geometry.
   *
   * Returns null when nothing was written, so callers can skip empty districts
   * without checking first.
   */
  finish(): BufferGeometry | null {
    if (this.indices.length === 0) return null;
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(this.positions), 3));
    geometry.setAttribute('normal', new BufferAttribute(new Float32Array(this.normals), 3));
    geometry.setAttribute('color', new BufferAttribute(new Float32Array(this.colors), 3));
    geometry.setIndex(new BufferAttribute(new Uint32Array(this.indices), 1));
    geometry.computeBoundingSphere();
    geometry.computeBoundingBox();
    return geometry;
  }
}

const NORMAL = new Vector3();
