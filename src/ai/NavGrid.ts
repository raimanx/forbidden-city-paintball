import { Vector3 } from 'three';
import { player as playerConfig } from '../core/Config';
import { DEG2RAD } from '../core/MathUtils';
import type { Rng } from '../core/Random';
import type { PhysicsWorld } from '../physics/PhysicsWorld';
import { NAV_HALF_X, NAV_HALF_Z, WATER_Y, heightAt, slopeAt } from '../world/CityLayout';

/** Cell size in metres. 2m is finer than a character is wide. */
const CELL = 2;
/** Clearance above the waterline required to count as dry land. */
const SHORE_MARGIN = 0.35;
/** Abrupt rise a bot can step up, matching the player's autostep. */
const MAX_STEP = playerConfig.maxStepHeight;
/** Tangent of the steepest walkable slope. */
const MAX_SLOPE_TAN = Math.tan(playerConfig.maxSlopeClimb * DEG2RAD);

/** Offsets probed within each cell, in metres. Centre plus the four quadrants. */
const CELL_SAMPLES: Array<[number, number]> = [
  [0, 0],
  [-CELL * 0.32, -CELL * 0.32],
  [CELL * 0.32, -CELL * 0.32],
  [-CELL * 0.32, CELL * 0.32],
  [CELL * 0.32, CELL * 0.32],
];

interface Node {
  index: number;
  g: number;
  f: number;
  parent: number;
}

/**
 * Walkability grid and pathfinding over the compound.
 *
 * A grid rather than a recast-style navmesh: the ground is already an
 * analytic heightfield, so sampling it into cells is exact and costs nothing,
 * and a proper navmesh would buy nothing at this scale. Obstacles are found by
 * querying the physics world at each cell, which means every collider the arena
 * places — all 798 buildings, the courtyard walls, the terrace facing — blocks
 * bots automatically, with no separate obstacle list to keep in sync. On a map
 * that is four fifths building by area, that property is doing most of the work.
 *
 * Rectangular, not square: the Forbidden City is half again as long as it is
 * wide, and a square grid would spend a third of its cells on ground that is
 * outside the walls.
 *
 * The grid covers the **compound only**, not the road and moat outside it. Two
 * reasons. Cost: each cell is five shape queries at boot. And intent: the ring
 * road is somewhere for the *player* to slip away to, and bots that followed
 * them out would be playing a different game from everyone else.
 */
export class NavGrid {
  readonly cols: number;
  readonly rows: number;
  private readonly walkable: Uint8Array;
  private readonly heights: Float32Array;

  /** Cells found walkable, for diagnostics. */
  readonly walkableCount: number;
  readonly buildMs: number;

  constructor(physics: PhysicsWorld) {
    const startedAt = performance.now();
    this.cols = Math.floor(NAV_HALF_X * 2 / CELL);
    this.rows = Math.floor(NAV_HALF_Z * 2 / CELL);
    this.walkable = new Uint8Array(this.cols * this.rows);
    this.heights = new Float32Array(this.cols * this.rows);

    const maxSlope = Math.tan(playerConfig.maxSlopeClimb * DEG2RAD);
    // A capsule a little slimmer than a character, so bots aren't refused
    // gaps they could actually squeeze through.
    const probe = new physics.api.Ball(playerConfig.radius * 0.85);
    const rotation = { x: 0, y: 0, z: 0, w: 1 };

    let count = 0;
    for (let row = 0; row < this.rows; row++) {
      for (let col = 0; col < this.cols; col++) {
        const index = row * this.cols + col;
        const { x, z } = this.cellCenter(col, row);
        const h = heightAt(x, z);
        this.heights[index] = h;

        if (h < WATER_Y + SHORE_MARGIN) continue;
        // slopeAt returns gradient/(gradient+1); undo that to compare to a tangent.
        const s = slopeAt(x, z);
        if (s / (1 - s) > maxSlope) continue;

        // Sample several points across the cell, not just its centre.
        // An obstacle thinner than a cell otherwise slips between samples —
        // the fountain's basin wall is 0.6m against a 2m grid, and a
        // centre-only probe left the basin interior connected to the plaza, so
        // bots would path straight through the stonework.
        let blocked = false;
        for (const [ox, oz] of CELL_SAMPLES) {
          if (physics.w.intersectionWithShape(
                { x: x + ox, y: h + 0.9, z: z + oz }, rotation, probe)) {
            blocked = true;
            break;
          }
        }
        if (blocked) continue;

        this.walkable[index] = 1;
        count++;
      }
    }

    this.walkableCount = count;
    this.buildMs = performance.now() - startedAt;
  }

