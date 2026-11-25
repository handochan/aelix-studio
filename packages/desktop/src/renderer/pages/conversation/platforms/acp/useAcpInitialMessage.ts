/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import type { TMessage } from '@/common/chat/chatLib';
import type { TConversationRuntimeSummary } from '@/common/config/storage';
import { parseError, uuid } from '@/common/utils';
import { isBackendHttpError } from '@/common/adapter/httpBridge';
import { emitter } from '@/renderer/utils/emitter';
import { type ChatFileRef, isChatFileRef, uploadFileRef } from '@/common/types/chatFile';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { getConversationRuntimeWorkspaceErrorMessage } from '../../utils/conversationCreateError';
import type { ConversationRuntimeSendFailure } from '../../runtime/conversationRuntimeViewStore';
import { classifyConversationBusyError } from '../conversationBusyError';
import { buildSendFailureError } from './buildSendFailureError';
import { AelixInitialModelUnconfirmed } from '@/renderer/services/runtime/aelixInitialModel';

const isRefusedByHost = (error: unknown): boolean =>
  isBackendHttpError(error) && error.status >= 400 && error.status < 500;

type UseAcpInitialMessageParams = {
  conversation_id: string;
  /** Holds the stored message until sending is allowed (e.g. the session holder check). */
  blocked?: boolean;
  backend: string;
  setAiProcessing: (value: boolean) => void;
  resetState: () => void;
  markSendStarted?: () => void;
  markSendAccepted?: (turn_id: string, runtime: TConversationRuntimeSummary, msg_id?: string) => void;
  markSendFailed?: (failure: ConversationRuntimeSendFailure) => void;
  beginCompactionSubmission?: (input: string) => (() => void) | undefined;
  checkAndUpdateTitle: (conversation_id: string, input: string) => void;
  addOrUpdateMessage: (message: TMessage, prepend?: boolean) => void;
  submitPrompt?: (dispatch: () => Promise<void>) => Promise<void>;
  restoreDraft?: (input: string, files: ChatFileRef[]) => void;
};

/**
 * Side-effect-only hook that checks sessionStorage for an initial message
 * and sends it when the ACP conversation first mounts.
 */
export const useAcpInitialMessage = ({
  conversation_id,
  blocked = false,
  backend,
  setAiProcessing,
  resetState,
  markSendStarted,
  markSendAccepted,
  markSendFailed,
  beginCompactionSubmission,
  checkAndUpdateTitle,
  addOrUpdateMessage,
  submitPrompt,
  restoreDraft,
}: UseAcpInitialMessageParams): void => {
  const { t } = useTranslation();

  useEffect(() => {
    if (blocked) return;
    const storageKey = `acp_initial_message_${conversation_id}`;
    const storedMessage = sessionStorage.getItem(storageKey);

    if (!storedMessage) return;

    // Clear immediately to prevent duplicate sends (e.g., if component remounts while sendMessage is pending)
    sessionStorage.removeItem(storageKey);

    const sendInitialMessage = async () => {
      let finishCompactionSubmission: (() => void) | undefined;
      let draft: { input: string; files: ChatFileRef[] } | undefined;
      let dispatched = false;
      try {
        const initialMessage = JSON.parse(storedMessage);
        const input = typeof initialMessage.input === 'string' ? initialMessage.input : '';
        finishCompactionSubmission = beginCompactionSubmission?.(input);
        // Guid-page initial files are source-tagged ChatFileRefs (`local` for
        // backend-machine picks, `upload` for device uploads). Body stays plain
        // text; the backend resolves each ref and injects the [[AION_FILES]]
        // marker at the send edge. Legacy string[] entries (a stale pre-upgrade
        // session) coerce to upload refs for back-compat.
        const files: ChatFileRef[] = Array.isArray(initialMessage.files)
          ? initialMessage.files
              .map((f: unknown) => (typeof f === 'string' ? uploadFileRef(f) : f))
              .filter(isChatFileRef)
          : [];

        draft = { input, files };
        const dispatch = async () => {
          dispatched = true;
          markSendStarted?.();
          setAiProcessing(true);
          void checkAndUpdateTitle(conversation_id, input);
          const result = await ipcBridge.acpConversation.sendMessage.invoke({ input, conversation_id, files });
          markSendAccepted?.(result.turn_id, result.runtime, result.msg_id);
        };
        if (submitPrompt) await submitPrompt(dispatch);
        else await dispatch();

        // Initial message sent successfully
        emitter.emit('chat.history.refresh');
      } catch (error) {
        // Give the prompt back unless it may have reached the agent: a 4xx means the host
        // refused it, while a lost connection or a 5xx leaves that unknown.
        if (draft && (!dispatched || isRefusedByHost(error))) restoreDraft?.(draft.input, draft.files);
        const errorMessageText =
          error instanceof AelixInitialModelUnconfirmed
            ? t('agent.model.switchFailed')
            : getConversationRuntimeWorkspaceErrorMessage(error, t) || parseError(error) || t('common.unknownError');
        const busyError = classifyConversationBusyError(error);
        if (busyError) {
          markSendFailed?.({
            kind: 'busy_conflict',
            reason: errorMessageText,
            busyKind: busyError.kind,
            status: busyError.status,
            code: busyError.code,
          });
          console.info('[useAcpInitialMessage] Initial send hit conversation busy state', busyError.status);
          return;
        }

        markSendFailed?.({ kind: 'ordinary', reason: errorMessageText });
        console.error('[useAcpInitialMessage] Error sending initial message');

        const errorMessage: TMessage = {
          id: uuid(),
          msg_id: uuid(),
          conversation_id: conversation_id,
          type: 'tips',
          position: 'center',
          content: {
            content: errorMessageText,
            type: 'error',
            error: buildSendFailureError(error, errorMessageText),
          },
          created_at: Date.now() + 2,
        };
        addOrUpdateMessage(errorMessage, true);
        resetState();
        setAiProcessing(false); // Keep the prop-setter in sync with the hook reset
      } finally {
        finishCompactionSubmission?.();
      }
    };

    sendInitialMessage().catch(() => {
      console.error('Failed to send initial message');
    });
  }, [
    addOrUpdateMessage,
    backend,
    beginCompactionSubmission,
    blocked,
    checkAndUpdateTitle,
    conversation_id,
    markSendAccepted,
    markSendFailed,
    markSendStarted,
    resetState,
    restoreDraft,
    setAiProcessing,
    submitPrompt,
    t,
  ]);
};
