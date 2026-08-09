/**
 * Claude Code token history as a monitor module: last-30-days and last-7-days
 * bar charts, and an all-time calendar heatmap — the three graphs Claude Code
 * itself draws from this data (docs/USAGE-GRAPH.md), sized for 72x16.
 *
 * The charts are not drawn as elements. The firmware caps an application at
 * 100 live elements (DEVICE.md) and a 30-day stacked chart alone brushes that
 * — with the heatmap's ~360 cells far past it, and element scrubbing during
 * screen switches needing both screens' ids alive at once. So the module renders
 * each screen into a 72x16 pixel buffer, packs all three into one animation
 * asset with a named section per screen, and uploads it when the data changes.
 * A frame is then one animation element (pointing at the section) plus three
 * text elements; switching screens swaps the `section` name — the pattern
 * DEVICE.md recommends for state-driven screens.
 *
 * Bar screens: one bar per day, newest at the right edge, scaled to the
 * window's tallest day and stacked bottom-up by model *family* — a fixed
 * colour per family (Fable, Opus, Sonnet, Haiku; versions merged), heaviest
 * family at the bottom, anything unrecognised in a grey cap. The heatmap is
 * GitHub-shaped: Sun–Sat rows of double-dot day cells by up to 17 week
 * columns (~4 months), brightness stepped by the percentile buckets
 * (p25/p50/p75 of nonzero days) Claude Code uses, so one monster day can't
 * flatten the rest of the map.
 *
 * Each screen carries an appearance intro in the same asset (`intro-30d` …):
 * bars rise oldest-to-newest behind a track wipe, tips glowing white until
 * they land; the heatmap sweeps in week by week behind the same white edge.
 * A screen switch draws the intro section, and a timer swaps the element to
 * the static section once the intro has played — the intro ends on a ~1s
 * hold of its final frame (identical to the static pixels), so the swap
 * lands invisibly even with timer jitter. Every redraw of an animation
 * element restarts its section (DEVICE.md), so a repaint during the
 * sub-second intro replays it — the only uninvited repaint sources are the
 * 60s heartbeat and a poll landing, and a rare replay is accepted over
 * tracking draw counts. Prototyped and tuned on-device via
 * tools/history-intro.ts, which previews and demos these exact frames.
 *
 * Data is Claude Code's local stats cache (src/stats.ts), which only advances
 * when Claude Code itself recomputes it — so every screen anchors at the newest
 * day *in the data*, not calendar today: trailing days the cache hasn't seen
 * yet would otherwise render as zero-usage lies. The cache is *by design* a
 * day behind (its scanner folds in completed UTC days only), so one day of
 * age is normal; only a gap of two or more days marks the label stale ('?',
 * grey) and spells the gap out as e.g. `-3D`.
 *
 * Static frames, no sweep: these are dozens of independent values, and the
 * data changes at most a few times a day. Polling is a local file read —
 * instant, unfailing — so like the CPU module there is no LED pulse and no
 * refresh hold. The asset re-uploads only when the cache's mtime moves.
 */
import { encodeAnim, type AnimSection } from '../anim';
import { COLORS, DISPLAYS, HIDDEN, scaleRgb, type DrawElement } from '../display';
import { wrapIndex, type ModuleContext, type MonitorModule, type PollResult } from '../module';
import {
  daysBetween,
  loadStatsHistory,
  statsCachePath,
  utcToday,
  type DayTokens,
  type StatsHistory,
} from '../stats';
import { assetsUpload } from '../store';

const WIDTH = DISPLAYS.front.width;
const HEIGHT = DISPLAYS.front.height;

/** Bars occupy rows 6..15; small text at mid-anchor y=3 spans rows 1..5, so a
 * full-height bar stops one row short of the text. */
const CHART_BOTTOM = 15;
const MAX_BAR_H = 10;

const LABEL_X = 2;
const TEXT_Y = 3;
/** Right anchor for the staleness age in the bar screens — the same column
 * claude-gauge hangs its countdown on, clear of both label and total. */
const AGE_ANCHOR_X = 43;

