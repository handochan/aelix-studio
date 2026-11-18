import { ipcBridge } from '@/common';
import type { TConversationRuntimeStateKind } from '@/common/config/storage';
import { getConversationOrNull } from '@/renderer/pages/conversation/utils/conversationCache';
import { useCallback, useEffect, useRef, useState } from 'react';

const isCompactPrompt = (input: string) => /^\/compact(?:\s|$)/.test(input);

/** Protect uncancellable compaction while submitting or reopening an active turn. */
export function useAcpCompactionGuard(
  conversationId: string,
  turnId: string | null,
  phase: TConversationRuntimeStateKind,
  liveCompaction: boolean
) {
  const localSubmission = useRef<{ conversationId: string } | null>(null);
  const [submittingFor, setSubmittingFor] = useState<string | null>(null);
  const [resolved, setResolved] = useState<{ conversationId: string; turnId: string; compaction: boolean } | null>(
    null
  );

  const beginSubmission = useCallback(
    (input: string) => {
      if (!isCompactPrompt(input)) return undefined;
      const current = { conversationId };
      localSubmission.current = current;
      setSubmittingFor(conversationId);
      return () => {
        if (localSubmission.current !== current) return;
        localSubmission.current = null;
        setSubmittingFor(null);
      };
    },
    [conversationId]
  );

  useEffect(() => {
    if (!turnId || liveCompaction) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const restore = async () => {
      if (phase === 'starting') {
        const runtime = (await getConversationOrNull(conversationId))?.runtime;
        if (disposed || runtime?.turn_id !== turnId) return;
        if (runtime.state === 'starting') {
          // A host can claim a turn before it persists the user message.
          timer = setTimeout(check, 300);
          return;
        }
      }
      const history = await ipcBridge.database.getConversationMessages.invoke({
        conversation_id: conversationId,
        limit: 50,
      });
      const latest = history.items.findLast((message) => message.type === 'text' && message.position === 'right');
      if (!disposed && latest?.type === 'text') {
        setResolved({ conversationId, turnId, compaction: isCompactPrompt(latest.content.content) });
      }
    };
    const check = (): void => {
      void restore().catch(() => {
        if (!disposed) timer = setTimeout(check, 1_000);
      });
    };
    check();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [conversationId, turnId, phase, liveCompaction]);

  const restoredOrdinaryTurn =
    resolved?.conversationId === conversationId && resolved.turnId === turnId && !resolved.compaction;
  const blocked = submittingFor === conversationId || liveCompaction || (turnId !== null && !restoredOrdinaryTurn);
  const isBlocked = () => blocked || localSubmission.current?.conversationId === conversationId;
  return { beginSubmission, blocked, isBlocked };
}
