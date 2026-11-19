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
export type AnalyticsPreviewMode = 'ordinary' | 'isolated' | 'source-only';

export const ANALYTICS_PREVIEW_CHANNELS = {
  classify: 'studio:analytics-preview:classify',
  open: 'studio:analytics-preview:open',
  close: 'studio:analytics-preview:close',
  detach: 'studio:analytics-preview:detach',
} as const;

export type AnalyticsPreviewAPI = {
  classify: (request: AnalyticsPreviewRequest) => Promise<AnalyticsPreviewMode>;
  open: (request: AnalyticsPreviewRequest) => Promise<AnalyticsPreviewHandle | null>;
  close: (url: string) => Promise<void>;
  detach: (projectId: string, peId: string) => Promise<void>;
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

export function isAnalyticsDocument(filename: string): boolean {
  return /\.(?:html?|svg)$/i.test(filename);
}

export function originalReportScope(parts: string[]): Extract<AnalyticsPreviewScope, { kind: 'report' }> | undefined {
  if (parts[0] === 'artifacts' && parts[1] === 'reports' && parts[4] === 'content' && parts.length >= 6) {
    return { kind: 'report', project: [], revision: parts.slice(0, 5) };
  }
}

/** Identify the unmodified Analytics project layout. */
export function analyticsPreviewScope(relativePath: string): AnalyticsPreviewScope | undefined {
  const parts = analyticsPathSegments(relativePath);
  if (!parts || !isAnalyticsDocument(parts.at(-1) ?? '')) return undefined;

  for (let i = parts.length - 2; i >= 0; i--) {
    const report = originalReportScope(parts.slice(i));
    if (report) return { ...report, project: parts.slice(0, i) };
  }
  const workspace = parts.lastIndexOf('workspace', parts.length - 2);
  if (workspace !== -1) return { kind: 'workspace', project: parts.slice(0, workspace) };
}

/** The kit puts copied originals beside each generated Report body. */
export function isReportViewPath(parts: string[]): boolean {
  return parts[0] === 'workspace' && parts[1] === 'reports' && parts.length >= 5;
}

export function isGeneratedReportBody(parts: string[]): boolean {
  return isReportViewPath(parts) && parts.length === 6 && parts[4] === 'preview' && parts[5] === 'report.html';
}
