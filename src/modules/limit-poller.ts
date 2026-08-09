/**
 * Shared machinery for the Claude gauge and dashboard modules: the limit
 * window list, the poll loop with its stale/back-off/cache behaviour, and
 * the pace tick. Each module owns a LimitPoller instance — separate stale
 * and back-off state — while the network fetch itself is deduplicated across
 * modules by `dedupedFetchUsage` (src/usage.ts), so two modules polling on
 * the same cadence cost the rate-limited endpoint one request per cycle.
 */
import { COLORS, HIDDEN, scaleRgb, type DrawElement } from '../display';
import { clockTime, formatDuration } from '../log';
import type { ModuleContext, PollResult } from '../module';
import {
  fetchUsage,
  loadCachedUsage,
  NoCredentialsError,
  RateLimitError,
  saveCachedUsage,
  USAGE_CACHE_PATH,
  type Usage,
  type UsageWindow,
} from '../usage';

/** One encoder stop: a limit window under its on-screen label. */
export interface Screen {
  label: string;
  window: UsageWindow;
  /** Length of the usage window; its start is `resetsAt - periodMs`. */
  periodMs: number;
}

const FIVE_HOURS_MS = 5 * 3_600_000;
const SEVEN_DAYS_MS = 7 * 86_400_000;

/** Brightness of the pace tick when it sits inside the fill, as a fraction of
 * the fill colour — dark enough to read as a notch, light enough to find. */
const PACE_FILL_SCALE = 0.35;

/** One short red blink when an update fails — preempts the cyan fetch pulse
 * (which is otherwise still fading when a fetch fails fast). */
const FAIL_BLINK = { durationMs: 600, cycles: 1 };

/** Cap on the 429 back-off, as a multiple of the poll interval. The endpoint's
 * budget is shared with everything else the account does, so one Retry-After
 * often isn't enough — consecutive 429s double the wait up to this cap rather
 * than re-knocking every interval while the limit persists. */
const MAX_BACKOFF_MULTIPLE = 4;

export function formatReset(resetsAt: string | null): string {
  if (!resetsAt) return 'no reset scheduled';
  const ms = new Date(resetsAt).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return 'resetting now';
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.round((ms % 3_600_000) / 60_000);
  return hours >= 24
    ? `resets in ${Math.floor(hours / 24)}d ${hours % 24}h`
    : `resets in ${hours}h ${minutes}m`;
}

/** The windows available to cycle through, in a stable order. Per-model windows
 * come and go as the API adds or drops them, so this is rebuilt on every poll. */
export function buildScreens(usage: Usage): Screen[] {
  const screens: Screen[] = [];
  if (usage.fiveHour) screens.push({ label: '5H', window: usage.fiveHour, periodMs: FIVE_HOURS_MS });
  if (usage.sevenDay) screens.push({ label: '7D', window: usage.sevenDay, periodMs: SEVEN_DAYS_MS });
  for (const model of usage.models) {
    // Fonts are bitmap ASCII; uppercase keeps the label visually consistent.
    // Model-scoped limits are weekly windows, like 7D.
    screens.push({ label: model.model.toUpperCase(), window: model, periodMs: SEVEN_DAYS_MS });
  }
  return screens;
}

/** Pace tick: where "now" sits in the window, so a bar reads as a race —
 * fill ahead of the tick means tokens are going faster than time. Clamped
 * against clock skew and already-passed resets. Which background the tick
 * sits on decides its shade: submerged in the fill it darkens the fill colour
 * (so it dims along with a dimmed row); over the empty track it stays full
 * pace grey — scaled down it would sink below the track. Draw it after the
 * bar's 'fill': later elements composite on top, and the tick must stay
 * visible when submerged. */
export function paceTick(
  id: string,
  screen: Screen,
  bar: { x: number; y: number; width: number; height: number },
  fillPct: number,
  fillColor: string
): DrawElement {
  const remainingMs = screen.window.resetsAt ? new Date(screen.window.resetsAt).getTime() - Date.now() : NaN;
  const timeFraction = Math.min(1, Math.max(0, 1 - remainingMs / screen.periodMs));
  const tickX = bar.x + (Number.isFinite(timeFraction) ? Math.round(timeFraction * (bar.width - 1)) : 0);
  const fillWidth = Math.max(1, Math.round((bar.width * fillPct) / 100));
  const color = Number.isFinite(timeFraction)
    ? fillPct > 0 && tickX < bar.x + fillWidth
      ? scaleRgb(fillColor, PACE_FILL_SCALE)
      : COLORS.pace
    : HIDDEN(COLORS.pace);
  return {
    id,
    type: 'rectangle',
    x: tickX,
    y: bar.y,
    width: 1,
    height: bar.height,
    radius: 0,
    fill: 'solid',
    fill_colors: [color],
    border_width: 0,
    border_color: color,
    display: 'front',
  };
}

export interface LimitModuleOptions {
  pollIntervalMs: number;
  /** Floor between API fetches, so holding a button can't hammer the endpoint
   * into a 429. */
  refreshCooldownMs: number;
  /** Sweep timings, overridable so tests can run instant (0). */
  sweepMs?: number;
  sweepCoolMs?: number;
  /** Where the last successful read is persisted so a restart under an
   * unreachable or rate-limited API starts from the previous values instead
   * of a blank screen. Null disables persistence (tests). */
  cachePath?: string | null;
  /** false: seed from the cache but never write it. For the secondary of a
   * shared-fetch pair — the twin polls dedupe into one request, but each
   * poller used to persist the identical result to the same path. */
  persist?: boolean;
  /** Injectable for tests, and how the modules share one deduplicated fetch. */
  fetchUsageImpl?: typeof fetchUsage;
  /** Skip the routine log lines (cache seed, summary, back-off, recovery) and
   * the failure warn. For a module sharing a deduplicated fetch with a
   * sibling: the primary module tells each story once. Fatal errors still
   * throw, and the status-light blinks are not affected. */
  quiet?: boolean;
}

