import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  boundedWait,
  closeElectron,
  launchWithIdentity,
  recordLaunchFailure,
} from '../../../scripts/studio-preview/host-release/verification.mjs';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

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

describe('Electron launch evidence without retry', () => {
  const destroyed = new Error('Execution context was destroyed');
  const options = (record = vi.fn()) => ({
    launchNumber: 3,
    record,
    remainingProcesses: { status: 'observed', processes: [] },
  });
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

  it.each([
    ['clean natural exit', 0, null],
    ['crash', 1, null],
    ['signal', null, 'SIGTERM'],
  ])('fails a restart on %s without launching a replacement', async (_label, code, signal) => {
    const { app } = application(destroyed, code as number | null, signal as string | null);
    const launch = vi.fn().mockResolvedValue(app);
    const record = vi.fn();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(launchWithIdentity(launch, options(record))).rejects.toThrow(destroyed);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Studio launch #3 FAILED: naturalExit=true'));
    expect(record.mock.calls.find(([row]) => row.status === 'failed')?.[0]).toMatchObject({
      launch: 3,
      exitCode: code,
      signal,
      naturalExit: true,
      closeRequestedAt: null,
      exitObservedAt: expect.any(String),
    });
  });

  it('retains a pre-handle launch failure for the uploaded result', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const record = vi.fn();
    await expect(
      launchWithIdentity(async () => {
        throw new Error('launch failed');
      }, options(record))
    ).rejects.toThrow('launch failed');
    expect(record.mock.calls.at(-1)?.[0]).toMatchObject({ launch: 3, status: 'failed', error: 'Error: launch failed' });
  });

  it('records main output and spontaneous exit after identity before smoke closes', async () => {
    const { app, main } = application(undefined, null);
    const stdout = new EventEmitter();
    const observedMain = Object.assign(main, { stdout });
    const record = vi.fn();
    await launchWithIdentity(async () => app, options(record));
    stdout.emit('data', Buffer.from('initialization failed'));
    observedMain.exitCode = 0;
    observedMain.emit('exit', 0, null);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    recordLaunchFailure(app, destroyed);
    expect(record.mock.calls.at(-1)?.[0]).toMatchObject({
      stdout: 'initialization failed',
      naturalExit: true,
      closeRequestedAt: null,
    });
    await closeElectron(app);
    expect(record.mock.calls.at(-1)?.[0]).toMatchObject({ naturalExit: true, closeRequestedAt: expect.any(String) });
  });

  it('distinguishes shutdown requested by smoke from a natural exit', async () => {
    const { app, main } = application(undefined, null);
    const record = vi.fn();
    await launchWithIdentity(async () => app, options(record));
    app.close.mockImplementation(async () => {
      main.exitCode = 0;
      main.emit('exit', 0, null);
    });
    await closeElectron(app);
    expect(record.mock.calls.at(-1)?.[0]).toMatchObject({ naturalExit: false, closeRequestedAt: expect.any(String) });
  });
});
