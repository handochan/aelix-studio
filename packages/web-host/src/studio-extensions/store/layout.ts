import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, realpath, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readSite } from '../inspect/site.js';

/**
 * Where everything lives (D04 ADR 5.1). The helper writes only under `root`, a directory
 * in the Studio user data area. It never writes to the app bundle, to the terminal CLI's
 * environment or to the `~/.aelix` directory shared with the CLI.
 *
 * ```text
 * <root>/
 *   lock                      cross-process mutation lock
 *   current.json              current and previous generation, revision, bundle binding
 *   current.previous.json     the pointer before the last switch
 *   constraints-<lock>.txt    distributions and versions the bundle ships
 *   artifacts/<set>/          imported wheels and their sha256 list
 *   leases/                   one file per running launcher, named <generation>.<suffix>
 *   generations/<id>/
 *     venv/                   venv on the bundled interpreter; extensions and extra dependencies
 *     agent/                  native install records and pins of this generation
 *     generation.json         written last; a directory without it is an unfinished candidate
 * ```
 */
export type Layout = {
  root: string;
  lock: string;
  pointer: string;
  previousPointer: string;
  generations: string;
  artifacts: string;
  leases: string;
};

/** Directory name under the Studio user data directory. */
export const STATE_DIRECTORY = 'aelix-runtime';

/** The paths of the helper's state under `root`. Nothing is created. */
export function layoutOf(root: string): Layout {
  return {
    root,
    lock: path.join(root, 'lock'),
    pointer: path.join(root, 'current.json'),
    previousPointer: path.join(root, 'current.previous.json'),
    generations: path.join(root, 'generations'),
    artifacts: path.join(root, 'artifacts'),
    leases: path.join(root, 'leases'),
  };
}

/** Create the directories of the layout. */
export async function ensureLayout(layout: Layout): Promise<void> {
  await Promise.all(
    [layout.generations, layout.artifacts, layout.leases].map((directory) => mkdir(directory, { recursive: true }))
  );
}

/**
 * Replace a file with new content so that a reader sees the old file or the new one,
 * never a part: write a temporary file beside it, flush it to disk, then rename.
 */
