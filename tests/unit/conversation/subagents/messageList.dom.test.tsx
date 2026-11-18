import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IMessageAcpToolCall } from '@/common/chat/chatLib';
import type { TConversationRuntimeSummary } from '@/common/config/storage';
import MessageList from '@/renderer/pages/conversation/Messages/MessageList';
import { MessageListProvider, useUpdateMessageList } from '@/renderer/pages/conversation/Messages/hooks';
import {
  getConversationRuntimeViewSnapshot,
  localSendAccepted,
  localSendStarted,
  localStopAcknowledged,
  localStopRequested,
  resetConversationRuntimeViewStoreForTest,
  turnCompleted,
} from '@/renderer/pages/conversation/runtime/conversationRuntimeViewStore';

const { conversation, summaryProps } = vi.hoisted(() => ({
  conversation: vi.fn(),
  summaryProps: vi.fn(),
}));
vi.mock('@/common', () => ({
  ipcBridge: {
    conversation: { turnCompleted: { on: () => () => {} }, listChanged: { on: () => () => {} } },
    database: { getConversationMessage: { invoke: vi.fn() } },
  },
}));
vi.mock('@/renderer/pages/conversation/utils/conversationCache', () => ({ getConversationOrNull: conversation }));
vi.mock('@/renderer/pages/conversation/GroupedHistory/hooks/useConversationListSync', () => ({
  reconcileGeneratingFromRuntime: vi.fn(),
  reconcileWaitingConfirmationFromRuntime: vi.fn(),
}));
vi.mock('@/renderer/hooks/context/ConversationContext', () => ({
  useConversationContextSafe: () => ({ conversation_id: 'conv' }),
}));
vi.mock('react-router-dom', () => ({ useLocation: () => ({ key: 'test', state: {} }) }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ i18n: { language: 'en-US' }, t: (key: string) => key }),
}));
vi.mock('@arco-design/web-react', async () => ({
  ...(await vi.importActual<typeof import('@arco-design/web-react')>('@arco-design/web-react')),
  Message: { useMessage: () => [{ success: vi.fn(), error: vi.fn() }, null] },
}));
vi.mock('@/renderer/components/media/LocalImageView', () => ({ default: () => null }));
vi.mock('@/renderer/pages/conversation/Messages/artifacts', () => ({ useConversationArtifacts: () => [] }));
vi.mock('@/renderer/pages/conversation/Messages/anchorRail', () => ({ MessageAnchorRail: () => null }));
vi.mock('@/renderer/pages/conversation/Messages/components/SelectionReplyButton', () => ({ default: () => null }));
vi.mock('@/renderer/pages/conversation/Messages/useAutoScroll', () => ({
  useAutoScroll: () => ({
    handleScrollerRef: () => {},
    handleContentRef: () => {},
    handleScroll: () => {},
    handleWheel: () => {},
    handlePointerDown: () => {},
    showScrollButton: false,
    scrollElementIntoView: () => {},
    hideScrollButton: () => {},
  }),
}));
vi.mock('@/renderer/pages/conversation/Messages/components/MessageToolGroupSummary', async () => {
  const { default: Summary } = await vi.importActual<
    typeof import('@/renderer/pages/conversation/Messages/components/MessageToolGroupSummary')
  >('@/renderer/pages/conversation/Messages/components/MessageToolGroupSummary');
  return {
    default: (props: React.ComponentProps<typeof Summary>) => {
      summaryProps(props);
      return <Summary {...props} />;
    },
  };
});

const idle: TConversationRuntimeSummary = {
  state: 'idle',
  can_send_message: true,
  has_task: true,
  task_status: 'finished',
  is_processing: false,
  pending_confirmations: 0,
  turn_id: null,
};
const running: TConversationRuntimeSummary = {
  ...idle,
  state: 'running',
  is_processing: true,
  can_send_message: false,
  task_status: 'running',
  turn_id: 'local-turn',
};
const frame = (
  state = 'running',
  elapsedMs = 10,
  status: IMessageAcpToolCall['content']['update']['status'] = 'in_progress'
): IMessageAcpToolCall => ({
  id: 'call',
  conversation_id: 'conv',
  type: 'acp_tool_call',
  content: {
    session_id: 'session',
    _meta: { 'aelix/subagents': { version: 1, children: [{ id: 'child', state, elapsedMs }] } },
    update: { sessionUpdate: 'tool_call_update', tool_call_id: 'call', title: 'agent', status },
  },
});
let publish: ReturnType<typeof useUpdateMessageList>;
const MessageFeed = () => {
  publish = useUpdateMessageList();
  return null;
};
const list = (messages: IMessageAcpToolCall[]) => (
  <MessageListProvider value={messages}>
    <MessageFeed />
    <MessageList />
  </MessageListProvider>
);
const busy = (container: HTMLElement) => container.querySelector('.tool-group-summary__header .arco-spin');

