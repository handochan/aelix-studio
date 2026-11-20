import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { Spawn } from '../process.js';
import { isImportSetId, pruneArtifacts, removeStaging } from './artifacts.js';
import { isGenerationId, type Bundle, type Layout } from './layout.js';
import { probeLeases, type StateWriter } from './lock.js';
import { readGenerationRecord, readPointer } from './pointer.js';

const list = (directory: string): Promise<string[]> => readdir(directory).catch(() => [] as string[]);

/** The Windows lock holder preserves a sibling record during interrupted retirement. */
function retiredGeneration(entry: string): string | undefined {
  const prefix = '.retired-';
  const generation = entry.slice(prefix.length);
  return entry.startsWith(prefix) && isGenerationId(generation) ? generation : undefined;
}

async function isFinished(layout: Layout, entry: string): Promise<boolean> {
  const directory = path.join(layout.generations, entry);
  try {
    return (await lstat(directory)).isDirectory() && (await lstat(path.join(directory, 'generation.json'))).isFile();
  } catch {
    return false;
  }
}

/**
 * Undo what an interrupted change left behind (D04 ADR 5.6). Call under the mutation lock,
 * before reading the pointer: with the lock held, nothing else can be building a candidate.
 *
 * A Windows generation marked retired is retried by collection after the next switch.
 * Removes generation directories that never got their `generation.json`, temporary files
 * of interrupted writes and staging directories of the wheel store. Everything is removed by
 * the lock holder. Returns the candidates removed.
 */
export async function recover(layout: Layout, writer: StateWriter): Promise<string[]> {
  const removed: string[] = [];
  const entries = await list(layout.generations);
  const present = new Set(entries);
  const retired = new Set(entries.map(retiredGeneration).filter((id) => id !== undefined));
  for (const entry of entries) {
    const target = retiredGeneration(entry);
    if (target !== undefined) {
      // oxlint-disable-next-line no-await-in-loop -- a crash may have removed the directory but left its record
      if (!present.has(target)) await writer.remove('generations/' + entry);
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop -- a handful of directories, checked in order
    if (retired.has(entry) || (await isFinished(layout, entry))) continue;
    // A link among the generations is not one the helper made; the holder removes the link, not its target.
    // oxlint-disable-next-line no-await-in-loop
    await writer.remove(`generations/${entry}`);
    removed.push(entry);
  }
  for (const entry of (await list(layout.root)).filter((name) => name.endsWith('.tmp'))) {
    // oxlint-disable-next-line no-await-in-loop -- the lock holder removes one entry at a time
    await writer.remove(entry);
  }
  await removeStaging(layout, writer);
  return removed;
}

export type CollectRequest = {
  bundle: Bundle;
  layout: Layout;
  spawn: Spawn;
  env: Record<string, string>;
  writer: StateWriter;
};

export type CollectReport = {
  removed: string[];
  /** Generations kept only because a lease on them is held or could not be checked. */
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
 *
 * @throws ExtensionFailure `CONFLICT` when the lock is lost on the way; nothing more is removed then.
 */
export async function collect(request: CollectRequest): Promise<CollectReport> {
  const { layout, writer } = request;
  const report: CollectReport = { removed: [], leased: [], removedArtifacts: [], skipped: false };
  const leases = await probeLeases(request);
  if (!leases) return { ...report, skipped: true };
  const leaseFiles = new Set(await list(layout.leases));
  for (const name of leases.stale) {
    const snapshot = name + '.snapshot.json';
    // oxlint-disable-next-line no-await-in-loop -- sidecar must go before its stale lease
    if (leaseFiles.has(snapshot)) await writer.remove(`leases/${snapshot}`);
    // oxlint-disable-next-line no-await-in-loop -- the lock holder removes one entry at a time
    await writer.remove(`leases/${name}`);
  }
  const { pointer } = await readPointer(layout);
  const keep = new Set([pointer?.generation, pointer?.previous]);
  const referenced = new Set<string>();
  for (const entry of await list(layout.generations)) {
    if (retiredGeneration(entry) !== undefined) continue;
    // Without a usable pointer there is no telling what is current: every generation stays.
    if (pointer && !keep.has(entry) && !leases.held.has(entry)) {
      // oxlint-disable-next-line no-await-in-loop -- removal of a few directories, in order
      await writer.remove(`generations/${entry}`);
      report.removed.push(entry);
      continue;
    }
    if (pointer && !keep.has(entry)) report.leased.push(entry);
    // oxlint-disable-next-line no-await-in-loop
    const record = await readGenerationRecord(layout, entry);
    for (const { origin } of Object.values(record?.distributions ?? {}))
      if (origin?.kind === 'file' && isImportSetId(origin.artifact)) referenced.add(origin.artifact);
  }
  report.removedArtifacts = await pruneArtifacts(layout, referenced, writer);
  return report;
}
