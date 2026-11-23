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
import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { getNativeAuthService } from '@aionui/web-host';
import { protectStudioRequests } from '../backend/studioRequest';
import { cancelStudioExtensionsOf, studioExtensionsIpcHandler } from '../services/StudioExtensionsService';

export type BridgeDependencies = Record<string, never>;

const nativeAuthWindows = new Map<number, Set<string>>();
const withoutHash = (value: string): string => {
  const url = new URL(value);
  url.hash = '';
  return url.href;
};

/**
 * Only the registered Studio main window may use the credential-bearing channels (native
 * auth and the extension helper). What the window started ends when it navigates away or
 * goes away.
 */
export function registerNativeAuthWindow(win: BrowserWindow, rendererUrls: string[]): void {
  const id = win.webContents.id;
  nativeAuthWindows.set(id, new Set(rendererUrls.map(withoutHash)));
  protectStudioRequests(win.webContents.session, nativeAuthWindows);
  win.webContents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
    if (mainFrame && !inPlace) {
      getNativeAuthService().cancelOwner(`desktop:${id}`);
      cancelStudioExtensionsOf(id);
    }
  });
  win.webContents.once('destroyed', () => {
    nativeAuthWindows.delete(id);
    getNativeAuthService().cancelOwner(`desktop:${id}`);
    cancelStudioExtensionsOf(id);
  });
}

/** The registered Studio window's own main frame, on one of its page URLs. */
function isTrustedStudioSender(event: IpcMainInvokeEvent): boolean {
  const trusted = nativeAuthWindows.get(event.sender.id);
  return Boolean(
    BrowserWindow.fromWebContents(event.sender) &&
    event.senderFrame === event.sender.mainFrame &&
    trusted?.has(withoutHash(event.sender.getURL()))
  );
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
    if (!isTrustedStudioSender(event)) return { ok: false, code: 'FORBIDDEN' };
    return nativeAuth.request(`desktop:${event.sender.id}`, command, app.getPath('userData'));
  });
  // The extension helper is configured after app ready; until then it answers RUNTIME_UNAVAILABLE.
  ipcMain.handle('studio:extensions', studioExtensionsIpcHandler(isTrustedStudioSender));
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
