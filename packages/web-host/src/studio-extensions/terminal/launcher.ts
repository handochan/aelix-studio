import { readBounded, type Scan } from './files.js';

/** The most of a launcher this reads: a script launcher names its interpreter in its first lines. */
export const HEAD_LIMIT = 4 * 1024;

const WHITESPACE = new Set([' ', '\t']);

/** The first whitespace-separated word of `text` from `start`, and where it ends. */
function word(text: string, start: number): { value: string; end: number } {
  let index = start;
  while (index < text.length && !WHITESPACE.has(text[index])) index += 1;
  return { value: text.slice(start, index), end: index };
}

/**
 * The interpreter of the `/bin/sh` form's second line, as pip (distlib) and uv write it:
 * `'''exec' <interpreter> [arguments] "$0" "$@"`, the interpreter quoted with `'` (uv) or `"`
 * (distlib, for a path with spaces) or not at all (distlib, for a long path). Read in one pass;
 * a quote inside the path or a backslash in it is not interpreted.
 */
function shellExecInterpreter(line: string): string | undefined {
  const prefix = "'''exec' ";
  const tail = ' "$0" "$@"';
  const trimmed = line.trimEnd();
  if (!trimmed.startsWith(prefix) || !trimmed.endsWith(tail)) return undefined;
  const body = trimmed.slice(prefix.length, trimmed.length - tail.length);
  const quote = body[0];
  if (quote === "'" || quote === '"') {
    const close = body.indexOf(quote, 1);
    if (close < 0) return undefined;
    const value = body.slice(1, close);
    if (value.includes('\\') || (close + 1 < body.length && !WHITESPACE.has(body[close + 1]))) return undefined;
    return value;
  }
  const { value } = word(body, 0);
  return value.includes('\\') || value.includes("'") || value.includes('"') ? undefined : value;
}

/**
 * The interpreter a script launcher runs, read from its first lines; nothing is executed.
 *
 * - `#!/path/to/python [arguments]`, as pip and uv write it.
 * - `#!/bin/sh` followed by `'''exec' <interpreter> [arguments] "$0" "$@"`, as pip and uv write
 *   it when the path has spaces or is too long for a `#!` line.
 *
 * Undefined for anything else: a relative interpreter (it would depend on the working
 * directory), `#!/usr/bin/env python3` (it depends on a PATH Studio does not have), a binary
 * launcher (a Windows `.exe`), no `#!` line, or a line cut off at `HEAD_LIMIT` (`truncated`:
 * the file goes on past what was read, and the line was not finished).
 */
export function readLauncherInterpreter(head: string, truncated = false): string | undefined {
  if (!head.startsWith('#!')) return undefined;
  const firstEnd = head.indexOf('\n');
  if (firstEnd < 0 && truncated) return undefined;
  const first = (firstEnd < 0 ? head : head.slice(0, firstEnd)).replace(/\r$/, '');
  let start = 2;
  while (start < first.length && WHITESPACE.has(first[start])) start += 1;
  const command = word(first, start).value;
  let interpreter: string | undefined;
  if (command === '/bin/sh') {
    if (firstEnd < 0) return undefined;
    const secondEnd = head.indexOf('\n', firstEnd + 1);
    if (secondEnd < 0 && truncated) return undefined;
    interpreter = shellExecInterpreter(
      head.slice(firstEnd + 1, secondEnd < 0 ? undefined : secondEnd).replace(/\r$/, '')
    );
  } else {
    interpreter = command;
  }
  if (!interpreter || !interpreter.startsWith('/') || interpreter === '/usr/bin/env' || interpreter.endsWith('/env'))
    return undefined;
  return interpreter;
}

/** The interpreter the launcher file names, from its first `HEAD_LIMIT` bytes only. */
export async function launcherInterpreter(scan: Scan, file: string): Promise<string | undefined> {
  const head = await readBounded(scan, file, HEAD_LIMIT, { head: true });
  return typeof head === 'object' ? readLauncherInterpreter(head.text, head.truncated) : undefined;
}
