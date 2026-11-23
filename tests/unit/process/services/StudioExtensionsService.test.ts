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

import {
  disposeStudioExtensions,
  getStudioExtensionService,
  type ExtensionService,
  type StudioExtensionsRequest,
} from '@aionui/web-host';
import {
  cancelStudioExtensionsOf,
  startStudioExtensions,
  studioExtensionsIpcHandler,
} from '@process/services/StudioExtensionsService';

const event = (id: number, devTools = false): IpcMainInvokeEvent =>
  ({ sender: { id, isDevToolsOpened: () => devTools } }) as unknown as IpcMainInvokeEvent;

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
    expect(await handle(event(8), { action: 'list' })).toEqual({ ok: false, code: 'FORBIDDEN', transport: 'secure' });
    expect(request).not.toHaveBeenCalled();
    expect(await handle(event(7), { action: 'list' })).toEqual({
      ok: true,
      data: { current: null },
      transport: 'secure',
    });
    expect(request).toHaveBeenCalledWith('desktop:7', { action: 'list' });
  });

  it.each(['install', 'upgrade'] as const)(
    'checks the size and JSON data of an %s before calling the helper',
    async (action) => {
      const request = vi.fn(async () => ({ ok: true as const, data: {} }));
      const handle = studioExtensionsIpcHandler(
        () => true,
        () => ({ request }) as unknown as ExtensionService
      );
      const command = (value: unknown) =>
        action === 'upgrade'
          ? { action, name: 'demo', proxyCredentials: { username: 'ops', password: value } }
          : { action, source: { kind: 'file', path: value } };
      expect(await handle(event(7), command('x'.repeat(60001)))).toEqual({
        ok: false,
        code: 'FRAME_LIMIT',
        transport: 'secure',
      });
      // 30,001 UTF-16 units, 60,002 bytes: counted as bytes.
      expect(await handle(event(7), command('é'.repeat(30001)))).toEqual({
        ok: false,
        code: 'FRAME_LIMIT',
        transport: 'secure',
      });
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      for (const value of [
        circular,
        new ArrayBuffer(70000),
        command(new ArrayBuffer(70000)),
        command(new Uint8Array(8)),
        command(new Date()),
        command(new Map()),
        command(Number.NaN),
        'list',
      ])
        expect(await handle(event(7), value)).toEqual({ ok: false, code: 'INVALID_INPUT', transport: 'secure' });
      expect(request).not.toHaveBeenCalled();
      expect(await handle(event(7), command('é'.repeat(100)))).toEqual({ ok: true, data: {}, transport: 'secure' });
    }
  );

  it('refuses the window while its DevTools are open in a packaged app, not in a development build', async () => {
    const request = vi.fn(async () => ({ ok: true as const, data: {} }));
    const service = () => ({ request }) as unknown as ExtensionService;
    const packaged = studioExtensionsIpcHandler(
      () => true,
      service,
      () => true
    );
    const upgrade = {
      action: 'upgrade',
      name: 'demo',
      allowUnpin: true,
      proxyCredentials: { username: 'ops', password: 'fixture-secret' },
    } satisfies StudioExtensionsRequest;
    expect(await packaged(event(7, true), upgrade)).toEqual({
      ok: false,
      code: 'FORBIDDEN',
      transport: 'secure',
    });
    expect(request).not.toHaveBeenCalled();
    expect(await packaged(event(7, false), { ...upgrade, acknowledgeInsecureTransport: true })).toEqual({
      ok: true,
      data: {},
      transport: 'secure',
    });
    expect(request).toHaveBeenCalledWith('desktop:7', upgrade);
    const development = studioExtensionsIpcHandler(
      () => true,
      service,
      () => false
    );
    expect(await development(event(7, true), upgrade)).toEqual({ ok: true, data: {}, transport: 'secure' });
  });

  it('answers RUNTIME_UNAVAILABLE until the helper is started', async () => {
    const handle = studioExtensionsIpcHandler(() => true);
    expect(await handle(event(7), { action: 'list' })).toEqual({
      ok: false,
      code: 'RUNTIME_UNAVAILABLE',
      transport: 'secure',
    });
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
    startStudioExtensions(undefined, 'win32');
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
