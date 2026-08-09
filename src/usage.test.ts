import { afterEach, describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDirs } from './test-util';
import { collectModelWindows, dedupedFetchUsage, loadCachedUsage, saveCachedUsage, type ApiLimit, type Usage } from './usage';

const { tempDir, cleanup } = tempDirs('mbar-usage-');
afterEach(cleanup);

const usage: Usage = {
  fiveHour: { utilization: 62, resetsAt: '2026-08-07T12:00:00.000Z' },
  sevenDay: null,
  models: [{ model: 'Fable', utilization: 12, resetsAt: null }],
  fetchedAt: new Date('2026-08-07T10:00:00.000Z'),
};

describe('usage cache', () => {
  test('round-trips through disk, creating directories and reviving fetchedAt', async () => {
    // Nested path: proves the mbar/ directory is created on first save.
    const path = join(tempDir(), 'nested', 'usage.json');
    await saveCachedUsage(usage, path);
    expect(loadCachedUsage(path)).toEqual(usage);
  });

  test('a missing file is simply no cache', () => {
    expect(loadCachedUsage(join(tempDir(), 'absent.json'))).toBeNull();
  });

  test('corrupt JSON or a missing fetchedAt is simply no cache', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'corrupt.json'), '{not json');
    expect(loadCachedUsage(join(dir, 'corrupt.json'))).toBeNull();
    writeFileSync(join(dir, 'stampless.json'), JSON.stringify({ ...usage, fetchedAt: 'not a date' }));
    expect(loadCachedUsage(join(dir, 'stampless.json'))).toBeNull();
  });

  test('a non-string fetchedAt is not ours, even when Date would coerce it', () => {
    // {"fetchedAt": 0} would otherwise log "showing cached usage from 1970".
    const dir = tempDir();
    for (const fetchedAt of [0, null, true, ['2026-01-01']]) {
      const path = join(dir, 'foreign.json');
      writeFileSync(path, JSON.stringify({ ...usage, fetchedAt }));
      expect(loadCachedUsage(path)).toBeNull();
    }
  });

  test('a cache with nothing renderable is no cache', () => {
    // Seeding from it would announce cached usage over a blank screen.
    const path = join(tempDir(), 'empty.json');
    writeFileSync(path, JSON.stringify({ fetchedAt: usage.fetchedAt.toISOString() }));
    expect(loadCachedUsage(path)).toBeNull();
  });

  test('windows with a non-numeric utilization are dropped, not rendered as NaN%', () => {
    const path = join(tempDir(), 'usage.json');
    writeFileSync(
      path,
      JSON.stringify({
        fiveHour: { utilization: 'high', resetsAt: null },
        sevenDay: { utilization: 31 },
        models: [{ model: 'Fable', utilization: 12 }, { utilization: 9 }, 'junk'],
        fetchedAt: usage.fetchedAt.toISOString(),
      })
    );
    expect(loadCachedUsage(path)).toEqual({
      fiveHour: null,
      sevenDay: { utilization: 31, resetsAt: null },
      models: [{ model: 'Fable', utilization: 12, resetsAt: null }],
      fetchedAt: usage.fetchedAt,
    });
  });

  test('a failed save is silent', async () => {
    // A directory where the file should be: Bun.write cannot replace it.
    const path = tempDir();
    await expect(saveCachedUsage(usage, path)).resolves.toBeUndefined();
  });
});

describe('collectModelWindows', () => {
  test('a scoped limit without a percent is dropped, not shown as 0%', () => {
    const limits: ApiLimit[] = [
      { kind: 'weekly_scoped', scope: { model: { display_name: 'Fable' } } },
      { kind: 'weekly_scoped', percent: 0, scope: { model: { display_name: 'Opus' } } },
      { kind: 'weekly_scoped', percent: 12, resets_at: '2026-08-10T00:00:00Z', scope: { model: { display_name: 'Sonnet' } } },
    ];
    // A genuine 0% stays; only the missing value vanishes.
    expect(collectModelWindows(limits)).toEqual([
      { model: 'Opus', utilization: 0, resetsAt: null },
      { model: 'Sonnet', utilization: 12, resetsAt: '2026-08-10T00:00:00Z' },
    ]);
  });

  test('unscoped entries and duplicate models are filtered', () => {
    const limits: ApiLimit[] = [
      { kind: 'five_hour', percent: 62 },
      { kind: 'weekly_scoped', percent: 5, scope: { model: { display_name: 'Fable' } } },
      { kind: 'weekly_scoped', percent: 9, scope: { model: { display_name: 'Fable' } } },
    ];
    expect(collectModelWindows(limits)).toEqual([{ model: 'Fable', utilization: 5, resetsAt: null }]);
  });
});

describe('dedupedFetchUsage', () => {
  test('concurrent callers share one in-flight fetch', async () => {
    let calls = 0;
    const fetch = dedupedFetchUsage(60_000, async () => {
      calls += 1;
      await Bun.sleep(5);
      return usage;
    });
    const [a, b] = await Promise.all([fetch(), fetch()]);
    expect(calls).toBe(1);
    expect(a).toBe(usage);
    expect(b).toBe(usage);
  });

  test('within the TTL, later callers get the cached value without a request', async () => {
    let calls = 0;
    const fetch = dedupedFetchUsage(60_000, async () => {
      calls += 1;
      return usage;
    });
    await fetch();
    await fetch();
    expect(calls).toBe(1);
  });

  test('failures are cached like values — a sibling module must not re-provoke a 429', async () => {
    let calls = 0;
    const error = new Error('boom');
    const fetch = dedupedFetchUsage(60_000, async () => {
      calls += 1;
      throw error;
    });
    await expect(fetch()).rejects.toBe(error);
    await expect(fetch()).rejects.toBe(error);
    expect(calls).toBe(1);
  });

  test('past the TTL, the next call fetches live again', async () => {
    let calls = 0;
    const fetch = dedupedFetchUsage(0, async () => {
      calls += 1;
      return usage;
    });
    await fetch();
    await fetch();
    expect(calls).toBe(2);
  });
});
