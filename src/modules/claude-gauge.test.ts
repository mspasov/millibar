import { afterEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { COLORS, HIDDEN } from '../display';
import type { ModuleContext } from '../module';
import { tempDirs } from '../test-util';
import { loadCachedUsage, NoCredentialsError, RateLimitError, saveCachedUsage, type Usage } from '../usage';
import { buildScreens, claudeGaugeModule, type ClaudeGaugeOptions } from './claude-gauge';

const usageFixture = (over: Partial<Usage> = {}): Usage => ({
  fiveHour: { utilization: 62, resetsAt: new Date(Date.now() + 2 * 3_600_000).toISOString() },
  sevenDay: { utilization: 31, resetsAt: new Date(Date.now() + 3 * 86_400_000).toISOString() },
  models: [],
  fetchedAt: new Date(),
  ...over,
});

const nullContext = (): ModuleContext => {
  const context = {
    applicationName: 'test_app',
    requestRender: () => {},
    pulseActivity: () => {},
    log: () => {},
    warn: () => {},
    signal: new AbortController().signal,
  };
  return context;
};

const { tempDir: cacheDir, cleanup } = tempDirs('mbar-module-');
afterEach(cleanup);

function makeModule(fetchImpl: () => Promise<Usage>, over: Partial<ClaudeGaugeOptions> = {}) {
  const module = claudeGaugeModule({
    pollIntervalMs: 300_000,
    refreshCooldownMs: 5_000,
    // Instant sweeps by default so renders show settled values, and no cache
    // so tests never touch the real ~/.cache.
    sweepMs: 0,
    sweepCoolMs: 0,
    cachePath: null,
    fetchUsageImpl: fetchImpl,
    ...over,
  });
  module.init?.(nullContext());
  return module;
}

describe('buildScreens', () => {
  test('window order is 5H, 7D, then per-model weekly windows uppercased', () => {
    const screens = buildScreens(
      usageFixture({
        models: [{ model: 'Fable', utilization: 12, resetsAt: null }],
      })
    );
    expect(screens.map((v) => v.label)).toEqual(['5H', '7D', 'FABLE']);
    expect(screens[0]!.periodMs).toBe(5 * 3_600_000);
    expect(screens[2]!.periodMs).toBe(7 * 86_400_000);
  });

  test('missing windows are skipped', () => {
    const screens = buildScreens(usageFixture({ fiveHour: null }));
    expect(screens.map((v) => v.label)).toEqual(['7D']);
  });
});

describe('poll', () => {
  test('success returns the normal cadence and cooldown', async () => {
    const module = makeModule(async () => usageFixture());
    expect(await module.poll()).toEqual({ nextPollMs: 300_000, holdRefreshMs: 5_000 });
  });

  test('a 429 back-off gates both the next poll and manual refreshes', async () => {
    const module = makeModule(async () => {
      throw new RateLimitError(900);
    });
    expect(await module.poll()).toEqual({ nextPollMs: 900_000, holdRefreshMs: 900_000 });
  });

  test('a 429 shorter than the poll interval still waits a full interval', async () => {
    const module = makeModule(async () => {
      throw new RateLimitError(60);
    });
    expect(await module.poll()).toEqual({ nextPollMs: 300_000, holdRefreshMs: 300_000 });
  });

  test('consecutive 429s double the wait, capped at 4x the interval', async () => {
    const module = makeModule(async () => {
      throw new RateLimitError(60);
    });
    expect((await module.poll()).nextPollMs).toBe(300_000);
    expect((await module.poll()).nextPollMs).toBe(600_000);
    expect((await module.poll()).nextPollMs).toBe(1_200_000);
    expect((await module.poll()).nextPollMs).toBe(1_200_000); // capped
  });

  test('a successful fetch resets the 429 escalation', async () => {
    let limited = true;
    const module = makeModule(async () => {
      if (limited) throw new RateLimitError(60);
      return usageFixture();
    });
    await module.poll();
    await module.poll(); // escalated to 2x by now
    limited = false;
    await module.poll();
    limited = true;
    expect((await module.poll()).nextPollMs).toBe(300_000); // back to the base wait
  });

  test('other errors keep the normal cadence and mark the data stale', async () => {
    let fail = true;
    const module = makeModule(async () => {
      if (fail) throw new Error('network down');
      return usageFixture();
    });
    expect(await module.poll()).toEqual({ nextPollMs: 300_000, holdRefreshMs: 5_000 });
    // Before any successful fetch there is nothing to show, stale or not.
    expect(module.render({ refreshing: false })).toEqual([]);

    fail = false;
    await module.poll();
    fail = true;
    await module.poll();
    const label = module.render({ refreshing: false })[0] as { text: string; color: string };
    expect(label.text).toBe('5H?');
    expect(label.color).toBe(COLORS.stale);
  });

  test('a failed update blinks the light red once, after the cyan fetch pulse', async () => {
    const pulses: Array<{ color: string; shape?: unknown }> = [];
    let fail = false;
    const module = claudeGaugeModule({
      pollIntervalMs: 300_000,
      refreshCooldownMs: 5_000,
      sweepMs: 0,
      sweepCoolMs: 0,
      cachePath: null,
      fetchUsageImpl: async () => {
        if (fail) throw new Error('network down');
        return usageFixture();
      },
    });
    module.init?.({ ...nullContext(), pulseActivity: (color, shape) => pulses.push({ color, shape }) });

    await module.poll();
    expect(pulses).toEqual([{ color: COLORS.refresh, shape: undefined }]);

    fail = true;
    await module.poll();
    expect(pulses[1]).toEqual({ color: COLORS.refresh, shape: undefined });
    expect(pulses[2]).toEqual({ color: COLORS.critical, shape: { durationMs: 600, cycles: 1 } });
  });

  test('a 429 back-off does not blink red — it is routine, not a fault', async () => {
    const pulses: string[] = [];
    const module = claudeGaugeModule({
      pollIntervalMs: 300_000,
      refreshCooldownMs: 5_000,
      sweepMs: 0,
      sweepCoolMs: 0,
      cachePath: null,
      fetchUsageImpl: async () => {
        throw new RateLimitError(900);
      },
    });
    module.init?.({ ...nullContext(), pulseActivity: (color) => pulses.push(color) });
    await module.poll();
    expect(pulses).toEqual([COLORS.refresh]); // the fetch pulse only
  });

  test('a failed poll warns with the retry decision; recovery reports the stale stretch', async () => {
    const logs: string[] = [];
    const warns: string[] = [];
    let fail = true;
    const module = claudeGaugeModule({
      pollIntervalMs: 300_000,
      refreshCooldownMs: 5_000,
      sweepMs: 0,
      sweepCoolMs: 0,
      cachePath: null,
      fetchUsageImpl: async () => {
        if (fail) throw new Error('network down');
        return usageFixture();
      },
    });
    module.init?.({ ...nullContext(), log: (m) => logs.push(m), warn: (m) => warns.push(m) });

    await module.poll();
    expect(warns).toEqual(['poll failed (network down); showing stale values, retrying in 5m']);
    expect(logs).toEqual([]);

    fail = false;
    await module.poll();
    expect(logs[0]).toMatch(/^recovered after \d+s stale \(1 failed poll\)$/);
  });

  test('a 429 logs the back-off end as routine, not a warning', async () => {
    const logs: string[] = [];
    const warns: string[] = [];
    const module = claudeGaugeModule({
      pollIntervalMs: 300_000,
      refreshCooldownMs: 5_000,
      sweepMs: 0,
      sweepCoolMs: 0,
      cachePath: null,
      fetchUsageImpl: async () => {
        throw new RateLimitError(900);
      },
    });
    module.init?.({ ...nullContext(), log: (m) => logs.push(m), warn: (m) => warns.push(m) });

    await module.poll();
    expect(warns).toEqual([]);
    expect(logs[0]).toMatch(/^rate limited; showing stale values, next poll at \d\d:\d\d:\d\d \(refresh held\)$/);
  });

  test('the summary logs only when a value changes', async () => {
    const logs: string[] = [];
    let utilization = 62;
    const module = claudeGaugeModule({
      pollIntervalMs: 300_000,
      refreshCooldownMs: 5_000,
      sweepMs: 0,
      sweepCoolMs: 0,
      cachePath: null,
      fetchUsageImpl: async () =>
        usageFixture({
          fiveHour: { utilization, resetsAt: new Date(Date.now() + 3_600_000).toISOString() },
        }),
    });
    module.init?.({ ...nullContext(), log: (m) => logs.push(m) });

    await module.poll();
    await module.poll(); // unchanged values: no second line
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('5H 62%');

    utilization = 63;
    await module.poll();
    expect(logs).toHaveLength(2);
    expect(logs[1]).toContain('5H 63%');
  });

  test('missing credentials are fatal', async () => {
    const module = makeModule(async () => {
      throw new NoCredentialsError();
    });
    await expect(module.poll()).rejects.toBeInstanceOf(NoCredentialsError);
  });

  test('the selected window survives a refresh that reorders the list', async () => {
    let usage = usageFixture({ models: [{ model: 'Fable', utilization: 12, resetsAt: null }] });
    const module = makeModule(async () => usage);
    await module.poll();
    module.onEncoder!(2); // 5H -> FABLE
    expect((module.render({ refreshing: false })[0] as { text: string }).text).toBe('FABLE');

    usage = usageFixture({
      fiveHour: null, // FABLE moves from index 2 to 1
      models: [{ model: 'Fable', utilization: 12, resetsAt: null }],
    });
    await module.poll();
    expect((module.render({ refreshing: false })[0] as { text: string }).text).toBe('FABLE');
  });
});

describe('render', () => {
  test('produces the full 10-element frame with stable ids', async () => {
    const module = makeModule(async () => usageFixture());
    await module.poll();
    const elements = module.render({ refreshing: false });
    expect(elements.map((el) => el.id)).toEqual([
      'label', 'reset', 'pct', 'track', 'fill', 'pace', 'head', 'dot0', 'dot1', 'dot2',
    ]);
  });

  test('62% renders an amber bar, its percentage, and a fitting countdown', async () => {
    const module = makeModule(async () => usageFixture());
    await module.poll();
    const [label, reset, pct, , fill] = module.render({ refreshing: false }) as Array<Record<string, unknown>>;
    expect(label).toMatchObject({ text: '5H', color: COLORS.label });
    expect(reset).toMatchObject({ text: '2:00', color: COLORS.reset });
    expect(pct).toMatchObject({ text: '62%', color: COLORS.warn });
    expect(fill).toMatchObject({ width: Math.round((72 * 62) / 100), fill_colors: [COLORS.warn] });
  });

  test('while refreshing, the dots show and the countdown hides', async () => {
    const module = makeModule(async () => usageFixture());
    await module.poll();
    const elements = module.render({ refreshing: true }) as Array<Record<string, unknown>>;
    const reset = elements[1]!;
    const dot = elements[7]!;
    expect(reset.color).toBe(HIDDEN(COLORS.reset));
    expect(dot.fill_colors).toEqual([COLORS.refresh]);
  });

  test('the pace tick sits where "now" falls in the window', async () => {
    // 2h left of a 5h window: 60% elapsed of 71 columns -> x = 43.
    const module = makeModule(async () => usageFixture());
    await module.poll();
    const pace = module.render({ refreshing: false })[5] as { x: number };
    expect(pace.x).toBe(43);
  });

  test('an encoder switch retargets the sweep to the new window', async () => {
    const module = makeModule(async () => usageFixture());
    await module.poll();
    module.onEncoder!(1); // 5H 62% -> 7D 31%
    const [, , pct, , fill] = module.render({ refreshing: false }) as Array<Record<string, unknown>>;
    expect(pct).toMatchObject({ text: '31%', color: COLORS.ok });
    expect(fill).toMatchObject({ width: Math.round((72 * 31) / 100) });
  });

  test('a successful poll persists the read for the next run', async () => {
    const path = join(cacheDir(), 'usage.json');
    const module = makeModule(async () => usageFixture(), { cachePath: path });
    await module.poll();
    const cached = loadCachedUsage(path);
    expect(cached?.fiveHour?.utilization).toBe(62);
    expect(cached?.sevenDay?.utilization).toBe(31);
  });

  test('a restart with the API down starts from the cached read, stale until a live fetch', async () => {
    const path = join(cacheDir(), 'usage.json');
    await saveCachedUsage(usageFixture(), path);

    let fail = true;
    const module = makeModule(async () => {
      if (fail) throw new Error('network down');
      return usageFixture({ fiveHour: { utilization: 70, resetsAt: null } });
    }, { cachePath: path });

    // Before any poll: cached values render, marked stale.
    const prePoll = module.render({ refreshing: false }) as Array<Record<string, unknown>>;
    expect(prePoll[0]).toMatchObject({ text: '5H?', color: COLORS.stale });
    expect(prePoll[2]).toMatchObject({ text: '62%', color: COLORS.stale });

    await module.poll(); // fails — cached values stay up
    expect((module.render({ refreshing: false })[0] as { text: string }).text).toBe('5H?');

    fail = false;
    await module.poll();
    const fresh = module.render({ refreshing: false }) as Array<Record<string, unknown>>;
    expect(fresh[0]).toMatchObject({ text: '5H', color: COLORS.label });
    expect(fresh[2]).toMatchObject({ text: '70%', color: COLORS.warn });
  });

  test('with a live sweep, a render right after the poll is still in flight', async () => {
    // A sweep far longer than the test: the first frame shows the start of
    // the roll up from 0% with the leading edge lit, not the settled value.
    const controller = new AbortController();
    const module = claudeGaugeModule({
      pollIntervalMs: 300_000,
      refreshCooldownMs: 5_000,
      sweepMs: 600_000,
      cachePath: null,
      fetchUsageImpl: async () => usageFixture(),
    });
    module.init?.({ ...nullContext(), signal: controller.signal });
    try {
      await module.poll();
      await Bun.sleep(5); // just past t=0, where the eased pct is still exactly 0 and the head hidden
      const [, , pct, , , , head] = module.render({ refreshing: false }) as Array<Record<string, unknown>>;
      expect(pct).toMatchObject({ text: '0%' });
      expect((head!.fill_colors as string[])[0]!.endsWith('00')).toBe(false);
    } finally {
      controller.abort(); // stops the sweep's repaint ticker
    }
  });
});
