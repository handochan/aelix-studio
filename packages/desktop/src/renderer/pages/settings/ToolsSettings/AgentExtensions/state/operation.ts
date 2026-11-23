/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ExtensionData, ExtensionOperation, StudioExtensionsRequest } from '@aionui/web-host';
import { useCallback, useEffect, useRef, useState } from 'react';
import { failureCode, type SendResult } from './channel';

/** How often a running change is polled (11-22 design note: one second). */
export const POLL_INTERVAL_MS = 1000;

/** Phases after which an operation does not change. `already_latest` comes with the upgrade (#121). */
const FINISHED = new Set<string>(['switched', 'already_latest', 'failed', 'cancelled']);

export const isFinished = (operation: ExtensionOperation): boolean => FINISHED.has(operation.phase);

export const isOperation = (data: ExtensionData): data is ExtensionOperation =>
  typeof (data as ExtensionOperation).operationId === 'string' &&
  typeof (data as ExtensionOperation).phase === 'string';

/**
 * The change this window started and the user has not dismissed yet. Kept outside the component
 * so leaving the screen and coming back shows it again and goes on polling it; the host cancels
 * it only when the window closes or reloads.
 */
let shown: ExtensionOperation | undefined;

/**
 * The change in progress on this screen: polled every `POLL_INTERVAL_MS` until it finishes.
 * `onFinished` runs once when it does (the screen then reads the list again). A poll that is
 * lost is tried again; an operation the host no longer knows (`NOT_FOUND`) ends as failed.
 */
export function useOperation(
  send: (command: StudioExtensionsRequest) => Promise<SendResult>,
  onFinished: (operation: ExtensionOperation) => void
) {
  const [operation, setOperation] = useState<ExtensionOperation | undefined>(shown);
  const finishedRef = useRef(onFinished);
  finishedRef.current = onFinished;

  const show = useCallback((next: ExtensionOperation | undefined) => {
    const wasRunning = shown !== undefined && !isFinished(shown) && shown.operationId === next?.operationId;
    shown = next;
    setOperation(next);
    if (next && isFinished(next) && wasRunning) finishedRef.current(next);
  }, []);

  const start = useCallback(
    (next: ExtensionOperation) => {
      shown = undefined;
      show(next);
      if (isFinished(next)) finishedRef.current(next);
    },
    [show]
  );

  const operationId = operation?.operationId;
  const running = operation !== undefined && !isFinished(operation);
  useEffect(() => {
    if (!operationId || !running) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async (): Promise<void> => {
      const reply = await send({ action: 'poll', operationId });
      if (stopped) return;
      if (reply !== 'declined' && reply.ok && isOperation(reply.data)) {
        show(reply.data);
        if (isFinished(reply.data)) return;
      } else if (reply !== 'declined' && failureCode(reply) === 'NOT_FOUND') {
        if (shown) show({ ...shown, phase: 'failed', code: 'NOT_FOUND' });
        return;
      }
      timer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
    };
    timer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [operationId, running, send, show]);

  const cancel = useCallback(async (): Promise<void> => {
    if (!operationId) return;
    const reply = await send({ action: 'cancel', operationId });
    if (reply !== 'declined' && reply.ok && isOperation(reply.data)) show(reply.data);
  }, [operationId, send, show]);

  const dismiss = useCallback(() => {
    if (shown && !isFinished(shown)) return;
    show(undefined);
  }, [show]);

  return { operation, start, cancel, dismiss };
}

/** For tests: forget the change kept across visits. */
export function resetShownOperation(): void {
  shown = undefined;
}
