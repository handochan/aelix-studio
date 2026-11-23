import type { IncomingMessage, ServerResponse } from 'node:http';
import { toHostCookieHeader } from './cookies.js';

/**
 * The admission of a credential-bearing Studio request on the WebUI listener, shared by the
 * native auth facade and the extension facade so the two never drift apart.
 */
export type StudioRequestOptions = {
  /** The one path the facade serves. */
  route: string;
  /** The header (lower case) that must be `1`: a simple cross-site form cannot set it. */
  marker: string;
  backendPort: number;
  /** The origins a browser request may come from. */
  origins: string[];
  /** Fields added to every refusal this answers (the extension facade's `transport`). */
  refusal?: Record<string, unknown>;
};

const BODY_LIMIT = 60000;
/** `application/json`, with parameters or none; not `application/jsonx` or the like. */
const JSON_TYPE = /^application\/json\s*(?:;.*)?$/i;

/** Answer as JSON that is never cached and sends no referrer. */
export function respondStudio(res: ServerResponse, status: number, body: unknown): void {
  if (res.destroyed) return;
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  });
  res.end(JSON.stringify(body));
}

/**
 * Admit a request: a JSON POST to `route` with the marker header, from an allowed origin and
 * not cross-site, by a real WebUI login. `/api/auth/user` deliberately requires a real login,
 * even when ordinary backend routes inject a default user in --local mode; no internal
 * identity header is ever forwarded. The body is read with a size cap and a deadline.
 *
 * Returns the backend user id and the parsed body, or undefined once it has answered the
 * refusal itself (403, 401, 413, 400). Unexpected errors are thrown for the caller's 503.
 */
export async function admitStudioRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: StudioRequestOptions
): Promise<{ userId: string; body: unknown } | undefined> {
  if (
    req.method !== 'POST' ||
    req.url !== options.route ||
    req.headers[options.marker] !== '1' ||
    !JSON_TYPE.test(req.headers['content-type'] ?? '') ||
    !options.origins.includes(req.headers.origin ?? '') ||
    req.headers['sec-fetch-site'] === 'cross-site'
  ) {
    respondStudio(res, 403, { ok: false, code: 'FORBIDDEN', ...options.refusal });
    return undefined;
  }
  const identity = await fetch(`http://127.0.0.1:${options.backendPort}/api/auth/user`, {
    headers: { cookie: toHostCookieHeader(req.headers.host, req.headers.cookie, req.url) ?? '' },
    signal: AbortSignal.timeout(5000),
    redirect: 'error',
  });
  if (!identity.ok) {
    respondStudio(res, 401, { ok: false, code: 'UNAUTHENTICATED', ...options.refusal });
    return undefined;
  }
  const result = (await identity.json()) as { success?: boolean; user?: { id?: string } };
  if (result.success !== true || typeof result.user?.id !== 'string') {
    respondStudio(res, 401, { ok: false, code: 'UNAUTHENTICATED', ...options.refusal });
    return undefined;
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  const bodyDeadline = setTimeout(() => req.destroy(), 10000);
  try {
    for await (const chunk of req) {
      bytes += Buffer.byteLength(chunk);
      if (bytes > BODY_LIMIT) {
        respondStudio(res, 413, { ok: false, code: 'FRAME_LIMIT', ...options.refusal });
        return undefined;
      }
      chunks.push(Buffer.from(chunk));
    }
  } finally {
    clearTimeout(bodyDeadline);
  }
  try {
    return { userId: result.user.id, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
  } catch {
    respondStudio(res, 400, { ok: false, code: 'INVALID_INPUT', ...options.refusal });
    return undefined;
  }
}
