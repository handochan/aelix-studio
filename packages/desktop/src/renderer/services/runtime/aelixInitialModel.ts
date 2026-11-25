import { ipcBridge } from '@/common';
import type { AcpConfigOptionDto, SetConfigOptionResponse } from '@/common/types/platform/acpTypes';
import {
  deriveSelectOption,
  findConfigOption,
  hasObservedValue,
  waitForConfigOptionIdle,
} from '@/renderer/hooks/agent/useAcpConfigOptions';
import { ensureConversationRuntime } from '@/renderer/pages/conversation/utils/ensureConversationRuntime';

export class AelixInitialModelUnconfirmed extends Error {}

// Header model changes and the first prompt share one queue per conversation, so a
// prompt can never read the metadata between an observed switch and its write.
const modelOperations = new Map<string, Promise<void>>();
// Observed switches whose metadata write failed; the next prompt retries the write.
const unsavedModelChoices = new Map<string, string>();

function serializeModelOperation<T>(conversationId: string, run: () => Promise<T>): Promise<T> {
  const operation = (modelOperations.get(conversationId) ?? Promise.resolve()).then(run);
  const settled = operation.then(
    () => {},
    () => {}
  );
  modelOperations.set(conversationId, settled);
  void settled.then(() => {
    if (modelOperations.get(conversationId) === settled) modelOperations.delete(conversationId);
  });
  return operation;
}

/** Read the outstanding first-prompt model from conversation metadata. */
export function readAelixInitialModel(extra: unknown): string | undefined {
  if (typeof extra !== 'object' || !extra || !('studio_initial_model' in extra)) return undefined;
  const value = extra.studio_initial_model;
  return typeof value === 'string' && value ? value : undefined;
}

/** Read the current intent so a confirmed header change can replace the original pick. */
async function loadAelixInitialModel(conversationId: string): Promise<string | undefined> {
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
async function confirmPendingAelixInitialModel(
  conversationId: string,
  loadFresh?: () => Promise<AcpConfigOptionDto[] | null | undefined>
): Promise<boolean> {
  let modelId: string | undefined;
  try {
    const unsavedChoice = unsavedModelChoices.get(conversationId);
    if (unsavedChoice) await persistModelChoice(conversationId, unsavedChoice);
    modelId = await loadAelixInitialModel(conversationId);
  } catch (error) {
    throw new AelixInitialModelUnconfirmed('Could not read the selected Aelix model', { cause: error });
  }
  if (!modelId) return false;
  await confirmAelixInitialModel(conversationId, modelId, loadFresh);
  return true;
}

/** Retarget an outstanding choice or retire it after the host accepts a prompt. */
async function saveAelixInitialModel(conversationId: string, model: string | null): Promise<void> {
  const updated = await ipcBridge.conversation.update.invoke({
    id: conversationId,
    updates: { extra: { studio_initial_model: model } },
    merge_extra: true,
  });
  if (!updated) throw new Error('Could not update the Aelix first-prompt model');
}

async function persistModelChoice(conversationId: string, model: string): Promise<void> {
  // The runtime has already changed. Retain the observed choice if persistence fails.
  unsavedModelChoices.set(conversationId, model);
  await saveAelixInitialModel(conversationId, model);
  unsavedModelChoices.delete(conversationId);
}

/** Apply a selector change and record an observed first-prompt model choice. */
export function setAelixInitialModelConfigOption(
  conversation_id: string,
  option_id: string,
  value: string
): Promise<SetConfigOptionResponse> {
  return serializeModelOperation(conversation_id, async () => {
    const pendingChoice = await loadAelixInitialModel(conversation_id);
    const response = await ipcBridge.acpConversation.setConfigOption.invoke({ conversation_id, option_id, value });
    if (
      pendingChoice &&
      hasObservedValue(response, option_id, value) &&
      findConfigOption(response.config_options, 'model', ['model'])?.id === option_id
    ) {
      await persistModelChoice(conversation_id, value);
    }
    return response;
  });
}

/** Hold the selector behind model confirmation, prompt admission, and metadata retirement. */
export async function submitAelixInitialPrompt(
  conversationId: string,
  dispatch: () => Promise<void>,
  onAccepted: () => void,
  loadFresh?: () => Promise<AcpConfigOptionDto[] | null | undefined>
): Promise<void> {
  // A selector change reads the runtime before it joins the queue. Let it join first.
  await waitForConfigOptionIdle(conversationId);
  return serializeModelOperation(conversationId, async () => {
    const confirmed = await confirmPendingAelixInitialModel(conversationId, loadFresh);
    await dispatch();
    if (!confirmed) return;
    onAccepted();
    await saveAelixInitialModel(conversationId, null).catch(() => {
      console.error('[Aelix] Failed to retire the first-prompt model');
    });
  });
}
