/**
 * Aelix Studio updates must never install an upstream AionUi binary.
 */
import type { GithubOptions } from 'builder-util-runtime';

export function buildStudioFeedOptions(): GithubOptions {
  return { provider: 'github', owner: 'handochan', repo: 'aelix-studio' };
}
