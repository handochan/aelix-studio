/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import {
  clearPendingDeepLinkUrl,
  getPendingDeepLinkUrl,
  handleDeepLinkUrl,
  parseDeepLinkUrl,
  PROTOCOL_SCHEME,
  registerStudioProtocol,
  setDeepLinkMainWindow,
} from '@/process/utils/deepLink';
import fs from 'node:fs';
import path from 'node:path';
import { registerWindowsAppUserModelId, WINDOWS_APP_USER_MODEL_ID } from '@/process/startup/windowsAppUserModelId';

const emitDeepLink = vi.hoisted(() => vi.fn());
vi.mock('@/common', () => ({ ipcBridge: { deepLink: { received: { emit: emitDeepLink } } } }));

const makeApp = (isPackaged: boolean) => ({
  isPackaged,
  setAppUserModelId: vi.fn(),
});

describe('registerWindowsAppUserModelId', () => {
  it('registers the electron-builder appId on packaged win32 builds', () => {
    const app = makeApp(true);
    registerWindowsAppUserModelId({ app, platform: 'win32', execPath: 'C:\\app\\Aelix Studio.exe' });
    expect(app.setAppUserModelId).toHaveBeenCalledTimes(1);
    expect(app.setAppUserModelId).toHaveBeenCalledWith(WINDOWS_APP_USER_MODEL_ID);
  });

  it('registers process.execPath on win32 development builds', () => {
    const app = makeApp(false);
    registerWindowsAppUserModelId({ app, platform: 'win32', execPath: 'C:\\dev\\electron.exe' });
    expect(app.setAppUserModelId).toHaveBeenCalledTimes(1);
    expect(app.setAppUserModelId).toHaveBeenCalledWith('C:\\dev\\electron.exe');
  });

  it('does not register on non-win32 platforms', () => {
    const app = makeApp(true);
    registerWindowsAppUserModelId({ app, platform: 'darwin', execPath: '/usr/local/bin/electron' });
    expect(app.setAppUserModelId).not.toHaveBeenCalled();
  });

  it('stays in sync with the appId in electron-builder.yml', () => {
    const ymlPath = path.resolve(__dirname, '../../../../packages/desktop/electron-builder.yml');
    const yml = fs.readFileSync(ymlPath, 'utf8');
    const match = yml.match(/^appId:\s*(\S+)\s*$/m);
    expect(match?.[1]).toBe(WINDOWS_APP_USER_MODEL_ID);
  });
});

describe('Studio deep links', () => {
  it('registers the same Studio scheme as the app package', () => {
    const config = fs.readFileSync(
      path.resolve(__dirname, '../../../../packages/desktop/electron-builder.yml'),
      'utf8'
    );
    expect(config).toMatch(new RegExp(`^      - ${PROTOCOL_SCHEME}$`, 'm'));
    expect(parseDeepLinkUrl('aelix-studio://add-provider?base_url=http%3A%2F%2Flocalhost')).not.toBeNull();
  });

  it.each([true, false])('keeps Windows protocol registration under NSIS ownership (defaultApp=%s)', (defaultApp) => {
    const write = vi.fn();
    registerStudioProtocol(
      { setAsDefaultProtocolClient: write },
      'win32',
      defaultApp,
      ['electron', '.'],
      'C:/dev/electron.exe'
    );
    expect(write).not.toHaveBeenCalled();
  });

  it('queues the Studio link for a window that has yet to start', () => {
    const link = 'aelix-studio://add-provider?base_url=http%3A%2F%2Flocalhost';
    clearPendingDeepLinkUrl();
    handleDeepLinkUrl(link);
    handleDeepLinkUrl('aionui://add-provider?base_url=http%3A%2F%2Flocalhost');
    expect(getPendingDeepLinkUrl()).toBe(link);
    clearPendingDeepLinkUrl();
  });

  it('delivers a Studio link to the running window and blocks the upstream scheme', () => {
    emitDeepLink.mockClear();
    const window = { isDestroyed: () => false } as import('electron').BrowserWindow;
    setDeepLinkMainWindow(window);
    try {
      handleDeepLinkUrl('aionui://add-provider?name=upstream');
      expect(emitDeepLink).not.toHaveBeenCalled();
      handleDeepLinkUrl('aelix-studio://add-provider?name=studio');
      expect(emitDeepLink).toHaveBeenCalledExactlyOnceWith({ action: 'add-provider', params: { name: 'studio' } });
    } finally {
      setDeepLinkMainWindow({ isDestroyed: () => true } as import('electron').BrowserWindow);
    }
  });

  it('rejects links intended for the upstream app', () => {
    expect(parseDeepLinkUrl('aionui://add-provider?base_url=http%3A%2F%2Flocalhost')).toBeNull();
  });
});
