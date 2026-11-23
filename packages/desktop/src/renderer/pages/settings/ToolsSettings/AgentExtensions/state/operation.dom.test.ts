/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ExtensionOperation, StudioExtensionsReply, StudioExtensionsRequest } from '@aionui/web-host';
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SendResult } from './channel';
import {
  currentOwner,
  forgetOwners,
  nextChangeRequest,
  resetShownOperation,
  sessionEpoch,
  useOperation,
} from './operation';

const operation = (operationId: string, phase: ExtensionOperation['phase']): ExtensionOperation => ({
  operationId,
  action: 'install',
  phase,
});
const reply = (data: ExtensionOperation): StudioExtensionsReply =>
  ({ ok: true, data, transport: 'secure' }) as unknown as StudioExtensionsReply;
const quiet = vi.fn(async (command: StudioExtensionsRequest): Promise<SendResult> => {
  const id = (command as { operationId?: string }).operationId ?? 'op';
  return reply(operation(id, 'installing'));
});

afterEach(() => {
  resetShownOperation();
});

describe('the change kept for the screen', () => {
  it('takes a started change only for the owner who has the screen', () => {
    const { result, unmount } = renderHook(() => useOperation(quiet, vi.fn(), 'bob'));
    expect(currentOwner()).toBe('bob');
    const epoch = sessionEpoch();
    // A late answer for the user before: dropped, not kept for when they come back.
    act(() =>
      result.current.start(operation('op-1', 'installing'), {
        owner: 'alice',
        epoch,
        request: nextChangeRequest(),
        retried: false,
      })
    );
    expect(result.current.operation).toBeUndefined();
    unmount();
    const alice = renderHook(() => useOperation(quiet, vi.fn(), 'alice'));
    expect(alice.result.current.operation).toBeUndefined();
    alice.unmount();
    const bob = renderHook(() => useOperation(quiet, vi.fn(), 'bob'));
    act(() =>
      bob.result.current.start(operation('op-1', 'installing'), {
        owner: 'bob',
        epoch: sessionEpoch(),
        request: nextChangeRequest(),
        retried: false,
      })
    );
    expect(bob.result.current.operation).toEqual(operation('op-1', 'installing'));
    bob.unmount();
  });

  it('takes no answer sent in an earlier sign-in, even for the same user', () => {
    const { result } = renderHook(() => useOperation(quiet, vi.fn(), 'alice'));
    const before = sessionEpoch();
    // Signed out and in again as the same user: a new sign-in.
    act(() => forgetOwners());
    const again = renderHook(() => useOperation(quiet, vi.fn(), 'alice'));
    act(() =>
      result.current.start(operation('op-1', 'installing'), {
        owner: 'alice',
        epoch: before,
        request: nextChangeRequest(),
        retried: false,
      })
    );
    expect(again.result.current.operation).toBeUndefined();
  });

  it('lets no late cancel answer about an earlier change cover the change shown now', async () => {
    let answerCancel: ((value: SendResult) => void) | undefined;
    const send = vi.fn(async (command: StudioExtensionsRequest): Promise<SendResult> => {
      if (command.action === 'cancel') return new Promise((resolve) => (answerCancel = resolve));
      return reply(operation((command as { operationId: string }).operationId, 'installing'));
    });
    const { result } = renderHook(() => useOperation(send, vi.fn(), 'alice'));
    const started = { owner: 'alice', epoch: sessionEpoch(), request: nextChangeRequest(), retried: false };
    act(() => result.current.start(operation('op-1', 'installing'), started));
    let cancelling: Promise<void> | undefined;
    act(() => {
      cancelling = result.current.cancel();
    });
    // The first change ends (it switched before the cancel arrived), and a second one starts.
    act(() => result.current.start(operation('op-1', 'switched'), started));
    act(() => result.current.dismiss());
    act(() => result.current.start(operation('op-2', 'installing'), started));
    await act(async () => {
      answerCancel?.(reply(operation('op-1', 'cancelled')));
      await cancelling;
    });
    expect(result.current.operation).toEqual(operation('op-2', 'installing'));
  });

  it('lets the start answer of an earlier change request cover no newer change', () => {
    const { result } = renderHook(() => useOperation(quiet, vi.fn(), 'alice'));
    const sender = { owner: 'alice', epoch: sessionEpoch(), retried: false };
    const earlier = nextChangeRequest();
    const newer = nextChangeRequest();
    act(() => result.current.start(operation('op-2', 'installing'), { ...sender, request: newer }));
    // The earlier request's answer arrives last.
    act(() => result.current.start(operation('op-1', 'installing'), { ...sender, request: earlier }));
    expect(result.current.operation).toEqual(operation('op-2', 'installing'));
  });

  it('keeps showing an accepted change when a newer request was refused, and takes its late start', () => {
    const { result } = renderHook(() => useOperation(quiet, vi.fn(), 'alice'));
    const sender = { owner: 'alice', epoch: sessionEpoch(), retried: false };
    const first = nextChangeRequest();
    // A second request was asked for and refused (BUSY): it never started anything.
    nextChangeRequest();
    act(() => result.current.start(operation('op-1', 'installing'), { ...sender, request: first }));
    expect(result.current.operation).toEqual(operation('op-1', 'installing'));
  });
});
