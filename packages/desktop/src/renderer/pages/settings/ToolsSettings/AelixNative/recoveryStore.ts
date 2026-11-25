/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  GlobalSelections,
  ResourceChange,
  ResourceKind,
  SessionSelections,
} from '@/renderer/services/runtime/NativeResources';

/** Where a save was written. A restore goes back through the same path only. */
export type RecoveryTarget = { scope: 'global' } | { scope: 'project'; conversationId: string };

export type RecoveryItem = { key: string; before: boolean; after: boolean };

/** The values Studio replaced in one scope and kind, kept for this renderer session. */
export type RecoveryRecord = {
  target: RecoveryTarget;
  kind: ResourceKind;
  /** Global store revision after Studio's own save; null when unknown or for project saves. */
  revision: string | null;
  /** True when at least one save's outcome could not be confirmed. */
  uncertain: boolean;
  items: readonly RecoveryItem[];
};

export type RecoveryRowState = 'restorable' | 'restored' | 'missing' | 'locked';

export type RecoveryRow = RecoveryItem & { current: boolean | null; state: RecoveryRowState };

type Listing = GlobalSelections | SessionSelections;

const records = new Map<string, RecoveryRecord>();

function recordKey(target: RecoveryTarget, kind: ResourceKind): string {
  return target.scope === 'global' ? `global:${kind}` : `project:${target.conversationId}:${kind}`;
}

/**
 * Remember the saved values that a write replaces. The earliest known value per key is kept,
 * so repeated saves still restore the environment from before Studio changed it.
 */
export function rememberChange(
  target: RecoveryTarget,
  kind: ResourceKind,
  snapshot: Listing,
  changes: readonly ResourceChange[],
  revision: string | null,
  uncertain: boolean
): RecoveryRecord | undefined {
  const id = recordKey(target, kind);
  const previous = records.get(id);
  const items = new Map((previous?.items ?? []).map((item) => [item.key, item]));
  for (const change of changes) {
    const known = items.get(change.key);
    const saved = snapshot.items.find((row) => row.key === change.key)?.saved;
    const before = known ? known.before : saved;
    if (typeof before !== 'boolean') continue;
    items.set(change.key, { key: change.key, before, after: change.on });
  }
  const kept = [...items.values()].filter((item) => item.before !== item.after);
  if (kept.length === 0) {
    records.delete(id);
    return undefined;
  }
  const record: RecoveryRecord = {
    target,
    kind,
    revision,
    uncertain: uncertain || Boolean(previous?.uncertain),
    items: kept,
  };
  records.set(id, record);
  return record;
}

export function getRecovery(target: RecoveryTarget, kind: ResourceKind): RecoveryRecord | undefined {
  return records.get(recordKey(target, kind));
}

/** Drop items that were restored, keeping the rest available. */
export function forgetRestored(target: RecoveryTarget, kind: ResourceKind, keys: readonly string[]): void {
  const id = recordKey(target, kind);
  const record = records.get(id);
  if (!record) return;
  const items = record.items.filter((item) => !keys.includes(item.key));
  if (items.length === 0) records.delete(id);
  else records.set(id, { ...record, items });
}

/** Reset all records. Used on owner change and by tests. */
export function clearRecovery(): void {
  records.clear();
}

/** Compare remembered values with the current listing to decide what can be restored. */
export function compareRecovery(record: RecoveryRecord, listing: Listing): RecoveryRow[] {
  return record.items.map((item): RecoveryRow => {
    const row = listing.items.find((entry) => entry.key === item.key);
    if (!row) return { ...item, current: null, state: 'missing' };
    const current = row.saved;
    if (row.role !== 'item' || row.lock !== null || current === null) return { ...item, current, state: 'locked' };
    if (current === item.before) return { ...item, current, state: 'restored' };
    return { ...item, current, state: 'restorable' };
  });
}

/** True when a global store changed after Studio's own save, for example from the CLI. */
export function changedSinceSave(record: RecoveryRecord, listing: Listing): boolean {
  return listing.source === 'global' && (record.revision === null || listing.revision !== record.revision);
}
