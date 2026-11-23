/**
 * Reading the terminal CLI from its files: the interpreter a launcher names, the extensions of
 * its virtual environment, and its global extension directory. Nothing is run.
 */
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readGlobalExtensions } from './globalDirectory';
import { readHead, readLauncherInterpreter } from './launcher';
import { readCliVenv } from './venv';

let scratch = '';
beforeEach(async () => {
  scratch = await mkdtemp(path.join(os.tmpdir(), 'studio-terminal-'));
});
afterEach(() => rm(scratch, { recursive: true, force: true }));

const write = async (file: string, text = ''): Promise<void> => {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
};

/** A distribution in `site`, with an optional `entry_points.txt`. */
const distribution = (site: string, name: string, version: string, entryPoints?: string): Promise<void[]> =>
  Promise.all([
    write(path.join(site, `${name}-${version}.dist-info`, 'METADATA'), `Name: ${name}\nVersion: ${version}\n`),
    write(path.join(site, `${name}-${version}.dist-info`, 'RECORD'), ''),
    ...(entryPoints ? [write(path.join(site, `${name}-${version}.dist-info`, 'entry_points.txt'), entryPoints)] : []),
  ]);

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

  it('reads only the head of a regular file, and never waits on a FIFO', async () => {
    const launcher = path.join(scratch, 'aelix');
    await write(launcher, '#!/opt/python\n' + 'x'.repeat(10000));
    expect((await readHead(launcher))?.length).toBe(4096);
    expect(await readHead(path.join(scratch, 'missing'))).toBeUndefined();
    expect(await readHead(scratch)).toBeUndefined();
    if (process.platform !== 'win32') {
      const fifo = path.join(scratch, 'fifo');
      execFileSync('mkfifo', [fifo]);
      expect(await readHead(fifo)).toBeUndefined();
    }
  });
});

describe('the terminal CLI virtual environment', () => {
  const posixSite = (root: string) => path.join(root, 'lib', 'python3.12', 'site-packages');

  it('lists the aelix.extensions entry points of the environment that holds the CLI', async () => {
    const root = path.join(scratch, 'tools', 'aelix');
    await write(path.join(root, 'pyvenv.cfg'), 'home = /opt/python/bin\n');
    const site = posixSite(root);
    await distribution(site, 'aelix', '0.1.0b2', '[console_scripts]\naelix = aelix_coding_agent.cli.entry:main_sync\n');
    await distribution(site, 'Aelix_Memory', '0.4.0', '[aelix.extensions]\nmemory = aelix_memory:setup\n');
    await distribution(site, 'aelix-webtool', '0.2.0', '[aelix.extensions]\nwebtool = aelix_webtool\n[other]\nx = y\n');
    await distribution(site, 'requests', '2.0');
    expect(await readCliVenv(root, 'darwin')).toEqual({
      nativeVersion: '0.1.0b2',
      extensions: [
        { name: 'memory', distribution: 'Aelix_Memory', version: '0.4.0', reference: 'aelix_memory:setup' },
        { name: 'webtool', distribution: 'aelix-webtool', version: '0.2.0', reference: 'aelix_webtool' },
      ],
      problems: [],
    });
  });

  it('reads the Windows layout, and reports what cannot be a ledger', async () => {
    const root = path.join(scratch, 'pipx', 'venvs', 'aelix');
    await write(path.join(root, 'pyvenv.cfg'), '');
    const site = path.join(root, 'Lib', 'site-packages');
    await distribution(site, 'aelix-coding-agent', '0.1.0');
    await distribution(site, 'one', '1.0', '[aelix.extensions]\nsame = one:setup\n');
    await distribution(site, 'two', '1.0', '[aelix.extensions]\nsame = two:setup\n');
    const venv = await readCliVenv(root, 'win32');
    expect(venv).toMatchObject({
      nativeVersion: '0.1.0',
      extensions: [{ name: 'same', distribution: 'one' }],
      problems: ['extension same is provided twice'],
    });
    // The POSIX layout is not looked for on Windows, nor the other way round.
    expect(await readCliVenv(root, 'linux')).toBe('no_cli');
  });

  it('tells a directory that is not a virtual environment from one without the CLI', async () => {
    expect(await readCliVenv(path.join(scratch, 'absent'), 'linux')).toBe('not_a_venv');
    const plain = path.join(scratch, 'plain');
    await write(path.join(plain, 'lib', 'python3.12', 'site-packages', 'x.py'));
    expect(await readCliVenv(plain, 'linux')).toBe('not_a_venv');
    const other = path.join(scratch, 'other');
    await write(path.join(other, 'pyvenv.cfg'));
    await distribution(posixSite(other), 'ruff', '0.9');
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
    expect(await readGlobalExtensions(directory)).toEqual([
      { name: '.hidden.py', kind: 'file' },
      { name: 'declared', kind: 'pyproject' },
      { name: 'single.py', kind: 'file' },
      { name: 'undeclared', kind: 'package' },
      { name: 'with-manifest', kind: 'manifest' },
    ]);
    expect(await readGlobalExtensions(path.join(scratch, 'absent'))).toEqual([]);
  });
});
