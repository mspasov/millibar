/**
 * Shared test scaffolding. Wire-level tests stub global fetch and assert on
 * the captured requests — the DisplayDraw incident (see CLAUDE.md) is why
 * they check the actual request rather than trusting wrapper signatures.
 *
 * Not a test file itself: helpers only, wired up by each suite
 * (`afterEach(restoreFetch)` / `afterEach(cleanup)`).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface CapturedRequest {
  url: URL;
  method: string;
  body?: RequestInit['body'];
}

const realFetch = globalThis.fetch;
let savedAddr: string | undefined;

/** Replace global fetch with a capturing stub; returns the (live) call list.
 * Pair with `afterEach(restoreFetch)`. */
export function stubFetch(
  respond: (captured: CapturedRequest) => Response = () => new Response('{}')
): CapturedRequest[] {
  // The stub IS the device: point the connection resolver's env override at
  // it, so device calls go straight through the stub instead of probing the
  // configured routes — which would fail on the stub's canned reply (no
  // api_semver) or, without the stub, leak requests to the real device.
  savedAddr = process.env.MBAR_ADDR;
  process.env.MBAR_ADDR = 'stub.device';
  const calls: CapturedRequest[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const captured: CapturedRequest = {
      url: new URL(String(input)),
      method: init?.method ?? 'GET',
      body: init?.body,
    };
    calls.push(captured);
    return respond(captured);
  }) as typeof fetch;
  return calls;
}

export function restoreFetch(): void {
  globalThis.fetch = realFetch;
  if (savedAddr === undefined) delete process.env.MBAR_ADDR;
  else process.env.MBAR_ADDR = savedAddr;
}

/** mkdtemp directories that one `afterEach(cleanup)` removes. */
export function tempDirs(prefix: string): { tempDir(): string; cleanup(): void } {
  const dirs: string[] = [];
  return {
    tempDir(): string {
      const dir = mkdtempSync(join(tmpdir(), prefix));
      dirs.push(dir);
      return dir;
    },
    cleanup(): void {
      for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    },
  };
}
