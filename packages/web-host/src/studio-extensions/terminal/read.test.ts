/**
 * Reading the terminal CLI from its files: bounded and scoped reads, the interpreter a launcher
 * names, the extensions of its virtual environment, and its global extension directory. Nothing
 * is run, special files are never opened, and no parser takes more than linear time.
 */
import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cliVenv, distribution, write } from '../../../tests/fixtures/terminalCli';
import { parseExtensionEntries } from '../inspect/metadata';

const fsSpy = vi.hoisted(() => ({
  opened: [] as string[],
  swap: undefined as { from: string; to: string } | undefined,
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: (file: string, ...rest: unknown[]) => {
      fsSpy.opened.push(String(file));
      const target = fsSpy.swap && String(file) === fsSpy.swap.from ? fsSpy.swap.to : file;
      return (actual.open as (...args: unknown[]) => unknown)(target, ...rest);
    },
  };
});

import { createScan, isUncOrDevice, listDirectory, mapLimited, readBounded, type Scan } from './files';
import { readDeclaredExtensions, readGlobalExtensions } from './globalDirectory';
import { HEAD_LIMIT, launcherInterpreter, readLauncherInterpreter } from './launcher';
import { METADATA_LIMIT, readCliVenv } from './venv';

const posix = process.platform !== 'win32';
const unprivileged = posix && process.getuid?.() !== 0;
let scratch = '';
let scan: Scan;
beforeEach(async () => {
  scratch = await realpath(await mkdtemp(path.join(os.tmpdir(), 'studio-terminal-')));
  scan = createScan(Date.now() + 30_000, process.platform);
  fsSpy.opened = [];
  fsSpy.swap = undefined;
});
afterEach(() => rm(scratch, { recursive: true, force: true }));

/** A time-bounded call: linear parsers finish well under this on any machine. */
const fast = (run: () => unknown, limitMs = 250): void => {
  const started = performance.now();
  run();
  expect(performance.now() - started).toBeLessThan(limitMs);
};

describe('limits on work at once', () => {
  it('maps a long list with no more calls at once than the limit, in order', async () => {
    let active = 0;
    let peak = 0;
    let started = 0;
    const result = await mapLimited(
      Array.from({ length: 500 }, (_, index) => index),
      8,
      async (item) => {
        started += 1;
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active -= 1;
        return item * 2;
      }
    );
    expect(result).toEqual(Array.from({ length: 500 }, (_, index) => index * 2));
    expect(peak).toBe(8);
    expect(started).toBe(500);
  });

  it('runs no more file system calls at once than its cap, whoever asks', async () => {
    const capped = createScan(Date.now() + 10_000, process.platform, 3);
    let active = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 40 }, () =>
        capped.fs(async () => {
          active += 1;
          peak = Math.max(peak, active);
          await new Promise((resolve) => setTimeout(resolve, 1));
          active -= 1;
        })
      )
    );
    expect(peak).toBe(3);
  });
});

