/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import type { TConversationRuntimeSummary } from '@/common/config/storage';
import {
  reconcileGeneratingFromRuntime,
  reconcileWaitingConfirmationFromRuntime,
} from '@/renderer/pages/conversation/GroupedHistory/hooks/useConversationListSync';
import { getConversationOrNull } from '@/renderer/pages/conversation/utils/conversationCache';
import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import {
  conversationDeleted,
  getConversationRuntimeViewSnapshot,
  hydrateFailed,
  hydrateStarted,
  hydrateSucceeded,
  localSendAccepted,
  localSendFailed,
  localSendStarted,
  localRestartFailed,
  localRestartStarted,
  localRestartSucceeded,
  localStopAcknowledged,
  localStopRequested,
  resetLocalGate,
  subscribeConversationRuntimeView,
  turnCompleted,
  type ConversationRuntimeView,
  type ConversationRuntimeViewLogEntry,
  type ConversationRuntimeSendFailure,
} from './conversationRuntimeViewStore';

type UseConversationRuntimeViewReturn = {
  view: ConversationRuntimeView;
  hydrated: boolean;
  state: ConversationRuntimeView['state'];
  isProcessing: boolean;
  canSendMessage: boolean;
  activeTurnId: string | null;
  supportsMidturnDelivery: boolean;
  refreshMissingRuntime: () => Promise<ConversationRuntimeView>;
  markSendStarted: () => void;
  markSendAccepted: (turn_id: string, runtime: TConversationRuntimeSummary, msg_id?: string) => void;
  markSendFailed: (failure: ConversationRuntimeSendFailure) => void;
  markStopRequested: (turn_id: string) => void;
  markStopAcknowledged: (turn_id: string, runtime: TConversationRuntimeSummary) => void;
  markRestartStarted: () => void;
  markRestartSucceeded: (runtime: TConversationRuntimeSummary) => void;
  markRestartFailed: (runtime: TConversationRuntimeSummary | null, reason: string) => void;
  resetLocalGate: (reason: string) => void;
};

const logConversationRuntimeView = (entry: ConversationRuntimeViewLogEntry): void => {
  const rendererLogger = ipcBridge.application?.writeRendererLog;
  if (!rendererLogger) {
    return;
  }
  const { reason, ...data } = entry.data;

  void rendererLogger
    .invoke({
      level: entry.level,
      tag: 'conversationRuntimeView',
      message: entry.event,
      data: typeof reason === 'string' ? { ...data, reasonLength: reason.length } : data,
    })
    .catch(() => {});
};

const flushRuntimeViewLogs = (logs: ConversationRuntimeViewLogEntry[]): void => {
  logs.forEach(logConversationRuntimeView);
};

const getRuntimeOrNull = (runtime: TConversationRuntimeSummary | undefined): TConversationRuntimeSummary | null =>
  runtime ?? null;

// Multiple mounted surfaces and a reconnect/Send can observe the same missing summary.
const pendingReads = new WeakMap<ConversationRuntimeView, ReturnType<typeof getConversationOrNull>>();

function readConversation(view: ConversationRuntimeView): ReturnType<typeof getConversationOrNull> {
  const pending = pendingReads.get(view);
  if (pending) return pending;
  const read = getConversationOrNull(view.conversation_id).finally(() => pendingReads.delete(view));
  pendingReads.set(view, read);
  return read;
}

