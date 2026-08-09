import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { DisplayDrawParams } from '@busy-app/busy-lib';
import { DisplaySession } from './display';
import { runHost } from './host';
import type { MonitorModule, PollResult } from './module';

/** Same reset as connection.test.ts: the host resolves a connection and opens
 * the input stream at startup, and tests must never read the user's real route
 * config. A dead port is taken verbatim (no probe), so the host comes up
 * device-less — its designed failure mode — and every draw goes through the
 * injected session, never the wire. */
const ENV_KEYS = ['MBAR_CONFIG', 'BUSY_BAR_ADDR', 'BUSY_BAR_ROUTE', 'BUSY_BAR_TOKEN', 'BUSY_BAR_PASSWORD', 'XDG_CONFIG_HOME'];
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.BUSY_BAR_ADDR = '127.0.0.1:9';
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

const textEl = (id: string) => ({
  id, type: 'text' as const, text: 'X', font: 'small' as const, color: '#FFFFFFFF',
  align: 'mid_left' as const, x: 0, y: 5, display: 'front' as const,
});

/** Event log shared by draws, clears, and exits — the shutdown findings are
 * all about ordering, so one ordered list is the assertion surface. */
function harness() {
  const events: string[] = [];
  const exits: (number | undefined)[] = [];
  const session = new DisplaySession({
    applicationName: 'test_host',
    priority: 50,
    timeoutS: 90,
    send: async (body: DisplayDrawParams) => {
      events.push(`draw:${body.elements.map((el) => el.id).join(',')}`);
    },
    clear: async () => {
      events.push('clear');
    },
  });
  return { events, exits, session, exit: (code?: number) => { exits.push(code); } };
}

async function until(cond: () => boolean, what: string, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}

describe('runHost shutdown', () => {
  test('a poll resolving after quit cannot repaint the cleared display', async () => {
    const { events, exits, session, exit } = harness();
    let release: (() => void) | null = null;
    let polls = 0;
    const slow: MonitorModule = {
      id: 'slow',
      title: 'Slow',
      async poll(): Promise<PollResult> {
        polls++;
        if (polls === 1) return { nextPollMs: 30, holdRefreshMs: 0 };
        // The second poll hangs until the test releases it — after shutdown.
        await new Promise<void>((resolve) => { release = resolve; });
        return { nextPollMs: 60_000, holdRefreshMs: 0 };
      },
      render: () => [textEl('x')],
    };
    const stop = new AbortController();
    const run = runHost([slow], {
      session, exit, signal: stop.signal, animations: false, heartbeatMs: 60_000,
    });

    await until(() => release !== null, 'the second poll to be in flight');
    expect(events[0]).toBe('draw:slow.x'); // module ids are namespaced
    stop.abort(); // quit while the poll is in flight
    await until(() => events.includes('clear'), 'the shutdown clear');
    release!(); // the poll outlives the quit
    await run;

    expect(exits).toEqual([0]);
    // The whole point: nothing may land after the clear and re-register the
    // application on the shared display.
    expect(events[events.length - 1]).toBe('clear');
    expect(events.filter((e) => e === 'clear')).toHaveLength(1);
  });

  test('a second interrupt exits immediately instead of replaying the shutdown', async () => {
    const { events, exits, session, exit } = harness();
    const idle: MonitorModule = {
      id: 'idle',
      title: 'Idle',
      poll: async () => ({ nextPollMs: 60_000, holdRefreshMs: 0 }),
      render: () => [textEl('x')],
    };
    const run = runHost([idle], { session, exit, animations: false, heartbeatMs: 60_000 });

    await until(() => events.length > 0, 'the first paint');
    process.kill(process.pid, 'SIGINT');
    await run;
    expect(exits).toEqual([0]);

    process.kill(process.pid, 'SIGINT');
    await until(() => exits.length === 2, 'the force exit');
    // No second farewell/clear pass — just the exit, exitCode untouched.
    expect(exits[1]).toBeUndefined();
    expect(events.filter((e) => e === 'clear')).toHaveLength(1);
  });
});
