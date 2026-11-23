/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  ExtensionData,
  ExtensionEntry,
  ExtensionOperation,
  ExtensionSource,
  StudioExtensionsRequest,
} from '@aionui/web-host';
import { useCallback, useEffect, useRef, useState } from 'react';
import { failureCode, type SendResult } from './channel';
import { createFlow, runFlow, type Flow, type Sender } from './flow';
import { sourceHasUserPart } from './secrets';

export type { Sender } from './flow';

/** How often a running change is polled (11-22 design note: one second). */
export const POLL_INTERVAL_MS = 1000;

/** Phases after which an operation does not change. `already_latest` comes with the upgrade (#121). */
const FINISHED = new Set<string>(['switched', 'already_latest', 'failed', 'cancelled']);

export const isFinished = (operation: ExtensionOperation): boolean => FINISHED.has(operation.phase);

export const isOperation = (data: ExtensionData): data is ExtensionOperation =>
  typeof (data as ExtensionOperation).operationId === 'string' &&
  typeof (data as ExtensionOperation).phase === 'string';

/** An online change as the user asked for it, kept to be sent again; it never holds proxy credentials. */
export type Change =
  | { action: 'install'; source: ExtensionSource; replaceIncompatible?: boolean }
  | { action: 'upgrade'; entry: ExtensionEntry; allowUnpin?: boolean };

/** What the screen keeps of the change it started, across visits. */
export type Kept = {
  operation: ExtensionOperation;
  /**
   * The change it came from, to send again after a proxy refusal. Absent for offline changes,
   * and for a change whose URL holds a user name or password (a secret is never kept).
   */
  change?: Change;
  /** It was already sent again after a proxy refusal: it is not offered again. */
  retried: boolean;
};

/**
 * What `start` records with an operation: for whom it was asked, and which change request it
 * answers (`request`, from `nextChangeRequest`).
 */
export type Started = Sender & { request: number; change?: Change; retried: boolean };

/** Whether a change holds something secret: a URL that may carry a user part. */
export const changeHasSecret = (change: Change): boolean =>
  change.action === 'install' && sourceHasUserPart(change.source);

/** The change, unless it holds something secret (it is then sent once and kept nowhere). */
const keepable = (change: Change | undefined): Change | undefined =>
  change && changeHasSecret(change) ? undefined : change;

/**
 * The change each owner (the signed-in user; `local` in the desktop app) started and has not
 * dismissed yet. Kept outside the component so leaving the screen and coming back shows it again
 * and goes on polling it; the host cancels it only when the window closes or reloads. Only the
 * current owner's is kept: when another owner opens the screen, or on sign-out, the others' are
 * dropped, and an answer that arrives for an owner who is no longer current is dropped too.
 * Every mounted screen is told when the current owner's changes, so a start reply that arrives
 * after the screen was left and opened again is shown by the new one.
 */
const kept = new Map<string, Kept>();
let owner: string | undefined;
/** Goes up at every sign-out (or change of user): answers sent in an earlier sign-in are dropped. */
let epoch = 0;
/** The latest change request: the answer to an earlier one starts nothing over it. */
let changeRequest = 0;
const viewers = new Set<(current: Kept | undefined) => void>();

const keptNow = (): Kept | undefined => (owner === undefined ? undefined : kept.get(owner));
const notify = (): void => {
  const current = keptNow();
  for (const viewer of viewers) viewer(current);
};

/** Whose changes the screen shows: a new owner drops every other's. */
export function claimOwner(next: string): void {
  if (owner === next) return;
  owner = next;
  // Deleting while iterating a Map is safe: each entry is visited once.
  for (const key of kept.keys()) if (key !== next) kept.delete(key);
  notify();
}

/** The owner whose answers are taken now; undefined after sign-out until a screen claims one. */
export const currentOwner = (): string | undefined => owner;

/** The sign-in answers are taken for now (see `epoch`). */
export const sessionEpoch = (): number => epoch;

/** Whether an answer sent for `sender` may still be taken. */
export const isCurrent = (sender: Sender): boolean => sender.owner === owner && sender.epoch === epoch;

/** A new change request, which takes the place of every earlier one. */
export const nextChangeRequest = (): number => (changeRequest += 1);

/** Whether `request` is still the latest change request. */
export const isLatestChange = (request: number): boolean => request === changeRequest;

/** On sign-out (or another user): a new sign-in, no owner, nothing kept. */
export function forgetOwners(): void {
  epoch += 1;
  owner = undefined;
  kept.clear();
  notify();
}

