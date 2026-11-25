/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { onUserChange } from '@/renderer/hooks/context/AuthContext';
import type {
  GlobalSelections,
  ResourceChange,
  ResourceKind,
  ResourceRow,
  SessionSelections,
} from '@/renderer/services/runtime/NativeResources';

/** Where a save was written. A restore goes back through the same path only. */
export type RecoveryTarget = { scope: 'global' } | { scope: 'project'; conversationId: string };

/** A saved value before Studio changed it, and which scope decided it then. */
export type PriorValue = { on: boolean; decidedBy: ResourceRow['decidedBy'] };

export type RecoveryItem = { key: string; before: PriorValue; after: boolean };

/** The values Studio replaced in one scope and kind, kept in memory for the current owner and runtime. */
export type RecoveryRecord = {
  target: RecoveryTarget;
  kind: ResourceKind;
  /** Global store revision after Studio's own latest write; null when unknown or for project saves. */
  revision: string | null;
  /** True when at least one save's outcome could not be confirmed. */
  uncertain: boolean;
  items: readonly RecoveryItem[];
};

export type RecoveryRowState = 'restorable' | 'restored' | 'missing' | 'locked';

export type RecoveryRow = RecoveryItem & { current: boolean | null; state: RecoveryRowState };

/**
 * How a picked item is written back. The current contract can only write an explicit value, so a
 * value that was inherited before comes back as an explicit value in the same scope. A contract
 * change that can remove the scope's own value would add an `unset` plan here.
 */
export type RestorePlan = { change: ResourceChange; explicitWhereInherited: boolean };

type Listing = GlobalSelections | SessionSelections;

const records = new Map<string, RecoveryRecord>();

/** Drop every record. Records belong to one signed-in owner and one native runtime/root. */
function clearRecovery(): void {
  records.clear();
}

// Records are owner-scoped: sign-out or another user's sign-in drops them.
onUserChange(clearRecovery);

/**
 * Drop every record after the selected native runtime or agent root changes, together with the
 * NativeResources client's `global.invalidate()`. Records from another runtime are never restored.
 */
export function resetRecoveryForRuntimeChange(): void {
  clearRecovery();
}

function recordKey(target: RecoveryTarget, kind: ResourceKind): string {
  return target.scope === 'global' ? `global:${kind}` : `project:${target.conversationId}:${kind}`;
}

/**
 * Remember the saved values that a write replaced. `changes` are the values the write reports as
 * saved (or, for an unconfirmed write, the values it tried to save). The earliest known value per
 * key is kept, so repeated saves still restore the environment from before Studio changed it.
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
    const row = snapshot.items.find((entry) => entry.key === change.key);
    const before: PriorValue | undefined =
      items.get(change.key)?.before ??
      (typeof row?.saved === 'boolean' ? { on: row.saved, decidedBy: row.decidedBy } : undefined);
    if (!before) continue;
    items.set(change.key, { key: change.key, before, after: change.on });
  }
  const kept = [...items.values()].filter((item) => item.before.on !== item.after);
  if (kept.length === 0) {
    records.delete(id);
    return undefined;
  }
  const record: RecoveryRecord = {
    target,
    kind,
    revision: uncertain ? null : revision,
    uncertain: uncertain || Boolean(previous?.uncertain),
    items: kept,
  };
  records.set(id, record);
  return record;
}

export function getRecovery(target: RecoveryTarget, kind: ResourceKind): RecoveryRecord | undefined {
  return records.get(recordKey(target, kind));
}

/**
 * Drop items that were restored, keeping the rest available. `revision` is the store revision
 * after the restore write, so a later comparison does not mistake Studio's own restore for a
 * change made elsewhere.
 */
export function forgetRestored(
  target: RecoveryTarget,
  kind: ResourceKind,
  keys: readonly string[],
  revision: string | null
): void {
  const id = recordKey(target, kind);
  const record = records.get(id);
  if (!record) return;
  const items = record.items.filter((item) => !keys.includes(item.key));
  if (items.length === 0) records.delete(id);
  else records.set(id, { ...record, items, revision });
}

/** Plan the write for one picked item. */
export function restorePlan(target: RecoveryTarget, item: RecoveryItem): RestorePlan {
  return {
    change: { key: item.key, on: item.before.on },
    explicitWhereInherited: item.before.decidedBy !== target.scope,
  };
}

/** Compare remembered values with the current listing to decide what can be restored. */
export function compareRecovery(record: RecoveryRecord, listing: Listing): RecoveryRow[] {
  return record.items.map((item): RecoveryRow => {
    const row = listing.items.find((entry) => entry.key === item.key);
    if (!row) return { ...item, current: null, state: 'missing' };
    const current = row.saved;
    if (row.role !== 'item' || row.lock !== null || current === null) return { ...item, current, state: 'locked' };
    if (current === item.before.on) return { ...item, current, state: 'restored' };
    return { ...item, current, state: 'restorable' };
  });
}

/** True when a global store changed after Studio's own latest write, for example from the CLI. */
export function changedSinceSave(record: RecoveryRecord, listing: Listing): boolean {
  return listing.source === 'global' && (record.revision === null || listing.revision !== record.revision);
}
