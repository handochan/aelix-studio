/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import type { App, BrowserWindow } from 'electron';
import { APP_SLUG } from '@/common/config/appIdentity';
import { ipcBridge } from '@/common';

export const PROTOCOL_SCHEME = APP_SLUG;

/** Let NSIS own the Windows handler, including when a developer runs Electron directly. */
export function registerStudioProtocol(
  app: Pick<App, 'setAsDefaultProtocolClient'>,
  platform = process.platform,
  defaultApp = process.defaultApp,
  argv = process.argv,
  executable = process.execPath
): void {
  if (platform === 'win32') return;

  if (defaultApp) {
    const entryPoint = argv[1];
    if (entryPoint) app.setAsDefaultProtocolClient(PROTOCOL_SCHEME, executable, [path.resolve(entryPoint)]);
  } else {
    app.setAsDefaultProtocolClient(PROTOCOL_SCHEME);
  }
}

/**
 * Parse an aelix-studio:// URL into action and params.
 * Supports two formats:
 *   1. aelix-studio://add-provider?base_url=xxx&api_key=xxx
 *   2. aelix-studio://provider/add?v=1&data=<base64 JSON>  (one-api / new-api style)
 */
export const parseDeepLinkUrl = (url: string): { action: string; params: Record<string, string> } | null => {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== `${PROTOCOL_SCHEME}:`) return null;

    const hostname = parsed.hostname || '';
    const pathname = parsed.pathname.replace(/^\/+/, '');
    const action = pathname ? `${hostname}/${pathname}` : hostname;

    const params: Record<string, string> = {};
    parsed.searchParams.forEach((value, key) => {
      params[key] = value;
    });

    // If data param exists, decode base64 JSON and merge into params
    if (params.data) {
      try {
        const json = JSON.parse(Buffer.from(params.data, 'base64').toString('utf-8'));
        if (json && typeof json === 'object') {
          Object.assign(params, json);
        }
      } catch {
        // Ignore decode errors
      }
      delete params.data;
    }

    return { action, params };
  } catch {
    return null;
  }
};

let mainWindowRef: BrowserWindow | null = null;
let pendingDeepLinkUrl: string | null = process.argv.find((arg) => arg.startsWith(`${PROTOCOL_SCHEME}://`)) || null;

export const setDeepLinkMainWindow = (win: BrowserWindow): void => {
  mainWindowRef = win;
};

export const getPendingDeepLinkUrl = (): string | null => pendingDeepLinkUrl;

export const clearPendingDeepLinkUrl = (): void => {
  pendingDeepLinkUrl = null;
};

/**
 * Send the deep-link payload to the renderer via IPC bridge.
 * If the window isn't ready yet, queue it.
 */
export const handleDeepLinkUrl = (url: string): void => {
  const parsed = parseDeepLinkUrl(url);
  if (!parsed) return;

  if (!mainWindowRef || mainWindowRef.isDestroyed()) {
    pendingDeepLinkUrl = url;
    return;
  }

  ipcBridge.deepLink.received.emit(parsed);
};
