/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { BrowserWindow, dialog, type FileFilter } from 'electron';
import { ipcBridge } from '@/common';

type DialogOptions = NonNullable<ipcBridge.ShowOpenOptions>;
type DialogProperties = NonNullable<DialogOptions['properties']>;

const OPEN_DIALOG_PROPERTIES: ReadonlySet<unknown> = new Set<DialogProperties[number]>([
  'openFile',
  'openDirectory',
  'multiSelections',
  'showHiddenFiles',
  'createDirectory',
  'promptToCreate',
  'noResolveAliases',
  'treatPackageAsDirectory',
  'dontAddToRecent',
]);

const MAX_FILE_FILTERS = 32;
const MAX_EXTENSIONS_PER_FILTER = 64;
const MAX_FILTER_NAME_LENGTH = 128;
const MAX_EXTENSION_LENGTH = 64;

function isValidDialogProperties(properties: unknown): properties is DialogProperties {
  if (!Array.isArray(properties)) return false;

  for (const property of properties as unknown[]) {
    if (!OPEN_DIALOG_PROPERTIES.has(property)) return false;
  }

  return true;
}

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
  ipcBridge.dialog.showOpen.provider(async (options) => {
    try {
      const { defaultPath, properties, filters } = options ?? {};
      const dialogOptions: DialogOptions = {};
      if (typeof defaultPath === 'string') dialogOptions.defaultPath = defaultPath;
      if (isValidDialogProperties(properties)) dialogOptions.properties = properties;
      if (isValidFileFilters(filters)) dialogOptions.filters = filters;

      // Parent the picker so it appears in front on Windows and behaves modally.
      const parentWindow = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
      const result = await (parentWindow
        ? dialog.showOpenDialog(parentWindow, dialogOptions)
        : dialog.showOpenDialog(dialogOptions));
      return result.filePaths;
    } catch (error) {
      console.error('[DialogBridge] Failed to open file dialog:', error);
      return [];
    }
  });
}
