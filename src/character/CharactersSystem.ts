import { Vector3 } from 'three';
import { player as playerConfig } from '../core/Config';
import type { GameContext, System } from '../core/System';
import { Bot, type BotTarget } from '../ai/Bot';
import { NavGrid } from '../ai/NavGrid';
import { PERSONALITIES } from '../ai/Personality';
import type { BallisticsSystem } from '../gameplay/Ballistics';
import type { LootState } from '../gameplay/LootSystem';
import { isPlaying, type MatchState } from '../gameplay/MatchState';
import type { PlayerState } from '../gameplay/PlayerState';
import { SplatAtlas } from '../paint/SplatAtlas';
import { Character } from './Character';
import type { CharacterRegistry } from './CharacterRegistry';
import type { AnimationInput } from './CharacterAnimator';

export interface BotSpec {
  id: string;
  position: Vector3;
  colorIndex: number;
  /** Index into PERSONALITIES. */
  personality: number;
}

/**
 * Owns every character in the match and routes hits to them.
 *
 * The player's character is posed from PlayerState; standing dummies exist so
 * character paint and hit routing are exercisable before the bots arrive in
 * phase 6, and they become the bots' bodies when they do.
 */
export class CharactersSystem implements System {
  readonly name = 'characters';

  private player?: Character;
  private bots: Bot[] = [];
  private splatAtlas?: SplatAtlas;
  private nav?: NavGrid;
  /** Where everyone stood at boot, so a restart can put them back. */
  private readonly spawns = new Map<string, Vector3>();
  /** Rebuilt each step; bots read it to find someone to shoot at. */
  private targets: BotTarget[] = [];

  private readonly input: AnimationInput = {
    speed: 0,
    runSpeed: playerConfig.sprintSpeed,
    grounded: true,
    crouching: false,
    aiming: false,
    verticalVelocity: 0,
    moveLocalX: 0,
    moveLocalY: 0,
    aimPitch: 0,
  };

  constructor(
    private readonly state: PlayerState,
    private readonly characters: CharacterRegistry,
    private readonly ballistics: BallisticsSystem,
    private readonly sharedAtlas: SplatAtlas,
    private readonly match: MatchState,
    private readonly loot: LootState,
    private readonly botSpecs: BotSpec[] = [],
    /**
     * Only used to put the player back at their spawn between rounds. Optional
     * because the test course builds this system without one.
     */
    private readonly controller?: { teleport(feetPosition: Vector3): void },
  ) {}

  init(ctx: GameContext): void {
    // One atlas shared by every character's paint stamper, and with world
    // paint and the lens splash too — the splat shapes are identical, only the
    // tint differs.
    this.splatAtlas = this.sharedAtlas;

    this.player = new Character(
      { id: 'player', colorIndex: 0 },
      ctx,
      this.splatAtlas,
    );
    // The player's collider is the character controller's capsule, created in
    // phase 1 and published on PlayerState.
    if (this.state.collider) {
      this.player.attachCollider(this.state.collider);
      this.characters.register(this.state.collider.handle, 'player');
    }

    // Built after the arena, so every prop collider is already in the world.
    // Existing is not enough, though: scene queries only see colliders that
    // were present at the last step, so the world must be stepped first or the
    // grid is computed against an empty park.
    ctx.physics.refreshQueries();
    this.nav = new NavGrid(ctx.physics);
    // Seeded from the player spawn, so "walkable" means "reachable from where
    // the player starts" — which is the only definition that helps a bot.
    this.nav.pruneUnreachable(this.state.position.x, this.state.position.z);

    for (const spec of this.botSpecs) {
      const character = new Character(
        { id: spec.id, colorIndex: spec.colorIndex },
        ctx,
        this.splatAtlas,
      );
      // Drop the spawn onto the ground, and onto a cell that is actually
      // walkable and actually *reachable* — a bot spawned inside a hall, or in
      // a sealed courtyard, would never path anywhere.
      //
      // The fallback matters more here than it did in the park. The park was
      // open ground with props on it, so a hint always had walkable cells a few
      // metres away; this compound is four fifths building and a hint can land
      // in a courtyard the flood fill has pruned entirely, where searching
      // outward finds nothing at all within its twelve rings. Somewhere random
      // and reachable is a far better answer than standing still in the dark
      // for the whole round, which is what the old code did.
      const grounded =
        this.nav.nearestWalkable(spec.position.x, spec.position.z) ??
        this.nav.randomWalkablePoint(ctx.rng, 400) ??
        new Vector3(spec.position.x, this.nav.groundAt(spec.position.x, spec.position.z), spec.position.z);

      const bot = new Bot(spec.id, PERSONALITIES[spec.personality % PERSONALITIES.length]!,
                          character, grounded, ctx, this.match, this.loot);
      this.characters.register(bot.collider.handle, spec.id);
      this.spawns.set(spec.id, grounded.clone());
      this.bots.push(bot);
    }

    // Captured after the arena is built and before anything has moved.
    this.spawns.set('player', this.state.position.clone());

    ctx.events.on('hit:character', (event) => this.onHit(event, ctx));
  }