export class LimitPoller {
  screens: Screen[] = [];
  stale = false;
  private ctx: ModuleContext | null = null;
  private readonly cachePath: string | null;
  private readonly fetchImpl: typeof fetchUsage;
  /** Consecutive 429s, escalating the back-off. Reset only by a successful
   * fetch — a network error in between says nothing about the rate limit. */
  private rateLimitStreak = 0;
  /** Consecutive polls without fresh data (failures and 429 back-offs alike),
   * and when the stretch began — the material for the recovery line. */
  private failedPolls = 0;
  private staleSince = 0;
  /** Utilization part of the last logged summary. At a 10-minute cadence an
   * unchanged summary is ~144 near-identical lines a day, so only changes are
   * worth a line. */
  private lastSummary = '';

  constructor(
    private readonly options: LimitModuleOptions,
    /** Called whenever screens or staleness changed — with the screen list from
     * before the change, so the module can re-find its selection by label
     * (the list is rebuilt every poll as model windows come and go) and
     * re-aim its animation. */
    private readonly onData: (previousScreens: Screen[]) => void
  ) {
    this.cachePath = options.cachePath === undefined ? USAGE_CACHE_PATH : options.cachePath;
    this.fetchImpl = options.fetchUsageImpl ?? fetchUsage;
  }

  /** Remembers the module context and seeds from the last run's read, marked
   * stale (grey, '?' on the label) until the first live fetch replaces it —
   * the startup sweep plays against the cached value instead of waiting on
   * the network. */
  init(ctx: ModuleContext): void {
    this.ctx = ctx;
    if (!this.cachePath) return;
    const cached = loadCachedUsage(this.cachePath);
    if (!cached) return;
    this.screens = buildScreens(cached);
    this.stale = true;
    this.onData([]);
    if (!this.options.quiet) {
      ctx.log(`showing cached usage from ${formatDuration(Date.now() - cached.fetchedAt.getTime())} ago`);
    }
  }

  /** One poll cycle: fetch, rebuild the window list, persist, log. `focus` is
   * consulted for the summary line — which window's reset matters is the
   * module's business. */
  async poll(focus: () => Screen | null): Promise<PollResult> {
    const { pollIntervalMs, refreshCooldownMs, quiet } = this.options;
    this.ctx?.pulseActivity(COLORS.refresh);
    try {
      const usage = await this.fetchImpl();
      const previousScreens = this.screens;
      this.screens = buildScreens(usage);
      this.stale = false;
      this.rateLimitStreak = 0;
      this.onData(previousScreens);
      if (this.cachePath && (this.options.persist ?? true)) await saveCachedUsage(usage, this.cachePath);

      if (this.failedPolls > 0) {
        if (!quiet) {
          this.ctx?.log(
            `recovered after ${formatDuration(Date.now() - this.staleSince)} stale ` +
              `(${this.failedPolls} failed poll${this.failedPolls === 1 ? '' : 's'})`
          );
        }
        this.failedPolls = 0;
      }
      const summary = this.screens.map((v) => `${v.label} ${v.window.utilization}%`).join(' | ');
      if (summary !== this.lastSummary) {
        this.lastSummary = summary;
        const screen = focus();
        if (!quiet && screen) {
          this.ctx?.log(`${summary} (${screen.label}: ${formatReset(screen.window.resetsAt)})`);
        }
      }
      return { nextPollMs: pollIntervalMs, holdRefreshMs: refreshCooldownMs };
    } catch (error) {
      if (error instanceof NoCredentialsError) throw error;

      // Keep the last known values on screen, dimmed, rather than blanking.
      if (this.failedPolls === 0) this.staleSince = Date.now();
      this.failedPolls += 1;
      this.stale = true;
      this.onData(this.screens);
      if (error instanceof RateLimitError) {
        // Routine back-off, not a fault — no red blink, or it would recur
        // every backed-off cycle for as long as the API stays rate-limited.
        // Hold button-triggered refreshes off for the whole back-off, not
        // just the usual cooldown, so a 429 isn't immediately provoked again.
        const backoffMs = pollIntervalMs * Math.min(2 ** this.rateLimitStreak, MAX_BACKOFF_MULTIPLE);
        this.rateLimitStreak += 1;
        const waitMs = Math.max(error.retryAfterSeconds * 1000, backoffMs);
        if (!quiet) {
          this.ctx?.log(`rate limited; showing stale values, next poll at ${clockTime(Date.now() + waitMs)} (refresh held)`);
        }
        return { nextPollMs: waitMs, holdRefreshMs: waitMs };
      }
      if (!quiet) {
        this.ctx?.warn(
          `poll failed (${(error as Error).message}); showing stale values, ` +
            `retrying in ${formatDuration(pollIntervalMs)}`
        );
      }
      this.ctx?.pulseActivity(COLORS.critical, FAIL_BLINK);
      return { nextPollMs: pollIntervalMs, holdRefreshMs: refreshCooldownMs };
    }
  }
}
