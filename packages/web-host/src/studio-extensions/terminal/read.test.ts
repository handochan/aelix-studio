/**
 * Reading the terminal CLI from its files: the interpreter a launcher names, the extensions of
 * its virtual environment, and its global extension directory. Nothing is run, and every read
 * is bounded.
 */
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cliVenv, distribution, write } from '../../../tests/fixtures/terminalCli';
import { listDirectory, readBounded } from './files';
import { readGlobalExtensions } from './globalDirectory';
import { HEAD_LIMIT, launcherInterpreter, readLauncherInterpreter } from './launcher';
import { METADATA_LIMIT, readCliVenv } from './venv';

let scratch = '';
beforeEach(async () => {
  scratch = await mkdtemp(path.join(os.tmpdir(), 'studio-terminal-'));
});
afterEach(() => rm(scratch, { recursive: true, force: true }));

describe('bounded reads', () => {
  it('reads a regular file within its limit, or its head, and never waits on a FIFO', async () => {
    const file = path.join(scratch, 'file');
    await write(file, 'x'.repeat(10000));
    expect(await readBounded(file, 100)).toBe('too_large');
    expect(await readBounded(file, 100, true)).toEqual({ text: 'x'.repeat(100) });
    expect(await readBounded(file, 20000)).toEqual({ text: 'x'.repeat(10000) });
    expect(await readBounded(path.join(scratch, 'missing'), 100)).toBe('absent');
    expect(await readBounded(scratch, 100)).toBe('not_a_file');
    if (process.platform !== 'win32') {
      const fifo = path.join(scratch, 'fifo');
      execFileSync('mkfifo', [fifo]);
      expect(await readBounded(fifo, 100)).toBe('not_a_file');
    }
  });

  it('lists a directory up to a limit and says when there was more', async () => {
    for (const name of ['a', 'b', 'c']) await write(path.join(scratch, 'dir', name));
    expect(await listDirectory(path.join(scratch, 'dir'), 5)).toEqual({ names: ['a', 'b', 'c'], truncated: false });
    expect((await listDirectory(path.join(scratch, 'dir'), 2))?.truncated).toBe(true);
    expect(await listDirectory(path.join(scratch, 'dir', 'a'), 2)).toBeUndefined();
  });
});

describe('the interpreter a launcher names', () => {
  it.each([
    [
      '#!/home/u/.local/share/uv/tools/aelix/bin/python\nimport sys\n',
      '/home/u/.local/share/uv/tools/aelix/bin/python',
    ],
    ['#!/usr/bin/python3 -E\n', '/usr/bin/python3'],
    [
      "#!/bin/sh\n'''exec' '/home/u/my tools/aelix/bin/python' \"$0\" \"$@\"\n' '''\n",
      '/home/u/my tools/aelix/bin/python',
    ],
    ["#!/bin/sh\r\n'''exec' \"/opt/a b/bin/python3\" \"$0\" \"$@\"\r\n' '''\r\n", '/opt/a b/bin/python3'],
  ])('reads %j', (head, interpreter) => {
    expect(readLauncherInterpreter(head)).toBe(interpreter);
  });

  it.each([
    ['an env launcher, which depends on a PATH Studio does not have', '#!/usr/bin/env python3\n'],
    ['a relative interpreter', '#!python\n'],
    ['a shell launcher of another shape', '#!/bin/sh\nexec /opt/aelix/bin/aelix "$@"\n'],
    ['a binary launcher', 'MZ\u0090\u0000\u0003'],
    ['no #! line', 'import sys\n'],
    ['an empty file', ''],
  ])('reads nothing from %s', (_case, head) => {
    expect(readLauncherInterpreter(head)).toBeUndefined();
  });

  it('reads only the first 4 KiB of a launcher', async () => {
    const launcher = path.join(scratch, 'aelix');
    // The interpreter line ends past the limit: nothing is read beyond it to finish the line.
    await write(launcher, '#!/opt/' + 'p'.repeat(HEAD_LIMIT) + '/python\n');
    expect(await launcherInterpreter(launcher)).toBe('/opt/' + 'p'.repeat(HEAD_LIMIT - '#!/opt/'.length));
    await write(launcher, '#!/opt/python\n' + 'x'.repeat(HEAD_LIMIT * 4));
    expect(await launcherInterpreter(launcher)).toBe('/opt/python');
  });
});

