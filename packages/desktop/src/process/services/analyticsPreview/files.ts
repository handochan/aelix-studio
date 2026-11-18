/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { Stats } from 'node:fs';
import {
  analyticsPathSegments,
  isGeneratedReportBody,
  isReportViewPath,
  type AnalyticsPreviewScope,
} from '@/common/utils/analyticsPreview';

export const MAX_ANALYTICS_PREVIEW_BYTES = 16 * 1024 * 1024;
const MAX_MARKER_BYTES = 64 * 1024;

const contentTypes = new Map([
  ['.htm', 'text/html; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json'],
  ['.avif', 'image/avif'],
  ['.gif', 'image/gif'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.webp', 'image/webp'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
]);

export function previewFileType(scope: AnalyticsPreviewScope, parts: string[]): string | undefined {
  const contentType = contentTypes.get(path.extname(parts.at(-1) ?? '').toLowerCase());
  if (!contentType) return;
  if (scope.kind === 'report') {
    return parts.length > scope.revision.length && scope.revision.every((part, i) => part === parts[i])
      ? contentType
      : undefined;
  }
  if (parts[0] === 'workspace' && parts.length > 1) {
    if (isReportViewPath(parts) && !isGeneratedReportBody(parts)) return;
    return contentType;
  }
  if (parts.length === 4 && parts[0] === 'runs' && parts[2] === 'visualizations' && contentType.startsWith('image/')) {
    return contentType;
  }
}

export type PreviewRoot = { directory: string; identity: Stats };

async function inspectPath(root: PreviewRoot, parts: string[]): Promise<{ filename: string; info: Stats }> {
  let filename = root.directory;
  let info = await lstat(filename);
  if (!info.isDirectory() || !sameFile(info, root.identity)) throw new Error('Preview root changed');
  for (const part of parts) {
    if (!info.isDirectory()) throw new Error('Expected a directory');
    filename = path.join(filename, part);
    info = await lstat(filename);
    if (info.isSymbolicLink()) throw new Error('Preview cannot follow links');
  }
  if ((await realpath(filename)) !== filename) throw new Error('Preview path changed');
  return { filename, info };
}

function sameFile(first: Stats, second: Stats): boolean {
  return first.dev === second.dev && first.ino === second.ino;
}

/** Resolve the canonical Explorer root and inspect the Analytics marker under it. */
export async function resolvePreviewRoot(
  explorerDirectory: string,
  scope: AnalyticsPreviewScope
): Promise<PreviewRoot | undefined> {
  if (!path.isAbsolute(explorerDirectory)) return;
  const directory = await realpath(explorerDirectory);
  const explorer = { directory, identity: await lstat(directory) };
  const project = await inspectPath(explorer, scope.project);
  if (!project.info.isDirectory()) return;
  const root = { directory: project.filename, identity: project.info };
  try {
    await lstat(path.join(root.directory, 'analytics.json'));
  } catch (error) {
    // An ordinary Explorer folder is the only case that can fall back to the
    // general HTML preview. An unreadable Analytics marker fails closed.
    if (scope.kind === 'workspace' && (error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new Error('Analytics project marker is unavailable');
  }
  const marker = await readPreviewFile(root, ['analytics.json'], MAX_MARKER_BYTES);
  if (marker instanceof Uint8Array) {
    try {
      const data: unknown = JSON.parse(new TextDecoder().decode(marker));
      if (data && typeof data === 'object' && 'schema' in data && data.schema === 'analytics.project/2') return root;
    } catch {
      // Do not return the parse failure or its contents across IPC.
    }
  }
  throw new Error('Invalid Analytics project marker');
}

/** Read a bounded file by descriptor and check that its name still refers to that file before sending bytes. */
export async function readPreviewFile(
  root: PreviewRoot,
  parts: string[],
  maxBytes = MAX_ANALYTICS_PREVIEW_BYTES
): Promise<Uint8Array<ArrayBuffer> | 404 | 413> {
  if (!parts.length || parts.some((part) => part.includes('/') || !analyticsPathSegments(part))) return 404;
  try {
    const { filename, info } = await inspectPath(root, parts);
    if (!info.isFile()) return 404;
    if (info.size > maxBytes) return 413;
    const file = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const opened = await file.stat();
      if (!opened.isFile() || opened.nlink > 1 || !sameFile(info, opened)) return 404;
      if (opened.size > maxBytes) return 413;
      const bytes = new Uint8Array(opened.size);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
        if (!bytesRead) return 404;
        offset += bytesRead;
      }
      const end = await file.stat();
      if (end.size > maxBytes) return 413;
      if (end.size !== opened.size || end.mtimeMs !== opened.mtimeMs || end.ctimeMs !== opened.ctimeMs) return 404;
      if (!sameFile(opened, (await inspectPath(root, parts)).info)) return 404;
      return bytes;
    } finally {
      await file.close();
    }
  } catch {
    return 404;
  }
}
