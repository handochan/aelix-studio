/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { analyticsPathSegments } from '@/common/utils/analyticsPreview';
import { readPreviewFile, scanPreviewJournal, type PreviewRoot } from './files';

export type RevisionFiles = ReadonlyMap<string, { bytes: number; sha256: string }>;
const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const digestPattern = /^[a-f0-9]{64}$/;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function integerSequence(line: string): number | undefined {
  // Python's Journal counts integers, excluding booleans, decimals and exponents.
  const value: unknown = JSON.parse(line, (key: string, parsed: unknown, context?: { source?: string }) =>
    key === 'seq' && typeof parsed === 'number' && !/^-?\d+$/.test(context?.source ?? '') ? undefined : parsed
  );
  const sequence = record(value)?.seq;
  if (typeof sequence === 'number' && Number.isSafeInteger(sequence)) return sequence;
}

async function matchesCompletion(
  lines: () => AsyncGenerator<string>,
  manifest: Record<string, unknown>,
  manifestDigest: string
): Promise<boolean> {
  let completion: { id: string; sequence: number } | undefined;
  for await (const line of lines()) {
    if (!line.trim()) continue;
    const event = record(JSON.parse(line));
    if (event?.schema !== 'analytics.event/2' || event.kind !== 'report_revision' || !Array.isArray(event.refs)) {
      continue;
    }
    const refs = event.refs.map(record).filter((ref) => ref?.type === 'report_revision' && ref.relation === 'about');
    for (const ref of refs) {
      if (ref?.report_id !== manifest.report_id || ref?.revision_id !== manifest.revision_id) continue;
      const sequence = integerSequence(line);
      if (
        completion ||
        refs.length !== 1 ||
        ref.basis !== 'observed' ||
        ref.version_binding !== 'author' ||
        record(ref.digest)?.sha256 !== manifestDigest ||
        sequence === undefined ||
        event.id !== `e${sequence}` ||
        typeof event.request_id !== 'string' ||
        event.request_id.toLowerCase() !== manifest.request_id ||
        record(event.details)?.previous_revision !== manifest.previous_revision
      )
        return false;
      completion = { id: event.id, sequence };
    }
  }
  if (!completion) return false;

  // Identity collisions count even on rows that Analytics cannot interpret.
  // A second pass on the same descriptor keeps memory independent of history length.
  let matchingRows = 0;
  for await (const line of lines()) {
    if (!line.trim()) continue;
    const event = record(JSON.parse(line));
    if (
      event?.id === completion.id ||
      (event?.seq === completion.sequence && integerSequence(line) === completion.sequence)
    ) {
      if (++matchingRows > 1) return false;
    }
  }
  return matchingRows === 1;
}

const MAX_ACTIVE_VERIFICATIONS = 2;
const MAX_WAITING_VERIFICATIONS = 32;
let activeVerifications = 0;
const waitingVerifications: Array<() => void> = [];

/** Bound simultaneous manifest and journal verification across every preview entry point. */
export async function savedRevisionFiles(root: PreviewRoot, revision: string[]): Promise<RevisionFiles | undefined> {
  if (activeVerifications >= MAX_ACTIVE_VERIFICATIONS) {
    if (waitingVerifications.length >= MAX_WAITING_VERIFICATIONS) return;
    await new Promise<void>((resume) => waitingVerifications.push(resume));
  } else {
    activeVerifications++;
  }
  try {
    return await loadSavedRevisionFiles(root, revision);
  } finally {
    const next = waitingVerifications.shift();
    if (next) next();
    else activeVerifications--;
  }
}

async function loadSavedRevisionFiles(root: PreviewRoot, revision: string[]): Promise<RevisionFiles | undefined> {
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
  const digest = sha256(bytes);
  const completionManifest = { ...manifest, request_id: manifest.request_id.toLowerCase() };
  const completed = await scanPreviewJournal(root, (lines) => matchesCompletion(lines, completionManifest, digest));
  if (completed === true) return files;
}

export function matchesSavedFile(bytes: Uint8Array, recorded: { bytes: number; sha256: string }): boolean {
  return bytes.byteLength === recorded.bytes && sha256(bytes) === recorded.sha256;
}
