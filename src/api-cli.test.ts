import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { runApiCommand, type ApiCommand } from './api-cli';
import { invalidateConnection } from './connection';
import { tempDirs } from './test-util';

// Same hygiene as device-cli.test.ts: never touch the real config or let a
// leaked BUSY_BAR_ADDR change what candidateRoutes sees. Extra stakes here:
// with no BUSY_BAR_ADDR, a handler that gets past argument validation would
// probe the *default* routes — the real, shared device — so every test that
// reaches the wire must point BUSY_BAR_ADDR at a fake first.
const ENV_KEYS = ['MBAR_CONFIG', 'BUSY_BAR_ADDR', 'BUSY_BAR_ROUTE', 'BUSY_BAR_TOKEN', 'BUSY_BAR_PASSWORD', 'XDG_CONFIG_HOME'];
const savedEnv: Record<string, string | undefined> = {};
const { tempDir, cleanup } = tempDirs('mbar-api-cli-');

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

/** Fake device: answers the /api/version handshake, logs every request. */
function fakeDevice(handle: (url: URL) => Response | undefined): { addr: string; requests: string[] } {
  const requests: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: (req) => {
      const url = new URL(req.url);
      requests.push(`${req.method} ${url.pathname}`);
      if (url.pathname === '/api/version') return Response.json({ api_semver: '25.0.0' });
      return handle(url) ?? Response.json({ error: 'unexpected request' }, { status: 400 });
    },
  });
  servers.push(server);
  return { addr: `127.0.0.1:${server.port}`, requests };
}

/** runApiCommand with stdout/stderr captured line-by-line. */
async function run(command: ApiCommand, args: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const realLog = console.log;
  const realError = console.error;
  console.log = (line: unknown) => out.push(String(line));
  console.error = (line: unknown) => err.push(String(line));
  try {
    const code = await runApiCommand(command, args);
    return { code, out: out.join('\n'), err: err.join('\n') };
  } finally {
    console.log = realLog;
    console.error = realError;
  }
}

describe('usage errors (fail before any device contact)', () => {
  // No BUSY_BAR_ADDR is set in any of these: passing means expect()/parseArgs
  // threw before a handler could reach the network.
  test('missing arguments exit 1 with a `usage: mbar api` line', async () => {
    for (const [cmd, args] of [
      ['cat', []],
      ['put', ['only-one']],
      ['rm', []],
      ['df', ['extra']],
    ] as [ApiCommand, string[]][]) {
      const { code, err } = await run(cmd, args);
      expect(code).toBe(1);
      expect(err).toContain(`usage: mbar api ${cmd}`);
    }
  });

  test('an unknown flag exits 1', async () => {
    const { code, err } = await run('ls', ['--frob']);
    expect(code).toBe(1);
    expect(err).toContain('unknown flag: --frob');
  });
});

describe('against a fake device', () => {
  test('df --json prints the storage status verbatim', async () => {
    const status = { used_bytes: 1024, free_bytes: 2048, total_bytes: 3072 };
    const fake = fakeDevice((url) => (url.pathname === '/api/storage/status' ? Response.json(status) : undefined));
    process.env.BUSY_BAR_ADDR = fake.addr;
    const { code, out } = await run('df', ['--json']);
    expect(code).toBe(0);
    expect(JSON.parse(out)).toEqual(status);
  });

  test('rm guards refuse before the remove request is ever made', async () => {
    // The device's remove endpoint deletes directories recursively and 200s
    // on missing paths (DEVICE.md), so all rm safety is client-side — the
    // point of this test is the request log staying free of /storage/remove.
    const fake = fakeDevice((url) => {
      if (url.pathname === '/api/storage/list' && url.searchParams.get('path') === '/ext') {
        return Response.json({
          list: [
            { type: 'dir', name: 'somedir' },
            { type: 'file', name: 'stock.bin', size: 10 },
          ],
        });
      }
      return undefined;
    });
    process.env.BUSY_BAR_ADDR = fake.addr;

    const dir = await run('rm', ['somedir']);
    expect(dir.code).toBe(1);
    expect(dir.err).toContain('is a directory');

    const stock = await run('rm', ['stock.bin']);
    expect(stock.code).toBe(1);
    expect(stock.err).toContain('--force');

    expect(fake.requests.filter((r) => r.includes('/api/storage/remove'))).toEqual([]);
  });

  test('rm removes a user-asset file once the guards pass', async () => {
    const fake = fakeDevice((url) => {
      if (url.pathname === '/api/storage/list' && url.searchParams.get('path') === '/ext/user_assets/app') {
        return Response.json({ list: [{ type: 'file', name: 'a.bin', size: 4 }] });
      }
      if (url.pathname === '/api/storage/remove') return Response.json({});
      return undefined;
    });
    process.env.BUSY_BAR_ADDR = fake.addr;
    const { code, out } = await run('rm', ['user_assets/app/a.bin']);
    expect(code).toBe(0);
    expect(out).toContain('removed /ext/user_assets/app/a.bin');
    expect(fake.requests).toContain('DELETE /api/storage/remove');
  });
});

describe('mbar api entry point', () => {
  const repoRoot = join(import.meta.dir, '..');

  test('bare `mbar api` prints the api usage and exits 0', () => {
    const result = Bun.spawnSync(['bun', 'run', 'src/mbar.ts', 'api'], { cwd: repoRoot });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain('mbar api ls');
  });

  test('an unknown api command exits 1 with the api usage on stderr', () => {
    const result = Bun.spawnSync(['bun', 'run', 'src/mbar.ts', 'api', 'frobnicate'], { cwd: repoRoot });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("unknown api command 'frobnicate'");
  });

  test('--route flows through the stripper to api commands', () => {
    // stripper → api dispatch → connection layer, end-to-end, no hardware: a
    // bogus forced route must surface as the connection error.
    const result = Bun.spawnSync(['bun', 'run', 'src/mbar.ts', 'api', 'df', '--route', 'nope'], {
      cwd: repoRoot,
      env: { ...process.env, MBAR_CONFIG: join(tempDir(), 'config.json') },
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("no route named 'nope'");
  });
});
