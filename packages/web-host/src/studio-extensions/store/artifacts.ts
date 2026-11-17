import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ExtensionFailure, type ExtensionSource } from '../types.js';
import type { Layout } from './layout.js';

/**
 * The store of imported wheels (D04 ADR 5.8, 5.9). A file import is copied here first and
 * installed from the copy, so the bytes that were checked are the bytes that are installed,
 * and a later rebuild can reinstall the same bytes without any network.
 *
 * Everything here runs under the mutation lock: the store is shared with clean-up.
 */
export type ImportSet = {
  /** Directory name under `artifacts/`: derived from the file names and hashes of the set. */
  id: string;
  directory: string;
  /** The requested wheel, inside the set. */
  target: string;
  /** sha256 by file name, for every wheel of the set. */
  digests: Record<string, string>;
};

/** Wheels copied out of the user's folders, not yet accepted into the store. */
export type StagedImport = { directory: string; target: string; files: string[] };

const STAGING_PREFIX = '.staging-';
const SET_ID = /^[0-9a-f]{16}$/;

/** Whether a string read from a generation record may be used as a store directory name. */
export function isImportSetId(value: unknown): value is string {
  return typeof value === 'string' && SET_ID.test(value);
}

/** sha256 of a file, read as a stream so a large wheel is never held in memory. */
export async function hashFile(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

const isWheelName = (name: string): boolean => name.endsWith('.whl');
const isRegularFile = (file: string): Promise<boolean> =>
  stat(file).then(
    (stats) => stats.isFile(),
    () => false
  );

/**
 * Copy the requested wheel, and every wheel of `source.folder` when given, into a staging
 * directory of the store. Only `*.whl` files are taken from the folder; nothing else in it
 * is read.
 *
 * @throws ExtensionFailure `NOT_A_WHEEL` when the requested file is not a `.whl` file.
 */
export async function stageImport(layout: Layout, source: ExtensionSource): Promise<StagedImport> {
  const requested = path.resolve(source.path);
  const refuse = (reason: string): never => {
    throw new ExtensionFailure('NOT_A_WHEEL', [`${path.basename(requested)}: ${reason}`]);
  };
  if (!isWheelName(requested)) refuse('not a wheel (a source archive would have to be built)');
  if (!(await isRegularFile(requested))) refuse('no such file');
  const sources = new Map([[path.basename(requested), requested]]);
  if (source.folder !== undefined) {
    const folder = path.resolve(source.folder);
    let names: string[];
    try {
      names = (await readdir(folder)).filter(isWheelName).toSorted();
    } catch {
      throw new ExtensionFailure('INVALID_INPUT', ['the folder cannot be read']);
    }
    // The requested wheel wins over a folder entry of the same file name.
    for (const name of names) if (!sources.has(name)) sources.set(name, path.join(folder, name));
  }
  const directory = path.join(layout.artifacts, STAGING_PREFIX + randomBytes(6).toString('hex'));
  await mkdir(directory, { recursive: true });
  try {
    for (const [name, file] of sources) {
      // oxlint-disable-next-line no-await-in-loop -- one copy at a time keeps disk use predictable
      if (await isRegularFile(file)) await copyFile(file, path.join(directory, name));
    }
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  const files = (await readdir(directory)).toSorted().map((name) => path.join(directory, name));
  return { directory, target: path.join(directory, path.basename(requested)), files };
}

/** Drop a staging directory. */
export async function discardStage(staged: StagedImport): Promise<void> {
  await rm(staged.directory, { recursive: true, force: true });
}

/**
 * Accept a checked staging directory into the store. The set is named by its content, so
 * importing the same wheels again reuses the stored copy after its hashes are confirmed.
 */
export async function promoteImport(layout: Layout, staged: StagedImport): Promise<ImportSet> {
  const digests: Record<string, string> = {};
  // oxlint-disable-next-line no-await-in-loop -- sequential hashing bounds memory and disk load
  for (const file of staged.files) digests[path.basename(file)] = await hashFile(file);
  const id = createHash('sha256').update(JSON.stringify(digests)).digest('hex').slice(0, 16);
  const directory = path.join(layout.artifacts, id);
  const targetName = path.basename(staged.target);
  const stored = await storedDigests(directory, Object.keys(digests));
  if (stored && Object.entries(digests).every(([name, digest]) => stored[name] === digest)) {
    await discardStage(staged);
  } else {
    await rm(directory, { recursive: true, force: true });
    await writeFile(path.join(staged.directory, 'sha256.json'), JSON.stringify(digests, null, 2) + '\n');
    await rename(staged.directory, directory);
  }
  return { id, directory, target: path.join(directory, targetName), digests };
}

async function storedDigests(directory: string, names: string[]): Promise<Record<string, string> | undefined> {
  try {
    const digests: Record<string, string> = {};
    // oxlint-disable-next-line no-await-in-loop
    for (const name of names) digests[name] = await hashFile(path.join(directory, name));
    return digests;
  } catch {
    return undefined;
  }
}

/** Remove staging directories left by an interrupted import. Call under the mutation lock. */
export async function removeStaging(layout: Layout): Promise<void> {
  const entries = await readdir(layout.artifacts).catch(() => [] as string[]);
  await Promise.all(
    entries
      .filter((entry) => entry.startsWith(STAGING_PREFIX))
      .map((entry) => rm(path.join(layout.artifacts, entry), { recursive: true, force: true }))
  );
}

/**
 * Remove every stored set no kept generation refers to. Call under the mutation lock.
 * Returns the names removed.
 */
export async function pruneArtifacts(layout: Layout, referenced: Set<string>): Promise<string[]> {
  const entries = await readdir(layout.artifacts).catch(() => [] as string[]);
  const removed = entries.filter((entry) => !referenced.has(entry));
  await Promise.all(removed.map((entry) => rm(path.join(layout.artifacts, entry), { recursive: true, force: true })));
  return removed;
}
