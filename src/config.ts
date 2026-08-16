/**
 * Shared configuration parsing for every script in the repo.
 *
 * `MBAR_ADDR` may be an IP, a hostname, or a full URL — the README
 * promises all three work everywhere, and busy-lib normalises its own copy —
 * so the raw-fetch clients (display, storage, input, screenshot) must resolve
 * it through one helper instead of blindly prefixing a scheme.
 *
 * Numeric env vars must fail loudly rather than becoming NaN: a NaN delay
 * makes setTimeout fire after ~1ms, which turns the monitor's poll loop into
 * a hot loop against the rate-limited usage API — and the 429 back-off can't
 * stop it, because Math.max(retryAfter, NaN) is NaN too.
 */

export const DEFAULT_ADDR = '10.0.4.20';

/** The application_name draws, uploads, and LED pulses run under by default.
 * The device keys the persisted element set and `/ext/user_assets/<app>` to
 * this name, so a rename only takes effect when the resident monitor
 * restarts — and strands any assets uploaded under the old name (this was
 * 'claude_usage' before the project was named). */
export const DEFAULT_APP_NAME = 'mbar';

/** The configured device address, verbatim — for busy-lib, which normalises
 * schemes itself, and for log lines. */
export function deviceAddr(explicit?: string): string {
  return explicit ?? process.env.MBAR_ADDR ?? DEFAULT_ADDR;
}

/** The cloud proxy hosts, per busy-lib's PROXY_HOST_RE. The proxy is not
 * "the device at another address": it defaults to https, and it serves the
 * device API under `/busybar/…` — `/api/…` there is a 404 no matter the
 * token (see DEVICE.md, Authentication). */
const PROXY_HOST_RE = /^api(?:\.(?:dev|test|stage))?\.busy\.app$/i;

export function isProxyAddr(addr: string): boolean {
  const host = addr.replace(/^https?:\/\//i, '').replace(/[/:?#].*$/, '');
  return PROXY_HOST_RE.test(host);
}

/** Device API path for an address: `/api/…` locally, `/busybar/…` through
 * the proxy. Callers keep writing `/api/…` everywhere. */
export function apiPath(addr: string, path: string): string {
  return isProxyAddr(addr) ? path.replace(/^\/api(?=\/|$)/, '/busybar') : path;
}

/** `http://…` base URL for the device, without a trailing slash. The proxy
 * gets https by default (it redirects plain http). */
export function httpBase(addr = deviceAddr()): string {
  const scheme = isProxyAddr(addr) ? 'https' : 'http';
  const url = /^https?:\/\//.test(addr) ? addr : `${scheme}://${addr}`;
  return url.replace(/\/+$/, '');
}

/** `ws://…` (or `wss://…`) base for the same address. */
export function wsBase(addr = deviceAddr()): string {
  return httpBase(addr).replace(/^http/, 'ws');
}

/** Boolean env var, or `fallback` when unset/empty. Accepts 1/0, true/false,
 * on/off (any case); anything else throws — `MBAR_ANIMATIONS=flase` silently
 * meaning "on" would be a setting that looks applied and isn't. */
export function envFlag(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = raw.toLowerCase();
  if (value === '1' || value === 'true' || value === 'on') return true;
  if (value === '0' || value === 'false' || value === 'off') return false;
  throw new Error(`${name} must be one of 1/0, true/false, on/off, got '${raw}'`);
}

/** Numeric env var, or `fallback` when unset/empty. Throws on anything
 * non-numeric or below `min` instead of letting NaN or a hot-loop-inducing
 * zero through. */
export function envNumber(name: string, fallback: number, min = 0): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min) {
    throw new Error(`${name} must be a number >= ${min}, got '${raw}'`);
  }
  return value;
}
