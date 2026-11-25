/**
 * WebUI static server.
 *
 * Serves out/renderer/ as the SPA and reverse-proxies /api/*, /ws, /api/stt/stream,
 * /login and /logout to aioncore. All auth goes to backend's aionui-auth crate;
 * /login and /logout are aionui-auth's top-level paths, the rest live under
 * /api/auth/*. The TCP listener checks the complete /ws and /api/stt/stream
 * WebSocket handshake before it reaches the backend.
 *
 * Design: Node native http + serve-handler. Studio's sessionless native auth
 * facade shares this listener and also verifies the operator session.
 * Other business routes remain on the backend.
 */

import http, { type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { networkInterfaces } from 'node:os';
import net, { type Socket } from 'node:net';
import serveHandler from 'serve-handler';
import {
  createRequestOriginPolicy,
  getStudioWebUIDefaultPort,
  getStudioWebUILocalUrl,
  matchesOriginAuthority,
  parseOrigin,
  readSourceHeaders,
} from './requestOrigin.js';
import { toHostCookieHeader, toStudioSetCookie, usesSharedLoopbackHost } from './studio-auth/cookies.js';
import { handleNativeAuth, NATIVE_AUTH_ROUTE } from './studio-auth/facade.js';
import { respondStudio } from './studio-auth/request.js';
import { handleNativeResources, NATIVE_RESOURCES_ROUTE } from './studio-auth/resources/facade.js';
import { getNativeAuthService } from './studio-auth/service.js';
import { handleStudioExtensions, STUDIO_EXTENSIONS_ROUTE } from './studio-extensions/host/facade.js';
import { createRelayVerdicts, isLoopbackAddress } from './studio-extensions/host/transport.js';
import { getStudioExtensionService } from './studio-extensions/host/shared.js';
import {
  MAX_UPGRADE_HEADER_BYTES,
  proxyWebSocket,
  rejectSocket,
  requestLineTargetsWebSocket,
} from './webSocketProxy.js';

export type StaticServerOptions = {
  staticDir: string;
  backendPort: number;
  userDataPath?: string;
  port?: number;
  allowRemote?: boolean;
};

export type StaticServerHandle = {
  port: number;
  url: string;
  localUrl: string;
  networkUrl?: string;
  lanIP?: string;
  stop: () => Promise<void>;
};

const DEFAULT_PORT = getStudioWebUIDefaultPort(true);

// Ranges that are non-internal IPv4 yet never a reachable LAN address, so we
// must never advertise them as the WebUI access URL even when they are the only
// non-loopback interface present:
//   169.254.0.0/16  link-local / APIPA (host got no DHCP lease)
//   198.18.0.0/15   RFC 2544 benchmarking range — handed out by utility tunnels
//                   such as Cloudflare WARP; this is the address that showed up
//                   on a multi-NIC machine instead of the real LAN IP.
const isUnreachableLanRange = (addr: string): boolean => addr.startsWith('169.254.') || /^198\.(18|19)\./.test(addr);

// Rank candidate LAN addresses by how likely they are the network the user
// actually reaches the desktop on. Lower is better. Private (RFC 1918) home /
// office ranges win over anything else; 192.168/16 is the most common LAN, then
// the 172.16/12 block, then 10/8 (frequently carved up by VPNs / corp routing).
const rankLanCandidate = (addr: string): number => {
  if (addr.startsWith('192.168.')) return 0;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(addr)) return 1;
  if (addr.startsWith('10.')) return 2;
  return 3;
};

// Pick the best LAN IPv4 to advertise. Pure over the interface map so it can be
// unit-tested against real multi-NIC layouts. Iterating and returning the first
// non-internal hit (the old behavior) picks whatever the OS lists first, which
// on a multi-NIC box can be a VPN / benchmark adapter rather than the LAN.
export function pickLanIP(nets: ReturnType<typeof networkInterfaces>): string | null {
  const candidates: string[] = [];
  for (const name of Object.keys(nets)) {
    for (const iface of nets[name] || []) {
      if (iface.family !== 'IPv4' || iface.internal) continue;
      if (isUnreachableLanRange(iface.address)) continue;
      candidates.push(iface.address);
    }
  }
  // Stable sort keeps OS interface order among equally-ranked addresses (e.g. a
  // physical NIC listed before a VPN when both are 10/8).
  candidates.sort((a, b) => rankLanCandidate(a) - rankLanCandidate(b));
  return candidates[0] ?? null;
}

