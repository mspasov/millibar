import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  fetchGrokUsage,
  GrokAuthError,
  hasGrokCredentials,
  loadCachedGrokUsage,
  NoGrokCredentialsError,
  pickGrokSession,
  saveCachedGrokUsage,
  type GrokWeeklyUsage,
} from './grok-usage';
import { tempDirs } from './test-util';
import { RateLimitError } from './usage';

const { tempDir, cleanup } = tempDirs('mbar-grok-');
afterEach(cleanup);

// All fixture tokens are fabricated. Real credentials never enter tests: the
// suite always points GROK_HOME at a temp directory before touching the file.
// Times are relative to the real clock — fetchGrokUsage judges expiry with
// Date.now(), so a pinned fixture date would rot.
const NOW = Date.now();
const LIVE = new Date(NOW + 3 * 3_600_000).toISOString();
const DEAD = new Date(NOW - 3_600_000).toISOString();

const session = (over: Record<string, unknown> = {}) => ({
  key: 'fixture-jwt',
  auth_mode: 'oidc',
  expires_at: LIVE,
  ...over,
});

describe('pickGrokSession', () => {
  test('prefers the auth.x.ai issuer among live sessions', () => {
    const picked = pickGrokSession(
      {
        'https://other.example::c1': session({ key: 'other' }),
        'https://auth.x.ai::c2': session({ key: 'xai' }),
      },
      NOW
    );
    expect(picked?.accessToken).toBe('xai');
  });

  test('a live token beats an expired preferred one', () => {
    const picked = pickGrokSession(
      {
        'https://auth.x.ai::c1': session({ key: 'dead-xai', expires_at: DEAD }),
        'https://other.example::c2': session({ key: 'live-other' }),
      },
      NOW
    );
    expect(picked?.accessToken).toBe('live-other');
  });

  test('among live entries the furthest expiry wins; unknown expiry counts as live', () => {
    const later = new Date(NOW + 6 * 3_600_000).toISOString();
    const picked = pickGrokSession(
      {
        'https://auth.x.ai::c1': session({ key: 'sooner' }),
        'https://auth.x.ai::c2': session({ key: 'later', expires_at: later }),
      },
      NOW
    );
    expect(picked?.accessToken).toBe('later');
    expect(pickGrokSession({ 'https://auth.x.ai::c3': session({ expires_at: undefined }) }, NOW)?.accessToken).toBe(
      'fixture-jwt'
    );
  });

  test('entries without a usable key are skipped; none at all is null', () => {
    const picked = pickGrokSession(
      {
        'https://auth.x.ai::c1': session({ key: '' }),
        'https://auth.x.ai::c2': 'junk',
        'https://other.example::c3': session({ key: 'usable' }),
      },
      NOW
    );
    expect(picked?.accessToken).toBe('usable');
    expect(pickGrokSession({ 'https://auth.x.ai::c1': session({ key: '' }) }, NOW)).toBeNull();
    expect(pickGrokSession('not an object', NOW)).toBeNull();
    expect(pickGrokSession(null, NOW)).toBeNull();
  });

  test('an expired-only file still yields its best entry, with its expiry', () => {
    const picked = pickGrokSession({ 'https://auth.x.ai::c1': session({ expires_at: DEAD }) }, NOW);
    expect(picked?.accessToken).toBe('fixture-jwt');
    expect(picked?.expiresAtMillis).toBe(Date.parse(DEAD));
  });
});