/** Heatmap geometry: each day is a 2x1 "double dot" with a 1px gap on both
 * axes — Sun–Sat rows at y=1,3,…,13, week columns on a 3px pitch ending at
 * x=71. Separated dots read as a calendar of days where the earlier 1x2
 * mosaic read as a brightness blur; the cost is range, 17 columns (~4
 * months) against the text margin instead of 52. */
const HEAT_MAX_WEEKS = 17;
const HEAT_CELL_W = 2;
const HEAT_PITCH_X = 3;
const HEAT_RIGHT_X = 71;
const HEAT_TOP_Y = 1;

/** Fixed palette by model family — colour follows the model, never its rank,
 * so a window where one family overtakes another recolours nothing, and
 * versions within a family (Opus 5, 4.8, 4.7…) merge into one segment.
 * Sonnet's slot is reserved even for users who never touch it: the day it
 * appears it gets its own green instead of vanishing into the grey cap.
 * All four hues are distinct from each other and from the grey scaffold on
 * the panel. Unknown families merge into OTHER. */
export const FAMILY_COLORS: Record<string, string> = {
  fable: '#FF9500FF',
  opus: '#00CCFFFF',
  sonnet: '#44E066FF',
  haiku: '#CC55FFFF',
};
export const OTHER_COLOR = '#666666FF';

/** `claude-opus-4-8` → `opus`; anything unrecognisable → `other`. */
export function modelFamily(model: string): string {
  const match = /^claude-([a-z]+)/.exec(model);
  return match && match[1]! in FAMILY_COLORS ? match[1]! : 'other';
}

/** Heatmap brightness ramp for percentile buckets 1-4. Alpha can't dim LEDs,
 * so the steps scale the components (see scaleRgb). The bottom step is 0.25:
 * at 0.18 a bucket-1 cell (#2E1B00) sat within a few counts of the #202020
 * idle cell on every channel — the dark-grey legibility trap (DEVICE.md).
 * 0.25 puts its red channel 32/255 above the idle grey and ~33/255 below
 * bucket 2. Computed against the documented floor, not yet eyeballed
 * on-device. */
export const HEAT_COLORS = [0.25, 0.38, 0.65, 1].map((f) => scaleRgb('#FF9500FF', f));
/** An in-range day with zero tokens — dark like the bar screens' track, and
 * distinct from unpainted (black) cells outside the data's range. */
export const HEAT_ZERO = COLORS.track;

export const ASSET_FILE = 'mbar-history.anim';

/** Appearance pacing, in display frames at FPS. Bars: the dark track wipes
 * in over TRACK_WIPE frames, bar i starts rising at INTRO_LEAD + i*stagger
 * and grows for `grow` frames with an ease-out — a wave rolling toward
 * today. Heat: week column w appears at HEAT_LEAD + w/HEAT_SWEEP, a scan
 * line crossing the calendar. Both share the white leading edge: heat cells
 * on arrival and bar tips while growing are mixed FLASH_MIX toward white,
 * settling to their final colour over FLASH_DECAY frames. Tuned on-device
 * (2026-08-09) via tools/history-intro.ts. */
const FPS = 30;
const TRACK_WIPE = 3;
const INTRO_LEAD = 2;
const HEAT_LEAD = 1;
const HEAT_SWEEP = 1.5;
export const FLASH_MIX = 0.55;
export const FLASH_DECAY = 3;
/** Final-frame hold appended to each intro section: the swap to the static
 * section lands inside this window, where both show identical pixels. */
const HOLD_FRAMES = 30;
/** How long after the intro's duration the swap draw fires — enough for
 * timer and draw latency, well inside the 1s hold. */
const INTRO_SWAP_MARGIN_MS = 150;

export interface HistoryScreen {
  label: string;
  /** Section name inside ASSET_FILE; screen switching is a section switch. */
  section: string;
  kind: 'bars' | 'heat';
  days: number;
  barWidth: number;
  gap: number;
  /** Intro: frames between consecutive bars starting to rise. */
  stagger: number;
  /** Intro: frames a single bar takes to reach full height. */
  grow: number;
}

