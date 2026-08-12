/**
 * The `mbar api` subcommands — the management face of the device's HTTP
 * API, today the /ext storage partition and per-app assets (src/store.ts
 * is the client). Kept out of mbar.ts so the entry point stays a thin argv
 * switch and the handlers stay testable (they return exit codes rather
 * than calling process.exit). The group is named `api`, not `storage`,
 * deliberately: room for more device endpoints under it later.
 *
 * Paths may omit the /ext prefix: `mbar api ls user_assets` and
 * `mbar api ls /ext/user_assets` are the same. Safety: the device's remove
 * endpoint recursively deletes non-empty directories and reports success
 * for nonexistent paths (see DEVICE.md), so `rm` stats first, demands -r
 * for directories, and demands --force outside /ext/user_assets.
 */
import {
  EXT_ROOT,
  USER_ASSETS,
  StorageError,
  assetsDelete,
  assetsUpload,
  basename,
  humanSize,
  list,
  mkdirp,
  normalizePath,
  parentOf,
  read,
  remove,
  rename,
  requiresForce,
  stat,
  storageStatus,
  walk,
  write,
  type StorageEntry,
} from './store';

export const API_COMMANDS = ['ls', 'df', 'cat', 'get', 'put', 'mv', 'mkdir', 'rm', 'apps', 'push', 'wipe'] as const;
export type ApiCommand = (typeof API_COMMANDS)[number];

export function isApiCommand(command: string): command is ApiCommand {
  return (API_COMMANDS as readonly string[]).includes(command);
}

export function apiUsage(): string {
  return `mbar api — the BUSY Bar's /ext storage partition and per-app assets

  mbar api ls [path] [-R] [--json]     list a directory (default /ext); -R recurses
  mbar api df [--json]                 storage usage
  mbar api cat <path>                  file contents to stdout (raw bytes)
  mbar api get <path> [local]          download a file (default: its basename)
  mbar api put <local|-> <path>        upload a file ('-' reads stdin)
  mbar api mv <old> <new> [--force]    rename/move; --force to overwrite the target
  mbar api mkdir <path>                create a directory (parents included)
  mbar api rm <path> [-r] [--force]    delete; -r for directories (recursive!),
                                         --force outside /ext/user_assets
  mbar api apps [--json]               per-app asset usage under /ext/user_assets
  mbar api push <app> <files...>       upload files as an app's assets
  mbar api wipe <app>                  delete an app's entire asset directory

Paths may omit the /ext prefix ('mbar api ls user_assets'). Routes,
credentials, and --route work as for every mbar command — see 'mbar help'.`;
}

interface Flags {
  recursive: boolean;
  force: boolean;
  json: boolean;
}

function parseArgs(argv: string[]): { positional: string[]; flags: Flags } {
  const positional: string[] = [];
  const flags: Flags = { recursive: false, force: false, json: false };
  for (const arg of argv) {
    if (arg === '-R' || arg === '-r') flags.recursive = true;
    else if (arg === '--force') flags.force = true;
    else if (arg === '--json') flags.json = true;
    else if (arg.startsWith('-') && arg !== '-') throw new StorageError(`unknown flag: ${arg}`);
    else positional.push(arg);
  }
  return { positional, flags };
}

function entryLine(entry: StorageEntry, name: string): string {
  const size = entry.type === 'dir' ? '-' : humanSize(entry.size ?? 0);
  return `${size.padStart(9)}  ${name}${entry.type === 'dir' ? '/' : ''}`;
}

/** For commands that treat a 400 from the device as "no such file". */
function notFound(error: unknown, path: string): never {
  if (error instanceof StorageError && error.status === 400) {
    throw new StorageError(`no such file: ${path}`);
  }
  throw error;
}

async function cmdLs(pathArg: string | undefined, flags: Flags): Promise<void> {
  const path = normalizePath(pathArg ?? '');
  let entries: StorageEntry[];
  try {
    entries = await list(path);
  } catch (error) {
    if (error instanceof StorageError && error.status === 400) {
      // list 400s on files and missing paths alike; the parent knows which.
      const st = await stat(path);
      if (st?.type === 'file') {
        if (flags.json) console.log(JSON.stringify([st]));
        else console.log(entryLine(st, st.name));
        return;
      }
      throw new StorageError(`no such path: ${path}`);
    }
    throw error;
  }
  if (flags.recursive) {
    const walked = (await walk(path)).sort((a, b) => a.path.localeCompare(b.path));
    if (flags.json) console.log(JSON.stringify(walked, null, 2));
    else for (const { path: p, entry } of walked) console.log(entryLine(entry, p));
    return;
  }
  if (flags.json) {
    console.log(JSON.stringify(entries, null, 2));
    return;
  }
  const sorted = [...entries].sort(
    (a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1)
  );
  for (const entry of sorted) console.log(entryLine(entry, entry.name));
}

