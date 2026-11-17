import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { isObjectReference } from '../inspect/metadata.js';
import type { ExtensionOrigin } from '../types.js';
import { isGenerationId, writeAtomic, type BundleBinding, type Layout } from './layout.js';

const POINTER_SCHEMA = 'aelix.studio.extensions.current/1';
const GENERATION_SCHEMA = 'aelix.studio.extensions.generation/1';

/** `current.json`: which generation new conversations use. */
export type Pointer = {
  schema: typeof POINTER_SCHEMA;
  generation: string;
  /** The generation before the last switch: the one-step rollback target. */
  previous: string | null;
  /** Goes up by one on every switch. A switch is refused when it moved since the candidate was made. */
  revision: number;
  binding: BundleBinding;
};

export type RecordedDistribution = { version: string; recordSha256: string; origin?: ExtensionOrigin };
export type RecordedExtension = { reference: string; distribution: string; manifestBound: boolean };

/** `generation.json`: what a finished generation holds. Its presence marks the generation complete. */
export type GenerationRecord = {
  schema: typeof GENERATION_SCHEMA;
  generation: string;
  parent: string | null;
  createdAt: string;
  binding: BundleBinding;
  operation: { action: 'install' | 'update' | 'remove'; target: string };
  /** Distributions other than the installer, by canonical name. */
  distributions: Record<string, RecordedDistribution>;
  /** `aelix.extensions` entries by entry name. */
  extensions: Record<string, RecordedExtension>;
};

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === 'string' && value !== '';
/** A generation name or null as read from disk; undefined when the value is neither. */
const optionalGeneration = (value: unknown): string | null | undefined =>
  value === null ? null : isGenerationId(value) ? value : undefined;

function parseBinding(value: unknown): BundleBinding | undefined {
  if (!isObject(value)) return undefined;
  const { bundle, target, pythonMinor, dependencyLockSha256, nativeCommit } = value;
  if (![bundle, target, pythonMinor, dependencyLockSha256, nativeCommit].every(isText)) return undefined;
  return { bundle, target, pythonMinor, dependencyLockSha256, nativeCommit } as BundleBinding;
}

function parseOrigin(value: unknown): ExtensionOrigin | undefined {
  if (!isObject(value) || value.kind !== 'file') return undefined;
  const { artifact, wheel, sha256 } = value;
  return isText(artifact) && isText(wheel) && isText(sha256) ? { kind: 'file', artifact, wheel, sha256 } : undefined;
}

/** Validate a pointer read from disk. The file is in the user area, so nothing in it is trusted. */
export function parsePointer(text: string): Pointer | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isObject(value) || value.schema !== POINTER_SCHEMA) return undefined;
  const binding = parseBinding(value.binding);
  const { generation, revision } = value;
  const previous = optionalGeneration(value.previous);
  if (!binding || !isGenerationId(generation) || previous === undefined) return undefined;
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1) return undefined;
  return { schema: POINTER_SCHEMA, generation, previous, revision, binding };
}

/** Validate a generation record read from disk. */
export function parseGenerationRecord(text: string): GenerationRecord | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isObject(value) || value.schema !== GENERATION_SCHEMA) return undefined;
  const binding = parseBinding(value.binding);
  const { generation, createdAt, operation, distributions, extensions } = value;
  const parent = optionalGeneration(value.parent);
  if (!binding || !isGenerationId(generation) || parent === undefined) return undefined;
  if (!isText(createdAt) || !isObject(operation) || !isObject(distributions) || !isObject(extensions)) return undefined;
  const { action, target } = operation;
  if ((action !== 'install' && action !== 'update' && action !== 'remove') || typeof target !== 'string')
    return undefined;
  const record: GenerationRecord = {
    schema: GENERATION_SCHEMA,
    generation,
    parent,
    createdAt,
    binding,
    operation: { action, target },
    distributions: {},
    extensions: {},
  };
  for (const [name, entry] of Object.entries(distributions)) {
    if (!isObject(entry) || !isText(entry.version) || typeof entry.recordSha256 !== 'string') return undefined;
    const origin = parseOrigin(entry.origin);
    record.distributions[name] = {
      version: entry.version,
      recordSha256: entry.recordSha256,
      ...(origin ? { origin } : {}),
    };
  }
  for (const [name, entry] of Object.entries(extensions)) {
    if (!isObject(entry) || !isText(entry.reference) || !isObjectReference(entry.reference)) return undefined;
    if (!isText(entry.distribution) || typeof entry.manifestBound !== 'boolean') return undefined;
    record.extensions[name] = {
      reference: entry.reference,
      distribution: entry.distribution,
      manifestBound: entry.manifestBound,
    };
  }
  return record;
}

