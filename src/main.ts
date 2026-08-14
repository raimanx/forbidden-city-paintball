import './style.css';
import { Vector3 } from 'three';
import { CharacterRegistry } from './character/CharacterRegistry';
import { CharactersSystem, type BotSpec } from './character/CharactersSystem';
import { AudioSystem } from './audio/AudioSystem';
import { Game } from './core/Game';
import { AimSolver } from './gameplay/Aim';
import { SceneCrosshairSystem } from './gameplay/SceneCrosshair';
import { BallisticsSystem } from './gameplay/Ballistics';
import { CameraRig } from './gameplay/CameraRig';
import { PlayerController } from './gameplay/PlayerController';
import { createPlayerState } from './gameplay/PlayerState';
import { LootSystem, createLootState, type LootState } from './gameplay/LootSystem';
import { createMatchState, type MatchState } from './gameplay/MatchState';
import { MatchSystem } from './gameplay/MatchSystem';
import { WeaponSystem } from './gameplay/Weapon';
import { PaintSystem } from './paint/PaintSystem';
import { SplatAtlas } from './paint/SplatAtlas';
import { SurfaceRegistry } from './paint/SurfaceRegistry';
import { HudSystem } from './ui/HudSystem';
import { PauseSystem } from './ui/PauseSystem';
import { ResultsSystem } from './ui/ResultsSystem';
import { TouchControlsSystem } from './ui/TouchControls';
import { CityArenaSystem } from './world/CityArena';
import { MeshBuilder } from './world/MeshBuilder';
import { TestCourseSystem } from './world/TestCourse';

const container = document.querySelector<HTMLDivElement>('#app');
if (!container) throw new Error('main: #app container missing');

const loader = document.querySelector<HTMLDivElement>('#loader');
const loaderBar = document.querySelector<HTMLDivElement>('#loader-bar');
const loaderLabel = document.querySelector<HTMLDivElement>('#loader-label');

/**
 * The park is the game; the test course is a purpose-built movement gym whose
 * geometry the movement, ballistics and paint suites assert against by exact
 * coordinate. Keeping both, selected by `?scene=course`, means those suites stay
 * meaningful instead of being rewritten every time the map changes.
 */
const scene = new URLSearchParams(location.search).get('scene');
const useTestCourse = scene === 'course';

const game = new Game(container);
// City: the great courtyard, a third of the way north from the Gate of Supreme
// Harmony, off the axis so the opening shot of the map is the terrace and the
// Hall of Supreme Harmony standing on it rather than the player's own back.
// Course: the old open-ground spawn.
const playerState = createPlayerState(
  useTestCourse ? new Vector3(0, 2, 6) : new Vector3(9, 1.5, 116),
);
const surfaces = new SurfaceRegistry();
// Generated once and shared: world paint, character paint and the lens splash
// all stamp the same shapes.
const splatAtlas = new SplatAtlas();
const paint = new PaintSystem(surfaces, splatAtlas);
const characterRegistry = new CharacterRegistry();
// Ballistics consults the registry at impact, so it must exist first.
const ballistics = new BallisticsSystem(characterRegistry);

// The opposition. Spawns are snapped to walkable ground at init, so these are
// hints rather than exact positions. One of each personality, spread across the
// park's distinct areas.
// None on the test course: it is a controlled fixture that the movement,
// ballistics and paint suites assert against by exact coordinate, and a bot
// firing into it makes every one of those measurements non-deterministic.
// Eight rather than the park's six: the compound is half again as long as the
// park was and four fifths of it is building, so the same roster spread over it
// would leave whole courts with nobody in them for a round at a time. One of
// each personality, spread down the axis and out to both flanks.
const bots: BotSpec[] = useTestCourse
  ? []
  : [
      { id: 'bot-a', position: new Vector3(-40, 0, 100), colorIndex: 1, personality: 0 },
      { id: 'bot-b', position: new Vector3(46, 0, 96), colorIndex: 2, personality: 1 },
      // The two flanking halls of the outer court.
      { id: 'bot-c', position: new Vector3(-96, 0, 128), colorIndex: 3, personality: 2 },
      { id: 'bot-d', position: new Vector3(86, 0, 121), colorIndex: 5, personality: 3 },
      // Behind the terrace, at the Gate of Heavenly Purity.
      { id: 'bot-e', position: new Vector3(-6, 0, -52), colorIndex: 6, personality: 2 },
      // The Six Eastern and Six Western Palaces — the close-quarters ground.
      { id: 'bot-f', position: new Vector3(62, 0, -108), colorIndex: 7, personality: 1 },
      { id: 'bot-g', position: new Vector3(-62, 0, -108), colorIndex: 0, personality: 0 },
      // The Imperial Garden, at the north end of the axis.
      { id: 'bot-h', position: new Vector3(10, 0, -168), colorIndex: 4, personality: 3 },
    ];
// Paint is finite. One map for everybody, passed to whoever needs to answer
// "can I fire?" synchronously — see MatchState's header.
const match = createMatchState(
  ['player', ...bots.map((bot) => bot.id)],
  // The test course is a sandbox: unlimited paint and no crate, so the
  // movement, ballistics and paint suites keep measuring geometry rather than
  // how much paint was left when they got there.
  { sandbox: useTestCourse },
);
const loot = createLootState();
// A different hiding place every game, so this cannot come from WORLD_SEED.
// `?seed=` pins it, which is what makes a crate reproducible when something
// about one needs reproducing.
const seedParam = new URLSearchParams(location.search).get('seed');
const lootSeed = seedParam !== null ? Number(seedParam) >>> 0 : Date.now() >>> 0;

