/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { analyticsPathSegments, type AnalyticsPreviewScope } from '@/common/utils/analyticsPreview';
import { type PreviewRoot, previewFileType, readPreviewFile } from './files';

export const ANALYTICS_SCHEME = 'studio-analytics';
export const ANALYTICS_PARTITION = 'studio-analytics-preview';

const headers = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy': [
    "default-src 'none'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; '),
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-DNS-Prefetch-Control': 'off',
};

export type PreviewGrant = { root: PreviewRoot; scope: AnalyticsPreviewScope };

const MAX_ACTIVE_READS = 8;
const MAX_WAITING_READS = 128;
let activeReads = 0;
const waitingReads: Array<() => void> = [];

export function previewUrl(host: string, parts: string[]): string {
  return `${ANALYTICS_SCHEME}://${host}/${parts.map(encodeURIComponent).join('/')}`;
}

export function parsePreviewUrl(value: string): { host: string; parts: string[] } | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== `${ANALYTICS_SCHEME}:` || !/^[0-9a-f]{32}$/.test(url.host) || url.username || url.password) {
      return;
    }
    const parts = url.pathname.slice(1).split('/').map(decodeURIComponent);
    if (parts.some((part) => part.includes('/') || !analyticsPathSegments(part))) return;
    return { host: url.host, parts };
  } catch {
    return;
  }
}

/** Serve only regular files from the scope bound to this origin. Query strings are cache keys. */
export async function servePreview(
  request: Pick<Request, 'url' | 'method'>,
  getGrant: (host: string) => PreviewGrant | undefined
): Promise<Response> {
  const target = parsePreviewUrl(request.url);
  const grant = target && getGrant(target.host);
  if (!target || !grant || request.method !== 'GET') return new Response(null, { status: 403, headers });
  const contentType = previewFileType(grant.scope, target.parts);
  if (!contentType) return new Response(null, { status: 404, headers });

  if (activeReads >= MAX_ACTIVE_READS) {
    if (waitingReads.length >= MAX_WAITING_READS) return new Response(null, { status: 429, headers });
    await new Promise<void>((resolve) => waitingReads.push(resolve));
  } else {
    activeReads++;
  }
  try {
    if (getGrant(target.host) !== grant) return new Response(null, { status: 403, headers });
    const bytes = await readPreviewFile(grant.root, target.parts);
    if (getGrant(target.host) !== grant) return new Response(null, { status: 403, headers });
    if (typeof bytes === 'number') return new Response(null, { status: bytes, headers });
    return new Response(bytes, { headers: { ...headers, 'Content-Type': contentType } });
  } finally {
    const next = waitingReads.shift();
    if (next) next();
    else activeReads--;
  }
}
