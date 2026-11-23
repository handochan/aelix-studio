/**
 * The extension helper on the WebUI listener: the native auth facade's admission (a real
 * login, the page's own origin, the marker header, a size cap), then the signed-in user as
 * the owner. The service is stubbed; the routing of the static server has its own test.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RUNTIME_HINT, type ExtensionService } from './service';
import { carriesProxyCredentials, handleStudioExtensions, STUDIO_EXTENSIONS_ROUTE } from './facade';

describe('the extension helper on the WebUI listener', () => {
  let server: http.Server;
  let backend: http.Server;
  let url = '';
  let authenticate = false;
  let seenHeaders: http.IncomingHttpHeaders = {};
  let configured: ExtensionService | undefined;
  /** Whether the connection counts as secure; undefined: from the real socket (loopback here). */
  let secure: boolean | undefined;
  /** The origins admission takes; undefined: the server's own. */
  let origins: string[] | undefined;
  const handler = vi.fn(async () => ({ ok: true as const, data: { settings: {} } }));
  beforeEach(async () => {
    authenticate = false;
    secure = undefined;
    origins = undefined;
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
        origins: origins ?? [url],
        ...(configured ? { service: configured } : {}),
        ...(secure === undefined ? {} : { secure: () => Boolean(secure) }),
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
    // Refusals say the transport too: the screen may read it from whatever reply came first.
    expect(await response.json()).toEqual({ ok: false, code: 'UNAUTHENTICATED', transport: 'secure' });
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
    ['a look-alike JSON type', { 'content-type': 'application/jsonx' }],
  ])('refuses %s even with a valid session', async (_case, headers) => {
    authenticate = true;
    const response = await request({ cookie: 'aelix-studio-session=valid', ...headers });
    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe('FORBIDDEN');
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
    // Every reply says whether the connection may carry a secret: this one is on this machine.
    expect(await response.json()).toEqual({ ok: true, data: { settings: {} }, transport: 'secure' });
    expect(handler).toHaveBeenCalledWith('web:operator', { action: 'get_settings' });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('takes JSON with parameters', async () => {
    authenticate = true;
    const response = await request({
      cookie: 'aelix-studio-session=valid',
      'content-type': 'application/json; charset=utf-8',
    });
    expect(response.status).toBe(200);
  });

  describe('proxy credentials over plain HTTP from another machine', () => {
    const credentials = { username: 'ops', password: 'sentinel-secret' };
    const secrets = [
      { action: 'set_proxy_credentials', credentials },
      { action: 'install', source: { kind: 'index', name: 'demo' }, proxyCredentials: credentials },
      { action: 'upgrade', name: 'demo', proxyCredentials: credentials },
      { action: 'set_settings', settings: { proxy: 'http://ops:sentinel-secret@proxy.example:3128' } },
    ];

    it.each(secrets)('refuses %j until the user acknowledged the warning', async (command) => {
      authenticate = true;
      secure = false;
      const refused = await request({ cookie: 'aelix-studio-session=valid' }, JSON.stringify(command));
      expect(refused.status).toBe(200);
      expect(await refused.json()).toEqual({ ok: false, code: 'INSECURE_TRANSPORT', transport: 'insecure' });
      expect(handler).not.toHaveBeenCalled();
      // With the acknowledgement the helper gets the request, without the flag.
      const sent = await request(
        { cookie: 'aelix-studio-session=valid' },
        JSON.stringify({ ...command, acknowledgeInsecureTransport: true })
      );
      expect(sent.status).toBe(200);
      expect(handler).toHaveBeenCalledWith('web:operator', command);
    });

    it('says on every reply that the connection is insecure, so the screen can warn before a secret', async () => {
      authenticate = true;
      secure = false;
      const response = await request({ cookie: 'aelix-studio-session=valid' });
      expect(await response.json()).toEqual({ ok: true, data: { settings: {} }, transport: 'insecure' });
    });

    it('lets everything else through without a flag, saved credentials included, and the flag never reaches the helper', async () => {
      authenticate = true;
      secure = false;
      for (const command of [
        { action: 'get_settings' },
        { action: 'install', source: { kind: 'index', name: 'demo' } },
        { action: 'set_settings', settings: { proxy: 'http://proxy.example:3128', proxyAuthentication: true } },
        { action: 'clear_proxy_credentials' },
      ]) {
        handler.mockClear();
        expect((await request({ cookie: 'aelix-studio-session=valid' }, JSON.stringify(command))).status).toBe(200);
        expect(handler).toHaveBeenCalledWith('web:operator', command);
      }
      handler.mockClear();
      await request(
        { cookie: 'aelix-studio-session=valid' },
        JSON.stringify({ action: 'get_settings', acknowledgeInsecureTransport: true })
      );
      expect(handler).toHaveBeenCalledWith('web:operator', { action: 'get_settings' });
    });

    it('asks for no flag on this machine, judged by the socket, whatever the headers say', async () => {
      authenticate = true;
      // The real socket of this test is loopback: a forwarded header claiming otherwise changes nothing.
      const response = await request(
        { cookie: 'aelix-studio-session=valid', 'x-forwarded-for': '203.0.113.7', 'x-forwarded-proto': 'http' },
        JSON.stringify(secrets[0])
      );
      expect(response.status).toBe(200);
      expect(handler).toHaveBeenCalledWith('web:operator', secrets[0]);
    });

    it('lowers a secure socket by the page origin: a plain-HTTP proxy on this machine in front of the public', async () => {
      authenticate = true;
      secure = true;
      origins = ['http://studio.example', 'https://studio.example'];
      const plain = await request(
        { cookie: 'aelix-studio-session=valid', origin: 'http://studio.example' },
        JSON.stringify(secrets[0])
      );
      expect(await plain.json()).toEqual({ ok: false, code: 'INSECURE_TRANSPORT', transport: 'insecure' });
      expect(handler).not.toHaveBeenCalled();
      // A proxy that terminates TLS: the browser sent the secret encrypted.
      const tls = await request(
        { cookie: 'aelix-studio-session=valid', origin: 'https://studio.example' },
        JSON.stringify(secrets[0])
      );
      expect(await tls.json()).toMatchObject({ ok: true, transport: 'secure' });
      expect(handler).toHaveBeenCalledWith('web:operator', secrets[0]);
    });

    it('takes no origin as insecure, and never raises an insecure socket', async () => {
      authenticate = true;
      origins = [''];
      const missing = await request({ cookie: 'aelix-studio-session=valid', origin: '' });
      expect(await missing.json()).toMatchObject({ ok: true, transport: 'insecure' });
      secure = false;
      origins = undefined;
      const lowered = await request({ cookie: 'aelix-studio-session=valid' });
      expect(await lowered.json()).toMatchObject({ ok: true, transport: 'insecure' });
    });

    it('tells requests that carry credentials apart', () => {
      for (const command of secrets) expect(carriesProxyCredentials(command)).toBe(true);
      for (const command of [
        null,
        'set_proxy_credentials',
        { action: 'list' },
        { action: 'set_settings', settings: { proxy: 'http://proxy.example:3128/path@x' } },
        { action: 'set_settings', settings: { proxy: null } },
      ])
        expect(carriesProxyCredentials(command)).toBe(false);
    });
  });

  it('caps the body and refuses malformed JSON without repeating it', async () => {
    authenticate = true;
    const malformed = await request({ cookie: 'aelix-studio-session=valid' }, '{"password":"sentinel-secret"');
    expect(malformed.status).toBe(400);
    const text = await malformed.text();
    expect(text).not.toContain('sentinel-secret');
    expect(JSON.parse(text)).toEqual({ ok: false, code: 'INVALID_INPUT', transport: 'secure' });
    const large = await request({ cookie: 'aelix-studio-session=valid' }, 'x'.repeat(60001));
    expect(large.status).toBe(413);
    expect(await large.json()).toEqual({ ok: false, code: 'FRAME_LIMIT', transport: 'secure' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('answers RUNTIME_UNAVAILABLE while the host has not configured the helper', async () => {
    authenticate = true;
    configured = undefined;
    const response = await request({ cookie: 'aelix-studio-session=valid' });
    expect(await response.json()).toEqual({
      ok: false,
      code: 'RUNTIME_UNAVAILABLE',
      detail: [RUNTIME_HINT],
      transport: 'secure',
    });
  });

  it('answers UNAVAILABLE, and nothing of the error, when the helper throws', async () => {
    authenticate = true;
    handler.mockRejectedValueOnce(new Error('sentinel-secret'));
    secure = false;
    const response = await request({ cookie: 'aelix-studio-session=valid' });
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(text).not.toContain('sentinel-secret');
    expect(JSON.parse(text)).toEqual({ ok: false, code: 'UNAVAILABLE', transport: 'insecure' });
  });
});
