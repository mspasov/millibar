/**
 * Which BUSY Bar to talk to, over which route, with which credentials.
 *
 * Routes are declared in a persistent config file and tried in priority
 * order — typically USB-Ethernet, then the LAN hostname, then the cloud
 * proxy — and the first one whose `/api/version` answers like a BUSY device
 * wins. Probes run in parallel so a dead first route costs one timeout, not
 * one per route. The winner is memoized per process; a network-level failure
 * invalidates it, so the next request re-probes and can fail over (USB
 * unplugged mid-run → LAN → cloud) without a restart.
 *
 * Config lives at `~/.config/mbar/config.json` (`MBAR_CONFIG` or
 * `XDG_CONFIG_HOME` move it). `MBAR_ROUTE` (or `mbar --route`) narrows
 * selection to the named config routes, in the given order — still probed,
 * so a forced-but-dead route fails loudly instead of hanging draws.
 * `MBAR_ADDR` still overrides everything — including `MBAR_ROUTE` —
 * and is trusted verbatim *without* probing; that keeps echo-server
 * debugging and the wire-level tests, which point it at fakes that don't
 * serve `/api/version`, working unchanged.
 *
 * Credentials (both optional, see DEVICE.md):
 * - `password` — the device's HTTP Access Password. Sent as an `X-API-Token`
 *   header; WebSockets can't carry headers, so there it becomes an
 *   `x-api-token` query parameter (busy-lib's LocalStateStream does the same).
 * - `token` — a cloud API token from https://cloud.busy.app/api-tokens, sent
 *   as `Authorization: Bearer …` to the `https://api.busy.app` proxy. It must
 *   carry the "BUSY Bar" scope — an Account-scope token gets 403s that look
 *   identical to an invalid token (DEVICE.md, Authentication).
 * The file can hold credentials, hence it is written 0600.
 *
 * The proxy serves the device API under `/busybar/…`, not `/api/…`, so every
 * request path is translated per-route via `apiPath` at the last moment —
 * callers write `/api/…` regardless of which route wins.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { BusyBar } from '@busy-app/busy-lib';
import { apiPath, DEFAULT_ADDR, httpBase } from './config';

export interface Route {
  /** Short label, e.g. 'usb', 'lan', 'cloud'. Unique within the config. */
  name: string;
  /** IP, hostname, or full URL — same forms MBAR_ADDR accepts. */
  addr: string;
  /** Cloud API token → `Authorization: Bearer …`. */
  token?: string;
  /** Device HTTP Access Password → `X-API-Token` header. */
  password?: string;
  /** Per-route probe budget; the cloud proxy may warrant more. */
  probe_timeout_ms?: number;
}

export interface DeviceConfig {
  routes: Route[];
}

export interface Connection {
  route: Route;
  /** `http(s)://…` base, no trailing slash. */
  base: string;
  /** `ws(s)://…` base for the same address. */
  ws: string;
  /** From the probe reply; '' for the unprobed MBAR_ADDR route. */
  apiSemver: string;
  /** Auth headers every HTTP request to this route must carry. */
  headers: Record<string, string>;
}

export const DEFAULT_PROBE_TIMEOUT_MS = 3000;

/** Without a config file these still cover both local paths: the fixed
 * USB-Ethernet address and the mDNS hostname on the LAN. */
export const DEFAULT_ROUTES: Route[] = [
  { name: 'usb', addr: DEFAULT_ADDR },
  { name: 'lan', addr: 'busy.bar' },
];

export function configPath(): string {
  if (process.env.MBAR_CONFIG) return process.env.MBAR_CONFIG;
  const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(configHome, 'mbar', 'config.json');
}

/** Parse and validate a config object (from file or about to be saved).
 * Throws with the offending route named — a half-typed config failing at
 * probe time with "no BUSY Bar reachable" would point the wrong way. */
export function validateConfig(raw: unknown): DeviceConfig {
  const cfg = raw as DeviceConfig;
  if (!cfg || !Array.isArray(cfg.routes) || cfg.routes.length === 0) {
    throw new Error("config must have a non-empty 'routes' array");
  }
  const seen = new Set<string>();
  for (const route of cfg.routes) {
    if (typeof route?.name !== 'string' || route.name === '') {
      throw new Error("every route needs a 'name'");
    }
    if (typeof route.addr !== 'string' || route.addr === '') {
      throw new Error(`route '${route.name}' needs an 'addr'`);
    }
    // A hand-edited (or pre-validation `mbar set --timeout abc`, which wrote
    // null) timeout must fail here with the route named, not at probe time as
    // an instant abort or an AbortSignal.timeout throw.
    if (route.probe_timeout_ms !== undefined) {
      const ms = route.probe_timeout_ms;
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 1) {
        throw new Error(`route '${route.name}': probe_timeout_ms must be a number of milliseconds >= 1`);
      }
    }
    if (seen.has(route.name)) throw new Error(`duplicate route name '${route.name}'`);
    seen.add(route.name);
  }
  return { routes: cfg.routes };
}

