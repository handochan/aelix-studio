/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { analyticsPathSegments } from '@/common/utils/analyticsPreview';
import { readPreviewFile, type PreviewRoot } from './files';

export type RevisionFiles = ReadonlyMap<string, { bytes: number; sha256: string }>;
const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const digestPattern = /^[a-f0-9]{64}$/;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function matchesCompletion(journal: Uint8Array, manifest: Record<string, unknown>, manifestDigest: string): boolean {
  let completed = false;
  try {
    for (const line of new TextDecoder().decode(journal).split('\n')) {
      if (!line.trim()) continue;
      const event = record(JSON.parse(line));
      if (event?.schema !== 'analytics.event/2' || event.kind !== 'report_revision' || !Array.isArray(event.refs)) {
        continue;
      }
      const refs = event.refs.map(record).filter((ref) => ref?.type === 'report_revision' && ref.relation === 'about');
      for (const ref of refs) {
        if (ref?.report_id !== manifest.report_id || ref?.revision_id !== manifest.revision_id) continue;
        if (
          completed ||
          refs.length !== 1 ||
          ref.basis !== 'observed' ||
          ref.version_binding !== 'author' ||
          record(ref.digest)?.sha256 !== manifestDigest ||
          !Number.isSafeInteger(event.seq) ||
          event.id !== `e${event.seq}` ||
          typeof event.request_id !== 'string' ||
          event.request_id.toLowerCase() !== manifest.request_id ||
          record(event.details)?.previous_revision !== manifest.previous_revision
        )
          return false;
        completed = true;
      }
    }
  } catch {
    return false;
  }
  return completed;
}

/** Pin the revision file set to the completion event and its recorded manifest digest. */
export async function savedRevisionFiles(root: PreviewRoot, revision: string[]): Promise<RevisionFiles | undefined> {
  const [, , reportId, revisionId] = revision;
  const bytes = await readPreviewFile(root, [...revision.slice(0, -1), 'manifest.json']);
  if (typeof bytes === 'number') return;
  let manifest: Record<string, unknown> | undefined;
  try {
    manifest = record(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    return;
  }
  if (
    manifest?.schema !== 'analytics.report_revision/1' ||
    manifest.report_id !== reportId ||
    manifest.revision_id !== revisionId ||
    typeof manifest.request_id !== 'string' ||
    !(manifest.previous_revision === null || typeof manifest.previous_revision === 'string') ||
    typeof manifest.entry !== 'string' ||
    !Array.isArray(manifest.files)
  )
    return;

  const files = new Map<string, { bytes: number; sha256: string }>();
  for (const value of manifest.files) {
    const file = record(value);
    if (
      !file ||
      typeof file.path !== 'string' ||
      !analyticsPathSegments(file.path) ||
      files.has(file.path) ||
      typeof file.bytes !== 'number' ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 0 ||
      typeof file.sha256 !== 'string' ||
      !digestPattern.test(file.sha256)
    )
      return;
    files.set(file.path, { bytes: file.bytes, sha256: file.sha256 });
  }
  if (!files.has(manifest.entry)) return;
  const journal = await readPreviewFile(root, ['journal.jsonl']);
  if (
    typeof journal !== 'number' &&
    matchesCompletion(journal, { ...manifest, request_id: manifest.request_id.toLowerCase() }, sha256(bytes))
  )
    return files;
}

export function matchesSavedFile(bytes: Uint8Array, recorded: { bytes: number; sha256: string }): boolean {
  return bytes.byteLength === recorded.bytes && sha256(bytes) === recorded.sha256;
}
