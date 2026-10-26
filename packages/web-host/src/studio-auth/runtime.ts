import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export type NativeRuntime = { root: string; python: string; helperArgs: string[]; launcher: string };

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
    return existsSync(python) && existsSync(entry)
      ? { root, python, helperArgs: ['-I', '-S', '-B', '-X', 'utf8', entry, 'helper'], launcher }
      : undefined;
  }
  const directory = process.platform === 'win32' ? 'Scripts' : 'bin';
  const filename = process.platform === 'win32' ? 'python.exe' : 'python';
  const python = path.join(root, 'native', directory, filename);
  return existsSync(python) && existsSync(path.join(root, 'adapter', directory, filename))
    ? { root, python, helperArgs: ['-I', '-B', '-X', 'utf8'], launcher }
    : undefined;
}
