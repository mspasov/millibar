import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_ROUTES, configPath, invalidateConnection, loadDeviceConfig } from './connection';
import { runDeviceCommand } from './device-cli';
import { tempDirs } from './test-util';

// Same hygiene as connection.test.ts: never touch the real config or let a
// leaked MBAR_ADDR change what candidateRoutes sees.
const ENV_KEYS = ['MBAR_CONFIG', 'MBAR_ADDR', 'MBAR_ROUTE', 'MBAR_TOKEN', 'MBAR_PASSWORD', 'XDG_CONFIG_HOME'];
const savedEnv: Record<string, string | undefined> = {};
const { tempDir, cleanup } = tempDirs('mbar-device-cli-');

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.MBAR_CONFIG = join(tempDir(), 'config.json');
  invalidateConnection();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  invalidateConnection();
  cleanup();
  for (const server of servers.splice(0)) server.stop(true);
});

const servers: ReturnType<typeof Bun.serve>[] = [];
function fakeDevice(): string {
  const server = Bun.serve({
    port: 0,
    fetch: () => new Response(JSON.stringify({ api_semver: '25.0.0' })),
  });
  servers.push(server);
  return `127.0.0.1:${server.port}`;
}

const routeNames = () => loadDeviceConfig().routes.map((r) => r.name);

describe('set', () => {
  test('first set starts from the defaults and appends', async () => {
    expect(await runDeviceCommand('set', ['cloud', 'https://api.busy.app', '--token', 'tok'])).toBe(0);
    expect(routeNames()).toEqual(['usb', 'lan', 'cloud']);
    expect(loadDeviceConfig().routes[2]).toEqual({
      name: 'cloud',
      addr: 'https://api.busy.app',
      token: 'tok',
    });
  });

  test('--first prepends a new route and promotes an existing one', async () => {
    await runDeviceCommand('set', ['eth2', '192.168.1.50', '--first']);
    expect(routeNames()).toEqual(['eth2', 'usb', 'lan']);
    await runDeviceCommand('set', ['lan', 'busy.bar', '--first']);
    expect(routeNames()).toEqual(['lan', 'eth2', 'usb']);
  });

  test('updating keeps credentials that were not re-passed', async () => {
    await runDeviceCommand('set', ['cloud', 'https://api.busy.app', '--token', 'tok']);
    await runDeviceCommand('set', ['cloud', 'https://api.busy.app', '--timeout', '5000']);
    expect(loadDeviceConfig().routes[2]).toEqual({
      name: 'cloud',
      addr: 'https://api.busy.app',
      token: 'tok',
      probe_timeout_ms: 5000,
    });
  });

  test('bad invocations exit 1 and leave no file behind', async () => {
    expect(await runDeviceCommand('set', ['onlyname'])).toBe(1);
    expect(await runDeviceCommand('set', ['x', 'addr', '--bogus'])).toBe(1);
    expect(await runDeviceCommand('set', ['x', 'addr', '--token'])).toBe(1);
    expect(existsSync(configPath())).toBe(false);
  });
});

describe('rm / order', () => {
  test('rm removes a route; unknown names and emptying the list are errors', async () => {
    await runDeviceCommand('set', ['cloud', 'https://api.busy.app']);
    expect(await runDeviceCommand('rm', ['cloud'])).toBe(0);
    expect(routeNames()).toEqual(['usb', 'lan']);
    expect(await runDeviceCommand('rm', ['cloud'])).toBe(1);
    expect(await runDeviceCommand('rm', ['usb'])).toBe(0);
    // The last route can't be removed: an empty config fails validation.
    expect(await runDeviceCommand('rm', ['lan'])).toBe(1);
    expect(routeNames()).toEqual(['lan']);
  });

  test('order lists names first, the rest keep their relative order', async () => {
    await runDeviceCommand('set', ['cloud', 'https://api.busy.app']);
    expect(await runDeviceCommand('order', ['cloud'])).toBe(0);
    expect(routeNames()).toEqual(['cloud', 'usb', 'lan']);
    expect(await runDeviceCommand('order', ['nope'])).toBe(1);
    expect(await runDeviceCommand('order', [])).toBe(1);
  });
});

describe('init', () => {
  test('writes the defaults once, then refuses', async () => {
    expect(await runDeviceCommand('init', [])).toBe(0);
    expect(loadDeviceConfig().routes).toEqual(DEFAULT_ROUTES);
    expect(await runDeviceCommand('init', [])).toBe(1);
  });
});

describe('probe', () => {
  test('exit 0 when a route answers, 1 when none do', async () => {
    process.env.MBAR_ADDR = fakeDevice();
    expect(await runDeviceCommand('probe', [])).toBe(0);

    const dead = Bun.serve({ port: 0, fetch: () => new Response('') });
    const deadAddr = `127.0.0.1:${dead.port}`;
    dead.stop(true);
    process.env.MBAR_ADDR = deadAddr;
    expect(await runDeviceCommand('probe', [])).toBe(1);
  });
});

describe('routes', () => {
  test('prints bare names, one per line, exit 0', async () => {
    await runDeviceCommand('set', ['cloud', 'https://api.busy.app']);
    const lines: string[] = [];
    const realLog = console.log;
    console.log = (line: string) => lines.push(line);
    try {
      expect(await runDeviceCommand('routes', [])).toBe(0);
    } finally {
      console.log = realLog;
    }
    expect(lines).toEqual(['usb', 'lan', 'cloud']);
  });
});

describe('mbar entry point', () => {
  const repoRoot = join(import.meta.dir, '..');

  test('--help prints usage and exits 0 without touching the device', () => {
    const result = Bun.spawnSync(['bun', 'run', 'src/mbar.ts', '--help'], { cwd: repoRoot });
    expect(result.exitCode).toBe(0);
    const out = result.stdout.toString();
    expect(out).toContain('mbar probe');
    expect(out).toContain('mbar api');
    expect(out).toContain('MBAR_ADDR');
    expect(out).toContain('MBAR_ROUTE');
  });

  test('--route reaches route selection from any argv position', () => {
    // End-to-end through the flag-stripping in mbar.ts: a bogus forced name
    // must surface as the connection error, not as an unknown command.
    const result = Bun.spawnSync(['bun', 'run', 'src/mbar.ts', 'probe', '--route', 'nope'], {
      cwd: repoRoot,
      env: { ...process.env, MBAR_CONFIG: join(tempDir(), 'config.json') },
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("no route named 'nope'");

    const eq = Bun.spawnSync(['bun', 'run', 'src/mbar.ts', '--route=nope', 'probe'], {
      cwd: repoRoot,
      env: { ...process.env, MBAR_CONFIG: join(tempDir(), 'config.json') },
    });
    expect(eq.exitCode).toBe(1);
    expect(eq.stderr.toString()).toContain("no route named 'nope'");
  });

  test('--route without a value exits 1 with guidance', () => {
    const result = Bun.spawnSync(['bun', 'run', 'src/mbar.ts', '--route'], { cwd: repoRoot });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain('--route needs a value');
  });

  test('an unknown command exits 1 with the usage on stderr', () => {
    const result = Bun.spawnSync(['bun', 'run', 'src/mbar.ts', 'frobnicate'], { cwd: repoRoot });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("unknown command 'frobnicate'");
  });
});