/** Bar screens right-align their newest bar to x=70, leaving a 1px margin. */
export const SCREENS: HistoryScreen[] = [
  { label: '30D', section: '30d', kind: 'bars', days: 30, barWidth: 1, gap: 1, stagger: 0.4, grow: 6 },
  { label: '7D', section: '7d', kind: 'bars', days: 7, barWidth: 8, gap: 2, stagger: 1.8, grow: 8 },
  { label: 'ALL', section: 'heat', kind: 'heat', days: 0, barWidth: 0, gap: 0, stagger: 0, grow: 0 },
];

// --- window shaping (shared with tests) -------------------------------------

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

/** Families present in the window by total, descending (`other` excluded —
 * it always caps the stack); name breaks ties so the order is stable. The
 * heaviest family sits at the bottom of every bar. */
export function rankFamilies(window: DayTokens[]): string[] {
  const totals = new Map<string, number>();
  for (const day of window) {
    for (const [model, tokens] of Object.entries(day.tokensByModel)) {
      const family = modelFamily(model);
      if (family !== 'other') totals.set(family, (totals.get(family) ?? 0) + tokens);
    }
  }
  return [...totals.entries()]
    .sort(([fa, a], [fb, b]) => b - a || fa.localeCompare(fb))
    .map(([family]) => family);
}

/** One day's bar as bottom-up colour segments, one per model family. The bar
 * height is the day's share of the window maximum (1px floor so an active day
 * never vanishes); segment heights use largest-remainder rounding so they sum
 * exactly to the bar — plain per-segment rounding can overshoot and poke into
 * the text row. */
export function stackSegments(
  day: DayTokens,
  rankedFamilies: string[],
  maxTotal: number,
  maxHeight = MAX_BAR_H
): { color: string; height: number }[] {
  if (day.total <= 0 || maxTotal <= 0) return [];
  const barHeight = Math.max(1, Math.round((day.total / maxTotal) * maxHeight));

  const byFamily = new Map<string, number>();
  for (const [model, tokens] of Object.entries(day.tokensByModel)) {
    const family = modelFamily(model);
    byFamily.set(family, (byFamily.get(family) ?? 0) + tokens);
  }
  const groups: { color: string; tokens: number }[] = rankedFamilies.map((family) => ({
    color: FAMILY_COLORS[family]!,
    tokens: byFamily.get(family) ?? 0,
  }));
  groups.push({ color: OTHER_COLOR, tokens: byFamily.get('other') ?? 0 });

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

// --- pixel painting ----------------------------------------------------------

function fillRect(frame: Uint8Array, x: number, y: number, w: number, h: number, color: string): void {
  const r = parseInt(color.slice(1, 3), 16);
  const g = parseInt(color.slice(3, 5), 16);
  const b = parseInt(color.slice(5, 7), 16);
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      const o = ((y + dy) * WIDTH + (x + dx)) * 3;
      frame[o] = r;
      frame[o + 1] = g;
      frame[o + 2] = b;
    }
  }
}

/** A bar screen as a full 72x16 RGB frame: dark baseline across the window's
 * extent (so idle days still read as part of the chart), stacked bars over
 * it. The top row band stays black for the text elements drawn above. */
export function paintBars(window: DayTokens[], screen: { days: number; barWidth: number; gap: number }): Uint8Array {
  const frame = new Uint8Array(WIDTH * HEIGHT * 3);
  if (window.length === 0) return frame;
  const ranked = rankFamilies(window);
  const maxTotal = Math.max(...window.map((d) => d.total));
  const span = screen.days * screen.barWidth + (screen.days - 1) * screen.gap;
  const x0 = 71 - span;

  fillRect(frame, x0, CHART_BOTTOM, span, 1, COLORS.track);
  window.forEach((day, i) => {
    const x = x0 + i * (screen.barWidth + screen.gap);
    let below = 0;
    for (const segment of stackSegments(day, ranked, maxTotal)) {
      fillRect(frame, x, CHART_BOTTOM - below - segment.height + 1, screen.barWidth, segment.height, segment.color);
      below += segment.height;
    }
  });
  return frame;
}

