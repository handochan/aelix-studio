/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Who a request was sent for: the owner (the signed-in user, `local` in the desktop app) and the
 * sign-in (`epoch`) it was sent in.
 */
export type Sender = { owner: string; epoch: number };

/** Thrown by a flow's `step` or `answer` once the flow may not go on; `runFlow` ends it quietly. */
export class FlowEnded extends Error {
  constructor() {
    super('the screen flow ended');
    this.name = 'FlowEnded';
  }
}

/**
 * One flow of the screen: a load, a settings save, a change with its questions and retries, a
 * poll. Every await in the screen's code goes through one of its gates:
 * - `step`: what comes before asking the user or sending anything more. Goes on only while
 *   `valid()`: the same owner and sign-in, the screen still open (for flows of a visit), and no
 *   newer request in its place (for changes).
 * - `ask`: a question to the user. Asked only while `valid()`, and gone on from only while
 *   `valid()` (a question asked of a screen that was left would never be answered).
 * - `answer`: an answer the flow asked for, to be taken (shown, kept) even after the screen was
 *   left. Goes on only while `current()`: the same owner and sign-in, and no newer request.
 * Each throws `FlowEnded` otherwise.
 */
export type Flow = {
  readonly sender: Sender;
  valid(): boolean;
  current(): boolean;
  step<T>(waiting: Promise<T>): Promise<T>;
  ask<T>(question: () => Promise<T>): Promise<T>;
  answer<T>(waiting: Promise<T>): Promise<T>;
};

export function createFlow(sender: Sender, checks: { valid: () => boolean; current: () => boolean }): Flow {
  const gate =
    (still: () => boolean) =>
    async <T>(waiting: Promise<T>): Promise<T> => {
      const value = await waiting;
      if (!still()) throw new FlowEnded();
      return value;
    };
  const step = gate(checks.valid);
  return {
    sender,
    valid: checks.valid,
    current: checks.current,
    step,
    ask: async <T>(question: () => Promise<T>): Promise<T> => {
      if (!checks.valid()) throw new FlowEnded();
      return step(question());
    },
    answer: gate(checks.current),
  };
}

/** Run a flow's body: a gate that closed ends it without an error. */
export async function runFlow(body: () => Promise<void>): Promise<void> {
  try {
    await body();
  } catch (error) {
    if (!(error instanceof FlowEnded)) throw error;
  }
}
