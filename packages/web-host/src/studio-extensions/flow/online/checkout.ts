import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { OutputTail, runToExit, type RunResult } from '../../process.js';
import { ExtensionFailure, type OnlineExtensionSource } from '../../types.js';
import type { FlowContext } from '../candidate.js';
import { gitLocation } from './source.js';

/**
 * A git subdirectory install, step one (Studio #32 1b): Studio fetches the repository itself,
 * checks the requested subdirectory against the real checkout and hands native that checked
 * directory as a local path. pip never chooses a path inside a repository, so a name in the
 * repository that is a link cannot lead the build outside it.
 *
 * Git runs by name from the installer environment's `PATH` (`/usr/bin:/bin` on macOS and
 * Linux), as pip runs it, with the same environment pip gets: the same isolation, the same
 * proxy and, when the user turned it on, the same private Git access. The revision is resolved
 * as pip resolves it (a branch, then a tag, then a commit), and submodules are initialized
 * as pip initializes them, before the check, so the check sees what is installed.
 */

const COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

export type GitCheckout = {
  /** The checkout's real root directory. */
  root: string;
  /** The checked subdirectory: a real directory under `root`, reached through no link. */
  directory: string;
  /** The commit that was checked out. */
  commit: string;
};

type GitRun = (args: string[], cwd: string) => Promise<RunResult>;

function failure(result: RunResult, what: string): ExtensionFailure {
  if (result.cancelled) return new ExtensionFailure('CANCELLED');
  if (result.timedOut) return new ExtensionFailure('TIMEOUT', [`${what} took too long`], result.output);
  return new ExtensionFailure(
    'GIT_FETCH_FAILED',
    [`${what} ended with exit code ${String(result.code)}`],
    result.output
  );
}

/** The commit a revision names in the clone, or undefined when it names none. */
async function resolveCommit(git: GitRun, checkout: string, revision: string): Promise<string | undefined> {
  const result = await git(['rev-parse', '--verify', '--quiet', `${revision}^{commit}`], checkout);
  if (result.cancelled || result.timedOut) throw failure(result, 'resolving the revision');
  // The output mixes stdout and stderr; a warning may come before the commit on the last line.
  const commit = result.code === 0 ? (result.output.trim().split('\n').at(-1) ?? '').trim() : '';
  return COMMIT.test(commit) ? commit : undefined;
}

/**
 * pip's order (`GitVCS.resolve_revision`): a branch of that name, then a tag; a full commit or a
 * `refs/` name the clone does not have is fetched; anything else is taken as a commit-ish.
 * The revision was checked when the request was parsed: it starts with a letter, digit or `_`
 * and has no `..`, so it can be neither an option nor a range.
 */
async function revisionCommit(git: GitRun, checkout: string, revision: string | undefined): Promise<string> {
  const found =
    revision === undefined
      ? await resolveCommit(git, checkout, 'HEAD')
      : ((await resolveCommit(git, checkout, `refs/remotes/origin/${revision}`)) ??
        (await resolveCommit(git, checkout, `refs/tags/${revision}`)) ??
        (revision.startsWith('refs/') ? undefined : await resolveCommit(git, checkout, revision)));
  if (found) return found;
  if (revision !== undefined && (revision.startsWith('refs/') || COMMIT.test(revision))) {
    const fetched = await git(['fetch', '--quiet', 'origin', revision], checkout);
    if (fetched.code !== 0) throw failure(fetched, 'fetching the revision');
    const commit = await resolveCommit(git, checkout, 'FETCH_HEAD');
    if (commit) return commit;
  }
  throw new ExtensionFailure('GIT_FETCH_FAILED', ['the requested revision is not in the repository']);
}

/**
 * Check a requested subdirectory against the checkout on disk: every name on the way must be a
 * real directory (not a link, not a junction), and the real path of the result must be exactly
 * the checkout's real root joined with the requested names. That also refuses a name whose
 * spelling differs from the one on disk, which a case-insensitive file system would accept.
 *
 * @throws ExtensionFailure `SUBDIRECTORY_INVALID`
 */
export async function checkSubdirectory(checkout: string, subdirectory: string): Promise<string> {
  const refuse = (reason: string): ExtensionFailure =>
    new ExtensionFailure('SUBDIRECTORY_INVALID', [`the subdirectory ${reason}`]);
  const parts = subdirectory.split('/');
  // The request parser allows only plain names; repeat the essentials before touching the disk.
  if (parts.some((part) => ['', '.', '..'].includes(part) || ['\\', ':', '\0'].some((mark) => part.includes(mark))))
    throw refuse('is not a relative path of plain names');
  if (parts.some((part) => part.toLowerCase() === '.git')) throw refuse('names the repository metadata');
  const root = await realpath(checkout);
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    // oxlint-disable-next-line no-await-in-loop -- each name is checked before the next is followed
    const stats = await lstat(current).catch((): undefined => undefined);
    if (!stats) throw refuse('does not exist in the repository');
    if (stats.isSymbolicLink()) throw refuse('passes through a link');
    if (!stats.isDirectory()) throw refuse('is not a directory');
  }
  const real = await realpath(current).catch((): undefined => undefined);
  const relative = real === undefined ? '' : path.relative(root, real);
  if (real !== current || relative === '' || relative.startsWith('..') || path.isAbsolute(relative))
    throw refuse('is not the directory it names inside the repository');
  return real;
}

/**
 * Fetch the repository of a git source into `checkout` (a new directory), check out the
 * requested revision, initialize submodules and check the subdirectory.
 *
 * @throws ExtensionFailure `GIT_FETCH_FAILED`, `SUBDIRECTORY_INVALID`, `CANCELLED`, `TIMEOUT`
 */
export async function checkoutSubdirectory(
  context: Pick<FlowContext, 'spawn' | 'signal'>,
  env: Record<string, string>,
  source: Extract<OnlineExtensionSource, { kind: 'git' }> & { subdirectory: string },
  checkout: string,
  timeoutMs: number
): Promise<GitCheckout & { output: string }> {
  const transcript = new OutputTail(4096);
  const git: GitRun = async (args, cwd) => {
    const result = await runToExit(
      context.spawn,
      { command: 'git', args, env, cwd },
      { timeoutMs, signal: context.signal }
    );
    transcript.push(result.output);
    return { ...result, output: result.code === 0 ? result.output : transcript.toString() };
  };
  const { repository, revision } = gitLocation(source);
  // pip clones the same way: without blobs it does not need yet (a server that cannot filter
  // sends everything). No checkout yet: the revision decides what is checked out.
  const cloned = await git(
    ['clone', '--quiet', '--filter=blob:none', '--no-checkout', '--', repository, checkout],
    path.dirname(checkout)
  );
  if (cloned.code !== 0) throw failure(cloned, 'fetching the repository');
  const commit = await revisionCommit(git, checkout, revision);
  const checkedOut = await git(['checkout', '--quiet', commit], checkout);
  if (checkedOut.code !== 0) throw failure(checkedOut, 'checking out the revision');
  const submodules = await lstat(path.join(checkout, '.gitmodules')).catch((): undefined => undefined);
  if (submodules?.isFile()) {
    const updated = await git(['submodule', 'update', '--init', '--recursive', '--quiet'], checkout);
    if (updated.code !== 0) throw failure(updated, 'fetching the submodules');
  }
  return {
    root: await realpath(checkout),
    directory: await checkSubdirectory(checkout, source.subdirectory),
    commit,
    output: transcript.toString(),
  };
}
