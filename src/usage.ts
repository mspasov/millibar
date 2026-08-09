/**
 * Reads Claude Code's OAuth usage limits (the data behind the `/usage` panel).
 *
 * Ported from ai-token-monitor's src-tauri/src/oauth_usage.rs, including its
 * hard-won details: the Keychain can hold several items under the same service
 * (some with only `mcpOAuth` and no token), newer Claude Code versions use a
 * hashed `Claude Code-credentials-{hash}` service name, and `resets_at` is null
 * on windows with no scheduled reset.
 *
 * The access token stays in memory: never logged, never written to disk, never
 * passed as an argv where `ps` could read it.
 */
import { readFileSync, renameSync, rmSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';

const KEYCHAIN_SERVICE = 'Claude Code-credentials';
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const OAUTH_BETA = 'oauth-2025-04-20';
/** Refresh a little before expiry so a poll never races the deadline. */
const REFRESH_SKEW_MS = 4 * 60 * 1000;

export interface UsageWindow {
  utilization: number;
  resetsAt: string | null;
}

export interface ModelWindow extends UsageWindow {
  model: string;
}

export interface Usage {
  fiveHour: UsageWindow | null;
  sevenDay: UsageWindow | null;
  /** Active model-scoped weekly windows (Fable, Sonnet, ...) from `limits`. */
  models: ModelWindow[];
  fetchedAt: Date;
}

export class RateLimitError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super(`rate limited, retry after ${retryAfterSeconds}s`);
    this.name = 'RateLimitError';
  }
}

export class NoCredentialsError extends Error {
  constructor() {
    super('no Claude Code OAuth credentials found — run `claude auth` to sign in');
    this.name = 'NoCredentialsError';
  }
}

interface Credentials {
  accessToken: string;
  expiresAtMillis: number | null;
}

function parseCredentials(raw: string): Credentials | null {
  // Keychain payloads may carry a leading non-JSON byte.
  const trimmed = raw.replace(/^[^{]*/, '');
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const oauth = (parsed as Record<string, any>)?.claudeAiOauth;
  const accessToken = oauth?.accessToken ?? oauth?.access_token;
  if (typeof accessToken !== 'string' || accessToken.length === 0) return null;

  const rawExpiry = oauth?.expiresAt ?? oauth?.expires_at;
  const expiry = typeof rawExpiry === 'string' ? Number(rawExpiry) : rawExpiry;
  const expiresAtMillis =
    typeof expiry === 'number' && Number.isFinite(expiry)
      ? expiry > 10_000_000_000
        ? expiry
        : expiry * 1000
      : null;

  return { accessToken, expiresAtMillis };
}

function keychainLookup(service: string, account: string | null): Credentials | null {
  const args = ['find-generic-password', '-s', service];
  if (account) args.push('-a', account);
  args.push('-w');

  const result = Bun.spawnSync({
    cmd: ['/usr/bin/security', ...args],
    stdout: 'pipe',
    stderr: 'ignore',
  });
  if (result.exitCode !== 0) return null;
  return parseCredentials(result.stdout.toString('utf8'));
}

/** Claude Code v2.1.52+ names the item `Claude Code-credentials-{hash}`. */
function discoverServiceNames(): string[] {
  const result = Bun.spawnSync({
    cmd: ['/usr/bin/security', 'dump-keychain'],
    stdout: 'pipe',
    stderr: 'ignore',
  });
  if (result.exitCode !== 0) return [];
  const names = new Set<string>();
  for (const match of result.stdout.toString('utf8').matchAll(/"(Claude Code-credentials[^"]*)"/g)) {
    names.add(match[1]!);
  }
  return [...names];
}

function readCredentialsFile(): Credentials | null {
  const dir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
  try {
    return parseCredentials(readFileSync(join(dir, '.credentials.json'), 'utf8'));
  } catch {
    return null;
  }
}

function readCredentials(): Credentials | null {
  if (process.platform === 'darwin') {
    const accounts = [null, 'unknown', userInfo().username];
    for (const service of [KEYCHAIN_SERVICE, ...discoverServiceNames()]) {
      for (const account of accounts) {
        const credentials = keychainLookup(service, account);
        if (credentials) return credentials;
      }
    }
  }
  return readCredentialsFile();
}

/**
 * Let the Claude Code CLI own the OAuth refresh exchange, then re-read what it
 * stored — avoids duplicating private OAuth client details here.
 */
function refreshViaClaudeCli(): boolean {
  const result = Bun.spawnSync({
    cmd: ['claude', 'auth', 'status', '--json'],
    env: { ...process.env, BROWSER: 'true' },
    stdout: 'ignore',
    stderr: 'ignore',
    timeout: 12_000,
  });
  return result.exitCode === 0;
}

interface ApiWindow {
  utilization: number;
  resets_at?: string | null;
}

interface ApiLimit {
  kind?: string;
  percent?: number;
  resets_at?: string | null;
  is_active?: boolean;
  scope?: { model?: { display_name?: string | null } | null } | null;
}

/** A window only counts if it would render: utilization must be a finite
 * number. One sanitizer for both the live fetch and the cache read, so the
 * two paths cannot drift — API shape drift and a hand-edited cache file both
 * drop the window instead of putting `NaN%` on the display. */
function windowFrom(utilization: unknown, resetsAt: unknown): UsageWindow | null {
  if (typeof utilization !== 'number' || !Number.isFinite(utilization)) return null;
  return { utilization, resetsAt: typeof resetsAt === 'string' ? resetsAt : null };
}

