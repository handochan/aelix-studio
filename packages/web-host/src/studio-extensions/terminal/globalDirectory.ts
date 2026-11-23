import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

/**
 * How native's directory tier takes an entry of `<agent dir>/extensions` (`_discover_in_dir`
 * and `_resolve_extension_entries` in its loader), first match wins for a directory:
 * `file`, a `*.py` file; `manifest`, a directory with `aelix-plugin.toml`; `pyproject`, one
 * whose `pyproject.toml` has a `[tool.aelix]` table; `package`, one with `__init__.py`.
 */
export type GlobalExtensionKind = 'file' | 'manifest' | 'pyproject' | 'package';

export type GlobalExtension = { name: string; kind: GlobalExtensionKind };

const statOf = (target: string) => stat(target).catch((): undefined => undefined);

/** A `[tool.aelix]` table header line; the TOML is not otherwise parsed. */
const TOOL_AELIX = /^\s*\[\s*tool\s*\.\s*aelix\s*\]\s*(?:#.*)?$/m;

async function directoryKind(directory: string): Promise<GlobalExtensionKind | undefined> {
  if ((await statOf(path.join(directory, 'aelix-plugin.toml')))?.isFile()) return 'manifest';
  const pyproject = path.join(directory, 'pyproject.toml');
  if ((await statOf(pyproject))?.isFile()) {
    const text = await readFile(pyproject, 'utf8').catch((): string => '');
    if (TOOL_AELIX.test(text)) return 'pyproject';
  }
  if ((await statOf(path.join(directory, '__init__.py')))?.isFile()) return 'package';
  return undefined;
}

/**
 * The entries of the terminal CLI's global extension directory that native's directory tier
 * would take, one level deep, by name; nothing is imported. Manifests are not parsed: a broken
 * one is listed here and fails in native. A missing directory has no entries.
 */
export async function readGlobalExtensions(directory: string): Promise<GlobalExtension[]> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return [];
  }
  const found = await Promise.all(
    names.toSorted().map(async (name): Promise<GlobalExtension | undefined> => {
      const entry = path.join(directory, name);
      const info = await statOf(entry);
      // Python's `Path.suffix`: `.py` alone is a hidden file without a suffix.
      if (info?.isFile()) return name.endsWith('.py') && name !== '.py' ? { name, kind: 'file' } : undefined;
      if (!info?.isDirectory()) return undefined;
      const kind = await directoryKind(entry);
      return kind ? { name, kind } : undefined;
    })
  );
  return found.filter((entry): entry is GlobalExtension => entry !== undefined);
}
