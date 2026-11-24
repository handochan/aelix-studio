/**
 * The read-only list of the terminal CLI's extensions (ADR 9, 2026-11-22 user decision 4):
 * every environment found by uv, pipx or a launcher, the global directory, from files only,
 * in one bounded scan per process.
 */
import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, readdir, readFile, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cliVenv, distribution, launcherScript, link, ranAnything, write } from '../../../tests/fixtures/terminalCli';

const fsWatch = vi.hoisted(() => ({
  active: 0,
  peak: 0,
  calls: 0,
  delayMs: 0,
  delayFor: '',
  /** Further delays: the first whose text is in the path applies. */
  delays: [] as [string, number][],
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const watched =
    <A extends unknown[], R>(call: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      fsWatch.calls += 1;
      fsWatch.active += 1;
      fsWatch.peak = Math.max(fsWatch.peak, fsWatch.active);
      try {
        const target = String(args[0]);
        const delay =
          fsWatch.delayMs && target.includes(fsWatch.delayFor)
            ? fsWatch.delayMs
            : (fsWatch.delays.find(([part]) => target.includes(part))?.[1] ?? 0);
        if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
        return await call(...args);
      } finally {
        fsWatch.active -= 1;
      }
    };
  return {
    ...actual,
    realpath: watched(actual.realpath as (...args: unknown[]) => Promise<string>),
    stat: watched(actual.stat as (...args: unknown[]) => Promise<unknown>),
    lstat: watched(actual.lstat as (...args: unknown[]) => Promise<unknown>),
    opendir: watched(actual.opendir as (...args: unknown[]) => Promise<unknown>),
  };
});

const venvModule = vi.hoisted(() => ({ failFor: undefined as string | undefined, busyMs: 0 }));
vi.mock('./venv', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./venv')>();
  return {
    ...actual,
    readCliVenv: async (...args: Parameters<typeof actual.readCliVenv>) => {
      if (venvModule.failFor && args[1].endsWith(venvModule.failFor)) throw new Error(`cannot read ${args[1]}`);
      const venv = await actual.readCliVenv(...args);
      // Work after the last file system call, holding the event loop (slow parsing).
      const until = Date.now() + venvModule.busyMs;
      while (Date.now() < until) {
        // busy
      }
      return venv;
    },
  };
});

import { FS_CONCURRENCY } from './files';
import { ENVIRONMENT_LIMIT, environmentKey, labelPath, listTerminalCli, maskText, terminalScanEnded } from './list';

const posix = process.platform !== 'win32';

