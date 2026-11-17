import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ExtensionFailure } from '../types';
import {
  discardStage,
  hashFile,
  isImportSetId,
  promoteImport,
  pruneArtifacts,
  removeStaging,
  stageImport,
} from './artifacts';
import { directWriter } from '../../../tests/fixtures/extensionRuntime';
import { ensureLayout, locateLayout, type Layout } from './layout';
import type { StateWriter } from './lock';

describe('the store of imported wheels', () => {
  let scratch = '';
  let layout: Layout;
  let writer: StateWriter;
  let folder = '';
  beforeEach(async () => {
    scratch = await realpath(await mkdtemp(path.join(os.tmpdir(), 'studio-artifacts-')));
    layout = await locateLayout(path.join(scratch, 'root'));
    folder = path.join(scratch, 'downloads');
    await ensureLayout(layout);
    writer = directWriter(layout.root);
    await mkdir(folder);
  });
  afterEach(() => rm(scratch, { recursive: true, force: true }));
  const file = async (name: string, content: string, directory = folder): Promise<string> => {
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, name), content);
    return path.join(directory, name);
  };
  const names = async (directory: string): Promise<string[]> => (await readdir(directory)).toSorted();
  const refusal = async (work: Promise<unknown>): Promise<string | undefined> => {
    const failure = await work.catch((error: unknown) => error);
    return failure instanceof ExtensionFailure ? failure.code : undefined;
  };

  it('copies only the requested wheel when no folder is given', async () => {
    const target = await file('demo-1.0-py3-none-any.whl', 'demo');
    await file('other-1.0-py3-none-any.whl', 'other');
    const staged = await stageImport(layout, { kind: 'file', path: target }, writer);
    expect(await names(staged.directory)).toEqual(['demo-1.0-py3-none-any.whl']);
    expect(staged.target).toBe(path.join(staged.directory, 'demo-1.0-py3-none-any.whl'));
    expect(path.dirname(staged.directory)).toBe(layout.artifacts);
  });

  it('takes the wheels of the folder and nothing else from it', async () => {
    const target = await file('demo-1.0-py3-none-any.whl', 'demo');
    await file('lib-2.0-py3-none-any.whl', 'lib');
    await file('notes.txt', 'text');
    await file('source-1.0.tar.gz', 'sdist');
    await mkdir(path.join(folder, 'nested.whl'));
    const staged = await stageImport(layout, { kind: 'file', path: target, folder }, writer);
    expect(staged.files.map((entry) => path.basename(entry))).toEqual([
      'demo-1.0-py3-none-any.whl',
      'lib-2.0-py3-none-any.whl',
    ]);
  });

  it('prefers the requested wheel over a folder entry of the same file name', async () => {
    const target = await file('demo-1.0-py3-none-any.whl', 'requested', path.join(scratch, 'elsewhere'));
    await file('demo-1.0-py3-none-any.whl', 'from the folder');
    const staged = await stageImport(layout, { kind: 'file', path: target, folder }, writer);
    expect(await readFile(staged.target, 'utf8')).toBe('requested');
  });

  it('refuses a request that does not name a wheel file', async () => {
    const stage = (target: string): Promise<unknown> => stageImport(layout, { kind: 'file', path: target }, writer);
    expect(await refusal(stage(await file('source-1.0.tar.gz', 'sdist')))).toBe('NOT_A_WHEEL');
    expect(await refusal(stage(path.join(folder, 'absent-1.0-py3-none-any.whl')))).toBe('NOT_A_WHEEL');
    await mkdir(path.join(folder, 'directory.whl'));
    expect(await refusal(stage(path.join(folder, 'directory.whl')))).toBe('NOT_A_WHEEL');
    expect(await names(layout.artifacts)).toEqual([]);
  });

  it('refuses a dependency folder it cannot read', async () => {
    const target = await file('demo-1.0-py3-none-any.whl', 'demo');
    const request = stageImport(layout, { kind: 'file', path: target, folder: path.join(scratch, 'absent') }, writer);
    expect(await refusal(request)).toBe('INVALID_INPUT');
  });

  it('stores a set under a name derived from its content, with the hash of every file', async () => {
    const target = await file('demo-1.0-py3-none-any.whl', 'demo');
    await file('lib-2.0-py3-none-any.whl', 'lib');
    const stored = await promoteImport(
      layout,
      await stageImport(layout, { kind: 'file', path: target, folder }, writer),
      writer
    );
    const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
    expect(stored.digests).toEqual({
      'demo-1.0-py3-none-any.whl': sha('demo'),
      'lib-2.0-py3-none-any.whl': sha('lib'),
    });
    expect(isImportSetId(stored.id)).toBe(true);
    expect(stored.target).toBe(path.join(layout.artifacts, stored.id, 'demo-1.0-py3-none-any.whl'));
    expect(await names(layout.artifacts)).toEqual([stored.id]);
    expect(JSON.parse(await readFile(path.join(stored.directory, 'sha256.json'), 'utf8'))).toEqual(stored.digests);
    expect(await hashFile(stored.target)).toBe(sha('demo'));
  });

  it('reuses the stored copy when the same wheels are imported again', async () => {
    const target = await file('demo-1.0-py3-none-any.whl', 'demo');
    const first = await promoteImport(
      layout,
      await stageImport(layout, { kind: 'file', path: target }, writer),
      writer
    );
    const second = await promoteImport(
      layout,
      await stageImport(layout, { kind: 'file', path: target }, writer),
      writer
    );
    expect(second.id).toBe(first.id);
    expect(await names(layout.artifacts)).toEqual([first.id]);
  });

  it('replaces a stored copy whose bytes no longer match its name', async () => {
    const target = await file('demo-1.0-py3-none-any.whl', 'demo');
    const first = await promoteImport(
      layout,
      await stageImport(layout, { kind: 'file', path: target }, writer),
      writer
    );
    await writeFile(first.target, 'tampered');
    const second = await promoteImport(
      layout,
      await stageImport(layout, { kind: 'file', path: target }, writer),
      writer
    );
    expect(await readFile(second.target, 'utf8')).toBe('demo');
  });

  it('does not trust a stored set that is a link to somewhere else', async () => {
    const target = await file('demo-1.0-py3-none-any.whl', 'demo');
    const first = await promoteImport(
      layout,
      await stageImport(layout, { kind: 'file', path: target }, writer),
      writer
    );
    const elsewhere = path.join(scratch, 'elsewhere');
    await mkdir(elsewhere);
    await writeFile(path.join(elsewhere, 'demo-1.0-py3-none-any.whl'), 'demo');
    await rm(first.directory, { recursive: true });
    await symlink(elsewhere, first.directory, 'junction');
    const second = await promoteImport(
      layout,
      await stageImport(layout, { kind: 'file', path: target }, writer),
      writer
    );
    expect((await lstat(second.directory)).isSymbolicLink()).toBe(false);
    expect(await names(elsewhere)).toEqual(['demo-1.0-py3-none-any.whl']);
  });

  it('gives a changed wheel a different set', async () => {
    const target = await file('demo-1.0-py3-none-any.whl', 'demo');
    const first = await promoteImport(
      layout,
      await stageImport(layout, { kind: 'file', path: target }, writer),
      writer
    );
    await writeFile(target, 'rebuilt');
    const second = await promoteImport(
      layout,
      await stageImport(layout, { kind: 'file', path: target }, writer),
      writer
    );
    expect(second.id).not.toBe(first.id);
  });

  it('drops staging directories, and with pruning every set no generation refers to', async () => {
    const target = await file('demo-1.0-py3-none-any.whl', 'demo');
    const kept = await promoteImport(layout, await stageImport(layout, { kind: 'file', path: target }, writer), writer);
    await writeFile(target, 'other');
    const dropped = await promoteImport(
      layout,
      await stageImport(layout, { kind: 'file', path: target }, writer),
      writer
    );
    const discarded = await stageImport(layout, { kind: 'file', path: target }, writer);
    await discardStage(layout, discarded, writer);
    await stageImport(layout, { kind: 'file', path: target }, writer);
    expect(await names(layout.artifacts)).toHaveLength(3);
    await removeStaging(layout, writer);
    expect(await names(layout.artifacts)).toEqual([kept.id, dropped.id].toSorted());
    expect(await pruneArtifacts(layout, new Set([kept.id]), writer)).toEqual([dropped.id]);
    expect(await names(layout.artifacts)).toEqual([kept.id]);
  });

  it('accepts only store names it could have made itself', () => {
    expect(['0123456789abcdef', '../outside', '0123456789ABCDEF', '0123', undefined].map(isImportSetId)).toEqual([
      true,
      false,
      false,
      false,
      false,
    ]);
  });
});