export function loadDeviceConfig(): DeviceConfig {
  const path = configPath();
  if (!existsSync(path)) return { routes: DEFAULT_ROUTES.map((r) => ({ ...r })) };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${(error as Error).message}`);
  }
  try {
    return validateConfig(parsed);
  } catch (error) {
    throw new Error(`${path}: ${(error as Error).message}`);
  }
}

export function saveDeviceConfig(cfg: DeviceConfig): string {
  const path = configPath();
  validateConfig(cfg);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(cfg, null, 2)}\n`);
  // The file may hold the cloud token or the device password.
  chmodSync(path, 0o600);
  return path;
}

/** `MBAR_ROUTE='cloud'` or `'cloud,lan'` — the named config routes, in
 * the given order. A name the config doesn't have is a loud error: a typo'd
 * force silently falling back to usb would defeat the point of forcing. */
function forcedRoutes(routes: Route[]): Route[] {
  const forced = process.env.MBAR_ROUTE;
  const names = (forced ?? '').split(',').map((n) => n.trim()).filter(Boolean);
  if (names.length === 0) return routes;
  const byName = new Map(routes.map((route) => [route.name, route]));
  return names.map((name) => {
    const route = byName.get(name);
    if (!route) {
      throw new Error(
        `MBAR_ROUTE/--route: no route named '${name}' — config has ${routes.map((r) => r.name).join(', ')}`
      );
    }
    return route;
  });
}

/** The routes a resolve will try, in order — config file plus env overlay.
 * `MBAR_ROUTE` narrows the list to the named routes (still probed);
 * `MBAR_ADDR` replaces the whole list with one unprobed route and wins
 * over it; `MBAR_TOKEN` / `MBAR_PASSWORD` fill credential gaps
 * either way. */
export function candidateRoutes(): Route[] {
  const token = process.env.MBAR_TOKEN || undefined;
  const password = process.env.MBAR_PASSWORD || undefined;
  const addr = process.env.MBAR_ADDR;
  const routes = addr
    ? [{ name: 'env', addr }]
    : forcedRoutes(loadDeviceConfig().routes);
  return routes.map((route) => ({
    ...route,
    token: route.token ?? token,
    password: route.password ?? password,
  }));
}

function authHeaders(route: Route): Record<string, string> {
  const headers: Record<string, string> = {};
  if (route.token) headers.Authorization = `Bearer ${route.token}`;
  if (route.password) headers['X-API-Token'] = route.password;
  return headers;
}

function asConnection(route: Route, apiSemver: string): Connection {
  const base = httpBase(route.addr);
  return { route, base, ws: base.replace(/^http/, 'ws'), apiSemver, headers: authHeaders(route) };
}

/** One route, one `GET /api/version`. A reply without `api_semver` fails the
 * probe even on HTTP 200 — a captive portal or a stale DNS entry for
 * `busy.bar` answers 200 without being a BUSY device. */