describe.runIf(posix)('the terminal CLI list', () => {
  let scratch = '';
  let home = '';
  beforeEach(async () => {
    scratch = await realpath(await mkdtemp(path.join(os.tmpdir(), 'studio-terminal-list-')));
    home = path.join(scratch, 'home', 'alice');
    venvModule.failFor = undefined;
    venvModule.busyMs = 0;
    Object.assign(fsWatch, { active: 0, peak: 0, calls: 0, delayMs: 0, delayFor: '', delays: [] });
  });
  afterEach(async () => {
    await terminalScanEnded();
    await rm(scratch, { recursive: true, force: true });
  });

  const list = (env: NodeJS.ProcessEnv = {}, deadlineMs?: number, platform: NodeJS.Platform = 'linux') =>
    listTerminalCli({ env, home, platform, username: 'alice', ...(deadlineMs === undefined ? {} : { deadlineMs }) });

  it('lists every environment found, once, with how it was found, and runs nothing it reads', async () => {
    // uv tool, linked from ~/.local/bin as uv does.
    const uvTool = path.join(home, '.local', 'share', 'uv', 'tools', 'aelix');
    await cliVenv(uvTool, scratch, { 'aelix-memory': 'aelix-memory', 'aelix-webtool': 'aelix-webtool' });
    await link(path.join(uvTool, 'bin', 'aelix'), path.join(home, '.local', 'bin', 'aelix'));
    // Another uv tool without the CLI is passed over.
    await cliVenv(path.join(home, '.local', 'share', 'uv', 'tools', 'ruff'), scratch, {}, { cli: false });
    // pipx, under its Linux default home.
    await cliVenv(path.join(home, '.local', 'share', 'pipx', 'venvs', 'aelix'), scratch, { 'aelix-notes': 'notes' });
    // pip into a virtual environment elsewhere, with a launcher on Studio's PATH.
    const project = path.join(scratch, 'srv', 'project', 'venv');
    await cliVenv(project, scratch);
    const projectBin = path.join(scratch, 'opt', 'project-bin');
    await write(path.join(projectBin, 'aelix'), launcherScript(path.join(project, 'bin', 'python'), scratch));
    // pip into a Python that is not a virtual environment.
    const userBin = path.join(scratch, 'opt', 'user-bin');
    await write(path.join(userBin, 'aelix'), launcherScript('/usr/bin/python3', scratch));
    // A launcher through env, a link loop, and a FIFO where a launcher would be.
    const envBin = path.join(scratch, 'opt', 'env-bin');
    await write(path.join(envBin, 'aelix'), '#!/usr/bin/env python3\n');
    const loopBin = path.join(scratch, 'opt', 'loop-bin');
    await link(path.join(loopBin, 'aelix'), path.join(loopBin, 'aelix'));
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
      expect.objectContaining({
        status: 'listed',
        location: '<scratch>/srv/project/venv',
        foundBy: ['launcher'],
        launchers: ['<scratch>/opt/project-bin/aelix'],
      }),
      expect.objectContaining({ status: 'not_a_venv', location: '/usr/bin/python3', extensions: [] }),
    ]);
    expect(listing.globalExtensions).toEqual({
      location: '~/.aelix/agent/extensions',
      status: 'absent',
      extensions: [],
      truncated: false,
    });
    expect(listing.searched).toContain('~/.local/share/uv/tools');
    expect(listing).toMatchObject({ truncated: false, timedOut: false });
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

  it('hides the home directory and the user name in every field of the answer', async () => {
    const uvTool = path.join(home, '.local', 'share', 'uv', 'tools', 'aelix');
    await cliVenv(uvTool, scratch);
    const site = path.join(uvTool, 'lib', 'python3.12', 'site-packages');
    await distribution(site, 'alice-tools', '1.0', `[aelix.extensions]\nalice = file://${home}/mod:setup\n`);
    await write(path.join(home, '.aelix', 'agent', 'extensions', 'alice_notes.py'));
    const userBin = path.join(scratch, 'opt', 'alice-bin');
    await write(path.join(userBin, 'aelix'), launcherScript(`${home}/../alice/py/../bin/python3`, scratch));
    const listing = await list({ PATH: userBin });
    const text = JSON.stringify(listing);
    expect(text).not.toMatch(/alice/i);
    expect(text).not.toContain(home);
    expect(listing.globalExtensions.extensions).toEqual([{ name: '<user>_notes.py', kind: 'file' }]);
    expect(listing.environments[0].extensions[0]).toMatchObject({
      name: '<user>',
      distribution: '<user>-tools',
      reference: 'file://~/mod:setup',
    });
    // Normalized first: `/home/alice/../alice/py/../bin` is `~/bin`.
    expect(listing.environments.find((environment) => environment.status === 'not_a_venv')?.location).toBe(
      '~/bin/python3'
    );
  });

  it('leaves fields with fixed values alone when the user name is one of them', async () => {
    // Two distributions declare the same entry: the environment has an issue code.
    await cliVenv(path.join(home, '.local', 'share', 'uv', 'tools', 'aelix'), scratch, {
      'aelix-notes': 'notes',
      'aelix-notes-two': 'notes',
    });
    await write(path.join(home, '.aelix', 'agent', 'extensions', 'hello.py'));
    for (const username of ['listed', 'uv_tool', 'file', 'duplicate_entry', 'DUPLICATE_ENTRY']) {
      // eslint-disable-next-line no-await-in-loop -- one scan after another: scans are shared while one runs
      const listing = await listTerminalCli({ env: { PATH: '' }, home, platform: 'linux', username });
      expect(listing.environments[0]).toMatchObject({
        status: 'listed',
        foundBy: ['uv_tool'],
        issues: ['DUPLICATE_ENTRY'],
      });
      expect(listing.globalExtensions).toMatchObject({ status: 'listed', extensions: [{ kind: 'file' }] });
      // eslint-disable-next-line no-await-in-loop -- as above
      await terminalScanEnded();
    }
  });

  it.runIf(process.getuid?.() !== 0)('reports a launcher directory or a --user folder it cannot read', async () => {
    const lockedBin = path.join(scratch, 'opt', 'locked-bin');
    await write(path.join(lockedBin, 'aelix'), '#!/usr/bin/python3\n');
    const userPython = path.join(home, 'Library', 'Python');
    await write(path.join(userPython, '3.12', 'bin', '.keep'));
    await chmod(lockedBin, 0o000);
    await chmod(userPython, 0o000);
    try {
      const listing = await list({ PATH: lockedBin }, undefined, 'darwin');
      expect(listing.environments).toEqual([
        expect.objectContaining({
          status: 'unreadable',
          location: '<scratch>/opt/locked-bin/aelix'.replace('<scratch>', scratch),
        }),
      ]);
      expect(listing.truncated).toBe(true);
    } finally {
      await chmod(lockedBin, 0o755);
      await chmod(userPython, 0o755);
    }
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
    const listing = await list({ PATH: '' }, undefined, 'darwin');
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

  it('lists the global extension directory of the agent directory Studio sees, or none it cannot place', async () => {
    await write(path.join(home, 'agents', 'extensions', 'hello.py'), 'def setup(api): pass\n');
    expect((await list({ PATH: '', AELIX_CODING_AGENT_DIR: '~/agents' })).globalExtensions).toEqual({
      location: '~/agents/extensions',
      status: 'listed',
      extensions: [{ name: 'hello.py', kind: 'file' }],
      truncated: false,
    });
    await terminalScanEnded();
    const relative = await list({ PATH: '', AELIX_CODING_AGENT_DIR: 'agents' });
    expect(relative.globalExtensions).toMatchObject({ location: '', status: 'absent' });
    expect(relative.searched).not.toContain('~/.aelix/agent/extensions');
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

  it.runIf(process.getuid?.() !== 0)('reports an unreadable environment by its code, not as no CLI', async () => {
    const venv = path.join(home, '.local', 'share', 'uv', 'tools', 'aelix');
    await cliVenv(venv, scratch);
    const site = path.join(venv, 'lib', 'python3.12', 'site-packages');
    await chmod(site, 0o000);
    try {
      expect((await list({ PATH: '' })).environments).toEqual([
        expect.objectContaining({ status: 'unreadable', location: '~/.local/share/uv/tools/aelix' }),
      ]);
    } finally {
      await chmod(site, 0o755);
    }
  });

  it.runIf(process.getuid?.() !== 0)('reports a tool it cannot resolve, instead of passing it over', async () => {
    const tools = path.join(home, '.local', 'share', 'uv', 'tools');
    await cliVenv(path.join(tools, 'aelix'), scratch);
    // The tool directory can be listed but not searched: its entries cannot be resolved.
    await chmod(tools, 0o444);
    try {
      expect((await list({ PATH: '' })).environments).toEqual([
        expect.objectContaining({ status: 'unreadable', location: '~/.local/share/uv/tools/aelix' }),
      ]);
    } finally {
      await chmod(tools, 0o755);
    }
  });

  it.runIf(process.getuid?.() !== 0)('reports a tool it cannot look into, instead of passing it over', async () => {
    const other = path.join(home, '.local', 'share', 'uv', 'tools', 'other');
    await cliVenv(other, scratch, {}, { cli: false });
    await chmod(other, 0o000);
    try {
      expect((await list({ PATH: '' })).environments).toEqual([
        expect.objectContaining({ status: 'unreadable', location: '~/.local/share/uv/tools/other' }),
      ]);
    } finally {
      await chmod(other, 0o755);
    }
  });

  it('says it stopped short when a tool has more to look at than is read', async () => {
    const other = path.join(home, '.local', 'share', 'uv', 'tools', 'other');
    await cliVenv(other, scratch, {}, { cli: false });
    await Promise.all(
      Array.from({ length: 16 }, (_, index) => write(path.join(other, 'lib', `extra-${index}`, '.keep')))
    );
    const listing = await list({ PATH: '' });
    expect(listing).toMatchObject({ environments: [], truncated: true });
  });

  it.runIf(process.getuid?.() !== 0)(
    'reports an environment whose CLI metadata cannot be read as unreadable',
    async () => {
      const venv = path.join(home, '.local', 'share', 'uv', 'tools', 'aelix');
      await cliVenv(venv, scratch);
      const metadata = path.join(venv, 'lib', 'python3.12', 'site-packages', 'aelix-0.1.0b2.dist-info', 'METADATA');
      await chmod(metadata, 0o000);
      try {
        expect((await list({ PATH: '' })).environments).toEqual([
          expect.objectContaining({ status: 'unreadable', foundBy: ['uv_tool'] }),
        ]);
      } finally {
        await chmod(metadata, 0o644);
      }
    }
  );

  it(`reads at most ${ENVIRONMENT_LIMIT} environments, and says where it stopped short`, async () => {
    const tools = path.join(home, '.local', 'share', 'uv', 'tools');
    for (let index = 0; index <= ENVIRONMENT_LIMIT; index += 1)
      await cliVenv(path.join(tools, `aelix-${String(index).padStart(2, '0')}`), scratch);
    const listing = await list({ PATH: '' });
    expect(listing.environments).toHaveLength(ENVIRONMENT_LIMIT);
    expect(listing.truncated).toBe(true);
    await terminalScanEnded();
    const longPath = Array.from({ length: 70 }, (_, index) => `/p${index}`).join(':');
    expect((await list({ PATH: longPath })).truncated).toBe(true);
  });

  it(`runs at most ${FS_CONCURRENCY} file system calls at once`, async () => {
    const venv = path.join(home, '.local', 'share', 'uv', 'tools', 'aelix');
    const packs = Object.fromEntries(Array.from({ length: 120 }, (_, index) => [`pack-${index}`, `pack-${index}`]));
    await cliVenv(venv, scratch, packs);
    const listing = await list({ PATH: '' });
    expect(listing.environments[0].extensions).toHaveLength(120);
    expect(fsWatch.peak).toBeLessThanOrEqual(FS_CONCURRENCY);
  });

  it('starts its clock before its first file system call, and stops reading when time is up', async () => {
    await cliVenv(path.join(home, '.local', 'share', 'uv', 'tools', 'aelix'), scratch, { late: 'late' });
    // Resolving the home directory alone takes longer than the whole limit.
    Object.assign(fsWatch, { delayMs: 400, delayFor: home });
    const started = Date.now();
    const listing = await list({ PATH: '' }, 100);
    expect(Date.now() - started).toBeLessThan(350);
    expect(listing).toMatchObject({ timedOut: true, environments: [] });
    await terminalScanEnded();
    // Past the deadline no further call starts: the slow one and at most a few in flight.
    expect(fsWatch.calls).toBeLessThan(5);
    const callsAtEnd = fsWatch.calls;
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(fsWatch.calls).toBe(callsAtEnd);
  });

  it('ends a timed-out scan only once its slow reads have settled, and starts no other before', async () => {
    const packs = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`pack-${index}`, `pack-${index}`]));
    await cliVenv(path.join(home, '.local', 'share', 'uv', 'tools', 'aelix'), scratch, { ...packs, early: 'early' });
    // One distribution's files answer long after the deadline; the others keep workers busy past it.
    fsWatch.delays = [
      ['early-1.0.0.dist-info', 900],
      ['pack_', 40],
    ];
    const late = await list({ PATH: '' }, 250);
    expect(late.timedOut).toBe(true);
    let ended = false;
    const ending = terminalScanEnded().then(() => (ended = true));
    await new Promise((resolve) => setTimeout(resolve, 150));
    // Workers stopped at the deadline, the slow read is still out: the scan has not ended.
    expect(fsWatch.active).toBeGreaterThan(0);
    expect(ended).toBe(false);
    expect(await list({ PATH: '' })).toBe(late);
    await ending;
    expect(fsWatch.active).toBe(0);
  });

  it('says it ran out of time when it ended past the deadline, even without a call after it', async () => {
    await cliVenv(path.join(home, '.local', 'share', 'uv', 'tools', 'aelix'), scratch);
    // The last file system call returns in time; the parsing after it does not.
    venvModule.busyMs = 400;
    const listing = await list({ PATH: '' }, 200);
    expect(listing.timedOut).toBe(true);
  });

  it('names a tool by its metadata where its suffix is not written exactly, as CPython does', async () => {
    const tool = path.join(home, '.local', 'share', 'uv', 'tools', 'renamed');
    await write(path.join(tool, 'pyvenv.cfg'), 'home = /opt/python/bin\n');
    const info = path.join(tool, 'lib', 'python3.12', 'site-packages', 'Renamed-0.1.0b2.DIST-INFO');
    await write(path.join(info, 'METADATA'), 'Metadata-Version: 2.1\nName: aelix\nVersion: 0.1.0b2\n');
    const listing = await list({ PATH: '' });
    expect(listing.environments).toEqual([
      expect.objectContaining({
        status: 'listed',
        location: '~/.local/share/uv/tools/renamed',
        nativeVersion: '0.1.0b2',
      }),
    ]);
  });

  it('shares one scan: callers at the same time, and after a timed-out answer until the scan ended', async () => {
    await cliVenv(path.join(home, '.local', 'share', 'uv', 'tools', 'aelix'), scratch);
    const [first, second] = await Promise.all([list({ PATH: '' }), list({ PATH: '' })]);
    expect(second).toBe(first);
    await terminalScanEnded();
    const third = await list({ PATH: '' });
    expect(third).not.toBe(first);
    await terminalScanEnded();

    Object.assign(fsWatch, { delayMs: 300, delayFor: home });
    const late = await list({ PATH: '' }, 50);
    expect(late.timedOut).toBe(true);
    // The timed-out scan has not ended yet: no new scan starts, the same answer comes.
    expect(await list({ PATH: '' })).toBe(late);
    await terminalScanEnded();
    Object.assign(fsWatch, { delayMs: 0 });
    expect(await list({ PATH: '' })).not.toBe(late);
  });
});

describe('text in a reply', () => {
  const masks = { homes: ['/home/alice', '/private/home/alice'], username: 'alice', platform: 'linux' as const };

  it('writes the home directory as ~ and the user name as <user>, and leaves the rest', () => {
    expect(labelPath('/home/alice/.local/bin/aelix', masks)).toBe('~/.local/bin/aelix');
    expect(labelPath('/home/alice', masks)).toBe('~');
    expect(labelPath('/home/alice/../alice/x', masks)).toBe('~/x');
    expect(labelPath('/private/home/alice/x', masks)).toBe('~/x');
    expect(labelPath('/home/alicex/bin', masks)).toBe('/home/alicex/bin');
    expect(labelPath('/srv/alice/venv', masks)).toBe('/srv/<user>/venv');
    expect(maskText('file:///home/alice/mod', masks)).toBe('file://~/mod');
    expect(maskText('Alice-Tools', masks)).toBe('<user>-Tools');
    expect(maskText('malice', masks)).toBe('malice');
    expect(labelPath('/USERS/ALICE/x', { homes: ['/Users/alice'], username: 'alice', platform: 'darwin' })).toBe('~/x');
    expect(
      labelPath('C:\\Users\\Alice\\pipx\\venvs\\aelix', {
        homes: ['C:\\Users\\alice'],
        username: 'alice',
        platform: 'win32',
      })
    ).toBe('~\\pipx\\venvs\\aelix');
    // A home of `/` labels nothing.
    expect(labelPath('/usr/bin/aelix', { homes: ['/'], platform: 'linux' })).toBe('/usr/bin/aelix');
    // Whatever follows the home that cannot continue its name ends it: quotes, punctuation.
    expect(maskText('"/home/alice"', masks)).toBe('"~"');
    expect(maskText("('/home/alice', 1)", masks)).toBe("('~', 1)");
    // A period ends it too, unless a name goes on after it: then it is another path, whose
    // user name part is still hidden.
    expect(maskText('installed in /home/alice.', masks)).toBe('installed in ~.');
    expect(maskText('"/home/alice."', masks)).toBe('"~."');
    expect(maskText('/home/alice. Then', masks)).toBe('~. Then');
    expect(maskText('/home/alice.bak/x', masks)).toBe('/home/<user>.bak/x');
    expect(maskText('/home/alice.d', masks)).toBe('/home/<user>.d');
    // On Windows either separator matches either.
    const windows = { homes: ['C:\\Users\\Alice'], username: 'alice', platform: 'win32' as const };
    expect(maskText('"C:/Users/alice/x"', windows)).toBe('"~/x"');
    expect(maskText('file:///c:/users/ALICE', windows)).toBe('file:///~');
    expect(maskText('C:\\Users\\alice\\x', windows)).toBe('~\\x');
    // The same environment written in another case is one environment there.
    expect(environmentKey('C:\\Users\\Alice\\tools\\aelix', 'win32')).toBe(
      environmentKey('c:\\users\\alice\\TOOLS\\aelix', 'win32')
    );
    expect(environmentKey('/opt/Aelix', 'linux')).not.toBe(environmentKey('/opt/aelix', 'linux'));
  });
});

describe('nothing is run', () => {
  it('has no way to start a process, load code or use the network in the code that reads the terminal CLI', async () => {
    // `fileURLToPath`, not the URL's pathname: on Windows that is `/D:/…`, not a path.
    const directory = path.dirname(fileURLToPath(import.meta.url));
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
        /child_process|node:net|node:http|node:https|node:dgram|node:vm|worker_threads|\bfetch\s*\(|\bspawn|(?<![.\w])exec(File)?(Sync)?\s*\(|\bimport\s*\(|\brequire\s*\(|\beval\s*\(|new\s+Function|writeFile|appendFile|mkdir|\brm\s*\(|unlink|rename|symlink|chmod/
      );
    }
  });
});
