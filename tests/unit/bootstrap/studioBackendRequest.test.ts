import { describe, expect, it, vi } from 'vitest';
import type { OnBeforeSendHeadersListenerDetails, Session, WebContents } from 'electron';

vi.mock('@aionui/web-host', () => ({
  STUDIO_CREDENTIAL_HEADER: 'x-aionui-studio-auth',
  studioBackendCredential: (url: URL) =>
    url.hostname === '127.0.0.1' && url.port === '28751' ? 'synthetic-launch-credential' : undefined,
}));

import { protectStudioRequests } from '@process/backend/studioRequest';

function requester() {
  const mainFrame = {};
  const window = {
    id: 9,
    mainFrame,
    getURL: () => 'file:///studio/index.html#/chat',
    isDestroyed: () => false,
    getType: () => 'window',
  };
  const hook = vi.fn();
  const redirect = vi.fn();
  const session = {
    webRequest: {
      onBeforeSendHeaders: hook,
      onBeforeRedirect: redirect,
      onCompleted: vi.fn(),
      onErrorOccurred: vi.fn(),
    },
  } as unknown as Session;
  protectStudioRequests(session, new Map([[window.id, new Set(['file:///studio/index.html'])]]));
  const listener = hook.mock.calls[0][0] as (
    details: OnBeforeSendHeadersListenerDetails,
    callback: (response: { requestHeaders: Record<string, string> }) => void
  ) => void;

  return {
    window: window as unknown as WebContents,
    redirect: (id: number) => redirect.mock.calls[0][0]({ id }),
    request(details?: Partial<OnBeforeSendHeadersListenerDetails>) {
      const result = vi.fn();
      listener(
        {
          id: 1,
          webContents: window as unknown as WebContents,
          frame: mainFrame,
          resourceType: 'xhr',
          method: 'POST',
          url: 'http://127.0.0.1:28751/api/anything',
          requestHeaders: {},
          ...details,
        } as OnBeforeSendHeadersListenerDetails,
        result
      );
      return result.mock.calls[0][0].requestHeaders;
    },
  };
}

describe('Studio desktop backend request authority', () => {
  it('injects credentials for a trusted main-frame WebSocket', () => {
    const { request } = requester();
    const headers = request({ resourceType: 'webSocket', url: 'ws://127.0.0.1:28751/ws' });
    expect(headers['x-aionui-studio-auth']).toBe('synthetic-launch-credential');
  });

  it.each(['https://elsewhere.invalid', 'http://127.0.0.1:28752'])(
    'strips the credential on a different destination %s',
    (url) => {
      const { request } = requester();
      expect(request({ url, requestHeaders: { 'X-AionUI-Studio-Auth': 'synthetic-launch-credential' } })).toEqual({});
    }
  );

  it('keeps the launch credential out of requests from untrusted frames and navigations', () => {
    const { request } = requester();
    expect(request({ frame: null })).toEqual({});
    expect(request({ resourceType: 'mainFrame' })).toEqual({});
  });

  it('does not grant authority when a request redirects into the backend', () => {
    const { request, redirect } = requester();
    redirect(1);
    expect(request()).toEqual({});
  });

  it('keeps credentials out of an unregistered guest', () => {
    const { request, window } = requester();
    const guest = { ...window, id: 10, hostWebContents: window } as WebContents;
    expect(request({ webContents: guest, frame: guest.mainFrame })).toEqual({});
  });
});
