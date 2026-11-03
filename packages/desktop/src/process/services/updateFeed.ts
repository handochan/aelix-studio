/** Studio updates are user initiated and use only the Studio release repository. */
import type { GithubOptions } from 'builder-util-runtime';
import type { BeforeQuitAndInstallCallback, StatusBroadcastCallback } from './autoUpdaterService';

export const STUDIO_UPDATE_REPO = 'handochan/aelix-studio';

export function buildStudioFeedOptions(): GithubOptions {
  return { provider: 'github', owner: 'handochan', repo: 'aelix-studio' };
}

/** Automatic checks require explicit operator opt-in; legacy disable guards still win. */
export function startupUpdateEnabled(env: NodeJS.ProcessEnv): boolean {
  return (
    env.AELIX_STUDIO_AUTO_UPDATE === '1' &&
    env.AIONUI_DISABLE_AUTO_UPDATE !== '1' &&
    env.AIONUI_E2E_TEST !== '1' &&
    env.CI !== 'true' &&
    env.CI !== '1' &&
    env.GITHUB_ACTIONS !== 'true'
  );
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
    env: NodeJS.ProcessEnv;
    discontinued: boolean;
  },
  schedule: (callback: () => void, delay: number) => void = (callback, delay) => {
    setTimeout(callback, delay);
  }
): void {
  updater.initialize(options.broadcast);
  updater.setBeforeQuitAndInstall(options.beforeQuit);
  if (startupUpdateEnabled(options.env) && !options.discontinued) {
    schedule(() => {
      void updater.checkForUpdatesAndNotify();
    }, 3000);
  }
}
