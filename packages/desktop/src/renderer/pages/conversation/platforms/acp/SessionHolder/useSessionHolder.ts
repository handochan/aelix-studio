/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import { ensureConversationRuntime } from '@/renderer/pages/conversation/utils/ensureConversationRuntime';
import { useCallback, useEffect, useRef, useState } from 'react';
import { sessionHolderFromError, sessionHolderFromStreamMessage, type SessionHolder } from './sessionHolder';

export type SessionHolderState = {
  /** Set while another writer holds the native session; the view is read-only. */
  holder: SessionHolder | null;
  /** A user-requested recheck is in flight. */
  checking: boolean;
  /** The last recheck found the session still held. */
  stillHeld: boolean;
  recheck: () => void;
};

/**
 * Tracks whether another writer (the CLI, another Aelix process, or another Studio
 * window) holds this conversation's native session.
 *
 * It only observes outcomes the host already reports: the `runtime/ensure` call the
 * conversation makes on open (deduplicated with the existing warmup), and lock errors
 * on the response stream. It never takes, releases, or polls the lock on its own;
 * `recheck` repeats the same ensure call that reopening the conversation would make.
 * Only a positive lock report makes the view read-only. Other failures leave the
 * send box in place so the existing error surfaces handle them.
 */
export const useSessionHolder = (conversationId: string, onWritable?: () => void): SessionHolderState => {
  const [holder, setHolder] = useState<SessionHolder | null>(null);
  const [checking, setChecking] = useState(false);
  const [stillHeld, setStillHeld] = useState(false);
  const activeIdRef = useRef(conversationId);
  activeIdRef.current = conversationId;
  const onWritableRef = useRef(onWritable);
  onWritableRef.current = onWritable;

  useEffect(() => {
    setHolder(null);
    setChecking(false);
    setStillHeld(false);
    let cancelled = false;
    ensureConversationRuntime(conversationId).catch((error: unknown) => {
      if (cancelled) return;
      const next = sessionHolderFromError(error);
      if (next) setHolder(next);
    });
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  useEffect(
    () =>
      ipcBridge.acpConversation.responseStream.on((message) => {
        if (message.conversation_id !== conversationId) return;
        const next = sessionHolderFromStreamMessage(message);
        if (next) setHolder(next);
      }),
    [conversationId]
  );

  const recheck = useCallback(() => {
    const requestedId = conversationId;
    setChecking(true);
    setStillHeld(false);
    ensureConversationRuntime(requestedId).then(
      () => {
        if (activeIdRef.current !== requestedId) return;
        setChecking(false);
        setHolder(null);
        onWritableRef.current?.();
      },
      (error: unknown) => {
        if (activeIdRef.current !== requestedId) return;
        setChecking(false);
        const next = sessionHolderFromError(error);
        setHolder(next);
        setStillHeld(!!next);
      }
    );
  }, [conversationId]);

  return { holder, checking, stillHeld, recheck };
};
