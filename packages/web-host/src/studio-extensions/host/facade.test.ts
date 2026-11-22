/**
 * The extension helper on the WebUI listener: the native auth facade's admission (a real
 * login, the page's own origin, the marker header, a size cap), then the signed-in user as
 * the owner. The service is stubbed; the routing of the static server has its own test.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExtensionService } from './service';
import { handleStudioExtensions, STUDIO_EXTENSIONS_ROUTE } from './facade';

describe('the extension helper on the WebUI listener', () => {
  let server: http.Server;
  let backend: http.Server;
  let url = '';
  let authenticate = false;
  let seenHeaders: http.IncomingHttpHeaders = {};
  let configured: ExtensionService | undefined;
  const handler = vi.fn(async () => ({ ok: true as const, data: { settings: {} } }));
  beforeEach(async () => {
    authenticate = false;
    configured = { request: handler } as unknown as ExtensionService;
    backend = http.createServer((req, res) => {
      seenHeaders = req.headers;
      // The facade hands the backend the host's own cookie name for the Studio session.
      res.writeHead(authenticate && req.headers.cookie === 'aionui-session=valid' ? 200 : 401, {
        'content-type': 'application/json',
      });
      res.end(JSON.stringify({ success: true, user: { id: 'operator' } }));
    });
    await new Promise<void>((resolve) => backend.listen(0, '127.0.0.1', resolve));
    server = http.createServer((req, res) => {
      void handleStudioExtensions(req, res, {
        backendPort: (backend.address() as AddressInfo).port,
        origins: [url],
        ...(configured ? { service: configured } : {}),
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
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
  const request = (headers: Record<string, string> = {}, body = '{"action":"get_settings"}', method = 'POST') =>
    fetch(url + STUDIO_EXTENSIONS_ROUTE, {
      method,
      headers: {
        origin: url,
        'content-type': 'application/json',
        'x-studio-extensions': '1',
        ...headers,
      },
      ...(method === 'POST' ? { body } : {}),
    });

  it('refuses a caller without a real login before the helper sees anything, and forwards no identity header', async () => {
    const response = await request({ 'x-aionui-internal': 'forged', 'x-user-id': 'operator' });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ ok: false, code: 'UNAUTHENTICATED' });
    expect(handler).not.toHaveBeenCalled();
    expect(seenHeaders['x-aionui-internal']).toBeUndefined();
    expect(seenHeaders['x-user-id']).toBeUndefined();
  });

  it.each([
    ['another origin', { origin: 'https://attacker.example' }],
    ['a cross-site request', { 'sec-fetch-site': 'cross-site' }],
    ['no marker header', { 'x-studio-extensions': '0' }],
    ['the native auth marker instead', { 'x-studio-extensions': '', 'x-studio-auth': '1' }],
    ['a form post', { 'content-type': 'application/x-www-form-urlencoded' }],
  ])('refuses %s even with a valid session', async (_case, headers) => {
    authenticate = true;
    const response = await request({ cookie: 'aelix-studio-session=valid', ...headers });
    expect(response.status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
  });

  it('refuses anything but a POST to the route itself', async () => {
    authenticate = true;
    expect((await request({ cookie: 'aelix-studio-session=valid' }, '', 'GET')).status).toBe(403);
    const other = await fetch(url + STUDIO_EXTENSIONS_ROUTE + '/list', {
      method: 'POST',
      headers: { origin: url, 'content-type': 'application/json', 'x-studio-extensions': '1' },
      body: '{}',
    });
    expect(other.status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
  });

  it('gives the request to the helper as the signed-in user, and the reply uncached', async () => {
    authenticate = true;
    const response = await request({ cookie: 'aelix-studio-session=valid' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, data: { settings: {} } });
    expect(handler).toHaveBeenCalledWith('web:operator', { action: 'get_settings' });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('caps the body and refuses malformed JSON without repeating it', async () => {
    authenticate = true;
    const malformed = await request({ cookie: 'aelix-studio-session=valid' }, '{"password":"sentinel-secret"');
    expect(malformed.status).toBe(400);
    expect(await malformed.text()).not.toContain('sentinel-secret');
    expect((await request({ cookie: 'aelix-studio-session=valid' }, 'x'.repeat(60001))).status).toBe(413);
    expect(handler).not.toHaveBeenCalled();
  });

  it('answers RUNTIME_UNAVAILABLE while the host has not configured the helper', async () => {
    authenticate = true;
    configured = undefined;
    const response = await request({ cookie: 'aelix-studio-session=valid' });
    expect(await response.json()).toEqual({ ok: false, code: 'RUNTIME_UNAVAILABLE' });
  });

  it('answers UNAVAILABLE, and nothing of the error, when the helper throws', async () => {
    authenticate = true;
    handler.mockRejectedValueOnce(new Error('sentinel-secret'));
    const response = await request({ cookie: 'aelix-studio-session=valid' });
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('sentinel-secret');
  });
});
