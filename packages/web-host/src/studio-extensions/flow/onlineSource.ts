import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { canonicalName } from '../inspect/metadata.js';
import type { SiteSnapshot } from '../inspect/site.js';
import { compareVersions, parseVersion } from '../inspect/version.js';
import { ExtensionFailure, type ExtensionOrigin, type OnlineExtensionSource } from '../types.js';

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
  if (!url.hostname) return undefined;
  if (url.protocol === 'ssh:' && url.username && !/^[a-z0-9_][a-z0-9_.-]*$/i.test(url.username)) return undefined;
  return url;
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
  if (source.kind !== 'git' || typeof source.url !== 'string') return undefined;
  const url = address(source.url.replace(/^git\+/, ''), ['https:', 'ssh:', 'git:', 'file:']);
  if (!url || url.pathname === '/' || url.search) return undefined;
  if (url.hash && !/^#subdirectory=[^&]+$/.test(url.hash)) return undefined;
  return { kind: 'git', url: 'git+' + url.href, indexUrl: index.href };
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
  const revision = at < 0 ? undefined : requested.pathname.slice(at + 1);
  if (at >= 0) requested.pathname = requested.pathname.slice(0, at);
  const subdirectory = new URLSearchParams(requested.hash.slice(1)).get('subdirectory') ?? undefined;
  requested.hash = '';
  const matches = [];
  for (const name of new Set([...after.extensions.values()].map((entry) => entry.distribution))) {
    const installed = after.distributions.get(name);
    if (!installed || before.distributions.get(name)?.recordSha256 === installed.recordSha256) continue;
    // oxlint-disable-next-line no-await-in-loop -- only the metadata of changed extension distributions
    const recorded = await readFile(path.join(site, installed.info, 'direct_url.json'), 'utf8').catch(() => '');
    if (!recorded) continue;
    let direct: { url?: unknown; subdirectory?: unknown; vcs_info?: { vcs?: unknown; commit_id?: unknown } } | null;
    try {
      direct = JSON.parse(recorded);
    } catch {
      continue;
    }
    const url = typeof direct?.url === 'string' ? URL.parse(direct.url) : null;
    // pip removes credentials (including the optional SSH username) from its saved URL.
    const comparable = new URL(requested);
    comparable.username = '';
    if (url) url.username = '';
    const commit = direct?.vcs_info?.commit_id;
    if (
      url?.href === comparable.href &&
      direct?.subdirectory === subdirectory &&
      direct?.vcs_info?.vcs === 'git' &&
      typeof commit === 'string' &&
      COMMIT.test(commit) &&
      (!revision || !COMMIT.test(revision) || revision === commit)
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
