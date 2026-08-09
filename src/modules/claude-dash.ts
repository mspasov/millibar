/**
 * The Claude dashboard: every Claude Code usage limit window on one screen —
 * the companion to src/modules/claude-gauge.ts, registered as its own module
 * so a dial press switches to it.
 *
 * Layout (72x16): the selected window's detail on top — label on the left,
 * reset countdown in dark grey, percentage on the right — and a bar strip
 * below with one slim bar per limit window (5-hour, 7-day, and any per-model
 * weekly windows such as Fable). The selected row runs at full brightness
 * behind a marker at the left edge; the other rows are dimmed. Every bar
 * keeps its own pace tick, so the three races stay readable at a glance.
 * Rotating the encoder moves the selection; the detail row follows — the
 * number rolls to the new window's value, but the bars stay put: with every
 * window on screen at once, a bar animating from another window's value
 * would misreport both windows mid-sweep.
 *
 * Fetching, staleness, back-off, and caching live in the shared LimitPoller;
 * mbar.ts hands both limit modules one deduplicated fetcher so the pair costs
 * the rate-limited endpoint a single request per cycle, and passes this
 * module `quiet` so the shared story is logged once.
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
import { PctSweep, sweepHead } from '../sweep';
import { wrapIndex, type ModuleContext, type MonitorModule, type RenderFrame } from '../module';
import { formatReset, paceTick, LimitPoller, type LimitModuleOptions, type Screen } from './limit-poller';

const WIDTH = DISPLAYS.front.width;

/** The text row sits high so the bar strip gets rows 8–15. The normal font
 * renders rows 0–6 here, the small font rows 1–5. */
const TEXT_Y = 3;
/** Activity dots, centred in the raised text band. */
const DOT_Y = 2;
const DOT_SIZE = 2;

/** Strip bars are inset so the selection marker at x0 keeps a clear column
 * before the fills. */
const STRIP_X = 3;
const STRIP_WIDTH = WIDTH - STRIP_X;
const MARKER_WIDTH = 2;
/** Brightness of unselected bars relative to their severity colour — dim
 * enough that the selected row reads first, bright enough to judge level and
 * severity at a glance. */
const UNSELECTED_SCALE = 0.45;

/** Same countdown geometry as the gauge module (see the comment there on the
 * mid_right anchor). */
const LABEL_X = 2;
const RESET_ANCHOR_X = 43;
const RESET_RIGHT_EDGE = RESET_ANCHOR_X - 2;
const RESET_GAP = 2;
const DOT_XS = [RESET_RIGHT_EDGE - 9, RESET_RIGHT_EDGE - 5, RESET_RIGHT_EDGE - 1];

/** Row layout of the bar strip for a given window count. Three windows — the
 * normal case — get 2px bars with a row of air between; the gaps close up at
 * four, and a lone window keeps a chunky bar near the gauge module's
 * spot. Five-plus drops to 1px rows; past eight the panel is out of rows and
 * the remainder are not drawn (the encoder still reaches them). */
function stripSlots(count: number): Array<{ y: number; height: number }> {
  switch (count) {
    case 0:
    case 1:
      return [{ y: 12, height: 3 }];
    case 2:
      return [
        { y: 9, height: 2 },
        { y: 13, height: 2 },
      ];
    case 3:
      return [
        { y: 8, height: 2 },
        { y: 11, height: 2 },
        { y: 14, height: 2 },
      ];
    case 4:
      return [
        { y: 8, height: 2 },
        { y: 10, height: 2 },
        { y: 12, height: 2 },
        { y: 14, height: 2 },
      ];
    default:
      return Array.from({ length: Math.min(count, 8) }, (_, i) => ({ y: 8 + i, height: 1 }));
  }
}