describe('fetchGrokUsage', () => {
  const realFetch = globalThis.fetch;
  let savedGrokHome: string | undefined;
  let requests: Array<{ url: string; headers: Record<string, string> }>;

  beforeEach(() => {
    savedGrokHome = process.env.GROK_HOME;
    requests = [];
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    if (savedGrokHome === undefined) delete process.env.GROK_HOME;
    else process.env.GROK_HOME = savedGrokHome;
  });

  const weeklyBody = (over: Record<string, unknown> = {}) => ({
    config: {
      creditUsagePercent: 3,
      currentPeriod: {
        type: 'USAGE_PERIOD_TYPE_WEEKLY',
        start: '2026-08-07T06:06:44.567993+00:00',
        end: '2026-08-14T06:06:44.567993+00:00',
      },
      ...over,
    },
  });

  const arrange = (auth: unknown, respond: () => Response) => {
    const home = tempDir();
    process.env.GROK_HOME = home;
    if (auth !== undefined) writeFileSync(join(home, 'auth.json'), JSON.stringify(auth));
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), headers: (init?.headers ?? {}) as Record<string, string> });
      return respond();
    }) as typeof fetch;
  };

  test('happy path: parses the weekly window and hits the exact credits URL', async () => {
    arrange({ 'https://auth.x.ai::c1': session() }, () => Response.json(weeklyBody()));
    const usage = await fetchGrokUsage();
    expect(usage.usedPercent).toBe(3);
    expect(usage.remainingPercent).toBe(97);
    expect(usage.periodStart).toBe('2026-08-07T06:06:44.567993+00:00');
    expect(usage.resetsAt).toBe('2026-08-14T06:06:44.567993+00:00');
    expect(usage.periodType).toBe('USAGE_PERIOD_TYPE_WEEKLY');
    // format=credits is load-bearing: without it the path serves a monthly
    // dollar envelope (docs/GROK-USAGE-API.md).
    expect(requests[0]!.url).toBe('https://cli-chat-proxy.grok.com/v1/billing?format=credits');
    expect(requests[0]!.headers['Authorization']).toBe('Bearer fixture-jwt');
    expect(requests[0]!.headers['Accept']).toBe('application/json');
  });

  test('a used percent past 100 clamps rather than rendering an overshoot', async () => {
    arrange({ 'https://auth.x.ai::c1': session() }, () => Response.json(weeklyBody({ creditUsagePercent: 104.2 })));
    const usage = await fetchGrokUsage();
    expect(usage.usedPercent).toBe(100);
    expect(usage.remainingPercent).toBe(0);
  });

  test('a missing auth.json is NoGrokCredentialsError, before any request', async () => {
    arrange(undefined, () => Response.json(weeklyBody()));
    expect(hasGrokCredentials()).toBe(false);
    await expect(fetchGrokUsage()).rejects.toBeInstanceOf(NoGrokCredentialsError);
    expect(requests).toHaveLength(0);
  });

  test('a leftover empty, keyless, or non-object auth.json is not credentials', async () => {
    // hasGrokCredentials must match the fetch path's predicate: a file that
    // exists but yields no session would pass an existsSync check, join the
    // default roster, and then die fatally on the first poll — the exact
    // failure the roster filter exists to prevent.
    for (const auth of [{}, { 'https://auth.x.ai::c1': session({ key: '' }) }, 'junk']) {
      arrange(auth, () => Response.json(weeklyBody()));
      expect(hasGrokCredentials()).toBe(false);
      await expect(fetchGrokUsage()).rejects.toBeInstanceOf(NoGrokCredentialsError);
    }
    // An expired session still counts: that failure is GrokAuthError, which
    // the poller survives (stale-dim), so the module belongs in the roster.
    arrange({ 'https://auth.x.ai::c1': session({ expires_at: DEAD }) }, () => Response.json(weeklyBody()));
    expect(hasGrokCredentials()).toBe(true);
  });

  test('an expired token errors with the login hint instead of spending a 401', async () => {
    arrange({ 'https://auth.x.ai::c1': session({ expires_at: DEAD }) }, () => Response.json(weeklyBody()));
    await expect(fetchGrokUsage()).rejects.toBeInstanceOf(GrokAuthError);
    await expect(fetchGrokUsage()).rejects.toThrow(/grok login/);
    expect(requests).toHaveLength(0);
  });

  test('401 and 403 are auth errors, not generic failures', async () => {
    for (const status of [401, 403]) {
      arrange({ 'https://auth.x.ai::c1': session() }, () => new Response('denied', { status }));
      const error = await fetchGrokUsage().then(
        () => null,
        (e: unknown) => e
      );
      expect(error).toBeInstanceOf(GrokAuthError);
      expect((error as Error).message).toContain(`${status}`);
    }
  });

  test('429 honours Retry-After with a 60s floor', async () => {
    arrange(
      { 'https://auth.x.ai::c1': session() },
      () => new Response('slow down', { status: 429, headers: { 'retry-after': '90' } })
    );
    await expect(fetchGrokUsage()).rejects.toEqual(new RateLimitError(90));

    arrange({ 'https://auth.x.ai::c1': session() }, () => new Response('slow down', { status: 429 }));
    await expect(fetchGrokUsage()).rejects.toEqual(new RateLimitError(60));

    arrange(
      { 'https://auth.x.ai::c1': session() },
      () => new Response('slow down', { status: 429, headers: { 'retry-after': '5' } })
    );
    await expect(fetchGrokUsage()).rejects.toEqual(new RateLimitError(60));
  });

  test('a non-weekly window is an error, never dressed up as weekly', async () => {
    arrange(
      { 'https://auth.x.ai::c1': session() },
      () => Response.json(weeklyBody({ currentPeriod: { type: 'USAGE_PERIOD_TYPE_MONTHLY' } }))
    );
    await expect(fetchGrokUsage()).rejects.toThrow(/not a weekly window.*MONTHLY/);
  });

  test('an omitted creditUsagePercent on a weekly window means 0 % used', async () => {
    // proto3-style JSON drops fields at their default: the first poll after
    // a weekly reset (nothing used yet) has no creditUsagePercent at all.
    // Observed live 2026-08-16; must not be mistaken for shape drift.
    arrange({ 'https://auth.x.ai::c1': session() }, () => Response.json(weeklyBody({ creditUsagePercent: undefined })));
    const usage = await fetchGrokUsage();
    expect(usage.usedPercent).toBe(0);
    expect(usage.remainingPercent).toBe(100);
    expect(usage.periodType).toBe('USAGE_PERIOD_TYPE_WEEKLY');
  });

  test('a non-numeric creditUsagePercent is a parse error, not 0', async () => {
    arrange({ 'https://auth.x.ai::c1': session() }, () => Response.json(weeklyBody({ creditUsagePercent: '3' })));
    await expect(fetchGrokUsage()).rejects.toThrow(/creditUsagePercent is not a number/);
  });

  test('the monthly envelope shape (no config.currentPeriod) is a parse error', async () => {
    // What the bare /v1/billing path returns — reaching this shape means the
    // query string was lost somewhere.
    arrange({ 'https://auth.x.ai::c1': session() }, () => Response.json({ monthlyLimit: 3000, used: 12 }));
    await expect(fetchGrokUsage()).rejects.toThrow(/unexpected response shape/);
  });
});

