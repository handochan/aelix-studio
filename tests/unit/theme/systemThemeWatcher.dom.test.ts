import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.mock factories are hoisted above const declarations — use vi.hoisted to avoid TDZ errors
const { setActiveTheme, configGet, configInitialized } = vi.hoisted(() => ({
  setActiveTheme: vi.fn().mockResolvedValue(undefined),
  configGet: vi.fn(),
  configInitialized: vi.fn(() => true),
}));

vi.mock('@/renderer/utils/theme/applyTheme', () => ({ setActiveTheme }));
vi.mock('@/common/config/configService', () => ({
  configService: { get: configGet, isInitialized: configInitialized },
}));

import { startSystemThemeWatcher } from '@renderer/utils/theme/systemThemeWatcher';
import { SYSTEM_THEME_ID } from '@/common/theme/constants';

type ChangeHandler = (e: { matches: boolean }) => void;

function installMatchMedia() {
  const handlers = new Set<ChangeHandler>();
  window.matchMedia = vi.fn().mockReturnValue({
    matches: false,
    addEventListener: (_: string, h: ChangeHandler) => handlers.add(h),
    removeEventListener: (_: string, h: ChangeHandler) => handlers.delete(h),
  }) as unknown as typeof window.matchMedia;
  return { fire: (next: boolean) => handlers.forEach((h) => h({ matches: next })) };
}

describe('startSystemThemeWatcher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configInitialized.mockReturnValue(true);
  });

  it('re-applies the system theme on OS change while system mode is active', () => {
    const media = installMatchMedia();
    configGet.mockReturnValue(SYSTEM_THEME_ID);
    startSystemThemeWatcher();
    media.fire(true);
    expect(setActiveTheme).toHaveBeenCalledWith(SYSTEM_THEME_ID);
  });

  it('follows the OS when no theme has been stored (system is the default)', () => {
    const media = installMatchMedia();
    configGet.mockReturnValue(undefined);
    startSystemThemeWatcher();
    media.fire(true);
    expect(setActiveTheme).toHaveBeenCalledWith(SYSTEM_THEME_ID);
  });

  it('ignores OS changes until the settings cache has loaded', () => {
    const media = installMatchMedia();
    // Not loaded yet: an explicit choice would read as missing, i.e. as the system default.
    configInitialized.mockReturnValue(false);
    configGet.mockReturnValue(undefined);
    startSystemThemeWatcher();
    media.fire(true);
    expect(setActiveTheme).not.toHaveBeenCalled();
  });

  it('does nothing when a non-system theme is active', () => {
    const media = installMatchMedia();
    configGet.mockReturnValue('misaka-mikoto-theme');
    startSystemThemeWatcher();
    media.fire(true);
    expect(setActiveTheme).not.toHaveBeenCalled();
  });

  it('stops re-applying after unsubscribe', () => {
    const media = installMatchMedia();
    configGet.mockReturnValue(SYSTEM_THEME_ID);
    const off = startSystemThemeWatcher();
    off();
    media.fire(true);
    expect(setActiveTheme).not.toHaveBeenCalled();
  });
});
