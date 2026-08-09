import { afterEach, describe, expect, test } from 'bun:test';
import { utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { COLORS, DISPLAYS, HIDDEN } from '../display';
import type { ModuleContext } from '../module';
import type { DayTokens } from '../stats';
import { tempDirs } from '../test-util';
import {
  ASSET_FILE,
  claudeStatsModule,
  encodeStatsAsset,
  FAMILY_COLORS,
  formatTokensCompact,
  formatTokensShort,
  HEAT_COLORS,
  HEAT_ZERO,
  heatLevel,
  heatSpan,
  heatThresholds,
  modelFamily,
  OTHER_COLOR,
  paintBars,
  paintHeatmap,
  rankFamilies,
  stackSegments,
  windowDays,
  type ClaudeStatsOptions,
} from './claude-stats';

const { tempDir, cleanup } = tempDirs('mbar-stats-module-');
afterEach(cleanup);

const WIDTH = DISPLAYS.front.width;

const day = (date: string, tokensByModel: Record<string, number>): DayTokens => ({
  date,
  tokensByModel,
  total: Object.values(tokensByModel).reduce((a, b) => a + b, 0),
});

/** Frame pixel as `#RRGGBB` for comparison against the `#RRGGBBAA` palette. */
const px = (frame: Uint8Array, x: number, y: number): string => {
  const o = (y * WIDTH + x) * 3;
  return (
    '#' +
    [frame[o]!, frame[o + 1]!, frame[o + 2]!].map((v) => v.toString(16).padStart(2, '0').toUpperCase()).join('')
  );
};
const rgb = (color: string): string => color.slice(0, 7).toUpperCase();
const BLACK = '#000000';

describe('windowDays', () => {
  test('anchors at the newest data day and zero-fills gaps', () => {
    const window = windowDays([day('2026-08-01', { m: 5 }), day('2026-08-03', { m: 7 })], 4);
    expect(window.map((d) => d.date)).toEqual(['2026-07-31', '2026-08-01', '2026-08-02', '2026-08-03']);
    expect(window.map((d) => d.total)).toEqual([0, 5, 0, 7]);
  });

  test('empty history windows to nothing', () => {
    expect(windowDays([], 7)).toEqual([]);
  });
});

describe('model families', () => {
  test('versions collapse into their family; unknowns are other', () => {
    expect(modelFamily('claude-opus-5')).toBe('opus');
    expect(modelFamily('claude-opus-4-8')).toBe('opus');
    expect(modelFamily('claude-sonnet-4-5-20250929')).toBe('sonnet');
    expect(modelFamily('claude-haiku-4-5-20251001')).toBe('haiku');
    expect(modelFamily('gpt-5')).toBe('other');
    expect(modelFamily('claude-nextgen-1')).toBe('other');
  });

  test('every family has a reserved colour, including unused Sonnet', () => {
    expect(Object.keys(FAMILY_COLORS).sort()).toEqual(['fable', 'haiku', 'opus', 'sonnet']);
  });

  test('rankFamilies orders present families by merged window total', () => {
    const ranked = rankFamilies([
      day('2026-08-01', { 'claude-opus-5': 40, 'claude-fable-5': 90, 'not-claude': 999 }),
      day('2026-08-02', { 'claude-opus-4-8': 60 }),
    ]);
    // Opus 40+60=100 beats Fable 90; the unknown model never ranks.
    expect(ranked).toEqual(['opus', 'fable']);
  });
});

describe('stackSegments', () => {
  test('segment heights sum exactly to the scaled bar height', () => {
    const segments = stackSegments(
      day('2026-08-01', { 'claude-fable-5': 33, 'claude-opus-5': 33, 'claude-haiku-4-5': 34 }),
      ['fable', 'opus', 'haiku'],
      100,
      10
    );
    expect(segments.reduce((sum, s) => sum + s.height, 0)).toBe(10);
    expect(segments.map((s) => s.color)).toEqual([FAMILY_COLORS.fable!, FAMILY_COLORS.opus!, FAMILY_COLORS.haiku!]);
  });

  test('versions within a family merge into one segment; unknowns cap in grey', () => {
    const segments = stackSegments(
      day('2026-08-01', { 'claude-opus-5': 40, 'claude-opus-4-8': 30, 'claude-fable-5': 20, mystery: 10 }),
      ['opus', 'fable'],
      100,
      10
    );
    expect(segments).toEqual([
      { color: FAMILY_COLORS.opus!, height: 7 },
      { color: FAMILY_COLORS.fable!, height: 2 },
      { color: OTHER_COLOR, height: 1 },
    ]);
  });

  test('an active day never rounds to nothing', () => {
    const segments = stackSegments(day('2026-08-01', { 'claude-fable-5': 1 }), ['fable'], 1_000_000, 10);
    expect(segments).toEqual([{ color: FAMILY_COLORS.fable!, height: 1 }]);
  });

  test('idle days produce no segments', () => {
    expect(stackSegments(day('2026-08-01', {}), ['fable'], 100, 10)).toEqual([]);
  });
});

describe('paintBars', () => {
  const view30 = { days: 30, barWidth: 1, gap: 1 };

  test('baseline spans the window, bars rise from it, sky stays black', () => {
    const frame = paintBars(
      windowDays([day('2026-08-05', { 'claude-fable-5': 50 }), day('2026-08-06', { 'claude-fable-5': 100 })], 30),
      view30
    );
    // Baseline x=12..70 at y=15 in track grey where no bar covers it.
    expect(px(frame, 12, 15)).toBe(rgb(COLORS.track));
    expect(px(frame, 11, 15)).toBe(BLACK);
    // Newest day (slot 29, x=70): full height 10 → rows 6..15 in Fable orange.
    expect(px(frame, 70, 6)).toBe(rgb(FAMILY_COLORS.fable!));
    expect(px(frame, 70, 15)).toBe(rgb(FAMILY_COLORS.fable!));
    expect(px(frame, 70, 5)).toBe(BLACK);
    // Day before (slot 28, x=68): half height → top at y=11, black above.
    expect(px(frame, 68, 11)).toBe(rgb(FAMILY_COLORS.fable!));
    expect(px(frame, 68, 10)).toBe(BLACK);
    // Gap column between bars keeps the baseline only.
    expect(px(frame, 69, 15)).toBe(rgb(COLORS.track));
    expect(px(frame, 69, 14)).toBe(BLACK);
  });

  test('stacks families bottom-up by window weight within a bar', () => {
    const frame = paintBars(
      windowDays([day('2026-08-06', { 'claude-fable-5': 60, 'claude-sonnet-5': 30, 'claude-haiku-4-5': 10 })], 7),
      { days: 7, barWidth: 8, gap: 2 }
    );
    // Newest bar covers x=63..70; heights 6/3/1 bottom-up: Fable, Sonnet, Haiku.
    expect(px(frame, 63, 15)).toBe(rgb(FAMILY_COLORS.fable!));
    expect(px(frame, 63, 10)).toBe(rgb(FAMILY_COLORS.fable!));
    expect(px(frame, 63, 9)).toBe(rgb(FAMILY_COLORS.sonnet!));
    expect(px(frame, 63, 7)).toBe(rgb(FAMILY_COLORS.sonnet!));
    expect(px(frame, 63, 6)).toBe(rgb(FAMILY_COLORS.haiku!));
    expect(px(frame, 63, 5)).toBe(BLACK);
  });
});

describe('heat helpers', () => {
  test('thresholds are the p25/p50/p75 of nonzero totals', () => {
    const days = [1, 2, 3, 4, 5, 6, 7, 8].map((t, i) => day(`2026-08-0${i + 1}`, { m: t }));
    expect(heatThresholds(days)).toEqual({ p25: 3, p50: 5, p75: 7 });
    expect(heatThresholds([day('2026-08-01', {})])).toBeNull();
  });

  test('levels bucket against the thresholds, zero staying zero', () => {
    const thresholds = { p25: 3, p50: 5, p75: 7 };
    expect([0, 1, 3, 5, 7, 99].map((t) => heatLevel(t, thresholds))).toEqual([0, 1, 2, 3, 4, 4]);
    expect(heatLevel(5, null)).toBe(0);
  });

  test('span counts Sunday-started weeks and caps at the 17 that fit', () => {
    // 1970-01-04 was a Sunday.
    expect(heatSpan([day('1970-01-04', { m: 1 }), day('1970-01-10', { m: 1 })])!.weeks).toBe(1);
    expect(heatSpan([day('1970-01-04', { m: 1 }), day('1970-01-12', { m: 1 })])!.weeks).toBe(2);
    expect(heatSpan([day('1970-01-04', { m: 1 }), day('1972-01-04', { m: 1 })])!.weeks).toBe(17);
    expect(heatSpan([])).toBeNull();
  });
});

describe('paintHeatmap', () => {
  // Fixed calendar: 1970-01-04 was a Sunday, so day-of-week rows are known.
  // Double-dot geometry: 2x1 cells, week columns on a 3px pitch ending at
  // x=71, weekday rows at y = 1 + dow*2.
  test('places 2x1 double dots by weekday row and week column, newest week at x=70..71', () => {
    const frame = paintHeatmap([
      day('1970-01-04', { m: 10 }), // Sunday, week 0
      day('1970-01-06', { m: 10 }), // Tuesday, week 0
      day('1970-01-12', { m: 10 }), // Monday, week 1 (newest)
    ]);
    // Two week columns: week 1 at x=70..71, week 0 at x=67..68, gap at x=69.
    expect(px(frame, 67, 1)).toBe(rgb(HEAT_COLORS[3]!)); // Sun week 0, both dots
    expect(px(frame, 68, 1)).toBe(rgb(HEAT_COLORS[3]!));
    expect(px(frame, 67, 5)).toBe(rgb(HEAT_COLORS[3]!)); // Tue week 0
    expect(px(frame, 70, 3)).toBe(rgb(HEAT_COLORS[3]!)); // Mon week 1
    expect(px(frame, 71, 3)).toBe(rgb(HEAT_COLORS[3]!));
    // Row gap between Sun and Mon stays black.
    expect(px(frame, 67, 2)).toBe(BLACK);
    // Column gap between the weeks stays black.
    expect(px(frame, 69, 3)).toBe(BLACK);
    // Monday week 0 (1970-01-05): in range, no tokens → zero cell.
    expect(px(frame, 67, 3)).toBe(rgb(HEAT_ZERO));
    // Tuesday week 1 (1970-01-13): after the newest data day → untouched black.
    expect(px(frame, 70, 5)).toBe(BLACK);
    // Left of the grid stays black for the text margin.
    expect(px(frame, 66, 3)).toBe(BLACK);
  });

  test('cells before the first data day stay black, not zero-grey', () => {
    // First data day is a Wednesday; the Sunday-anchored week starts before it.
    const frame = paintHeatmap([day('1970-01-07', { m: 5 })]);
    expect(px(frame, 70, 7)).toBe(rgb(HEAT_COLORS[3]!)); // Wed row y=7
    expect(px(frame, 71, 7)).toBe(rgb(HEAT_COLORS[3]!));
    expect(px(frame, 70, 1)).toBe(BLACK); // Sun before first data
    expect(px(frame, 70, 3)).toBe(BLACK); // Mon before first data
  });

  test('brightness follows the percentile buckets', () => {
    const frame = paintHeatmap([
      day('1970-01-04', { m: 1 }),
      day('1970-01-05', { m: 2 }),
      day('1970-01-06', { m: 3 }),
      day('1970-01-07', { m: 4 }),
    ]);
    // Totals 1..4 → thresholds p25=2 p50=3 p75=4 → levels 1..4 down the column.
    expect(px(frame, 70, 1)).toBe(rgb(HEAT_COLORS[0]!));
    expect(px(frame, 70, 3)).toBe(rgb(HEAT_COLORS[1]!));
    expect(px(frame, 70, 5)).toBe(rgb(HEAT_COLORS[2]!));
    expect(px(frame, 70, 7)).toBe(rgb(HEAT_COLORS[3]!));
  });
});

describe('formatting', () => {
  test('compact matches Claude Code notation, uppercased', () => {
    expect(formatTokensCompact(1_234_567_890)).toBe('1.2B');
    expect(formatTokensCompact(999_950_000)).toBe('1.0B');
    expect(formatTokensCompact(114_822_351)).toBe('114.8M');
    expect(formatTokensCompact(62_000)).toBe('62K');
    expect(formatTokensCompact(999)).toBe('999');
  });

  test('short variant drops megacount decimals for the heatmap margin', () => {
    expect(formatTokensShort(466_100_000)).toBe('466M');
    expect(formatTokensShort(10_400_000_000)).toBe('10.4B');
    expect(formatTokensShort(62_000)).toBe('62K');
  });
});

describe('encodeStatsAsset', () => {
  test('packs three sections into one device-native container', () => {
    const data = encodeStatsAsset([day('2026-08-06', { 'claude-fable-5': 100 })]);
    expect(new TextDecoder().decode(data.slice(0, 8))).toBe('bicycle0');
    expect(data.length).toBeGreaterThan(36);
  });
});

describe('module', () => {
  type Upload = { app: string; file: string; data: Uint8Array };

  function makeModule(
    days: DayTokens[] | null,
    over: Partial<ClaudeStatsOptions> = {},
    uploads: Upload[] = [],
    failUploads = 0
  ) {
    const path = join(tempDir(), 'stats-cache.json');
    if (days) writeCache(path, days);
    let failures = failUploads;
    const warned: string[] = [];
    const module = claudeStatsModule({
      statsPath: path,
      todayImpl: () => '2026-08-06',
      uploadImpl: async (app, file, data) => {
        if (failures > 0) {
          failures -= 1;
          throw new Error('device unreachable');
        }
        uploads.push({ app, file, data });
      },
      ...over,
    });
    module.init?.({
      applicationName: 'test_app',
      requestRender: () => {},
      pulseActivity: () => {},
      log: () => {},
      warn: (m) => warned.push(m),
      signal: new AbortController().signal,
    } satisfies ModuleContext);
    return { module, path, uploads, warned };
  }

  function writeCache(path: string, days: DayTokens[]): void {
    writeFileSync(
      path,
      JSON.stringify({
        version: 5,
        dailyModelTokens: days.map((d) => ({ date: d.date, tokensByModel: d.tokensByModel })),
      })
    );
  }

  const byId = (elements: { id?: string }[], id: string) => elements.find((el) => el.id === id) as any;

  test('poll uploads the asset under the host application name, once per mtime', async () => {
    const { module, path, uploads } = makeModule([day('2026-08-06', { 'claude-fable-5': 100 })]);
    await module.poll();
    expect(uploads).toHaveLength(1);
    expect(uploads[0]).toMatchObject({ app: 'test_app', file: ASSET_FILE });
    expect(new TextDecoder().decode(uploads[0]!.data.slice(0, 8))).toBe('bicycle0');

    await module.poll();
    expect(uploads).toHaveLength(1); // unchanged cache, no re-upload

    writeCache(path, [day('2026-08-06', { 'claude-fable-5': 100 }), day('2026-08-07', { 'claude-fable-5': 50 })]);
    utimesSync(path, new Date(), new Date(Date.now() + 5000));
    await module.poll();
    expect(uploads).toHaveLength(2);
  });

  test('renders text-only until the first upload lands, then the chart element', async () => {
    const { module, warned } = makeModule([day('2026-08-06', { 'claude-fable-5': 100 })], {}, [], 1);
    await module.poll(); // upload fails
    expect(warned.some((m) => m.includes('upload failed'))).toBe(true);
    expect(byId(module.render({ refreshing: false }), 'chart')).toBeUndefined();

    await module.poll(); // retry succeeds
    const chart = byId(module.render({ refreshing: false }), 'chart');
    expect(chart).toMatchObject({ type: 'animation', path: ASSET_FILE, section: '30d' });
  });

  test('encoder cycles 30D, 7D, ALL as section switches on one element id', async () => {
    const { module } = makeModule([day('2026-08-06', { 'claude-fable-5': 100 })]);
    await module.poll();
    expect(byId(module.render({ refreshing: false }), 'label').text).toBe('30D');

    module.onEncoder!(1);
    let elements = module.render({ refreshing: false });
    expect(byId(elements, 'chart').section).toBe('7d');
    expect(byId(elements, 'label').text).toBe('7D');

    module.onEncoder!(1);
    elements = module.render({ refreshing: false });
    expect(byId(elements, 'chart').section).toBe('heat');
    expect(byId(elements, 'label').text).toBe('ALL');
    // Heat text stacks in the left margin instead of the top row.
    expect(byId(elements, 'total')).toMatchObject({ align: 'mid_left', y: 8 });
    expect(byId(elements, 'age')).toMatchObject({ align: 'mid_left', y: 13 });

    module.onEncoder!(1);
    expect(byId(module.render({ refreshing: false }), 'label').text).toBe('30D');
  });

  test('every view shares the same four element ids — the app stays tiny', async () => {
    const { module } = makeModule([day('2026-08-06', { 'claude-fable-5': 100 })]);
    await module.poll();
    const ids = new Set<string>();
    for (let i = 0; i < 3; i++) {
      for (const el of module.render({ refreshing: false })) ids.add(el.id!);
      module.onEncoder!(1);
    }
    expect([...ids].sort()).toEqual(['age', 'chart', 'label', 'total']);
  });

  test('one day behind is the fresh steady state — no marks', async () => {
    // The cache scanner only folds in completed UTC days, so -1D is normal.
    const { module } = makeModule([day('2026-08-06', { 'claude-fable-5': 100 })], {
      todayImpl: () => '2026-08-07',
    });
    await module.poll();
    const elements = module.render({ refreshing: false });
    expect(byId(elements, 'label')).toMatchObject({ text: '30D', color: COLORS.label });
    expect(byId(elements, 'age').color).toBe(HIDDEN(COLORS.reset));
  });

  test('two or more days behind goes stale: ?, grey, and the age readout', async () => {
    const { module } = makeModule([day('2026-08-06', { 'claude-fable-5': 100 })], {
      todayImpl: () => '2026-08-08',
    });
    await module.poll();
    let elements = module.render({ refreshing: false });
    expect(byId(elements, 'label')).toMatchObject({ text: '30D?', color: COLORS.stale });
    expect(byId(elements, 'age')).toMatchObject({ text: '-2D', color: COLORS.reset });

    const far = makeModule([day('2026-08-06', { 'claude-fable-5': 100 })], { todayImpl: () => '2026-08-09' });
    await far.module.poll();
    elements = far.module.render({ refreshing: false });
    expect(byId(elements, 'age')).toMatchObject({ text: '-3D' });
  });

  test('fresh data hides the age element by alpha, not omission', async () => {
    const { module } = makeModule([day('2026-08-06', { 'claude-fable-5': 100 })]);
    await module.poll();
    const age = byId(module.render({ refreshing: false }), 'age');
    expect(age.color).toBe(HIDDEN(COLORS.reset));
    expect(age.text.length).toBeGreaterThan(0);
  });

  test('a missing cache renders NO STATS, keeps polling calmly, uploads nothing', async () => {
    const { module, uploads } = makeModule(null);
    expect(await module.poll()).toEqual({ nextPollMs: 60_000, holdRefreshMs: 0 });
    expect(uploads).toHaveLength(0);
    const elements = module.render({ refreshing: false });
    expect(elements).toHaveLength(1);
    expect(byId(elements, 'label')).toMatchObject({ text: 'NO STATS', color: COLORS.stale });
  });
});