// Built after the match, whose roster needs the bot list and whose phase the
// controller reads — a player does not drive once the round is over.
const player = new PlayerController(playerState, match);
const charactersSystem = new CharactersSystem(
  playerState,
  characterRegistry,
  ballistics,
  splatAtlas,
  match,
  loot,
  bots,
  // Only used to put the player back at their spawn when a round restarts.
  player,
);
const lootSystem = new LootSystem(match, loot, playerState, charactersSystem, lootSeed);
const matchSystem = new MatchSystem(match, charactersSystem, ballistics, loot, lootSystem);
const audio = new AudioSystem(playerState);
const hud = new HudSystem(container, charactersSystem, splatAtlas, match);
// One solver shared by the gun and the scene crosshair, so the mark on the
// ground is traced from the same muzzle and direction the ball actually leaves.
const aim = new AimSolver();

// Registration order is execution order, and it matters:
//   player writes renderPosition -> camera reads it and writes avatarOpacity
//   -> avatar reads both.
game
  .add(useTestCourse ? new TestCourseSystem(surfaces) : new CityArenaSystem(surfaces))
  .add(player)
  .add(new CameraRig(playerState))
  .add(ballistics)
  .add(new WeaponSystem(playerState, ballistics, aim, match))
  // After the camera, which it aims from; before paint, which does not care.
  .add(new SceneCrosshairSystem(playerState, ballistics, aim))
  .add(paint)
  .add(charactersSystem)
  // After characters, whose init builds the navgrid the crate is placed on.
  .add(lootSystem)
  // After loot: the round can end on the last paintball in the park, and the
  // crate's own rounds count until somebody has taken them.
  .add(matchSystem)
  // After characters: the HUD reads their scores, and audio positions sounds
  // relative to the player's interpolated transform.
  .add(audio)
  .add(hud)
  // Nothing on a desktop; on a phone, the thumbs. It feeds `Input` and draws
  // its own layer, so it only has to exist before the first frame a player
  // could touch.
  .add(new TouchControlsSystem(container, match))
  // After the HUD, whose bottom hint it replaces while the round is held.
  .add(new PauseSystem(container, charactersSystem, match))
  // Last: it draws over the finished frame, and it takes the characters out of
  // the world, which everything above expects to still be there while playing.
  .add(new ResultsSystem(container, charactersSystem, match, game.render));

interface ImpactRecord {
  x: number;
  y: number;
  z: number;
  color: number;
  speed: number;
  colliderHandle: number;
  shooterId: string;
}

// Test hook. The headless movement tests and the phase 9 visual critic drive
// the game through this rather than through simulated input alone.
declare global {
  interface Window {
    __paintball?: {
      game: Game;
      state: typeof playerState;
      player: PlayerController;
      ballistics: BallisticsSystem;
      paint: PaintSystem;
      characters: CharactersSystem;
      audio: AudioSystem;
      hud: HudSystem;
      match: MatchState;
      loot: LootState;
      lootSystem: LootSystem;
      matchSystem: MatchSystem;
      camera: () => { x: number; y: number; z: number };
      simTime: () => number;
      setManualSim: (on: boolean) => void;
      stepSim: (seconds: number) => number;
      bootTimings: () => Array<{ phase: string; ms: number }>;
      impacts: ImpactRecord[];
      /**
       * Exposed for `tools/geometry-test.mjs`, which builds a box and a prism
       * and checks their faces point outward. Every wall in the city comes out
       * of this class, and a winding mistake in it is invisible in a screenshot
       * — it just makes the whole compound a shade too dark.
       */
      MeshBuilder: typeof MeshBuilder;
    };
  }
}
const impacts: ImpactRecord[] = [];
game.events.on('shot:fired', ({ shooterId }) => {
  if (shooterId === 'player') charactersSystem.onPlayerShot();
});

game.events.on('hit:world', ({ point, color, impactSpeed, colliderHandle, shooterId }) => {
  impacts.push({
    x: point.x,
    y: point.y,
    z: point.z,
    color,
    speed: impactSpeed,
    colliderHandle,
    shooterId,
  });
  if (impacts.length > 512) impacts.shift();
});

window.__paintball = {
  game,
  state: playerState,
  player,
  ballistics,
  paint,
  characters: charactersSystem,
  audio,
  hud,
  match,
  loot,
  lootSystem,
  matchSystem,
  camera: () => game.render.camera.position.clone(),
  simTime: () => game.simElapsed,
  setManualSim: (on) => game.setManualSim(on),
  stepSim: (seconds) => game.stepSim(seconds),
  bootTimings: () => game.bootTimings,
  impacts,
  MeshBuilder,
};

game.events.on('load:progress', ({ phase, progress }) => {
  if (loaderBar) loaderBar.style.width = `${Math.round(progress * 100)}%`;
  if (loaderLabel) loaderLabel.textContent = phase;
});

game.events.once('game:ready', () => {
  loader?.classList.add('is-done');
  // Let the fade finish before pulling it out of the layer tree.
  setTimeout(() => loader?.remove(), 600);
});

void game.boot().catch((error: unknown) => {
  console.error('Boot failed', error);
  if (loaderLabel) {
    loaderLabel.textContent =
      error instanceof Error ? `Failed to start: ${error.message}` : 'Failed to start';
  }
});

if (import.meta.hot) {
  import.meta.hot.dispose(() => game.dispose());
}