export async function writeAtomic(file: string, content: string): Promise<void> {
  const temporary = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    const handle = await open(temporary, 'w', 0o600);
    try {
      await handle.writeFile(content, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  // Make the rename durable where the platform lets a directory be flushed.
  try {
    const directory = await open(path.dirname(file), 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch {
    // Windows cannot open a directory for this; the rename itself already happened.
  }
}

/**
 * What a generation is bound to (ADR 5.1). A generation is used only with the bundle it
 * was verified against: same location, target, Python minor, dependency lock and native commit.
 */
export type BundleBinding = {
  bundle: string;
  target: string;
  pythonMinor: string;
  dependencyLockSha256: string;
  nativeCommit: string;
};

/** Whether two bindings name the same bundle in every respect. */
export function sameBinding(left: BundleBinding, right: BundleBinding): boolean {
  return (
    left.bundle === right.bundle &&
    left.target === right.target &&
    left.pythonMinor === right.pythonMinor &&
    left.dependencyLockSha256 === right.dependencyLockSha256 &&
    left.nativeCommit === right.nativeCommit
  );
}

/** The read-only runtime shipped with Studio. */
export type Bundle = {
  root: string;
  /** The bundled interpreter. */
  python: string;
  /** `launch.py`, the entrypoint both launch forms go through. */
  launcher: string;
  /** `native-site`: native and its dependencies. */
  nativeSite: string;
  binding: BundleBinding;
};

const BUNDLE_SCHEMA = 'aelix.studio-preview.runtime/1';
const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);

/**
 * Resolve the bundled runtime at `root`. Only the self-contained bundle (the one with a
 * `manifest.json`) is supported; a prepared development runtime has no manifest to bind to.
 *
 * Returns undefined when the directory is not a bundle for this platform.
 */
export async function resolveBundle(
  root: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): Promise<Bundle | undefined> {
  try {
    const real = await realpath(root);
    const manifest = JSON.parse(await readFile(path.join(real, 'manifest.json'), 'utf8')) as {
      schema?: unknown;
      target?: unknown;
      python?: unknown;
      dependencyLockSha256?: unknown;
      native?: { sourceTag?: { commit?: unknown } };
    };
    const version = text(manifest.python);
    const lock = text(manifest.dependencyLockSha256);
    const commit = text(manifest.native?.sourceTag?.commit);
    const minor = version && /^(\d+\.\d+)(?:\.|$)/.exec(version)?.[1];
    if (manifest.schema !== BUNDLE_SCHEMA || manifest.target !== `${platform}-${arch}` || !minor || !lock || !commit)
      return undefined;
    const python = path.join(real, 'python', ...(platform === 'win32' ? ['python.exe'] : ['bin', 'python3']));
    const launcher = path.join(real, 'launch.py');
    const nativeSite = path.join(real, 'native-site');
    const present = await Promise.all([python, launcher, nativeSite].map((file) => stat(file)));
    if (!present[0].isFile() || !present[1].isFile() || !present[2].isDirectory()) return undefined;
    return {
      root: real,
      python,
      launcher,
      nativeSite,
      binding: {
        bundle: real,
        target: `${platform}-${arch}`,
        pythonMinor: minor,
        dependencyLockSha256: lock,
        nativeCommit: commit,
      },
    };
  } catch {
    return undefined;
  }
}

/** A generation directory name: `g`, an 8-digit sequence number, `-`, 4 hex characters. */
const GENERATION_ID = /^g\d{8}-[0-9a-f]{4}$/;

/** Whether a string read from disk may be used as a generation directory name. */
export function isGenerationId(value: unknown): value is string {
  return typeof value === 'string' && GENERATION_ID.test(value);
}

/**
 * Name a new generation. Names have a fixed length, so every generation's interpreter path
 * has the same length and console scripts carried over keep a valid first line. The number
 * is the pointer revision the generation will have once it is current; the suffix keeps a
 * discarded candidate's name from ever being used again.
 */
export function generationId(revision: number, suffix: string): string {
  return `g${String(revision).padStart(8, '0')}-${suffix}`;
}

export type GenerationPaths = {
  directory: string;
  venv: string;
  /** native's agent directory for this generation. */
  agent: string;
  record: string;
  /** The venv interpreter used for management. */
  python: string;
  /** Where console scripts go. */
  scripts: string;
  site: string;
  configuration: string;
};

/** Paths inside one generation. `pythonMinor` is the one the generation was built with. */
export function generationPaths(
  layout: Layout,
  id: string,
  pythonMinor: string,
  platform: NodeJS.Platform = process.platform
): GenerationPaths {
  const directory = path.join(layout.generations, id);
  const venv = path.join(directory, 'venv');
  const scripts = path.join(venv, platform === 'win32' ? 'Scripts' : 'bin');
  return {
    directory,
    venv,
    agent: path.join(directory, 'agent'),
    record: path.join(directory, 'generation.json'),
    python: path.join(scripts, platform === 'win32' ? 'python.exe' : 'python'),
    scripts,
    site:
      platform === 'win32'
        ? path.join(venv, 'Lib', 'site-packages')
        : path.join(venv, 'lib', `python${pythonMinor}`, 'site-packages'),
    configuration: path.join(venv, 'pyvenv.cfg'),
  };
}

/** What the bundle owns: a generation may neither shadow nor add to any of it (ADR 5.3). */
export type BundleFacts = {
  /** Canonical distribution name to version. */
  distributions: Map<string, string>;
  /** Lower-cased top-level module and package names. */
  topLevel: Set<string>;
};

/** Read the distributions and top-level names of the bundle's `native-site`. */
export async function readBundleFacts(bundle: Bundle): Promise<BundleFacts> {
  const site = await readSite(bundle.nativeSite);
  return {
    distributions: new Map([...site.distributions.values()].map(({ name, version }) => [name, version])),
    topLevel: site.topLevel,
  };
}

/**
 * Write the constraints file for this bundle and return its `file://` address.
 *
 * pip splits `PIP_CONSTRAINT` on spaces, so a path under "Application Support" must be
 * passed as a URL (ADR 5.4).
 */
export async function writeConstraints(layout: Layout, bundle: Bundle, facts: BundleFacts): Promise<string> {
  const file = path.join(layout.root, `constraints-${bundle.binding.dependencyLockSha256.slice(0, 12)}.txt`);
  const lines = [...facts.distributions]
    .toSorted(([left], [right]) => (left < right ? -1 : 1))
    .map(([name, version]) => `${name}==${version}\n`);
  await writeAtomic(file, lines.join(''));
  return pathToFileURL(file).href;
}
