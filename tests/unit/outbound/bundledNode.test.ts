import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveBundledNodePath } from '@/process/backend/binaryResolver';

const { verify, read, exists } = vi.hoisted(() => ({ verify: vi.fn(), read: vi.fn(), exists: vi.fn() }));
vi.mock('node:fs', () => ({ readFileSync: read, existsSync: exists, readdirSync: vi.fn() }));
vi.mock('../../../packages/shared-scripts/src/default-host.js', () => ({ verifyDefaultHostBundle: verify }));

const resources = Object.getOwnPropertyDescriptor(process, 'resourcesPath');
const defaultApp = Object.getOwnPropertyDescriptor(process, 'defaultApp');
const runtimeKey = `${process.platform}-${process.arch}`;
const bundle = join(process.cwd(), 'owned resources', 'bundled-aioncore', runtimeKey);
const root = join(bundle, 'managed-resources');
const executable = process.platform === 'win32' ? 'node.exe' : 'bin/node';

beforeEach(() => {
  vi.resetAllMocks();
  Object.defineProperty(process, 'resourcesPath', {
    value: join(process.cwd(), 'owned resources'),
    configurable: true,
  });
  Object.defineProperty(process, 'defaultApp', { value: false, configurable: true });
  read.mockReturnValue(JSON.stringify({ node: { root: 'node/pinned', executable } }));
  exists.mockReturnValue(true);
});
afterEach(() => {
  for (const [key, descriptor] of [
    ['resourcesPath', resources],
    ['defaultApp', defaultApp],
  ] as const) {
    if (descriptor) Object.defineProperty(process, key, descriptor);
    else Reflect.deleteProperty(process, key);
  }
  vi.unstubAllEnvs();
});

describe('bundled MCP Node', () => {
  it('uses the verified bundle with empty PATH and an unrelated backend override', () => {
    vi.stubEnv('PATH', '');
    vi.stubEnv('AIONUI_BACKEND_BIN', '/custom/host');
    expect(resolveBundledNodePath()).toBe(join(root, 'node/pinned', executable));
    expect(verify).toHaveBeenCalledWith(bundle, runtimeKey);
  });
  it('fails before reading an unverified bundle contract', () => {
    verify.mockImplementation(() => {
      throw new Error('Unverified bundle');
    });
    expect(resolveBundledNodePath).toThrow('Unverified bundle');
    expect(read).not.toHaveBeenCalled();
  });
  it('rejects a missing executable instead of searching PATH', () => {
    exists.mockReturnValue(false);
    expect(resolveBundledNodePath).toThrow('bundled Node executable is unavailable');
  });
  it('rejects a contract path escaping the managed bundle', () => {
    read.mockReturnValue(JSON.stringify({ node: { root: '../../external', executable } }));
    expect(resolveBundledNodePath).toThrow('bundled Node executable is unavailable');
  });
});