/** Percentile thresholds over the nonzero day totals — Claude Code's own
 * bucketing (p25/p50/p75), which keeps one monster day from flattening the
 * rest of the map. Null when nothing is nonzero. */
export function heatThresholds(days: DayTokens[]): { p25: number; p50: number; p75: number } | null {
  const totals = days
    .map((d) => d.total)
    .filter((t) => t > 0)
    .sort((a, b) => a - b);
  if (totals.length === 0) return null;
  return {
    p25: totals[Math.floor(totals.length * 0.25)]!,
    p50: totals[Math.floor(totals.length * 0.5)]!,
    p75: totals[Math.floor(totals.length * 0.75)]!,
  };
}

export function heatLevel(total: number, thresholds: ReturnType<typeof heatThresholds>): number {
  if (total <= 0 || !thresholds) return 0;
  if (total >= thresholds.p75) return 4;
  if (total >= thresholds.p50) return 3;
  if (total >= thresholds.p25) return 2;
  return 1;
}

/** The heatmap's rendered range: Sunday-started weeks (the cache's UTC days,
 * Claude Code's week convention), ending with the newest day's week, capped
 * at HEAT_MAX_WEEKS. */
export function heatSpan(days: DayTokens[]): { startMs: number; weeks: number } | null {
  const newest = days.at(-1);
  if (!newest) return null;
  const first = days[0]!;
  const newestMs = Date.parse(newest.date);
  const sundayMs = newestMs - new Date(newestMs).getUTCDay() * 86_400_000;
  const firstSundayMs = Date.parse(first.date) - new Date(Date.parse(first.date)).getUTCDay() * 86_400_000;
  const weeks = Math.min(HEAT_MAX_WEEKS, Math.round((sundayMs - firstSundayMs) / (7 * 86_400_000)) + 1);
  return { startMs: sundayMs - (weeks - 1) * 7 * 86_400_000, weeks };
}

/** The all-time heatmap as a full 72x16 RGB frame: double-dot day cells (see
 * the geometry constants), a week column per 3px, right-aligned so the newest
 * week hugs the edge. Three cell states: black outside the data's range
 * (unknown, not zero), dark track inside it on idle days, and the orange ramp
 * by percentile bucket. The left margin stays black for the stacked text. */
export function paintHeatmap(days: DayTokens[]): Uint8Array {
  const frame = new Uint8Array(WIDTH * HEIGHT * 3);
  const span = heatSpan(days);
  if (!span) return frame;
  const byDate = new Map(days.map((d) => [d.date, d]));
  const firstDataMs = Date.parse(days[0]!.date);
  const newestMs = Date.parse(days.at(-1)!.date);
  const thresholds = heatThresholds(days.filter((d) => Date.parse(d.date) >= span.startMs));
  const x0 = HEAT_RIGHT_X - (span.weeks * HEAT_PITCH_X - 1) + 1;

  for (let ms = Math.max(span.startMs, firstDataMs); ms <= newestMs; ms += 86_400_000) {
    const date = new Date(ms).toISOString().slice(0, 10);
    const week = Math.floor((ms - span.startMs) / (7 * 86_400_000));
    const level = heatLevel(byDate.get(date)?.total ?? 0, thresholds);
    const color = level === 0 ? HEAT_ZERO : HEAT_COLORS[level - 1]!;
    fillRect(frame, x0 + week * HEAT_PITCH_X, HEAT_TOP_Y + new Date(ms).getUTCDay() * 2, HEAT_CELL_W, 1, color);
  }
  return frame;
}

// --- appearance intros --------------------------------------------------------

const easeOutCubic = (u: number): number => 1 - (1 - u) ** 3;

/** The bar screens' appearance: bars rising left-to-right. Each frame draws
 * the final stack truncated to the eased height, so family colours appear
 * bottom-up in their real order as the bar grows; the tip row glows white
 * while rising and melts into the real colour once the bar lands. The final
 * frame is pixel-identical to paintBars (tests assert it byte-for-byte). */
