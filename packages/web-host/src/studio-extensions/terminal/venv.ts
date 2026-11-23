import path from 'node:path';
import { canonicalName, parseExtensionEntries, readIdentity } from '../inspect/metadata.js';
import type { TerminalCliExtension, TerminalCliIssue } from '../types.js';
import { listDirectory, readBounded, statOf } from './files.js';

/** Distributions that install the `aelix` command: an environment with one of them is a CLI. */
const CLI_DISTRIBUTIONS = new Set(['aelix', 'aelix-coding-agent']);

/** The most of a `METADATA` (its headers come first) and of an `entry_points.txt` this reads. */
export const METADATA_LIMIT = 256 * 1024;
/** The most `.dist-info` directories of one environment this looks at. */
export const DISTRIBUTION_LIMIT = 2000;

export type CliVenv = {
  /** The native version installed there. */
  nativeVersion: string;
  extensions: TerminalCliExtension[];
  /** Each code once, in a stable order. */
  issues: TerminalCliIssue[];
  /** More than `DISTRIBUTION_LIMIT` distributions: the rest were not looked at. */
  truncated: boolean;
};

const ISSUE_ORDER: TerminalCliIssue[] = [
  'ENTRY_POINTS_TOO_LARGE',
  'METADATA_UNREADABLE',
  'DUPLICATE_DISTRIBUTION',
  'DUPLICATE_ENTRY',
];

/** The site-packages directories of the virtual environment at `root` (normally one). */
async function sitePackages(root: string, platform: NodeJS.Platform): Promise<string[]> {
  if (platform === 'win32') {
    const site = path.join(root, 'Lib', 'site-packages');
    return (await statOf(site))?.isDirectory() ? [site] : [];
  }
  const lib = await listDirectory(path.join(root, 'lib'), 16);
  const sites = (lib?.names ?? [])
    .filter((name) => /^python\d+\.\d+t?$/.test(name))
    .map((name) => path.join(root, 'lib', name, 'site-packages'));
  const present = await Promise.all(sites.map(async (site) => (await statOf(site))?.isDirectory() ?? false));
  return sites.filter((_site, index) => present[index]);
}

/**
 * The canonical distribution name a `.dist-info` directory name carries: `<name>-<version>`,
 * where the version is after the last `-` (installers write `_` for `-` in the name, older ones
 * did not).
 */
const infoName = (info: string): string => {
  const stem = info.slice(0, -'.dist-info'.length);
  const split = stem.lastIndexOf('-');
  return canonicalName(split > 0 ? stem.slice(0, split) : stem);
};

const distInfos = async (site: string): Promise<{ infos: string[]; truncated: boolean }> => {
  // Other entries (packages, modules) share the directory: read a margin past the limit.
  const listing = await listDirectory(site, DISTRIBUTION_LIMIT * 4);
  const infos = (listing?.names ?? []).filter((name) => name.endsWith('.dist-info'));
  return {
    infos: infos.slice(0, DISTRIBUTION_LIMIT),
    truncated: (listing?.truncated ?? false) || infos.length > DISTRIBUTION_LIMIT,
  };
};

/** Name and version from a distribution's `METADATA` headers, read within the limit. */
async function identityOf(info: string): Promise<{ declaredName: string; name: string; version: string } | undefined> {
  const metadata = await readBounded(path.join(info, 'METADATA'), METADATA_LIMIT, true);
  return typeof metadata === 'object' ? readIdentity(metadata.text) : undefined;
}

async function readSiteForCli(site: string): Promise<CliVenv | undefined> {
  const { infos, truncated } = await distInfos(site);
  const cliInfo = infos.find((info) => CLI_DISTRIBUTIONS.has(infoName(info)));
  if (!cliInfo) return undefined;
  const cli = await identityOf(path.join(site, cliInfo));
  if (!cli || !CLI_DISTRIBUTIONS.has(cli.name)) return undefined;

  const issues = new Set<TerminalCliIssue>();
  const seen = new Set<string>();
  const entries = new Set<string>();
  const extensions: TerminalCliExtension[] = [];
  const read = await Promise.all(
    infos.map(async (info) => ({
      info,
      entryPoints: await readBounded(path.join(site, info, 'entry_points.txt'), METADATA_LIMIT),
    }))
  );
  for (const { info, entryPoints } of read) {
    if (entryPoints === 'too_large') issues.add('ENTRY_POINTS_TOO_LARGE');
    if (typeof entryPoints !== 'object') continue;
    const declared = parseExtensionEntries(entryPoints.text);
    if (declared.size === 0) continue;
    // eslint-disable-next-line no-await-in-loop -- only distributions with extensions, in a stable order
    const identity = await identityOf(path.join(site, info));
    if (!identity) {
      issues.add('METADATA_UNREADABLE');
      continue;
    }
    if (seen.has(identity.name)) {
      issues.add('DUPLICATE_DISTRIBUTION');
      continue;
    }
    seen.add(identity.name);
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
 * Read the terminal CLI's virtual environment at `root` from its files; nothing is run or
 * imported. A directory is one when it has a `pyvenv.cfg` and a site-packages holding the
 * `aelix` distribution. Its extensions are the `aelix.extensions` entry points there, which is
 * what that CLI's `extension list` reads (`importlib.metadata`).
 *
 * Returns `not_a_venv` without a `pyvenv.cfg`, `no_cli` when no site-packages holds the CLI.
 */
export async function readCliVenv(
  root: string,
  platform: NodeJS.Platform = process.platform
): Promise<CliVenv | 'not_a_venv' | 'no_cli'> {
  if (!(await statOf(path.join(root, 'pyvenv.cfg')))?.isFile()) return 'not_a_venv';
  for (const site of await sitePackages(root, platform)) {
    // eslint-disable-next-line no-await-in-loop -- stops at the first site that holds the CLI
    const venv = await readSiteForCli(site);
    if (venv) return venv;
  }
  return 'no_cli';
}

/**
 * Whether `root` looks like a CLI environment, from directory names only (no file is read):
 * how a tool directory's other tools are passed over without reading their metadata.
 */
export async function holdsCli(root: string, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  if (!(await statOf(path.join(root, 'pyvenv.cfg')))?.isFile()) return false;
  for (const site of await sitePackages(root, platform)) {
    // eslint-disable-next-line no-await-in-loop -- stops at the first site that holds the CLI
    const { infos } = await distInfos(site);
    if (infos.some((info) => CLI_DISTRIBUTIONS.has(infoName(info)))) return true;
  }
  return false;
}
