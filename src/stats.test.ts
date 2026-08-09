import { afterEach, describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { daysBetween, loadStatsHistory, parseStatsHistory, utcToday } from './stats';
import { tempDirs } from './test-util';

const { tempDir, cleanup } = tempDirs('mbar-stats-');
afterEach(cleanup);

const entry = (date: string, tokensByModel: Record<string, unknown>) => ({ date, tokensByModel });

describe('parseStatsHistory', () => {
  test('extracts, totals, and sorts dailyModelTokens', () => {
    const days = parseStatsHistory({
      version: 5,
      dailyModelTokens: [
        entry('2026-08-06', { 'claude-fable-5': 100, 'claude-opus-5': 50 }),
        entry('2026-08-05', { 'claude-fable-5': 10 }),
      ],
    });
    expect(days.map((d) => d.date)).toEqual(['2026-08-05', '2026-08-06']);
    expect(days[1]!.total).toBe(150);
  });

  test('skips malformed entries and non-finite token values', () => {
    const days = parseStatsHistory({
      dailyModelTokens: [
        entry('not-a-date', { m: 1 }),
        entry('2026-08-05', 'not-an-object' as unknown as Record<string, unknown>),
        { tokensByModel: { m: 1 } }, // no date at all
        null,
        entry('2026-08-06', { good: 5, nan: NaN, negative: -3, text: 'x' }),
      ],
    });
    expect(days).toEqual([{ date: '2026-08-06', tokensByModel: { good: 5 }, total: 5 }]);
  });

  test('duplicate dates collapse to the last entry', () => {
    const days = parseStatsHistory({
      dailyModelTokens: [entry('2026-08-06', { m: 1 }), entry('2026-08-06', { m: 9 })],
    });
    expect(days).toEqual([{ date: '2026-08-06', tokensByModel: { m: 9 }, total: 9 }]);
  });

  test('anything without a dailyModelTokens array parses to empty', () => {
    expect(parseStatsHistory(null)).toEqual([]);
    expect(parseStatsHistory({ version: 99 })).toEqual([]);
    expect(parseStatsHistory({ dailyModelTokens: 'nope' })).toEqual([]);
  });
});

describe('loadStatsHistory', () => {
  test('round-trips a real-shaped cache with its mtime', () => {
    const path = join(tempDir(), 'stats-cache.json');
    writeFileSync(path, JSON.stringify({ version: 5, dailyModelTokens: [entry('2026-08-06', { m: 7 })] }));
    const history = loadStatsHistory(path);
    expect(history?.days).toEqual([{ date: '2026-08-06', tokensByModel: { m: 7 }, total: 7 }]);
    expect(history?.modifiedAtMs).toBeGreaterThan(0);
  });

  test('missing, corrupt, and day-less files all read as null', () => {
    const dir = tempDir();
    expect(loadStatsHistory(join(dir, 'absent.json'))).toBeNull();

    const corrupt = join(dir, 'corrupt.json');
    writeFileSync(corrupt, '{ not json');
    expect(loadStatsHistory(corrupt)).toBeNull();

    const empty = join(dir, 'empty.json');
    writeFileSync(empty, JSON.stringify({ version: 5, dailyModelTokens: [] }));
    expect(loadStatsHistory(empty)).toBeNull();
  });
});

describe('date helpers', () => {
  test('utcToday buckets like the cache does', () => {
    expect(utcToday(new Date('2026-08-09T23:59:00Z'))).toBe('2026-08-09');
    expect(utcToday(new Date('2026-08-09T00:00:00Z'))).toBe('2026-08-09');
  });

  test('daysBetween counts whole days, signed', () => {
    expect(daysBetween('2026-08-06', '2026-08-09')).toBe(3);
    expect(daysBetween('2026-08-09', '2026-08-09')).toBe(0);
    expect(daysBetween('2026-08-09', '2026-08-06')).toBe(-3);
  });
});