function forwardToBackend(
  req: IncomingMessage,
  res: ServerResponse,
  backendPort: number,
  secureOrigin: boolean,
  cookieAuthority: string | undefined
): void {
  const headers: http.OutgoingHttpHeaders = { ...req.headers };
  const connectionFields = new Set(
    req.headers.connection
      ?.toLowerCase()
      .split(',')
      .map((name) => name.trim())
  );
  for (const name of Object.keys(headers)) {
    if (
      name === 'connection' ||
      name === 'upgrade' ||
      name === 'expect' ||
      name === 'forwarded' ||
      name === 'x-real-ip' ||
      name.startsWith('x-forwarded-') ||
      name.startsWith('x-aionui-') ||
      connectionFields.has(name)
    ) {
      delete headers[name];
    }
  }
  const cookie = toHostCookieHeader(
    cookieAuthority,
    typeof headers.cookie === 'string' ? headers.cookie : undefined,
    req.url ?? ''
  );
  if (cookie) headers.cookie = cookie;
  else delete headers.cookie;
  headers.host = '127.0.0.1:' + backendPort;
  if (req.headers.origin) headers.origin = 'http://' + headers.host;
  const options: http.RequestOptions = {
    hostname: '127.0.0.1',
    port: backendPort,
    path: req.url,
    method: req.method,
    headers,
  };
  const proxy = http.request(options, (proxyRes) => {
    const responseHeaders = { ...proxyRes.headers };
    for (const name of Object.keys(responseHeaders)) {
      if (name.startsWith('access-control-')) delete responseHeaders[name];
    }
    const cookies = toStudioSetCookie(cookieAuthority, proxyRes.headers['set-cookie'] ?? [], secureOrigin);
    if (cookies.length) responseHeaders['set-cookie'] = cookies;
    else delete responseHeaders['set-cookie'];
    res.writeHead(proxyRes.statusCode ?? 502, responseHeaders);
    proxyRes.pipe(res);
  });
  proxy.on('error', () => {
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'BACKEND_UNREACHABLE' }));
    } else {
      res.destroy();
    }
  });
  req.pipe(proxy);
}

// Max bytes we peek before forcing a routing decision. An HTTP request-line
// on its own is typically < 100 bytes; a full header block is < 2 KB. If we
// haven't seen a newline after 4 KB the client is sending something weird —
// hand it to the internal HTTP server and let it return 400.
const PEEK_LIMIT_BYTES = 4096;

/**
 * Splice `client` to a TCP endpoint on `targetPort`. Any bytes already read
 * from `client` during peek are replayed to the upstream as the first write,
 * so the endpoint sees the full HTTP request as-sent.
 */
function spliceToTcpEndpoint(
  client: Socket,
  targetPort: number,
  initialBytes: Buffer,
  /** Called once connected with the relay connection's local address and port; returns its release. */
  relayed?: (localAddress: string, localPort: number) => () => void
): void {
  client.setNoDelay(true);
  client.setKeepAlive(true);
  client.setTimeout(0);
  // The peek phase left `client` in flowing mode (it had a 'data' listener),
  // but that listener is now removed and the real consumer — `client.pipe(upstream)`
  // — is only wired inside the async 'connect' handler below. Pause here so any
  // body bytes arriving in the gap are buffered by the socket instead of being
  // dropped for lack of a consumer; `pipe()` resumes the socket once connected.
  // Without this, large/buffered uploads (e.g. reverse-proxied POST bodies that
  // span multiple TCP segments) lose their tail bytes and the backend hangs
  // forever waiting for the missing Content-Length (issue #4058).
  client.pause();
  const upstream = net.connect({ host: '127.0.0.1', port: targetPort, localAddress: '127.0.0.1' });
  upstream.setNoDelay(true);
  upstream.setKeepAlive(true);
  upstream.once('connect', () => {
    // Registered before a byte of the request is relayed, so the internal server finds it.
    const { localAddress, localPort } = upstream;
    if (relayed && localAddress !== undefined && localPort !== undefined) {
      upstream.once('close', relayed(localAddress, localPort));
    }
    if (initialBytes.length > 0) upstream.write(initialBytes);
    upstream.pipe(client);
    client.pipe(upstream);
  });
  const tearDown = (): void => {
    client.destroy();
    upstream.destroy();
  };
  upstream.on('error', tearDown);
  client.on('error', tearDown);
  upstream.on('close', tearDown);
  client.on('close', tearDown);
}