export const useConversationRuntimeView = (conversation_id: string): UseConversationRuntimeViewReturn => {
  const getSnapshot = useCallback(() => getConversationRuntimeViewSnapshot(conversation_id), [conversation_id]);
  const view = useSyncExternalStore(subscribeConversationRuntimeView, getSnapshot, getSnapshot);

  const reader = useRef<{ id: string; read: () => Promise<void> } | null>(null);

  useEffect(() => {
    if (!conversation_id) return;
    let cancelled = false;

    const read = async (): Promise<void> => {
      const before = getSnapshot();
      // A newer host event, local submission or deletion takes precedence over a delayed GET.
      const current = () => !cancelled && before === getSnapshot();
      try {
        const conversation = await readConversation(before);
        if (!current()) return;
        const runtime = getRuntimeOrNull(conversation?.runtime);
        flushRuntimeViewLogs(hydrateSucceeded(conversation_id, runtime));
        if (runtime) {
          reconcileGeneratingFromRuntime(conversation_id, runtime.is_processing === true);
          reconcileWaitingConfirmationFromRuntime(conversation_id, runtime.pending_confirmations ?? 0);
        }
      } catch (error: unknown) {
        if (!current()) return;
        const reason = error instanceof Error ? error.message : String(error);
        flushRuntimeViewLogs(hydrateFailed(conversation_id, reason));
      }
    };

    const view = getSnapshot();
    if (view.hydrated && !pendingReads.has(view)) flushRuntimeViewLogs(hydrateStarted(conversation_id));
    reader.current = { id: conversation_id, read };
    void read();
    return () => {
      cancelled = true;
      reader.current = null;
    };
  }, [conversation_id, getSnapshot]);

  const refreshMissingRuntime = useCallback(async () => {
    const view = getSnapshot();
    const mounted = reader.current;
    if ((!view.hydrated || !view.hasBackendRuntime) && mounted?.id === conversation_id) await mounted.read();
    return getSnapshot();
  }, [conversation_id, getSnapshot]);

  useEffect(() => {
    if (!conversation_id) {
      return;
    }

    const turnCompletedEmitter = ipcBridge.conversation.turnCompleted;
    const listChangedEmitter = ipcBridge.conversation.listChanged;
    if (!turnCompletedEmitter || !listChangedEmitter) {
      return;
    }

    const disposeTurnCompleted = turnCompletedEmitter.on((event) => {
      if (event.session_id !== conversation_id) {
        return;
      }
      flushRuntimeViewLogs(turnCompleted(conversation_id, event.turn_id, event.runtime));
    });

    const disposeListChanged = listChangedEmitter.on((event) => {
      if (event.conversation_id !== conversation_id || event.action !== 'deleted') {
        return;
      }
      flushRuntimeViewLogs(conversationDeleted(conversation_id));
    });

    return () => {
      disposeTurnCompleted();
      disposeListChanged();
    };
  }, [conversation_id]);

  const markSendStarted = useCallback(() => {
    flushRuntimeViewLogs(localSendStarted(conversation_id));
  }, [conversation_id]);

  const markSendAccepted = useCallback(
    (turn_id: string, runtime: TConversationRuntimeSummary, msg_id?: string) => {
      flushRuntimeViewLogs(localSendAccepted(conversation_id, turn_id, runtime, msg_id));
      reconcileGeneratingFromRuntime(conversation_id, runtime.is_processing === true);
    },
    [conversation_id]
  );

  const markSendFailed = useCallback(
    (failure: ConversationRuntimeSendFailure) => {
      flushRuntimeViewLogs(localSendFailed(conversation_id, failure));
    },
    [conversation_id]
  );

  const markStopRequested = useCallback(
    (turn_id: string) => {
      flushRuntimeViewLogs(localStopRequested(conversation_id, turn_id));
    },
    [conversation_id]
  );

  const markStopAcknowledged = useCallback(
    (turn_id: string, runtime: TConversationRuntimeSummary) => {
      flushRuntimeViewLogs(localStopAcknowledged(conversation_id, turn_id, runtime));
    },
    [conversation_id]
  );

  const markRestartStarted = useCallback(() => {
    flushRuntimeViewLogs(localRestartStarted(conversation_id));
  }, [conversation_id]);

  const markRestartSucceeded = useCallback(
    (runtime: TConversationRuntimeSummary) => {
      flushRuntimeViewLogs(localRestartSucceeded(conversation_id, runtime));
    },
    [conversation_id]
  );

  const markRestartFailed = useCallback(
    (runtime: TConversationRuntimeSummary | null, reason: string) => {
      flushRuntimeViewLogs(localRestartFailed(conversation_id, runtime, reason));
    },
    [conversation_id]
  );

  const resetLocalRuntimeGate = useCallback(
    (reason: string) => {
      flushRuntimeViewLogs(resetLocalGate(conversation_id, reason));
    },
    [conversation_id]
  );

  return {
    view,
    hydrated: view.hydrated,
    state: view.state,
    isProcessing: view.isProcessing,
    canSendMessage: view.canSendMessage,
    activeTurnId: view.activeTurnId,
    supportsMidturnDelivery: view.supportsMidturnDelivery,
    refreshMissingRuntime,
    markSendStarted,
    markSendAccepted,
    markSendFailed,
    markStopRequested,
    markStopAcknowledged,
    markRestartStarted,
    markRestartSucceeded,
    markRestartFailed,
    resetLocalGate: resetLocalRuntimeGate,
  };
};

export const logStreamTerminalObserved = (
  conversation_id: string,
  turn_id: string | undefined,
  platform: 'acp' | 'aionrs',
  stream_type: string
): void => {
  const rendererLogger = ipcBridge.application?.writeRendererLog;
  if (!rendererLogger) {
    return;
  }

  void rendererLogger
    .invoke({
      level: 'info',
      tag: 'conversationRuntimeView',
      message: 'stream_terminal_observed',
      data: {
        conversation_id,
        turn_id,
        platform,
        stream_type,
      },
    })
    .catch(() => {});
};
