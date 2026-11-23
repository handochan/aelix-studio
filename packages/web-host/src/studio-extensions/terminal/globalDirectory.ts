import path from 'node:path';
import type { TerminalGlobalExtension, TerminalGlobalExtensionKind } from '../types.js';
import { isUncOrDevice, listDirectory, mapLimited, readBounded, statOf, FS_CONCURRENCY, type Scan } from './files.js';

/** The most entries of the global directory this looks at. */
export const GLOBAL_ENTRY_LIMIT = 500;
/** The most of a `pyproject.toml` this reads, and of one of its lines. */
const PYPROJECT_LIMIT = 256 * 1024;
const LINE_LIMIT = 4096;

/** What `[tool.aelix] extensions` says, read without a TOML parser. */
export type DeclaredExtensions = { paths: string[] } | 'none' | 'unknown';

/** A TOML key or header part without its quotes and surrounding space; `quoted` when it had them. */
function keyPart(raw: string): { name: string; quoted: boolean } {
  const part = raw.trim();
  const quoted = part.length >= 2 && (part[0] === '"' || part[0] === "'") && part.at(-1) === part[0];
  return { name: quoted ? part.slice(1, -1) : part, quoted };
}

/** The text before a `#` comment, for a line whose only quotes are inside strings. */
function withoutComment(line: string): string {
  let quote = '';
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote) {
      if (char === '\\' && quote === '"') index += 1;
      else if (char === quote) quote = '';
    } else if (char === '"' || char === "'") quote = char;
    else if (char === '#') return line.slice(0, index);
  }
  return line;
}

/**
 * Reads the strings of a TOML array fed after its `[`, a piece at a time, in one pass: basic
 * (`"…"`, with `\\` and `\"`) and literal (`'…'`) strings; other values are skipped. A nested
 * array or another escape makes it `unknown`; `closed` once its `]` came.
 */
class ArrayReader {
  readonly strings: string[] = [];
  state: 'open' | 'closed' | 'unknown' = 'open';
  private quote = '';
  private value = '';
  private escaped = false;
  private comment = false;

  feed(text: string): void {
    for (const char of text) {
      if (this.state !== 'open') return;
      if (this.comment) {
        if (char === '\n') this.comment = false;
      } else if (this.quote) {
        if (this.escaped) {
          if (char !== '\\' && char !== '"') this.state = 'unknown';
          this.value += char;
          this.escaped = false;
        } else if (this.quote === '"' && char === '\\') this.escaped = true;
        else if (char === this.quote) {
          this.strings.push(this.value);
          this.quote = '';
          this.value = '';
        } else if (char === '\n') this.state = 'unknown';
        else this.value += char;
      } else if (char === ']') this.state = 'closed';
      else if (char === '[') this.state = 'unknown';
      else if (char === '"' || char === "'") this.quote = char;
      else if (char === '#') this.comment = true;
    }
  }
}

/** The parts of a table name or dotted key read: the first ones decide, the rest are not copied. */
const DEPTH_LIMIT = 16;
/** Declared paths whose existence is checked; more make the answer `unknown` and `truncated`. */
export const DECLARED_LIMIT = 64;

/**
 * The delimiter of a multi-line string (`"""` or `'''`) left open at the end of `line`, if
 * any: an odd count of it on the line opens one that later lines continue.
 */
function openMultiline(line: string): string | undefined {
  for (const delimiter of ['"""', "'''"]) {
    let count = 0;
    for (let index = line.indexOf(delimiter); index >= 0; index = line.indexOf(delimiter, index + 3)) count += 1;
    if (count % 2 === 1) return delimiter;
  }
  return undefined;
}

/**
 * Read `[tool.aelix] extensions = [...]` from a `pyproject.toml` in one pass over its lines, the
 * way native's directory tier takes it. Only that form is read. `unknown`, where native may
 * decide otherwise and Studio cannot tell without a TOML parser: a quoted or dotted key that
 * names the same table (`"tool".aelix`, `tool.aelix.extensions = …`, `aelix.extensions` under
 * `[tool]`), an inline table, an array of tables, the table or the key given twice (native
 * then reads nothing), a table deeper than `DEPTH_LIMIT` that names `aelix`, or a line over
 * `LINE_LIMIT`. Lines inside multi-line strings are skipped.
 */
