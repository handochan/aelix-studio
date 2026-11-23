/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ExtensionOperation, StudioExtensionsReply } from '@aionui/web-host';
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { currentOwner, resetShownOperation, useOperation } from './operation';

const running: ExtensionOperation = { operationId: 'op-1', action: 'install', phase: 'installing' };
const send = vi.fn(
  async (): Promise<StudioExtensionsReply> =>
    ({ ok: true, data: running, transport: 'secure' }) as unknown as StudioExtensionsReply
);

afterEach(() => {
  resetShownOperation();
});

describe('the change kept for the screen', () => {
  it('takes a started change only for the owner who has the screen', () => {
    const { result, unmount } = renderHook(() => useOperation(send, vi.fn(), 'bob'));
    expect(currentOwner()).toBe('bob');
    // A late answer for the user before: dropped, not kept for when they come back.
    act(() => result.current.start(running, { owner: 'alice', retried: false }));
    expect(result.current.operation).toBeUndefined();
    unmount();
    const alice = renderHook(() => useOperation(send, vi.fn(), 'alice'));
    expect(alice.result.current.operation).toBeUndefined();
    alice.unmount();
    const bob = renderHook(() => useOperation(send, vi.fn(), 'bob'));
    act(() => bob.result.current.start(running, { owner: 'bob', retried: false }));
    expect(bob.result.current.operation).toEqual(running);
    bob.unmount();
  });
});
