/**
 * Double-BACK quit confirmation: the first BACK press arms a 5-second window
 * and paints "AGAIN = QUIT" with a time bar draining under it; a second BACK
 * inside the window quits, and anything else — another button, the encoder,
 * or the timeout — restores the module screen. The first paint trails the
 * press slightly (BACK_SETTLE_MS) so the firmware's own BACK blank cannot
 * wipe it — without the wait the prompt flashes text → blank → text.
 *
 * While armed this owns the display: the host suppresses module repaints so a
 * poll landing mid-window cannot overdraw the prompt. Restoring needs nothing
 * special — the next ordinary repaint carries none of the quit.* ids, and the
 * session tombstones them.
 */
import { COLORS, DISPLAYS, progressBar, textWidth, type DrawElement } from './display';
import { assetsUpload, humanSize, list, read } from './store';

export const QUIT_WINDOW_MS = 5000;
/** Drain repaint cadence — an upper bound, as with the sweeps; the bar moves
 * ~1.4px per tick, well under the device's draw latency ceiling. */
const TICK_MS = 100;
/** Wait between a BACK event and any draw reacting to it. BACK also acts on
 * the device itself — it dismisses the canvas app, blanking the screen
 * (DEVICE.md) — and that blank lands ~5–30 ms *after* the BACK event reaches
 * us (measured over injected input, firmware 1.1.1). A draw fired immediately
 * races it and can lose: the prompt flashed text → blank → text, and the
 * farewell can be wiped outright. Waiting lets the blank land first. */
export const BACK_SETTLE_MS = 150;

const WIDTH = DISPLAYS.front.width;
const TEXT = 'AGAIN = QUIT';
/** mid_left puts the first inked column exactly at x (DEVICE.md), so centring
 * is arithmetic rather than trusting `align: center`'s unmeasured behaviour. */
const TEXT_X = Math.floor((WIDTH - textWidth(TEXT)) / 2);

export interface QuitConfirmOptions {
  /** Draw a confirm frame. Ids arrive already namespaced (`quit.*`). */
  draw(elements: DrawElement[]): void;
  /** The window closed without a second BACK: restore the module screen.
   * Called after the state has disarmed, so a repaint sees `armed` false. */
  onExpire(): void;
  windowMs?: number;
  tickMs?: number;
  /** false stills the drain (mbar's ANIMATIONS switch): the bar draws full
   * once and only the expiry timer runs. */
  animate?: boolean;
  /** Wait between arming and the first prompt draw, riding out the firmware's
   * BACK blank. 0 draws synchronously (tests). */
  armDrawDelayMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

export class QuitConfirm {
  private readonly windowMs: number;
  private readonly tickMs: number;
  private readonly animate: boolean;
  private readonly armDrawDelayMs: number;
  private readonly now: () => number;

  private deadline: number | null = null;
  private expiry: ReturnType<typeof setTimeout> | null = null;
  private ticker: ReturnType<typeof setInterval> | null = null;
  private firstDraw: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: QuitConfirmOptions) {
    this.windowMs = options.windowMs ?? QUIT_WINDOW_MS;
    this.tickMs = options.tickMs ?? TICK_MS;
    this.animate = options.animate ?? true;
    this.armDrawDelayMs = options.armDrawDelayMs ?? BACK_SETTLE_MS;
    this.now = options.now ?? Date.now;
  }

  get armed(): boolean {
    return this.deadline !== null;
  }

  /** Opens the window and schedules the prompt. A second arm while armed is a
   * no-op — the caller treats that press as the confirmation instead. */
  arm(): void {
    if (this.armed) return;
    // The window opens now — a second BACK during the draw delay still quits;
    // only the paint waits for the firmware's blank to land.
    this.deadline = this.now() + this.windowMs;
    this.expiry = setTimeout(() => {
      this.stop();
      this.options.onExpire();
    }, this.windowMs);
    if (this.armDrawDelayMs === 0) {
      this.show();
    } else {
      this.firstDraw = setTimeout(() => {
        this.firstDraw = null;
        this.show();
      }, this.armDrawDelayMs);
    }
  }

  private show(): void {
    if (this.animate) {
      this.ticker = setInterval(() => this.options.draw(this.render()), this.tickMs);
    }
    this.options.draw(this.render());
  }

  /** Closes the window without restoring the screen (the caller's next action
   * repaints). Returns whether a prompt was actually up. */
  disarm(): boolean {
    const was = this.armed;
    this.stop();
    return was;
  }

