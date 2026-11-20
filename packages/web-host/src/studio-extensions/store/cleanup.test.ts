import { mkdir, mkdtemp, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { directWriter, fakeRuntime, scriptedSpawn } from '../../../tests/fixtures/extensionRuntime';
import { collect, recover } from './cleanup';
import { ensureLayout, layoutOf, locateLayout, type Bundle, type BundleBinding, type Layout } from './layout';
import type { StateWriter } from './lock';
import { ExtensionFailure } from '../types';
import { newGenerationRecord, newPointer, readGenerationRecord, switchPointer, writeGenerationRecord } from './pointer';

const BINDING: BundleBinding = {
  bundle: '/bundle',
  target: 'darwin-arm64',
  pythonMinor: '3.12',
  dependencyLockSha256: 'lock',
  nativeCommit: 'commit',
};
const [G1, G2, G3, G4] = ['g00000001-aaaa', 'g00000002-bbbb', 'g00000003-cccc', 'g00000004-dddd'];
const [SET_A, SET_B, SET_C] = ['a'.repeat(16), 'b'.repeat(16), 'c'.repeat(16)];
const bundle = { root: '/bundle', python: '/bundle/python/bin/python3' } as Bundle;

describe('recovery and clean-up', () => {
  let layout: Layout;
  let writer: StateWriter;
  beforeEach(async () => {
    layout = await locateLayout(await mkdtemp(path.join(os.tmpdir(), 'studio-cleanup-')));
    await ensureLayout(layout);
    writer = directWriter(layout.root);
  });
  afterEach(() => rm(layout.root, { recursive: true, force: true }));
  const names = async (directory: string): Promise<string[]> => (await readdir(directory)).toSorted();
  const generation = async (id: string, artifact?: string): Promise<void> => {
    await mkdir(path.join(layout.generations, id, 'venv'), { recursive: true });
    await writeGenerationRecord(
      layout,
      newGenerationRecord({
        generation: id,
        parent: null,
        createdAt: '2026-11-17T00:00:00.000Z',
        binding: BINDING,
        operation: { action: 'install', target: 'demo' },
        distributions: artifact
          ? { demo: { version: '1', recordSha256: 'h', origin: { kind: 'file', artifact, wheel: 'w', sha256: 's' } } }
          : {},
        extensions: {},
        launch: { packs: false, modules: [] },
      })
    );
  };
  const request = (heldLeases: string[] = []) => ({
    bundle,
    layout,
    spawn: fakeRuntime({ bundle: bundle.root, heldLeases }),
    env: {},
    writer,
  });

  it('removes candidates that never finished and what interrupted writes left behind', async () => {
    await generation(G1);
    await mkdir(path.join(layout.generations, G2, 'venv'), { recursive: true });
    await mkdir(path.join(layout.generations, 'not-even-a-name'));
    await writeFile(path.join(layout.root, 'current.json.1a2b3c4d.tmp'), '{');
    await mkdir(path.join(layout.artifacts, '.staging-abcdef'));
    await mkdir(path.join(layout.artifacts, SET_A));
    expect((await recover(layout, writer)).toSorted()).toEqual([G2, 'not-even-a-name'].toSorted());
    expect(await names(layout.generations)).toEqual([G1]);
    expect(await names(layout.root)).toEqual(['artifacts', 'generations', 'leases']);
    expect(await names(layout.artifacts)).toEqual([SET_A]);
  });

  it('recovers past a partially removed generation and collects it without restoring its retired record', async () => {
    await Promise.all([generation(G1), generation(G2), generation(G3)]);
    const retired = path.join(layout.generations, G1);
    await rename(path.join(retired, 'generation.json'), path.join(layout.generations, '.retired-' + G1));
    await writeFile(path.join(retired, 'venv', 'locked.exe'), 'fixture');
    await switchPointer(layout, newPointer(G3, G2, 3, BINDING), null, writer);
    await expect(
      recover(layout, {
        replace: writer.replace,
        remove: () => Promise.reject(new Error('the retired executable is locked')),
      })
    ).resolves.toEqual([]);
    expect(await readGenerationRecord(layout, G1)).toBeUndefined();
    expect((await collect(request())).removed).toEqual([G1]);
    // The fake writer modeled a crash between removing the tree and deleting its sibling record.
    expect(await names(layout.generations)).toEqual(['.retired-' + G1, G2, G3]);
    await recover(layout, writer);
    expect(await names(layout.generations)).toEqual([G2, G3]);
  });

  it('removes a link among the generations without touching what it points at', async () => {
    const outside = await mkdtemp(path.join(os.tmpdir(), 'studio-cleanup-outside-'));
    try {
      await mkdir(path.join(outside, 'keep'));
      await writeFile(path.join(outside, 'generation.json'), '{}');
      await symlink(outside, path.join(layout.generations, G2), 'junction');
      expect(await recover(layout, writer)).toEqual([G2]);
      expect(await names(layout.generations)).toEqual([]);
      expect(await names(outside)).toEqual(['generation.json', 'keep']);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('removes nothing more once the lock holder is gone', async () => {
    await Promise.all([generation(G1), generation(G2), generation(G3), generation(G4)]);
    await switchPointer(layout, newPointer(G4, G3, 4, BINDING), null, writer);
    let asked = 0;
    const dying: StateWriter = {
      replace: writer.replace,
      remove: (relative) => {
        asked += 1;
        return asked === 1
          ? writer.remove(relative)
          : Promise.reject(new ExtensionFailure('CONFLICT', ['the lock was lost']));
      },
    };
    await expect(collect({ ...request(), writer: dying })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await names(layout.generations)).toEqual([G2, G3, G4]);
  });

  it('does nothing on a root that has no directories yet', async () => {
    const empty = layoutOf(path.join(layout.root, 'absent'));
    expect(await recover(empty, directWriter(empty.root))).toEqual([]);
  });

  it('keeps the current and the previous generation and removes older ones with their wheels', async () => {
    await Promise.all([generation(G1, SET_A), generation(G2, SET_B), generation(G3, SET_C)]);
    await Promise.all([SET_A, SET_B, SET_C].map((set) => mkdir(path.join(layout.artifacts, set))));
    await switchPointer(layout, newPointer(G3, G2, 3, BINDING), null, writer);
    const report = await collect(request());
    expect(report).toEqual({ removed: [G1], leased: [], removedArtifacts: [SET_A], skipped: false });
    expect(await names(layout.generations)).toEqual([G2, G3]);
    expect(await names(layout.artifacts)).toEqual([SET_B, SET_C]);
  });

  it('keeps a generation a running launcher holds, with its wheels, and drops leases nobody holds', async () => {
    await Promise.all([generation(G1, SET_A), generation(G2), generation(G3), generation(G4)]);
    await mkdir(path.join(layout.artifacts, SET_A));
    await writeFile(path.join(layout.leases, `${G1}.4711`), '');
    await writeFile(path.join(layout.leases, `${G2}.4712`), '');
    await switchPointer(layout, newPointer(G4, G3, 4, BINDING), null, writer);
    const report = await collect(request([`${G1}.4711`]));
    expect(report).toMatchObject({ removed: [G2], leased: [G1], removedArtifacts: [] });
    expect(await names(layout.generations)).toEqual([G1, G3, G4]);
    expect(await names(layout.leases)).toEqual([`${G1}.4711`]);
  });

  it('removes nothing when it cannot tell which generations are in use', async () => {
    await Promise.all([generation(G1), generation(G2), generation(G3)]);
    await writeFile(path.join(layout.leases, `${G1}.4711`), '');
    await switchPointer(layout, newPointer(G3, G2, 3, BINDING), null, writer);
    const failing = scriptedSpawn((_spec, child) => child.exit(1));
    expect(await collect({ bundle, layout, spawn: failing, env: {}, writer })).toMatchObject({
      removed: [],
      skipped: true,
    });
    expect(await names(layout.generations)).toEqual([G1, G2, G3]);
    expect(await names(layout.leases)).toEqual([`${G1}.4711`]);
  });

  it('keeps every generation when there is no usable pointer, and only drops wheels none of them uses', async () => {
    await Promise.all([generation(G1, SET_A), generation(G2)]);
    await Promise.all([SET_A, SET_B].map((set) => mkdir(path.join(layout.artifacts, set))));
    await writeFile(layout.pointer, 'garbage');
    expect(await collect(request())).toEqual({ removed: [], leased: [], removedArtifacts: [SET_B], skipped: false });
    expect(await names(layout.generations)).toEqual([G1, G2]);
    expect(await names(layout.artifacts)).toEqual([SET_A]);
  });
});
