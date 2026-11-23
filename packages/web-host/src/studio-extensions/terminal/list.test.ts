/**
 * The read-only list of the terminal CLI's extensions (ADR 9, 2026-11-22 user decision 4):
 * every environment found by uv, pipx or a launcher, the global directory, from files only.
 */
import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, readdir, readFile, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cliVenv, launcherScript, link, ranAnything, write } from '../../../tests/fixtures/terminalCli';
import { ENVIRONMENT_LIMIT, labelPath, listTerminalCli } from './list';

const venvModule = vi.hoisted(() => ({ failFor: undefined as string | undefined }));
vi.mock('./venv', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./venv')>();
  return {
    ...actual,
    readCliVenv: async (root: string, platform?: NodeJS.Platform) => {
      if (venvModule.failFor && root.endsWith(venvModule.failFor)) throw new Error(`cannot read ${root}`);
      return actual.readCliVenv(root, platform);
    },
  };
});

const posix = process.platform !== 'win32';

describe.runIf(posix)('the terminal CLI list', () => {
  let scratch = '';
  let home = '';
  beforeEach(async () => {
    scratch = await realpath(await mkdtemp(path.join(os.tmpdir(), 'studio-terminal-list-')));
    home = path.join(scratch, 'home', 'alice');
    venvModule.failFor = undefined;
  });
  afterEach(() => rm(scratch, { recursive: true, force: true }));

  const list = (env: NodeJS.ProcessEnv = {}, deadlineMs?: number) =>
    listTerminalCli({
      env,
      home,
      platform: 'linux',
      username: 'alice',
      ...(deadlineMs === undefined ? {} : { deadlineMs }),
    });

  it('lists every environment found, once, with how it was found, and reads nothing it runs', async () => {
    // uv tool, linked from ~/.local/bin as uv does.
    const uvTool = path.join(home, '.local', 'share', 'uv', 'tools', 'aelix');
    await cliVenv(uvTool, scratch, { 'aelix-memory': 'aelix-memory', 'aelix-webtool': 'aelix-webtool' });
    await link(path.join(uvTool, 'bin', 'aelix'), path.join(home, '.local', 'bin', 'aelix'));
    // Another uv tool without the CLI is passed over.
    await cliVenv(path.join(home, '.local', 'share', 'uv', 'tools', 'ruff'), scratch, {}, { cli: false });
    // pipx, under its Linux default home.
    await cliVenv(path.join(home, '.local', 'share', 'pipx', 'venvs', 'aelix'), scratch, { 'aelix-notes': 'notes' });
    // pip into a virtual environment elsewhere, with a launcher on Studio's PATH.
    const project = path.join(scratch, 'srv', 'alice', 'venv');
    await cliVenv(project, scratch);
    const projectBin = path.join(scratch, 'opt', 'project-bin');
    await write(path.join(projectBin, 'aelix'), launcherScript(path.join(project, 'bin', 'python'), scratch));
    // pip into a Python that is not a virtual environment.
    const userBin = path.join(scratch, 'opt', 'user-bin');
    await write(path.join(userBin, 'aelix'), launcherScript('/usr/bin/python3', scratch));
    // A launcher through env, and a link loop.
    const envBin = path.join(scratch, 'opt', 'env-bin');
    await write(path.join(envBin, 'aelix'), '#!/usr/bin/env python3\n');
    const loopBin = path.join(scratch, 'opt', 'loop-bin');
    await link(path.join(loopBin, 'aelix'), path.join(loopBin, 'aelix'));
    // A FIFO where a launcher would be: never waited on.
    const fifoBin = path.join(scratch, 'opt', 'fifo-bin');
    await write(path.join(fifoBin, '.keep'));
    execFileSync('mkfifo', [path.join(fifoBin, 'aelix')]);
    for (const launcher of [path.join(projectBin, 'aelix'), path.join(userBin, 'aelix'), path.join(envBin, 'aelix')])
      await chmod(launcher, 0o755);

    const listing = await list({ PATH: [projectBin, userBin, envBin, loopBin, fifoBin].join(':') });
    const at = (target: string): string => target.replace(scratch, '<scratch>');
    expect(
      listing.environments.map((environment) => ({
        ...environment,
        location: at(environment.location),
        launchers: environment.launchers.map(at),
      }))
    ).toEqual([
      {
        status: 'listed',
        location: '~/.local/share/uv/tools/aelix',
        foundBy: ['uv_tool', 'launcher'],
        launchers: ['~/.local/bin/aelix'],
        nativeVersion: '0.1.0b2',
        extensions: [
          { name: 'aelix-memory', distribution: 'aelix-memory', version: '1.0.0', reference: 'aelix_memory:setup' },
          { name: 'aelix-webtool', distribution: 'aelix-webtool', version: '1.0.0', reference: 'aelix_webtool:setup' },
        ],
        issues: [],
        truncated: false,
      },
      {
        status: 'listed',
        location: '~/.local/share/pipx/venvs/aelix',
        foundBy: ['pipx'],
        launchers: [],
        nativeVersion: '0.1.0b2',
        extensions: [{ name: 'notes', distribution: 'aelix-notes', version: '1.0.0', reference: 'aelix_notes:setup' }],
        issues: [],
        truncated: false,
      },
      expect.objectContaining({ status: 'unresolved_launcher', location: '<scratch>/opt/env-bin/aelix' }),
      expect.objectContaining({ status: 'unresolved_launcher', location: '<scratch>/opt/fifo-bin/aelix' }),
      expect.objectContaining({ status: 'unreadable', location: '<scratch>/opt/loop-bin/aelix', extensions: [] }),
      // The user name is hidden wherever it is a path segment, home or not.
      expect.objectContaining({
        status: 'listed',
        location: '<scratch>/srv/<user>/venv',
        foundBy: ['launcher'],
        launchers: ['<scratch>/opt/project-bin/aelix'],
      }),
      expect.objectContaining({
        status: 'not_a_venv',
        location: '/usr/bin/python3',
        launchers: ['<scratch>/opt/user-bin/aelix'],
        extensions: [],
      }),
    ]);
    expect(listing.globalExtensions).toEqual({
      location: '~/.aelix/agent/extensions',
      status: 'absent',
      extensions: [],
      truncated: false,
    });
    expect(listing.searched).toContain('~/.local/share/uv/tools');
    expect(listing.searched).toContain('~/.aelix/agent/extensions');
    expect(JSON.stringify(listing)).not.toContain('alice');
    expect(listing).toMatchObject({ truncated: false, timedOut: false });
    // No launcher ran, and nothing was written next to what was read.
    expect(ranAnything(scratch)).toBe(false);
    expect((await readdir(path.join(uvTool, 'bin'))).toSorted()).toEqual(['aelix']);
  });

  it('counts an environment reached through links once, by its real path', async () => {
    const realTools = path.join(scratch, 'disk', 'uv-tools');
    await cliVenv(path.join(realTools, 'aelix'), scratch, { 'aelix-memory': 'memory' });
    await link(realTools, path.join(scratch, 'tools-link'));
    await link(path.join(scratch, 'tools-link', 'aelix', 'bin', 'aelix'), path.join(home, '.local', 'bin', 'aelix'));
    const listing = await list({ PATH: '', UV_TOOL_DIR: path.join(scratch, 'tools-link') });
    expect(listing.environments).toHaveLength(1);
    expect(listing.environments[0]).toMatchObject({
      status: 'listed',
      location: path.join(realTools, 'aelix'),
      foundBy: ['uv_tool', 'launcher'],
      launchers: ['~/.local/bin/aelix'],
    });
  });

  it('answers with an empty list and the places it looked when there is no terminal CLI', async () => {
    const listing = await list({ PATH: '' });
    expect(listing.environments).toEqual([]);
    expect(listing.searched).toEqual([
      '~/.local/share/uv/tools',
      '~/.local/share/pipx/venvs',
      '~/.local/pipx/venvs',
      '~/.local/bin',
      '/home/linuxbrew/.linuxbrew/bin',
      '/usr/local/bin',
      '/usr/bin',
      '~/.aelix/agent/extensions',
    ]);
  });

  it('looks in the macOS --user launcher directories too, and reads no Python outside an environment', async () => {
    const launcher = path.join(home, 'Library', 'Python', '3.12', 'bin', 'aelix');
    await write(launcher, launcherScript('/Library/Frameworks/Python.framework/Versions/3.12/bin/python3', scratch));
    const listing = await listTerminalCli({ env: { PATH: '' }, home, platform: 'darwin', username: 'alice' });
    expect(listing.searched).toContain('~/Library/Python/3.12/bin');
    expect(listing.searched.at(-1)).toBe('~/.aelix/agent/extensions');
    expect(listing.environments).toEqual([
      expect.objectContaining({
        status: 'not_a_venv',
        location: '/Library/Frameworks/Python.framework/Versions/3.12/bin/python3',
        launchers: ['~/Library/Python/3.12/bin/aelix'],
      }),
    ]);
    expect(ranAnything(scratch)).toBe(false);
  });

  it('lists the global extension directory of the agent directory Studio sees', async () => {
    await write(path.join(home, 'agents', 'extensions', 'hello.py'), 'def setup(api): pass\n');
    const listing = await list({ PATH: '', AELIX_CODING_AGENT_DIR: '~/agents' });
    expect(listing.globalExtensions).toEqual({
      location: '~/agents/extensions',
      status: 'listed',
      extensions: [{ name: 'hello.py', kind: 'file' }],
      truncated: false,
    });
  });

  it('keeps reading the others when one environment fails, with a code and nothing of the error', async () => {
    await cliVenv(path.join(home, '.local', 'share', 'uv', 'tools', 'aelix'), scratch, { first: 'first' });
    await cliVenv(path.join(home, '.local', 'share', 'pipx', 'venvs', 'aelix'), scratch, { second: 'second' });
    venvModule.failFor = path.join('uv', 'tools', 'aelix');
    const listing = await list({ PATH: '' });
    expect(listing.environments.map((environment) => [environment.status, environment.extensions.length])).toEqual([
      ['unreadable', 0],
      ['listed', 1],
    ]);
    expect(JSON.stringify(listing)).not.toContain('cannot read');
  });

  it(`reads at most ${ENVIRONMENT_LIMIT} environments and says it stopped`, async () => {
    const tools = path.join(home, '.local', 'share', 'uv', 'tools');
    for (let index = 0; index <= ENVIRONMENT_LIMIT; index += 1)
      await cliVenv(path.join(tools, `aelix-${String(index).padStart(2, '0')}`), scratch);
    const listing = await list({ PATH: '' });
    expect(listing.environments).toHaveLength(ENVIRONMENT_LIMIT);
    expect(listing.truncated).toBe(true);
  });

  it('answers at the time limit with what it read, and that answer does not change afterwards', async () => {
    await cliVenv(path.join(home, '.local', 'share', 'uv', 'tools', 'aelix'), scratch, { late: 'late' });
    const listing = await list({ PATH: '' }, 0);
    expect(listing.timedOut).toBe(true);
    const before = JSON.stringify(listing);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(JSON.stringify(listing)).toBe(before);
  });
});