async function cmdDf(flags: Flags): Promise<void> {
  const status = await storageStatus();
  if (flags.json) {
    console.log(JSON.stringify(status, null, 2));
    return;
  }
  const percent = ((status.used_bytes / status.total_bytes) * 100).toFixed(1);
  console.log(`used   ${humanSize(status.used_bytes).padStart(9)}  (${percent}%)`);
  console.log(`free   ${humanSize(status.free_bytes).padStart(9)}`);
  console.log(`total  ${humanSize(status.total_bytes).padStart(9)}`);
}

async function cmdCat(pathArg: string): Promise<void> {
  const path = normalizePath(pathArg);
  const data = await read(path).catch((e) => notFound(e, path));
  await Bun.write(Bun.stdout, data);
}

async function cmdGet(pathArg: string, localArg: string | undefined): Promise<void> {
  const path = normalizePath(pathArg);
  const local = localArg ?? basename(path);
  const data = await read(path).catch((e) => notFound(e, path));
  await Bun.write(local, data);
  console.log(`${path} -> ${local} (${humanSize(data.length)})`);
}

async function readLocal(local: string): Promise<Uint8Array> {
  if (local === '-') return new Uint8Array(await new Response(Bun.stdin.stream()).arrayBuffer());
  const file = Bun.file(local);
  if (!(await file.exists())) throw new StorageError(`no such local file: ${local}`);
  return new Uint8Array(await file.arrayBuffer());
}

async function cmdPut(localArg: string, pathArg: string): Promise<void> {
  const data = await readLocal(localArg);
  let path = normalizePath(pathArg);
  if ((await stat(path))?.type === 'dir') {
    if (localArg === '-') {
      throw new StorageError(`${path} is a directory — give a full target path when reading stdin`);
    }
    path = `${path}/${basename(localArg)}`;
  }
  const { free_bytes } = await storageStatus();
  if (data.length > free_bytes) {
    throw new StorageError(
      `${humanSize(data.length)} won't fit — only ${humanSize(free_bytes)} free on the device`
    );
  }
  const parent = parentOf(path);
  // write auto-creates only one missing level; deeper targets 508 without this.
  if (parent !== null && parent !== EXT_ROOT) await mkdirp(parent);
  await write(path, data);
  console.log(`${localArg === '-' ? 'stdin' : localArg} -> ${path} (${humanSize(data.length)})`);
}

async function cmdMv(oldArg: string, newArg: string, flags: Flags): Promise<void> {
  const from = normalizePath(oldArg);
  if ((await stat(from)) === null) throw new StorageError(`no such path: ${from}`);
  let to = normalizePath(newArg);
  const target = await stat(to);
  if (target?.type === 'dir') to = `${to}/${basename(from)}`;
  if (from === to) throw new StorageError(`${from} and ${to} are the same path`);
  const existing = target?.type === 'dir' ? await stat(to) : target;
  if (existing !== null && !flags.force) {
    // The device overwrites silently; make destruction opt-in.
    throw new StorageError(`${to} exists — pass --force to overwrite`);
  }
  const parent = parentOf(to);
  if (parent !== null && (await stat(parent))?.type !== 'dir') {
    // rename does not create target directories.
    throw new StorageError(`target directory does not exist: ${parent}`);
  }
  await rename(from, to);
  console.log(`${from} -> ${to}`);
}

async function cmdMkdir(pathArg: string): Promise<void> {
  const path = normalizePath(pathArg);
  const existing = await stat(path);
  if (existing?.type === 'dir') {
    console.log(`already exists: ${path}`);
    return;
  }
  if (existing?.type === 'file') throw new StorageError(`a file is in the way: ${path}`);
  await mkdirp(path);
  console.log(`created ${path}`);
}

async function cmdRm(pathArg: string, flags: Flags): Promise<void> {
  const path = normalizePath(pathArg);
  if (path === EXT_ROOT) throw new StorageError('refusing to remove the storage root');
  // The device 200s on nonexistent paths and recursively removes non-empty
  // directories, so all the safety has to happen client-side.
  const st = await stat(path);
  if (st === null) throw new StorageError(`no such path: ${path}`);
  if (st.type === 'dir' && !flags.recursive) {
    throw new StorageError(`${path} is a directory — pass -r to remove it and everything in it`);
  }
  if (requiresForce(path) && !flags.force) {
    throw new StorageError(
      `${path} is outside ${USER_ASSETS} — pass --force to touch stock/system files`
    );
  }
  await remove(path);
  console.log(`removed ${path}${st.type === 'dir' ? ' (recursively)' : ''}`);
}

