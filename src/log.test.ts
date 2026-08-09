import { afterEach, describe, expect, setSystemTime, spyOn, test } from 'bun:test';
import { clockTime, formatDuration, log, logError, logResolved } from './log';

// The incident map inside log.ts is module-global and keyed by scope, so each
// test uses its own scope instead of resetting shared state.
let scopeCounter = 0;
const freshScope = () => `test${scopeCounter++}`;

const T0 = new Date('2026-08-09T14:00:00');

let out: ReturnType<typeof spyOn>;
let err: ReturnType<typeof spyOn>;

function capture(): void {
  out = spyOn(console, 'log').mockImplementation(() => {});
  err = spyOn(console, 'error').mockImplementation(() => {});
}

afterEach(() => {
  out?.mockRestore();
  err?.mockRestore();
  setSystemTime();
});

describe('formatDuration', () => {
  test('picks the coarsest unit that stays readable', () => {
    expect(formatDuration(45_000)).toBe('45s');
    expect(formatDuration(89_000)).toBe('89s');
    expect(formatDuration(14 * 60_000)).toBe('14m');
    expect(formatDuration(125 * 60_000)).toBe('2h 05m');
  });
});

describe('log', () => {
  test('stamps the local time and scope', () => {
    capture();
    setSystemTime(T0);
    log('claude', '5H 12%');
    expect(out.mock.calls[0]![0]).toBe(`${clockTime(T0.getTime())} [claude] 5H 12%`);
    expect(err).not.toHaveBeenCalled();
  });
});

describe('logError coalescing', () => {
  test('first failure logs immediately, to stderr', () => {
    capture();
    setSystemTime(T0);
    logError(freshScope(), 'fetch failed');
    expect(err).toHaveBeenCalledTimes(1);
    expect(err.mock.calls[0]![0]).toContain('fetch failed');
  });

  test('identical repeats inside the window are suppressed, then summarised', () => {
    capture();
    const scope = freshScope();
    setSystemTime(T0);
    logError(scope, 'fetch failed');
    // Reconnect-style spam: once a minute for nine minutes stays silent.
    for (let m = 1; m <= 9; m++) {
      setSystemTime(new Date(T0.getTime() + m * 60_000));
      logError(scope, 'fetch failed');
    }
    expect(err).toHaveBeenCalledTimes(1);

    setSystemTime(new Date(T0.getTime() + 10 * 60_000));
    logError(scope, 'fetch failed');
    expect(err).toHaveBeenCalledTimes(2);
    expect(err.mock.calls[1]![0]).toContain(`still failing (11x since ${clockTime(T0.getTime())})`);
  });

  test('a different message starts a new incident and logs immediately', () => {
    capture();
    const scope = freshScope();
    setSystemTime(T0);
    logError(scope, 'fetch failed');
    setSystemTime(new Date(T0.getTime() + 60_000));
    logError(scope, 'HTTP 500');
    expect(err).toHaveBeenCalledTimes(2);
    expect(err.mock.calls[1]![0]).toContain('HTTP 500');
  });

  test('a quiet gap longer than the window starts a new incident', () => {
    capture();
    const scope = freshScope();
    setSystemTime(T0);
    logError(scope, 'fetch failed');
    // Hours later the same message is a new outage, not repeat #2.
    const later = T0.getTime() + 3 * 3_600_000;
    setSystemTime(new Date(later));
    logError(scope, 'fetch failed');
    expect(err).toHaveBeenCalledTimes(2);
    expect(err.mock.calls[1]![0]).toBe(`${clockTime(later)} [${scope}] fetch failed`);
  });
});

describe('logResolved', () => {
  test('after coalesced repeats, logs one recovery line with the count', () => {
    capture();
    const scope = freshScope();
    setSystemTime(T0);
    logError(scope, 'fetch failed');
    setSystemTime(new Date(T0.getTime() + 60_000));
    logError(scope, 'fetch failed');
    setSystemTime(new Date(T0.getTime() + 120_000));
    logResolved(scope);
    expect(out).toHaveBeenCalledTimes(1);
    expect(out.mock.calls[0]![0]).toContain(`recovered after 2 failures (first at ${clockTime(T0.getTime())})`);
  });

  test('a single blip recovers silently — its one error line is enough', () => {
    capture();
    const scope = freshScope();
    setSystemTime(T0);
    logError(scope, 'fetch failed');
    logResolved(scope);
    expect(out).not.toHaveBeenCalled();
  });

  test('a healthy scope resolves as a no-op', () => {
    capture();
    logResolved(freshScope());
    expect(out).not.toHaveBeenCalled();
    expect(err).not.toHaveBeenCalled();
  });
});