describe('bounded reads', () => {
  it('reads a regular file within its limit, or its head, and says when it cut it', async () => {
    const file = path.join(scratch, 'file');
    await write(file, 'x'.repeat(10000));
    expect(await readBounded(scan, file, 100)).toBe('too_large');
    expect(await readBounded(scan, file, 100, { head: true })).toEqual({ text: 'x'.repeat(100), truncated: true });
    expect(await readBounded(scan, file, 20000)).toEqual({ text: 'x'.repeat(10000), truncated: false });
    expect(await readBounded(scan, path.join(scratch, 'missing'), 100)).toBe('absent');
    expect(await readBounded(scan, scratch, 100)).toBe('not_a_file');
  });

  it.runIf(posix)('never opens a FIFO or a device: it looks first', async () => {
    const fifo = path.join(scratch, 'fifo');
    execFileSync('mkfifo', [fifo]);
    expect(await readBounded(scan, fifo, 100)).toBe('not_a_file');
    expect(await readBounded(scan, '/dev/null', 100)).toBe('not_a_file');
    expect(fsSpy.opened).toEqual([]);
  });

  it('refuses a file swapped between its stat and its open', async () => {
    const file = path.join(scratch, 'one');
    await write(file, 'first');
    await write(path.join(scratch, 'two'), 'second');
    fsSpy.swap = { from: file, to: path.join(scratch, 'two') };
    expect(await readBounded(scan, file, 100)).toBe('unreadable');
  });

  it('reads inside a root only, by real path', async () => {
    const root = path.join(scratch, 'root');
    await write(path.join(root, 'inside'), 'ok');
    await write(path.join(scratch, 'secret'), 'outside');
    await symlink(path.join(scratch, 'secret'), path.join(root, 'link'));
    expect(await readBounded(scan, path.join(root, 'inside'), 100, { within: root })).toMatchObject({ text: 'ok' });
    expect(await readBounded(scan, path.join(root, 'link'), 100, { within: root })).toBe('outside');
    expect(fsSpy.opened).toEqual([path.join(root, 'inside')]);
  });

  it('never touches a Windows UNC or device path', async () => {
    expect(isUncOrDevice('\\\\server\\share\\x', 'win32')).toBe(true);
    expect(isUncOrDevice('\\\\?\\C:\\x', 'win32')).toBe(true);
    expect(isUncOrDevice('\\\\.\\pipe\\x', 'win32')).toBe(true);
    expect(isUncOrDevice('//server/share', 'win32')).toBe(true);
    expect(isUncOrDevice('C:\\Users\\u', 'win32')).toBe(false);
    expect(isUncOrDevice('//usr/bin', 'linux')).toBe(false);
    const windows = createScan(Date.now() + 10_000, 'win32');
    expect(await readBounded(windows, '\\\\server\\share\\x', 100)).toBe('unreadable');
    expect(await listDirectory(windows, '\\\\server\\share', 10)).toBe('unreadable');
    expect(fsSpy.opened).toEqual([]);
  });

  it('lists a directory up to a limit, and tells a missing one from an unreadable one', async () => {
    for (const name of ['a', 'b', 'c']) await write(path.join(scratch, 'dir', name));
    expect(await listDirectory(scan, path.join(scratch, 'dir'), 5)).toEqual({
      names: ['a', 'b', 'c'],
      truncated: false,
    });
    expect(await listDirectory(scan, path.join(scratch, 'dir'), 2)).toMatchObject({ truncated: true });
    expect(await listDirectory(scan, path.join(scratch, 'dir', 'a'), 2)).toBe('absent');
    expect(await listDirectory(scan, path.join(scratch, 'none'), 2)).toBe('absent');
    if (unprivileged) {
      await chmod(path.join(scratch, 'dir'), 0o000);
      expect(await listDirectory(scan, path.join(scratch, 'dir'), 2)).toBe('unreadable');
      await chmod(path.join(scratch, 'dir'), 0o755);
    }
  });

  it('stops at its deadline instead of reading on', async () => {
    const late = createScan(Date.now() - 1, process.platform);
    await write(path.join(scratch, 'file'), 'x');
    await expect(readBounded(late, path.join(scratch, 'file'), 100)).rejects.toThrow('time limit');
    expect(fsSpy.opened).toEqual([]);
  });
});