function toWindow(w: ApiWindow | null | undefined): UsageWindow | null {
  return w ? windowFrom(w.utilization, w.resets_at) : null;
}

/**
 * Per-model weekly limits arrive as `weekly_scoped` entries in `limits`; the
 * legacy `seven_day_<model>` keys are null now. Do NOT filter on `is_active`:
 * it marks whichever single limit currently binds (highest utilization), not
 * which windows exist — a model window that isn't the binding one still counts.
 * Unscoped session/weekly-all entries are already covered by fiveHour/sevenDay,
 * so they're skipped (they have no model scope).
 */
function collectModelWindows(limits: ApiLimit[]): ModelWindow[] {
  const windows = limits
    .map((l) => ({
      model: l.scope?.model?.display_name?.trim(),
      window: windowFrom(l.percent ?? 0, l.resets_at),
    }))
    .filter((e): e is { model: string; window: UsageWindow } => Boolean(e.model && e.window))
    .map(({ model, window }) => ({ model, ...window }))
    .sort((a, b) => a.model.localeCompare(b.model));

  return windows.filter((w, i) => i === 0 || w.model !== windows[i - 1]!.model);
}

async function requestUsage(token: string): Promise<Response> {
  return fetch(USAGE_URL, {
    headers: {
      Authorization: `Bearer ${token}`,
      'anthropic-beta': OAUTH_BETA,
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(15_000),
  });
}

/** Fetch current usage, refreshing the OAuth token if it is expired or rejected. */
export async function fetchUsage(): Promise<Usage> {
  let credentials = readCredentials();
  if (!credentials) throw new NoCredentialsError();

  const expired =
    credentials.expiresAtMillis !== null && credentials.expiresAtMillis <= Date.now() + REFRESH_SKEW_MS;
  if (expired && refreshViaClaudeCli()) {
    credentials = readCredentials() ?? credentials;
  }

  let response = await requestUsage(credentials.accessToken);

  if (response.status === 401) {
    const refreshed = refreshViaClaudeCli() ? readCredentials() : null;
    if (!refreshed || refreshed.accessToken === credentials.accessToken) {
      throw new Error('OAuth token rejected — run `claude auth` to sign in again');
    }
    response = await requestUsage(refreshed.accessToken);
  }

  if (response.status === 429) {
    throw new RateLimitError(Number(response.headers.get('retry-after')) || 60);
  }
  if (!response.ok) {
    throw new Error(`usage request failed: HTTP ${response.status}`);
  }

  const body = (await response.json()) as {
    five_hour?: ApiWindow | null;
    seven_day?: ApiWindow | null;
    limits?: ApiLimit[];
  };

  lastRawBody = body;

  return {
    fiveHour: toWindow(body.five_hour),
    sevenDay: toWindow(body.seven_day),
    models: collectModelWindows(body.limits ?? []),
    fetchedAt: new Date(),
  };
}

/** Raw body of the last fetch, for debugging shape drift in the undocumented API. */
export let lastRawBody: unknown = null;

// ---------------------------------------------------------------------------
// Cache: the last successful read, persisted so a restart while the API is
// down or rate-limited starts from the previous values (rendered stale)
// instead of a blank screen.
// ---------------------------------------------------------------------------

export const USAGE_CACHE_PATH = join(homedir(), '.cache', 'mbar', 'usage.json');

function cachedWindow(raw: unknown): UsageWindow | null {
  if (!raw || typeof raw !== 'object') return null;
  const { utilization, resetsAt } = raw as Record<string, unknown>;
  return windowFrom(utilization, resetsAt);
}

/** Null when absent, corrupt, or empty — a cache with nothing renderable is
 * simply no cache (seeding from it would announce cached usage over a blank
 * screen). */
export function loadCachedUsage(path = USAGE_CACHE_PATH): Usage | null {
  let raw: any;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
  // Our own writes always carry an ISO fetchedAt string; anything else is not
  // ours. Checked as a string — new Date() alone would happily coerce
  // numbers, booleans, and arrays.
  if (typeof raw?.fetchedAt !== 'string') return null;
  const fetchedAt = new Date(raw.fetchedAt);
  if (!Number.isFinite(fetchedAt.getTime())) return null;
  const models: ModelWindow[] = Array.isArray(raw?.models)
    ? raw.models.flatMap((m: unknown) => {
        const window = cachedWindow(m);
        const model = (m as Record<string, unknown> | null)?.model;
        return window && typeof model === 'string' ? [{ ...window, model }] : [];
      })
    : [];
  const fiveHour = cachedWindow(raw?.fiveHour);
  const sevenDay = cachedWindow(raw?.sevenDay);
  if (!fiveHour && !sevenDay && models.length === 0) return null;
  return { fiveHour, sevenDay, models, fetchedAt };
}

/** Best-effort: a read-only or full disk must not break polling. Bun.write
 * creates the ~/.cache/mbar/ directory itself. Written to a temp file and
 * renamed so a crash mid-write cannot tear the previous good cache — a torn
 * file reads as "no cache", a blank screen in exactly the outage the cache
 * exists for. */
export async function saveCachedUsage(usage: Usage, path = USAGE_CACHE_PATH): Promise<void> {
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
  const usage = await fetchUsage();
  if (process.argv.includes('--raw')) {
    console.log(JSON.stringify(lastRawBody, null, 2));
  } else {
    console.log(JSON.stringify(usage, null, 2));
  }
}
