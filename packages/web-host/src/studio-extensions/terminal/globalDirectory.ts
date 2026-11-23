import path from 'node:path';
import type { TerminalGlobalExtension, TerminalGlobalExtensionKind } from '../types.js';
import { listDirectory, readBounded, statOf } from './files.js';

/** The most entries of the global directory this looks at. */
export const GLOBAL_ENTRY_LIMIT = 500;
/** The most of a `pyproject.toml` this reads. */
const PYPROJECT_LIMIT = 256 * 1024;

/** A `[tool.aelix]` table header line; the TOML is not otherwise parsed. */
const TOOL_AELIX = /^\s*\[\s*tool\s*\.\s*aelix\s*\]\s*(?:#.*)?$/m;

async function directoryKind(directory: string): Promise<TerminalGlobalExtensionKind | undefined> {
  if ((await statOf(path.join(directory, 'aelix-plugin.toml')))?.isFile()) return 'manifest';
  const pyproject = await readBounded(path.join(directory, 'pyproject.toml'), PYPROJECT_LIMIT);
  if (typeof pyproject === 'object' && TOOL_AELIX.test(pyproject.text)) return 'pyproject';
  if ((await statOf(path.join(directory, '__init__.py')))?.isFile()) return 'package';
  return undefined;
}

/**
 * The entries of the terminal CLI's global extension directory that native's directory tier
 * would take, one level deep, by name; nothing is imported. Manifests are not parsed: a broken
 * one is listed here and fails in native. `absent` when the directory does not exist or is not
 * readable as one.
 */
export async function readGlobalExtensions(
  directory: string
): Promise<{ extensions: TerminalGlobalExtension[]; truncated: boolean } | 'absent'> {
  const listing = await listDirectory(directory, GLOBAL_ENTRY_LIMIT);
  if (!listing) return 'absent';
  const found = await Promise.all(
    listing.names.map(async (name): Promise<TerminalGlobalExtension | undefined> => {
      const entry = path.join(directory, name);
      const info = await statOf(entry);
      // Python's `Path.suffix`: `.py` alone is a hidden file without a suffix.
      if (info?.isFile()) return name.endsWith('.py') && name !== '.py' ? { name, kind: 'file' } : undefined;
      if (!info?.isDirectory()) return undefined;
      const kind = await directoryKind(entry);
      return kind ? { name, kind } : undefined;
    })
  );
  return {
    extensions: found.filter((entry): entry is TerminalGlobalExtension => entry !== undefined),
    truncated: listing.truncated,
  };
}
