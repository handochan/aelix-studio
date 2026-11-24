/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import { initDialogBridge } from '@process/bridge/dialogBridge';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getFocusedWindow, getAllWindows, showOpenDialog } = vi.hoisted(() => ({
  getFocusedWindow: vi.fn(),
  getAllWindows: vi.fn(),
  showOpenDialog: vi.fn(),
}));

vi.mock('electron', () => ({
  BrowserWindow: { getFocusedWindow, getAllWindows },
  dialog: { showOpenDialog },
}));

vi.mock('@/common', () => ({
  ipcBridge: { dialog: { showOpen: { provider: vi.fn() } } },
}));

const open = (options?: unknown) =>
  vi.mocked(ipcBridge.dialog.showOpen.provider).mock.calls[0][0](options as ipcBridge.ShowOpenOptions);

beforeEach(() => {
  vi.resetAllMocks();
  getFocusedWindow.mockReturnValue(null);
  getAllWindows.mockReturnValue([]);
  showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
  initDialogBridge();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('native open dialog', () => {
  it('forwards the wheel filter and the selected path with a parent window', async () => {
    const parentWindow = { id: 1 };
    getFocusedWindow.mockReturnValue(parentWindow);
    const filePaths = ['/tmp/extension.whl'];
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths });
    const options = {
      defaultPath: '/tmp',
      properties: ['openFile'],
      filters: [{ name: '휠 파일', extensions: ['whl'] }],
    } satisfies ipcBridge.ShowOpenOptions;

    await expect(open(options)).resolves.toEqual(filePaths);
    expect(showOpenDialog).toHaveBeenCalledExactlyOnceWith(parentWindow, options);
  });

  it('forwards multiple filter groups and the all-files wildcard without a parent window', async () => {
    const options = {
      defaultPath: '/tmp',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Images', extensions: ['png', 'JPG'] },
        { name: 'All files', extensions: ['*'] },
      ],
    } satisfies ipcBridge.ShowOpenOptions;

    await open(options);
    expect(showOpenDialog).toHaveBeenCalledExactlyOnceWith(options);
  });

  it('opens a directory picker without adding a filter', async () => {
    const options = { defaultPath: '/tmp', properties: ['openDirectory', 'createDirectory'] };

    await expect(open(options)).resolves.toEqual([]);
    expect(showOpenDialog).toHaveBeenCalledExactlyOnceWith(options);
  });

  it('uses the default path when a non-string path is supplied', async () => {
    const options = { properties: ['openDirectory'] };

    await expect(open({ ...options, defaultPath: 42 })).resolves.toEqual([]);
    expect(showOpenDialog.mock.calls).toStrictEqual([[options]]);
  });

  const sparseProperties = ['openFile'];
  sparseProperties.length = 2;
  it.each([
    { label: 'a non-array', properties: 'openFile' },
    { label: 'a non-string element', properties: ['openFile', 42] },
    { label: 'an unsupported property', properties: ['openFile', 'showOverwriteConfirmation'] },
    { label: 'a sparse array', properties: sparseProperties },
  ])('uses the default dialog properties for $label', async ({ properties }) => {
    const options = { defaultPath: '/tmp', filters: [{ name: 'Wheel', extensions: ['whl'] }] };

    await expect(open({ ...options, properties })).resolves.toEqual([]);
    expect(showOpenDialog.mock.calls).toStrictEqual([[options]]);
  });

  it('opens the default picker when every option is malformed', async () => {
    await expect(open({ defaultPath: 42, properties: 'openFile', filters: false })).resolves.toEqual([]);

    expect(showOpenDialog.mock.calls).toStrictEqual([[{}]]);
  });

  it.each([
    {
      label: 'throws synchronously',
      fail: () => {
        throw new Error('Dialog failed');
      },
    },
    { label: 'rejects asynchronously', fail: () => Promise.reject(new Error('Dialog failed')) },
  ])('resolves with no selection when Electron $label', async ({ fail }) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    showOpenDialog.mockImplementationOnce(fail);

    await expect(open()).resolves.toEqual([]);
  });

  it.each([
    { label: 'a non-array', filters: { name: 'Wheel', extensions: ['whl'] } },
    { label: 'a malformed filter among valid filters', filters: [{ name: 'Wheel', extensions: ['whl'] }, null] },
    { label: 'a non-string name', filters: [{ name: 12, extensions: ['whl'] }] },
    { label: 'a name with a null byte', filters: [{ name: 'Wheel\0', extensions: ['whl'] }] },
    { label: 'a non-array extensions value', filters: [{ name: 'Wheel', extensions: 'whl' }] },
    { label: 'a non-string extension', filters: [{ name: 'Wheel', extensions: ['whl', 12] }] },
    { label: 'an empty extension list', filters: [{ name: 'Wheel', extensions: [] }] },
    { label: 'a filename glob', filters: [{ name: 'Wheel', extensions: ['*.whl'] }] },
    { label: 'too many filters', filters: Array(33).fill({ name: 'Wheel', extensions: ['whl'] }) },
    { label: 'too many extensions', filters: [{ name: 'Wheel', extensions: Array(65).fill('whl') }] },
    { label: 'an oversized filter name', filters: [{ name: 'a'.repeat(129), extensions: ['whl'] }] },
    { label: 'an oversized extension', filters: [{ name: 'Wheel', extensions: ['a'.repeat(65)] }] },
  ])('ignores $label and preserves the other dialog options', async ({ filters }) => {
    const options = { defaultPath: '/tmp', properties: ['openFile'] };

    await open({ ...options, filters });
    expect(showOpenDialog).toHaveBeenCalledExactlyOnceWith(options);
  });
});
