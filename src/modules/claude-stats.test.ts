import { afterEach, describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { COLORS, HIDDEN } from '../display';
import type { ModuleContext } from '../module';
import type { DayTokens } from '../stats';
import { tempDirs } from '../test-util';
import {
  claudeStatsModule,
  formatTokensCompact,
  MODEL_COLORS,
  OTHER_COLOR,
  rankModels,
  stackSegments,
  windowDays,
  type ClaudeStatsOptions,
} from './claude-stats';

const { tempDir, cleanup } = tempDirs('mbar-stats-module-');
afterEach(cleanup);

const day = (date: string, tokensByModel: Record<string, number>): DayTokens => ({
  date,
  tokensByModel,
  total: Object.values(tokensByModel).reduce((a, b) => a + b, 0),
});

const nullContext = (): ModuleContext => ({
  requestRender: () => {},
  pulseActivity: () => {},
  log: () => {},
  warn: () => {},
  signal: new AbortController().signal,
});

/** Writes a cache file shaped like the real one and mounts the module on it. */
function makeModule(days: DayTokens[] | null, over: Partial<ClaudeStatsOptions> = {}) {
  const path = join(tempDir(), 'stats-cache.json');
  if (days) {
    writeFileSync(
      path,
      JSON.stringify({
        version: 5,
        dailyModelTokens: days.map((d) => ({ date: d.date, tokensByModel: d.tokensByModel })),
      })
    );
  }
  const module = claudeStatsModule({ statsPath: path, todayImpl: () => '2026-08-06', ...over });
  module.init?.(nullContext());
  return module;
}

const byId = (elements: { id?: string }[], id: string) => elements.find((el) => el.id === id) as any;

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

describe('rankModels', () => {
  test('orders by window total, name breaking ties', () => {
    const ranked = rankModels([
      day('2026-08-01', { small: 1, big: 90, tie_b: 5 }),
      day('2026-08-02', { big: 10, tie_a: 5 }),
    ]);
    expect(ranked).toEqual(['big', 'tie_a', 'tie_b', 'small']);
  });
});

describe('stackSegments', () => {
  test('segment heights sum exactly to the scaled bar height', () => {
    const segments = stackSegments(day('2026-08-01', { a: 33, b: 33, c: 34 }), ['a', 'b', 'c'], 100, 10);
    expect(segments.reduce((sum, s) => sum + s.height, 0)).toBe(10);
    expect(segments.map((s) => s.color)).toEqual([...MODEL_COLORS]);
  });

  test('models past the top three merge into the grey cap', () => {
    const segments = stackSegments(
      day('2026-08-01', { a: 40, b: 30, c: 20, d: 6, e: 4 }),
      ['a', 'b', 'c', 'd', 'e'],
      100,
      10
    );
    expect(segments.map((s) => s.color)).toEqual([...MODEL_COLORS, OTHER_COLOR]);
    expect(segments[3]!.height).toBe(1); // d + e together
  });

  test('an active day never rounds to nothing', () => {
    const segments = stackSegments(day('2026-08-01', { a: 1 }), ['a'], 1_000_000, 10);
    expect(segments).toEqual([{ color: MODEL_COLORS[0]!, height: 1 }]);
  });

  test('idle days produce no segments', () => {
    expect(stackSegments(day('2026-08-01', {}), ['a'], 100, 10)).toEqual([]);
  });
});

describe('formatTokensCompact', () => {
  test('matches Claude Code notation, uppercased', () => {
    expect(formatTokensCompact(1_234_567_890)).toBe('1.2B');
    expect(formatTokensCompact(999_950_000)).toBe('1.0B');
    expect(formatTokensCompact(114_822_351)).toBe('114.8M');
    expect(formatTokensCompact(62_000)).toBe('62K');
    expect(formatTokensCompact(999)).toBe('999');
  });
});

describe('module', () => {
  test('renders the 30-day view with bars right-aligned to x=70', async () => {
    const module = makeModule([day('2026-08-05', { m: 50 }), day('2026-08-06', { m: 100 })]);
    await module.poll();
    const elements = module.render({ refreshing: false });

    expect(byId(elements, 'label').text).toBe('30D');
    expect(byId(elements, 'total').text).toBe('150');
    // 30 slots of 1px bar + 1px gap span 59px, right edge inclusive at x=70.
    expect(byId(elements, 'base')).toMatchObject({ x: 12, width: 59, y: 15 });
    // Newest day is slot 29 at x=70, full height (window max); the day before
    // is slot 28 at x=68, half height.
    expect(byId(elements, 'b29s0')).toMatchObject({ x: 70, y: 6, width: 1, height: 10 });
    expect(byId(elements, 'b28s0')).toMatchObject({ x: 68, y: 11, width: 1, height: 5 });
  });

  test('encoder switches to the 7-day view with 8px bars', async () => {
    const module = makeModule([day('2026-08-06', { m: 100 })]);
    await module.poll();
    module.onEncoder!(1);
    const elements = module.render({ refreshing: false });

    expect(byId(elements, 'label').text).toBe('7D');
    expect(byId(elements, 'base')).toMatchObject({ x: 3, width: 68 });
    expect(byId(elements, 'b6s0')).toMatchObject({ x: 63, width: 8, y: 6, height: 10 });
  });

  test('data older than UTC today goes stale: ?, grey, and the age readout', async () => {
    const module = makeModule([day('2026-08-06', { m: 100 })], { todayImpl: () => '2026-08-09' });
    await module.poll();
    const elements = module.render({ refreshing: false });

    expect(byId(elements, 'label')).toMatchObject({ text: '30D?', color: COLORS.stale });
    expect(byId(elements, 'age')).toMatchObject({ text: '-3D', color: COLORS.reset });
    expect(byId(elements, 'total').color).toBe(COLORS.stale);
  });

  test('fresh data hides the age element by alpha, not omission', async () => {
    const module = makeModule([day('2026-08-06', { m: 100 })]);
    await module.poll();
    const age = byId(module.render({ refreshing: false }), 'age');
    expect(age.color).toBe(HIDDEN(COLORS.reset));
    expect(age.text.length).toBeGreaterThan(0);
  });

  test('a missing cache renders NO STATS and keeps polling calmly', async () => {
    const module = makeModule(null);
    expect(await module.poll()).toEqual({ nextPollMs: 60_000, holdRefreshMs: 0 });
    const elements = module.render({ refreshing: false });
    expect(elements).toHaveLength(1);
    expect(byId(elements, 'label')).toMatchObject({ text: 'NO STATS', color: COLORS.stale });
  });

  test('init alone already renders the chart — the first frame precedes the first poll', () => {
    const module = makeModule([day('2026-08-06', { m: 100 })]);
    expect(byId(module.render({ refreshing: false }), 'b29s0')).toBeDefined();
  });

  test('stacked segments keep rank order bottom-up per bar', async () => {
    const module = makeModule([day('2026-08-06', { top: 60, second: 30, third: 10 })]);
    await module.poll();
    const elements = module.render({ refreshing: false });
    const segments = [0, 1, 2].map((k) => byId(elements, `b29s${k}`));
    expect(segments.map((s) => s.fill_colors[0])).toEqual([...MODEL_COLORS]);
    expect(segments.map((s) => s.height)).toEqual([6, 3, 1]);
    // Bottom-up: rank 1 sits on the baseline, rank 3 on top.
    expect(segments.map((s) => s.y)).toEqual([10, 7, 6]);
  });
});
