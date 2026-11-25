/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  GlobalSelections,
  GlobalWrite,
  NativeResources,
  NativeSessionResources,
  ProjectWrite,
  ResourceChange,
  ResourceFailure,
  ResourceKind,
  ResourceResult,
  SessionSelections,
  WriteReport,
} from '@/renderer/services/runtime/NativeResources';
import { forgetRestored, getRecovery, rememberChange, type RecoveryRecord, type RecoveryTarget } from './recoveryStore';

export type Listing = GlobalSelections | SessionSelections;

/** The scope a panel reads and writes. Project scope goes through the open conversation. */
export type SelectionTarget =
  | { scope: 'global'; client: NativeResources }
  | { scope: 'project'; conversationId: string; session: NativeSessionResources; canWrite: boolean };

export type SavedMessage = 'applied' | 'deferred' | 'notApplied' | 'restart' | 'globalNext' | 'globalRestart';

export type SaveNotice =
  | { type: 'saved'; message: SavedMessage; restored: boolean }
  | { type: 'retry'; reason: 'conflict' | 'unknown' | 'stale'; changes: readonly ResourceChange[] }
  | { type: 'failure'; failure: ResourceFailure };

type Write = WriteReport<GlobalWrite, GlobalSelections> | WriteReport<ProjectWrite, SessionSelections>;

type Source = {
  list: () => Promise<ResourceResult<Listing>>;
  next: (previous: Listing) => Promise<ResourceResult<Listing>>;
  write: (snapshot: Listing, changes: readonly ResourceChange[]) => Promise<Write>;
};

/** Stop following cursors after this many pages and show the partial list as partial. */
const MAX_PAGES = 25;

const mismatchedSource: ResourceFailure = {
  status: 'invalid-input',
  reason: 'invalid-input',
  action: 'refresh',
  retryWrite: false,
};

function sourceFor(target: SelectionTarget, kind: ResourceKind): Source {
  if (target.scope === 'global') {
    const resources = target.client.global;
    return {
      list: () => resources.listSelections(kind),
      next: (previous) =>
        previous.source === 'global' ? resources.nextSelections(previous) : Promise.resolve(mismatchedSource),
      write: (snapshot, changes) =>
        snapshot.source === 'global'
          ? resources.setSelections(snapshot, changes)
          : Promise.resolve({ outcome: mismatchedSource }),
    };
  }
  const { session } = target;
  return {
    list: () => session.listSelections(kind),
    next: (previous) =>
      previous.source === 'session' ? session.nextSelections(previous) : Promise.resolve(mismatchedSource),
    write: (snapshot, changes) =>
      snapshot.source === 'session'
        ? session.setProjectSelections(snapshot, changes)
        : Promise.resolve({ outcome: mismatchedSource }),
  };
}

async function readRest(source: Source, first: ResourceResult<Listing>): Promise<ResourceResult<Listing>> {
  let reply = first;
  for (let page = 1; reply.status === 'success' && reply.data.nextCursor !== null && page < MAX_PAGES; page++) {
    // Pages chain through the previous cursor, so they are read in order.
    // oxlint-disable-next-line no-await-in-loop
    reply = await source.next(reply.data);
  }
  return reply;
}

function savedMessage(data: GlobalWrite | ProjectWrite, kind: ResourceKind): SavedMessage {
  if (data.scope === 'global') return kind === 'mcp' ? 'globalRestart' : 'globalNext';
  if (data.effect === 'restart' || data.apply === null) return 'restart';
  if (data.apply.deferred) return 'deferred';
  return data.apply.applied ? 'applied' : 'notApplied';
}

/** Keep only changes that a current, writable row would actually change. */
function effectiveChanges(listing: Listing, changes: readonly ResourceChange[]): ResourceChange[] {
  return changes.filter((change) => {
    const row = listing.items.find((item) => item.key === change.key);
    return row !== undefined && row.role === 'item' && row.lock === null && row.saved !== change.on;
  });
}

export function scopeStatus(listing: Listing) {
  return listing.source === 'global' ? listing.scopes.global : listing.scopes.project;
}

/**
 * Manage one scope and kind of native selections: full listing, staged edits, conditional
 * saves, conflict re-apply and previous-environment restore. Writes are only sent on an
 * explicit user action and are never retried automatically.
 */