describe('the interpreter a launcher names', () => {
  it.each([
    [
      '#!/home/u/.local/share/uv/tools/aelix/bin/python\nimport sys\n',
      '/home/u/.local/share/uv/tools/aelix/bin/python',
    ],
    ['#!/usr/bin/python3 -E\n', '/usr/bin/python3'],
    ['#! /usr/bin/python3\n', '/usr/bin/python3'],
    // uv: single quotes.
    [
      "#!/bin/sh\n'''exec' '/home/u/my tools/aelix/bin/python' \"$0\" \"$@\"\n' '''\n",
      '/home/u/my tools/aelix/bin/python',
    ],
    // distlib: double quotes for spaces, CRLF.
    ["#!/bin/sh\r\n'''exec' \"/opt/a b/bin/python3\" \"$0\" \"$@\"\r\n' '''\r\n", '/opt/a b/bin/python3'],
    // distlib: no quotes for a long path, and interpreter arguments.
    ["#!/bin/sh\n'''exec' /opt/very/long/bin/python \"$0\" \"$@\"\n' '''\n", '/opt/very/long/bin/python'],
    ["#!/bin/sh\n'''exec' /opt/very/long/bin/python -E -s \"$0\" \"$@\"\n' '''\n", '/opt/very/long/bin/python'],
    ["#!/bin/sh\n'''exec' '/opt/x y/python' -E \"$0\" \"$@\"\n' '''\n", '/opt/x y/python'],
  ])('reads %j', (head, interpreter) => {
    expect(readLauncherInterpreter(head)).toBe(interpreter);
  });

  it.each([
    ['an env launcher, which depends on a PATH Studio does not have', '#!/usr/bin/env python3\n'],
    ['a relative interpreter', '#!python\n'],
    ['a relative interpreter in the sh form', "#!/bin/sh\n'''exec' python \"$0\" \"$@\"\n' '''\n"],
    ['a relative quoted interpreter in the sh form', "#!/bin/sh\n'''exec' 'bin/python' \"$0\" \"$@\"\n' '''\n"],
    ['a quote inside the path', "#!/bin/sh\n'''exec' '/a'\"'\"'b/python' \"$0\" \"$@\"\n' '''\n"],
    ['a shell launcher of another shape', '#!/bin/sh\nexec /opt/aelix/bin/aelix "$@"\n'],
    ['a binary launcher', 'MZ\u0090\u0000\u0003'],
    ['no #! line', 'import sys\n'],
    ['an empty file', ''],
  ])('reads nothing from %s', (_case, head) => {
    expect(readLauncherInterpreter(head)).toBeUndefined();
  });

  it('reads only the first 4 KiB, and takes nothing from a line cut there', async () => {
    const launcher = path.join(scratch, 'aelix');
    await write(launcher, '#!/opt/' + 'p'.repeat(HEAD_LIMIT) + '/python\n');
    expect(await launcherInterpreter(scan, launcher)).toBeUndefined();
    await write(launcher, '#!/opt/python\n' + 'x'.repeat(HEAD_LIMIT * 4));
    expect(await launcherInterpreter(scan, launcher)).toBe('/opt/python');
    // A file shorter than the limit may end without a newline.
    await write(launcher, '#!/opt/python');
    expect(await launcherInterpreter(scan, launcher)).toBe('/opt/python');
  });
});

describe('linear time on hostile input', () => {
  it('strips entry point extras in linear time, as the pattern did', () => {
    // With no closing `]`, the pattern tried every `[` to the end: quadratic.
    fast(() => parseExtensionEntries('[aelix.extensions]\nx = mod' + '['.repeat(50_000) + 'x\n'));
    fast(() => parseExtensionEntries('[aelix.extensions]\nx = mod' + '['.repeat(200_000) + ' ]\n'));
    const entries = parseExtensionEntries(
      '[aelix.extensions]\na = mod:setup [extra]\nb = mod [x[y]\nc = mod[x] y\nd = mod:attr\n'
    );
    expect(Object.fromEntries(entries)).toEqual({ a: 'mod:setup', b: 'mod', c: 'mod[x]y', d: 'mod:attr' });
  });

  it('reads pyproject tables in linear time', () => {
    fast(() => readDeclaredExtensions('[tool.aelix]\nextensions = [\n' + '"a",\n'.repeat(40_000) + ']\n'));
    fast(() => readDeclaredExtensions('[' + ' '.repeat(4000) + '\n'.repeat(60_000)));
    fast(() => readDeclaredExtensions(' \n'.repeat(100_000) + '[tool.aelix]'));
    expect(readDeclaredExtensions('x = "' + 'y'.repeat(5000) + '"\n')).toBe('unknown');
  });
});

describe('pyproject tables', () => {
  it.each([
    ['[tool.aelix]\nextensions = ["ext.py", \'other.py\']\n', { paths: ['ext.py', 'other.py'] }],
    [
      '[ tool . aelix ] # here\nextensions = [ # list\n  "a.py", # one\n  "b\\\\c.py",\n]\n',
      { paths: ['a.py', 'b\\c.py'] },
    ],
    ['[tool.aelix]\nextensions = []\n', { paths: [] }],
    ['[project]\nname = "x"\n', 'none'],
    ['[tool.aelixir]\nextensions = ["a.py"]\n', 'none'],
    ['[tool.other]\nnote = "aelix"\n', 'none'],
    ['["tool".aelix]\nextensions = ["a.py"]\n', 'unknown'],
    ['[tool."aelix"]\nextensions = ["a.py"]\n', 'unknown'],
    ['tool.aelix.extensions = ["a.py"]\n', 'unknown'],
    ['[tool]\naelix.extensions = ["a.py"]\n', 'unknown'],
    ['[tool]\naelix = { extensions = ["a.py"] }\n', 'unknown'],
    ['[tool.aelix]\n"extensions" = ["a.py"]\n', 'unknown'],
    ['[tool.aelix]\nextensions = [["a.py"]]\n', 'unknown'],
    ['[tool.aelix]\nextensions = ["a\\u0041.py"]\n', 'unknown'],
    ['[tool.aelix]\nextensions = ["a.py"\n', 'unknown'],
  ])('reads %j', (text, expected) => {
    expect(readDeclaredExtensions(text)).toEqual(expected);
  });
});

