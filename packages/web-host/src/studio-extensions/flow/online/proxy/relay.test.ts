/**
 * The loopback relay: it takes requests only with its token, signs in to the user's proxy
 * with the user's credentials, and hands back nothing of the proxy's own sign-in answers.
 */
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from 'node:http';
import { connect, createServer as tcpServer, type AddressInfo, type Socket } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createServer as tlsServer } from 'node:tls';
import { afterEach, describe, expect, it } from 'vitest';
import { startProxyRelay, type ProxyRelay, type RelayOptions } from './relay';

/** `%41` is taken as it is now: the relay builds the Basic value itself. */
const LOGIN = { username: 'ops@corp', password: "p@ss:w/rd%41%zz#?& !*'()100%" };
const basic = (user: string, password: string): string =>
  'Basic ' + Buffer.from(`${user}:${password}`).toString('base64');
const SIGNED_IN = basic(LOGIN.username, LOGIN.password);

const listen = async (
  server: Server | ReturnType<typeof tlsServer> | ReturnType<typeof tcpServer>
): Promise<string> => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return '127.0.0.1:' + String((server.address() as AddressInfo).port);
};

/** The token header a client of the relay sends, read from the relay's URL. */
const tokenOf = (relay: ProxyRelay): string => {
  const url = new URL(relay.url);
  return basic(url.username, url.password);
};
const relayAddress = (relay: ProxyRelay): { host: string; port: number } => {
  const url = new URL(relay.url);
  return { host: url.hostname, port: Number(url.port) };
};

/** Read from a socket until the response head (and `extra` more bytes) or its end. */
async function readHead(socket: Socket, extra = 0): Promise<string> {
  let text = '';
  const complete = (): boolean => {
    const end = text.indexOf('\r\n\r\n');
    return end >= 0 && text.length >= end + 4 + extra;
  };
  while (!complete()) {
    // oxlint-disable-next-line no-await-in-loop -- read the response as it arrives
    const [chunk] = (await Promise.race([
      once(socket, 'data'),
      once(socket, 'close').then(() => [Buffer.alloc(0)]),
    ])) as [Buffer];
    if (chunk.length === 0) break;
    text += chunk.toString('latin1');
  }
  return text;
}

/** Send a raw CONNECT and read the status line, keeping the socket for a tunnel. */
async function rawConnect(
  relay: ProxyRelay,
  target: string,
  authorization?: string
): Promise<{ head: string; socket: Socket }> {
  const socket = connect(relayAddress(relay));
  socket.on('error', () => socket.destroy());
  await once(socket, 'connect');
  socket.write(
    `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n` +
      (authorization ? `Proxy-Authorization: ${authorization}\r\n` : '') +
      '\r\n'
  );
  return { head: await readHead(socket), socket };
}

/** An absolute-form GET through the relay. */
function get(
  relay: ProxyRelay,
  url: string,
  authorization?: string
): Promise<{ status: number; reason: string; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      {
        ...relayAddress(relay),
        method: 'GET',
        path: url,
        headers: authorization ? { 'proxy-authorization': authorization } : {},
        agent: false,
      },
      (response) => {
        let body = '';
        response.on('data', (chunk: Buffer) => (body += chunk.toString()));
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            reason: response.statusMessage ?? '',
            headers: response.headers,
            body,
          })
        );
      }
    );
    outgoing.on('error', reject);
    outgoing.end();
  });
}

const closedWithin = async (socket: Socket, ms: number): Promise<boolean> => {
  if (socket.destroyed) return true;
  const timer = new Promise<'open'>((resolve) => setTimeout(() => resolve('open'), ms));
  return (await Promise.race([once(socket, 'close').then(() => 'closed' as const), timer])) === 'closed';
};