export function introBarsFrames(window: DayTokens[], screen: HistoryScreen): Uint8Array[] {
  if (window.length === 0) return [new Uint8Array(WIDTH * HEIGHT * 3)];
  const ranked = rankFamilies(window);
  const maxTotal = Math.max(...window.map((d) => d.total));
  const span = screen.days * screen.barWidth + (screen.days - 1) * screen.gap;
  const x0 = 71 - span;
  const stacks = window.map((day) => stackSegments(day, ranked, maxTotal));
  const starts = window.map((_, i) => INTRO_LEAD + i * screen.stagger);
  const frameCount = Math.ceil(Math.max(...starts) + screen.grow + FLASH_DECAY) + 1;

  const frames: Uint8Array[] = [];
  for (let f = 0; f < frameCount; f++) {
    const frame = new Uint8Array(WIDTH * HEIGHT * 3);
    const trackW = Math.min(span, Math.round((span * (f + 1)) / TRACK_WIPE));
    fillRect(frame, x0, CHART_BOTTOM, trackW, 1, COLORS.track);

    window.forEach((_, i) => {
      const u = (f - starts[i]!) / screen.grow;
      const finalH = stacks[i]!.reduce((a, s) => a + s.height, 0);
      if (u <= 0 || finalH === 0) return;
      const h = Math.max(1, Math.round(finalH * easeOutCubic(Math.min(1, u))));
      const x = x0 + i * (screen.barWidth + screen.gap);
      let below = 0;
      for (const segment of stacks[i]!) {
        const take = Math.min(segment.height, h - below);
        if (take <= 0) break;
        fillRect(frame, x, CHART_BOTTOM - below - take + 1, screen.barWidth, take, segment.color);
        below += take;
      }
      // (u - 1) * grow = frames since the bar reached full height.
      const settle = u < 1 ? 0 : Math.min(1, ((u - 1) * screen.grow) / FLASH_DECAY);
      const mix = FLASH_MIX * (1 - settle);
      if (mix > 0) {
        const yTip = CHART_BOTTOM - h + 1;
        for (let dx = 0; dx < screen.barWidth; dx++) {
          const o = (yTip * WIDTH + x + dx) * 3;
          for (let c = 0; c < 3; c++) frame[o + c] = Math.round(frame[o + c]! + (255 - frame[o + c]!) * mix);
        }
      }
    });
    frames.push(frame);
  }
  return frames;
}

/** The heatmap's appearance: week columns sweeping in oldest-first. Cells
 * flash on arrival — data cells mixed toward white, idle cells at a lifted
 * grey (0x50, well clear of the 0x20 track's legibility floor, DEVICE.md) —
 * and decay to their final colour, so a bright edge visibly crosses the
 * calendar. The final frame is pixel-identical to paintHeatmap. */