describe('the terminal CLI virtual environment', () => {
  const posixSite = (root: string) => path.join(root, 'lib', 'python3.12', 'site-packages');

  it.runIf(posix)('lists the aelix.extensions entry points of the environment that holds the CLI', async () => {
    const root = path.join(scratch, 'tools', 'aelix');
    await cliVenv(root, scratch);
    const site = posixSite(root);
    await distribution(site, 'Aelix_Memory', '0.4.0', '[aelix.extensions]\nmemory = aelix_memory:setup\n');
    await distribution(
      site,
      'aelix_webtool',
      '0.2.0',
      '[aelix.extensions]\nwebtool = aelix_webtool [extra]\n[other]\nx = y\n'
    );
    await distribution(site, 'requests', '2.0');
    // An egg-info directory with its PKG-INFO, and a suffix in capitals.
    await write(path.join(site, 'legacy_pack-1.0.egg-info', 'PKG-INFO'), 'Name: legacy-pack\nVersion: 1.0\n');
    await write(
      path.join(site, 'legacy_pack-1.0.egg-info', 'entry_points.txt'),
      '[aelix.extensions]\nlegacy = legacy_pack\n'
    );
    await write(path.join(site, 'Shouty-2.0.DIST-INFO', 'METADATA'), 'Name: Shouty\nVersion: 2.0\n');
    await write(path.join(site, 'Shouty-2.0.DIST-INFO', 'entry_points.txt'), '[aelix.extensions]\nshouty = shouty\n');
    expect(await readCliVenv(scan, root)).toEqual({
      nativeVersion: '0.1.0b2',
      extensions: [
        { name: 'legacy', distribution: 'legacy-pack', version: '1.0', reference: 'legacy_pack' },
        { name: 'memory', distribution: 'Aelix_Memory', version: '0.4.0', reference: 'aelix_memory:setup' },
        { name: 'shouty', distribution: 'Shouty', version: '2.0', reference: 'shouty' },
        { name: 'webtool', distribution: 'aelix_webtool', version: '0.2.0', reference: 'aelix_webtool' },
      ],
      issues: [],
      truncated: false,
    });
  });

  it.runIf(posix)('drops a second copy of a distribution first, as CPython does, entries or not', async () => {
    const root = path.join(scratch, 'venv');
    await cliVenv(root, scratch);
    const site = posixSite(root);
    // The first copy by name has no entry; the second must not show its entry.
    await distribution(site, 'twice', '1.0');
    await distribution(site, 'twice', '2.0', '[aelix.extensions]\nghost = twice:setup\n');
    await distribution(site, 'one', '1.0', '[aelix.extensions]\nsame = one:setup\n');
    await distribution(site, 'two', '1.0', '[aelix.extensions]\nsame = two:setup\n');
    expect(await readCliVenv(scan, root)).toMatchObject({
      extensions: [
        { name: 'same', distribution: 'one' },
        { name: 'same', distribution: 'two' },
      ],
      issues: ['DUPLICATE_DISTRIBUTION', 'DUPLICATE_ENTRY'],
    });
  });

  it.runIf(posix)('reads nothing a link takes out of the environment, and says so by code', async () => {
    const root = path.join(scratch, 'venv');
    await cliVenv(root, scratch);
    const site = posixSite(root);
    await write(path.join(scratch, 'outside', 'entry_points.txt'), '[aelix.extensions]\nleak = alice_secret:setup\n');
    await write(path.join(site, 'linked-1.0.dist-info', 'METADATA'), 'Name: linked\nVersion: 1.0\n');
    await symlink(
      path.join(scratch, 'outside', 'entry_points.txt'),
      path.join(site, 'linked-1.0.dist-info', 'entry_points.txt')
    );
    await write(path.join(site, 'big-1.0.dist-info', 'METADATA'), 'Name: big\nVersion: 1.0\n');
    await write(
      path.join(site, 'big-1.0.dist-info', 'entry_points.txt'),
      '[aelix.extensions]\nsecret-name = x\n' + '#'.repeat(METADATA_LIMIT)
    );
    await write(path.join(site, 'nameless-1.0.dist-info', 'METADATA'), 'Summary: nothing\n');
    await write(path.join(site, 'nameless-1.0.dist-info', 'entry_points.txt'), '[aelix.extensions]\nhidden = y\n');
    const venv = await readCliVenv(scan, root);
    expect(venv).toMatchObject({ extensions: [], issues: ['ENTRY_POINTS_TOO_LARGE', 'METADATA_UNREADABLE'] });
    expect(JSON.stringify(venv)).not.toMatch(/leak|secret-name|hidden/);
    expect(fsSpy.opened).not.toContain(path.join(scratch, 'outside', 'entry_points.txt'));
  });

  it('reads the Windows layout only on Windows', async () => {
    const root = path.join(scratch, 'pipx', 'venvs', 'aelix');
    await cliVenv(root, scratch, { 'aelix-notes': 'notes' }, { windows: true });
    expect(await readCliVenv(createScan(Date.now() + 10_000, 'win32'), root)).toMatchObject({
      extensions: [{ name: 'notes' }],
    });
    expect(await readCliVenv(createScan(Date.now() + 10_000, 'linux'), root)).toBe('no_cli');
  });

  it.runIf(unprivileged)('tells an unreadable environment from one without the CLI', async () => {
    expect(await readCliVenv(scan, path.join(scratch, 'absent'))).toBe('not_a_venv');
    const other = path.join(scratch, 'other');
    await cliVenv(other, scratch, {}, { cli: false });
    expect(await readCliVenv(scan, other)).toBe('no_cli');
    const locked = path.join(scratch, 'locked');
    await cliVenv(locked, scratch);
    await chmod(posixSite(locked), 0o000);
    try {
      expect(await readCliVenv(scan, locked)).toBe('unreadable');
    } finally {
      await chmod(posixSite(locked), 0o755);
    }
  });
});

