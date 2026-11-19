import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ipcBridge } from '@/common';
import type { TMessage } from '@/common/chat/chatLib';
import type { ToolMessage } from '@/common/chat/normalizeToolCall';
import MessageToolGroupSummary from '@/renderer/pages/conversation/Messages/components/MessageToolGroupSummary';
import contextControls from '../../fixtures/aelix-context-controls.json';

vi.mock('@/common', () => ({
  ipcBridge: {
    database: {
      getConversationMessage: {
        invoke: vi.fn(),
      },
    },
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { resolvedLanguage: 'en-US' },
    t: (key: string, values?: { tokens: string }) => (values ? `${key} ${values.tokens}` : key),
  }),
}));

describe('MessageToolGroupSummary', () => {
  it('renders an unconfirmed deadline outcome on the steps surface', () => {
    const message: ToolMessage = {
      id: 'compact-deadline',
      conversation_id: 'conversation-1',
      type: 'acp_tool_call',
      content: {
        sessionId: 'session',
        _meta: { 'aelix/compaction': { reason: 'manual', state: 'unknown' } },
        update: {
          sessionUpdate: 'tool_call_update',
          tool_call_id: 'deadline-compact',
          title: '/compact',
          status: 'failed',
          kind: 'execute',
        },
      },
    };
    render(<MessageToolGroupSummary messages={[message]} />);
    expect(screen.getByRole('status')).toHaveTextContent('acp.compaction.unknown');
  });

  it('renders the compaction result on the existing steps surface', () => {
    const completion = contextControls.manualCompactionCompleted;
    const message: ToolMessage = {
      id: 'compact-message',
      conversation_id: 'conversation-1',
      type: 'acp_tool_call',
      content: {
        sessionId: 'session',
        _meta: completion._meta,
        update: {
          sessionUpdate: 'tool_call_update',
          tool_call_id: completion.toolCallId,
          title: '/compact',
          status: 'completed',
          kind: 'execute',
        },
      },
    };
    render(<MessageToolGroupSummary messages={[message]} />);
    expect(screen.getByRole('status')).toHaveTextContent('18,432');
  });

  it('loads full tool content when expanding a compact history item', async () => {
    const invoke = vi.mocked(ipcBridge.database.getConversationMessage.invoke);
    invoke.mockResolvedValue({
      id: 'message-1',
      conversation_id: 'conversation-1',
      type: 'acp_tool_call',
      content: {
        update: {
          session_update: 'tool_call',
          tool_call_id: 'tool-1',
          status: 'completed',
          title: 'rg',
          kind: 'search',
          raw_input: { pattern: 'needle', path: '.' },
          content: [{ type: 'content', content: { type: 'text', text: 'full output' } }],
        },
      },
    } as unknown as TMessage);

    render(
      <MessageToolGroupSummary
        messages={[
          {
            id: 'message-1',
            conversation_id: 'conversation-1',
            type: 'acp_tool_call',
            content: {
              _compact: {
                truncated: true,
                original_size: 90000,
                preview_chars: 4096,
              },
              update: {
                session_update: 'tool_call',
                tool_call_id: 'tool-1',
                status: 'completed',
                title: 'rg',
                kind: 'search',
                raw_input: { pattern: 'needle', path: '.' },
                content: [{ type: 'content', content: { type: 'text', text: 'preview' } }],
              },
            },
          } as unknown as ToolMessage,
        ]}
      />
    );

    fireEvent.click(screen.getByText('View Steps · 1'));
    fireEvent.click(screen.getByText('rg'));

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith({
        conversation_id: 'conversation-1',
        message_id: 'message-1',
      });
    });
    expect(await screen.findByText('full output')).toBeInTheDocument();
  });
});