export function readDeclaredExtensions(text: string): DeclaredExtensions {
  let table: string[] = [];
  let seenTable = false;
  let multiline: string | undefined;
  let reader: ArrayReader | undefined;
  let found: string[] | undefined;
  for (const raw of text.split('\n')) {
    if (raw.length > LINE_LIMIT) return 'unknown';
    if (multiline) {
      if (raw.includes(multiline)) multiline = undefined;
      continue;
    }
    if (reader) {
      reader.feed('\n' + raw);
      if (reader.state === 'unknown') return 'unknown';
      if (reader.state === 'closed') {
        found = reader.strings;
        reader = undefined;
      }
      continue;
    }
    const line = withoutComment(raw).trim();
    if (line === '') continue;
    if (line.startsWith('[')) {
      const array = line.startsWith('[[');
      const close = line.lastIndexOf(']');
      if (close < 0) return 'unknown';
      const parts = line
        .slice(array ? 2 : 1, array ? close - 1 : close)
        .split('.', DEPTH_LIMIT)
        .map(keyPart);
      const names = parts.map((part) => part.name);
      if (names[0] === 'tool' && names[1] === 'aelix' && (array || parts.some((part) => part.quoted))) return 'unknown';
      table = array ? ['[['] : names;
      if (table.length === 2 && table[0] === 'tool' && table[1] === 'aelix') {
        // TOML refuses a table defined twice; native then reads nothing.
        if (seenTable) return 'unknown';
        seenTable = true;
      }
      continue;
    }
    const multilineOpen = openMultiline(line);
    const equals = line.indexOf('=');
    if (equals < 0) {
      multiline = multilineOpen;
      continue;
    }
    const keys = line.slice(0, equals).split('.', DEPTH_LIMIT).map(keyPart);
    const value = line.slice(equals + 1).trim();
    // Names along the key's path, read in place: the table's, then the key's own.
    const name = (index: number): string | undefined =>
      index < table.length ? table[index] : keys[index - table.length]?.name;
    const depth = table.length + keys.length;
    const underAelix = name(0) === 'tool' && name(1) === 'aelix';
    const isTarget = depth === 3 && underAelix && name(2) === 'extensions';
    if (!isTarget) {
      // What could define `tool.aelix` itself or its `extensions` another way: `aelix = {…}`
      // under `[tool]`, `tool = { aelix = … }`, or `extensions` as a table.
      const definesTable = depth === 2 && underAelix;
      const inline = depth === 1 && name(0) === 'tool' && value.startsWith('{') && value.includes('aelix');
      const deeper = depth > 3 && underAelix && name(2) === 'extensions';
      if (definesTable || inline || deeper) return 'unknown';
      multiline = multilineOpen;
      continue;
    }
    if (keys.length !== 1 || keys[0].quoted || table.length !== 2 || !value.startsWith('[')) return 'unknown';
    // TOML refuses a key given twice; native then reads nothing.
    if (found) return 'unknown';
    const next = new ArrayReader();
    next.feed(value.slice(1));
    if (next.state === 'unknown') return 'unknown';
    if (next.state === 'closed') found = next.strings;
    else reader = next;
  }
  if (reader || multiline) return 'unknown';
  return found ? { paths: found } : 'none';
}

async function directoryKind(
  scan: Scan,
  directory: string
): Promise<{ kind?: TerminalGlobalExtensionKind; truncated: boolean }> {
  if ((await statOf(scan, path.join(directory, 'aelix-plugin.toml')))?.isFile())
    return { kind: 'manifest', truncated: false };
  const pyproject = await readBounded(scan, path.join(directory, 'pyproject.toml'), PYPROJECT_LIMIT);
  if (pyproject === 'too_large') return { kind: 'unknown', truncated: false };
  if (typeof pyproject === 'object') {
    const declared = readDeclaredExtensions(pyproject.text);
    if (declared === 'unknown') return { kind: 'unknown', truncated: false };
    if (declared !== 'none') {
      // Native takes the table only when a declared path exists, resolved from the directory.
      const paths = scan.platform === 'win32' ? path.win32 : path.posix;
      const candidates = declared.paths
        .filter((entry) => entry !== '')
        .map((entry) => paths.resolve(directory, entry))
        .filter((candidate) => !isUncOrDevice(candidate, scan.platform));
      for (const candidate of candidates.slice(0, DECLARED_LIMIT)) {
        // eslint-disable-next-line no-await-in-loop -- stops at the first that exists
        if (await statOf(scan, candidate)) return { kind: 'pyproject', truncated: false };
      }
      // More declared paths than are checked: one of the rest may exist.
      if (candidates.length > DECLARED_LIMIT) return { kind: 'unknown', truncated: true };
    }
  }
  if ((await statOf(scan, path.join(directory, '__init__.py')))?.isFile()) return { kind: 'package', truncated: false };
  return { truncated: false };
}

/**
 * The entries of the terminal CLI's global extension directory that native's directory tier
 * would take, one level deep, by name; nothing is imported. Manifests are not parsed: a broken
 * one is listed here and fails in native. `absent` when the directory does not exist,
 * `unreadable` when it cannot be read.
 */
export async function readGlobalExtensions(
  scan: Scan,
  directory: string
): Promise<{ extensions: TerminalGlobalExtension[]; truncated: boolean } | 'absent' | 'unreadable'> {
  const listing = await listDirectory(scan, directory, GLOBAL_ENTRY_LIMIT);
  if (typeof listing === 'string') return listing;
  let truncated = listing.truncated;
  const found = await mapLimited(
    listing.names,
    FS_CONCURRENCY,
    async (name): Promise<TerminalGlobalExtension | undefined> => {
      const entry = path.join(directory, name);
      const info = await statOf(scan, entry);
      // Python's `Path.suffix`: `.py` alone is a hidden file without a suffix.
      if (info?.isFile()) return name.endsWith('.py') && name !== '.py' ? { name, kind: 'file' } : undefined;
      if (!info?.isDirectory()) return undefined;
      const { kind, truncated: cut } = await directoryKind(scan, entry);
      if (cut) truncated = true;
      return kind ? { name, kind } : undefined;
    }
  );
  return { extensions: found.filter((entry): entry is TerminalGlobalExtension => entry !== undefined), truncated };
}
