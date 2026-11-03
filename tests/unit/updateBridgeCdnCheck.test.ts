/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/common/platform/bridge', () => ({
  bridge: {
    buildProvider: vi.fn(() => {
      const handlerMap = new Map<string, Function>();
      return {
        provider: vi.fn((handler: Function) => {
          handlerMap.set('handler', handler);
          return vi.fn();
        }),
        invoke: vi.fn(),
        _getHandler: () => handlerMap.get('handler'),
      };
    }),
    buildEmitter: vi.fn(() => ({
      emit: vi.fn(),
      on: vi.fn(),
    })),
  },
}));

vi.mock('electron', () => ({
  app: {
    getVersion: vi.fn(() => '2.1.40'),
    getPath: vi.fn(() => '/test/path'),
    exit: vi.fn(),
    isPackaged: true,
  },
  autoUpdater: {
    on: vi.fn(),
    removeListener: vi.fn(),
  },
}));

vi.mock('electron-updater', () => ({
  autoUpdater: {
    logger: null,
    autoDownload: false,
    autoInstallOnAppQuit: true,
    allowPrerelease: false,
    allowDowngrade: false,
    setFeedURL: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
    checkForUpdates: vi.fn(),
    downloadUpdate: vi.fn(),
    quitAndInstall: vi.fn(),
    checkForUpdatesAndNotify: vi.fn(),
  },
}));

vi.mock('electron-log', () => ({
  default: {
    transports: { file: { level: 'info' } },
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock('@process/services/i18n', () => ({
  default: { t: (key: string) => key },
}));

// The fixtures below are mac-arm64 assets and both resolveCdnChannelFile and
// pickRecommendedAsset read the host platform/arch, so pin the runtime to keep
// results identical on every CI runner (linux/windows x64 would otherwise
// filter the assets out and pick no recommended asset).
import { afterAll, beforeAll } from 'vitest';

const realPlatform = process.platform;
const realArch = process.arch;
beforeAll(() => {
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  Object.defineProperty(process, 'arch', { value: 'arm64', configurable: true });
});
afterAll(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
  Object.defineProperty(process, 'arch', { value: realArch, configurable: true });
});

const release = (version = '2.1.45', prerelease = false) => ({
  tag_name: `v${version}`,
  prerelease,
  draft: false,
  name: version,
  body: 'Studio notes',
  html_url: `https://github.com/handochan/aelix-studio/releases/tag/v${version}`,
  assets: [
    {
      name: `Studio-${version}-mac-arm64.dmg`,
      size: 123,
      browser_download_url: `https://github.com/handochan/aelix-studio/releases/download/v${version}/Studio-${version}-mac-arm64.dmg`,
    },
  ],
});
const handler = async () => {
  vi.resetModules();
  const { initUpdateBridge } = await import('@process/bridge/updateBridge');
  const { ipcBridge } = await import('@/common');
  initUpdateBridge();
  return vi.mocked(ipcBridge.update.check.provider).mock.calls.at(-1)![0];
};
describe('manual Studio release checks', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.unstubAllGlobals());
  it('uses Studio Releases even when a legacy renderer asks for AionUi', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify([release()])));
    vi.stubGlobal('fetch', fetch);
    const result = await (await handler())({ repo: 'iOfficeAI/AionUi' });
    expect(fetch).toHaveBeenCalledWith(
      'https://api.github.com/repos/handochan/aelix-studio/releases',
      expect.any(Object)
    );
    expect(result.data?.latest?.assets[0].url).toContain('/handochan/aelix-studio/releases/download/');
    expect(result.data?.updateAvailable).toBe(true);
  });
  it('ignores drafts, invalid versions and prereleases by default and sorts by semver', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify([
              release('2.1.45'),
              release('2.2.0-beta.1', true),
              { ...release('9.0.0'), draft: true },
              release('bad'),
              release('2.1.46'),
            ])
          )
        )
    );
    const result = await (await handler())({});
    expect(result.data?.latest?.version).toBe('2.1.46');
  });
  it('permits an explicit prerelease check', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify([release('2.2.0-beta.1', true)]))));
    expect((await (await handler())({ includePrerelease: true })).data?.latest?.version).toBe('2.2.0-beta.1');
  });
  it('shows a manual network failure without falling back to an upstream service', async () => {
    const fetch = vi.fn().mockRejectedValue(new Error('offline'));
    vi.stubGlobal('fetch', fetch);
    expect(await (await handler())({})).toMatchObject({ success: false, msg: 'offline' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('handles an empty Studio feed without proposing an upstream update', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('[]')));
    expect((await (await handler())({})).data?.updateAvailable).toBe(false);
  });
});
