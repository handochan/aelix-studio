import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import {
  createServer,
  request as httpRequest,
  type ClientRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
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
 * absolute-form `http:` requests. To an `https:` proxy it connects over TLS and always checks
 * the certificate, whatever `NODE_TLS_REJECT_UNAUTHORIZED` says.
 *
 * Nothing of the user's proxy's own answers to the sign-in reaches the installers: a refusal
 * (407), a failed tunnel, or a proxy that cannot be reached or verified becomes a short
 * answer of the relay's own (`502` with a fixed reason). A 407 is also recorded, so the change
 * can say the credentials were rejected.
 *
 * What remains: code that runs during the install (a build backend, say) can read the token
 * and use this proxy until the change ends. It never sees the user's password.
 */
export type ProxyRelay = {
  /** The address the installers get, with the token as its user part. */
  url: string;
  /**
   * The token in the forms it can take in output (as is, percent-encoded, in the Basic value
   * clients send) and the Basic value of the user's credentials: for the output masker.
   */
  secrets: readonly string[];
  /** The user's proxy answered 407 to the credentials at least once. */
  credentialsRejected(): boolean;
  /** Stop listening and cut every connection. Safe to call more than once. */
  close(): Promise<void>;
};

export type RelayOptions = {
  /** Certificates to trust for an `https:` proxy; by default Node's and the system's. */
  ca?: string[];
  /** How long connecting to the user's proxy may take, until its first answer, in all. */
  connectMs?: number;
  /** How long a connection to the user's proxy may sit idle once it carries data. */
  idleMs?: number;
  /** How long a client connection may stay without a request that carries the token. */
  authMs?: number;
  /** Client connections without the token yet, at most; more are closed at once. */
  maxPending?: number;
  /** Connections to the user's proxy at the same time, at most; more are answered 503. */
  maxUpstream?: number;
};

const REALM = 'Basic realm="aelix-studio"';
/**
 * Headers for one hop only (RFC 9110 section 7.6.1), and the proxy's own: none of the user's
 * proxy's authentication headers reaches a client, and no client's reaches the user's proxy.
 */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'proxy-authenticate',
  'proxy-authentication-info',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);
const HEAD_LIMIT = 16 * 1024;
const CONNECT_TARGET = /^(?:\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+):[0-9]{1,5}$/;

/** The relay's own answers, by what went wrong. The reason is all an installer learns. */
const FAILURE = {
  rejected: [502, 'Proxy Credentials Rejected'],
  refused: [502, 'Proxy Refused Tunnel'],
  unreachable: [502, 'Proxy Unreachable'],
  untrusted: [502, 'Proxy Certificate Rejected'],
  busy: [503, 'Relay Busy'],
  invalid: [400, 'Bad Request'],
} as const;
type Failure = keyof typeof FAILURE;

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

/** A failure of the connection to the user's proxy: a certificate that did not verify, or anything else. */
const classify = (error: NodeJS.ErrnoException): Failure =>
  /CERT|SELF_SIGNED|UNABLE_TO_(?:GET|VERIFY)|ALTNAME/.test(String(error.code ?? '')) ? 'untrusted' : 'unreachable';

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

const failureBody = (reason: string): string => `aelix-studio relay: ${reason.toLowerCase()}\n`;

/** A complete answer of the relay's own on a raw client socket, then close it. */
function answerSocket(socket: Duplex, failure: Failure | 'challenge'): void {
  if (socket.destroyed || socket.writableEnded) return;
  if (failure === 'challenge') {
    socket.end(
      'HTTP/1.1 407 Proxy Authentication Required\r\n' +
        `Proxy-Authenticate: ${REALM}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`
    );
    return;
  }
  const [code, reason] = FAILURE[failure];
  const body = failureBody(reason);
  socket.end(
    `HTTP/1.1 ${String(code)} ${reason}\r\nContent-Type: text/plain\r\n` +
      `Content-Length: ${String(body.length)}\r\nConnection: close\r\n\r\n${body}`
  );
}

