/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { StudioExtensionsReply, StudioExtensionsRequest } from '@aionui/web-host';

declare global {
  interface Window {
    __studioExtensions?: { request: (command: StudioExtensionsRequest) => Promise<StudioExtensionsReply> };
  }
}

/** The WebUI route of the extension helper (`STUDIO_EXTENSIONS_ROUTE` in web-host). */
const ROUTE = '/api/studio/extensions';

type Refusal = { ok: false; code: 'UNAUTHENTICATED' | 'FORBIDDEN' | 'FRAME_LIMIT' | 'INVALID_INPUT' | 'UNAVAILABLE' };

const transportFailure = (status: number): Refusal => {
  if (status === 401) return { ok: false, code: 'UNAUTHENTICATED' };
  if (status === 403) return { ok: false, code: 'FORBIDDEN' };
  if (status === 413) return { ok: false, code: 'FRAME_LIMIT' };
  if (status === 400) return { ok: false, code: 'INVALID_INPUT' };
  return { ok: false, code: 'UNAVAILABLE' };
};

/** The most of a refusal's body the client reads: the host's own refusals are a few bytes. */
const REFUSAL_LIMIT = 16 * 1024;
const REFUSAL_CODES = new Set<string>(['UNAUTHENTICATED', 'FORBIDDEN', 'FRAME_LIMIT', 'INVALID_INPUT', 'UNAVAILABLE']);

/** The body of a non-2xx answer as a JSON object, if it is one within `REFUSAL_LIMIT`. */
async function readRefusalBody(response: Response): Promise<Record<string, unknown> | undefined> {
  if (!/^application\/json\s*(?:;.*)?$/i.test(response.headers.get('content-type') ?? '') || !response.body) {
    return undefined;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  try {
    for (;;) {
      // eslint-disable-next-line no-await-in-loop -- a stream is read in order, chunk by chunk
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > REFUSAL_LIMIT) {
        reader.cancel().catch((): void => {});
        return undefined;
      }
      text += decoder.decode(value, { stream: true });
    }
    const parsed: unknown = JSON.parse(text + decoder.decode());
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A non-2xx answer of the route. The host writes its refusals (401, 403, 413, 400, 503) as JSON
 * with `transport`, which is kept, with the host's code. Without a readable JSON body (an empty
 * 403 of the listener, a proxy's page) the code comes from the status and there is no
 * `transport`, which the screen takes as `insecure`.
 */
async function refusalOf(response: Response): Promise<StudioExtensionsReply> {
  const fallback = transportFailure(response.status);
  const body = await readRefusalBody(response);
  if (body?.ok !== false) return fallback;
  const code =
    typeof body.code === 'string' && REFUSAL_CODES.has(body.code) ? (body.code as Refusal['code']) : fallback.code;
  const transport = body.transport === 'secure' || body.transport === 'insecure' ? body.transport : undefined;
  return { ok: false, code, ...(transport ? { transport } : {}) };
}

/**
 * Send one request to the Studio extension helper (Studio #32): over the desktop window's
 * dedicated channel, or the WebUI route of the page's own origin. Requests can carry proxy
 * credentials, so they bypass the generic bridge, HTTP interceptors and logging, a redirect is
 * never followed (it would send the body on), and a lost answer is never sent again: it may
 * follow a change that was made (`CONNECTION_LOST`).
 */
export async function requestStudioExtensions(command: StudioExtensionsRequest): Promise<StudioExtensionsReply> {
  try {
    if (window.__studioExtensions) return await window.__studioExtensions.request(command);
    const response = await fetch(ROUTE, {
      method: 'POST',
      credentials: 'include',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'X-Studio-Extensions': '1' },
      body: JSON.stringify(command),
      redirect: 'error',
      signal: AbortSignal.timeout(25000),
    });
    if (!response.ok) return await refusalOf(response);
    return (await response.json()) as StudioExtensionsReply;
  } catch {
    return { ok: false, code: 'CONNECTION_LOST' };
  }
}
