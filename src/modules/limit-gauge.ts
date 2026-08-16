/**
 * The single-window gauge: one usage limit at a time, given the whole panel.
 * Provider-agnostic — src/modules/claude-gauge.ts and grok-gauge.ts are thin
 * wrappers that pass their id, title, and UsageSource.
 *
 * Layout (72x16): window label on the left, reset countdown in dark grey and
 * percentage on the right, and a progress bar along the bottom. A faint tick
 * on the bar marks how much of the window has elapsed — fill ahead of the tick
 * means tokens are going faster than time. Colour tracks severity. Rotating
 * the encoder cycles the screens the source offers (a no-op when there is
 * only one). The sibling module src/modules/claude-dash.ts shows every window
 * at once; this one gives the selected window the whole panel.
 *
 * Value changes animate (src/sweep.ts): polls, going stale, and encoder screen
 * switches all sweep the bar and roll the number instead of snapping.
 *
 * The last successful read is persisted (the source names the cache file), so
 * a restart while the API is unreachable or rate-limited starts from the
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
import {
  formatReset,
  paceTick,
  LimitPoller,
  type LimitModuleOptions,
  type Screen,
  type UsageSource,
} from './limit-poller';

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

export interface LimitGaugeSpec<D> {
  /** Stable module slug; the host namespaces element ids under it. */
  id: string;
  title: string;
  source: UsageSource<D>;
}

export function limitGaugeModule<D>(spec: LimitGaugeSpec<D>, options: LimitModuleOptions<D>): MonitorModule {
  let ctx: ModuleContext | null = null;
  let screenIndex = 0;

  const sweep = new PctSweep({
    durationMs: options.sweepMs,
    coolMs: options.sweepCoolMs,
    onFrame: () => ctx?.requestRender(),
  });
  sweep.set(0, severityColor(0));

  const poller = new LimitPoller(spec.source, options, (previousScreens) => {
    // Keep showing the same window across refreshes even if the list changed.
    const previousLabel = previousScreens[screenIndex]?.label;
    const sameScreen = poller.screens.findIndex((v) => v.label === previousLabel);
    screenIndex = sameScreen >= 0 ? sameScreen : Math.min(screenIndex, Math.max(poller.screens.length - 1, 0));
    retarget();
  });

  const currentScreen = (): Screen | null => poller.screens[screenIndex] ?? null;

  /** Point the sweep at the current screen's value; staleness rides the colour,
   * so going stale fades to grey in place instead of snapping. The first poll
   * sweeps up from 0 — the startup reveal. The stale grey is staleBar, not
   * `stale`: the sweep colour paints the bar row, where everything must clear
   * the ladder in COLORS — `stale` sits 21/255 from the pace tick, under the
   * panel's ~24/255 legibility floor (the dash learned this first). */
  const retarget = (): void => {
    const screen = currentScreen();
    if (!screen) return;
    const pct = Math.max(0, Math.min(100, screen.window.utilization));
    sweep.to(pct, poller.stale ? COLORS.staleBar : severityColor(pct));
  };

  return {
    id: spec.id,
    title: spec.title,

    init(context) {
      ctx = context;
      context.signal.addEventListener('abort', () => sweep.stop());
      poller.init(context);
    },

    poll: () => poller.poll(currentScreen),

    render(frame: RenderFrame): DrawElement[] {
      const screen = currentScreen();
      if (!screen) return [];

      // The animated reading of the data: pct is fractional mid-sweep, colour
      // is mid-lerp. retarget() keeps the tween pointed at the current screen.
      const shown = sweep.current();
      const { pct, color } = shown;
      const dotColor = frame.refreshing ? COLORS.refresh : HIDDEN(COLORS.refresh);
      const labelText = poller.stale ? `${screen.label}?` : screen.label;
      const labelEnd = LABEL_X + textWidth(labelText) - 1;
      const resetText = formatResetCompact(screen.window.resetsAt, RESET_RIGHT_EDGE - labelEnd - RESET_GAP);
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
          // Text wears the text grey while stale; the sweep's staleBar
          // belongs to the bar row only (`stale` is off the row's ladder,
          // staleBar is brighter than the label's grey). The number snaps to
          // its grey while the bar fades — staleness onset is a quiet event.
          color: poller.stale ? COLORS.stale : color,
          align: 'mid_right',
          x: WIDTH - 2,
          y: 5,
          display: 'front',
        },
        ...progressBar({ pct, color, y: BAR_Y, width: WIDTH, height: BAR_HEIGHT }),
        paceTick('pace', screen, bar, pct, color),
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
      if (poller.screens.length < 2) return;
      screenIndex = wrapIndex(screenIndex, delta, poller.screens.length);
      // The label and countdown switch instantly; the bar and number sweep
      // from the previous window's value to this one's.
      retarget();
      const screen = currentScreen();
      if (screen) {
        ctx?.log(`-> ${screen.label} ${screen.window.utilization}% (${formatReset(screen.window.resetsAt)})`);
      }
    },
  };
}
