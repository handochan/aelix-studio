import { act, renderHook, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Theme } from '@/common/theme/types';

const { applyThemeMock, changedOnMock, configGetMock, setActiveThemeMock } = vi.hoisted(() => ({
  applyThemeMock: vi.fn(),
  changedOnMock: vi.fn((_handler: (theme: Theme) => void) => vi.fn()),
  configGetMock: vi.fn(),
  setActiveThemeMock: vi.fn(),
}));

vi.mock('@/common/config/configService', () => ({
  configService: {
    get: configGetMock,
    isInitialized: () => true,
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

const THEME_CACHE_KEY = '__aionui_theme';

function stubPrefersDark(prefersDark: boolean): () => void {
  const originalMatchMedia = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches: prefersDark && query === '(prefers-color-scheme: dark)',
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
  return () => {
    window.matchMedia = originalMatchMedia;
  };
}

/** Load a fresh useTheme: it resolves the stored selection when the module loads. */
async function renderFreshUseTheme() {
  vi.resetModules();
  const { default: freshUseTheme } = await import('@/renderer/hooks/system/useTheme');
  return renderHook(() => freshUseTheme());
}

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
    const restoreMatchMedia = stubPrefersDark(true);
    configGetMock.mockImplementation((key: string) => (key === 'theme.userThemes' ? [] : undefined));
    applyThemeMock.mockClear();

    try {
      const { result } = await renderFreshUseTheme();

      await waitFor(() => expect(result.current[0]?.appearance).toBe('dark'));
      expect(result.current[2]).toBe(SYSTEM_THEME_ID);
      expect(applyThemeMock).toHaveBeenCalledWith(expect.objectContaining({ id: 'dark' }));
      // The first paint resolves the OS appearance again instead of reusing today's.
      expect(localStorage.getItem(THEME_CACHE_KEY)).toBe(SYSTEM_THEME_ID);
    } finally {
      restoreMatchMedia();
    }
  });

  it('keeps following the system after the Electron echo of the resolved theme', async () => {
    const restoreMatchMedia = stubPrefersDark(true);
    configGetMock.mockImplementation((key: string) => (key === 'theme.userThemes' ? [] : undefined));
    changedOnMock.mockClear();

    try {
      const { result } = await renderFreshUseTheme();
      await waitFor(() => expect(result.current[0]?.appearance).toBe('dark'));

      // The main-process relay echoes the resolved Dark builtin back to this window.
      const relay = changedOnMock.mock.calls.at(-1)?.[0];
      act(() => relay?.(darkTheme));

      expect(result.current[2]).toBe(SYSTEM_THEME_ID);
      expect(localStorage.getItem(THEME_CACHE_KEY)).toBe(SYSTEM_THEME_ID);
    } finally {
      restoreMatchMedia();
    }
  });
});

describe('first-paint theme script', () => {
  const html = readFileSync(resolve(__dirname, '../../../packages/desktop/src/renderer/index.html'), 'utf8');
  const source = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? '';

  function firstPaint(cached: string | null, prefersDark: boolean): string | null {
    const restoreMatchMedia = stubPrefersDark(prefersDark);
    try {
      if (cached === null) localStorage.removeItem(THEME_CACHE_KEY);
      else localStorage.setItem(THEME_CACHE_KEY, cached);
      document.documentElement.setAttribute('data-theme', 'light');
      new Function(source)();
      return document.documentElement.getAttribute('data-theme');
    } finally {
      restoreMatchMedia();
    }
  }

  afterEach(() => {
    localStorage.removeItem(THEME_CACHE_KEY);
    document.documentElement.setAttribute('data-theme', 'light');
  });

  it('reads the cache written by useTheme', () => {
    expect(source).toContain(THEME_CACHE_KEY);
  });

  it('follows the OS without a cached selection', () => {
    expect(firstPaint(null, true)).toBe('dark');
    expect(firstPaint(null, false)).toBe('light');
  });

  it('resolves a cached system selection with the current OS appearance', () => {
    expect(firstPaint(SYSTEM_THEME_ID, true)).toBe('dark');
    expect(firstPaint(SYSTEM_THEME_ID, false)).toBe('light');
  });

  it('keeps a fixed light or dark choice whatever the OS shows', () => {
    expect(firstPaint('light', true)).toBe('light');
    expect(firstPaint('dark', false)).toBe('dark');
  });

  it('follows the OS for an unknown cached value', () => {
    expect(firstPaint('sepia', true)).toBe('dark');
  });
});
