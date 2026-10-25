import { afterEach, describe, expect, it, vi } from 'vitest';
import { requestNativeAuth } from './nativeAuth';

describe('secret-bearing native auth transport', () => {
  afterEach(() => {
    delete window.__studioNativeAuth;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('does not log or replay a WebUI credential request rejected before admission', async () => {
    const fetcher = vi.fn(async () => new Response('{"ok":false,"code":"UNAUTHENTICATED"}', { status: 401 }));
    vi.stubGlobal('fetch', fetcher);
    const logs = [vi.spyOn(console, 'debug'), vi.spyOn(console, 'error'), vi.spyOn(console, 'log')];
    const reply = await requestNativeAuth({
      action: 'setKey',
      provider: 'openai',
      key: 'sentinel-secret',
      revision: 'one',
      exclusive: true,
    });
    expect(reply).toEqual({ ok: false, code: 'UNAUTHENTICATED' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(logs.every((log) => log.mock.calls.length === 0)).toBe(true);
  });

  it('keeps an ambiguous disconnect terminal rather than resending callback input', async () => {
    const fetcher = vi.fn(async () => {
      throw new Error('provider echoed secret');
    });
    vi.stubGlobal('fetch', fetcher);
    expect(
      await requestNativeAuth({ action: 'reply', operationId: 'one', challengeId: 'fresh', value: 'sentinel-secret' })
    ).toEqual({ ok: false, code: 'CONNECTION_LOST' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('uses the dedicated preload channel in desktop instead of HTTP', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    window.__studioNativeAuth = { request: vi.fn(async () => ({ ok: false as const, code: 'FORBIDDEN' })) };
    expect(await requestNativeAuth({ action: 'catalog' })).toEqual({ ok: false, code: 'FORBIDDEN' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('reads a successful WebUI reply on the same origin without retaining a secret', async () => {
    const fetcher = vi.fn(
      async () => new Response('{"ok":false,"code":"CONFLICT"}', { headers: { 'content-type': 'application/json' } })
    );
    vi.stubGlobal('fetch', fetcher);
    expect(
      await requestNativeAuth({
        action: 'setKey',
        provider: 'openai',
        key: 'sentinel-secret',
        revision: 'old',
        exclusive: true,
      })
    ).toEqual({ ok: false, code: 'CONFLICT' });
    expect(fetcher.mock.calls).toHaveLength(1);
  });
});
