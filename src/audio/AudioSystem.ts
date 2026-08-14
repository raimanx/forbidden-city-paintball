import { Vector3 } from 'three';
import type { GameContext, System } from '../core/System';
import { GOLDEN_RIVER } from '../world/CityLayout';
import type { PlayerState } from '../gameplay/PlayerState';
import { AudioEngine } from './AudioEngine';
import { Synth } from './Synth';

/** Metres of travel between footfalls at a walk. */
const STRIDE_LENGTH = 1.9;
/** Pentatonic scale in Hz — no semitones, so any two notes agree. */
const SCALE = [261.63, 293.66, 329.63, 392.0, 440.0, 523.25, 587.33, 659.25];

/**
 * Turns game events into sound, and keeps the park murmuring underneath.
 *
 * The context cannot be created until the player has interacted with the page,
 * so everything here is inert until the same click that grants pointer lock
 * also unlocks audio.
 */
export class AudioSystem implements System {
  readonly name = 'audio';

  readonly engine = new AudioEngine();
  private synth?: Synth;

  private wind?: { source: AudioBufferSourceNode; filter: BiquadFilterNode; gain: GainNode };
  private nextBirdAt = 0;
  private nextNoteAt = 0;
  private nextWaterAt = 0;
  /** The round started before audio was unlocked; blow the whistle on unlock. */
  private pendingStartWhistle = false;
  private strideAccumulator = 0;
  private scaleIndex = 0;

  private readonly listenerRight = new Vector3();
  private readonly lastPosition = new Vector3();
  private hasLastPosition = false;

  constructor(private readonly state: PlayerState) {}

  init(ctx: GameContext): void {
    this.synth = new Synth(this.engine);

    // The canvas click that grants pointer lock is also the user gesture the
    // browser requires before any audio may start.
    ctx.events.on('input:lockChanged', ({ locked }) => {
      if (locked) void this.start(ctx);
    });

    ctx.events.on('shot:fired', ({ origin, shooterId }) => {
      // Our own shot is not positioned — it happens at the ear.
      if (shooterId === 'player') this.synth?.shoot(0.8, 0);
      else this.playAt(origin, (g, p) => this.synth?.shoot(g * 0.9, p));
    });

    ctx.events.on('hit:world', ({ point, impactSpeed }) => {
      this.playAt(point, (g, p) =>
        this.synth?.splat(g, p, 0.85 + Math.min(impactSpeed, 42) / 60));
    });

    ctx.events.on('hit:character', ({ point, targetId, shooterId }) => {
      this.playAt(point, (g, p) => this.synth?.splat(g * 1.15, p, 1.15));
      if (targetId === 'player') this.synth?.tagged(1);
      else if (shooterId === 'player') this.synth?.scored(1);
    });

    ctx.events.on('weapon:dry', ({ shooterId }) => {
      // Only the player's. Bots never emit this — they stop shooting rather
      // than pull an empty trigger — and an off-screen click would read as a
      // shot the player then went looking for.
      if (shooterId === 'player') this.synth?.dryFire(0.9, 0);
    });

    // The two moments the round has, and the only two that were silent.
    // `match:started` fires during init, before the audio context has been
    // unlocked by a click, so the opening whistle is scheduled by `start()`
    // instead — every other beat in the game is audible from the first frame
    // and the one that says "go" cannot be the exception.
    ctx.events.on('match:started', () => {
      if (this.engine.isReady) this.synth?.whistle(0.9, true);
      else this.pendingStartWhistle = true;
    });
    ctx.events.on('match:ended', () => {
      // Two blasts, falling: unmistakably the end of something.
      this.synth?.whistle(0.95, false, 0.32);
      window.setTimeout(() => this.synth?.whistle(0.95, false, 0.8), 380);
    });

    ctx.events.on('loot:taken', ({ characterId, position }) => {
      if (characterId === 'player') {
        // Two bells, a fifth apart: unmistakably a reward, and it needs no new
        // sound in the set.
        this.synth?.bell(784, 0.42, 0.8);
        this.synth?.bell(1175, 0.3, 1.0);
      } else {
        // Somebody else got there — audible, and placed, so you know roughly
        // where the paint you were looking for just went.
        this.playAt(position, (g, p) => this.synth?.footstep(g * 1.4, p, 1.8));
      }
    });
  }

  private async start(ctx: GameContext): Promise<void> {
    await this.engine.unlock();
    if (!this.engine.isReady) return;
    this.startWind();
    this.nextBirdAt = ctx.elapsed + 1.5;
    this.nextNoteAt = ctx.elapsed + 4;
    this.nextWaterAt = ctx.elapsed + 0.5;
    if (this.pendingStartWhistle) {
      this.pendingStartWhistle = false;
      this.synth?.whistle(0.9, true);
    }
  }

  /** A continuous filtered-noise bed, slowly opening and closing. */
  private startWind(): void {
    const context = this.engine.ctx;
    const bus = this.engine.busNode('ambient');
    const source = this.engine.createNoiseSource();
    if (!context || !bus || !source || this.wind) return;

    const filter = context.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 420;
    filter.Q.value = 0.4;

    const gain = context.createGain();
    gain.gain.value = 0.22;

    source.connect(filter);
    filter.connect(gain);
    gain.connect(bus);
    source.start();

    this.wind = { source, filter, gain };
  }

