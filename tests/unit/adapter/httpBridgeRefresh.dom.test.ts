/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { httpRequest } from '@/common/adapter/httpBridge';

type WindowWithPort = { __backendPort?: number };

/** Minimal `Response`-like stub covering the fields `httpRequest` reads. */
function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null) },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function errorResponse(status: number, body: unknown) {
  return {
    ok: false,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
  };
}

describe('httpRequest 401 → refresh → replay (WebUI #4124 fix)', () => {
  beforeEach(() => {
    // Browser mode so getBaseUrl() === '' and refresh is active.
    delete (window as WindowWithPort).__backendPort;
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete (window as WindowWithPort).__backendPort;
  });

  it('refreshes once and replays the original request on 401, returning unwrapped data', async () => {
    let dataCalls = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/api/auth/refresh') return { ok: true };
      dataCalls += 1;
      if (dataCalls === 1) return errorResponse(401, { code: 'UNAUTHORIZED', error: 'expired' });
      return jsonResponse(200, { data: { value: 42 } });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(httpRequest('GET', '/api/data')).resolves.toEqual({ value: 42 });

    // original 401 + refresh + replay = 3 calls
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(['/api/data', '/api/auth/refresh', '/api/data']);
  });

  it.each(['/api/conversations/c1/active-lease', '/api/conversations/c1/runtime/release'])(
    'replays the exact bounded request to %s after one cookie refresh',
    async (path) => {
      let accessExpired = true;
      const fetchMock = vi.fn(async (url: string, _init: RequestInit) => {
        if (url === '/api/auth/refresh') {
          accessExpired = false;
          return { ok: true };
        }
        return accessExpired
          ? errorResponse(401, { code: 'UNAUTHORIZED', error: 'expired' })
          : jsonResponse(200, { data: { outcome: 'deferred' } });
      });
      vi.stubGlobal('fetch', fetchMock);
      const body = { view_id: 'current-view' };

      await expect(httpRequest('POST', path, body, { timeoutMs: 1_000 })).resolves.toEqual({ outcome: 'deferred' });

      const [original, refresh, retry] = fetchMock.mock.calls;
      expect([original[0], refresh[0], retry[0]]).toEqual([path, '/api/auth/refresh', path]);
      expect(refresh[1].credentials).toBe('include');
      expect(retry[1]).toMatchObject({ body: JSON.stringify(body), signal: original[1].signal });
    }
  );

  it('stops waiting at the original deadline without replaying after a late refresh', async () => {
    let finishRefresh: (value: { ok: boolean }) => void = () => {};
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/api/auth/refresh') {
        return new Promise<{ ok: boolean }>((resolve) => {
          finishRefresh = resolve;
        });
      }
      return errorResponse(401, { code: 'UNAUTHORIZED', error: 'expired' });
    });
    vi.stubGlobal('fetch', fetchMock);

    try {
      await expect(
        httpRequest('POST', '/api/release', { view_id: 'current-view' }, { timeoutMs: 20 })
      ).rejects.toMatchObject({ name: 'TimeoutError' });
    } finally {
      finishRefresh({ ok: true });
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['/api/release', '/api/auth/refresh']);
  });

  it('does not refresh or retry permission denials', async () => {
    const fetchMock = vi.fn(async () => errorResponse(403, { code: 'SOURCE_FORBIDDEN' }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(httpRequest('POST', '/api/release', { view_id: 'view' }, { timeoutMs: 100 })).rejects.toMatchObject({
      status: 403,
      code: 'SOURCE_FORBIDDEN',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws the original 401 when the refresh also fails (no infinite retry)', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/api/auth/refresh') return { ok: false, status: 401 };
      return errorResponse(401, { code: 'UNAUTHORIZED', error: 'expired' });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(httpRequest('GET', '/api/data')).rejects.toMatchObject({
      name: 'BackendHttpError',
      status: 401,
      code: 'UNAUTHORIZED',
    });

    // original 401 + one refresh attempt, then give up (no replay)
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not refresh when the first response succeeds', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { data: { ok: true } }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(httpRequest('GET', '/api/data')).resolves.toEqual({ ok: true });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalledWith('/api/auth/refresh', expect.anything());
  });

  it('does not recurse when the refresh endpoint itself returns 401', async () => {
    const fetchMock = vi.fn(async () => errorResponse(401, { code: 'UNAUTHORIZED', error: 'expired' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(httpRequest('POST', '/api/auth/refresh')).rejects.toMatchObject({
      name: 'BackendHttpError',
      status: 401,
    });

    // Called exactly once — the auth endpoint is exempt from refresh-replay.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
