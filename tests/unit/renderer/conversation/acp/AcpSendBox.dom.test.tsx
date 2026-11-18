/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { BackendHttpError } from '@/common/adapter/httpBridge';
import AcpSendBox from '@/renderer/pages/conversation/platforms/acp/AcpSendBox';
import type { UseAcpMessageReturn } from '@/renderer/pages/conversation/platforms/acp/useAcpMessage';
import type { TeamSendBoxRuntime } from '@/renderer/pages/team/components/teamSendRuntime';

const {
  sendMessageInvokeMock,
  addOrUpdateMessageMock,
  resetStateMock,
  emitterEmitMock,
  setSendBoxHandlerMock,
  useAcpConfigOptionsMock,
  useTeamPermissionMock,
  isMobileMock,
  mobileActionSheetEntries,
  sendBoxPropsSpy,
  runtimeViewMock,
  useConversationCommandQueueSpy,
  enqueueMock,
  removeMock,
  prioritizeMock,
  commandQueuePanelPropsSpy,
  clearFilesMock,
  draftMutateMock,
  draftContentRef,
  messageWarningMock,
  stopInvokeMock,
  getMessagesInvokeMock,
  getConversationOrNullMock,
} = vi.hoisted(() => ({
  sendMessageInvokeMock: vi.fn(),
  addOrUpdateMessageMock: vi.fn(),
  resetStateMock: vi.fn(),
  emitterEmitMock: vi.fn(),
  setSendBoxHandlerMock: vi.fn(),
  useAcpConfigOptionsMock: vi.fn(),
  useTeamPermissionMock: vi.fn(),
  sendBoxPropsSpy: vi.fn(),
  isMobileMock: { current: false },
  mobileActionSheetEntries: {
    current: [] as Array<{
      key: string;
      submenu?: {
        onSelect?: (value: string) => void;
      };
    }>,
  },
  runtimeViewMock: {
    hydrated: true,
    state: 'idle' as 'idle' | 'running' | 'starting',
    isProcessing: false,
    canSendMessage: true,
    activeTurnId: null as string | null,
    supportsMidturnDelivery: false,
    markSendStarted: vi.fn(),
    markSendAccepted: vi.fn(),
    markSendFailed: vi.fn(),
    markStopRequested: vi.fn(),
    markStopAcknowledged: vi.fn(),
    resetLocalGate: vi.fn(),
  },
  useConversationCommandQueueSpy: vi.fn(),
  enqueueMock: vi.fn(),
  removeMock: vi.fn(),
  prioritizeMock: vi.fn(),
  commandQueuePanelPropsSpy: vi.fn(),
  clearFilesMock: vi.fn(),
  draftMutateMock: vi.fn(),
  draftContentRef: { current: '' },
  messageWarningMock: vi.fn(),
  stopInvokeMock: vi.fn().mockResolvedValue(undefined),
  getMessagesInvokeMock: vi.fn(),
  getConversationOrNullMock: vi.fn(),
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    acpConversation: {
      sendMessage: {
        invoke: sendMessageInvokeMock,
      },
    },
    conversation: {
      stop: {
        invoke: stopInvokeMock,
      },
    },
    database: { getConversationMessages: { invoke: getMessagesInvokeMock } },
  },
}));

vi.mock('@/renderer/components/chat/SendBox', () => ({
  default: ({
    onSend,
    onChange,
    onStop,
    rightTools,
    sendButtonPrefix,
    topRightOverlay,
    active,
    onFocused,
    disabled,
    sendDisabled,
    onAddToDraft,
    addToDraftDisabled,
    selectedSessions,
    onSelectedSessionsChange,
    crossSessionEnabled,
    isTeamConversation,
  }: {
    onSend: (message: string) => Promise<void>;
    onStop?: () => Promise<void>;
    onChange?: (value: string) => void;
    rightTools?: React.ReactNode;
    sendButtonPrefix?: React.ReactNode;
    topRightOverlay?: React.ReactNode;
    active?: boolean;
    onFocused?: () => void;
    disabled?: boolean;
    sendDisabled?: boolean;
    onAddToDraft?: () => void;
    addToDraftDisabled?: boolean;
    selectedSessions?: Array<{ id: string }>;
    onSelectedSessionsChange?: (sessions: Array<{ id: string }>) => void;
    crossSessionEnabled?: boolean;
    isTeamConversation?: boolean;
  }) => {
    sendBoxPropsSpy({
      onSend,
      onStop,
      active,
      onFocused,
      disabled,
      sendDisabled,
      onAddToDraft,
      addToDraftDisabled,
      selectedSessions,
      crossSessionEnabled,
      isTeamConversation,
    });
    return (
      <div>
        {rightTools}
        {sendButtonPrefix}
        {topRightOverlay}
        <button type='button' onClick={() => onChange?.('hello')}>
          change
        </button>
        {/* Stands in for choosing a conversation in the `@@` picker. */}
        <button type='button' onClick={() => onSelectedSessionsChange?.([{ id: 'conv_target' }])}>
          pick-session
        </button>
        <button type='button' onClick={() => onAddToDraft?.()}>
          add-to-draft
        </button>
        <button
          type='button'
          onClick={() => {
            // Models the Enter-key submit path: in the real component Enter
            // reaches `onSend` regardless of the button's visual `sendDisabled`
            // state (only a mouse click on the real, disabled button is
            // blocked natively) — the parent decides whether to block+toast.
            void onSend('Hello').catch(() => {});
          }}
        >
          send
        </button>
      </div>
    );
  },
}));

