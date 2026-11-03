/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { UpdateInfo } from 'electron-updater';
import type { AppUpdater } from 'electron-updater/out/AppUpdater';
import type { ProviderRuntimeOptions } from 'electron-updater/out/providers/Provider';
import { CdnGenericProvider } from '@/process/services/cdnGenericProvider';
import { buildStudioFeedOptions, startupUpdateEnabled, initializeDesktopUpdates } from '@/process/services/updateFeed';

const makeRuntimeOptions = (): ProviderRuntimeOptions => ({
  isUseMultipleRangeRequest: true,
  platform: 'darwin',
  executor: {
    request: vi.fn(),
  } as unknown as ProviderRuntimeOptions['executor'],
});

describe('Studio update policy', () => {
  it('uses only the Studio GitHub release repository', () => {
    expect(buildStudioFeedOptions()).toEqual({ provider: 'github', owner: 'handochan', repo: 'aelix-studio' });
  });
  it('does not check for updates without explicit opt-in', () => {
    expect(startupUpdateEnabled({})).toBe(false);
  });
  it('allows explicit operator opt-in', () => {
    expect(startupUpdateEnabled({ AELIX_STUDIO_AUTO_UPDATE: '1' })).toBe(true);
  });
  it.each([
    { AIONUI_DISABLE_AUTO_UPDATE: '1' },
    { AIONUI_E2E_TEST: '1' },
    { CI: 'true' },
    { CI: '1' },
    { GITHUB_ACTIONS: 'true' },
  ])('retains the disable guard %j', (guard) => {
    expect(startupUpdateEnabled({ AELIX_STUDIO_AUTO_UPDATE: '1', ...guard })).toBe(false);
  });
});

describe('CdnGenericProvider', () => {
  it('resolves relative update files under the version directory', () => {
    const provider = new CdnGenericProvider(
      {
        provider: 'custom',
        url: 'https://static.aionui.com/releases',
      },
      {} as AppUpdater,
      makeRuntimeOptions()
    );

    const files = provider.resolveFiles({
      version: '2.1.14',
      files: [
        {
          url: 'AionUi-2.1.14-mac-arm64.dmg',
          sha512: 'sha512-value',
        },
      ],
      path: 'AionUi-2.1.14-mac-arm64.dmg',
      sha512: 'sha512-value',
      releaseDate: '2026-06-08T00:00:00.000Z',
    } satisfies UpdateInfo);

    expect(files[0]?.url.href).toBe('https://static.aionui.com/releases/2.1.14/AionUi-2.1.14-mac-arm64.dmg');
  });
});

describe('manual and background update lifecycle', () => {
  const setup = (env = {}, discontinued = false) => {
    const updater = {
      initialize: vi.fn(),
      setBeforeQuitAndInstall: vi.fn(),
      checkForUpdatesAndNotify: vi.fn().mockResolvedValue(undefined),
    };
    const options = { env, discontinued, broadcast: vi.fn(), beforeQuit: vi.fn() };
    const schedule = vi.fn();
    initializeDesktopUpdates(updater, options, schedule);
    return { updater, options, schedule };
  };
  it('keeps manual status and host cleanup initialized with background checks off', () => {
    const { updater, options, schedule } = setup();
    expect(updater.initialize).toHaveBeenCalledWith(options.broadcast);
    expect(updater.setBeforeQuitAndInstall).toHaveBeenCalledWith(options.beforeQuit);
    expect(schedule).not.toHaveBeenCalled();
  });
  it('checks only after explicit opt-in and the startup delay', () => {
    const { updater, schedule } = setup({ AELIX_STUDIO_AUTO_UPDATE: '1' });
    expect(updater.checkForUpdatesAndNotify).not.toHaveBeenCalled();
    schedule.mock.calls[0][0]();
    expect(updater.checkForUpdatesAndNotify).toHaveBeenCalledOnce();
  });
  it('does not schedule a discontinued-build check even with opt-in', () => {
    expect(setup({ AELIX_STUDIO_AUTO_UPDATE: '1' }, true).schedule).not.toHaveBeenCalled();
  });
});