/** A pointer naming `generation` as current. */
export function newPointer(
  generation: string,
  previous: string | null,
  revision: number,
  binding: BundleBinding
): Pointer {
  return { schema: POINTER_SCHEMA, generation, previous, revision, binding };
}

/** A generation record with the current schema. */
export function newGenerationRecord(fields: Omit<GenerationRecord, 'schema'>): GenerationRecord {
  return { schema: GENERATION_SCHEMA, ...fields };
}

const recordFile = (layout: Layout, generation: string): string =>
  path.join(layout.generations, generation, 'generation.json');

/** Read the record of a finished generation; undefined when it is missing, unfinished or damaged. */
export async function readGenerationRecord(layout: Layout, generation: string): Promise<GenerationRecord | undefined> {
  if (!isGenerationId(generation)) return undefined;
  try {
    const record = parseGenerationRecord(await readFile(recordFile(layout, generation), 'utf8'));
    return record?.generation === generation ? record : undefined;
  } catch {
    return undefined;
  }
}

/** Mark a generation complete by writing its record. This is the last write into a generation. */
export async function writeGenerationRecord(layout: Layout, record: GenerationRecord): Promise<void> {
  await writeAtomic(recordFile(layout, record.generation), JSON.stringify(record, null, 2) + '\n');
}

export type PointerState = {
  /** The pointer in effect, or null when there is none: start from the bundle alone. */
  pointer: Pointer | null;
  /** The record of the generation it names. */
  record: GenerationRecord | null;
  /** True when `current.json` was unusable and the copy from before the last switch is in effect. */
  recovered: boolean;
};

/**
 * Read the pointer in effect (ADR 5.6). `current.json` counts only when it parses and the
 * generation it names is complete. Otherwise the copy kept from before the last switch is
 * used, which loses that one switch. With neither, there is no generation.
 *
 * A caller that will change the pointer must hold the mutation lock before calling this.
 */
export async function readPointer(layout: Layout): Promise<PointerState> {
  const usable = async (file: string, recovered: boolean): Promise<PointerState | undefined> => {
    let pointer: Pointer | undefined;
    try {
      pointer = parsePointer(await readFile(file, 'utf8'));
    } catch {
      return undefined;
    }
    const record = pointer && (await readGenerationRecord(layout, pointer.generation));
    return pointer && record ? { pointer, record, recovered } : undefined;
  };
  return (
    (await usable(layout.pointer, false)) ??
    (await usable(layout.previousPointer, true)) ?? { pointer: null, record: null, recovered: false }
  );
}

/**
 * Make `next` the pointer in effect. `base` is the pointer that was in effect when the
 * caller took the lock; it is kept as the copy to fall back on. The copy is written
 * first, so an interruption between the two writes leaves `base` in effect either way.
 */
export async function switchPointer(layout: Layout, next: Pointer, base: Pointer | null): Promise<void> {
  if (base) await writeAtomic(layout.previousPointer, JSON.stringify(base, null, 2) + '\n');
  await writeAtomic(layout.pointer, JSON.stringify(next, null, 2) + '\n');
}
