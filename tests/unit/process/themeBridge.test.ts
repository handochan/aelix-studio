/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Theme } from '@/common/theme/types';

const mocks = vi.hoisted(() => ({
  nativeTheme: { shouldUseDarkColors: false },
  httpRequest: vi.fn(),
  setActiveProvider: vi.fn(),
  changedEmit: vi.fn(),
}));

vi.mock('electron', () => ({ nativeTheme: mocks.nativeTheme }));
vi.mock('@/common/adapter/httpBridge', () => ({ httpRequest: mocks.httpRequest }));
vi.mock('@/common', () => ({
  ipcBridge: {
    theme: {
      setActive: { provider: mocks.setActiveProvider },
      changed: { emit: mocks.changedEmit },
      requestCurrent: { provider: vi.fn() },
    },
  },
}));

import {
  getWindowBackgroundColor,
  initThemeBridge,
  loadThemeSelection,
  resolveSelectedAppearance,
  WINDOW_BACKGROUND_COLORS,
} from '@process/bridge/themeBridge';

const LIGHT = WINDOW_BACKGROUND_COLORS.light;
const DARK = WINDOW_BACKGROUND_COLORS.dark;

function storeSettings(settings: Record<string, unknown>) {
  mocks.httpRequest.mockImplementation(async (_method: string, path: string) => {
    const key = decodeURIComponent(path.split('keys=')[1] ?? '');
    return key in settings ? { [key]: settings[key] } : {};
  });
}

const sepia: Partial<Theme> = { id: 'user-sepia', appearance: 'dark' };

describe('theme bridge window background', () => {
  beforeEach(async () => {
    mocks.httpRequest.mockReset();
    mocks.nativeTheme.shouldUseDarkColors = false;
    // Reset the module-level selection to "follow the OS".
    storeSettings({});
    await loadThemeSelection();
  });

  it('matches the base background tokens of the default color scheme', () => {
    expect(WINDOW_BACKGROUND_COLORS).toEqual({ light: '#ffffff', dark: '#0e0e0e' });
  });

  it('follows the OS appearance when nothing is stored or system is selected', async () => {
    mocks.nativeTheme.shouldUseDarkColors = true;
    expect(getWindowBackgroundColor()).toBe(DARK);

    storeSettings({ 'theme.activeId': 'system' });
    await loadThemeSelection();
    expect(getWindowBackgroundColor()).toBe(DARK);
    mocks.nativeTheme.shouldUseDarkColors = false;
    expect(getWindowBackgroundColor()).toBe(LIGHT);
  });

  it('keeps an explicit light or dark choice whatever the OS shows', async () => {
    mocks.nativeTheme.shouldUseDarkColors = true;
    storeSettings({ 'theme.activeId': 'light' });
    await loadThemeSelection();
    expect(getWindowBackgroundColor()).toBe(LIGHT);

    mocks.nativeTheme.shouldUseDarkColors = false;
    storeSettings({ 'theme.activeId': 'dark' });
    await loadThemeSelection();
    expect(getWindowBackgroundColor()).toBe(DARK);
  });

  it("uses a user theme's appearance", async () => {
    storeSettings({ 'theme.activeId': 'user-sepia', 'theme.userThemes': [sepia] });
    await loadThemeSelection();
    expect(getWindowBackgroundColor()).toBe(DARK);
  });

  it('keeps the last known selection when the settings read fails', async () => {
    storeSettings({ 'theme.activeId': 'dark' });
    await loadThemeSelection();
    mocks.httpRequest.mockRejectedValue(new Error('backend unavailable'));
    await loadThemeSelection();
    expect(getWindowBackgroundColor()).toBe(DARK);
  });

  it('refreshes the selection when a renderer publishes a theme', async () => {
    initThemeBridge();
    const publish = mocks.setActiveProvider.mock.calls.at(-1)?.[0] as (theme: Theme) => Promise<void>;
    storeSettings({ 'theme.activeId': 'dark' });

    await publish({ id: 'dark', name: 'Dark', appearance: 'dark', created_at: 0, updated_at: 0 });
    await vi.waitFor(() => expect(getWindowBackgroundColor()).toBe(DARK));
    expect(mocks.changedEmit).toHaveBeenCalled();
  });
});

describe('resolveSelectedAppearance', () => {
  it('returns null while following the OS', () => {
    expect(resolveSelectedAppearance(undefined, undefined)).toBeNull();
    expect(resolveSelectedAppearance('', undefined)).toBeNull();
    expect(resolveSelectedAppearance('system', undefined)).toBeNull();
  });

  it('resolves builtin and user themes, and unknown ids to light like the renderer', () => {
    expect(resolveSelectedAppearance('dark', undefined)).toBe('dark');
    expect(resolveSelectedAppearance('light', undefined)).toBe('light');
    expect(resolveSelectedAppearance('user-sepia', [null, sepia])).toBe('dark');
    expect(resolveSelectedAppearance('removed-theme', [sepia])).toBe('light');
  });
});
