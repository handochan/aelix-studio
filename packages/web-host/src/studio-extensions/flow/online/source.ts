import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRequirement } from '../../inspect/requirement.js';
import { recordInstalledMetadata, type InstalledDistribution, type SiteSnapshot } from '../../inspect/site.js';
import {
  acceptsInstalledVersion,
  compareInstalledVersions,
  compareVersions,
  parseVersion,
} from '../../inspect/version.js';
import { ExtensionFailure, type ExtensionOrigin, type OnlineExtensionSource } from '../../types.js';

const PYPI = 'https://pypi.org/simple/';
const PACKAGE = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/i;
const COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

/** An explicit URL only. Reject credentials that would enter argv, output, or the generation record. */
function address(value: unknown, schemes: string[]): URL | undefined {
  // oxlint-disable-next-line no-control-regex -- reject characters URL parsing can silently discard.
  if (typeof value !== 'string' || value.length > 4096 || /[\s\\\x00-\x1f\x7f]/.test(value)) return undefined;
  if (!/^[a-z]+:\/\//i.test(value)) return undefined;
  const url = URL.parse(value);
  if (!url || !schemes.includes(url.protocol) || url.password || (url.username && url.protocol !== 'ssh:'))
    return undefined;
  if (url.protocol === 'file:') return url.hostname ? undefined : url;
  if (!url.hostname || url.hostname.startsWith('-')) return undefined;
  if (url.protocol === 'ssh:' && url.username && !/^[a-z0-9_][a-z0-9_.-]*$/i.test(url.username)) return undefined;
  return url;
}

/** pip unquotes the revision before passing it to Git as a positional argument. */
function safeGitRevision(pathname: string): boolean {
  const at = pathname.lastIndexOf('@');
  if (at < 0) return true;
  let revision: string;
  try {
    revision = decodeURIComponent(pathname.slice(at + 1));
  } catch {
    return false;
  }
  return (
    /^[a-z0-9_][a-z0-9._/-]*$/i.test(revision) &&
    !revision.includes('..') &&
    !revision.endsWith('.') &&
    revision.split('/').every((part) => part && !part.startsWith('.') && !part.endsWith('.lock'))
  );
}

/** pip decodes file URLs before parsing the revision again. Keep escapes from changing delimiters. */
function safeFileGitPath(pathname: string): boolean {
  try {
    const decoded = decodeURIComponent(pathname);
    // oxlint-disable-next-line no-control-regex -- urllib may discard controls while re-parsing.
    return !/[?#%\\\x00-\x1f\x7f]/.test(decoded) && decoded.split('@').length === pathname.split('@').length;
  } catch {
    return false;
  }
}

/** One name of a repository subdirectory: no `.`/`..`, no hidden or option-like name, nothing native reads as extras. */
const SUBDIRECTORY_PART = /^[a-z0-9_][a-z0-9._-]*$/i;

/**
 * A repository subdirectory as requested: a relative path of plain names joined by `/`.
 * Absolute paths, drive letters, backslashes, `.`, `..`, empty names and `.git` cannot be
 * spelled. This is the first check only: the path is checked again against the checkout.
 */
export function parseSubdirectory(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024) return undefined;
  const parts = value.split('/');
  if (parts.length > 32) return undefined;
  return parts.every((part) => part.length <= 255 && SUBDIRECTORY_PART.test(part) && !part.endsWith('.'))
    ? value
    : undefined;
}

export type IndexSource = Extract<OnlineExtensionSource, { kind: 'index' }>;
type GitSource = Extract<OnlineExtensionSource, { kind: 'git' }>;

/** A name and version clauses only. pip remains the authority on PEP 440 resolution. */
export function parseIndexRequirement(text: unknown) {
  if (typeof text !== 'string' || text.length > 512 || /[^a-z0-9._ +*!<>=~,()\t-]/i.test(text)) return undefined;
  const parsed = parseRequirement(text);
  if (!parsed || parsed.name.length > 200 || (text.includes('(') && !parsed.specifier)) return undefined;
  const clauses = parsed.specifier.split(',').map((clause) => clause.trim());
  const exact = clauses.find(
    (clause) => clause.startsWith('===') || (clause.startsWith('==') && !clause.endsWith('.*'))
  );
  return { ...parsed, text, exact };
}

export function indexRequirement(source: IndexSource) {
  const text =
    'requirement' in source
      ? source.requirement
      : source.version === undefined
        ? source.name
        : `${source.name}==${source.version}`;
  const requirement = parseIndexRequirement(text);
  if (!requirement) throw new ExtensionFailure('INVALID_INPUT');
  return requirement;
}

/** Parse only the documented package-name and git install forms. A request cannot supply extra indexes or flags. */
export function parseOnlineSource(source: Record<string, unknown>): OnlineExtensionSource | undefined {
  const index = source.indexUrl === undefined ? new URL(PYPI) : address(source.indexUrl, ['http:', 'https:']);
  if (!index || index.hash || index.search) return undefined;
  if (source.kind === 'index') {
    const { name, version, requirement } = source;
    if (requirement !== undefined) {
      if (
        name !== undefined ||
        version !== undefined ||
        typeof requirement !== 'string' ||
        !parseIndexRequirement(requirement)
      )
        return undefined;
      return { kind: 'index', requirement, indexUrl: index.href };
    }
    if (typeof name !== 'string' || name.length > 200 || !PACKAGE.test(name)) return undefined;
    if (
      version !== undefined &&
      (typeof version !== 'string' ||
        version.length > 128 ||
        !parseVersion(version) ||
        !parseIndexRequirement(`${name}==${version}`))
    )
      return undefined;
    return {
      kind: 'index',
      name,
      version: typeof version === 'string' ? version : undefined,
      indexUrl: index.href,
    };
  }
  if (source.kind !== 'git' || typeof source.url !== 'string' || source.url.includes('#')) return undefined;
  const target = source.url.replace(/^git\+/, '');
  const url = address(target, ['https:', 'ssh:', 'git:', 'file:']);
  if (!url?.pathname || url.pathname === '/' || target.includes('?')) return undefined;
  // Check the spelling before URL normalization can remove dot segments from a ref.
  const pathname = target.slice(target.indexOf('/', target.indexOf('://') + 3));
  if (!safeGitRevision(pathname) || (url.protocol === 'file:' && !safeFileGitPath(pathname))) return undefined;
  // A `#subdirectory=` fragment would let pip pick the path in its own checkout, where even a
  // plain name can be a link. A subdirectory is a field of its own, checked against Studio's checkout.
  if (source.subdirectory === undefined) return { kind: 'git', url: 'git+' + url.href, indexUrl: index.href };
  const subdirectory = parseSubdirectory(source.subdirectory);
  return subdirectory === undefined
    ? undefined
    : { kind: 'git', url: 'git+' + url.href, subdirectory, indexUrl: index.href };
}

/** The repository address and the revision of a parsed git source, split the way pip splits them. */
export function gitLocation(source: GitSource): {
  repository: string;
  revision: string | undefined;
} {
  const requested = new URL(source.url.slice(4));
  const at = requested.pathname.lastIndexOf('@');
  const revision = at < 0 ? undefined : decodeURIComponent(requested.pathname.slice(at + 1));
  if (at >= 0) requested.pathname = requested.pathname.slice(0, at);
  return { repository: requested.href, revision };
}

/** A full object name for the repository's hash format records an immutable Git ref. */
export function pinnedGit(source: GitSource, installedCommit: string): boolean {
  const { revision } = gitLocation(source);
  return revision !== undefined && revision.length === installedCommit.length && COMMIT.test(revision.toLowerCase());
}

/** Revalidate a persisted endpoint before using it again. */
export function upgradeSource(
  origin: ExtensionOrigin | undefined,
  distribution: string
): OnlineExtensionSource | undefined {
  if (origin?.kind === 'index') {
    const source = parseOnlineSource({ ...origin, requirement: origin.requirement ?? distribution });
    if (source?.kind === 'index' && indexRequirement(source).name === distribution) return source;
  }
  if (origin?.kind === 'git') return parseOnlineSource(origin);
  return undefined;
}

const INDEX_ORIGIN_FILE = 'aelix_studio_index.json';

async function installedMetadata(site: string, info: string, filename: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path.join(site, info, filename), 'utf8')) as unknown;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : null;
  }
}

