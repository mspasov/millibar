import { describe, expect, test } from 'bun:test';
import { COLORS, HIDDEN, scaleRgb } from '../display';
import type { ModuleContext } from '../module';
import { RateLimitError, type Usage } from '../usage';
import { claudeUsageCombinedModule } from './claude-usage-combined';
import type { UsageModuleOptions } from './usage-poller';

const usageFixture = (over: Partial<Usage> = {}): Usage => ({
  fiveHour: { utilization: 62, resetsAt: new Date(Date.now() + 2 * 3_600_000).toISOString() },
  sevenDay: { utilization: 31, resetsAt: new Date(Date.now() + 3 * 86_400_000).toISOString() },
  models: [{ model: 'Fable', utilization: 84, resetsAt: new Date(Date.now() + 3 * 86_400_000).toISOString() }],
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

function makeModule(fetchImpl: () => Promise<Usage>, over: Partial<UsageModuleOptions> = {}, ctx?: Partial<ModuleContext>) {
  const module = claudeUsageCombinedModule({
    pollIntervalMs: 300_000,
    refreshCooldownMs: 5_000,
    sweepMs: 0,
    sweepCoolMs: 0,
    cachePath: null,
    fetchUsageImpl: fetchImpl,
    ...over,
  });
  module.init?.({ ...nullContext(), ...ctx });
  return module;
}

const byId = (module: ReturnType<typeof makeModule>, refreshing = false) =>
  Object.fromEntries(
    (module.render({ refreshing }) as Array<Record<string, unknown>>).map((el) => [el.id as string, el])
  );

describe('render', () => {
  test('one bar row per window, with stable ids', async () => {
    const module = makeModule(async () => usageFixture());
    await module.poll();
    const ids = module.render({ refreshing: false }).map((el) => el.id);
    expect(ids).toEqual([
      'label', 'reset', 'pct',
      'w0track', 'w0fill', 'w0pace',
      'w1track', 'w1fill', 'w1pace',
      'w2track', 'w2fill', 'w2pace',
      'marker', 'head', 'dot0', 'dot1', 'dot2',
    ]);
  });

  test('the selected row is bright and marked; the others dim toward their severity colour', async () => {
    const module = makeModule(async () => usageFixture());
    await module.poll();
    const els = byId(module);
    // Selected (5H, 62%) at full warn brightness on the top row; the sweep
    // head rides its row.
    expect(els.label).toMatchObject({ text: '5H' });
    expect(els.pct).toMatchObject({ text: '62%', color: COLORS.warn });
    expect(els.w0fill).toMatchObject({ x: 3, y: 8, height: 2, fill_colors: [COLORS.warn] });
    expect(els.w1fill).toMatchObject({ y: 11, height: 2, fill_colors: [scaleRgb(COLORS.ok, 0.45)] });
    expect(els.w2fill).toMatchObject({ y: 14, height: 2, fill_colors: [scaleRgb(COLORS.critical, 0.45)] });
    expect(els.marker).toMatchObject({ y: 8, height: 2, fill_colors: [COLORS.label] });
    expect(els.head).toMatchObject({ y: 8 });
  });

  test('an encoder switch moves the marker and retargets the sweep', async () => {
    const module = makeModule(async () => usageFixture());
    await module.poll();
    module.onEncoder!(2); // 5H -> 7D -> FABLE
    const els = byId(module);
    expect(els.label).toMatchObject({ text: 'FABLE' });
    expect(els.pct).toMatchObject({ text: '84%', color: COLORS.critical });
    expect(els.w2fill).toMatchObject({ fill_colors: [COLORS.critical] });
    expect(els.w0fill).toMatchObject({ fill_colors: [scaleRgb(COLORS.warn, 0.45)] });
    expect(els.marker).toMatchObject({ y: 14, height: 2 });
    expect(els.head).toMatchObject({ y: 14 });
  });

  test('an encoder switch snaps the new bar to its own value while the number rolls', async () => {
    // Real sweep duration, long enough that nothing lands mid-test: any
    // animated value is still ~at its starting point when asserted.
    const controller = new AbortController();
    const module = makeModule(
      async () => usageFixture(),
      { sweepMs: 60_000, sweepCoolMs: 160 },
      { signal: controller.signal }
    );
    try {
      await module.poll();
      module.onEncoder!(2); // 5H -> FABLE (84%, critical)
      const els = byId(module);
      // The bar wears FABLE's own value and colour immediately — before the
      // fix it rendered the shared sweep, still down near the previous
      // window's position, and crawled up from there.
      expect(els.w2fill).toMatchObject({ width: 58, fill_colors: [COLORS.critical] }); // 84% of 69px
      // A snap is not a sweep: no head riding the selected row.
      expect(els.head).toMatchObject({ fill_colors: [HIDDEN('#FFFFFFFF')] });
      // The readout does roll — mid-flight, so not FABLE's value yet.
      expect((els.pct as { text: string }).text).not.toBe('84%');
      // The deselected row sits at its own last-polled value, dimmed.
      expect(els.w0fill).toMatchObject({ width: 43, fill_colors: [scaleRgb(COLORS.warn, 0.45)] }); // 62% of 69px
    } finally {
      controller.abort(); // stops the 60s sweep tickers
    }
  });

  test('a lone window keeps a chunky bar and hides the marker', async () => {
    const module = makeModule(async () => usageFixture({ sevenDay: null, models: [] }));
    await module.poll();
    const els = byId(module);
    expect(els.w0fill).toMatchObject({ y: 12, height: 3 });
    expect(els.w1fill).toBeUndefined();
    expect(els.marker).toMatchObject({ fill_colors: [HIDDEN(COLORS.label)] });
  });

  test('the selection survives a refresh that reorders the list', async () => {
    let usage = usageFixture();
    const module = makeModule(async () => usage);
    await module.poll();
    module.onEncoder!(2); // -> FABLE
    usage = usageFixture({ fiveHour: null }); // FABLE moves from index 2 to 1
    await module.poll();
    const els = byId(module);
    expect(els.label).toMatchObject({ text: 'FABLE' });
    expect(els.marker).toMatchObject({ y: 13 }); // second of two rows now
  });

  test('going stale dims every row to grey', async () => {
    let fail = false;
    const module = makeModule(async () => {
      if (fail) throw new Error('network down');
      return usageFixture();
    });
    await module.poll();
    fail = true;
    await module.poll();
    const els = byId(module);
    expect(els.label).toMatchObject({ text: '5H?', color: COLORS.stale });
    expect(els.w0fill).toMatchObject({ fill_colors: [COLORS.stale] });
    expect(els.w1fill).toMatchObject({ fill_colors: [scaleRgb(COLORS.stale, 0.45)] });
    expect(els.marker).toMatchObject({ fill_colors: [COLORS.stale] });
  });
});

describe('quiet mode', () => {
  test('suppresses the routine logs and the failure warn, for a module sharing a deduplicated fetch', async () => {
    const logs: string[] = [];
    const warns: string[] = [];
    let fail = false;
    const module = makeModule(
      async () => {
        if (fail) throw new Error('network down');
        return usageFixture();
      },
      { quiet: true },
      { log: (m) => logs.push(m), warn: (m) => warns.push(m) }
    );
    await module.poll(); // summary suppressed
    fail = true;
    await module.poll(); // failure warn suppressed
    expect(logs).toEqual([]);
    expect(warns).toEqual([]);
  });

  test('still returns the 429 back-off, silently', async () => {
    const logs: string[] = [];
    const module = makeModule(
      async () => {
        throw new RateLimitError(900);
      },
      { quiet: true },
      { log: (m) => logs.push(m) }
    );
    expect(await module.poll()).toEqual({ nextPollMs: 900_000, holdRefreshMs: 900_000 });
    expect(logs).toEqual([]);
  });
});
