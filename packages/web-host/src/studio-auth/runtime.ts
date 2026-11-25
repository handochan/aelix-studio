import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { STATE_DIRECTORY, STATE_ENVIRONMENT } from '../studio-extensions/store/layout.js';

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

function resolveNode(): string | undefined {
  if (!process.versions.electron && !process.versions.bun) return process.execPath;

  const executable = process.platform === 'win32' ? 'node.exe' : 'node';
  for (const directory of (process.env.PATH ?? '').split(path.delimiter).filter(path.isAbsolute)) {
    const candidate = path.join(directory, executable);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Continue searching for a native Node executable.
    }
  }
  return undefined;
}

/** Build the D16 launch descriptor from paths alone, without calling the auth helper. */
export function buildStudioAelixLaunch(userDataPath: string): string | undefined {
  const runtime = selectNativeRuntime();
  if (!runtime) return undefined;
  const command = runtime.acpArgs ? runtime.python : resolveNode();
  if (!command) return undefined;

  // Keep the same directory and tilde expansion as native get_agent_dir().
  const agentDir = process.env.AELIX_CODING_AGENT_DIR || path.join(homedir(), '.aelix', 'agent');
  const expanded = agentDir === '~' || agentDir.startsWith('~/') ? path.join(homedir(), agentDir.slice(2)) : agentDir;
  return JSON.stringify({
    command,
    args: [...(runtime.acpArgs ?? [runtime.launcher]), '--profile', 'coding'],
    env: {
      AELIX_CODING_AGENT_DIR: path.resolve(expanded),
      AELIX_ACP_STUDIO_MANAGED: '1',
      [STATE_ENVIRONMENT]: path.resolve(userDataPath, STATE_DIRECTORY),
    },
  });
}
