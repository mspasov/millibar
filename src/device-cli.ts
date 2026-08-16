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

export const DEVICE_COMMANDS = ['probe', 'routes', 'show', 'init', 'set', 'rm', 'order'] as const;
export type DeviceCommand = (typeof DEVICE_COMMANDS)[number];

export function isDeviceCommand(command: string): command is DeviceCommand {
  return (DEVICE_COMMANDS as readonly string[]).includes(command);
}

export function mbarUsage(): string {
  return `mbar — usage pressure on a very small bar

Monitor (the default — no arguments):

  mbar                   switchable monitor modules on the BUSY Bar display.
                         Press the dial to switch modules, START to refresh,
                         rotate the encoder to cycle screens, BACK twice to
                         quit. Ctrl-C also stops and clears the display.
  --modules <names>      which modules run, comma-separated, in cycle order:
                         gauge, dash, history, grok, cpu. The first named is
                         the startup screen; unset runs all (grok only when
                         a \`grok login\` exists). Equivalent to MBAR_MODULES.
  --no-animations        still everything that moves: value changes snap
                         instead of sweeping, history screens skip their
                         intros, quitting skips the turn-off farewell.
                         Equivalent to MBAR_ANIMATIONS=off; the flag wins
                         (--animations overrides an inherited off).

Connection routes (config: ${configPath()}):

  mbar probe             try every route, report status and latency
  mbar routes            list the route names, one per line
  mbar show              print the config (credentials masked)
  mbar init              write the config file with the defaults
  mbar set <name> <addr> [--token T] [--password P] [--timeout MS] [--first]
  mbar rm <name>
  mbar order <name> [name...]

Routes are tried in order; the first whose /api/version answers like a BUSY
device wins. 'set' adds or updates a route (--first puts it at the top).
--route <name[,name...]> on any invocation forces this run to just the named
route(s), in that order, still probed — 'mbar --route cloud' runs the monitor
over the proxy, 'mbar probe --route cloud,lan' probes those two. Equivalent
to MBAR_ROUTE; the flag wins.
Credentials: --token is a cloud API token (https://cloud.busy.app/api-tokens,
for the https://api.busy.app route — create it with the "BUSY Bar" scope, an
Account-scope token 403s); --password is the device's HTTP Access Password if
one is configured.

Device storage (mbar api):

  mbar api <cmd>         browse and manage the device's /ext partition and
                         per-app assets: ls, df, cat, get, put, mv, mkdir,
                         rm, apps, push, wipe — 'mbar api help' for details

Environment:

  MBAR_ADDR              bypass the route config — exact address, unprobed
                         (wins over MBAR_ROUTE/--route)
  MBAR_ROUTE             force these config route(s), comma-separated — what
                         --route sets; honoured by every script in the repo
  MBAR_TOKEN             cloud token for routes that don't carry their own
  MBAR_PASSWORD          HTTP Access Password, likewise
  MBAR_CONFIG            route config path
  MBAR_POLL_INTERVAL_MS, MBAR_REFRESH_COOLDOWN_MS, MBAR_PRIORITY,
  MBAR_SWITCH_BUTTON, MBAR_ANIMATIONS
                         monitor tuning — see README (MBAR_ANIMATIONS is what
                         --[no-]animations sets)`;
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
  const forced = !process.env.MBAR_ADDR && process.env.MBAR_ROUTE;
  console.log(
    `config: ${process.env.MBAR_ADDR ? 'MBAR_ADDR override' : fileNote()}${forced ? ` — forced to ${forced}` : ''}`
  );
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

/** Bare names on stdout — for scripting and for picking a --route value. */
function listRoutes(): void {
  for (const route of loadDeviceConfig().routes) console.log(route.name);
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
      else {
        // Validated like envNumber, not bare Number(): NaN JSON-serialises to
        // null and silently restores the default (a set that looks applied and
        // isn't), 0 makes AbortSignal.timeout abort every probe instantly, and
        // a negative throws from AbortSignal.timeout at probe time.
        const ms = Number(value);
        if (!Number.isFinite(ms) || ms < 1) {
          throw new Error(`--timeout must be a number of milliseconds >= 1, got '${value}'`);
        }
        route.probe_timeout_ms = ms;
      }
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
      case 'routes':
        listRoutes();
        return 0;
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
