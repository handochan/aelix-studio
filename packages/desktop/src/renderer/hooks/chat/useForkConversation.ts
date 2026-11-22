/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import { isBackendHttpError } from '@/common/adapter/httpBridge';
import { parseError } from '@/common/utils';
import { Message } from '@arco-design/web-react';
import { useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { emitter } from '@/renderer/utils/emitter';
import type { TFunction } from 'i18next';

/**
 * Map a fork API failure to a user-facing message. The backend carries stable
 * `FORK_*` reason prefixes (409/422); anything else falls back to the raw
 * parsed message.
 */
export function getForkErrorMessage(error: unknown, t: TFunction): string {
  const raw = parseError(error);
  const backendCode = isBackendHttpError(error) ? error.code : undefined;
  const matches = (code: string) => backendCode === code || raw.includes(code);
  if (matches('FORK_TURN_IN_FLIGHT')) return t('messages.fork.errorTurnInFlight');
  if (matches('FORK_PARENT_UNBOUND')) return t('messages.fork.errorParentUnbound');
  if (matches('FORK_HEAD_CHANGED')) return t('messages.fork.errorHeadChanged');
  if (matches('FORK_HEAD_UNAVAILABLE')) return t('messages.fork.errorHeadUnavailable');
  if (matches('FORK_POINT_UNSUPPORTED')) return t('messages.fork.errorPointUnsupported');
  if (matches('FORK_UNSUPPORTED')) return t('messages.fork.errorUnsupported');
  return t('messages.fork.errorGeneric', { message: raw });
}

/**
 * Fork the current conversation at a message: call the fork API, jump into the
 * forked conversation, and pre-warm its runtime so a backend-side fork failure
 * surfaces immediately instead of on the first send.
 */
export function useForkConversation(conversationId: string | undefined, requiresNativeHead = false) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const forkingRef = useRef(false);

  return useCallback(
    async (messageId: string, nativeHead?: string) => {
      if (!conversationId || forkingRef.current) return;
      forkingRef.current = true;
      try {
        if (requiresNativeHead && !nativeHead) {
          Message.error(t('messages.fork.errorHeadUnavailable'));
          return;
        }
        const forked = await ipcBridge.conversation.fork.invoke({
          conversation_id: conversationId,
          message_id: messageId,
          ...(requiresNativeHead ? { expected_native_head: nativeHead } : {}),
        });
        if (!forked?.id) {
          throw new Error('fork returned no conversation');
        }
        if (requiresNativeHead) {
          await ipcBridge.conversation.ensureRuntime.invoke({ conversation_id: forked.id });
        }
        emitter.emit('chat.history.refresh');
        void navigate(`/conversation/${forked.id}`);
        // Standalone ACP destinations materialize through their mounted view.
        // Other runtime types retain the existing eager warmup.
        if (!requiresNativeHead && forked.type !== 'acp' && forked.type !== 'antigravity') {
          void ipcBridge.conversation.ensureRuntime.invoke({ conversation_id: forked.id }).catch((): void => undefined);
        }
      } catch (error) {
        console.error('Failed to fork conversation:', error);
        Message.error(getForkErrorMessage(error, t));
      } finally {
        forkingRef.current = false;
      }
    },
    [conversationId, navigate, requiresNativeHead, t]
  );
}
