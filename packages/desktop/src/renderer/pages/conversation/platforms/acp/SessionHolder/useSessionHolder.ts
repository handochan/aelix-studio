/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import { isBackendHttpError } from '@/common/adapter/httpBridge';
import { ensureConversationRuntime } from '@/renderer/pages/conversation/utils/ensureConversationRuntime';
import { useCallback, useEffect, useRef, useState } from 'react';
import { sessionHolderFromError, sessionHolderFromStreamMessage, type SessionHolder } from './sessionHolder';

/**
 * - `checking`: the first lock check is still running.
 * - `writable`: the host confirmed the session is not locked; the only unblocked state.
 * - `held`: the host reported that another writer holds the session.
 * - `unconfirmed`: a check failed without any lock result (transport or host error).
 */
export type SessionHolderStatus = 'checking' | 'writable' | 'held' | 'unconfirmed';

/** Outcome of the last check while blocked. */
export type SessionRecheckState = 'idle' | 'checking' | 'stillHeld' | 'failed';

type State = {
  status: SessionHolderStatus;
  holder: SessionHolder | null;
  recheckState: SessionRecheckState;
  /** Message of the last failure that carried no lock result. */
  errorDetail?: string;
};

export type SessionHolderState = State & { recheck: () => void };

const CHECKING: State = { status: 'checking', holder: null, recheckState: 'idle' };
const WRITABLE: State = { status: 'writable', holder: null, recheckState: 'idle' };
const held = (holder: SessionHolder, recheckState: SessionRecheckState = 'idle'): State => ({
  status: 'held',
  holder,
  recheckState,
});

/**
 * Holders confirmed in this renderer, kept across remounts so that returning to a
 * locked conversation starts read-only. Only a confirmed lock-free result clears one.
 */
const knownHolders = new Map<string, SessionHolder>();

export const resetSessionHolderMemoryForTests = (): void => knownHolders.clear();

const initialState = (conversationId: string): State => {
  const holder = knownHolders.get(conversationId);
  return holder ? held(holder) : CHECKING;
};

const errorDetailOf = (error: unknown): string | undefined => {
  const detail = isBackendHttpError(error) ? error.backendMessage : error instanceof Error ? error.message : '';
  return detail.trim() || undefined;
};

/** A failure without a lock result never unblocks: it keeps a known holder or stays unconfirmed. */
const withoutResult = (current: State, error: unknown): State => ({
  status: current.holder ? 'held' : 'unconfirmed',
  holder: current.holder,
  recheckState: 'failed',
  errorDetail: errorDetailOf(error),
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
 * Only a successful ensure (a confirmed lock-free result) makes the conversation
 * writable: on first open, on return, and on recheck. Any other failure keeps sending,
 * the stored first message, and the Draft Box blocked and saved until a check succeeds.
 */
export const useSessionHolder = (conversationId: string, onWritable?: () => void): SessionHolderState => {
  const [state, setState] = useState<State>(() => initialState(conversationId));
  const activeIdRef = useRef(conversationId);
  activeIdRef.current = conversationId;
  const onWritableRef = useRef(onWritable);
  onWritableRef.current = onWritable;

  const settle = useCallback((requestedId: string, error: unknown, isRecheck: boolean) => {
    const lockHolder = sessionHolderFromError(error);
    if (lockHolder) knownHolders.set(requestedId, lockHolder);
    setState((current) =>
      lockHolder ? held(lockHolder, isRecheck ? 'stillHeld' : 'idle') : withoutResult(current, error)
    );
  }, []);

  useEffect(() => {
    setState(initialState(conversationId));
    let cancelled = false;
    ensureConversationRuntime(conversationId).then(
      () => {
        if (cancelled) return;
        knownHolders.delete(conversationId);
        setState(WRITABLE);
      },
      (error: unknown) => {
        if (!cancelled) settle(conversationId, error, false);
      }
    );
    return () => {
      cancelled = true;
    };
  }, [conversationId, settle]);

  useEffect(
    () =>
      ipcBridge.acpConversation.responseStream.on((message) => {
        if (message.conversation_id !== conversationId) return;
        const holder = sessionHolderFromStreamMessage(message);
        if (!holder) return;
        knownHolders.set(conversationId, holder);
        setState(held(holder));
      }),
    [conversationId]
  );

  const recheck = useCallback(() => {
    const requestedId = conversationId;
    setState((current) => ({ ...current, recheckState: 'checking' }));
    ensureConversationRuntime(requestedId).then(
      () => {
        if (activeIdRef.current !== requestedId) return;
        knownHolders.delete(requestedId);
        setState(WRITABLE);
        onWritableRef.current?.();
      },
      (error: unknown) => {
        if (activeIdRef.current === requestedId) settle(requestedId, error, true);
      }
    );
  }, [conversationId, settle]);

  return { ...state, recheck };
};
