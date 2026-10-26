import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostOperationKey, HostOperationReceipt } from '@/common/types/platform/acpTypes';
import {
  managedRequestDigest,
  recoverManagedMessage,
  sendManagedMessage,
} from '@/renderer/pages/conversation/platforms/acp/managedOperations';
import {
  readManagedEnvelope,
  writeManagedEnvelope,
} from '@/renderer/pages/conversation/platforms/acp/managedOperations/persistence';
import { resetEnsureConversationRuntimeStateForTests } from '@/renderer/pages/conversation/utils/ensureConversationRuntime';

const mocks = vi.hoisted(() => ({ who: vi.fn(), ensure: vi.fn(), send: vi.fn(), status: vi.fn(), get: vi.fn() }));
vi.mock('@/common', () => ({
  ipcBridge: {
    auth: { currentUser: { invoke: mocks.who } },
    conversation: { ensureRuntime: { invoke: mocks.ensure }, get: { invoke: mocks.get } },
    acpConversation: { sendMessage: { invoke: mocks.send }, getOperationStatus: { invoke: mocks.status } },
  },
}));

const params = { conversation_id: 'conv', input: 'private-prompt', files: [] };
const operation: HostOperationKey = { schema: 'aelix.operation/1', id: 'request-1', host_store_id: 'a'.repeat(32) };
const receipt = (state: HostOperationReceipt['state'], key = operation): HostOperationReceipt => ({
  ...key,
  msg_id: 'message-1',
  turn_id: 'turn-1',
  state,
  automatic_retry: false,
  effects_unknown: state !== 'completed',
  replayed: false,
});
const runtime = {
  state: 'idle',
  is_processing: false,
  can_send_message: true,
  has_task: false,
  pending_confirmations: 0,
  turn_id: null,
};

// The browser implementation serializes cooperating windows. Preserve that
// ordering in tests, including a second caller arriving before the first ACK.
function serialLocks(): LockManager {
  const tails = new Map<string, Promise<unknown>>();
  return {
    request: (name: string, _options: unknown, callback: () => Promise<unknown>) => {
      const result = (tails.get(name) ?? Promise.resolve()).then(callback);
      tails.set(
        name,
        result.catch(() => {})
      );
      return result;
    },
  } as unknown as LockManager;
}

async function persistOriginal() {
  writeManagedEnvelope({
    version: 1,
    user_id: 'owner',
    conversation_id: 'conv',
    operation,
    request_digest: await managedRequestDigest(params),
  });
}

