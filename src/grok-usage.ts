/**
 * Reads the SuperGrok / Grok Build shared weekly credit pool — the data behind
 * the Grok CLI's /usage panel. See docs/GROK-USAGE-API.md; there is no public
 * xAI doc for this endpoint, and the `?format=credits` query is load-bearing
 * (without it the same path returns a monthly dollar envelope that must not be
 * shown as the weekly gauge).
 *
 * Scope is the weekly window only: used %, remaining %, period start, reset.
 * Product split, on-demand caps, and prepaid balance are deliberately ignored.
 *
 * The OIDC access token from ~/.grok/auth.json stays in memory: never logged,
 * never written into our cache, never passed as an argv where `ps` could read
 * it — the same rules as the Claude token (docs/USAGE-API.md).
 */
import { existsSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { RateLimitError } from './usage';

const BILLING_URL = 'https://cli-chat-proxy.grok.com/v1/billing?format=credits';
/** Skip the request when the token expires this close to now: the file's
 * expiry is authoritative (docs/GROK-USAGE-API.md suggests 1–2 min of skew),
 * and a knowingly-dead token would just spend a request on a 401. */
const EXPIRY_SKEW_MS = 2 * 60 * 1000;

export interface GrokWeeklyUsage {
  /** 0–100, how much of the weekly pool is used. */
  usedPercent: number;
  /** 0–100, `100 - usedPercent`. */
  remainingPercent: number;
  periodStart: string; // ISO-8601
  resetsAt: string; // ISO-8601 = period end
  periodType: string; // USAGE_PERIOD_TYPE_WEEKLY
  fetchedAt: Date;
}

/** No auth.json (or nothing usable in it): the user never ran `grok login`
 * here. Fatal to a monitor module — retrying cannot fix it. */
export class NoGrokCredentialsError extends Error {
  constructor() {
    super('no Grok credentials found — run `grok login` to sign in');
    this.name = 'NoGrokCredentialsError';
  }
}

/** The stored token is expired or the API rejected it. NOT fatal: Grok
 * tokens live ~6 hours, and any normal `grok` use rewrites auth.json — the
 * monitor keeps polling (stale-dimmed) and recovers when the file does. */
export class GrokAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GrokAuthError';
  }
}

export function grokAuthPath(): string {
  const home = process.env.GROK_HOME ?? join(homedir(), '.grok');
  return join(home, 'auth.json');
}

/** Whether a `grok login` has ever happened here — mbar uses this to leave
 * the Grok module out of the default roster rather than die on first poll. */
export function hasGrokCredentials(): boolean {
  return existsSync(grokAuthPath());
}

interface GrokCredentials {
  accessToken: string;
  expiresAtMillis: number | null;
}

/**
 * Picks the session to use from a parsed auth.json: a top-level object keyed
 * by `<issuer>::<client-id>`, each value holding `key` (the JWT) and
 * `expires_at`. Preference order: a live token beats an expired one, the
 * auth.x.ai issuer (current SuperGrok OIDC) beats others, later expiry beats
 * earlier. An expired-only file still returns its best entry — the caller
 * distinguishes "expired" from "absent" for the error message.
 */
export function pickGrokSession(parsed: unknown, nowMs: number): GrokCredentials | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const candidates = Object.entries(parsed as Record<string, unknown>).flatMap(([issuerKey, entry]) => {
    if (!entry || typeof entry !== 'object') return [];
    const { key, expires_at } = entry as Record<string, unknown>;
    if (typeof key !== 'string' || key.length === 0) return [];
    const expiry = typeof expires_at === 'string' ? new Date(expires_at).getTime() : NaN;
    return [
      {
        accessToken: key,
        expiresAtMillis: Number.isFinite(expiry) ? expiry : null,
        // Unknown expiry counts as live: better one speculative request than
        // discarding a token that may work.
        live: !Number.isFinite(expiry) || expiry > nowMs,
        preferred: issuerKey.startsWith('https://auth.x.ai::'),
      },
    ];
  });
  candidates.sort(
    (a, b) =>
      Number(b.live) - Number(a.live) ||
      Number(b.preferred) - Number(a.preferred) ||
      (b.expiresAtMillis ?? 0) - (a.expiresAtMillis ?? 0)
  );
  const best = candidates[0];
  return best ? { accessToken: best.accessToken, expiresAtMillis: best.expiresAtMillis } : null;
}

function readGrokCredentials(): GrokCredentials | null {
  let raw: string;
  try {
    raw = readFileSync(grokAuthPath(), 'utf8');
  } catch {
    return null;
  }
  try {
    return pickGrokSession(JSON.parse(raw), Date.now());
  } catch {
    return null;
  }
}

/** Raw body of the last fetch, for debugging shape drift in the undocumented
 * API (`bun run src/grok-usage.ts --raw`). Carries no credentials. */
export let lastRawGrokBody: unknown = null;

/**
 * Fetch the current weekly pool. The credentials file is re-read on every
 * call — the Grok CLI refreshes it as a side effect of normal use, and
 * delegating refresh to it beats reimplementing OIDC with private client
 * details here.
 */
