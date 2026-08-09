#!/usr/bin/env bun
/**
 * millibar — switchable monitor modules on the BUSY Bar front display.
 * Pressing the dial cycles modules (Claude gauge/dashboard/history, CPU
 * load), START refreshes the active one, and rotating the encoder cycles
 * the screens inside a module (limit windows, load windows).
 *
 * The moving parts live elsewhere: src/host.ts runs the modules and owns the
 * device, src/module.ts defines what a module is, src/modules/* are the
 * modules themselves, src/device-cli.ts implements the connection
 * subcommands. Adding a monitor means writing one module file and
 * registering it here.
 *
 * Usage: mbar [--route <names>] [--[no-]animations] [--help | probe |
 *        routes | show | init | set | rm | order] (after `bun link`), or
 *        bun run src/mbar.ts — no arguments runs the monitor
 * Env:   BUSY_BAR_ADDR, BUSY_BAR_ROUTE, BUSY_BAR_TOKEN, BUSY_BAR_PASSWORD,
 *        MBAR_CONFIG, BUSY_PRIORITY, POLL_INTERVAL_MS, REFRESH_COOLDOWN_MS,
 *        SWITCH_BUTTON (which button the dial press reports as; default OK),
 *        ANIMATIONS (off disables the sweeps and the history intros)
 */
import { envFlag, envNumber } from './config';
import { isDeviceCommand, mbarUsage, runDeviceCommand } from './device-cli';
import { runHost } from './host';
import { claudeDashModule } from './modules/claude-dash';
import { claudeGaugeModule } from './modules/claude-gauge';
import { claudeHistoryModule } from './modules/claude-history';
import { cpuModule } from './modules/cpu';
import { dedupedFetchUsage } from './usage';

// Flags work on any invocation (monitor or subcommand) and anywhere in the
// argv, so they're stripped before command dispatch. Each becomes its env
// var — one mechanism, two spellings — with the flag winning over an
// inherited env var.
const argv = process.argv.slice(2);
for (let i = argv.length - 1; i >= 0; i--) {
  const arg = argv[i]!;
  if (arg === '--route') {
    const value = argv[i + 1];
    if (value === undefined) {
      console.error('--route needs a value: config route name(s), comma-separated — see mbar routes');
      process.exit(1);
    }
    process.env.BUSY_BAR_ROUTE = value;
    argv.splice(i, 2);
  } else if (arg.startsWith('--route=')) {
    process.env.BUSY_BAR_ROUTE = arg.slice('--route='.length);
    argv.splice(i, 1);
  } else if (arg === '--animations' || arg === '--no-animations') {
    // The bare positive spelling exists to override an ANIMATIONS=off
    // inherited from the environment, symmetric with the negative.
    process.env.ANIMATIONS = arg === '--animations' ? 'on' : 'off';
    argv.splice(i, 1);
  }
}

const [command, ...args] = argv;

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

// ANIMATIONS=off stills everything that moves: the value sweeps collapse to
// snaps (a zero-length sweep is PctSweep's documented off switch, exercised
// by every module test) and the history screens draw their static sections
// without the appearance intros.
const ANIMATIONS = envFlag('ANIMATIONS', true);
const sweepOptions = ANIMATIONS ? {} : { sweepMs: 0, sweepCoolMs: 0 };

// Both usage modules poll on the same cadence; the deduplicated fetcher makes
// that one request per cycle against the rate-limited endpoint. The 30s TTL
// covers the near-simultaneous twin polls (and puts a freshness floor under
// START-refreshes) without holding data back longer than anyone would notice
// at 1% granularity. The dashboard module is quiet — the gauge logs each
// fetch's story once.
const usageOptions = {
  pollIntervalMs: POLL_INTERVAL_MS,
  refreshCooldownMs: REFRESH_COOLDOWN_MS,
  fetchUsageImpl: dedupedFetchUsage(30_000),
  ...sweepOptions,
};

await runHost([
  claudeGaugeModule(usageOptions),
  claudeDashModule({ ...usageOptions, quiet: true }),
  claudeHistoryModule({ intros: ANIMATIONS }),
  cpuModule(sweepOptions),
]);
