import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { STATE_DIRECTORY, STATE_ENVIRONMENT } from '../studio-extensions/store/layout.js';
import { verifyDefaultHostBundle } from '../../../shared-scripts/src/default-host.js';

export type NativeRuntime = {
  root: string;
  python: string;
  helperArgs: string[];
  launcher: string;
  acpArgs?: string[];
};

export const STUDIO_AELIX_LAUNCH_ENV = 'AIONUI_STUDIO_AELIX_LAUNCH';

/** Resolve only the selected prepared or self-contained runtime, using direct Python on every OS. */
export function resolveNativeRuntime(root: string): NativeRuntime | undefined {
  root = path.resolve(root);
  const launcher = path.join(root, 'launch.cjs');
  if (!existsSync(launcher)) return undefined;
  const manifest = path.join(root, 'manifest.json');
  if (existsSync(manifest)) {
    try {
      const data = JSON.parse(readFileSync(manifest, 'utf8')) as { schema?: unknown; target?: unknown };
      if (data.schema !== 'aelix.studio-preview.runtime/1' || data.target !== `${process.platform}-${process.arch}`)
        return undefined;
    } catch {
      return undefined;
    }
    const python = path.join(root, 'python', ...(process.platform === 'win32' ? ['python.exe'] : ['bin', 'python3']));
    const entry = path.join(root, 'launch.py');
    if (!existsSync(python) || !existsSync(entry)) return undefined;
    const args = ['-I', '-S', '-B', '-X', 'utf8', entry];
    return { root, python, helperArgs: [...args, 'helper'], launcher, acpArgs: [...args, 'acp'] };
  }
  const directory = process.platform === 'win32' ? 'Scripts' : 'bin';
  const filename = process.platform === 'win32' ? 'python.exe' : 'python';
  const python = path.join(root, 'native', directory, filename);
  return existsSync(python) && existsSync(path.join(root, 'adapter', directory, filename))
    ? { root, python, helperArgs: ['-I', '-B', '-X', 'utf8'], launcher }
    : undefined;
}

/** Match the runtime selection used by the sessionless native auth helper. */
export function selectNativeRuntime(explicit = process.env.AELIX_STUDIO_RUNTIME): NativeRuntime | undefined {
  if (explicit) return resolveNativeRuntime(explicit);
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const bundled = resourcesPath ? resolveNativeRuntime(path.join(resourcesPath, 'studio-preview')) : undefined;
  return bundled ?? resolveNativeRuntime('.local/studio-preview');
}

/** Locate this platform's default host bundle under Studio's resources directory. */
export function studioHostBundleDirectory(resourcesPath: string): string {
  return path.resolve(resourcesPath, 'bundled-aioncore', `${process.platform}-${process.arch}`);
}

/** Resolve the Node executable from a verified Studio host bundle directory. */
export function resolveBundledStudioNode(directory: string): string {
  const target = `${process.platform}-${process.arch}`;
  verifyDefaultHostBundle(directory, target);
  const root = path.join(directory, 'managed-resources');
  const contract = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8')) as {
    node: { root: string; executable: string };
  };
  const executable = path.resolve(root, contract.node.root, contract.node.executable);
  if (!executable.startsWith(root + path.sep) || !existsSync(executable)) {
    throw new Error('Verified bundled Node executable is unavailable');
  }
  return executable;
}

function isExecutableFile(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

function resolveNode(hostBundleDirectory?: string): string | undefined {
  if (hostBundleDirectory) {
    try {
      const bundled = resolveBundledStudioNode(hostBundleDirectory);
      if (isExecutableFile(bundled)) return bundled;
    } catch {
      // A developer runtime can be used without an installed host bundle.
    }
  }
  if (!process.versions.electron && !process.versions.bun && isExecutableFile(process.execPath)) {
    return process.execPath;
  }

  const executable = process.platform === 'win32' ? 'node.exe' : 'node';
  for (const directory of (process.env.PATH ?? '').split(path.delimiter).filter(path.isAbsolute)) {
    const candidate = path.join(directory, executable);
    if (isExecutableFile(candidate)) return candidate;
  }
  return undefined;
}

/** Resolve the CLI agent root before launching either the auth helper or ACP. */
export function normalizeStudioAgentDir(env = process.env): string {
  const windows = process.platform === 'win32';
  const paths = windows ? path.win32 : path.posix;
  const home = (windows ? env.USERPROFILE : env.HOME) || homedir();
  const agentDir = env.AELIX_CODING_AGENT_DIR || paths.join(home, '.aelix', 'agent');
  const expandsHome = agentDir === '~' || agentDir.startsWith('~/') || (windows && agentDir.startsWith('~\\'));
  return paths.resolve(expandsHome ? paths.join(home, agentDir.slice(2)) : agentDir);
}

/**
 * Build the D16 launch descriptor from paths alone, without calling the auth helper.
 * Node comes from the same verified host bundle directory as the host binary.
 */
export function buildStudioAelixLaunch(userDataPath: string, hostBundleDirectory?: string): string | undefined {
  const runtime = selectNativeRuntime();
  if (!runtime) return undefined;

  const launcher = runtime.acpArgs?.at(-2) ?? runtime.launcher;
  const command = runtime.acpArgs ? runtime.python : resolveNode(hostBundleDirectory);
  if (!command || (process.platform === 'win32' && path.extname(command).toLowerCase() !== '.exe')) return undefined;
  try {
    if (!statSync(launcher).isFile() || (runtime.acpArgs && !isExecutableFile(command))) return undefined;
  } catch {
    return undefined;
  }
  return JSON.stringify({
    command,
    args: [...(runtime.acpArgs ?? [runtime.launcher]), '--profile', 'coding'],
    env: {
      AELIX_CODING_AGENT_DIR: normalizeStudioAgentDir(),
      AELIX_ACP_STUDIO_MANAGED: '1',
      [STATE_ENVIRONMENT]: path.resolve(userDataPath, STATE_DIRECTORY),
    },
  });
}
