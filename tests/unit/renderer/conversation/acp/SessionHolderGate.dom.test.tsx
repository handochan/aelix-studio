/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IResponseMessage } from '@/common/adapter/ipcBridge';

const mocks = vi.hoisted(() => ({
  ensure: vi.fn<(conversationId: string) => Promise<unknown>>(),
  listeners: new Set<(message: IResponseMessage) => void>(),
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    acpConversation: {
      responseStream: {
        on: (listener: (message: IResponseMessage) => void) => {
          mocks.listeners.add(listener);
          return () => mocks.listeners.delete(listener);
        },
      },
    },
  },
}));

vi.mock('@/renderer/pages/conversation/utils/ensureConversationRuntime', () => ({
  ensureConversationRuntime: (conversationId: string) => mocks.ensure(conversationId),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { BackendHttpError } from '@/common/adapter/httpBridge';
import SessionHolderGate from '@/renderer/pages/conversation/platforms/acp/SessionHolder';

const lockError = (lockedBy = 'native') =>
  new BackendHttpError({
    method: 'POST',
    path: '/api/conversations/c1/runtime/ensure',
    status: 502,
    body: {
      code: 'USER_AGENT_SESSION_LOCKED',
      error: 'locked',
      details: { protocol_code: -33001, retryable: false, data: { kind: 'session_locked', lockedBy, holder: null } },
    },
  });

const emit = (message: Partial<IResponseMessage>) =>
  act(() => {
    mocks.listeners.forEach((listener) =>
      listener({ msg_id: 'm', conversation_id: 'c1', ...message } as IResponseMessage)
    );
  });

const flush = () => act(async () => {});

const renderGate = (onWritable = vi.fn()) => {
  const view = render(
    <SessionHolderGate conversationId='c1' onWritable={onWritable}>
      <div data-testid='send-box' />
    </SessionHolderGate>
  );
  return { ...view, onWritable };
};

beforeEach(() => {
  mocks.ensure.mockReset();
  mocks.listeners.clear();
});

describe('SessionHolderGate', () => {
  it('keeps the send box when the runtime opens normally', async () => {
    mocks.ensure.mockResolvedValue({});
    renderGate();
    await flush();
    expect(mocks.ensure).toHaveBeenCalledWith('c1');
    expect(screen.getByTestId('send-box')).toBeTruthy();
    expect(screen.queryByTestId('session-holder-bar')).toBeNull();
  });

  it('replaces the send box with the CLI holder notice when the host reports a native lock', async () => {
    mocks.ensure.mockRejectedValue(lockError('native'));
    renderGate();
    await flush();
    const bar = screen.getByTestId('session-holder-bar');
    expect(bar.getAttribute('data-holder-kind')).toBe('native');
    expect(bar.getAttribute('role')).toBe('status');
    expect(screen.getByText('conversation.sessionHolder.native.title')).toBeTruthy();
    expect(screen.getByText('conversation.sessionHolder.readOnly')).toBeTruthy();
    expect(screen.queryByTestId('send-box')).toBeNull();
  });

  it('stays writable when the runtime fails for a reason other than the lock', async () => {
    mocks.ensure.mockRejectedValue(new Error('spawn failed'));
    renderGate();
    await flush();
    expect(screen.getByTestId('send-box')).toBeTruthy();
  });

  it('becomes read-only when a send reports the lock on the stream', async () => {
    mocks.ensure.mockResolvedValue({});
    renderGate();
    await flush();
    emit({
      type: 'tips',
      conversation_id: 'other',
      data: { type: 'error', error: { code: 'USER_AGENT_SESSION_LOCKED' } },
    });
    expect(screen.getByTestId('send-box')).toBeTruthy();
    emit({
      type: 'tips',
      data: {
        type: 'error',
        content: 'locked',
        error: { code: 'USER_AGENT_SESSION_LOCKED', data: { lockedBy: 'acp' } },
      },
    });
    expect(screen.getByTestId('session-holder-bar').getAttribute('data-holder-kind')).toBe('acp');
  });

  it('reports a session that is still held after a recheck', async () => {
    mocks.ensure.mockRejectedValue(lockError());
    const { onWritable } = renderGate();
    await flush();
    fireEvent.click(screen.getByText('conversation.sessionHolder.recheck'));
    await flush();
    expect(mocks.ensure).toHaveBeenCalledTimes(2);
    expect(screen.getByText('conversation.sessionHolder.stillHeld')).toBeTruthy();
    expect(onWritable).not.toHaveBeenCalled();
  });

  it('restores the send box once a recheck finds the session released', async () => {
    mocks.ensure.mockRejectedValueOnce(lockError()).mockResolvedValueOnce({});
    const { onWritable } = renderGate();
    await flush();
    fireEvent.click(screen.getByText('conversation.sessionHolder.recheck'));
    await flush();
    expect(screen.getByTestId('send-box')).toBeTruthy();
    expect(onWritable).toHaveBeenCalledTimes(1);
  });

  it('ignores a lock report that arrives after switching conversations', async () => {
    let rejectFirst: ((error: unknown) => void) | undefined;
    mocks.ensure.mockImplementationOnce(() => new Promise((_resolve, reject) => (rejectFirst = reject)));
    mocks.ensure.mockResolvedValueOnce({});
    const { rerender } = renderGate();
    rerender(
      <SessionHolderGate conversationId='c2'>
        <div data-testid='send-box' />
      </SessionHolderGate>
    );
    await act(async () => rejectFirst?.(lockError()));
    expect(screen.getByTestId('send-box')).toBeTruthy();
  });
});
