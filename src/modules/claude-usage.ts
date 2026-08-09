/**
 * Claude Code usage limits as a monitor module.
 *
 * Layout (72x16): window label on the left, reset countdown in dark grey and
 * percentage on the right, and a progress bar along the bottom. A faint tick
 * on the bar marks how much of the window has elapsed — fill ahead of the tick
 * means tokens are going faster than time. Colour tracks severity. Rotating
 * the encoder cycles through the available limit windows (5-hour, 7-day, and
 * any per-model weekly windows such as Fable).
 *
 * Value changes animate (src/sweep.ts): polls, going stale, and encoder view
 * switches all sweep the bar and roll the number instead of snapping.
 *
 * The last successful read is persisted to ~/.cache/mbar/usage.json, so a
 * restart while the API is unreachable or rate-limited starts from the
 * previous values (stale-dimmed) rather than a blank screen.
 */
import {
  COLORS,
  DISPLAYS,
  HIDDEN,
  formatResetCompact,
  progressBar,
  scaleRgb,
  severityColor,
  textWidth,
  type DrawElement,
} from '../display';
import { clockTime, formatDuration } from '../log';
import { PctSweep, sweepHead } from '../sweep';
import { wrapIndex, type ModuleContext, type MonitorModule, type PollResult, type RenderFrame } from '../module';
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

const WIDTH = DISPLAYS.front.width;
const BAR_Y = 12;
const BAR_HEIGHT = 3;

const LABEL_X = 2;
/** `mid_right` renders its last inked column 2px left of the anchor (measured,
 * both fonts), so anchoring at 43 puts the countdown's right edge at column 41
 * — two clear columns before the widest percentage ("100%" starts at 44). */
const RESET_ANCHOR_X = 43;
const RESET_RIGHT_EDGE = RESET_ANCHOR_X - 2;
/** Minimum dark columns between the label and the reset countdown. */
const RESET_GAP = 2;

/** Activity dots, swapped in (by alpha) for the reset countdown while
 * fetching — right-aligned on the same column so they clear the label too. */
const DOT_XS = [RESET_RIGHT_EDGE - 9, RESET_RIGHT_EDGE - 5, RESET_RIGHT_EDGE - 1];
const DOT_Y = 4;
const DOT_SIZE = 2;

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

interface View {
  label: string;
  window: UsageWindow;
  /** Length of the usage window; its start is `resetsAt - periodMs`. */
  periodMs: number;
}

const FIVE_HOURS_MS = 5 * 3_600_000;
const SEVEN_DAYS_MS = 7 * 86_400_000;

