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

/** Declared paths whose existence is checked; more make the answer `truncated`. */
export const DECLARED_LIMIT = 64;

/** One line of a `pyproject.toml` as this reader sees it, in one pass over its characters. */
type Line = {
  /** The line without its comment, trimmed. */
  text: string;
  /** Where its first `=` outside strings is, or -1. */
  equals: number;
  /** `[` and `{` opened minus closed outside strings: above 0, the value goes on below. */
  depth: number;
  /** A basic string on it holds a `\` escape. */
  escape: boolean;
  /** A string is still open at its end (a one-line string that does not close). */
  open: boolean;
};

function scanLine(raw: string): Line {
  const line = raw.trim();
  let quote = '';
  let equals = -1;
  let depth = 0;
  let escape = false;
  let end = line.length;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote) {
      if (quote === '"' && char === '\\') {
        escape = true;
        index += 1;
      } else if (char === quote) quote = '';
    } else if (char === '"' || char === "'") quote = char;
    else if (char === '#') {
      end = index;
      break;
    } else if (char === '=' && equals < 0) equals = index;
    else if (char === '[' || char === '{') depth += 1;
    else if (char === ']' || char === '}') depth -= 1;
  }
  return { text: line.slice(0, end).trimEnd(), equals, depth, escape, open: quote !== '' };
}

const BARE_KEY = /[A-Za-z0-9_-]/;

/**
 * The names of a TOML key or table name (`a.b`, `"a".'b'`, with space around the dots), and
 * whether a part was quoted; undefined when it is not one.
 */
function keyPath(text: string): { names: string[]; quoted: boolean } | undefined {
  const names: string[] = [];
  let quoted = false;
  let index = 0;
  const space = (): void => {
    while (text[index] === ' ' || text[index] === '\t') index += 1;
  };
  for (;;) {
    space();
    const char = text[index];
    if (char === '"' || char === "'") {
      const close = text.indexOf(char, index + 1);
      if (close < 0) return undefined;
      names.push(text.slice(index + 1, close));
      quoted = true;
      index = close + 1;
    } else {
      const start = index;
      while (index < text.length && BARE_KEY.test(text[index])) index += 1;
      if (index === start) return undefined;
      names.push(text.slice(start, index));
    }
    space();
    if (index === text.length) return { names, quoted };
    if (text[index] !== '.') return undefined;
    index += 1;
  }
}

/**
 * The strings of a one-line array of basic strings without escapes (`["a", "b",]`);
 * undefined for any other value.
 */
function plainStrings(value: string): string[] | undefined {
  if (!value.startsWith('[') || !value.endsWith(']')) return undefined;
  const last = value.length - 1;
  const strings: string[] = [];
  let index = 1;
  const space = (): void => {
    while (value[index] === ' ' || value[index] === '\t') index += 1;
  };
  for (;;) {
    space();
    if (index === last) return strings;
    if (value[index] !== '"') return undefined;
    const close = value.indexOf('"', index + 1);
    if (close < 0 || close === last) return undefined;
    const text = value.slice(index + 1, close);
    if (text.includes('\\')) return undefined;
    strings.push(text);
    index = close + 1;
    space();
    if (index === last) return strings;
    if (value[index] !== ',') return undefined;
    index += 1;
  }
}

/**
 * Read `[tool.aelix] extensions = [...]` from a `pyproject.toml` by one strict rule, in one pass
 * over its lines. It is not a TOML parser (2026-11-24 orchestrator decision, ADR 9).
 *
 * The only form taken is a `[tool.aelix]` header (space around the name allowed) and, in that
 * table, one line `extensions = ["…", …]` of basic strings without escapes. Anything that could
 * say otherwise in a way this cannot tell is `unknown`:
 * - three quotes of either kind anywhere in the file (a multi-line string);
 * - `tool.aelix` named any other way: a quoted name, an array of tables, `extensions` as a
 *   table, a dotted key or an inline table under `[tool]` or at the top;
 * - in `[tool.aelix]`: a quoted or dotted key, an inline table, a value on more lines (a
 *   multi-line array), or an escape;
 * - a table or a key given twice (TOML refuses the file, and native reads nothing), an escape
 *   in a table name, a line that is neither a table, a key nor empty, a string left open, or a
 *   line over `LINE_LIMIT`.
 *
 * Values on more lines elsewhere are skipped to where their brackets close.
 */
export function readDeclaredExtensions(text: string): DeclaredExtensions {
  if (text.includes('"""') || text.includes("'''")) return 'unknown';
  let table: 'top' | 'tool' | 'aelix' | 'other' = 'top';
  const tables = new Set<string>();
  let keys = new Set<string>();
  let continuing = 0;
  let found: string[] | undefined;
  for (const raw of text.split('\n')) {
    if (raw.length > LINE_LIMIT) return 'unknown';
    const line = scanLine(raw);
    if (line.open) return 'unknown';
    if (continuing > 0) {
      continuing += line.depth;
      if (continuing < 0) return 'unknown';
      continue;
    }
    if (line.text === '') continue;
    if (line.text.startsWith('[')) {
      const array = line.text.startsWith('[[');
      if (line.escape || !line.text.endsWith(array ? ']]' : ']')) return 'unknown';
      const header = keyPath(line.text.slice(array ? 2 : 1, array ? -2 : -1));
      if (!header) return 'unknown';
      const [first, second, third] = header.names;
      const underAelix = first === 'tool' && second === 'aelix';
      if (first === 'tool' && (array || header.quoted) && (second === undefined || second === 'aelix'))
        return 'unknown';
      if (underAelix && third === 'extensions') return 'unknown';
      if (!array) {
        const name = header.names.join('\u0000');
        if (tables.has(name)) return 'unknown';
        tables.add(name);
      }
      keys = new Set();
      if (underAelix && header.names.length === 2) table = 'aelix';
      else table = first === 'tool' && second === undefined ? 'tool' : 'other';
      continue;
    }
    if (line.equals < 0 || line.depth < 0) return 'unknown';
    const key = keyPath(line.text.slice(0, line.equals));
    if (!key) return 'unknown';
    const name = key.names.join('\u0000');
    if (keys.has(name)) return 'unknown';
    keys.add(name);
    if (table === 'top' && key.names[0] === 'tool') return 'unknown';
    if (table === 'tool' && key.names[0] === 'aelix') return 'unknown';
    if (table === 'aelix') {
      const value = line.text.slice(line.equals + 1).trim();
      if (key.quoted || key.names.length > 1 || line.escape || line.depth !== 0 || value.startsWith('{'))
        return 'unknown';
      if (key.names[0] === 'extensions') {
        const strings = plainStrings(value);
        if (!strings) return 'unknown';
        found = strings;
      }
    }
    continuing = line.depth;
  }
  if (continuing > 0) return 'unknown';
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
      // More declared paths than are checked: the answer may have missed one.
      const truncated = candidates.length > DECLARED_LIMIT;
      for (const candidate of candidates.slice(0, DECLARED_LIMIT)) {
        // eslint-disable-next-line no-await-in-loop -- stops at the first that exists
        if (await statOf(scan, candidate)) return { kind: 'pyproject', truncated };
      }
      // One of the rest may exist.
      if (truncated) return { kind: 'unknown', truncated };
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
