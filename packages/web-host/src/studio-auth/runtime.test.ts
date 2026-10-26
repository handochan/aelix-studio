import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveNativeRuntime } from './runtime';

const mocks = vi.hoisted(() => ({ existsSync: vi.fn(), readFileSync: vi.fn() }));
vi.mock('node:fs', () => mocks);

describe('portable native runtime resolution', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const arch = Object.getOwnPropertyDescriptor(process, 'arch')!;
  const root = path.resolve('/owned runtime 한글');
  afterEach(() => {
    Object.defineProperty(process, 'platform', platform);
    Object.defineProperty(process, 'arch', arch);
    vi.resetAllMocks();
  });

  it('uses the Windows venv Python without a shell or POSIX entrypoint', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    mocks.existsSync.mockImplementation((file) => !String(file).endsWith('manifest.json'));
    const runtime = resolveNativeRuntime(root);
    expect(runtime?.python).toBe(path.join(root, 'native', 'Scripts', 'python.exe'));
    expect(runtime?.helperArgs).toEqual(['-I', '-B', '-X', 'utf8']);
    expect(runtime?.launcher).toBe(path.join(root, 'launch.cjs'));
  });

  it('uses isolated bundled Python and the owned loader on macOS', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    Object.defineProperty(process, 'arch', { value: 'arm64', configurable: true });
    mocks.existsSync.mockReturnValue(true);
    mocks.readFileSync.mockReturnValue(
      JSON.stringify({ schema: 'aelix.studio-preview.runtime/1', target: 'darwin-arm64' })
    );
    const runtime = resolveNativeRuntime(root);
    expect(runtime?.python).toBe(path.join(root, 'python', 'bin', 'python3'));
    expect(runtime?.helperArgs).toEqual(['-I', '-S', '-B', '-X', 'utf8', path.join(root, 'launch.py'), 'helper']);
  });

  it('refuses a payload for a different host target', () => {
    mocks.existsSync.mockReturnValue(true);
    mocks.readFileSync.mockReturnValue(JSON.stringify({ schema: 'aelix.studio-preview.runtime/1', target: 'unknown' }));
    expect(resolveNativeRuntime(root)).toBeUndefined();
  });

  it('refuses malformed manifests and missing owned launchers', () => {
    mocks.existsSync.mockReturnValue(true);
    mocks.readFileSync.mockReturnValue('{');
    expect(resolveNativeRuntime(root)).toBeUndefined();
    mocks.existsSync.mockReturnValue(false);
    expect(resolveNativeRuntime(root)).toBeUndefined();
  });
});