/**
 * The change in progress on this screen for `ownerId`: polled every `POLL_INTERVAL_MS` until it
 * finishes. `onFinished` runs once when it does (the screen then reads the list again). A poll
 * that is lost is tried again; an operation the host no longer knows (`NOT_FOUND`) ends as
 * failed.
 */
export function useOperation(
  send: (command: StudioExtensionsRequest, flow: Flow) => Promise<SendResult>,
  onFinished: (operation: ExtensionOperation) => void,
  ownerId: string
) {
  const [current, setCurrent] = useState<Kept | undefined>(() => {
    claimOwner(ownerId);
    return keptNow();
  });
  const finishedRef = useRef(onFinished);
  finishedRef.current = onFinished;

  useEffect(() => {
    claimOwner(ownerId);
    const viewer = (next: Kept | undefined): void => setCurrent(owner === ownerId ? next : undefined);
    viewers.add(viewer);
    // What changed between the first render and this subscription.
    viewer(keptNow());
    return () => {
      viewers.delete(viewer);
    };
  }, [ownerId]);

  /**
   * A newer state of the kept operation (a poll, a cancel answer), or none (dismissed). Taken
   * only for the sender it was asked for and the operation it was asked about: a late answer
   * about an earlier operation, sign-in or owner is dropped.
   */
  const show = useCallback(
    (next: ExtensionOperation | undefined, sender: Sender) => {
      if (!isCurrent(sender) || sender.owner !== ownerId) return;
      const previous = kept.get(ownerId);
      if (!next) kept.delete(ownerId);
      else if (previous && previous.operation.operationId === next.operationId)
        kept.set(ownerId, { ...previous, operation: next });
      else return;
      notify();
      const wasRunning =
        previous !== undefined &&
        !isFinished(previous.operation) &&
        previous.operation.operationId === next?.operationId;
      if (next && isFinished(next) && wasRunning) finishedRef.current(next);
    },
    [ownerId]
  );

  /**
   * A change the host started, kept for the sender who asked. Dropped if that sender is no
   * longer current, or if a newer change was asked for since (it must not cover that one).
   */
  const start = useCallback((next: ExtensionOperation, started: Started) => {
    if (!isCurrent(started) || !isLatestChange(started.request)) return;
    kept.set(started.owner, { operation: next, change: keepable(started.change), retried: started.retried });
    notify();
    if (isFinished(next)) finishedRef.current(next);
  }, []);

  const operation = current?.operation;
  const operationId = operation?.operationId;
  const running = operation !== undefined && !isFinished(operation);
  useEffect(() => {
    if (!operationId || !running) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const sender: Sender = { owner: ownerId, epoch };
    // Polling this operation, from this screen, for this sender.
    const following = (): boolean =>
      !stopped && isCurrent(sender) && kept.get(ownerId)?.operation.operationId === operationId;
    const flow = createFlow(sender, { valid: following, current: following });
    const poll = (): Promise<void> =>
      runFlow(async () => {
        const reply = await flow.answer(send({ action: 'poll', operationId }, flow));
        if (reply !== 'declined' && reply.ok && isOperation(reply.data)) {
          show(reply.data, sender);
          if (isFinished(reply.data)) return;
        } else if (reply !== 'declined' && failureCode(reply) === 'NOT_FOUND') {
          const last = kept.get(ownerId)?.operation;
          if (last?.operationId === operationId) show({ ...last, phase: 'failed', code: 'NOT_FOUND' }, sender);
          return;
        }
        timer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
      });
    timer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [operationId, running, send, show, ownerId]);

  const cancel = useCallback(
    (): Promise<void> =>
      runFlow(async () => {
        if (!operationId) return;
        const sender: Sender = { owner: ownerId, epoch };
        // The answer counts only for this operation, while it is still the one kept.
        const about = (): boolean => isCurrent(sender) && kept.get(ownerId)?.operation.operationId === operationId;
        const flow = createFlow(sender, { valid: about, current: about });
        const reply = await flow.answer(send({ action: 'cancel', operationId }, flow));
        if (reply !== 'declined' && reply.ok && isOperation(reply.data)) show(reply.data, sender);
      }),
    [operationId, send, show, ownerId]
  );

  const dismiss = useCallback(() => {
    const last = kept.get(ownerId)?.operation;
    if (last && !isFinished(last)) return;
    show(undefined, { owner: ownerId, epoch });
  }, [show, ownerId]);

  return { operation, change: current?.change, retried: current?.retried ?? false, start, cancel, dismiss };
}

/** For tests: forget every change kept across visits, and the owner. */
export function resetShownOperation(): void {
  forgetOwners();
}
