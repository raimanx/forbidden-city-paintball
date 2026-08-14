import { Group, Material, Mesh, BoxGeometry, SphereGeometry, Vector3 } from 'three';
import type { NavGrid } from '../ai/NavGrid';
import type { CharactersSystem } from '../character/CharactersSystem';
import { match as matchConfig, paintColors } from '../core/Config';
import { Rng } from '../core/Random';
import type { GameContext, System } from '../core/System';
import { createCelMaterial } from '../render/CelMaterial';
import { LOOT_SPOTS } from '../world/CityLayout';
import { grant, type MatchState } from './MatchState';
import type { PlayerState } from './PlayerState';

/**
 * Where the crate is, for anything that needs to go and get it.
 *
 * Bots read this directly rather than being told over the bus, because "is
 * there paint out there, and where" is a question they ask every step while
 * deciding what to do, not an event they react to once.
 */
export interface LootState {
  /** Crate position, or null when there is no crate out. */
  position: Vector3 | null;
  /** Rounds it is holding. */
  rounds: number;
}

export function createLootState(): LootState {
  return { position: null, rounds: 0 };
}

/** Bob height and rate, so the crate reads as a pickup rather than scenery. */
const BOB_HEIGHT = 0.09;
const BOB_RATE = 1.7;
const SPIN_RATE = 0.5;

/**
 * The paint crate: one per round, hidden somewhere different each time.
 *
 * Pickup is a distance check against seven characters on the fixed step, not a
 * sensor collider — a Rapier sensor plus an intersection query is a lot of
 * machinery to answer a question that costs seven subtractions, and the crate
 * deliberately has no collider at all so shots pass through it rather than
 * being blocked by a thing you are meant to walk into.
 */
export class LootSystem implements System {
  readonly name = 'loot';

  private group?: Group;
  /** Held from init, so a crate can be placed outside the step. See respawn(). */
  private ctx?: GameContext;
  private readonly base = new Vector3();
  /** Counts down to a respawn; only ever set when respawning is enabled. */
  private respawnTimer = 0;
  /** So the same hiding place is never picked twice running. */
  private lastSpotIndex = -1;
  private readonly rng: Rng;

  constructor(
    private readonly match: MatchState,
    private readonly loot: LootState,
    private readonly playerState: PlayerState,
    private readonly characters: CharactersSystem,
    /**
     * Its own seed, never `ctx.rng`. That sequence has to stay reproducible
     * draw-for-draw — see the comment in `Character.takeHit` — and "a different
     * place each game" is the one thing here that must *not* be reproducible.
     */
    seed: number,
  ) {
    this.rng = new Rng(seed);
  }

  init(ctx: GameContext): void {
    if (this.match.sandbox) return;

    this.ctx = ctx;
    this.group = this.buildCrate();
    ctx.scene.add(this.group);
    this.spawn(ctx);
  }

  /**
   * Puts a crate back immediately, at a new hiding place.
   *
   * Public because a fresh round needs one and the match suite needs one; the
   * respawn *timer* is a different thing and stays private.
   */
  respawn(): void {
    if (!this.ctx || this.match.sandbox) return;
    this.respawnTimer = 0;
    this.spawn(this.ctx);
  }

  fixedUpdate(dt: number, ctx: GameContext): void {
    if (this.match.sandbox) return;

    if (!this.loot.position) {
      if (matchConfig.lootRespawnSeconds <= 0) return;
      this.respawnTimer -= dt;
      if (this.respawnTimer <= 0) this.spawn(ctx);
      return;
    }

    this.checkPickup(ctx);
  }

  update(_dt: number, _alpha: number, ctx: GameContext): void {
    const group = this.group;
    if (!group?.visible) return;
    // Wall clock, not simulated time: this is decoration, and it should keep
    // turning at the same rate whatever the simulation is doing.
    group.position.y = this.base.y + BOB_HEIGHT * (1 + Math.sin(ctx.elapsed * BOB_RATE)) * 0.5;
    group.rotation.y = ctx.elapsed * SPIN_RATE;
  }

  /** Places the crate at a fresh hiding place. */
  private spawn(ctx: GameContext): void {
    const nav = this.characters.navGrid;
    const group = this.group;
    if (!nav || !group) return;

    const spot = this.pickSpot(nav);
    if (!spot) return;

    this.base.copy(spot.point);
    group.position.copy(this.base);
    group.visible = true;
    this.loot.position = this.base.clone();
    this.loot.rounds = matchConfig.lootAmmo;

    ctx.events.emit('loot:spawned', {
      position: this.loot.position.clone(),
      rounds: this.loot.rounds,
    });
  }