type DirectUrl = {
  url?: unknown;
  vcs_info?: { vcs?: unknown; commit_id?: unknown; requested_revision?: unknown };
  subdirectory?: unknown;
  dir_info?: unknown;
};
async function directUrl(site: string, info: string): Promise<DirectUrl | undefined> {
  const value = await installedMetadata(site, info, 'direct_url.json');
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as DirectUrl) : undefined;
}

function comparableGitUrl(value: unknown): string | undefined {
  const url = address(value, ['https:', 'ssh:', 'git:', 'file:']);
  if (!url || url.hash || url.search) return undefined;
  // pip strips user info from the recorded URL. The repository and ref still identify the source.
  url.username = '';
  return url.href;
}

function matchesGitSource(source: GitSource, direct: DirectUrl | undefined): boolean {
  const { repository, revision } = gitLocation(source);
  const actual = comparableGitUrl(direct?.url);
  return (
    actual !== undefined &&
    actual === comparableGitUrl(repository) &&
    direct?.subdirectory === source.subdirectory &&
    direct?.vcs_info?.vcs === 'git' &&
    direct.vcs_info.requested_revision === revision
  );
}

export async function verifyUpgradeSource(
  site: string,
  source: OnlineExtensionSource,
  origin: ExtensionOrigin,
  installed: InstalledDistribution
): Promise<void> {
  const mismatch = (): ExtensionFailure =>
    new ExtensionFailure('UPGRADE_SOURCE_MISMATCH', [
      'the saved source does not agree with the installed distribution; reinstall to refresh it',
    ]);
  if (source.kind === 'git' && origin.kind === 'git') {
    const direct = await directUrl(site, installed.info);
    if (!matchesGitSource(source, direct) || direct?.vcs_info?.commit_id !== origin.commit) throw mismatch();
    return;
  }
  if (source.kind !== 'index' || origin.kind !== 'index') throw mismatch();
  const { name, specifier } = indexRequirement(source);
  if (name !== installed.name || !acceptsInstalledVersion(specifier, installed.version)) throw mismatch();
  const saved = await installedMetadata(site, installed.info, INDEX_ORIGIN_FILE);
  if (saved !== undefined) {
    const local = saved as { indexUrl?: unknown; requirement?: unknown } | null;
    if (local?.indexUrl !== onlineIndex(source) || local?.requirement !== origin.requirement) throw mismatch();
  }
}

