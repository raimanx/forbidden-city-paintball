import { isTouchDevice } from '../core/Device';

const REPO_URL = 'https://github.com/raimanx/forbidden-city-paintball';

/** What the card says under the button. Anywhere on it resumes, either way. */
const RESUME_NOTE = isTouchDevice() ? 'or tap anywhere' : 'or click anywhere';

/** GitHub's mark, as a path on a 16×16 viewBox. Inlined so it costs no request. */
const GITHUB_MARK =
  'M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z';

/**
 * The whole control scheme, which the game has never written down anywhere but
 * the one-line hint along the bottom of the HUD. A pause screen is where a
 * player goes looking for it.
 *
 * Only the bindings that do something. `Input` also knows about reload and
 * mute, which nothing has implemented yet — a legend that lists a key the game
 * ignores is worse than one that leaves it out.
 */
const KEYS: ReadonlyArray<[string, string]> = [
  ['wasd', 'move'],
  ['space', 'jump'],
  ['shift', 'sprint'],
  ['ctrl', 'crouch'],
  ['click', 'fire'],
  ['right-click', 'aim'],
  ['t', 'wave'],
  ['tab', 'scores'],
  ['esc', 'pause'],
];

/**
 * The same legend for thumbs.
 *
 * Not a translation of the one above: the touch scheme is a different scheme,
 * and a shorter one. Sprint has no button because pushing the stick to its edge
 * already asks for one; crouch and wave have none because playtesting found
 * them in the way; and the scoreboard is this card, which is why it is not on
 * it.
 */
const TOUCH_KEYS: ReadonlyArray<[string, string]> = [
  ['left thumb', 'move'],
  ['push far', 'sprint'],
  ['drag right', 'look'],
  ['fire', 'either hand'],
  ['jump', 'jump'],
  ['aim', 'tap on, tap off'],
  ['❚❚', 'pause'],
];

/** What the card shows about the round it is holding. */
export interface PauseStats {
  /** Seconds left on the clock. */
  timeLeft: number;
  hitsGiven: number;
  hitsTaken: number;
  ammo: number;
}

/**
 * The pause card: the round, held.
 *
 * Built from the two screens that already exist rather than inventing a third
 * look — the loading card's tinted sky wash and centred stack, over the
 * end-of-round card's ink border and cream paper. The point is that stopping
 * mid-round should feel like the same game, not like a browser dialog.
 *
 * Unlike the HUD this layer is interactive: it covers the canvas, so the click
 * that takes the pointer back has to land here. Anywhere on it will do, which
 * matters because the muscle memory for "back to the game" is a click, not a
 * hunt for a button.
 */
export class PauseOverlay {
  private readonly root: HTMLDivElement;
  private readonly clock: HTMLElement;
  private readonly given: HTMLElement;
  private readonly taken: HTMLElement;
  private readonly ammo: HTMLElement;
  private readonly note: HTMLElement;
  private onResume?: () => void;

  constructor(container: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'pause';
    this.root.innerHTML = `
      <div class="pause__card">
        <div class="pause__eyebrow">Forbidden City Paintball</div>
        <h1 class="pause__title">Paused</h1>
        <p class="pause__subtitle">The paint will wait.</p>

        <div class="pause__stats">
          <div class="pause__stat">
            <span class="pause__stat-value" data-pause-clock>0:00</span>
            <span class="pause__stat-label">left</span>
          </div>
          <div class="pause__stat pause__stat--given">
            <span class="pause__stat-value" data-pause-given>0</span>
            <span class="pause__stat-label">tagged them</span>
          </div>
          <div class="pause__stat pause__stat--taken">
            <span class="pause__stat-value" data-pause-taken>0</span>
            <span class="pause__stat-label">tagged you</span>
          </div>
          <div class="pause__stat pause__stat--ammo">
            <span class="pause__stat-value" data-pause-ammo>0</span>
            <span class="pause__stat-label">paint left</span>
          </div>
        </div>

        <button class="pause__resume" type="button" data-pause-resume>Back to it</button>
        <div class="pause__note" data-pause-note>${RESUME_NOTE}</div>

        <div class="pause__keys">
          ${(isTouchDevice() ? TOUCH_KEYS : KEYS).map(
            ([key, action]) =>
              `<div class="pause__key"><kbd>${key}</kbd><span>${action}</span></div>`,
          ).join('')}
        </div>

        <a
          class="fork-badge fork-badge--hero"
          href="${REPO_URL}"
          target="_blank"
          rel="noopener noreferrer"
        >
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="${GITHUB_MARK}" /></svg>
          Fork me on GitHub
        </a>
      </div>
    `;
    container.append(this.root);

    this.clock = this.root.querySelector('[data-pause-clock]')!;
    this.given = this.root.querySelector('[data-pause-given]')!;
    this.taken = this.root.querySelector('[data-pause-taken]')!;
    this.ammo = this.root.querySelector('[data-pause-ammo]')!;
    this.note = this.root.querySelector('[data-pause-note]')!;

    this.root.addEventListener('pointerdown', this.onPointerDown);
  }

  /**
   * Anywhere on the card resumes — except the repo link, which is the single
   * thing here a player might want without giving up the pause. Grabbing the
   * pointer as a new tab opens would be a small hostage situation.
   *
   * `pointerdown` rather than `click`, and that is a phone fix rather than a
   * preference. Tapping the on-screen pause button raises this card *under the
   * finger that is still down*, and the browser then delivers that tap's click
   * to whatever now sits beneath it — this card — resuming the round in the
   * same gesture that held it. A pointerdown cannot arrive that way: the one
   * that paused the game was spent on the pause button, before this card
   * existed. The link still works, because a link is followed on click.
   */
  private onPointerDown = (event: PointerEvent): void => {
    if ((event.target as HTMLElement | null)?.closest('a')) return;
    this.onResume?.();
  };

  /** Registers what a press on the card means. */
  setResumeHandler(handler: () => void): void {
    this.onResume = handler;
  }

  show(stats: PauseStats): void {
    const total = Math.max(0, Math.ceil(stats.timeLeft));
    this.clock.textContent = `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
    this.given.textContent = String(stats.hitsGiven);
    this.taken.textContent = String(stats.hitsTaken);
    this.ammo.textContent = Number.isFinite(stats.ammo) ? String(stats.ammo) : '∞';
    this.setNote(RESUME_NOTE);
    this.root.classList.add('is-visible');
  }

  hide(): void {
    this.root.classList.remove('is-visible');
  }

  /** Used to say "in a moment" when the browser holds the lock back. */
  setNote(text: string): void {
    this.note.textContent = text;
  }

  get isVisible(): boolean {
    return this.root.classList.contains('is-visible');
  }

  dispose(): void {
    this.root.removeEventListener('pointerdown', this.onPointerDown);
    this.root.remove();
  }
}
