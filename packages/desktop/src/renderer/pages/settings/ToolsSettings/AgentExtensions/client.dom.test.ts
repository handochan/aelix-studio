/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { requestStudioExtensions } from './client';

describe('the screen client of the extension helper', () => {
  afterEach(() => {
    delete window.__studioExtensions;
    vi.unstubAllGlobals();
  });

  it('uses the desktop window channel when there is one, and nothing else', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    window.__studioExtensions = { request: vi.fn(async () => ({ ok: false as const, code: 'BUSY' as const })) };
    expect(await requestStudioExtensions({ action: 'list' })).toEqual({ ok: false, code: 'BUSY' });
    expect(window.__studioExtensions.request).toHaveBeenCalledWith({ action: 'list' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('posts to the WebUI route of its own origin with the marker header, uncached', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true, data: { current: null } })));
    vi.stubGlobal('fetch', fetch);
    expect(await requestStudioExtensions({ action: 'get_settings' })).toEqual({ ok: true, data: { current: null } });
    expect(fetch).toHaveBeenCalledWith(
      '/api/studio/extensions',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json', 'X-Studio-Extensions': '1' },
        body: JSON.stringify({ action: 'get_settings' }),
      })
    );
  });

  it.each([
    [401, 'UNAUTHENTICATED'],
    [403, 'FORBIDDEN'],
    [413, 'FRAME_LIMIT'],
    [400, 'INVALID_INPUT'],
    [503, 'UNAVAILABLE'],
    [502, 'UNAVAILABLE'],
  ])('maps a %i of the route to %s', async (status, code) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status }))
    );
    expect(await requestStudioExtensions({ action: 'list' })).toEqual({ ok: false, code });
  });

  it('never sends a request again when its answer is lost: the change may have been made', async () => {
    const credentials = { username: 'ops', password: 'sentinel-secret' };
    const fetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    vi.stubGlobal('fetch', fetch);
    const reply = await requestStudioExtensions({
      action: 'install',
      source: { kind: 'index', name: 'demo' },
      proxyCredentials: credentials,
    });
    expect(reply).toEqual({ ok: false, code: 'CONNECTION_LOST' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(reply)).not.toContain('sentinel-secret');
    window.__studioExtensions = {
      request: vi.fn(async () => {
        throw new Error('channel closed');
      }),
    };
    expect(await requestStudioExtensions({ action: 'list' })).toEqual({ ok: false, code: 'CONNECTION_LOST' });
    expect(window.__studioExtensions.request).toHaveBeenCalledTimes(1);
  });
});
