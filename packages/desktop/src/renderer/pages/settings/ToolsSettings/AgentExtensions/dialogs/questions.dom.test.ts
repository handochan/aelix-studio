/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ExtensionEntry } from '@aionui/web-host';
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useQuestions } from './questions';

const entry = { name: 'x' } as ExtensionEntry;

describe('the questions of the screen’s dialogs', () => {
  it('ends an open question as stopped when its dialog is asked again, and shows the new one', async () => {
    const { result } = renderHook(() => useQuestions());
    let first: Promise<unknown> | undefined;
    let second: Promise<unknown> | undefined;
    act(() => {
      first = result.current.asks.credentials('save', 'http://proxy:3128');
    });
    const firstQuestion = result.current.open.credentials;
    act(() => {
      second = result.current.asks.credentials('rejected', 'http://proxy:3128');
    });
    expect(await first).toBeUndefined();
    expect(result.current.open.credentials?.reason).toBe('rejected');
    // An answer to the question that was ended changes nothing.
    act(() => firstQuestion?.answer({ credentials: { username: 'a', password: 'b' }, save: false }));
    expect(result.current.open.credentials?.reason).toBe('rejected');
    const answer = { credentials: { username: 'ops', password: 'right' }, save: false };
    act(() => result.current.open.credentials?.answer(answer));
    expect(await second).toEqual(answer);
    expect(result.current.open.credentials).toBeUndefined();
  });

  it.each(['confirmInsecure', 'confirmUnpin', 'pinned'] as const)(
    'ends an open yes-or-no question (%s) as no when asked again',
    async (kind) => {
      const { result } = renderHook(() => useQuestions());
      const ask = (): Promise<boolean> =>
        kind === 'confirmInsecure' ? result.current.asks.confirmInsecure() : result.current.asks[kind](entry);
      let first: Promise<boolean> | undefined;
      act(() => {
        first = ask();
      });
      act(() => {
        void ask();
      });
      expect(await first).toBe(false);
    }
  );

  it('ends every open question with its no when the screen is left', async () => {
    const { result, unmount } = renderHook(() => useQuestions());
    let credentials: Promise<unknown> | undefined;
    let insecure: Promise<boolean> | undefined;
    act(() => {
      credentials = result.current.asks.credentials('required', 'http://proxy:3128');
      insecure = result.current.asks.confirmInsecure();
    });
    unmount();
    expect(await credentials).toBeUndefined();
    expect(await insecure).toBe(false);
  });
});
