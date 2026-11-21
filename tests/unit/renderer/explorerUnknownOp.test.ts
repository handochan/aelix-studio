/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

// A delta op this build does not handle must not pass in silence.
//
// `applyDelta` skipping unknown ops is deliberate — it is what lets the backend ship a
// protocol addition before the frontend handles it. The cost is that the gap is
// invisible: the `modified` op was being sent and dropped here for several rounds of
// work, because "silently ignored" and "never sent" look identical from the frontend.
//
// Keep the listing usable and report the number of skipped ops once per frame.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyDelta, peKey, type Change, type FactCache } from '@/renderer/pages/conversation/explorer/explorerModel';

const KEY = peKey('peA', 'src');

const cacheWith = (...names: string[]): FactCache =>
  new Map([[KEY, names.map((name) => ({ name, kind: 'file' as const }))]]);

/** An op from a future backend, outside the currently declared union. */
const futureOp = (op: string, name: string): Change => ({ op, name }) as unknown as Change;

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => warn.mockRestore());

describe('an unrecognised fs/delta op', () => {
  it('reports a count while keeping raw and escaped op values private', () => {
    const marker = 'C:\\private-workspace\\file "name"';
    const delta = [futureOp(marker, 'a.ts')];
    expect(JSON.stringify(delta)).toContain(JSON.stringify(marker).slice(1, -1));
    applyDelta(cacheWith('a.ts'), KEY, delta);

    expect(warn).toHaveBeenCalledExactlyOnceWith('[explorer] ignoring unknown fs/delta ops', 1);
  });

  it('leaves the listing untouched instead of throwing', () => {
    const before = cacheWith('a.ts', 'b.ts');

    const after = applyDelta(before, KEY, [futureOp('opUntouched', 'a.ts')]);

    expect(after.get(KEY)?.map((entry) => entry.name)).toEqual(['a.ts', 'b.ts']);
  });

  // Ops the build does understand must stay silent, or the warning becomes noise and
  // stops being read — including `modified`, which this cache legitimately ignores.
  it('says nothing about ops this build handles', () => {
    applyDelta(cacheWith('a.ts'), KEY, [
      { op: 'modified', name: 'a.ts' },
      { op: 'added', name: 'new.ts', kind: 'file' },
      { op: 'removed', name: 'a.ts' },
      { op: 'renamed', from: 'new.ts', to: 'moved.ts' },
    ]);

    expect(warn).not.toHaveBeenCalled();
  });

  it('reports one total for all unknown ops in the delta', () => {
    applyDelta(cacheWith('a.ts'), KEY, [
      futureOp('opOnce', 'a.ts'),
      futureOp('opOnce', 'b.ts'),
      futureOp('opOnce', 'c.ts'),
    ]);

    expect(warn).toHaveBeenCalledExactlyOnceWith('[explorer] ignoring unknown fs/delta ops', 3);
  });
});
