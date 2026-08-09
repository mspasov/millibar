/**
 * Manage and probe the persistent BUSY Bar connection config.
 *
 * The config is an ordered list of routes — typically the fixed USB-Ethernet
 * IP, the LAN hostname, and the cloud proxy — and every script in this repo
 * uses the first route whose `/api/version` answers. `probe` shows that
 * decision instead of making you infer it from a hung draw call.
 *
 * Usage: bun run tools/device.ts [command]
 */
import {
  candidateRoutes,
  configPath,
  loadDeviceConfig,
  probeRoute,
  saveDeviceConfig,
  type Route,
} from '../src/connection';
import { existsSync } from 'node:fs';

const USAGE = `device — BUSY Bar connection routes (config: ${configPath()})

  bun run tools/device.ts [probe]   try every route, report status and latency
  bun run tools/device.ts show      print the config (credentials masked)
  bun run tools/device.ts init      write the config file with the defaults
  bun run tools/device.ts set <name> <addr> [--token T] [--password P] [--timeout MS] [--first]
  bun run tools/device.ts rm <name>
  bun run tools/device.ts order <name> [name...]

Routes are tried in order; the first whose /api/version answers like a BUSY
device wins. 'set' adds or updates a route (--first puts it at the top).
Credentials: --token is a cloud API token (https://cloud.busy.app/api-tokens,
for the https://api.busy.app route); --password is the device's HTTP Access
Password if one is configured. BUSY_BAR_ADDR bypasses the config entirely;
BUSY_BAR_TOKEN / BUSY_BAR_PASSWORD fill credentials without persisting them.
`;

const [command = 'probe', ...args] = process.argv.slice(2);

function fileNote(): string {
  return existsSync(configPath()) ? configPath() : `${configPath()} (not written yet — using defaults)`;
}

function describeRoute(route: Route): string {
  const creds = [route.token && 'token', route.password && 'password'].filter(Boolean).join('+');
  return `${route.name.padEnd(8)} ${route.addr.padEnd(28)}${creds ? ` [${creds}]` : ''}`;
}

async function probeAll(): Promise<void> {
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
    process.exit(1);
  }
}

function show(): void {
  console.log(`config: ${fileNote()}`);
  for (const route of loadDeviceConfig().routes) {
    console.log(`  ${describeRoute(route)}${route.probe_timeout_ms ? ` timeout ${route.probe_timeout_ms}ms` : ''}`);
  }
}

/** Load for editing: an absent file starts from the defaults, so the first
 * `set cloud …` yields usb + lan + cloud rather than a cloud-only config. */
function loadForEdit(): { routes: Route[] } {
  return loadDeviceConfig();
}

function set(setArgs: string[]): void {
  const [name, addr] = setArgs;
  if (!name || !addr) throw new Error("usage: set <name> <addr> [--token T] [--password P] [--timeout MS] [--first]");
  const route: Route = { name, addr };
  let first = false;
  for (let i = 2; i < setArgs.length; i++) {
    const flag = setArgs[i]!;
    if (flag === '--first') {
      first = true;
    } else if (flag === '--token' || flag === '--password' || flag === '--timeout') {
      const value = setArgs[++i];
      if (value === undefined) throw new Error(`${flag} needs a value`);
      if (flag === '--token') route.token = value;
      else if (flag === '--password') route.password = value;
      else route.probe_timeout_ms = Number(value);
    } else {
      throw new Error(`unknown flag '${flag}'`);
    }
  }
  const cfg = loadForEdit();
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
  if (!name) throw new Error('usage: rm <name>');
  const cfg = loadForEdit();
  if (!cfg.routes.some((r) => r.name === name)) throw new Error(`no route named '${name}'`);
  cfg.routes = cfg.routes.filter((r) => r.name !== name);
  console.log(`wrote ${saveDeviceConfig(cfg)}`);
  show();
}

function order(names: string[]): void {
  if (names.length === 0) throw new Error('usage: order <name> [name...]');
  const cfg = loadForEdit();
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

try {
  switch (command) {
    case 'probe':
      await probeAll();
      break;
    case 'show':
      show();
      break;
    case 'init':
      if (existsSync(configPath())) throw new Error(`${configPath()} already exists — edit it with 'set'`);
      console.log(`wrote ${saveDeviceConfig(loadDeviceConfig())}`);
      show();
      break;
    case 'set':
      set(args);
      break;
    case 'rm':
      rm(args[0]);
      break;
    case 'order':
      order(args);
      break;
    case 'help':
    case '--help':
    case '-h':
      console.log(USAGE);
      break;
    default:
      console.error(`unknown command '${command}'\n\n${USAGE}`);
      process.exit(1);
  }
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}
