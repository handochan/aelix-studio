import { readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Spawn } from '../process.js';
import { isImportSetId, pruneArtifacts, removeStaging } from './artifacts.js';
import type { Bundle, Layout } from './layout.js';
import { probeLeases } from './lock.js';
import { readGenerationRecord, readPointer } from './pointer.js';

const list = (directory: string): Promise<string[]> => readdir(directory).catch(() => [] as string[]);
const remove = (target: string): Promise<void> => rm(target, { recursive: true, force: true, maxRetries: 3 });

/**
 * Undo what an interrupted change left behind (D04 ADR 5.6). Call under the mutation lock,
 * before reading the pointer: with the lock held, nothing else can be building a candidate.
 *
 * Removes generation directories that never got their `generation.json`, temporary files
 * of interrupted writes and staging directories of the wheel store. Returns the candidates removed.
 */
export async function recover(layout: Layout): Promise<string[]> {
  const removed: string[] = [];
  for (const entry of await list(layout.generations)) {
    const directory = path.join(layout.generations, entry);
    // oxlint-disable-next-line no-await-in-loop -- a handful of directories, checked in order
    const finished = await stat(path.join(directory, 'generation.json')).then(
      (stats) => stats.isFile(),
      () => false
    );
    if (finished) continue;
    // oxlint-disable-next-line no-await-in-loop
    await remove(directory);
    removed.push(entry);
  }
  const temporary = (await list(layout.root)).filter((entry) => entry.endsWith('.tmp'));
  await Promise.all(temporary.map((entry) => remove(path.join(layout.root, entry))));
  await removeStaging(layout);
  return removed;
}

export type CollectRequest = { bundle: Bundle; layout: Layout; spawn: Spawn; env: Record<string, string> };

export type CollectReport = {
  removed: string[];
  /** Generations kept only because a running launcher holds a lease on them. */
  leased: string[];
  removedArtifacts: string[];
  /** True when leases could not be checked, so nothing was removed. */
  skipped: boolean;
};

/**
 * Remove what is no longer needed (ADR 5.6). Call under the mutation lock, after a switch.
 *
 * Kept: the current generation, the previous one (the one-step rollback target) and every
 * generation with a lease a running launcher still holds. Stored wheel sets are kept while
 * a kept generation refers to them. Without a usable pointer every generation is kept.
 */
export async function collect(request: CollectRequest): Promise<CollectReport> {
  const { layout } = request;
  const report: CollectReport = { removed: [], leased: [], removedArtifacts: [], skipped: false };
  const leases = await probeLeases(request);
  if (!leases) return { ...report, skipped: true };
  await Promise.all(leases.stale.map((name) => remove(path.join(layout.leases, name))));
  const { pointer } = await readPointer(layout);
  const keep = new Set([pointer?.generation, pointer?.previous]);
  const referenced = new Set<string>();
  for (const entry of await list(layout.generations)) {
    // Without a usable pointer there is no telling what is current: every generation stays.
    if (pointer && !keep.has(entry) && !leases.held.has(entry)) {
      // oxlint-disable-next-line no-await-in-loop -- removal of a few directories, in order
      await remove(path.join(layout.generations, entry));
      report.removed.push(entry);
      continue;
    }
    if (pointer && !keep.has(entry)) report.leased.push(entry);
    // oxlint-disable-next-line no-await-in-loop
    const record = await readGenerationRecord(layout, entry);
    for (const distribution of Object.values(record?.distributions ?? {}))
      if (isImportSetId(distribution.origin?.artifact)) referenced.add(distribution.origin.artifact);
  }
  report.removedArtifacts = await pruneArtifacts(layout, referenced);
  return report;
}
