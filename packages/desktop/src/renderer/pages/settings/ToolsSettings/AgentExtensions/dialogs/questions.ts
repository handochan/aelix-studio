/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ExtensionEntry, ProxyCredentials } from '@aionui/web-host';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CredentialsReason } from './CredentialsPrompt';

/** What the credentials dialog gives back; undefined when the user stopped. */
export type CredentialsAnswer = { credentials: ProxyCredentials; save: boolean } | undefined;

export type InsecureQuestion = { answer: (yes: boolean) => void };
export type CredentialsQuestion = {
  reason: CredentialsReason;
  proxy: string;
  answer: (result: CredentialsAnswer) => void;
};
export type EntryQuestion = { entry: ExtensionEntry; answer: (yes: boolean) => void };

/** The question each dialog shows, if any. */
export type OpenQuestions = {
  insecure?: InsecureQuestion;
  credentials?: CredentialsQuestion;
  unpin?: EntryQuestion;
  pinned?: EntryQuestion;
};

/**
 * The questions the screen's dialogs ask, one open per dialog. Asking again while one is open
 * ends the open one with its "no" (stopped) first, so no earlier question waits for ever; leaving
 * the screen ends every open question the same way. A question is answered once: a later answer
 * to one already ended does nothing.
 */
export function useQuestions() {
  const [open, setOpen] = useState<OpenQuestions>({});
  const pending = useRef<OpenQuestions>({});

  /** Show `question` in its dialog, ending the one it replaces first. */
  const show = useCallback(<K extends keyof OpenQuestions>(kind: K, question: NonNullable<OpenQuestions[K]>) => {
    const previous = pending.current[kind];
    // `answer` of the one shown before checks that it is still the open one: end it first.
    if (previous) endWithNo(kind, previous);
    pending.current[kind] = question;
    setOpen((current) => ({ ...current, [kind]: question }));
  }, []);

  /** Take `question` off its dialog; false when it was already answered or replaced. */
  const settle = useCallback(<K extends keyof OpenQuestions>(kind: K, question: OpenQuestions[K]): boolean => {
    if (pending.current[kind] !== question) return false;
    pending.current[kind] = undefined;
    setOpen((current) => (current[kind] === question ? { ...current, [kind]: undefined } : current));
    return true;
  }, []);

  useEffect(
    () => () => {
      const still = pending.current;
      for (const kind of Object.keys(still) as (keyof OpenQuestions)[]) {
        const question = still[kind];
        if (question) endWithNo(kind, question);
      }
    },
    []
  );

  const asks = useMemo(() => {
    const entryQuestion = (kind: 'unpin' | 'pinned', entry: ExtensionEntry): Promise<boolean> =>
      new Promise<boolean>((resolve) => {
        const question: EntryQuestion = {
          entry,
          answer: (yes) => {
            if (settle(kind, question)) resolve(yes);
          },
        };
        show(kind, question);
      });
    return {
      confirmInsecure: (): Promise<boolean> =>
        new Promise<boolean>((resolve) => {
          const question: InsecureQuestion = {
            answer: (yes) => {
              if (settle('insecure', question)) resolve(yes);
            },
          };
          show('insecure', question);
        }),
      credentials: (reason: CredentialsReason, proxy: string): Promise<CredentialsAnswer> =>
        new Promise<CredentialsAnswer>((resolve) => {
          const question: CredentialsQuestion = {
            reason,
            proxy,
            answer: (result) => {
              if (settle('credentials', question)) resolve(result);
            },
          };
          show('credentials', question);
        }),
      confirmUnpin: (entry: ExtensionEntry): Promise<boolean> => entryQuestion('unpin', entry),
      pinned: (entry: ExtensionEntry): Promise<boolean> => entryQuestion('pinned', entry),
    };
  }, [show, settle]);

  return { open, asks };
}

/** End an open question with its "no": stopped, or not confirmed. */
function endWithNo<K extends keyof OpenQuestions>(kind: K, question: NonNullable<OpenQuestions[K]>): void {
  if (kind === 'credentials') (question as CredentialsQuestion).answer(undefined);
  else (question as InsecureQuestion | EntryQuestion).answer(false);
}
