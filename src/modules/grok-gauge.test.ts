import { afterEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { COLORS } from '../display';
import { GrokAuthError, NoGrokCredentialsError, saveCachedGrokUsage, type GrokWeeklyUsage } from '../grok-usage';
import type { ModuleContext } from '../module';
import { tempDirs } from '../test-util';
import { buildGrokScreens, grokGaugeModule, type GrokGaugeOptions } from './grok-gauge';

const { tempDir, cleanup } = tempDirs('mbar-grok-module-');
afterEach(cleanup);

const usageFixture = (over: Partial<GrokWeeklyUsage> = {}): GrokWeeklyUsage => ({
  usedPercent: 3,
  remainingPercent: 97,
  periodStart: new Date(Date.now() - 3 * 86_400_000).toISOString(),
  resetsAt: new Date(Date.now() + 4 * 86_400_000).toISOString(),
  periodType: 'USAGE_PERIOD_TYPE_WEEKLY',
  fetchedAt: new Date(),
  ...over,
});

const nullContext = (): ModuleContext => ({
  applicationName: 'test_app',
  requestRender: () => {},
  pulseActivity: () => {},
  log: () => {},
  warn: () => {},
  signal: new AbortController().signal,
});

function makeModule(fetchImpl: () => Promise<GrokWeeklyUsage>, over: Partial<GrokGaugeOptions> = {}) {
  const module = grokGaugeModule({
    pollIntervalMs: 300_000,
    refreshCooldownMs: 5_000,
    // Instant sweeps so renders show settled values, and no cache so tests
    // never touch the real ~/.cache.
    sweepMs: 0,
    sweepCoolMs: 0,
    cachePath: null,
    fetchUsageImpl: fetchImpl,
    ...over,
  });
  module.init?.(nullContext());
  return module;
}

describe('buildGrokScreens', () => {
  test('one GROK screen whose window length is measured from the timestamps', () => {
    const screens = buildGrokScreens(usageFixture());
    expect(screens).toHaveLength(1);
    expect(screens[0]!.label).toBe('GROK');
    expect(screens[0]!.window.utilization).toBe(3);
    expect(screens[0]!.periodMs).toBe(7 * 86_400_000);
  });

  test('an unparseable period start falls back to seven days', () => {
    const screens = buildGrokScreens(usageFixture({ periodStart: 'not a date' }));
    expect(screens[0]!.periodMs).toBe(7 * 86_400_000);
  });
});

describe('grok gauge', () => {
  test('renders the GROK label and the used percentage on the shared layout', async () => {
    const module = makeModule(async () => usageFixture());
    expect(module.id).toBe('grok-gauge');
    await module.poll();
    const elements = module.render({ refreshing: false }) as Array<Record<string, unknown>>;
    expect(elements.map((el) => el.id)).toEqual([
      'label', 'reset', 'pct', 'track', 'fill', 'pace', 'head', 'dot0', 'dot1', 'dot2',
    ]);
    expect(elements[0]).toMatchObject({ text: 'GROK', color: COLORS.label });
    expect(elements[2]).toMatchObject({ text: '3%', color: COLORS.ok });
  });

  test('the pace tick sits where "now" falls in the provided period', async () => {
    // 3 of 7 days elapsed over 71 columns: round(3/7 * 71) = 30.
    const module = makeModule(async () => usageFixture());
    await module.poll();
    const pace = module.render({ refreshing: false })[5] as { x: number };
    expect(pace.x).toBe(30);
  });

  test('missing credentials are fatal — only `grok login` fixes them', async () => {
    const module = makeModule(async () => {
      throw new NoGrokCredentialsError();
    });
    await expect(module.poll()).rejects.toBeInstanceOf(NoGrokCredentialsError);
  });

  test('an expired token is routine: stale dimming, not a crash', async () => {
    let expired = false;
    const module = makeModule(async () => {
      if (expired) throw new GrokAuthError('Grok token expired — run `grok login`');
      return usageFixture();
    });
    await module.poll();
    expired = true;
    expect(await module.poll()).toEqual({ nextPollMs: 300_000, holdRefreshMs: 5_000 });
    const label = module.render({ refreshing: false })[0] as { text: string; color: string };
    expect(label.text).toBe('GROK?');
    expect(label.color).toBe(COLORS.stale);
  });

  test('a restart seeds from the cache, stale until a live fetch', async () => {
    const path = join(tempDir(), 'grok-usage.json');
    await saveCachedGrokUsage(usageFixture({ usedPercent: 42 }), path);
    const module = makeModule(
      async () => {
        throw new GrokAuthError('Grok token expired');
      },
      { cachePath: path }
    );
    const prePoll = module.render({ refreshing: false }) as Array<Record<string, unknown>>;
    expect(prePoll[0]).toMatchObject({ text: 'GROK?', color: COLORS.stale });
    expect(prePoll[2]).toMatchObject({ text: '42%', color: COLORS.stale });
  });

  test('a successful poll persists the read for the next run', async () => {
    const path = join(tempDir(), 'grok-usage.json');
    const module = makeModule(async () => usageFixture({ usedPercent: 12 }), { cachePath: path });
    await module.poll();
    const seeded = makeModule(async () => usageFixture(), { cachePath: path });
    const prePoll = seeded.render({ refreshing: false }) as Array<Record<string, unknown>>;
    expect(prePoll[2]).toMatchObject({ text: '12%' });
  });

  test('the encoder is a no-op on the single screen', async () => {
    const module = makeModule(async () => usageFixture());
    await module.poll();
    const before = module.render({ refreshing: false })[0];
    module.onEncoder?.(1);
    expect(module.render({ refreshing: false })[0]).toEqual(before);
  });
});
