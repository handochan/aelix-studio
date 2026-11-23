import path from 'node:path';
import { canonicalName, parseExtensionEntries, readIdentity } from '../inspect/metadata.js';
import type { TerminalCliExtension, TerminalCliIssue } from '../types.js';
import {
  FS_CONCURRENCY,
  isWithin,
  listDirectory,
  mapLimited,
  readBounded,
  realpathOf,
  statEntry,
  statOf,
  type Scan,
} from './files.js';

/** Distributions that install the `aelix` command: an environment with one of them is a CLI. */
const CLI_DISTRIBUTIONS = new Set(['aelix', 'aelix-coding-agent']);

/** The most of a `METADATA` (its headers come first) and of an `entry_points.txt` this reads. */
export const METADATA_LIMIT = 256 * 1024;
/** The most metadata directories of one environment this looks at. */
export const DISTRIBUTION_LIMIT = 2000;

export type CliVenv = {
  /** The native version installed there. */
  nativeVersion: string;
  extensions: TerminalCliExtension[];
  /** Each code once, in a stable order. */
  issues: TerminalCliIssue[];
  /** More distributions (or site directories) than this reads: the rest were not looked at. */
  truncated: boolean;
};

const ISSUE_ORDER: TerminalCliIssue[] = [
  'ENTRY_POINTS_TOO_LARGE',
  'METADATA_UNREADABLE',
  'DUPLICATE_DISTRIBUTION',
  'DUPLICATE_ENTRY',
];

/** One installed distribution's metadata directory, as `importlib.metadata` finds it. */
type Distribution = { directory: string; normalized: string; egg: boolean };

/** A metadata directory by its name: what `Lookup` reads from it, before any file is opened. */
type Candidate = Distribution & {
  /** The suffix is written exactly `.dist-info` or `.egg-info` (CPython's `_name_from_stem`). */
  exact: boolean;
};

/**
 * The metadata directories of a site directory by name, sorted, as CPython 3.12's `Lookup`
 * finds them: `.dist-info` and `.egg-info` in any case, named by what comes before the first
 * `-`, normalized.
 */
function candidatesOf(names: string[]): Candidate[] {
  const candidates: Candidate[] = [];
  for (const name of names) {
    const low = name.toLowerCase();
    const egg = low.endsWith('.egg-info');
    if (!egg && !low.endsWith('.dist-info')) continue;
    const normalized = canonicalName(low.slice(0, low.lastIndexOf('.')).split('-', 1)[0]);
    const exact = name.endsWith(egg ? '.egg-info' : '.dist-info');
    candidates.push({ directory: name, normalized, egg, exact });
  }
  return candidates;
}

/**
 * The distributions of a site directory as `importlib.metadata.distributions()` keeps them
 * (`_unique`): the first of each normalized name wins, before entry points are looked at. The
 * name is the directory's, except where its suffix is not written exactly `.dist-info` or
 * `.egg-info`: there CPython takes the `Name` of its metadata, and so does this. CPython takes
 * the directories in the file system's order, which Studio cannot know: it takes them sorted.
 */
async function distributionsOf(
  scan: Scan,
  site: string,
  root: string,
  candidates: Candidate[]
): Promise<{ distributions: Distribution[]; duplicates: boolean }> {
  const seen = new Set<string>();
  const distributions: Distribution[] = [];
  let duplicates = false;
  for (const candidate of candidates) {
    const normalized = candidate.exact
      ? candidate.normalized
      : // eslint-disable-next-line no-await-in-loop -- only the few with an unusual suffix, in order
        ((await identityOf(scan, site, candidate, root))?.name ?? candidate.normalized);
    if (seen.has(normalized)) {
      duplicates = true;
      continue;
    }
    seen.add(normalized);
    distributions.push({ directory: candidate.directory, normalized, egg: candidate.egg });
  }
  return { distributions, duplicates };
}

/**
 * The site directories of the environment at `root` that are really inside it (normally one).
 * `lib` itself is resolved and checked to be inside `root` before it is listed.
 */