  /**
   * Drops every cell not reachable on foot from `seed`.
   *
   * Two things make this necessary. Rapier trimesh colliders are hollow
   * surfaces, so a probe fully inside a solid prop — the fountain pedestal, say
   * — touches nothing and the cell is wrongly marked walkable. And the arena
   * has genuine pockets: enclosed courtyards, islands, ledges reachable only by
   * a fall. Both produce cells a bot can be sent to but never reach, where it
   * would path-fail and stand still forever.
   *
   * Flood-filling from a known-good cell converts "looks standable" into
   * "actually reachable", which is the property a navgrid is supposed to have.
   * Returns the number of cells removed.
   */
  pruneUnreachable(seedX: number, seedZ: number): number {
    const seed = this.nearestWalkable(seedX, seedZ);
    if (!seed) return 0;

    const start = this.toCell(seed.x, seed.z);
    const startIndex = start.row * this.cols + start.col;
    const reached = new Uint8Array(this.cols * this.rows);
    const queue = new Int32Array(this.cols * this.rows);
    let head = 0;
    let tail = 0;

    reached[startIndex] = 1;
    queue[tail++] = startIndex;

    while (head < tail) {
      const index = queue[head++]!;
      const col = index % this.cols;
      const row = Math.floor(index / this.cols);

      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dc === 0 && dr === 0) continue;
          const nc = col + dc;
          const nr = row + dr;
          if (!this.inBounds(nc, nr)) continue;
          const neighbour = nr * this.cols + nc;
          if (reached[neighbour] || this.walkable[neighbour] !== 1) continue;
          // Same traversal rule A* uses, or the fill would claim edges the
          // pathfinder will later refuse.
          if (!this.canTraverse(index, neighbour, dc, dr)) continue;
          if (dc !== 0 && dr !== 0) {
            if (
              this.walkable[row * this.cols + nc] !== 1 ||
              this.walkable[nr * this.cols + col] !== 1
            ) {
              continue;
            }
          }
          reached[neighbour] = 1;
          queue[tail++] = neighbour;
        }
      }
    }

    let removed = 0;
    for (let i = 0; i < this.walkable.length; i++) {
      if (this.walkable[i] === 1 && !reached[i]) {
        this.walkable[i] = 0;
        removed++;
      }
    }
    this.reachableCount = tail;
    return removed;
  }

  /** Cells reachable from the seed, after pruning. */
  reachableCount = 0;

  /**
   * Whether a bot can move between two adjacent cells.
   *
   * A rise is traversable if it is either a small enough *step* to be
   * auto-stepped, or a shallow enough *slope* to be walked. Testing only the
   * step height treats a ramp as a wall: the Mall rises 4.2m over 8m, which is
   * 1.05m per 2m cell — a comfortable 28 degree walk, but nearly three times
   * the autostep height, so the whole southern half of the park was
   * unreachable.
   */
  private canTraverse(from: number, to: number, dc: number, dr: number): boolean {
    const rise = Math.abs(this.heights[to]! - this.heights[from]!);
    if (rise <= MAX_STEP) return true;
    const run = Math.hypot(dc, dr) * CELL;
    return rise / run <= MAX_SLOPE_TAN;
  }

  private cellCenter(col: number, row: number): { x: number; z: number } {
    return {
      x: -NAV_HALF_X + (col + 0.5) * CELL,
      z: -NAV_HALF_Z + (row + 0.5) * CELL,
    };
  }

  private toCell(x: number, z: number): { col: number; row: number } {
    return {
      col: Math.floor((x + NAV_HALF_X) / CELL),
      row: Math.floor((z + NAV_HALF_Z) / CELL),
    };
  }

  private inBounds(col: number, row: number): boolean {
    return col >= 0 && col < this.cols && row >= 0 && row < this.rows;
  }

  isWalkable(x: number, z: number): boolean {
    const { col, row } = this.toCell(x, z);
    if (!this.inBounds(col, row)) return false;
    return this.walkable[row * this.cols + col] === 1;
  }

  /** Ground height at a position — the same function the terrain mesh used. */
  groundAt(x: number, z: number): number {
    return heightAt(x, z);
  }

  /** Nearest walkable cell centre to a point, searching outward. Null if none. */
  nearestWalkable(x: number, z: number, maxRings = 12): Vector3 | null {
    const { col, row } = this.toCell(x, z);
    for (let ring = 0; ring <= maxRings; ring++) {
      for (let dr = -ring; dr <= ring; dr++) {
        for (let dc = -ring; dc <= ring; dc++) {
          // Only the perimeter of each ring; the interior was covered already.
          if (ring > 0 && Math.abs(dr) !== ring && Math.abs(dc) !== ring) continue;
          const c = col + dc;
          const r = row + dr;
          if (!this.inBounds(c, r)) continue;
          if (this.walkable[r * this.cols + c] !== 1) continue;
          const center = this.cellCenter(c, r);
          return new Vector3(center.x, this.heights[r * this.cols + c]!, center.z);
        }
      }
    }
    return null;
  }

  randomWalkablePoint(rng: Rng, attempts = 60): Vector3 | null {
    for (let i = 0; i < attempts; i++) {
      const col = rng.int(0, this.cols);
      const row = rng.int(0, this.rows);
      if (this.walkable[row * this.cols + col] !== 1) continue;
      const center = this.cellCenter(col, row);
      return new Vector3(center.x, this.heights[row * this.cols + col]!, center.z);
    }
    return null;
  }

  /**
   * A* between two world positions, returned as smoothed waypoints.
   * Null when no route exists.
   */
  findPath(from: Vector3, to: Vector3): Vector3[] | null {
    const start = this.toCell(from.x, from.z);
    const goalPoint = this.isWalkable(to.x, to.z)
      ? to
      : this.nearestWalkable(to.x, to.z);
    if (!goalPoint) return null;
    const goal = this.toCell(goalPoint.x, goalPoint.z);

    if (!this.inBounds(start.col, start.row) || !this.inBounds(goal.col, goal.row)) return null;
    const startIndex = start.row * this.cols + start.col;
    const goalIndex = goal.row * this.cols + goal.col;
    if (this.walkable[goalIndex] !== 1) return null;

    const open = new Map<number, Node>();
    const closed = new Set<number>();
    const heuristic = (index: number) => {
      const col = index % this.cols;
      const row = Math.floor(index / this.cols);
      return Math.hypot(col - goal.col, row - goal.row) * CELL;
    };

    open.set(startIndex, { index: startIndex, g: 0, f: heuristic(startIndex), parent: -1 });
    const cameFrom = new Map<number, number>();

    // Bounded so a hopeless query can't stall a frame.
    let expansions = 0;
    const maxExpansions = this.cols * this.rows;

    while (open.size > 0 && expansions++ < maxExpansions) {
      let current: Node | undefined;
      for (const node of open.values()) {
        if (!current || node.f < current.f) current = node;
      }
      if (!current) break;

      if (current.index === goalIndex) {
        return this.reconstruct(cameFrom, goalIndex, from);
      }

      open.delete(current.index);
      closed.add(current.index);

      const col = current.index % this.cols;
      const row = Math.floor(current.index / this.cols);
      const height = this.heights[current.index]!;

      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dc === 0 && dr === 0) continue;
          const nc = col + dc;
          const nr = row + dr;
          if (!this.inBounds(nc, nr)) continue;
          const neighbour = nr * this.cols + nc;
          if (this.walkable[neighbour] !== 1 || closed.has(neighbour)) continue;

          if (!this.canTraverse(current.index, neighbour, dc, dr)) continue;
          const rise = Math.abs(this.heights[neighbour]! - height);

          // Diagonals may not cut a corner between two blocked cells.
          if (dc !== 0 && dr !== 0) {
            if (
              this.walkable[row * this.cols + nc] !== 1 ||
              this.walkable[nr * this.cols + col] !== 1
            ) {
              continue;
            }
          }

          const step = Math.hypot(dc, dr) * CELL + rise * 1.5;
          const g = current.g + step;
          const existing = open.get(neighbour);
          if (existing && existing.g <= g) continue;

          cameFrom.set(neighbour, current.index);
          open.set(neighbour, { index: neighbour, g, f: g + heuristic(neighbour), parent: current.index });
        }
      }
    }

    return null;
  }

  private reconstruct(
    cameFrom: Map<number, number>,
    goalIndex: number,
    from: Vector3,
  ): Vector3[] {
    const cells: number[] = [goalIndex];
    let cursor = goalIndex;
    while (cameFrom.has(cursor)) {
      cursor = cameFrom.get(cursor)!;
      cells.push(cursor);
    }
    cells.reverse();

    const points = cells.map((index) => {
      const col = index % this.cols;
      const row = Math.floor(index / this.cols);
      const center = this.cellCenter(col, row);
      return new Vector3(center.x, this.heights[index]!, center.z);
    });
    points[0] = from.clone();

    return this.smooth(points);
  }

  /**
   * String-pulling. Grid paths are staircases; skipping any waypoint that can be
   * reached directly turns them back into the straight lines a person walks.
   */
  private smooth(points: Vector3[]): Vector3[] {
    if (points.length <= 2) return points;
    const result: Vector3[] = [points[0]!];
    let anchor = 0;

    for (let i = 2; i < points.length; i++) {
      if (!this.hasClearLine(points[anchor]!, points[i]!)) {
        result.push(points[i - 1]!);
        anchor = i - 1;
      }
    }
    result.push(points[points.length - 1]!);
    return result;
  }

  /** True if every sample along a straight line between two points is walkable. */
  private hasClearLine(a: Vector3, b: Vector3): boolean {
    const distance = Math.hypot(b.x - a.x, b.z - a.z);
    const steps = Math.ceil(distance / (CELL * 0.5));
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const x = a.x + (b.x - a.x) * t;
      const z = a.z + (b.z - a.z) * t;
      if (!this.isWalkable(x, z)) return false;
    }
    return true;
  }
}
