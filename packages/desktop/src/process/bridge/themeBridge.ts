/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 主题桥接模块
 * Theme Bridge Module
 *
 * 主进程作为哑中继：缓存渲染进程发布的已解析 Theme 对象，
 * 并通过 changed 事件将其广播给所有窗口。
 * Main process acts as a dumb relay: caches the resolved Theme published by a
 * renderer via setActive, and re-broadcasts it to all windows via changed. It also
 * reads the stored selection so a new window's native background matches it.
 */

import { nativeTheme } from 'electron';
import { ipcBridge } from '@/common';
import { httpRequest } from '@/common/adapter/httpBridge';
import { DARK_THEME_ID, LIGHT_THEME_ID, SYSTEM_THEME_ID } from '@/common/theme/constants';
import type { Theme, ThemeAppearance } from '@/common/theme/types';

/** `--bg-base` of the default color scheme per appearance, for native window backgrounds. */
export const WINDOW_BACKGROUND_COLORS: Record<ThemeAppearance, string> = { light: '#ffffff', dark: '#0e0e0e' };

const SELECTION_READ_TIMEOUT_MS = 1000;

let cachedTheme: Theme | null = null;
/** Appearance of a fixed stored selection; null while the selection follows the OS. */
let selectedAppearance: ThemeAppearance | null = null;
let selectionLoadSeq = 0;
type ThemeListener = (t: Theme) => void;
const listeners = new Set<ThemeListener>();

export function getCachedTheme(): Theme | null {
  return cachedTheme;
}

export function onThemeChanged(listener: ThemeListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The fixed appearance a stored `theme.activeId` resolves to, or null when it follows
 * the OS (nothing stored, or `system`). Mirrors resolveActiveTheme: an unknown id
 * resolves to Light.
 */
export function resolveSelectedAppearance(activeId: unknown, userThemes: unknown): ThemeAppearance | null {
  if (typeof activeId !== 'string' || !activeId || activeId === SYSTEM_THEME_ID) return null;
  if (activeId === LIGHT_THEME_ID || activeId === DARK_THEME_ID) return activeId;
  const userTheme = Array.isArray(userThemes)
    ? (userThemes as Array<Partial<Theme> | null>).find((theme) => theme?.id === activeId)
    : undefined;
  return userTheme?.appearance === 'dark' ? 'dark' : 'light';
}

async function readClientSetting(key: string): Promise<unknown> {
  const settings = await httpRequest<Record<string, unknown>>(
    'GET',
    `/api/settings/client?keys=${encodeURIComponent(key)}`,
    undefined,
    { refreshAuth: false, silentStatuses: [404], timeoutMs: SELECTION_READ_TIMEOUT_MS }
  );
  return settings?.[key];
}

/**
 * Read the stored theme selection so new windows open on its appearance. A failed
 * read keeps the previous value (initially: follow the OS).
 */
export async function loadThemeSelection(): Promise<void> {
  const seq = ++selectionLoadSeq;
  try {
    const activeId = await readClientSetting('theme.activeId');
    const isBuiltinSelection =
      activeId === SYSTEM_THEME_ID || activeId === LIGHT_THEME_ID || activeId === DARK_THEME_ID;
    const userThemes =
      typeof activeId === 'string' && activeId && !isBuiltinSelection
        ? await readClientSetting('theme.userThemes')
        : undefined;
    if (seq === selectionLoadSeq) selectedAppearance = resolveSelectedAppearance(activeId, userThemes);
  } catch {
    // Keep the previous selection.
  }
}

/** Native background for a new window: the fixed selection, else the OS appearance. */
export function getWindowBackgroundColor(): string {
  return WINDOW_BACKGROUND_COLORS[selectedAppearance ?? (nativeTheme.shouldUseDarkColors ? 'dark' : 'light')];
}

/**
 * 初始化主题桥接
 * Initialize theme bridge
 *
 * 注册 IPC 处理器以缓存并转发主题变更
 * Register IPC handlers to cache and relay theme changes
 */
export function initThemeBridge(): void {
  // Renderer publishes a resolved theme → cache it and re-broadcast to all windows.
  ipcBridge.theme.setActive.provider(async (resolved: Theme) => {
    cachedTheme = resolved;
    ipcBridge.theme.changed.emit(resolved);
    listeners.forEach((l) => l(resolved));
    // The renderer persists the selection before publishing; refresh it for the next window.
    void loadThemeSelection();
  });

  // A freshly-loaded window (e.g. pet) pulls the current theme on load.
  ipcBridge.theme.requestCurrent.provider(async () => cachedTheme);
}
