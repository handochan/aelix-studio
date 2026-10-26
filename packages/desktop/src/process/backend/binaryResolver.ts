/**
 * Resolve the aioncore binary path.
 *
 * Search order:
 *  1. AIONUI_BACKEND_BIN env override (path, resolved to absolute)
 *  2. Bundled with app (production)
 * Explicit overrides are opt-in; the default source policy never falls back to PATH.
 */

import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { verifyDefaultHostBundle } from '../../../../shared-scripts/src/default-host.js';

const BINARY_NAME = 'aioncore';
const BIN_ENV_VAR = 'AIONUI_BACKEND_BIN';
const MAX_DIR_ENTRIES = 20;

type BackendBinaryResolveDiagnostics = {
  envOverridePath?: string;
  envOverrideExists?: boolean;
  resourcesPath?: string;
  runtimeKey: string;
  binaryName: string;
  checkedBundledPath?: string;
  bundledDirExists?: boolean;
  runtimeDirExists?: boolean;
  resourcesDirEntries?: string[];
  runtimeDirEntries?: string[];
  pathLookupCommand: string;
  pathLookupResult?: string;
  pathLookupError?: string;
};

class BackendBinaryResolveError extends Error {
  readonly diagnostics: BackendBinaryResolveDiagnostics;

  constructor(message: string, diagnostics: BackendBinaryResolveDiagnostics) {
    super(message);
    this.name = 'BackendBinaryResolveError';
    this.diagnostics = diagnostics;
  }
}

function getBinaryName(): string {
  return process.platform === 'win32' ? `${BINARY_NAME}.exe` : BINARY_NAME;
}

function getRuntimeKey(): string {
  return `${process.platform}-${process.arch}`;
}

function listDirEntries(dirPath: string): string[] | undefined {
  try {
    return readdirSync(dirPath, { withFileTypes: true })
      .slice(0, MAX_DIR_ENTRIES)
      .map((entry) => `${entry.name}${entry.isDirectory() ? '/' : ''}`);
  } catch {
    return undefined;
  }
}

/**
 * Resolve the aioncore binary path.
 * Returns the absolute path to the binary, or throws if not found.
 */
export function resolveBinaryPath(): string {
  const runtimeKey = getRuntimeKey();
  const binaryName = getBinaryName();
  const diagnostics: BackendBinaryResolveDiagnostics = {
    runtimeKey,
    binaryName,
    pathLookupCommand: process.platform === 'win32' ? `where ${BINARY_NAME}` : `which ${BINARY_NAME}`,
  };

  const override = envOverridePath(diagnostics);
  if (override) return override;

  const bundled = bundledPath(runtimeKey, binaryName, diagnostics);
  if (bundled) return bundled;

  throw new BackendBinaryResolveError(
    `Cannot find "${BINARY_NAME}" binary. Prepare the default source host bundle or set an explicit backend override.`,
    diagnostics
  );
}

/**
 * Honor the AIONUI_BACKEND_BIN env override.
 * The value is resolved to an absolute path (relative to process.cwd) so it
 * survives the backend launcher spawning with a different working directory.
 * Returns the path when it points at an existing file. When the variable is
 * set but the file is missing, throws so a typo fails loudly instead of
 * silently falling back to the bundled or PATH binary.
 */
function envOverridePath(diagnostics: BackendBinaryResolveDiagnostics): string | null {
  const raw = process.env[BIN_ENV_VAR]?.trim();
  if (!raw) return null;

  const absolute = resolve(raw);
  diagnostics.envOverridePath = absolute;
  const exists = existsSync(absolute);
  diagnostics.envOverrideExists = exists;
  if (exists) return absolute;

  throw new BackendBinaryResolveError(
    `${BIN_ENV_VAR} is set to "${raw}" but no file exists at "${absolute}".`,
    diagnostics
  );
}

/**
 * Check bundled binary in resources directory.
 * Layout: bundled-aioncore/{platform}-{arch}/aioncore[.exe]
 */
function bundledPath(
  runtimeKey: string,
  binaryName: string,
  diagnostics: BackendBinaryResolveDiagnostics
): string | null {
  const electronProcess = process as NodeJS.Process & { resourcesPath?: string; defaultApp?: boolean };
  const resourcesPath =
    electronProcess.resourcesPath && !electronProcess.defaultApp
      ? electronProcess.resourcesPath
      : join(process.cwd(), 'resources');
  if (!resourcesPath) return null;
  diagnostics.resourcesPath = resourcesPath;

  const bundledDir = join(resourcesPath, 'bundled-aioncore');
  const runtimeDir = join(bundledDir, runtimeKey);
  const candidate = join(runtimeDir, binaryName);
  diagnostics.checkedBundledPath = candidate;
  diagnostics.bundledDirExists = existsSync(bundledDir);
  diagnostics.runtimeDirExists = existsSync(runtimeDir);
  diagnostics.resourcesDirEntries = listDirEntries(resourcesPath);
  diagnostics.runtimeDirEntries = listDirEntries(runtimeDir);

  if (!existsSync(candidate)) return null;
  try {
    verifyDefaultHostBundle(runtimeDir, runtimeKey);
  } catch (error) {
    throw new BackendBinaryResolveError(
      `Default host bundle failed verification: ${error instanceof Error ? error.message : String(error)}`,
      diagnostics
    );
  }
  return candidate;
}

export type { BackendBinaryResolveDiagnostics };