describe('the global extension directory', () => {
  it('lists what native would take, by its rules, and nothing else', async () => {
    const directory = path.join(scratch, 'agent', 'extensions');
    await write(path.join(directory, 'single.py'), 'def setup(api): pass\n');
    await write(path.join(directory, '.hidden.py'));
    await write(path.join(directory, '.py'));
    await write(path.join(directory, 'notes.txt'));
    await write(path.join(directory, 'with-manifest', 'aelix-plugin.toml'), 'broken =');
    await write(path.join(directory, 'with-manifest', '__init__.py'));
    await write(path.join(directory, 'declared', 'pyproject.toml'), '[tool.aelix]\nextensions = ["src/ext.py"]\n');
    await write(path.join(directory, 'declared', 'src', 'ext.py'));
    // Declared paths that do not exist: native goes on to __init__.py, or skips it.
    await write(path.join(directory, 'missing-path', 'pyproject.toml'), '[tool.aelix]\nextensions = ["gone.py"]\n');
    await write(path.join(directory, 'missing-path', '__init__.py'));
    await write(path.join(directory, 'empty-list', 'pyproject.toml'), '[tool.aelix]\nextensions = []\n');
    await write(path.join(directory, 'dotted', 'pyproject.toml'), 'tool.aelix.extensions = ["a.py"]\n');
    await write(path.join(directory, 'nothing', 'pyproject.toml'), '[project]\n');
    await write(path.join(directory, 'empty', 'README.md'));
    expect(await readGlobalExtensions(scan, directory)).toEqual({
      extensions: [
        { name: '.hidden.py', kind: 'file' },
        { name: 'declared', kind: 'pyproject' },
        { name: 'dotted', kind: 'unknown' },
        { name: 'missing-path', kind: 'package' },
        { name: 'single.py', kind: 'file' },
        { name: 'with-manifest', kind: 'manifest' },
      ],
      truncated: false,
    });
    expect(await readGlobalExtensions(scan, path.join(scratch, 'absent'))).toBe('absent');
  });
});
