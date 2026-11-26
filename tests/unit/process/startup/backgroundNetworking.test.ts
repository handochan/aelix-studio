import { describe, expect, it, vi } from 'vitest';
import type { App, Session, WebContents } from 'electron';
import {
  applyStudioRendererNetworkPolicy,
  configureBackgroundNetworking,
  isManagedStudioRendererSession,
  prepareStudioRendererSession,
  protectStudioResources,
  setStudioRenderersOffline,
} from '@/process/startup/backgroundNetworking';

describe('Chromium background network policy', () => {
  it('configures engine defaults before ready and retains the OS DNS policy after ready', () => {
    const appendSwitch = vi.fn();
    const configureHostResolver = vi.fn();
    const on = vi.fn();
    configureBackgroundNetworking({
      commandLine: { appendSwitch } as unknown as App['commandLine'],
      on,
      configureHostResolver,
    });
    expect(appendSwitch.mock.calls).toEqual([
      ['disable-background-networking'],
      ['disable-component-update'],
      ['disable-domain-reliability'],
    ]);
    expect(configureHostResolver).not.toHaveBeenCalled();
    on.mock.calls[0][1]();
    expect(configureHostResolver).toHaveBeenCalledWith({ enableBuiltInResolver: false, secureDnsMode: 'off' });
  });
  it('does not suppress an engine configuration failure', () => {
    expect(() =>
      configureBackgroundNetworking({
        commandLine: {
          appendSwitch: () => {
            throw new Error('engine unavailable');
          },
        } as unknown as App['commandLine'],
        on: vi.fn(),
        configureHostResolver: vi.fn(),
      })
    ).toThrow('engine unavailable');
  });
});

describe('Studio offline request policy', () => {
  it('blocks external document assets and the remote-image relay only while offline', () => {
    const onBeforeRequest = vi.fn();
    let offline = false;
    protectStudioResources(
      { webRequest: { onBeforeRequest } as unknown as Session['webRequest'] },
      () => offline,
      (url) =>
        url.origin === 'http://127.0.0.1:13400' &&
        ['/api/fs/fetch-remote-image', '/api/system/check-update'].includes(url.pathname)
    );
    const inspect = (url: string) => {
      const reply = vi.fn();
      onBeforeRequest.mock.calls[0][0]({ url }, reply);
      return Boolean(reply.mock.calls[0][0].cancel);
    };
    const external = [
      'https://example.test/font.woff2',
      'http://192.0.2.1/asset.css',
      'https://127.0.0.1.example.test/asset.css',
      'wss://example.test/socket',
      'file://example.test/share/image.jpg',
      'http://127.0.0.1:13400/api/fs/fetch-remote-image',
      'http://127.0.0.1:13400/api/system/check-update',
    ];
    expect(external.some(inspect)).toBe(false);
    offline = true;
    expect(external.every(inspect)).toBe(true);
    expect(
      [
        'http://localhost/sprite.svg',
        'http://127.0.0.2/sprite.svg',
        'http://[::1]/sprite.svg',
        'http://[::ffff:127.0.0.1]/sprite.svg',
        'ws://127.0.0.1:13400/ws',
        'http://127.0.0.1:13400/api/fs/content',
        'file:///fixtures/image.png',
        'data:image/png;base64,stuff',
      ].some(inspect)
    ).toBe(false);
  });
});

it('prepares a fresh offline settings partition and disconnects existing partitions on the live switch', async () => {
  const application = { once: vi.fn() } as unknown as Pick<App, 'once'>;
  const makeSession = () => ({
    webRequest: { onBeforeRequest: vi.fn() },
    setProxy: vi.fn().mockResolvedValue(undefined),
    closeAllConnections: vi.fn().mockResolvedValue(undefined),
  });
  const renderer = makeSession();
  const extension = makeSession();
  const fresh = makeSession();
  const detached = makeSession();
  const session = (fixture: ReturnType<typeof makeSession>) => fixture as unknown as Session;
  const contents = (fixture: ReturnType<typeof makeSession>, type = 'webview') => ({
    getType: () => type,
    session: session(fixture),
    setWebRTCIPHandlingPolicy: vi.fn(),
  });
  const existingMain = contents(renderer, 'window');
  const existingGuest = contents(extension);
  const explicitBrowser = contents(detached);
  const guests = () => [existingMain, existingGuest, explicitBrowser] as unknown as WebContents[];
  await prepareStudioRendererSession(application, session(renderer), () => false);
  await prepareStudioRendererSession(application, session(extension), () => false);
  expect(extension.setProxy).not.toHaveBeenCalled();
  applyStudioRendererNetworkPolicy(existingMain as unknown as WebContents);
  expect(existingMain.setWebRTCIPHandlingPolicy).toHaveBeenLastCalledWith('default');
  try {
    await setStudioRenderersOffline(application, true, guests);
    expect(extension.setProxy).toHaveBeenCalledWith({
      mode: 'fixed_servers',
      proxyRules: expect.stringMatching(/^socks5:\/\/127\.0\.0\.1:/),
    });
    expect(extension.closeAllConnections).toHaveBeenCalledOnce();
    expect(existingGuest.setWebRTCIPHandlingPolicy).toHaveBeenLastCalledWith('disable_non_proxied_udp');
    expect(explicitBrowser.setWebRTCIPHandlingPolicy).not.toHaveBeenCalled();
    expect(existingMain.setWebRTCIPHandlingPolicy).toHaveBeenLastCalledWith('disable_non_proxied_udp');
    const freshMain = contents(renderer, 'window');
    applyStudioRendererNetworkPolicy(freshMain as unknown as WebContents);
    expect(freshMain.setWebRTCIPHandlingPolicy).toHaveBeenLastCalledWith('disable_non_proxied_udp');

    fresh.setProxy.mockRejectedValueOnce(new Error('proxy failure'));
    await expect(prepareStudioRendererSession(application, session(fresh), () => true)).rejects.toThrow(
      'proxy failure'
    );
    expect(isManagedStudioRendererSession(session(fresh))).toBe(false);
    await prepareStudioRendererSession(application, session(fresh), () => true);
    expect(isManagedStudioRendererSession(session(fresh))).toBe(true);
    expect(fresh.closeAllConnections).toHaveBeenCalledOnce();
    const firstGuest = contents(fresh);
    applyStudioRendererNetworkPolicy(firstGuest as unknown as WebContents);
    expect(firstGuest.setWebRTCIPHandlingPolicy).toHaveBeenCalledWith('disable_non_proxied_udp');
  } finally {
    await setStudioRenderersOffline(application, false, guests);
    vi.mocked(application.once).mock.calls[0]?.[1]();
  }
  expect(extension.setProxy).toHaveBeenLastCalledWith({ mode: 'system' });
  expect(existingGuest.setWebRTCIPHandlingPolicy).toHaveBeenLastCalledWith('default');
  expect(existingMain.setWebRTCIPHandlingPolicy).toHaveBeenLastCalledWith('default');
});
