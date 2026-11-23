import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseIndexRequirement, parseSubdirectory } from '../flow/online/source.js';
import { isAdapterReference, isObjectReference } from '../inspect/metadata.js';
import type { LaunchForm } from '../launch/form.js';
import { isManagedId, managedExtensionId, parseManagedCatalog } from '../launch/managedCatalog.js';
import { ExtensionFailure, type ExtensionOrigin } from '../types.js';
import { isGenerationId, writeAtomic, writeTemporary, type BundleBinding, type Layout } from './layout.js';
import type { StateWriter } from './lock.js';

const POINTER_SCHEMA = 'aelix.studio.extensions.current/1';
const GENERATION_SCHEMA = 'aelix.studio.extensions.generation/2';

/** `current.json`: which generation new conversations use. */
export type Pointer = {
  schema: typeof POINTER_SCHEMA;
  generation: string;
  /** The generation before the last switch: the one-step rollback target. */
  previous: string | null;
  /** Goes up by one on every switch. A switch is refused when it moved since the candidate was made. */
  revision: number;
  binding: BundleBinding;
  /** Explicit app defaults, keyed by the managed IDs in this generation. Missing means enabled. */
  defaults?: Record<string, boolean>;
};

export type RecordedDistribution = { version: string; recordSha256: string; origin?: ExtensionOrigin };
export type RecordedExtension = {
  reference: string;
  distribution: string;
  /** native's `extension verify` verdict for the installed entry point. */
  manifestBound: boolean;
  /** How conversations get it (decision B5): `pack` binds its manifest, `module` loads its code only. */
  form: 'pack' | 'module';
  /** The plugin id a conversation reports for a pack; null for a module reference. */
  plugin: string | null;
};

/** `generation.json`: what a finished generation holds. Its presence marks the generation complete. */
export type GenerationRecord = {
  schema: typeof GENERATION_SCHEMA;
  generation: string;
  parent: string | null;
  createdAt: string;
  binding: BundleBinding;
  operation: { action: 'install' | 'update' | 'upgrade' | 'remove'; target: string };
  /** Distributions other than the installer, by canonical name. */
  distributions: Record<string, RecordedDistribution>;
  /** `aelix.extensions` entries by entry name. */
  extensions: Record<string, RecordedExtension>;
  /** What the launcher passes to conversations; verified by the conversation load check. */
  launch: LaunchForm;
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
  if (!isObject(value)) return undefined;
  const { kind, artifact, wheel, sha256, indexUrl, url, commit, subdirectory, requirement } = value;
  if (kind === 'file' && isText(artifact) && isText(wheel) && isText(sha256)) return { kind, artifact, wheel, sha256 };
  if (kind === 'index' && isText(indexUrl)) {
    if (requirement === undefined) return { kind, indexUrl };
    const parsed = parseIndexRequirement(requirement);
    return parsed && { kind, indexUrl, requirement: parsed.text };
  }
  if (
    kind === 'git' &&
    isText(indexUrl) &&
    isText(url) &&
    typeof commit === 'string' &&
    /^[a-f0-9]{40,64}$/.test(commit)
  ) {
    if (subdirectory === undefined) return { kind, indexUrl, url, commit };
    const checked = parseSubdirectory(subdirectory);
    return checked === undefined ? undefined : { kind, indexUrl, url, commit, subdirectory: checked };
  }
  return undefined;
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
  const { generation, revision, defaults } = value;
  const previous = optionalGeneration(value.previous);
  if (!binding || !isGenerationId(generation) || previous === undefined) return undefined;
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1) return undefined;
  if (
    defaults !== undefined &&
    (!isObject(defaults) ||
      Object.entries(defaults).some(([id, enabled]) => !isManagedId(id) || typeof enabled !== 'boolean'))
  )
    return undefined;
  return newPointer(generation, previous, revision, binding, defaults as Pointer['defaults']);
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
  const { generation, createdAt, operation, distributions, extensions, launch } = value;
  const parent = optionalGeneration(value.parent);
  if (!binding || !isGenerationId(generation) || parent === undefined) return undefined;
  if (!isText(createdAt) || !isObject(operation) || !isObject(distributions) || !isObject(extensions)) return undefined;
  if (!isObject(launch) || typeof launch.packs !== 'boolean' || !Array.isArray(launch.modules)) return undefined;
  const modules = launch.modules.filter((module): module is string => typeof module === 'string');
  if (modules.length !== launch.modules.length || !modules.every(isAdapterReference)) return undefined;
  const managed = launch.managed === undefined ? undefined : parseManagedCatalog(launch.managed);
  if (launch.managed !== undefined && managed === undefined) return undefined;
  const { action, target } = operation;
  if (
    (action !== 'install' && action !== 'update' && action !== 'upgrade' && action !== 'remove') ||
    typeof target !== 'string'
  )
    return undefined;
  const record: GenerationRecord = {
    schema: GENERATION_SCHEMA,
    generation,
    parent,
    createdAt,
    binding,
    operation: { action, target },
    distributions: Object.create(null),
    extensions: Object.create(null),
    launch: { packs: launch.packs, modules, ...(managed ? { managed } : {}) },
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
    const { form, plugin } = entry;
    const pack = form === 'pack' && isText(plugin);
    if (!pack && (form !== 'module' || plugin !== null)) return undefined;
    record.extensions[name] = {
      reference: entry.reference,
      distribution: entry.distribution,
      manifestBound: entry.manifestBound,
      ...(pack ? { form: 'pack', plugin } : { form: 'module', plugin: null }),
    };
  }
  return record;
}

