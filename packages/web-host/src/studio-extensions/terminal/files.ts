import { constants } from 'node:fs';
import { lstat, open, opendir, realpath, stat } from 'node:fs/promises';

/** What a bounded read found. */
export type BoundedRead = { text: string } | 'absent' | 'not_a_file' | 'too_large' | 'unreadable';

/**
 * Read a regular file as UTF-8, at most `limit` bytes. Opened without blocking and checked with
 * fstat before reading, so a FIFO or a device in its place is never waited on or read
 * (`not_a_file`). With `head`, a longer file gives its first `limit` bytes; without, it is
 * `too_large`. Nothing about the file's content goes into the result's other values.
 */
export async function readBounded(file: string, limit: number, head = false): Promise<BoundedRead> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    const stats = await handle.stat();
    if (!stats.isFile()) return 'not_a_file';
    if (!head && stats.size > limit) return 'too_large';
    const buffer = Buffer.alloc(Math.min(limit, stats.size));
    let filled = 0;
    while (filled < buffer.length) {
      // eslint-disable-next-line no-await-in-loop -- one file, read in order up to the limit
      const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    return { text: buffer.subarray(0, filled).toString('utf8') };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'unreadable';
  } finally {
    await handle?.close().catch((): void => {});
  }
}

/** The entry's stat, following links; undefined when it does not exist or cannot be read. */
export const statOf = (target: string) => stat(target).catch((): undefined => undefined);

/** The entry's own stat, not following a link; undefined when it does not exist. */
export const lstatOf = (target: string) => lstat(target).catch((): undefined => undefined);

/** The real path, or undefined for a missing entry, a link loop (`ELOOP`) or an unreadable one. */
export const realpathOf = (target: string) => realpath(target).catch((): undefined => undefined);

/**
 * The names in a directory, sorted, at most `limit` of them; `truncated` when there were more
 * (which ones are kept then depends on the directory's order). Reading stops at the limit.
 * Undefined when it is not a readable directory.
 */
export async function listDirectory(
  directory: string,
  limit: number
): Promise<{ names: string[]; truncated: boolean } | undefined> {
  let handle: Awaited<ReturnType<typeof opendir>> | undefined;
  try {
    handle = await opendir(directory);
    const names: string[] = [];
    let truncated = false;
    for await (const entry of handle) {
      if (names.length === limit) {
        truncated = true;
        break;
      }
      names.push(entry.name);
    }
    return { names: names.toSorted(), truncated };
  } catch {
    return undefined;
  } finally {
    // A `for await` that ran to the end closed it already; closing again only rejects.
    await handle?.close().catch((): void => {});
  }
}
