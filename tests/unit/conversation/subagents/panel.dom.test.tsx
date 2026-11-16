import React from 'react';
import { render, screen, within, fireEvent } from '@testing-library/react';
import { ipcBridge } from '@/common';
import { describe, expect, it, vi } from 'vitest';
import type { IMessageAcpToolCall } from '@/common/chat/chatLib';
import SubagentProgressPanel from '@/renderer/pages/conversation/Messages/acp/SubagentProgress';
import MessageToolGroupSummary from '@/renderer/pages/conversation/Messages/components/MessageToolGroupSummary';
import fixture from './frames.json';
import native from './nativeFrames.json';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'en-US' },
    t: (key: string, args?: Record<string, unknown>) =>
      args?.value !== undefined ? `${key}: ${String(args.value)}` : key,
  }),
}));
vi.mock('@/common', () => ({ ipcBridge: { database: { getConversationMessage: { invoke: vi.fn() } } } }));
vi.mock('@/renderer/components/media/LocalImageView', () => ({ default: () => null }));
vi.mock('@arco-design/web-react', async () => ({
  ...(await vi.importActual<typeof import('@arco-design/web-react')>('@arco-design/web-react')),
  Message: { useMessage: () => [{ success: vi.fn(), error: vi.fn() }, null] },
}));

const value = (name: string) => fixture.frames.find((frame) => frame.name === name)!.update._meta['aelix/subagents'];
const message = (snapshot: unknown, id = 'call-one', result = ''): IMessageAcpToolCall => ({
  id,
  type: 'acp_tool_call',
  conversation_id: 'conv',
  msg_id: id,
  content: {
    session_id: 'parent-session',
    _meta: { 'aelix/subagents': snapshot },
    update: {
      sessionUpdate: 'tool_call_update',
      tool_call_id: id,
      title: 'agent',
      kind: 'execute',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: result } }],
    },
  },
});

describe('subagent progress display', () => {
  it.each(['starting', 'running', 'done', 'error', 'stopped', 'unknown'])('shows a readable %s state', (state) => {
    render(<SubagentProgressPanel value={{ version: 1, children: [{ ...value('running').children[0], state }] }} />);
    expect(screen.getByText(`acp.subagents.states.${state}`)).toBeInTheDocument();
  });

  it('shows the tool, reported elapsed time and zero usage without hiding zero', () => {
    render(<SubagentProgressPanel value={value('documented')} />);
    expect(screen.getByText('acp.subagents.tool: read')).toBeInTheDocument();
    expect(screen.getByText('acp.subagents.elapsed: 2.3')).toBeInTheDocument();
    expect(screen.getByText('acp.subagents.tokens: 0')).toBeInTheDocument();
    expect(screen.getByText('acp.subagents.cost: 0')).toBeInTheDocument();
  });

  it('shows unavailable counters when fields are absent', () => {
    render(<SubagentProgressPanel value={{ version: 1, children: [{ id: 'partial' }] }} />);
    expect(screen.getByText('acp.subagents.tokens: acp.subagents.unavailable')).toBeInTheDocument();
  });

  it('preserves the exact integer token count', () => {
    render(<SubagentProgressPanel value={{ version: 1, children: [{ id: 'large', tokens: 1234567 }] }} />);
    expect(screen.getByText('acp.subagents.tokens: 1,234,567')).toBeInTheDocument();
  });

  it('keeps the ordinary tool view for a future version', () => {
    render(<MessageToolGroupSummary messages={[message({ version: 2, children: [{ id: 'future' }] })]} />);
    fireEvent.click(screen.getByText(/View Steps/));
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
    expect(screen.getByText('agent')).toBeInTheDocument();
  });

  it('updates child rows in place and exposes interrupted work in the parent tool result', () => {
    const { rerender } = render(<MessageToolGroupSummary messages={[message(value('twoChildren'))]} />);
    const first = screen.getAllByRole('listitem')[0];
    rerender(<MessageToolGroupSummary messages={[message(value('stopped'), 'call-one', 'PARTIAL_CHILD_WORK')]} />);
    expect(screen.getAllByRole('listitem')[0]).toBe(first);
    expect(screen.getByText('acp.subagents.states.stopped')).toBeInTheDocument();
    expect(screen.getByText('PARTIAL_CHILD_WORK')).toBeInTheDocument();
  });

  it('restores the panel and partial result from a serialized history message', () => {
    const saved = JSON.parse(JSON.stringify(message(value('stopped'), 'call-one', 'SAVED_PARTIAL_WORK')));
    const { unmount } = render(<MessageToolGroupSummary messages={[saved]} />);
    unmount();
    render(<MessageToolGroupSummary messages={[JSON.parse(JSON.stringify(saved))]} />);
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByText('SAVED_PARTIAL_WORK')).toBeInTheDocument();
  });

  it('automatically loads the complete interrupted result from compact history', async () => {
    vi.mocked(ipcBridge.database.getConversationMessage.invoke).mockResolvedValueOnce(
      message(value('stopped'), 'compact', 'FULL_INTERRUPTED_RESULT')
    );
    const saved = {
      ...message(value('stopped'), 'compact', 'preview'),
      content: {
        ...message(value('stopped'), 'compact', 'preview').content,
        _compact: { truncated: true },
      },
    };
    render(<MessageToolGroupSummary messages={[saved]} />);
    expect(await screen.findByText('FULL_INTERRUPTED_RESULT')).toBeInTheDocument();
  });

  it('renders a resumed run under its new parent call without linking progress IDs', () => {
    const calls = native.frames.filter((frame) => frame.scenario === 'completedChildResumed');
    const old = calls[0].content._meta['aelix/subagents'];
    const resumed = calls[1].content._meta['aelix/subagents'];
    render(<MessageToolGroupSummary messages={[message(old, 'old'), message(resumed, 'resumed')]} />);
    const lists = screen.getAllByRole('list');
    expect(within(lists[0]).getAllByRole('listitem')).toHaveLength(2);
    expect(within(lists[1]).getAllByRole('listitem')).toHaveLength(1);
    expect(within(lists[1]).getByRole('listitem')).toHaveAttribute('data-subagent-id', resumed.children[0].id);
  });
});