async function sitePackages(scan: Scan, root: string): Promise<{ sites: string[]; truncated: boolean } | 'unreadable'> {
  const candidates: string[] = [];
  let truncated = false;
  // The layout follows the platform; paths are joined by this host's rules, as they are read here.
  if (scan.platform === 'win32') candidates.push(path.join(root, 'Lib', 'site-packages'));
  else {
    const libPath = path.join(root, 'lib');
    const entry = await statEntry(scan, libPath);
    if (entry === 'unreadable') return 'unreadable';
    const lib = entry === 'absent' ? undefined : await realpathOf(scan, libPath);
    if (lib && isWithin(lib, root, scan.platform)) {
      const listing = await listDirectory(scan, lib, 16);
      if (listing === 'unreadable') return 'unreadable';
      if (listing !== 'absent') {
        truncated = listing.truncated;
        for (const name of listing.names)
          if (/^python\d+\.\d+t?$/.test(name)) candidates.push(path.join(lib, name, 'site-packages'));
      }
    }
  }
  const sites: string[] = [];
  for (const candidate of candidates) {
    // eslint-disable-next-line no-await-in-loop -- a handful at most, in order
    const real = await realpathOf(scan, candidate);
    if (!real || !isWithin(real, root, scan.platform)) continue;
    // eslint-disable-next-line no-await-in-loop -- as above
    if ((await statOf(scan, real))?.isDirectory()) sites.push(real);
  }
  return { sites, truncated };
}

type SiteRead = { names: string[]; truncated: boolean } | 'unreadable';

const readSiteNames = async (scan: Scan, site: string): Promise<SiteRead> => {
  // Other entries (packages, modules) share the directory: read a margin past the limit.
  const listing = await listDirectory(scan, site, DISTRIBUTION_LIMIT * 4);
  if (listing === 'unreadable') return 'unreadable';
  if (listing === 'absent') return { names: [], truncated: false };
  return listing;
};

/** Name and version from a distribution's `METADATA` (or `PKG-INFO`), read within the limit and the root. */
async function identityOf(
  scan: Scan,
  site: string,
  distribution: Distribution,
  root: string
): Promise<{ declaredName: string; name: string; version: string } | undefined> {
  const file = path.join(site, distribution.directory, distribution.egg ? 'PKG-INFO' : 'METADATA');
  const metadata = await readBounded(scan, file, METADATA_LIMIT, { head: true, within: root });
  return typeof metadata === 'object' ? readIdentity(metadata.text) : undefined;
}

async function readSiteForCli(scan: Scan, site: string, root: string): Promise<CliVenv | 'no_cli' | 'unreadable'> {
  const listing = await readSiteNames(scan, site);
  if (listing === 'unreadable') return 'unreadable';
  const candidates = candidatesOf(listing.names);
  const truncated = listing.truncated || candidates.length > DISTRIBUTION_LIMIT;
  const { distributions, duplicates } = await distributionsOf(
    scan,
    site,
    root,
    candidates.slice(0, DISTRIBUTION_LIMIT)
  );
  const cliDistribution = distributions.find((distribution) => CLI_DISTRIBUTIONS.has(distribution.normalized));
  if (!cliDistribution) return 'no_cli';
  const cli = await identityOf(scan, site, cliDistribution, root);
  if (!cli || !CLI_DISTRIBUTIONS.has(cli.name)) return 'unreadable';

  const issues = new Set<TerminalCliIssue>(duplicates ? ['DUPLICATE_DISTRIBUTION'] : []);
  const read = await mapLimited(distributions, FS_CONCURRENCY, async (distribution) => ({
    distribution,
    entryPoints: await readBounded(scan, path.join(site, distribution.directory, 'entry_points.txt'), METADATA_LIMIT, {
      within: root,
    }),
  }));
  const entries = new Set<string>();
  const extensions: TerminalCliExtension[] = [];
  for (const { distribution, entryPoints } of read) {
    if (entryPoints === 'too_large') issues.add('ENTRY_POINTS_TOO_LARGE');
    else if (entryPoints !== 'absent' && typeof entryPoints !== 'object') issues.add('METADATA_UNREADABLE');
    if (typeof entryPoints !== 'object') continue;
    const declared = parseExtensionEntries(entryPoints.text);
    if (declared.size === 0) continue;
    // eslint-disable-next-line no-await-in-loop -- only distributions with extensions, in a stable order
    const identity = await identityOf(scan, site, distribution, root);
    if (!identity) {
      issues.add('METADATA_UNREADABLE');
      continue;
    }
    for (const [name, reference] of declared) {
      if (entries.has(name)) issues.add('DUPLICATE_ENTRY');
      entries.add(name);
      extensions.push({ name, distribution: identity.declaredName, version: identity.version, reference });
    }
  }
  return {
    nativeVersion: cli.version,
    extensions: extensions.toSorted(
      (a, b) => a.name.localeCompare(b.name) || a.distribution.localeCompare(b.distribution)
    ),
    issues: ISSUE_ORDER.filter((code) => issues.has(code)),
    truncated,
  };
}

