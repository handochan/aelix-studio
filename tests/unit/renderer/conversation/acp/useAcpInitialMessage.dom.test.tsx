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

  it('restores the automatic first draft and sends nothing when the model check rejects', async () => {
    const files = [
      { kind: 'upload', path: '/uploads/note.txt' },
      { kind: 'local', path: '/workspace/source.ts' },
      { kind: 'project', pe_id: 'p1', relative_path: 'src/main.ts' },
    ];
    sessionStorage.setItem('acp_initial_message_conv-1', JSON.stringify({ input: 'hello', files }));
    const addOrUpdateMessage = vi.fn();
    const restoreDraft = vi.fn();
    // The live model check fails before the prompt is handed to the host.
    const submitPrompt = vi.fn(async (_dispatch: () => Promise<void>) => {
      throw new AelixInitialModelUnconfirmed();
    });
    renderHook(() =>
      useAcpInitialMessage({
        conversation_id: 'conv-1',
        backend: 'aelix',
        submitPrompt,
        restoreDraft,
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
    expect(restoreDraft).toHaveBeenCalledExactlyOnceWith('hello', files);
    expect(sessionStorage.getItem('acp_initial_message_conv-1')).toBeNull();
  });

  it('suppresses tips and reset and gives the draft back when initial ACP send hits active-turn busy', async () => {
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
    const restoreDraft = vi.fn();

    renderHook(() =>
      useAcpInitialMessage({
        conversation_id: 'conv-1',
        backend: 'codex',
        workspacePath: '/tmp/workspace',
        restoreDraft,
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
    // The host refused the prompt (409), so the composer offers it again.
    expect(restoreDraft).toHaveBeenCalledExactlyOnceWith('hello', []);
  });

  it.each([
    ['a validation error', 400, true],
    ['an archived conversation', 410, true],
    ['an upstream failure', 502, false],
    ['a lost connection', undefined, false],
  ])('restores the dispatched first draft after %s only when the host refused it', async (_case, status, restores) => {
    sessionStorage.setItem('acp_initial_message_conv-1', JSON.stringify({ input: 'hello', files: [] }));
    sendMessageInvokeMock.mockRejectedValue(
      status
        ? new BackendHttpError({
            method: 'POST',
            path: '/api/conversations/conv-1/messages',
            status,
            body: { success: false, code: 'FIXTURE', error: 'fixture failure' },
          })
        : new TypeError('Failed to fetch')
    );
    const restoreDraft = vi.fn();
    const addOrUpdateMessage = vi.fn();
    renderHook(() =>
      useAcpInitialMessage({
        conversation_id: 'conv-1',
        backend: 'aelix',
        restoreDraft,
        setAiProcessing: vi.fn(),
        resetState: vi.fn(),
        checkAndUpdateTitle: vi.fn(),
        addOrUpdateMessage,
      })
    );
    await waitFor(() => expect(addOrUpdateMessage).toHaveBeenCalledOnce());
    expect(sendMessageInvokeMock).toHaveBeenCalledOnce();
    expect(restoreDraft).toHaveBeenCalledTimes(restores ? 1 : 0);
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
    const restoreDraft = vi.fn();

    renderHook(() =>
      useAcpInitialMessage({
        conversation_id: 'conv-1',
        backend: 'codex',
        workspacePath: '/tmp/workspace',
        restoreDraft,
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
