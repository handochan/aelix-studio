import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scriptedSpawn } from '../../../../tests/fixtures/extensionRuntime';
import { spawnChild } from '../../process';
import { parseCredentialEntries, privateGitAccess, privateGitEnvironment } from './credentials';

const run = promisify(execFile);

const USER: NodeJS.ProcessEnv = {
  HOME: '/Users/someone',
  XDG_CONFIG_HOME: '/Users/someone/.config',
  SSH_AUTH_SOCK: '/private/tmp/agent.sock',
  DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/501/bus',
  SSH_AGENT_PID: '42',
  GIT_SSH_COMMAND: 'ssh -i /elsewhere/key',
  GIT_CONFIG_GLOBAL: '/elsewhere/gitconfig',
  HTTPS_PROXY: 'http://ambient.invalid:3128',
  ANTHROPIC_API_KEY: 'secret',
};

describe('what private Git takes from the user environment', () => {
  it('keeps the agent, the home for reading Git configuration, and nothing else', () => {
    expect(privateGitEnvironment(USER, 'darwin')).toEqual({
      HOME: '/Users/someone',
      XDG_CONFIG_HOME: '/Users/someone/.config',
      SSH_AUTH_SOCK: '/private/tmp/agent.sock',
    });
  });

  it('also keeps the session bus on Linux, where secret-service helpers need it', () => {
    expect(privateGitEnvironment(USER, 'linux')).toMatchObject({
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/501/bus',
    });
  });

  it('keeps nothing on Windows, where git installs are not offered', () => {
    expect(privateGitEnvironment(USER, 'win32')).toEqual({});
  });

  it('skips empty values', () => {
    expect(privateGitEnvironment({ HOME: '', SSH_AUTH_SOCK: '' }, 'darwin')).toEqual({});
  });
});

describe('the credential entries Git reports', () => {
  it('keeps credential entries in order, reads a name without a value as true, and drops anything else', () => {
    const output =
      'credential.helper\nosxkeychain\0' +
      'credential.helper\n\0' +
      'credential.https://git.example.com.helper\n/usr/local/bin/git-credential-manager\0' +
      'credential.usehttppath\0' +
      'alias.st\nstatus\0' +
      'core.sshcommand\nssh -i /elsewhere/key\0';
    expect(parseCredentialEntries(output)).toEqual([
      ['credential.helper', 'osxkeychain'],
      ['credential.helper', ''],
      ['credential.https://git.example.com.helper', '/usr/local/bin/git-credential-manager'],
      ['credential.usehttppath', 'true'],
    ]);
  });

  it('keeps at most 64 entries', () => {
    expect(parseCredentialEntries('credential.helper\nx\0'.repeat(80))).toHaveLength(64);
  });
});

describe('reading the user credential configuration', () => {
  it('asks Git for credential entries only, with the user home, from a directory where no repository is found', async () => {
    const spawn = scriptedSpawn((_spec, child) => {
      child.print('credential.helper\nosxkeychain\0');
      child.exit(0);
    });
    const access = await privateGitAccess(
      { spawn, user: privateGitEnvironment(USER, 'darwin') },
      '/data/generations/g1/install-home',
      5000
    );
    expect(access).toEqual({
      sshAuthSock: '/private/tmp/agent.sock',
      credentials: [['credential.helper', 'osxkeychain']],
    });
    expect(spawn.calls).toEqual([
      {
        command: 'git',
        args: ['config', '--null', '--get-regexp', '^credential\\.'],
        cwd: '/data/generations/g1/install-home',
        env: {
          PATH: '/usr/bin:/bin',
          HOME: '/Users/someone',
          XDG_CONFIG_HOME: '/Users/someone/.config',
          LC_ALL: 'C',
          GIT_CEILING_DIRECTORIES: '/data/generations/g1',
          GIT_TERMINAL_PROMPT: '0',
        },
      },
    ]);
  });

  it.each([
    ['no entry (exit 1)', 1],
    ['a configuration Git cannot read (exit 128)', 128],
  ])('uses no helper for %s', async (_case, code) => {
    const spawn = scriptedSpawn((_spec, child) => {
      child.print('credential.helper\nhalf');
      child.exit(code);
    });
    expect(
      (await privateGitAccess({ spawn, user: { HOME: '/home/someone' } }, '/data/x/home', 5000)).credentials
    ).toEqual([]);
  });

  it('starts nothing without a home to read from', async () => {
    const spawn = scriptedSpawn((_spec, child) => child.exit(0));
    expect(await privateGitAccess({ spawn, user: { SSH_AUTH_SOCK: '/tmp/a' } }, '/data/x/home', 5000)).toEqual({
      sshAuthSock: '/tmp/a',
      credentials: [],
    });
    expect(spawn.calls).toEqual([]);
  });
});

describe.skipIf(process.platform === 'win32')('reading the credential configuration with the real Git', () => {
  let scratch = '';
  beforeAll(async () => {
    scratch = await realpath(await mkdtemp(path.join(os.tmpdir(), 'studio-credentials-')));
  });
  afterAll(async () => {
    if (scratch) await rm(scratch, { recursive: true, force: true });
  });

  it('returns the global credential entries and includes, but no other setting and nothing of a repository', async () => {
    const home = path.join(scratch, 'home');
    await mkdir(home);
    await writeFile(path.join(home, 'included'), '[credential "https://git.example.com"]\n\tusername = someone\n');
    await writeFile(
      path.join(home, '.gitconfig'),
      `[include]\n\tpath = ${path.join(home, 'included')}\n[credential]\n\thelper = /opt/example/git-credential-example\n[alias]\n\tst = status\n[core]\n\tsshCommand = ssh -i /elsewhere/key\n`
    );
    // The candidate directory sits inside a repository whose own configuration names a helper.
    const repository = path.join(scratch, 'repository');
    await mkdir(repository);
    await run('git', ['init', '--quiet', repository], { env: { PATH: '/usr/bin:/bin', HOME: home } });
    await run('git', ['config', 'credential.helper', 'repository-helper'], {
      cwd: repository,
      env: { PATH: '/usr/bin:/bin', HOME: home },
    });
    const cwd = path.join(repository, 'generations', 'g1', 'install-home');
    await mkdir(cwd, { recursive: true });
    const { credentials } = await privateGitAccess({ spawn: spawnChild, user: { HOME: home } }, cwd, 10_000);
    expect(credentials).toEqual(
      expect.arrayContaining([
        ['credential.helper', '/opt/example/git-credential-example'],
        ['credential.https://git.example.com.username', 'someone'],
      ])
    );
    expect(credentials.every(([name]) => name.startsWith('credential.'))).toBe(true);
    expect(credentials.map(([, value]) => value)).not.toContain('repository-helper');
  });
});
