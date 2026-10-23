/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Aelix Studio updates must never install an upstream AionUi binary.
 */
import type { GithubOptions } from 'builder-util-runtime';

export function buildStudioFeedOptions(): GithubOptions {
  return { provider: 'github', owner: 'handochan', repo: 'aelix-studio' };
}
