/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import { ensureConversationRuntime } from '@/renderer/pages/conversation/utils/ensureConversationRuntime';
import { useCallback, useEffect, useRef, useState } from 'react';
import { classifyCheckFailure, type CheckFailure } from './checkFailure';
import { useSessionLockView } from './useSessionLockView';
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
  /** The last failure that carried no lock result. */
  failure?: CheckFailure;
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

/** A failure without a lock result never unblocks: it keeps a known holder or stays unconfirmed. */
const withoutResult = (current: State, error: unknown): State => ({
  status: current.holder ? 'held' : 'unconfirmed',
  holder: current.holder,
  recheckState: 'failed',
  failure: classifyCheckFailure(error),
});

/**
 * Tracks whether another writer (the CLI or another Aelix process) holds this
 * conversation's native session.
 *
 * Host ensure and stream errors are the source of the holder state. The view also
 * asks the host to release the solo runtime when the conversation closes.
 * `recheck` repeats the ensure call that opening the conversation makes.
 *
 * Only a successful ensure (a confirmed lock-free result) makes the conversation
 * writable: on first open, on return, and on recheck. Any other failure keeps sending,
 * the stored first message, and the Draft Box blocked and saved until a check succeeds.
 */
export const useSessionHolder = (conversationId: string, onWritable?: () => void): SessionHolderState => {
  useSessionLockView(conversationId);
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
