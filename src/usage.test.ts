import { afterEach, describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDirs } from './test-util';
import { loadCachedUsage, saveCachedUsage, type Usage } from './usage';

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
