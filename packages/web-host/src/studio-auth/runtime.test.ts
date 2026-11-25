import path from 'node:path';
import { homedir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildStudioAelixLaunch, resolveNativeRuntime } from './runtime';

const mocks = vi.hoisted(() => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  statSync: vi.fn(),
  accessSync: vi.fn(),
  constants: { X_OK: 1 },
  verifyBundle: vi.fn(),
}));
vi.mock('node:fs', () => mocks);
vi.mock('../../../shared-scripts/src/default-host.js', () => ({ verifyDefaultHostBundle: mocks.verifyBundle }));

describe('portable native runtime resolution', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const arch = Object.getOwnPropertyDescriptor(process, 'arch')!;
  const root = path.resolve('/owned runtime 한글');
  afterEach(() => {
    Object.defineProperty(process, 'platform', platform);
    Object.defineProperty(process, 'arch', arch);
    vi.resetAllMocks();
    vi.unstubAllEnvs();
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

  it('supplies only the D16 launcher arguments and environment for a bundled runtime', () => {
    vi.stubEnv('AELIX_STUDIO_RUNTIME', root);
    vi.stubEnv('AELIX_CODING_AGENT_DIR', '~/agent fixture');
    vi.stubEnv('AELIX_AUTH_PATH', 'private auth path');
    vi.stubEnv('OPENAI_API_KEY', 'test-secret');
    mocks.existsSync.mockReturnValue(true);
    mocks.statSync.mockReturnValue({ isFile: () => true });
    mocks.readFileSync.mockReturnValue(
      JSON.stringify({ schema: 'aelix.studio-preview.runtime/1', target: `${process.platform}-${process.arch}` })
    );

    const profile = path.join(root, 'profile');
    const python = path.join(root, 'python', ...(process.platform === 'win32' ? ['python.exe'] : ['bin', 'python3']));
    expect(JSON.parse(buildStudioAelixLaunch(profile)!)).toEqual({
      command: python,
      args: ['-I', '-S', '-B', '-X', 'utf8', path.join(root, 'launch.py'), 'acp', '--profile', 'coding'],
      env: {
        AELIX_CODING_AGENT_DIR: path.join(homedir(), 'agent fixture'),
        AELIX_ACP_STUDIO_MANAGED: '1',
        AELIX_STUDIO_EXTENSION_STATE: path.join(profile, 'aelix-runtime'),
      },
    });
  });

  it.each(['electron', 'bun'] as const)('prefers verified packaged Node under %s with a system-only PATH', (engine) => {
    const resources = path.join(root, 'packaged resources');
    const target = `${process.platform}-${process.arch}`;
    const bundle = path.join(resources, 'bundled-aioncore', target);
    const executable = process.platform === 'win32' ? 'node.exe' : 'bin/node';
    const bundledNode = path.join(bundle, 'managed-resources', 'node/pinned', executable);
    const version = Object.getOwnPropertyDescriptor(process.versions, engine);
    Object.defineProperty(process.versions, engine, { value: '1.0.0', configurable: true });
    try {
      vi.stubEnv('AELIX_STUDIO_RUNTIME', root);
      vi.stubEnv('PATH', process.platform === 'win32' ? 'C:\\Windows\\System32' : '/usr/bin:/bin');
      mocks.existsSync.mockImplementation((file) => !String(file).endsWith('manifest.json'));
      mocks.statSync.mockReturnValue({ isFile: () => true });
      mocks.accessSync.mockImplementation((file) => {
        if (file !== bundledNode) throw new Error('No system Node');
      });
      mocks.readFileSync.mockReturnValue(JSON.stringify({ node: { root: 'node/pinned', executable } }));
      const launch = buildStudioAelixLaunch(root, resources);
      expect(launch && JSON.parse(launch)).toMatchObject({
        command: bundledNode,
        args: [path.join(root, 'launch.cjs'), '--profile', 'coding'],
      });
      expect(mocks.verifyBundle).toHaveBeenCalledWith(bundle, target);
    } finally {
      if (version) Object.defineProperty(process.versions, engine, version);
      else Reflect.deleteProperty(process.versions, engine);
    }
  });

  it('omits the launch descriptor when a launcher path is a directory', () => {
    vi.stubEnv('AELIX_STUDIO_RUNTIME', root);
    mocks.existsSync.mockImplementation((file) => !String(file).endsWith('manifest.json'));
    mocks.statSync.mockImplementation((file) => ({ isFile: () => !String(file).endsWith('launch.cjs') }));
    expect(buildStudioAelixLaunch(root)).toBeUndefined();
  });
});
