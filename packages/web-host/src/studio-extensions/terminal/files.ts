import { constants } from 'node:fs';
import { lstat, open, opendir, realpath, stat } from 'node:fs/promises';
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
 * first, so a scan that ran out of time stops instead of reading on.
 */
export type Scan = {
  readonly platform: NodeJS.Platform;
  /** Throws `ScanStopped` once the deadline passed. */
  check(): void;
  /** Run one file system call under the cap, after checking the deadline. */
  fs<T>(call: () => Promise<T>): Promise<T>;
};

/** File system calls one scan runs at once. */
export const FS_CONCURRENCY = 8;

export function createScan(deadline: number, platform: NodeJS.Platform, concurrency = FS_CONCURRENCY): Scan {
  let active = 0;
  const waiting: (() => void)[] = [];
  const check = (): void => {
    if (Date.now() >= deadline) throw new ScanStopped();
  };
  return {
    platform,
    check,
    async fs<T>(call: () => Promise<T>): Promise<T> {
      check();
      if (active >= concurrency) await new Promise<void>((resolve) => waiting.push(resolve));
      active += 1;
      try {
        check();
        return await call();
      } finally {
        active -= 1;
        waiting.shift()?.();
      }
    },
  };
}

/**
 * Map `items` with at most `limit` calls of `map` at once, keeping their order. Only that many
 * calls exist at a time: a long list is never scheduled all at once.
 */
export async function mapLimited<T, R>(items: readonly T[], limit: number, map: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      // eslint-disable-next-line no-await-in-loop -- each worker takes one item at a time
      results[index] = await map(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
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

/** A failed call is undefined, except the scan's own stop, which goes on up. */
function rethrowStop(error: unknown): undefined {
  if (error instanceof ScanStopped) throw error;
  return undefined;
}

/** The entry's stat, following links; undefined when it does not exist or cannot be read. */
export async function statOf(scan: Scan, target: string): Promise<Awaited<ReturnType<typeof stat>> | undefined> {
  if (isUncOrDevice(target, scan.platform)) return undefined;
  return scan.fs(() => stat(target)).catch(rethrowStop);
}

/** The entry's own stat, not following a link; undefined when it does not exist. */
export async function lstatOf(scan: Scan, target: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  if (isUncOrDevice(target, scan.platform)) return undefined;
  return scan.fs(() => lstat(target)).catch(rethrowStop);
}

/**
 * The real path, or undefined for a missing entry, a link loop (`ELOOP`), an unreadable one,
 * or one that resolves to a Windows UNC or device path.
 */
export async function realpathOf(scan: Scan, target: string): Promise<string | undefined> {
  if (isUncOrDevice(target, scan.platform)) return undefined;
  const real = await scan.fs(() => realpath(target)).catch(rethrowStop);
  return real === undefined || isUncOrDevice(real, scan.platform) ? undefined : real;
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
  if (isUncOrDevice(file, scan.platform)) return 'unreadable';
  let real: string;
  try {
    real = await scan.fs(() => realpath(file));
  } catch (error) {
    if (error instanceof ScanStopped) throw error;
    return errorCode(error) === 'ENOENT' ? 'absent' : 'unreadable';
  }
  if (isUncOrDevice(real, scan.platform)) return 'unreadable';
  if (options.within !== undefined && !isWithin(real, options.within, scan.platform)) return 'outside';
  const before = await statOf(scan, real);
  if (!before) return 'unreadable';
  if (!before.isFile()) return 'not_a_file';
  if (!options.head && before.size > limit) return 'too_large';
  return scan.fs(async (): Promise<BoundedRead> => {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(real, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0));
      const opened = await handle.stat();
      // The file was swapped between stat and open: not read.
      if (opened.dev !== before.dev || opened.ino !== before.ino) return 'unreadable';
      if (!opened.isFile()) return 'not_a_file';
      const buffer = Buffer.alloc(Math.min(limit, opened.size));
      let filled = 0;
      while (filled < buffer.length) {
        // eslint-disable-next-line no-await-in-loop -- one file, read in order up to the limit
        const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled);
        if (bytesRead === 0) break;
        filled += bytesRead;
      }
      return { text: buffer.subarray(0, filled).toString('utf8'), truncated: opened.size > limit };
    } catch {
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
 * directory's order); reading stops at the limit. `absent` when it does not exist or is not a
 * directory, `unreadable` when it cannot be read.
 */
export async function listDirectory(
  scan: Scan,
  directory: string,
  limit: number
): Promise<Listing | 'absent' | 'unreadable'> {
  if (isUncOrDevice(directory, scan.platform)) return 'unreadable';
  return scan.fs(async (): Promise<Listing | 'absent' | 'unreadable'> => {
    let handle: Awaited<ReturnType<typeof opendir>> | undefined;
    try {
      handle = await opendir(directory);
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
