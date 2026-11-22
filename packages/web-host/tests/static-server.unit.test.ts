import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os, { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { CookieJar } from 'jsdom';
import { configureStudioExtensions, disposeStudioExtensions, startWebHost } from '../src/index.js';
import { createFakeBundle, fakeRuntime } from './fixtures/extensionRuntime.js';
import { startStaticServer, type StaticServerHandle } from '../src/static-server.js';

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, networkInterfaces: vi.fn<typeof actual.networkInterfaces>(() => ({})) };
});

function setLanAddress(address: string): void {
  vi.mocked(networkInterfaces).mockReturnValue({
    lan: [{ address, family: 'IPv4', internal: false, netmask: '255.255.255.0', cidr: address + '/24', mac: '' }],
  });
}

async function mkRendererFixture(): Promise<string> {
  const dir = await fs.mkdtemp(join(os.tmpdir(), 'ws-static-'));
  await fs.writeFile(join(dir, 'index.html'), '<!doctype html><title>root</title>');
  await fs.mkdir(join(dir, 'assets'));
  await fs.writeFile(join(dir, 'assets', 'main.js'), 'console.log("hi")');
  return dir;
}

async function startMockBackend(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
  port = 0
): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
  return {
    port: (server.address() as AddressInfo).port,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

function requestStatus(
  port: number,
  path: string,
  options: { method?: string; headers?: http.OutgoingHttpHeaders } = {}
): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, ...options }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.setTimeout(3000, () => req.destroy(new Error('HTTP response timeout')));
    req.end();
  });
}

