/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { constants } from 'node:fs';
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import type { Stats } from 'node:fs';
import {
  analyticsPathSegments,
  isGeneratedReportBody,
  originalReportScope,
  isReportViewPath,
  type AnalyticsPreviewScope,
} from '@/common/utils/analyticsPreview';

export const MAX_ANALYTICS_PREVIEW_BYTES = 16 * 1024 * 1024;
const MAX_MARKER_BYTES = 64 * 1024;
// Both supported Analytics writers limit a complete record to less than 50 KiB.
const MAX_JOURNAL_LINE_BYTES = 64 * 1024;
const JOURNAL_CHUNK_BYTES = 64 * 1024;

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

async function withStableFile<T>(
  root: PreviewRoot,
  parts: string[],
  read: (file: FileHandle, size: number) => Promise<T>
): Promise<T | 404> {
  if (!parts.length || parts.some((part) => part.includes('/') || !analyticsPathSegments(part))) return 404;
  try {
    const { filename, info } = await inspectPath(root, parts);
    if (!info.isFile()) return 404;
    const file = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const opened = await file.stat();
      if (!opened.isFile() || opened.nlink > 1 || !sameFile(info, opened)) return 404;
      const result = await read(file, opened.size);
      const named = (await inspectPath(root, parts)).info;
      if (
        !sameFile(opened, named) ||
        named.nlink > 1 ||
        named.size !== opened.size ||
        named.mtimeMs !== opened.mtimeMs ||
        named.ctimeMs !== opened.ctimeMs
      )
        return 404;
      return result;
    } finally {
      await file.close();
    }
  } catch {
    return 404;
  }
}

/** Read a bounded asset without returning bytes from a changed file. */
export async function readPreviewFile(
  root: PreviewRoot,
  parts: string[],
  maxBytes = MAX_ANALYTICS_PREVIEW_BYTES
): Promise<Uint8Array<ArrayBuffer> | 404 | 413> {
  return withStableFile<Uint8Array<ArrayBuffer> | 404 | 413>(root, parts, async (file, size) => {
    if (size > maxBytes) return 413;
    const bytes = new Uint8Array(size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) return 404;
      offset += bytesRead;
    }
    return bytes;
  });
}

async function* journalLines(file: FileHandle, size: number): AsyncGenerator<string> {
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const chunk = Buffer.alloc(JOURNAL_CHUNK_BYTES);
  let carry = Buffer.alloc(0);
  for (let offset = 0; offset < size; ) {
    const { bytesRead } = await file.read(chunk, 0, Math.min(chunk.length, size - offset), offset);
    if (!bytesRead) throw new Error('Analytics journal was truncated');
    offset += bytesRead;
    const data = carry.length ? Buffer.concat([carry, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead);
    let start = 0;
    for (let end = data.indexOf(10, start); end !== -1; end = data.indexOf(10, start)) {
      if (end - start > MAX_JOURNAL_LINE_BYTES) throw new Error('Analytics journal record is too large');
      yield decoder.decode(data.subarray(start, end));
      start = end + 1;
    }
    if (data.length - start > MAX_JOURNAL_LINE_BYTES) throw new Error('Analytics journal record is too large');
    carry = Buffer.from(data.subarray(start));
  }
  if (carry.length) yield decoder.decode(carry);
}

/** Scan a single verified journal snapshot without imposing the asset size limit. */
export async function scanPreviewJournal<T>(
  root: PreviewRoot,
  scan: (lines: () => AsyncGenerator<string>) => Promise<T>
): Promise<T | 404> {
  return withStableFile(root, ['journal.jsonl'], (file, size) => scan(() => journalLines(file, size)));
}

async function hasAnalyticsJournal(root: PreviewRoot): Promise<boolean> {
  const parsed = await scanPreviewJournal(root, async (lines) => {
    for await (const line of lines()) {
      if (!line.trim()) continue;
      const entry: unknown = JSON.parse(line);
      return Boolean(entry && typeof entry === 'object' && 'schema' in entry && entry.schema === 'analytics.event/2');
    }
    return false;
  });
  return parsed === true;
}

async function openProjectRoot(directory: string): Promise<PreviewRoot> {
  const canonical = await realpath(directory);
  const identity = await lstat(canonical);
  if (!identity.isDirectory()) throw new Error('Analytics project root is unavailable');
  return { directory: canonical, identity };
}

async function hasProjectMarker(root: PreviewRoot): Promise<boolean> {
  try {
    await lstat(path.join(root.directory, 'analytics.json'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw new Error('Analytics project marker is unavailable');
  }
  const marker = await readPreviewFile(root, ['analytics.json'], MAX_MARKER_BYTES);
  if (marker instanceof Uint8Array) {
    try {
      const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(marker));
      if (value && typeof value === 'object' && 'schema' in value && value.schema === 'analytics.project/2')
        return true;
    } catch {
      // Keep invalid Analytics content out of the ordinary HTML renderer.
    }
  }
  throw new Error('Invalid Analytics project marker');
}

async function hasReportRecord(root: PreviewRoot, parts: string[]): Promise<boolean> {
  const report = originalReportScope(parts);
  const view = isReportViewPath(parts);
  if (!report && !view) return false;
  const metadata = report ? [...report.revision.slice(0, -1), 'manifest.json'] : [...parts.slice(0, 4), 'view.json'];
  const bytes = await readPreviewFile(root, metadata);
  if (typeof bytes === 'number') return false;
  try {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!value || typeof value !== 'object') return false;
    if (report) return 'schema' in value && value.schema === 'analytics.report_revision/1';
    if (!('stamp' in value) || !value.stamp || typeof value.stamp !== 'object') return false;
    return 'revision_id' in value.stamp && value.stamp.revision_id === parts[3] && 'kit' in value.stamp;
  } catch {
    return false;
  }
}

/** Apply Analytics document rules only inside an identified Analytics project. */
export async function locateAnalyticsDocument(filename: string) {
  const volume = path.parse(filename).root;
  const segments = path.relative(volume, filename).split(path.sep);
  let workspace;
  for (let index = 0; index < segments.length - 1; index++) {
    const parts = segments.slice(index);
    const report = originalReportScope(parts);
    const prepared = parts[0] === 'artifacts' && parts[1] === 'reports' && parts[3] === '.staging';
    if (!report && !prepared && parts[0] !== 'workspace') continue;
    const directory = path.join(volume, ...segments.slice(0, index));
    const root = await openProjectRoot(directory);
    if (!(await hasProjectMarker(root))) {
      if ((await hasReportRecord(root, parts)) || (await hasAnalyticsJournal(root))) {
        throw new Error('Analytics project marker is unavailable');
      }
      continue;
    }
    if (prepared) throw new Error('A prepared Report revision cannot be previewed');
    if (report) return { root, scope: report, parts };
    const scope: AnalyticsPreviewScope = { kind: 'workspace', project: [] };
    const location = { root, scope, parts };
    if (isReportViewPath(parts)) return location;
    workspace = location;
  }
  return workspace;
}
