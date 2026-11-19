/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useState } from 'react';
import { ipcBridge } from '@/common';
import { uuid } from '@/common/utils/utils';
import { ACTIVE_LEASE_RENEW_INTERVAL_MS } from '@/renderer/pages/conversation/hooks/useActiveLease';
import { afterConversationRuntimeEnsure } from '@/renderer/pages/conversation/utils/ensureConversationRuntime';

const RELEASE_RETRY_MS = 2_000;
const openViews = new Map<string, Set<string>>();

/** Hold a foreground lease while this view is open and release it on departure. */
export function useSessionLockView(conversationId: string): void {
  const [viewId] = useState(() => uuid(36));

  useEffect(() => {
    const params = { conversation_id: conversationId, view_id: viewId };
    const shown = openViews.get(conversationId) ?? new Set<string>();
    shown.add(viewId);
    openViews.set(conversationId, shown);

    let renewal: Promise<void> | undefined;
    const renew = () => {
      if (document.visibilityState === 'hidden' || renewal) return;
      renewal = ipcBridge.conversation.activeLease
        .invoke(params)
        .catch((): void => undefined)
        .finally(() => {
          renewal = undefined;
        });
    };
    renew();
    const heartbeat = setInterval(renew, ACTIVE_LEASE_RENEW_INTERVAL_MS);
    document.addEventListener('visibilitychange', renew);

    let pageClosed = false;
    const closePage = (event: PageTransitionEvent) => {
      if (event.persisted) return;
      pageClosed = true;
      void ipcBridge.conversation.releaseRuntime.invoke(params).catch(() => {});
    };
    window.addEventListener('pagehide', closePage);

    const wasReopened = () => openViews.get(conversationId)?.has(viewId) ?? false;
    const release = async (retry: boolean) => {
      if (retry && openViews.has(conversationId)) return;
      try {
        const result = await afterConversationRuntimeEnsure(conversationId, async () => {
          await renewal;
          if (wasReopened() || (retry && openViews.has(conversationId))) return;
          return ipcBridge.conversation.releaseRuntime.invoke(params);
        });
        if (result?.outcome === 'busy' && !openViews.has(conversationId)) {
          setTimeout(() => void release(true), RELEASE_RETRY_MS);
        }
      } catch {
        // Older hosts and transport failures fall back to host idle cleanup.
      }
    };

    return () => {
      clearInterval(heartbeat);
      document.removeEventListener('visibilitychange', renew);
      window.removeEventListener('pagehide', closePage);
      shown.delete(viewId);
      if (!shown.size) openViews.delete(conversationId);
      if (!pageClosed) void release(false);
    };
  }, [conversationId, viewId]);
}
