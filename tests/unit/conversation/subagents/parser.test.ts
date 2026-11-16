import { describe, expect, it } from 'vitest';
import { parseSubagentProgress } from '@/renderer/pages/conversation/Messages/acp/SubagentProgress/parser';
import fixture from './frames.json';

const value = (name: string) => fixture.frames.find((frame) => frame.name === name)!.update._meta['aelix/subagents'];

describe('subagent metadata contract', () => {
  it('reads the documented progress frame without requiring other tool-call fields', () => {
    expect(parseSubagentProgress(value('documented'))?.children[0]).toMatchObject({
      profile: 'reviewer',
      state: 'running',
      currentTool: 'read',
      elapsedMs: 2300,
      tokens: 0,
      cost: 0,
    });
  });

  it('keeps both children from the latest complete snapshot', () => {
    const progress = parseSubagentProgress(value('stopped'));
    expect(progress?.children.map((child) => child.state)).toEqual(['done', 'stopped']);
  });

  it.each([
    undefined,
    null,
    [],
    1,
    {},
    { version: 2, children: [{ id: 'future' }] },
    { version: 1 },
    { version: 1, children: [] },
    { version: 1, children: [null, {}, { profile: 'missing id' }] },
  ])('falls back for unsupported or unusable metadata %j', (input) => {
    expect(parseSubagentProgress(input)).toBeNull();
  });

  it('handles missing optional fields and unknown fields without invented counters', () => {
    expect(
      parseSubagentProgress({ version: 1, future: true, children: [{ id: 'child', future: true }] })?.children[0]
    ).toEqual({
      id: 'child',
      state: 'unknown',
      profile: undefined,
      currentTool: undefined,
      elapsedMs: undefined,
      tokens: undefined,
      cost: undefined,
    });
  });

  it('bounds child-authored text, rejects invalid metrics and deduplicates IDs', () => {
    const progress = parseSubagentProgress({
      version: 1,
      children: [
        {
          id: 'child',
          state: 'future',
          currentTool: '\u001b' + 'x'.repeat(500),
          elapsedMs: -1,
          tokens: NaN,
          cost: Infinity,
        },
        { id: 'child', state: 'done' },
      ],
    });
    expect(progress?.children).toHaveLength(1);
    expect(progress?.children[0].currentTool).not.toContain('\u001b');
    expect(progress?.children[0]).toMatchObject({
      state: 'unknown',
      elapsedMs: undefined,
      tokens: undefined,
      cost: undefined,
    });
  });

  it('bounds oversized child collections to the native contract limit', () => {
    expect(
      parseSubagentProgress({ version: 1, children: Array.from({ length: 1000 }, (_, id) => ({ id: String(id) })) })
        ?.children
    ).toHaveLength(32);
  });
});