export async function fetchGrokUsage(): Promise<GrokWeeklyUsage> {
  const credentials = readGrokCredentials();
  if (!credentials) throw new NoGrokCredentialsError();
  if (credentials.expiresAtMillis !== null && credentials.expiresAtMillis <= Date.now() + EXPIRY_SKEW_MS) {
    throw new GrokAuthError('Grok token expired — run `grok login` (any grok CLI use refreshes it)');
  }

  const response = await fetch(BILLING_URL, {
    headers: {
      Authorization: `Bearer ${credentials.accessToken}`,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (response.status === 401 || response.status === 403) {
    throw new GrokAuthError(`Grok token rejected (HTTP ${response.status}) — run \`grok login\``);
  }
  if (response.status === 429) {
    // Conservative 60s floor even when Retry-After is present but short: the
    // endpoint's cadence is minutes, nothing needs a faster retry.
    throw new RateLimitError(Math.max(Number(response.headers.get('retry-after')) || 0, 60));
  }
  if (!response.ok) {
    throw new Error(`grok usage request failed: HTTP ${response.status}`);
  }

  const body = (await response.json()) as {
    config?: {
      creditUsagePercent?: unknown;
      currentPeriod?: { type?: unknown; start?: unknown; end?: unknown } | null;
    } | null;
  };
  lastRawGrokBody = body;

  const config = body.config;
  const period = config?.currentPeriod;
  if (!period) {
    throw new Error('grok usage: unexpected response shape (no config.currentPeriod)');
  }
  // proto3-style JSON: a field at its default value is omitted, so a weekly
  // window with nothing used yet has no creditUsagePercent at all (observed
  // 2026-08-16, first poll after a reset). Absent means 0; the monthly
  // envelope is still told apart by its missing currentPeriod above.
  const used = config?.creditUsagePercent ?? 0;
  if (typeof used !== 'number' || !Number.isFinite(used)) {
    throw new Error(`grok usage: creditUsagePercent is not a number (${JSON.stringify(used)})`);
  }
  // Weekly only, by explicit type check: the same path without format=credits
  // serves a monthly envelope, and pretending that is a weekly window is the
  // documented failure mode of community tools (docs/GROK-USAGE-API.md).
  if (period.type !== 'USAGE_PERIOD_TYPE_WEEKLY') {
    throw new Error(`grok usage: not a weekly window (type ${JSON.stringify(period.type ?? null)})`);
  }
  const { start, end } = period;
  if (typeof start !== 'string' || typeof end !== 'string') {
    throw new Error('grok usage: currentPeriod is missing start/end');
  }

  const usedPercent = Math.min(100, Math.max(0, used));
  return {
    usedPercent,
    remainingPercent: 100 - usedPercent,
    periodStart: start,
    resetsAt: end,
    periodType: period.type,
    fetchedAt: new Date(),
  };
}

// ---------------------------------------------------------------------------
// Cache: the last successful read, persisted so a restart while the API is
// down (or the token is between refreshes) starts from the previous values,
// rendered stale. Same shape discipline as the Claude cache (src/usage.ts):
// a file that would not render is simply no cache.
// ---------------------------------------------------------------------------

export const GROK_USAGE_CACHE_PATH = join(homedir(), '.cache', 'mbar', 'grok-usage.json');

export function loadCachedGrokUsage(path = GROK_USAGE_CACHE_PATH): GrokWeeklyUsage | null {
  let raw: any;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
  // Our own writes always carry an ISO fetchedAt string; anything else is not
  // ours (a bare `new Date()` would coerce numbers and arrays too).
  if (typeof raw?.fetchedAt !== 'string') return null;
  const fetchedAt = new Date(raw.fetchedAt);
  if (!Number.isFinite(fetchedAt.getTime())) return null;
  if (typeof raw?.usedPercent !== 'number' || !Number.isFinite(raw.usedPercent)) return null;
  if (typeof raw?.periodStart !== 'string' || typeof raw?.resetsAt !== 'string') return null;
  const usedPercent = Math.min(100, Math.max(0, raw.usedPercent));
  return {
    usedPercent,
    // Recomputed, not read: the pair must agree even in a hand-edited file.
    remainingPercent: 100 - usedPercent,
    periodStart: raw.periodStart,
    resetsAt: raw.resetsAt,
    periodType: typeof raw?.periodType === 'string' ? raw.periodType : 'USAGE_PERIOD_TYPE_WEEKLY',
    fetchedAt,
  };
}

/** Best-effort, atomic via temp-file rename — same rationale as
 * saveCachedUsage (src/usage.ts): a torn or unwritable cache must neither
 * break polling nor read back as corrupt. */
export async function saveCachedGrokUsage(usage: GrokWeeklyUsage, path = GROK_USAGE_CACHE_PATH): Promise<void> {
  const tmp = `${path}.tmp`;
  try {
    await Bun.write(tmp, JSON.stringify(usage));
    renameSync(tmp, path);
  } catch {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // deliberately silent — same rule as the write itself
    }
  }
}

if (import.meta.main) {
  const raw = process.argv.includes('--raw');
  try {
    const usage = await fetchGrokUsage();
    console.log(JSON.stringify(raw ? lastRawGrokBody : usage, null, 2));
  } catch (error) {
    // Shape drift is exactly when the raw body matters most: print it (it
    // carries no credentials) alongside the parse error, then fail.
    if (raw && lastRawGrokBody !== null) console.log(JSON.stringify(lastRawGrokBody, null, 2));
    throw error;
  }
}
