import { afterEach, describe, expect, test } from 'bun:test';
import {
  StorageError,
  basename,
  humanSize,
  list,
  mkdirp,
  normalizePath,
  parentOf,
  rename,
  requiresForce,
  stat,
  storageStatus,
  write,
} from './store';
import { restoreFetch, stubFetch } from './test-util';

describe('normalizePath', () => {
  test('resolves relative and absolute forms to the same device path', () => {
    expect(normalizePath('user_assets/foo')).toBe('/ext/user_assets/foo');
    expect(normalizePath('/ext/user_assets/foo')).toBe('/ext/user_assets/foo');
    expect(normalizePath('ext/user_assets/foo')).toBe('/ext/user_assets/foo');
  });

  test('empty input and stray slashes resolve to the storage root', () => {
    expect(normalizePath('')).toBe('/ext');
    expect(normalizePath('/')).toBe('/ext');
    expect(normalizePath('/ext/')).toBe('/ext');
    expect(normalizePath('a//b/')).toBe('/ext/a/b');
  });

  test('rejects characters the device pattern forbids', () => {
    expect(() => normalizePath('has space.txt')).toThrow(StorageError);
    expect(() => normalizePath('naïve.txt')).toThrow(StorageError);
  });

  test('rejects dot segments that would escape the user_assets rm guard', () => {
    expect(() => normalizePath('user_assets/../apps_assets')).toThrow(StorageError);
    expect(() => normalizePath('./x')).toThrow(StorageError);
  });
});

describe('path helpers', () => {
  test('basename and parentOf agree at the root', () => {
    expect(basename('/ext/a/b.txt')).toBe('b.txt');
    expect(parentOf('/ext/a/b.txt')).toBe('/ext/a');
    expect(parentOf('/ext/a')).toBe('/ext');
    expect(parentOf('/ext')).toBeNull();
  });

  test('requiresForce covers user_assets itself but not its children', () => {
    expect(requiresForce('/ext/user_assets/my_app')).toBe(false);
    expect(requiresForce('/ext/user_assets/my_app/deep/file.anim')).toBe(false);
    // Deleting the whole user_assets tree is not an everyday operation.
    expect(requiresForce('/ext/user_assets')).toBe(true);
    expect(requiresForce('/ext/apps_assets/shared')).toBe(true);
    expect(requiresForce('/ext/Manifest')).toBe(true);
  });
});

describe('humanSize', () => {
  test('picks sensible units', () => {
    expect(humanSize(0)).toBe('0 B');
    expect(humanSize(1023)).toBe('1023 B');
    expect(humanSize(1024)).toBe('1.0 KB');
    expect(humanSize(3456)).toBe('3.4 KB');
    expect(humanSize(2_700_000)).toBe('2.6 MB');
    expect(humanSize(7_461_896_192)).toBe('6.9 GB');
    expect(humanSize(123 * 1024)).toBe('123 KB'); // 3 digits drop the decimal
  });
});

// --- wire-level tests with a stubbed fetch ----------------------------------
// The DisplayDraw incident (see CLAUDE.md) is why these assert on the actual
// request rather than trusting the wrappers' signatures.

afterEach(restoreFetch);

const ok = (json: unknown) => new Response(JSON.stringify(json), { status: 200 });

describe('storage client on the wire', () => {
  test('write sends the path as a query param and the bytes as the raw body', async () => {
    const calls = stubFetch(() => ok({ result: 'OK' }));
    await write('/ext/user_assets/x/a.bin', new Uint8Array([1, 2, 3]));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url.pathname).toBe('/api/storage/write');
    expect(calls[0]!.url.searchParams.get('path')).toBe('/ext/user_assets/x/a.bin');
    expect(calls[0]!.body).toEqual(new Uint8Array([1, 2, 3]));
  });

  test('rename sends both path and new_path', async () => {
    const calls = stubFetch(() => ok({ result: 'OK' }));
    await rename('/ext/a.txt', '/ext/b.txt');
    expect(calls[0]!.url.searchParams.get('path')).toBe('/ext/a.txt');
    expect(calls[0]!.url.searchParams.get('new_path')).toBe('/ext/b.txt');
  });

  test('list unwraps the response envelope', async () => {
    stubFetch(() => ok({ list: [{ type: 'file', name: 'a.txt', size: 5 }] }));
    expect(await list('/ext')).toEqual([{ type: 'file', name: 'a.txt', size: 5 }]);
  });

  test('errors carry the device detail and HTTP status', async () => {
    stubFetch(() => new Response(JSON.stringify({ error: 'Bad Request' }), { status: 400 }));
    try {
      await list('/ext/nope');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(StorageError);
      expect((error as StorageError).status).toBe(400);
      expect((error as StorageError).message).toContain('Bad Request');
      expect((error as StorageError).message).toContain('/ext/nope');
    }
  });
});

describe('stat', () => {
  test('finds the entry by listing the parent', async () => {
    const calls = stubFetch(() =>
      ok({ list: [{ type: 'dir', name: 'sub' }, { type: 'file', name: 'a.txt', size: 5 }] })
    );
    expect(await stat('/ext/x/a.txt')).toEqual({ type: 'file', name: 'a.txt', size: 5 });
    expect(calls[0]!.url.pathname).toBe('/api/storage/list');
    expect(calls[0]!.url.searchParams.get('path')).toBe('/ext/x');
  });

  test('a 400 on the parent means the path does not exist', async () => {
    stubFetch(() => new Response(JSON.stringify({ error: 'Bad Request' }), { status: 400 }));
    expect(await stat('/ext/missing/a.txt')).toBeNull();
  });

  test('the storage root exists without a request', async () => {
    const calls = stubFetch(() => ok({}));
    expect((await stat('/ext'))?.type).toBe('dir');
    expect(calls).toHaveLength(0);
  });
});

describe('full-URL BUSY_BAR_ADDR', () => {
  test('a scheme-carrying addr reaches the server instead of becoming http://http://…', async () => {
    // Real fetch against a local echo server — the regression this guards
    // broke every bbar command whenever BUSY_BAR_ADDR was a full URL.
    const status = { used_bytes: 1024, free_bytes: 2048, total_bytes: 3072 };
    const server = Bun.serve({
      port: 0,
      fetch: (req) =>
        new URL(req.url).pathname === '/api/storage/status'
          ? Response.json(status)
          : new Response('wrong path', { status: 404 }),
    });
    const previous = process.env.BUSY_BAR_ADDR;
    process.env.BUSY_BAR_ADDR = `http://127.0.0.1:${server.port}/`;
    try {
      expect(await storageStatus()).toEqual(status);
    } finally {
      if (previous === undefined) delete process.env.BUSY_BAR_ADDR;
      else process.env.BUSY_BAR_ADDR = previous;
      server.stop(true);
    }
  });
});

describe('mkdirp', () => {
  test('creates each level and skips already-existing ones', async () => {
    const calls = stubFetch((captured) =>
      captured.url.searchParams.get('path') === '/ext/a'
        ? new Response(JSON.stringify({ error: 'Bad Request' }), { status: 400 }) // exists
        : ok({ result: 'OK' })
    );
    await mkdirp('/ext/a/b/c');
    expect(calls.map((c) => c.url.searchParams.get('path'))).toEqual([
      '/ext/a',
      '/ext/a/b',
      '/ext/a/b/c',
    ]);
    expect(calls.every((c) => c.url.pathname === '/api/storage/mkdir')).toBe(true);
  });
});
