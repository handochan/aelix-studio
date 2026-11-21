import { randomBytes } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { OutputTail, runToExit, type RunResult } from '../../process.js';
import { removeFromState, type StateWriter } from '../../store/lock.js';
import { ExtensionFailure, type OnlineExtensionSource } from '../../types.js';
import type { FlowContext } from '../candidate.js';
import { gitLocation, redactUrlCredentials } from './source.js';

/**
 * A git subdirectory install, step one (Studio #32 1b): Studio fetches the repository itself,
 * checks the requested subdirectory and hands native a checked copy of the repository as a
 * local path. pip never chooses a path inside a repository, so a name in the repository that
 * is a link cannot lead the build outside it.
 *
 * Git runs by name from the installer environment's `PATH` (`/usr/bin:/bin` on macOS and
 * Linux), as pip runs it, with the same environment the installer of a git source gets: the
 * same isolation, the same proxy and transport policy and, when the user turned it on, the
 * same private Git access. The revision is resolved as pip resolves it (a branch, then a tag,
 * then a commit) and checked out detached by its object name; the checkout must then be at
 * exactly that commit.
 *
 * Only the submodules inside the requested subdirectory are initialized: the rest of the
 * repository is never built, so the hosts its other submodules name are not contacted.
 *
 * The clone and the copy live in staging directories of the store (`artifacts/.staging-…`):
 * the lock holder removes them, and recovery removes what an interruption left.
 */

const COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

export type GitCheckout = {
  /** The checked subdirectory in the copy: a real directory reached through no link. */
  directory: string;
  /** The commit the checkout was verified to be at. */
  commit: string;
  /** The copy's staging directory. The caller removes it through the lock holder. */
  staging: string;
};

type GitRun = (args: string[], cwd: string) => Promise<RunResult>;

/**
 * Copy a directory tree without following a link anywhere (`openat`-style: every name is
 * opened relative to its parent's descriptor with `O_NOFOLLOW`). A directory, file or link
 * that is swapped while the copy runs makes it fail instead of leading it elsewhere. Links are
 * copied as links, as Git checked them out; nothing they point at is read. Anything that is
 * not a directory, a regular file or a link is refused. The target must not exist.
 */
const COPY_SOURCE = `
# aelix-studio-copy-tree
import json, os, stat, sys

NOFOLLOW = os.O_NOFOLLOW
DIRECTORY = os.O_DIRECTORY
CLOEXEC = getattr(os, 'O_CLOEXEC', 0)
LIMIT = 500000

class Refused(Exception):
    pass

count = 0

def copy_file(name, src, dst, mode):
    s = os.open(name, os.O_RDONLY | NOFOLLOW | CLOEXEC, dir_fd=src)
    try:
        if not stat.S_ISREG(os.fstat(s).st_mode):
            raise Refused('an entry of the repository changed while it was copied')
        d = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | NOFOLLOW | CLOEXEC,
                    0o755 if mode & 0o111 else 0o644, dir_fd=dst)
        try:
            while True:
                chunk = os.read(s, 1 << 20)
                if not chunk:
                    break
                view = memoryview(chunk)
                while view:
                    view = view[os.write(d, view):]
        finally:
            os.close(d)
    finally:
        os.close(s)

def copy_tree(src, dst, depth):
    global count
    if depth > 128:
        raise Refused('the repository is nested too deeply')
    with os.scandir(src) as entries:
        names = sorted(entry.name for entry in entries)
    for name in names:
        count += 1
        if count > LIMIT:
            raise Refused('the repository has too many entries')
        info = os.stat(name, dir_fd=src, follow_symlinks=False)
        if stat.S_ISDIR(info.st_mode):
            os.mkdir(name, 0o755, dir_fd=dst)
            s = os.open(name, os.O_RDONLY | DIRECTORY | NOFOLLOW | CLOEXEC, dir_fd=src)
            try:
                d = os.open(name, os.O_RDONLY | DIRECTORY | NOFOLLOW | CLOEXEC, dir_fd=dst)
                try:
                    copy_tree(s, d, depth + 1)
                finally:
                    os.close(d)
            finally:
                os.close(s)
        elif stat.S_ISREG(info.st_mode):
            copy_file(name, src, dst, info.st_mode)
        elif stat.S_ISLNK(info.st_mode):
            os.symlink(os.readlink(name, dir_fd=src), name, dir_fd=dst)
        else:
            raise Refused('the repository holds an entry that is not a file, a directory or a link')

source, target = sys.argv[1], sys.argv[2]
try:
    needed = (os.open, os.stat, os.mkdir, os.symlink, os.readlink)
    if os.name == 'nt' or not all(call in os.supports_dir_fd for call in needed) or os.scandir not in os.supports_fd:
        raise Refused('copying without following links is not supported here')
    root = os.open(source, os.O_RDONLY | DIRECTORY | NOFOLLOW | CLOEXEC)
    try:
        os.mkdir(target, 0o700)
        out = os.open(target, os.O_RDONLY | DIRECTORY | NOFOLLOW | CLOEXEC)
        try:
            copy_tree(root, out, 0)
        finally:
            os.close(out)
    finally:
        os.close(root)
    print(json.dumps({'ok': True}), flush=True)
except Refused as error:
    print(json.dumps({'ok': False, 'refused': str(error)}), flush=True)
    sys.exit(3)
except OSError as error:
    print(json.dumps({'ok': False, 'error': type(error).__name__}), flush=True)
    sys.exit(4)
`;

