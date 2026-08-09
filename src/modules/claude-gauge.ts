/**
 * The Claude gauge: one Claude Code usage limit at a time, given the whole
 * panel. The layout and behaviour live in the provider-agnostic
 * src/modules/limit-gauge.ts; this wrapper binds it to the Claude usage
 * source — screens for the 5-hour and 7-day windows plus any per-model
 * weekly windows (Fable, ...), cached in ~/.cache/mbar/usage.json.
 */
import type { MonitorModule } from '../module';
import { limitGaugeModule } from './limit-gauge';
import { claudeUsageSource, type LimitModuleOptions } from './limit-poller';

export { buildScreens } from './limit-poller';
export type ClaudeGaugeOptions = LimitModuleOptions;

export function claudeGaugeModule(options: ClaudeGaugeOptions): MonitorModule {
  return limitGaugeModule({ id: 'claude-gauge', title: 'Claude gauge', source: claudeUsageSource }, options);
}