  private stop(): void {
    if (this.expiry) clearTimeout(this.expiry);
    if (this.ticker) clearInterval(this.ticker);
    if (this.firstDraw) clearTimeout(this.firstDraw);
    this.expiry = null;
    this.ticker = null;
    this.firstDraw = null;
    this.deadline = null;
  }

  /** The prompt frame for the current instant: centred text, and under it the
   * remaining-time bar (full when the drain is stilled). */
  render(): DrawElement[] {
    const remaining = this.deadline === null ? 0 : Math.max(0, this.deadline - this.now());
    const pct = this.animate ? (remaining / this.windowMs) * 100 : 100;
    return [
      {
        id: 'quit.text',
        type: 'text',
        text: TEXT,
        font: 'small',
        color: COLORS.warn,
        align: 'mid_left',
        x: TEXT_X,
        y: 5,
        display: 'front',
      },
      ...progressBar({ pct, color: COLORS.warn, y: 10, width: WIDTH, height: 3, idPrefix: 'quit.' }),
    ];
  }
}

// --- the farewell: the firmware's own turn-off animation ---------------------

/** The soft-off app's asset. `stock_path` resolves only within `shared/`
 * (other apps_assets directories and `..` traversal both render the
 * missing-asset placeholder — see DEVICE.md), so playing it means copying it
 * into our own asset directory once and drawing it by `path`. */
const TURN_OFF_SOURCE = '/ext/apps_assets/soft_off/animations/turn_off_72x16.anim';
export const TURN_OFF_FILE = 'turn_off.anim';
/** One pass: 40 display frames at 60 fps (header read 2026-08-09, firmware
 * 1.1.1). A firmware update could retime it; the size check below re-copies
 * the pixels, and a small drift in this wait only trims or pads the hold on
 * the final frame. */
export const TURN_OFF_MS = Math.round((40 / 60) * 1000);
/** How long to hold after the farewell draw is *accepted*: the device takes a
 * variable 20–400 ms to render the 90 KB asset's first frame (measured via
 * /api/screen, firmware 1.1.1 — the high end under concurrent request load),
 * so the hold budgets the slowest observed start plus one pass. Overshooting
 * is invisible — the pass ends on a dark frame and the non-looping element
 * dies there — while undershooting clears mid-fade, visibly truncating the
 * power-down. */
export const TURN_OFF_HOLD_MS = TURN_OFF_MS + 500;

/**
 * Makes the turn-off animation playable under `applicationName`, copying it
 * device → host → device (storage has no on-device copy) unless the app's
 * copy already matches the firmware's by size. Resolves false — never throws
 * — when the asset can't be readied; the quit then just skips the farewell.
 */
export async function ensureTurnOffAsset(
  applicationName: string,
  log: (message: string) => void
): Promise<boolean> {
  try {
    const sourceDir = TURN_OFF_SOURCE.slice(0, TURN_OFF_SOURCE.lastIndexOf('/'));
    const sourceName = TURN_OFF_SOURCE.slice(TURN_OFF_SOURCE.lastIndexOf('/') + 1);
    const source = (await list(sourceDir)).find((e) => e.name === sourceName);
    if (source?.size === undefined) {
      log(`no turn-off farewell: ${TURN_OFF_SOURCE} not in firmware assets`);
      return false;
    }
    // list 400s on a missing directory — the same as "no copy yet" here.
    const appDir = await list(`/ext/user_assets/${applicationName}`).catch(() => []);
    if (appDir.find((e) => e.name === TURN_OFF_FILE)?.size === source.size) return true;
    await assetsUpload(applicationName, TURN_OFF_FILE, await read(TURN_OFF_SOURCE));
    log(`copied the firmware's turn-off animation (${humanSize(source.size)})`);
    return true;
  } catch (error) {
    log(`no turn-off farewell: ${(error as Error).message}`);
    return false;
  }
}

/** The farewell frame. Drawn through the session as the sole element, it
 * tombstones whatever was up (the prompt, mid-window). `loop: false` leaves
 * the element dead after its single pass (DEVICE.md) — fine, the display
 * clear follows immediately. */
export function turnOffElement(): DrawElement {
  return {
    id: 'quit.off',
    type: 'animation',
    path: TURN_OFF_FILE,
    loop: false,
    await_previous_end: false,
    opacity: 100,
    x: 0,
    y: 0,
    display: 'front',
  };
}