describe('the loopback relay of an online install', () => {
  const closers: (() => unknown)[] = [];
  afterEach(async () => {
    for (const close of closers.splice(0).reverse()) await close();
  });
  const start = async (upstream: string, options: RelayOptions = {}): Promise<ProxyRelay> => {
    const relay = await startProxyRelay(upstream, LOGIN, options);
    closers.push(() => relay.close());
    return relay;
  };
  const later = (close: () => unknown): void => {
    closers.push(close);
  };
  /**
   * The user's proxy: records what reaches it. It answers with `answer`'s text, or, for
   * undefined, a 407 that echoes the request's Proxy-Authorization, as a careless proxy might.
   */
  const userProxy = async (
    answer: (kind: 'connect' | 'request', headers: IncomingHttpHeaders, url: string) => string | undefined
  ) => {
    const seen: { kind: string; url: string; headers: IncomingHttpHeaders }[] = [];
    const server = createServer((request, response) => {
      seen.push({ kind: 'request', url: String(request.url), headers: request.headers });
      const body = answer('request', request.headers, String(request.url));
      response
        .writeHead(body === undefined ? 407 : 200, {
          'proxy-authenticate': 'NTLM',
          'proxy-authentication-info': 'nextnonce="abc"',
          'proxy-connection': 'keep-alive',
          'x-upstream-only': 'kept away',
          'content-type': 'text/plain',
        })
        .end(body ?? `refused ${String(request.headers['proxy-authorization'])}`);
    });
    server.on('connect', (request, socket: Socket) => {
      seen.push({ kind: 'connect', url: String(request.url), headers: request.headers });
      socket.on('error', () => socket.destroy());
      const reply = answer('connect', request.headers, String(request.url));
      if (reply === undefined) {
        const echo = `refused ${String(request.headers['proxy-authorization'])}`;
        socket.end(
          'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: NTLM\r\nX-Upstream-Only: kept\r\n' +
            `Content-Length: ${String(echo.length)}\r\n\r\n${echo}`
        );
        return;
      }
      // A tunnel to an echo: whatever the client sends comes back upper-cased.
      socket.write('HTTP/1.1 200 Connection established\r\n\r\n' + reply);
      socket.on('data', (chunk: Buffer) => socket.write(chunk.toString().toUpperCase()));
    });
    const address = 'http://' + (await listen(server));
    later(() => {
      server.closeAllConnections();
      server.close();
    });
    return { address, seen };
  };

  it('listens on loopback only, with a fresh token per relay in its URL, and names its secrets', async () => {
    const upstream = await userProxy(() => '');
    const [one, two] = [await start(upstream.address), await start(upstream.address)];
    expect(one.url).toMatch(/^http:\/\/run:[0-9a-f]{64}@127\.0\.0\.1:[0-9]+$/);
    expect(new URL(one.url).password).not.toBe(new URL(two.url).password);
    for (const piece of ['ops', 'p@ss', encodeURIComponent(LOGIN.password)]) expect(one.url).not.toContain(piece);
    const token = new URL(one.url).password;
    expect(one.secrets).toEqual(
      expect.arrayContaining([token, tokenOf(one).slice('Basic '.length), SIGNED_IN.slice('Basic '.length)])
    );
    for (const secret of one.secrets) expect(secret).not.toMatch(/\s/);
    expect(one.credentialsRejected()).toBe(false);
  });

  it('refuses CONNECT and requests without the token, or with another one, asking for Basic', async () => {
    const upstream = await userProxy(() => '');
    const relay = await start(upstream.address);
    for (const authorization of [undefined, basic('run', 'not-the-token'), SIGNED_IN]) {
      const { head, socket } = await rawConnect(relay, 'repo.example:443', authorization);
      socket.destroy();
      expect(head).toMatch(/^HTTP\/1\.1 407 /);
      expect(head).toContain('Proxy-Authenticate: Basic realm="aelix-studio"');
      const response = await get(relay, 'http://index.example/simple/', authorization);
      expect(response.status).toBe(407);
      expect(response.headers['proxy-authenticate']).toBe('Basic realm="aelix-studio"');
    }
    // Nothing reached the user's proxy.
    expect(upstream.seen).toEqual([]);
  });

  it('tunnels CONNECT through the user proxy, signed in with the credentials as they were given', async () => {
    const upstream = await userProxy((_kind, headers) =>
      headers['proxy-authorization'] === SIGNED_IN ? 'hi ' : undefined
    );
    const relay = await start(upstream.address);
    const { head, socket } = await rawConnect(relay, 'repo.example:443', tokenOf(relay));
    expect(head.startsWith('HTTP/1.1 200 Connection Established\r\n\r\n')).toBe(true);
    let echoed = head.slice(head.indexOf('\r\n\r\n') + 4);
    socket.on('data', (chunk: Buffer) => (echoed += chunk.toString()));
    socket.write('through the tunnel');
    await expect.poll(() => echoed, { timeout: 5000 }).toBe('hi THROUGH THE TUNNEL');
    socket.destroy();
    expect(upstream.seen).toMatchObject([{ kind: 'connect', url: 'repo.example:443' }]);
    expect(upstream.seen[0].headers['proxy-authorization']).toBe(SIGNED_IN);
    expect(upstream.seen[0].headers.host).toBe('repo.example:443');
  });

  it('forwards absolute-form requests, signed in, without the token or the proxy authentication headers', async () => {
    const upstream = await userProxy((_kind, headers) =>
      headers['proxy-authorization'] === SIGNED_IN ? 'index' : undefined
    );
    const relay = await start(upstream.address);
    const response = await get(relay, 'http://index.example/simple/demo/', tokenOf(relay));
    expect(response).toMatchObject({ status: 200, body: 'index' });
    for (const name of ['proxy-authenticate', 'proxy-authentication-info', 'proxy-connection'])
      expect(response.headers[name]).toBeUndefined();
    expect(upstream.seen).toMatchObject([{ kind: 'request', url: 'http://index.example/simple/demo/' }]);
    expect(upstream.seen[0].headers['proxy-authorization']).toBe(SIGNED_IN);
    expect(upstream.seen[0].headers.host).toBe('index.example');
    expect(JSON.stringify(upstream.seen)).not.toContain(new URL(relay.url).password);
  });

  it('answers a refused sign-in itself, with nothing of the proxy answer, and records it', async () => {
    const upstream = await userProxy(() => undefined);
    const relay = await start(upstream.address);
    const { head, socket } = await rawConnect(relay, 'repo.example:443', tokenOf(relay));
    const body = head + (await readHead(socket, 0).catch(() => ''));
    socket.destroy();
    expect(head).toMatch(/^HTTP\/1\.1 502 Proxy Credentials Rejected\r\n/);
    expect(relay.credentialsRejected()).toBe(true);
    const response = await get(relay, 'http://index.example/simple/', tokenOf(relay));
    expect(response).toMatchObject({
      status: 502,
      reason: 'Proxy Credentials Rejected',
      body: 'aelix-studio relay: proxy credentials rejected\n',
    });
    for (const name of ['proxy-authenticate', 'proxy-authentication-info', 'x-upstream-only'])
      expect(response.headers[name]).toBeUndefined();
    // The proxy's echo of the sign-in, and the sign-in itself, stay with the relay.
    for (const text of [body, JSON.stringify(response)]) {
      expect(text).not.toMatch(/NTLM|X-Upstream-Only|refused Basic|Basic realm/i);
      expect(text).not.toContain(SIGNED_IN.slice('Basic '.length));
    }
  });

  it('answers 502 when the user proxy cannot be reached or refuses the tunnel, and 400 for what is not a proxy request', async () => {
    const gone = createServer();
    const address = 'http://' + (await listen(gone));
    gone.close();
    const relay = await start(address, { connectMs: 2000 });
    const { head, socket } = await rawConnect(relay, 'repo.example:443', tokenOf(relay));
    socket.destroy();
    expect(head).toMatch(/^HTTP\/1\.1 502 Proxy Unreachable\r\n/);
    expect(await get(relay, 'http://index.example/', tokenOf(relay))).toMatchObject({
      status: 502,
      reason: 'Proxy Unreachable',
    });
    expect((await get(relay, '/simple/', tokenOf(relay))).status).toBe(400);
    expect((await get(relay, 'https://index.example/', tokenOf(relay))).status).toBe(400);
    const bad = await rawConnect(relay, 'repo.example/path:443', tokenOf(relay));
    bad.socket.destroy();
    expect(bad.head).toMatch(/^HTTP\/1\.1 400 /);
    // A tunnel the proxy will not open: the relay's answer, not the proxy's.
    const forbidding = createServer();
    forbidding.on('connect', (_request, client: Socket) =>
      client.end('HTTP/1.1 403 Forbidden\r\nX-Policy: secret\r\n\r\n')
    );
    const refusing = await start('http://' + (await listen(forbidding)));
    later(() => forbidding.close());
    const refused = await rawConnect(refusing, 'repo.example:443', tokenOf(refusing));
    refused.socket.destroy();
    expect(refused.head).toMatch(/^HTTP\/1\.1 502 Proxy Refused Tunnel\r\n/);
    expect(refused.head).not.toContain('X-Policy');
    expect(refusing.credentialsRejected()).toBe(false);
  });

  it('closes a connection that shows no token in time, and takes only a few such connections at once', async () => {
    const upstream = await userProxy(() => '');
    const quick = await start(upstream.address, { authMs: 200 });
    const silent = connect(relayAddress(quick));
    silent.on('error', () => silent.destroy());
    await once(silent, 'connect');
    expect(await closedWithin(silent, 3000)).toBe(true);

    const capped = await start(upstream.address, { authMs: 30_000, maxPending: 2 });
    const idle = await Promise.all(
      [0, 1, 2].map(async () => {
        const socket = connect(relayAddress(capped));
        socket.on('error', () => socket.destroy());
        await once(socket, 'connect');
        return socket;
      })
    );
    later(() => idle.forEach((socket) => socket.destroy()));
    expect(await closedWithin(idle[2], 3000)).toBe(true);
    expect(await closedWithin(idle[0], 300)).toBe(false);
    // A further connection waits for a free place, token or not.
    const signed = await get(capped, 'http://index.example/', tokenOf(capped)).catch(() => undefined);
    expect(signed).toBeUndefined();
    idle[0].destroy();
    await expect.poll(async () => (await get(capped, 'http://index.example/', tokenOf(capped))).status).toBe(200);
  });

  it('opens only so many connections to the user proxy at once', async () => {
    const upstream = await userProxy(() => '');
    const relay = await start(upstream.address, { maxUpstream: 1 });
    const first = await rawConnect(relay, 'repo.example:443', tokenOf(relay));
    expect(first.head).toMatch(/^HTTP\/1\.1 200 /);
    const second = await rawConnect(relay, 'repo.example:443', tokenOf(relay));
    second.socket.destroy();
    expect(second.head).toMatch(/^HTTP\/1\.1 503 Relay Busy\r\n/);
    expect((await get(relay, 'http://index.example/', tokenOf(relay))).status).toBe(503);
    first.socket.destroy();
    await expect.poll(async () => (await get(relay, 'http://index.example/', tokenOf(relay))).status).toBe(200);
  });

  it('gives a proxy that trickles its answer no longer than the connect time in all', async () => {
    // Bytes keep coming, so an idle timeout alone would never fire.
    const trickling = tcpServer((socket) => {
      socket.on('error', () => socket.destroy());
      const timer = setInterval(() => socket.write('H'), 50);
      socket.on('close', () => clearInterval(timer));
    });
    const relay = await start('http://' + (await listen(trickling)), { connectMs: 400 });
    later(() => trickling.close());
    const started = Date.now();
    const { head, socket } = await rawConnect(relay, 'repo.example:443', tokenOf(relay));
    socket.destroy();
    expect(head).toMatch(/^HTTP\/1\.1 502 Proxy Unreachable\r\n/);
    expect((await get(relay, 'http://index.example/', tokenOf(relay))).status).toBe(502);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('cuts open tunnels and stops listening when closed', async () => {
    const upstream = await userProxy(() => '');
    const relay = await start(upstream.address);
    const { socket } = await rawConnect(relay, 'repo.example:443', tokenOf(relay));
    const ended = once(socket, 'close');
    await relay.close();
    await relay.close();
    await ended;
    const late = connect(relayAddress(relay));
    const [error] = (await once(late, 'error')) as [NodeJS.ErrnoException];
    expect(error.code).toBe('ECONNREFUSED');
  });

  // A certificate for 127.0.0.1 needs openssl, which CI's Linux and macOS runners have.
  const openssl = spawnSync('openssl', ['version'], { encoding: 'utf8' }).status === 0;
  describe.skipIf(!openssl)('to an https: proxy', () => {
    const tlsProxy = async () => {
      const directory = await mkdtemp(path.join(os.tmpdir(), 'studio-relay-tls-'));
      later(() => rm(directory, { recursive: true, force: true }));
      const [key, cert] = [path.join(directory, 'key.pem'), path.join(directory, 'cert.pem')];
      const made = spawnSync(
        'openssl',
        ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1'].concat([
          '-subj',
          '/CN=127.0.0.1',
          '-addext',
          'subjectAltName=IP:127.0.0.1',
        ]),
        { encoding: 'utf8' }
      );
      expect(made.status, made.stderr).toBe(0);
      const pem = { key: await readFile(key, 'utf8'), cert: await readFile(cert, 'utf8') };
      const seen: string[] = [];
      const server = tlsServer(pem, (socket) => {
        socket.on('error', () => socket.destroy());
        socket.once('data', (chunk: Buffer) => {
          seen.push(chunk.toString('latin1'));
          socket.write('HTTP/1.1 200 Connection established\r\n\r\n');
        });
      });
      server.on('tlsClientError', () => {});
      const address = 'https://' + (await listen(server));
      later(() => server.close());
      return { address, seen, cert: pem.cert };
    };

    it('connects over TLS, trusting what it is told to', async () => {
      const proxy = await tlsProxy();
      const relay = await start(proxy.address, { ca: [proxy.cert] });
      const { head, socket } = await rawConnect(relay, 'repo.example:443', tokenOf(relay));
      socket.destroy();
      expect(head).toMatch(/^HTTP\/1\.1 200 /);
      expect(proxy.seen[0]).toContain(`Proxy-Authorization: ${SIGNED_IN}`);
    });

    it('refuses a certificate it does not trust even with NODE_TLS_REJECT_UNAUTHORIZED=0, and sends nothing', async () => {
      const proxy = await tlsProxy();
      const before = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
      try {
        for (const ca of [[], undefined]) {
          const relay = await start(proxy.address, ca ? { ca } : {});
          const { head, socket } = await rawConnect(relay, 'repo.example:443', tokenOf(relay));
          socket.destroy();
          expect(head).toMatch(/^HTTP\/1\.1 502 Proxy Certificate Rejected\r\n/);
          expect(await get(relay, 'http://index.example/', tokenOf(relay))).toMatchObject({
            status: 502,
            reason: 'Proxy Certificate Rejected',
          });
        }
      } finally {
        if (before === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
        else process.env.NODE_TLS_REJECT_UNAUTHORIZED = before;
      }
      expect(proxy.seen).toEqual([]);
    });
  });
});
