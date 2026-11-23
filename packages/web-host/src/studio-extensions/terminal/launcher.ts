import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

/** The most of a launcher this reads: a script launcher names its interpreter in its first lines. */
const HEAD_LIMIT = 4096;

/** The second line of a `/bin/sh` launcher that re-runs itself with the interpreter (pip, uv). */
const SH_EXEC = /^'''exec' (['"])(.+?)\1 "\$0" "\$@"\s*$/;

/**
 * The interpreter a script launcher runs, read from its first lines; nothing is executed.
 *
 * - `#!/path/to/python` (with or without arguments), as pip and uv write it.
 * - `#!/bin/sh` followed by `'''exec' '/path/to/python' "$0" "$@"`, as pip and uv write it
 *   when the interpreter path has spaces or is too long for a `#!` line.
 *
 * Undefined for anything else: `#!/usr/bin/env python3` (it depends on a PATH Studio does not
 * have), a binary launcher (a Windows `.exe`), or no `#!` line at all.
 */
export function readLauncherInterpreter(head: string): string | undefined {
  if (!head.startsWith('#!')) return undefined;
  const [first, second = ''] = head.split(/\r?\n/, 2);
  const command = first.slice(2).trim();
  if (command === '/bin/sh') return SH_EXEC.exec(second)?.[2];
  const interpreter = command.split(/\s+/, 1)[0];
  if (!interpreter || !interpreter.startsWith('/') || /(?:^|\/)env$/.test(interpreter)) return undefined;
  return interpreter;
}

/**
 * The first bytes of a regular file as text, or undefined when it is not one or cannot be
 * read. Opened without blocking, so a FIFO in its place never makes the listing wait.
 */
export async function readHead(file: string): Promise<string | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    if (!(await handle.stat()).isFile()) return undefined;
    const buffer = Buffer.alloc(HEAD_LIMIT);
    const { bytesRead } = await handle.read(buffer, 0, HEAD_LIMIT, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch((): void => {});
  }
}
