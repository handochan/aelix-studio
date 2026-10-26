import { ipcBridge } from '@/common';
import type { ISendMessageParams, ISendMessageResult } from '@/common/adapter/ipcBridge';
import type { HostOperationKey, HostOperationReceipt, ManagedRequestBinding } from '@/common/types/platform/acpTypes';
import { uuid } from '@/common/utils';
import type { TFunction } from 'i18next';
import { ensureConversationRuntime } from '../../../utils/ensureConversationRuntime';
import {
  isManagedBinding,
  ManagedOperationError,
  readManagedEnvelope,
  withManagedLock,
  writeManagedEnvelope,
} from './persistence';

export { isManagedBinding, ManagedOperationError } from './persistence';

type SendOptions = {
  id?: string;
  binding?: ManagedRequestBinding;
  /** Only a new explicit user action may retry an unadmitted SAME key. */
  manual?: boolean;
  reuseUnadmitted?: boolean;
  onPrepared?: (binding: ManagedRequestBinding) => void | Promise<void>;
  onLegacy?: () => void;
};

const terminal = (state: HostOperationReceipt['state']): boolean =>
  ['completed', 'cancelled', 'cancelled_before_dispatch', 'failed', 'interrupted'].includes(state);
const deadline = async <T>(promise: Promise<T>, ms = 15_000): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ManagedOperationError('OPERATION_UNCERTAIN')), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

export async function managedRequestDigest(params: ISendMessageParams): Promise<string> {
  const bytes = new TextEncoder().encode(
    JSON.stringify([params.input, params.files ?? [], params.sessions ?? [], params.inject_skills ?? [], false])
  );
  if (bytes.length > 256 * 1024 || !globalThis.crypto?.subtle)
    throw new ManagedOperationError('OPERATION_STORAGE_UNAVAILABLE');
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (value) =>
    value.toString(16).padStart(2, '0')
  ).join('');
}

function checkedReceipt(value: HostOperationReceipt, operation: HostOperationKey): HostOperationReceipt {
  const states: HostOperationReceipt['state'][] = [
    'accepted',
    'pending',
    'recovery_waiting',
    'completed',
    'cancelled',
    'cancelled_before_dispatch',
    'failed',
    'interrupted',
    'not_found',
  ];
  const token = (text: string): boolean => typeof text === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(text);
  if (
    value.schema !== operation.schema ||
    value.id !== operation.id ||
    value.host_store_id !== operation.host_store_id ||
    !states.includes(value.state) ||
    value.automatic_retry !== false ||
    value.effects_unknown !== (value.state !== 'completed') ||
    (value.state !== 'not_found' && (!token(value.msg_id) || !token(value.turn_id)))
  )
    throw new ManagedOperationError('OPERATION_UNCERTAIN');
  return {
    schema: operation.schema,
    id: operation.id,
    host_store_id: operation.host_store_id,
    msg_id: value.msg_id,
    turn_id: value.turn_id,
    state: value.state,
    effects_unknown: value.effects_unknown,
    automatic_retry: false,
    replayed: value.replayed === true,
  };
}

async function status(conversation: string, operation: HostOperationKey): Promise<HostOperationReceipt> {
  try {
    return checkedReceipt(
      await deadline(ipcBridge.acpConversation.getOperationStatus.invoke({ conversation_id: conversation, operation })),
      operation
    );
  } catch {
    throw new ManagedOperationError('OPERATION_UNCERTAIN');
  }
}

async function recoveredResult(conversation: string, receipt: HostOperationReceipt): Promise<ISendMessageResult> {
  if (receipt.state === 'failed' || receipt.state === 'interrupted')
    throw new ManagedOperationError('OPERATION_INTERRUPTED');
  if (receipt.state === 'not_found' || receipt.state === 'recovery_waiting')
    throw new ManagedOperationError('OPERATION_UNCERTAIN');
  const view = await deadline(ipcBridge.conversation.get.invoke({ id: conversation }));
  if (!view.runtime) throw new ManagedOperationError('OPERATION_UNCERTAIN');
  return {
    msg_id: receipt.msg_id,
    turn_id: receipt.turn_id,
    runtime: view.runtime,
    operation: { ...receipt, replayed: true },
  };
}

