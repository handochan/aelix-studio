import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import {
  createServer,
  request as httpRequest,
  STATUS_CODES,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
} from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, connect as netConnect, type AddressInfo, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import tls from 'node:tls';
import type { ProxyCredentials } from '../../../types.js';

/**
 * The loopback proxy of one online install (Studio #32 review, 2026-11-22).
 *
 * pip, Git and the build code pip starts never get the user's proxy credentials. They get
 * `http://run:<token>@127.0.0.1:<port>`: this proxy, in the helper process, for this change
 * only. It takes a request only with the token, a fresh random one per change compared in
 * constant time, and passes it on to the user's proxy with the user's credentials as
 * `Proxy-Authorization: Basic`: CONNECT tunnels (HTTPS, and anything pip and Git tunnel) and
 * absolute-form `http:` requests. To an `https:` proxy it connects over TLS.
 *
 * What remains: code that runs during the install (a build backend, say) can read the token
 * and use this proxy until the change ends. It never sees the user's password.
 *
 * Nothing it answers or reports carries the credentials or the token.
 */
export type ProxyRelay = {
  /** The address the installers get, with the token as its user part. */
  url: string;
  /** Stop listening and cut every connection. Safe to call more than once. */
  close(): Promise<void>;
};

export type RelayOptions = {
  /** Certificates to trust for an `https:` proxy; by default Node's and the system's. */
  ca?: string[];
  /** How long connecting to the user's proxy and its first answer may take. */
  connectMs?: number;
  /** How long a connection to the user's proxy may sit idle once it carries data. */
  idleMs?: number;
};

const REALM = 'Basic realm="aelix-studio"';
/** Headers for one hop only (RFC 9110 section 7.6.1), and the proxy's own. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);
const HEAD_LIMIT = 16 * 1024;
const CONNECT_TARGET = /^(?:\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+):[0-9]{1,5}$/;

const digest = (text: string): Buffer => createHash('sha256').update(text).digest();
const basic = (user: string, password: string): string =>
  'Basic ' + Buffer.from(`${user}:${password}`, 'latin1').toString('base64');

/** Node's certificates and the system's, as pip's truststore uses the system's. */
function defaultTrust(): string[] | undefined {
  const get = (tls as { getCACertificates?: (type: 'default' | 'system') => string[] }).getCACertificates;
  if (typeof get !== 'function') return undefined;
  try {
    return [...get('default'), ...get('system')];
  } catch {
    return undefined;
  }
}

function forwardedHeaders(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const named = new Set(
    String(headers.connection ?? '')
      .split(',')
      .map((name) => name.trim().toLowerCase())
  );
  const kept: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers))
    if (value !== undefined && !HOP_BY_HOP.has(name) && !named.has(name)) kept[name] = value;
  return kept;
}

/** A short answer to a client socket that has not been tunnelled, then close it. */
function answer(socket: Duplex, code: number, challenge = false): void {
  if (socket.destroyed) return;
  const reason = STATUS_CODES[code] ?? 'Proxy Error';
  socket.end(
    `HTTP/1.1 ${String(code)} ${reason}\r\n` +
      (challenge ? `Proxy-Authenticate: ${REALM}\r\n` : '') +
      'Content-Length: 0\r\nConnection: close\r\n\r\n'
  );
}

/**
 * Start the relay to `upstream` (a stored, credential-free `http(s)://host[:port]`; a missing
 * port is the scheme's, as pip reads it) with `credentials`. Call under the mutation lock,
 * for one change, and close it when the installers are done.
 */
