import { describe, expect, test } from 'bun:test';
import {
  MIN_INDICATOR_MS,
  ModuleRunner,
  selectModules,
  wrapIndex,
  type ModuleChoice,
  type MonitorModule,
  type PollResult,
} from './module';

describe('selectModules', () => {
  const roster: ModuleChoice<string>[] = [
    { aliases: ['gauge', 'claude-gauge'], value: 'G' },
    { aliases: ['dash', 'claude-dash'], value: 'D' },
    { aliases: ['cpu'], value: 'C' },
  ];

  test('preserves the given order — it is the cycle order', () => {
    expect(selectModules('cpu,gauge', roster)).toEqual(['C', 'G']);
    expect(selectModules('gauge,dash,cpu', roster)).toEqual(['G', 'D', 'C']);
  });

  test('accepts full ids, mixed case, and stray whitespace/commas', () => {
    expect(selectModules('Claude-Gauge, CPU,', roster)).toEqual(['G', 'C']);
  });

  test('a single module is a valid selection', () => {
    expect(selectModules('dash', roster)).toEqual(['D']);
  });

  test('an unknown name throws with the canonical names listed', () => {
    expect(() => selectModules('gauge,typo', roster)).toThrow("unknown module 'typo' — valid: gauge, dash, cpu");
  });

  test('the same module twice throws, even under two aliases', () => {
    expect(() => selectModules('gauge,cpu,gauge', roster)).toThrow("'gauge' is listed twice");
    expect(() => selectModules('gauge,claude-gauge', roster)).toThrow("'gauge' is listed twice");
  });

  test('an empty spec throws rather than selecting nothing', () => {
    expect(() => selectModules('', roster)).toThrow('empty selection');
    expect(() => selectModules(' , ', roster)).toThrow('empty selection');
  });
});

describe('wrapIndex', () => {
  test('wraps in both directions, including multi-step deltas', () => {
    expect(wrapIndex(0, 1, 3)).toBe(1);
    expect(wrapIndex(2, 1, 3)).toBe(0);
    expect(wrapIndex(0, -1, 3)).toBe(2);
    expect(wrapIndex(1, 5, 3)).toBe(0);
    expect(wrapIndex(1, -5, 3)).toBe(2);
  });

  test('is safe on an empty list', () => {
    expect(wrapIndex(0, 1, 0)).toBe(0);
  });
});

interface FakeModuleState {
  pollCount: number;
  module: MonitorModule;
}

function fakeModule(result: () => PollResult): FakeModuleState {
  const state: FakeModuleState = {
    pollCount: 0,
    module: {
      id: 'fake',
      title: 'Fake',
      async poll() {
        state.pollCount++;
        return result();
      },
      render: () => [],
    },
  };
  return state;
}

const sleep = (ms: number) => Bun.sleep(ms);

describe('ModuleRunner', () => {
  test('holds the activity indicator up for at least MIN_INDICATOR_MS', async () => {
    const fake = fakeModule(() => ({ nextPollMs: 60_000, holdRefreshMs: 0 }));
    const seen: boolean[] = [];
    const controller = new AbortController();
    const runner = new ModuleRunner(fake.module, () => seen.push(runner.refreshing), () => {});
    const run = runner.run(controller.signal);

    await sleep(MIN_INDICATOR_MS / 2);
    expect(seen).toEqual([true]); // poll was instant, but the dots must still be up
    await sleep(MIN_INDICATOR_MS);
    expect(seen).toEqual([true, false]);

    controller.abort();
    await run;
  });

  test('requestRefresh during the hold window repaints without polling', async () => {
    const fake = fakeModule(() => ({ nextPollMs: 60_000, holdRefreshMs: 60_000 }));
    let updates = 0;
    const logs: string[] = [];
    const controller = new AbortController();
    const runner = new ModuleRunner(fake.module, () => updates++, (m) => logs.push(m));
    const run = runner.run(controller.signal);

    await sleep(MIN_INDICATOR_MS + 50); // first poll done, now sleeping
    expect(fake.pollCount).toBe(1);
    const updatesBefore = updates;
    runner.requestRefresh('test');
    await sleep(50);
    expect(fake.pollCount).toBe(1); // no fetch
    expect(updates).toBe(updatesBefore + 1); // but a repaint
    expect(logs[0]).toMatch(/cooldown .*repainting without fetching/);

    controller.abort();
    await run;
  });

  test('requestRefresh outside the hold window starts the next poll early', async () => {
    const fake = fakeModule(() => ({ nextPollMs: 60_000, holdRefreshMs: 0 }));
    const controller = new AbortController();
    const runner = new ModuleRunner(fake.module, () => {}, () => {});
    const run = runner.run(controller.signal);

    await sleep(MIN_INDICATOR_MS + 50);
    expect(fake.pollCount).toBe(1);
    runner.requestRefresh('test');
    await sleep(50);
    expect(fake.pollCount).toBe(2);

    controller.abort();
    await run;
  });

  test('requestRefresh while a poll is in flight is a no-op', async () => {
    let release: (() => void) | null = null;
    const fake = fakeModule(() => ({ nextPollMs: 60_000, holdRefreshMs: 0 }));
    const slowModule: MonitorModule = {
      ...fake.module,
      async poll() {
        fake.pollCount++;
        await new Promise<void>((resolve) => { release = resolve; });
        return { nextPollMs: 60_000, holdRefreshMs: 0 };
      },
    };
    let updates = 0;
    const controller = new AbortController();
    const runner = new ModuleRunner(slowModule, () => updates++, () => {});
    const run = runner.run(controller.signal);

    await sleep(20); // poll is now blocked in flight
    const updatesBefore = updates;
    runner.requestRefresh('test');
    expect(updates).toBe(updatesBefore); // neither repaint nor second poll
    expect(fake.pollCount).toBe(1);

    release!();
    controller.abort();
    await run;
  });

  test('the 429-shaped hold gates refreshes for the whole back-off', async () => {
    const fake = fakeModule(() => ({ nextPollMs: 60_000, holdRefreshMs: 60_000 }));
    const controller = new AbortController();
    const runner = new ModuleRunner(fake.module, () => {}, () => {});
    const run = runner.run(controller.signal);

    await sleep(MIN_INDICATOR_MS + 50);
    runner.requestRefresh('test');
    runner.requestRefresh('test');
    await sleep(50);
    expect(fake.pollCount).toBe(1);

    controller.abort();
    await run;
  });

  test('abort during the inter-poll sleep ends the loop promptly', async () => {
    const fake = fakeModule(() => ({ nextPollMs: 3_600_000, holdRefreshMs: 0 }));
    const controller = new AbortController();
    const runner = new ModuleRunner(fake.module, () => {}, () => {});
    const run = runner.run(controller.signal);

    await sleep(MIN_INDICATOR_MS + 50);
    controller.abort();
    const settled = await Promise.race([run.then(() => true), sleep(200).then(() => false)]);
    expect(settled).toBe(true);
  });
});