export function introHeatFrames(days: DayTokens[]): Uint8Array[] {
  const span = heatSpan(days);
  if (!span) return [new Uint8Array(WIDTH * HEIGHT * 3)];
  const byDate = new Map(days.map((d) => [d.date, d]));
  const firstDataMs = Date.parse(days[0]!.date);
  const newestMs = Date.parse(days.at(-1)!.date);
  const thresholds = heatThresholds(days.filter((d) => Date.parse(d.date) >= span.startMs));
  const x0 = HEAT_RIGHT_X - (span.weeks * HEAT_PITCH_X - 1) + 1;

  // The same walk as paintHeatmap, kept as a cell list so every frame can
  // rescale each cell's colour by its age since appearance.
  const cells: { x: number; y: number; week: number; r: number; g: number; b: number; idle: boolean }[] = [];
  for (let ms = Math.max(span.startMs, firstDataMs); ms <= newestMs; ms += 86_400_000) {
    const date = new Date(ms).toISOString().slice(0, 10);
    const week = Math.floor((ms - span.startMs) / (7 * 86_400_000));
    const level = heatLevel(byDate.get(date)?.total ?? 0, thresholds);
    const color = level === 0 ? HEAT_ZERO : HEAT_COLORS[level - 1]!;
    cells.push({
      x: x0 + week * HEAT_PITCH_X,
      y: HEAT_TOP_Y + new Date(ms).getUTCDay() * 2,
      week,
      r: parseInt(color.slice(1, 3), 16),
      g: parseInt(color.slice(3, 5), 16),
      b: parseInt(color.slice(5, 7), 16),
      idle: level === 0,
    });
  }

  const frameCount = Math.ceil(HEAT_LEAD + (span.weeks - 1) / HEAT_SWEEP + FLASH_DECAY) + 1;
  const frames: Uint8Array[] = [];
  for (let f = 0; f < frameCount; f++) {
    const frame = new Uint8Array(WIDTH * HEIGHT * 3);
    for (const cell of cells) {
      const age = f - (HEAT_LEAD + cell.week / HEAT_SWEEP);
      if (age < 0) continue;
      const settle = Math.min(1, age / FLASH_DECAY);
      let { r, g, b } = cell;
      if (cell.idle) {
        const grey = Math.round(0x20 + (0x50 - 0x20) * (1 - settle));
        r = g = b = grey;
      } else {
        const mix = FLASH_MIX * (1 - settle);
        r = Math.round(r + (255 - r) * mix);
        g = Math.round(g + (255 - g) * mix);
        b = Math.round(b + (255 - b) * mix);
      }
      for (let dx = 0; dx < HEAT_CELL_W; dx++) {
        const o = (cell.y * WIDTH + cell.x + dx) * 3;
        frame[o] = r;
        frame[o + 1] = g;
        frame[o + 2] = b;
      }
    }
    frames.push(frame);
  }
  return frames;
}

// --- formatting ---------------------------------------------------------------

/** Claude Code's y-axis notation, uppercased for the bitmap font. */
export function formatTokensCompact(n: number): string {
  if (n >= 999_950_000) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return `${Math.round(n)}`;
}