describe('paths in a reply', () => {
  it('writes the home directory as ~ and the user name as <user>, and leaves other paths', () => {
    expect(labelPath('/home/alice/.local/bin/aelix', ['/home/alice'], 'alice', 'linux')).toBe('~/.local/bin/aelix');
    expect(labelPath('/home/alice', ['/home/alice'], 'alice', 'linux')).toBe('~');
    expect(labelPath('/home/alicex/bin', ['/home/alice'], 'alice', 'linux')).toBe('/home/alicex/bin');
    expect(labelPath('/srv/alice/venv', ['/home/alice'], 'alice', 'linux')).toBe('/srv/<user>/venv');
    expect(labelPath('/opt/homebrew/bin/aelix', ['/Users/alice'], 'alice', 'darwin')).toBe('/opt/homebrew/bin/aelix');
    expect(labelPath('/USERS/ALICE/x', ['/Users/alice'], 'alice', 'darwin')).toBe('~/x');
    expect(labelPath('C:\\Users\\Alice\\pipx\\venvs\\aelix', ['C:\\Users\\alice'], 'alice', 'win32')).toBe(
      '~\\pipx\\venvs\\aelix'
    );
    // A home of `/` labels nothing.
    expect(labelPath('/usr/bin/aelix', ['/'], undefined, 'linux')).toBe('/usr/bin/aelix');
  });
});

describe('nothing is run', () => {
  it('has no way to start a process or use the network in the code that reads the terminal CLI', async () => {
    const directory = path.dirname(new URL(import.meta.url).pathname);
    const sources = (await readdir(directory)).filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'));
    expect(sources.toSorted()).toEqual([
      'files.ts',
      'globalDirectory.ts',
      'launcher.ts',
      'list.ts',
      'locations.ts',
      'venv.ts',
    ]);
    for (const name of sources) {
      const text = await readFile(path.join(directory, name), 'utf8');
      expect(text, name).not.toMatch(
        /child_process|node:net|node:http|node:https|node:dgram|\bfetch\(|\bspawn|(?<![.\w])exec(File)?(Sync)?\(|writeFile|appendFile|mkdir|\brm\(|unlink|rename|symlink|chmod/
      );
    }
  });
});
