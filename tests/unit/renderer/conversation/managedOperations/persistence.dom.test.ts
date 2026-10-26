import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  readManagedEnvelope,
  withManagedLock,
  writeManagedEnvelope,
} from '@/renderer/pages/conversation/platforms/acp/managedOperations/persistence';

const envelope = () => ({
  version: 1 as const,
  user_id: 'owner',
  conversation_id: 'conv',
  operation: { schema: 'aelix.operation/1' as const, id: 'request-1', host_store_id: 'a'.repeat(32) },
  request_digest: 'b'.repeat(64),
});

describe('managed request identity persistence', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it('retains only the operation scope and digest', () => {
    writeManagedEnvelope({ ...envelope(), input: 'secret-prompt', token: 'secret-token' } as ReturnType<
      typeof envelope
    >);
    expect(readManagedEnvelope('owner', 'conv')).toEqual(envelope());
    expect(localStorage.getItem(localStorage.key(0)!)).not.toContain('secret');
  });

  it('rejects corrupt identity without resetting the original bytes', () => {
    const key = 'aelix-managed-operation/owner/conv';
    localStorage.setItem(key, '{broken');
    expect(() => readManagedEnvelope('owner', 'conv')).toThrow('OPERATION_STORAGE_UNAVAILABLE');
    expect(localStorage.getItem(key)).toBe('{broken');
  });

  it('rejects a failed durable write before execution can begin', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota');
    });
    expect(() => writeManagedEnvelope(envelope())).toThrow('OPERATION_STORAGE_UNAVAILABLE');
  });

  it('does not share an operation across authenticated users', () => {
    writeManagedEnvelope(envelope());
    expect(readManagedEnvelope('other-owner', 'conv')).toBeUndefined();
  });

  it('requires a browser lock for managed submission', async () => {
    Object.defineProperty(navigator, 'locks', { configurable: true, get: () => undefined });
    const work = vi.fn();
    await expect(withManagedLock('owner', 'conv', true, work)).rejects.toThrow('OPERATION_STORAGE_UNAVAILABLE');
    expect(work).not.toHaveBeenCalled();
  });
});