export async function startStaticServer(opts: StaticServerOptions): Promise<StaticServerHandle> {
  const port = opts.port ?? DEFAULT_PORT;
  const allowRemote = opts.allowRemote === true;
  const host = allowRemote ? '0.0.0.0' : '127.0.0.1';
  const readInterfaces = (): ReturnType<typeof networkInterfaces> => {
    if (!allowRemote) return {};
    try {
      return networkInterfaces();
    } catch {
      // A failed lookup cannot authorize any LAN address. Retry on the next request.
      return {};
    }
  };
  // A wildcard listener can receive traffic on interfaces added after startup.
  const readLanAddresses = () =>
    Object.values(readInterfaces()).flatMap(
      (entries) =>
        entries?.filter((entry) => entry.family === 'IPv4' && !entry.internal).map((entry) => entry.address) ?? []
    );
  const configuredOrigin = process.env.AELIX_STUDIO_ORIGIN;
  const publicOrigin = configuredOrigin ? parseOrigin(configuredOrigin) : undefined;
  const isConfiguredAuthority = (authority: string | undefined): boolean =>
    publicOrigin !== undefined && matchesOriginAuthority(publicOrigin, authority);
  const isSecureOrigin = (authority: string | undefined): boolean =>
    publicOrigin?.protocol === 'https:' && isConfiguredAuthority(authority);
  let isAllowed = createRequestOriginPolicy(port, readLanAddresses, configuredOrigin);
  let localOrigin = new URL(getStudioWebUILocalUrl(port));
  const isLoopbackAlias = (authority: string | undefined): boolean =>
    usesSharedLoopbackHost(authority) &&
    !matchesOriginAuthority(localOrigin, authority) &&
    !isConfiguredAuthority(authority);
  const browserCookieAuthority = (authority: string | undefined): string | undefined =>
    isLoopbackAlias(authority) ? undefined : authority;

  // The listener relays every connection to the internal HTTP server from 127.0.0.1, so that
  // server cannot see who connected: the listener records its verdict on each relay
  // connection (see `createRelayVerdicts`).
  const relayVerdicts = createRelayVerdicts();

  // Bun's HTTP server upgrade socket does not reliably write the 101 response
  // (#2824). Keep client upgrades on the TCP listener and use this HTTP
  // listener to parse and validate every ordinary request, including keep-alive.
  const handleHttp = async (req: IncomingMessage, res: ServerResponse, expectContinue = false): Promise<void> => {
    try {
      if (!req.url || !req.method) {
        res.writeHead(400).end();
        return;
      }

      const nativeResources = req.url.startsWith(NATIVE_RESOURCES_ROUTE);
      const safeMethod = req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS';
      if (!isAllowed(readSourceHeaders(req.rawHeaders), !safeMethod)) {
        if (nativeResources) respondStudio(res, 403, { ok: false, code: 'FORBIDDEN' });
        else res.writeHead(403).end();
        return;
      }
      if (req.method === 'OPTIONS' && !nativeResources) {
        res.writeHead(204).end();
        return;
      }
      if (
        (req.method === 'GET' || req.method === 'HEAD') &&
        (req.headers['sec-fetch-mode'] === 'navigate' || req.headers.accept?.includes('text/html')) &&
        isLoopbackAlias(req.headers.host) &&
        req.url.startsWith('/')
      ) {
        res.writeHead(307, { location: localOrigin.origin + req.url, 'cache-control': 'no-store' }).end();
        return;
      }
      if (expectContinue) res.writeContinue();
      const cookieAuthority = browserCookieAuthority(req.headers.host);

      if (nativeResources) {
        if (!cookieAuthority) delete req.headers.cookie;
        await handleNativeResources(req, res, {
          backendPort: opts.backendPort,
          origins: [req.headers.origin ?? ''],
        });
        return;
      }

      if (req.url.startsWith(NATIVE_AUTH_ROUTE)) {
        if (!cookieAuthority) delete req.headers.cookie;
        await handleNativeAuth(req, res, {
          backendPort: opts.backendPort,
          origins: [req.headers.origin ?? ''],
          userDataPath: opts.userDataPath,
        });
        return;
      }

      if (req.url.startsWith(STUDIO_EXTENSIONS_ROUTE)) {
        if (!cookieAuthority) delete req.headers.cookie;
        await handleStudioExtensions(req, res, {
          backendPort: opts.backendPort,
          origins: [req.headers.origin ?? ''],
          secure: relayVerdicts.fromThisMachine,
        });
        return;
      }

      // /api/* — reverse proxy to backend (includes /api/auth/*).
      // /login and /logout are aionui-auth's top-level auth endpoints: proxy them too
      // so WebUI browser clients reach the backend without a path-rewrite.
      const pathname = req.url.split('?', 1)[0];
      if (pathname.startsWith('/api/') || ['/login', '/logout', '/qr-login', '/api'].includes(pathname)) {
        forwardToBackend(req, res, opts.backendPort, isSecureOrigin(req.headers.host), cookieAuthority);
        return;
      }

      // static files + SPA fallback
      await serveHandler(req, res, {
        public: opts.staticDir,
        rewrites: [{ source: '**', destination: '/index.html' }],
      });
    } catch {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'INTERNAL_ERROR' }));
      } else {
        res.destroy();
      }
    }
  };
  const http_server: Server = http.createServer((req, res) => void handleHttp(req, res));
  http_server.on('checkContinue', (req, res) => void handleHttp(req, res, true));

  // Internal HTTP server — 127.0.0.1 ephemeral port, never visible to the user.
  await new Promise<void>((resolve, reject) => {
    http_server.once('error', reject);
    http_server.listen(0, '127.0.0.1', () => {
      http_server.off('error', reject);
      resolve();
    });
  });
  const internalPort = (http_server.address() as { port: number } | null)?.port;
  if (!internalPort) {
    throw new Error('internal HTTP server failed to bind to a port');
  }

  // Closing the listener must also close active upgrades.
  const clients = new Set<Socket>();
  const acceptConnection = (client: Socket): void => {
    clients.add(client);
    client.once('close', () => clients.delete(client));
    let peeked = Buffer.alloc(0);
    const cleanup = (): void => {
      client.removeListener('data', onData);
      clearTimeout(headerDeadline);
    };
    const onData = (chunk: Buffer): void => {
      peeked = Buffer.concat([peeked, chunk]);
      const newline = peeked.indexOf(0x0a);
      if (newline < 0 && peeked.length < PEEK_LIMIT_BYTES) return;
      if (newline >= 0 && requestLineTargetsWebSocket(peeked.toString('latin1', 0, newline))) {
        const headerEnd = peeked.indexOf('\r\n\r\n');
        if (headerEnd < 0 && peeked.length < MAX_UPGRADE_HEADER_BYTES) return;
        cleanup();
        if (headerEnd < 0 || headerEnd + 4 > MAX_UPGRADE_HEADER_BYTES) {
          rejectSocket(client, 431);
        } else if (peeked.length !== headerEnd + 4) {
          rejectSocket(client, 400);
        } else {
          proxyWebSocket(
            client,
            peeked.toString('latin1', 0, headerEnd),
            opts.backendPort,
            isAllowed,
            isSecureOrigin,
            browserCookieAuthority
          );
        }
        return;
      }
      cleanup();
      const fromThisMachine = isLoopbackAddress(client.remoteAddress);
      spliceToTcpEndpoint(client, internalPort, peeked, (localAddress, localPort) =>
        relayVerdicts.record(localAddress, localPort, fromThisMachine)
      );
    };
    const close = (): void => {
      cleanup();
      client.destroy();
    };
    const headerDeadline = setTimeout(close, 10000);
    client.on('data', onData);
    client.on('error', close);
    client.once('close', cleanup);
  };

  const listen = (server: net.Server, options: net.ListenOptions) =>
    new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(options, () => {
        server.off('error', reject);
        resolve();
      });
    });
  const tcpServer = net.createServer(acceptConnection);
  const ipv6LoopbackServer = net.createServer(acceptConnection);
  const close = (server: net.Server) =>
    new Promise<void>((resolve) => {
      if (server.listening) server.close(() => resolve());
      else resolve();
    });
  const closeListeners = async () => {
    for (const client of clients) client.destroy();
    await Promise.all([close(tcpServer), close(ipv6LoopbackServer), close(http_server)]);
  };

  let actualPort: number;
  try {
    await listen(tcpServer, { port, host });
    actualPort = (tcpServer.address() as net.AddressInfo).port;
    try {
      // A numeric, loopback-only IPv6 endpoint needs no browser or OS DNS support.
      await listen(ipv6LoopbackServer, { port: actualPort, host: '::1', ipv6Only: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!['EADDRINUSE', 'EADDRNOTAVAIL', 'EAFNOSUPPORT', 'EPROTONOSUPPORT', 'EACCES', 'EPERM'].includes(code ?? '')) {
        throw error;
      }
      // Keep the IPv4 listener when IPv6 is unavailable or the chosen port is in use.
    }
  } catch (error) {
    await closeListeners();
    throw error;
  }

  isAllowed = createRequestOriginPolicy(actualPort, readLanAddresses, configuredOrigin, ipv6LoopbackServer.listening);
  const localUrl = getStudioWebUILocalUrl(actualPort, ipv6LoopbackServer.listening);
  localOrigin = new URL(localUrl);

  const handle: StaticServerHandle = {
    port: actualPort,
    localUrl,
    get url() {
      return this.networkUrl ?? localUrl;
    },
    get networkUrl() {
      const address = this.lanIP;
      return address ? `http://${address}:${actualPort}` : undefined;
    },
    get lanIP() {
      return pickLanIP(readInterfaces()) ?? undefined;
    },
    stop: async () => {
      getNativeAuthService().cancelOwner('web:', true);
      // WebUI users' extension changes end with the listener that started them.
      getStudioExtensionService()?.cancelOwner('web:', true);
      await closeListeners();
    },
  };
  return handle;
}

export async function stopStaticServer(handle: StaticServerHandle): Promise<void> {
  await handle.stop();
}
