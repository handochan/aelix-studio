/** Studio updates are user initiated and use only the Studio release repository. */
import type { GithubOptions } from 'builder-util-runtime';

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
