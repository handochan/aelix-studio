import { ipcBridge } from '@/common';
import type { AcpConfigOptionDto, SetConfigOptionResponse } from '@/common/types/platform/acpTypes';
import {
  deriveSelectOption,
  findConfigOption,
  getOptionCurrentValue,
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
// Switches the host failed or timed out on that may still land. The next prompt adopts
// one only if the live runtime then reports it.
const unconfirmedModelChoices = new Map<string, { optionId: string; value: string }>();

type ConfigOptionsLoad = () => Promise<AcpConfigOptionDto[] | null | undefined>;

const freshRuntimeOptions =
  (conversationId: string): ConfigOptionsLoad =>
  async () =>
    (await ensureConversationRuntime(conversationId, { fresh: true })).config_options;

/** Whether the runtime now reports `value` for the model option `optionId`. */
function reportsModel(options: AcpConfigOptionDto[] | null | undefined, optionId: string, value: string): boolean {
  const model = findConfigOption(options, 'model', ['model']);
  return model?.id === optionId && getOptionCurrentValue(model) === value;
}

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
  loadFresh: ConfigOptionsLoad = freshRuntimeOptions(conversationId)
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
  loadFresh: ConfigOptionsLoad = freshRuntimeOptions(conversationId)
): Promise<boolean> {
  const unconfirmed = unconfirmedModelChoices.get(conversationId);
  unconfirmedModelChoices.delete(conversationId);
  let modelId: string | undefined;
  let options: AcpConfigOptionDto[] | null | undefined;
  try {
    const unsavedChoice = unsavedModelChoices.get(conversationId);
    if (unsavedChoice) await persistModelChoice(conversationId, unsavedChoice);
    modelId = await loadAelixInitialModel(conversationId);
    if (modelId && unconfirmed) {
      // A switch reported as failed landed late: the header shows it, so it is the choice.
      options = await loadFresh();
      if (reportsModel(options, unconfirmed.optionId, unconfirmed.value)) {
        await persistModelChoice(conversationId, unconfirmed.value);
        modelId = unconfirmed.value;
      }
    }
  } catch (error) {
    throw new AelixInitialModelUnconfirmed('Could not read the selected Aelix model', { cause: error });
  }
  if (!modelId) return false;
  const current = options;
  await confirmAelixInitialModel(conversationId, modelId, current ? async () => current : loadFresh);
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

/** Retarget an outstanding first-prompt choice; the queue keeps it from retiring meanwhile. */
async function retargetPendingChoice(conversationId: string, model: string): Promise<void> {
  if (await loadAelixInitialModel(conversationId)) await persistModelChoice(conversationId, model);
}

/**
 * A host error can follow a model switch that already landed (a failing native model
 * hook) or that lands later (a confirmation timeout). Record what the runtime reports.
 */
async function recordSwitchAfterError(
  conversationId: string,
  optionId: string,
  value: string,
  loadFresh: ConfigOptionsLoad
): Promise<void> {
  try {
    if (!(await loadAelixInitialModel(conversationId))) return;
    if (reportsModel(await loadFresh(), optionId, value)) {
      await persistModelChoice(conversationId, value);
    } else {
      unconfirmedModelChoices.set(conversationId, { optionId, value });
    }
  } catch {
    // The selector reports the original error; Send rechecks the live runtime.
  }
}

/** Apply a selector change and record an observed first-prompt model choice. */
export function setAelixInitialModelConfigOption(
  conversation_id: string,
  option_id: string,
  value: string,
  loadFresh: ConfigOptionsLoad = freshRuntimeOptions(conversation_id)
): Promise<SetConfigOptionResponse> {
  return serializeModelOperation(conversation_id, async () => {
    let response: SetConfigOptionResponse;
    try {
      response = await ipcBridge.acpConversation.setConfigOption.invoke({ conversation_id, option_id, value });
    } catch (error) {
      await recordSwitchAfterError(conversation_id, option_id, value, loadFresh);
      throw error;
    }
    if (
      hasObservedValue(response, option_id, value) &&
      findConfigOption(response.config_options, 'model', ['model'])?.id === option_id
    ) {
      unconfirmedModelChoices.delete(conversation_id);
      await retargetPendingChoice(conversation_id, value);
    }
    return response;
  });
}

/** Hold the selector behind model confirmation, prompt admission, and metadata retirement. */
export async function submitAelixInitialPrompt(
  conversationId: string,
  dispatch: () => Promise<void>,
  onAccepted: () => void,
  loadFresh?: ConfigOptionsLoad
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
