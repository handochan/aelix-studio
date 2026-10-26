import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { TConversationRuntimeSummary } from '@/common/config/storage';
import type { ConversationRuntimeSendFailure } from '../../../runtime/conversationRuntimeViewStore';
import { emitter } from '@/renderer/utils/emitter';
import { getManagedOperationErrorMessage, hasManagedRecovery, recoverManagedMessage } from './index';

type RecoveryCallbacks = {
  setAiProcessing: (processing: boolean) => void;
  markSendAccepted: (turn: string, runtime: TConversationRuntimeSummary, msg?: string) => void;
  markSendFailed: (failure: ConversationRuntimeSendFailure) => void;
};

export function useManagedOperationRecovery(conversation: string, options: RecoveryCallbacks): void {
  const callbacks = useRef(options);
  callbacks.current = options;
  const { t } = useTranslation();
  useEffect(() => {
    if (!hasManagedRecovery(conversation)) return;
    let mounted = true;
    void recoverManagedMessage(conversation)
      .then((result) => {
        if (!mounted || !result) return;
        callbacks.current.markSendAccepted(result.turn_id, result.runtime, result.msg_id);
        callbacks.current.setAiProcessing(result.runtime.is_processing);
        emitter.emit('chat.history.refresh');
      })
      .catch((error: unknown) => {
        if (!mounted) return;
        callbacks.current.markSendFailed({
          kind: 'ordinary',
          reason: getManagedOperationErrorMessage(error, t) ?? t('conversation.managedOperation.uncertain'),
        });
        callbacks.current.setAiProcessing(false);
      });
    return () => {
      mounted = false;
    };
  }, [conversation, t]);
}
