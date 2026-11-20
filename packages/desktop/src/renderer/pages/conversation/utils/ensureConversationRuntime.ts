import { ipcBridge } from '@/common';
import { isBackendHttpError } from '@/common/adapter/httpBridge';
import type { EnsureConversationRuntimeResponse } from '@/common/types/platform/acpTypes';

const ensureRuntimeByConversation = new Map<string, Promise<EnsureConversationRuntimeResponse>>();

async function ensureRuntime(
  conversation_id: string,
  viewId?: string,
  signal?: AbortSignal
): Promise<EnsureConversationRuntimeResponse> {
  const deadline = Date.now() + 25_000;
  const params = viewId ? { conversation_id, view_id: viewId, ...(signal && { signal }) } : { conversation_id };
  for (;;) {
    signal?.throwIfAborted();
    try {
      const runtime = await ipcBridge.conversation.ensureRuntime.invoke(params);
      signal?.throwIfAborted();
      return runtime;
    } catch (error) {
      if (!isBackendHttpError(error) || error.code !== 'runtime_restarting' || Date.now() >= deadline) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, 200));
    }
  }
}

export function ensureConversationRuntime(
  conversation_id: string,
  { fresh = false, viewId, signal }: { fresh?: boolean; viewId?: string; signal?: AbortSignal } = {}
): Promise<EnsureConversationRuntimeResponse> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  const key = JSON.stringify([conversation_id, viewId]);
  const existing = ensureRuntimeByConversation.get(key);
  if (existing && !fresh) return existing;

  const promise = ensureRuntime(conversation_id, viewId, signal).finally(() => {
    if (ensureRuntimeByConversation.get(key) === promise) {
      ensureRuntimeByConversation.delete(key);
    }
  });
  ensureRuntimeByConversation.set(key, promise);
  return promise;
}

export function resetEnsureConversationRuntimeStateForTests(): void {
  ensureRuntimeByConversation.clear();
}