describe('static-server', () => {
  let handle: StaticServerHandle | null = null;
  let stopBackend: (() => Promise<void>) | null = null;
  let staticDir = '';

  beforeEach(async () => {
    staticDir = await mkRendererFixture();
  });

  afterEach(async () => {
    if (handle) {
      await handle.stop();
      handle = null;
    }
    if (stopBackend) {
      await stopBackend();
      stopBackend = null;
    }
    vi.unstubAllEnvs();
    vi.mocked(networkInterfaces).mockReset();
    await fs.rm(staticDir, { recursive: true, force: true });
  });

  it('serves static index.html at /', async () => {
    const backend = await startMockBackend((_req, res) => res.end('nope'));
    stopBackend = backend.close;
    handle = await startStaticServer({ staticDir, backendPort: backend.port, port: 0 });
    const r = await fetch(`${handle.localUrl}/`);
    expect(r.status).toBe(200);
    const text = await r.text();
    expect(text).toContain('<title>root</title>');
  });

  it('runs at the Studio default while upstream occupies 25808, and rejects the upstream browser origin', async () => {
    vi.stubEnv('AELIX_STUDIO_ORIGIN', undefined);
    const upstream = await startMockBackend((_req, res) => res.end('upstream fixture'), 25808);
    const backend = await startMockBackend((req, res) => {
      res.writeHead(req.headers.cookie === 'aionui-session=studio-cookie' ? 200 : 401).end();
    });
    stopBackend = backend.close;
    try {
      handle = await startStaticServer({ staticDir, backendPort: backend.port });
      expect(handle.localUrl).toBe('http://[::1]:25982');
      expect(await (await fetch('http://127.0.0.1:25808')).text()).toBe('upstream fixture');
      expect(await (await fetch(handle.localUrl)).text()).toContain('<title>root</title>');
      const login = (origin: string, cookie: string) =>
        requestStatus(handle!.port, '/login', {
          method: 'POST',
          headers: { host: new URL(handle!.localUrl).host, origin, cookie, 'sec-fetch-site': 'same-origin' },
        });
      expect(await login('http://127.0.0.1:25808', 'aelix-studio-session=studio-cookie')).toBe(403);
      expect(await login(handle.localUrl, 'aionui-session=studio-cookie')).toBe(401);
      expect(await login(handle.localUrl, 'aelix-studio-session=studio-cookie')).toBe(200);
    } finally {
      await upstream.close();
    }
  });

  it('separates login, refresh and logout cookies even in one browser cookie jar', async () => {
    const legacy = (value: string, expire = false) => [
      'aionui-session=' + value + '; Path=/; HttpOnly; SameSite=Lax' + (expire ? '; Max-Age=0' : ''),
      'aionui-refresh=' + value + '; Path=/api/auth/refresh; HttpOnly; SameSite=Lax' + (expire ? '; Max-Age=0' : ''),
    ];
    const heard: (string | undefined)[] = [];
    const backend = await startMockBackend((req, res) => {
      heard.push(req.headers.cookie);
      res
        .writeHead(200, {
          'set-cookie': legacy(req.url === '/api/auth/refresh' ? 'rotated' : 'studio', req.url === '/logout'),
        })
        .end();
    });
    stopBackend = backend.close;
    handle = await startStaticServer({ staticDir, backendPort: backend.port, port: 0 });
    const studio = handle.localUrl;
    const upstream = 'http://127.0.0.1:25808';
    const jar = new CookieJar();
    for (const cookie of legacy('upstream')) await jar.setCookie(cookie, upstream + '/login');
    const send = async (pathname: string) => {
      const url = studio + pathname;
      const response = await fetch(url, {
        method: 'POST',
        headers: { origin: studio, cookie: await jar.getCookieString(url) },
      });
      expect(response.status).toBe(200);
      for (const cookie of response.headers.getSetCookie()) await jar.setCookie(cookie, url);
    };
    await send('/login');
    expect(await jar.getCookieString(studio + '/api/auth/user')).toBe('aelix-studio-session=studio');
    expect(await jar.getCookieString(studio + '/api/auth/refresh', { http: false })).toBe('');
    expect(await jar.getCookieString(upstream + '/api/auth/refresh')).toBe(
      'aionui-refresh=upstream; aionui-session=upstream'
    );
    await send('/api/auth/refresh');
    expect(await jar.getCookieString(studio + '/api/auth/user')).toBe('aelix-studio-session=rotated');
    await send('/logout');
    expect(await jar.getCookieString(studio + '/api/auth/refresh')).toBe('');
    expect(await jar.getCookieString(upstream + '/api/auth/refresh')).toBe(
      'aionui-refresh=upstream; aionui-session=upstream'
    );
    expect(heard).toEqual([undefined, 'aionui-session=studio; aionui-refresh=studio', 'aionui-session=rotated']);
  });

  it('redirects shared loopback navigation and withholds auth cookies on its raw alias', async () => {
    let backendCookie: string | undefined;
    const backend = await startMockBackend((req, res) => {
      backendCookie = req.headers.cookie;
      res.writeHead(200, { 'set-cookie': 'aionui-session=synthetic; Path=/; HttpOnly' }).end();
    });
    stopBackend = backend.close;
    handle = await startStaticServer({ staticDir, backendPort: backend.port, port: 0 });
    const alias = 'http://127.0.0.1:' + handle.port;
    const page = await fetch(alias + '/login', { headers: { accept: 'text/html' }, redirect: 'manual' });
    expect(page.headers.get('location')).toBe(handle.localUrl + '/login');
    const raw = await fetch(alias + '/login', {
      method: 'POST',
      headers: { origin: alias, cookie: 'aionui-session=foreign; aelix-studio-session=forged' },
    });
    expect(raw.headers.getSetCookie()).toEqual([]);
    expect(backendCookie).toBeUndefined();
  });

  it('keeps a configured localhost proxy on its own authority for navigation and login', async () => {
    const origin = 'http://localhost:28443';
    vi.stubEnv('AELIX_STUDIO_ORIGIN', origin);
    const backend = await startMockBackend((_req, res) => {
      res.writeHead(200, { 'set-cookie': 'aionui-session=proxy-session; Path=/; HttpOnly' }).end();
    });
    stopBackend = backend.close;
    handle = await startStaticServer({ staticDir, backendPort: backend.port, port: 0 });
    const host = new URL(origin).host;
    const response = (method: string, path: string) =>
      new Promise<{ status?: number; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
        const req = http.request(
          { host: '127.0.0.1', port: handle!.port, path, method, headers: { host, origin, accept: 'text/html' } },
          (res) => {
            res.resume();
            resolve({ status: res.statusCode, headers: res.headers });
          }
        );
        req.once('error', reject).end();
      });
    const home = await response('GET', '/');
    expect(home.status).toBe(200);
    expect(home.headers.location).toBeUndefined();
    const login = await response('POST', '/login');
    expect(login.headers['set-cookie']).toEqual(['aelix-studio-session=proxy-session; Path=/; HttpOnly; SameSite=Lax']);
  });

  it('keeps IPv4 WebUI usable if the same IPv6 loopback port is occupied', async () => {
    const occupied = net.createServer();
    await new Promise<void>((resolve, reject) => {
      occupied.once('error', reject);
      occupied.listen({ host: '::1', port: 0, ipv6Only: true }, resolve);
    });
    try {
      const backend = await startMockBackend((req, res) => {
        res.writeHead(200, { 'set-cookie': 'aionui-session=fallback; Path=/; HttpOnly' }).end(req.headers.cookie);
      });
      stopBackend = backend.close;
      const port = (occupied.address() as AddressInfo).port;
      handle = await startStaticServer({ staticDir, backendPort: backend.port, port });
      expect(handle.localUrl).toBe('http://127.0.0.1:' + port);
      const login = await fetch(handle.localUrl + '/login', {
        method: 'POST',
        headers: { origin: handle.localUrl, cookie: 'aionui-session=foreign; aelix-studio-session=studio' },
      });
      expect(await login.text()).toBe('aionui-session=studio');
      expect(login.headers.getSetCookie()[0]).toContain('aelix-studio-session=fallback');
    } finally {
      await new Promise<void>((resolve) => occupied.close(() => resolve()));
    }
  });

  it('applies secure HTTPS attributes only for the configured origin and drops Domain', async () => {
    const origin = 'https://studio.example.test';
    vi.stubEnv('AELIX_STUDIO_ORIGIN', origin);
    const backend = await startMockBackend((_req, res) => {
      res
        .writeHead(200, {
          'set-cookie': [
            'aionui-session=session; Domain=example.test; Path=/other; Max-Age=30',
            'aionui-csrf-token=csrf; Domain=example.test; Path=/; HttpOnly',
            'aionui-refresh=refresh; Path=/; HttpOnly; Max-Age=0',
          ],
        })
        .end();
    });
    stopBackend = backend.close;
    handle = await startStaticServer({ staticDir, backendPort: backend.port, port: 0 });
    expect(
      await requestStatus(handle.port, '/login', {
        method: 'POST',
        headers: { host: 'studio.example.test:' + handle.port, origin },
      })
    ).toBe(403);
    // Hit the listener while simulating the exact authority a configured HTTPS proxy preserves.
    const raw = await new Promise<string[] | undefined>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: handle!.port,
          path: '/login',
          method: 'POST',
          headers: { host: 'studio.example.test', origin },
        },
        (res) => {
          res.resume();
          resolve(res.headers['set-cookie']);
        }
      );
      req.once('error', reject).end();
    });
    expect(raw).toEqual([
      'aelix-studio-session=session; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=30',
      'aelix-studio-csrf-token=csrf; Path=/; SameSite=Strict; Secure',
      'aelix-studio-refresh=refresh; Path=/api/auth/refresh; HttpOnly; SameSite=Strict; Secure; Max-Age=0',
    ]);
    const spoof = await fetch(handle.localUrl + '/login', {
      method: 'POST',
      headers: { origin: handle.localUrl, 'x-forwarded-proto': 'https' },
    });
    expect(spoof.headers.getSetCookie()[0]).toBe(
      'aelix-studio-session=session; Path=/; HttpOnly; SameSite=Lax; Max-Age=30'
    );
  });

  it('SPA fallback: /chat/123 returns index.html', async () => {
    const backend = await startMockBackend((_req, res) => res.end('nope'));
    stopBackend = backend.close;
    handle = await startStaticServer({ staticDir, backendPort: backend.port, port: 0 });
    const r = await fetch(`${handle.localUrl}/chat/123`);
    expect(r.status).toBe(200);
    expect(await r.text()).toContain('<title>root</title>');
  });

  it('static asset /assets/main.js served', async () => {
    const backend = await startMockBackend((_req, res) => res.end('nope'));
    stopBackend = backend.close;
    handle = await startStaticServer({ staticDir, backendPort: backend.port, port: 0 });
    const r = await fetch(`${handle.localUrl}/assets/main.js`);
    expect(r.status).toBe(200);
    expect(await r.text()).toContain('hi');
  });

  describe('request source checks', () => {
    let backendRequests = 0;

    beforeEach(async () => {
      backendRequests = 0;
      vi.stubEnv('AELIX_STUDIO_ORIGIN', undefined);
      const backend = await startMockBackend((_req, res) => {
        backendRequests += 1;
        res.end('backend response');
      });
      stopBackend = backend.close;
      handle = await startStaticServer({ staticDir, backendPort: backend.port, port: 0 });
    });

    it.each(['/api/anything', '/', '/client/route', '/assets/main.js'])(
      'requires an allowed Host for %s',
      async (path) => {
        const server = handle!;
        expect(await requestStatus(server.port, path, { headers: { host: 'unlisted.invalid:' + server.port } })).toBe(
          403
        );
        expect(backendRequests).toBe(0);
      }
    );

    it.each(['/api/anything', '/', '/assets/main.js'])(
      'requires an allowed Origin when supplied for %s',
      async (path) => {
        const server = handle!;
        expect(await requestStatus(server.port, path, { headers: { origin: 'http://unlisted.invalid' } })).toBe(403);
        expect(backendRequests).toBe(0);
      }
    );

    it('denies a cross-site asset request without an Origin', async () => {
      expect(
        await requestStatus(handle!.port, '/assets/main.js', { headers: { 'sec-fetch-site': 'cross-site' } })
      ).toBe(403);
    });

    it('accepts case-insensitive localhost with the actual port', async () => {
      const { port } = handle!;
      const headers = { host: 'LOCALHOST:' + port, origin: 'http://LocalHost:' + port };
      expect(await requestStatus(port, '/api/anything', { headers })).toBe(200);
    });

    it.each(['localhost', 'localhost:1', '[::1]', '[::1]:1', '[::ffff:127.0.0.1]', '127.0.0.1.'])(
      'rejects unbound Host authority %s',
      async (host) => {
        expect(await requestStatus(handle!.port, '/', { headers: { host } })).toBe(403);
      }
    );

    it('rejects non-loopback IPv6 authorities', async () => {
      const { port } = handle!;
      expect(await requestStatus(port, '/', { headers: { host: '[2001:db8::1]:' + port } })).toBe(403);
    });

    it('rejects mixing two individually allowed authorities', async () => {
      const server = handle!;
      expect(
        await requestStatus(server.port, '/api/anything', {
          headers: { host: 'localhost:' + server.port, origin: server.localUrl },
        })
      ).toBe(403);
    });

    it('requires a same-origin value on state-changing requests', async () => {
      const server = handle!;
      expect(await requestStatus(server.port, '/api/anything', { method: 'POST' })).toBe(403);
      expect(await requestStatus(server.port, '/api/anything', { method: 'POST', headers: { origin: 'null' } })).toBe(
        403
      );
      expect(backendRequests).toBe(0);
    });

    it('rejects cross-origin preflight before forwarding', async () => {
      const server = handle!;
      const headers = { origin: 'http://unlisted.invalid', 'access-control-request-method': 'POST' };
      expect(await requestStatus(server.port, '/api/anything', { method: 'OPTIONS', headers })).toBe(403);
      expect(backendRequests).toBe(0);
    });

    it('handles same-origin OPTIONS locally', async () => {
      const server = handle!;
      expect(
        await requestStatus(server.port, '/api/anything', {
          method: 'OPTIONS',
          headers: { host: new URL(server.localUrl).host, origin: server.localUrl },
        })
      ).toBe(204);
      expect(backendRequests).toBe(0);
    });
  });

  it('accepts a configured proxy origin only with its matching Host', async () => {
    vi.stubEnv('AELIX_STUDIO_ORIGIN', 'https://[2001:db8::1]:8443');
    const backend = await startMockBackend((_req, res) => res.end('backend response'));
    stopBackend = backend.close;
    handle = await startStaticServer({ staticDir, backendPort: backend.port, port: 0 });

    const origin = 'https://[2001:db8::1]:8443';
    expect(await requestStatus(handle.port, '/', { headers: { host: '[2001:DB8::1]:8443', origin } })).toBe(200);
    expect(await requestStatus(handle.port, '/', { headers: { host: '[2001:db8::1]:8444', origin } })).toBe(403);
  });

  it('/api/* reverse-proxies to backend', async () => {
    const backend = await startMockBackend((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ path: req.url, method: req.method }));
    });
    stopBackend = backend.close;
    handle = await startStaticServer({ staticDir, backendPort: backend.port, port: 0 });
    const r = await fetch(`${handle.localUrl}/api/anything`);
    expect(r.status).toBe(200);
    const json = (await r.json()) as { path: string };
    expect(json.path).toBe('/api/anything');
  });

  it('keeps proxy metadata and CORS decisions at the WebUI listener', async () => {
    const backend = await startMockBackend((req, res) => {
      res.writeHead(200, { 'access-control-allow-origin': '*' });
      res.end(JSON.stringify(req.headers));
    });
    stopBackend = backend.close;
    handle = await startStaticServer({ staticDir, backendPort: backend.port, port: 0 });
    const response = await fetch(handle.localUrl + '/api/anything', {
      headers: {
        'x-forwarded-for': '192.0.2.1',
        'x-aionui-internal': '1',
        'x-aionui-studio-auth': 'synthetic-credential',
      },
    });
    const headers = (await response.json()) as Record<string, unknown>;
    expect(headers['x-forwarded-for']).toBeUndefined();
    expect(headers['x-aionui-internal']).toBeUndefined();
    expect(headers['x-aionui-studio-auth']).toBeUndefined();
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('shares the backend login rate limit between clients behind a configured reverse proxy', async () => {
    const host = 'studio.example.test';
    const origin = 'https://' + host;
    vi.stubEnv('AELIX_STUDIO_ORIGIN', origin);
    const failuresByIP = new Map<string, number>();
    const backend = await startMockBackend((req, res) => {
      // The pinned host uses the first forwarded IP, then x-real-ip, then "unknown".
      const ip = req.headers['x-forwarded-for']?.toString().split(',')[0] || req.headers['x-real-ip']?.toString();
      const key = ip || 'unknown';
      const failures = failuresByIP.get(key) ?? 0;
      if (failures >= 5) {
        res.writeHead(429).end();
        return;
      }
      failuresByIP.set(key, failures + 1);
      res.writeHead(401).end();
    });
    stopBackend = backend.close;
    handle = await startStaticServer({ staticDir, backendPort: backend.port, port: 0 });

    const login = (ip: string) =>
      requestStatus(handle!.port, '/login', {
        method: 'POST',
        headers: {
          host,
          origin,
          forwarded: 'for=' + ip,
          'x-forwarded-for': ip,
          'x-real-ip': ip,
        },
      });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(await login('192.0.2.1')).toBe(401);
    }
    expect(await login('192.0.2.2')).toBe(429);
    expect([...failuresByIP]).toEqual([['unknown', 5]]);
  });

  it('/login reverse-proxies to backend (no local handler)', async () => {
    const backend = await startMockBackend((req, res) => {
      if (req.url === '/login' && req.method === 'POST') {
        res.writeHead(200, {
          'content-type': 'application/json',
          'set-cookie': 'aionui-session=backend-token; Path=/; HttpOnly',
        });
        res.end(JSON.stringify({ success: true, proxied: true }));
        return;
      }
      res.writeHead(404).end();
    });
    stopBackend = backend.close;
    handle = await startStaticServer({ staticDir, backendPort: backend.port, port: 0 });

    const r = await fetch(`${handle.localUrl}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: handle.localUrl },
      body: JSON.stringify({ username: 'admin', password: 'anything' }),
    });
    expect(r.status).toBe(200);
    expect(r.headers.get('set-cookie')).toMatch(/aelix-studio-session=backend-token; Path=\/; HttpOnly; SameSite=Lax/);
    const json = (await r.json()) as { proxied: boolean };
    expect(json.proxied).toBe(true);
  });

  it('/api/auth/user reverse-proxies to backend (no local handler)', async () => {
    const backend = await startMockBackend((req, res) => {
      if (req.url === '/api/auth/user' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ success: true, user: { username: 'from-backend', id: 'from-backend' } }));
        return;
      }
      res.writeHead(404).end();
    });
    stopBackend = backend.close;
    handle = await startStaticServer({ staticDir, backendPort: backend.port, port: 0 });

    const r = await fetch(`${handle.localUrl}/api/auth/user`);
    expect(r.status).toBe(200);
    const json = (await r.json()) as { user: { username: string } };
    expect(json.user.username).toBe('from-backend');
  });

  it('answers the extension helper route itself, as the signed-in user, and stops WebUI changes with it', async () => {
    const forwarded: string[] = [];
    const backend = await startMockBackend((req, res) => {
      if (req.url === '/api/auth/user') {
        res.writeHead(req.headers.cookie === 'aionui-session=valid' ? 200 : 401, {
          'content-type': 'application/json',
        });
        res.end(JSON.stringify({ success: true, user: { id: 'operator' } }));
        return;
      }
      forwarded.push(String(req.url));
      res.writeHead(404).end();
    });
    stopBackend = backend.close;
    const scratch = await fs.mkdtemp(join(os.tmpdir(), 'studio-static-extensions-'));
    try {
      const bundle = await createFakeBundle(join(scratch, 'bundle'));
      const service = configureStudioExtensions({
        userDataPath: join(scratch, 'user data'),
        runtime: bundle,
        service: { spawn: fakeRuntime({ bundle }) },
      });
      const request = vi.spyOn(service, 'request');
      const cancel = vi.spyOn(service, 'cancelOwner');
      handle = await startStaticServer({ staticDir, backendPort: backend.port, port: 0 });
      const origin = handle.localUrl;
      const response = await fetch(`${origin}/api/studio/extensions`, {
        method: 'POST',
        headers: {
          origin,
          'content-type': 'application/json',
          'x-studio-extensions': '1',
          cookie: 'aelix-studio-session=valid',
        },
        body: JSON.stringify({ action: 'get_settings' }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ ok: true, data: { credentialMode: 'memory-only' } });
      expect(request).toHaveBeenCalledWith('web:operator', { action: 'get_settings' });
      expect(forwarded).toEqual([]);
      await handle.stop();
      handle = null;
      expect(cancel).toHaveBeenCalledWith('web:', true);
    } finally {
      await disposeStudioExtensions();
      await fs.rm(scratch, { recursive: true, force: true });
    }
  });

  it('/logout reverse-proxies to backend (no local handler)', async () => {
    const backend = await startMockBackend((req, res) => {
      if (req.url === '/logout' && req.method === 'POST') {
        res.writeHead(200, {
          'content-type': 'application/json',
          'set-cookie': 'aionui-session=; Path=/; Max-Age=0',
        });
        res.end(JSON.stringify({ success: true, proxied: true }));
        return;
      }
      res.writeHead(404).end();
    });
    stopBackend = backend.close;
    handle = await startStaticServer({ staticDir, backendPort: backend.port, port: 0 });

    const r = await fetch(`${handle.localUrl}/logout`, {
      method: 'POST',
      headers: { origin: handle.localUrl },
    });
    expect(r.status).toBe(200);
    expect(r.headers.get('set-cookie')).toMatch(/Max-Age=0/);
  });

  it('/api proxy returns 502 when backend unreachable', async () => {
    // allocate a port then free it
    const placeholder = await startMockBackend((_req, res) => res.end());
    const freePort = placeholder.port;
    await placeholder.close();

    handle = await startStaticServer({ staticDir, backendPort: freePort, port: 0 });
    const r = await fetch(`${handle.localUrl}/api/anything`);
    expect(r.status).toBe(502);
  });

  describe('WebSocket upgrades', () => {
    const wsHeaders = {
      Connection: 'Upgrade',
      Upgrade: 'websocket',
      'Sec-WebSocket-Version': '13',
      'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
    };
    const paths = ['/ws', '/api/stt/stream', '/api/stt/stream?lang=en&model=default'];
    const handshake = Buffer.from(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=',
        '\r\n',
      ].join('\r\n')
    );
    const firstFrame = Buffer.from('\x81\x05hello', 'latin1');
    const replyFrame = Buffer.from('\x81\x04pong', 'latin1');
    const mask = Buffer.from([1, 2, 3, 4]);
    const maskedPayload = Buffer.from('ping').map((byte, index) => byte ^ mask[index]);
    const clientFrame = Buffer.concat([Buffer.from([0x81, 0x84]), mask, maskedPayload]);

    function connectUpgrade(path: string, headers: Record<string, string>): net.Socket {
      const lines = Object.entries({ ...wsHeaders, ...headers }).map(([name, value]) => name + ': ' + value);
      const sock = net.connect({ host: '127.0.0.1', port: handle!.port }, () => {
        // Send the request line before the rest of the handshake.
        sock.write('GET ' + path + ' HTTP/1.1\r\n');
        setImmediate(() => sock.write([...lines, '\r\n'].join('\r\n')));
      });
      sock.setTimeout(3000, () => sock.destroy(new Error('WebSocket response timeout')));
      return sock;
    }

    async function upgrade(path: string, headers: Record<string, string>): Promise<string> {
      return new Promise((resolve, reject) => {
        const sock = connectUpgrade(path, headers);
        let response = '';
        sock.on('data', (chunk) => {
          response += chunk.toString('latin1');
          if (!response.includes('\r\n\r\n')) return;
          sock.destroy();
          resolve(response.split('\r\n')[0]);
        });
        sock.on('error', reject);
        sock.once('close', () => reject(new Error('WebSocket closed before the handshake')));
      });
    }

    let backendUpgrades = 0;
    let upgradeCookie: string | undefined;
    let upgradeCredential: string | string[] | undefined;

    beforeEach(async () => {
      backendUpgrades = 0;
      upgradeCredential = undefined;
      const server = http.createServer();
      const upstreamSockets = new Set<Duplex>();
      server.on('upgrade', (req, socket) => {
        backendUpgrades += 1;
        upgradeCredential = req.headers['x-aionui-studio-auth'];
        upgradeCookie = req.headers.cookie;
        upstreamSockets.add(socket);
        socket.once('close', () => upstreamSockets.delete(socket));
        socket.once('error', () => socket.destroy());
        socket.write(Buffer.concat([handshake, firstFrame]));
        let received = Buffer.alloc(0);
        socket.on('data', (chunk: Buffer) => {
          received = Buffer.concat([received, chunk]);
          if (received.equals(clientFrame)) socket.write(replyFrame);
        });
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      stopBackend = () => {
        for (const socket of upstreamSockets) socket.destroy();
        return new Promise<void>((resolve) => server.close(() => resolve()));
      };
      handle = await startStaticServer({
        staticDir,
        backendPort: (server.address() as AddressInfo).port,
        port: 0,
        allowRemote: true,
      });
    });

    it.each(paths)('does not forward internal credentials over %s', async (path) => {
      expect(
        await upgrade(path, {
          Host: new URL(handle!.localUrl).host,
          Origin: handle!.localUrl,
          'X-AionUI-Studio-Auth': 'synthetic-launch-credential',
        })
      ).toContain(' 101 ');
      expect(backendUpgrades).toBe(1);
      expect(upgradeCredential).toBeUndefined();
    });

    it('maps Studio session cookies and drops foreign and off-path refresh cookies', async () => {
      const headers = { Host: new URL(handle!.localUrl).host, Origin: handle!.localUrl };
      expect(
        await upgrade('/ws', { ...headers, Cookie: 'aionui-session=foreign; aelix-studio-refresh=off-path' })
      ).toContain(' 101 ');
      expect(upgradeCookie).toBeUndefined();
      expect(
        await upgrade('/ws', { ...headers, Cookie: 'aionui-session=foreign; aelix-studio-session=studio' })
      ).toContain(' 101 ');
      expect(upgradeCookie).toBe('aionui-session=studio');
    });

    it.each(paths)('relays the first server frame and a round trip for %s', async (path) => {
      const server = handle!;
      const sock = connectUpgrade(path, {
        Host: 'LOCALHOST:' + server.port,
        Origin: 'http://localhost:' + server.port,
      });
      try {
        const payload = await new Promise<Buffer>((resolve, reject) => {
          let response = Buffer.alloc(0);
          let sent = false;
          sock.on('data', (chunk: Buffer) => {
            response = Buffer.concat([response, chunk]);
            const headerEnd = response.indexOf('\r\n\r\n');
            if (headerEnd < 0) return;
            if (!response.subarray(0, headerEnd).toString('latin1').startsWith('HTTP/1.1 101 ')) {
              reject(new Error('Expected a WebSocket 101 response'));
              return;
            }
            const frames = response.subarray(headerEnd + 4);
            if (frames.length >= firstFrame.length && !sent) {
              sent = true;
              sock.write(clientFrame);
            }
            if (frames.length >= firstFrame.length + replyFrame.length) resolve(frames);
          });
          sock.once('error', reject);
          sock.once('close', () => reject(new Error('WebSocket closed before both frames arrived')));
        });
        expect(payload).toEqual(Buffer.concat([firstFrame, replyFrame]));
      } finally {
        sock.destroy();
      }
      expect(backendUpgrades).toBe(1);
    });

    it('accepts a new LAN authority after startup and rejects it when removed', async () => {
      const host = '192.168.40.23:' + handle!.port;
      const headers = { Host: host, Origin: 'http://' + host };
      expect(await upgrade('/ws', headers)).toMatch(/HTTP\/1\.1 403/);
      setLanAddress('192.168.40.23');
      vi.mocked(networkInterfaces).mockImplementationOnce(() => {
        throw new Error('Interface lookup unavailable');
      });
      expect(await upgrade('/ws', headers)).toMatch(/HTTP\/1\.1 403/);
      expect(await upgrade('/ws', headers)).toMatch(/HTTP\/1\.1 101/);
      setLanAddress('192.168.41.46');
      expect(await upgrade('/ws', headers)).toMatch(/HTTP\/1\.1 403/);
    });

    it.each(paths)('rejects an upgrade from a different origin for %s', async (path) => {
      expect(await upgrade(path, { Host: '127.0.0.1:' + handle!.port, Origin: 'https://unlisted.invalid' })).toMatch(
        /HTTP\/1\.1 403/
      );
      expect(backendUpgrades).toBe(0);
    });

    it('requires Origin on an upgrade', async () => {
      expect(await upgrade('/ws', { Host: '127.0.0.1:' + handle!.port })).toMatch(/HTTP\/1\.1 403/);
      expect(backendUpgrades).toBe(0);
    });

    it('rejects a different Host even with a valid Origin', async () => {
      const server = handle!;
      expect(await upgrade('/ws', { Host: 'unlisted.invalid:' + server.port, Origin: server.localUrl })).toMatch(
        /HTTP\/1\.1 403/
      );
      expect(backendUpgrades).toBe(0);
    });
  });

  it.each([false, true])('forwards a large upload (Expect: 100-continue %s)', async (expectContinue) => {
    // Regression for #4058: WebUI uploads hang forever at 100%. When the routing
    // decision fired on the first chunk, the pre-router removed its 'data'
    // listener but left the socket in flowing mode; body bytes arriving before
    // the async `client.pipe(upstream)` was wired had no consumer and were
    // silently dropped. The backend then waited forever for the missing bytes,
    // so the browser upload sat at 100% and never returned. A body large enough
    // to span multiple TCP segments reproduces the race deterministically.
    const BODY_LEN = 512 * 1024; // 512 KB — spans several TCP segments

    const backend = await startMockBackend((req, res) => {
      let received = 0;
      req.on('data', (chunk: Buffer) => {
        received += chunk.length;
      });
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ received }));
      });
    });
    stopBackend = backend.close;
    handle = await startStaticServer({ staticDir, backendPort: backend.port, port: 0 });

    const { port: publicPort } = handle;
    const body = Buffer.alloc(BODY_LEN, 0x61); // 512 KB of 'a'

    const received: number = await new Promise((resolve, reject) => {
      const request = http.request(
        {
          host: '127.0.0.1',
          port: publicPort,
          method: 'POST',
          path: '/api/fs/upload',
          headers: {
            host: new URL(handle!.localUrl).host,
            origin: handle!.localUrl,
            'content-type': 'application/octet-stream',
            'content-length': BODY_LEN,
            ...(expectContinue ? { expect: '100-continue' } : {}),
          },
        },
        (res) => {
          let raw = '';
          res.setEncoding('utf8');
          res.on('data', (c) => {
            raw += c;
          });
          res.on('end', () => {
            try {
              resolve((JSON.parse(raw) as { received: number }).received);
            } catch (e) {
              reject(e as Error);
            }
          });
        }
      );
      request.on('error', reject);
      request.setTimeout(5000, () => {
        request.destroy(new Error('timeout: backend never received the full body (bytes dropped in splice)'));
      });
      if (expectContinue) {
        request.once('continue', () => request.end(body));
        request.flushHeaders();
      } else {
        request.end(body);
      }
    });

    expect(received).toBe(BODY_LEN);
  });

  it('rejects a LAN authority when remote access is disabled', async () => {
    const backend = await startMockBackend((_req, res) => res.end('nope'));
    stopBackend = backend.close;
    setLanAddress('192.168.40.23');
    handle = await startStaticServer({ staticDir, backendPort: backend.port, port: 0 });
    expect(handle.networkUrl).toBeUndefined();
    expect(await requestStatus(handle.port, '/', { headers: { host: '192.168.40.23:' + handle.port } })).toBe(403);
  });

  it('refreshes the network URL and HTTP authorities after an interface change', async () => {
    const backend = await startMockBackend((_req, res) => res.end('backend response'));
    stopBackend = backend.close;
    setLanAddress('192.168.40.23');
    const webHost = await startWebHost({
      app: { version: 'test', isPackaged: false, resourcesPath: '', userDataPath: '' },
      staticDir,
      backend: { kind: 'useExistingBackend', port: backend.port },
      port: 0,
      allowRemote: true,
    });
    handle = webHost;
    const oldHost = '192.168.40.23:' + webHost.port;
    const newHost = '192.168.41.46:' + webHost.port;
    const postFrom = (host: string) =>
      requestStatus(webHost.port, '/api/anything', { method: 'POST', headers: { host, origin: 'http://' + host } });

    expect(webHost.networkUrl).toBe('http://' + oldHost);
    expect(await postFrom(oldHost)).toBe(200);
    expect(await postFrom(newHost)).toBe(403);
    setLanAddress('192.168.41.46');
    expect(webHost.networkUrl).toBe('http://' + newHost);
    expect(await postFrom(newHost)).toBe(200);
    expect(await postFrom(oldHost)).toBe(403);
  });
});
