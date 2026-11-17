import { mkdir, mkdtemp, readFile, rm, truncate, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureLayout, layoutOf, type BundleBinding, type Layout } from './layout';
import {
  newGenerationRecord,
  newPointer,
  parseGenerationRecord,
  parsePointer,
  readGenerationRecord,
  readPointer,
  switchPointer,
  writeGenerationRecord,
  type GenerationRecord,
} from './pointer';

const BINDING: BundleBinding = {
  bundle: '/bundle',
  target: 'darwin-arm64',
  pythonMinor: '3.12',
  dependencyLockSha256: 'lock',
  nativeCommit: 'commit',
};
const [G1, G2, G3] = ['g00000001-aaaa', 'g00000002-bbbb', 'g00000003-cccc'];

const record = (generation: string, parent: string | null = null): GenerationRecord =>
  newGenerationRecord({
    generation,
    parent,
    createdAt: '2026-11-17T00:00:00.000Z',
    binding: BINDING,
    operation: { action: 'install', target: 'demo' },
    distributions: {
      demo: {
        version: '1.0',
        recordSha256: 'hash',
        origin: { kind: 'file', artifact: '0123456789abcdef', wheel: 'demo-1.0-py3-none-any.whl', sha256: 'digest' },
      },
      lib: { version: '2.0', recordSha256: 'other' },
    },
    extensions: { demo: { reference: 'demo:setup', distribution: 'demo', manifestBound: true } },
  });

describe('pointer and generation records read from disk', () => {
  const pointer = JSON.stringify(newPointer(G2, G1, 2, BINDING));
  const change = (text: string, edit: (value: Record<string, unknown>) => void): string => {
    const value = JSON.parse(text) as Record<string, unknown>;
    edit(value);
    return JSON.stringify(value);
  };

  it('reads back a pointer it wrote', () => {
    expect(parsePointer(pointer)).toEqual(newPointer(G2, G1, 2, BINDING));
    expect(parsePointer(JSON.stringify(newPointer(G1, null, 1, BINDING)))?.previous).toBeNull();
  });

  it.each<[string, (value: Record<string, unknown>) => void]>([
    ['another schema', (value) => (value.schema = 'other')],
    ['a generation name that leaves the directory', (value) => (value.generation = '../../outside')],
    ['a previous generation that is not a name', (value) => (value.previous = 'g1')],
    ['no revision', (value) => delete value.revision],
    ['revision zero', (value) => (value.revision = 0)],
    ['a fractional revision', (value) => (value.revision = 1.5)],
    ['no binding', (value) => delete value.binding],
    ['an incomplete binding', (value) => (value.binding = { bundle: '/bundle' })],
  ])('does not accept a pointer with %s', (_what, edit) => {
    expect(parsePointer(change(pointer, edit))).toBeUndefined();
  });

  it('does not accept text that is not a JSON object', () => {
    expect(['', '{"schema"', '[]', 'null', '"text"'].map(parsePointer)).toEqual(Array(5).fill(undefined));
  });

  it('reads back a generation record it wrote, with and without an origin', () => {
    expect(parseGenerationRecord(JSON.stringify(record(G2, G1)))).toEqual(record(G2, G1));
  });

  it.each<[string, (value: Record<string, unknown>) => void]>([
    ['another schema', (value) => (value.schema = 'other')],
    ['a parent that is not a generation name', (value) => (value.parent = '..')],
    ['an unknown operation', (value) => (value.operation = { action: 'adopt', target: 'x' })],
    ['a distribution without a version', (value) => (value.distributions = { demo: { recordSha256: 'h' } })],
    [
      'an extension reference that could be read as an option',
      (value) => (value.extensions = { demo: { reference: '--trust', distribution: 'demo', manifestBound: true } }),
    ],
    [
      'an extension without a binding verdict',
      (value) => (value.extensions = { demo: { reference: 'demo:setup', distribution: 'demo' } }),
    ],
  ])('does not accept a generation record with %s', (_what, edit) => {
    expect(parseGenerationRecord(change(JSON.stringify(record(G1)), edit))).toBeUndefined();
  });

  it('drops an origin it does not understand instead of trusting it', () => {
    const text = change(JSON.stringify(record(G1)), (value) => {
      (value.distributions as Record<string, Record<string, unknown>>).demo.origin = { kind: 'index', url: 'x' };
    });
    expect(parseGenerationRecord(text)?.distributions.demo).toEqual({ version: '1.0', recordSha256: 'hash' });
  });
});