describe('the terminal CLI virtual environment', () => {
  const posixSite = (root: string) => path.join(root, 'lib', 'python3.12', 'site-packages');

  it('lists the aelix.extensions entry points of the environment that holds the CLI', async () => {
    const root = path.join(scratch, 'tools', 'aelix');
    await cliVenv(root, scratch);
    const site = posixSite(root);
    await distribution(site, 'Aelix_Memory', '0.4.0', '[aelix.extensions]\nmemory = aelix_memory:setup\n');
    await distribution(
      site,
      'aelix-webtool',
      '0.2.0',
      '[aelix.extensions]\nwebtool = aelix_webtool [extra]\n[other]\nx = y\n'
    );
    await distribution(site, 'requests', '2.0');
    expect(await readCliVenv(root, 'darwin')).toEqual({
      nativeVersion: '0.1.0b2',
      extensions: [
        { name: 'memory', distribution: 'Aelix_Memory', version: '0.4.0', reference: 'aelix_memory:setup' },
        { name: 'webtool', distribution: 'aelix-webtool', version: '0.2.0', reference: 'aelix_webtool' },
      ],
      issues: [],
      truncated: false,
    });
  });

  it('reads the Windows layout, and reports what cannot be a ledger by code, without file content', async () => {
    const root = path.join(scratch, 'pipx', 'venvs', 'aelix');
    await cliVenv(root, scratch, {}, { windows: true });
    const site = path.join(root, 'Lib', 'site-packages');
    await distribution(site, 'one', '1.0', '[aelix.extensions]\nsame = one:setup\n');
    await distribution(site, 'two', '1.0', '[aelix.extensions]\nsame = two:setup\n');
    await distribution(site, 'two', '2.0', '[aelix.extensions]\nlater = two:setup\n');
    await write(path.join(site, 'big-1.0.dist-info', 'METADATA'), 'Name: big\nVersion: 1.0\n');
    await write(
      path.join(site, 'big-1.0.dist-info', 'entry_points.txt'),
      '[aelix.extensions]\nsecret-name = x\n' + '#'.repeat(METADATA_LIMIT)
    );
    await write(path.join(site, 'nameless-1.0.dist-info', 'METADATA'), 'Summary: nothing\n');
    await write(path.join(site, 'nameless-1.0.dist-info', 'entry_points.txt'), '[aelix.extensions]\nhidden = y\n');
    const venv = await readCliVenv(root, 'win32');
    expect(venv).toEqual({
      nativeVersion: '0.1.0b2',
      extensions: [
        { name: 'same', distribution: 'one', version: '1.0', reference: 'one:setup' },
        { name: 'same', distribution: 'two', version: '1.0', reference: 'two:setup' },
      ],
      issues: ['ENTRY_POINTS_TOO_LARGE', 'METADATA_UNREADABLE', 'DUPLICATE_DISTRIBUTION', 'DUPLICATE_ENTRY'],
      truncated: false,
    });
    expect(JSON.stringify(venv)).not.toContain('secret-name');
    // The POSIX layout is not looked for on Windows, nor the other way round.
    expect(await readCliVenv(root, 'linux')).toBe('no_cli');
  });

  it('reads a METADATA only up to its limit: the headers come first', async () => {
    const root = path.join(scratch, 'venv');
    await cliVenv(root, scratch);
    await write(
      path.join(posixSite(root), 'long-1.0.dist-info', 'METADATA'),
      'Name: long\nVersion: 1.0\n\n' + 'd'.repeat(METADATA_LIMIT * 2)
    );
    await write(
      path.join(posixSite(root), 'long-1.0.dist-info', 'entry_points.txt'),
      '[aelix.extensions]\nlong = long:setup\n'
    );
    expect(await readCliVenv(root, 'linux')).toMatchObject({
      extensions: [{ name: 'long', version: '1.0' }],
      issues: [],
    });
  });

  it('tells a directory that is not a virtual environment from one without the CLI', async () => {
    expect(await readCliVenv(path.join(scratch, 'absent'), 'linux')).toBe('not_a_venv');
    const plain = path.join(scratch, 'plain');
    await write(path.join(plain, 'lib', 'python3.12', 'site-packages', 'x.py'));
    expect(await readCliVenv(plain, 'linux')).toBe('not_a_venv');
    const other = path.join(scratch, 'other');
    await cliVenv(other, scratch, {}, { cli: false });
    expect(await readCliVenv(other, 'linux')).toBe('no_cli');
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
    await write(path.join(directory, 'declared', 'pyproject.toml'), '[project]\nname = "x"\n\n[tool.aelix] # here\n');
    await write(path.join(directory, 'undeclared', 'pyproject.toml'), '[tool.aelixir]\n');
    await write(path.join(directory, 'undeclared', '__init__.py'));
    await write(path.join(directory, 'nothing', 'pyproject.toml'), '[project]\n');
    await write(path.join(directory, 'empty', 'README.md'));
    expect(await readGlobalExtensions(directory)).toEqual({
      extensions: [
        { name: '.hidden.py', kind: 'file' },
        { name: 'declared', kind: 'pyproject' },
        { name: 'single.py', kind: 'file' },
        { name: 'undeclared', kind: 'package' },
        { name: 'with-manifest', kind: 'manifest' },
      ],
      truncated: false,
    });
    expect(await readGlobalExtensions(path.join(scratch, 'absent'))).toBe('absent');
  });
});
