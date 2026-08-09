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
 * src/mbar.ts; the Grok module is the worked example — a sibling fetch
 * client (src/grok-usage.ts) plus a factory (src/modules/grok-gauge.ts),
 * with nothing here changing.
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

/** One selectable entry: every name in `aliases` picks the same module. The
 * first alias is the canonical one, used when listing valid names. */
export interface ModuleChoice<T> {
  aliases: string[];
  value: T;
}

/**
 * Parses a module selection (mbar --modules / MBAR_MODULES): comma-separated
 * names, case-insensitive, whitespace-tolerant. The given order is preserved
 * — it defines the dial cycle, and the first name is the startup screen.
 * Unknown and duplicate names (including the same module under two aliases)
 * throw with the canonical names listed, so a typo is loud rather than a
 * silently missing screen.
 */
export function selectModules<T>(spec: string, choices: ModuleChoice<T>[]): T[] {
  const canonical = choices.map((c) => c.aliases[0]).join(', ');
  const names = spec
    .split(',')
    .map((n) => n.trim().toLowerCase())
    .filter((n) => n !== '');
  if (names.length === 0) {
    throw new Error(`--modules/MBAR_MODULES: empty selection — valid: ${canonical}`);
  }
  const picked = new Set<ModuleChoice<T>>();
  const selection: T[] = [];
  for (const name of names) {
    const choice = choices.find((c) => c.aliases.includes(name));
    if (!choice) {
      throw new Error(`--modules/MBAR_MODULES: unknown module '${name}' — valid: ${canonical}`);
    }
    if (picked.has(choice)) {
      throw new Error(`--modules/MBAR_MODULES: '${choice.aliases[0]}' is listed twice`);
    }
    picked.add(choice);
    selection.push(choice.value);
  }
  return selection;
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
      if (elapsed < MIN_INDICATOR_MS && !signal.aborted) await Bun.sleep(MIN_INDICATOR_MS - elapsed);
      this.refreshing = false;
      // A poll that outlives shutdown must not announce itself: the host has
      // cleared (or is clearing) the display, and a repaint now would land
      // after the clear and re-register the application on the device.
      if (signal.aborted) break;
      this.onUpdated();
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
