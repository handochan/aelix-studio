import { readBounded } from './files.js';

/** The most of a launcher this reads: a script launcher names its interpreter in its first lines. */
export const HEAD_LIMIT = 4 * 1024;

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

/** The interpreter the launcher file names, from its first `HEAD_LIMIT` bytes only. */
export async function launcherInterpreter(file: string): Promise<string | undefined> {
  const head = await readBounded(file, HEAD_LIMIT, true);
  return typeof head === 'object' ? readLauncherInterpreter(head.text) : undefined;
}
