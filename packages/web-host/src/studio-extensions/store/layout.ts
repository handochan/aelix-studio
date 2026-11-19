import { randomBytes } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readSite } from '../inspect/site.js';
import { ExtensionFailure } from '../types.js';

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

/**
 * The environment variable that tells the bundled launcher (`launch.py`) where the state
 * directory is. Each adapter reads the current generation when it starts, including when
 * an existing conversation's adapter restarts. Without this variable it uses the bundle alone.
 */
export const STATE_ENVIRONMENT = 'AELIX_STUDIO_EXTENSION_STATE';

/** Locate the extension helper's state for a Studio user data directory. */
export function locateStudioExtensionLayout(userDataPath: string): Promise<Layout> {
  return locateLayout(path.resolve(userDataPath, STATE_DIRECTORY));
}

/** Locate the Studio profile for a standalone WebUI database directory. */
export async function resolveStandaloneStudioUserDataPath(dataDir: string): Promise<string> {
  const absolute = path.resolve(dataDir);
  const resolved = await realpath(absolute);
  const databaseName = path.basename(resolved);
  if ((process.platform === 'win32' ? databaseName.toLowerCase() : databaseName) !== 'aionui') return resolved;

  // Desktop keeps its database in <userData>/aionui and settings in <userData>/config.
  // It also exposes the database directory through a CLI-safe home link on macOS.
  const profile = path.dirname(resolved);
  const desktopAlias = /^\.aionui(?:-dev(?:-2)?)?$/.test(path.basename(absolute));
  if (desktopAlias && (await lstat(absolute)).isSymbolicLink()) return profile;
  const config = path.join(profile, 'config');
  const markers = await Promise.all(
    ['aionui-config.txt', '.aionui-env'].map((name) => stat(path.join(config, name)).catch((): undefined => undefined))
  );
  return markers.some((marker) => marker?.isFile()) ? profile : resolved;
}

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

/** The directories only the helper puts things into, and removes things from. */
export const DEDICATED_DIRECTORIES = ['generations', 'artifacts', 'leases'] as const;

const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT';

/**
 * The layout of a state directory, with its location resolved through links, so every path
 * the helper builds is the real one. Nothing is created: for a directory that does not
 * exist yet, the nearest existing ancestor is resolved.
 */
export async function locateLayout(root: string): Promise<Layout> {
  const absent: string[] = [];
  let existing = path.resolve(root);
  for (;;) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- walks up one directory at a time
      return layoutOf(path.join(await realpath(existing), ...absent));
    } catch (error) {
      const parent = path.dirname(existing);
      if (!missing(error) || parent === existing) throw error;
      absent.unshift(path.basename(existing));
      existing = parent;
    }
  }
}

/**
 * Make sure the state directory is the helper's own. The helper removes things from its
 * dedicated directories; if one of them were a link, that would remove what the link
 * points at. So the root must be where its path says it is, and each dedicated directory
 * must be a real directory in it. A directory that does not exist yet passes.
 *
 * @throws ExtensionFailure `UNSAFE_ROOT`
 */
export async function verifyLayout(layout: Layout): Promise<void> {
  const check = async (directory: string, what: string): Promise<void> => {
    const stats = await lstat(directory).catch((error: unknown): undefined => {
      if (!missing(error)) throw error;
      return undefined;
    });
    if (!stats) return;
    if (stats.isSymbolicLink() || !stats.isDirectory() || (await realpath(directory)) !== directory)
      throw new ExtensionFailure('UNSAFE_ROOT', [`${what} is not a directory of the helper's own`]);
  };
  await check(layout.root, 'the state directory');
  await Promise.all(DEDICATED_DIRECTORIES.map((name) => check(layout[name], name)));
}

/**
 * Create the directories of the layout and verify them.
 *
 * @throws ExtensionFailure `UNSAFE_ROOT`
 */
export async function ensureLayout(layout: Layout): Promise<void> {
  await mkdir(layout.root, { recursive: true });
  await Promise.all(
    DEDICATED_DIRECTORIES.map((name) =>
      mkdir(layout[name]).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      })
    )
  );
  await verifyLayout(layout);
}

/**
 * The path of something directly in the root or in one of the dedicated directories,
 * relative to the root with `/`: the only places the helper renames or removes anything.
 * Undefined for any other path.
 */
export function stateRelative(layout: Layout, target: string): string | undefined {
  const parts = path.relative(layout.root, target).split(path.sep);
  const plain = parts.every((part) => part !== '' && part !== '.' && part !== '..' && !part.includes('/'));
  const dedicated = (DEDICATED_DIRECTORIES as readonly string[]).includes(parts[0]);
  if (!plain || path.isAbsolute(parts[0]) || !(parts.length === 1 || (parts.length === 2 && dedicated)))
    return undefined;
  return parts.join('/');
}

/**
 * Write `content` into a new temporary file beside `file` and flush it to disk. Returns
 * the path of the temporary file; renaming it over `file` is the caller's step.
 */
export async function writeTemporary(file: string, content: string): Promise<string> {
  const temporary = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  // `wx`: the name is new, so an existing file or link of that name is never written through.
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  return temporary;
}

/**
 * Replace a file with new content so that a reader sees the old file or the new one,
 * never a part: write a temporary file beside it, flush it to disk, then rename.
 *
 * For files only this process's change cares about. The pointer files are shared and are
 * renamed by the lock holder instead (`switchPointer`).
 */
export async function writeAtomic(file: string, content: string): Promise<void> {
  const temporary = await writeTemporary(file, content);
  try {
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
