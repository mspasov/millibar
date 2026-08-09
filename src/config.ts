/**
 * Shared configuration parsing for every script in the repo.
 *
 * `BUSY_BAR_ADDR` may be an IP, a hostname, or a full URL — the README
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

/** The configured device address, verbatim — for busy-lib, which normalises
 * schemes itself, and for log lines. */
export function deviceAddr(explicit?: string): string {
  return explicit ?? process.env.BUSY_BAR_ADDR ?? DEFAULT_ADDR;
}

/** `http://…` base URL for the device, without a trailing slash. */
export function httpBase(addr = deviceAddr()): string {
  const url = /^https?:\/\//.test(addr) ? addr : `http://${addr}`;
  return url.replace(/\/+$/, '');
}

/** `ws://…` (or `wss://…`) base for the same address. */
export function wsBase(addr = deviceAddr()): string {
  return httpBase(addr).replace(/^http/, 'ws');
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
