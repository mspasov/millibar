import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import {
  candidateRoutes,
  configPath,
  DEFAULT_ROUTES,
  deviceFetch,
  invalidateConnection,
  loadDeviceConfig,
  probeRoute,
  resolveConnection,
  saveDeviceConfig,
  wsUrl,
  type Route,
} from './connection';
import { tempDirs } from './test-util';

// Every test runs against a scratch config path and a clean env — the suite
// must never read (or write!) the developer's real ~/.config/mbar/config.json.
const ENV_KEYS = ['MBAR_CONFIG', 'MBAR_ADDR', 'MBAR_ROUTE', 'MBAR_TOKEN', 'MBAR_PASSWORD', 'XDG_CONFIG_HOME'];
const savedEnv: Record<string, string | undefined> = {};
const { tempDir, cleanup } = tempDirs('mbar-connection-');

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

/** A fake device: answers /api/version, counts hits, optionally slow, dead
 * slow, or not a BUSY device at all. */
const servers: ReturnType<typeof Bun.serve>[] = [];
function fakeDevice(
  opts: {
    semver?: string;
    versionStatus?: number;
    versionBody?: string;
    delayMs?: number;
    /** Probe answers normally; every other request hangs forever. */
    hang?: boolean;
  } = {}
) {
  // Header values are read eagerly — the Request object isn't reliably
  // inspectable after its handler returns.
  const hits: { auth: string | null; xapi: string | null }[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      if (opts.delayMs) await Bun.sleep(opts.delayMs);
      if (url.pathname === '/api/version') {
        hits.push({ auth: req.headers.get('Authorization'), xapi: req.headers.get('X-API-Token') });
        if (opts.versionStatus) return new Response('', { status: opts.versionStatus });
        return new Response(opts.versionBody ?? JSON.stringify({ api_semver: opts.semver ?? '25.0.0' }));
      }
      if (opts.hang) return new Promise<Response>(() => {});
      return new Response(
        JSON.stringify({
          echoed: url.pathname,
          auth: req.headers.get('Authorization'),
          ctype: req.headers.get('Content-Type'),
        })
      );
    },
  });
  servers.push(server);
  return { addr: `127.0.0.1:${server.port}`, versionHits: hits };
}

/** A TCP port with nothing listening — connection refused, immediately. */
function deadAddr(): string {
  const server = Bun.serve({ port: 0, fetch: () => new Response('') });
  const addr = `127.0.0.1:${server.port}`;
  server.stop(true);
  return addr;
}

function writeConfig(routes: Route[]): void {
  saveDeviceConfig({ routes });
  invalidateConnection(); // the memo key doesn't hash file contents
}

