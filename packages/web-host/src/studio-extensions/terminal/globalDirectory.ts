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

/**
 * Read `[tool.aelix] extensions = [...]` from a `pyproject.toml` in one pass over its lines, the
 * way native's directory tier takes it. Only that form is read: a quoted or dotted key that
 * names the same table (`"tool".aelix`, `tool.aelix.extensions = …`, `aelix.extensions` under
 * `[tool]`), an inline table, or a line over `LINE_LIMIT` is `unknown`: native may take it, and
 * Studio cannot tell without a TOML parser.
 */
export function readDeclaredExtensions(text: string): DeclaredExtensions {
  let table: string[] = [];
  let reader: ArrayReader | undefined;
  let found: string[] | undefined;
  for (const raw of text.split('\n')) {
    if (raw.length > LINE_LIMIT) return 'unknown';
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
      if (line.startsWith('[[')) {
        table = ['[['];
        continue;
      }
      const close = line.lastIndexOf(']');
      if (close < 0) return 'unknown';
      const parts = line.slice(1, close).split('.').map(keyPart);
      table = parts.map((part) => part.name);
      if (parts.some((part) => part.quoted) && table.includes('aelix')) return 'unknown';
      continue;
    }
    const equals = line.indexOf('=');
    if (equals < 0) continue;
    const keys = line.slice(0, equals).split('.').map(keyPart);
    const value = line.slice(equals + 1).trim();
    const full = [...table, ...keys.map((key) => key.name)];
    const isTarget = full.length === 3 && full[0] === 'tool' && full[1] === 'aelix' && full[2] === 'extensions';
    const mentionsAelix = full[0] === 'tool' && (full[1] === 'aelix' || value.includes('aelix'));
    if (!isTarget) {
      if (mentionsAelix && (keys.length > 1 || table.length !== 2 || value.startsWith('{'))) return 'unknown';
      continue;
    }
    if (keys.length !== 1 || keys[0].quoted || table.length !== 2 || !value.startsWith('[')) return 'unknown';
    const next = new ArrayReader();
    next.feed(value.slice(1));
    if (next.state === 'unknown') return 'unknown';
    if (next.state === 'closed') found = next.strings;
    else reader = next;
  }
  if (reader) return 'unknown';
  return found ? { paths: found } : 'none';
}

async function directoryKind(scan: Scan, directory: string): Promise<TerminalGlobalExtensionKind | undefined> {
  if ((await statOf(scan, path.join(directory, 'aelix-plugin.toml')))?.isFile()) return 'manifest';
  const pyproject = await readBounded(scan, path.join(directory, 'pyproject.toml'), PYPROJECT_LIMIT);
  if (pyproject === 'too_large') return 'unknown';
  if (typeof pyproject === 'object') {
    const declared = readDeclaredExtensions(pyproject.text);
    if (declared === 'unknown') return 'unknown';
    if (declared !== 'none') {
      // Native takes the table only when a declared path exists, resolved from the directory.
      const paths = scan.platform === 'win32' ? path.win32 : path.posix;
      const candidates = declared.paths
        .filter((entry) => entry !== '')
        .map((entry) => paths.resolve(directory, entry))
        .filter((candidate) => !isUncOrDevice(candidate, scan.platform))
        .slice(0, 64);
      for (const candidate of candidates) {
        // eslint-disable-next-line no-await-in-loop -- stops at the first that exists
        if (await statOf(scan, candidate)) return 'pyproject';
      }
    }
  }
  if ((await statOf(scan, path.join(directory, '__init__.py')))?.isFile()) return 'package';
  return undefined;
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
  const found = await mapLimited(
    listing.names,
    FS_CONCURRENCY,
    async (name): Promise<TerminalGlobalExtension | undefined> => {
      const entry = path.join(directory, name);
      const info = await statOf(scan, entry);
      // Python's `Path.suffix`: `.py` alone is a hidden file without a suffix.
      if (info?.isFile()) return name.endsWith('.py') && name !== '.py' ? { name, kind: 'file' } : undefined;
      if (!info?.isDirectory()) return undefined;
      const kind = await directoryKind(scan, entry);
      return kind ? { name, kind } : undefined;
    }
  );
  return {
    extensions: found.filter((entry): entry is TerminalGlobalExtension => entry !== undefined),
    truncated: listing.truncated,
  };
}
