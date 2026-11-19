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
import { resetSessionHolderMemoryForTests } from '@/renderer/pages/conversation/platforms/acp/SessionHolder/useSessionHolder';

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

const sendBox = (sendBlocked: boolean) => (
  <textarea data-testid='send-box' data-blocked={String(sendBlocked)} disabled={sendBlocked} />
);

const renderGate = (onWritable = vi.fn()) => {
  const view = render(
    <SessionHolderGate conversationId='c1' onWritable={onWritable}>
      {sendBox}
    </SessionHolderGate>
  );
  return { ...view, onWritable };
};

const statusText = () => screen.getByTestId('session-holder-status').textContent;
/** While held, the send box stays mounted (so its Draft Box never detaches) but is hidden and blocked. */
const expectHeldSendBox = () => {
  expect(screen.getByTestId('session-holder-send-box').className).toBe('hidden');
  expect(screen.getByTestId('send-box').dataset.blocked).toBe('true');
};
const recheckButton = () => screen.getByRole('button', { name: 'conversation.sessionHolder.recheck' });

beforeEach(() => {
  mocks.ensure.mockReset();
  mocks.listeners.clear();
  resetSessionHolderMemoryForTests();
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
    expectHeldSendBox();
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

  it('keeps sending blocked when the first check fails without a lock result', async () => {
    mocks.ensure.mockRejectedValueOnce(new Error('spawn failed')).mockResolvedValueOnce({});
    const { onWritable } = renderGate();
    await flush();
    expect(screen.getByTestId('session-holder-bar').dataset.holderKind).toBe('unconfirmed');
    expect(within(screen.getByTestId('session-holder-bar')).getByText('spawn failed')).toBeTruthy();
    expect(statusText()).toBe(
      'conversation.sessionHolder.unconfirmed.title. conversation.sessionHolder.unconfirmed.body'
    );
    expectHeldSendBox();

    fireEvent.click(recheckButton());
    await flush();
    expect(screen.getByTestId('send-box').dataset.blocked).toBe('false');
    expect(onWritable).toHaveBeenCalledTimes(1);
  });

  it('shows the existing login guidance while blocked when the agent needs authentication', async () => {
    mocks.ensure.mockRejectedValueOnce(
      new BackendHttpError({
        method: 'POST',
        path: '/api/conversations/c1/runtime/ensure',
        status: 502,
        body: {
          code: 'USER_AGENT_AUTH_REQUIRED',
          error: 'auth required',
          details: {
            message: 'auth required',
            code: 'USER_AGENT_AUTH_REQUIRED',
            resolution: { kind: 'check_agent_login' },
          },
        },
      })
    );
    renderGate();
    await flush();
    const bar = within(screen.getByTestId('session-holder-bar'));
    expect(screen.getByTestId('session-holder-bar').dataset.holderKind).toBe('agent');
    expect(bar.getByText('conversation.agentError.codes.USER_AGENT_AUTH_REQUIRED.title')).toBeTruthy();
    expect(bar.getByText('conversation.agentError.codes.USER_AGENT_AUTH_REQUIRED.body')).toBeTruthy();
    expect(
      bar.getByText('conversation.agentError.resolutionPrefixconversation.agentError.resolution.check_agent_login')
    ).toBeTruthy();
    expect(bar.getByText('conversation.sessionHolder.paused')).toBeTruthy();
    expect(bar.queryByText('conversation.sessionHolder.unconfirmed.title')).toBeNull();
    expect(statusText()).toContain('conversation.agentError.codes.USER_AGENT_AUTH_REQUIRED.title');
    expectHeldSendBox();
  });

  it('suggests agent login and installation when the agent fails to start without details', async () => {
    mocks.ensure.mockRejectedValueOnce(
      new BackendHttpError({
        method: 'POST',
        path: '/api/conversations/c1/runtime/ensure',
        status: 502,
        body: { code: 'BAD_GATEWAY', error: 'Upstream service unavailable.' },
      })
    );
    renderGate();
    await flush();
    const bar = within(screen.getByTestId('session-holder-bar'));
    expect(bar.getByText('conversation.sessionHolder.unconfirmed.title')).toBeTruthy();
    expect(
      bar.getByText('conversation.agentError.resolutionPrefixconversation.agentError.resolution.check_agent_login')
    ).toBeTruthy();
    expect(
      bar.getByText(
        'conversation.agentError.resolutionPrefixconversation.agentError.resolution.check_agent_installation'
      )
    ).toBeTruthy();
    expect(bar.getByText('Upstream service unavailable.')).toBeTruthy();
    expectHeldSendBox();
  });

  it('stays read-only when returning to a locked conversation and the check fails to connect', async () => {
    mocks.ensure.mockRejectedValueOnce(lockError('native'));
    const first = renderGate();
    await flush();
    expect(screen.getByTestId('session-holder-bar').dataset.holderKind).toBe('native');
    first.unmount();

    // Return while the CLI still holds the lock; the check on return cannot connect.
    const onReturn = deferred();
    mocks.ensure.mockReturnValueOnce(onReturn.promise).mockResolvedValueOnce({});
    const { onWritable } = renderGate();
    expect(screen.getByTestId('session-holder-bar').dataset.holderKind).toBe('native');
    expectHeldSendBox();
    await act(async () => onReturn.reject(new TypeError('Failed to fetch')));
    expect(screen.getByTestId('session-holder-bar').dataset.holderKind).toBe('native');
    expect(
      within(screen.getByTestId('session-holder-bar')).getByText('conversation.sessionHolder.checkFailed')
    ).toBeTruthy();
    expectHeldSendBox();
    expect(onWritable).not.toHaveBeenCalled();

    // Only a confirmed lock-free recheck unblocks sending.
    fireEvent.click(recheckButton());
    await flush();
    expect(screen.getByTestId('session-holder-send-box').className).toBe('contents');
    expect(screen.getByTestId('send-box').dataset.blocked).toBe('false');
    expect(onWritable).toHaveBeenCalledTimes(1);
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
    expectHeldSendBox();
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
    expectHeldSendBox();
    expect(screen.getByTestId('session-holder-bar').dataset.holderKind).toBe('native');
    expect(
      within(screen.getByTestId('session-holder-bar')).getByText('conversation.sessionHolder.checkFailed')
    ).toBeTruthy();
    expect(statusText()).toBe(
      'conversation.sessionHolder.native.title. conversation.sessionHolder.native.body conversation.sessionHolder.checkFailed'
    );
    expect(onWritable).not.toHaveBeenCalled();
  });

  it('restores the send box once a recheck finds the session released', async () => {
    mocks.ensure.mockRejectedValueOnce(lockError()).mockResolvedValueOnce({});
    const { onWritable } = renderGate();
    await flush();
    fireEvent.click(recheckButton());
    await flush();
    expect(screen.getByTestId('send-box').dataset.blocked).toBe('false');
    expect(screen.getByTestId('session-holder-send-box').className).toBe('contents');
    expect(document.activeElement).toBe(screen.getByTestId('send-box'));
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
