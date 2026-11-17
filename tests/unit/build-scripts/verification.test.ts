import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  boundedWait,
  closeElectron,
  launchWithIdentity,
} from '../../../scripts/studio-preview/host-release/verification.mjs';

afterEach(() => vi.useRealTimers());

function application(error?: Error, exitCode: number | null = 0, signalCode: string | null = null) {
  const main = Object.assign(new EventEmitter(), { pid: 123, exitCode, signalCode });
  const app = {
    process: () => main,
    evaluate: vi.fn(async () => {
      if (error) throw error;
      return { pid: 123 };
    }),
    close: vi.fn(async () => {}),
  };
  return { main, app };
}

describe('fixture callback deadlines', () => {
  it('accepts a slow cold start above the old five second guard and logs elapsed time', async () => {
    vi.useFakeTimers();
    const log = vi.fn();
    const result = boundedWait(new Promise((resolve) => setTimeout(() => resolve('authorization'), 6000)), 'callback', {
      log,
    });
    await vi.advanceTimersByTimeAsync(6000);
    await expect(result).resolves.toBe('authorization');
    expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({ timeoutMs: 20000, status: 'passed' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('still rejects a hung helper and logs failure', async () => {
    vi.useFakeTimers();
    const log = vi.fn();
    const result = expect(boundedWait(new Promise(() => {}), 'callback', { log })).rejects.toThrow(
      'bounded wait elapsed'
    );
    await vi.advanceTimersByTimeAsync(20000);
    await result;
    expect(JSON.parse(log.mock.calls[0][0]).status).toBe('failed');
  });
});

describe('Electron restart evidence', () => {
  const destroyed = new Error('Execution context was destroyed');
  it('waits for the old OS process even when app.close has already resolved', async () => {
    const { main, app } = application(undefined, null);
    let completed = false;
    const closing = closeElectron(app).then(() => {
      completed = true;
    });
    await Promise.resolve();
    expect(completed).toBe(false);
    main.exitCode = 0;
    main.emit('exit', 0, null);
    await closing;
    expect(completed).toBe(true);
  });

  it('retains a clean pre-identity restart failure and evaluates the replacement', async () => {
    const failed = application(destroyed);
    const replacement = application();
    const launch = vi.fn().mockResolvedValueOnce(failed.app).mockResolvedValueOnce(replacement.app);
    const record = vi.fn();
    const result = await launchWithIdentity(launch, { restarting: true, record });
    expect(result.app).toBe(replacement.app);
    expect(record.mock.calls[0][0]).toMatchObject({ exitCode: 0, retry: true, status: 'failed' });
    expect(launch).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['first startup', false, 0, null, destroyed],
    ['crash', true, 1, null, destroyed],
    ['signal', true, null, 'SIGTERM', destroyed],
    ['assertion', true, 0, null, new Error('identity assertion failed')],
  ])('does not retry %s', async (_label, restarting, code, signal, error) => {
    const { app } = application(error as Error, code as number | null, signal as string | null);
    const launch = vi.fn().mockResolvedValue(app);
    await expect(launchWithIdentity(launch, { restarting, record: vi.fn() })).rejects.toThrow(error as Error);
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it('fails after the second clean early exit', async () => {
    const { app } = application(destroyed);
    const launch = vi.fn().mockResolvedValue(app);
    await expect(launchWithIdentity(launch, { restarting: true, record: vi.fn() })).rejects.toThrow(destroyed);
    expect(launch).toHaveBeenCalledTimes(2);
  });
});