/** Persist one identity before HTTP; lookup never performs runtime/ensure. */
export async function sendManagedMessage(
  params: ISendMessageParams,
  options: SendOptions = {}
): Promise<ISendMessageResult> {
  const user = await deadline(ipcBridge.auth.currentUser.invoke());
  const initial = readManagedEnvelope(user.id, params.conversation_id);
  // A persisted key always wins over a new capability/namespace or resume anchor.
  let capability =
    options.binding || initial
      ? undefined
      : (await ensureConversationRuntime(params.conversation_id)).operation_capability;
  if (!options.binding && !initial && !capability) {
    options.onLegacy?.();
    return ipcBridge.acpConversation.sendMessage.invoke(params);
  }
  const digest = await managedRequestDigest(params);
  if (options.binding && (!isManagedBinding(options.binding) || options.binding.request_digest !== digest))
    throw new ManagedOperationError('OPERATION_CONFLICT');
  return withManagedLock(
    user.id,
    params.conversation_id,
    Boolean(options.binding || initial || capability),
    async () => {
      const existing = readManagedEnvelope(user.id, params.conversation_id);
      let binding = options.binding;
      let receipt: HostOperationReceipt | undefined;
      if (existing && binding && existing.operation.id !== binding.operation.id) {
        // A queued retry can coexist with another window's ordinary submission.
        // Reconcile its own original key without deleting that window's recovery
        // identity; only a terminal existing record may be replaced by admission.
        const active = await status(params.conversation_id, existing.operation);
        receipt = await status(params.conversation_id, binding.operation);
        if (receipt.state !== 'not_found') return recoveredResult(params.conversation_id, receipt);
        if (!terminal(active.state)) throw new ManagedOperationError('OPERATION_UNCERTAIN');
      }
      if (existing && (!binding || existing.operation.id === binding.operation.id)) {
        if (binding && existing.operation.host_store_id !== binding.operation.host_store_id)
          throw new ManagedOperationError('OPERATION_UNCERTAIN');
        receipt = await status(params.conversation_id, existing.operation);
        const same =
          Boolean(binding) ||
          (options.id ? options.id === existing.operation.id : existing.request_digest === digest) ||
          (options.manual &&
            options.reuseUnadmitted &&
            receipt.state === 'not_found' &&
            existing.request_digest === digest);
        if (same) {
          if (existing.request_digest !== digest) throw new ManagedOperationError('OPERATION_CONFLICT');
          binding = existing;
        } else if (!terminal(receipt.state) || (!options.manual && receipt.state !== 'completed')) {
          throw new ManagedOperationError('OPERATION_UNCERTAIN');
        } else {
          capability = (await ensureConversationRuntime(params.conversation_id)).operation_capability;
          if (!capability) throw new ManagedOperationError('OPERATION_UNCERTAIN');
        }
      }
      if (binding) {
        if (
          !receipt ||
          receipt.id !== binding.operation.id ||
          receipt.host_store_id !== binding.operation.host_store_id
        )
          receipt = await status(params.conversation_id, binding.operation);
        if (receipt.state !== 'not_found') return recoveredResult(params.conversation_id, receipt);
        if (!options.manual && !(existing?.admission_rejected && existing.operation.id === binding.operation.id))
          throw new ManagedOperationError('OPERATION_UNCERTAIN');
      } else if (capability) {
        if (capability.schema !== 'aelix.operation/1' || !/^[a-f0-9]{32}$/.test(capability.host_store_id))
          throw new ManagedOperationError('OPERATION_UNCERTAIN');
        binding = {
          operation: {
            schema: 'aelix.operation/1',
            id: options.id ?? `ui-${uuid(36)}`,
            host_store_id: capability.host_store_id,
          },
          request_digest: digest,
        };
      } else {
        if (existing) throw new ManagedOperationError('OPERATION_UNCERTAIN');
        options.onLegacy?.();
        return ipcBridge.acpConversation.sendMessage.invoke(params);
      }
      // Persist only this attempt's immutable binding. In particular, a previous
      // definite busy rejection must not survive an ambiguous response this time.
      binding = {
        operation: {
          schema: binding.operation.schema,
          id: binding.operation.id,
          host_store_id: binding.operation.host_store_id,
        },
        request_digest: binding.request_digest,
      };
      writeManagedEnvelope({ version: 1, user_id: user.id, conversation_id: params.conversation_id, ...binding });
      await options.onPrepared?.(binding);
      try {
        const result = await deadline(
          ipcBridge.acpConversation.sendMessage.invoke({ ...params, operation: binding.operation })
        );
        if (!result.operation) throw new ManagedOperationError('OPERATION_UNCERTAIN');
        checkedReceipt(result.operation, binding.operation);
        return result;
      } catch (error) {
        if ((error as { code?: unknown })?.code === 'OPERATION_CONFLICT')
          throw new ManagedOperationError('OPERATION_CONFLICT');
        const observed = await status(params.conversation_id, binding.operation);
        const code = (error as { code?: unknown })?.code;
        if (observed.state === 'not_found' && (code === 'CONFLICT' || code === 'runtime_restarting')) {
          writeManagedEnvelope({
            version: 1,
            user_id: user.id,
            conversation_id: params.conversation_id,
            ...binding,
            admission_rejected: true,
          });
          throw error; // Definite pre-admission busy, still the SAME key on retry.
        }
        return recoveredResult(params.conversation_id, observed);
      }
    }
  );
}

/** Resume UI observation after remount; never submits or opens a native worker. */
export async function recoverManagedMessage(conversation: string): Promise<ISendMessageResult | undefined> {
  const user = await deadline(ipcBridge.auth.currentUser.invoke());
  const envelope = readManagedEnvelope(user.id, conversation);
  if (!envelope) return undefined;
  return recoveredResult(conversation, await status(conversation, envelope.operation));
}

export function hasManagedRecovery(conversation: string): boolean {
  try {
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (key?.startsWith('aelix-managed-operation/') && key.endsWith(`/${encodeURIComponent(conversation)}`))
        return true;
    }
  } catch {
    /* Submission still fails closed if persistent identity cannot be read. */
  }
  return false;
}

export function getManagedOperationErrorMessage(error: unknown, t: TFunction): string | undefined {
  const code = (error as { code?: unknown })?.code;
  if (code === 'OPERATION_UNCERTAIN') return t('conversation.managedOperation.uncertain');
  if (code === 'OPERATION_STORAGE_UNAVAILABLE') return t('conversation.managedOperation.storageUnavailable');
  if (code === 'OPERATION_CONFLICT') return t('conversation.managedOperation.conflict');
  if (code === 'OPERATION_INTERRUPTED') return t('conversation.managedOperation.interrupted');
  return undefined;
}
