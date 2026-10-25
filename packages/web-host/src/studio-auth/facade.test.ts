import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleNativeAuth, NATIVE_AUTH_ROUTE } from './facade';
import { NativeAuthService } from './service';

describe('native auth facade authentication and request boundary', () => {
  let server: http.Server;
  let backend: http.Server;
  let url: string;
  let authenticate: boolean;
  let seenHeaders: http.IncomingHttpHeaders;
  let service: NativeAuthService;
  const handler = vi.fn(async () => ({ ok: true as const, data: { providers: [] } }));
  beforeEach(async () => {
    authenticate = false;
    service = new NativeAuthService();
    vi.spyOn(service, 'request').mockImplementation(handler as NativeAuthService['request']);
    backend = http.createServer((req, res) => {
      seenHeaders = req.headers;
      res.writeHead(authenticate && req.headers.cookie === 'session=valid' ? 200 : 401, {
        'content-type': 'application/json',
      });
      res.end(JSON.stringify({ success: true, user: { id: 'operator' } }));
    });
    await new Promise<void>((resolve) => backend.listen(0, '127.0.0.1', resolve));
    server = http.createServer((req, res) => {
      void handleNativeAuth(req, res, {
        backendPort: (backend.address() as AddressInfo).port,
        origins: [url],
        service,
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    service.dispose();
    handler.mockClear();
    await Promise.all(
      [server, backend].map(
        (instance) =>
          new Promise<void>((resolve) => {
            instance.closeAllConnections();
            instance.close(() => resolve());
          })
      )
    );
  });
  const request = (base: string, headers: Record<string, string> = {}, body = '{"action":"catalog"}') =>
    fetch(base + NATIVE_AUTH_ROUTE, {
      method: 'POST',
      headers: { origin: base, 'content-type': 'application/json', 'x-studio-auth': '1', ...headers },
      body,
    });

  it('rejects unauthenticated callers before helper admission', async () => {
    const response = await request(url, { 'x-aionui-internal': 'forged', 'x-user-id': 'operator' });
    expect(response.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
    expect(seenHeaders['x-aionui-internal']).toBeUndefined();
  });
  it('rejects cross-origin credential requests even with a valid session', async () => {
    authenticate = true;
    expect((await request(url, { origin: 'https://attacker.example', cookie: 'session=valid' })).status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
  });
  it('scopes commands to backend identity and disables response caching', async () => {
    authenticate = true;
    const response = await request(url, { cookie: 'session=valid' });
    expect(response.status).toBe(200);
    expect(handler).toHaveBeenCalledWith('web:operator', { action: 'catalog' });
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
  it('bounds oversized bodies and rejects malformed JSON without reflecting it', async () => {
    authenticate = true;
    const response = await request(url, { cookie: 'session=valid' }, 'sentinel-secret');
    expect(await response.text()).not.toContain('sentinel-secret');
    expect(response.status).toBe(400);
    expect((await request(url, { cookie: 'session=valid' }, 'x'.repeat(60001))).status).toBe(413);
  });
});