function formatReset(resetsAt: string | null): string {
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
export function buildViews(usage: Usage): View[] {
  const views: View[] = [];
  if (usage.fiveHour) views.push({ label: '5H', window: usage.fiveHour, periodMs: FIVE_HOURS_MS });
  if (usage.sevenDay) views.push({ label: '7D', window: usage.sevenDay, periodMs: SEVEN_DAYS_MS });
  for (const model of usage.models) {
    // Fonts are bitmap ASCII; uppercase keeps the label visually consistent.
    // Model-scoped limits are weekly windows, like 7D.
    views.push({ label: model.model.toUpperCase(), window: model, periodMs: SEVEN_DAYS_MS });
  }
  return views;
}

export interface ClaudeUsageOptions {
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
  /** Injectable for tests. */
  fetchUsageImpl?: typeof fetchUsage;
}

export function claudeUsageModule(options: ClaudeUsageOptions): MonitorModule {
  const { pollIntervalMs, refreshCooldownMs, cachePath = USAGE_CACHE_PATH, fetchUsageImpl = fetchUsage } = options;
  let ctx: ModuleContext | null = null;
  let views: View[] = [];
  let viewIndex = 0;
  let stale = false;
  /** Consecutive 429s, escalating the back-off. Reset only by a successful
   * fetch — a network error in between says nothing about the rate limit. */
  let rateLimitStreak = 0;
  /** Consecutive polls without fresh data (failures and 429 back-offs alike),
   * and when the stretch began — the material for the recovery line. */
  let failedPolls = 0;
  let staleSince = 0;
  /** Utilization part of the last logged summary. At a 10-minute cadence an
   * unchanged summary is ~144 near-identical lines a day, so only changes are
   * worth a line. */
  let lastSummary = '';

  const sweep = new PctSweep({
    durationMs: options.sweepMs,
    coolMs: options.sweepCoolMs,
    onFrame: () => ctx?.requestRender(),
  });
  sweep.set(0, severityColor(0));

  const currentView = (): View | null => views[viewIndex] ?? null;

  /** Point the sweep at the current view's value; staleness rides the colour,
   * so going stale fades to grey in place instead of snapping. The first poll
   * sweeps up from 0 — the startup reveal. */
  const retarget = (): void => {
    const view = currentView();
    if (!view) return;
    const pct = Math.max(0, Math.min(100, view.window.utilization));
    sweep.to(pct, stale ? COLORS.stale : severityColor(pct));
  };

  return {
    id: 'claude',
    title: 'Claude usage',

    init(context) {
      ctx = context;
      context.signal.addEventListener('abort', () => sweep.stop());
      // Seed from the last run's read, marked stale (grey, '?' on the label)
      // until the first live fetch replaces it — the startup sweep plays
      // against the cached value instead of waiting on the network.
      if (cachePath) {
        const cached = loadCachedUsage(cachePath);
        if (cached) {
          views = buildViews(cached);
          stale = true;
          retarget();
          ctx.log(`showing cached usage from ${formatDuration(Date.now() - cached.fetchedAt.getTime())} ago`);
        }
      }
    },

    async poll(): Promise<PollResult> {
      ctx?.pulseActivity(COLORS.refresh);
      try {
        const usage = await fetchUsageImpl();
        const previousLabel = currentView()?.label;
        views = buildViews(usage);
        // Keep showing the same window across refreshes even if the list changed.
        const sameView = views.findIndex((v) => v.label === previousLabel);
        viewIndex = sameView >= 0 ? sameView : Math.min(viewIndex, Math.max(views.length - 1, 0));
        stale = false;
        rateLimitStreak = 0;
        retarget();
        if (cachePath) await saveCachedUsage(usage, cachePath);

        if (failedPolls > 0) {
          ctx?.log(
            `recovered after ${formatDuration(Date.now() - staleSince)} stale ` +
              `(${failedPolls} failed poll${failedPolls === 1 ? '' : 's'})`
          );
          failedPolls = 0;
        }
        const summary = views.map((v) => `${v.label} ${v.window.utilization}%`).join(' | ');
        if (summary !== lastSummary) {
          lastSummary = summary;
          const reset = currentView()?.window.resetsAt ?? null;
          ctx?.log(`${summary} (${currentView()?.label}: ${formatReset(reset)})`);
        }
        return { nextPollMs: pollIntervalMs, holdRefreshMs: refreshCooldownMs };
      } catch (error) {
        if (error instanceof NoCredentialsError) throw error;

        // Keep the last known values on screen, dimmed, rather than blanking.
        if (failedPolls === 0) staleSince = Date.now();
        failedPolls += 1;
        stale = true;
        retarget();
        if (error instanceof RateLimitError) {
          // Routine back-off, not a fault — no red blink, or it would recur
          // every backed-off cycle for as long as the API stays rate-limited.
          // Hold button-triggered refreshes off for the whole back-off, not
          // just the usual cooldown, so a 429 isn't immediately provoked again.
          const backoffMs = pollIntervalMs * Math.min(2 ** rateLimitStreak, MAX_BACKOFF_MULTIPLE);
          rateLimitStreak += 1;
          const waitMs = Math.max(error.retryAfterSeconds * 1000, backoffMs);
          ctx?.log(`rate limited; showing stale values, next poll at ${clockTime(Date.now() + waitMs)} (refresh held)`);
          return { nextPollMs: waitMs, holdRefreshMs: waitMs };
        }
        ctx?.warn(
          `poll failed (${(error as Error).message}); showing stale values, ` +
            `retrying in ${formatDuration(pollIntervalMs)}`
        );
        ctx?.pulseActivity(COLORS.critical, FAIL_BLINK);
        return { nextPollMs: pollIntervalMs, holdRefreshMs: refreshCooldownMs };
      }
    },

    render(frame: RenderFrame): DrawElement[] {
      const view = currentView();
      if (!view) return [];

      // The animated view of the data: pct is fractional mid-sweep, colour is
      // mid-lerp. retarget() keeps the tween pointed at the current view.
      const shown = sweep.current();
      const { pct, color } = shown;
      const dotColor = frame.refreshing ? COLORS.refresh : HIDDEN(COLORS.refresh);
      const labelText = stale ? `${view.label}?` : view.label;
      const labelEnd = LABEL_X + textWidth(labelText) - 1;
      const resetText = formatResetCompact(view.window.resetsAt, RESET_RIGHT_EDGE - labelEnd - RESET_GAP);
      // Hidden while the refresh dots occupy its spot, and when nothing fits.
      const resetColor = resetText && !frame.refreshing ? COLORS.reset : HIDDEN(COLORS.reset);

      const bar = progressBar({ pct, color, y: BAR_Y, width: WIDTH, height: BAR_HEIGHT });
      const fillWidth = Math.max(1, Math.round((WIDTH * pct) / 100));

      // Pace tick: where "now" sits in the window, so the bar reads as a race —
      // fill ahead of the tick means tokens are going faster than time. Clamped
      // against clock skew and already-passed resets.
      const remainingMs = view.window.resetsAt ? new Date(view.window.resetsAt).getTime() - Date.now() : NaN;
      const timeFraction = Math.min(1, Math.max(0, 1 - remainingMs / view.periodMs));
      const tickX = Number.isFinite(timeFraction) ? Math.round(timeFraction * (WIDTH - 1)) : 0;
      // Which background the tick sits on decides its shade: submerged in the fill
      // it darkens the severity colour, over the empty track it lightens the track.
      const tickColor = Number.isFinite(timeFraction)
        ? pct > 0 && tickX < fillWidth
          ? scaleRgb(color, PACE_FILL_SCALE)
          : COLORS.pace
        : HIDDEN(COLORS.pace);

      return [
        {
          id: 'label',
          type: 'text',
          text: labelText,
          font: 'small',
          color: stale ? COLORS.stale : COLORS.label,
          align: 'mid_left',
          x: LABEL_X,
          y: 5,
          display: 'front',
        },
        {
          id: 'reset',
          type: 'text',
          // Kept non-empty even when hidden: the element persists by id, and a
          // redraw carrying the previous text under zero alpha renders nothing.
          text: resetText || '0',
          font: 'small',
          color: resetColor,
          align: 'mid_right',
          x: RESET_ANCHOR_X,
          y: 5,
          display: 'front',
        },
        {
          id: 'pct',
          type: 'text',
          text: `${Math.round(pct)}%`,
          font: 'normal',
          color,
          align: 'mid_right',
          x: WIDTH - 2,
          y: 5,
          display: 'front',
        },
        ...bar,
        {
          // Drawn after 'fill': later elements composite on top, and the tick
          // must stay visible when submerged in the fill.
          id: 'pace',
          type: 'rectangle',
          x: tickX,
          y: BAR_Y,
          width: 1,
          height: BAR_HEIGHT,
          radius: 0,
          fill: 'solid',
          fill_colors: [tickColor],
          border_width: 0,
          border_color: tickColor,
          display: 'front',
        },
        // After 'pace' for the same reason: a sweeping head passes over it.
        sweepHead(shown, { y: BAR_Y, height: BAR_HEIGHT, width: WIDTH }),
        ...DOT_XS.map((x, i) => ({
          id: `dot${i}`,
          type: 'rectangle' as const,
          x,
          y: DOT_Y,
          width: DOT_SIZE,
          height: DOT_SIZE,
          radius: 0,
          fill: 'solid' as const,
          fill_colors: [dotColor],
          border_width: 0,
          border_color: dotColor,
          display: 'front' as const,
        })),
      ];
    },

    onEncoder(delta) {
      if (views.length < 2) return;
      viewIndex = wrapIndex(viewIndex, delta, views.length);
      // The label and countdown switch instantly; the bar and number sweep
      // from the previous window's value to this one's.
      retarget();
      const view = currentView();
      if (view) {
        ctx?.log(`-> ${view.label} ${view.window.utilization}% (${formatReset(view.window.resetsAt)})`);
      }
    },
  };
}
