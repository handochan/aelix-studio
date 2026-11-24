/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { BrowserWindow, dialog, type FileFilter } from 'electron';
import { ipcBridge } from '@/common';

const MAX_FILE_FILTERS = 32;
const MAX_EXTENSIONS_PER_FILTER = 64;
const MAX_FILTER_NAME_LENGTH = 128;
const MAX_EXTENSION_LENGTH = 64;

function isValidFileFilters(filters: unknown): filters is FileFilter[] {
  if (!Array.isArray(filters) || filters.length > MAX_FILE_FILTERS) return false;

  for (const filter of filters as unknown[]) {
    if (typeof filter !== 'object' || filter === null || Array.isArray(filter)) return false;

    const { name, extensions } = filter as Record<string, unknown>;
    if (typeof name !== 'string' || name.length > MAX_FILTER_NAME_LENGTH || !name.trim() || name.includes('\0')) {
      return false;
    }
    if (!Array.isArray(extensions) || extensions.length === 0 || extensions.length > MAX_EXTENSIONS_PER_FILTER) {
      return false;
    }

    // Electron expects bare suffixes or the standalone wildcard for all files.
    for (const extension of extensions as unknown[]) {
      if (typeof extension !== 'string' || extension.length === 0 || extension.length > MAX_EXTENSION_LENGTH) {
        return false;
      }
      if (extension !== '*' && /[^a-z0-9_+-]/i.test(extension)) return false;
    }
  }

  return true;
}

export function initDialogBridge(): void {
  ipcBridge.dialog.showOpen.provider((options) => {
    // Get the focused window or the first available window as parent
    // This ensures the dialog appears in front on Windows and has proper modal behavior
    const parentWindow = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
    const dialogOptions: NonNullable<ipcBridge.ShowOpenOptions> = {
      defaultPath: options?.defaultPath,
      properties: options?.properties,
    };
    const filters = options?.filters;
    if (isValidFileFilters(filters)) {
      dialogOptions.filters = filters;
    }

    const showDialogPromise = parentWindow
      ? dialog.showOpenDialog(parentWindow, dialogOptions)
      : dialog.showOpenDialog(dialogOptions);

    return showDialogPromise.then((res) => {
      return res.filePaths;
    });
  });
}
