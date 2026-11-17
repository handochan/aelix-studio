import {
  constants,
  copyFile,
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  realpath,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { parseRequirement } from '../inspect/requirement.js';
import { contentDistributions, INSTALLER, readSite, type SiteSnapshot } from '../inspect/site.js';
import { runToExit, type Spawn } from '../process.js';
import { hashFile } from '../store/artifacts.js';
import { generationPaths, type Bundle, type BundleFacts, type GenerationPaths, type Layout } from '../store/layout.js';
import type { GenerationRecord } from '../store/pointer.js';
import { ExtensionFailure, type ExtensionFailureCode } from '../types.js';

/** What a flow step needs to start processes and find files. */
export type FlowContext = {
  bundle: Bundle;
  layout: Layout;
  platform: NodeJS.Platform;
  spawn: Spawn;
  /** Allow-listed environment every child starts from. */
  base: Record<string, string>;
  timeouts: { lockMs: number; environmentMs: number; installerMs: number; verifyMs: number };
  signal?: AbortSignal;
};

/** What Studio itself wrote into a generation. A scan fails when any of it changed. */
export type Skeleton = {
  /** Content of `pyvenv.cfg`. */
  configuration: string;
  /**
   * Every entry `python -m venv` put next to the interpreter, by name: the interpreter under
   * each of its names, the installer's launchers, the activation scripts. On POSIX the
   * interpreter names are links that end at the bundled interpreter.
   */
  entries: Record<string, string>;
  /** `RECORD` hash of the installer distribution. */
  installer: string;
};

/** A generation being built. It has no `generation.json` yet, so recovery would remove it. */
export type Candidate = { id: string; paths: GenerationPaths; skeleton: Skeleton };

export type ScanProblem = {
  code: Extract<
    ExtensionFailureCode,
    'STARTUP_CODE' | 'BUNDLE_OVERLAP' | 'GENERATION_MODIFIED' | 'DIRECT_REFERENCE' | 'INVALID_WHEEL'
  >;
  message: string;
};

/** What an entry next to the interpreter is, without following a link: its target, or its content hash. */
async function entryIdentity(file: string): Promise<string> {
  try {
    const stats = await lstat(file);
    if (stats.isSymbolicLink()) return `link:${await readlink(file)}`;
    return stats.isFile() ? `file:${await hashFile(file)}` : 'other';
  } catch {
    return 'missing';
  }
}

async function readSkeleton(paths: GenerationPaths, names?: string[]): Promise<Skeleton> {
  const site = await readSite(paths.site);
  const entries: Record<string, string> = {};
  for (const name of names ?? (await readdir(paths.scripts)).toSorted()) {
    // oxlint-disable-next-line no-await-in-loop -- a dozen small entries, read in order
    entries[name] = await entryIdentity(path.join(paths.scripts, name));
  }
  return {
    configuration: await readFile(paths.configuration, 'utf8'),
    entries,
    installer: site.distributions.get(INSTALLER)?.recordSha256 ?? '',
  };
}

/** Replace every occurrence of `from` in `line`. */
function replaceBytes(line: Buffer, from: Buffer, to: Buffer): Buffer {
  const parts: Buffer[] = [];
  let cursor = 0;
  for (let found = line.indexOf(from); found >= 0; found = line.indexOf(from, cursor)) {
    parts.push(line.subarray(cursor, found), to);
    cursor = found + from.length;
  }
  parts.push(line.subarray(cursor));
  return Buffer.concat(parts);
}

/**
 * Point a console script at another interpreter. pip writes the interpreter either on the
 * first line (`#!<python>`) or, when the path has a space or is long, on the second line of
 * a `/bin/sh` header (`'''exec' "<python>" "$0" "$@"`). Only those header lines are touched.
 *
 * Returns undefined when the file is not such a script.
 */
export function rewriteScriptHeader(content: Buffer, from: string, to: string): Buffer | undefined {
  const [source, target] = [Buffer.from(from), Buffer.from(to)];
  const firstEnd = content.indexOf(0x0a);
  if (firstEnd < 0 || content.subarray(0, 2).toString() !== '#!') return undefined;
  const first = content.subarray(0, firstEnd);
  if (first.includes(source)) return Buffer.concat([replaceBytes(first, source, target), content.subarray(firstEnd)]);
  const secondEnd = content.indexOf(0x0a, firstEnd + 1);
  const second = content.subarray(firstEnd + 1, secondEnd < 0 ? content.length : secondEnd);
  if (first.toString().trim() !== '#!/bin/sh' || !second.toString().startsWith("'''exec' ") || !second.includes(source))
    return undefined;
  return Buffer.concat([
    content.subarray(0, firstEnd + 1),
    replaceBytes(second, source, target),
    content.subarray(firstEnd + 1 + second.length),
  ]);
}

const inside = (directory: string, file: string): boolean => {
  const relative = path.relative(directory, file);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
};

/**
 * Copy what the parent generation installed into the candidate (ADR 5.4 step 3): every
 * file its `RECORD` files list, which includes console scripts and data files outside
 * `site-packages`. The installer itself is not copied; the candidate has its own.
 *
 * A copy only ever creates a new file. The candidate's interpreter names are links that end
 * at the bundled interpreter, so writing "onto" one of them would write into the bundle;
 * a recorded file that meets an entry of the new environment, or that would leave either
 * generation through a link, ends the change instead.
 */
async function carryOver(
  parent: GenerationPaths,
  candidate: GenerationPaths,
  platform: NodeJS.Platform
): Promise<void> {
  const snapshot = await readSite(parent.site);
  if (snapshot.problems.length > 0)
    throw new ExtensionFailure('GENERATION_MODIFIED', ['the current generation is damaged', ...snapshot.problems]);
  const refuse = (distribution: string, reason: string): never => {
    throw new ExtensionFailure('GENERATION_MODIFIED', [`${distribution} ${reason}`]);
  };
  const [parentRoot, candidateRoot] = await Promise.all([realpath(parent.venv), realpath(candidate.venv)]);
  const within = async (root: string, directory: string): Promise<boolean> => {
    const real = await realpath(directory);
    return real === root || inside(root, real);
  };
  const copied = new Set<string>();
  for (const distribution of contentDistributions(snapshot)) {
    for (const listed of distribution.files) {
      if (listed.endsWith('.pyc')) continue;
      const source = path.resolve(parent.site, listed);
      const destination = path.resolve(candidate.site, listed);
      if (!inside(parent.venv, source) || !inside(candidate.venv, destination))
        refuse(distribution.name, 'lists a file outside its generation');
      // Two distributions may list the same file (a shared package); it is copied once.
      if (copied.has(destination)) continue;
      // oxlint-disable-next-line no-await-in-loop -- files are copied one at a time, in RECORD order
      const regular = await lstat(source).then(
        (stats) => stats.isFile(),
        () => false
      );
      if (!regular) continue;
      // oxlint-disable-next-line no-await-in-loop
      await mkdir(path.dirname(destination), { recursive: true });
      // oxlint-disable-next-line no-await-in-loop
      const contained =
        (await within(parentRoot, path.dirname(source))) && (await within(candidateRoot, path.dirname(destination)));
      if (!contained) refuse(distribution.name, 'lists a file that leaves its generation through a link');
      try {
        // Exclusive: fails on anything that is already there, link or file, and never writes through it.
        // oxlint-disable-next-line no-await-in-loop
        await copyFile(source, destination, constants.COPYFILE_EXCL);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        refuse(distribution.name, `lists ${path.basename(destination)}, which belongs to the new environment`);
      }
      copied.add(destination);
      if (platform === 'win32' || path.dirname(destination) !== candidate.scripts) continue;
      // oxlint-disable-next-line no-await-in-loop
      const rewritten = rewriteScriptHeader(await readFile(destination), parent.python, candidate.python);
      // oxlint-disable-next-line no-await-in-loop
      if (rewritten) await writeFile(destination, rewritten);
    }
  }
  // Links in the agent directory are left behind: native would write through them.
  await cp(parent.agent, candidate.agent, {
    recursive: true,
    filter: async (source) => {
      const stats = await lstat(source);
      return stats.isDirectory() || stats.isFile();
    },
  });
}

/**
 * Build a candidate generation (ADR 5.4 step 3): a fresh venv on the bundled interpreter,
 * then the parent generation's installed files and native records.
 *
 * The directory is new: a directory of that name must not exist. When this fails, what was
 * built so far is left for the caller to remove through the lock holder.
 *
 * @throws ExtensionFailure `RUNTIME_UNAVAILABLE` when the venv cannot be made,
 * `GENERATION_MODIFIED` when the parent cannot be copied faithfully, `CANCELLED`, `TIMEOUT`.
 */
export async function createCandidate(
  context: FlowContext,
  id: string,
  parent: GenerationRecord | null
): Promise<Candidate> {
  const paths = generationPaths(context.layout, id, context.bundle.binding.pythonMinor, context.platform);
  await mkdir(paths.directory);
  const result = await runToExit(
    context.spawn,
    {
      command: context.bundle.python,
      args: ['-I', '-B', '-m', 'venv', paths.venv],
      env: context.base,
      cwd: paths.directory,
    },
    { timeoutMs: context.timeouts.environmentMs, signal: context.signal }
  );
  if (result.cancelled) throw new ExtensionFailure('CANCELLED');
  if (result.timedOut) throw new ExtensionFailure('TIMEOUT', ['creating the environment took too long']);
  if (result.code !== 0)
    throw new ExtensionFailure(
      'RUNTIME_UNAVAILABLE',
      ['the bundled interpreter could not create an environment'],
      result.output
    );
  // Anything that cannot be read here means venv did not leave an environment behind.
  const skeleton = await readSkeleton(paths).catch((): undefined => undefined);
  const lines = skeleton?.configuration.split(/\r?\n/) ?? [];
  const linked = async (): Promise<boolean> =>
    context.platform === 'win32' || (await realpath(paths.python)) === (await realpath(context.bundle.python));
  const owned =
    lines.includes(`home = ${path.dirname(context.bundle.python)}`) &&
    lines.includes('include-system-site-packages = false') &&
    skeleton?.installer !== '' &&
    (await linked().catch(() => false));
  if (!skeleton || !owned)
    throw new ExtensionFailure('RUNTIME_UNAVAILABLE', ['the new environment is not on the bundled interpreter']);
  await mkdir(paths.agent, { recursive: true });
  if (parent) {
    const parentPaths = generationPaths(
      context.layout,
      parent.generation,
      parent.binding.pythonMinor,
      context.platform
    );
    await carryOver(parentPaths, paths, context.platform);
  }
  return { id, paths, skeleton };
}

/**
 * The static scan of a generation (ADR 5.3). It reads files only and must pass before the
 * generation's interpreter is started, because that interpreter runs with `site` enabled.
 *
 * - No file that runs when the interpreter starts: `.pth`, `sitecustomize`, `usercustomize`.
 * - What Studio wrote is unchanged: `pyvenv.cfg`, every entry venv put next to the
 *   interpreter (the interpreter under all its names included), the installer.
 * - No distribution and no top-level name the bundle ships. The bundle wins only if a
 *   generation never holds its names; path order alone does not guarantee it.
 * - No installed distribution declares a direct reference. This is read from the metadata
 *   that ended up on disk, which is what the installer consults on every later install.
 */
export async function scanGeneration(
  candidate: Candidate,
  bundle: BundleFacts
): Promise<{ snapshot: SiteSnapshot; problems: ScanProblem[] }> {
  const { paths, skeleton } = candidate;
  const snapshot = await readSite(paths.site);
  const problems: ScanProblem[] = [];
  const report = (code: ScanProblem['code'], message: string): void => {
    problems.push({ code, message });
  };
  for (const entry of snapshot.startup) report('STARTUP_CODE', `${entry} runs when the interpreter starts`);
  const current = await readSkeleton(paths, Object.keys(skeleton.entries)).catch((): undefined => undefined);
  if (current?.configuration !== skeleton.configuration) report('GENERATION_MODIFIED', 'pyvenv.cfg was replaced');
  for (const [name, identity] of Object.entries(skeleton.entries))
    if (current?.entries[name] !== identity) report('GENERATION_MODIFIED', `${name} of the environment was replaced`);
  if (current?.installer !== skeleton.installer) report('GENERATION_MODIFIED', 'the installer was replaced');
  for (const problem of snapshot.problems) report('GENERATION_MODIFIED', problem);
  for (const distribution of contentDistributions(snapshot)) {
    const shipped = bundle.distributions.get(distribution.name);
    if (shipped !== undefined)
      report(
        'BUNDLE_OVERLAP',
        `distribution ${distribution.name} ${distribution.version} is shipped with Studio (${shipped})`
      );
    const claimsInstaller = distribution.files.some((file) => {
      const top = path.posix.normalize(file).split('/')[0].toLowerCase();
      return top === INSTALLER || (top.startsWith(`${INSTALLER}-`) && top.endsWith('.dist-info'));
    });
    if (claimsInstaller) report('GENERATION_MODIFIED', `${distribution.name} installs files of the installer`);
    for (const text of distribution.requires) {
      const requirement = parseRequirement(text);
      if (!requirement) report('INVALID_WHEEL', `${distribution.name} declares a requirement that cannot be read`);
      else if (requirement.url !== undefined) report('DIRECT_REFERENCE', `${distribution.name} requires ${text}`);
    }
  }
  for (const name of snapshot.topLevel)
    if (name !== INSTALLER && bundle.topLevel.has(name))
      report('BUNDLE_OVERLAP', `top-level module ${name} is shipped with Studio`);
  return { snapshot, problems };
}
