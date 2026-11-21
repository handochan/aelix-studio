import { execFile, spawnSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { directWriter, scriptedSpawn } from '../../../../tests/fixtures/extensionRuntime';
import { spawnChild, type Spawn } from '../../process';
import { layoutOf, type Bundle, type Layout } from '../../store/layout';
import { ExtensionFailure } from '../../types';
import { baseEnvironment, managementEnvironment } from '../environment';
import { checkSubdirectory, checkoutSubdirectory, COPY_SOURCE, copyWithoutLinks } from './checkout';

const run = promisify(execFile);
/** The no-follow copy is plain Python; the system interpreter runs it as the bundled one would. */
const PYTHON = spawnSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).stdout?.trim();

/** Git sources are not offered on Windows; everything here runs the real `git` and Python. */
describe.skipIf(process.platform === 'win32' || !PYTHON)('fetching a git source and checking its subdirectory', () => {
  let scratch = '';
  let repository = '';
  let outside = '';
  let layout: Layout;
  let commits: Record<string, string> = {};
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
  const context = (spawn: Spawn = spawnChild, signal?: AbortSignal) => ({
    spawn,
    signal,
    layout,
    bundle: { python: PYTHON ?? '' } as Bundle,
    base: { PATH: '/usr/bin:/bin', PYTHONDONTWRITEBYTECODE: '1' },
  });
  const source = (subdirectory: string, revision = '', url = pathToFileURL(repository).href) => ({
    kind: 'git' as const,
    url: 'git+' + url + revision,
    subdirectory,
  });
  const fetch = async (
    subdirectory: string,
    revision = '',
    options: { env?: Record<string, string>; url?: string; signal?: AbortSignal; spawn?: Spawn } = {}
  ) =>
    checkoutSubdirectory(
      context(options.spawn, options.signal),
      directWriter(layout.root),
      options.env ?? environment(),
      source(subdirectory, revision, options.url),
      30_000
    );
  const refusal = async (work: Promise<unknown>): Promise<ExtensionFailure> => {
    const error = await work.catch((caught: unknown) => caught);
    if (!(error instanceof ExtensionFailure)) throw new Error(`expected a failure, got ${String(error)}`);
    return error;
  };
  const staged = async (): Promise<string[]> => (await readdir(layout.artifacts)).toSorted();
  const clearStaging = async (): Promise<void> => {
    for (const entry of await readdir(layout.artifacts))
      await rm(path.join(layout.artifacts, entry), { recursive: true });
  };

  beforeAll(async () => {
    scratch = await realpath(await mkdtemp(path.join(os.tmpdir(), 'studio-checkout-')));
    await mkdir(path.join(scratch, 'home'));
    layout = layoutOf(path.join(scratch, 'aelix-runtime'));
    await mkdir(layout.artifacts, { recursive: true });
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
    // A link inside the project: the copy keeps it as a link and reads nothing through it.
    await symlink(path.join(outside, 'pyproject.toml'), path.join(repository, 'packages', 'demo', 'outside-link'));
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

  it('copies the checkout without the clone, and returns the checked directory and the commit', async () => {
    await clearStaging();
    const checkout = await fetch('packages/demo');
    expect(checkout.commit).toBe(commits.first);
    expect(checkout.directory).toBe(path.join(checkout.staging, 'packages', 'demo'));
    expect(path.dirname(checkout.staging)).toBe(layout.artifacts);
    // Only the copy is left; the lock holder removed the clone.
    expect(await staged()).toEqual([path.basename(checkout.staging)]);
    expect(path.basename(checkout.staging)).toMatch(/^\.staging-source-[0-9a-f]{12}$/);
    expect((await lstat(path.join(checkout.directory, 'pyproject.toml'))).isFile()).toBe(true);
    // Git metadata comes along, for builds that read their version from it.
    expect((await lstat(path.join(checkout.staging, '.git'))).isDirectory()).toBe(true);
    const link = path.join(checkout.directory, 'outside-link');
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readlink(link)).toBe(path.join(outside, 'pyproject.toml'));
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

  it('checks out the selected commit even when a branch is named after it', async () => {
    // The default branch, which a clone checks out as a local branch, carries the object name
    // of another commit. `git checkout <name>` would take that branch.
    const tricky = path.join(scratch, 'tricky');
    await git(scratch, 'init', '--quiet', '--initial-branch=main', tricky);
    await mkdir(path.join(tricky, 'pkg'));
    await writeFile(path.join(tricky, 'pkg', 'which'), 'selected\n');
    await git(tricky, 'add', '-A');
    await git(tricky, 'commit', '--quiet', '-m', 'selected');
    const selected = await git(tricky, 'rev-parse', 'HEAD');
    await git(tricky, 'branch', 'stable');
    await writeFile(path.join(tricky, 'pkg', 'which'), 'impostor\n');
    await git(tricky, 'commit', '--quiet', '-am', 'impostor');
    await git(tricky, 'branch', '-m', 'main', selected);
    const checkout = await fetch('pkg', '@stable', { url: pathToFileURL(tricky).href });
    expect(checkout.commit).toBe(selected);
    expect(await readFile(path.join(checkout.directory, 'which'), 'utf8')).toBe('selected\n');
  });

  it('takes a requested full commit as that object, even when a branch and a tag carry its name', async () => {
    const shadowed = path.join(scratch, 'shadowed');
    await git(scratch, 'init', '--quiet', '--initial-branch=main', shadowed);
    await mkdir(path.join(shadowed, 'pkg'));
    await writeFile(path.join(shadowed, 'pkg', 'which'), 'requested\n');
    await git(shadowed, 'add', '-A');
    await git(shadowed, 'commit', '--quiet', '-m', 'requested');
    const requested = await git(shadowed, 'rev-parse', 'HEAD');
    await writeFile(path.join(shadowed, 'pkg', 'which'), 'impostor\n');
    await git(shadowed, 'commit', '--quiet', '-am', 'impostor');
    // Both names pip would look up first point at the impostor commit.
    await git(shadowed, 'branch', requested, 'HEAD');
    await git(shadowed, 'tag', requested, 'HEAD');
    const checkout = await fetch('pkg', '@' + requested, { url: pathToFileURL(shadowed).href });
    expect(checkout.commit).toBe(requested);
    expect(await readFile(path.join(checkout.directory, 'which'), 'utf8')).toBe('requested\n');
  });

  it('takes 40 hex digits in a SHA-256 repository as an abbreviation, and 64 as the object', async () => {
    const sha256 = path.join(scratch, 'sha256');
    await git(scratch, 'init', '--quiet', '--object-format=sha256', '--initial-branch=main', sha256);
    await mkdir(path.join(sha256, 'pkg'));
    await writeFile(path.join(sha256, 'pkg', 'which'), 'sha256\n');
    await git(sha256, 'add', '-A');
    await git(sha256, 'commit', '--quiet', '-m', 'sha256');
    const object = await git(sha256, 'rev-parse', 'HEAD');
    expect(object).toHaveLength(64);
    const url = pathToFileURL(sha256).href;
    expect((await fetch('pkg', '@' + object.slice(0, 40), { url })).commit).toBe(object);
    expect((await fetch('pkg', '@' + object, { url })).commit).toBe(object);
  });

  it('reads Git answers from stdout, so a late warning on stderr does not send it fetching', async () => {
    const requested = 'a'.repeat(40);
    const spawn = scriptedSpawn((spec, child) => {
      const args = spec.args.join(' ');
      if (spec.args[0] === 'clone') {
        void mkdir(path.join(spec.args.at(-1) ?? '', 'packages', 'demo'), { recursive: true }).then(() =>
          child.exit(0)
        );
        return;
      }
      if (args === 'rev-parse --show-object-format') child.print('sha1\n');
      if (args === `cat-file -t ${requested}`) {
        child.print('commit\n');
        child.complain('warning: a late note\n');
      }
      // Stop after the decision, with an answer that cannot match the requested commit.
      if (args === 'rev-parse --verify --quiet HEAD') child.print('b'.repeat(40) + '\n');
      child.exit(0);
    });
    const failure = await refusal(fetch('packages/demo', '@' + requested, { spawn }));
    expect(failure.detail).toEqual(['the checkout is not at the selected commit']);
    expect(spawn.calls.map((call) => call.args[0])).not.toContain('fetch');
    expect(spawn.calls.find((call) => call.args[0] === 'checkout')?.args).toEqual([
      'checkout',
      '--quiet',
      '--detach',
      requested + '^{commit}',
    ]);
  });

  it('refuses a checkout whose HEAD is not the selected commit', async () => {
    await clearStaging();
    const answers: Record<string, string> = {
      'rev-parse --verify --quiet HEAD^{commit}': 'a'.repeat(40),
      'rev-parse --verify --quiet HEAD': 'b'.repeat(40),
    };
    const spawn = scriptedSpawn((spec, child) => {
      if (spec.command !== 'git') throw new Error('nothing else may start');
      if (spec.args[0] === 'clone') void mkdir(spec.args.at(-1) ?? '', { recursive: true }).then(() => child.exit(0));
      else {
        child.print((answers[spec.args.join(' ')] ?? '') + '\n');
        child.exit(0);
      }
    });
    const failure = await refusal(fetch('packages/demo', '', { spawn }));
    expect([failure.code, failure.detail]).toEqual([
      'GIT_FETCH_FAILED',
      ['the checkout is not at the selected commit'],
    ]);
    expect(spawn.calls.map((call) => call.args[0])).toEqual(['clone', 'rev-parse', 'checkout', 'rev-parse']);
    expect(spawn.calls[2].args).toEqual(['checkout', '--quiet', '--detach', 'a'.repeat(40) + '^{commit}']);
    expect(await staged()).toEqual([]);
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
  ])('refuses %s and leaves nothing staged', async (_case, subdirectory, reason) => {
    await clearStaging();
    const failure = await refusal(fetch(subdirectory));
    expect([failure.code, failure.detail]).toEqual(['SUBDIRECTORY_INVALID', [`the subdirectory ${reason}`]]);
    expect(await staged()).toEqual([]);
  });

  it('refuses a spelling other than the one on disk, also where the file system ignores case', async () => {
    expect((await refusal(fetch('packages/mixed'))).code).toBe('SUBDIRECTORY_INVALID');
    expect((await fetch('packages/Mixed')).directory.endsWith(path.join('packages', 'Mixed'))).toBe(true);
  });

  it('refuses relative escapes, absolute paths, the repository metadata and a linked root past the parser', async () => {
    const checkout = await fetch('packages/demo');
    for (const subdirectory of ['../outside', 'packages/../..', '/etc', 'packages//demo', '.', '.git', 'x/.GIT'])
      expect((await refusal(checkSubdirectory(checkout.staging, subdirectory))).code).toBe('SUBDIRECTORY_INVALID');
    const linkedRoot = path.join(scratch, 'linked-root');
    await symlink(checkout.staging, linkedRoot);
    expect((await refusal(checkSubdirectory(linkedRoot, 'packages/demo'))).detail).toEqual([
      'the subdirectory is in a checkout that is not where its path says',
    ]);
  });

  it('copies without following a link, and refuses a linked source and what is neither file, directory nor link', async () => {
    const tree = path.join(scratch, 'copy-source');
    await mkdir(path.join(tree, 'nested'), { recursive: true });
    await writeFile(path.join(tree, 'nested', 'file'), 'content\n');
    await symlink(outside, path.join(tree, 'nested', 'away'));
    const target = path.join(scratch, 'copy-target');
    await copyWithoutLinks(context(), tree, target, 10_000);
    expect(await readFile(path.join(target, 'nested', 'file'), 'utf8')).toBe('content\n');
    expect((await lstat(path.join(target, 'nested', 'away'))).isSymbolicLink()).toBe(true);
    expect(await readdir(target)).toEqual(['nested']);

    const linked = path.join(scratch, 'copy-linked');
    await symlink(tree, linked);
    expect((await refusal(copyWithoutLinks(context(), linked, path.join(scratch, 'copy-2'), 10_000))).code).toBe(
      'SUBDIRECTORY_INVALID'
    );
    await run('mkfifo', [path.join(tree, 'nested', 'pipe')]);
    expect((await refusal(copyWithoutLinks(context(), tree, path.join(scratch, 'copy-3'), 10_000))).detail).toEqual([
      'the repository holds an entry that is not a file, a directory or a link',
    ]);
  });

  it('refuses, without waiting, a name that turned into a FIFO between listing and opening', async () => {
    const tree = path.join(scratch, 'fifo-race');
    await mkdir(tree);
    await run('mkfifo', [path.join(tree, 'late')]);
    // The listing says regular file (as it did before the swap); the open must decide.
    const harness = `
import os, signal, stat, sys
namespace = {'__name__': 'copy_test'}
exec(sys.argv[1], namespace)
real = os.stat
def listed(name, *args, **kwargs):
    info = real(name, *args, **kwargs)
    if name == 'late':
        return os.stat_result((stat.S_IFREG | 0o644,) + tuple(info)[1:])
    return info
namespace['os'].stat = listed
signal.alarm(5)
src = os.open(sys.argv[2], os.O_RDONLY | os.O_DIRECTORY)
os.mkdir(sys.argv[3])
dst = os.open(sys.argv[3], os.O_RDONLY | os.O_DIRECTORY)
try:
    namespace['copy_tree'](src, dst, 0)
    print('copied')
except namespace['Refused'] as error:
    print('refused:', error)
`;
    const { stdout } = await run(
      PYTHON ?? 'python3',
      ['-I', '-S', '-B', '-c', harness, COPY_SOURCE, tree, path.join(scratch, 'fifo-copy')],
      {
        timeout: 15_000,
      }
    );
    expect(stdout.trim()).toBe('refused: an entry of the repository changed while it was copied');
    expect(await readdir(path.join(scratch, 'fifo-copy'))).toEqual([]);
  });

  it('reports a revision the repository does not have as a fetch failure', async () => {
    expect((await refusal(fetch('packages/demo', '@no-such-branch'))).code).toBe('GIT_FETCH_FAILED');
    expect((await refusal(fetch('packages/demo', '@' + 'a'.repeat(40)))).code).toBe('GIT_FETCH_FAILED');
  });

  it('reports a repository it cannot fetch with the end of what Git said, and leaves nothing staged', async () => {
    await clearStaging();
    const failure = await refusal(fetch('packages/demo', '', { url: pathToFileURL(path.join(scratch, 'none')).href }));
    expect(failure.code).toBe('GIT_FETCH_FAILED');
    expect(failure.output).toMatch(/repository|not found|does not exist/i);
    expect(await staged()).toEqual([]);
  });

  it('hides credentials of addresses in what Git said', async () => {
    const spawn = scriptedSpawn((_spec, child) => {
      child.complain(
        "fatal: unable to access 'https://user:ghp_secret@git.example.com/o/r.git/': Could not resolve host\n" +
          "fatal: clone of 'https://ghp_token@git.example.com/o/s.git' failed; ssh://git:pass@host/x\n"
      );
      child.exit(128);
    });
    const failure = await refusal(fetch('packages/demo', '', { spawn }));
    expect(failure.output).not.toMatch(/ghp_secret|ghp_token|:pass@|user:/);
    expect(failure.output).toContain('https://***@git.example.com/o/r.git/');
    expect(failure.output).toContain('ssh://***@host/x');
  });

  describe('submodules', () => {
    let parent = '';
    /** Git refuses file:// submodules by default; a remote submodule would be fetched the same way. */
    const allowFile = (): Record<string, string> =>
      environment({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'protocol.file.allow', GIT_CONFIG_VALUE_0: 'always' });
    const submodule = async (name: string, files: Record<string, string>): Promise<string> => {
      const module = path.join(scratch, name);
      for (const [file, content] of Object.entries(files)) {
        await mkdir(path.dirname(path.join(module, file)), { recursive: true });
        await writeFile(path.join(module, file), content);
      }
      await git(scratch, 'init', '--quiet', '--initial-branch=main', module);
      await git(module, 'add', '-A');
      await git(module, 'commit', '--quiet', '-m', name);
      return pathToFileURL(module).href;
    };
    beforeAll(async () => {
      const inner = await submodule('inner-module', { 'lib/code.py': 'inner\n' });
      const other = await submodule('other-module', { readme: 'other\n' });
      parent = path.join(scratch, 'parent');
      await mkdir(path.join(parent, 'pkg'), { recursive: true });
      await writeFile(path.join(parent, 'pkg', 'pyproject.toml'), '[project]\nname = "pkg"\n');
      await git(scratch, 'init', '--quiet', '--initial-branch=main', parent);
      const add = (url: string, where: string) =>
        git(parent, '-c', 'protocol.file.allow=always', 'submodule', 'add', '--quiet', url, where);
      await add(inner, 'pkg/vendor');
      await add(other, 'unrelated');
      await git(parent, 'add', '-A');
      await git(parent, 'commit', '--quiet', '-m', 'parent');
    }, 60_000);

    it('reports a missing subdirectory as such in a repository with submodules', async () => {
      const failure = await refusal(fetch('missing', '', { env: allowFile(), url: pathToFileURL(parent).href }));
      expect([failure.code, failure.detail]).toEqual([
        'SUBDIRECTORY_INVALID',
        ['the subdirectory does not exist in the repository'],
      ]);
    });

    it('initializes the submodules inside the subdirectory and no other', async () => {
      const checkout = await fetch('pkg', '', { env: allowFile(), url: pathToFileURL(parent).href });
      expect(await readFile(path.join(checkout.directory, 'vendor', 'lib', 'code.py'), 'utf8')).toBe('inner\n');
      expect(await readdir(path.join(checkout.staging, 'unrelated'))).toEqual([]);
    });

    describe('a subdirectory inside a submodule', () => {
      let nested = '';
      beforeAll(async () => {
        // nested: vendor -> middle (pkg/, pkg/deep -> deepest, other -> other-of-middle, escape -> outside)
        const deepest = await submodule('deepest-module', { 'code.py': 'deepest\n' });
        const otherOfMiddle = await submodule('other-of-middle', { readme: 'not needed\n' });
        const middle = path.join(scratch, 'middle-module');
        await mkdir(path.join(middle, 'pkg'), { recursive: true });
        await writeFile(path.join(middle, 'pkg', 'pyproject.toml'), '[project]\nname = "middle"\n');
        await symlink(outside, path.join(middle, 'escape'));
        await git(scratch, 'init', '--quiet', '--initial-branch=main', middle);
        const addTo = (repository: string, url: string, where: string) =>
          git(repository, '-c', 'protocol.file.allow=always', 'submodule', 'add', '--quiet', url, where);
        await addTo(middle, deepest, 'pkg/deep');
        await addTo(middle, otherOfMiddle, 'other');
        await git(middle, 'add', '-A');
        await git(middle, 'commit', '--quiet', '-m', 'middle');
        const unrelated = await submodule('unrelated-of-nested', { readme: 'not needed\n' });
        nested = path.join(scratch, 'nested');
        await mkdir(nested);
        await writeFile(path.join(nested, 'README'), 'nested\n');
        await git(scratch, 'init', '--quiet', '--initial-branch=main', nested);
        await addTo(nested, pathToFileURL(middle).href, 'vendor');
        await addTo(nested, unrelated, 'unrelated');
        await git(nested, 'add', '-A');
        await git(nested, 'commit', '--quiet', '-m', 'nested');
      }, 60_000);
      const fetchNested = (subdirectory: string) =>
        fetch(subdirectory, '', { env: allowFile(), url: pathToFileURL(nested).href });

      it('initializes the submodules on the way, then those inside it, and no other', async () => {
        const checkout = await fetchNested('vendor/pkg');
        expect(await readFile(path.join(checkout.directory, 'pyproject.toml'), 'utf8')).toContain('middle');
        expect(await readFile(path.join(checkout.directory, 'deep', 'code.py'), 'utf8')).toBe('deepest\n');
        expect(await readdir(path.join(checkout.staging, 'vendor', 'other'))).toEqual([]);
        expect(await readdir(path.join(checkout.staging, 'unrelated'))).toEqual([]);
      });

      it('takes a submodule as the subdirectory with every submodule inside it', async () => {
        const checkout = await fetchNested('vendor');
        expect(await readFile(path.join(checkout.directory, 'pkg', 'deep', 'code.py'), 'utf8')).toBe('deepest\n');
        expect(await readFile(path.join(checkout.directory, 'other', 'readme'), 'utf8')).toBe('not needed\n');
        expect(await readdir(path.join(checkout.staging, 'unrelated'))).toEqual([]);
      });

      it('still refuses a link inside the submodule and a missing name in it', async () => {
        expect((await refusal(fetchNested('vendor/escape'))).detail).toEqual([
          'the subdirectory passes through a link',
        ]);
        expect((await refusal(fetchNested('vendor/missing'))).detail).toEqual([
          'the subdirectory does not exist in the repository',
        ]);
      });

      it('keeps the transport policy for submodules on the way', async () => {
        const policy = managementEnvironment(
          baseEnvironment({ PATH: '/usr/bin:/bin' }, process.platform),
          process.platform,
          {
            agentDirectory: path.join(scratch, 'agent'),
            nativeSite: '/bundle/native-site',
            constraintsUrl: 'file:///constraints.txt',
            online: { indexUrl: 'https://index.invalid/simple/', home: path.join(scratch, 'home'), work: scratch },
          }
        );
        const failure = await refusal(fetch('vendor/pkg', '', { env: policy, url: pathToFileURL(nested).href }));
        expect([failure.code, failure.detail]).toEqual([
          'GIT_FETCH_FAILED',
          ['fetching a submodule on the way to the subdirectory ended with exit code 1'],
        ]);
        expect(failure.output).toMatch(/transport 'file' not allowed/);
      });
    });

    it('fetches no submodule over a transport the installer policy keeps from submodules', async () => {
      const policy = managementEnvironment(
        baseEnvironment({ PATH: '/usr/bin:/bin' }, process.platform),
        process.platform,
        {
          agentDirectory: path.join(scratch, 'agent'),
          nativeSite: '/bundle/native-site',
          constraintsUrl: 'file:///constraints.txt',
          online: { indexUrl: 'https://index.invalid/simple/', home: path.join(scratch, 'home'), work: scratch },
        }
      );
      const failure = await refusal(fetch('pkg', '', { env: policy, url: pathToFileURL(parent).href }));
      expect([failure.code, failure.detail]).toEqual([
        'GIT_FETCH_FAILED',
        ['fetching the submodules of the subdirectory ended with exit code 1'],
      ]);
      expect(failure.output).toMatch(/transport 'file' not allowed/);
    });
  });

  it('stops when cancelled', async () => {
    const abort = new AbortController();
    abort.abort();
    expect((await refusal(fetch('packages/demo', '', { signal: abort.signal }))).code).toBe('CANCELLED');
  });
});
