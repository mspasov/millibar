/**
 * The Grok gauge: the SuperGrok weekly credit pool on the shared
 * single-window layout (src/modules/limit-gauge.ts) — label, countdown to
 * the weekly reset, used %, severity-coloured bar with the pace tick.
 *
 * One screen only ("GROK"): the scope is the shared weekly pool, nothing
 * else (docs/GROK-USAGE-API.md) — so the encoder has nothing to cycle and
 * the gauge's single-screen no-op covers it. Unlike Claude's windows, Grok
 * sends the period start, so the pace tick's window length comes from the
 * real timestamps rather than an assumed seven days.
 */
import {
  fetchGrokUsage,
  loadCachedGrokUsage,
  NoGrokCredentialsError,
  saveCachedGrokUsage,
  GROK_USAGE_CACHE_PATH,
  type GrokWeeklyUsage,
} from '../grok-usage';
import type { MonitorModule } from '../module';
import { limitGaugeModule } from './limit-gauge';
import type { LimitModuleOptions, Screen, UsageSource } from './limit-poller';

const SEVEN_DAYS_MS = 7 * 86_400_000;

/** The weekly pool as the gauge's one screen. The window length is measured
 * end − start (the API provides both); the seven-day constant is only the
 * fallback for a cache written before either stamp existed. */
export function buildGrokScreens(usage: GrokWeeklyUsage): Screen[] {
  const periodMs = new Date(usage.resetsAt).getTime() - new Date(usage.periodStart).getTime();
  return [
    {
      label: 'GROK',
      window: { utilization: usage.usedPercent, resetsAt: usage.resetsAt },
      periodMs: Number.isFinite(periodMs) && periodMs > 0 ? periodMs : SEVEN_DAYS_MS,
    },
  ];
}

export const grokUsageSource: UsageSource<GrokWeeklyUsage> = {
  fetch: fetchGrokUsage,
  screens: buildGrokScreens,
  loadCache: loadCachedGrokUsage,
  saveCache: saveCachedGrokUsage,
  defaultCachePath: GROK_USAGE_CACHE_PATH,
  // Only a missing login is fatal. GrokAuthError stays recoverable: tokens
  // live ~6 hours, so mid-run expiry is routine — the module dims to stale
  // and recovers once any grok CLI use refreshes auth.json.
  fatalError: (error) => error instanceof NoGrokCredentialsError,
};

export type GrokGaugeOptions = LimitModuleOptions<GrokWeeklyUsage>;

export function grokGaugeModule(options: GrokGaugeOptions): MonitorModule {
  return limitGaugeModule({ id: 'grok-gauge', title: 'Grok weekly', source: grokUsageSource }, options);
}
