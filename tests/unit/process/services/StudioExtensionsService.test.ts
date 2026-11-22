/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { IpcMainInvokeEvent } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({
  userData: '',
  quitHandlers: [] as (() => void)[],
}));

vi.mock('electron', () => ({
  app: {
    getPath: () => electron.userData,
    once: (event: string, handler: () => void) => {
      if (event === 'before-quit') electron.quitHandlers.push(handler);
    },
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.alloc(0),
    decryptString: () => '',
  },
}));

import { disposeStudioExtensions, getStudioExtensionService, type ExtensionService } from '@aionui/web-host';
import {
  cancelStudioExtensionsOf,
  startStudioExtensions,
  studioExtensionsIpcHandler,
} from '@process/services/StudioExtensionsService';

const event = (id: number): IpcMainInvokeEvent => ({ sender: { id } }) as unknown as IpcMainInvokeEvent;

describe('the desktop channel of the extension helper', () => {
  beforeEach(async () => {
    electron.userData = await mkdtemp(path.join(os.tmpdir(), 'studio-desktop-extensions-'));
    electron.quitHandlers = [];
  });
  afterEach(async () => {
    await disposeStudioExtensions();
    await rm(electron.userData, { recursive: true, force: true });
  });

  it('answers only the Studio window, as that window', async () => {
    const request = vi.fn(async () => ({ ok: true as const, data: { current: null } }));
    const service = { request } as unknown as ExtensionService;
    const trusted = vi.fn((sender: IpcMainInvokeEvent) => sender.sender.id === 7);
    const handle = studioExtensionsIpcHandler(trusted, () => service);
    expect(await handle(event(8), { action: 'list' })).toEqual({ ok: false, code: 'FORBIDDEN' });
    expect(request).not.toHaveBeenCalled();
    expect(await handle(event(7), { action: 'list' })).toEqual({ ok: true, data: { current: null } });
    expect(request).toHaveBeenCalledWith('desktop:7', { action: 'list' });
  });

  it('refuses a request over 60 kB, or one that is not data, before the helper sees it', async () => {
    const request = vi.fn();
    const handle = studioExtensionsIpcHandler(
      () => true,
      () => ({ request }) as unknown as ExtensionService
    );
    expect(await handle(event(7), { action: 'install', source: { kind: 'file', path: 'x'.repeat(60001) } })).toEqual({
      ok: false,
      code: 'FRAME_LIMIT',
    });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(await handle(event(7), circular)).toEqual({ ok: false, code: 'INVALID_INPUT' });
    expect(request).not.toHaveBeenCalled();
  });

  it('answers RUNTIME_UNAVAILABLE until the helper is started', async () => {
    const handle = studioExtensionsIpcHandler(() => true);
    expect(await handle(event(7), { action: 'list' })).toEqual({ ok: false, code: 'RUNTIME_UNAVAILABLE' });
  });

  it('starts the helper in the user data directory with the safeStorage vault, and stops it on quit', async () => {
    const storage = {
      isEncryptionAvailable: () => true,
      encryptString: (text: string) => Buffer.from(text),
      decryptString: (sealed: Buffer) => sealed.toString(),
      getSelectedStorageBackend: () => 'gnome_libsecret',
    };
    const service = startStudioExtensions(storage);
    expect(getStudioExtensionService()).toBe(service);
    const reply = await studioExtensionsIpcHandler(() => true)(event(7), { action: 'get_settings' });
    expect(reply).toMatchObject({ ok: true, data: { credentialMode: 'keychain' } });
    expect(electron.quitHandlers).toHaveLength(1);
    electron.quitHandlers[0]();
    await vi.waitFor(() => expect(getStudioExtensionService()).toBeUndefined());
  });

  it('is memory-only where safeStorage cannot encrypt', async () => {
    startStudioExtensions();
    const reply = await studioExtensionsIpcHandler(() => true)(event(7), { action: 'get_settings' });
    expect(reply).toMatchObject({ ok: true, data: { credentialMode: 'memory-only' } });
  });

  it('cancels what a window started when it goes away', async () => {
    const service = startStudioExtensions();
    const cancel = vi.spyOn(service, 'cancelOwner');
    cancelStudioExtensionsOf(7);
    expect(cancel).toHaveBeenCalledWith('desktop:7');
  });
});
