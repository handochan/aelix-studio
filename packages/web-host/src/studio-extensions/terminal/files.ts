import { constants } from 'node:fs';
import { lstat, open, opendir, readlink, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

/** Thrown inside a scan once its deadline passed: the scan stops where it is. */
export class ScanStopped extends Error {
  constructor() {
    super('the terminal CLI scan reached its time limit');
    this.name = 'ScanStopped';
  }
}

/**
 * One read-only scan of the terminal CLI: its deadline, its platform, and a cap on file system
 * calls running at once. Every file system call goes through `fs`, which checks the deadline
 * before it starts and again when it returns, so nothing new starts once time is up.
 */
export type Scan = {
  readonly platform: NodeJS.Platform;
  /** Throws `ScanStopped` once the deadline passed. */
  check(): void;
  /** Run one file system call under the cap, checking the deadline before and after it. */
  fs<T>(call: () => Promise<T>): Promise<T>;
  /** Resolves once no file system call of this scan is running or waiting. */
  settled(): Promise<void>;
};

/** File system calls one scan runs at once. */
export const FS_CONCURRENCY = 8;

export function createScan(deadline: number, platform: NodeJS.Platform, concurrency = FS_CONCURRENCY): Scan {
  let active = 0;
  const waiting: (() => void)[] = [];
  const idle: (() => void)[] = [];
  const check = (): void => {
    if (Date.now() >= deadline) throw new ScanStopped();
  };
  const release = (): void => {
    const next = waiting.shift();
    // The slot passes to the next waiter as it is; only an unclaimed slot is given back.
    if (next) return next();
    active -= 1;
    if (active === 0) for (const resolve of idle.splice(0)) resolve();
  };
  return {
    platform,
    check,
    async fs<T>(call: () => Promise<T>): Promise<T> {
      check();
      if (active >= concurrency) await new Promise<void>((resolve) => waiting.push(resolve));
      else active += 1;
      // A call let in by `release` holds the slot it was given.
      try {
        check();
        const result = await call();
        // A call that came back after the deadline starts nothing more.
        check();
        return result;
      } finally {
        release();
      }
    },
    settled(): Promise<void> {
      return active === 0 && waiting.length === 0 ? Promise.resolve() : new Promise((resolve) => idle.push(resolve));
    },
  };
}

/**
 * Map `items` with at most `limit` calls of `map` at once, keeping their order. Only that many
 * calls exist at a time: a long list is never scheduled all at once. Every worker finishes
 * before this ends, even after one failed; then the first failure is thrown.
 */
export async function mapLimited<T, R>(items: readonly T[], limit: number, map: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  let failure: { error: unknown } | undefined;
  const worker = async (): Promise<void> => {
    while (next < items.length && !failure) {
      const index = next;
      next += 1;
      try {
        // eslint-disable-next-line no-await-in-loop -- each worker takes one item at a time
        results[index] = await map(items[index]);
      } catch (error) {
        failure ??= { error };
      }
    }
  };
  await Promise.allSettled(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failure) throw failure.error;
  return results;
}

/**
 * A Windows UNC or device path (`\\server\share`, `\\?\…`, `\\.\…`, or with `/`): reading one
 * can reach the network or a device, so the scan never touches it. Only Windows reads these.
 */
export function isUncOrDevice(target: string, platform: NodeJS.Platform): boolean {
  return platform === 'win32' && /^[\\/]{2}/.test(target);
}

/** Whether `target` is `root` or inside it (both real paths). */
export function isWithin(target: string, root: string, platform: NodeJS.Platform): boolean {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const fold = (value: string): string => (platform === 'win32' ? value.toLowerCase() : value);
  const relative = paths.relative(fold(root), fold(target));
  return relative === '' || (!relative.startsWith('..') && !paths.isAbsolute(relative));
}

const errorCode = (error: unknown): string | undefined => (error as NodeJS.ErrnoException).code;

/** Links followed when resolving one path on Windows before giving up, as `ELOOP` does. */
const LINK_LIMIT = 40;

/**
 * Resolve `target` one component at a time, reading each link's target before following it, so
 * a local link or junction that points at a UNC or device path is refused before anything
 * reaches the network. Used where those paths exist (Windows).
 */
async function resolveWithoutUnc(scan: Scan, target: string): Promise<string> {
  const { root } = path.parse(target);
  const pending = path.relative(root, target).split(path.sep).filter(Boolean);
  let resolved = root;
  let links = 0;
  while (pending.length > 0) {
    const part = pending.shift() ?? '';
    if (part === '.') continue;
    if (part === '..') {
      resolved = path.dirname(resolved);
      continue;
    }
    const next = path.join(resolved, part);
    // eslint-disable-next-line no-await-in-loop -- one component after another
    const entry = await scan.fs(() => lstat(next));
    if (!entry.isSymbolicLink()) {
      resolved = next;
      continue;
    }
    links += 1;
    if (links > LINK_LIMIT) throw Object.assign(new Error('too many links'), { code: 'ELOOP' });
    // eslint-disable-next-line no-await-in-loop -- as above
    const destination = await scan.fs(() => readlink(next));
    if (isUncOrDevice(destination, scan.platform)) throw Object.assign(new Error('UNC link'), { code: 'EUNC' });
    const absolute = path.resolve(resolved, destination);
    const parsed = path.parse(absolute);
    resolved = parsed.root;
    pending.unshift(...path.relative(parsed.root, absolute).split(path.sep).filter(Boolean));
  }
  return resolved;
}

/** The real path through the scan: on Windows link by link (see `resolveWithoutUnc`). */
async function realPath(scan: Scan, target: string): Promise<string> {
  if (isUncOrDevice(target, scan.platform)) throw Object.assign(new Error('UNC path'), { code: 'EUNC' });
  const real =
    scan.platform === 'win32' ? await resolveWithoutUnc(scan, target) : await scan.fs(() => realpath(target));
  if (isUncOrDevice(real, scan.platform)) throw Object.assign(new Error('UNC path'), { code: 'EUNC' });
  return real;
}

/** A failed call is undefined, except the scan's own stop, which goes on up. */
function rethrowStop(error: unknown): undefined {
  if (error instanceof ScanStopped) throw error;
  return undefined;
}

/**
 * The real path, or undefined for a missing entry, a link loop (`ELOOP`), an unreadable one, or
 * one that is or leads to a Windows UNC or device path.
 */
export async function realpathOf(scan: Scan, target: string): Promise<string | undefined> {
  return realPath(scan, target).catch(rethrowStop);
}

type Stats = Awaited<ReturnType<typeof stat>>;

/**
 * The entry's stat, following links: the entry, `absent` when it does not exist, or
 * `unreadable` when it cannot be read. On Windows the path is resolved first, so a link to a UNC
 * path is never followed.
 */
export async function statEntry(scan: Scan, target: string): Promise<Stats | 'absent' | 'unreadable'> {
  try {
    const real = scan.platform === 'win32' ? await realPath(scan, target) : target;
    return await scan.fs(() => stat(real));
  } catch (error) {
    if (error instanceof ScanStopped) throw error;
    const code = errorCode(error);
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'absent' : 'unreadable';
  }
}

/** The entry's stat, following links; undefined when it does not exist or cannot be read. */
export async function statOf(scan: Scan, target: string): Promise<Stats | undefined> {
  const entry = await statEntry(scan, target);
  return typeof entry === 'string' ? undefined : entry;
}

/**
 * The entry's own stat, not following a link: `absent` or `unreadable` when it gives none. On
 * Windows its directory is resolved first, so a link to a UNC path on the way is not followed.
 */
export async function lstatEntry(scan: Scan, target: string): Promise<Stats | 'absent' | 'unreadable'> {
  if (isUncOrDevice(target, scan.platform)) return 'unreadable';
  try {
    const entry =
      scan.platform === 'win32' ? path.join(await realPath(scan, path.dirname(target)), path.basename(target)) : target;
    return await scan.fs(() => lstat(entry));
  } catch (error) {
    if (error instanceof ScanStopped) throw error;
    const code = errorCode(error);
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'absent' : 'unreadable';
  }
}

/** What a bounded read found. `truncated` is set for a head read of a longer file. */
export type BoundedRead =
  | { text: string; truncated: boolean }
  | 'absent'
  | 'not_a_file'
  | 'too_large'
  | 'outside'
  | 'unreadable';

/**
 * Read a regular file as UTF-8, at most `limit` bytes. Its real path must be inside `within`
 * when given (`outside` otherwise). It is checked with `stat` before it is opened, so a FIFO, a
 * device or a socket is never opened (`not_a_file`). It is opened without blocking and without
 * following a link, and `fstat` must show the same file `stat` did (`unreadable` otherwise).
 * With `head`, a longer file gives its first `limit` bytes; without, it is `too_large`. Nothing
 * about the file's content goes into the other results.
 */
export async function readBounded(
  scan: Scan,
  file: string,
  limit: number,
  options: { head?: boolean; within?: string } = {}
): Promise<BoundedRead> {
  let real: string;
  try {
    real = await realPath(scan, file);
  } catch (error) {
    if (error instanceof ScanStopped) throw error;
    return errorCode(error) === 'ENOENT' ? 'absent' : 'unreadable';
  }
  if (options.within !== undefined && !isWithin(real, options.within, scan.platform)) return 'outside';
  const before = await scan.fs(() => stat(real)).catch(rethrowStop);
  if (!before) return 'unreadable';
  if (!before.isFile()) return 'not_a_file';
  if (!options.head && before.size > limit) return 'too_large';
  return scan.fs(async (): Promise<BoundedRead> => {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(real, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0));
      scan.check();
      const opened = await handle.stat();
      // The file was swapped between stat and open: not read.
      if (opened.dev !== before.dev || opened.ino !== before.ino) return 'unreadable';
      if (!opened.isFile()) return 'not_a_file';
      const buffer = Buffer.alloc(Math.min(limit, opened.size));
      let filled = 0;
      while (filled < buffer.length) {
        scan.check();
        // eslint-disable-next-line no-await-in-loop -- one file, read in order up to the limit
        const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled);
        if (bytesRead === 0) break;
        filled += bytesRead;
      }
      return { text: buffer.subarray(0, filled).toString('utf8'), truncated: opened.size > limit };
    } catch (error) {
      if (error instanceof ScanStopped) throw error;
      return 'unreadable';
    } finally {
      await handle?.close().catch((): void => {});
    }
  });
}

