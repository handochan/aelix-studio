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
  listed: [] as string[],
  looked: [] as string[],
  reads: 0,
  openDelayMs: 0,
  swap: undefined as { from: string; to: string } | undefined,
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const looked =
    (call: (...args: unknown[]) => Promise<unknown>) =>
    (file: string, ...rest: unknown[]) => {
      fsSpy.looked.push(String(file));
      return call(file, ...rest);
    };
  return {
    ...actual,
    open: async (file: string, ...rest: unknown[]) => {
      fsSpy.opened.push(String(file));
      if (fsSpy.openDelayMs) await new Promise((resolve) => setTimeout(resolve, fsSpy.openDelayMs));
      const target = fsSpy.swap && String(file) === fsSpy.swap.from ? fsSpy.swap.to : file;
      const handle = (await (actual.open as (...args: unknown[]) => Promise<import('node:fs/promises').FileHandle>)(
        target,
        ...rest
      )) as import('node:fs/promises').FileHandle;
      const read = handle.read.bind(handle);
      return Object.assign(handle, {
        read: (...args: unknown[]) => {
          fsSpy.reads += 1;
          return (read as (...inner: unknown[]) => unknown)(...args);
        },
      });
    },
    opendir: async (directory: string, ...rest: unknown[]) => {
      fsSpy.listed.push(String(directory));
      if (fsSpy.openDelayMs) await new Promise((resolve) => setTimeout(resolve, fsSpy.openDelayMs));
      const dir = (await (actual.opendir as (...args: unknown[]) => Promise<import('node:fs').Dir>)(
        directory,
        ...rest
      )) as import('node:fs').Dir;
      return {
        close: () => dir.close(),
        [Symbol.asyncIterator]: () => {
          fsSpy.reads += 1;
          return dir[Symbol.asyncIterator]();
        },
      };
    },
    lstat: looked(actual.lstat as (...args: unknown[]) => Promise<unknown>),
    stat: looked(actual.stat as (...args: unknown[]) => Promise<unknown>),
    readlink: looked(actual.readlink as (...args: unknown[]) => Promise<unknown>),
  };
});

import {
  createScan,
  isUncOrDevice,
  listDirectory,
  lstatEntry,
  mapLimited,
  readBounded,
  statEntry,
  type Scan,
} from './files';
import { DECLARED_LIMIT, readDeclaredExtensions, readGlobalExtensions } from './globalDirectory';
import { HEAD_LIMIT, launcherInterpreter, readLauncherInterpreter } from './launcher';
import { METADATA_LIMIT, readCliVenv } from './venv';

const posix = process.platform !== 'win32';
const unprivileged = posix && process.getuid?.() !== 0;
let scratch = '';
let scan: Scan;
beforeEach(async () => {
  scratch = await realpath(await mkdtemp(path.join(os.tmpdir(), 'studio-terminal-')));
  scan = createScan(Date.now() + 30_000, process.platform);
  Object.assign(fsSpy, { opened: [], listed: [], looked: [], reads: 0, openDelayMs: 0, swap: undefined });
});
afterEach(() => rm(scratch, { recursive: true, force: true }));

/** A time-bounded call: linear parsers finish well under this on any machine. */
/**
 * Runs in linear time: the inputs below are sized so that quadratic work takes seconds, and the
 * limit leaves room for a busy machine.
 */
