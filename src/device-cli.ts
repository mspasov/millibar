/**
 * The `mbar` connection subcommands — the management face of
 * src/connection.ts, kept out of mbar.ts so the entry point stays a thin
 * argv switch and the handlers stay testable (they return exit codes rather
 * than calling process.exit).
 *
 * The config is an ordered list of routes — typically the fixed USB-Ethernet
 * IP, the LAN hostname, and the cloud proxy — and every script in this repo
 * uses the first route whose `/api/version` answers. `probe` shows that
 * decision instead of making you infer it from a hung draw call.
 */
import { existsSync } from 'node:fs';
import {
  candidateRoutes,
  configPath,
  loadDeviceConfig,
  probeRoute,
  saveDeviceConfig,
  type Route,
} from './connection';

export const DEVICE_COMMANDS = ['probe', 'show', 'init', 'set', 'rm', 'order'] as const;
export type DeviceCommand = (typeof DEVICE_COMMANDS)[number];

export function isDeviceCommand(command: string): command is DeviceCommand {
  return (DEVICE_COMMANDS as readonly string[]).includes(command);
}

export function mbarUsage(): string {
  return `mbar — usage pressure on a very small bar

Monitor (the default — no arguments):

  mbar                   switchable monitor modules on the BUSY Bar display.
                         Press the dial to switch modules, START to refresh,
                         rotate the encoder to cycle views. Ctrl-C stops and
                         clears the display.

Connection routes (config: ${configPath()}):

  mbar probe             try every route, report status and latency
  mbar show              print the config (credentials masked)
  mbar init              write the config file with the defaults
  mbar set <name> <addr> [--token T] [--password P] [--timeout MS] [--first]
  mbar rm <name>
  mbar order <name> [name...]

Routes are tried in order; the first whose /api/version answers like a BUSY
device wins. 'set' adds or updates a route (--first puts it at the top).
Credentials: --token is a cloud API token (https://cloud.busy.app/api-tokens,
for the https://api.busy.app route); --password is the device's HTTP Access
Password if one is configured.

Environment:

  BUSY_BAR_ADDR          bypass the route config — exact address, unprobed
  BUSY_BAR_TOKEN         cloud token for routes that don't carry their own
  BUSY_BAR_PASSWORD      HTTP Access Password, likewise
  MBAR_CONFIG            route config path
  POLL_INTERVAL_MS, REFRESH_COOLDOWN_MS, BUSY_PRIORITY, SWITCH_BUTTON
                         monitor tuning — see README`;
}

function fileNote(): string {
  return existsSync(configPath()) ? configPath() : `${configPath()} (not written yet — using defaults)`;
}

function describeRoute(route: Route): string {
  const creds = [route.token && 'token', route.password && 'password'].filter(Boolean).join('+');
  return `${route.name.padEnd(8)} ${route.addr.padEnd(28)}${creds ? ` [${creds}]` : ''}`;
}

async function probeAll(): Promise<number> {
  const routes = candidateRoutes();
  console.log(`config: ${process.env.BUSY_BAR_ADDR ? 'BUSY_BAR_ADDR override' : fileNote()}`);
  let winner: string | undefined;
  for (const route of routes) {
    const startedAt = Date.now();
    try {
      const conn = await probeRoute(route);
      const chosen = winner === undefined;
      winner ??= route.name;
      console.log(
        `  ${describeRoute(route)} ok — api ${conn.apiSemver}, ${Date.now() - startedAt}ms${chosen ? '   <- selected' : ''}`
      );
    } catch (error) {
      console.log(`  ${describeRoute(route)} ${(error as Error).message}`);
    }
  }
  if (winner === undefined) {
    console.error('no route reachable');
    return 1;
  }
  return 0;
}

function show(): void {
  console.log(`config: ${fileNote()}`);
  for (const route of loadDeviceConfig().routes) {
    console.log(`  ${describeRoute(route)}${route.probe_timeout_ms ? ` timeout ${route.probe_timeout_ms}ms` : ''}`);
  }
}

function set(args: string[]): void {
  const [name, addr] = args;
  if (!name || !addr) {
    throw new Error('usage: mbar set <name> <addr> [--token T] [--password P] [--timeout MS] [--first]');
  }
  const route: Route = { name, addr };
  let first = false;
  for (let i = 2; i < args.length; i++) {
    const flag = args[i]!;
    if (flag === '--first') {
      first = true;
    } else if (flag === '--token' || flag === '--password' || flag === '--timeout') {
      const value = args[++i];
      if (value === undefined) throw new Error(`${flag} needs a value`);
      if (flag === '--token') route.token = value;
      else if (flag === '--password') route.password = value;
      else route.probe_timeout_ms = Number(value);
    } else {
      throw new Error(`unknown flag '${flag}'`);
    }
  }
  // An absent file starts from the defaults, so the first `set cloud …`
  // yields usb + lan + cloud rather than a cloud-only config.
  const cfg = loadDeviceConfig();
  const existing = cfg.routes.findIndex((r) => r.name === name);
  if (existing >= 0) {
    // Update in place, keeping credentials that weren't re-passed.
    cfg.routes[existing] = { ...cfg.routes[existing], ...route };
    if (first) cfg.routes.unshift(cfg.routes.splice(existing, 1)[0]!);
  } else if (first) {
    cfg.routes.unshift(route);
  } else {
    cfg.routes.push(route);
  }
  console.log(`wrote ${saveDeviceConfig(cfg)}`);
  show();
}

function rm(name?: string): void {
  if (!name) throw new Error('usage: mbar rm <name>');
  const cfg = loadDeviceConfig();
  if (!cfg.routes.some((r) => r.name === name)) throw new Error(`no route named '${name}'`);
  cfg.routes = cfg.routes.filter((r) => r.name !== name);
  console.log(`wrote ${saveDeviceConfig(cfg)}`);
  show();
}

function order(names: string[]): void {
  if (names.length === 0) throw new Error('usage: mbar order <name> [name...]');
  const cfg = loadDeviceConfig();
  const byName = new Map(cfg.routes.map((r) => [r.name, r]));
  for (const name of names) {
    if (!byName.has(name)) throw new Error(`no route named '${name}'`);
  }
  // Listed names first, in the given order; the rest keep their relative order.
  cfg.routes = [
    ...names.map((name) => byName.get(name)!),
    ...cfg.routes.filter((r) => !names.includes(r.name)),
  ];
  console.log(`wrote ${saveDeviceConfig(cfg)}`);
  show();
}

function init(): void {
  if (existsSync(configPath())) {
    throw new Error(`${configPath()} already exists — edit it with 'mbar set'`);
  }
  console.log(`wrote ${saveDeviceConfig(loadDeviceConfig())}`);
  show();
}

/** Run one connection subcommand; returns the process exit code. */
export async function runDeviceCommand(command: DeviceCommand, args: string[]): Promise<number> {
  try {
    switch (command) {
      case 'probe':
        return await probeAll();
      case 'show':
        show();
        return 0;
      case 'init':
        init();
        return 0;
      case 'set':
        set(args);
        return 0;
      case 'rm':
        rm(args[0]);
        return 0;
      case 'order':
        order(args);
        return 0;
    }
  } catch (error) {
    console.error((error as Error).message);
    return 1;
  }
}
