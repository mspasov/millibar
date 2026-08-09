#!/usr/bin/env bun
/**
 * millibar — switchable monitor modules on the BUSY Bar front display.
 * Pressing the dial cycles modules (Claude Code usage, CPU load), START
 * refreshes the active one, and rotating the encoder cycles the views
 * inside a module (usage windows, load windows).
 *
 * The moving parts live elsewhere: src/host.ts runs the modules and owns the
 * device, src/module.ts defines what a module is, src/modules/* are the
 * modules themselves, src/device-cli.ts implements the connection
 * subcommands. Adding a monitor means writing one module file and
 * registering it here.
 *
 * Usage: mbar [--help | probe | show | init | set | rm | order] (after
 *        `bun link`), or bun run src/mbar.ts — no arguments runs the monitor
 * Env:   BUSY_BAR_ADDR, BUSY_BAR_TOKEN, BUSY_BAR_PASSWORD, MBAR_CONFIG,
 *        BUSY_PRIORITY, POLL_INTERVAL_MS, REFRESH_COOLDOWN_MS,
 *        SWITCH_BUTTON (which button the dial press reports as; default OK)
 */
import { envNumber } from './config';
import { isDeviceCommand, mbarUsage, runDeviceCommand } from './device-cli';
import { runHost } from './host';
import { claudeStatsModule } from './modules/claude-stats';
import { claudeUsageModule } from './modules/claude-usage';
import { claudeUsageCombinedModule } from './modules/claude-usage-combined';
import { cpuModule } from './modules/cpu';
import { dedupedFetchUsage } from './usage';

const [command, ...args] = process.argv.slice(2);

if (command === '--help' || command === '-h' || command === 'help') {
  console.log(mbarUsage());
  process.exit(0);
}
if (command !== undefined) {
  if (!isDeviceCommand(command)) {
    console.error(`unknown command '${command}'\n\n${mbarUsage()}`);
    process.exit(1);
  }
  process.exit(await runDeviceCommand(command, args));
}

// Validated, not just Number()-coerced: a NaN interval would make every
// setTimeout fire immediately and hot-loop the rate-limited usage API.
// 10 minutes, not the 5 the docs once suggested: the endpoint's budget is
// shared with whatever else the account is doing (Claude Code sessions poll
// it too), and 5-minute polling drew regular 429s in day-to-day use.
// Read here, after command dispatch, so a bad value can't break `mbar probe`.
const POLL_INTERVAL_MS = envNumber('POLL_INTERVAL_MS', 10 * 60 * 1000, 1000);
const REFRESH_COOLDOWN_MS = envNumber('REFRESH_COOLDOWN_MS', 5000, 0);

// Both usage modules poll on the same cadence; the deduplicated fetcher makes
// that one request per cycle against the rate-limited endpoint. The 30s TTL
// covers the near-simultaneous twin polls (and puts a freshness floor under
// START-refreshes) without holding data back longer than anyone would notice
// at 1% granularity. The combined module is quiet — the primary usage module
// logs each fetch's story once.
const usageOptions = {
  pollIntervalMs: POLL_INTERVAL_MS,
  refreshCooldownMs: REFRESH_COOLDOWN_MS,
  fetchUsageImpl: dedupedFetchUsage(30_000),
};

await runHost([
  claudeUsageModule(usageOptions),
  claudeUsageCombinedModule({ ...usageOptions, quiet: true }),
  claudeStatsModule(),
  cpuModule(),
]);