  private onHit(
    event: {
      targetId: string;
      shooterId: string;
      color: number;
      point: Vector3;
      normal: Vector3;
      impactSpeed: number;
    },
    ctx: GameContext,
  ): void {
    const target = this.find(event.targetId);
    if (!target || !this.splatAtlas) return;
    // Nothing counts after the whistle. Shots already in the air when the clock
    // ran out land on the world and paint it as usual, but a person they reach
    // is not tagged — the alternative is a scoreboard that keeps moving after
    // it has been shown as final.
    if (!isPlaying(this.match)) return;

    const registered = target.takeHit(
      event.point,
      event.normal,
      event.color,
      event.impactSpeed,
      ctx.rng,
      this.splatAtlas.variants,
    );
    if (!registered) return;

    const shooter = this.find(event.shooterId);
    if (shooter && shooter !== target) shooter.hitsGiven++;

    // Reactions: the target scurries, the shooter may celebrate.
    this.bots.find((b) => b.id === event.targetId)?.onHit(ctx.rng);
    this.bots.find((b) => b.id === event.shooterId)?.onScored(ctx.rng);

    ctx.events.emit('score:changed', {
      characterId: target.id,
      hitsTaken: target.hitsTaken,
      hitsGiven: target.hitsGiven,
    });
  }

  private find(id: string): Character | undefined {
    if (id === 'player') return this.player;
    return this.bots.find((b) => b.id === id)?.character;
  }

  fixedUpdate(dt: number, ctx: GameContext): void {
    // Taunt is an input, so it belongs on the fixed step with the rest.
    if (ctx.input.wasPressed('taunt')) this.player?.animator.triggerTaunt();

    // Grace windows tick in simulation time.
    this.player?.tickGameplay(dt);
    for (const bot of this.bots) bot.character.tickGameplay(dt);

    if (!this.nav) return;

    // One shared candidate list per step, rather than each bot rebuilding it.
    this.targets.length = 0;
    this.targets.push({
      id: 'player',
      position: PLAYER_CHEST.set(
        this.state.position.x,
        this.state.position.y + 1.25,
        this.state.position.z,
      ),
      collider: this.state.collider ?? undefined,
    });
    for (const bot of this.bots) {
      this.targets.push({ id: bot.id, position: bot.chest.clone(), collider: bot.collider });
    }

    for (const bot of this.bots) {
      bot.fixedUpdate(dt, ctx, this.nav, this.targets, this.bots, this.ballistics);
    }
  }

  update(dt: number, _alpha: number, ctx: GameContext): void {
    const player = this.player;
    if (!player) return;

    // Once the round is over the figures belong to the results stage, which owns
    // their position and facing. Still animated, so they breathe and settle
    // rather than freezing mid-stride — just not moved.
    if (!isPlaying(this.match)) {
      for (const character of this.allCharacters) character.update(dt, IDLE_POSE);
      return;
    }

    const { state } = this;
    player.setTransform(state.renderPosition, state.bodyYaw);
    player.setOpacity(state.avatarOpacity);

    // Movement direction expressed in the body's own frame, so the animator can
    // tell walking forward from sidestepping.
    const forwardX = -Math.sin(state.bodyYaw);
    const forwardZ = -Math.cos(state.bodyYaw);
    const rightX = Math.cos(state.bodyYaw);
    const rightZ = -Math.sin(state.bodyYaw);
    const vx = state.velocity.x;
    const vz = state.velocity.z;
    const speed = Math.hypot(vx, vz);
    const inv = speed > 0.001 ? 1 / speed : 0;

    this.input.speed = speed;
    this.input.grounded = state.grounded;
    this.input.crouching = state.crouching;
    this.input.aiming = state.aiming;
    this.input.verticalVelocity = state.velocity.y;
    this.input.moveLocalX = (vx * rightX + vz * rightZ) * inv;
    this.input.moveLocalY = (vx * forwardX + vz * forwardZ) * inv;
    this.input.aimPitch = state.pitch;

    player.update(dt, this.input);

    for (const bot of this.bots) {
      bot.character.update(dt, bot.animationInput);
    }

    void ctx;
  }

  /**
   * Wipes the scoreboard and the paint everybody is wearing, for a new round.
   * The park keeps its own paint — see `MatchSystem.restart`.
   */
  resetScores(): void {
    for (const character of this.allCharacters) {
      character.hitsTaken = 0;
      character.hitsGiven = 0;
      character.paint.clear();
    }
  }

  /**
   * Puts everybody back where the round started.
   *
   * Without this a restart left seven people standing wherever the whistle
   * caught them — which for the player is usually face-down in the fight that
   * just ended, next to the three bots who were shooting at them, with a fresh
   * five minutes on the clock. Resetting the scoreboard but not the board is
   * half a restart.
   */
  respawnAll(): void {
    const playerSpawn = this.spawns.get('player');
    if (playerSpawn && this.controller) {
      this.controller.teleport(playerSpawn);
      this.state.velocity.set(0, 0, 0);
    }
    for (const bot of this.bots) {
      const spawn = this.spawns.get(bot.id);
      if (spawn) bot.respawn(spawn);
    }
  }

  /** Triggers the player's shooting pose. Called when a shot is fired. */
  onPlayerShot(): void {
    this.player?.animator.triggerShot();
  }

  get playerCharacter(): Character | undefined {
    return this.player;
  }

  get allCharacters(): Character[] {
    const bots = this.bots.map((b) => b.character);
    return this.player ? [this.player, ...bots] : bots;
  }

  get allBots(): Bot[] {
    return this.bots;
  }

  get navGrid(): NavGrid | undefined {
    return this.nav;
  }

  dispose(): void {
    this.player?.dispose();
    for (const bot of this.bots) bot.character.dispose();
    this.bots = [];
  }
}

const PLAYER_CHEST = new Vector3();

/** Standing still, for the results line-up. Shared: nothing writes to it. */
const IDLE_POSE: AnimationInput = {
  speed: 0,
  runSpeed: playerConfig.sprintSpeed,
  grounded: true,
  crouching: false,
  aiming: false,
  verticalVelocity: 0,
  moveLocalX: 0,
  moveLocalY: 0,
  aimPitch: 0,
};
