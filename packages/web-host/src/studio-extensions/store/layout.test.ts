import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFakeBundle } from '../../../tests/fixtures/extensionRuntime';
import {
  ensureLayout,
  generationId,
  generationPaths,
  isGenerationId,
  layoutOf,
  locateLayout,
  readBundleFacts,
  resolveBundle,
  sameBinding,
  stateRelative,
  verifyLayout,
  writeAtomic,
  writeConstraints,
} from './layout';

describe('helper layout', () => {
  let scratch = '';
  beforeEach(async () => {
    scratch = await realpath(await mkdtemp(path.join(os.tmpdir(), 'studio-layout-')));
  });
  afterEach(() => rm(scratch, { recursive: true, force: true }));

  it('keeps everything under one root and creates the shared directories', async () => {
    const layout = layoutOf(path.join(scratch, 'Application Support', 'aelix-runtime'));
    expect(Object.values(layout).every((file) => file.startsWith(layout.root))).toBe(true);
    await ensureLayout(layout);
    expect((await readdir(layout.root)).toSorted()).toEqual(['artifacts', 'generations', 'leases']);
  });

  it('resolves the state directory through links, also before it exists', async () => {
    const real = path.join(scratch, 'real data');
    await mkdir(real);
    await symlink(real, path.join(scratch, 'linked data'), 'junction');
    expect((await locateLayout(path.join(scratch, 'linked data', 'aelix-runtime'))).root).toBe(
      path.join(real, 'aelix-runtime')
    );
    await mkdir(path.join(real, 'aelix-runtime'));
    expect((await locateLayout(path.join(scratch, 'linked data', 'aelix-runtime'))).root).toBe(
      path.join(real, 'aelix-runtime')
    );
  });

  it.each(['generations', 'artifacts', 'leases'] as const)(
    'refuses a state directory whose %s directory is a link to somewhere else',
    async (name) => {
      const layout = layoutOf(path.join(scratch, 'root'));
      const outside = path.join(scratch, 'outside');
      await mkdir(layout.root);
      await mkdir(outside);
      await symlink(outside, layout[name], 'junction');
      await expect(ensureLayout(layout)).rejects.toMatchObject({ code: 'UNSAFE_ROOT' });
      await expect(verifyLayout(layout)).rejects.toMatchObject({ code: 'UNSAFE_ROOT' });
      expect(await readdir(outside)).toEqual([]);
    }
  );

  it('refuses a state directory that is reached through a link, and one whose directory is a file', async () => {
    const real = path.join(scratch, 'real');
    await mkdir(real);
    await symlink(real, path.join(scratch, 'link'), 'junction');
    await expect(ensureLayout(layoutOf(path.join(scratch, 'link')))).rejects.toMatchObject({ code: 'UNSAFE_ROOT' });
    const layout = layoutOf(path.join(scratch, 'root'));
    await mkdir(layout.root);
    await writeFile(layout.leases, 'not a directory');
    await expect(ensureLayout(layout)).rejects.toMatchObject({ code: 'UNSAFE_ROOT' });
  });

  it('has nothing to object to before anything was created', async () => {
    await expect(verifyLayout(layoutOf(path.join(scratch, 'absent')))).resolves.toBeUndefined();
  });

  it('names only what sits directly in the root or in a dedicated directory', () => {
    const layout = layoutOf(path.join(scratch, 'root'));
    const relative = (...parts: string[]): string | undefined =>
      stateRelative(layout, path.join(layout.root, ...parts));
    expect([relative('current.json'), relative('generations', 'g1'), relative('leases', 'g1.4711')]).toEqual([
      'current.json',
      'generations/g1',
      'leases/g1.4711',
    ]);
    expect([
      relative(),
      relative('generations', 'g1', 'venv'),
      relative('elsewhere', 'g1'),
      relative('..', 'outside'),
      stateRelative(layout, path.join(scratch, 'other')),
    ]).toEqual(Array(5).fill(undefined));
  });

  it('lays a generation out the way venv does on each platform', () => {
    const layout = layoutOf(path.join(scratch, 'root'));
    const posix = generationPaths(layout, 'g00000001-abcd', '3.12', 'darwin');
    const windows = generationPaths(layout, 'g00000001-abcd', '3.12', 'win32');
    expect(path.relative(posix.directory, posix.python)).toBe(path.join('venv', 'bin', 'python'));
    expect(path.relative(posix.directory, posix.site)).toBe(path.join('venv', 'lib', 'python3.12', 'site-packages'));
    expect(path.relative(windows.directory, windows.python)).toBe(path.join('venv', 'Scripts', 'python.exe'));
    expect(path.relative(windows.directory, windows.site)).toBe(path.join('venv', 'Lib', 'site-packages'));
    expect(path.relative(posix.directory, posix.record)).toBe('generation.json');
  });

  it('names generations with a fixed length so interpreter paths never change length', () => {
    expect(generationId(1, 'abcd')).toBe('g00000001-abcd');
    expect(generationId(123456, '00ff')).toHaveLength(generationId(1, 'abcd').length);
  });

  it('accepts only generation names it could have made itself', () => {
    expect(isGenerationId('g00000001-abcd')).toBe(true);
    expect(
      ['../outside', 'g1', 'g00000001-ABCD', 'g00000001-abcd/..', 'g00000001.abcd', '', 7, null].map(isGenerationId)
    ).toEqual(Array(8).fill(false));
  });

  it('replaces a file without leaving a temporary file behind', async () => {
    const file = path.join(scratch, 'pointer.json');
    await writeAtomic(file, 'one');
    await writeAtomic(file, 'two');
    expect(await readFile(file, 'utf8')).toBe('two');
    expect(await readdir(scratch)).toEqual(['pointer.json']);
  });

  it('removes its temporary file when the target cannot be replaced', async () => {
    await mkdir(path.join(scratch, 'taken'));
    await expect(writeAtomic(path.join(scratch, 'taken'), 'x')).rejects.toThrow();
    expect(await readdir(scratch)).toEqual(['taken']);
  });
});

