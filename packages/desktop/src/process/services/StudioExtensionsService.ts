/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { app, type IpcMainInvokeEvent } from 'electron';
import {
  configureStudioExtensions,
  disposeStudioExtensions,
  getStudioExtensionService,
  type ExtensionService,
  type StudioExtensionsReply,
} from '@aionui/web-host';
import { createProxyCredentialVault, type SafeStorageLike } from './ProxyCredentialVaultService';

/** The largest request the channel takes; the WebUI route has the same cap. */
const REQUEST_LIMIT = 60000;

/**
 * Configure the Studio extension helper for this desktop process (Studio #32, ADR 5.11).
 *
 * Call after app `ready`: Electron reports the Linux secret store only then, and the vault
 * decides whether proxy credentials can be kept. The desktop window's IPC channel and the
 * WebUI this process may serve share the one service. Unexpected errors are logged by name
 * and message only.
 */
export function startStudioExtensions(storage?: SafeStorageLike): ExtensionService {
  const service = configureStudioExtensions({
    userDataPath: app.getPath('userData'),
    proxyVault: createProxyCredentialVault(storage),
    log: (message, error) =>
      console.error(
        `[StudioExtensions] ${message}`,
        error instanceof Error ? `${error.name}: ${error.message}` : typeof error
      ),
  });
  app.once('before-quit', () => void disposeStudioExtensions());
  return service;
}

/**
 * The handler of the `studio:extensions` channel. Only the Studio window (`trusted`, the
 * check native auth uses) is answered; each window owns what it starts. Requests can carry
 * proxy credentials: the channel is its own, outside the generic bridge and its logging.
 */
export function studioExtensionsIpcHandler(
  trusted: (event: IpcMainInvokeEvent) => boolean,
  service: () => ExtensionService | undefined = getStudioExtensionService
): (event: IpcMainInvokeEvent, command: unknown) => Promise<StudioExtensionsReply> {
  return async (event, command) => {
    if (!trusted(event)) return { ok: false, code: 'FORBIDDEN' };
    let size: number;
    try {
      size = JSON.stringify(command ?? null).length;
    } catch {
      return { ok: false, code: 'INVALID_INPUT' };
    }
    if (size > REQUEST_LIMIT) return { ok: false, code: 'FRAME_LIMIT' };
    const current = service();
    if (!current) return { ok: false, code: 'RUNTIME_UNAVAILABLE' };
    return current.request(`desktop:${event.sender.id}`, command);
  };
}

/** Stop the change a window started when it goes away or loads another page. */
export function cancelStudioExtensionsOf(webContentsId: number): void {
  getStudioExtensionService()?.cancelOwner(`desktop:${webContentsId}`);
}
