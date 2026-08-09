/**
 * The monitor-module contract and the per-module scheduler.
 *
 * A monitor module owns one data source (Claude usage, CPU load, …) and its
 * on-screen representation. The host (src/host.ts) owns everything shared:
 * the display session, the input stream, the status light, and which module
 * is visible. Every module polls continuously at its own cadence — so
 * switching always lands on fresh data — but only the active module's
 * `render()` output reaches the device.
 *
 * Adding a module means implementing `MonitorModule` and registering it in
 * src/mbar.ts; a future Grok-usage module is a sibling fetch client plus a
 * factory like src/modules/claude-gauge.ts — nothing here changes.
 */
import type { DrawElement } from './display';
import type { PulseShape } from './led';

export interface PollResult {
  /** Delay until the next automatic poll. A 429's Retry-After lands here. */
  nextPollMs: number;
  /** Earliest a manual refresh may fetch again, as a delay from now: the
   * ordinary cooldown after a success, the full Retry-After after a 429 so a
   * button press cannot immediately provoke the rate limit again. */
  holdRefreshMs: number;
}

export interface RenderFrame {
  /** True while this module's poll is in flight (with a floor applied so a
   * fast fetch still registers visually). Modules may ignore it. */
  refreshing: boolean;
}

export interface ModuleContext {
  /** The application_name the host draws (and owns assets) under. Uploads
   * must use it: an animation element's `path` resolves within the asset
   * directory of the application named on the draw. */
  applicationName: string;
  /** Ask the host to repaint; a no-op while this module is hidden. */
  requestRender(): void;
  /** Pulse the status light; `shape` overrides the default slow two-cycle
   * fade (e.g. one short cycle for a failure blink). A new pulse preempts one
   * still running. Suppressed by the host while the module is hidden: the
   * firmware restarts the notification preset on every draw that carries a
   * colour, so exactly one module may drive it at a time. */
  pulseActivity(color: string, shape?: PulseShape): void;
  /** Log a routine line, timestamped and prefixed with the module id. */
  log(message: string): void;
  /** Log a failure — stderr, with identical repeats coalesced (src/log.ts).
   * For polls that failed or data gone stale; a routine back-off (429) is not
   * a fault and reads better via `log`. */
  warn(message: string): void;
  /** Host lifetime — aborted on shutdown. */
  signal: AbortSignal;
}

export interface MonitorModule {
  /** Stable slug. The host namespaces element ids as `<id>.<elementId>`. */
  readonly id: string;
  /** Human name for logs and the startup banner. */
  readonly title: string;
  init?(ctx: ModuleContext): void;
  /** Fetch/update data. Recoverable failures are the module's business —
   * represent them in the next render (e.g. stale dimming) and return a
   * back-off. A throw is fatal: the host clears the display and exits. */
  poll(): Promise<PollResult>;
  /** Produce the full frame for the current state, with module-local ids.
   * Conditionally-visible elements must be hidden with zero alpha, never
   * omitted — but elements that stop being returned altogether are scrubbed
   * by the session, so a module may change its element set freely. */
  render(frame: RenderFrame): DrawElement[];
  /** Encoder rotation while this module is active. The host repaints after. */
  onEncoder?(delta: number): void;
}

/** Wraps an index by `delta` in both directions; deltas can exceed 1 on a
 * fast encoder spin. */
export function wrapIndex(index: number, delta: number, length: number): number {
  if (length <= 0) return 0;
  return (((index + delta) % length) + length) % length;
}

/** Floor on how long a module's activity indicator stays up, so a fast fetch
 * still registers visually. */
export const MIN_INDICATOR_MS = 300;

/**
 * Runs one module's poll loop: poll, hold the activity indicator up for at
 * least MIN_INDICATOR_MS, then sleep until the next poll is due or a manual
 * refresh wakes it early.
 */
export class ModuleRunner {
  /** Read by the host when building the module's RenderFrame. */
  refreshing = false;
  /** Earliest time a manual refresh may fetch — advanced by every PollResult,
   * so a 429's Retry-After also gates button presses. */
  private holdUntil = 0;
  /** Set only while the loop is sleeping; calling it starts the next poll
   * early. Null means a poll is already in flight. */
  private wake: (() => void) | null = null;

  constructor(
    readonly module: MonitorModule,
    /** Called whenever this module's visible state may have changed; the host
     * repaints if the module is active. */
    private readonly onUpdated: () => void,
    private readonly log: (message: string) => void
  ) {}

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const startedAt = Date.now();
      this.refreshing = true;
      this.onUpdated();
      const result = await this.module.poll();
      this.holdUntil = Date.now() + result.holdRefreshMs;
      const elapsed = Date.now() - startedAt;
      if (elapsed < MIN_INDICATOR_MS) await Bun.sleep(MIN_INDICATOR_MS - elapsed);
      this.refreshing = false;
      this.onUpdated();
      if (signal.aborted) break;
      await this.sleepUntilDueOrWoken(result.nextPollMs, signal);
    }
  }

  /** Poll early on user demand — or, inside the hold window, just repaint:
   * the press may well be someone reacting to a blank screen (BACK dismissed
   * the canvas, or another app drew over it), and doing nothing looks broken. */
  requestRefresh(reason: string): void {
    const waitMs = this.holdUntil - Date.now();
    if (waitMs > 0) {
      this.log(`${reason}: cooldown ${Math.ceil(waitMs / 1000)}s, repainting without fetching`);
      this.onUpdated();
      return;
    }
    if (!this.wake) return; // already polling
    this.log(`${reason}: refreshing`);
    this.wake();
  }

  private sleepUntilDueOrWoken(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', finish);
        this.wake = null;
        resolve();
      };
      const timer = setTimeout(finish, ms);
      this.wake = finish;
      signal.addEventListener('abort', finish, { once: true });
    });
  }
}
