/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { useLayoutEffect, useMemo } from 'react';
import { ipcBridge } from '@/common';
import { isBackendHttpError } from '@/common/adapter/httpBridge';
import { uuid } from '@/common/utils/utils';
import { ACTIVE_LEASE_RENEW_INTERVAL_MS } from '@/renderer/pages/conversation/hooks/useActiveLease';
import { ensureConversationRuntime } from '@/renderer/pages/conversation/utils/ensureConversationRuntime';

export type SessionLockView = {
  ensure: (options?: { fresh?: boolean }) => ReturnType<typeof ensureConversationRuntime>;
  onLeaseExpired: (listener: () => Promise<void>) => () => void;
};

type ViewLifetime = { id: string; lifetime: AbortController };

function createSessionView(conversationId: string | undefined) {
  let active: ViewLifetime | undefined;
  let onExpired: (() => Promise<void>) | undefined;
  const view: SessionLockView = {
    ensure: ({ fresh } = {}) => {
      if (!conversationId || !active) {
        return Promise.reject(new DOMException('Conversation view has departed', 'AbortError'));
      }
      return ensureConversationRuntime(conversationId, {
        viewId: active.id,
        signal: active.lifetime.signal,
        fresh,
      });
    },
    onLeaseExpired: (listener) => {
      onExpired = listener;
      return () => {
        if (onExpired === listener) onExpired = undefined;
      };
    },
  };

  return {
    view,
    attach: (lifetime: ViewLifetime | undefined) => {
      active = lifetime;
    },
    recover: async () => {
      await onExpired?.();
    },
  };
}

/** Share the mounted view's runtime admission with every standalone ACP reader. */
export function useSessionLockView(conversationId: string | undefined): SessionLockView | undefined {
  const scope = useMemo(() => createSessionView(conversationId), [conversationId]);

  useLayoutEffect(() => {
    if (!conversationId) return;
    const active = { id: uuid(36), lifetime: new AbortController() };
    const params = { conversation_id: conversationId, view_id: active.id };
    scope.attach(active);

    let renewing = false;
    const renew = async () => {
      if (active.lifetime.signal.aborted || renewing || document.visibilityState === 'hidden') return;
      renewing = true;
      try {
        await ipcBridge.conversation.renewViewLease.invoke(params);
      } catch (error) {
        if (!active.lifetime.signal.aborted && isBackendHttpError(error) && error.status === 409) {
          await scope.recover();
        }
      } finally {
        renewing = false;
      }
    };
    const visible = (): void => {
      void renew();
    };
    const heartbeat = setInterval(visible, ACTIVE_LEASE_RENEW_INTERVAL_MS);
    document.addEventListener('visibilitychange', visible);

    const depart = (pageClosing: boolean) => {
      if (active.lifetime.signal.aborted) return;
      active.lifetime.abort();
      scope.attach(undefined);
      clearInterval(heartbeat);
      document.removeEventListener('visibilitychange', visible);
      // The host schedules the release even if this page cannot receive a reply.
      const release = pageClosing
        ? ipcBridge.conversation.releaseRuntimeOnPageHide
        : ipcBridge.conversation.releaseRuntime;
      void release.invoke(params).catch(() => {});
    };
    const closePage = (event: PageTransitionEvent) => {
      if (!event.persisted) depart(true);
    };
    window.addEventListener('pagehide', closePage);

    return () => {
      window.removeEventListener('pagehide', closePage);
      depart(false);
    };
  }, [conversationId, scope]);

  return conversationId ? scope.view : undefined;
}
