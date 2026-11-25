import type { IncomingMessage, ServerResponse } from 'node:http';
import { admitStudioRequest, respondStudio } from '../request.js';
import { getNativeResourcesService, type NativeResourcesService } from './service.js';
import { RESOURCE_ERROR_STATUS } from './types.js';

export const NATIVE_RESOURCES_ROUTE = '/api/studio/native-resources';

/** Admit real WebUI sessions through the same cookie and CSRF boundary as native auth. */
export async function handleNativeResources(
  req: IncomingMessage,
  res: ServerResponse,
  options: { backendPort: number; origins: string[]; service?: NativeResourcesService }
): Promise<void> {
  try {
    const admitted = await admitStudioRequest(req, res, {
      route: NATIVE_RESOURCES_ROUTE,
      marker: 'x-studio-resources',
      backendPort: options.backendPort,
      origins: options.origins,
    });
    if (!admitted) return;
    const reply = await (options.service ?? getNativeResourcesService()).request(
      `web:${admitted.userId}`,
      admitted.body
    );
    respondStudio(res, reply.ok === false ? RESOURCE_ERROR_STATUS[reply.code] : 200, reply);
  } catch {
    respondStudio(res, 503, { ok: false, code: 'HELPER_UNAVAILABLE' });
  }
}
