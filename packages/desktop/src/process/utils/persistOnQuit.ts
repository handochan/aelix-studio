/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Tracks fire-and-forget persistence writes so they can finish flushing to
 * disk before the app exits. Without this, the last write triggered by an
 * action right before quit (e.g. ⌘Q immediately after a window resize or
 * a ⌘+ zoom shortcut) routinely loses the race against process teardown,
 * which manifests to the user as the setting "not being remembered".
 */

import { app } from 'electron';

const pending = new Set<Promise<unknown>>();
let installed = false;
let flushing = false;
let timedOut = false;
const QUIT_WRITE_TIMEOUT_MS = 5000;

const ensureHandlerInstalled = (): void => {
  if (installed) return;
  installed = true;
  // before-quit precedes window close, which can enqueue the final bounds write.
  // will-quit runs after those close handlers, including the first tracked write.
  app.on('will-quit', (event) => {
    if (timedOut || pending.size === 0) return;
    event.preventDefault();
    if (flushing) return;
    flushing = true;
    const drain = async () => {
      while (pending.size > 0) await Promise.allSettled(pending);
    };
    let timeout: ReturnType<typeof setTimeout>;
    const deadline = new Promise<void>((resolve) => {
      timeout = setTimeout(() => {
        timedOut = true;
        console.error(`[Storage] Quit write wait exceeded ${QUIT_WRITE_TIMEOUT_MS}ms; continuing shutdown`);
        resolve();
      }, QUIT_WRITE_TIMEOUT_MS);
    });
    void Promise.race([drain(), deadline]).finally(() => {
      clearTimeout(timeout);
      flushing = false;
      app.quit();
    });
  });
};

/**
 * Register a write so the app waits for it on quit. Errors are swallowed —
 * persistence callers are expected to log their own failures; the only role
 * here is to keep the process alive long enough for the write to land.
 */
export const trackPersistedWrite = <T>(promise: Promise<T>): Promise<T> => {
  ensureHandlerInstalled();
  const tracked = promise.catch(() => {});
  pending.add(tracked);
  tracked.finally(() => pending.delete(tracked));
  return promise;
};

/** Test-only helper to reset module state between cases. */
export const __resetPersistOnQuitForTests = (): void => {
  pending.clear();
  installed = false;
  flushing = false;
  timedOut = false;
};
