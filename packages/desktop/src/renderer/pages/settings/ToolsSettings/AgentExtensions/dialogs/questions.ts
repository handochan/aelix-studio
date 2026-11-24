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

/** Every question has its own id: what is typed for one belongs to no other. */
export type InsecureQuestion = { id: number; answer: (yes: boolean) => void };
export type CredentialsQuestion = {
  id: number;
  reason: CredentialsReason;
  proxy: string;
  answer: (result: CredentialsAnswer) => void;
};
export type EntryQuestion = { id: number; entry: ExtensionEntry; answer: (yes: boolean) => void };

/** The question open on the screen, if any: at most one of these is set. */
export type OpenQuestions = {
  insecure?: InsecureQuestion;
  credentials?: CredentialsQuestion;
  unpin?: EntryQuestion;
  pinned?: EntryQuestion;
};

type Kind = keyof OpenQuestions;
type Pending = { kind: Kind; question: NonNullable<OpenQuestions[Kind]> };

let nextId = 0;

/**
 * The questions the screen's dialogs ask, one at a time on the whole screen, whatever dialog
 * asks. A new question ends the open one with its "no" (stopped) first, so no earlier question
 * waits for ever; leaving the screen ends the open question the same way. A question is answered
 * once: an answer to one already ended does nothing.
 */
export function useQuestions() {
  const [open, setOpen] = useState<OpenQuestions>({});
  const pending = useRef<Pending | undefined>(undefined);

  /** Show `question`, ending the open one, of any kind, first. */
  const show = useCallback((kind: Kind, question: NonNullable<OpenQuestions[Kind]>) => {
    const previous = pending.current;
    // Its `answer` checks that it is still the open one: end it before this one takes its place.
    if (previous) endWithNo(previous);
    pending.current = { kind, question };
    setOpen({ [kind]: question });
  }, []);

  /** Take `question` off the screen; false when it was already answered or replaced. */
  const settle = useCallback((question: NonNullable<OpenQuestions[Kind]>): boolean => {
    if (pending.current?.question !== question) return false;
    pending.current = undefined;
    setOpen((current) => (Object.values(current).includes(question) ? {} : current));
    return true;
  }, []);

  useEffect(
    () => () => {
      const still = pending.current;
      if (still) endWithNo(still);
    },
    []
  );

  const asks = useMemo(() => {
    const entryQuestion = (kind: 'unpin' | 'pinned', entry: ExtensionEntry): Promise<boolean> =>
      new Promise<boolean>((resolve) => {
        const question: EntryQuestion = {
          id: (nextId += 1),
          entry,
          answer: (yes) => {
            if (settle(question)) resolve(yes);
          },
        };
        show(kind, question);
      });
    return {
      confirmInsecure: (): Promise<boolean> =>
        new Promise<boolean>((resolve) => {
          const question: InsecureQuestion = {
            id: (nextId += 1),
            answer: (yes) => {
              if (settle(question)) resolve(yes);
            },
          };
          show('insecure', question);
        }),
      credentials: (reason: CredentialsReason, proxy: string): Promise<CredentialsAnswer> =>
        new Promise<CredentialsAnswer>((resolve) => {
          const question: CredentialsQuestion = {
            id: (nextId += 1),
            reason,
            proxy,
            answer: (result) => {
              if (settle(question)) resolve(result);
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
function endWithNo({ kind, question }: Pending): void {
  if (kind === 'credentials') (question as CredentialsQuestion).answer(undefined);
  else (question as InsecureQuestion | EntryQuestion).answer(false);
}
