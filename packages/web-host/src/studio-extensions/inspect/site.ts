import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseExtensionEntries, parseRecordPaths, readIdentity } from './metadata.js';
import { isStartupEntry, topLevelName } from './wheel.js';

/** The installer every generation carries. It is Studio's, never an extension's. */
export const INSTALLER = 'pip';

export type InstalledDistribution = {
  /** Canonical distribution name. */
  name: string;
  version: string;
  /** sha256 of the `RECORD` file: changes whenever the installer rewrites the distribution. */
  recordSha256: string;
  /** Directory name of the `.dist-info`. */
  info: string;
  /** Paths listed in `RECORD`, relative to `site-packages`. */
  files: string[];
};

export type InstalledExtension = { reference: string; distribution: string };

/** What a `site-packages` directory holds, read from its files. Nothing is imported. */
export type SiteSnapshot = {
  distributions: Map<string, InstalledDistribution>;
  /** `aelix.extensions` entries by entry name. */
  extensions: Map<string, InstalledExtension>;
  /** Lower-cased module and package names at the top of the directory. */
  topLevel: Set<string>;
  /** Entries at the top that run or inject paths when an interpreter with `site` starts. */
  startup: string[];
  /** Metadata that cannot be trusted as a ledger: unreadable or duplicated entries. */
  problems: string[];
};

const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

/**
 * Read a `site-packages` directory: distributions with their `RECORD` hash, extension
 * entry points, top-level names and startup files.
 *
 * A missing directory is an empty snapshot (a generation that does not exist yet).
 */
export async function readSite(site: string): Promise<SiteSnapshot> {
  const snapshot: SiteSnapshot = {
    distributions: new Map(),
    extensions: new Map(),
    topLevel: new Set(),
    startup: [],
    problems: [],
  };
  let entries: string[];
  try {
    entries = (await readdir(site)).toSorted();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return snapshot;
    throw error;
  }
  const infos = entries.filter((entry) => entry.endsWith('.dist-info'));
  const metadata = await Promise.all(infos.map((info) => readDistributionFiles(site, info)));
  for (const entry of entries) {
    if (isStartupEntry(entry)) snapshot.startup.push(entry);
    if (!entry.endsWith('.dist-info') && !entry.endsWith('.data') && entry !== '__pycache__' && entry !== 'bin')
      snapshot.topLevel.add(topLevelName(entry));
  }
  infos.forEach((info, index) => addDistribution(snapshot, info, metadata[index]));
  return snapshot;
}

type DistributionFiles = { metadata?: Buffer; record?: Buffer; entryPoints?: Buffer };

async function readDistributionFiles(site: string, info: string): Promise<DistributionFiles> {
  const read = (name: string): Promise<Buffer | undefined> =>
    readFile(path.join(site, info, name)).catch((): undefined => undefined);
  const [metadata, record, entryPoints] = await Promise.all(['METADATA', 'RECORD', 'entry_points.txt'].map(read));
  return { metadata, record, entryPoints };
}

function addDistribution(snapshot: SiteSnapshot, info: string, files: DistributionFiles): void {
  const identity = files.metadata && readIdentity(files.metadata.toString('utf8'));
  if (!identity) {
    snapshot.problems.push(`${info} has no readable METADATA`);
    return;
  }
  if (snapshot.distributions.has(identity.name)) {
    snapshot.problems.push(`distribution ${identity.name} is recorded twice`);
    return;
  }
  if (!files.record) snapshot.problems.push(`${info} has no RECORD`);
  snapshot.distributions.set(identity.name, {
    name: identity.name,
    version: identity.version,
    recordSha256: files.record ? sha256(files.record) : '',
    info,
    files: files.record ? parseRecordPaths(files.record.toString('utf8')) : [],
  });
  if (!files.entryPoints) return;
  for (const [name, reference] of parseExtensionEntries(files.entryPoints.toString('utf8'))) {
    if (snapshot.extensions.has(name)) snapshot.problems.push(`extension ${name} is provided twice`);
    else snapshot.extensions.set(name, { reference, distribution: identity.name });
  }
}

/** The distributions of a snapshot that are not the installer. */
export function contentDistributions(snapshot: SiteSnapshot): InstalledDistribution[] {
  return [...snapshot.distributions.values()].filter((distribution) => distribution.name !== INSTALLER);
}