function failure(result: RunResult, what: string): ExtensionFailure {
  if (result.cancelled) return new ExtensionFailure('CANCELLED');
  const output = redactUrlCredentials(result.output);
  if (result.timedOut) return new ExtensionFailure('TIMEOUT', [`${what} took too long`], output);
  return new ExtensionFailure('GIT_FETCH_FAILED', [`${what} ended with exit code ${String(result.code)}`], output);
}

/** The copier's own reason, or a general one when it could not give any. */
function copyRefusal(output: string): string {
  try {
    const answer = JSON.parse(output.split('\n').findLast((line) => line.startsWith('{')) ?? '{}') as {
      refused?: unknown;
    };
    if (typeof answer.refused === 'string') return answer.refused;
  } catch {
    // Not an answer of the copier.
  }
  return 'the checkout could not be copied without following links';
}

/** The last line Git printed: the output mixes stdout and stderr, and a warning may come first. */
const lastLine = (result: RunResult): string =>
  result.code === 0 ? (result.output.trim().split('\n').at(-1) ?? '').trim() : '';

/** The commit a revision names in the clone, or undefined when it names none. */
async function resolveCommit(git: GitRun, checkout: string, revision: string): Promise<string | undefined> {
  const result = await git(['rev-parse', '--verify', '--quiet', `${revision}^{commit}`], checkout);
  if (result.cancelled || result.timedOut) throw failure(result, 'resolving the revision');
  const commit = lastLine(result);
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
 * Check out `commit` and make sure the checkout is at it. A plain `git checkout <name>`
 * prefers a local branch of that name, and a repository can name its default branch after the
 * object name of another commit; `<object>^{commit}` is never a branch name, so `--detach`
 * takes the object. HEAD is read back afterwards and must be that very commit.
 */
async function checkoutCommit(git: GitRun, checkout: string, commit: string): Promise<string> {
  const checkedOut = await git(['checkout', '--quiet', '--detach', `${commit}^{commit}`], checkout);
  if (checkedOut.code !== 0) throw failure(checkedOut, 'checking out the revision');
  const head = await git(['rev-parse', '--verify', '--quiet', 'HEAD'], checkout);
  if (head.cancelled || head.timedOut) throw failure(head, 'reading the checked-out commit');
  if (lastLine(head) !== commit)
    throw new ExtensionFailure('GIT_FETCH_FAILED', ['the checkout is not at the selected commit']);
  return commit;
}

/**
 * Copy `source` to the new directory `target` with the bundled interpreter, never following a
 * link (see `COPY_SOURCE`). `source` itself must not be a link either.
 *
 * @throws ExtensionFailure `SUBDIRECTORY_INVALID`, `CANCELLED`, `TIMEOUT`
 */
export async function copyWithoutLinks(
  context: Pick<FlowContext, 'spawn' | 'signal' | 'bundle' | 'base'>,
  source: string,
  target: string,
  timeoutMs: number
): Promise<void> {
  const copied = await runToExit(
    context.spawn,
    {
      command: context.bundle.python,
      args: ['-I', '-S', '-B', '-X', 'utf8', '-c', COPY_SOURCE, source, target],
      env: context.base,
    },
    { timeoutMs, signal: context.signal }
  );
  if (copied.cancelled) throw new ExtensionFailure('CANCELLED');
  if (copied.timedOut) throw new ExtensionFailure('TIMEOUT', ['copying the checkout took too long']);
  if (copied.code !== 0) throw new ExtensionFailure('SUBDIRECTORY_INVALID', [copyRefusal(copied.output)]);
}

/**
 * Check a requested subdirectory against a checkout on disk: the checkout's root must be the
 * real directory its path names, every name on the way must be a real directory (not a link,
 * not a junction), and the real path of the result must be exactly the root joined with the
 * requested names. That also refuses a name whose spelling differs from the one on disk,
 * which a case-insensitive file system would accept.
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
  const root = path.resolve(checkout);
  const rootStats = await lstat(root).catch((): undefined => undefined);
  if (!rootStats?.isDirectory() || (await realpath(root)) !== root)
    throw refuse('is in a checkout that is not where its path says');
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
 * Fetch the repository of a git source, check out the requested revision detached and verify
 * it, initialize the submodules inside the subdirectory and check the subdirectory. Then copy
 * the whole checkout (with its Git metadata, which some builds read) into a new staging
 * directory without following links, remove the clone, and check the subdirectory again in
 * the copy. The copy is what native installs from: nothing that happens to the clone after
 * the check can change what is built.
 *
 * @throws ExtensionFailure `GIT_FETCH_FAILED`, `SUBDIRECTORY_INVALID`, `CANCELLED`, `TIMEOUT`
 */
export async function checkoutSubdirectory(
  context: Pick<FlowContext, 'spawn' | 'signal' | 'bundle' | 'layout' | 'base'>,
  writer: StateWriter,
  env: Record<string, string>,
  source: Extract<OnlineExtensionSource, { kind: 'git' }> & { subdirectory: string },
  timeoutMs: number
): Promise<GitCheckout> {
  const { layout } = context;
  const suffix = randomBytes(6).toString('hex');
  const clone = path.join(layout.artifacts, `.staging-git-${suffix}`);
  const copy = path.join(layout.artifacts, `.staging-source-${suffix}`);
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
  const discard = async (directory: string): Promise<void> => {
    await removeFromState(layout, writer, directory).catch(() => {});
  };
  try {
    const { repository, revision } = gitLocation(source);
    // pip clones the same way: without blobs it does not need yet (a server that cannot filter
    // sends everything). No checkout yet: the revision decides what is checked out.
    const cloned = await git(
      ['clone', '--quiet', '--filter=blob:none', '--no-checkout', '--', repository, clone],
      layout.artifacts
    );
    if (cloned.code !== 0) throw failure(cloned, 'fetching the repository');
    const commit = await checkoutCommit(git, clone, await revisionCommit(git, clone, revision));
    // Checked before and after the submodules: a missing path is the subdirectory's fault, not
    // the submodule step's, and the submodules fill in only gitlinks below a checked directory.
    await checkSubdirectory(clone, source.subdirectory);
    const submodules = await lstat(path.join(clone, '.gitmodules')).catch((): undefined => undefined);
    if (submodules?.isFile()) {
      const updated = await git(
        ['submodule', 'update', '--init', '--recursive', '--quiet', '--', source.subdirectory],
        clone
      );
      if (updated.code !== 0) throw failure(updated, 'fetching the submodules of the subdirectory');
      await checkSubdirectory(clone, source.subdirectory);
    }
    await copyWithoutLinks(context, clone, copy, timeoutMs);
    await discard(clone);
    return { directory: await checkSubdirectory(copy, source.subdirectory), commit, staging: copy };
  } catch (error) {
    await discard(clone);
    await discard(copy);
    throw error;
  }
}
