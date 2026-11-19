/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useRef } from 'react';
import { ipcBridge } from '@/common';
import { isBackendHttpError } from '@/common/adapter/httpBridge';
import { uuid } from '@/common/utils/utils';
import { ACTIVE_LEASE_RENEW_INTERVAL_MS } from '@/renderer/pages/conversation/hooks/useActiveLease';
import { ensureConversationRuntime } from '@/renderer/pages/conversation/utils/ensureConversationRuntime';

/** Bind runtime ensure, heartbeat and departure to one mounted view. */
export function useSessionLockView(conversationId: string): () => ReturnType<typeof ensureConversationRuntime> {
  const current = useRef<{ conversation_id: string; view_id: string } | undefined>(undefined);
  const ensure = useCallback(() => {
    const view = current.current;
    return ensureConversationRuntime(conversationId, { viewId: view?.view_id });
  }, [conversationId]);

  useEffect(() => {
    const params = { conversation_id: conversationId, view_id: uuid(36) };
    current.current = params;

    let departed = false;
    let renewing = false;
    const renew = async () => {
      if (departed || renewing || document.visibilityState === 'hidden') return;
      renewing = true;
      try {
        await ipcBridge.conversation.renewViewLease.invoke(params);
      } catch (error) {
        // A background tab may have outlived the host's lease. Re-register only
        // the view which is still mounted, using the same fenced ensure path.
        if (!departed && isBackendHttpError(error) && error.status === 409) {
          void ensure().catch(() => {});
        }
      } finally {
        renewing = false;
      }
    };
    const heartbeat = setInterval(() => void renew(), ACTIVE_LEASE_RENEW_INTERVAL_MS);
    const visible = (): void => {
      void renew();
    };
    document.addEventListener('visibilitychange', visible);

    const depart = () => {
      if (departed) return;
      departed = true;
      clearInterval(heartbeat);
      document.removeEventListener('visibilitychange', visible);
      // The host schedules the release even if this page cannot receive a reply.
      void ipcBridge.conversation.releaseRuntime.invoke(params).catch(() => {});
    };
    const closePage = (event: PageTransitionEvent) => {
      if (!event.persisted) depart();
    };
    window.addEventListener('pagehide', closePage);

    return () => {
      window.removeEventListener('pagehide', closePage);
      if (current.current === params) current.current = undefined;
      depart();
    };
  }, [conversationId, ensure]);

  return ensure;
}
