/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';

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
    getVersion: vi.fn(() => '1.0.0'),
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

import { mapGitHubRelease } from '@process/bridge/updateBridge';
const release = {
  tag_name: 'v1.2.3',
  html_url: 'https://github.com/handochan/aelix-studio/releases/tag/v1.2.3',
  prerelease: false,
  draft: false,
  assets: [
    {
      name: 'Studio-linux-x64.deb',
      browser_download_url: 'https://github.com/handochan/aelix-studio/releases/download/v1.2.3/Studio-linux-x64.deb',
      size: 100,
    },
    { name: 'latest.yml', browser_download_url: 'https://example.invalid/latest.yml', size: 10 },
  ],
};
describe('Studio release mapping', () => {
  it('preserves release URLs and excludes non-installer assets', () => {
    expect(mapGitHubRelease(release)?.assets).toEqual([
      { name: 'Studio-linux-x64.deb', url: release.assets[0].browser_download_url, size: 100, contentType: undefined },
    ]);
  });
  it('rejects non-semver releases and drafts', () => {
    expect(mapGitHubRelease({ ...release, tag_name: 'latest' })).toBeNull();
    expect(mapGitHubRelease({ ...release, draft: true })).toBeNull();
  });
});
