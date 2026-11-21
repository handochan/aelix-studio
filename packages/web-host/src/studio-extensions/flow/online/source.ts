import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalName } from '../../inspect/metadata.js';
import type { SiteSnapshot } from '../../inspect/site.js';
import { compareVersions, parseVersion } from '../../inspect/version.js';
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

/** Parse only the documented package-name and git install forms. A request cannot supply extra indexes or flags. */
export function parseOnlineSource(source: Record<string, unknown>): OnlineExtensionSource | undefined {
  const index = source.indexUrl === undefined ? new URL(PYPI) : address(source.indexUrl, ['http:', 'https:']);
  if (!index || index.hash || index.search) return undefined;
  if (source.kind === 'index') {
    const { name, version } = source;
    if (typeof name !== 'string' || name.length > 200 || !PACKAGE.test(name)) return undefined;
    if (version !== undefined && (typeof version !== 'string' || version.length > 128 || !parseVersion(version)))
      return undefined;
    return {
      kind: 'index',
      name: canonicalName(name),
      version: typeof version === 'string' ? version.trim() : undefined,
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
export function gitLocation(source: Extract<OnlineExtensionSource, { kind: 'git' }>): {
  repository: string;
  revision: string | undefined;
} {
  const requested = new URL(source.url.slice(4));
  const at = requested.pathname.lastIndexOf('@');
  const revision = at < 0 ? undefined : decodeURIComponent(requested.pathname.slice(at + 1));
  if (at >= 0) requested.pathname = requested.pathname.slice(0, at);
  return { repository: requested.href, revision };
}

/** PEP 610 provenance of one distribution in a site, or undefined when it has none that parses. */
async function directUrl(site: string, info: string): Promise<Record<string, unknown> | undefined> {
  const recorded = await readFile(path.join(site, info, 'direct_url.json'), 'utf8').catch(() => '');
  try {
    const value: unknown = JSON.parse(recorded);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
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
  const requested = new URL(source.url.slice(4));
  const at = requested.pathname.lastIndexOf('@');
  const commitPin = at < 0 ? '' : decodeURIComponent(requested.pathname.slice(at + 1)).toLowerCase();
  if (at >= 0) requested.pathname = requested.pathname.slice(0, at);
  requested.username = '';
  const matches = [];
  for (const name of changedExtensionDistributions(before, after)) {
    const installed = after.distributions.get(name);
    if (!installed) continue;
    // oxlint-disable-next-line no-await-in-loop -- only the metadata of changed extension distributions
    const direct = await directUrl(site, installed.info);
    if (!direct) continue;
    const url = typeof direct.url === 'string' ? URL.parse(direct.url) : null;
    // pip removes credentials (including the optional SSH username) from its saved URL.
    if (url) url.username = '';
    const vcs = direct.vcs_info as { vcs?: unknown; commit_id?: unknown } | undefined;
    const commit = vcs?.commit_id;
    if (
      url?.href === requested.href &&
      direct.subdirectory === undefined &&
      vcs?.vcs === 'git' &&
      typeof commit === 'string' &&
      COMMIT.test(commit) &&
      (!COMMIT.test(commitPin) || commitPin === commit)
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
  return wanted.local === null || wanted.local.replace(/[-_]/g, '.') === actual.local?.replace(/[-_]/g, '.');
}

export function onlineIndex(source: OnlineExtensionSource): string {
  return source.indexUrl ?? PYPI;
}