vi.mock('@/renderer/components/agent/AgentModeSelector', () => ({ default: () => null }));
vi.mock('@/renderer/components/chat/CommandQueuePanel', () => ({
  default: (props: { onSendNow: (item: unknown) => void }) => {
    commandQueuePanelPropsSpy(props);
    return null;
  },
}));
vi.mock('@/renderer/components/chat/MobileActionSheet', () => ({
  default: ({
    entries,
  }: {
    entries?: Array<{
      key: string;
      submenu?: {
        onSelect?: (value: string) => void;
      };
    }>;
  }) => {
    mobileActionSheetEntries.current = entries ?? [];
    return null;
  },
  useAttachEntry: () => ({ entries: [], hiddenFileInput: null }),
}));
vi.mock('@/renderer/components/chat/ThoughtDisplay', () => ({ default: () => null }));
vi.mock('@/renderer/components/media/FileAttachButton', () => ({ default: () => null }));
vi.mock('@/renderer/components/media/FilePreview', () => ({ default: () => null }));
vi.mock('@/renderer/components/media/HorizontalFileList', () => ({
  default: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@/renderer/hooks/agent/useAcpModelInfo', () => ({
  useAcpModelInfo: () => ({
    model_info: null,
    canSwitch: false,
    selectModel: vi.fn(),
  }),
}));
vi.mock('@/renderer/hooks/agent/useAcpConfigOptions', () => ({
  classifyConfigSetError: () => 'unknown',
  useAcpConfigOptions: useAcpConfigOptionsMock,
}));
vi.mock('@/renderer/hooks/chat/useSendBoxDraft', () => ({
  getSendBoxDraftHook: () => () => ({
    data: {
      atPath: [],
      uploadFile: [],
      content: draftContentRef.current,
    },
    mutate: draftMutateMock,
  }),
}));
vi.mock('@/renderer/hooks/chat/useSendBoxFiles', () => ({
  useSendBoxFiles: () => ({
    handleFilesAdded: vi.fn(),
    clearFiles: clearFilesMock,
  }),
  createSetUploadFile: () => vi.fn(),
}));
vi.mock('@/renderer/hooks/chat/useAutoTitle', () => ({
  useAutoTitle: () => ({
    checkAndUpdateTitle: vi.fn(),
  }),
}));
vi.mock('@/renderer/hooks/context/ConversationContext', () => ({
  useConversationContextSafe: () => null,
}));
vi.mock('@/renderer/hooks/context/LayoutContext', () => ({
  useLayoutContext: () => ({ isMobile: isMobileMock.current }),
}));
vi.mock('@/renderer/hooks/file/useOpenFileSelector', () => ({
  useOpenFileSelector: () => ({
    openFileSelector: vi.fn(),
    onSlashBuiltinCommand: vi.fn(),
  }),
}));
vi.mock('@/renderer/hooks/ui/useLatestRef', () => ({
  useLatestRef: <T,>(value: T) => ({ current: value }),
}));
vi.mock('@/renderer/pages/conversation/Messages/hooks', () => ({
  useAddOrUpdateMessage: () => addOrUpdateMessageMock,
}));
vi.mock('@/renderer/pages/conversation/platforms/useConversationCommandQueue', () => ({
  useConversationCommandQueue: (args: unknown) => {
    useConversationCommandQueueSpy(args);
    return {
      items: [],
      isPaused: false,
      isInteractionLocked: false,
      hasPendingCommands: false,
      enqueue: enqueueMock,
      remove: removeMock,
      prioritize: prioritizeMock,
      clear: vi.fn(),
      reorder: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      lockInteraction: vi.fn(),
      unlockInteraction: vi.fn(),
      resetActiveExecution: vi.fn(),
    };
  },
}));
vi.mock('@/renderer/pages/conversation/runtime/useConversationRuntimeView', () => ({
  useConversationRuntimeView: () => runtimeViewMock,
}));
vi.mock('@/renderer/pages/conversation/utils/conversationCache', () => ({
  getConversationOrNull: getConversationOrNullMock,
}));
vi.mock('@/renderer/pages/conversation/Preview', () => ({
  usePreviewContext: () => ({
    setSendBoxHandler: setSendBoxHandlerMock,
  }),
}));
vi.mock('@/renderer/pages/team/hooks/TeamPermissionContext', () => ({
  useTeamPermission: useTeamPermissionMock,
}));
vi.mock('@/renderer/services/FileService', () => ({
  allSupportedExts: [],
}));
vi.mock('@/renderer/utils/emitter', () => ({
  emitter: {
    emit: emitterEmitMock,
  },
  useAddEventListener: vi.fn(),
}));
vi.mock('@/renderer/utils/file/fileSelection', () => ({
  mergeFileSelectionItems: vi.fn(),
}));
vi.mock('@/renderer/utils/file/messageFiles', () => ({
  collectChatFileRefs: () => [],
  splitChatFileRefs: () => ({ uploadFiles: [], atPath: [] }),
}));
vi.mock('@/renderer/pages/conversation/platforms/acp/useAcpInitialMessage', () => ({
  useAcpInitialMessage: vi.fn(),
}));
vi.mock('@arco-design/web-react', () => ({
  Message: {
    success: vi.fn(),
    error: vi.fn(),
    warning: messageWarningMock,
  },
  Tag: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  Popover: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  Button: ({
    children,
    onClick,
    disabled,
  }: {
    children?: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
  }) => (
    <button type='button' onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
}));

const makeMessageState = (): UseAcpMessageReturn => ({
  manualCompactionRunning: false,
  thought: { subject: '', description: '' },
  setThought: vi.fn(),
  running: true,
  hasHydratedRunningState: true,
  acpStatus: null,
  aiProcessing: false,
  setAiProcessing: vi.fn(),
  resetState: resetStateMock,
  tokenUsage: null,
  context_limit: 0,
  hasThinkingMessage: false,
  slashCommands: [],
  fetchSlashCommands: vi.fn(),
});

describe('AcpSendBox', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isMobileMock.current = false;
    mobileActionSheetEntries.current = [];
    runtimeViewMock.hydrated = true;
    runtimeViewMock.state = 'idle';
    runtimeViewMock.isProcessing = false;
    getMessagesInvokeMock.mockResolvedValue({ items: [] });
    getConversationOrNullMock.mockResolvedValue(null);
    runtimeViewMock.canSendMessage = true;
    runtimeViewMock.activeTurnId = null;
    runtimeViewMock.supportsMidturnDelivery = false;
    draftContentRef.current = '';
    useTeamPermissionMock.mockReturnValue(null);
    useAcpConfigOptionsMock.mockReturnValue({
      setStatus: { state: 'idle' },
      mode: null,
      model: null,
      thoughtLevel: null,
      reload: vi.fn(),
      setConfigOption: vi.fn(),
    });
  });

  it('resets ACP loading state when sendMessage fails before any stream error arrives', async () => {
    sendMessageInvokeMock.mockRejectedValue(
      new BackendHttpError({
        method: 'POST',
        path: '/api/conversations/conv-1/messages',
        status: 400,
        body: {
          success: false,
          code: 'WORKSPACE_PATH_RUNTIME_UNAVAILABLE',
          error: 'Workspace path is unavailable during execution: /tmp/missing',
          details: { workspace_path: '/tmp/missing' },
        },
      })
    );

    render(
      <AcpSendBox
        conversation_id='conv-1'
        backend='claude'
        workspacePath='/tmp/missing'
        messageState={makeMessageState()}
      />
    );

    await act(async () => {
      screen.getByRole('button', { name: 'send' }).click();
    });

    await waitFor(() => {
      expect(resetStateMock).toHaveBeenCalledTimes(1);
    });
  });

  it('shows a progress ring with a window size, a hollow ring without one, and nothing without usage', () => {
    const { container, rerender } = render(
      <AcpSendBox
        conversation_id='conv-1'
        backend='gemini'
        workspacePath='/tmp/workspace'
        messageState={{ ...makeMessageState(), tokenUsage: { total_tokens: 500_000 }, context_limit: 1_000_000 }}
      />
    );
    expect(container.querySelector('.context-usage-indicator')).not.toBeNull();
    expect(container.querySelectorAll('.context-usage-indicator circle')).toHaveLength(2);

    // Usage without an agent-reported denominator renders a hollow ring
    // (track circle only) — the count is real, but a percentage against a
    // made-up window size would lie.
    rerender(
      <AcpSendBox
        conversation_id='conv-1'
        backend='gemini'
        workspacePath='/tmp/workspace'
        messageState={{ ...makeMessageState(), tokenUsage: { total_tokens: 500_000 }, context_limit: 0 }}
      />
    );
    expect(container.querySelector('.context-usage-indicator')).not.toBeNull();
    expect(container.querySelectorAll('.context-usage-indicator circle')).toHaveLength(1);

    rerender(
      <AcpSendBox
        conversation_id='conv-1'
        backend='gemini'
        workspacePath='/tmp/workspace'
        messageState={makeMessageState()}
      />
    );
    expect(container.querySelector('.context-usage-indicator')).toBeNull();
  });

  it('suppresses internal error cards and loading reset for active-turn busy conflicts', async () => {
    sendMessageInvokeMock.mockRejectedValue(
      new BackendHttpError({
        method: 'POST',
        path: '/api/conversations/conv-1/messages',
        status: 409,
        body: {
          success: false,
          code: 'CONFLICT',
          error: 'conversation conv-1 is already running',
        },
      })
    );

    render(
      <AcpSendBox
        conversation_id='conv-1'
        backend='codex'
        workspacePath='/tmp/workspace'
        messageState={makeMessageState()}
      />
    );

    await act(async () => {
      screen.getByRole('button', { name: 'send' }).click();
    });

    await waitFor(() => {
      expect(sendMessageInvokeMock).toHaveBeenCalledTimes(1);
    });
    expect(addOrUpdateMessageMock).not.toHaveBeenCalled();
    expect(resetStateMock).not.toHaveBeenCalled();
  });

  it('uses container-responsive fluid width instead of a fixed max width', () => {
    render(
      <AcpSendBox
        conversation_id='conv-1'
        backend='codex'
        workspacePath='/tmp/workspace'
        messageState={makeMessageState()}
      />
    );

    const wrapper = screen.getByRole('button', { name: 'send' }).closest('.chat-surface-fluid');
    expect(wrapper?.className).toContain('chat-surface-fluid');
    expect(wrapper?.className).not.toContain('w-[calc(100%-24px)]');
    expect(wrapper?.className).not.toContain('md:w-[calc(100%-clamp(80px,10vw,240px))]');
    expect(wrapper?.className).not.toContain('max-w-800px');
  });

  it('uses the same container-responsive width in team mode', () => {
    // The send box shares one width class with standalone mode; the container query
    // decides whether gutters appear, so a narrow team column still fills its width.
    useTeamPermissionMock.mockReturnValue({
      isTeamMode: true,
      isLeaderAgent: true,
      leaderConversationId: 'conv-1',
      allConversationIds: ['conv-1'],
      propagateMode: vi.fn(),
      warmupSession: vi.fn().mockResolvedValue(undefined),
    });

    render(
      <AcpSendBox
        conversation_id='conv-1'
        backend='codex'
        workspacePath='/tmp/workspace'
        messageState={makeMessageState()}
      />
    );

    const wrapper = screen.getByRole('button', { name: 'send' }).closest('.chat-surface-fluid');
    expect(wrapper?.className).toContain('chat-surface-fluid');
    expect(wrapper?.className).not.toContain('w-[calc(100%-24px)]');
    expect(wrapper?.className).not.toContain('md:w-[calc(100%-clamp(80px,10vw,240px))]');
  });

  it('does not warm up team session on mount or draft content changes', async () => {
    const warmupSession = vi.fn().mockResolvedValue(undefined);
    useTeamPermissionMock.mockReturnValue({
      isTeamMode: true,
      isLeaderAgent: true,
      leaderConversationId: 'conv-1',
      allConversationIds: ['conv-1'],
      propagateMode: vi.fn(),
      warmupSession,
    });

    render(
      <AcpSendBox
        conversation_id='conv-1'
        backend='codex'
        workspacePath='/tmp/workspace'
        messageState={makeMessageState()}
      />
    );

    expect(warmupSession).not.toHaveBeenCalled();

    await act(async () => {
      screen.getByRole('button', { name: 'change' }).click();
    });

    expect(warmupSession).not.toHaveBeenCalled();
  });

  it('does not warm up team session when config options prepare runtime runs', async () => {
    const warmupSession = vi.fn().mockResolvedValue(undefined);
    useTeamPermissionMock.mockReturnValue({
      isTeamMode: true,
      isLeaderAgent: true,
      leaderConversationId: 'conv-1',
      allConversationIds: ['conv-1'],
      propagateMode: vi.fn(),
      warmupSession,
    });

    render(
      <AcpSendBox
        conversation_id='conv-1'
        backend='codex'
        workspacePath='/tmp/workspace'
        messageState={makeMessageState()}
      />
    );

    const configOptionsArgs = useAcpConfigOptionsMock.mock.calls[0]?.[0] as
      | { prepareRuntime?: () => Promise<void> }
      | undefined;
    await configOptionsArgs?.prepareRuntime?.();

    expect(warmupSession).not.toHaveBeenCalled();
  });

  it('still warms up team session before sending a message', async () => {
    sendMessageInvokeMock.mockResolvedValue({ turn_id: 'turn-1', runtime: null, msg_id: 'msg-1' });
    const warmupSession = vi.fn().mockResolvedValue(undefined);
    useTeamPermissionMock.mockReturnValue({
      isTeamMode: true,
      isLeaderAgent: true,
      leaderConversationId: 'conv-1',
      allConversationIds: ['conv-1'],
      propagateMode: vi.fn(),
      warmupSession,
    });

    render(
      <AcpSendBox
        conversation_id='conv-1'
        backend='codex'
        workspacePath='/tmp/workspace'
        messageState={makeMessageState()}
      />
    );

    await act(async () => {
      screen.getByRole('button', { name: 'send' }).click();
    });

    await waitFor(() => {
      expect(warmupSession).toHaveBeenCalledTimes(1);
    });
  });

  it('keeps ACP config options enabled on desktop without rendering a standalone thought selector', () => {
    useAcpConfigOptionsMock.mockReturnValue({
      setStatus: { state: 'idle' },
      mode: null,
      model: null,
      thoughtLevel: {
        id: 'reasoning_effort',
        category: 'thought_level',
        currentValue: 'high',
        options: [{ value: 'high', label: 'High' }],
      },
      reload: vi.fn(),
      setConfigOption: vi.fn(),
    });

    render(
      <AcpSendBox
        conversation_id='conv-1'
        backend='codex'
        workspacePath='/tmp/workspace'
        messageState={makeMessageState()}
      />
    );

    expect(useAcpConfigOptionsMock).toHaveBeenCalledWith(expect.objectContaining({ enabled: true }));
    expect(screen.queryByTestId('mock-thought-selector')).not.toBeInTheDocument();
  });

  it('applies runtime thought level from the mobile action sheet without persisting a global preference', async () => {
    isMobileMock.current = true;
    const setConfigOption = vi.fn().mockResolvedValue([]);
    useAcpConfigOptionsMock.mockReturnValue({
      mode: null,
      model: null,
      thoughtLevel: {
        id: 'reasoning_effort',
        category: 'thought_level',
        currentValue: 'medium',
        options: [
          { value: 'medium', label: 'Medium' },
          { value: 'high', label: 'High' },
        ],
      },
      setStatus: { state: 'idle' },
      setConfigOption,
      reload: vi.fn(),
      isLoading: false,
      configOptions: [],
    });

    render(
      <AcpSendBox
        conversation_id='conv-1'
        backend='codex'
        workspacePath='/tmp/workspace'
        messageState={makeMessageState()}
      />
    );

    await act(async () => {
      mobileActionSheetEntries.current.find((entry) => entry.key === 'thought-level')?.submenu?.onSelect?.('high');
    });

    // This branch dropped global-preference persistence: only the runtime
    // config option is set; nothing is saved to a global agent preference.
    await waitFor(() => {
      expect(setConfigOption).toHaveBeenCalledWith('reasoning_effort', 'high');
    });
  });

  it('does not apply runtime thought level when observed confirmation fails', async () => {
    isMobileMock.current = true;
    const setConfigOption = vi.fn().mockRejectedValue(new Error('command_ack'));
    useAcpConfigOptionsMock.mockReturnValue({
      mode: null,
      model: null,
      thoughtLevel: {
        id: 'reasoning_effort',
        category: 'thought_level',
        currentValue: 'medium',
        options: [{ value: 'high', label: 'High' }],
      },
      setStatus: { state: 'idle' },
      setConfigOption,
      reload: vi.fn(),
      isLoading: false,
      configOptions: [],
    });

    render(
      <AcpSendBox
        conversation_id='conv-1'
        backend='codex'
        workspacePath='/tmp/workspace'
        messageState={makeMessageState()}
      />
    );

    await act(async () => {
      mobileActionSheetEntries.current.find((entry) => entry.key === 'thought-level')?.submenu?.onSelect?.('high');
    });

    await waitFor(() => {
      expect(setConfigOption).toHaveBeenCalledWith('reasoning_effort', 'high');
    });
  });

  it('passes teamRuntime.isActive and onFocus down to SendBox as active/onFocused', () => {
    const onFocus = vi.fn();
    render(
      <AcpSendBox
        conversation_id='conv-1'
        backend='claude'
        workspacePath='/tmp/workspace'
        messageState={makeMessageState()}
        teamRuntime={{ loading: false, startedAtMs: null, isActive: true, onFocus } as unknown as TeamSendBoxRuntime}
      />
    );
    const props = sendBoxPropsSpy.mock.calls.at(-1)?.[0] as { active?: boolean; onFocused?: () => void };
    expect(props.active).toBe(true);
    props.onFocused?.();
    expect(onFocus).toHaveBeenCalledTimes(1);
  });

  it('keeps the client command queue enabled for backends that can deliver mid-turn (queued items still auto-send)', () => {
    runtimeViewMock.supportsMidturnDelivery = true;

    render(
      <AcpSendBox
        conversation_id='conv-1'
        backend='claude'
        workspacePath='/tmp/workspace'
        messageState={makeMessageState()}
      />
    );

    expect(useConversationCommandQueueSpy).toHaveBeenCalledWith(expect.objectContaining({ enabled: true }));
  });

  it('keeps the client command queue enabled for backends that cannot deliver mid-turn', () => {
    runtimeViewMock.supportsMidturnDelivery = false;

    render(
      <AcpSendBox
        conversation_id='conv-1'
        backend='antigravity'
        workspacePath='/tmp/workspace'
        messageState={makeMessageState()}
      />
    );

    expect(useConversationCommandQueueSpy).toHaveBeenCalledWith(expect.objectContaining({ enabled: true }));
  });

  describe('mid-turn interjection controls', () => {
    it('shows the add-to-draft-box entry for a supporting agent with a non-empty draft, and clicking it enqueues without executing', async () => {
      runtimeViewMock.supportsMidturnDelivery = true;
      runtimeViewMock.isProcessing = true;
      runtimeViewMock.canSendMessage = true;
      draftContentRef.current = 'hello world';

      render(
        <AcpSendBox
          conversation_id='conv-1'
          backend='claude'
          workspacePath='/tmp/workspace'
          messageState={makeMessageState()}
        />
      );

      const props = sendBoxPropsSpy.mock.calls.at(-1)?.[0] as { onAddToDraft?: () => void };
      expect(props.onAddToDraft).toBeDefined();
      await act(async () => {
        props.onAddToDraft?.();
      });

      expect(enqueueMock).toHaveBeenCalledWith({ input: 'hello world', files: [] });
      expect(sendMessageInvokeMock).not.toHaveBeenCalled();
      expect(clearFilesMock).toHaveBeenCalled();
      // setContent('') clears the draft the same way a send would.
      const updater = draftMutateMock.mock.calls.at(-1)?.[0] as (prev: { content: string }) => { content: string };
      expect(updater({ content: 'hello world' })).toEqual(expect.objectContaining({ content: '' }));
    });

    it('shows the add-to-draft-box option for a supporting agent that is idle, as long as the draft is non-empty', async () => {
      // Visibility is keyed only to the draft, not to the agent's busy state —
      // clicking while idle is semantically fine (the queue's own mode governs).
      runtimeViewMock.supportsMidturnDelivery = true;
      runtimeViewMock.isProcessing = false;
      draftContentRef.current = 'hello world';

      render(
        <AcpSendBox
          conversation_id='conv-1'
          backend='claude'
          workspacePath='/tmp/workspace'
          messageState={makeMessageState()}
        />
      );

      const props = sendBoxPropsSpy.mock.calls.at(-1)?.[0] as { onAddToDraft?: () => void };
      expect(props.onAddToDraft).toBeDefined();
    });

    it('disables the Draft box action for a supporting agent with an empty draft, even while replying', () => {
      runtimeViewMock.supportsMidturnDelivery = true;
      runtimeViewMock.isProcessing = true;
      draftContentRef.current = '';

      render(
        <AcpSendBox
          conversation_id='conv-1'
          backend='claude'
          workspacePath='/tmp/workspace'
          messageState={makeMessageState()}
        />
      );

      const props = sendBoxPropsSpy.mock.calls.at(-1)?.[0] as {
        onAddToDraft?: () => void;
        addToDraftDisabled?: boolean;
      };
      expect(props.onAddToDraft).toBeDefined();
      expect(props.addToDraftDisabled).toBe(true);
    });

    it('disables the send button and blocks Enter with a toast for a non-supporting agent while replying, without implicitly enqueuing', async () => {
      runtimeViewMock.supportsMidturnDelivery = false;
      runtimeViewMock.isProcessing = true;
      runtimeViewMock.canSendMessage = true;
      draftContentRef.current = 'hello world';

      render(
        <AcpSendBox
          conversation_id='conv-1'
          backend='antigravity'
          workspacePath='/tmp/workspace'
          messageState={makeMessageState()}
        />
      );

      const props = sendBoxPropsSpy.mock.calls.at(-1)?.[0] as { sendDisabled?: boolean };
      expect(props.sendDisabled).toBe(true);

      await act(async () => {
        screen.getByRole('button', { name: 'send' }).click();
      });

      expect(sendMessageInvokeMock).not.toHaveBeenCalled();
      expect(enqueueMock).not.toHaveBeenCalled();
      expect(clearFilesMock).not.toHaveBeenCalled();
      expect(messageWarningMock).toHaveBeenCalledWith(
        'This agent is still working, so the message can’t be sent directly. Save it to Draft box and send it later.'
      );
    });

    it('sends normally for a non-supporting agent while idle', async () => {
      runtimeViewMock.supportsMidturnDelivery = false;
      runtimeViewMock.isProcessing = false;
      runtimeViewMock.canSendMessage = true;
      sendMessageInvokeMock.mockResolvedValue({ turn_id: 'turn-1', runtime: null, msg_id: 'msg-1' });

      render(
        <AcpSendBox
          conversation_id='conv-1'
          backend='antigravity'
          workspacePath='/tmp/workspace'
          messageState={makeMessageState()}
        />
      );

      const props = sendBoxPropsSpy.mock.calls.at(-1)?.[0] as { sendDisabled?: boolean };
      expect(props.sendDisabled).toBe(false);

      await act(async () => {
        screen.getByRole('button', { name: 'send' }).click();
      });

      await waitFor(() => {
        expect(sendMessageInvokeMock).toHaveBeenCalledTimes(1);
      });
      expect(enqueueMock).not.toHaveBeenCalled();
      expect(messageWarningMock).not.toHaveBeenCalled();
    });
  });

  describe('queued command send-now', () => {
    const queuedItem = { id: 'q1', input: 'queued draft', files: [], created_at: 1 };

    const getOnSendNow = () => {
      const props = commandQueuePanelPropsSpy.mock.calls.at(-1)?.[0] as {
        onSendNow: (item: typeof queuedItem) => void;
      };
      return props.onSendNow;
    };

    it('keeps a queued command from stopping a manual compaction', async () => {
      runtimeViewMock.activeTurnId = 'turn-compact';
      render(
        <AcpSendBox
          conversation_id='conv-1'
          backend='aelix'
          messageState={{ ...makeMessageState(), manualCompactionRunning: true }}
        />
      );
      await act(async () => getOnSendNow()(queuedItem));
      expect(stopInvokeMock).not.toHaveBeenCalled();
      expect(removeMock).not.toHaveBeenCalled();
    });

    it('blocks Stop and queued send-now while /compact submission awaits the first frame', async () => {
      let finishSend!: (value: unknown) => void;
      sendMessageInvokeMock.mockReturnValue(new Promise((resolve) => (finishSend = resolve)));
      runtimeViewMock.activeTurnId = 'turn-compact';
      render(<AcpSendBox conversation_id='conv-1' backend='aelix' messageState={makeMessageState()} />);
      const original = sendBoxPropsSpy.mock.calls.at(-1)?.[0];
      let submitted: Promise<void>;
      act(() => {
        submitted = original.onSend('/compact keep decisions');
      });
      await waitFor(() => expect(sendMessageInvokeMock).toHaveBeenCalled());
      expect(sendBoxPropsSpy.mock.calls.at(-1)?.[0].onStop).toBeUndefined();
      await act(async () => {
        await original.onStop();
        await getOnSendNow()(queuedItem);
        finishSend({ turn_id: 'turn-compact', runtime: null, msg_id: 'msg-1' });
        await submitted;
      });
      expect(stopInvokeMock).not.toHaveBeenCalled();
      expect(removeMock).not.toHaveBeenCalled();
    });

    it('keeps Stop unavailable after reopening an active manual compaction without a stream frame', async () => {
      let finishHistory!: (value: unknown) => void;
      getMessagesInvokeMock.mockReturnValue(new Promise((resolve) => (finishHistory = resolve)));
      runtimeViewMock.activeTurnId = 'turn-compact';
      runtimeViewMock.state = 'running';
      runtimeViewMock.isProcessing = true;
      render(<AcpSendBox conversation_id='conv-1' backend='aelix' messageState={makeMessageState()} />);
      await waitFor(() => expect(getMessagesInvokeMock).toHaveBeenCalled());
      expect(sendBoxPropsSpy.mock.calls.at(-1)?.[0].onStop).toBeUndefined();
      await act(async () => {
        finishHistory({
          items: [{ type: 'text', position: 'right', content: { content: '/compact keep decisions' } }],
        });
        await getOnSendNow()(queuedItem);
      });
      expect(sendBoxPropsSpy.mock.calls.at(-1)?.[0].onStop).toBeUndefined();
      expect(stopInvokeMock).not.toHaveBeenCalled();
    });

    it('does not use the previous user message while the host is still persisting the new turn', async () => {
      runtimeViewMock.activeTurnId = 'turn-compact';
      runtimeViewMock.state = 'starting';
      runtimeViewMock.isProcessing = true;
      getConversationOrNullMock.mockResolvedValue({ runtime: { turn_id: 'turn-compact', state: 'starting' } });
      getMessagesInvokeMock.mockResolvedValue({
        items: [{ type: 'text', position: 'right', content: { content: 'Previous ordinary message' } }],
      });
      render(<AcpSendBox conversation_id='conv-1' backend='aelix' messageState={makeMessageState()} />);
      await waitFor(() => expect(getConversationOrNullMock).toHaveBeenCalled());
      expect(getMessagesInvokeMock).not.toHaveBeenCalled();
      await act(async () => getOnSendNow()(queuedItem));
      expect(stopInvokeMock).not.toHaveBeenCalled();
    });

    it('restores Stop for ordinary active turns after checking persisted input', async () => {
      runtimeViewMock.activeTurnId = 'turn-ordinary';
      runtimeViewMock.state = 'running';
      runtimeViewMock.isProcessing = true;
      getMessagesInvokeMock.mockResolvedValue({
        items: [{ type: 'text', position: 'right', content: { content: 'Keep working' } }],
      });
      stopInvokeMock.mockResolvedValue({ runtime: null });
      render(<AcpSendBox conversation_id='conv-1' backend='aelix' messageState={makeMessageState()} />);
      await waitFor(() => expect(sendBoxPropsSpy.mock.calls.at(-1)?.[0].onStop).toBeTypeOf('function'));
      await act(async () => sendBoxPropsSpy.mock.calls.at(-1)?.[0].onStop());
      expect(stopInvokeMock).toHaveBeenCalledWith({ conversation_id: 'conv-1', turn_id: 'turn-ordinary' });
    });

    it('recovers ordinary Stop when the current input is older than the latest 50 rows', async () => {
      runtimeViewMock.activeTurnId = 'turn-long';
      runtimeViewMock.state = 'running';
      runtimeViewMock.isProcessing = true;
      getMessagesInvokeMock
        .mockResolvedValueOnce({
          items: Array.from({ length: 50 }, (_, index) => ({ id: `tool-${index}`, type: 'acp_tool_call' })),
          has_more_before: true,
          oldest_cursor: 'more-history',
        })
        .mockResolvedValueOnce({
          items: [{ type: 'text', position: 'right', content: { content: 'Ordinary turn still running' } }],
          has_more_before: false,
        });
      stopInvokeMock.mockResolvedValue({ runtime: null });
      render(<AcpSendBox conversation_id='conv-1' backend='aelix' messageState={makeMessageState()} />);

      expect(sendBoxPropsSpy.mock.calls.at(-1)?.[0].onStop).toBeUndefined();
      await waitFor(() => expect(sendBoxPropsSpy.mock.calls.at(-1)?.[0].onStop).toBeTypeOf('function'));
      expect(getMessagesInvokeMock).toHaveBeenNthCalledWith(2, {
        conversation_id: 'conv-1',
        limit: 50,
        before: 'more-history',
      });
      await act(async () => sendBoxPropsSpy.mock.calls.at(-1)?.[0].onStop());
      expect(stopInvokeMock).toHaveBeenCalledWith({ conversation_id: 'conv-1', turn_id: 'turn-long' });
    });

    it('delivers mid-turn for a supporting agent instead of stopping the turn', async () => {
      runtimeViewMock.supportsMidturnDelivery = true;
      sendMessageInvokeMock.mockResolvedValue({ turn_id: 'turn-1', runtime: null, msg_id: 'msg-1' });

      render(
        <AcpSendBox
          conversation_id='conv-1'
          backend='claude'
          workspacePath='/tmp/workspace'
          messageState={makeMessageState()}
        />
      );

      await act(async () => {
        await getOnSendNow()(queuedItem);
      });

      expect(removeMock).toHaveBeenCalledWith('q1');
      expect(stopInvokeMock).not.toHaveBeenCalled();
      expect(sendMessageInvokeMock).toHaveBeenCalledWith(expect.objectContaining({ input: 'queued draft', files: [] }));
      expect(prioritizeMock).not.toHaveBeenCalled();
      expect(enqueueMock).not.toHaveBeenCalled();
    });

    it('keeps the stop-then-prioritize path for a non-supporting agent', async () => {
      runtimeViewMock.supportsMidturnDelivery = false;
      runtimeViewMock.activeTurnId = 'turn-9';

      render(
        <AcpSendBox
          conversation_id='conv-1'
          backend='antigravity'
          workspacePath='/tmp/workspace'
          messageState={makeMessageState()}
        />
      );

      await act(async () => {
        await getOnSendNow()(queuedItem);
      });

      expect(stopInvokeMock).toHaveBeenCalledWith({ conversation_id: 'conv-1', turn_id: 'turn-9' });
      expect(prioritizeMock).toHaveBeenCalledWith('q1');
      expect(removeMock).not.toHaveBeenCalled();
      expect(sendMessageInvokeMock).not.toHaveBeenCalled();
    });

    it('re-enqueues at the front when a supporting agent fails to deliver mid-turn', async () => {
      runtimeViewMock.supportsMidturnDelivery = true;
      sendMessageInvokeMock.mockRejectedValue(new Error('boom'));
      enqueueMock.mockReturnValue({ id: 'restored-1', input: 'queued draft', files: [], created_at: 123 });

      render(
        <AcpSendBox
          conversation_id='conv-1'
          backend='claude'
          workspacePath='/tmp/workspace'
          messageState={makeMessageState()}
        />
      );

      await act(async () => {
        await getOnSendNow()(queuedItem);
      });

      expect(removeMock).toHaveBeenCalledWith('q1');
      expect(enqueueMock).toHaveBeenCalledWith({ input: 'queued draft', files: [], sessions: undefined });
      expect(prioritizeMock).toHaveBeenCalledWith('restored-1');
    });

    it('keeps the `@@` references when a failed mid-turn send is re-enqueued', async () => {
      // The restore path re-creates the queue item from scratch, so dropping
      // `sessions` here would silently strip the references the user picked.
      runtimeViewMock.supportsMidturnDelivery = true;
      sendMessageInvokeMock.mockRejectedValue(new Error('boom'));
      enqueueMock.mockReturnValue({ id: 'restored-1', input: 'queued draft', files: [], created_at: 123 });

      render(
        <AcpSendBox
          conversation_id='conv-1'
          backend='claude'
          workspacePath='/tmp/workspace'
          messageState={makeMessageState()}
        />
      );

      await act(async () => {
        await getOnSendNow()({ ...queuedItem, sessions: [{ id: 'conv_target' }] });
      });

      expect(enqueueMock).toHaveBeenCalledWith({
        input: 'queued draft',
        files: [],
        sessions: [{ id: 'conv_target' }],
      });
    });
  });

  describe('`@@` session references', () => {
    it('forwards them to sendMessage on a direct send and clears them afterwards', async () => {
      sendMessageInvokeMock.mockResolvedValue({ msg_id: 'm1', turn_id: 't1', runtime: {} });
      render(
        <AcpSendBox
          conversation_id='conv-1'
          backend='claude'
          workspacePath='/tmp/workspace'
          messageState={makeMessageState()}
        />
      );

      await act(async () => {
        screen.getByText('pick-session').click();
      });
      await act(async () => {
        screen.getByText('send').click();
      });

      expect(sendMessageInvokeMock).toHaveBeenCalledWith(
        expect.objectContaining({ sessions: [{ id: 'conv_target' }] })
      );

      // Released with the draft: a leftover reference would silently attach
      // itself to the user's next, unrelated message.
      sendMessageInvokeMock.mockClear();
      await act(async () => {
        screen.getByText('send').click();
      });
      expect(sendMessageInvokeMock).toHaveBeenCalledWith(expect.objectContaining({ sessions: undefined }));
    });

    it('carries them into the draft box and clears them from the send box', async () => {
      // The draft box is the path most likely to lose them: enqueue rebuilds the
      // item, and a message that reaches the agent without its session block
      // fails silently on both sides.
      render(
        <AcpSendBox
          conversation_id='conv-1'
          backend='claude'
          workspacePath='/tmp/workspace'
          messageState={makeMessageState()}
        />
      );

      await act(async () => {
        screen.getByText('pick-session').click();
      });
      await act(async () => {
        screen.getByText('add-to-draft').click();
      });

      expect(enqueueMock).toHaveBeenCalledWith(expect.objectContaining({ sessions: [{ id: 'conv_target' }] }));

      const props = sendBoxPropsSpy.mock.calls.at(-1)?.[0] as { selectedSessions?: Array<{ id: string }> };
      expect(props.selectedSessions).toEqual([]);
    });

    it('offers the picker in an ordinary conversation but not in a team one', () => {
      const { unmount } = render(
        <AcpSendBox
          conversation_id='conv-1'
          backend='claude'
          workspacePath='/tmp/workspace'
          messageState={makeMessageState()}
        />
      );
      let props = sendBoxPropsSpy.mock.calls.at(-1)?.[0] as {
        crossSessionEnabled?: boolean;
        isTeamConversation?: boolean;
      };
      expect(props.crossSessionEnabled).toBe(true);
      expect(props.isTeamConversation).toBe(false);
      unmount();

      render(
        <AcpSendBox
          conversation_id='conv-1'
          backend='claude'
          workspacePath='/tmp/workspace'
          messageState={makeMessageState()}
          teamRuntime={{ loading: false, startedAtMs: null } as unknown as TeamSendBoxRuntime}
        />
      );
      props = sendBoxPropsSpy.mock.calls.at(-1)?.[0] as {
        crossSessionEnabled?: boolean;
        isTeamConversation?: boolean;
      };
      expect(props.isTeamConversation).toBe(true);
    });
  });
});
