import { copyFile, cp, lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
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
  /** What the management interpreter path is: the file it links to, or its hash where it is a copy. */
  interpreter: string;
  /** `RECORD` hash of the installer distribution. */
  installer: string;
};

/** A generation being built. It has no `generation.json` yet, so recovery would remove it. */
export type Candidate = { id: string; paths: GenerationPaths; skeleton: Skeleton };

export type ScanProblem = {
  code: Extract<ExtensionFailureCode, 'STARTUP_CODE' | 'BUNDLE_OVERLAP' | 'GENERATION_MODIFIED'>;
  message: string;
};

async function interpreterIdentity(paths: GenerationPaths, platform: NodeJS.Platform): Promise<string> {
  // POSIX venvs link to the bundled interpreter; Windows venvs hold a copy of a launcher.
  return platform === 'win32' ? `sha256:${await hashFile(paths.python)}` : `link:${await realpath(paths.python)}`;
}

async function readSkeleton(context: FlowContext, paths: GenerationPaths): Promise<Skeleton> {
  const site = await readSite(paths.site);
  return {
    configuration: await readFile(paths.configuration, 'utf8'),
    interpreter: await interpreterIdentity(paths, context.platform),
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
 */
async function carryOver(
  parent: GenerationPaths,
  candidate: GenerationPaths,
  platform: NodeJS.Platform
): Promise<void> {
  const snapshot = await readSite(parent.site);
  if (snapshot.problems.length > 0)
    throw new ExtensionFailure('GENERATION_MODIFIED', ['the current generation is damaged', ...snapshot.problems]);
  for (const distribution of contentDistributions(snapshot)) {
    for (const listed of distribution.files) {
      if (listed.endsWith('.pyc')) continue;
      const source = path.resolve(parent.site, listed);
      const destination = path.resolve(candidate.site, listed);
      if (!inside(parent.venv, source) || !inside(candidate.venv, destination))
        throw new ExtensionFailure('GENERATION_MODIFIED', [`${distribution.name} lists a file outside its generation`]);
      // oxlint-disable-next-line no-await-in-loop -- files are copied one at a time, in RECORD order
      const regular = await lstat(source).then(
        (stats) => stats.isFile(),
        () => false
      );
      if (!regular) continue;
      // oxlint-disable-next-line no-await-in-loop
      await mkdir(path.dirname(destination), { recursive: true });
      // oxlint-disable-next-line no-await-in-loop
      await copyFile(source, destination);
      if (platform === 'win32' || path.dirname(destination) !== candidate.scripts) continue;
      // oxlint-disable-next-line no-await-in-loop
      const rewritten = rewriteScriptHeader(await readFile(destination), parent.python, candidate.python);
      // oxlint-disable-next-line no-await-in-loop
      if (rewritten) await writeFile(destination, rewritten);
    }
  }
  await cp(parent.agent, candidate.agent, { recursive: true, force: true });
}

/**
 * Build a candidate generation (ADR 5.4 step 3): a fresh venv on the bundled interpreter,
 * then the parent generation's installed files and native records.
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
  // Not recursive: a directory of this name must not exist yet, so nothing is ever built into an old one.
  await mkdir(paths.directory);
  try {
    return { id, paths, skeleton: await buildCandidate(context, paths, parent) };
  } catch (error) {
    await rm(paths.directory, { recursive: true, force: true, maxRetries: 3 });
    throw error;
  }
}

async function buildCandidate(
  context: FlowContext,
  paths: GenerationPaths,
  parent: GenerationRecord | null
): Promise<Skeleton> {
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
  const skeleton = await readSkeleton(context, paths);
  const lines = skeleton.configuration.split(/\r?\n/);
  const owned =
    lines.includes(`home = ${path.dirname(context.bundle.python)}`) &&
    lines.includes('include-system-site-packages = false') &&
    skeleton.installer !== '' &&
    (context.platform === 'win32' || skeleton.interpreter === `link:${await realpath(context.bundle.python)}`);
  if (!owned)
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
  return skeleton;
}

/** Remove a candidate that will not become a generation. */
export async function discardCandidate(candidate: Candidate): Promise<void> {
  await rm(candidate.paths.directory, { recursive: true, force: true, maxRetries: 3 });
}

/**
 * The static scan of a generation (ADR 5.3). It reads files only and must pass before the
 * generation's interpreter is started, because that interpreter runs with `site` enabled.
 *
 * - No file that runs when the interpreter starts: `.pth`, `sitecustomize`, `usercustomize`.
 * - What Studio wrote is unchanged: `pyvenv.cfg`, the interpreter the helper starts, the installer.
 * - No distribution and no top-level name the bundle ships. The bundle wins only if a
 *   generation never holds its names; path order alone does not guarantee it.
 */
export async function scanGeneration(
  context: FlowContext,
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
  const current = await readSkeleton(context, paths).catch((): undefined => undefined);
  if (current?.configuration !== skeleton.configuration) report('GENERATION_MODIFIED', 'pyvenv.cfg was replaced');
  if (current?.interpreter !== skeleton.interpreter) report('GENERATION_MODIFIED', 'the interpreter was replaced');
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
  }
  for (const name of snapshot.topLevel)
    if (name !== INSTALLER && bundle.topLevel.has(name))
      report('BUNDLE_OVERLAP', `top-level module ${name} is shipped with Studio`);
  return { snapshot, problems };
}
