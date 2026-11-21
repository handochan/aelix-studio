import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProcessTimeline } from '../../../scripts/studio-preview/host-release/probes/processTimeline.mjs';
import {
  boundedWait,
  closeElectron,
  launchWithIdentity,
  recordLaunchFailure,
  recordLaunchEvidence,
  writeRendererResult,
  configSummary,
  electronAppEnvironment,
  verifyConfigPreserved,
  verifyInstalledBackend,
} from '../../../scripts/studio-preview/host-release/verification.mjs';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('installed profile preservation', () => {
  it.each(['', btoa(encodeURIComponent('{}')), btoa(encodeURIComponent('{"update.autoCheck":true}'))])(
    'fails immediately on lost or enabled preference and records safe evidence',
    async (raw) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-profile-'));
      try {
        const file = path.join(root, 'config.txt');
        await fs.writeFile(file, raw);
        const record = vi.fn();
        expect(() => verifyConfigPreserved(file, { phase: 'after-os-exit', launch: 1, record })).toThrow(
          'config preservation failed'
        );
        expect(record.mock.calls[0][0]).toMatchObject({
          phase: 'after-os-exit',
          launch: 1,
          bytes: Buffer.byteLength(raw),
          status: 'failed',
        });
        expect(await fs.readFile(file, 'utf8')).toBe(raw);
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    }
  );

  it('accepts persisted false before the next launch without exposing other values', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-profile-'));
    try {
      const file = path.join(root, 'config.txt');
      await fs.writeFile(
        file,
        btoa(encodeURIComponent(JSON.stringify({ 'update.autoCheck': false, secret: 'SYNTHETIC_SECRET' })))
      );
      const result = verifyConfigPreserved(file, { phase: 'before-launch', launch: 2, record: vi.fn() });
      expect(result).toMatchObject({ status: 'passed', keyCount: 2, autoCheck: false });
      expect(JSON.stringify(result)).not.toContain('SYNTHETIC_SECRET');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('records a missing file as failure rather than recreating it', () => {
    expect(configSummary(path.join(os.tmpdir(), 'absent-studio-config', 'missing.txt'))).toMatchObject({
      bytes: null,
      errorCode: 'ENOENT',
    });
  });

  it('retains DEBUG on the driver and excludes it from the application copy', () => {
    const driver = { DEBUG: 'pw:browser', PATH: '/synthetic' };
    expect(electronAppEnvironment(driver)).toEqual({ PATH: '/synthetic' });
    expect(driver.DEBUG).toBe('pw:browser');
  });
});

function application(error?: Error, failureExitCode: number | null = 0, failureSignal: string | null = null) {
  const main = Object.assign(new EventEmitter(), {
    pid: 123,
    exitCode: null as number | null,
    signalCode: null as string | null,
  });
  const exit = (exitCode: number | null, signalCode: string | null) => {
    Object.assign(main, { exitCode, signalCode });
    main.emit('exit', exitCode, signalCode);
  };
  const app = {
    process: () => main,
    firstWindow: vi.fn(async (_options?: { timeout: number }) => ({})),
    evaluate: vi.fn(async (_expression?: () => object, _token?: string) => {
      if (error) {
        if (failureExitCode !== null || failureSignal !== null) exit(failureExitCode, failureSignal);
        throw error;
      }
      return { pid: 123 };
    }),
    close: vi.fn(async () => {
      if (main.exitCode === null && main.signalCode === null) exit(0, null);
    }),
  };
  return { main, app };
}

const collected = { code: -32000, message: 'Promise was collected' };

type InspectorRequest = {
  id: number;
  method: string;
  params?: { awaitPromise?: boolean; returnByValue?: boolean; objectId?: string; functionDeclaration?: string };
};

function inspectorApplication(
  replies: Array<
    { code: number; message: string } | { pid: number; backendOverride?: string; resourcesPath?: string } | 'hang'
  >,
  { unrelatedError = false, beforeSyncResponse = () => {} } = {}
) {
  const require = createRequire(import.meta.url);
  const testRequire = createRequire(require.resolve('@playwright/test/package.json'));
  const library = createRequire(testRequire.resolve('playwright/package.json'));
  const base = path.dirname(library.resolve('playwright-core/package.json'));
  const { helper } = require(path.join(base, 'lib/server/helper.js'));
  const { CRConnection } = require(path.join(base, 'lib/server/chromium/crConnection.js'));
  const { CRExecutionContext } = require(path.join(base, 'lib/server/chromium/crExecutionContext.js'));
  const { ExecutionContext, JSHandle } = require(path.join(base, 'lib/server/javascript.js'));
  const { createRootSdkObject } = require(path.join(base, 'lib/server/instrumentation.js'));
  const { ElectronApplication } = require(path.join(base, 'lib/client/electron.js'));
  const { parseSerializedValue, serializeValue } = require(path.join(base, 'lib/protocol/serializers.js'));
  const { serializeAsCallArgument } = require(path.join(base, 'lib/utils/isomorphic/utilityScriptSerializers.js'));
  const { main, app } = application();
  const synchronousReads: InspectorRequest[] = [];

  const launch = vi.fn(async () => {
    const transport = {
      onmessage: (_message: unknown) => {},
      onclose: () => {},
      close: () => {},
      send: (request: InspectorRequest) => {
        const { id, method } = request;
        const reply = method === 'Runtime.evaluate' ? null : replies.shift();
        if (reply === undefined) throw new Error('Unexpected fixture evaluation');
        const synchronous = request.params?.awaitPromise === false;
        if (synchronous) synchronousReads.push(request);
        if (reply === 'hang') return;
        queueMicrotask(() => {
          if (synchronous) beforeSyncResponse();
          transport.onmessage(
            reply === null
              ? { id, result: { result: { type: 'object', objectId: 'utility' } } }
              : 'code' in reply
                ? { id, error: reply }
                : {
                    id,
                    result: {
                      result: {
                        type: 'object',
                        value: synchronous
                          ? reply
                          : serializeAsCallArgument(reply, (value: unknown) => ({ fallThrough: value })),
                      },
                    },
                  }
          );
        });
      },
    };
    const sdk = createRootSdkObject();
    const connection = new CRConnection(sdk, transport, helper.debugProtocolLogger(), { recentLogs: () => [] });
    const context = new ExecutionContext(sdk, new CRExecutionContext(connection.rootSession, { id: 1 }), 'electron');
    const handle = new JSHandle(context, 'object', 'electron', 'electron-handle');
    Object.assign(app, {
      _connection: {
        toImpl: () => ({
          process: () => main,
          _nodeElectronHandlePromise: Promise.resolve(handle),
          _nodeSession: connection.rootSession,
        }),
      },
    });
    // Use the real serializers and JSHandle route with a fixture transport
    // and in-process dispatcher lookup.
    const client = {
      _channel: {
        async evaluateExpression(params: { expression: string; isFunction: boolean; arg: { value: unknown } }) {
          if (unrelatedError)
            await handle
              .evaluateExpression(params.expression, { isFunction: params.isFunction }, 'unrelated')
              .catch(() => {});
          const value = await handle.evaluateExpression(
            params.expression,
            { isFunction: params.isFunction },
            parseSerializedValue(params.arg.value, [])
          );
          return { value: serializeValue(value, (item: unknown) => ({ fallThrough: item })) };
        },
      },
    };
    app.evaluate.mockImplementation((fn, token) => ElectronApplication.prototype.evaluate.call(client, fn, token));
    return app;
  });
  return { app, launch, main, synchronousReads };
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

describe('Electron launch evidence and identity retry', () => {
  const destroyed = new Error('Execution context was destroyed');
  const options = (record = vi.fn()) => ({
    launchNumber: 3,
    record,
    remainingProcesses: { status: 'observed', processes: [] },
  });

  it('shares the launch timeout and records readiness before evaluating identity', async () => {
    vi.useFakeTimers();
    const { app } = application();
    const record = vi.fn();
    const launch = vi.fn((_timeout: number) => new Promise((resolve) => setTimeout(() => resolve(app), 20000)));
    app.firstWindow.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve({}), 39000)));
    const result = launchWithIdentity(launch, options(record));
    await vi.advanceTimersByTimeAsync(20000);
    expect(launch).toHaveBeenCalledWith(60000);
    expect(app.firstWindow).toHaveBeenCalledWith({ timeout: 40000 });
    await vi.advanceTimersByTimeAsync(38999);
    expect(app.evaluate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toEqual({ app, identity: { pid: 123 } });
    const row = record.mock.calls.at(-1)?.[0];
    expect(row).toMatchObject({ launch: 3, firstWindowWait: { outcome: 'passed' }, status: 'identified' });
    expect(Date.parse(row.firstWindowWait.finishedAt) - Date.parse(row.firstWindowWait.startedAt)).toBe(39000);
    expect(row.identityStartedAt).toBe(row.firstWindowWait.finishedAt);
  });

  it('fails and cleans up without identity evaluation when the first window exhausts the remaining budget', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { app, main } = application(undefined, null);
    app.close.mockImplementation(async () => {
      main.exitCode = 0;
      main.emit('exit', 0, null);
    });
    const error = new Error('firstWindow: timeout');
    app.firstWindow.mockImplementation(
      ({ timeout } = { timeout: 0 }) => new Promise((_resolve, reject) => setTimeout(() => reject(error), timeout))
    );
    const launch = vi.fn(() => new Promise((resolve) => setTimeout(() => resolve(app), 59000)));
    const record = vi.fn();
    const checked = expect(launchWithIdentity(launch, options(record))).rejects.toBe(error);
    await vi.advanceTimersByTimeAsync(59999);
    expect(app.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await checked;
    expect(app.firstWindow).toHaveBeenCalledWith({ timeout: 1000 });
    expect(app.evaluate).not.toHaveBeenCalled();
    expect(app.close).toHaveBeenCalledTimes(1);
    expect(record.mock.calls.at(-1)?.[0]).toMatchObject({
      launch: 3,
      firstWindowWait: { startedAt: expect.any(String), finishedAt: expect.any(String), outcome: 'failed' },
      waits: [{ phase: 'first-window-failure-cleanup' }],
    });
  });

  it.each([
    [0, null, 'code 0'],
    [17, null, 'code 17'],
    [null, 'SIGTERM', 'signal SIGTERM'],
  ])('fails immediately on an already exited launcher (%s, %s)', async (exitCode, signal, reason) => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { app, main } = application();
    Object.assign(main, { exitCode, signalCode: signal });
    const record = vi.fn();
    const checked = expect(launchWithIdentity(async () => app, options(record))).rejects.toThrow(
      `application exited with ${reason} before the first window`
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(app.firstWindow).not.toHaveBeenCalled();
    await checked;
    expect(app.evaluate).not.toHaveBeenCalled();
    expect(app.close).toHaveBeenCalledTimes(1);
    expect(record.mock.calls.at(-1)?.[0]).toMatchObject({
      exitCode,
      signal,
      naturalExit: true,
      firstWindowWait: { outcome: 'failed' },
      waits: [{ phase: 'first-window-failure-cleanup', alreadyExited: true }],
    });
  });

  it('fails on OS exit while a descendant still holds the launcher output pipes open', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-window-exit-'));
    const release = path.join(root, 'release-pipes');
    const keeper = `
      const { existsSync } = require('node:fs');
      setTimeout(() => process.exit(0), 8000).unref();
      setInterval(() => { if (existsSync(process.argv[1])) process.exit(0); }, 20);
    `;
    const launcher = `
      const { spawn } = require('node:child_process');
      process.once('message', () => process.exit(17));
      if (process.platform !== 'win32')
        spawn(process.execPath, ['-e', process.argv[1], process.argv[2]], { stdio: 'inherit' }).unref();
      process.send('ready');
    `;
    const main = spawn(process.execPath, ['-e', launcher, keeper, release], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
    const closed = once(main, 'close').then(() => {});
    let releaseCloseNotification: (() => void) | undefined;
    // The Windows runner can close those streams at process exit. Exercise the
    // delayed Playwright notification there with the same real launcher exit.
    const closeNotification =
      process.platform === 'win32'
        ? new Promise<void>((resolve) => {
            releaseCloseNotification = resolve;
          })
        : closed;
    let closeNotified = false;
    void closeNotification.then(() => {
      closeNotified = true;
    });
    const { app: fixture } = application();
    const app = {
      ...fixture,
      process: () => main,
      // Match Playwright's wait and cleanup dependency on ChildProcess 'close'.
      firstWindow: vi.fn(({ timeout }: { timeout: number }) => {
        main.send('exit');
        return new Promise((_resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('firstWindow: timeout')), timeout);
          void closeNotification.then(() => {
            clearTimeout(timer);
            reject(new Error('Playwright close'));
          });
        });
      }),
      close: vi.fn(async () => closeNotification),
    };
    const record = vi.fn();
    try {
      await once(main, 'message');
      const result = launchWithIdentity(async () => app, { ...options(record), launchTimeoutMs: 1500 });
      await expect(boundedWait(result, 'OS exit fixture', { timeoutMs: 3000, log: () => {} })).rejects.toThrow(
        'application exited with code 17 before the first window'
      );
      expect(closeNotified).toBe(false);
      expect(app.evaluate).not.toHaveBeenCalled();
      expect(app.close).toHaveBeenCalledTimes(1);
      expect(record.mock.calls.find(([row]) => row.status === 'failed')?.[0]).toMatchObject({
        exitCode: 17,
        signal: null,
        naturalExit: true,
        firstWindowWait: { outcome: 'failed' },
      });
    } finally {
      releaseCloseNotification?.();
      await fs.writeFile(release, '');
      await closed;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it.each(['next launch running', 'timeline stopped'])(
    'isolates a delayed first-window cleanup with %s',
    async (scenario) => {
      vi.useFakeTimers();
      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(console, 'log').mockImplementation(() => {});
      const first = application();
      const second = application();
      second.main.pid = 456;
      const stdout = new EventEmitter();
      Object.assign(first.main, { stdout });
      let finishClose!: () => void;
      const closing = new Promise<void>((resolve) => (finishClose = resolve));
      first.app.close.mockImplementation(() => closing);
      first.app.firstWindow.mockImplementation(() => {
        first.main.exitCode = 17;
        first.main.emit('exit', 17, null);
        return new Promise(() => {});
      });

      let secondRunning = false;
      const timelineRecord = vi.fn();
      const processTimeline = createProcessTimeline({
        record: timelineRecord,
        publishIntervalMs: 0,
        snapshot: () => ({
          status: 'observed',
          rows: secondRunning
            ? [{ pid: second.main.pid, parentPid: 1, birth: 'second', role: 'other', state: 'live' }]
            : [],
        }),
      });
      const record = vi.fn();
      try {
        processTimeline.start();
        processTimeline.checkpoint('before-launch', 1);
        await expect(
          launchWithIdentity(async () => first.app, { ...options(record), launchNumber: 1, processTimeline })
        ).rejects.toThrow('application exited with code 17 before the first window');
        expect(first.app.close).toHaveBeenCalledTimes(1);
        expect.soft(record.mock.calls.at(-1)?.[0]).toMatchObject({
          launch: 1,
          exitCode: 17,
          waits: [{ phase: 'first-window-failure-cleanup', alreadyExited: true }],
        });

        if (scenario === 'next launch running') {
          secondRunning = true;
          processTimeline.checkpoint('before-launch', 2);
          await launchWithIdentity(async () => second.app, { ...options(record), launchNumber: 2, processTimeline });
        } else {
          processTimeline.checkpoint('cleanup-complete', 1);
          processTimeline.stop();
        }
        await vi.advanceTimersByTimeAsync(0);
        const previousTimelineWrites = timelineRecord.mock.calls.length;
        const previousLaunchWrites = record.mock.calls.length;

        finishClose();
        stdout.emit('data', Buffer.from('delayed output from the old launch'));
        await vi.advanceTimersByTimeAsync(1001);

        expect.soft(record.mock.calls.length).toBe(previousLaunchWrites);
        const writes = timelineRecord.mock.calls.slice(previousTimelineWrites);
        if (secondRunning) {
          expect(writes.length).toBeGreaterThan(0);
          expect(writes.every(([, event]) => !event || event.launch === 2)).toBe(true);
          expect(writes.at(-1)?.[0].processes).toContainEqual(
            expect.objectContaining({ pid: second.main.pid, launchAtStart: 2, launchAtCompletion: 2 })
          );
        } else {
          expect(writes).toEqual([]);
        }
      } finally {
        finishClose();
        processTimeline.stop();
      }
    }
  );

  it.each(['launch deadline already elapsed', 'window arrives after deadline'])('rejects if %s', async (scenario) => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { app } = application();
    const lateLaunch = scenario === 'launch deadline already elapsed';
    const launch = vi.fn(() => new Promise((resolve) => setTimeout(() => resolve(app), lateLaunch ? 1000 : 0)));
    app.firstWindow.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve({}), 1001)));
    const checked = expect(launchWithIdentity(launch, { ...options(), launchTimeoutMs: 1000 })).rejects.toThrow(
      'first window exceeded the 1000ms launch timeout'
    );
    await vi.advanceTimersByTimeAsync(1001);
    await checked;
    expect(app.firstWindow).toHaveBeenCalledTimes(lateLaunch ? 0 : 1);
    expect(app.evaluate).not.toHaveBeenCalled();
  });

  it('samples during the first-window wait and pauses only for identity', async () => {
    vi.useFakeTimers();
    const { app } = application();
    app.firstWindow.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve({}), 2000)));
    app.evaluate.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve({ pid: 123 }), 2000)));
    const snapshot = vi.fn(() => ({ status: 'observed', rows: [] }));
    const timeline = createProcessTimeline({ snapshot });
    timeline.start();
    try {
      const result = launchWithIdentity(async () => app, { ...options(), processTimeline: timeline });
      await vi.advanceTimersByTimeAsync(1500);
      expect(snapshot).toHaveBeenCalled();
      expect(app.evaluate).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(501);
      expect(app.evaluate).toHaveBeenCalledTimes(1);
      snapshot.mockClear();
      await vi.advanceTimersByTimeAsync(1998);
      expect(snapshot).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2);
      await expect(result).resolves.toMatchObject({ identity: { pid: 123 } });
      expect(snapshot).toHaveBeenCalled();
    } finally {
      timeline.stop();
    }
  });

  it('retries on the original inspector object without awaiting a promise', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-identity-retry-'));
    try {
      writeRendererResult(root, {});
      const launches: object[] = [];
      const record = vi.fn((value: { launch: number }) => {
        launches[value.launch - 1] = value;
        recordLaunchEvidence(root, { mainLaunches: launches }, value);
      });
      // Windows installer artifact 14482766412 reports launcher 4888 and Electron 3016.
      const identity = { pid: 3016, resourcesPath: '/installed/resources' };
      const { app, launch, main, synchronousReads } = inspectorApplication([collected, identity]);
      main.pid = 4888;
      await expect(launchWithIdentity(launch, options(record))).resolves.toEqual({ app, identity });
      expect(launch).toHaveBeenCalledTimes(1);
      expect(app.evaluate).toHaveBeenCalledTimes(1);
      expect(synchronousReads).toMatchObject([
        {
          method: 'Runtime.callFunctionOn',
          params: { objectId: 'electron-handle', awaitPromise: false, returnByValue: true },
        },
      ]);
      expect(log).toHaveBeenCalledWith(expect.stringContaining('retrying identity without awaiting a promise'));
      expect(app.close).not.toHaveBeenCalled();
      const text = await fs.readFile(path.join(root, 'renderer-result.json'), 'utf8');
      const firstError = {
        method: 'Runtime.callFunctionOn',
        ...collected,
        messageRedacted: false,
        connection: 1,
        requestId: expect.any(Number),
        awaitPromise: true,
        returnByValue: true,
      };
      expect(JSON.parse(text).mainLaunches[2]).toMatchObject({
        pid: 4888,
        firstWindowWait: { startedAt: expect.any(String), finishedAt: expect.any(String), outcome: 'passed' },
        identityFailedAt: expect.any(String),
        identityProtocol: { errors: [firstError] },
        identityRetry: {
          startedAt: expect.any(String),
          finishedAt: expect.any(String),
          firstProtocolError: firstError,
          method: 'synchronous-inspector',
          outcome: 'passed',
        },
        status: 'identified',
      });
      for (const [, token] of app.evaluate.mock.calls) expect(text).not.toContain(token);
      await closeElectron(app);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it.each(['Promise was collected: path', 'promise was collected', 'Cannot find context with specified id'])(
    'does not retry a different original CDP message (%s)',
    async (message) => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.useFakeTimers();
      const { app, launch } = inspectorApplication([{ code: -32000, message }]);
      const record = vi.fn();
      const result = expect(launchWithIdentity(launch, options(record))).rejects.toThrow(destroyed.message);
      await vi.advanceTimersByTimeAsync(20000);
      await result;
      expect(app.evaluate).toHaveBeenCalledTimes(1);
      expect(record.mock.calls.some(([row]) => row.identityRetry)).toBe(false);
    }
  );

  it('does not use the original error of a different evaluation during the same identity call', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.useFakeTimers();
    const { app, launch } = inspectorApplication(
      [collected, { code: -32000, message: 'Cannot find context with specified id' }],
      { unrelatedError: true }
    );
    const record = vi.fn();
    const result = expect(launchWithIdentity(launch, options(record))).rejects.toThrow(destroyed.message);
    await vi.advanceTimersByTimeAsync(20000);
    await result;
    expect(app.evaluate).toHaveBeenCalledTimes(1);
    expect(record.mock.calls.at(-1)?.[0]).toMatchObject({
      identityProtocol: { errors: [collected, { message: 'Cannot find context with specified id' }] },
    });
    expect(record.mock.calls.some(([row]) => row.identityRetry)).toBe(false);
  });

  it('does not retry the exact message with a different CDP code', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.useFakeTimers();
    const { app, launch } = inspectorApplication([{ ...collected, code: -32001 }, { pid: 123 }]);
    const result = expect(launchWithIdentity(launch, options())).rejects.toThrow(destroyed.message);
    await vi.advanceTimersByTimeAsync(20000);
    await result;
    expect(app.evaluate).toHaveBeenCalledTimes(1);
  });

  it('does not retry a correlated error after the app exits', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { app, launch, main } = inspectorApplication([collected, { pid: 123 }]);
    const record = vi.fn();
    await expect(
      launchWithIdentity(async () => {
        await launch();
        const evaluate = app.evaluate.getMockImplementation()!;
        app.evaluate.mockImplementationOnce(async (fn, token) => {
          try {
            return await evaluate(fn, token);
          } finally {
            main.exitCode = 17;
            main.emit('exit', 17, null);
          }
        });
        return app;
      }, options(record))
    ).rejects.toThrow(destroyed.message);
    expect(app.evaluate).toHaveBeenCalledTimes(1);
    expect(record.mock.calls.at(-1)?.[0]).toMatchObject({ exitCode: 17, naturalExit: true });
  });

  it('still rejects an installed backend identity mismatch after the synchronous read succeeds', async () => {
    const { launch } = inspectorApplication([collected, { pid: 3016, backendOverride: '/dev/host' }]);
    const result = launchWithIdentity(launch, options()).then(({ identity }) => verifyInstalledBackend(identity));
    await expect(result).rejects.toMatchObject({ code: 'ERR_ASSERTION', actual: '/dev/host' });
  });

  it('fails at the original deadline if the synchronous read hangs', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.useFakeTimers();
    const { app, launch, synchronousReads } = inspectorApplication([collected, 'hang']);
    const result = expect(launchWithIdentity(launch, { ...options(), launchTimeoutMs: 1200 })).rejects.toThrow(
      'electron-identity-retry-response: bounded wait elapsed (1200ms)'
    );
    await vi.advanceTimersByTimeAsync(21200);
    await result;
    expect(synchronousReads).toHaveLength(1);
    expect(app.close).toHaveBeenCalledTimes(1);
  });

  it('rejects a late inspector reply even when the deadline timer has not fired', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.useFakeTimers();
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
    const { launch } = inspectorApplication([collected, { pid: 3016 }], {
      beforeSyncResponse() {
        // Advance only the deadline clock. The reply's microtask wins the timer race.
        clock.mockReturnValue(1201);
      },
    });
    const record = vi.fn();
    const result = launchWithIdentity(launch, { ...options(record), launchTimeoutMs: 1200 }).catch((error) => error);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(20000);
    expect(await result).toMatchObject({
      message: 'electron-identity-retry-response: bounded wait elapsed (1200ms)',
    });
    expect(record.mock.calls.find(([row]) => row.status === 'failed')?.[0].identityRetry.outcome).toBe('failed');
    expect(record.mock.calls.some(([row]) => row.status === 'identified')).toBe(false);
    expect(log).toHaveBeenCalledWith(
      expect.stringMatching(/"wait":"electron-identity-retry-response".*"status":"failed"/)
    );
  });

  it('rejects a late reply from the initial identity read', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.useFakeTimers();
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
    const { app } = application();
    app.evaluate.mockImplementationOnce(async () => {
      clock.mockReturnValue(1201);
      return { pid: 123 };
    });
    const result = launchWithIdentity(async () => app, { ...options(), launchTimeoutMs: 1200 }).catch((error) => error);
    await vi.advanceTimersByTimeAsync(20000);
    expect(await result).toMatchObject({ message: expect.stringContaining('identity evaluation exceeded') });
  });

  it('fails on a synchronous inspector error and preserves the exit wait before one cleanup', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.useFakeTimers();
    const { app, launch, synchronousReads } = inspectorApplication([
      collected,
      { code: -32000, message: 'Cannot find object with given id' },
    ]);
    const record = vi.fn();
    const result = expect(launchWithIdentity(launch, options(record))).rejects.toThrow(
      'Studio identity retry failed in the Electron inspector'
    );
    await vi.advanceTimersByTimeAsync(19999);
    expect(app.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await result;
    expect(synchronousReads).toHaveLength(1);
    expect(app.close).toHaveBeenCalledTimes(1);
    expect(record.mock.calls.at(-1)?.[0]).toMatchObject({
      identityRetry: { firstProtocolError: collected, outcome: 'failed' },
      protocol: {
        errors: [collected, { message: 'Cannot find object with given id', awaitPromise: false }],
      },
      waits: [
        { phase: 'identity-failure-exit-observation', timeoutMs: 20000, status: 'failed' },
        { phase: 'identity-failure-cleanup', status: 'passed' },
      ],
    });
  });

  it('rejects a retry if the app process handle changes', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { app, launch } = inspectorApplication([collected, { pid: 456 }], {
      beforeSyncResponse() {
        const { main: replacement } = application();
        replacement.exitCode = 0;
        app.process = () => replacement;
      },
    });
    await expect(launchWithIdentity(launch, options())).rejects.toThrow('Studio app changed during identity retry');
    expect(launch).toHaveBeenCalledTimes(1);
    expect(app.close).toHaveBeenCalledTimes(1);
  });

  it('does not start a retry if the launcher handle changed even with the same numeric PID', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { app, launch, main, synchronousReads } = inspectorApplication([collected, { pid: 3016 }]);
    const { main: replacement } = application();
    replacement.pid = main.pid;
    replacement.exitCode = 0;
    await expect(
      launchWithIdentity(async () => {
        await launch();
        const evaluate = app.evaluate.getMockImplementation()!;
        app.evaluate.mockImplementationOnce(async (fn, token) => {
          try {
            return await evaluate(fn, token);
          } finally {
            app.process = () => replacement;
          }
        });
        return app;
      }, options())
    ).rejects.toThrow(destroyed.message);
    expect(synchronousReads).toHaveLength(0);
  });

  it('rejects a valid identity reply if the original launcher exited during the retry', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { launch, main } = inspectorApplication([collected, { pid: 3016 }], {
      beforeSyncResponse() {
        main.signalCode = 'SIGTERM';
        main.emit('exit', null, 'SIGTERM');
      },
    });
    const record = vi.fn();
    await expect(launchWithIdentity(launch, options(record))).rejects.toThrow(
      'Studio app changed during identity retry'
    );
    expect(record.mock.calls.at(-1)?.[0]).toMatchObject({
      signal: 'SIGTERM',
      naturalExit: true,
      identityRetry: { outcome: 'failed' },
    });
  });

  it('rejects a retry that returns an invalid Electron PID', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.useFakeTimers();
    const { launch } = inspectorApplication([collected, { pid: 0 }]);
    const result = expect(launchWithIdentity(launch, options())).rejects.toThrow(
      'Studio identity retry returned an invalid PID'
    );
    await vi.advanceTimersByTimeAsync(20000);
    await result;
  });

  it('lets an already resolved launch enter identity protection before a previously queued batch', async () => {
    vi.useFakeTimers();
    const { app } = application();
    let identityDone: (value: { pid: number }) => void;
    app.evaluate.mockImplementation(
      () =>
        new Promise((resolve) => {
          identityDone = resolve;
        })
    );
    let launchResolved = false;
    let identityFinished = false;
    const intrusions: string[] = [];
    const snapshot = vi.fn(() => {
      if (launchResolved && !identityFinished) intrusions.push('batch-inside-identity-window');
      return { status: 'observed', rows: [] };
    });
    const processTimeline = createProcessTimeline({ snapshot });
    processTimeline.start(); // Leave the sample queued when launch resolves.
    const launch = vi.fn(() => {
      launchResolved = true;
      return Promise.resolve(app);
    });
    const result = launchWithIdentity(launch, { ...options(), processTimeline });
    await vi.advanceTimersByTimeAsync(2100);
    expect(app.evaluate).toHaveBeenCalledTimes(1);
    expect(snapshot).not.toHaveBeenCalled();
    identityFinished = true;
    identityDone!({ pid: 123 });
    await expect(result).resolves.toEqual({ app, identity: { pid: 123 } });
    await vi.advanceTimersByTimeAsync(0);
    expect(intrusions).toEqual([]);
    expect(snapshot).toHaveBeenCalledTimes(1);
    processTimeline.stop();
  });
  it.each(['success', 'failure'])('runs no synchronous batch before the %s identity result', async (outcome) => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { app, main } = application();
    let resolveIdentity: (value: { pid: number }) => void;
    let rejectIdentity: (error: Error) => void;
    app.evaluate.mockImplementation(
      () =>
        new Promise((resolve, reject) => {
          resolveIdentity = resolve;
          rejectIdentity = reject;
        })
    );
    const snapshot = vi.fn(() => ({ status: 'observed', rows: [] }));
    const timelineRecord = vi.fn();
    const processTimeline = createProcessTimeline({ snapshot, record: timelineRecord });
    processTimeline.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(snapshot).toHaveBeenCalledTimes(1); // Before-launch observation is retained.
    snapshot.mockClear();
    const launch = vi.fn().mockResolvedValue(app);
    const result = launchWithIdentity(launch, { ...options(), processTimeline });
    const checked =
      outcome === 'failure'
        ? expect(result).rejects.toBe(destroyed)
        : expect(result).resolves.toEqual({ app, identity: { pid: 123 } });
    await vi.advanceTimersByTimeAsync(2100);
    expect(app.evaluate).toHaveBeenCalledTimes(1);
    expect(snapshot).not.toHaveBeenCalled();
    if (outcome === 'failure') {
      main.exitCode = 0;
      main.emit('exit', 0, null);
      rejectIdentity!(destroyed);
    } else resolveIdentity!({ pid: 123 });
    await checked;
    await vi.advanceTimersByTimeAsync(0);
    expect(
      timelineRecord.mock.calls.some(
        ([, event]) => event?.phase === (outcome === 'failure' ? 'identity-failed' : 'after-identity')
      )
    ).toBe(true);
    expect(snapshot).toHaveBeenCalled();
    expect(launch).toHaveBeenCalledTimes(1);
    processTimeline.stop();
  });

  it.each(['success', 'identity-failure', 'pre-handle-failure'])(
    'isolates every lifecycle sink call on %s without retrying or changing the outcome',
    async (outcome) => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(console, 'log').mockImplementation(() => {});
      const { main, app } = application(outcome === 'identity-failure' ? destroyed : undefined);
      const stdout = new EventEmitter();
      Object.assign(main, { stdout });
      const record = vi.fn(() => {
        throw Object.assign(new Error('diagnostic write denied'), { code: 'EPERM' });
      });
      const launch = vi.fn(async () => {
        if (outcome === 'pre-handle-failure') throw destroyed;
        return app;
      });
      if (outcome === 'success') {
        await expect(launchWithIdentity(launch, options(record))).resolves.toEqual({ app, identity: { pid: 123 } });
        expect(() => {
          stdout.emit('data', Buffer.from('safe fixture output'));
          main.exitCode = 0;
          main.emit('exit', 0, null);
        }).not.toThrow();
        await expect(closeElectron(app)).resolves.toBeUndefined();
      } else await expect(launchWithIdentity(launch, options(record))).rejects.toBe(destroyed);
      expect(record).toHaveBeenCalled();
      expect(launch).toHaveBeenCalledTimes(1);
      expect(app.close).toHaveBeenCalledTimes(outcome === 'pre-handle-failure' ? 0 : 1);
    }
  );
  it('isolates diagnostic sink failure while preserving the original identity failure and single cleanup', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { app } = application(destroyed, 0);
    let diagnosticFailed = false;
    const record = vi.fn((value) => {
      if (value.identityFailedAt && !value.error) {
        diagnosticFailed = true;
        throw new Error('diagnostic sink failure');
      }
    });
    const launch = vi.fn().mockResolvedValue(app);
    await expect(launchWithIdentity(launch, options(record))).rejects.toBe(destroyed);
    expect(diagnosticFailed).toBe(true);
    expect(app.close).toHaveBeenCalledTimes(1);
    expect(launch).toHaveBeenCalledTimes(1);
  });
  it('keeps successful identity and lifecycle status unchanged while adding evidence', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { app } = application();
    const record = vi.fn();
    const result = await launchWithIdentity(async () => app, options(record));
    expect(result).toEqual({ app, identity: { pid: 123 } });
    expect(record.mock.calls.at(-1)?.[0].status).toBe('identified');
    const identifiedAt = record.mock.calls.at(-1)?.[0].identifiedAt;
    await closeElectron(app);
    expect(record.mock.calls.find(([row]) => row.status === 'closing')?.[0]).toMatchObject({ identifiedAt });
    expect(record.mock.calls.at(-1)?.[0].identifiedAt).toBe(identifiedAt);
  });
  it('keeps the original twenty second identity failure observation and records its launch PID and phase', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { main, app } = application(destroyed, null);
    const record = vi.fn();
    app.close.mockImplementation(async () => {
      main.exitCode = 0;
      main.emit('exit', 0, null);
    });
    const launch = vi.fn().mockResolvedValue(app);
    const result = expect(launchWithIdentity(launch, options(record))).rejects.toBe(destroyed);
    await vi.advanceTimersByTimeAsync(19999);
    expect(app.close).not.toHaveBeenCalled();
    expect(record.mock.calls.some(([value]) => value.identityFailedAt)).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    await result;
    expect(launch).toHaveBeenCalledTimes(1);
    expect(record.mock.calls.at(-1)?.[0].waits).toMatchObject([
      {
        launch: 3,
        pid: 123,
        phase: 'identity-failure-exit-observation',
        elapsedMs: 20000,
        timeoutMs: 20000,
        status: 'failed',
      },
      { launch: 3, pid: 123, phase: 'identity-failure-cleanup', alreadyExited: true },
    ]);
  });

  it('writes failed launch and process evidence into the real uploaded result and journal', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-launch-evidence-'));
    try {
      await fs.writeFile(path.join(root, 'renderer-result.json'), JSON.stringify({ checksPassed: ['existing-check'] }));
      const launches: object[] = [];
      const record = (value: { launch: number }) => {
        launches[value.launch - 1] = value;
        recordLaunchEvidence(root, { mainLaunches: launches }, value);
      };
      const { app } = application(destroyed, 0);
      vi.spyOn(console, 'error').mockImplementation(() => {});
      await expect(launchWithIdentity(async () => app, options(record))).rejects.toBe(destroyed);
      recordLaunchEvidence(root, { processTimeline: { status: 'observed' } }, { kind: 'process-timeline' });
      const value = JSON.parse(await fs.readFile(path.join(root, 'renderer-result.json'), 'utf8'));
      expect(value).toMatchObject({
        checksPassed: ['existing-check'],
        processTimeline: { status: 'observed' },
        mainLaunches: [
          null,
          null,
          { error: String(destroyed), identityFailedAt: expect.any(String), protocol: { status: 'active' } },
        ],
      });
      expect(
        (await fs.readFile(path.join(root, 'startup-lifecycle.jsonl'), 'utf8'))
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
          .some((event) => event.identityFailedAt)
      ).toBe(true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  it('waits for the old OS process even when app.close has already resolved', async () => {
    const { main, app } = application(undefined, null);
    app.close.mockResolvedValue(undefined);
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

  it('retains stdout, stderr tails and the original exit code when identity fails', async () => {
    const { app, main } = application(undefined, null);
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    Object.assign(main, { stdout, stderr });
    const record = vi.fn();
    app.evaluate.mockImplementation(async () => {
      stdout.emit('data', Buffer.from('owned main stdout\n'));
      stderr.emit('data', Buffer.from('owned main stderr\n'));
      main.exitCode = 17;
      main.emit('exit', 17, null);
      stderr.emit('data', Buffer.from('tail after exit\n'));
      throw destroyed;
    });
    app.close.mockImplementation(async () => {
      stderr.emit('data', Buffer.from('tail during close\n'));
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const launch = vi.fn().mockResolvedValue(app);
    await expect(launchWithIdentity(launch, options(record))).rejects.toThrow(destroyed);
    stderr.emit('data', Buffer.from('tail after shutdown\n'));
    expect(launch).toHaveBeenCalledTimes(1);
    // The production recorder uploads these rows under mainLaunches.
    expect(record.mock.calls.at(-1)?.[0]).toMatchObject({
      stdout: 'owned main stdout\n',
      stderr: 'owned main stderr\ntail after exit\ntail during close\ntail after shutdown\n',
      exitCode: 17,
      naturalExit: true,
      error: String(destroyed),
    });
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

describe('atomic renderer evidence', () => {
  it('merges delegation evidence without dropping the process timeline', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-delegation-evidence-'));
    try {
      writeRendererResult(root, { processTimeline: { sampleCount: 3 }, checksPassed: [] });
      recordLaunchEvidence(root, { delegation: { children: [] }, checksPassed: ['delegation'] }, null);
      expect(JSON.parse(await fs.readFile(path.join(root, 'renderer-result.json'), 'utf8'))).toEqual({
        processTimeline: { sampleCount: 3 },
        checksPassed: ['delegation'],
        delegation: { children: [] },
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('retries transient Windows EPERM replacement while keeping the old complete JSON visible', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-rename-retry-'));
    try {
      writeRendererResult(root, { sequence: 0 });
      const rename = fsSync.renameSync;
      const replacement = vi
        .spyOn(fsSync, 'renameSync')
        .mockImplementationOnce(() => {
          throw Object.assign(new Error('busy'), { code: 'EPERM' });
        })
        .mockImplementation((source, target) => {
          expect(JSON.parse(fsSync.readFileSync(target, 'utf8')).sequence).toBe(0);
          rename(source, target);
        });
      const pause = vi.spyOn(Atomics, 'wait').mockReturnValue('timed-out');
      writeRendererResult(root, { sequence: 1 }, { platform: 'win32' });
      expect(replacement).toHaveBeenCalledTimes(2);
      expect(pause).toHaveBeenCalledTimes(1);
      expect(JSON.parse(await fs.readFile(path.join(root, 'renderer-result.json'), 'utf8')).sequence).toBe(1);
    } finally {
      vi.restoreAllMocks();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    { platform: 'win32', code: 'EPERM', calls: 3 },
    { platform: 'linux', code: 'EPERM', calls: 1 },
    { platform: 'win32', code: 'EACCES', calls: 1 },
  ])(
    'bounds replacement attempts for $platform/$code and preserves the original result',
    async ({ platform, code, calls }) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-rename-failure-'));
      try {
        writeRendererResult(root, { sequence: 0 });
        const error = Object.assign(new Error('replacement failed'), { code });
        const replacement = vi.spyOn(fsSync, 'renameSync').mockImplementation(() => {
          throw error;
        });
        vi.spyOn(Atomics, 'wait').mockReturnValue('timed-out');
        expect(() => writeRendererResult(root, { sequence: 1 }, { platform })).toThrow(error);
        expect(replacement).toHaveBeenCalledTimes(calls);
        expect(JSON.parse(await fs.readFile(path.join(root, 'renderer-result.json'), 'utf8')).sequence).toBe(0);
        expect((await fs.readdir(root)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
      } finally {
        vi.restoreAllMocks();
        await fs.rm(root, { recursive: true, force: true });
      }
    }
  );
  it('keeps the previous complete JSON visible until rename and omits empty journal events', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-atomic-evidence-'));
    try {
      writeRendererResult(root, { sequence: 0 });
      const rename = fsSync.renameSync;
      const observed = vi.spyOn(fsSync, 'renameSync').mockImplementation((source, target) => {
        expect(JSON.parse(fsSync.readFileSync(target, 'utf8')).sequence).toBe(0);
        rename(source, target);
      });
      recordLaunchEvidence(root, { sequence: 1 }, null);
      expect(observed).toHaveBeenCalledTimes(1);
      expect(JSON.parse(await fs.readFile(path.join(root, 'renderer-result.json'), 'utf8')).sequence).toBe(1);
      expect(fsSync.existsSync(path.join(root, 'startup-lifecycle.jsonl'))).toBe(false);
    } finally {
      vi.restoreAllMocks();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('leaves the previous result intact and removes its temporary file if replacement fails', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-atomic-evidence-'));
    try {
      writeRendererResult(root, { sequence: 0 });
      vi.spyOn(fsSync, 'renameSync').mockImplementation(() => {
        throw new Error('replacement failed');
      });
      expect(() => writeRendererResult(root, { sequence: 1 })).toThrow('replacement failed');
      expect(JSON.parse(await fs.readFile(path.join(root, 'renderer-result.json'), 'utf8')).sequence).toBe(0);
      expect((await fs.readdir(root)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    } finally {
      vi.restoreAllMocks();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