export async function recordVerifiedSource(site: string, installed: InstalledDistribution, origin: ExtensionOrigin) {
  if (origin.kind === 'index') {
    await recordInstalledMetadata(site, installed, INDEX_ORIGIN_FILE, {
      indexUrl: origin.indexUrl,
      requirement: origin.requirement,
    });
  } else if (origin.kind === 'git' && origin.subdirectory !== undefined) {
    const { repository, revision } = gitLocation(origin);
    await recordInstalledMetadata(site, installed, 'direct_url.json', {
      url: comparableGitUrl(repository),
      vcs_info: { vcs: 'git', commit_id: origin.commit, requested_revision: revision },
      subdirectory: origin.subdirectory,
    });
  }
}

/** Canonical names of the extension distributions a change added or rewrote. */
function changedExtensionDistributions(before: SiteSnapshot, after: SiteSnapshot): string[] {
  return [...new Set([...after.extensions.values()].map((entry) => entry.distribution))].filter((name) => {
    const installed = after.distributions.get(name);
    return installed !== undefined && before.distributions.get(name)?.recordSha256 !== installed.recordSha256;
  });
}

/**
 * Resolve a subdirectory install against its PEP 610 provenance. native installed the checked
 * directory as a local path, so exactly one changed extension distribution must record that
 * very directory, as a plain (not editable) directory install. The origin records the
 * repository, the commit Studio checked out and the subdirectory.
 */
