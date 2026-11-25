import { describe, expect, it } from 'vitest';
import { presentSubagentTool } from '@/renderer/pages/conversation/Messages/acp/SubagentProgress/presentation';
import {
  parseCancelReport,
  presentCancelReport,
} from '@/renderer/pages/conversation/Messages/acp/SubagentProgress/report';
import type { SubagentParentStatus } from '@/renderer/pages/conversation/Messages/acp/SubagentProgress/types';
import fixture from './cancelReports.json';

const { reports } = fixture;
const stoppedPair = {
  version: 1,
  children: [
    { id: 'sub-a', state: 'stopped' },
    { id: 'sub-b', state: 'stopped' },
  ],
};
const view = (status: SubagentParentStatus, snapshot: unknown = stoppedPair) =>
  presentSubagentTool({ 'aelix/subagents': snapshot }, status)!;
const ready = { pending: false, loadFailed: false };

describe('cancelled delegation report parser', () => {
  it('splits a two-task report by submitted position with each block intact', () => {
    const report = parseCancelReport(reports.twoStopped);
    expect(report).toMatchObject({ kind: 'batch', noun: 'task', total: 2 });
    if (report?.kind !== 'batch') throw new Error('expected a batch');
    expect(report.entries.map((entry) => entry.position)).toEqual([1, 2]);
    expect(report.entries[0]).toMatchObject({ kind: 'ran', text: expect.stringContaining('PARTIAL_CHILD_CANCEL_A') });
    expect(report.entries[1]).toMatchObject({ kind: 'ran', text: expect.stringContaining('Second paragraph of B.') });
  });

  it('keeps one task text from leaking into its sibling', () => {
    const report = parseCancelReport(reports.twoStopped);
    if (report?.kind !== 'batch' || report.entries[0].kind !== 'ran') throw new Error('expected a ran block');
    expect(report.entries[0].text).not.toContain('PARTIAL_CHILD_CANCEL_B');
  });

  it('names positions that lost their agent or never had one', () => {
    const report = parseCancelReport(reports.lostAndIdle);
    if (report?.kind !== 'batch') throw new Error('expected a batch');
    expect(report.entries.map((entry) => entry.kind)).toEqual(['ran', 'lost', 'idle']);
  });

  it('labels chain members as steps and keeps a finished step', () => {
    const report = parseCancelReport(reports.chain);
    expect(report).toMatchObject({ kind: 'batch', noun: 'step', total: 3 });
    if (report?.kind !== 'batch') throw new Error('expected a batch');
    expect(report.entries.map((entry) => entry.kind)).toEqual(['ran', 'ran', 'idle']);
  });

  it('keeps a child that wrote nothing with native wording, next to an idle task', () => {
    const report = parseCancelReport(reports.didNothing);
    if (report?.kind !== 'batch' || report.entries[0].kind !== 'ran') throw new Error('expected a ran block');
    expect(report.entries[0].text).toContain('(it wrote no text before it stopped)');
    expect(report.entries[1].kind).toBe('idle');
  });

  it('reads a single call as one child text', () => {
    expect(parseCancelReport(reports.single)).toEqual({
      kind: 'single',
      text: expect.stringContaining('PARTIAL_SINGLE_WORK'),
    });
  });

  it.each(['forgedOverSibling', 'forgedOverIdle'] as const)(
    'refuses a split when a child forges another position (%s)',
    (name) => {
      expect(parseCancelReport(reports[name])).toBeNull();
    }
  );

  it.each([
    ['plain text', 'Tool call was cut.'],
    ['a truncated preview', reports.twoStopped.slice(0, 600) + '\n...[truncated]'],
    ['a second fence', reports.twoStopped.replace('</cancelled-delegation-report>', '')],
    ['a wrong total', reports.twoStopped.replace('[2/2 aborted]', '[2/3 aborted]')],
    ['a changed note', reports.lostAndIdle.replace('not started, or not reached.', 'not reached.')],
  ])('rejects %s', (_name, output) => {
    expect(parseCancelReport(output)).toBeNull();
  });
});

describe('cancelled delegation report presentation', () => {
  it('shows the report only for an ended parent call', () => {
    expect(presentCancelReport(view('error'), reports.twoStopped, ready)).toMatchObject({ kind: 'batch' });
    expect(presentCancelReport(view('completed'), reports.twoStopped, ready)).toBeNull();
  });

  it('waits for the parent result instead of projecting a missing report from stopped rows', () => {
    const projected = view('running');
    expect(projected.parentStatus).toBe('canceled');
    expect(presentCancelReport(projected, undefined, ready)).toBeNull();
  });

  it('says that no report was returned for a stopped call without one', () => {
    expect(presentCancelReport(view('error'), 'Tool call was cut.', ready)).toEqual({ kind: 'missing' });
  });

  it('stays quiet for a failed call whose children did not stop', () => {
    const failed = view('error', { version: 1, children: [{ id: 'sub-a', state: 'error' }] });
    expect(presentCancelReport(failed, 'provider error', ready)).toBeNull();
  });

  it('marks a malformed report unreadable rather than guessing', () => {
    expect(presentCancelReport(view('error'), reports.forgedOverSibling, ready)).toEqual({ kind: 'unreadable' });
  });

  it('rejects more reported members than progress rows', () => {
    const one = view('error', { version: 1, children: [{ id: 'sub-a', state: 'stopped' }] });
    expect(presentCancelReport(one, reports.twoStopped, ready)).toEqual({ kind: 'unreadable' });
  });

  it('waits for a compact preview and reports a failed full load', () => {
    expect(presentCancelReport(view('error'), 'preview', { pending: true, loadFailed: false })).toBeNull();
    expect(presentCancelReport(view('error'), 'preview', { pending: true, loadFailed: true })).toEqual({
      kind: 'loadFailed',
    });
  });
});
