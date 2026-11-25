/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { configService } from '@/common/config/configService';
import { ipcBridge } from '@/common';
import { resolveActiveTheme } from '@/common/theme/resolveTheme';
import { applyTheme, seedElectronTheme, setActiveTheme } from '@/renderer/utils/theme/applyTheme';
import { getSystemPrefersDark } from '@/renderer/utils/theme/systemAppearance';
import { startSystemThemeWatcher } from '@/renderer/utils/theme/systemThemeWatcher';
import { BUILTIN_THEMES } from '@renderer/theme/builtinThemes';
import { DEFAULT_THEME_ID, SYSTEM_THEME_ID } from '@/common/theme/constants';
import type { Theme } from '@/common/theme/types';
import { useCallback, useEffect, useState } from 'react';

/** Read by the first-paint script in `renderer/index.html`. */
const THEME_SELECTION_CACHE_KEY = '__aionui_theme';

/**
 * Cache the selection for the first paint: `system` while following the OS (the
 * first-paint script resolves it with matchMedia, so OS changes need no update),
 * otherwise the fixed appearance of the chosen theme.
 */
function cacheThemeSelection(activeId: string, theme: Theme): void {
  try {
    localStorage.setItem(THEME_SELECTION_CACHE_KEY, activeId === SYSTEM_THEME_ID ? SYSTEM_THEME_ID : theme.appearance);
  } catch {
    /* noop */
  }
}

function getPersistedActiveId(): string {
  return (configService.get('theme.activeId') as string) || DEFAULT_THEME_ID;
}

/**
 * Selection behind a relayed theme (the Electron echo or another window). Config is
 * persisted before the broadcast, and once loaded nothing stored means the default;
 * before that, fall back to the relayed theme itself.
 */
function getRelayedSelectionId(theme: Theme): string {
  const stored = configService.get('theme.activeId') as string | undefined;
  if (stored) return stored;
  return configService.isInitialized() ? DEFAULT_THEME_ID : theme.id;
}

async function initActiveTheme(): Promise<Theme> {
  try {
    await configService.whenReady();
    const activeId = getPersistedActiveId();
    const userThemes = (configService.get('theme.userThemes') as Theme[]) ?? [];
    const resolved = resolveActiveTheme(activeId, [...BUILTIN_THEMES, ...userThemes], getSystemPrefersDark());
    applyTheme(resolved);
    cacheThemeSelection(activeId, resolved);
    // Seed the main-process relay so other surfaces (markdown shadow DOM, pet windows) can pull it.
    void seedElectronTheme(resolved).catch(() => {});
    return resolved;
  } catch (e) {
    console.error('init theme failed', e);
    const fallback = resolveActiveTheme(DEFAULT_THEME_ID, BUILTIN_THEMES, getSystemPrefersDark());
    applyTheme(fallback);
    return fallback;
  }
}

let initialPromise: Promise<Theme> | null = null;
if (typeof window !== 'undefined') initialPromise = initActiveTheme();

/**
 * Returns [resolvedActiveTheme, selectThemeById, rawActiveId]. `rawActiveId` may be the
 * `system` sentinel while the resolved theme is the Light/Dark builtin — the gallery
 * highlights cards by `rawActiveId`.
 */
const useTheme = (): [Theme | null, (activeId: string) => Promise<void>, string | null] => {
  const [active, setActive] = useState<Theme | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    initialPromise
      ?.then((t) => {
        if (mounted) {
          setActive(t);
          setActiveId(getPersistedActiveId());
        }
      })
      .catch((e) => console.error('init theme failed', e));
    const off = ipcBridge.theme.changed.on((t: Theme) => {
      applyTheme(t);
      const selectedId = getRelayedSelectionId(t);
      if (mounted) {
        setActive((prev) => (prev?.id === t.id ? prev : t));
        setActiveId(selectedId);
      }
      cacheThemeSelection(selectedId, t);
    });
    const offSystemWatch = startSystemThemeWatcher();
    return () => {
      mounted = false;
      off?.();
      offSystemWatch();
    };
  }, []);

  const select = useCallback(async (selectedId: string) => {
    const resolved = await setActiveTheme(selectedId);
    setActive(resolved);
    setActiveId(selectedId);
    cacheThemeSelection(selectedId, resolved);
  }, []);

  return [active, select, activeId];
};

export default useTheme;
