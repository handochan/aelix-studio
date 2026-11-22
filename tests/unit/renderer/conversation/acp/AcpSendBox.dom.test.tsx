/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { Message } from '@arco-design/web-react';
import type { IResponseMessage } from '@/common/adapter/ipcBridge';
import type { AcpConfigOptionDto } from '@/common/types/platform/acpTypes';
import { TeamPermissionProvider } from '@/renderer/pages/team/hooks/TeamPermissionContext';
import { BackendHttpError } from '@/common/adapter/httpBridge';
import AcpSendBox from '@/renderer/pages/conversation/platforms/acp/AcpSendBox';
import type { UseAcpMessageReturn } from '@/renderer/pages/conversation/platforms/acp/useAcpMessage';
import type { MobileActionSheetEntry } from '@/renderer/components/chat/MobileActionSheet/types';
import type { TeamSendBoxRuntime } from '@/renderer/pages/team/components/teamSendRuntime';

const {
  sendMessageInvokeMock,
  addOrUpdateMessageMock,
  resetStateMock,
  emitterEmitMock,
  setSendBoxHandlerMock,
  useAcpConfigOptionsMock,
  useTeamPermissionMock,
  teamGetConfigMock,
  teamSetConfigMock,
  teamSetModeMock,
  responseListeners,
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
  teamGetConfigMock: vi.fn(),
  teamSetConfigMock: vi.fn(),
  teamSetModeMock: vi.fn(),
  responseListeners: new Set<(message: IResponseMessage) => void>(),
  sendBoxPropsSpy: vi.fn(),
  isMobileMock: { current: false },
  mobileActionSheetEntries: {
    current: [] as MobileActionSheetEntry[],
  },
  runtimeViewMock: {
    hydrated: true,
    hasBackendRuntime: true,
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

const { runningInputMock, useRunningInputSpy, collectChatFileRefsMock } = vi.hoisted(() => ({
  runningInputMock: {
    available: false,
    handlesSubmit: false,
    modes: ['steer', 'follow-up'],
    mode: 'follow-up',
    setMode: vi.fn(),
    notices: [],
    submit: vi.fn(),
    beginStop: vi.fn(),
    finishStop: vi.fn(),
    dismiss: vi.fn(),
    check: vi.fn(),
  },
  useRunningInputSpy: vi.fn(),
  collectChatFileRefsMock: vi.fn((): object[] => []),
}));

vi.mock('@/renderer/pages/conversation/runtime/RunningInput', () => ({
  useRunningInput: (options: unknown) => {
    useRunningInputSpy(options);
    return runningInputMock;
  },
  RunningInputModeSwitch: () => <div data-testid='running-input-mode' />,
  RunningInputNotices: () => null,
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    team: {
      getConfigOptions: { invoke: teamGetConfigMock },
      setConfigOption: { invoke: teamSetConfigMock },
      setSessionMode: { invoke: teamSetModeMock },
      ensureSession: { invoke: vi.fn().mockResolvedValue(undefined) },
    },
    acpConversation: {
      responseStream: {
        on: (listener: (message: IResponseMessage) => void) => {
          responseListeners.add(listener);
          return () => responseListeners.delete(listener);
        },
      },
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
    deferDraftClear,
    allowAttachmentOnlySend,
  }: {
    onSend: (message: string, draft: { slashCommand: boolean; hasQuote: boolean }) => Promise<void | false>;
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
    deferDraftClear?: boolean;
    allowAttachmentOnlySend?: boolean;
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
      deferDraftClear,
      allowAttachmentOnlySend,
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
        <button
          type='button'
          onClick={() => onSelectedSessionsChange?.([...(selectedSessions ?? []), { id: 'conv_new' }])}
        >
          pick-another-session
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
            void onSend('Hello', { slashCommand: false, hasQuote: false }).catch(() => {});
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
  default: ({ entries }: { entries?: MobileActionSheetEntry[] }) => {
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
vi.mock('@/renderer/pages/conversation/runtime/conversationRuntimeViewStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/renderer/pages/conversation/runtime/conversationRuntimeViewStore')>()),
  getConversationRuntimeViewSnapshot: () => runtimeViewMock,
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
vi.mock('@/renderer/pages/team/hooks/TeamPermissionContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/renderer/pages/team/hooks/TeamPermissionContext')>();
  return {
    ...actual,
    useTeamPermission: () => {
      const context = actual.useTeamPermission();
      return useTeamPermissionMock() ?? context;
    },
  };
});
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
  collectChatFileRefs: collectChatFileRefsMock,
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
    info: vi.fn(),
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
    runtimeViewMock.hasBackendRuntime = true;
    runtimeViewMock.state = 'idle';
    runtimeViewMock.isProcessing = false;
    getMessagesInvokeMock.mockResolvedValue({ items: [] });
    getConversationOrNullMock.mockResolvedValue(null);
    runtimeViewMock.canSendMessage = true;
    runtimeViewMock.activeTurnId = null;
    runtimeViewMock.supportsMidturnDelivery = false;
    draftContentRef.current = '';
    runningInputMock.beginStop.mockReturnValue(runningInputMock.finishStop);
    runningInputMock.available = false;
    runningInputMock.handlesSubmit = false;
    runningInputMock.submit.mockResolvedValue('ordinary');
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

  it('disables the send box while the session holder check blocks sending', () => {
    const { rerender } = render(
      <AcpSendBox conversation_id='conv-1' backend='codex' messageState={makeMessageState()} sendBlocked />
    );
    expect(sendBoxPropsSpy.mock.calls.at(-1)?.[0]).toMatchObject({ disabled: true });

    rerender(<AcpSendBox conversation_id='conv-1' backend='codex' messageState={makeMessageState()} />);
    expect(sendBoxPropsSpy.mock.calls.at(-1)?.[0]).toMatchObject({ disabled: false });
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

  it.each([
    { backend: 'antigravity', backend_accepted: undefined, snapshotMode: 'yolo' },
    { backend: 'codex', backend_accepted: true, snapshotMode: 'yolo' },
    { backend: 'codex', backend_accepted: true, snapshotMode: 'default' },
  ])(
    'propagates an accepted next-turn Ask from $backend and shows pending with snapshot mode $snapshotMode',
    async ({ backend, backend_accepted, snapshotMode }) => {
      const actual = await vi.importActual<typeof import('@/renderer/hooks/agent/useAcpConfigOptions')>(
        '@/renderer/hooks/agent/useAcpConfigOptions'
      );
      useAcpConfigOptionsMock.mockImplementation(actual.useAcpConfigOptions);
      isMobileMock.current = true;
      const leaderId = `deferred-mixed-team-leader-${backend}-${snapshotMode}`;
      const modeOption = (current_value: string): AcpConfigOptionDto => ({
        id: 'mode',
        category: 'mode',
        type: 'select',
        current_value,
        options: [
          { value: 'default', label: 'Ask' },
          { value: 'yolo', label: 'Yolo' },
        ],
      });

      let teammateMode = 'yolo';
      teamGetConfigMock.mockResolvedValue({ config_options: [modeOption('yolo')] });
      teamSetConfigMock
        .mockReset()
        .mockResolvedValueOnce({
          confirmation: 'pending_next_turn',
          backend_accepted,
          config_options: [modeOption(snapshotMode)],
        })
        .mockResolvedValueOnce({
          confirmation: backend === 'antigravity' ? 'pending_next_turn' : 'command_ack',
          backend_accepted: false,
          config_options: [modeOption('default')],
        });
      teamSetModeMock.mockImplementation(async ({ session_mode }: { session_mode: string }) => {
        teammateMode = session_mode;
      });

      render(
        <TeamPermissionProvider
          team_id='mixed-team'
          isLeaderAgent
          leaderConversationId={leaderId}
          allConversationIds={[leaderId, 'aelix-teammate']}
          runtimeStartingConversationIds={new Set()}
        >
          <AcpSendBox
            conversation_id={leaderId}
            backend={backend}
            workspacePath='/tmp/workspace'
            messageState={makeMessageState()}
          />
        </TeamPermissionProvider>
      );

      const permission = () => mobileActionSheetEntries.current.find((entry) => entry.key === 'permission');
      const activeMode = () => permission()?.submenu?.options.find((option) => option.active)?.key;
      await waitFor(() => expect(activeMode()).toBe('yolo'));
      await act(async () => permission()?.submenu?.onSelect('default'));
      expect(teamSetModeMock).toHaveBeenCalledWith({ team_id: 'mixed-team', session_mode: 'default' });
      expect(teammateMode).toBe('default');
      expect(activeMode()).toBe(snapshotMode);
      expect(Message.info).toHaveBeenCalledWith('agentMode.switchPendingNextTurn');
      expect(Message.success).not.toHaveBeenCalled();

      if (snapshotMode === 'default') {
        // The HTTP snapshot can already match while the request is pending.
        // A same-mode retry should still report pending and only retry the Team write.
        await act(async () => permission()?.submenu?.onSelect('default'));
        expect(teamSetConfigMock).toHaveBeenCalledOnce();
        expect(Message.info).toHaveBeenCalledTimes(2);
        expect(Message.success).not.toHaveBeenCalled();
      }
      const propagationCount = snapshotMode === 'default' ? 2 : 1;

      teamGetConfigMock.mockResolvedValue({ config_options: [modeOption('default')] });
      await act(async () => {
        for (const listener of responseListeners) {
          listener({
            conversation_id: leaderId,
            msg_id: 'observed-ask',
            type: 'acp_config_option',
            data: { config_options: [modeOption('default')] },
          });
        }
      });
      await waitFor(() => expect(activeMode()).toBe('default'));
      expect(teamSetModeMock).toHaveBeenCalledTimes(propagationCount);

      // An unconfirmed or explicitly unaccepted command cannot elevate the teammate.
      await act(async () => permission()?.submenu?.onSelect('yolo'));
      expect(Message.error).toHaveBeenCalled();
      expect(teamSetModeMock).toHaveBeenCalledTimes(propagationCount);
      expect(teammateMode).toBe('default');
    }
  );

  it('keeps the Team on Ask when a legacy Codex mode selection is only dispatched and later rejected', async () => {
    const actual = await vi.importActual<typeof import('@/renderer/hooks/agent/useAcpConfigOptions')>(
      '@/renderer/hooks/agent/useAcpConfigOptions'
    );
    useAcpConfigOptionsMock.mockImplementation(actual.useAcpConfigOptions);
    isMobileMock.current = true;
    const leaderId = 'unconfirmed-codex-team-leader';
    const ask: AcpConfigOptionDto = {
      id: 'mode',
      category: 'mode',
      type: 'select',
      current_value: ':workspace',
      options: [
        { value: ':workspace', label: 'Ask' },
        { value: ':danger-full-access', label: 'Full Access' },
      ],
    };
    teamGetConfigMock.mockResolvedValue({ config_options: [ask] });
    // Even if the legacy response contains the requested value, its confirmation
    // is only the command write. A later rejection must leave this scope untouched.
    teamSetConfigMock.mockReset().mockResolvedValueOnce({
      confirmation: 'pending_next_turn',
      config_options: [{ ...ask, current_value: ':danger-full-access' }],
    });

    render(
      <TeamPermissionProvider
        team_id='codex-with-aelix-team'
        isLeaderAgent
        leaderConversationId={leaderId}
        allConversationIds={[leaderId, 'aelix-teammate']}
        runtimeStartingConversationIds={new Set()}
      >
        <AcpSendBox
          conversation_id={leaderId}
          backend='codex'
          workspacePath='/tmp/workspace'
          messageState={makeMessageState()}
        />
      </TeamPermissionProvider>
    );

    const permission = () => mobileActionSheetEntries.current.find((entry) => entry.key === 'permission');
    const activeMode = () => permission()?.submenu?.options.find((option) => option.active)?.key;
    await waitFor(() => expect(activeMode()).toBe(':workspace'));
    await act(async () => permission()?.submenu?.onSelect(':danger-full-access'));
    expect(teamSetConfigMock).toHaveBeenCalledOnce();
    expect(teamSetModeMock).not.toHaveBeenCalled();
    expect(Message.error).toHaveBeenCalled();
    expect(Message.success).not.toHaveBeenCalled();

    await act(async () => {
      for (const listener of responseListeners) {
        listener({
          conversation_id: leaderId,
          msg_id: 'refresh-after-rejection',
          type: 'acp_config_option',
          data: { config_options: [ask] },
        });
      }
    });
    expect(activeMode()).toBe(':workspace');
    expect(teamSetModeMock).not.toHaveBeenCalled();
  });

  it('labels the effective Aelix Ask mode in the mobile sheet', () => {
    isMobileMock.current = true;
    useAcpConfigOptionsMock.mockReturnValue({
      mode: {
        id: 'permission_mode',
        category: 'mode',
        currentValue: 'default',
        options: [
          { value: 'default', label: 'Ask' },
          { value: 'yolo', label: 'Yolo' },
        ],
      },
      setStatus: { state: 'idle' },
    });

    render(
      <AcpSendBox
        conversation_id='conv-1'
        backend='acp'
        workspacePath='/tmp/workspace'
        messageState={makeMessageState()}
      />
    );

    const permission = mobileActionSheetEntries.current.find((entry) => entry.key === 'permission');
    expect(permission?.meta).toBe('agentMode.ask');
    expect(permission?.submenu?.options.find((option) => option.key === 'default')).toMatchObject({
      label: 'agentMode.ask',
      active: true,
    });
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

  describe('Aelix running input', () => {
    const renderRunning = () => {
      runtimeViewMock.isProcessing = true;
      runtimeViewMock.state = 'running';
      runtimeViewMock.activeTurnId = 'turn-1';
      runningInputMock.handlesSubmit = true;
      runningInputMock.available = true;
      return render(<AcpSendBox conversation_id='conv-1' backend='aelix' messageState={makeMessageState()} />);
    };
    const lastSendBoxProps = () =>
      sendBoxPropsSpy.mock.calls.at(-1)?.[0] as {
        sendDisabled?: boolean;
        onSend: (message: string, draft: { slashCommand: boolean; hasQuote: boolean }) => Promise<void | false>;
      };

    it('enables send with the mode switch while the relay can take input, and sends nothing ordinary', async () => {
      runningInputMock.submit.mockResolvedValue('sent');
      renderRunning();

      expect(lastSendBoxProps()).toMatchObject({
        sendDisabled: false,
        deferDraftClear: true,
        allowAttachmentOnlySend: false,
      });
      expect(screen.getByTestId('running-input-mode')).toBeInTheDocument();
      await act(async () => {
        screen.getByRole('button', { name: 'send' }).click();
      });

      expect(runningInputMock.submit).toHaveBeenCalledWith(
        'Hello',
        { files: [], sessions: [] },
        { slashCommand: false, hasQuote: false }
      );
      expect(sendMessageInvokeMock).not.toHaveBeenCalled();
      expect(draftMutateMock).not.toHaveBeenCalled();
      expect(messageWarningMock).not.toHaveBeenCalled();
    });

    it('keeps the existing draft and chips when the relay did not accept them', async () => {
      runningInputMock.submit.mockResolvedValue('kept');
      renderRunning();
      fireEvent.click(screen.getByText('pick-session'));
      expect(lastSendBoxProps()).toMatchObject({ allowAttachmentOnlySend: true });

      await act(async () => {
        await expect(lastSendBoxProps().onSend('Hello', { slashCommand: false, hasQuote: false })).resolves.toBe(false);
      });

      expect(sendMessageInvokeMock).not.toHaveBeenCalled();
      expect(lastSendBoxProps()).toMatchObject({ selectedSessions: [{ id: 'conv_target' }] });
      expect(draftMutateMock).not.toHaveBeenCalled();
    });

    it('clears only the submitted session chips when preparation and delivery finish', async () => {
      let finish!: (route: 'sent') => void;
      runningInputMock.submit.mockReturnValue(
        new Promise((resolve) => {
          finish = resolve;
        })
      );
      renderRunning();
      fireEvent.click(screen.getByText('pick-session'));
      let sending: Promise<void | false> | undefined;
      act(() => {
        sending = lastSendBoxProps().onSend('Hello', { slashCommand: false, hasQuote: false });
      });
      fireEvent.click(screen.getByText('pick-another-session'));
      await act(async () => {
        finish('sent');
        await sending;
      });

      expect(runningInputMock.submit).toHaveBeenCalledWith(
        'Hello',
        { files: [], sessions: [{ id: 'conv_target' }] },
        { slashCommand: false, hasQuote: false }
      );
      expect(lastSendBoxProps()).toMatchObject({ selectedSessions: [{ id: 'conv_new' }] });
    });

    it('removes only the submitted upload after a later upload is added to the draft', async () => {
      const file = { kind: 'upload', path: '/tmp/submitted' };
      let finish!: (route: 'sent') => void;
      runningInputMock.submit.mockReturnValue(
        new Promise((resolve) => {
          finish = resolve;
        })
      );
      renderRunning();
      collectChatFileRefsMock.mockReturnValueOnce([file]);
      const send = lastSendBoxProps().onSend('Hello', { slashCommand: false, hasQuote: false });
      await act(async () => {
        finish('sent');
        await send;
      });

      expect(runningInputMock.submit).toHaveBeenCalledWith(
        'Hello',
        { files: [file], sessions: [] },
        { slashCommand: false, hasQuote: false }
      );
      const update = draftMutateMock.mock.calls.at(-1)?.[0] as (draft: { uploadFile: string[] }) => {
        uploadFile: string[];
      };
      expect(update({ uploadFile: [file.path, '/tmp/added-during-validation'] }).uploadFile).toEqual([
        '/tmp/added-during-validation',
      ]);
    });

    it('keeps the existing busy block when the relay is not negotiated', async () => {
      runtimeViewMock.isProcessing = true;
      runtimeViewMock.state = 'running';
      render(<AcpSendBox conversation_id='conv-1' backend='claude' messageState={makeMessageState()} />);

      expect(lastSendBoxProps().sendDisabled).toBe(true);
      expect(screen.queryByTestId('running-input-mode')).toBeNull();
      await act(async () => {
        screen.getByRole('button', { name: 'send' }).click();
      });
      expect(runningInputMock.submit).not.toHaveBeenCalled();
      expect(sendMessageInvokeMock).not.toHaveBeenCalled();
      expect(messageWarningMock).toHaveBeenCalledTimes(1);
    });

    it('sends the complete slash-prefixed reply body and all references on ordinary admission', async () => {
      runningInputMock.handlesSubmit = true;
      sendMessageInvokeMock.mockResolvedValue({ turn_id: 'next', runtime: null, msg_id: 'message' });
      render(<AcpSendBox conversation_id='conv-1' backend='aelix' messageState={makeMessageState()} />);
      fireEvent.click(screen.getByText('pick-session'));
      const file = { kind: 'upload', path: '/tmp/selected' };
      collectChatFileRefsMock.mockReturnValueOnce([file]);
      const input = '> Quoted reply\n\n/tmp/report\n\n---\nDOM Snippet (p):\n```html\n<p>Selected</p>\n```';
      const draft = { slashCommand: true, hasQuote: true };
      await act(async () => {
        await lastSendBoxProps().onSend(input, draft);
      });
      const references = { files: [file], sessions: [{ id: 'conv_target' }] };
      expect(runningInputMock.submit).toHaveBeenCalledWith(input, references, draft);
      expect(sendMessageInvokeMock).toHaveBeenCalledWith({ conversation_id: 'conv-1', input, ...references });
    });

    it('checks the live host turn before posting even if React has not rerendered', async () => {
      runningInputMock.handlesSubmit = true;
      let finish!: (route: 'ordinary') => void;
      runningInputMock.submit.mockReturnValueOnce(
        new Promise((resolve) => {
          finish = resolve;
        })
      );
      render(<AcpSendBox conversation_id='conv-1' backend='aelix' messageState={makeMessageState()} />);
      fireEvent.click(screen.getByText('pick-session'));
      const sending = lastSendBoxProps().onSend('Hello', { slashCommand: false, hasQuote: false });
      runtimeViewMock.activeTurnId = 'claimed-in-another-tab';
      await act(async () => {
        finish('ordinary');
        await expect(sending).resolves.toBe(false);
      });
      expect(sendMessageInvokeMock).not.toHaveBeenCalled();
      expect(lastSendBoxProps()).toMatchObject({ selectedSessions: [{ id: 'conv_target' }] });
    });

    it('keeps the ordinary draft when hydration completed without a host runtime summary', async () => {
      runtimeViewMock.hasBackendRuntime = false;
      runningInputMock.handlesSubmit = true;
      render(<AcpSendBox conversation_id='conv-1' backend='aelix' messageState={makeMessageState()} />);
      expect(useRunningInputSpy.mock.calls.at(-1)?.[0]).toMatchObject({ host: 'unknown' });
      await act(async () => {
        await expect(lastSendBoxProps().onSend('Hello', { slashCommand: false, hasQuote: false })).resolves.toBe(false);
      });
      expect(sendMessageInvokeMock).not.toHaveBeenCalled();
    });

    it('interrupts pending discovery even when there is no host turn to cancel', async () => {
      runningInputMock.handlesSubmit = true;
      runningInputMock.available = false;
      let finish!: (route: 'kept') => void;
      runningInputMock.submit.mockReturnValueOnce(
        new Promise((resolve) => {
          finish = resolve;
        })
      );
      render(<AcpSendBox conversation_id='conv-1' backend='aelix' messageState={makeMessageState()} />);
      expect(lastSendBoxProps()).toMatchObject({ deferDraftClear: true });
      const pending = lastSendBoxProps().onSend('Hello', { slashCommand: false, hasQuote: false });
      await act(async () => {
        await sendBoxPropsSpy.mock.calls.at(-1)?.[0].onStop();
        finish('kept');
        await pending;
      });
      expect(runningInputMock.beginStop).toHaveBeenCalledOnce();
      expect(runningInputMock.finishStop).toHaveBeenCalledWith('failed');
      expect(stopInvokeMock).not.toHaveBeenCalled();
      expect(sendMessageInvokeMock).not.toHaveBeenCalled();
    });

    it('reports a failed host Stop to the running-input controller', async () => {
      getMessagesInvokeMock.mockResolvedValue({
        items: [{ type: 'text', position: 'right', content: { content: 'Keep working' } }],
      });
      stopInvokeMock.mockRejectedValueOnce(new Error('Stop failed'));
      renderRunning();
      await waitFor(() => expect(sendBoxPropsSpy.mock.calls.at(-1)?.[0].onStop).toBeTypeOf('function'));
      await act(async () => sendBoxPropsSpy.mock.calls.at(-1)?.[0].onStop());
      expect(runningInputMock.finishStop).toHaveBeenCalledWith('failed');
      expect(runtimeViewMock.resetLocalGate).toHaveBeenCalledWith('stop_failed');
    });

    it('keeps text and attachments when an ordinary send loses the host turn', async () => {
      runningInputMock.handlesSubmit = true;
      sendMessageInvokeMock.mockRejectedValue(
        new BackendHttpError({
          method: 'POST',
          path: '/api/conversations/conv-1/messages',
          status: 409,
          body: { success: false, code: 'CONFLICT', error: 'conversation conv-1 is already running' },
        })
      );
      render(<AcpSendBox conversation_id='conv-1' backend='aelix' messageState={makeMessageState()} />);

      await act(async () => {
        screen.getByText('pick-session').click();
      });
      await act(async () => {
        screen.getByRole('button', { name: 'send' }).click();
      });

      expect(sendMessageInvokeMock).toHaveBeenCalledTimes(1);
      expect(draftMutateMock).not.toHaveBeenCalled();
      expect(lastSendBoxProps()).toMatchObject({ selectedSessions: [{ id: 'conv_target' }] });
      expect(messageWarningMock).toHaveBeenCalledWith('acp.runningInput.ordinaryBusyKept');
    });

    it('records Stop for receipts and leaves team chats on their own path', async () => {
      getMessagesInvokeMock.mockResolvedValue({
        items: [{ type: 'text', position: 'right', content: { content: 'Keep working' } }],
      });
      stopInvokeMock.mockResolvedValue({ runtime: null });
      renderRunning();
      await waitFor(() => expect(sendBoxPropsSpy.mock.calls.at(-1)?.[0].onStop).toBeTypeOf('function'));
      await act(async () => sendBoxPropsSpy.mock.calls.at(-1)?.[0].onStop());
      expect(runningInputMock.beginStop).toHaveBeenCalledExactlyOnceWith('turn-1');
      expect(runningInputMock.finishStop).toHaveBeenCalledWith('done');
      expect(stopInvokeMock).toHaveBeenCalledWith({ conversation_id: 'conv-1', turn_id: 'turn-1' });
      expect(useRunningInputSpy.mock.calls.at(-1)?.[0]).toMatchObject({ enabled: true, host: 'busy' });
      expect(useRunningInputSpy.mock.calls.at(-1)?.[0].enablePixels).toBeUndefined();

      render(
        <AcpSendBox
          conversation_id='conv-1'
          backend='aelix'
          messageState={makeMessageState()}
          teamSendMessage={vi.fn().mockResolvedValue(undefined)}
        />
      );
      expect(useRunningInputSpy.mock.calls.at(-1)?.[0]).toMatchObject({ enabled: false });
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

    it('holds the Draft Box queue and disables its send-now while the session holder check blocks sending', async () => {
      const queueArgs = () =>
        useConversationCommandQueueSpy.mock.calls.at(-1)?.[0] as { holdExecution?: boolean } | undefined;
      const panelProps = () =>
        commandQueuePanelPropsSpy.mock.calls.at(-1)?.[0] as { sendNowDisabledReason?: string } | undefined;
      const { rerender } = render(
        <AcpSendBox conversation_id='conv-1' backend='aelix' messageState={makeMessageState()} sendBlocked />
      );
      expect(queueArgs()?.holdExecution).toBe(true);
      expect(panelProps()?.sendNowDisabledReason).toBe('conversation.sessionHolder.checking');
      await act(async () => getOnSendNow()(queuedItem));
      expect(sendMessageInvokeMock).not.toHaveBeenCalled();
      expect(removeMock).not.toHaveBeenCalled();
      expect(stopInvokeMock).not.toHaveBeenCalled();

      rerender(<AcpSendBox conversation_id='conv-1' backend='aelix' messageState={makeMessageState()} />);
      expect(queueArgs()?.holdExecution).toBe(false);
      expect(panelProps()?.sendNowDisabledReason).toBeUndefined();
    });

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
        submitted = original.onSend('/compact keep decisions', { slashCommand: true, hasQuote: false });
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
