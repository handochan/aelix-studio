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

/** The largest request the channel takes, in UTF-8 bytes; the WebUI route has the same cap. */
const REQUEST_LIMIT = 60000;
const DEPTH_LIMIT = 16;

/**
 * JSON data and nothing else: null, booleans, finite numbers, strings, arrays and objects
 * whose prototype is Object's (or none). IPC also delivers buffers, typed arrays, dates and
 * maps; none of them is a request, and JSON would hide them as `{}`.
 */
function plainData(value: unknown, depth = 0): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || depth > DEPTH_LIMIT) return false;
  if (Array.isArray(value)) return value.every((item) => plainData(item, depth + 1));
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.values(value).every((item) => plainData(item, depth + 1));
}

/**
 * Configure the Studio extension helper for this desktop process (Studio #32, ADR 5.11).
 *
 * Call after app `ready`: Electron reports the Linux secret store only then, and the vault
 * decides whether proxy credentials can be kept. The desktop window's IPC channel and the
 * WebUI this process may serve share the one service. Unexpected errors are logged by name
 * and message only.
 */
export function startStudioExtensions(storage?: SafeStorageLike, platform?: NodeJS.Platform): ExtensionService {
  const service = configureStudioExtensions({
    userDataPath: app.getPath('userData'),
    proxyVault: createProxyCredentialVault(storage, platform),
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
 * check native auth uses) is answered, and in a packaged app not while its DevTools are open;
 * each window owns what it starts. A request is JSON data of at most 60 kB in UTF-8. Requests
 * can carry proxy credentials: the channel is its own, outside the generic bridge and its
 * logging. A window of this app is on this machine, so a secret never crosses a network on
 * this channel: every reply says `transport: 'secure'`, refusals included.
 */
export function studioExtensionsIpcHandler(
  trusted: (event: IpcMainInvokeEvent) => boolean,
  service: () => ExtensionService | undefined = getStudioExtensionService,
  packaged: () => boolean = () => app.isPackaged
): (event: IpcMainInvokeEvent, command: unknown) => Promise<StudioExtensionsReply> {
  const answer = async (event: IpcMainInvokeEvent, command: unknown): Promise<StudioExtensionsReply> => {
    if (!trusted(event)) return { ok: false, code: 'FORBIDDEN' };
    // Self-XSS: in a released app, nothing typed into an open DevTools console reaches the
    // helper (or the keychain through it). Development builds keep the console usable.
    if (packaged() && event.sender.isDevToolsOpened()) return { ok: false, code: 'FORBIDDEN' };
    const isObject = typeof command === 'object' && command !== null && !Array.isArray(command);
    if (!isObject || !plainData(command)) return { ok: false, code: 'INVALID_INPUT' };
    if (Buffer.byteLength(JSON.stringify(command), 'utf8') > REQUEST_LIMIT) return { ok: false, code: 'FRAME_LIMIT' };
    // The window is on this machine: no network to warn about, and the helper never sees the flag.
    const { acknowledgeInsecureTransport: _acknowledged, ...request } = command as Record<string, unknown>;
    const current = service();
    if (!current) return { ok: false, code: 'RUNTIME_UNAVAILABLE' };
    return current.request(`desktop:${event.sender.id}`, request);
  };
  return async (event, command) => ({ ...(await answer(event, command)), transport: 'secure' });
}

/** Stop the change a window started when it goes away or loads another page. */
export function cancelStudioExtensionsOf(webContentsId: number): void {
  getStudioExtensionService()?.cancelOwner(`desktop:${webContentsId}`);
}