async function cmdApps(flags: Flags): Promise<void> {
  const entries = await list(USER_ASSETS);
  const rows: { name: string; files: number; bytes: number }[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.type === 'file') {
      rows.push({ name: entry.name, files: 1, bytes: entry.size ?? 0 });
      continue;
    }
    const walked = await walk(`${USER_ASSETS}/${entry.name}`);
    const files = walked.filter((w) => w.entry.type === 'file');
    rows.push({
      name: `${entry.name}/`,
      files: files.length,
      bytes: files.reduce((sum, w) => sum + (w.entry.size ?? 0), 0),
    });
  }
  if (flags.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  for (const row of rows) {
    console.log(`${humanSize(row.bytes).padStart(9)}  ${String(row.files).padStart(4)} file${row.files === 1 ? ' ' : 's'}  ${row.name}`);
  }
}

const APP_NAME = /^[a-zA-Z0-9._-]+$/;

async function cmdPush(app: string, files: string[]): Promise<void> {
  if (!APP_NAME.test(app)) throw new StorageError(`invalid application name: ${app}`);
  for (const local of files) {
    const name = basename(local.replaceAll('\\', '/'));
    if (!APP_NAME.test(name)) {
      throw new StorageError(`invalid asset filename '${name}' — only [a-zA-Z0-9._-] allowed`);
    }
    const data = await readLocal(local);
    await assetsUpload(app, name, data);
    console.log(`${local} -> ${USER_ASSETS}/${app}/${name} (${humanSize(data.length)})`);
  }
}

async function cmdWipe(app: string): Promise<void> {
  if (!APP_NAME.test(app)) throw new StorageError(`invalid application name: ${app}`);
  const dir = `${USER_ASSETS}/${app}`;
  let walked;
  try {
    walked = await walk(dir);
  } catch (error) {
    if (error instanceof StorageError && error.status === 400) {
      throw new StorageError(`no assets for app '${app}' (${dir} does not exist)`);
    }
    throw error;
  }
  const files = walked.filter((w) => w.entry.type === 'file');
  const bytes = files.reduce((sum, w) => sum + (w.entry.size ?? 0), 0);
  await assetsDelete(app);
  console.log(`wiped ${dir}: ${files.length} file${files.length === 1 ? '' : 's'}, ${humanSize(bytes)} freed`);
}

function expect(positional: string[], min: number, max: number, usage: string): void {
  if (positional.length < min || positional.length > max) {
    throw new StorageError(`usage: mbar api ${usage}`);
  }
}

export async function runApiCommand(command: ApiCommand, args: string[]): Promise<number> {
  try {
    // Inside the try so an unknown-flag throw reports like any other error.
    const { positional, flags } = parseArgs(args);
    switch (command) {
      case 'ls':
        expect(positional, 0, 1, 'ls [path] [-R] [--json]');
        await cmdLs(positional[0], flags);
        return 0;
      case 'df':
        expect(positional, 0, 0, 'df [--json]');
        await cmdDf(flags);
        return 0;
      case 'cat':
        expect(positional, 1, 1, 'cat <path>');
        await cmdCat(positional[0]!);
        return 0;
      case 'get':
        expect(positional, 1, 2, 'get <path> [local]');
        await cmdGet(positional[0]!, positional[1]);
        return 0;
      case 'put':
        expect(positional, 2, 2, 'put <local|-> <path>');
        await cmdPut(positional[0]!, positional[1]!);
        return 0;
      case 'mv':
        expect(positional, 2, 2, 'mv <old> <new> [--force]');
        await cmdMv(positional[0]!, positional[1]!, flags);
        return 0;
      case 'mkdir':
        expect(positional, 1, 1, 'mkdir <path>');
        await cmdMkdir(positional[0]!);
        return 0;
      case 'rm':
        expect(positional, 1, 1, 'rm <path> [-r] [--force]');
        await cmdRm(positional[0]!, flags);
        return 0;
      case 'apps':
        expect(positional, 0, 0, 'apps [--json]');
        await cmdApps(flags);
        return 0;
      case 'push':
        expect(positional, 2, Infinity, 'push <app> <files...>');
        await cmdPush(positional[0]!, positional.slice(1));
        return 0;
      case 'wipe':
        expect(positional, 1, 1, 'wipe <app>');
        await cmdWipe(positional[0]!);
        return 0;
    }
  } catch (error) {
    console.error((error as Error).message);
    return 1;
  }
}
