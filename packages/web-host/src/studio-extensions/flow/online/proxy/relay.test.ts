/**
 * The loopback relay: it takes requests only with its token, signs in to the user's proxy
 * with the user's credentials, and hands back nothing of the proxy's own headers.
 */
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from 'node:http';
import { connect, type AddressInfo, type Socket } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createServer as tlsServer } from 'node:tls';
import { afterEach, describe, expect, it } from 'vitest';
import { startProxyRelay, type ProxyRelay } from './relay';

const LOGIN = { username: 'ops@corp', password: "p@ss:w/rd%zz#?& !*'()100%" };
const basic = (user: string, password: string): string =>
  'Basic ' + Buffer.from(`${user}:${password}`).toString('base64');
const SIGNED_IN = basic(LOGIN.username, LOGIN.password);

const listen = async (server: Server | ReturnType<typeof tlsServer>): Promise<string> => {
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

/** Send a raw CONNECT and read the status line, keeping the socket for a tunnel. */
async function rawConnect(
  relay: ProxyRelay,
  target: string,
  authorization?: string
): Promise<{ head: string; socket: Socket }> {
  const socket = connect(relayAddress(relay));
  await once(socket, 'connect');
  socket.write(
    `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n` +
      (authorization ? `Proxy-Authorization: ${authorization}\r\n` : '') +
      '\r\n'
  );
  let text = '';
  while (!text.includes('\r\n\r\n')) {
    // oxlint-disable-next-line no-await-in-loop -- read the response head as it arrives
    const [chunk] = (await Promise.race([once(socket, 'data'), once(socket, 'end').then(() => [Buffer.alloc(0)])])) as [
      Buffer,
    ];
    if (chunk.length === 0) break;
    text += chunk.toString('latin1');
  }
  return { head: text, socket };
}

/** An absolute-form GET through the relay. */
function get(
  relay: ProxyRelay,
  url: string,
  authorization?: string
): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
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
        response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body }));
      }
    );
    outgoing.on('error', reject);
    outgoing.end();
  });
}

describe('the loopback relay of an online install', () => {
  const closers: (() => unknown)[] = [];
  afterEach(async () => {
    for (const close of closers.splice(0).reverse()) await close();
  });
  const start = async (upstream: string, options = {}): Promise<ProxyRelay> => {
    const relay = await startProxyRelay(upstream, LOGIN, options);
    closers.push(() => relay.close());
    return relay;
  };
  /** The user's proxy: records what reaches it and answers with `answer`. */
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
          'x-upstream-only': 'kept away',
          'content-type': 'text/plain',
        })
        .end(body ?? '');
    });
    server.on('connect', (request, socket: Socket) => {
      seen.push({ kind: 'connect', url: String(request.url), headers: request.headers });
      socket.on('error', () => socket.destroy());
      const reply = answer('connect', request.headers, String(request.url));
      if (reply === undefined) {
        socket.end(
          'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: NTLM\r\nX-Upstream-Only: kept\r\n\r\n'
        );
        return;
      }
      // A tunnel to an echo: whatever the client sends comes back upper-cased.
      socket.write('HTTP/1.1 200 Connection established\r\n\r\n' + reply);
      socket.on('data', (chunk: Buffer) => socket.write(chunk.toString().toUpperCase()));
    });
    const address = 'http://' + (await listen(server));
    closers.push(() => {
      server.closeAllConnections();
      server.close();
    });
    return { address, seen };
  };

  it('listens on loopback only, with a fresh token per relay in its URL', async () => {
    const upstream = await userProxy(() => '');
    const [one, two] = [await start(upstream.address), await start(upstream.address)];
    expect(one.url).toMatch(/^http:\/\/run:[0-9a-f]{64}@127\.0\.0\.1:[0-9]+$/);
    expect(new URL(one.url).password).not.toBe(new URL(two.url).password);
    for (const piece of ['ops', 'p@ss', encodeURIComponent(LOGIN.password)]) expect(one.url).not.toContain(piece);
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

  it('tunnels CONNECT through the user proxy, signed in with the user credentials', async () => {
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

  it('forwards absolute-form requests, signed in, and keeps the token and the proxy headers away', async () => {
    const upstream = await userProxy((_kind, headers) =>
      headers['proxy-authorization'] === SIGNED_IN ? 'index' : undefined
    );
    const relay = await start(upstream.address);
    const response = await get(relay, 'http://index.example/simple/demo/', tokenOf(relay));
    expect(response).toMatchObject({ status: 200, body: 'index' });
    expect(response.headers['proxy-authenticate']).toBeUndefined();
    expect(upstream.seen).toMatchObject([{ kind: 'request', url: 'http://index.example/simple/demo/' }]);
    expect(upstream.seen[0].headers['proxy-authorization']).toBe(SIGNED_IN);
    expect(upstream.seen[0].headers.host).toBe('index.example');
    expect(JSON.stringify(upstream.seen)).not.toContain(new URL(relay.url).password);
  });

  it('answers a refusal of the user proxy with its status alone', async () => {
    const upstream = await userProxy(() => undefined);
    const relay = await start(upstream.address);
    const { head, socket } = await rawConnect(relay, 'repo.example:443', tokenOf(relay));
    socket.destroy();
    expect(head).toMatch(/^HTTP\/1\.1 407 Proxy Authentication Required\r\n/);
    expect(head).not.toMatch(/NTLM|X-Upstream-Only|Basic realm/);
    const response = await get(relay, 'http://index.example/simple/', tokenOf(relay));
    expect(response.status).toBe(407);
    expect(response.headers['proxy-authenticate']).toBeUndefined();
  });

  it('answers 502 when the user proxy cannot be reached, and 400 for what is not a proxy request', async () => {
    const gone = createServer();
    const address = 'http://' + (await listen(gone));
    gone.close();
    const relay = await start(address, { connectMs: 2000 });
    const { head, socket } = await rawConnect(relay, 'repo.example:443', tokenOf(relay));
    socket.destroy();
    expect(head).toMatch(/^HTTP\/1\.1 502 /);
    expect((await get(relay, 'http://index.example/', tokenOf(relay))).status).toBe(502);
    expect((await get(relay, '/simple/', tokenOf(relay))).status).toBe(400);
    expect((await get(relay, 'https://index.example/', tokenOf(relay))).status).toBe(400);
    const bad = await rawConnect(relay, 'repo.example/path:443', tokenOf(relay));
    bad.socket.destroy();
    expect(bad.head).toMatch(/^HTTP\/1\.1 400 /);
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
  it.skipIf(!openssl)('connects to an https: proxy over TLS, trusting what it is told to', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'studio-relay-tls-'));
    closers.push(() => rm(directory, { recursive: true, force: true }));
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
    const address = 'https://' + (await listen(server));
    closers.push(() => server.close());
    const relay = await start(address, { ca: [pem.cert] });
    const { head, socket } = await rawConnect(relay, 'repo.example:443', tokenOf(relay));
    socket.destroy();
    expect(head).toMatch(/^HTTP\/1\.1 200 /);
    expect(seen[0]).toContain(`Proxy-Authorization: ${SIGNED_IN}`);
    // Without that certificate the TLS check fails and nothing is sent.
    const untrusting = await start(address, { ca: [] });
    const refused = await rawConnect(untrusting, 'repo.example:443', tokenOf(untrusting));
    refused.socket.destroy();
    expect(refused.head).toMatch(/^HTTP\/1\.1 502 /);
    expect(seen).toHaveLength(1);
  });
});
