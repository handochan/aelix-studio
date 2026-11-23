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

const transportFailure = (status: number): StudioExtensionsReply => {
  if (status === 401) return { ok: false, code: 'UNAUTHENTICATED' };
  if (status === 403) return { ok: false, code: 'FORBIDDEN' };
  if (status === 413) return { ok: false, code: 'FRAME_LIMIT' };
  if (status === 400) return { ok: false, code: 'INVALID_INPUT' };
  return { ok: false, code: 'UNAVAILABLE' };
};

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
    if (!response.ok) return transportFailure(response.status);
    return (await response.json()) as StudioExtensionsReply;
  } catch {
    return { ok: false, code: 'CONNECTION_LOST' };
  }
}
