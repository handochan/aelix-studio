import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, open, readdir, readFile, realpath, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseExtensionEntries, parseRecordPaths, readIdentity } from './metadata.js';
import { isStartupEntry, topLevelName } from './wheel.js';
import { ExtensionFailure } from '../types.js';

/** The installer every generation carries. It is Studio's, never an extension's. */
export const INSTALLER = 'pip';

export type InstalledDistribution = {
  /** Canonical distribution name. */
  name: string;
  /** `Name` as its metadata writes it; native compares this spelling. */
  declaredName: string;
  version: string;
  /** `Requires-Dist` values of the installed metadata, as written. */
  requires: string[];
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
    declaredName: identity.declaredName,
    version: identity.version,
    requires: identity.requires,
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

type RecordRow = { file: string; hash: string; line: string };

function rows(text: string): RecordRow[] {
  return text
    .split(/\r\n|\r|\n/)
    .filter(Boolean)
    .map((line) => {
      const file = parseRecordPaths(line)[0] ?? '';
      const suffix = line[0] === '"' ? /^"(?:[^"]|"")*",([^,]*),[^,]*$/.exec(line) : /^[^,]+,([^,]*),[^,]*$/.exec(line);
      // Older fixture or third-party metadata may omit the hash and size columns.
      return { file, hash: suffix?.[1] ?? '', line };
    });
}

function recordPath(site: string, info: string): string {
  return path.join(site, info, 'RECORD');
}

const recordDigest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('base64url');

function rowFor(file: string, bytes: Buffer): string {
  return `"${file.replaceAll('"', '""')}",sha256=${recordDigest(bytes)},${bytes.length}`;
}

export async function rewriteRecord(
  site: string,
  info: string,
  updates: ReadonlyMap<string, Buffer>,
  dropBytecode = false,
  addMissing = false,
  omit?: string
): Promise<void> {
  const file = recordPath(site, info);
  const found = new Set<string>();
  if (!(await lstat(file)).isFile()) throw new ExtensionFailure('GENERATION_MODIFIED');
  const original = await readFile(file, 'utf8');
  const next = rows(original)
    .filter(({ file }) => file !== omit && (!dropBytecode || !file.endsWith('.pyc')))
    .map(({ file, line }) => {
      found.add(file);
      const bytes = updates.get(path.resolve(site, file));
      return bytes ? rowFor(file, bytes) : line;
    });
  for (const [absolute, bytes] of updates) {
    const relative = path.relative(site, absolute).split(path.sep).join('/');
    if (addMissing && !found.has(relative)) next.push(rowFor(relative, bytes));
  }
  const text = next.join('\n') + '\n';
  if (text !== original) await writeFile(file, text);
}

function recordKey(site: string, file: string, platform: NodeJS.Platform): string {
  const absolute = path.resolve(site, file);
  return platform === 'linux' ? absolute : absolute.normalize('NFD').toLowerCase();
}

/** Pip uninstalls every path it sees in RECORD, including paths claimed by another distribution. */
export function refuseSharedFiles(site: string, snapshot: SiteSnapshot, name: string, platform: NodeJS.Platform): void {
  const target = snapshot.distributions.get(name);
  if (!target) throw new ExtensionFailure('GENERATION_MODIFIED');
  const owned = new Set(target.files.map((file) => recordKey(site, file, platform)));
  for (const dist of snapshot.distributions.values()) {
    if (dist.name !== name && dist.files.some((file) => owned.has(recordKey(site, file, platform))))
      throw new ExtensionFailure('SHARED_DISTRIBUTION_FILES', ['the Git distribution shares installed files']);
  }
}

async function checkFile(site: string, root: string, row: RecordRow): Promise<boolean> {
  if (!row.file || path.isAbsolute(row.file)) return false;
  const file = path.resolve(site, row.file);
  const relative = path.relative(root, file);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) return false;
  try {
    const [stat, real] = await Promise.all([lstat(file), realpath(file)]);
    if (!stat.isFile() || real !== file) return false;
    if (!row.hash) return true;
    const [algorithm, digest] = row.hash.split('=');
    const hash = createHash(algorithm);
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    return hash.digest('base64url') === digest;
  } catch {
    return false;
  }
}

async function verifyDistribution(
  site: string,
  root: string,
  distribution: InstalledDistribution,
  signal?: AbortSignal
) {
  const file = recordPath(site, distribution.info);
  const data = await readFile(file).catch((): undefined => undefined);
  if (!data?.length || sha256(data) !== distribution.recordSha256)
    throw new ExtensionFailure('GENERATION_MODIFIED', [`${distribution.name} has a missing or changed RECORD`]);
  const records = rows(data.toString('utf8'));
  for (let offset = 0; offset < records.length; offset += 32) {
    if (signal?.aborted) throw new ExtensionFailure('CANCELLED');
    // oxlint-disable-next-line no-await-in-loop -- bounded file descriptor and I/O usage
    const results = await Promise.all(records.slice(offset, offset + 32).map((row) => checkFile(site, root, row)));
    if (results.includes(false))
      throw new ExtensionFailure('GENERATION_MODIFIED', [`${distribution.name} has a missing or changed RECORD file`]);
  }
}

export async function verifyRecordFiles(
  site: string,
  root: string,
  snapshot: SiteSnapshot,
  signal?: AbortSignal
): Promise<void> {
  for (const distribution of snapshot.distributions.values()) {
    // oxlint-disable-next-line no-await-in-loop -- the check limits parallelism within each RECORD
    await verifyDistribution(site, root, distribution, signal);
  }
}

/** Record Studio-authored metadata in the installed distribution's ledger so it travels with the files. */
export async function recordInstalledMetadata(
  site: string,
  distribution: InstalledDistribution,
  filename: string,
  value: object
): Promise<void> {
  const file = path.join(site, distribution.info, filename);
  const directory = path.dirname(file);
  if ((await realpath(directory)) !== directory)
    throw new ExtensionFailure('GENERATION_MODIFIED', ['the metadata directory is not where it should be']);
  const existing = await lstat(file).catch((error: NodeJS.ErrnoException): undefined => {
    if (error.code !== 'ENOENT') throw error;
    return undefined;
  });
  if (existing && !existing.isFile()) throw new ExtensionFailure('GENERATION_MODIFIED');
  const bytes = Buffer.from(JSON.stringify(value) + '\n');
  const handle = await open(file, existing ? 'r+' : 'wx');
  try {
    await handle.writeFile(bytes);
    await handle.truncate(bytes.length);
  } finally {
    await handle.close();
  }
  await rewriteRecord(site, distribution.info, new Map([[file, bytes]]), false, true);
}

/** The temporary direct URL used to apply a pinned index archive is no longer its source. */
export async function removeInstalledDirectUrl(site: string, distribution: InstalledDistribution): Promise<void> {
  const file = path.join(site, distribution.info, 'direct_url.json');
  const directory = path.dirname(file);
  if ((await realpath(directory)) !== directory) throw new ExtensionFailure('GENERATION_MODIFIED');
  await unlink(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
  await rewriteRecord(site, distribution.info, new Map(), false, false, `${distribution.info}/direct_url.json`);
}
