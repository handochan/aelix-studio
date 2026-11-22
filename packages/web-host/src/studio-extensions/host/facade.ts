import type { IncomingMessage, ServerResponse } from 'node:http';
import { admitStudioRequest, respondStudio } from '../../studio-auth/request.js';
import type { ExtensionService } from './service.js';
import { getStudioExtensionService } from './shared.js';

export const STUDIO_EXTENSIONS_ROUTE = '/api/studio/extensions';

/**
 * The extension helper on the WebUI listener (Studio #32, ADR 5.11), with the native auth
 * facade's admission: a JSON POST with `X-Studio-Extensions: 1` from the page's own origin
 * and a real WebUI login. The signed-in user is the owner of what it starts. Requests can
 * carry proxy credentials, so nothing of a request or a reply is logged here.
 */
export async function handleStudioExtensions(
  req: IncomingMessage,
  res: ServerResponse,
  options: { backendPort: number; origins: string[]; service?: ExtensionService }
): Promise<void> {
  try {
    const admitted = await admitStudioRequest(req, res, {
      route: STUDIO_EXTENSIONS_ROUTE,
      marker: 'x-studio-extensions',
      backendPort: options.backendPort,
      origins: options.origins,
    });
    if (!admitted) return;
    const service = options.service ?? getStudioExtensionService();
    const reply = service
      ? await service.request(`web:${admitted.userId}`, admitted.body)
      : { ok: false, code: 'RUNTIME_UNAVAILABLE' };
    respondStudio(res, 200, reply);
  } catch {
    respondStudio(res, 503, { ok: false, code: 'UNAVAILABLE' });
  }
}
