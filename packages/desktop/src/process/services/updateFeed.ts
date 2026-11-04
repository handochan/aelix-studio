/** Studio updates are automatic or user initiated and use only the Studio release repository. */
import type { GithubOptions } from 'builder-util-runtime';
import type { BeforeQuitAndInstallCallback, StatusBroadcastCallback } from './autoUpdaterService';

export const STUDIO_UPDATE_REPO = 'handochan/aelix-studio';

export function buildStudioFeedOptions(): GithubOptions {
  return { provider: 'github', owner: 'handochan', repo: 'aelix-studio' };
}

/** Default on; the persisted desktop setting is the sole automatic-check preference. */
export function startupUpdateEnabled(value: unknown): boolean {
  return value !== false;
}

type UpdateLifecycle = {
  initialize: (broadcast: StatusBroadcastCallback) => void;
  setBeforeQuitAndInstall: (callback: BeforeQuitAndInstallCallback) => void;
  checkForUpdatesAndNotify: () => Promise<void>;
};

/** Keep manual update/status/host cleanup available even when background checks are off. */
export function initializeDesktopUpdates(
  updater: UpdateLifecycle,
  options: {
    broadcast: StatusBroadcastCallback;
    beforeQuit: BeforeQuitAndInstallCallback;
    readAutoCheck: () => Promise<boolean>;
    discontinued: boolean;
  },
  schedule: (callback: () => void, delay: number) => void = (callback, delay) => {
    setTimeout(callback, delay);
  }
): void {
  updater.initialize(options.broadcast);
  updater.setBeforeQuitAndInstall(options.beforeQuit);
  if (!options.discontinued) {
    schedule(() => {
      void options
        .readAutoCheck()
        .then((enabled) => {
          if (startupUpdateEnabled(enabled)) return updater.checkForUpdatesAndNotify();
        })
        .catch(() => {
          /* An unreadable setting must not produce an error window. */
        });
    }, 3000);
  }
}
