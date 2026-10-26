import type { ManagedRequestBinding } from '@/common/types/platform/acpTypes';

export type ManagedEnvelope = ManagedRequestBinding & {
  version: 1;
  user_id: string;
  conversation_id: string;
  admission_rejected?: true;
};
export type ManagedOperationErrorCode =
  | 'OPERATION_UNCERTAIN'
  | 'OPERATION_STORAGE_UNAVAILABLE'
  | 'OPERATION_CONFLICT'
  | 'OPERATION_INTERRUPTED';

export class ManagedOperationError extends Error {
  constructor(readonly code: ManagedOperationErrorCode) {
    super(code);
    this.name = 'ManagedOperationError';
  }
}

const token = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
export const isManagedBinding = (value: unknown): value is ManagedRequestBinding => {
  if (!value || typeof value !== 'object') return false;
  const binding = value as Partial<ManagedRequestBinding>;
  return (
    binding.operation?.schema === 'aelix.operation/1' &&
    token(binding.operation.id) &&
    token(binding.operation.host_store_id) &&
    typeof binding.request_digest === 'string' &&
    /^[a-f0-9]{64}$/.test(binding.request_digest)
  );
};

const storageKey = (user: string, conversation: string): string =>
  `aelix-managed-operation/${encodeURIComponent(user)}/${encodeURIComponent(conversation)}`;

export function readManagedEnvelope(user: string, conversation: string): ManagedEnvelope | undefined {
  try {
    const text = localStorage.getItem(storageKey(user, conversation));
    if (text === null) return undefined;
    if (text.length > 4096) throw new Error();
    const envelope: unknown = JSON.parse(text);
    if (!isManagedBinding(envelope)) throw new Error();
    const record = envelope as Partial<ManagedEnvelope>;
    if (record.version !== 1 || record.user_id !== user || record.conversation_id !== conversation) throw new Error();
    if (record.admission_rejected !== undefined && record.admission_rejected !== true) throw new Error();
    return {
      version: 1,
      user_id: user,
      conversation_id: conversation,
      operation: {
        schema: 'aelix.operation/1',
        id: record.operation!.id,
        host_store_id: record.operation!.host_store_id,
      },
      request_digest: record.request_digest!,
      ...(record.admission_rejected ? { admission_rejected: true } : {}),
    };
  } catch {
    throw new ManagedOperationError('OPERATION_STORAGE_UNAVAILABLE');
  }
}

export function writeManagedEnvelope(envelope: ManagedEnvelope): void {
  try {
    if (!isManagedBinding(envelope)) throw new Error();
    const text = JSON.stringify({
      version: 1,
      user_id: envelope.user_id,
      conversation_id: envelope.conversation_id,
      operation: {
        schema: envelope.operation.schema,
        id: envelope.operation.id,
        host_store_id: envelope.operation.host_store_id,
      },
      request_digest: envelope.request_digest,
      ...(envelope.admission_rejected ? { admission_rejected: true } : {}),
    });
    if (text.length > 4096) throw new Error();
    const key = storageKey(envelope.user_id, envelope.conversation_id);
    localStorage.setItem(key, text);
    if (localStorage.getItem(key) !== text) throw new Error();
  } catch {
    throw new ManagedOperationError('OPERATION_STORAGE_UNAVAILABLE');
  }
}

/** Serialize a conversation across cooperating windows, before storing/sending. */
export async function withManagedLock<T>(
  user: string,
  conversation: string,
  required: boolean,
  work: () => Promise<T>
): Promise<T> {
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
  if (!locks) {
    if (required) throw new ManagedOperationError('OPERATION_STORAGE_UNAVAILABLE');
    return work();
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    return await locks.request(storageKey(user, conversation), { signal: controller.signal }, async () => {
      clearTimeout(timer);
      return work();
    });
  } catch (error) {
    if (controller.signal.aborted) throw new ManagedOperationError('OPERATION_STORAGE_UNAVAILABLE');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