/** Narrower variant for the heatmap's 18px left margin: whole megacounts. */
export function formatTokensShort(n: number): string {
  if (n >= 999_950_000) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${Math.round(n / 1e6)}M`;
  return formatTokensCompact(n);
}

// --- the module ---------------------------------------------------------------

export interface HistoryAsset {
  bytes: Uint8Array;
  /** Intro playback duration per screen section — what the swap timer waits
   * before switching the chart element to the static section. */
  introMs: Record<string, number>;
}

/** Per screen: an `intro-<section>` (appearance frames plus a HOLD_FRAMES
 * tail of the final frame — folded by the encoder, so the tail is ~free)
 * followed by the static frame written twice so its section spans two
 * display frames. Both halves of the static shape are load-bearing, verified
 * on-device (firmware 1.1.1, DEVICE.md): a looping ONE-frame section is not
 * honoured — playback runs through the file and settles on its last frame,
 * so every screen showed the heatmap — and fps is the section-switch
 * latency, since switches land on a frame boundary (1 fps lagged the encoder
 * by up to a second; 30 fps is ~33ms while re-showing the same pixels). */
export function encodeHistoryAsset(days: DayTokens[]): HistoryAsset {
  const frames: Uint8Array[] = [];
  const sections: AnimSection[] = [];
  const introMs: Record<string, number> = {};
  const push = (name: string, add: Uint8Array[]): void => {
    sections.push({ name, start: frames.length, end: frames.length + add.length - 1 });
    frames.push(...add);
  };
  for (const screen of SCREENS) {
    const intro =
      screen.kind === 'bars' ? introBarsFrames(windowDays(days, screen.days), screen) : introHeatFrames(days);
    const still =
      screen.kind === 'bars' ? paintBars(windowDays(days, screen.days), screen) : paintHeatmap(days);
    push(`intro-${screen.section}`, [...intro, ...(Array(HOLD_FRAMES).fill(intro.at(-1)!) as Uint8Array[])]);
    push(screen.section, [still, still]);
    introMs[screen.section] = Math.round((intro.length / FPS) * 1000);
  }
  return { bytes: encodeAnim(frames, { width: WIDTH, height: HEIGHT, fps: FPS, sections }), introMs };
}

export interface ClaudeHistoryOptions {
  /** False disables the appearance intros — every screen draws its static
   * section directly (mbar's ANIMATIONS switch). Playback-only: the asset
   * still carries the intro sections, so the encoder and the upload path
   * don't fork on a display preference. */
  intros?: boolean;
  /** Local file read — 60s keeps the screen a minute behind Claude Code's own
   * recompute at zero cost. */
  pollIntervalMs?: number;
  /** The cache to read, injectable for tests. */
  statsPath?: string;
  /** UTC-today source, injectable so staleness tests can pin the calendar. */
  todayImpl?: () => string;
  /** Asset transport, injectable for tests. */
  uploadImpl?: typeof assetsUpload;
  /** Intro→static swap timer, returning a cancel — injectable so tests fire
   * it by hand instead of waiting out real intros. */
  scheduleImpl?: (fn: () => void, ms: number) => () => void;
}

export function claudeHistoryModule(options: ClaudeHistoryOptions = {}): MonitorModule {
  const {
    intros = true,
    pollIntervalMs = 60_000,
    statsPath = statsCachePath(),
    todayImpl = utcToday,
    uploadImpl = assetsUpload,
    scheduleImpl = (fn, ms) => {
      const timer = setTimeout(fn, ms);
      return () => clearTimeout(timer);
    },
  } = options;
  let ctx: ModuleContext | null = null;
  let history: StatsHistory | null = null;
  let screenIndex = 0;
  let warnedMissing = false;
  /** mtime of the cache content the device-side asset was built from; null
   * until the first successful upload, during which the frame is text-only —
   * an animation element pointing at a path that was never uploaded must not
   * be drawn. */
  let uploadedMtimeMs: number | null = null;
  /** Section the chart should play right now: `intro-…` while an appearance
   * runs, null once settled (render falls back to the static section). */
  let introSection: string | null = null;
  let cancelIntroSwap: (() => void) | null = null;
  let introDurations: Record<string, number> = {};

  /** Arm the appearance for the active screen: the next render draws the
   * intro section, and once it has played (margin inside the hold window)
   * the element swaps to the static section. */
  const startIntro = (): void => {
    if (!intros) return; // render falls through to the static section
    if (uploadedMtimeMs === null) return; // no chart element yet
    const screen = SCREENS[screenIndex]!;
    cancelIntroSwap?.();
    introSection = `intro-${screen.section}`;
    cancelIntroSwap = scheduleImpl(() => {
      cancelIntroSwap = null;
      introSection = null;
      ctx?.requestRender();
    }, introDurations[screen.section]! + INTRO_SWAP_MARGIN_MS);
  };

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
      const totals = SCREENS.filter((v) => v.kind === 'bars').map(
        (v) => `${v.label} ${formatTokensCompact(windowDays(loaded.days, v.days).reduce((a, d) => a + d.total, 0))}`
      );
      ctx?.log(`history through ${newest}: ${totals.join(', ')}`);
    }
    history = loaded;
  };

  /** Re-encode and re-upload when the cache content moved. A failed upload
   * retries next poll; the on-device asset (possibly from a previous run —
   * assets persist) keeps serving meanwhile. */
  const syncAsset = async (): Promise<void> => {
    if (!ctx || !history || uploadedMtimeMs === history.modifiedAtMs) return;
    try {
      const asset = encodeHistoryAsset(history.days);
      await uploadImpl(ctx.applicationName, ASSET_FILE, asset.bytes);
      const firstUpload = uploadedMtimeMs === null;
      introDurations = asset.introMs;
      uploadedMtimeMs = history.modifiedAtMs;
      ctx.log(`uploaded ${ASSET_FILE}`);
      // The chart's very first appearance animates too; later data
      // re-uploads swap pixels under the element without replaying.
      if (firstUpload) startIntro();
    } catch (error) {
      ctx.warn(`asset upload failed: ${(error as Error).message}`);
    }
  };

  const windowTotal = (screen: HistoryScreen): number => {
    if (!history) return 0;
    if (screen.kind === 'heat') {
      const span = heatSpan(history.days);
      return history.days.reduce((a, d) => (span && Date.parse(d.date) >= span.startMs ? a + d.total : a), 0);
    }
    return windowDays(history.days, screen.days).reduce((a, d) => a + d.total, 0);
  };

  return {
    id: 'claude-history',
    title: 'Claude history',

    init(context) {
      ctx = context;
      context.signal.addEventListener('abort', () => cancelIntroSwap?.());
      // The runner renders before the first poll resolves; loading here makes
      // even that first frame carry the text (the chart follows the upload).
      load();
    },

    async poll(): Promise<PollResult> {
      load();
      await syncAsset();
      return { nextPollMs: pollIntervalMs, holdRefreshMs: 0 };
    },

    render(): DrawElement[] {
      const screen = SCREENS[screenIndex]!;
      const text = (
        id: string,
        value: string,
        color: string,
        align: 'mid_left' | 'mid_right',
        x: number,
        y = TEXT_Y
      ): DrawElement => ({
        id,
        type: 'text',
        text: value,
        font: 'small',
        color,
        align,
        x,
        y,
        display: 'front',
      });

      if (!history) return [text('label', 'NO STATS', COLORS.stale, 'mid_left', LABEL_X)];

      const ageDays = Math.max(0, daysBetween(history.days.at(-1)!.date, todayImpl()));
      // One day behind is the cache's freshest possible state, not staleness:
      // Claude Code's scanner only folds in *completed* UTC days, so repeated
      // /usage recomputes never add the current day (observed 2026-08-09 —
      // and the binary's incremental scan is anchored on a "yesterday"
      // helper). The marks appear only when the gap exceeds that by-design
      // day, i.e. when a recompute is genuinely overdue.
      const stale = ageDays > 1;
      const labelColor = stale ? COLORS.stale : COLORS.label;
      const label = stale ? `${screen.label}?` : screen.label;
      // Kept non-empty while hidden — persisted elements re-render their
      // previous text under zero alpha otherwise (same trick as claude-gauge).
      const age = stale ? `-${ageDays}D` : '0';
      const ageColor = stale ? COLORS.reset : HIDDEN(COLORS.reset);

      const elements: DrawElement[] = [];
      if (uploadedMtimeMs !== null) {
        elements.push({
          id: 'chart',
          type: 'animation',
          path: ASSET_FILE,
          // Self-healing guard: a pending intro can only be the active
          // screen's (onEncoder re-arms on every switch), but a mismatch
          // must fall back to the static section, not play the wrong intro.
          section: introSection === `intro-${screen.section}` ? introSection : screen.section,
          // loop:true is load-bearing even though the section is static: a
          // finished loop:false element ignores redraws entirely, so the
          // section could never switch again (verified on-device; DEVICE.md).
          loop: true,
          await_previous_end: false,
          opacity: 100,
          x: 0,
          y: 0,
          display: 'front',
        });
      }
      if (screen.kind === 'heat') {
        // The grid owns the panel from x=20; text stacks in the left margin.
        elements.push(
          text('label', label, labelColor, 'mid_left', LABEL_X),
          text('total', formatTokensShort(windowTotal(screen)), labelColor, 'mid_left', LABEL_X, 8),
          text('age', age, ageColor, 'mid_left', LABEL_X, 13)
        );
      } else {
        elements.push(
          text('label', label, labelColor, 'mid_left', LABEL_X),
          text('age', age, ageColor, 'mid_right', AGE_ANCHOR_X),
          text('total', formatTokensCompact(windowTotal(screen)), labelColor, 'mid_right', WIDTH - 2)
        );
      }
      return elements;
    },

    onEncoder(delta) {
      screenIndex = wrapIndex(screenIndex, delta, SCREENS.length);
      startIntro();
      const screen = SCREENS[screenIndex]!;
      if (history) {
        ctx?.log(`-> ${screen.label} (${formatTokensCompact(windowTotal(screen))} tokens)`);
      }
    },
  };
}