export async function installedCheckoutOrigin(
  source: Extract<OnlineExtensionSource, { kind: 'git' }>,
  site: string,
  before: SiteSnapshot,
  after: SiteSnapshot,
  checkout: { directory: string; commit: string }
): Promise<{ distribution: string; origin: ExtensionOrigin }> {
  const matches: string[] = [];
  for (const name of changedExtensionDistributions(before, after)) {
    const installed = after.distributions.get(name);
    if (!installed) continue;
    // oxlint-disable-next-line no-await-in-loop -- only the metadata of changed extension distributions
    const direct = await directUrl(site, installed.info);
    const info = direct?.dir_info as { editable?: unknown } | undefined;
    const url = typeof direct?.url === 'string' ? URL.parse(direct.url) : null;
    if (url?.protocol !== 'file:' || typeof info !== 'object' || info === null || info.editable === true) continue;
    let recorded: string;
    try {
      recorded = fileURLToPath(url);
    } catch {
      continue;
    }
    if (path.resolve(recorded) === checkout.directory) matches.push(name);
  }
  if (matches.length !== 1 || source.subdirectory === undefined)
    throw new ExtensionFailure('REQUEST_MISMATCH', [
      'the checked subdirectory did not identify exactly one changed extension distribution',
    ]);
  return {
    distribution: matches[0],
    origin: {
      kind: 'git',
      url: source.url,
      commit: checkout.commit,
      indexUrl: source.indexUrl ?? PYPI,
      subdirectory: source.subdirectory,
    },
  };
}

/** Resolve a git install against actual PEP 610 provenance, never against an unrelated dependency. */
export async function installedGitOrigin(
  source: Extract<OnlineExtensionSource, { kind: 'git' }>,
  site: string,
  before: SiteSnapshot,
  after: SiteSnapshot
): Promise<{ distribution: string; origin: ExtensionOrigin }> {
  const commitPin = gitLocation(source).revision?.toLowerCase() ?? '';
  const matches = [];
  for (const name of changedExtensionDistributions(before, after)) {
    const installed = after.distributions.get(name);
    if (!installed) continue;
    // oxlint-disable-next-line no-await-in-loop -- only the metadata of changed extension distributions
    const direct = await directUrl(site, installed.info);
    if (!direct) continue;
    const commit = direct.vcs_info?.commit_id;
    if (
      matchesGitSource(source, direct) &&
      typeof commit === 'string' &&
      COMMIT.test(commit) &&
      (!pinnedGit(source, commit) || commitPin === commit)
    )
      matches.push({ distribution: name, commit });
  }
  if (matches.length !== 1)
    throw new ExtensionFailure('REQUEST_MISMATCH', [
      'the git source did not identify exactly one changed extension distribution',
    ]);
  const { distribution, commit } = matches[0];
  return { distribution, origin: { kind: 'git', url: source.url, commit, indexUrl: source.indexUrl ?? PYPI } };
}

/** pip compares normalized PEP 440 versions and a public pin also accepts local builds. */
export function matchesVersion(pin: string, installed: string): boolean {
  const wanted = parseVersion(pin);
  const actual = parseVersion(installed);
  if (!wanted || !actual || compareVersions(wanted, actual) !== 0) return false;
  return wanted.local === null || compareInstalledVersions(wanted, actual) === 0;
}

export function onlineIndex(source: OnlineExtensionSource): string {
  return source.indexUrl ?? PYPI;
}
