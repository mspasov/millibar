/**
 * Claude Code usage limits as a monitor module.
 *
 * Layout (72x16): window label on the left, reset countdown in dark grey and
 * percentage on the right, and a progress bar along the bottom. A faint tick
 * on the bar marks how much of the window has elapsed — fill ahead of the tick
 * means tokens are going faster than time. Colour tracks severity. Rotating
 * the encoder cycles through the available limit windows (5-hour, 7-day, and
 * any per-model weekly windows such as Fable). The sibling module
 * src/modules/claude-usage-combined.ts shows every window at once; this one
 * gives the selected window the whole panel.
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
  severityColor,
  textWidth,
  type DrawElement,
} from '../display';
import { PctSweep, sweepHead } from '../sweep';
import { wrapIndex, type ModuleContext, type MonitorModule, type RenderFrame } from '../module';
import { formatReset, paceTick, UsagePoller, type UsageModuleOptions, type View } from './usage-poller';

export { buildViews } from './usage-poller';
export type ClaudeUsageOptions = UsageModuleOptions;

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

export function claudeUsageModule(options: ClaudeUsageOptions): MonitorModule {
  let ctx: ModuleContext | null = null;
  let viewIndex = 0;

  const sweep = new PctSweep({
    durationMs: options.sweepMs,
    coolMs: options.sweepCoolMs,
    onFrame: () => ctx?.requestRender(),
  });
  sweep.set(0, severityColor(0));

  const poller = new UsagePoller(options, (previousViews) => {
    // Keep showing the same window across refreshes even if the list changed.
    const previousLabel = previousViews[viewIndex]?.label;
    const sameView = poller.views.findIndex((v) => v.label === previousLabel);
    viewIndex = sameView >= 0 ? sameView : Math.min(viewIndex, Math.max(poller.views.length - 1, 0));
    retarget();
  });

  const currentView = (): View | null => poller.views[viewIndex] ?? null;

  /** Point the sweep at the current view's value; staleness rides the colour,
   * so going stale fades to grey in place instead of snapping. The first poll
   * sweeps up from 0 — the startup reveal. */
  const retarget = (): void => {
    const view = currentView();
    if (!view) return;
    const pct = Math.max(0, Math.min(100, view.window.utilization));
    sweep.to(pct, poller.stale ? COLORS.stale : severityColor(pct));
  };

  return {
    id: 'claude',
    title: 'Claude usage',

    init(context) {
      ctx = context;
      context.signal.addEventListener('abort', () => sweep.stop());
      poller.init(context);
    },

    poll: () => poller.poll(currentView),

    render(frame: RenderFrame): DrawElement[] {
      const view = currentView();
      if (!view) return [];

      // The animated view of the data: pct is fractional mid-sweep, colour is
      // mid-lerp. retarget() keeps the tween pointed at the current view.
      const shown = sweep.current();
      const { pct, color } = shown;
      const dotColor = frame.refreshing ? COLORS.refresh : HIDDEN(COLORS.refresh);
      const labelText = poller.stale ? `${view.label}?` : view.label;
      const labelEnd = LABEL_X + textWidth(labelText) - 1;
      const resetText = formatResetCompact(view.window.resetsAt, RESET_RIGHT_EDGE - labelEnd - RESET_GAP);
      // Hidden while the refresh dots occupy its spot, and when nothing fits.
      const resetColor = resetText && !frame.refreshing ? COLORS.reset : HIDDEN(COLORS.reset);

      const bar = { x: 0, y: BAR_Y, width: WIDTH, height: BAR_HEIGHT };

      return [
        {
          id: 'label',
          type: 'text',
          text: labelText,
          font: 'small',
          color: poller.stale ? COLORS.stale : COLORS.label,
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
        ...progressBar({ pct, color, y: BAR_Y, width: WIDTH, height: BAR_HEIGHT }),
        paceTick('pace', view, bar, pct, color),
        // After 'pace': a sweeping head passes over it.
        sweepHead(shown, bar),
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
      if (poller.views.length < 2) return;
      viewIndex = wrapIndex(viewIndex, delta, poller.views.length);
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
