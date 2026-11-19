import { ipcBridge } from '@/common';
import type { IConfirmation } from '@/common/chat/chatLib';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { removeStack } from '@/renderer/utils/common';
import {
  extractConfirmationId,
  isTerminalStreamMessage,
  isWaitingConfirmationStreamMessage,
} from '@/renderer/pages/conversation/GroupedHistory/hooks/useConversationListSync';

const STORAGE_KEY_PREFIX = 'team-pending-permissions-';

/** Pending confirmation ids per conversation (agent slot). */
export type PendingConfirmationIds = Record<string, readonly string[]>;

/** Live events observed while a `confirmation.list` request for one conversation was in flight. */
export type PendingSeedJournal = {
  marked: Set<string>;
  removed: Set<string>;
  cleared: boolean;
};

export const createSeedJournal = (): PendingSeedJournal => ({
  marked: new Set(),
  removed: new Set(),
  cleared: false,
});

/**
 * One pending confirmation: the key the badge tracks plus every id the backend may later
 * send on `confirmation.remove` for it.
 */
export type ConfirmationRef = { key: string; ids: string[] };

const toRef = (ids: unknown[]): ConfirmationRef | undefined => {
  const valid = [...new Set(ids.filter((id): id is string => typeof id === 'string' && id.length > 0))];
  return valid.length > 0 ? { key: valid[0], ids: valid } : undefined;
};

/** Identify a backend confirmation by `call_id` (falling back to `id`), keeping both ids. */
export const confirmationRef = (
  confirmation: Pick<IConfirmation<unknown>, 'id' | 'call_id'>
): ConfirmationRef | undefined => toRef([confirmation.call_id, confirmation.id]);

/**
 * Identify a waiting-confirmation stream frame. Reuses the conversation-list parser and also
 * accepts the flat Confirmation payload (`id` + `call_id`, no `tool_call`) that built-in Aionrs
 * members send as `acp_permission`.
 */
export const streamConfirmationRef = (message: { type?: string; data?: unknown }): ConfirmationRef | undefined => {
  const parsed = extractConfirmationId(message);
  if (message.type === 'ask') return toRef([parsed]);
  const data = message.data && typeof message.data === 'object' ? (message.data as Record<string, unknown>) : {};
  if (message.type === 'acp_permission' && parsed) return toRef([parsed]);
  return toRef([parsed, data.call_id, data.id]);
};

/**
 * Merge a `confirmation.list` snapshot with the live events that arrived while it was in flight,
 * so a slow response can neither resurrect an answered request nor drop one that was just raised.
 * A request counts as answered when any of its ids was removed, so a removal by confirmation id
 * also drops a live mark that only knew the call id.
 */
export const mergeSeedSnapshot = (snapshot: readonly ConfirmationRef[], journal: PendingSeedJournal): string[] => {
  const answered = new Set(journal.removed);
  for (const entry of snapshot) {
    if (entry.ids.some((id) => journal.removed.has(id))) answered.add(entry.key);
  }
  const merged = new Set<string>();
  if (!journal.cleared) {
    for (const entry of snapshot) {
      if (!answered.has(entry.key)) merged.add(entry.key);
    }
  }
  for (const key of journal.marked) {
    if (!answered.has(key)) merged.add(key);
  }
  return [...merged];
};

const sameIds = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((id) => b.includes(id));

const replaceIds = (
  prev: PendingConfirmationIds,
  conversation_id: string,
  next: readonly string[]
): PendingConfirmationIds => {
  if (sameIds(prev[conversation_id] ?? [], next)) return prev;
  return { ...prev, [conversation_id]: next };
};

const readFromStorage = (storageKey: string): PendingConfirmationIds => {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const ids: Record<string, string[]> = {};
    for (const [conversation_id, value] of Object.entries(parsed)) {
      // Older builds stored bare counts; those are dropped and reseeded from the backend.
      if (Array.isArray(value)) {
        ids[conversation_id] = value.filter((id): id is string => typeof id === 'string');
      }
    }
    return ids;
  } catch {
    return {};
  }
};

/**
 * Track pending permission confirmations per conversation (agent slot) for the Team tab badge.
 *
 * - Restores the last known ids from localStorage for instant render
 * - Seeds from `confirmation.list` on mount, turn completion and realtime reconnect
 * - Adds a request live from its `permission` / `acp_permission` / `ask` stream frame
 * - Drops it on `confirmation.remove` (answered) and clears the slot on a terminal frame
 *   (finish, error, disconnected) so a cancelled or ended run does not leave a stale badge
 */
