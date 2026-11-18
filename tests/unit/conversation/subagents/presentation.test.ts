import { describe, expect, it, vi } from 'vitest';
import { presentSubagentTool } from '@/renderer/pages/conversation/Messages/acp/SubagentProgress/presentation';
import * as parser from '@/renderer/pages/conversation/Messages/acp/SubagentProgress/parser';

const meta = (children: unknown[]) => ({ 'aelix/subagents': { version: 1, children } });

describe('subagent tool presentation boundary', () => {
  it('parses once per extension item and never parses ordinary tool metadata', () => {
    const spy = vi.spyOn(parser, 'parseSubagentProgress');
    presentSubagentTool(undefined, 'running');
    presentSubagentTool({ other: true }, 'running');
    expect(spy).not.toHaveBeenCalled();
    presentSubagentTool(meta([{ id: 'child', state: 'running' }]), 'running');
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it('keeps an unfinished parent busy when every child is done/error but the call has not ended', () => {
    expect(
      presentSubagentTool(
        meta([
          { id: 'done', state: 'done' },
          { id: 'error', state: 'error' },
        ]),
        'running'
      )?.parentStatus
    ).toBe('running');
  });

  it.each(['completed', 'error', 'canceled'] as const)(
    'marks unreported active children as ended only with an explicit %s parent',
    (status) => {
      const input = meta([{ id: 'child', state: 'running', elapsedMs: 2300 }]);
      const view = presentSubagentTool(input, status);
      expect(view?.progress.children[0]).toMatchObject({ state: 'ended', elapsedMs: 2300 });
      expect(input['aelix/subagents'].children[0]).toMatchObject({ state: 'running' });
    }
  );

  it.each([
    { children: [{ id: 'stop', state: 'stopped' }, { state: 'running' }] },
    {
      children: [
        { id: 'same', state: 'stopped' },
        { id: 'same', state: 'running' },
      ],
    },
  ])('never projects a parent from a filtered child list', ({ children }) => {
    expect(presentSubagentTool(meta(children), 'running')?.parentStatus).toBe('running');
  });

  it('keeps reported active children and an unfinished parent running without a call-ended signal', () => {
    const view = presentSubagentTool(meta([{ id: 'child', state: 'running' }]), 'running');
    expect(view?.parentStatus).toBe('running');
    expect(view?.progress.children[0].state).toBe('running');
    expect(view?.interrupted).toBe(false);
  });

  it('keeps reported terminal parent statuses and future metadata opaque', () => {
    expect(presentSubagentTool(meta([{ id: 'stop', state: 'stopped' }]), 'error')?.parentStatus).toBe('error');
    expect(
      presentSubagentTool({ 'aelix/subagents': { version: 2, children: [{ id: 'child' }] } }, 'running')
    ).toBeNull();
  });
});
