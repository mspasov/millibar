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
import { runHost } from './host';
import { claudeUsageModule } from './modules/claude-usage';
import { cpuModule } from './modules/cpu';

const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 5 * 60 * 1000);
const REFRESH_COOLDOWN_MS = Number(process.env.REFRESH_COOLDOWN_MS ?? 5000);

await runHost([
  claudeUsageModule({ pollIntervalMs: POLL_INTERVAL_MS, refreshCooldownMs: REFRESH_COOLDOWN_MS }),
  cpuModule(),
]);