export function useSelections(target: SelectionTarget | undefined, kind: ResourceKind) {
  const [listing, setListing] = useState<Listing>();
  const [failure, setFailure] = useState<ResourceFailure>();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const [notice, setNotice] = useState<SaveNotice>();
  const [recovery, setRecovery] = useState<RecoveryRecord>();
  const ticket = useRef(0);

  const source = useMemo(() => (target ? sourceFor(target, kind) : undefined), [target, kind]);
  const recoveryTarget = useMemo<RecoveryTarget | undefined>(() => {
    if (!target) return undefined;
    return target.scope === 'global'
      ? { scope: 'global' }
      : { scope: 'project', conversationId: target.conversationId };
  }, [target]);

  const apply = useCallback((reply: ResourceResult<Listing>) => {
    if (reply.status === 'success') {
      setListing(reply.data);
      setFailure(undefined);
    } else {
      setListing(undefined);
      setFailure(reply);
    }
  }, []);

  const reload = useCallback(async () => {
    if (!source) return;
    const run = ++ticket.current;
    setLoading(true);
    const reply = await readRest(source, await source.list());
    if (run !== ticket.current) return;
    setLoading(false);
    apply(reply);
  }, [apply, source]);

  useEffect(() => {
    // A new target (for example after rediscovery) retires any in-flight read or write.
    setListing(undefined);
    setFailure(undefined);
    setSaving(false);
    setLoading(false);
    setDraft(new Map());
    setNotice(undefined);
    setRecovery(recoveryTarget ? getRecovery(recoveryTarget, kind) : undefined);
    if (source) void reload();
    else ticket.current++;
  }, [kind, recoveryTarget, reload, source]);

  const submit = useCallback(
    async (requested: readonly ResourceChange[], restoring = false) => {
      if (!source || !listing || !recoveryTarget || saving) return;
      const changes = effectiveChanges(listing, requested);
      if (changes.length === 0) {
        setDraft(new Map());
        setNotice(undefined);
        return;
      }
      const snapshot = listing;
      const run = ++ticket.current;
      setSaving(true);
      const report = await source.write(snapshot, changes);
      const fresh = report.refresh
        ? await readRest(source, report.refresh)
        : await readRest(source, await source.list());
      if (run !== ticket.current) return;
      setSaving(false);
      setLoading(false);
      apply(fresh);

      const { outcome } = report;
      if (outcome.status === 'success') {
        const revision = outcome.data.scope === 'global' ? outcome.data.revision : null;
        if (restoring) {
          forgetRestored(
            recoveryTarget,
            kind,
            changes.map((change) => change.key)
          );
        } else {
          rememberChange(recoveryTarget, kind, snapshot, changes, revision, false);
        }
        setDraft(new Map());
        setNotice({ type: 'saved', message: savedMessage(outcome.data, kind), restored: restoring });
      } else if (outcome.status === 'conflict' || outcome.status === 'unknown') {
        // An unknown write may have committed; keep what it would replace so it can be restored.
        if (outcome.status === 'unknown' && !restoring) {
          rememberChange(recoveryTarget, kind, snapshot, changes, null, true);
        }
        setDraft(new Map());
        setNotice({ type: 'retry', reason: outcome.status, changes });
      } else if (outcome.status === 'stale' && outcome.reason === 'cursor-stale') {
        setDraft(new Map());
        setNotice({ type: 'retry', reason: 'stale', changes });
      } else {
        setNotice({ type: 'failure', failure: outcome });
      }
      setRecovery(getRecovery(recoveryTarget, kind));
    },
    [apply, kind, listing, recoveryTarget, saving, source]
  );

  const toggle = useCallback(
    (key: string, on: boolean) => {
      setDraft((previous) => {
        const next = new Map(previous);
        const saved = listing?.items.find((item) => item.key === key)?.saved;
        if (saved === on) next.delete(key);
        else next.set(key, on);
        return next;
      });
    },
    [listing]
  );

  const writable =
    listing !== undefined && scopeStatus(listing).writable && (target?.scope !== 'project' || target.canWrite);

  return {
    listing,
    failure,
    loading,
    saving,
    draft,
    notice,
    recovery,
    writable,
    reload,
    toggle,
    discard: () => setDraft(new Map()),
    dismissNotice: () => setNotice(undefined),
    save: () => submit([...draft].map(([key, on]) => ({ key, on }))),
    reapply: (changes: readonly ResourceChange[]) => submit(changes),
    restore: (changes: readonly ResourceChange[]) => submit(changes, true),
  };
}

export type SelectionsState = ReturnType<typeof useSelections>;
