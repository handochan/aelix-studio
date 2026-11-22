/**
 * Online installs through the helper service with the user's extension settings (Studio #32
 * 1b): the stored settings, the proxy, private Git and git subdirectories. The bundled runtime
 * is the fake one; Studio's own Git steps run the real `git` against local repositories.
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createFakeBundle,
  fakeRuntime,
  installWheel,
  type FakeRuntimeOptions,
} from '../../../../tests/fixtures/extensionRuntime';
import { writeWheel } from '../../../../tests/fixtures/extensionWheels';
import { ExtensionService, type ExtensionServiceOptions } from '../../service';
import type { ExtensionListing, ExtensionOperation, ExtensionReply, ExtensionSettingsState } from '../../types';

const run = promisify(execFile);
const OWNER = 'window:1';
const PROXY = 'http://proxy.corp.example:3128';

// POSIX paths and the real `git`; git installs are not offered on Windows.
describe.skipIf(process.platform === 'win32')('online installs with the extension settings', () => {
  let scratch = '';
  let root = '';
  let runtime: FakeRuntimeOptions;
  let spawn: ReturnType<typeof fakeRuntime>;
  let service: ExtensionService;
  const start = (options: Partial<ExtensionServiceOptions> = {}): ExtensionService =>
    new ExtensionService({ runtime: runtime.bundle, root, spawn, env: { PATH: '/usr/bin' }, ...options });
  beforeEach(async () => {
    scratch = await realpath(await mkdtemp(path.join(os.tmpdir(), 'studio-online-')));
    root = path.join(scratch, 'user data', 'aelix-runtime');
    runtime = { bundle: await createFakeBundle(path.join(scratch, 'bundle')) };
    spawn = fakeRuntime(runtime);
    service = start();
  });
  afterEach(async () => {
    await service.dispose();
    await rm(scratch, { recursive: true, force: true });
  });

  const data = <T>(reply: ExtensionReply): T => {
    if (reply.ok === false) throw new Error(`request failed: ${reply.code} ${(reply.detail ?? []).join('; ')}`);
    return reply.data as T;
  };
  const settings = async (target = service): Promise<ExtensionSettingsState> =>
    data<ExtensionSettingsState>(await target.request(OWNER, { action: 'get_settings' }));
  const save = (change: unknown, target = service): Promise<ExtensionReply> =>
    target.request(OWNER, { action: 'set_settings', settings: change });
  const settle = async (reply: ExtensionReply): Promise<ExtensionOperation> => {
    let state = data<ExtensionOperation>(reply);
    for (let round = 0; round < 1000 && !['switched', 'failed', 'cancelled'].includes(state.phase); round += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      state = data<ExtensionOperation>(
        await service.request(OWNER, { action: 'poll', operationId: state.operationId })
      );
    }
    return state;
  };
  const listing = async (): Promise<ExtensionListing> =>
    data<ExtensionListing>(await service.request(OWNER, { action: 'list' }));
  const installer = () => spawn.calls.find((call) => call.args.includes('install') && call.args.includes('native'));
  /** An index install whose installer puts a fixture wheel in place. */
  const installFromIndex = async (): Promise<ExtensionOperation> => {
    const wheel = await writeWheel(path.join(scratch, 'wheels'), { name: 'demo-one', version: '1.0.0' });
    runtime.install = async (venv) => {
      await installWheel(venv, wheel);
      return 0;
    };
    return settle(await service.request(OWNER, { action: 'install', source: { kind: 'index', name: 'demo-one' } }));
  };

  describe('settings', () => {
    it('are the defaults until saved, and reading them creates nothing', async () => {
      expect(await settings()).toEqual({
        settings: { onlineInstall: true, proxy: null, privateGit: false, proxyAuthentication: false },
        unreadable: false,
        onlineInstallLocked: false,
        credentialMode: 'memory-only',
        hasSavedCredentials: false,
      });
      expect(await readdir(scratch)).not.toContain('user data');
      expect(spawn.calls).toEqual([]);
    });

    it('are saved under the lock, changing only the fields given, and read back by another service', async () => {
      expect(data(await save({ proxy: 'HTTP://Proxy.Corp.Example:3128/', privateGit: true }))).toEqual({
        settings: { onlineInstall: true, proxy: PROXY, privateGit: true, proxyAuthentication: false },
        unreadable: false,
        onlineInstallLocked: false,
        credentialMode: 'memory-only',
        hasSavedCredentials: false,
      });
      expect(spawn.calls.filter((call) => call.args.includes('hold'))).toHaveLength(1);
      expect(data(await save({ onlineInstall: false }))).toMatchObject({
        settings: { onlineInstall: false, proxy: PROXY, privateGit: true },
      });
      expect((await settings(start())).settings).toEqual({
        onlineInstall: false,
        proxy: PROXY,
        privateGit: true,
        proxyAuthentication: false,
      });
      expect(data(await save({ proxy: null }))).toMatchObject({ settings: { proxy: null } });
    });

    it('report a Studio policy that keeps online installs off', async () => {
      service = start({ onlineInstallEnabled: false });
      expect(await settings()).toMatchObject({ settings: { onlineInstall: true }, onlineInstallLocked: true });
    });

    it.each([
      ['INVALID_PROXY', { proxy: 'proxy.corp.example:3128' }],
      ['INVALID_PROXY', { proxy: 'http://:hunter2@proxy.corp.example:3128' }],
      ['INVALID_INPUT', { proxy: null, proxyAuthentication: true }],
      ['INVALID_INPUT', { proxy: 'http://proxy.corp.example', unknown: true }],
      ['INVALID_INPUT', {}],
      ['INVALID_INPUT', 'privateGit'],
    ])('refuse a change with %s before anything starts, and never repeat the proxy', async (code, change) => {
      const reply = await save(change);
      expect(reply).toMatchObject({ ok: false, code });
      expect(JSON.stringify(reply)).not.toMatch(/hunter2|alice|corp\.example/);
      expect(spawn.calls).toEqual([]);
    });

    it('cannot be saved while another change runs, which keeps the settings it started with', async () => {
      let release = (): void => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      runtime.install = async () => {
        await gate;
        return 1;
      };
      const running = await service.request(OWNER, { action: 'install', source: { kind: 'index', name: 'demo-one' } });
      expect(await save({ proxy: PROXY })).toEqual({ ok: false, code: 'BUSY' });
      release();
      expect(await settle(running)).toMatchObject({ code: 'INSTALLER_FAILED' });
      expect(installer()?.env).not.toHaveProperty('PIP_PROXY');
    });

    it('that cannot be read keep online installs closed until saved again', async () => {
      await mkdir(root, { recursive: true });
      await writeFile(path.join(root, 'settings.json'), '{ damaged');
      expect(await settings()).toMatchObject({
        settings: { onlineInstall: false, proxy: null, privateGit: false, proxyAuthentication: false },
        unreadable: true,
      });
      const named = { action: 'install', source: { kind: 'index', name: 'demo-one' } };
      expect(await service.request(OWNER, named)).toEqual({ ok: false, code: 'SETTINGS_UNREADABLE' });
      expect(spawn.calls).toEqual([]);
      // A change starts from the closed settings; the screen sends every field after `unreadable`.
      expect(data(await save({ proxy: PROXY }))).toMatchObject({
        settings: { onlineInstall: false, proxy: PROXY, privateGit: false, proxyAuthentication: false },
        unreadable: false,
      });
    });
  });

  describe('online installs', () => {
    it('are refused before anything starts when the user turned them off', async () => {
      data(await save({ onlineInstall: false }));
      const before = spawn.calls.length;
      const git = { action: 'install', source: { kind: 'git', url: 'git+https://git.invalid/owner/demo.git' } };
      for (const source of [{ kind: 'index', name: 'demo-one' }, git.source])
        expect(await service.request(OWNER, { action: 'install', source })).toEqual({
          ok: false,
          code: 'ONLINE_INSTALL_DISABLED',
        });
      expect(spawn.calls.length).toBe(before);
    });

    it('are refused under the lock when another Studio process turned them off in between', async () => {
      runtime.lock = (child) => {
        // The other process saves its settings while this change waits for the lock.
        runtime.lock = undefined;
        void (async () => {
          await mkdir(root, { recursive: true });
          await writeFile(
            path.join(root, 'settings.json'),
            JSON.stringify({
              schema: 'aelix.studio.extensions.settings/1',
              onlineInstall: false,
              proxy: null,
              privateGit: false,
            })
          );
          child.print('held\n');
        })();
      };
      const state = await settle(
        await service.request(OWNER, { action: 'install', source: { kind: 'index', name: 'demo-one' } })
      );
      expect(state).toMatchObject({ phase: 'failed', code: 'ONLINE_INSTALL_DISABLED' });
      expect(installer()).toBeUndefined();
    });

    it('send pip and Git through the proxy the user typed', async () => {
      data(await save({ proxy: PROXY }));
      expect(await installFromIndex()).toMatchObject({ phase: 'switched' });
      expect(installer()?.env).toMatchObject({
        PIP_PROXY: PROXY,
        http_proxy: PROXY,
        https_proxy: PROXY,
        HTTP_PROXY: PROXY,
        HTTPS_PROXY: PROXY,
        no_proxy: '',
        GIT_CONFIG_KEY_1: 'http.proxy',
        GIT_CONFIG_VALUE_1: PROXY,
      });
      // The proxy is in the settings file only, not in what the generation records.
      expect(JSON.stringify(await listing())).not.toContain('proxy.corp.example');
    });

    it('connect directly without a proxy, and never through a system or environment one', async () => {
      service = start({ env: { PATH: '/usr/bin', HTTPS_PROXY: 'http://ambient.invalid:8080' } });
      expect(await installFromIndex()).toMatchObject({ phase: 'switched' });
      const env = installer()?.env ?? {};
      expect(env.no_proxy).toBe('*');
      expect(Object.keys(env).filter((name) => /^(PIP_PROXY|https?_proxy|all_proxy)$/i.test(name))).toEqual([]);
    });

    it('leave a file import offline behind the dead proxy, whatever proxy the user typed', async () => {
      data(await save({ proxy: PROXY, privateGit: true }));
      const wheel = await writeWheel(path.join(scratch, 'wheels'), { name: 'demo-file' });
      expect(
        await settle(await service.request(OWNER, { action: 'install', source: { kind: 'file', path: wheel } }))
      ).toMatchObject({ phase: 'switched' });
      const env = installer()?.env ?? {};
      expect(env).toMatchObject({
        PIP_NO_INDEX: '1',
        HTTP_PROXY: 'http://127.0.0.1:9',
        HTTPS_PROXY: 'http://127.0.0.1:9',
        https_proxy: 'http://127.0.0.1:9',
      });
      expect(env).not.toHaveProperty('PIP_PROXY');
      expect(env).not.toHaveProperty('PIP_INDEX_URL');
      expect(env).not.toHaveProperty('SSH_AUTH_SOCK');
      expect(spawn.calls.some((call) => call.command === 'git')).toBe(false);
    });
  });

  describe('private Git', () => {
    const user = { PATH: '/usr/bin', HOME: '/Users/someone', SSH_AUTH_SOCK: '/private/tmp/agent.sock' };
    const answerGitConfig = (): void => {
      runtime.git = (spec, child) => {
        if (spec.args[0] === 'config') child.print('credential.helper\nosxkeychain\0alias.st\nstatus\0');
        child.exit(0);
      };
    };

    it('stays out while off: no agent, no credential lookup, the isolated SSH command', async () => {
      service = start({ env: user });
      answerGitConfig();
      expect(await installFromIndex()).toMatchObject({ phase: 'switched' });
      expect(spawn.calls.some((call) => call.command === 'git')).toBe(false);
      expect(installer()?.env).not.toHaveProperty('SSH_AUTH_SOCK');
      expect(installer()?.env.GIT_SSH_COMMAND).toContain('-o IdentityAgent=none');
    });

    it('when on, still keeps a name install as isolated as before: it has no repository to sign in to', async () => {
      service = start({ env: { ...user, DBUS_SESSION_BUS_ADDRESS: 'x' } });
      answerGitConfig();
      data(await save({ privateGit: true }));
      expect(await installFromIndex()).toMatchObject({ phase: 'switched' });
      expect(spawn.calls.some((call) => call.command === 'git')).toBe(false);
      const env = installer()?.env ?? {};
      for (const name of ['SSH_AUTH_SOCK', 'GCM_INTERACTIVE', 'DBUS_SESSION_BUS_ADDRESS'])
        expect(env).not.toHaveProperty(name);
      expect(env.GIT_SSH_COMMAND).toContain('-o IdentityAgent=none');
      expect(Object.values(env)).not.toContain('osxkeychain');
      expect(env).toMatchObject({ GIT_CONFIG_KEY_4: 'protocol.ssh.allow', GIT_CONFIG_VALUE_4: 'user' });
    });

    it('when on, passes the agent and the user credential helpers to a git install, and nothing else', async () => {
      service = start({ env: { ...user, GIT_SSH_COMMAND: 'ssh -i /elsewhere', DBUS_SESSION_BUS_ADDRESS: 'x' } });
      answerGitConfig();
      data(await save({ privateGit: true }));
      const url = 'https://git.invalid/owner/demo.git';
      const wheel = await writeWheel(path.join(scratch, 'wheels'), { name: 'demo-git' });
      runtime.install = async (venv) => {
        await installWheel(venv, wheel);
        await writeFile(
          path.join(venv.site, 'demo_git-0.1.0.dist-info', 'direct_url.json'),
          JSON.stringify({ url, vcs_info: { vcs: 'git', commit_id: '2'.repeat(40) } })
        );
        return 0;
      };
      const request = { action: 'install', source: { kind: 'git', url: 'git+' + url } };
      expect(await settle(await service.request(OWNER, request))).toMatchObject({ phase: 'switched' });
      const lookup = spawn.calls.find((call) => call.command === 'git');
      expect(lookup?.env.HOME).toBe('/Users/someone');
      expect(installer()?.env).toMatchObject({
        SSH_AUTH_SOCK: '/private/tmp/agent.sock',
        GCM_INTERACTIVE: 'never',
        GIT_SSH_COMMAND: '/usr/bin/ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o UpdateHostKeys=no',
        GIT_CONFIG_COUNT: '8',
        GIT_CONFIG_KEY_4: 'protocol.ssh.allow',
        GIT_CONFIG_VALUE_4: 'always',
        GIT_CONFIG_KEY_7: 'credential.helper',
        GIT_CONFIG_VALUE_7: 'osxkeychain',
        GIT_CONFIG_GLOBAL: '/dev/null',
      });
      // The installer keeps its private home; the user's netrc and Git files stay out.
      expect(installer()?.env.HOME).not.toBe('/Users/someone');
      // Only Linux secret-service helpers need the session bus.
      expect(installer()?.env.DBUS_SESSION_BUS_ADDRESS).toBe(process.platform === 'linux' ? 'x' : undefined);
    });
  });

  describe('git subdirectories', () => {
    let repository = '';
    let commit = '';
    const git = async (cwd: string, ...args: string[]): Promise<string> =>
      (
        await run('git', ['-c', 'user.name=Studio Test', '-c', 'user.email=studio@test.invalid', ...args], {
          cwd,
          env: { PATH: '/usr/bin:/bin', HOME: scratch, GIT_CONFIG_NOSYSTEM: '1' },
        })
      ).stdout.trim();
    beforeEach(async () => {
      repository = path.join(scratch, 'repo');
      await mkdir(path.join(repository, 'packages', 'demo'), { recursive: true });
      await writeFile(path.join(repository, 'packages', 'demo', 'pyproject.toml'), '[project]\nname = "demo-sub"\n');
      await mkdir(path.join(scratch, 'outside'));
      await symlink(path.join(scratch, 'outside'), path.join(repository, 'packages', 'escape'));
      await git(scratch, 'init', '--quiet', '--initial-branch=main', repository);
      await git(repository, 'add', '-A');
      await git(repository, 'commit', '--quiet', '-m', 'first');
      commit = await git(repository, 'rev-parse', 'HEAD');
    });
    const request = (subdirectory: unknown) => ({
      action: 'install',
      source: { kind: 'git', url: 'git+' + pathToFileURL(repository).href + '@main', subdirectory },
    });

    it('installs from a checked copy of Studio checkout and records repository, verified commit and path', async () => {
      const wheel = await writeWheel(path.join(scratch, 'wheels'), { name: 'demo-sub' });
      let target = '';
      let stagedDuringInstall: string[] = [];
      runtime.install = async (venv, requested) => {
        target = requested;
        stagedDuringInstall = await readdir(path.join(root, 'artifacts'));
        await installWheel(venv, wheel);
        await writeFile(
          path.join(venv.site, 'demo_sub-0.1.0.dist-info', 'direct_url.json'),
          JSON.stringify({ url: pathToFileURL(requested).href, dir_info: {} })
        );
        return 0;
      };
      const state = await settle(await service.request(OWNER, request('packages/demo')));
      expect(state).toMatchObject({ phase: 'switched' });
      // native installs from the copy; the clone is already gone by then.
      const artifacts = await realpath(path.join(root, 'artifacts'));
      expect(stagedDuringInstall).toEqual([expect.stringMatching(/^\.staging-source-[0-9a-f]{12}$/)]);
      expect(target).toBe(path.join(artifacts, stagedDuringInstall[0], 'packages', 'demo'));
      expect(installer()?.args.slice(-3)).toEqual(['install', target, '--yes']);
      // The lock holder removed both staging directories; nothing stays in the generation either.
      const removals = spawn.children
        .filter((_child, index) => spawn.calls[index].args.includes('hold'))
        .flatMap((child) => child.written)
        .join('');
      expect(removals).toContain(`"path":"artifacts/${stagedDuringInstall[0]}"`);
      expect(removals).toMatch(/"path":"artifacts\/\.staging-git-[0-9a-f]{12}"/);
      expect(await readdir(artifacts)).toEqual([]);
      expect(await readdir(path.join(root, 'generations', state.generation ?? '', 'install-work'))).toEqual([]);
      expect((await listing()).extensions[0].origin).toEqual({
        kind: 'git',
        url: 'git+' + pathToFileURL(repository).href + '@main',
        commit,
        indexUrl: 'https://pypi.org/simple/',
        subdirectory: 'packages/demo',
      });
      const record = JSON.parse(
        await readFile(path.join(root, 'generations', state.generation ?? '', 'generation.json'), 'utf8')
      ) as { distributions: Record<string, { origin?: { subdirectory?: string } }> };
      expect(record.distributions['demo-sub'].origin?.subdirectory).toBe('packages/demo');
    });

    it('hides credentials in what the installer printed, such as a submodule address Git repeats', async () => {
      runtime.nativeOutput =
        "fatal: clone of 'https://x-token:ghp_abcdef@git.example.com/o/sub.git' into submodule path failed\n";
      runtime.install = async () => 1;
      const url = 'git+https://git.invalid/owner/demo.git';
      const state = await settle(await service.request(OWNER, { action: 'install', source: { kind: 'git', url } }));
      expect(state).toMatchObject({ phase: 'failed', code: 'INSTALLER_FAILED' });
      expect(state.output).toContain("'https://***@git.example.com/o/sub.git'");
      expect(JSON.stringify(state)).not.toMatch(/ghp_abcdef|x-token/);
    });

    it('refuses a subdirectory that is a link in the checkout before the installer starts', async () => {
      runtime.install = async () => {
        throw new Error('the installer must not run');
      };
      const state = await settle(await service.request(OWNER, request('packages/escape')));
      expect(state).toMatchObject({
        phase: 'failed',
        code: 'SUBDIRECTORY_INVALID',
        detail: ['the subdirectory passes through a link'],
      });
      expect(installer()).toBeUndefined();
      expect(await readdir(path.join(root, 'generations'))).toEqual([]);
      expect(await readdir(path.join(root, 'artifacts'))).toEqual([]);
    });

    it('keeps the old generation when the installed distribution does not record the checked directory', async () => {
      const wheel = await writeWheel(path.join(scratch, 'wheels'), { name: 'demo-sub' });
      runtime.install = async (venv) => {
        await installWheel(venv, wheel);
        await writeFile(
          path.join(venv.site, 'demo_sub-0.1.0.dist-info', 'direct_url.json'),
          JSON.stringify({ url: pathToFileURL(path.join(scratch, 'outside')).href, dir_info: {} })
        );
        return 0;
      };
      expect(await settle(await service.request(OWNER, request('packages/demo')))).toMatchObject({
        phase: 'failed',
        code: 'REQUEST_MISMATCH',
      });
      expect((await listing()).current).toBeNull();
    });

    it.each([
      '../outside',
      '/etc',
      'packages/../..',
      'packages//demo',
      '.git',
      'packages\\demo',
      'C:/x',
      'packages/demo[extra]',
      '-option',
      '',
      7,
    ])('refuses the subdirectory %j before anything starts', async (subdirectory) => {
      expect(await service.request(OWNER, request(subdirectory))).toEqual({ ok: false, code: 'INVALID_INPUT' });
      expect(spawn.calls).toEqual([]);
    });
  });
});