/** The same answer on the HTTP response of an absolute-form request. */
function answerResponse(response: ServerResponse, failure: Failure | 'challenge'): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  if (failure === 'challenge') {
    response.writeHead(407, { 'proxy-authenticate': REALM, 'content-length': '0', connection: 'close' }).end();
    return;
  }
  const [code, reason] = FAILURE[failure];
  const body = failureBody(reason);
  response
    .writeHead(code, reason, {
      'content-type': 'text/plain',
      'content-length': String(body.length),
      connection: 'close',
    })
    .end(body);
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
  const clientSignIn = basic('run', token);
  const expected = digest(clientSignIn);
  const connectMs = options.connectMs ?? 30_000;
  const idleMs = options.idleMs ?? 300_000;
  const authMs = options.authMs ?? 5000;
  const maxPending = options.maxPending ?? 16;
  const maxUpstream = options.maxUpstream ?? 32;
  const ca = options.ca ?? defaultTrust();
  // Verification is set here, not left to defaults that `NODE_TLS_REJECT_UNAUTHORIZED` changes.
  const tlsOptions: tls.ConnectionOptions = {
    rejectUnauthorized: true,
    checkServerIdentity: tls.checkServerIdentity,
    ...(isIP(host) ? {} : { servername: host }),
    ...(ca ? { ca } : {}),
  };
  let rejected = false;

  const sockets = new Set<Socket | Duplex>();
  const track = <T extends Socket | Duplex>(socket: T): T => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    // A peer that goes away is not an error of the change; never let one reach the process.
    socket.on('error', () => socket.destroy());
    return socket;
  };
  // Client connections that have not shown the token yet, each with its deadline.
  const pending = new Map<Socket | Duplex, ReturnType<typeof setTimeout>>();
  const admit = (socket: Socket | Duplex): void => {
    clearTimeout(pending.get(socket));
    pending.delete(socket);
  };
  const authorized = (request: IncomingMessage): boolean => {
    const ok = timingSafeEqual(digest(String(request.headers['proxy-authorization'] ?? '')), expected);
    if (ok) admit(request.socket);
    return ok;
  };
  let upstreams = 0;
  /** Count a connection to the user's proxy until it closes; false when there are too many already. */
  const reserve = (): boolean => {
    if (upstreams >= maxUpstream) return false;
    upstreams += 1;
    return true;
  };
  const release = (): void => {
    upstreams -= 1;
  };

  const server = createServer();
  server.on('connection', (socket: Socket) => {
    track(socket);
    if (pending.size >= maxPending) {
      socket.destroy();
      return;
    }
    pending.set(
      socket,
      setTimeout(() => socket.destroy(), authMs)
    );
    socket.once('close', () => admit(socket));
  });
  server.on('clientError', (_error, socket) => socket.destroy());

  // CONNECT: open the user's proxy, ask it for the same tunnel with the user's credentials,
  // and join the two once it answers 200. Anything else is answered by the relay itself.
  server.on('connect', (request: IncomingMessage, client: Duplex, head: Buffer) => {
    if (!authorized(request)) return answerSocket(client, 'challenge');
    const destination = request.url ?? '';
    if (!CONNECT_TARGET.test(destination)) return answerSocket(client, 'invalid');
    if (!reserve()) return answerSocket(client, 'busy');
    const remote = track(secure ? tls.connect({ host, port, ...tlsOptions }) : netConnect({ host, port }));
    let failure: Failure = 'unreachable';
    let received = Buffer.alloc(0);
    // Answered: the client got its one status line, a refusal or the tunnel; joined: the tunnel.
    let answered = false;
    let joined = false;
    const refuse = (why: Failure): void => {
      if (answered) return;
      answered = true;
      answerSocket(client, why);
      remote.destroy();
    };
    // In all, not idle: a proxy that trickles its answer still gets no longer than this.
    const deadline = setTimeout(() => refuse('unreachable'), connectMs);
    remote.on('error', (error: NodeJS.ErrnoException) => {
      failure = classify(error);
    });
    remote.once('close', () => {
      clearTimeout(deadline);
      release();
      // A refusal was written with end(): let it reach the client. A tunnel ends with its far side.
      if (joined) client.destroy();
      else refuse(failure);
    });
    // The server keeps client sockets half-open: a client that ends its side ends the tunnel,
    // or the connection to the user's proxy would be held (and counted) for good.
    client.once('end', () => remote.destroy());
    client.once('close', () => remote.destroy());
    remote.once(secure ? 'secureConnect' : 'connect', () =>
      remote.write(`CONNECT ${destination} HTTP/1.1\r\nHost: ${destination}\r\nProxy-Authorization: ${signIn}\r\n\r\n`)
    );
    const onData = (chunk: Buffer): void => {
      received = Buffer.concat([received, chunk]);
      const end = received.indexOf('\r\n\r\n');
      if (end < 0) {
        if (received.length > HEAD_LIMIT) refuse('refused');
        return;
      }
      remote.removeListener('data', onData);
      remote.pause();
      const status = /^HTTP\/1\.[01] ([1-5][0-9]{2})/.exec(received.subarray(0, end).toString('latin1'))?.[1];
      if (status === '407') {
        rejected = true;
        return refuse('rejected');
      }
      if (status !== '200') return refuse('refused');
      answered = true;
      joined = true;
      clearTimeout(deadline);
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
    if (!authorized(request)) return answerResponse(response, 'challenge');
    const destination = URL.parse(request.url ?? '');
    if (destination?.protocol !== 'http:' || !destination.hostname) return answerResponse(response, 'invalid');
    if (!reserve()) return answerResponse(response, 'busy');
    let released = false;
    const done = (): void => {
      if (released) return;
      released = true;
      release();
    };
    let failure: Failure = 'unreachable';
    const outgoing: ClientRequest = (secure ? httpsRequest : httpRequest)({
      host,
      port,
      method: request.method,
      path: request.url,
      // The target's authority is the host (RFC 9112 section 3.2.2), whatever the client's header said.
      headers: { ...forwardedHeaders(request.headers), host: destination.host, 'proxy-authorization': signIn },
      agent: false,
      ...(secure ? tlsOptions : {}),
    });
    // In all, until the user's proxy answers; then idle only.
    const deadline = setTimeout(() => outgoing.destroy(), connectMs);
    outgoing.once('close', () => {
      clearTimeout(deadline);
      done();
    });
    outgoing.on('socket', (socket) => track(socket));
    // A client that goes away takes its request to the user's proxy with it.
    response.on('close', () => {
      if (!response.writableFinished) outgoing.destroy();
    });
    outgoing.on('error', (error: NodeJS.ErrnoException) => {
      failure = classify(error);
      answerResponse(response, failure);
    });
    outgoing.on('response', (incoming) => {
      clearTimeout(deadline);
      outgoing.setTimeout(idleMs, () => outgoing.destroy());
      incoming.on('error', () => response.destroy());
      // A refusal of the sign-in stays here: its headers and body are the user's proxy's own.
      if (incoming.statusCode === 407) {
        rejected = true;
        incoming.resume();
        return answerResponse(response, 'rejected');
      }
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
    secrets: [token, encodeURIComponent(token), clientSignIn.slice('Basic '.length), signIn.slice('Basic '.length)],
    credentialsRejected: () => rejected,
    close: () => {
      closed ??= new Promise<void>((resolve) => {
        server.close(() => resolve());
        for (const timer of pending.values()) clearTimeout(timer);
        for (const socket of sockets) socket.destroy();
      });
      return closed;
    },
  };
}
