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
const JOURNAL_PROBE_BYTES = 256 * 1024;
const MAX_ACTIVE_JOURNAL_PROBES = 2;
let activeJournalProbes = 0;

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

async function* journalLines(file: FileHandle, size: number, probeBytes?: number): AsyncGenerator<string> {
  const strict = probeBytes === undefined;
  const endOfScan = probeBytes ?? size;
  const decoder = new TextDecoder('utf-8', { fatal: strict, ignoreBOM: true });
  const chunk = Buffer.alloc(JOURNAL_CHUNK_BYTES);
  let carry = Buffer.alloc(0);
  let discardLine = false;
  for (let offset = 0; offset < endOfScan; ) {
    const { bytesRead } = await file.read(chunk, 0, Math.min(chunk.length, endOfScan - offset), offset);
    if (!bytesRead) throw new Error('Analytics journal was truncated');
    offset += bytesRead;
    const data = carry.length ? Buffer.concat([carry, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead);
    let start = 0;
    for (let end = data.indexOf(10, start); end !== -1; end = data.indexOf(10, start)) {
      if (end - start > MAX_JOURNAL_LINE_BYTES) {
        if (strict) throw new Error('Analytics journal record is too large');
      } else if (!discardLine) {
        yield decoder.decode(data.subarray(start, end));
      }
      discardLine = false;
      start = end + 1;
    }
    if (data.length - start > MAX_JOURNAL_LINE_BYTES) {
      if (strict) throw new Error('Analytics journal record is too large');
      discardLine = true;
    }
    carry = discardLine ? Buffer.alloc(0) : Buffer.from(data.subarray(start));
  }
  if (carry.length && endOfScan === size) yield decoder.decode(carry);
}

/** Scan a single verified journal snapshot without imposing the asset size limit. */
export async function scanPreviewJournal<T>(
  root: PreviewRoot,
  scan: (lines: () => AsyncGenerator<string>) => Promise<T>
): Promise<T | 404> {
  return withStableFile(root, ['journal.jsonl'], (file, size) => scan(() => journalLines(file, size)));
}

type JournalProbe = 'analytics' | 'no-evidence' | 'inconclusive';
type ProbeBudget = { remaining: number };

async function probeAnalyticsJournal(root: PreviewRoot, budget: ProbeBudget): Promise<JournalProbe> {
  try {
    await lstat(path.join(root.directory, 'journal.jsonl'));
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'no-evidence' : 'inconclusive';
  }
  if (budget.remaining <= 0 || activeJournalProbes >= MAX_ACTIVE_JOURNAL_PROBES) return 'inconclusive';

  activeJournalProbes++;
  let recognized = false;
  try {
    const result = await withStableFile<JournalProbe>(root, ['journal.jsonl'], async (file, size) => {
      const bytes = Math.min(budget.remaining, size);
      budget.remaining -= bytes;
      for await (const line of journalLines(file, size, bytes)) {
        if (!line.trim()) continue;
        try {
          const entry: unknown = JSON.parse(line);
          if (
            entry &&
            typeof entry === 'object' &&
            'schema' in entry &&
            (entry.schema === 'lab.event/1' || entry.schema === 'analytics.event/2')
          ) {
            recognized = true;
            return 'analytics';
          }
        } catch {
          // Recognition only denies fallback. Scan past damage within the prefix.
        }
      }
      return bytes === size ? 'no-evidence' : 'inconclusive';
    });
    // Evidence can only deny ordinary rendering. A concurrent append does not erase it.
    if (recognized) return 'analytics';
    return result === 404 ? 'inconclusive' : result;
  } finally {
    activeJournalProbes--;
  }
}

async function openProjectRoot(directory: string): Promise<PreviewRoot> {
  const canonical = await realpath(directory);
  const identity = await lstat(canonical);
  if (!identity.isDirectory()) throw new Error('Analytics project root is unavailable');
  return { directory: canonical, identity };
}

async function projectMarker(root: PreviewRoot): Promise<'valid' | 'missing' | 'invalid'> {
  try {
    await lstat(path.join(root.directory, 'analytics.json'));
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'invalid';
  }
  const marker = await readPreviewFile(root, ['analytics.json'], MAX_MARKER_BYTES);
  let schema: unknown;
  if (marker instanceof Uint8Array) {
    try {
      const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(marker));
      if (value && typeof value === 'object' && 'schema' in value) schema = value.schema;
    } catch {
      return 'invalid';
    }
  }
  if (schema === 'analytics.project/2') return 'valid';
  if (typeof schema === 'string' && schema.startsWith('analytics.project/')) {
    throw new Error('Invalid Analytics project marker');
  }
  return 'invalid';
}

function isPreparedReportPath(parts: string[]): boolean {
  return parts[0] === 'artifacts' && parts[1] === 'reports' && parts[3] === '.staging';
}

function isReportContentPath(parts: string[]): boolean {
  return Boolean(
    originalReportScope(parts) ||
    (isPreparedReportPath(parts) && parts[5] === 'content' && parts.length > 6) ||
    (isReportViewPath(parts) && parts[4] === 'files' && parts.length > 5) ||
    isGeneratedReportBody(parts)
  );
}

async function hasReportRecord(root: PreviewRoot, parts: string[]): Promise<boolean> {
  const report = originalReportScope(parts);
  const prepared = isPreparedReportPath(parts) && parts.length > 5;
  const view = isReportViewPath(parts);
  if (!report && !prepared && !view) return false;
  const metadata = prepared
    ? [...parts.slice(0, 5), 'manifest.json']
    : [...parts.slice(0, 4), report ? 'manifest.json' : 'view.json'];
  const bytes = await readPreviewFile(root, metadata);
  if (typeof bytes === 'number') return false;
  try {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!value || typeof value !== 'object') return false;
    if (report || prepared) return 'schema' in value && value.schema === 'analytics.report_revision/1';
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
  const budget = { remaining: JOURNAL_PROBE_BYTES };
  let workspace;
  for (let index = 0; index < segments.length - 1; index++) {
    const parts = segments.slice(index);
    const report = originalReportScope(parts);
    const prepared = isPreparedReportPath(parts);
    if (!report && !prepared && parts[0] !== 'workspace') continue;
    const directory = path.join(volume, ...segments.slice(0, index));
    const root = await openProjectRoot(directory);
    const marker = await projectMarker(root);
    if (marker !== 'valid') {
      const journal = (await hasReportRecord(root, parts)) ? 'analytics' : await probeAnalyticsJournal(root, budget);
      if (journal === 'analytics' || (journal === 'inconclusive' && isReportContentPath(parts))) {
        throw new Error(
          marker === 'missing' ? 'Analytics project marker is unavailable' : 'Invalid Analytics project marker'
        );
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
