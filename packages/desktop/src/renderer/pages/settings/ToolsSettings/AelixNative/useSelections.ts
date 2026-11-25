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

export type SavedMessage = 'applied' | 'deferred' | 'notApplied' | 'restart' | 'nextWorker';

export type SaveNotice =
  | {
      type: 'saved';
      message: SavedMessage;
      restored: boolean;
      /** The store saved nothing, or saved values that differ from the request. */
      warning: 'noChange' | 'mismatch' | null;
    }
  | { type: 'nothingToApply' }
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

/** Notices survive a rediscovery of the same scope and kind, so a pending re-apply is not lost. */
export type NoticeCache = Map<string, SaveNotice>;

function savedMessage(data: GlobalWrite | ProjectWrite): SavedMessage {
  // The global helper reports when a save takes effect; D16 v1 only defines the next worker start.
  if (data.scope === 'global') return 'nextWorker';
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
export function useSelections(target: SelectionTarget | undefined, kind: ResourceKind, notices?: NoticeCache) {
  const [listing, setListing] = useState<Listing>();
  const [failure, setFailure] = useState<ResourceFailure>();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const [notice, setNoticeState] = useState<SaveNotice>();
  const [recovery, setRecovery] = useState<RecoveryRecord>();
  const ticket = useRef(0);

  const source = useMemo(() => (target ? sourceFor(target, kind) : undefined), [target, kind]);
  const recoveryTarget = useMemo<RecoveryTarget | undefined>(() => {
    if (!target) return undefined;
    return target.scope === 'global'
      ? { scope: 'global' }
      : { scope: 'project', conversationId: target.conversationId };
  }, [target]);
  const identity = target
    ? `${target.scope === 'global' ? 'global' : `project:${target.conversationId}`}:${kind}`
    : undefined;

  const setNotice = useCallback(
    (next: SaveNotice | undefined) => {
      setNoticeState(next);
      if (!identity || !notices) return;
      // Only a pending re-apply is worth keeping across a rediscovery; other notices are momentary.
      if (next?.type === 'retry') notices.set(identity, next);
      else notices.delete(identity);
    },
    [identity, notices]
  );

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
    // A rediscovered binding for the same conversation and kind keeps its pending notice.
    setNoticeState(identity ? notices?.get(identity) : undefined);
    setRecovery(recoveryTarget ? getRecovery(recoveryTarget, kind) : undefined);
    if (source) void reload();
    else ticket.current++;
  }, [identity, kind, notices, recoveryTarget, reload, source]);

  const submit = useCallback(
    async (requested: readonly ResourceChange[], restoring = false) => {
      if (!source || !listing || !recoveryTarget || saving) return;
      const changes = effectiveChanges(listing, requested);
      if (changes.length === 0) {
        // Re-apply or restore found every value already matching (or no longer changeable).
        setDraft(new Map());
        setNotice(requested.length > 0 ? { type: 'nothingToApply' } : undefined);
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
        const { data } = outcome;
        const revision = data.scope === 'global' ? data.revision : null;
        // Only what the store reports as saved can be restored later.
        const saved = data.changed.map(({ key, saved: on }) => ({ key, on }));
        if (restoring) {
          // Forget only items the store reports as restored; keep the rest for another try.
          const mismatched = new Set(data.mismatches.map((issue) => issue.key));
          forgetRestored(
            recoveryTarget,
            kind,
            saved.filter((change) => !mismatched.has(change.key)).map((change) => change.key),
            revision
          );
        } else {
          rememberChange(recoveryTarget, kind, snapshot, saved, revision, false);
        }
        setDraft(new Map());
        setNotice({
          type: 'saved',
          message: savedMessage(data),
          restored: restoring,
          warning: data.mismatches.length > 0 ? 'mismatch' : saved.length === 0 ? 'noChange' : null,
        });
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
    [apply, kind, listing, recoveryTarget, saving, setNotice, source]
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
