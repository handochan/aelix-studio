/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

describe('Studio update download boundaries', () => {
  afterEach(() => vi.unstubAllGlobals());
  it.each([
    'https://static.aionui.com/releases/1/a.deb',
    'https://github.com/iOfficeAI/AionUi/releases/download/v1/a.deb',
    'http://github.com/handochan/aelix-studio/releases/download/v1/a.deb',
  ])('rejects an upstream or insecure download %s before connecting', async (url) => {
    vi.resetModules();
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const { initUpdateBridge } = await import('@process/bridge/updateBridge');
    const { ipcBridge } = await import('@/common');
    initUpdateBridge();
    const callback = vi.mocked(ipcBridge.update.download.provider).mock.calls.at(-1)![0];
    expect((await callback({ url, file_name: 'a.deb' })).success).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
});
