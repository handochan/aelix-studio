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
 * Key a backend confirmation the way stream frames and `confirmation.remove` identify it
 * (`call_id`, falling back to `id`).
 */
export const confirmationKey = (confirmation: Pick<IConfirmation<unknown>, 'id' | 'call_id'>): string =>
  confirmation.call_id || confirmation.id;

/**
 * Merge a `confirmation.list` snapshot with the live events that arrived while it was in flight,
 * so a slow response can neither resurrect an answered request nor drop one that was just raised.
 */
export const mergeSeedSnapshot = (snapshotKeys: readonly string[], journal: PendingSeedJournal): string[] => {
  const merged = new Set(journal.cleared ? [] : snapshotKeys.filter((key) => !journal.removed.has(key)));
  for (const key of journal.marked) {
    merged.add(key);
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
  const journalsRef = useRef(new Map<string, PendingSeedJournal>());
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
    let disposed = false;

    const updateIds = (cid: string, apply: (current: Set<string>) => void) => {
      setPendingIds((prev) => {
        const current = new Set(prev[cid] ?? []);
        apply(current);
        return replaceIds(prev, cid, [...current]);
      });
    };

    const mark = (cid: string, key: string) => {
      const journal = journals.get(cid);
      journal?.marked.add(key);
      journal?.removed.delete(key);
      updateIds(cid, (current) => {
        current.add(key);
      });
    };

    const unmark = (cid: string, keys: string[]) => {
      const journal = journals.get(cid);
      for (const key of keys) {
        journal?.removed.add(key);
        journal?.marked.delete(key);
      }
      updateIds(cid, (current) => {
        for (const key of keys) current.delete(key);
      });
    };

    const clear = (cid: string) => {
      const journal = journals.get(cid);
      if (journal) {
        journal.cleared = true;
        journal.marked.clear();
      }
      setPendingIds((prev) => replaceIds(prev, cid, []));
    };

    const seed = async (cid: string) => {
      const journal = createSeedJournal();
      journals.set(cid, journal);
      let snapshot: string[];
      try {
        const confirmations = await ipcBridge.conversation.confirmation.list.invoke({ conversation_id: cid });
        snapshot = (confirmations ?? []).map((confirmation) => {
          const key = confirmationKey(confirmation);
          if (confirmation.id && confirmation.id !== key) aliases.set(confirmation.id, key);
          return key;
        });
      } catch {
        // Keep the live state; the next turn completion or reconnect reseeds.
        if (journals.get(cid) === journal) journals.delete(cid);
        return;
      }
      if (disposed || journals.get(cid) !== journal) return;
      journals.delete(cid);
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
        const key = extractConfirmationId(message);
        if (key) mark(cid, key);
      }),
      ipcBridge.conversation.confirmation.remove.on((event) => {
        if (!event?.id || !idSet.has(event.conversation_id)) return;
        const alias = aliases.get(event.id);
        unmark(event.conversation_id, alias ? [event.id, alias] : [event.id]);
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