export function useTeamPendingPermissions(team_id: string, conversation_ids: string[]) {
  const storageKey = `${STORAGE_KEY_PREFIX}${team_id}`;
  const [pendingIds, setPendingIds] = useState<PendingConfirmationIds>(() => readFromStorage(storageKey));
  // Every in-flight `confirmation.list` request per conversation keeps its own journal, so a newer
  // request never erases the clear records an older one still needs if the newer one fails.
  const journalsRef = useRef(new Map<string, Set<PendingSeedJournal>>());
  const aliasesRef = useRef(new Map<string, string>());
  const idsSignature = conversation_ids.join(',');

  // Persist ids for current conversations only; prune stale ones
  useEffect(() => {
    try {
      const pruned: Record<string, readonly string[]> = {};
      for (const cid of conversation_ids) {
        const ids = pendingIds[cid];
        if (ids && ids.length > 0) {
          pruned[cid] = ids;
        }
      }
      localStorage.setItem(storageKey, JSON.stringify(pruned));
    } catch {
      // Storage quota exceeded — silent ignore
    }
  }, [storageKey, pendingIds, idsSignature]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (conversation_ids.length === 0) return;

    const idSet = new Set(conversation_ids);
    const journals = journalsRef.current;
    const aliases = aliasesRef.current;
    const appliedGeneration = new Map<string, number>();
    let nextGeneration = 0;
    let disposed = false;

    const journalsFor = (cid: string): ReadonlySet<PendingSeedJournal> => journals.get(cid) ?? new Set();

    const updateIds = (cid: string, apply: (current: Set<string>) => void) => {
      setPendingIds((prev) => {
        const current = new Set(prev[cid] ?? []);
        apply(current);
        return replaceIds(prev, cid, [...current]);
      });
    };

    // Every id a backend may send on `confirmation.remove` maps to the badge key it clears.
    const remember = (ref: ConfirmationRef) => {
      for (const id of ref.ids) aliases.set(id, ref.key);
    };

    const mark = (cid: string, ref: ConfirmationRef) => {
      remember(ref);
      for (const journal of journalsFor(cid)) {
        journal.marked.add(ref.key);
        journal.removed.delete(ref.key);
      }
      updateIds(cid, (current) => {
        current.add(ref.key);
      });
    };

    const unmark = (cid: string, keys: string[]) => {
      for (const journal of journalsFor(cid)) {
        for (const key of keys) {
          journal.removed.add(key);
          journal.marked.delete(key);
        }
      }
      updateIds(cid, (current) => {
        for (const key of keys) current.delete(key);
      });
    };

    const clear = (cid: string) => {
      for (const journal of journalsFor(cid)) {
        journal.cleared = true;
        journal.marked.clear();
      }
      setPendingIds((prev) => replaceIds(prev, cid, []));
    };

    const seed = async (cid: string) => {
      const generation = ++nextGeneration;
      const journal = createSeedJournal();
      const inFlight = journals.get(cid) ?? new Set<PendingSeedJournal>();
      inFlight.add(journal);
      journals.set(cid, inFlight);
      let snapshot: ConfirmationRef[];
      try {
        const confirmations = await ipcBridge.conversation.confirmation.list.invoke({ conversation_id: cid });
        snapshot = [];
        for (const confirmation of confirmations ?? []) {
          const ref = confirmationRef(confirmation);
          if (!ref) continue;
          remember(ref);
          snapshot.push(ref);
        }
      } catch {
        // Keep the live state; an older in-flight request, turn completion or reconnect reseeds.
        inFlight.delete(journal);
        return;
      }
      inFlight.delete(journal);
      // Apply a snapshot only when no newer one has landed; an older one still applies if a newer
      // request failed, merged with every event recorded since it started.
      if (disposed || generation <= (appliedGeneration.get(cid) ?? 0)) return;
      appliedGeneration.set(cid, generation);
      const merged = mergeSeedSnapshot(snapshot, journal);
      setPendingIds((prev) => replaceIds(prev, cid, merged));
    };

    const unsubscribe = removeStack(
      ipcBridge.conversation.responseStream.on((message) => {
        const cid = message.conversation_id;
        if (!idSet.has(cid)) return;
        if (isTerminalStreamMessage(message)) {
          clear(cid);
          return;
        }
        if (!isWaitingConfirmationStreamMessage(message.type)) return;
        const ref = streamConfirmationRef(message);
        if (ref) mark(cid, ref);
      }),
      ipcBridge.conversation.confirmation.remove.on((event) => {
        if (!event?.id || !idSet.has(event.conversation_id)) return;
        const key = aliases.get(event.id);
        unmark(event.conversation_id, key && key !== event.id ? [event.id, key] : [event.id]);
        // An id the badge never saw cannot be matched to a live mark (e.g. a frame that only carried
        // the call id); reseed so the backend list decides what is still pending.
        if (!key) void seed(event.conversation_id);
      }),
      ipcBridge.conversation.turnCompleted.on((event) => {
        if (idSet.has(event.session_id)) void seed(event.session_id);
      }),
      ipcBridge.realtime.reconnected.on(() => {
        for (const cid of conversation_ids) void seed(cid);
      })
    );

    for (const cid of conversation_ids) void seed(cid);

    return () => {
      disposed = true;
      journals.clear();
      unsubscribe();
    };
  }, [idsSignature]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Pending confirmation count per conversation */
  const pendingCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const [cid, ids] of Object.entries(pendingIds)) {
      counts[cid] = ids.length;
    }
    return counts;
  }, [pendingIds]);

  /** Total pending confirmations across all agents in this team */
  const totalPending = conversation_ids.reduce((sum, cid) => sum + (pendingCounts[cid] ?? 0), 0);

  /** Clear persisted storage for this team (call when team is deleted) */
  const clearStorage = useCallback(() => {
    try {
      localStorage.removeItem(storageKey);
    } catch {
      // ignore
    }
  }, [storageKey]);

  return { pendingCounts, totalPending, clearStorage };
}
