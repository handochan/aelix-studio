/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { initApplicationBridge } from './applicationBridge';
import { initDialogBridge } from './dialogBridge';
import { initUpdateBridge } from './updateBridge';
import { initSystemSettingsBridge } from './systemSettingsBridge';
import { initWindowControlsBridge } from './windowControlsBridge';
import { initNotificationBridge } from './notificationBridge';
import { initWebuiBridge } from './webuiBridge';
import { initThemeBridge } from './themeBridge';
import { app, BrowserWindow, ipcMain } from 'electron';
import { getNativeAuthService } from '@aionui/web-host';

export type BridgeDependencies = Record<string, never>;

const nativeAuthWindows = new Map<number, Set<string>>();
const withoutHash = (value: string): string => {
  const url = new URL(value);
  url.hash = '';
  return url.href;
};

/** Only the registered Studio main window may use the credential-bearing channel. */
export function registerNativeAuthWindow(win: BrowserWindow, rendererUrls: string[]): void {
  const id = win.webContents.id;
  nativeAuthWindows.set(id, new Set(rendererUrls.map(withoutHash)));
  win.webContents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
    if (mainFrame && !inPlace) getNativeAuthService().cancelOwner(`desktop:${id}`);
  });
  win.webContents.once('destroyed', () => {
    nativeAuthWindows.delete(id);
    getNativeAuthService().cancelOwner(`desktop:${id}`);
  });
}

export function initAllBridges(_deps: BridgeDependencies = {}): void {
  initDialogBridge();
  initApplicationBridge();
  initWindowControlsBridge();
  initUpdateBridge();
  initSystemSettingsBridge();
  initNotificationBridge();
  initWebuiBridge();
  initThemeBridge();
  const nativeAuth = getNativeAuthService();
  ipcMain.handle('studio:native-auth', (event, command: unknown) => {
    const trusted = nativeAuthWindows.get(event.sender.id);
    if (
      !BrowserWindow.fromWebContents(event.sender) ||
      event.senderFrame !== event.sender.mainFrame ||
      !trusted?.has(withoutHash(event.sender.getURL()))
    ) {
      return { ok: false, code: 'FORBIDDEN' };
    }
    return nativeAuth.request(`desktop:${event.sender.id}`, command);
  });
  app.once('before-quit', () => nativeAuth.dispose());
}

export {
  initApplicationBridge,
  initDialogBridge,
  initNotificationBridge,
  initSystemSettingsBridge,
  initThemeBridge,
  initUpdateBridge,
  initWindowControlsBridge,
  initWebuiBridge,
};
export { registerWindowMaximizeListeners } from './windowControlsBridge';
export const disposeAllTeamSessions = (): Promise<void> => Promise.resolve();
