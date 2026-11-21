import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnChild } from '../../process';
import { ExtensionFailure } from '../../types';
import { checkSubdirectory, checkoutSubdirectory } from './checkout';

const run = promisify(execFile);

/** Git sources are not offered on Windows; everything here runs the real `git`. */
describe.skipIf(process.platform === 'win32')('fetching a git source and checking its subdirectory', () => {
  let scratch = '';
  let repository = '';
  let outside = '';
  let commits: Record<string, string> = {};
  let made = 0;
  /** An installer-like environment: no user configuration, and file submodules allowed only where a test says. */
  const environment = (extra: Record<string, string> = {}): Record<string, string> => ({
    PATH: '/usr/bin:/bin',
    HOME: path.join(scratch, 'home'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    ...extra,
  });
  const git = async (cwd: string, ...args: string[]): Promise<string> =>
    (
      await run('git', ['-c', 'user.name=Studio Test', '-c', 'user.email=studio@test.invalid', ...args], {
        cwd,
        env: environment(),
      })
    ).stdout.trim();
  const fresh = async (): Promise<string> => {
    made += 1;
    const work = path.join(scratch, 'work-' + String(made));
    await mkdir(work);
    return path.join(work, 'checkout');
  };
  const source = (subdirectory: string, revision = '', url = pathToFileURL(repository).href) => ({
    kind: 'git' as const,
    url: 'git+' + url + revision,
    subdirectory,
  });
  const fetch = async (
    subdirectory: string,
    revision = '',
    options: { env?: Record<string, string>; url?: string; signal?: AbortSignal } = {}
  ) =>
    checkoutSubdirectory(
      { spawn: spawnChild, signal: options.signal },
      options.env ?? environment(),
      source(subdirectory, revision, options.url),
      await fresh(),
      30_000
    );
  const refusal = async (work: Promise<unknown>): Promise<ExtensionFailure> => {
    const error = await work.catch((caught: unknown) => caught);
    if (!(error instanceof ExtensionFailure)) throw new Error(`expected a failure, got ${String(error)}`);
    return error;
  };

  beforeAll(async () => {
    scratch = await realpath(await mkdtemp(path.join(os.tmpdir(), 'studio-checkout-')));
    await mkdir(path.join(scratch, 'home'));
    outside = path.join(scratch, 'outside');
    await mkdir(outside);
    await writeFile(path.join(outside, 'pyproject.toml'), '[project]\nname = "outside"\n');
    repository = path.join(scratch, 'repo');
    await mkdir(path.join(repository, 'packages', 'demo'), { recursive: true });
    await mkdir(path.join(repository, 'packages', 'Mixed'), { recursive: true });
    await writeFile(path.join(repository, 'packages', 'demo', 'pyproject.toml'), '[project]\nname = "demo"\n');
    await writeFile(path.join(repository, 'packages', 'Mixed', 'pyproject.toml'), '[project]\nname = "mixed"\n');
    await writeFile(path.join(repository, 'packages', 'plain-file'), 'not a directory\n');
    // Links a pip checkout would follow: one leaving the repository, one inside it, one in the middle of a path.
    await symlink(outside, path.join(repository, 'packages', 'escape'));
    await symlink('demo', path.join(repository, 'packages', 'alias'));
    await symlink('packages', path.join(repository, 'linked'));
    await git(scratch, 'init', '--quiet', '--initial-branch=main', repository);
    await git(repository, 'add', '-A');
    await git(repository, 'commit', '--quiet', '-m', 'first');
    commits.first = await git(repository, 'rev-parse', 'HEAD');
    await git(repository, 'tag', 'v1');
    await git(repository, 'checkout', '--quiet', '-b', 'stable');
    await mkdir(path.join(repository, 'packages', 'later'));
    await writeFile(path.join(repository, 'packages', 'later', 'pyproject.toml'), '[project]\nname = "later"\n');
    await git(repository, 'add', '-A');
    await git(repository, 'commit', '--quiet', '-m', 'second');
    commits.stable = await git(repository, 'rev-parse', 'HEAD');
    await git(repository, 'checkout', '--quiet', 'main');
  }, 60_000);
  afterAll(async () => {
    if (scratch) await rm(scratch, { recursive: true, force: true });
    commits = {};
  });

  it('checks out the default branch and returns the checked directory and the commit', async () => {
    const checkout = await fetch('packages/demo');
    expect(checkout.commit).toBe(commits.first);
    expect(checkout.directory).toBe(path.join(checkout.root, 'packages', 'demo'));
    expect((await lstat(path.join(checkout.directory, 'pyproject.toml'))).isFile()).toBe(true);
  });

  it.each([
    ['a branch', '@stable', 'stable'],
    ['a tag', '@v1', 'first'],
    ['a full commit', () => '@' + commits.stable, 'stable'],
    ['an abbreviated commit', () => '@' + commits.stable.slice(0, 10), 'stable'],
  ])('resolves %s the way pip does', async (_case, revision, expected) => {
    const checkout = await fetch('packages/demo', typeof revision === 'function' ? revision() : revision);
    expect(checkout.commit).toBe(commits[expected]);
  });

  it('finds a directory only the requested revision has', async () => {
    expect((await fetch('packages/later', '@stable')).commit).toBe(commits.stable);
    expect((await refusal(fetch('packages/later'))).code).toBe('SUBDIRECTORY_INVALID');
  });

  it.each([
    ['a link that leaves the repository', 'packages/escape', 'passes through a link'],
    ['a link to a directory inside the repository', 'packages/alias', 'passes through a link'],
    ['a path through a linked directory', 'linked/demo', 'passes through a link'],
    ['a file', 'packages/plain-file', 'is not a directory'],
    ['a missing path', 'packages/missing', 'does not exist in the repository'],
  ])('refuses %s', async (_case, subdirectory, reason) => {
    const failure = await refusal(fetch(subdirectory));
    expect([failure.code, failure.detail]).toEqual(['SUBDIRECTORY_INVALID', [`the subdirectory ${reason}`]]);
  });

  it('refuses a spelling other than the one on disk, also where the file system ignores case', async () => {
    expect((await refusal(fetch('packages/mixed'))).code).toBe('SUBDIRECTORY_INVALID');
    expect((await fetch('packages/Mixed')).directory.endsWith(path.join('packages', 'Mixed'))).toBe(true);
  });

  it('refuses relative escapes, absolute paths and the repository metadata even past the request parser', async () => {
    const checkout = await fetch('packages/demo');
    for (const subdirectory of ['../outside', 'packages/../..', '/etc', 'packages//demo', '.', '.git', 'x/.GIT'])
      expect((await refusal(checkSubdirectory(checkout.root, subdirectory))).code).toBe('SUBDIRECTORY_INVALID');
  });

  it('reports a revision the repository does not have as a fetch failure', async () => {
    expect((await refusal(fetch('packages/demo', '@no-such-branch'))).code).toBe('GIT_FETCH_FAILED');
    expect((await refusal(fetch('packages/demo', '@' + 'a'.repeat(40)))).code).toBe('GIT_FETCH_FAILED');
  });

  it('reports a repository it cannot fetch with the end of what Git said', async () => {
    const failure = await refusal(fetch('packages/demo', '', { url: pathToFileURL(path.join(scratch, 'none')).href }));
    expect(failure.code).toBe('GIT_FETCH_FAILED');
    expect(failure.output).toMatch(/repository|not found|does not exist/i);
  });

  it('initializes submodules before the check, and checks paths inside them too', async () => {
    const module = path.join(scratch, 'module');
    await mkdir(path.join(module, 'pkg'), { recursive: true });
    await writeFile(path.join(module, 'pkg', 'pyproject.toml'), '[project]\nname = "inner"\n');
    await symlink(outside, path.join(module, 'escape'));
    await git(scratch, 'init', '--quiet', '--initial-branch=main', module);
    await git(module, 'add', '-A');
    await git(module, 'commit', '--quiet', '-m', 'module');
    const parent = path.join(scratch, 'parent');
    await git(scratch, 'init', '--quiet', '--initial-branch=main', parent);
    await git(
      parent,
      '-c',
      'protocol.file.allow=always',
      'submodule',
      'add',
      '--quiet',
      pathToFileURL(module).href,
      'vendor'
    );
    await git(parent, 'commit', '--quiet', '-m', 'parent');
    // Git's default refuses file:// submodules; a remote submodule would be fetched the same way.
    const allowFile = environment({
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'protocol.file.allow',
      GIT_CONFIG_VALUE_0: 'always',
    });
    const url = pathToFileURL(parent).href;
    const checkout = await fetch('vendor/pkg', '', { env: allowFile, url });
    expect((await lstat(path.join(checkout.directory, 'pyproject.toml'))).isFile()).toBe(true);
    expect((await refusal(fetch('vendor/escape', '', { env: allowFile, url }))).code).toBe('SUBDIRECTORY_INVALID');
    expect((await refusal(fetch('vendor/pkg', '', { url }))).code).toBe('GIT_FETCH_FAILED');
  });

  it('stops when cancelled', async () => {
    const abort = new AbortController();
    abort.abort();
    expect((await refusal(fetch('packages/demo', '', { signal: abort.signal }))).code).toBe('CANCELLED');
  });
});
