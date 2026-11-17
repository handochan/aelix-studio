import { describe, expect, it, vi } from 'vitest';
import { presentSubagentTool } from '@/renderer/pages/conversation/Messages/acp/SubagentProgress/presentation';
import * as parser from '@/renderer/pages/conversation/Messages/acp/SubagentProgress/parser';

const idle = { known: true, isProcessing: false };
const active = { known: true, isProcessing: true };
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

  it('ends an unfinished parent after its turn ends even when every child is done/error', () => {
    expect(
      presentSubagentTool(
        meta([
          { id: 'done', state: 'done' },
          { id: 'error', state: 'error' },
        ]),
        'running',
        idle
      )?.parentStatus
    ).toBe('canceled');
  });

  it('marks stale active children as ended without inventing their final outcome or changing input', () => {
    const input = meta([{ id: 'child', state: 'running', elapsedMs: 2300 }]);
    const view = presentSubagentTool(input, 'running', idle);
    expect(view?.progress.children[0]).toMatchObject({ state: 'ended', elapsedMs: 2300 });
    expect(input['aelix/subagents'].children[0]).toMatchObject({ state: 'running' });
  });

  it.each([
    { children: [{ id: 'stop', state: 'stopped' }, { state: 'running' }] },
    {
      children: [
        { id: 'same', state: 'stopped' },
        { id: 'same', state: 'running' },
      ],
    },
  ])('never projects a parent from a filtered child list', ({ children }) => {
    expect(presentSubagentTool(meta(children), 'running', idle)?.parentStatus).toBe('running');
  });

  it('does not guess the end of an untagged call while another turn is active', () => {
    expect(presentSubagentTool(meta([{ id: 'legacy', state: 'running' }]), 'running', active)?.parentStatus).toBe(
      'running'
    );
  });

  it('does not treat unhydrated state as an ended turn', () => {
    expect(
      presentSubagentTool(meta([{ id: 'child', state: 'running' }]), 'running', { ...idle, known: false })?.progress
        .children[0].state
    ).toBe('running');
  });

  it('keeps reported terminal parent statuses and future metadata opaque', () => {
    expect(presentSubagentTool(meta([{ id: 'stop', state: 'stopped' }]), 'error', idle)?.parentStatus).toBe('error');
    expect(
      presentSubagentTool({ 'aelix/subagents': { version: 2, children: [{ id: 'child' }] } }, 'running', idle)
    ).toBeNull();
  });
});