/** A pointer naming `generation` as current. */
export function newPointer(
  generation: string,
  previous: string | null,
  revision: number,
  binding: BundleBinding,
  defaults?: Pointer['defaults']
): Pointer {
  const pointer: Pointer = { schema: POINTER_SCHEMA, generation, previous, revision, binding };
  if (defaults) pointer.defaults = Object.assign(Object.create(null), defaults);
  return pointer;
}

/** Read a saved default only when the ID is present in the pointer. */
export function recordedDefault(defaults: Pointer['defaults'], id: string): boolean | undefined {
  return defaults && Object.hasOwn(defaults, id) ? defaults[id] : undefined;
}

/** Carry app defaults by distribution and exact entry name, across module and pack IDs. */
export function retainedDefaults(base: PointerState, next: GenerationRecord): Pointer['defaults'] {
  if (!base.pointer?.defaults || !base.record?.launch.managed || !next.launch.managed) return undefined;
  const previous = new Map(Object.entries(base.record.extensions));
  const previousIds = new Set(base.record.launch.managed.map(({ id }) => id));
  const nextIds = new Set(next.launch.managed.map(({ id }) => id));
  const defaults: NonNullable<Pointer['defaults']> = Object.create(null);
  for (const [name, extension] of Object.entries(next.extensions)) {
    const prior = previous.get(name);
    if (prior?.distribution !== extension.distribution) continue;
    const oldId = managedExtensionId(prior.distribution, name, prior.plugin);
    const id = managedExtensionId(extension.distribution, name, extension.plugin);
    if (!previousIds.has(oldId) || !nextIds.has(id)) continue;
    const enabled = recordedDefault(base.pointer.defaults, oldId);
    if (typeof enabled !== 'boolean') continue;
    // Several previously separate modules can become one pack. An explicit off
    // wins over on so grouping cannot activate a disabled extension.
    defaults[id] = (defaults[id] ?? true) && enabled;
  }
  return Object.keys(defaults).length ? defaults : undefined;
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
    // A generation is a directory of its own; a link of that name is not read through.
    if (!(await lstat(path.join(layout.generations, generation))).isDirectory()) return undefined;
    const record = parseGenerationRecord(await readFile(recordFile(layout, generation), 'utf8'));
    return record?.generation === generation ? record : undefined;
  } catch {
    return undefined;
  }
}

/** Mark a generation complete by writing its record. This is the last write into a generation. */
export async function writeGenerationRecord(layout: Layout, record: GenerationRecord): Promise<void> {
  const content = JSON.stringify(record, null, 2) + '\n';
  if (Buffer.byteLength(content) > 1024 * 1024)
    throw new ExtensionFailure('MANAGED_EXTENSION_INVALID', ['the generation record exceeds 1 MiB']);
  await writeAtomic(recordFile(layout, record.generation), content);
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
 *
 * The new content is flushed to temporary files here; the renames that put it in effect are
 * done by the lock holder, so the pointer cannot move once the lock is gone.
 *
 * @throws ExtensionFailure `CONFLICT` when the lock was lost.
 */
export async function switchPointer(
  layout: Layout,
  next: Pointer,
  base: Pointer | null,
  writer: StateWriter
): Promise<void> {
  const put = async (file: string, pointer: Pointer): Promise<void> => {
    const temporary = await writeTemporary(file, JSON.stringify(pointer, null, 2) + '\n');
    await writer.replace(path.basename(temporary), path.basename(file));
  };
  if (base) await put(layout.previousPointer, base);
  await put(layout.pointer, next);
}
