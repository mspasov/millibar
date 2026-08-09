import { describe, expect, test } from 'bun:test';
import type { ModuleContext } from '../module';
import { cpuModule, type CpuOptions } from './cpu';

const nullContext = (): ModuleContext => ({
  applicationName: 'test_app',
  requestRender: () => {},
  pulseActivity: () => {},
  log: () => {},
  warn: () => {},
  signal: new AbortController().signal,
});

function makeModule(options: CpuOptions) {
  const module = cpuModule(options);
  module.init?.(nullContext());
  return module;
}

const shownPct = (module: ReturnType<typeof makeModule>): string =>
  (module.render({ refreshing: false }).find((el) => el.id === 'pct') as { text: string }).text;

const shownLabel = (module: ReturnType<typeof makeModule>): string =>
  (module.render({ refreshing: false }).find((el) => el.id === 'label') as { text: string }).text;

describe('cpuModule', () => {
  test('normalises load by core count and clamps at 100%', async () => {
    const module = makeModule({ sweepMs: 0, sweepCoolMs: 0, cores: 8, loadavg: () => [4, 2, 16] });
    await module.poll();
    expect(shownLabel(module)).toBe('CPU 1M');
    expect(shownPct(module)).toBe('50%'); // 4 / 8 cores

    module.onEncoder?.(1);
    expect(shownLabel(module)).toBe('CPU 5M');
    expect(shownPct(module)).toBe('25%');

    module.onEncoder?.(1);
    expect(shownLabel(module)).toBe('CPU 15M');
    expect(shownPct(module)).toBe('100%'); // 16 / 8 cores, clamped

    // Wraps in both directions.
    module.onEncoder?.(1);
    expect(shownLabel(module)).toBe('CPU 1M');
    module.onEncoder?.(-1);
    expect(shownLabel(module)).toBe('CPU 15M');
  });

  test('local sampling never holds refreshes and polls on the 2s cadence', async () => {
    const module = makeModule({ sweepMs: 0, sweepCoolMs: 0, cores: 1, loadavg: () => [0, 0, 0] });
    expect(await module.poll()).toEqual({ nextPollMs: 2000, holdRefreshMs: 0 });
  });

  test('jitter under the floor snaps; larger moves sweep', async () => {
    // Real (short) sweep timing: with sweepMs 0 a snap and a sweep are
    // indistinguishable — the blind spot CLAUDE.md warns about.
    let load = 0.5;
    const module = makeModule({ sweepMs: 80, sweepCoolMs: 0, cores: 1, loadavg: () => [load, 0, 0] });

    await module.poll(); // 0 -> 50, well over the floor: animates
    expect(shownPct(module)).not.toBe('50%'); // still en route right after the poll
    await Bun.sleep(120);
    expect(shownPct(module)).toBe('50%');

    load = 0.51; // +1%, under the 3% floor: jumps silently
    await module.poll();
    expect(shownPct(module)).toBe('51%');

    load = 0.6; // +9%, over the floor: animates again
    await module.poll();
    expect(shownPct(module)).not.toBe('60%');
    await Bun.sleep(120);
    expect(shownPct(module)).toBe('60%');
  });
});
