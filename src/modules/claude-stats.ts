/**
 * Claude Code token history as a monitor module — the "last N days" graph.
 *
 * Layout (72x16): view label top-left, window-total top-right, and a bar per
 * day along the bottom, newest day at the right edge. Bars are scaled to the
 * window's tallest day and stacked by model: the window's top three models get
 * the palette (bottom-up in rank order), everything else merges into a grey
 * "other" cap — the same top-3 cut Claude Code's own Tokens-per-Day chart
 * makes. Rotating the encoder switches the 30-day and 7-day windows.
 *
 * Data is Claude Code's local stats cache (src/stats.ts, docs/USAGE-GRAPH.md),
 * which only advances when Claude Code itself recomputes it — so the chart is
 * anchored at the newest day *in the data*, not calendar today: trailing days
 * the cache hasn't seen yet would otherwise render as zero-usage lies. When
 * the newest day is behind UTC today the label goes stale ('?', grey) and the
 * gap is spelled out top-centre as e.g. `-3D`.
 *
 * Static frames, no sweep: this is thirty independent values, not one moving
 * one, and the data changes at most a few times a day. Polling is a local
 * file read — instant, unfailing — so like the CPU module there is no LED
 * pulse and no refresh hold.
 */
import { COLORS, DISPLAYS, HIDDEN, type DrawElement } from '../display';
import { wrapIndex, type ModuleContext, type MonitorModule, type PollResult } from '../module';
import {
  daysBetween,
  loadStatsHistory,
  statsCachePath,
  utcToday,
  type DayTokens,
  type StatsHistory,
} from '../stats';

const WIDTH = DISPLAYS.front.width;

/** Bars occupy rows 6..15; small text at mid-anchor y=3 spans rows 1..5, so a
 * full-height bar stops one row short of the text. */
const CHART_BOTTOM = 15;
const MAX_BAR_H = 10;

const LABEL_X = 2;
const TEXT_Y = 3;
/** Right anchor for the staleness age — the same column claude-usage hangs
 * its countdown on, clear of both the label and the window total. */
const AGE_ANCHOR_X = 43;

/** Window ranks 1-3, bottom-up in each bar; every model past third merges
 * into OTHER. Orange/cyan/violet keep all three apart from the grey scaffold
 * colours and from each other on the panel. */
export const MODEL_COLORS = ['#FF9500FF', '#00CCFFFF', '#CC55FFFF'] as const;
export const OTHER_COLOR = '#666666FF';

interface StatsView {
  label: string;
  days: number;
  barWidth: number;
  gap: number;
}

/** Both views right-align their newest bar to x=70, leaving a 1px margin. */
const VIEWS: StatsView[] = [
  { label: '30D', days: 30, barWidth: 1, gap: 1 },
  { label: '7D', days: 7, barWidth: 8, gap: 2 },
];

/** The last `count` calendar days ending at the newest day in the data, with
 * absent days filled in as zero — inside the data's own range a missing date
 * genuinely means an idle day, so a zero there is true (unlike one past the
 * cache's horizon). */
export function windowDays(days: DayTokens[], count: number): DayTokens[] {
  const newest = days.at(-1);
  if (!newest) return [];
  const byDate = new Map(days.map((d) => [d.date, d]));
  const end = Date.parse(newest.date);
  const out: DayTokens[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const date = new Date(end - i * 86_400_000).toISOString().slice(0, 10);
    out.push(byDate.get(date) ?? { date, tokensByModel: {}, total: 0 });
  }
  return out;
}

/** Model ids by window total, descending; name breaks ties so colour
 * assignment is stable run to run. */
export function rankModels(window: DayTokens[]): string[] {
  const totals = new Map<string, number>();
  for (const day of window) {
    for (const [model, tokens] of Object.entries(day.tokensByModel)) {
      totals.set(model, (totals.get(model) ?? 0) + tokens);
    }
  }
  return [...totals.entries()]
    .sort(([ma, a], [mb, b]) => b - a || ma.localeCompare(mb))
    .map(([model]) => model);
}

/** One day's bar as bottom-up colour segments. The bar height is the day's
 * share of the window maximum (1px floor so an active day never vanishes);
 * segment heights use largest-remainder rounding so they sum exactly to the
 * bar — plain per-segment rounding can overshoot and poke into the text row. */
