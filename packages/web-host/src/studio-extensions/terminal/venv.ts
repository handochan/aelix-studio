import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { readSite } from '../inspect/site.js';

/** Distributions that install the `aelix` command: an environment with one of them is a CLI. */
const CLI_DISTRIBUTIONS = ['aelix', 'aelix-coding-agent'];

/** One `aelix.extensions` entry point of the terminal CLI's environment, read from its files. */
export type CliExtension = {
  /** Entry point name: what native's `extension list` shows. */
  name: string;
  /** Distribution name as its metadata writes it. */
  distribution: string;
  version: string;
  /** The object reference the entry point names. */
  reference: string;
};

export type CliVenv = {
  /** The native version installed there. */
  nativeVersion: string;
  extensions: CliExtension[];
  /** Metadata that could not be read as a ledger (duplicated or unreadable entries). */
  problems: string[];
};

const isDirectory = (target: string): Promise<boolean> =>
  stat(target).then(
    (entry) => entry.isDirectory(),
    (): boolean => false
  );

const isFile = (target: string): Promise<boolean> =>
  stat(target).then(
    (entry) => entry.isFile(),
    (): boolean => false
  );

/**
 * The `site-packages` directories of the virtual environment at `root`: `Lib/site-packages`
 * on Windows, `lib/python<X.Y>/site-packages` elsewhere (normally one).
 */
async function sitePackages(root: string, platform: NodeJS.Platform): Promise<string[]> {
  if (platform === 'win32') {
    const site = path.join(root, 'Lib', 'site-packages');
    return (await isDirectory(site)) ? [site] : [];
  }
  let names: string[];
  try {
    names = await readdir(path.join(root, 'lib'));
  } catch {
    return [];
  }
  const sites = names
    .filter((name) => /^python\d+\.\d+t?$/.test(name))
    .toSorted()
    .map((name) => path.join(root, 'lib', name, 'site-packages'));
  const present = await Promise.all(sites.map(isDirectory));
  return sites.filter((_site, index) => present[index]);
}

/**
 * Read the terminal CLI's virtual environment at `root` from its files; nothing is run or
 * imported. A directory is one when it has a `pyvenv.cfg` and a `site-packages` holding the
 * `aelix` distribution. Its extensions are the `aelix.extensions` entry points there, which
 * is what that CLI's `extension list` reads (`importlib.metadata`).
 *
 * Returns `not_a_venv` without a `pyvenv.cfg`, `no_cli` when no `site-packages` holds the CLI.
 */
export async function readCliVenv(
  root: string,
  platform: NodeJS.Platform = process.platform
): Promise<CliVenv | 'not_a_venv' | 'no_cli'> {
  if (!(await isFile(path.join(root, 'pyvenv.cfg')))) return 'not_a_venv';
  for (const site of await sitePackages(root, platform)) {
    const snapshot = await readSite(site);
    const cli = CLI_DISTRIBUTIONS.map((name) => snapshot.distributions.get(name)).find(Boolean);
    if (!cli) continue;
    const extensions = [...snapshot.extensions].map(([name, entry]): CliExtension => {
      const distribution = snapshot.distributions.get(entry.distribution);
      return {
        name,
        distribution: distribution?.declaredName ?? entry.distribution,
        version: distribution?.version ?? '',
        reference: entry.reference,
      };
    });
    return {
      nativeVersion: cli.version,
      extensions: extensions.toSorted((a, b) => a.name.localeCompare(b.name)),
      problems: snapshot.problems,
    };
  }
  return 'no_cli';
}
