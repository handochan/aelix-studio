/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useState } from 'react';
import { createNativeResources, type NativeResources } from '@/renderer/services/runtime/NativeResources';
import { isRecord } from '@/renderer/services/runtime/RunningInput/transport';
import { ipcBridge } from '@/common';
import { onUserChange } from '@/renderer/hooks/context/AuthContext';

/**
 * Own one NativeResources client for a mounted settings screen. The client is disposed on
 * unmount, so returning to the screen lists again and observes CLI changes. A sign-out or another
 * user's sign-in replaces the client, so nothing read or staged for the previous user survives.
 */
export function useNativeClient(): NativeResources | undefined {
  const [client, setClient] = useState<NativeResources>();
  useEffect(() => {
    let current = createNativeResources();
    setClient(current);
    const unsubscribe = onUserChange(() => {
      current.dispose();
      current = createNativeResources();
      setClient(current);
    });
    return () => {
      unsubscribe();
      current.dispose();
    };
  }, []);
  return client;
}

export type ConversationWorkspace =
  | { status: 'loading' }
  | { status: 'ready'; name: string | null; workspace: string | null }
  | { status: 'failed' };

/**
 * Read the display name and workspace folder of the conversation that opened settings. `client`
 * is the current user's NativeResources client: a user change replaces it, which drops the
 * previous user's path and reads again as the new user.
 */
export function useConversationWorkspace(
  conversationId: string | null | undefined,
  client: NativeResources | undefined
): ConversationWorkspace | undefined {
  const [state, setState] = useState<ConversationWorkspace>();
  useEffect(() => {
    if (!conversationId || !client) {
      setState(undefined);
      return;
    }
    const request = new AbortController();
    setState({ status: 'loading' });
    ipcBridge.conversation.get
      .invoke({ id: conversationId, privateRead: true, signal: request.signal })
      .then((detail: unknown) => {
        if (request.signal.aborted) return;
        const extra = isRecord(detail) && isRecord(detail.extra) ? detail.extra : undefined;
        setState({
          status: 'ready',
          name: isRecord(detail) && typeof detail.name === 'string' ? detail.name : null,
          workspace: extra && typeof extra.workspace === 'string' && extra.workspace ? extra.workspace : null,
        });
      })
      .catch(() => {
        if (!request.signal.aborted) setState({ status: 'failed' });
      });
    return () => request.abort();
  }, [client, conversationId]);
  return state;
}