export async function startProxyRelay(
  upstream: string,
  credentials: ProxyCredentials,
  options: RelayOptions = {}
): Promise<ProxyRelay> {
  const target = new URL(upstream);
  const secure = target.protocol === 'https:';
  const host = target.hostname.replace(/^\[(.*)\]$/, '$1');
  const port = Number(target.port || (secure ? 443 : 80));
  const signIn = basic(credentials.username, credentials.password);
  const token = randomBytes(32).toString('hex');
  const expected = digest(basic('run', token));
  const connectMs = options.connectMs ?? 30_000;
  const idleMs = options.idleMs ?? 300_000;
  const ca = options.ca ?? defaultTrust();
  const sockets = new Set<Socket | Duplex>();
  const track = <T extends Socket | Duplex>(socket: T): T => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    // A peer that goes away is not an error of the change; never let one reach the process.
    socket.on('error', () => socket.destroy());
    return socket;
  };
  const authorized = (request: IncomingMessage): boolean =>
    timingSafeEqual(digest(String(request.headers['proxy-authorization'] ?? '')), expected);
  const openUpstream = (): Socket =>
    track(
      secure
        ? tls.connect({ host, port, ...(isIP(host) ? {} : { servername: host }), ...(ca ? { ca } : {}) })
        : netConnect({ host, port })
    );

  const server = createServer();
  server.on('connection', (socket) => track(socket));
  server.on('clientError', (_error, socket) => socket.destroy());

  // CONNECT: open the user's proxy, ask it for the same tunnel with the user's credentials,
  // and join the two once it answers 200. Any other answer goes back as its status alone.
  server.on('connect', (request: IncomingMessage, client: Duplex, head: Buffer) => {
    if (!authorized(request)) return answer(client, 407, true);
    const destination = request.url ?? '';
    if (!CONNECT_TARGET.test(destination)) return answer(client, 400);
    const remote = openUpstream();
    let received = Buffer.alloc(0);
    // Answered: the client got its one status line, a refusal or the tunnel.
    let answered = false;
    const refuse = (code: number): void => {
      if (answered) return;
      answered = true;
      answer(client, code);
      remote.destroy();
    };
    remote.setTimeout(connectMs, () => remote.destroy());
    remote.once('close', () => {
      if (!answered) refuse(502);
      else client.destroy();
    });
    client.once('close', () => remote.destroy());
    remote.once(secure ? 'secureConnect' : 'connect', () =>
      remote.write(`CONNECT ${destination} HTTP/1.1\r\nHost: ${destination}\r\nProxy-Authorization: ${signIn}\r\n\r\n`)
    );
    const onData = (chunk: Buffer): void => {
      received = Buffer.concat([received, chunk]);
      const end = received.indexOf('\r\n\r\n');
      if (end < 0) {
        if (received.length > HEAD_LIMIT) remote.destroy();
        return;
      }
      remote.removeListener('data', onData);
      remote.pause();
      const status = /^HTTP\/1\.[01] ([1-5][0-9]{2})/.exec(received.subarray(0, end).toString('latin1'));
      // Anything but 200 goes back as its status only: the user's proxy's headers stay here.
      if (status?.[1] !== '200') return refuse(status ? Number(status[1]) : 502);
      answered = true;
      remote.setTimeout(idleMs, () => remote.destroy());
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      const rest = received.subarray(end + 4);
      if (rest.length > 0) client.write(rest);
      if (head.length > 0) remote.write(head);
      remote.pipe(client);
      client.pipe(remote);
    };
    remote.on('data', onData);
  });

  // Absolute-form `http:` requests: the same request to the user's proxy, signed in.
  server.on('request', (request, response) => {
    request.on('error', () => response.destroy());
    response.on('error', () => response.destroy());
    if (!authorized(request)) {
      response.writeHead(407, { 'proxy-authenticate': REALM, 'content-length': '0', connection: 'close' }).end();
      return;
    }
    const destination = URL.parse(request.url ?? '');
    if (destination?.protocol !== 'http:' || !destination.hostname) {
      response.writeHead(400, { 'content-length': '0', connection: 'close' }).end();
      return;
    }
    const outgoing = (secure ? httpsRequest : httpRequest)({
      host,
      port,
      method: request.method,
      path: request.url,
      // The target's authority is the host (RFC 9112 section 3.2.2), whatever the client's header said.
      headers: { ...forwardedHeaders(request.headers), host: destination.host, 'proxy-authorization': signIn },
      agent: false,
      ...(secure ? { ...(isIP(host) ? {} : { servername: host }), ...(ca ? { ca } : {}) } : {}),
    });
    outgoing.setTimeout(connectMs, () => outgoing.destroy());
    outgoing.on('socket', (socket) => track(socket));
    // A client that goes away takes its request to the user's proxy with it.
    response.on('close', () => {
      if (!response.writableFinished) outgoing.destroy();
    });
    outgoing.on('error', () => {
      if (!response.headersSent) response.writeHead(502, { 'content-length': '0', connection: 'close' }).end();
      else response.destroy();
    });
    outgoing.on('response', (incoming) => {
      outgoing.setTimeout(idleMs, () => outgoing.destroy());
      incoming.on('error', () => response.destroy());
      response.writeHead(incoming.statusCode ?? 502, forwardedHeaders(incoming.headers));
      incoming.pipe(response);
    });
    request.pipe(outgoing);
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  // After listening, an accept error (too many open files, say) must not end the process.
  server.on('error', () => {});
  const { port: local } = server.address() as AddressInfo;
  let closed: Promise<void> | undefined;
  return {
    url: `http://run:${token}@127.0.0.1:${String(local)}`,
    close: () => {
      closed ??= new Promise<void>((resolve) => {
        server.close(() => resolve());
        for (const socket of sockets) socket.destroy();
      });
      return closed;
    },
  };
}
