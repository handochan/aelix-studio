import { describe, expect, it, vi } from 'vitest';
import type { App, Session } from 'electron';
import { configureBackgroundNetworking, protectStudioResources } from '@/process/startup/backgroundNetworking';

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
      (url) => url.origin === 'http://127.0.0.1:13400'
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
