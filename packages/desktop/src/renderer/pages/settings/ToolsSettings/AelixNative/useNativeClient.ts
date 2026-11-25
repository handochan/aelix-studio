/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useState } from 'react';
import { createNativeResources, type NativeResources } from '@/renderer/services/runtime/NativeResources';
import { isRecord } from '@/renderer/services/runtime/RunningInput/transport';
import { ipcBridge } from '@/common';

/**
 * Own one NativeResources client for a mounted settings screen. The client is disposed on
 * unmount, so returning to the screen lists again and observes CLI changes.
 */
export function useNativeClient(): NativeResources | undefined {
  const [client, setClient] = useState<NativeResources>();
  useEffect(() => {
    const next = createNativeResources();
    setClient(next);
    return () => next.dispose();
  }, []);
  return client;
}

export type ConversationWorkspace =
  | { status: 'loading' }
  | { status: 'ready'; name: string | null; workspace: string | null }
  | { status: 'failed' };

/** Read the display name and workspace folder of the conversation that opened settings. */
export function useConversationWorkspace(conversationId: string | null | undefined): ConversationWorkspace | undefined {
  const [state, setState] = useState<ConversationWorkspace>();
  useEffect(() => {
    if (!conversationId) {
      setState(undefined);
      return;
    }
    let active = true;
    setState({ status: 'loading' });
    ipcBridge.conversation.get
      .invoke({ id: conversationId, privateRead: true })
      .then((detail: unknown) => {
        if (!active) return;
        const extra = isRecord(detail) && isRecord(detail.extra) ? detail.extra : undefined;
        setState({
          status: 'ready',
          name: isRecord(detail) && typeof detail.name === 'string' ? detail.name : null,
          workspace: extra && typeof extra.workspace === 'string' && extra.workspace ? extra.workspace : null,
        });
      })
      .catch(() => {
        if (active) setState({ status: 'failed' });
      });
    return () => {
      active = false;
    };
  }, [conversationId]);
  return state;
}
