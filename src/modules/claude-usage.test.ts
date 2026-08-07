import { describe, expect, test } from 'bun:test';
import { COLORS, HIDDEN } from '../display';
import type { ModuleContext } from '../module';
import { NoCredentialsError, RateLimitError, type Usage } from '../usage';
import { buildViews, claudeUsageModule } from './claude-usage';

const usageFixture = (over: Partial<Usage> = {}): Usage => ({
  fiveHour: { utilization: 62, resetsAt: new Date(Date.now() + 2 * 3_600_000).toISOString() },
  sevenDay: { utilization: 31, resetsAt: new Date(Date.now() + 3 * 86_400_000).toISOString() },
  models: [],
  fetchedAt: new Date(),
  ...over,
});

const nullContext = (): ModuleContext => ({
  requestRender: () => {},
  pulseActivity: () => {},
  log: () => {},
  signal: new AbortController().signal,
});

function makeModule(fetchImpl: () => Promise<Usage>, sweepMs = 0) {
  const module = claudeUsageModule({
    pollIntervalMs: 300_000,
    refreshCooldownMs: 5_000,
    // Instant sweeps by default so renders show settled values.
    sweepMs,
    sweepCoolMs: 0,
    fetchUsageImpl: fetchImpl,
  });
  module.init?.(nullContext());
  return module;
}

describe('buildViews', () => {
  test('window order is 5H, 7D, then per-model weekly windows uppercased', () => {
    const views = buildViews(
      usageFixture({
        models: [{ model: 'Fable', utilization: 12, resetsAt: null }],
      })
    );
    expect(views.map((v) => v.label)).toEqual(['5H', '7D', 'FABLE']);
    expect(views[0]!.periodMs).toBe(5 * 3_600_000);
    expect(views[2]!.periodMs).toBe(7 * 86_400_000);
  });

  test('missing windows are skipped', () => {
    const views = buildViews(usageFixture({ fiveHour: null }));
    expect(views.map((v) => v.label)).toEqual(['7D']);
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

  test('with a live sweep, a render right after the poll is still in flight', async () => {
    // A sweep far longer than the test: the first frame shows the start of
    // the roll up from 0% with the leading edge lit, not the settled value.
    const controller = new AbortController();
    const module = claudeUsageModule({
      pollIntervalMs: 300_000,
      refreshCooldownMs: 5_000,
      sweepMs: 600_000,
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