/**
 * Read the terminal CLI's virtual environment at `root` (a real path) from its files; nothing is
 * run or imported. A directory is one when it has a `pyvenv.cfg` and a site directory holding
 * the `aelix` distribution. Every file read is inside `root` by its real path. Its extensions
 * are the `aelix.extensions` entry points there, close to what that CLI's `extension list`
 * reads (`importlib.metadata`; see `distributionsOf` for where they may differ).
 *
 * `not_a_venv` without a `pyvenv.cfg`, `no_cli` when no site directory holds the CLI,
 * `unreadable` when the directories or the CLI's own metadata cannot be read.
 */
export async function readCliVenv(scan: Scan, root: string): Promise<CliVenv | 'not_a_venv' | 'no_cli' | 'unreadable'> {
  if (!(await statOf(scan, path.join(root, 'pyvenv.cfg')))?.isFile()) return 'not_a_venv';
  const found = await sitePackages(scan, root);
  if (found === 'unreadable') return 'unreadable';
  let unreadable = false;
  for (const site of found.sites) {
    // eslint-disable-next-line no-await-in-loop -- stops at the first site that holds the CLI
    const venv = await readSiteForCli(scan, site, root);
    if (typeof venv === 'object') return { ...venv, truncated: venv.truncated || found.truncated };
    if (venv === 'unreadable') unreadable = true;
  }
  return unreadable ? 'unreadable' : 'no_cli';
}

/**
 * Whether `root` holds the CLI, from directory names only (no file is read): how a tool
 * directory's other tools are passed over without reading their metadata. `truncated` when a
 * directory had more entries than this looks at, so the CLI may have been missed.
 */
export async function holdsCli(
  scan: Scan,
  root: string
): Promise<{ held: 'yes' | 'no' | 'unreadable'; truncated: boolean }> {
  const config = await statEntry(scan, path.join(root, 'pyvenv.cfg'));
  if (config === 'unreadable') return { held: 'unreadable', truncated: false };
  if (config === 'absent' || !config.isFile()) return { held: 'no', truncated: false };
  const found = await sitePackages(scan, root);
  if (found === 'unreadable') return { held: 'unreadable', truncated: false };
  let unreadable = false;
  let truncated = found.truncated;
  for (const site of found.sites) {
    // eslint-disable-next-line no-await-in-loop -- stops at the first site that holds the CLI
    const listing = await readSiteNames(scan, site);
    if (listing === 'unreadable') {
      unreadable = true;
      continue;
    }
    truncated ||= listing.truncated;
    if (candidatesOf(listing.names).some((entry) => CLI_DISTRIBUTIONS.has(entry.normalized)))
      return { held: 'yes', truncated };
  }
  return { held: unreadable ? 'unreadable' : 'no', truncated };
}
