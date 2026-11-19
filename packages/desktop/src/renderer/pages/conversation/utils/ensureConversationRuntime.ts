import { ipcBridge } from '@/common';
import { isBackendHttpError } from '@/common/adapter/httpBridge';
import type { EnsureConversationRuntimeResponse } from '@/common/types/platform/acpTypes';

type PendingEnsure = {
  result: Promise<EnsureConversationRuntimeResponse>;
  afterRelease: Promise<unknown> | undefined;
};

const ensureRuntimeByConversation = new Map<string, PendingEnsure>();
const releasingByConversation = new Map<string, Promise<unknown>>();

async function ensureRuntime(conversation_id: string): Promise<EnsureConversationRuntimeResponse> {
  const deadline = Date.now() + 25_000;
  for (;;) {
    try {
      return await ipcBridge.conversation.ensureRuntime.invoke({ conversation_id });
    } catch (error) {
      if (!isBackendHttpError(error) || error.code !== 'runtime_restarting' || Date.now() >= deadline) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, 200));
    }
  }
}

/** Run a departure after the previous warmup. A later warmup waits for this attempt. */
export function afterConversationRuntimeEnsure<T>(conversationId: string, release: () => Promise<T>): Promise<T> {
  const previous = [
    ensureRuntimeByConversation.get(conversationId)?.result,
    releasingByConversation.get(conversationId),
  ];
  const promise = Promise.allSettled(previous)
    .then(release)
    .finally(() => {
      if (releasingByConversation.get(conversationId) === promise) {
        releasingByConversation.delete(conversationId);
      }
    });
  releasingByConversation.set(conversationId, promise);
  return promise;
}

export function ensureConversationRuntime(
  conversation_id: string,
  { fresh = false }: { fresh?: boolean } = {}
): Promise<EnsureConversationRuntimeResponse> {
  const existing = ensureRuntimeByConversation.get(conversation_id);
  const releasing = releasingByConversation.get(conversation_id);
  if (existing && !fresh && (!releasing || existing.afterRelease === releasing)) {
    return existing.result;
  }

  const request = releasing
    ? releasing.catch((): void => undefined).then(() => ensureRuntime(conversation_id))
    : ensureRuntime(conversation_id);
  const promise = request.finally(() => {
    if (ensureRuntimeByConversation.get(conversation_id)?.result === promise) {
      ensureRuntimeByConversation.delete(conversation_id);
    }
  });
  ensureRuntimeByConversation.set(conversation_id, { result: promise, afterRelease: releasing });
  return promise;
}

export function resetEnsureConversationRuntimeStateForTests(): void {
  ensureRuntimeByConversation.clear();
  releasingByConversation.clear();
}
