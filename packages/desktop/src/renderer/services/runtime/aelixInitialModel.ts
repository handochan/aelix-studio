import { ipcBridge } from '@/common';
import type { AcpConfigOptionDto } from '@/common/types/platform/acpTypes';
import { deriveSelectOption, hasObservedValue } from '@/renderer/hooks/agent/useAcpConfigOptions';
import { ensureConversationRuntime } from '@/renderer/pages/conversation/utils/ensureConversationRuntime';

export class AelixInitialModelUnconfirmed extends Error {}

/** Read the outstanding first-prompt model from conversation metadata. */
export function readAelixInitialModel(extra: unknown): string | undefined {
  if (typeof extra !== 'object' || !extra || !('studio_initial_model' in extra)) return undefined;
  const value = extra.studio_initial_model;
  return typeof value === 'string' && value ? value : undefined;
}

/** Read the current intent so a confirmed header change can replace the original pick. */
export async function loadAelixInitialModel(conversationId: string): Promise<string | undefined> {
  const conversation = await ipcBridge.conversation.get.invoke({ id: conversationId, privateRead: true });
  return readAelixInitialModel(conversation.extra);
}

/** Apply an advertised model if needed and require ACP to report it as current. */
export async function confirmAelixInitialModel(
  conversationId: string,
  modelId: string,
  loadFresh: () => Promise<AcpConfigOptionDto[] | null | undefined> = async () =>
    (await ensureConversationRuntime(conversationId, { fresh: true })).config_options
): Promise<void> {
  try {
    const model = deriveSelectOption(await loadFresh(), 'model', ['model']);
    if (model?.currentValue === modelId) return;
    if (model?.options.some(({ value }) => value === modelId)) {
      const result = await ipcBridge.acpConversation.setConfigOption.invoke({
        conversation_id: conversationId,
        option_id: model.id,
        value: modelId,
      });
      if (hasObservedValue(result, model.id, modelId)) return;
    }
  } catch (error) {
    throw new AelixInitialModelUnconfirmed('Aelix did not confirm the selected model', { cause: error });
  }
  throw new AelixInitialModelUnconfirmed('Aelix did not confirm the selected model');
}

/** Recheck the live session directly before dispatching an outstanding first prompt. */
export async function confirmPendingAelixInitialModel(
  conversationId: string,
  loadFresh?: () => Promise<AcpConfigOptionDto[] | null | undefined>
): Promise<boolean> {
  let modelId: string | undefined;
  try {
    modelId = await loadAelixInitialModel(conversationId);
  } catch (error) {
    throw new AelixInitialModelUnconfirmed('Could not read the selected Aelix model', { cause: error });
  }
  if (!modelId) return false;
  await confirmAelixInitialModel(conversationId, modelId, loadFresh);
  return true;
}

/** Retarget an outstanding choice or retire it after the host accepts a prompt. */
export async function saveAelixInitialModel(conversationId: string, model: string | null): Promise<void> {
  const updated = await ipcBridge.conversation.update.invoke({
    id: conversationId,
    updates: { extra: { studio_initial_model: model } },
    merge_extra: true,
  });
  if (!updated) throw new Error('Could not update the Aelix first-prompt model');
}
