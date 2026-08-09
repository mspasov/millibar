/**
 * Client for the BUSY Bar storage (`/api/storage/*`) and assets
 * (`/api/assets/upload`) HTTP APIs, plus the pure path/size helpers the
 * bbar CLI is built from.
 *
 * Device behaviours this module has to encode (verified on firmware 1.1.1,
 * documented in DEVICE.md):
 *
 * - `remove` deletes non-empty directories recursively in one call, and
 *   returns 200 for paths that don't exist — callers that care must stat
 *   first, the device won't tell them.
 * - `write` auto-creates exactly one missing parent directory; anything
 *   deeper fails with 508. `mkdirp()` exists for deep targets.
 * - `rename` silently overwrites an existing target and does not create
 *   target directories.
 * - `list` returns 400 both for a file path and for a missing path — the
 *   two are indistinguishable without listing the parent, which is what
 *   `stat()` does.
 * - `mkdir` returns 400 when the directory already exists.
 */

import { httpBase } from './config';

export const EXT_ROOT = '/ext';
export const USER_ASSETS = '/ext/user_assets';

export interface StorageEntry {
  type: 'file' | 'dir';
  name: string;
  size?: number;
}

export interface StorageStatus {
  used_bytes: number;
  free_bytes: number;
  total_bytes: number;
}

export class StorageError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message);
    this.name = 'StorageError';
  }
}

/** Long enough for a multi-megabyte .anim over the device's link. */
const TRANSFER_TIMEOUT_MS = 120_000;
const TIMEOUT_MS = 15_000;

async function request(
  method: 'GET' | 'POST' | 'DELETE',
  endpoint: string,
  query: Record<string, string>,
  body?: Uint8Array,
  timeoutMs = TIMEOUT_MS
): Promise<Response> {
  const qs = new URLSearchParams(query).toString();
  const response = await fetch(`${httpBase()}/api${endpoint}?${qs}`, {
    method,
    body,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/octet-stream' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    let detail = '';
    try {
      detail = ((await response.json()) as { error?: string }).error ?? '';
    } catch {
      // non-JSON error body; the status alone will have to do
    }
    const where = query.path ?? query.application_name ?? '';
    throw new StorageError(
      `${method} ${endpoint}${where ? ` ${where}` : ''}: HTTP ${response.status}${detail ? ` (${detail})` : ''}`,
      response.status
    );
  }
  return response;
}

export async function list(path: string): Promise<StorageEntry[]> {
  const response = await request('GET', '/storage/list', { path });
  return ((await response.json()) as { list: StorageEntry[] }).list;
}

export async function storageStatus(): Promise<StorageStatus> {
  const response = await request('GET', '/storage/status', {});
  return (await response.json()) as StorageStatus;
}

export async function read(path: string): Promise<Uint8Array> {
  const response = await request('GET', '/storage/read', { path }, undefined, TRANSFER_TIMEOUT_MS);
  return new Uint8Array(await response.arrayBuffer());
}

export async function write(path: string, data: Uint8Array): Promise<void> {
  await request('POST', '/storage/write', { path }, data, TRANSFER_TIMEOUT_MS);
}

export async function remove(path: string): Promise<void> {
  await request('DELETE', '/storage/remove', { path });
}

export async function mkdir(path: string): Promise<void> {
  await request('POST', '/storage/mkdir', { path });
}

export async function rename(path: string, newPath: string): Promise<void> {
  await request('POST', '/storage/rename', { path, new_path: newPath });
}

export async function assetsUpload(applicationName: string, file: string, data: Uint8Array): Promise<void> {
  await request(
    'POST',
    '/assets/upload',
    { application_name: applicationName, file },
    data,
    TRANSFER_TIMEOUT_MS
  );
}

/** Removes the app's entire asset directory — the directory itself, not just its contents. */
export async function assetsDelete(applicationName: string): Promise<void> {
  await request('DELETE', '/assets/upload', { application_name: applicationName });
}

// --- path helpers ------------------------------------------------------------

/**
 * The device's per-segment charset (`^[a-zA-Z0-9._-]+$` — notably no spaces).
 * `.` and `..` pass that pattern, so they are rejected separately: a `..`
 * that slipped through would let a path escape the `/ext/user_assets` guard
 * the rm command relies on.
 */
const SEGMENT = /^[a-zA-Z0-9._-]+$/;

/**
 * Resolves user input to a device path: `foo/bar` and `/ext/foo/bar` both
 * become `/ext/foo/bar`; empty input is the storage root.
 */
export function normalizePath(input: string): string {
  const segments = input.split('/').filter((s) => s.length > 0);
  if (segments[0] === 'ext') segments.shift();
  for (const segment of segments) {
    if (segment === '.' || segment === '..') {
      throw new StorageError(`'.' and '..' are not allowed in device paths: ${input}`);
    }
    if (!SEGMENT.test(segment)) {
      throw new StorageError(
        `invalid path segment '${segment}' — device paths allow only [a-zA-Z0-9._-] (no spaces)`
      );
    }
  }
  return segments.length === 0 ? EXT_ROOT : `${EXT_ROOT}/${segments.join('/')}`;
}

export function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** Parent directory of a normalized path, or null at the storage root. */
export function parentOf(path: string): string | null {
  if (path === EXT_ROOT) return null;
  const parent = path.slice(0, path.lastIndexOf('/'));
  return parent.length === 0 ? null : parent;
}

/** True when the path is outside `/ext/user_assets` — where rm demands --force. */
export function requiresForce(path: string): boolean {
  return !path.startsWith(`${USER_ASSETS}/`);
}

// --- composite operations ----------------------------------------------------

/**
 * Existence + type check. The device gives no direct stat: list on a file or
 * a missing path both 400, so this lists the parent and looks the name up.
 */
export async function stat(path: string): Promise<StorageEntry | null> {
  if (path === EXT_ROOT) return { type: 'dir', name: 'ext' };
  const parent = parentOf(path);
  if (parent === null) return null;
  let entries: StorageEntry[];
  try {
    entries = await list(parent);
  } catch (error) {
    // 400 = the parent itself is missing or a file; either way the path
    // doesn't exist. Anything else is a real failure.
    if (error instanceof StorageError && error.status === 400) return null;
    throw error;
  }
  const name = basename(path);
  return entries.find((entry) => entry.name === name) ?? null;
}

/**
 * mkdir -p. The device's mkdir 400s on an existing directory, which is
 * indistinguishable from other bad requests — but segments are charset-
 * validated before we get here, so a 400 on an ancestor means "exists" and
 * is safe to skip; a genuinely broken path still fails on the final write.
 */
export async function mkdirp(path: string): Promise<void> {
  const segments = path.split('/').filter((s) => s.length > 0).slice(1); // drop 'ext'
  let current = EXT_ROOT;
  for (const segment of segments) {
    current = `${current}/${segment}`;
    try {
      await mkdir(current);
    } catch (error) {
      if (error instanceof StorageError && error.status === 400) continue;
      throw error;
    }
  }
}

export interface WalkedEntry {
  path: string;
  entry: StorageEntry;
}

/** Depth-first recursive listing. Sequential on purpose — be kind to the device. */
export async function walk(dir: string): Promise<WalkedEntry[]> {
  const out: WalkedEntry[] = [];
  for (const entry of await list(dir)) {
    const path = `${dir}/${entry.name}`;
    out.push({ path, entry });
    if (entry.type === 'dir') out.push(...(await walk(path)));
  }
  return out;
}

// --- formatting --------------------------------------------------------------

export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = -1;
  do {
    value /= 1024;
    unit++;
  } while (value >= 1024 && unit < units.length - 1);
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}