describe('the pointer in effect', () => {
  let layout: Layout;
  beforeEach(async () => {
    layout = layoutOf(await mkdtemp(path.join(os.tmpdir(), 'studio-pointer-')));
    await ensureLayout(layout);
  });
  afterEach(() => rm(layout.root, { recursive: true, force: true }));
  const complete = async (generation: string, parent: string | null = null): Promise<void> => {
    await mkdir(path.join(layout.generations, generation), { recursive: true });
    await writeGenerationRecord(layout, record(generation, parent));
  };

  it('is absent before anything was installed', async () => {
    expect(await readPointer(layout)).toEqual({ pointer: null, record: null, recovered: false });
  });

  it('is the current pointer when its generation is complete', async () => {
    await complete(G1);
    await switchPointer(layout, newPointer(G1, null, 1, BINDING), null);
    const state = await readPointer(layout);
    expect(state).toMatchObject({ pointer: { generation: G1, revision: 1 }, recovered: false });
    expect(state.record?.generation).toBe(G1);
  });

  it('keeps the pointer before the switch as a copy, and no copy on the first switch', async () => {
    await complete(G1);
    await complete(G2, G1);
    const first = newPointer(G1, null, 1, BINDING);
    await switchPointer(layout, first, null);
    await expect(readFile(layout.previousPointer, 'utf8')).rejects.toThrow();
    await switchPointer(layout, newPointer(G2, G1, 2, BINDING), first);
    expect(parsePointer(await readFile(layout.previousPointer, 'utf8'))).toEqual(first);
    expect((await readPointer(layout)).pointer?.generation).toBe(G2);
  });

  it('falls back to the copy when the current pointer was cut short, losing one switch', async () => {
    await complete(G1);
    await complete(G2, G1);
    const first = newPointer(G1, null, 1, BINDING);
    await switchPointer(layout, first, null);
    await switchPointer(layout, newPointer(G2, G1, 2, BINDING), first);
    await truncate(layout.pointer, 25);
    expect(await readPointer(layout)).toMatchObject({ pointer: first, recovered: true });
  });

  it('falls back to the copy when the current pointer names an unfinished generation', async () => {
    await complete(G1);
    const first = newPointer(G1, null, 1, BINDING);
    await switchPointer(layout, first, null);
    await mkdir(path.join(layout.generations, G2));
    await switchPointer(layout, newPointer(G2, G1, 2, BINDING), first);
    expect(await readPointer(layout)).toMatchObject({ pointer: first, recovered: true });
  });

  it('is absent when neither pointer can be used, so the bundle starts alone', async () => {
    await writeFile(layout.pointer, 'garbage');
    await writeFile(layout.previousPointer, JSON.stringify(newPointer(G3, null, 3, BINDING)));
    expect(await readPointer(layout)).toEqual({ pointer: null, record: null, recovered: false });
  });

  it('does not take a record that belongs to another generation directory', async () => {
    await mkdir(path.join(layout.generations, G1), { recursive: true });
    await writeFile(path.join(layout.generations, G1, 'generation.json'), JSON.stringify(record(G2)));
    expect(await readGenerationRecord(layout, G1)).toBeUndefined();
    expect(await readGenerationRecord(layout, '../outside')).toBeUndefined();
  });
});
