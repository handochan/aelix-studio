/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import { ensureConversationRuntime } from '@/renderer/pages/conversation/utils/ensureConversationRuntime';
import { useCallback, useEffect, useRef, useState } from 'react';
import { sessionHolderFromError, sessionHolderFromStreamMessage, type SessionHolder } from './sessionHolder';

/**
 * - `checking`: the first lock check is still running; sending stays blocked.
 * - `writable`: the host did not report a lock; the send box is usable.
 * - `held`: the host reported that another writer holds the session; read-only.
 */
export type SessionHolderStatus = 'checking' | 'writable' | 'held';

/** Outcome of the last user-requested recheck while held. */
export type SessionRecheckState = 'idle' | 'checking' | 'stillHeld' | 'failed';

type State = { status: SessionHolderStatus; holder: SessionHolder | null; recheckState: SessionRecheckState };

export type SessionHolderState = State & { recheck: () => void };

const CHECKING: State = { status: 'checking', holder: null, recheckState: 'idle' };
const WRITABLE: State = { status: 'writable', holder: null, recheckState: 'idle' };
const held = (holder: SessionHolder, recheckState: SessionRecheckState = 'idle'): State => ({
  status: 'held',
  holder,
  recheckState,
});

/**
 * Tracks whether another writer (the CLI or another Aelix process) holds this
 * conversation's native session.
 *
 * It only observes outcomes the host already reports: the `runtime/ensure` call the
 * conversation makes on open (deduplicated with the existing warmup), and lock errors
 * on the response stream. It never takes, releases, or polls the lock on its own;
 * `recheck` repeats the same ensure call that reopening the conversation would make.
 *
 * Sending stays blocked until the first check settles. A first check that fails for a
 * reason other than the lock leaves the conversation writable, so the existing error
 * surfaces explain that failure; the host still refuses a locked send. Once a lock is
 * confirmed, only a successful recheck makes the conversation writable again.
 */
export const useSessionHolder = (conversationId: string, onWritable?: () => void): SessionHolderState => {
  const [state, setState] = useState<State>(CHECKING);
  const activeIdRef = useRef(conversationId);
  activeIdRef.current = conversationId;
  const onWritableRef = useRef(onWritable);
  onWritableRef.current = onWritable;

  useEffect(() => {
    setState(CHECKING);
    let cancelled = false;
    ensureConversationRuntime(conversationId).then(
      () => {
        if (cancelled) return;
        setState((current) => (current.status === 'checking' ? WRITABLE : current));
      },
      (error: unknown) => {
        if (cancelled) return;
        const holder = sessionHolderFromError(error);
        setState((current) => (holder ? held(holder) : current.status === 'checking' ? WRITABLE : current));
      }
    );
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  useEffect(
    () =>
      ipcBridge.acpConversation.responseStream.on((message) => {
        if (message.conversation_id !== conversationId) return;
        const holder = sessionHolderFromStreamMessage(message);
        if (holder) setState(held(holder));
      }),
    [conversationId]
  );

  const recheck = useCallback(() => {
    const requestedId = conversationId;
    setState((current) => ({ ...current, recheckState: 'checking' }));
    ensureConversationRuntime(requestedId).then(
      () => {
        if (activeIdRef.current !== requestedId) return;
        setState(WRITABLE);
        onWritableRef.current?.();
      },
      (error: unknown) => {
        if (activeIdRef.current !== requestedId) return;
        const holder = sessionHolderFromError(error);
        // A transport or host failure is not a confirmed release: stay read-only.
        setState((current) => (holder ? held(holder, 'stillHeld') : { ...current, recheckState: 'failed' }));
      }
    );
  }, [conversationId]);

  return { ...state, recheck };
};
