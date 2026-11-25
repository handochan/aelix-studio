/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { configService } from '@/common/config/configService';
import { DEFAULT_THEME_ID, SYSTEM_THEME_ID } from '@/common/theme/constants';
import { setActiveTheme } from './applyTheme';
import { watchSystemPrefersDark } from './systemAppearance';

/**
 * While "Follow System" is the active selection (also the default when nothing is stored), re-resolve and re-apply the theme
 * whenever the OS appearance changes. Reuses the normal select pipeline, so the
 * change persists and broadcasts to all windows. Returns an unsubscribe function.
 */
export function startSystemThemeWatcher(): () => void {
  return watchSystemPrefersDark(() => {
    // Until settings load, the selection is unknown and an explicit choice could be
    // overwritten; the initial theme resolution reads the OS appearance itself.
    if (!configService.isInitialized()) return;
    const activeId = (configService.get('theme.activeId') as string | undefined) || DEFAULT_THEME_ID;
    if (activeId !== SYSTEM_THEME_ID) return;
    void setActiveTheme(SYSTEM_THEME_ID).catch((e) => console.error('re-apply system theme failed', e));
  });
}