export function stackSegments(
  day: DayTokens,
  ranked: string[],
  maxTotal: number,
  maxHeight = MAX_BAR_H
): { color: string; height: number }[] {
  if (day.total <= 0 || maxTotal <= 0) return [];
  const barHeight = Math.max(1, Math.round((day.total / maxTotal) * maxHeight));

  const top = ranked.slice(0, MODEL_COLORS.length);
  const groups: { color: string; tokens: number }[] = top.map((model, i) => ({
    color: MODEL_COLORS[i]!,
    tokens: day.tokensByModel[model] ?? 0,
  }));
  let other = 0;
  for (const [model, tokens] of Object.entries(day.tokensByModel)) {
    if (!top.includes(model)) other += tokens;
  }
  groups.push({ color: OTHER_COLOR, tokens: other });

  const exact = groups.map((g) => (g.tokens / day.total) * barHeight);
  const heights = exact.map(Math.floor);
  let remaining = barHeight - heights.reduce((a, b) => a + b, 0);
  const byRemainder = exact
    .map((value, i) => ({ i, frac: value - Math.floor(value) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of byRemainder) {
    if (remaining <= 0) break;
    heights[i]! += 1;
    remaining -= 1;
  }

  return groups
    .map((g, i) => ({ color: g.color, height: heights[i]! }))
    .filter((s) => s.height > 0);
}

/** Claude Code's y-axis notation, uppercased for the bitmap font. */
export function formatTokensCompact(n: number): string {
  if (n >= 999_950_000) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return `${Math.round(n)}`;
}

export interface ClaudeStatsOptions {
  /** Local file read — 60s keeps the screen a minute behind Claude Code's own
   * recompute at zero cost. */
  pollIntervalMs?: number;
  /** The cache to read, injectable for tests. */
  statsPath?: string;
  /** UTC-today source, injectable so staleness tests can pin the calendar. */
  todayImpl?: () => string;
}

export function claudeStatsModule(options: ClaudeStatsOptions = {}): MonitorModule {
  const { pollIntervalMs = 60_000, statsPath = statsCachePath(), todayImpl = utcToday } = options;
  let ctx: ModuleContext | null = null;
  let history: StatsHistory | null = null;
  let viewIndex = 0;
  let warnedMissing = false;

  const load = (): void => {
    const loaded = loadStatsHistory(statsPath);
    if (!loaded) {
      // Keep the previous read if the file vanishes mid-run: the history it
      // held is still true, and staleness is already carried by the age text.
      if (!history && !warnedMissing) {
        warnedMissing = true;
        ctx?.warn(`no readable stats cache at ${statsPath} — the graph stays empty until Claude Code writes one`);
      }
      return;
    }
    if (loaded.modifiedAtMs !== history?.modifiedAtMs) {
      const newest = loaded.days.at(-1)!.date;
      const totals = VIEWS.map(
        (v) => `${v.label} ${formatTokensCompact(windowDays(loaded.days, v.days).reduce((a, d) => a + d.total, 0))}`
      );
      ctx?.log(`history through ${newest}: ${totals.join(', ')}`);
    }
    history = loaded;
  };

  return {
    id: 'stats',
    title: 'Claude history',

    init(context) {
      ctx = context;
      // The runner renders before the first poll resolves; loading here makes
      // even that first frame carry the chart.
      load();
    },

    async poll(): Promise<PollResult> {
      load();
      return { nextPollMs: pollIntervalMs, holdRefreshMs: 0 };
    },

    render(): DrawElement[] {
      const view = VIEWS[viewIndex]!;
      const text = (id: string, value: string, color: string, align: 'mid_left' | 'mid_right', x: number): DrawElement => ({
        id,
        type: 'text',
        text: value,
        font: 'small',
        color,
        align,
        x,
        y: TEXT_Y,
        display: 'front',
      });

      if (!history) return [text('label', 'NO STATS', COLORS.stale, 'mid_left', LABEL_X)];

      const window = windowDays(history.days, view.days);
      const ranked = rankModels(window);
      const maxTotal = Math.max(...window.map((d) => d.total));
      const windowTotal = window.reduce((a, d) => a + d.total, 0);

      const ageDays = Math.max(0, daysBetween(window.at(-1)!.date, todayImpl()));
      const stale = ageDays > 0;

      const span = view.days * view.barWidth + (view.days - 1) * view.gap;
      const x0 = 71 - span;
      const rect = (id: string, x: number, y: number, width: number, height: number, color: string): DrawElement => ({
        id,
        type: 'rectangle',
        x,
        y,
        width,
        height,
        radius: 0,
        fill: 'solid',
        fill_colors: [color],
        border_width: 0,
        border_color: color,
        display: 'front',
      });

      const bars: DrawElement[] = [];
      window.forEach((day, i) => {
        const x = x0 + i * (view.barWidth + view.gap);
        let below = 0;
        for (const [k, segment] of stackSegments(day, ranked, maxTotal).entries()) {
          bars.push(rect(`b${i}s${k}`, x, CHART_BOTTOM - below - segment.height + 1, view.barWidth, segment.height, segment.color));
          below += segment.height;
        }
      });

      return [
        // Baseline first: bars composite over it, and its full span marks the
        // window's extent through idle (zero) days.
        rect('base', x0, CHART_BOTTOM, span, 1, COLORS.track),
        ...bars,
        text('label', stale ? `${view.label}?` : view.label, stale ? COLORS.stale : COLORS.label, 'mid_left', LABEL_X),
        // Kept non-empty while hidden — persisted elements re-render their
        // previous text under zero alpha otherwise (same trick as claude-usage).
        text('age', stale ? `-${ageDays}D` : '0', stale ? COLORS.reset : HIDDEN(COLORS.reset), 'mid_right', AGE_ANCHOR_X),
        text('total', formatTokensCompact(windowTotal), stale ? COLORS.stale : COLORS.label, 'mid_right', WIDTH - 2),
      ];
    },

    onEncoder(delta) {
      viewIndex = wrapIndex(viewIndex, delta, VIEWS.length);
      const view = VIEWS[viewIndex]!;
      if (history) {
        const total = windowDays(history.days, view.days).reduce((a, d) => a + d.total, 0);
        ctx?.log(`-> ${view.label} (${formatTokensCompact(total)} tokens)`);
      }
    },
  };
}