describe('config file', () => {
  test('missing file falls back to the usb + lan defaults', () => {
    expect(loadDeviceConfig().routes).toEqual(DEFAULT_ROUTES);
  });

  test('save/load round-trips and the file is private (0600)', () => {
    const routes: Route[] = [
      { name: 'usb', addr: '10.0.4.20' },
      { name: 'cloud', addr: 'https://api.busy.app', token: 'sekret', probe_timeout_ms: 5000 },
    ];
    const path = saveDeviceConfig({ routes });
    expect(path).toBe(configPath());
    expect(loadDeviceConfig().routes).toEqual(routes);
    // The token lives in this file; group/world bits must be off.
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test('rejects malformed configs with the path in the message', () => {
    expect(() => saveDeviceConfig({ routes: [] })).toThrow('non-empty');
    expect(() => saveDeviceConfig({ routes: [{ name: 'x', addr: '' }] })).toThrow("route 'x'");
    expect(() =>
      saveDeviceConfig({ routes: [{ name: 'a', addr: '1' }, { name: 'a', addr: '2' }] })
    ).toThrow("duplicate route name 'a'");
    Bun.write(configPath(), '{nope');
    expect(() => loadDeviceConfig()).toThrow(configPath());
  });
});

describe('candidateRoutes', () => {
  test('MBAR_ADDR replaces the whole list with one env route', () => {
    writeConfig([{ name: 'lan', addr: 'busy.bar' }]);
    process.env.MBAR_ADDR = '192.168.1.50';
    expect(candidateRoutes()).toEqual([{ name: 'env', addr: '192.168.1.50', token: undefined, password: undefined }]);
  });

  test('MBAR_ROUTE narrows the list to the named routes, in that order', () => {
    writeConfig([
      { name: 'usb', addr: '10.0.4.20' },
      { name: 'lan', addr: 'busy.bar' },
      { name: 'cloud', addr: 'api.busy.app', token: 'tok' },
    ]);
    process.env.MBAR_ROUTE = 'cloud,lan';
    expect(candidateRoutes().map((r) => r.name)).toEqual(['cloud', 'lan']);
    // Whitespace around names is tolerated — 'cloud, lan' comes from shells.
    process.env.MBAR_ROUTE = ' cloud , lan ';
    expect(candidateRoutes().map((r) => r.name)).toEqual(['cloud', 'lan']);
  });

  test('an unknown forced name fails loudly instead of falling back', () => {
    // A typo'd --route silently probing usb anyway would defeat the forcing.
    writeConfig([{ name: 'usb', addr: '10.0.4.20' }]);
    process.env.MBAR_ROUTE = 'cluod';
    expect(() => candidateRoutes()).toThrow("no route named 'cluod'");
    expect(() => candidateRoutes()).toThrow('usb');
  });

  test('MBAR_ADDR wins over MBAR_ROUTE', () => {
    writeConfig([{ name: 'lan', addr: 'busy.bar' }]);
    process.env.MBAR_ROUTE = 'nonexistent'; // must not even be validated
    process.env.MBAR_ADDR = '192.168.1.50';
    expect(candidateRoutes().map((r) => r.name)).toEqual(['env']);
  });

  test('env credentials fill gaps but never override the file', () => {
    writeConfig([
      { name: 'lan', addr: 'busy.bar' },
      { name: 'cloud', addr: 'https://api.busy.app', token: 'from-file' },
    ]);
    process.env.MBAR_TOKEN = 'from-env';
    process.env.MBAR_PASSWORD = 'pw-env';
    const [lan, cloud] = candidateRoutes();
    expect(lan!.token).toBe('from-env');
    expect(lan!.password).toBe('pw-env');
    expect(cloud!.token).toBe('from-file');
  });
});

describe('probeRoute', () => {
  test('accepts a BUSY device and captures its api_semver', async () => {
    const device = fakeDevice({ semver: '25.0.0' });
    const conn = await probeRoute({ name: 'usb', addr: device.addr });
    expect(conn.base).toBe(`http://${device.addr}`);
    expect(conn.ws).toBe(`ws://${device.addr}`);
    expect(conn.apiSemver).toBe('25.0.0');
  });

  test('sends credentials with the probe itself', async () => {
    // A password-protected device 401s the probe too — creds must be on it.
    const device = fakeDevice();
    await probeRoute({ name: 'usb', addr: device.addr, token: 'tok', password: 'pw' });
    expect(device.versionHits[0]!.auth).toBe('Bearer tok');
    expect(device.versionHits[0]!.xapi).toBe('pw');
  });

  test('a 200 without api_semver is not a BUSY device', async () => {
    // Captive portals and stale busy.bar DNS answer 200 to anything.
    const portal = fakeDevice({ versionBody: '<html>hotel wifi</html>' });
    await expect(probeRoute({ name: 'lan', addr: portal.addr })).rejects.toThrow('not a BUSY device');
  });

  test('distinguishes missing from rejected credentials on 401', async () => {
    const locked = fakeDevice({ versionStatus: 401 });
    await expect(probeRoute({ name: 'usb', addr: locked.addr })).rejects.toThrow('credentials required');
    await expect(probeRoute({ name: 'usb', addr: locked.addr, password: 'bad' })).rejects.toThrow(
      'credentials rejected'
    );
  });

  test('reports unreachable routes as such', async () => {
    await expect(probeRoute({ name: 'usb', addr: deadAddr() })).rejects.toThrow('unreachable');
  });
});

describe('resolveConnection', () => {
  test('a slower first route still beats a faster second one', async () => {
    // Priority order is the user's preference, not a race: usb-with-jitter
    // must not lose the display to the cloud proxy on a lucky RTT.
    const slow = fakeDevice({ semver: '1.0.0', delayMs: 150 });
    const fast = fakeDevice({ semver: '2.0.0' });
    writeConfig([
      { name: 'slow', addr: slow.addr },
      { name: 'fast', addr: fast.addr },
    ]);
    const conn = await resolveConnection();
    expect(conn.route.name).toBe('slow');
  });

  test('a forced route wins over an alive earlier one; flipping the force re-resolves', async () => {
    const usb = fakeDevice({ semver: '1.0.0' });
    const lan = fakeDevice({ semver: '2.0.0' });
    writeConfig([
      { name: 'usb', addr: usb.addr },
      { name: 'lan', addr: lan.addr },
    ]);
    expect((await resolveConnection()).route.name).toBe('usb');
    // The memo key covers MBAR_ROUTE — a caller flipping it mid-process
    // must get the newly forced route, not the memoized winner.
    process.env.MBAR_ROUTE = 'lan';
    expect((await resolveConnection()).route.name).toBe('lan');
  });

  test('falls over to the next route when the first is dead', async () => {
    const device = fakeDevice();
    writeConfig([
      { name: 'usb', addr: deadAddr() },
      { name: 'lan', addr: device.addr },
    ]);
    const conn = await resolveConnection();
    expect(conn.route.name).toBe('lan');
  });

  test('memoizes the winner; invalidateConnection() forces a re-probe', async () => {
    const device = fakeDevice();
    writeConfig([{ name: 'usb', addr: device.addr }]);
    await resolveConnection();
    await resolveConnection();
    expect(device.versionHits.length).toBe(1);
    invalidateConnection();
    await resolveConnection();
    expect(device.versionHits.length).toBe(2);
  });

  test('total failure lists every route and is not cached', async () => {
    writeConfig([
      { name: 'usb', addr: deadAddr() },
      { name: 'lan', addr: deadAddr() },
    ]);
    await expect(resolveConnection()).rejects.toThrow(/usb .*; lan /);
    // The device coming back (here: the config changing) must be picked up
    // by the very next attempt — an off-then-on device mustn't need a restart.
    const device = fakeDevice();
    writeConfig([{ name: 'usb', addr: device.addr }]);
    expect((await resolveConnection()).route.name).toBe('usb');
  });
});

describe('deviceFetch', () => {
  test('env route: no probe, base prefixed, auth attached, per-call headers win', async () => {
    const device = fakeDevice();
    process.env.MBAR_ADDR = device.addr;
    process.env.MBAR_TOKEN = 'tok';
    const response = await deviceFetch('/api/status', { headers: { 'Content-Type': 'application/json' } });
    const body = (await response.json()) as { echoed: string; auth: string };
    expect(body.echoed).toBe('/api/status');
    expect(body.auth).toBe('Bearer tok');
    expect(device.versionHits.length).toBe(0); // trusted verbatim, never probed
  });

  test('every HeadersInit shape merges with auth instead of dropping headers', async () => {
    const device = fakeDevice();
    process.env.MBAR_ADDR = device.addr;
    process.env.MBAR_TOKEN = 'tok';
    // A Headers instance and a tuple array have no own enumerable string keys,
    // so the old object-spread merge lost them silently.
    const shapes: NonNullable<RequestInit['headers']>[] = [
      { 'Content-Type': 'application/json' },
      new Headers({ 'Content-Type': 'application/json' }),
      [['Content-Type', 'application/json']],
    ];
    for (const headers of shapes) {
      const body = (await (await deviceFetch('/api/status', { headers })).json()) as {
        auth: string; ctype: string;
      };
      expect(body.auth).toBe('Bearer tok'); // auth survived the merge
      expect(body.ctype).toBe('application/json'); // and the caller's header arrived
    }
    // Per-call headers still win over the route's auth, whatever the shape.
    const override = (await (
      await deviceFetch('/api/status', { headers: new Headers({ Authorization: 'Bearer other' }) })
    ).json()) as { auth: string };
    expect(override.auth).toBe('Bearer other');
  });

  test('a timed-out request invalidates the route; a deliberate abort keeps it', async () => {
    const device = fakeDevice();
    writeConfig([{ name: 'usb', addr: device.addr }]);
    await resolveConnection();
    expect(device.versionHits.length).toBe(1);

    // Deliberate abort — the route is fine, the caller changed its mind.
    const controller = new AbortController();
    controller.abort();
    await expect(deviceFetch('/api/status', { signal: controller.signal })).rejects.toThrow();
    await resolveConnection();
    expect(device.versionHits.length).toBe(1); // memo survived

    // Timeout — the route may be gone; the next call must re-probe.
    const hung = fakeDevice({ hang: true });
    writeConfig([{ name: 'usb', addr: hung.addr }]);
    await resolveConnection();
    expect(hung.versionHits.length).toBe(1);
    await expect(
      deviceFetch('/api/status', { signal: AbortSignal.timeout(100) })
    ).rejects.toThrow();
    await resolveConnection();
    expect(hung.versionHits.length).toBe(2); // the timeout dropped the memo
  });

  test('re-probes after a network failure and fails over mid-run', async () => {
    // The monitor's real failure mode: USB route dies mid-run, the next poll
    // should land on the lan route without a process restart.
    const usb = fakeDevice();
    const lan = fakeDevice();
    writeConfig([
      { name: 'usb', addr: usb.addr },
      { name: 'lan', addr: lan.addr },
    ]);
    expect((await resolveConnection()).route.name).toBe('usb');
    servers.find((s) => s.port === Number(usb.addr.split(':')[1]))!.stop(true);
    await deviceFetch('/api/status').catch(() => {});
    expect((await resolveConnection()).route.name).toBe('lan');
  });
});

describe('wsUrl', () => {
  test('maps to ws:// and carries the password as x-api-token', async () => {
    const device = fakeDevice();
    writeConfig([{ name: 'usb', addr: device.addr, password: 'pw', token: 'tok' }]);
    // Password wins over token for the query param, matching busy-lib's
    // LocalStateStream (HTTPAccessPassword ?? token).
    expect(await wsUrl('/api/status/ws')).toBe(`ws://${device.addr}/api/status/ws?x-api-token=pw`);
  });

  test('no credentials, no query parameter', async () => {
    const device = fakeDevice();
    process.env.MBAR_ADDR = device.addr;
    expect(await wsUrl('/api/status/ws')).toBe(`ws://${device.addr}/api/status/ws`);
  });
});