  update(dt: number, _alpha: number, ctx: GameContext): void {
    if (!this.engine.isReady || !this.synth) return;

    // Listener basis from the camera, for panning.
    ctx.camera.getWorldDirection(FORWARD);
    this.listenerRight.set(-FORWARD.z, 0, FORWARD.x).normalize();

    this.updateFootsteps(ctx);
    this.updateAmbience(ctx);

    // Breathe the wind filter, so the bed never sits perfectly still.
    if (this.wind) {
      const target = 320 + Math.sin(ctx.elapsed * 0.11) * 150 + Math.sin(ctx.elapsed * 0.037) * 90;
      this.wind.filter.frequency.setTargetAtTime(target, this.engine.now, 0.4);
    }

    void dt;
  }

  /** Footfalls are driven by distance travelled, not by a timer. */
  private updateFootsteps(ctx: GameContext): void {
    const position = this.state.renderPosition;
    if (!this.hasLastPosition) {
      this.lastPosition.copy(position);
      this.hasLastPosition = true;
      return;
    }

    if (this.state.grounded) {
      const travelled = Math.hypot(
        position.x - this.lastPosition.x,
        position.z - this.lastPosition.z,
      );
      // A crouched shuffle covers ground more quietly and more often.
      const stride = this.state.crouching ? STRIDE_LENGTH * 0.6 : STRIDE_LENGTH;
      this.strideAccumulator += travelled;
      if (this.strideAccumulator >= stride) {
        this.strideAccumulator = 0;
        const volume = this.state.crouching ? 0.35 : this.state.sprinting ? 1 : 0.7;
        this.synth?.footstep(volume, 0, 0.85 + ctx.rng.range(0, 0.35));
      }
    }
    this.lastPosition.copy(position);
  }

  /** Schedules birdsong and the occasional bell. */
  private updateAmbience(ctx: GameContext): void {
    if (ctx.elapsed >= this.nextBirdAt) {
      // Birds live in the cypresses of the Imperial Garden and on the roofs, so
      // place calls out at a distance and off to one side rather than at the
      // listener.
      const pan = ctx.rng.range(-0.9, 0.9);
      const gain = ctx.rng.range(0.18, 0.5);
      this.synth?.birdCall(gain, pan, ctx.rng.range(1600, 3200));
      this.nextBirdAt = ctx.elapsed + ctx.rng.range(1.8, 6.5);
    }

    // The Golden Water River, heard across the outer court. Scheduled rather
    // than looped: a one-shot wash every second or so overlaps into a
    // continuous bed, and it costs nothing when nobody is near enough to hear
    // it. Distance is measured to the *channel*, not to a point, because the
    // river is 90m of it running the width of the courtyard.
    if (ctx.elapsed >= this.nextWaterAt) {
      const position = this.state.renderPosition;
      const distance = Math.abs(position.z - GOLDEN_RIVER.centerZ)
        + Math.max(0, Math.abs(position.x) - GOLDEN_RIVER.halfSpan);
      if (distance < RIVER_AUDIBLE) {
        const near = 1 - distance / RIVER_AUDIBLE;
        RIVER_POSITION.set(position.x, 1.0, GOLDEN_RIVER.centerZ);
        this.playAt(RIVER_POSITION, (g, p) => this.synth?.water(g * near * 0.5, p));
      }
      this.nextWaterAt = ctx.elapsed + ctx.rng.range(0.8, 1.3);
    }

    if (ctx.elapsed >= this.nextNoteAt) {
      // A wandering pentatonic line: steps of at most a third keep it calm.
      this.scaleIndex = Math.max(
        0,
        Math.min(SCALE.length - 1, this.scaleIndex + ctx.rng.int(-2, 3)),
      );
      this.synth?.bell(SCALE[this.scaleIndex]!, ctx.rng.range(0.5, 0.9), ctx.rng.range(2.0, 3.6));
      this.nextNoteAt = ctx.elapsed + ctx.rng.range(3.5, 8.0);
    }
  }

  /** Plays a positioned one-shot, if it's close enough to hear. */
  private playAt(worldPosition: Vector3, play: (gain: number, pan: number) => void): void {
    if (!this.engine.isReady) return;
    const spatial = this.engine.spatialise(
      worldPosition,
      this.state.renderPosition,
      this.listenerRight,
    );
    if (!spatial) return;
    play(spatial.gain, spatial.pan);
  }

  toggleMute(): void {
    this.engine.setMuted(!this.engine.isMuted);
  }

  dispose(): void {
    this.wind?.source.stop();
    this.wind = undefined;
    this.engine.dispose();
  }
}

const FORWARD = new Vector3();

/** Scratch for the river's nearest point, which moves with the listener. */
const RIVER_POSITION = new Vector3();
/** Beyond this the river is inaudible under the wind. */
const RIVER_AUDIBLE = 34;
