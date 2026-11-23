import type { IncomingMessage, ServerResponse } from 'node:http';
import { admitStudioRequest, respondStudio } from './request.js';
import { getNativeAuthService, type NativeAuthService } from './service.js';

export const NATIVE_AUTH_ROUTE = '/api/studio/native-auth';

/** Credential operations use the existing WebUI listener and backend session authentication. */
export async function handleNativeAuth(
  req: IncomingMessage,
  res: ServerResponse,
  options: { backendPort: number; origins: string[]; userDataPath?: string; service?: NativeAuthService }
): Promise<void> {
  try {
    const admitted = await admitStudioRequest(req, res, {
      route: NATIVE_AUTH_ROUTE,
      marker: 'x-studio-auth',
      backendPort: options.backendPort,
      origins: options.origins,
    });
    if (!admitted) return;
    const reply = await (options.service ?? getNativeAuthService()).request(
      `web:${admitted.userId}`,
      admitted.body,
      options.userDataPath
    );
    respondStudio(res, 200, reply);
  } catch {
    respondStudio(res, 503, { ok: false, code: 'UNAVAILABLE' });
  }
}
