import type { IncomingMessage, ServerResponse } from 'node:http';
import type { TLSSocket } from 'node:tls';
import { admitStudioRequest, respondStudio } from '../../studio-auth/request.js';
import { RUNTIME_HINT, type ExtensionService } from './service.js';
import { getStudioExtensionService } from './shared.js';

export const STUDIO_EXTENSIONS_ROUTE = '/api/studio/extensions';

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A loopback peer address: 127.0.0.0/8 or ::1, also in IPv4-mapped form. */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const v4 = address.toLowerCase().startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
  return v4 === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4);
}

/**
 * Whether a connection can carry a secret without it crossing a network in the clear: TLS,
 * or a peer on this machine. Read from the socket, never from headers a client or proxy sets.
 * Behind the WebUI listener's relay every request comes from 127.0.0.1: the static server
 * passes its own verdict from the accepted socket instead (`secure`).
 */
export function secureTransport(req: IncomingMessage): boolean {
  return Boolean((req.socket as Partial<TLSSocket>).encrypted) || isLoopbackAddress(req.socket.remoteAddress);
}

/**
 * Whether a request carries proxy credentials: `set_proxy_credentials`, any request with
 * `proxyCredentials` (an install, an upgrade), or settings whose proxy address has a user part.
 */
export function carriesProxyCredentials(command: unknown): boolean {
  if (!isObject(command)) return false;
  if (command.action === 'set_proxy_credentials' || command.proxyCredentials !== undefined) return true;
  if (command.action !== 'set_settings' || !isObject(command.settings)) return false;
  const proxy = command.settings.proxy;
  return typeof proxy === 'string' && /^[^:/?#]*:\/\/[^/?#]*@/.test(proxy);
}

/**
 * The extension helper on the WebUI listener (Studio #32, ADR 5.11), with the native auth
 * facade's admission: a JSON POST with `X-Studio-Extensions: 1` from the page's own origin
 * and a real WebUI login. The signed-in user is the owner of what it starts. Requests can
 * carry proxy credentials, so nothing of a request or a reply is logged here.
 *
 * Proxy credentials sent over plain HTTP from another machine would cross the network in the
 * clear (2026-11-23 user decision: warn, then allow). Every reply says which (`transport`),
 * so the screen warns before it sends a secret, and adds `acknowledgeInsecureTransport: true`
 * once the user confirmed. A request that carries credentials without the flag over such a
 * connection is still answered `INSECURE_TRANSPORT`, as a second line. The flag is removed
 * before the helper sees the request. Saved credentials used remotely travel nowhere and
 * need no flag.
 */
export async function handleStudioExtensions(
  req: IncomingMessage,
  res: ServerResponse,
  options: {
    backendPort: number;
    origins: string[];
    service?: ExtensionService;
    /** Whether the connection is secure; by default from the socket (see `secureTransport`). */
    secure?: (req: IncomingMessage) => boolean;
  }
): Promise<void> {
  try {
    const admitted = await admitStudioRequest(req, res, {
      route: STUDIO_EXTENSIONS_ROUTE,
      marker: 'x-studio-extensions',
      backendPort: options.backendPort,
      origins: options.origins,
    });
    if (!admitted) return;
    const transport = (options.secure ?? secureTransport)(req) ? 'secure' : 'insecure';
    let command = admitted.body;
    if (isObject(command)) {
      const { acknowledgeInsecureTransport, ...rest } = command;
      if (transport === 'insecure' && carriesProxyCredentials(rest) && acknowledgeInsecureTransport !== true) {
        respondStudio(res, 200, { ok: false, code: 'INSECURE_TRANSPORT', transport });
        return;
      }
      command = rest;
    }
    const service = options.service ?? getStudioExtensionService();
    const reply = service
      ? await service.request(`web:${admitted.userId}`, command)
      : { ok: false, code: 'RUNTIME_UNAVAILABLE', detail: [RUNTIME_HINT] };
    respondStudio(res, 200, { ...reply, transport });
  } catch {
    respondStudio(res, 503, { ok: false, code: 'UNAVAILABLE' });
  }
}
