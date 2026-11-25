import React from 'react';
import { render, screen, within, fireEvent } from '@testing-library/react';
import { ipcBridge } from '@/common';
import { describe, expect, it, vi } from 'vitest';
import { mergeAcpToolCallContent, type IMessageAcpToolCall } from '@/common/chat/chatLib';
import SubagentProgressPanel, {
  presentSubagentTool,
} from '@/renderer/pages/conversation/Messages/acp/SubagentProgress';
import MessageToolGroupSummary from '@/renderer/pages/conversation/Messages/components/MessageToolGroupSummary';
import fixture from './frames.json';
import native from './nativeFrames.json';
import cancelReports from './cancelReports.json';
import * as parser from '@/renderer/pages/conversation/Messages/acp/SubagentProgress/parser';

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
const panel = (snapshot: unknown) => (
  <SubagentProgressPanel progress={presentSubagentTool({ 'aelix/subagents': snapshot }, 'running')!.progress} />
);
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
    render(panel({ version: 1, children: [{ ...value('running').children[0], state }] }));
    expect(screen.getByText(`acp.subagents.states.${state}`)).toBeInTheDocument();
  });

  it('shows the tool, reported elapsed time and zero usage without hiding zero', () => {
    render(panel(value('documented')));
    expect(screen.getByText('acp.subagents.tool: read')).toBeInTheDocument();
    expect(screen.getByText('acp.subagents.elapsedReported: 2.3')).toBeInTheDocument();
    expect(screen.getByText('acp.subagents.tokens: 0')).toBeInTheDocument();
    expect(screen.getByText('acp.subagents.cost: 0')).toBeInTheDocument();
  });

  it('shows unavailable counters when fields are absent', () => {
    render(panel({ version: 1, children: [{ id: 'partial' }] }));
    expect(screen.getByText('acp.subagents.tokens: acp.subagents.unavailable')).toBeInTheDocument();
  });

  it('preserves the exact integer token count', () => {
    render(panel({ version: 1, children: [{ id: 'large', tokens: 1234567 }] }));
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

  it('stops parent busy indicators when all children ended and a child stopped', () => {
    const saved = message(value('stopped'));
    saved.content.update.status = 'in_progress';
    const { container } = render(<MessageToolGroupSummary messages={[saved]} />);
    expect(container.querySelector('.tool-group-summary__header .arco-spin')).toBeNull();
    expect(container.querySelector('.arco-badge-status-processing')).toBeNull();
  });

  it('keeps the parent busy while a sibling is still running', () => {
    const snapshot = value('stopped');
    const saved = message({
      ...snapshot,
      children: snapshot.children.map((child, index) => (index === 0 ? { ...child, state: 'running' } : child)),
    });
    saved.content.update.status = 'in_progress';
    const { container } = render(<MessageToolGroupSummary messages={[saved]} />);
    expect(container.querySelector('.tool-group-summary__header .arco-spin')).not.toBeNull();
  });

  it('renders a resumed run under its new parent call without linking progress IDs', () => {
    const calls = native.frames.filter((frame) => frame.scenario === 'stoppedChildResumed');
    const old = calls[0].content._meta['aelix/subagents'];
    const resumed = calls[1].content._meta['aelix/subagents'];
    render(<MessageToolGroupSummary messages={[message(old, 'old'), message(resumed, 'resumed')]} />);
    const lists = screen.getAllByRole('list');
    expect(within(lists[0]).getAllByRole('listitem')).toHaveLength(2);
    expect(within(lists[1]).getAllByRole('listitem')).toHaveLength(1);
    expect(within(lists[1]).getByRole('listitem')).toHaveAttribute('data-subagent-id', resumed.children[0].id);
  });

  it('preserves a user-collapsed subagent group when the delegation finishes', () => {
    const running = message(value('running'));
    running.content.update.status = 'in_progress';
    const { rerender } = render(<MessageToolGroupSummary messages={[running]} />);
    fireEvent.click(screen.getByText(/View Steps/));
    const complete = value('completed');
    rerender(
      <MessageToolGroupSummary
        messages={[message({ ...complete, children: complete.children.map((child) => ({ ...child, state: 'done' })) })]}
      />
    );
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
  });

  it('parses each extension item once and never parses an ordinary tool', () => {
    const spy = vi.spyOn(parser, 'parseSubagentProgress');
    const { unmount } = render(<MessageToolGroupSummary messages={[message(value('documented'))]} />);
    expect(spy).toHaveBeenCalledTimes(1);
    unmount();
    spy.mockClear();
    const ordinary = message(undefined);
    delete ordinary.content._meta;
    render(<MessageToolGroupSummary messages={[ordinary]} />);
    fireEvent.click(screen.getByText(/View Steps/));
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('ends stale child rows only when the parent call explicitly ended', () => {
    const running = message({ version: 1, children: [{ id: 'late', state: 'running' }] });
    running.content.update.status = 'failed';
    const { container } = render(<MessageToolGroupSummary messages={[running]} />);
    expect(screen.getByText('acp.subagents.states.ended')).toBeInTheDocument();
    expect(container.querySelector('.arco-badge-status-processing')).toBeNull();
  });

  it('retains ordinary compact-tool expansion and exactly one full-message lookup', async () => {
    const ordinary = message(undefined, 'ordinary', 'preview');
    delete ordinary.content._meta;
    ordinary.content.update.title = 'ordinary-tool';
    const compact = { ...ordinary, content: { ...ordinary.content, _compact: { truncated: true } } };
    vi.mocked(ipcBridge.database.getConversationMessage.invoke)
      .mockClear()
      .mockResolvedValueOnce({
        ...ordinary,
        content: {
          ...ordinary.content,
          update: {
            ...ordinary.content.update,
            content: [{ type: 'content', content: { type: 'text', text: 'ORDINARY_FULL' } }],
          },
        },
      });
    render(<MessageToolGroupSummary messages={[compact]} />);
    expect(ipcBridge.database.getConversationMessage.invoke).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText(/View Steps/));
    fireEvent.click(screen.getByText('ordinary-tool'));
    expect(await screen.findByText('ORDINARY_FULL')).toBeInTheDocument();
    expect(ipcBridge.database.getConversationMessage.invoke).toHaveBeenCalledTimes(1);
  });
});

describe('cancelled children report', () => {
  const stoppedPair = native.frames[0].content._meta['aelix/subagents'];
  const cancelled = (text: string, id = 'cancelled') => {
    const saved = message(stoppedPair, id, text);
    saved.content.update.status = 'failed';
    return saved;
  };
  const report = (container: HTMLElement) => container.querySelector('[data-subagent-report]');
  const entry = (container: HTMLElement, position: number) =>
    container.querySelector(`[data-subagent-report-position="${position}"]`);

  it('shows what each of two stopped children did right after the cancel', () => {
    const { container } = render(<MessageToolGroupSummary messages={[cancelled(cancelReports.reports.twoStopped)]} />);
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(entry(container, 1)).toHaveTextContent('PARTIAL_CHILD_CANCEL_A');
    expect(entry(container, 2)).toHaveTextContent('PARTIAL_CHILD_CANCEL_B');
    expect(entry(container, 1)).not.toHaveTextContent('PARTIAL_CHILD_CANCEL_B');
  });

  it('splits the persisted row captured from the pinned native and host', () => {
    const captured = native.frames.find((frame) => frame.scenario === 'cancelledReport')!;
    const saved = {
      id: 'captured',
      type: 'acp_tool_call',
      conversation_id: 'conv',
      msg_id: 'captured',
      content: JSON.parse(JSON.stringify(captured.content)),
    } as IMessageAcpToolCall;
    const { container } = render(<MessageToolGroupSummary messages={[saved]} />);
    expect(container.querySelectorAll('[data-subagent-state="stopped"]')).toHaveLength(2);
    expect(entry(container, 1)).toHaveTextContent('PARTIAL_CHILD_CANCEL_A');
    expect(entry(container, 2)).toHaveTextContent('PARTIAL_CHILD_CANCEL_B');
  });

  it('adds the report when the cancelled call result arrives after the stopped rows', () => {
    const live = message(stoppedPair, 'live');
    live.content.update.status = 'in_progress';
    const { container, rerender } = render(<MessageToolGroupSummary messages={[live]} />);
    expect(report(container)).toBeNull();
    rerender(<MessageToolGroupSummary messages={[cancelled(cancelReports.reports.twoStopped, 'live')]} />);
    expect(report(container)).toHaveAttribute('data-subagent-report', 'batch');
  });

  it('keeps the report through a merged final update and a later metadata-only update', () => {
    const live = message(stoppedPair, 'merged');
    live.content.update.status = 'in_progress';
    live.content.update.content = [];
    const final = cancelled(cancelReports.reports.twoStopped, 'merged');
    const late = {
      session_id: 'parent-session',
      _meta: { 'aelix/subagents': stoppedPair },
      update: { sessionUpdate: 'tool_call_update', tool_call_id: 'merged' },
    } as unknown as IMessageAcpToolCall['content'];
    const merged = mergeAcpToolCallContent(mergeAcpToolCallContent(live.content, final.content), late);
    const reopened = JSON.parse(JSON.stringify({ ...live, content: merged }));
    const { container } = render(<MessageToolGroupSummary messages={[reopened]} />);
    expect(entry(container, 1)).toHaveTextContent('PARTIAL_CHILD_CANCEL_A');
    expect(entry(container, 2)).toHaveTextContent('PARTIAL_CHILD_CANCEL_B');
  });

  it('does not repeat a split report in the auto-expanded raw output', () => {
    const { container } = render(<MessageToolGroupSummary messages={[cancelled(cancelReports.reports.twoStopped)]} />);
    expect(report(container)).toHaveAttribute('data-subagent-report', 'batch');
    expect(container.querySelector('.tool-detail-panel')).toBeNull();
  });

  it('keeps the raw output open as the fallback for a report notice', () => {
    const { container } = render(<MessageToolGroupSummary messages={[cancelled('Tool call was cut.')]} />);
    expect(report(container)).toHaveAttribute('data-subagent-report', 'missing');
    expect(container.querySelector('.tool-detail-panel')).not.toBeNull();
  });

  it('fetches a compact row only after its call ended, then shows the report instead of missing', async () => {
    const invoke = vi.mocked(ipcBridge.database.getConversationMessage.invoke).mockClear();
    const compact = (saved: IMessageAcpToolCall) => ({
      ...saved,
      content: { ...saved.content, _compact: { truncated: true } },
    });
    const running = message(
      { version: 1, children: stoppedPair.children.map((child) => ({ ...child, state: 'running' })) },
      'late',
      'preview'
    );
    running.content.update.status = 'in_progress';
    const { container, rerender } = render(<MessageToolGroupSummary messages={[compact(running)]} />);
    const stoppedFrame = compact(message(stoppedPair, 'late', 'preview'));
    stoppedFrame.content.update.status = 'in_progress';
    rerender(<MessageToolGroupSummary messages={[stoppedFrame]} />);
    expect(invoke).not.toHaveBeenCalled();
    const stale = { ...stoppedFrame, content: { ...stoppedFrame.content, _compact: undefined } };
    invoke.mockResolvedValueOnce(stale).mockResolvedValueOnce(cancelled(cancelReports.reports.twoStopped, 'late'));
    const final = cancelled(cancelReports.reports.twoStopped, 'late');
    rerender(
      <MessageToolGroupSummary
        messages={[{ ...final, content: mergeAcpToolCallContent(stoppedFrame.content, final.content) }]}
      />
    );
    await vi.waitFor(() => expect(entry(container, 2)).toHaveTextContent('PARTIAL_CHILD_CANCEL_B'), { timeout: 3000 });
    expect(container.querySelector('[data-subagent-report="missing"]')).toBeNull();
  });

  it.each([
    ['a row without message identifiers', { conversation_id: '' }, null],
    ['a fetched message without this call', {}, { id: 'other', type: 'text', content: { content: 'x' } }],
  ])('reports a failed full load for %s', async (_name, patch, fetched) => {
    const invoke = vi.mocked(ipcBridge.database.getConversationMessage.invoke).mockReset();
    if (fetched) invoke.mockResolvedValueOnce(fetched);
    const saved = cancelled(cancelReports.reports.twoStopped.slice(0, 400), 'unloadable');
    const compact = { ...saved, ...patch, content: { ...saved.content, _compact: { truncated: true } } };
    const { container } = render(<MessageToolGroupSummary messages={[compact]} />);
    await vi.waitFor(() => expect(report(container)).toHaveAttribute('data-subagent-report', 'loadFailed'));
  });

  it('loads the full report of a compact reopened message before splitting it', async () => {
    const full = cancelled(cancelReports.reports.twoStopped, 'compact-report');
    vi.mocked(ipcBridge.database.getConversationMessage.invoke).mockReset().mockResolvedValueOnce(full);
    const preview = cancelled(cancelReports.reports.twoStopped.slice(0, 400) + '\n...[truncated]', 'compact-report');
    const saved = { ...preview, content: { ...preview.content, _compact: { truncated: true } } };
    const { container } = render(<MessageToolGroupSummary messages={[saved]} />);
    expect(report(container)).toBeNull();
    await vi.waitFor(() => expect(entry(container, 2)).toHaveTextContent('PARTIAL_CHILD_CANCEL_B'));
  });

  it('names tasks that lost their agent or never had one', () => {
    const { container } = render(<MessageToolGroupSummary messages={[cancelled(cancelReports.reports.lostAndIdle)]} />);
    expect(entry(container, 2)).toHaveTextContent('acp.subagents.report.lost');
    expect(entry(container, 3)).toHaveTextContent('acp.subagents.report.idle');
  });

  it.each([
    ['missing', 'Tool call was cut.'],
    ['unreadable', cancelReports.reports.forgedOverSibling],
  ])('degrades to the %s notice without per-task text', (kind, text) => {
    const { container } = render(<MessageToolGroupSummary messages={[cancelled(text)]} />);
    expect(report(container)).toHaveAttribute('data-subagent-report', kind);
    expect(container.querySelector('[data-subagent-report-position]')).toBeNull();
  });
});