export function claudeDashModule(options: LimitModuleOptions): MonitorModule {
  let ctx: ModuleContext | null = null;
  let screenIndex = 0;

  /** Two animations with different rules. The number (and its colour) rolls
   * on every change, selection moves included — motion in the readout says
   * "now showing a different window". The selected bar may only animate
   * within its own window (polls, going stale): every bar is on screen at
   * once, so one sweeping from another window's value would misreport both
   * windows mid-animation. Selection changes snap it instead. */
  const textSweep = new PctSweep({
    durationMs: options.sweepMs,
    coolMs: options.sweepCoolMs,
    onFrame: () => ctx?.requestRender(),
  });
  textSweep.set(0, severityColor(0));
  const barSweep = new PctSweep({
    durationMs: options.sweepMs,
    coolMs: options.sweepCoolMs,
    onFrame: () => ctx?.requestRender(),
  });
  barSweep.set(0, severityColor(0));

  const poller = new LimitPoller(options, (previousScreens) => {
    // Keep the selection on the same window across refreshes even if the
    // list changed.
    const previousLabel = previousScreens[screenIndex]?.label;
    const sameScreen = poller.screens.findIndex((v) => v.label === previousLabel);
    screenIndex = sameScreen >= 0 ? sameScreen : Math.min(screenIndex, Math.max(poller.screens.length - 1, 0));
    // A vanished window drops the selection onto a different one — snap the
    // bar, as for an encoder move. The very first data (no previous screens)
    // sweeps: that's the startup reveal rising from 0, not another window's
    // value.
    retarget({ snapBar: previousScreens.length > 0 && sameScreen < 0 });
  });

  const currentScreen = (): Screen | null => poller.screens[screenIndex] ?? null;

  /** Point both animations at the selected screen's value; staleness rides the
   * colour, so going stale fades to grey in place instead of snapping. */
  const retarget = ({ snapBar = false }: { snapBar?: boolean } = {}): void => {
    const screen = currentScreen();
    if (!screen) return;
    const pct = Math.max(0, Math.min(100, screen.window.utilization));
    const color = poller.stale ? COLORS.stale : severityColor(pct);
    textSweep.to(pct, color);
    if (snapBar) barSweep.set(pct, color);
    else barSweep.to(pct, color);
  };

  return {
    id: 'claude-dash',
    title: 'Claude dashboard',

    init(context) {
      ctx = context;
      context.signal.addEventListener('abort', () => {
        textSweep.stop();
        barSweep.stop();
      });
      poller.init(context);
    },

    poll: () => poller.poll(currentScreen),

    render(frame: RenderFrame): DrawElement[] {
      const screen = currentScreen();
      if (!screen) return [];

      // The animated reading of the data: pct is fractional mid-sweep, colour
      // is mid-lerp. retarget() keeps both tweens pointed at the selected screen.
      const shown = textSweep.current();
      const { pct, color } = shown;
      const barShown = barSweep.current();
      const dotColor = frame.refreshing ? COLORS.refresh : HIDDEN(COLORS.refresh);
      const labelText = poller.stale ? `${screen.label}?` : screen.label;
      const labelEnd = LABEL_X + textWidth(labelText) - 1;
      const resetText = formatResetCompact(screen.window.resetsAt, RESET_RIGHT_EDGE - labelEnd - RESET_GAP);
      // Hidden while the refresh dots occupy its spot, and when nothing fits.
      const resetColor = resetText && !frame.refreshing ? COLORS.reset : HIDDEN(COLORS.reset);

      const slots = stripSlots(poller.screens.length);
      const selectedSlot = slots[Math.min(screenIndex, slots.length - 1)]!;
      // With a single window there is no selection to mark.
      const markerColor =
        poller.screens.length > 1 ? (poller.stale ? COLORS.stale : COLORS.label) : HIDDEN(COLORS.label);

      const bars: DrawElement[] = [];
      poller.screens.forEach((v, i) => {
        const slot = slots[i];
        if (!slot) return;
        const selected = i === screenIndex;
        // The selected bar renders its own animation, so a poll's value change
        // and the stale fade still glide — but it never wears another window's
        // value: selection changes snap it (see retarget). The rest sit at
        // their last-polled values, dimmed.
        const rowPct = selected ? barShown.pct : Math.max(0, Math.min(100, v.window.utilization));
        const rowColor = selected
          ? barShown.color
          : scaleRgb(poller.stale ? COLORS.stale : severityColor(rowPct), UNSELECTED_SCALE);
        const rowBar = { x: STRIP_X, y: slot.y, width: STRIP_WIDTH, height: slot.height };
        bars.push(
          ...progressBar({ pct: rowPct, color: rowColor, idPrefix: `w${i}`, ...rowBar }),
          paceTick(`w${i}pace`, v, rowBar, rowPct, rowColor)
        );
      });

      return [
        {
          id: 'label',
          type: 'text',
          text: labelText,
          font: 'small',
          color: poller.stale ? COLORS.stale : COLORS.label,
          align: 'mid_left',
          x: LABEL_X,
          y: TEXT_Y,
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
          y: TEXT_Y,
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
          y: TEXT_Y,
          display: 'front',
        },
        ...bars,
        {
          id: 'marker',
          type: 'rectangle',
          x: 0,
          y: selectedSlot.y,
          width: MARKER_WIDTH,
          height: selectedSlot.height,
          radius: 0,
          fill: 'solid',
          fill_colors: [markerColor],
          border_width: 0,
          border_color: markerColor,
          display: 'front',
        },
        // After the selected row's tick: a sweeping head passes over it. Rides
        // the bar's animation, so a selection snap shows no head.
        sweepHead(barShown, { x: STRIP_X, y: selectedSlot.y, height: selectedSlot.height, width: STRIP_WIDTH }),
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
      // The label and countdown switch instantly, the marker jumps, and the
      // number rolls to the new window's value. The bar snaps: each row keeps
      // showing its own window's truth.
      retarget({ snapBar: true });
      const screen = currentScreen();
      if (screen) {
        ctx?.log(`-> ${screen.label} ${screen.window.utilization}% (${formatReset(screen.window.resetsAt)})`);
      }
    },
  };
}
