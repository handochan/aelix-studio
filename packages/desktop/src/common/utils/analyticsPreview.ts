/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ChatFileRef } from '../types/chatFile';

export type AnalyticsPreviewRequest = {
  projectId: string;
  file: Extract<ChatFileRef, { kind: 'project' }>;
};

export type AnalyticsPreviewHandle = { url: string; partition: string };

export const ANALYTICS_PREVIEW_CHANNELS = {
  matches: 'studio:analytics-preview:matches',
  open: 'studio:analytics-preview:open',
  close: 'studio:analytics-preview:close',
} as const;

export type AnalyticsPreviewAPI = {
  matches: (request: AnalyticsPreviewRequest) => Promise<boolean>;
  open: (request: AnalyticsPreviewRequest) => Promise<AnalyticsPreviewHandle | null>;
  close: (url: string) => Promise<void>;
};

export type AnalyticsPreviewScope =
  | { kind: 'workspace'; project: string[] }
  | { kind: 'report'; project: string[]; revision: string[] };

/** Accept portable path segments without separators, aliases, or Windows alternate streams. */
export function analyticsPathSegments(relativePath: string): string[] | undefined {
  const segments = relativePath.split('/');
  return segments.every(
    (part) => part && !/[\\:]/.test(part) && !/[. ]$/.test(part) && [...part].every((char) => char.charCodeAt(0) >= 32)
  )
    ? segments
    : undefined;
}

/** Identify an HTML entry in the unmodified Analytics project layout. */
export function analyticsPreviewScope(relativePath: string): AnalyticsPreviewScope | undefined {
  const parts = analyticsPathSegments(relativePath);
  if (!parts || !/\.html?$/i.test(parts.at(-1) ?? '')) return undefined;

  for (let i = parts.length - 2; i >= 0; i--) {
    if (parts[i] === 'artifacts' && parts[i + 1] === 'reports' && parts[i + 4] === 'content' && i + 5 < parts.length) {
      return { kind: 'report', project: parts.slice(0, i), revision: parts.slice(i, i + 5) };
    }
  }
  const workspace = parts.lastIndexOf('workspace', parts.length - 2);
  if (workspace !== -1) return { kind: 'workspace', project: parts.slice(0, workspace) };
}