const fast = (run: () => unknown, limitMs = 1000): void => {
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

  it('ends a mapping only when every worker has finished, even after one failed', async () => {
    let slowDone = false;
    const mapping = mapLimited([0, 1], 2, async (item) => {
      if (item === 0) throw new Error('first');
      await new Promise((resolve) => setTimeout(resolve, 50));
      slowDone = true;
      return item;
    });
    await expect(mapping).rejects.toThrow('first');
    expect(slowDone).toBe(true);
  });

  it('gives nothing from a call that came back after the deadline, so nothing follows it', async () => {
    const soon = createScan(Date.now() + 30, process.platform);
    const late = soon.fs(() => new Promise((resolve) => setTimeout(() => resolve('late'), 80)));
    await expect(late).rejects.toThrow('time limit');
  });

  it('gives nothing from a call that failed after the deadline, so nothing follows it either', async () => {
    const soon = createScan(Date.now() + 30, process.platform);
    const failed = soon.fs(
      () =>
        new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('gone'), { code: 'ENOENT' })), 80))
    );
    await expect(failed).rejects.toThrow('time limit');
  });

  it('says when every file system call of a scan has settled', async () => {
    const tracked = createScan(Date.now() + 10_000, process.platform);
    let done = false;
    void tracked.fs(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      done = true;
    });
    await tracked.settled();
    expect(done).toBe(true);
    await tracked.settled();
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

  it('starts no read after an open that came back past the deadline', async () => {
    await write(path.join(scratch, 'file'), 'x'.repeat(100));
    fsSpy.openDelayMs = 200;
    const soon = createScan(Date.now() + 50, process.platform);
    await expect(readBounded(soon, path.join(scratch, 'file'), 1000)).rejects.toThrow('time limit');
    expect(fsSpy.opened).toHaveLength(1);
    expect(fsSpy.reads).toBe(0);
  });

  it('reads no entry of a directory opened past the deadline', async () => {
    await write(path.join(scratch, 'dir', 'a'));
    fsSpy.openDelayMs = 200;
    const soon = createScan(Date.now() + 50, process.platform);
    await expect(listDirectory(soon, path.join(scratch, 'dir'), 10)).rejects.toThrow('time limit');
    expect(fsSpy.listed).toHaveLength(1);
    expect(fsSpy.reads).toBe(0);
  });

  it('follows no link to a UNC path on Windows: the target is read before it is followed', async (context) => {
    // The type is given, so Windows does not look at the share to choose one.
    const made = await symlink('//server/share', path.join(scratch, 'to-unc'), 'dir').catch(
      (error: NodeJS.ErrnoException) => error.code
    );
    // Windows without the right to make links: nothing to test there.
    if (made === 'EPERM' && !posix) context.skip();
    const windows = createScan(Date.now() + 10_000, 'win32');
    expect(await readBounded(windows, path.join(scratch, 'to-unc', 'x'), 100)).toBe('unreadable');
    expect(await listDirectory(windows, path.join(scratch, 'to-unc'), 10)).toBe('unreadable');
    expect(await statEntry(windows, path.join(scratch, 'to-unc'))).toBe('unreadable');
    expect(await lstatEntry(windows, path.join(scratch, 'to-unc', 'aelix'))).toBe('unreadable');
    expect(fsSpy.looked.some((entry) => entry.startsWith('//server'))).toBe(false);
    expect(fsSpy.listed).toEqual([]);
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
    fast(() => parseExtensionEntries('[aelix.extensions]\nx = mod' + '['.repeat(100_000) + 'x\n'));
    fast(() => parseExtensionEntries('[aelix.extensions]\nx = mod' + '['.repeat(200_000) + ' ]\n'));
    const entries = parseExtensionEntries(
      '[aelix.extensions]\na = mod:setup [extra]\nb = mod [x[y]\nc = mod[x] y\nd = mod:attr\n'
    );
    expect(Object.fromEntries(entries)).toEqual({ a: 'mod:setup', b: 'mod', c: 'mod[x]y', d: 'mod:attr' });
  });

  it('reads pyproject tables in linear time', () => {
    fast(() => readDeclaredExtensions('[project]\nx = [\n' + '"a",\n'.repeat(40_000) + ']\n'));
    fast(() => readDeclaredExtensions('[' + ' '.repeat(4000) + '\n'.repeat(60_000)));
    fast(() => readDeclaredExtensions(' \n'.repeat(100_000) + '[tool.aelix]'));
    // A deep table and many keys under it: nothing of the table is copied per line.
    const keys = Array.from({ length: 50_000 }, (_, index) => `k${index} = 1`).join('\n');
    fast(() => readDeclaredExtensions('[' + 'a.'.repeat(2000) + 'b]\n' + keys));
    fast(() => readDeclaredExtensions('[tool.aelix]\nextensions = [' + '"a", '.repeat(800) + ']\n'));
  });
});

