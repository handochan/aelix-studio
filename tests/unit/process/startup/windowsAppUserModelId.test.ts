/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { parseDeepLinkUrl, PROTOCOL_SCHEME } from '@/process/utils/deepLink';
import fs from 'node:fs';
import path from 'node:path';
import { registerWindowsAppUserModelId, WINDOWS_APP_USER_MODEL_ID } from '@/process/startup/windowsAppUserModelId';

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

  it('rejects links intended for the upstream app', () => {
    expect(parseDeepLinkUrl('aionui://add-provider?base_url=http%3A%2F%2Flocalhost')).toBeNull();
  });
});
