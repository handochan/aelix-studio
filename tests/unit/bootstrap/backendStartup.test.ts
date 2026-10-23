/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { startBackendOrExit } from '@/process/startup/backendStartup';

describe('startBackendOrExit', () => {
  it('does not report success until asynchronous runtime registration completes', async () => {
    let release: () => void = () => {};
    const registered = new Promise<void>((resolve) => {
      release = resolve;
    });
    const onStarted = vi.fn(() => registered);
    const complete = vi.fn();
    const task = startBackendOrExit({
      startBackend: async () => 42123,
      onStarted,
      captureFailure: vi.fn(),
      exitApp: vi.fn(),
    }).then(complete);
    await vi.waitFor(() => expect(onStarted).toHaveBeenCalled());
    expect(complete).not.toHaveBeenCalled();
    release();
    await task;
    expect(complete).toHaveBeenCalledWith({ ok: true, port: 42123 });
  });

  it('surfaces registration failure instead of opening an app without its bundled agents', async () => {
    const error = new Error('bundled Analytics is missing');
    const captureFailure = vi.fn();
    const result = await startBackendOrExit({
      startBackend: async () => 42123,
      onStarted: async () => {
        throw error;
      },
      captureFailure,
      exitApp: vi.fn(),
      exitOnFailure: false,
      logError: vi.fn(),
    });
    expect(result).toEqual({ ok: false });
    expect(captureFailure).toHaveBeenCalledWith(error);
  });

  it('registers the backend port when startup succeeds', async () => {
    const onStarted = vi.fn();
    const captureFailure = vi.fn();
    const exitApp = vi.fn();

    const result = await startBackendOrExit({
      startBackend: async () => 42123,
      onStarted,
      captureFailure,
      exitApp,
      logError: vi.fn(),
    });

    expect(result).toEqual({ ok: true, port: 42123 });
    expect(onStarted).toHaveBeenCalledWith(42123);
    expect(captureFailure).not.toHaveBeenCalled();
    expect(exitApp).not.toHaveBeenCalled();
  });

  it('captures startup failure and exits without registering a backend port by default', async () => {
    const error = new Error('aioncore failed to start within timeout');
    const calls: string[] = [];
    const onStarted = vi.fn();
    const captureFailure = vi.fn(async () => {
      calls.push('capture-start');
      await Promise.resolve();
      calls.push('capture-end');
    });
    const exitApp = vi.fn(() => {
      calls.push('exit');
    });
    const logError = vi.fn();

    const result = await startBackendOrExit({
      startBackend: async () => {
        throw error;
      },
      onStarted,
      captureFailure,
      exitApp,
      logError,
    });

    expect(result).toEqual({ ok: false });
    expect(logError).toHaveBeenCalledWith('[AionUi] Failed to start aioncore:', error);
    expect(captureFailure).toHaveBeenCalledWith(error);
    expect(exitApp).toHaveBeenCalledWith(1);
    expect(calls).toEqual(['capture-start', 'capture-end', 'exit']);
    expect(onStarted).not.toHaveBeenCalled();
  });

  it('captures startup failure without dialog or exit when exitOnFailure is disabled', async () => {
    const error = new Error('aioncore exited before health check passed');
    const onStarted = vi.fn();
    const captureFailure = vi.fn();
    const exitApp = vi.fn();
    const logError = vi.fn();

    const result = await startBackendOrExit({
      startBackend: async () => {
        throw error;
      },
      onStarted,
      captureFailure,
      exitApp,
      exitOnFailure: false,
      logError,
    });

    expect(result).toEqual({ ok: false });
    expect(logError).toHaveBeenCalledWith('[AionUi] Failed to start aioncore:', error);
    expect(captureFailure).toHaveBeenCalledWith(error);
    expect(exitApp).not.toHaveBeenCalled();
    expect(onStarted).not.toHaveBeenCalled();
  });

  it('does not capture or exit when backend startup is cancelled by shutdown', async () => {
    const error = new Error('aioncore startup cancelled');
    error.name = 'BackendStartupCancelledError';
    const onStarted = vi.fn();
    const captureFailure = vi.fn();
    const exitApp = vi.fn();
    const logError = vi.fn();

    const result = await startBackendOrExit({
      startBackend: async () => {
        throw error;
      },
      onStarted,
      captureFailure,
      exitApp,
      logError,
    });

    expect(result).toEqual({ ok: false });
    expect(logError).not.toHaveBeenCalled();
    expect(captureFailure).not.toHaveBeenCalled();
    expect(exitApp).not.toHaveBeenCalled();
    expect(onStarted).not.toHaveBeenCalled();
  });
});