describe('grok usage cache', () => {
  const usage: GrokWeeklyUsage = {
    usedPercent: 3,
    remainingPercent: 97,
    periodStart: '2026-08-07T06:06:44.567993+00:00',
    resetsAt: '2026-08-14T06:06:44.567993+00:00',
    periodType: 'USAGE_PERIOD_TYPE_WEEKLY',
    fetchedAt: new Date('2026-08-09T10:00:00.000Z'),
  };

  test('round-trips through disk, creating directories and reviving fetchedAt', async () => {
    const path = join(tempDir(), 'nested', 'grok-usage.json');
    await saveCachedGrokUsage(usage, path);
    expect(loadCachedGrokUsage(path)).toEqual(usage);
  });

  test('missing, corrupt, or foreign files are simply no cache', () => {
    const dir = tempDir();
    expect(loadCachedGrokUsage(join(dir, 'absent.json'))).toBeNull();
    writeFileSync(join(dir, 'corrupt.json'), '{not json');
    expect(loadCachedGrokUsage(join(dir, 'corrupt.json'))).toBeNull();
    for (const fetchedAt of [0, null, true, ['2026-01-01']]) {
      writeFileSync(join(dir, 'foreign.json'), JSON.stringify({ ...usage, fetchedAt }));
      expect(loadCachedGrokUsage(join(dir, 'foreign.json'))).toBeNull();
    }
  });

  test('a cache that would not render (bad percent or missing period) is no cache', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'nan.json'), JSON.stringify({ ...usage, usedPercent: 'high' }));
    expect(loadCachedGrokUsage(join(dir, 'nan.json'))).toBeNull();
    writeFileSync(join(dir, 'no-reset.json'), JSON.stringify({ ...usage, resetsAt: undefined }));
    expect(loadCachedGrokUsage(join(dir, 'no-reset.json'))).toBeNull();
  });

  test('remainingPercent is recomputed from usedPercent, not trusted', () => {
    const path = join(tempDir(), 'edited.json');
    writeFileSync(path, JSON.stringify({ ...usage, usedPercent: 40, remainingPercent: 99 }));
    expect(loadCachedGrokUsage(path)?.remainingPercent).toBe(60);
  });

  test('a failed save is silent', async () => {
    // A directory where the file should be: Bun.write cannot replace it.
    await expect(saveCachedGrokUsage(usage, tempDir())).resolves.toBeUndefined();
  });
});