describe('managed message recovery', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    localStorage.clear();
    resetEnsureConversationRuntimeStateForTests();
    vi.stubGlobal('crypto', webcrypto);
    Object.defineProperty(navigator, 'locks', { configurable: true, get: () => serialLocks() });
    // Each test needs one shared manager, as in one browser origin.
    const locks = serialLocks();
    vi.spyOn(navigator, 'locks', 'get').mockReturnValue(locks);
    mocks.who.mockResolvedValue({ id: 'owner' });
    mocks.ensure.mockResolvedValue({
      runtime,
      operation_capability: { schema: 'aelix.operation/1', host_store_id: operation.host_store_id },
    });
    mocks.get.mockResolvedValue({ runtime });
    mocks.status.mockResolvedValue(receipt('completed'));
    mocks.send.mockResolvedValue({ msg_id: 'message-1', turn_id: 'turn-1', runtime, operation: receipt('accepted') });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('persists the same key in both stores before the first HTTP submission', async () => {
    const prepared = vi.fn();
    mocks.send.mockImplementation(async (request) => {
      expect(readManagedEnvelope('owner', 'conv')?.operation).toEqual(request.operation);
      expect(prepared).toHaveBeenCalledWith(expect.objectContaining({ operation: request.operation }));
      return { msg_id: 'message-1', turn_id: 'turn-1', runtime, operation: receipt('accepted', request.operation) };
    });
    await sendManagedMessage(params, { id: operation.id, onPrepared: prepared });
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });

  it('coalesces simultaneous retries into one submission and the original IDs', async () => {
    const options = { id: operation.id };
    const results = await Promise.all([sendManagedMessage(params, options), sendManagedMessage(params, options)]);
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(results.map((result) => result.msg_id)).toEqual(['message-1', 'message-1']);
  });

  it('recovers an ACK lost after execution without submitting a second prompt', async () => {
    mocks.send.mockRejectedValue(new Error('network lost with secret transport details'));
    const result = await sendManagedMessage(params, { id: operation.id });
    expect(result.operation).toMatchObject({ state: 'completed', replayed: true });
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(localStorage.key(0)!)).not.toContain('private-prompt');
  });

  it('rejects a changed body for an already bound key', async () => {
    await persistOriginal();
    await expect(sendManagedMessage({ ...params, input: 'different' }, { id: operation.id })).rejects.toThrow(
      'OPERATION_CONFLICT'
    );
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('does not replace a missing original namespace or automatically resend not_found', async () => {
    await persistOriginal();
    mocks.status.mockResolvedValue(receipt('not_found'));
    await expect(sendManagedMessage(params, { id: operation.id })).rejects.toThrow('OPERATION_UNCERTAIN');
    expect(mocks.ensure).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('permits only an explicit retry of the exact unadmitted key', async () => {
    await persistOriginal();
    mocks.status.mockResolvedValue(receipt('not_found'));
    await sendManagedMessage(params, { id: operation.id, manual: true });
    expect(mocks.send).toHaveBeenCalledWith({ ...params, operation });
  });

  it('does not let a failed queue persistence callback reach HTTP', async () => {
    await expect(
      sendManagedMessage(params, {
        id: operation.id,
        onPrepared: () => {
          throw new Error('queue storage failed');
        },
      })
    ).rejects.toThrow('queue storage failed');
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('recovery is status-only and never warms or submits a worker', async () => {
    await persistOriginal();
    await recoverManagedMessage('conv');
    expect(mocks.status).toHaveBeenCalledWith({ conversation_id: 'conv', operation });
    expect(mocks.ensure).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('rejects a receipt with a different original operation scope', async () => {
    await persistOriginal();
    mocks.status.mockResolvedValue({ ...receipt('completed'), host_store_id: 'c'.repeat(32) });
    await expect(recoverManagedMessage('conv')).rejects.toThrow('OPERATION_UNCERTAIN');
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("does not replace another window's pending recovery key with an old queue retry", async () => {
    await persistOriginal();
    const old = { ...operation, id: 'older-queue-request' };
    const binding = { operation: old, request_digest: await managedRequestDigest(params) };
    mocks.status.mockImplementation(async ({ operation: key }) =>
      receipt(key.id === operation.id ? 'pending' : 'not_found', key)
    );
    await expect(sendManagedMessage(params, { binding, manual: true })).rejects.toThrow('OPERATION_UNCERTAIN');
    expect(readManagedEnvelope('owner', 'conv')?.operation).toEqual(operation);
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('preserves legacy unkeyed sends without requiring browser crypto or locks', async () => {
    mocks.ensure.mockResolvedValue({ runtime });
    vi.stubGlobal('crypto', undefined);
    vi.spyOn(navigator, 'locks', 'get').mockReturnValue(undefined as unknown as LockManager);
    await sendManagedMessage(params);
    expect(mocks.send).toHaveBeenCalledWith(params);
  });

  it('clears the definite busy marker before a retry whose response is lost', async () => {
    mocks.status.mockResolvedValue(receipt('not_found'));
    mocks.send.mockRejectedValueOnce({ code: 'CONFLICT' }).mockRejectedValueOnce(new Error('network lost'));
    await expect(sendManagedMessage(params, { id: operation.id })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(readManagedEnvelope('owner', 'conv')?.admission_rejected).toBe(true);
    await expect(sendManagedMessage(params, { id: operation.id })).rejects.toThrow('OPERATION_UNCERTAIN');
    expect(readManagedEnvelope('owner', 'conv')?.admission_rejected).toBeUndefined();
  });
});
