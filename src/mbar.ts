#!/usr/bin/env bun
/**
 * millibar — switchable monitor modules on the BUSY Bar front display.
 * Pressing the dial cycles modules (Claude Code usage, CPU load), START
 * refreshes the active one, and rotating the encoder cycles the views
 * inside a module (usage windows, load windows).
 *
 * The moving parts live elsewhere: src/host.ts runs the modules and owns the
 * device, src/module.ts defines what a module is, src/modules/* are the
 * modules themselves. Adding a monitor means writing one module file and
 * registering it here.
 *
 * Usage: mbar (after `bun link`), or bun run src/mbar.ts
 * Env:   BUSY_BAR_ADDR, BUSY_PRIORITY, POLL_INTERVAL_MS, REFRESH_COOLDOWN_MS,
 *        SWITCH_BUTTON (which button the dial press reports as; default OK)
 */
import { envNumber } from './config';
import { runHost } from './host';
import { claudeStatsModule } from './modules/claude-stats';
import { claudeUsageModule } from './modules/claude-usage';
import { cpuModule } from './modules/cpu';

// Validated, not just Number()-coerced: a NaN interval would make every
// setTimeout fire immediately and hot-loop the rate-limited usage API.
// 10 minutes, not the 5 the docs once suggested: the endpoint's budget is
// shared with whatever else the account is doing (Claude Code sessions poll
// it too), and 5-minute polling drew regular 429s in day-to-day use.
const POLL_INTERVAL_MS = envNumber('POLL_INTERVAL_MS', 10 * 60 * 1000, 1000);
const REFRESH_COOLDOWN_MS = envNumber('REFRESH_COOLDOWN_MS', 5000, 0);

await runHost([
  claudeUsageModule({ pollIntervalMs: POLL_INTERVAL_MS, refreshCooldownMs: REFRESH_COOLDOWN_MS }),
  claudeStatsModule(),
  cpuModule(),
]);
