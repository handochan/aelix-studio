import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Theme } from '@/common/theme/types';

const { applyThemeMock, changedOnMock, configGetMock, setActiveThemeMock } = vi.hoisted(() => ({
  applyThemeMock: vi.fn(),
  changedOnMock: vi.fn(() => vi.fn()),
  configGetMock: vi.fn(),
  setActiveThemeMock: vi.fn(),
}));

vi.mock('@/common/config/configService', () => ({
  configService: {
    get: configGetMock,
    whenReady: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    theme: {
      changed: { on: changedOnMock },
    },
  },
}));

vi.mock('@/renderer/utils/theme/applyTheme', () => ({
  applyTheme: applyThemeMock,
  seedElectronTheme: vi.fn().mockResolvedValue(undefined),
  setActiveTheme: setActiveThemeMock,
}));

vi.mock('@/renderer/utils/theme/systemThemeWatcher', () => ({
  startSystemThemeWatcher: vi.fn(() => vi.fn()),
}));

import useTheme from '@/renderer/hooks/system/useTheme';
import { DEFAULT_THEME_ID, SYSTEM_THEME_ID } from '@/common/theme/constants';

const darkTheme: Theme = {
  id: 'dark',
  name: 'Dark',
  appearance: 'dark',
  builtin: true,
  created_at: 0,
  updated_at: 0,
};

describe('useTheme selection', () => {
  beforeEach(() => {
    configGetMock.mockImplementation((key: string) => {
      if (key === 'theme.activeId') return 'light';
      if (key === 'theme.userThemes') return [];
      return undefined;
    });
    setActiveThemeMock.mockReset();
  });

  it('updates local theme state without waiting for a cross-window event', async () => {
    setActiveThemeMock.mockResolvedValue(darkTheme);
    const { result } = renderHook(() => useTheme());

    await waitFor(() => expect(result.current[0]?.appearance).toBe('light'));
    await act(async () => result.current[1]('dark'));

    expect(result.current[0]?.appearance).toBe('dark');
    expect(result.current[2]).toBe('dark');
    expect(localStorage.getItem('__aionui_theme')).toBe('dark');
  });

  it('keeps the current state when selecting a theme fails', async () => {
    setActiveThemeMock.mockRejectedValue(new Error('save failed'));
    const { result } = renderHook(() => useTheme());

    await waitFor(() => expect(result.current[0]?.appearance).toBe('light'));
    await expect(act(async () => result.current[1]('dark'))).rejects.toThrow('save failed');

    expect(result.current[0]?.appearance).toBe('light');
  });
});

describe('default theme selection', () => {
  it('follows the OS appearance when no theme has been stored', async () => {
    expect(DEFAULT_THEME_ID).toBe(SYSTEM_THEME_ID);
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: query === '(prefers-color-scheme: dark)',
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia;
    configGetMock.mockImplementation((key: string) => (key === 'theme.userThemes' ? [] : undefined));
    applyThemeMock.mockClear();

    try {
      // useTheme resolves the stored selection when the module loads; load a fresh copy.
      vi.resetModules();
      const { default: freshUseTheme } = await import('@/renderer/hooks/system/useTheme');
      const { result } = renderHook(() => freshUseTheme());

      await waitFor(() => expect(result.current[0]?.appearance).toBe('dark'));
      expect(result.current[2]).toBe(SYSTEM_THEME_ID);
      expect(applyThemeMock).toHaveBeenCalledWith(expect.objectContaining({ id: 'dark' }));
    } finally {
      window.matchMedia = originalMatchMedia;
    }
  });
});