/** A directory's names, sorted, at most `limit` of them; `truncated` when there were more. */
export type Listing = { names: string[]; truncated: boolean };

/**
 * The names in a directory, at most `limit` (which ones are kept then depends on the
 * directory's order); reading stops at the limit. The directory is resolved first, so on Windows
 * a link to a UNC path is not followed. `absent` when it does not exist or is not a directory,
 * `unreadable` when it cannot be read.
 */
export async function listDirectory(
  scan: Scan,
  directory: string,
  limit: number
): Promise<Listing | 'absent' | 'unreadable'> {
  let real: string;
  try {
    real = await realPath(scan, directory);
  } catch (error) {
    if (error instanceof ScanStopped) throw error;
    const code = errorCode(error);
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'absent' : 'unreadable';
  }
  return scan.fs(async (): Promise<Listing | 'absent' | 'unreadable'> => {
    let handle: Awaited<ReturnType<typeof opendir>> | undefined;
    try {
      handle = await opendir(real);
      // A directory opened after the deadline is not read.
      scan.check();
      const names: string[] = [];
      let truncated = false;
      for await (const entry of handle) {
        scan.check();
        if (names.length === limit) {
          truncated = true;
          break;
        }
        names.push(entry.name);
      }
      return { names: names.toSorted(), truncated };
    } catch (error) {
      if (error instanceof ScanStopped) throw error;
      const code = errorCode(error);
      return code === 'ENOENT' || code === 'ENOTDIR' ? 'absent' : 'unreadable';
    } finally {
      await handle?.close().catch((): void => {});
    }
  });
}