// Real hook + real store functions: a fully hydrated idle snapshot is deliberate,
// unlike the older MessageList tests whose partial mock omitted view/hydrated.
describe('MessageList subagent lifecycle with the real runtime view', () => {
  beforeEach(() => {
    resetConversationRuntimeViewStoreForTest();
    conversation.mockResolvedValue({ runtime: idle });
    summaryProps.mockClear();
  });

  it.each(['Team send', 'scheduled run', 'other-client send'])(
    'preserves the first live frame and every later frame after idle hydration: %s',
    async () => {
      const { container } = render(list([]));
      await waitFor(() =>
        expect(getConversationRuntimeViewSnapshot('conv')).toMatchObject({
          hydrated: true,
          hasBackendRuntime: true,
          isProcessing: false,
        })
      );
      for (const elapsed of [10, 20, 30]) {
        act(() => publish([frame('running', elapsed)]));
        // Synchronous assertions catch even a first-frame flash before effects.
        expect(screen.getByRole('listitem')).toHaveAttribute('data-subagent-state', 'running');
        expect(busy(container)).not.toBeNull();
        expect(screen.queryByText('acp.subagents.states.ended')).not.toBeInTheDocument();
      }
    }
  );

  it('never derives a call turn from known/idle while mounting or receiving its first frame', async () => {
    const { container } = render(list([frame()]));
    expect(screen.getByRole('listitem')).toHaveAttribute('data-subagent-state', 'running');
    await waitFor(() => expect(getConversationRuntimeViewSnapshot('conv').hydrated).toBe(true));
    expect(busy(container)).not.toBeNull();
    expect(summaryProps.mock.calls.every(([props]) => !('turn' in props))).toBe(true);
  });

  it('keeps local live work running and trusts stopped children after a local cancel', async () => {
    const { container } = render(list([]));
    await waitFor(() => expect(getConversationRuntimeViewSnapshot('conv').hydrated).toBe(true));
    act(() => {
      localSendStarted('conv');
      localSendAccepted('conv', 'local-turn', running);
    });
    act(() => publish([frame()]));
    expect(busy(container)).not.toBeNull();
    act(() => {
      localStopRequested('conv', 'local-turn');
      localStopAcknowledged('conv', 'local-turn', idle);
    });
    act(() => publish([frame('stopped')]));
    expect(screen.getByRole('listitem')).toHaveAttribute('data-subagent-state', 'stopped');
    expect(busy(container)).toBeNull();
  });

  it('restores a dead call with an explicit terminal parent without a spinner', async () => {
    const saved = JSON.parse(JSON.stringify(frame('running', 10, 'failed')));
    const first = render(list([saved]));
    await waitFor(() => expect(getConversationRuntimeViewSnapshot('conv').hydrated).toBe(true));
    first.unmount();
    const { container } = render(list([JSON.parse(JSON.stringify(saved))]));
    expect(screen.getByRole('listitem')).toHaveAttribute('data-subagent-state', 'ended');
    expect(busy(container)).toBeNull();
  });

  it('restores an unfinished parent with reported stopped children without a spinner', async () => {
    const saved = JSON.parse(JSON.stringify(frame('stopped')));
    const { container } = render(list([saved]));
    await waitFor(() => expect(getConversationRuntimeViewSnapshot('conv').hydrated).toBe(true));
    expect(screen.getByRole('listitem')).toHaveAttribute('data-subagent-state', 'stopped');
    expect(busy(container)).toBeNull();
  });

  it.each(['running', 'done', 'error'])(
    'retains an ambiguous reopened unfinished call with %s children instead of inventing cancellation',
    async (state) => {
      const { container } = render(list([JSON.parse(JSON.stringify(frame(state)))]));
      await waitFor(() => expect(getConversationRuntimeViewSnapshot('conv').hydrated).toBe(true));
      expect(screen.getByRole('listitem')).toHaveAttribute('data-subagent-state', state);
      expect(busy(container)).not.toBeNull();
    }
  );

  it('retains a spinner if local completion or stop arrives without a call/child terminal update', async () => {
    const { container } = render(list([frame()]));
    await waitFor(() => expect(getConversationRuntimeViewSnapshot('conv').hydrated).toBe(true));
    act(() => {
      localSendStarted('conv');
      localSendAccepted('conv', 'local-turn', running);
      localStopRequested('conv', 'local-turn');
      localStopAcknowledged('conv', 'local-turn', idle);
      turnCompleted('conv', 'local-turn', idle);
    });
    expect(screen.getByRole('listitem')).toHaveAttribute('data-subagent-state', 'running');
    expect(busy(container)).not.toBeNull();
  });
});
