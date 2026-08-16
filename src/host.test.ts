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
const ENV_KEYS = ['MBAR_CONFIG', 'MBAR_ADDR', 'MBAR_ROUTE', 'MBAR_TOKEN', 'MBAR_PASSWORD', 'XDG_CONFIG_HOME'];
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.MBAR_ADDR = '127.0.0.1:9';
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
    // The second interrupt is delivered while the first shutdown is provably
    // still in flight (the clear is blocked), because that is the only time
    // the host's own handler is attached. After the run the handlers must be
    // gone — a kill then would reach Bun's default handler and abort the
    // whole test process, which is exactly the leak this guards against.
    const events: string[] = [];
    const exits: (number | undefined)[] = [];
    let releaseClear: (() => void) | null = null;
    const session = new DisplaySession({
      applicationName: 'test_host',
      priority: 50,
      timeoutS: 90,
      send: async (body: DisplayDrawParams) => {
        events.push(`draw:${body.elements.map((el) => el.id).join(',')}`);
      },
      clear: async () => {
        events.push('clear');
        await new Promise<void>((resolve) => { releaseClear = resolve; });
      },
    });
    const idle: MonitorModule = {
      id: 'idle',
      title: 'Idle',
      poll: async () => ({ nextPollMs: 60_000, holdRefreshMs: 0 }),
      render: () => [textEl('x')],
    };
    const baseline = process.listenerCount('SIGINT');
    const stop = new AbortController();
    const run = runHost([idle], {
      session, exit: (code) => { exits.push(code); }, signal: stop.signal,
      animations: false, heartbeatMs: 60_000,
    });

    await until(() => events.length > 0, 'the first paint');
    expect(process.listenerCount('SIGINT')).toBe(baseline + 1);
    stop.abort(); // first quit — parks in the blocked clear
    await until(() => releaseClear !== null, 'the shutdown clear to start');

    process.kill(process.pid, 'SIGINT');
    await until(() => exits.length === 1, 'the force exit');
    // No second farewell/clear pass — just the exit, exitCode untouched.
    expect(exits[0]).toBeUndefined();

    releaseClear!();
    await run;
    // The interrupted shutdown still completes its ordinary exit…
    expect(exits).toEqual([undefined, 0]);
    expect(events.filter((e) => e === 'clear')).toHaveLength(1);
    // …and leaves nothing attached to the process.
    expect(process.listenerCount('SIGINT')).toBe(baseline);
  });

  test('a fatal poll error exits 1 through the injected exit, display cleared', async () => {
    // Setting process.exitCode and returning left an embedder awaiting the
    // exit callback hanging forever, with the signal handlers still attached.
    const { events, exits, session, exit } = harness();
    const fatal: MonitorModule = {
      id: 'fatal',
      title: 'Fatal',
      poll: async () => {
        throw Object.assign(new Error('no credentials'), { name: 'NoCredentialsError' });
      },
      render: () => [textEl('x')],
    };
    const baseline = process.listenerCount('SIGINT');
    const savedExitCode = process.exitCode;
    await runHost([fatal], { session, exit, animations: false, heartbeatMs: 60_000 });
    expect(exits).toEqual([1]);
    expect(events[events.length - 1]).toBe('clear');
    expect(process.listenerCount('SIGINT')).toBe(baseline);
    // The host also sets process.exitCode (so a mid-cleanup signal's bare
    // exit() keeps the failure); undo that here or the test runner inherits it.
    process.exitCode = savedExitCode;
  });
});