describe('the bundled runtime', () => {
  let scratch = '';
  beforeEach(async () => {
    scratch = await realpath(await mkdtemp(path.join(os.tmpdir(), 'studio-bundle-')));
  });
  afterEach(() => rm(scratch, { recursive: true, force: true }));
  const manifest = async (bundle: string, change: (value: Record<string, unknown>) => void): Promise<void> => {
    const file = path.join(bundle, 'manifest.json');
    const value = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    change(value);
    await writeFile(file, JSON.stringify(value));
  };

  it('binds a generation to location, target, Python minor, dependency lock and native commit', async () => {
    const root = await createFakeBundle(path.join(scratch, 'bundle'), { platform: 'darwin', arch: 'arm64' });
    const bundle = await resolveBundle(root, 'darwin', 'arm64');
    expect(bundle?.binding).toEqual({
      bundle: root,
      target: 'darwin-arm64',
      pythonMinor: '3.12',
      dependencyLockSha256: 'a'.repeat(64),
      nativeCommit: 'c'.repeat(40),
    });
    expect(bundle?.python).toBe(path.join(root, 'python', 'bin', 'python3'));
    expect(bundle?.launcher).toBe(path.join(root, 'launch.py'));
  });

  it('uses python.exe at the top of the bundle on Windows', async () => {
    const root = await createFakeBundle(path.join(scratch, 'bundle'), { platform: 'win32', arch: 'x64' });
    expect((await resolveBundle(root, 'win32', 'x64'))?.python).toBe(path.join(root, 'python', 'python.exe'));
  });

  it.each<[string, (bundle: string) => Promise<void>]>([
    ['is for another platform', (bundle) => manifest(bundle, (value) => (value.target = 'linux-x64'))],
    ['has another schema', (bundle) => manifest(bundle, (value) => (value.schema = 'other/1'))],
    ['names no dependency lock', (bundle) => manifest(bundle, (value) => delete value.dependencyLockSha256)],
    ['names no native commit', (bundle) => manifest(bundle, (value) => (value.native = {}))],
    ['has an unreadable Python version', (bundle) => manifest(bundle, (value) => (value.python = 'three'))],
    ['has a damaged manifest', (bundle) => writeFile(path.join(bundle, 'manifest.json'), '{')],
    ['has no manifest', (bundle) => rm(path.join(bundle, 'manifest.json'))],
    ['has no interpreter', (bundle) => rm(path.join(bundle, 'python'), { recursive: true })],
    ['has no launcher', (bundle) => rm(path.join(bundle, 'launch.py'))],
  ])('does not accept a directory that %s', async (_what, damage) => {
    const root = await createFakeBundle(path.join(scratch, 'bundle'), { platform: 'darwin', arch: 'arm64' });
    await damage(root);
    expect(await resolveBundle(root, 'darwin', 'arm64')).toBeUndefined();
  });

  it('does not accept a path that does not exist', async () => {
    expect(await resolveBundle(path.join(scratch, 'absent'), 'darwin', 'arm64')).toBeUndefined();
  });

  it('compares every part of a binding', () => {
    const binding = { bundle: '/b', target: 't', pythonMinor: '3.12', dependencyLockSha256: 'l', nativeCommit: 'c' };
    expect(sameBinding(binding, { ...binding })).toBe(true);
    for (const key of Object.keys(binding)) expect(sameBinding(binding, { ...binding, [key]: 'other' })).toBe(false);
  });

  it('reads what the bundle ships and writes it as constraints behind a file URL', async () => {
    const root = await createFakeBundle(path.join(scratch, 'bundle'), {
      platform: 'darwin',
      arch: 'arm64',
      distributions: { Typing_Extensions: '4.15.0', packaging: '26.3' },
    });
    const bundle = await resolveBundle(root, 'darwin', 'arm64');
    if (!bundle) throw new Error('fixture bundle did not resolve');
    const facts = await readBundleFacts(bundle);
    expect([...facts.distributions]).toEqual([
      ['typing-extensions', '4.15.0'],
      ['packaging', '26.3'],
    ]);
    expect([...facts.topLevel].toSorted()).toEqual(['packaging', 'typing_extensions']);
    const layout = layoutOf(path.join(scratch, 'Application Support', '스튜디오'));
    await ensureLayout(layout);
    const url = await writeConstraints(layout, bundle, facts);
    expect(url).toMatch(/^file:\/\/.*Application%20Support.*constraints-aaaaaaaaaaaa\.txt$/);
    expect(url).not.toContain(' ');
    expect(await readFile(fileURLToPath(url), 'utf8')).toBe('packaging==26.3\ntyping-extensions==4.15.0\n');
  });
});