export async function probeRoute(route: Route): Promise<Connection> {
  const base = httpBase(route.addr);
  let response: Response;
  try {
    response = await fetch(`${base}${apiPath(route.addr, '/api/version')}`, {
      headers: authHeaders(route),
      signal: AbortSignal.timeout(route.probe_timeout_ms ?? DEFAULT_PROBE_TIMEOUT_MS),
    });
  } catch (error) {
    const reason = (error as Error).name === 'TimeoutError' ? 'timed out' : (error as Error).message;
    throw new Error(`unreachable (${reason})`);
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error(`HTTP ${response.status} — ${route.token || route.password ? 'credentials rejected' : 'credentials required'}`);
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = (await response.json().catch(() => undefined)) as { api_semver?: string } | undefined;
  if (typeof body?.api_semver !== 'string') {
    throw new Error('no api_semver in reply — not a BUSY device?');
  }
  return asConnection(route, body.api_semver);
}

let memo: { key: string; promise: Promise<Connection> } | undefined;

/** The memo must not outlive an env change: the test suite (and any caller
 * flipping MBAR_ADDR between operations) expects the next resolve to see
 * the new world, and MBAR_CONFIG moves the file itself. */
function memoKey(): string {
  const { MBAR_ADDR, MBAR_ROUTE, MBAR_TOKEN, MBAR_PASSWORD, MBAR_CONFIG, XDG_CONFIG_HOME } =
    process.env;
  return [MBAR_ADDR, MBAR_ROUTE, MBAR_TOKEN, MBAR_PASSWORD, MBAR_CONFIG, XDG_CONFIG_HOME].join('|');
}

/** Drop the resolved connection so the next call re-probes. Called
 * automatically when a request fails at the network level. */
export function invalidateConnection(): void {
  memo = undefined;
}

/**
 * The connection every device request goes through. Memoized; a rejection is
 * not cached, so a poll loop that failed while the device was off re-probes
 * on its next cycle.
 */
export function resolveConnection(): Promise<Connection> {
  const key = memoKey();
  if (memo?.key !== key) {
    const promise = resolveFresh();
    memo = { key, promise };
    promise.catch(() => {
      if (memo?.promise === promise) memo = undefined;
    });
  }
  return memo.promise;
}

async function resolveFresh(): Promise<Connection> {
  const routes = candidateRoutes();

  // The env route is trusted verbatim — no probe. Echo servers and test
  // fakes don't serve /api/version, and the point of MBAR_ADDR is "talk
  // to exactly this, now".
  if (routes[0]!.name === 'env') return asConnection(routes[0]!, '');

  // All probes start at once; selection then awaits them in priority order,
  // so a dead usb route delays a live lan answer by nothing but its own
  // timeout — and a slow-but-alive usb still beats a fast lan.
  const attempts = routes.map((route) => {
    const attempt = probeRoute(route);
    attempt.catch(() => {}); // handled via the ordered await below
    return attempt;
  });
  const failures: string[] = [];
  for (let i = 0; i < routes.length; i++) {
    try {
      return await attempts[i]!;
    } catch (error) {
      failures.push(`${routes[i]!.name} ${routes[i]!.addr}: ${(error as Error).message}`);
    }
  }
  throw new Error(
    `no BUSY Bar reachable — ${failures.join('; ')}. ` +
      `Routes come from ${process.env.MBAR_ADDR ? 'MBAR_ADDR' : configPath()}` +
      `${!process.env.MBAR_ADDR && process.env.MBAR_ROUTE ? ` (forced to '${process.env.MBAR_ROUTE}' by MBAR_ROUTE/--route)` : ''}; ` +
      `'mbar probe' shows each route's status.`
  );
}

/** 'usb http://10.0.4.20 (api 25.0.0)' — for startup log lines. */
export function describeConnection(conn: Connection): string {
  return `${conn.route.name} ${conn.base}${conn.apiSemver ? ` (api ${conn.apiSemver})` : ''}`;
}

/**
 * `fetch` against the resolved route: base URL prefixed, auth headers merged
 * in (per-call headers win). A network-level failure — not an HTTP error
 * status — invalidates the connection so the next call re-probes; a caller's
 * own abort doesn't, because cancelling a request says nothing about the
 * route. `AbortSignal.timeout` aborts carry `TimeoutError`, deliberate aborts
 * `AbortError`, which is how the two are told apart.
 */
/** Per-call headers layered over the route's auth headers. `HeadersInit` has
 * three shapes — plain object, `Headers` instance, tuple array — and object-
 * spreading the latter two silently mangles them (a `Headers` has no own
 * enumerable properties, an array spreads to numeric keys), so a caller using
 * either shape would lose its headers without an error. Normalise through
 * `Headers` instead; `set` keeps per-call values winning over auth. */
function mergeHeaders(base: Record<string, string>, extra?: RequestInit['headers']): Headers {
  const headers = new Headers(base);
  if (extra) new Headers(extra).forEach((value, key) => headers.set(key, value));
  return headers;
}

export async function deviceFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const conn = await resolveConnection();
  try {
    return await fetch(`${conn.base}${apiPath(conn.route.addr, path)}`, {
      ...init,
      headers: mergeHeaders(conn.headers, init.headers),
    });
  } catch (error) {
    const aborted = init.signal?.aborted === true;
    const deliberate = aborted && (init.signal?.reason as Error | undefined)?.name === 'AbortError';
    if (!deliberate) invalidateConnection();
    throw error;
  }
}

/** WebSocket URL for the resolved route, credentials included as the
 * `x-api-token` query parameter (headers aren't available to `WebSocket`). */
export async function wsUrl(path: string): Promise<string> {
  const conn = await resolveConnection();
  const url = new URL(`${conn.ws}${apiPath(conn.route.addr, path)}`);
  const secret = conn.route.password ?? conn.route.token;
  if (secret) url.searchParams.set('x-api-token', secret);
  return url.toString();
}

/** A busy-lib client on the resolved route, credentials wired through.
 * Dynamic import so store/display-only processes never load the library. */
export async function connectedBar(): Promise<BusyBar> {
  const conn = await resolveConnection();
  const { BusyBar } = await import('@busy-app/busy-lib');
  return new BusyBar({
    addr: conn.route.addr,
    token: conn.route.token,
    HTTPAccessPassword: conn.route.password,
  });
}