  /**
   * Chooses a hiding place and snaps it to standable ground.
   *
   * A spot whose nearest walkable cell is far away was authored somewhere that
   * is no longer ground — in the lake, or inside a prop — so it is skipped
   * rather than silently relocated to the edge of the water.
   */
  private pickSpot(nav: NavGrid): { point: Vector3; where: string } | null {
    // A random start walked circularly, rather than a shuffle: the first choice
    // is uniform, which is all that matters, and the fallback order is then
    // fixed so a round with several unusable spots still behaves predictably.
    const count = LOOT_SPOTS.length;
    const start = this.rng.int(0, count);
    for (let step = 0; step < count; step++) {
      const index = (start + step) % count;
      if (index === this.lastSpotIndex && count > 1) continue;
      const spot = LOOT_SPOTS[index]!;
      const walkable = nav.nearestWalkable(spot.x, spot.z, 3);
      if (!walkable) continue;
      if (Math.hypot(walkable.x - spot.x, walkable.z - spot.z) > 4) continue;
      this.lastSpotIndex = index;
      return { point: walkable, where: spot.where };
    }
    return null;
  }

  /** First character within reach takes the lot. */
  private checkPickup(ctx: GameContext): void {
    const position = this.loot.position;
    if (!position) return;

    const radius = matchConfig.lootPickupRadius;
    let takerId: string | null = null;

    if (this.playerState.position.distanceTo(position) <= radius) {
      takerId = 'player';
    } else {
      for (const bot of this.characters.allBots) {
        if (bot.position.distanceTo(position) <= radius) {
          takerId = bot.id;
          break;
        }
      }
    }
    if (!takerId) return;

    const rounds = this.loot.rounds;
    grant(this.match, takerId, rounds);

    ctx.events.emit('loot:taken', { characterId: takerId, rounds, position: position.clone() });

    this.loot.position = null;
    this.loot.rounds = 0;
    if (this.group) this.group.visible = false;
    this.respawnTimer = matchConfig.lootRespawnSeconds;
  }

  /**
   * A crate of paint: a box, a lid, and a few loose balls sitting on top.
   *
   * No collider. It is something to walk into, and a collider would make it
   * something to take cover behind and to block shots — neither of which a
   * pickup should do.
   */
  private buildCrate(): Group {
    const group = new Group();

    const body = new Mesh(
      new BoxGeometry(0.52, 0.36, 0.52),
      createCelMaterial({ color: 0x9c6f5c, rimStrength: 0.25 }),
    );
    body.position.y = 0.18;
    body.castShadow = true;
    body.receiveShadow = true;
    group.add(body);

    const lid = new Mesh(
      new BoxGeometry(0.58, 0.07, 0.58),
      createCelMaterial({ color: 0x6f4b3c, rimStrength: 0.25 }),
    );
    lid.position.y = 0.39;
    lid.castShadow = true;
    group.add(lid);

    // Loose paintballs on the lid, in the match's own colours — the one part of
    // the crate that says what is in it from a distance.
    const ballGeometry = new SphereGeometry(0.07, 10, 8);
    const offsets: Array<[number, number]> = [
      [-0.12, -0.08],
      [0.1, -0.1],
      [0.02, 0.11],
      [0.15, 0.06],
    ];
    offsets.forEach(([x, z], index) => {
      const ball = new Mesh(
        ballGeometry,
        createCelMaterial({
          color: paintColors[index % paintColors.length]!,
          rimStrength: 0.5,
          rimPower: 2,
        }),
      );
      ball.position.set(x, 0.47, z);
      ball.castShadow = true;
      group.add(ball);
    });

    return group;
  }

  dispose(): void {
    const group = this.group;
    if (!group) return;
    group.removeFromParent();
    group.traverse((object) => {
      if (!(object instanceof Mesh)) return;
      object.geometry.dispose();
      // The balls share one geometry, so this disposes it several times, which
      // three tolerates. The materials are one each.
      const material: Material | Material[] = object.material;
      if (Array.isArray(material)) material.forEach((m) => m.dispose());
      else material.dispose();
    });
    this.group = undefined;
  }
}
