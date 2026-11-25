/**
 * Tests for startWebHost (M6)
 *
 * After the M6 auth cleanup, startWebHost is a thin orchestrator: start backend,
 * start static-server, return the combined handle. No credentials, no config
 * file reads — the caller (Electron main process, aionui-web CLI) resolves
 * port / allowRemote from its own source of truth.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

describe('startWebHost', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('Returns handle without initialPassword', async () => {
    // Mock backend-launcher
    vi.doMock('../src/backend-launcher.js', () => ({
      startBackend: vi.fn().mockResolvedValue({
        port: 55555,
        stop: vi.fn().mockResolvedValue(undefined),
      }),
    }));

    // Mock static-server
    vi.doMock('../src/static-server.js', () => ({
      startStaticServer: vi.fn().mockResolvedValue({
        port: 33000,
        url: 'http://127.0.0.1:33000',
        localUrl: 'http://127.0.0.1:33000',
        stop: vi.fn().mockResolvedValue(undefined),
      }),
    }));

    const { startWebHost } = await import('../src/index.js');
    const { startStaticServer } = await import('../src/static-server.js');
    const userDataPath = '/tmp/Studio 사용자 데이터';

    const handle = await startWebHost({
      app: {
        version: '1.0.0',
        isPackaged: false,
        resourcesPath: '/app',
        userDataPath,
      },
      staticDir: '/tmp/static',
      backend: {
        kind: 'ownBackend',
        resolveBackend: () => '/bin/backend',
      },
    });

    // No initialPassword field on the handle — admin credentials flow through
    // backend's /api/webui/reset-password, not through startWebHost.
    expect('initialPassword' in handle).toBe(false);
    expect(handle.port).toBe(33000);
    expect(handle.backendPort).toBe(55555);
    expect(startStaticServer).toHaveBeenCalledWith(expect.objectContaining({ userDataPath }));

    await handle.stop();

    vi.doUnmock('../src/backend-launcher.js');
    vi.doUnmock('../src/static-server.js');
  });

  test.todo('Backend port conflict: throws and does not leak resources');
  test.todo('Static-server port conflict: cleans up backend before throwing');
  test.todo('Stop cleanup: stops static-server then backend in sequence');
});

test('development WebUI hands Node resolution the exact alternate bundle verified for the host', async () => {
  const workDir = await mkdtemp(path.join(tmpdir(), 'studio-webui-bundle-'));
  const alternate = path.join(workDir, 'alternate host bundle');
  const target = `${process.platform}-${process.arch}`;
  const directory = path.join(alternate, target);
  const binary = path.join(directory, process.platform === 'win32' ? 'aelix-studio-host.exe' : 'aelix-studio-host');
  const verifyDefaultHostBundle = vi.fn();
  const startWebHost = vi.fn().mockResolvedValue({ backendPort: 55555, localUrl: 'http://127.0.0.1:33000' });
  const signals = ['SIGINT', 'SIGTERM'] as const;
  const oldListeners = Object.fromEntries(signals.map((signal) => [signal, process.listeners(signal)]));
  vi.stubEnv('AIONUI_BACKEND_BIN', undefined);
  vi.stubEnv('AIONUI_BACKEND_BUNDLED_DIR', alternate);
  vi.stubEnv('AIONUI_DATA_DIR', workDir);
  vi.stubEnv('AIONUI_STATIC_DIR', workDir);
  vi.stubEnv('AIONUI_OPEN_BROWSER', '0');
  vi.stubEnv('NVM_DIR', path.join(workDir, 'no-nvm'));
  vi.doMock('@aionui/web-host', () => ({
    startWebHost,
    configureStudioExtensions: vi.fn(),
    disposeStudioExtensions: vi.fn(),
    resolveStandaloneStudioUserDataPath: vi.fn().mockResolvedValue(workDir),
    fetchStudioBackend: vi.fn().mockResolvedValue({ ok: false }),
  }));
  vi.doMock('../../shared-scripts/src/default-host.js', () => ({ verifyDefaultHostBundle }));
  try {
    await import('../../../scripts/webui');
    await vi.waitFor(() => expect(startWebHost).toHaveBeenCalledOnce());
    const { app, backend } = startWebHost.mock.calls[0][0];
    expect(backend.resolveBackend()).toBe(binary);
    expect(verifyDefaultHostBundle).toHaveBeenCalledWith(directory, target);
    expect(app.bundledHostDirectory).toBe(directory);
  } finally {
    for (const signal of signals) {
      for (const listener of process.listeners(signal)) {
        if (!oldListeners[signal].includes(listener)) process.removeListener(signal, listener);
      }
    }
    vi.unstubAllEnvs();
    vi.doUnmock('@aionui/web-host');
    vi.doUnmock('../../shared-scripts/src/default-host.js');
    await rm(workDir, { recursive: true, force: true });
  }
});
