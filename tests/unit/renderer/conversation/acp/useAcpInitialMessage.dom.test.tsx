/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BackendHttpError } from '@/common/adapter/httpBridge';
import { useAcpInitialMessage } from '@/renderer/pages/conversation/platforms/acp/useAcpInitialMessage';
import { AelixInitialModelUnconfirmed } from '@/renderer/services/runtime/aelixInitialModel';

const { sendMessageInvokeMock, emitterEmitMock } = vi.hoisted(() => ({
  sendMessageInvokeMock: vi.fn(),
  emitterEmitMock: vi.fn(),
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    acpConversation: {
      sendMessage: {
        invoke: sendMessageInvokeMock,
      },
    },
  },
}));

vi.mock('@/renderer/utils/emitter', () => ({
  emitter: {
    emit: emitterEmitMock,
  },
}));

vi.mock('@/renderer/utils/file/messageFiles', () => ({
  buildDisplayMessage: (input: string) => input,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? _key,
  }),
}));

describe('useAcpInitialMessage', () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.clearAllMocks();
  });

  it('sends nothing when the first-prompt model check rejects', async () => {
    sessionStorage.setItem('acp_initial_message_conv-1', JSON.stringify({ input: 'hello', files: [] }));
    const addOrUpdateMessage = vi.fn();
    const prepareInitialModel = vi.fn().mockRejectedValue(new AelixInitialModelUnconfirmed());
    renderHook(() =>
      useAcpInitialMessage({
        conversation_id: 'conv-1',
        backend: 'aelix',
        prepareInitialModel,
        setAiProcessing: vi.fn(),
        resetState: vi.fn(),
        checkAndUpdateTitle: vi.fn(),
        addOrUpdateMessage,
      })
    );
    await waitFor(() =>
      expect(addOrUpdateMessage).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.objectContaining({ content: 'agent.model.switchFailed' }) }),
        true
      )
    );
    expect(sendMessageInvokeMock).not.toHaveBeenCalled();
  });

  it('suppresses tips and reset when initial ACP send hits active-turn busy', async () => {
    sessionStorage.setItem('acp_initial_message_conv-1', JSON.stringify({ input: 'hello', files: [] }));
    sendMessageInvokeMock.mockRejectedValue(
      new BackendHttpError({
        method: 'POST',
        path: '/api/conversations/conv-1/messages',
        status: 409,
        body: { success: false, code: 'CONFLICT', error: 'conversation conv-1 is already running' },
      })
    );

    const markSendFailed = vi.fn();
    const addOrUpdateMessage = vi.fn();
    const resetState = vi.fn();
    const setAiProcessing = vi.fn();

    renderHook(() =>
      useAcpInitialMessage({
        conversation_id: 'conv-1',
        backend: 'codex',
        workspacePath: '/tmp/workspace',
        setAiProcessing,
        resetState,
        markSendStarted: vi.fn(),
        markSendAccepted: vi.fn(),
        markSendFailed,
        checkAndUpdateTitle: vi.fn(),
        addOrUpdateMessage,
      })
    );

    await waitFor(() => expect(sendMessageInvokeMock).toHaveBeenCalledTimes(1));
    expect(markSendFailed).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'busy_conflict', busyKind: 'active_turn' })
    );
    expect(addOrUpdateMessage).not.toHaveBeenCalled();
    expect(resetState).not.toHaveBeenCalled();
    expect(setAiProcessing).not.toHaveBeenCalledWith(false);
  });

  it('holds the stored first message while sending is blocked and sends it once unblocked', async () => {
    sessionStorage.setItem('acp_initial_message_conv-1', JSON.stringify({ input: 'hello', files: [] }));
    sendMessageInvokeMock.mockResolvedValue({ turn_id: 't1', runtime: {}, msg_id: 'm1' });
    const params = {
      conversation_id: 'conv-1',
      backend: 'codex',
      setAiProcessing: vi.fn(),
      resetState: vi.fn(),
      checkAndUpdateTitle: vi.fn(),
      addOrUpdateMessage: vi.fn(),
    };

    const { rerender } = renderHook(({ blocked }) => useAcpInitialMessage({ ...params, blocked }), {
      initialProps: { blocked: true },
    });
    await Promise.resolve();
    expect(sendMessageInvokeMock).not.toHaveBeenCalled();
    expect(sessionStorage.getItem('acp_initial_message_conv-1')).not.toBeNull();

    rerender({ blocked: false });
    await waitFor(() => expect(sendMessageInvokeMock).toHaveBeenCalledTimes(1));
    expect(sessionStorage.getItem('acp_initial_message_conv-1')).toBeNull();
  });

  it('keeps ordinary initial ACP send failures visible and resets loading state', async () => {
    sessionStorage.setItem('acp_initial_message_conv-1', JSON.stringify({ input: 'hello', files: [] }));
    sendMessageInvokeMock.mockRejectedValue(new Error('boom'));

    const markSendFailed = vi.fn();
    const addOrUpdateMessage = vi.fn();
    const resetState = vi.fn();
    const setAiProcessing = vi.fn();

    renderHook(() =>
      useAcpInitialMessage({
        conversation_id: 'conv-1',
        backend: 'codex',
        workspacePath: '/tmp/workspace',
        setAiProcessing,
        resetState,
        markSendStarted: vi.fn(),
        markSendAccepted: vi.fn(),
        markSendFailed,
        checkAndUpdateTitle: vi.fn(),
        addOrUpdateMessage,
      })
    );

    await waitFor(() => expect(sendMessageInvokeMock).toHaveBeenCalledTimes(1));
    expect(markSendFailed).toHaveBeenCalledWith({ kind: 'ordinary', reason: 'boom' });
    expect(addOrUpdateMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'tips',
        content: expect.objectContaining({ type: 'error' }),
      }),
      true
    );
    expect(resetState).toHaveBeenCalledTimes(1);
    expect(setAiProcessing).toHaveBeenCalledWith(false);
  });
});