describe('pyproject tables, by the strict rule', () => {
  const declared = '[tool.aelix]\nextensions = ["a.py"]\n';
  const tripleDouble = '"'.repeat(3);
  const tripleSingle = "'".repeat(3);
  it.each([
    // The one form taken.
    ['[tool.aelix]\nextensions = ["ext.py", "other.py"]\n', { paths: ['ext.py', 'other.py'] }],
    ['[ tool . aelix ] # here\nextensions = [ "a.py", "b.py", ] # list\n', { paths: ['a.py', 'b.py'] }],
    ['﻿[tool.aelix]\r\nextensions = ["a.py"]\r\n', { paths: ['a.py'] }],
    ['[tool.aelix]\nextensions = []\n', { paths: [] }],
    // Elsewhere, values on more lines are skipped, nested arrays included.
    ['[project]\nname = "x"\ndependencies = [\n  "a", # ]\n  ["n"],\n]\n' + declared, { paths: ['a.py'] }],
    ['[project]\nname = "x"\n', 'none'],
    ['[tool.aelixir]\nextensions = ["a.py"]\n', 'none'],
    ['[tool.other]\nnote = "aelix"\n', 'none'],
    ['[tool."black"]\nx = 1\n', 'none'],
    ['[tool.aelix.sub]\nextensions = ["a.py"]\n', 'none'],
    ['[' + Array.from({ length: 20 }, () => 'a').join('.') + '.aelix]\nx = 1\n', 'none'],
    ['[tool.aelix.' + Array.from({ length: 20 }, () => 'a').join('.') + ']\nx = 1\n', 'none'],
    // Three quotes anywhere, even inside a one-line string.
    [`[project]\ndescription = ${tripleDouble}x\n${tripleDouble}\n${declared}`, 'unknown'],
    [`[project]\nx = 'a${tripleDouble}b'\n${declared}`, 'unknown'],
    [`[project]\nreadme = ${tripleSingle}x\n${tripleSingle}\n${declared}`, 'unknown'],
    // tool.aelix named another way.
    ['["tool".aelix]\nextensions = ["a.py"]\n', 'unknown'],
    ['[tool."aelix"]\nextensions = ["a.py"]\n', 'unknown'],
    ['[[tool.aelix]]\nextensions = ["a.py"]\n', 'unknown'],
    ['[[tool]]\naelix = 1\n', 'unknown'],
    ['[tool.aelix.extensions]\nx = 1\n', 'unknown'],
    ['tool.aelix.extensions = ["a.py"]\n', 'unknown'],
    ['tool = { aelix = { extensions = ["a.py"] } }\n', 'unknown'],
    ['[tool]\naelix.extensions = ["a.py"]\n', 'unknown'],
    ['[tool]\naelix = { extensions = ["a.py"] }\n', 'unknown'],
    ['[tool]\n"aelix" = 1\n', 'unknown'],
    // In [tool.aelix]: quoted or dotted keys, inline tables, more lines, escapes, other strings.
    ['[tool.aelix]\n"extensions" = ["a.py"]\n', 'unknown'],
    ['[tool.aelix]\nextensions.x = 1\n', 'unknown'],
    ['[tool.aelix]\noptions = { a = 1 }\nextensions = ["a.py"]\n', 'unknown'],
    ['[tool.aelix]\nextensions = [\n  "a.py",\n]\n', 'unknown'],
    ['[tool.aelix]\nother = [\n  "x",\n]\nextensions = ["a.py"]\n', 'unknown'],
    ['[tool.aelix]\nextensions = ["a.py"\n', 'unknown'],
    ['[tool.aelix]\nextensions = [["a.py"]]\n', 'unknown'],
    ['[tool.aelix]\nextensions = ["a\\u0041.py"]\n', 'unknown'],
    ['[tool.aelix]\nname = "a\\tb"\nextensions = ["a.py"]\n', 'unknown'],
    ["[tool.aelix]\nextensions = ['a.py']\n", 'unknown'],
    ['[tool.aelix]\nextensions = "a.py"\n', 'unknown'],
    // Given twice: TOML refuses the file.
    [declared + '[tool.aelix]\nname = "x"\n', 'unknown'],
    ['[tool.aelix]\nextensions = ["a.py"]\nextensions = ["b.py"]\n', 'unknown'],
    ['[project]\nname = "a"\n[project]\nversion = "1"\n' + declared, 'unknown'],
    ['[project]\nname = "a"\nname = "b"\n' + declared, 'unknown'],
    // Not TOML this reader can follow.
    ['[project]\njust words\n' + declared, 'unknown'],
    ['[project]\nname = "open\n' + declared, 'unknown'],
    // Escapes: read in names, so a name is what it says; only where tool.aelix can be named.
    ['["a\\"b"]\nx = 1\n' + declared, { paths: ['a.py'] }],
    ['[project."a\\tb"]\nx = "c\\td"\n' + declared, { paths: ['a.py'] }],
    ['[project]\ndescription = "a\\tb"\n' + declared, { paths: ['a.py'] }],
    ['["t\\u006fol".aelix]\nextensions = ["a.py"]\n', 'unknown'],
    ['[tool."a\\u0065lix"]\nextensions = ["a.py"]\n', 'unknown'],
    ['"t\\u006fol".x = 1\n' + declared, 'unknown'],
    ['[tool]\n"a\\u0065lix" = 1\n' + declared, 'unknown'],
    ['["a\\qb"]\nx = 1\n' + declared, 'unknown'],
    ['[project]\n"\\uD800" = 1\n' + declared, 'unknown'],
    // Given twice once escapes are read.
    ['[project]\nname = "a"\n"n\\u0061me" = "b"\n' + declared, 'unknown'],
    ['[project]\n["proj\\u0065ct"]\n' + declared, 'unknown'],
    // Inline tables: in tool.aelix at any depth; elsewhere left alone.
    ['[tool.aelix]\nlist = [{ a = 1 }]\nextensions = ["a.py"]\n', 'unknown'],
    ['[project]\nauthors = [{ name = "x" }]\n' + declared, { paths: ['a.py'] }],
    ['[project\n' + declared, 'unknown'],
    ['x = "' + 'y'.repeat(5000) + '"\n', 'unknown'],
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

  it.runIf(posix)('does not list a lib directory that a link takes out of the environment', async () => {
    const root = path.join(scratch, 'venv');
    await cliVenv(path.join(scratch, 'elsewhere'), scratch);
    await write(path.join(root, 'pyvenv.cfg'), 'home = /opt/python/bin\n');
    await symlink(path.join(scratch, 'elsewhere', 'lib'), path.join(root, 'lib'));
    expect(await readCliVenv(scan, root)).toBe('no_cli');
    expect(fsSpy.listed.some((entry) => entry.startsWith(path.join(scratch, 'elsewhere')))).toBe(false);
  });

  it.runIf(posix)(
    'names a distribution whose suffix is not in lower case by its metadata, as CPython does',
    async () => {
      const root = path.join(scratch, 'venv');
      await cliVenv(root, scratch);
      const site = posixSite(root);
      // Sorted first; CPython keys it by its METADATA Name, which the next directory shares.
      await write(path.join(site, 'Twice-1.0.DIST-INFO', 'METADATA'), 'Name: other-name\nVersion: 1.0\n');
      await write(
        path.join(site, 'Twice-1.0.DIST-INFO', 'entry_points.txt'),
        '[aelix.extensions]\nkept = twice:setup\n'
      );
      await distribution(site, 'other-name', '2.0', '[aelix.extensions]\ndropped = other:setup\n');
      expect(await readCliVenv(scan, root)).toMatchObject({
        extensions: [{ name: 'kept', distribution: 'other-name' }],
        issues: ['DUPLICATE_DISTRIBUTION'],
      });
    }
  );

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

  it.runIf(unprivileged)(
    'calls an environment unreadable when a directory above its files cannot be searched',
    async () => {
      const root = path.join(scratch, 'venv');
      await cliVenv(root, scratch);
      const version = path.dirname(posixSite(root));
      await chmod(version, 0o000);
      try {
        expect(await readCliVenv(scan, root)).toBe('unreadable');
      } finally {
        await chmod(version, 0o755);
      }
      await chmod(root, 0o000);
      try {
        expect(await readCliVenv(scan, root)).toBe('unreadable');
      } finally {
        await chmod(root, 0o755);
      }
    }
  );
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

  it('says it stopped short when a pyproject declares more paths than are checked', async () => {
    const directory = path.join(scratch, 'agent', 'extensions');
    const declared = Array.from({ length: DECLARED_LIMIT + 1 }, (_, index) => `"p${index}.py"`).join(', ');
    await write(path.join(directory, 'many', 'pyproject.toml'), `[tool.aelix]\nextensions = [${declared}]\n`);
    await write(path.join(directory, 'many', `p${DECLARED_LIMIT}.py`));
    expect(await readGlobalExtensions(scan, directory)).toEqual({
      extensions: [{ name: 'many', kind: 'unknown' }],
      truncated: true,
    });
  });

  it('says it stopped short past the limit even when a declared path was found', async () => {
    const directory = path.join(scratch, 'agent', 'extensions');
    // One of them empty: counted as declared all the same.
    const declared = ['""', ...Array.from({ length: DECLARED_LIMIT }, (_, index) => `"p${index}.py"`)].join(', ');
    await write(path.join(directory, 'many', 'pyproject.toml'), `[tool.aelix]\nextensions = [${declared}]\n`);
    await write(path.join(directory, 'many', 'p0.py'));
    expect(await readGlobalExtensions(scan, directory)).toEqual({
      extensions: [{ name: 'many', kind: 'pyproject' }],
      truncated: true,
    });
  });
});
