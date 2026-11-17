/** Text formats inside a wheel and an installed distribution. Parsing only; nothing is executed. */

/** Entry point group the native loader reads. */
export const EXTENSION_GROUP = 'aelix.extensions';

/** PEP 503 name normalization: case-insensitive, runs of `-`, `_`, `.` are one separator. */
export function canonicalName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[-_.]+/g, '-');
}

const HEADER_LINE = /^([\x21-\x39\x3b-\x7e]*):(.*)$/;

/**
 * Read the header block of a `METADATA` file the way Python's email parser does, because
 * that is what the installer reads. The block ends at the first blank line or the first
 * line that is not a header. A line starting with a space or a tab continues the previous
 * header. A line with an empty name, a misplaced `From ` line and a leading continuation
 * are skipped, as Python skips them, so this never sees fewer headers than the installer.
 *
 * Returns header values by lower-case name, in file order.
 */
export function parseHeaders(text: string): Map<string, string[]> {
  const headers = new Map<string, string[]>();
  let current: { name: string; value: string } | undefined;
  const flush = (): void => {
    if (!current) return;
    const values = headers.get(current.name) ?? [];
    values.push(current.value.trim());
    headers.set(current.name, values);
    current = undefined;
  };
  for (const line of text.split(/\r\n|\r|\n/)) {
    if (line[0] === ' ' || line[0] === '\t') {
      if (current) current.value += '\n' + line;
      continue;
    }
    if (line.startsWith('From ')) {
      flush();
      continue;
    }
    const match = HEADER_LINE.exec(line);
    if (!match) break;
    flush();
    if (match[1] !== '') current = { name: match[1].toLowerCase(), value: match[2] };
  }
  flush();
  return headers;
}

export type DistributionIdentity = { name: string; version: string; requires: string[] };

/** Name, version and declared requirements of a distribution; undefined when a field is missing. */
export function readIdentity(metadata: string): DistributionIdentity | undefined {
  const headers = parseHeaders(metadata);
  const name = headers.get('name')?.[0];
  const version = headers.get('version')?.[0];
  if (!name || !version) return undefined;
  return { name: canonicalName(name), version, requires: headers.get('requires-dist') ?? [] };
}

const REFERENCE = /^[\p{L}\p{N}_.]+(?::[\p{L}\p{N}_.]+)?$/u;

/**
 * The `aelix.extensions` entries of an `entry_points.txt`: entry name to object reference.
 *
 * A reference is `module` or `module:attribute`; a trailing `[extras]` is dropped. A value
 * that is not a reference is returned as written so the caller can refuse it.
 */
export function parseExtensionEntries(text: string): Map<string, string> {
  const entries = new Map<string, string>();
  let inGroup = false;
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const line = raw.trim();
    if (line === '' || line[0] === '#' || line[0] === ';') continue;
    if (line[0] === '[' && line.endsWith(']')) {
      inGroup = line.slice(1, -1).trim() === EXTENSION_GROUP;
      continue;
    }
    if (!inGroup) continue;
    const split = line.indexOf('=');
    if (split <= 0) continue;
    const name = line.slice(0, split).trim();
    const value = line
      .slice(split + 1)
      .replace(/\[[^\]]*\]\s*$/, '')
      .replace(/\s+/g, '');
    if (name) entries.set(name, value);
  }
  return entries;
}

/** Whether a reference can be passed to native as `-e <reference>`. */
export function isObjectReference(value: string): boolean {
  return REFERENCE.test(value);
}

const ENTRY_NAME = /^[\p{L}\p{N}_][\p{L}\p{N}_.-]*$/u;

/**
 * Whether an entry point name can be passed to native as an argument (`extension remove
 * <name>`, `extension verify <name>`). A name that starts with `-` would be read as an option.
 */
export function isEntryName(value: string): boolean {
  return ENTRY_NAME.test(value);
}

/**
 * The file paths of a `RECORD`, as written (relative to the directory holding the
 * `.dist-info`, `/`-separated). The hash and size columns are not used.
 */
export function parseRecordPaths(text: string): string[] {
  const paths: string[] = [];
  for (const line of text.split(/\r\n|\r|\n/)) {
    if (line === '') continue;
    let field: string;
    if (line[0] === '"') {
      // A quoted CSV field: "" stands for one quote, and the field ends at the first lone quote.
      let end = 1;
      while (end < line.length) {
        if (line[end] === '"') {
          if (line[end + 1] === '"') end += 1;
          else break;
        }
        end += 1;
      }
      field = line.slice(1, end).replace(/""/g, '"');
    } else {
      const comma = line.indexOf(',');
      field = comma < 0 ? line : line.slice(0, comma);
    }
    if (field) paths.push(field);
  }
  return paths;
}
