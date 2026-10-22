import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ startBackend: vi.fn(), startStaticServer: vi.fn() }));
vi.mock('../../../packages/web-host/src/backend-launcher.js', () => ({ startBackend: mocks.startBackend }));
vi.mock('../../../packages/web-host/src/static-server.js', () => ({ startStaticServer: mocks.startStaticServer }));
import { startWebHost } from '../../../packages/web-host/src/index';

const app = { version: '2.2.2', isPackaged: true, resourcesPath: '/resources', userDataPath: '/data' };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.startBackend.mockResolvedValue({ port: 12345, stop: vi.fn() });
  mocks.startStaticServer.mockResolvedValue({ port: 3000, localUrl: 'http://127.0.0.1:3000', stop: vi.fn() });
});

describe('public WebUI authentication boundary', () => {
  it('starts its backend with authentication enabled even on loopback', async () => {
    await startWebHost({
      app,
      staticDir: '/renderer',
      dataDir: '/data',
      backend: { kind: 'ownBackend', resolveBackend: () => '/core' },
    });
    expect(mocks.startBackend).toHaveBeenCalledWith(expect.objectContaining({ local: false }));
  });

  it('rejects exposing an embedded unauthenticated backend to the LAN', async () => {
    await expect(
      startWebHost({
        app,
        staticDir: '/renderer',
        allowRemote: true,
        backend: { kind: 'useExistingBackend', port: 12345 },
      })
    ).rejects.toThrow('cannot be exposed remotely');
    expect(mocks.startStaticServer).not.toHaveBeenCalled();
  });
});

import { ensureStudioAdmin } from '@/process/studio/standalone';

describe('private WebUI account provisioning', () => {
  it('creates initial credentials before allowing a public server to open', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ needs_setup: true }))
      .mockResolvedValueOnce(Response.json({ data: { new_password: 'initial-test-password' } }))
      .mockResolvedValueOnce(Response.json({ data: { username: 'admin' } }));
    await expect(ensureStudioAdmin(12345, request)).resolves.toEqual({
      username: 'admin',
      initialPassword: 'initial-test-password',
    });
    expect(request).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('/api/webui/reset-password'),
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('preserves an existing account password', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ needs_setup: false }))
      .mockResolvedValueOnce(Response.json({ data: { username: 'operator' } }));
    await expect(ensureStudioAdmin(12345, request)).resolves.toEqual({ username: 'operator' });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('fails closed when account provisioning returns an error', async () => {
    const request = vi.fn().mockResolvedValue(new Response(null, { status: 503 }));
    await expect(ensureStudioAdmin(12345, request)).rejects.toThrow('HTTP 503');
  });

  it('rejects missing initial credentials instead of publishing a broken login', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ needs_setup: true }))
      .mockResolvedValueOnce(Response.json({ data: {} }));
    await expect(ensureStudioAdmin(12345, request)).rejects.toThrow('did not return initial credentials');
  });
});
