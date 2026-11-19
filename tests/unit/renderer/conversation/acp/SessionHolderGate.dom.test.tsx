/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
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

const deferred = () => {
  const handlers: { resolve: (value: unknown) => void; reject: (error: unknown) => void } = {
    resolve: () => {},
    reject: () => {},
  };
  const promise = new Promise<unknown>((resolve, reject) => Object.assign(handlers, { resolve, reject }));
  return { promise, ...handlers };
};

const emit = (message: Partial<IResponseMessage>) =>
  act(() => {
    mocks.listeners.forEach((listener) =>
      listener({ msg_id: 'm', conversation_id: 'c1', ...message } as IResponseMessage)
    );
  });

const flush = () => act(async () => {});

const sendBox = (sendBlocked: boolean) => <div data-testid='send-box' data-blocked={String(sendBlocked)} />;

const renderGate = (onWritable = vi.fn()) => {
  const view = render(
    <SessionHolderGate conversationId='c1' onWritable={onWritable}>
      {sendBox}
    </SessionHolderGate>
  );
  return { ...view, onWritable };
};

const statusText = () => screen.getByTestId('session-holder-status').textContent;
const recheckButton = () => screen.getByRole('button', { name: 'conversation.sessionHolder.recheck' });

beforeEach(() => {
  mocks.ensure.mockReset();
  mocks.listeners.clear();
});

describe('SessionHolderGate', () => {
  it('blocks sending until the first check settles, then unblocks a writable session', async () => {
    const first = deferred();
    mocks.ensure.mockReturnValueOnce(first.promise);
    renderGate();
    expect(mocks.ensure).toHaveBeenCalledWith('c1');
    expect(screen.getByTestId('send-box').dataset.blocked).toBe('true');

    await act(async () => first.resolve({}));
    expect(screen.getByTestId('send-box').dataset.blocked).toBe('false');
    expect(screen.queryByTestId('session-holder-bar')).toBeNull();
  });

  it('never unblocks the send box when a delayed first check reports a CLI lock', async () => {
    const first = deferred();
    mocks.ensure.mockReturnValueOnce(first.promise);
    renderGate();
    const status = screen.getByTestId('session-holder-status');
    expect(status.getAttribute('role')).toBe('status');
    expect(status.textContent).toBe('');

    await act(async () => first.reject(lockError('native')));
    expect(screen.queryByTestId('send-box')).toBeNull();
    expect(screen.getByTestId('session-holder-bar').dataset.holderKind).toBe('native');
    expect(screen.getByText('conversation.sessionHolder.native.title')).toBeTruthy();
    expect(screen.getByText('conversation.sessionHolder.readOnly')).toBeTruthy();
    // The status region mounted before the result now carries the announcement.
    expect(screen.getByTestId('session-holder-status')).toBe(status);
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(status.textContent).toBe('conversation.sessionHolder.native.title. conversation.sessionHolder.native.body');
  });

  it('uses neutral wording for an ACP lease holder', async () => {
    mocks.ensure.mockRejectedValue(lockError('acp'));
    renderGate();
    await flush();
    expect(screen.getByTestId('session-holder-bar').dataset.holderKind).toBe('other');
    expect(screen.getByText('conversation.sessionHolder.other.title')).toBeTruthy();
  });

  it('stays writable when the first check fails for a reason other than the lock', async () => {
    mocks.ensure.mockRejectedValue(new Error('spawn failed'));
    renderGate();
    await flush();
    expect(screen.getByTestId('send-box').dataset.blocked).toBe('false');
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
        error: { code: 'USER_AGENT_SESSION_LOCKED', data: { lockedBy: 'native' } },
      },
    });
    expect(screen.getByTestId('session-holder-bar').dataset.holderKind).toBe('native');
  });

  it('reports a session that is still held after a recheck', async () => {
    mocks.ensure.mockRejectedValue(lockError());
    const { onWritable } = renderGate();
    await flush();
    fireEvent.click(recheckButton());
    await flush();
    expect(mocks.ensure).toHaveBeenCalledTimes(2);
    expect(
      within(screen.getByTestId('session-holder-bar')).getByText('conversation.sessionHolder.stillHeld')
    ).toBeTruthy();
    expect(statusText()).toBe('conversation.sessionHolder.stillHeld');
    expect(onWritable).not.toHaveBeenCalled();
  });

  it('stays read-only when a recheck fails without a confirmed result', async () => {
    mocks.ensure.mockRejectedValueOnce(lockError()).mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const { onWritable } = renderGate();
    await flush();
    fireEvent.click(recheckButton());
    await flush();
    expect(screen.queryByTestId('send-box')).toBeNull();
    expect(screen.getByTestId('session-holder-bar').dataset.holderKind).toBe('native');
    expect(
      within(screen.getByTestId('session-holder-bar')).getByText('conversation.sessionHolder.checkFailed')
    ).toBeTruthy();
    expect(statusText()).toBe('conversation.sessionHolder.checkFailed');
    expect(onWritable).not.toHaveBeenCalled();
  });

  it('restores the send box once a recheck finds the session released', async () => {
    mocks.ensure.mockRejectedValueOnce(lockError()).mockResolvedValueOnce({});
    const { onWritable } = renderGate();
    await flush();
    fireEvent.click(recheckButton());
    await flush();
    expect(screen.getByTestId('send-box').dataset.blocked).toBe('false');
    expect(statusText()).toBe('');
    expect(onWritable).toHaveBeenCalledTimes(1);
  });

  it('ignores a lock report that arrives after switching conversations', async () => {
    const first = deferred();
    mocks.ensure.mockReturnValueOnce(first.promise).mockResolvedValueOnce({});
    const { rerender } = renderGate();
    rerender(<SessionHolderGate conversationId='c2'>{sendBox}</SessionHolderGate>);
    await act(async () => first.reject(lockError()));
    expect(screen.getByTestId('send-box').dataset.blocked).toBe('false');
  });
});
