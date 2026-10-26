/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TMessage } from '@/common/chat/chatLib';
import type { TConversationRuntimeSummary } from '@/common/config/storage';
import { parseError, uuid } from '@/common/utils';
import { emitter } from '@/renderer/utils/emitter';
import { type ChatFileRef, isChatFileRef, uploadFileRef } from '@/common/types/chatFile';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { getConversationRuntimeWorkspaceErrorMessage } from '../../utils/conversationCreateError';
import type { ConversationRuntimeSendFailure } from '../../runtime/conversationRuntimeViewStore';
import { classifyConversationBusyError } from '../conversationBusyError';
import { buildSendFailureError } from './buildSendFailureError';
import type { ManagedRequestBinding } from '@/common/types/platform/acpTypes';
import {
  getManagedOperationErrorMessage,
  isManagedBinding,
  ManagedOperationError,
  sendManagedMessage,
} from './managedOperations';

const submittingInitials = new Set<string>();

type UseAcpInitialMessageParams = {
  conversation_id: string;
  backend: string;
  setAiProcessing: (value: boolean) => void;
  resetState: () => void;
  markSendStarted?: () => void;
  markSendAccepted?: (turn_id: string, runtime: TConversationRuntimeSummary, msg_id?: string) => void;
  markSendFailed?: (failure: ConversationRuntimeSendFailure) => void;
  checkAndUpdateTitle: (conversation_id: string, input: string) => void;
  addOrUpdateMessage: (message: TMessage, prepend?: boolean) => void;
};

/**
 * Side-effect-only hook that checks sessionStorage for an initial message
 * and sends it when the ACP conversation first mounts.
 */
export const useAcpInitialMessage = ({
  conversation_id,
  backend,
  setAiProcessing,
  resetState,
  markSendStarted,
  markSendAccepted,
  markSendFailed,
  checkAndUpdateTitle,
  addOrUpdateMessage,
}: UseAcpInitialMessageParams): void => {
  const { t } = useTranslation();

  useEffect(() => {
    const storageKey = `acp_initial_message_${conversation_id}`;
    const storedMessage = sessionStorage.getItem(storageKey);

    if (!storedMessage) return;

    if (submittingInitials.has(storageKey)) return;
    submittingInitials.add(storageKey);

    const sendInitialMessage = async () => {
      try {
        const initialMessage = JSON.parse(storedMessage);
        const input = typeof initialMessage.input === 'string' ? initialMessage.input : '';
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
        const operationId =
          typeof initialMessage.operation_id === 'string' ? initialMessage.operation_id : `initial-${conversation_id}`;
        if (initialMessage.operation_binding !== undefined && !isManagedBinding(initialMessage.operation_binding))
          throw new ManagedOperationError('OPERATION_UNCERTAIN');
        const binding: ManagedRequestBinding | undefined = isManagedBinding(initialMessage.operation_binding)
          ? initialMessage.operation_binding
          : undefined;
        const frozen = { input, files, operation_id: operationId, ...(binding ? { operation_binding: binding } : {}) };
        sessionStorage.setItem(storageKey, JSON.stringify(frozen));

        markSendStarted?.();
        setAiProcessing(true);

        void checkAndUpdateTitle(conversation_id, input);
        const result = await sendManagedMessage(
          {
            input,
            conversation_id: conversation_id,
            files,
          },
          {
            id: operationId,
            binding,
            onPrepared: (prepared) =>
              sessionStorage.setItem(storageKey, JSON.stringify({ ...frozen, operation_binding: prepared })),
            onLegacy: () => sessionStorage.removeItem(storageKey),
          }
        );
        sessionStorage.removeItem(storageKey);
        markSendAccepted?.(result.turn_id, result.runtime, result.msg_id);
        if (result.operation?.replayed) setAiProcessing(result.runtime.is_processing);

        // Initial message sent successfully
        emitter.emit('chat.history.refresh');
      } catch (error) {
        const errorMessageText =
          getManagedOperationErrorMessage(error, t) ||
          getConversationRuntimeWorkspaceErrorMessage(error, t) ||
          parseError(error) ||
          t('common.unknownError');
        const busyError = classifyConversationBusyError(error);
        if (busyError) {
          markSendFailed?.({
            kind: 'busy_conflict',
            reason: errorMessageText,
            busyKind: busyError.kind,
            status: busyError.status,
            code: busyError.code,
          });
          console.info('[useAcpInitialMessage] Initial send hit conversation busy state:', {
            conversation_id,
            busyKind: busyError.kind,
            status: busyError.status,
            code: busyError.code,
          });
          return;
        }

        markSendFailed?.({ kind: 'ordinary', reason: errorMessageText });
        console.error('[useAcpInitialMessage] Error sending initial message:', error);
        console.error('[useAcpInitialMessage] Error details:', {
          name: (error as Error)?.name,
          message: errorMessageText,
          conversation_id,
        });

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
      }
    };

    sendInitialMessage()
      .finally(() => submittingInitials.delete(storageKey))
      .catch((error) => {
        console.error('Failed to send initial message:', error);
      });
  }, [
    addOrUpdateMessage,
    backend,
    checkAndUpdateTitle,
    conversation_id,
    markSendAccepted,
    markSendFailed,
    markSendStarted,
    resetState,
    setAiProcessing,
    t,
  ]);
};
