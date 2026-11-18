/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { appHandlers, appQuit } = vi.hoisted(() => ({
  appHandlers: {} as Record<string, Array<(...args: unknown[]) => void>>,
  appQuit: vi.fn(),
}));

const fireAppEvent = (event: string, ...args: unknown[]) => {
  for (const fn of appHandlers[event] ?? []) fn(...args);
};

vi.mock('electron', () => ({
  app: {
    on: (event: string, fn: (...args: unknown[]) => void) => {
      (appHandlers[event] ??= []).push(fn);
    },
    quit: appQuit,
  },
}));

import { trackPersistedWrite, __resetPersistOnQuitForTests } from '@/process/utils/persistOnQuit';

describe('persistOnQuit', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  beforeEach(() => {
    for (const key of Object.keys(appHandlers)) delete appHandlers[key];
    appQuit.mockReset();
    __resetPersistOnQuitForTests();
  });

  it('waits for writes first created by window close after before-quit', async () => {
    const beforeQuit = vi.fn();
    fireAppEvent('before-quit', { preventDefault: beforeQuit });
    let release: (() => void) | undefined;
    trackPersistedWrite(
      new Promise<void>((resolve) => {
        release = resolve;
      })
    );
    const willQuit = vi.fn();
    fireAppEvent('will-quit', { preventDefault: willQuit });
    expect(beforeQuit).not.toHaveBeenCalled();
    expect(willQuit).toHaveBeenCalled();
    release?.();
    await vi.waitFor(() => expect(appQuit).toHaveBeenCalledTimes(1));
  });

  it('also drains another write added while the first batch is settling', async () => {
    vi.useFakeTimers();
    let first: (() => void) | undefined;
    let second: (() => void) | undefined;
    trackPersistedWrite(
      new Promise<void>((resolve) => {
        first = resolve;
      })
    );
    fireAppEvent('will-quit', { preventDefault: vi.fn() });
    trackPersistedWrite(
      new Promise<void>((resolve) => {
        second = resolve;
      })
    );
    first?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(appQuit).not.toHaveBeenCalled();
    second?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(appQuit).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('continues shutdown after five seconds even if a write never settles', async () => {
    vi.useFakeTimers();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    trackPersistedWrite(new Promise(() => {}));
    fireAppEvent('will-quit', { preventDefault: vi.fn() });
    await vi.advanceTimersByTimeAsync(4999);
    expect(appQuit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect([appQuit.mock.calls.length, log.mock.calls.length]).toEqual([1, 1]);
    const preventDefault = vi.fn();
    fireAppEvent('will-quit', { preventDefault });
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it('defers app.quit until a pending write resolves', async () => {
    let resolveWrite: (() => void) | undefined;
    trackPersistedWrite(
      new Promise<void>((r) => {
        resolveWrite = r;
      })
    );

    const preventDefault = vi.fn();
    fireAppEvent('will-quit', { preventDefault });
    expect(preventDefault).toHaveBeenCalled();
    expect(appQuit).not.toHaveBeenCalled();

    resolveWrite?.();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await vi.waitFor(() => expect(appQuit).toHaveBeenCalledTimes(1));
  });

  it('does not block quit when no writes are pending', async () => {
    // Track a write and let it settle so the pending set is empty.
    trackPersistedWrite(Promise.resolve());
    await Promise.resolve();
    await Promise.resolve();

    const preventDefault = vi.fn();
    fireAppEvent('will-quit', { preventDefault });
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it('still allows quit when a tracked write rejects', async () => {
    let rejectWrite: ((reason: Error) => void) | undefined;
    trackPersistedWrite(
      new Promise<void>((_resolve, reject) => {
        rejectWrite = reject;
      })
    );

    const preventDefault = vi.fn();
    fireAppEvent('will-quit', { preventDefault });
    expect(preventDefault).toHaveBeenCalled();

    rejectWrite?.(new Error('disk full'));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await vi.waitFor(() => expect(appQuit).toHaveBeenCalledTimes(1));
  });

  it('keeps blocking repeated will-quit events while writes are still flushing', async () => {
    let resolveWrite: (() => void) | undefined;
    trackPersistedWrite(
      new Promise<void>((resolve) => {
        resolveWrite = resolve;
      })
    );

    const firstPreventDefault = vi.fn();
    fireAppEvent('will-quit', { preventDefault: firstPreventDefault });
    expect(firstPreventDefault).toHaveBeenCalled();

    const secondPreventDefault = vi.fn();
    fireAppEvent('will-quit', { preventDefault: secondPreventDefault });
    expect(secondPreventDefault).toHaveBeenCalled();
    expect(appQuit).not.toHaveBeenCalled();

    resolveWrite?.();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await vi.waitFor(() => expect(appQuit).toHaveBeenCalledTimes(1));
  });
});
