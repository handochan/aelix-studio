import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { ExtensionFailure } from '../types.js';
import type { Candidate } from '../flow/candidate.js';
import type { SiteSnapshot } from '../inspect/site.js';
import { conversationReference, linkPack, type ExtensionForm } from './form.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;
const MODULE = /^[A-Za-z_][A-Za-z_0-9]*(?:\.[A-Za-z_][A-Za-z_0-9]*)*:[A-Za-z_][A-Za-z_0-9]*$/;
const WRAPPER = /^pack-inputs\/[0-9]{1,8}$/;

export type ManagedEntry = { id: string; reference: string; entryPoints?: string[] };

export function isManagedId(input: unknown): input is string {
  return typeof input === 'string' && ID.exec(input)?.[0] === input;
}

/** A stable group ID when multiple entry points resolve to one pack. */
export function managedExtensionId(distribution: string, name: string, plugin?: string | null): string {
  return plugin ? `${distribution}:pack:${plugin}` : `${distribution}:${name}`;
}

/** Parse generation-local references. The bundled Python validator also resolves their actual paths. */
export function parseManagedCatalog(input: unknown): ManagedEntry[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const entries: ManagedEntry[] = [];
  const ids = new Set<string>();
  const moduleReference = (value: unknown): value is string =>
    typeof value === 'string' &&
    MODULE.exec(value)?.[0] === value &&
    (process.platform !== 'win32' || !/^[A-Za-z]:/.test(value));
  for (const value of input as unknown[]) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const { id, reference, entryPoints } = value as Record<string, unknown>;
    if (!isManagedId(id) || ids.has(id) || typeof reference !== 'string') return undefined;
    if (Object.keys(value).length !== (entryPoints === undefined ? 2 : 3)) return undefined;
    if (entryPoints === undefined) {
      if (!moduleReference(reference)) return undefined;
      entries.push({ id, reference });
    } else {
      if (WRAPPER.exec(reference)?.[0] !== reference || !Array.isArray(entryPoints) || !entryPoints.length)
        return undefined;
      const points: unknown[] = entryPoints;
      if (!points.every(moduleReference) || new Set(points).size !== points.length) return undefined;
      entries.push({ id, reference, entryPoints: points });
    }
    ids.add(id);
  }
  return entries;
}

/** Materialize each pack as a separate directory for the managed ACP protocol. */
export async function writeManagedCatalog(
  candidate: Candidate,
  snapshot: SiteSnapshot,
  expected: Map<string, string>,
  forms: Map<string, ExtensionForm>
): Promise<ManagedEntry[]> {
  const entries = new Map<string, ManagedEntry>();
  const pluginOwners = new Map<string, string>();
  let packIndex = 0;
  for (const name of [...expected.keys()].toSorted()) {
    const extension = snapshot.extensions.get(name);
    if (!extension) throw new ExtensionFailure('REQUEST_MISMATCH');
    const form = forms.get(name);
    const reference = conversationReference(extension.reference);
    const id = managedExtensionId(extension.distribution, name, form?.form === 'pack' ? form.plugin : null);
    if (form?.form !== 'pack') {
      entries.set(id, { id, reference });
      continue;
    }
    const owner = pluginOwners.get(form.plugin);
    if (owner !== undefined && owner !== id)
      throw new ExtensionFailure('MANAGED_EXTENSION_INVALID', ['a managed pack has more than one distribution owner']);
    pluginOwners.set(form.plugin, id);
    const existing = entries.get(id);
    if (existing?.entryPoints) {
      if (!existing.entryPoints.includes(reference)) existing.entryPoints.push(reference);
      continue;
    }
    const wrapper = `pack-inputs/${packIndex++}`;
    const directory = path.join(candidate.paths.directory, ...wrapper.split('/'));
    // oxlint-disable-next-line no-await-in-loop -- one owned wrapper and link per pack, in entry order
    await mkdir(directory, { recursive: true });
    // oxlint-disable-next-line no-await-in-loop
    await linkPack(candidate.paths.site, form.directory, path.join(directory, path.posix.basename(form.directory)));
    entries.set(id, { id, reference: wrapper, entryPoints: [reference] });
  }
  const catalogue = parseManagedCatalog([...entries.values()]);
  if (!catalogue)
    throw new ExtensionFailure('MANAGED_EXTENSION_INVALID', [
      'an extension has an unsupported managed ID or reference',
    ]);
  return catalogue;
}
