import type { IncomingMessage, ServerResponse } from 'node:http';
import { getNativeAuthService, type NativeAuthService } from './service.js';

export const NATIVE_AUTH_ROUTE = '/api/studio/native-auth';

/** Credential operations use the existing WebUI listener and backend session authentication. */
export async function handleNativeAuth(
  req: IncomingMessage,
  res: ServerResponse,
  options: { backendPort: number; origins: string[]; service?: NativeAuthService }
): Promise<void> {
  const respond = (status: number, body: unknown): void => {
    if (res.destroyed) return;
    res.writeHead(status, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    });
    res.end(JSON.stringify(body));
  };
  if (
    req.method !== 'POST' ||
    req.url !== NATIVE_AUTH_ROUTE ||
    req.headers['x-studio-auth'] !== '1' ||
    !req.headers['content-type']?.startsWith('application/json') ||
    !options.origins.includes(req.headers.origin ?? '') ||
    req.headers['sec-fetch-site'] === 'cross-site'
  ) {
    respond(403, { ok: false, code: 'FORBIDDEN' });
    return;
  }
  try {
    // /api/auth/user deliberately requires a real WebUI login, even when ordinary
    // backend routes inject a default user in --local mode. Never forward internal identity headers.
    const identity = await fetch(`http://127.0.0.1:${options.backendPort}/api/auth/user`, {
      headers: { cookie: req.headers.cookie ?? '' },
      signal: AbortSignal.timeout(5000),
      redirect: 'error',
    });
    if (!identity.ok) {
      respond(401, { ok: false, code: 'UNAUTHENTICATED' });
      return;
    }
    const result = (await identity.json()) as { success?: boolean; user?: { id?: string } };
    if (result.success !== true || typeof result.user?.id !== 'string') {
      respond(401, { ok: false, code: 'UNAUTHENTICATED' });
      return;
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    const bodyDeadline = setTimeout(() => req.destroy(), 10000);
    try {
      for await (const chunk of req) {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 60000) {
          respond(413, { ok: false, code: 'FRAME_LIMIT' });
          return;
        }
        chunks.push(Buffer.from(chunk));
      }
    } finally {
      clearTimeout(bodyDeadline);
    }
    let command: unknown;
    try {
      command = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      respond(400, { ok: false, code: 'INVALID_INPUT' });
      return;
    }
    const reply = await (options.service ?? getNativeAuthService()).request(`web:${result.user.id}`, command);
    respond(200, reply);
  } catch {
    respond(503, { ok: false, code: 'UNAVAILABLE' });
  }
}
