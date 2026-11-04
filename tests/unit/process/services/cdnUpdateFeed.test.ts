import { describe, expect, it, vi } from 'vitest';
import { buildStudioFeedOptions, startupUpdateEnabled, initializeDesktopUpdates } from '@/process/services/updateFeed';

describe('Studio update preference', () => {
  it('uses only the Studio GitHub release repository', () => {
    expect(buildStudioFeedOptions()).toEqual({ provider: 'github', owner: 'handochan', repo: 'aelix-studio' });
  });
  it('checks by default and honors the persisted false value', () => {
    expect(startupUpdateEnabled(undefined)).toBe(true);
    expect(startupUpdateEnabled(true)).toBe(true);
    expect(startupUpdateEnabled(false)).toBe(false);
  });
});

describe('manual and background update lifecycle', () => {
  const setup = (enabled = true, discontinued = false) => {
    const updater = {
      initialize: vi.fn(),
      setBeforeQuitAndInstall: vi.fn(),
      checkForUpdatesAndNotify: vi.fn().mockResolvedValue(undefined),
    };
    const options = {
      readAutoCheck: vi.fn().mockResolvedValue(enabled),
      discontinued,
      broadcast: vi.fn(),
      beforeQuit: vi.fn(),
    };
    const schedule = vi.fn();
    initializeDesktopUpdates(updater, options, schedule);
    return { updater, options, schedule };
  };
  it('keeps manual status and host cleanup initialized with automatic checks off', async () => {
    const { updater, options, schedule } = setup(false);
    schedule.mock.calls[0][0]();
    await vi.waitFor(() => expect(options.readAutoCheck).toHaveBeenCalled());
    expect(updater.initialize).toHaveBeenCalledWith(options.broadcast);
    expect(updater.setBeforeQuitAndInstall).toHaveBeenCalledWith(options.beforeQuit);
    expect(updater.checkForUpdatesAndNotify).not.toHaveBeenCalled();
  });
  it('checks by default after the startup delay', async () => {
    const { updater, schedule } = setup();
    expect(updater.checkForUpdatesAndNotify).not.toHaveBeenCalled();
    schedule.mock.calls[0][0]();
    await vi.waitFor(() => expect(updater.checkForUpdatesAndNotify).toHaveBeenCalledOnce());
  });
  it('does not check if the preference was disabled during the delay', async () => {
    const { updater, options, schedule } = setup();
    options.readAutoCheck.mockResolvedValue(false);
    schedule.mock.calls[0][0]();
    await Promise.resolve();
    expect(updater.checkForUpdatesAndNotify).not.toHaveBeenCalled();
  });
  it('does not schedule a discontinued-build check', () => {
    expect(setup(true, true).schedule).not.toHaveBeenCalled();
  });
});
