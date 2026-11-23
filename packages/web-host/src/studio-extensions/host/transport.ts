import type { IncomingMessage } from 'node:http';
import type { TLSSocket } from 'node:tls';
import type { StudioExtensionsTransport } from '../types.js';

/** A loopback peer address: 127.0.0.0/8 or ::1, also in IPv4-mapped form. */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const v4 = address.toLowerCase().startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
  return v4 === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4);
}

/** The host names of a page served on this machine (as `URL` writes them): localhost, 127/8, [::1]. */
const LOOPBACK_HOST = /^(?:localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|\[::1\])$/;

/**
 * Whether a connection can carry a secret without it crossing a network in the clear: TLS,
 * or a peer on this machine. Read from the socket, never from headers a client or proxy sets.
 * Behind the WebUI listener's relay every request comes from 127.0.0.1: the static server
 * passes its own verdict from the accepted socket instead (`createRelayVerdicts`).
 */
export function secureTransport(req: IncomingMessage): boolean {
  return Boolean((req.socket as Partial<TLSSocket>).encrypted) || isLoopbackAddress(req.socket.remoteAddress);
}

/**
 * Whether the page's `Origin` lets a secure socket verdict stand. It can only lower one. A
 * loopback socket can still be a reverse proxy on this machine that serves the public over
 * plain HTTP: the browser then names that public `http:` origin, and the secret crossed the
 * network in the clear before the proxy. Kept: an `https:` origin (the browser sent the
 * same-origin request over TLS, to a proxy that terminates it) and an `http:` origin on a
 * loopback host name. Lowered: an `http:` origin on any other host, any other scheme, and a
 * missing or unparseable origin (the facade's admission does not require one).
 */
export function originKeepsSecure(origin: string | undefined): boolean {
  if (!origin) return false;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.protocol === 'https:') return true;
  return parsed.protocol === 'http:' && LOOPBACK_HOST.test(parsed.hostname);
}

/**
 * The transport a request arrived over: the socket's verdict (`socketSecure`, by default
 * `secureTransport`), lowered by the page's `Origin` (`originKeepsSecure`), never raised.
 */
export function requestTransport(
  req: IncomingMessage,
  socketSecure: (req: IncomingMessage) => boolean = secureTransport
): StudioExtensionsTransport {
  return socketSecure(req) && originKeepsSecure(req.headers.origin) ? 'secure' : 'insecure';
}

/**
 * The WebUI listener's verdicts on the connections it relays to its internal HTTP server.
 * The listener decides at accept time, from the peer of the accepted socket, and records the
 * verdict under the relay connection's local address and port. The internal server finds it
 * under its request socket's remote address and port; both must match. Nothing a client
 * sends can set one. A request with no record (not relayed by this listener) is remote.
 */
export function createRelayVerdicts(): {
  /** Record the verdict on the relay connection from `address`:`port`; returns its release. */
  record(address: string, port: number, fromThisMachine: boolean): () => void;
  /** Whether the request came over a relay connection the listener accepted from this machine. */
  fromThisMachine(req: IncomingMessage): boolean;
} {
  const verdicts = new Map<string, { fromThisMachine: boolean }>();
  const key = (address: string, port: number): string => `${address}|${port}`;
  return {
    record(address, port, fromThisMachine) {
      const own = { fromThisMachine };
      const id = key(address, port);
      verdicts.set(id, own);
      // A later connection may reuse the address and port before this one's close arrives:
      // the release removes only its own record.
      return () => {
        if (verdicts.get(id) === own) verdicts.delete(id);
      };
    },
    fromThisMachine(req) {
      const { remoteAddress, remotePort } = req.socket;
      if (remoteAddress === undefined || remotePort === undefined) return false;
      return verdicts.get(key(remoteAddress, remotePort))?.fromThisMachine === true;
    },
  };
}
