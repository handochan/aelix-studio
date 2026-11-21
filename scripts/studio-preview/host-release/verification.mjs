import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { installProtocolDiagnostics } from './probes/protocolDiagnostics.mjs';

/** Atomically replace a complete renderer result using a sibling temporary file. */
export function writeRendererResult(output, value, { platform = process.platform } = {}) {
  const file = path.join(output, 'renderer-result.json');
  const temporary = path.join(output, `.renderer-result-${process.pid}-${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
    for (let attempt = 0; ; attempt++) {
      try {
        fs.renameSync(temporary, file);
        break;
      } catch (error) {
        if (platform !== 'win32' || error.code !== 'EPERM' || attempt === 2) throw error;
        // Only diagnostic file replacement retries; never retry an app launch.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
  } finally {
    try {
      fs.unlinkSync(temporary);
    } catch {
      /* absent after rename; preserve the original write error */
    }
  }
}

/** Merge diagnostics into the uploaded result; journal only supplied lifecycle changes. */
export function recordLaunchEvidence(output, patch, event) {
  const file = path.join(output, 'renderer-result.json');
  const previous = JSON.parse(readFileSync(file, 'utf8'));
  writeRendererResult(output, { ...previous, ...patch });
  if (event != null) appendFileSync(path.join(output, 'startup-lifecycle.jsonl'), JSON.stringify(event) + '\n');
}

/** Keep Playwright's driver logging out of the installed application environment. */
export function electronAppEnvironment(driver) {
  const environment = { ...driver };
  delete environment.DEBUG;
  return environment;
}

/** Summarize the owned synthetic profile without exporting setting values. */
export function configSummary(file) {
  try {
    const raw = readFileSync(file);
    let value;
    try {
      value = JSON.parse(decodeURIComponent(atob(raw.toString())));
    } catch {
      /* retain size and digest for malformed data */
    }
    const valid = Boolean(value && typeof value === 'object' && !Array.isArray(value));
    return {
      bytes: raw.length,
      sha256: createHash('sha256').update(raw).digest('hex'),
      valid,
      keyCount: valid ? Object.keys(value).length : 0,
      autoCheck: valid && typeof value['update.autoCheck'] === 'boolean' ? value['update.autoCheck'] : 'missing',
    };
  } catch (error) {
    return { bytes: null, valid: false, autoCheck: 'missing', errorCode: error.code };
  }
}

/** Fail on preference loss; callers must never reseed settings between launches. */
export function verifyConfigPreserved(file, { phase, launch, record }) {
  const summary = configSummary(file);
  const passed = summary.valid && summary.autoCheck === false;
  const result = { phase, launch, ...summary, status: passed ? 'passed' : 'failed' };
  record(result);
  assert.ok(passed, `Studio config preservation failed: ${JSON.stringify(result)}`);
  return result;
}

/** Wait for a fixture result with a finite, logged harness deadline. */
export async function boundedWait(
  work,
  label,
  { timeoutMs = 20000, log = console.log, launch = null, pid = null, phase = 'fixture' } = {}
) {
  const started = performance.now();
  const startedAt = new Date().toISOString();
  let timer;
  let status = 'passed';
  try {
    return await Promise.race([
      work,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}: bounded wait elapsed (${timeoutMs}ms)`)), timeoutMs);
      }),
    ]);
  } catch (error) {
    status = 'failed';
    throw error;
  } finally {
    clearTimeout(timer);
    log(
      JSON.stringify({
        wait: label,
        launch,
        pid,
        phase,
        startedAt,
        endedAt: new Date().toISOString(),
        elapsedMs: Math.round(performance.now() - started),
        timeoutMs,
        status,
      })
    );
  }
}

function exited(main) {
  return main.exitCode !== null || main.signalCode !== null;
}

async function waitForExit(main, state, phase) {
  const context = { launch: state?.observation.launch ?? null, pid: main.pid ?? null, phase };
  const log = (text) => {
    console.log(text);
    if (state) {
      state.observation.waits.push(JSON.parse(text));
      state.diagnostic();
    }
  };
  if (exited(main)) {
    log(
      JSON.stringify({
        wait: 'electron-main-exit',
        ...context,
        elapsedMs: 0,
        timeoutMs: 20000,
        status: 'passed',
        alreadyExited: true,
      })
    );
    return;
  }
  let listener;
  try {
    await boundedWait(new Promise((resolve) => main.once('exit', (listener = resolve))), 'electron-main-exit', {
      ...context,
      log,
    });
  } finally {
    main.removeListener('exit', listener);
  }
}

/** Close the old main process before reusing its user root, including disconnect paths. */
export async function closeElectron(app, { phase = 'cleanup-main-exit', backgroundAfterExit = false } = {}) {
  if (!app) return;
  const main = app.process();
  const state = observations.get(app);
  const background = backgroundAfterExit && exited(main);
  if (state) {
    state.observeExit();
    state.observation.closeRequestedAt ??= new Date().toISOString();
    state.record({ ...state.observation, status: 'closing' });
    state.processTimeline?.checkpoint('close-requested', state.observation.launch);
  }
  try {
    if (background) {
      // Finalize the known OS exit while this launch still owns the timeline.
      // Deferred Playwright cleanup can outlive both the launch and its evidence.
      await waitForExit(main, state, phase);
      void Promise.resolve()
        .then(() => app.close())
        .catch(() =>
          console.error(`Studio launch #${state?.observation.launch}: Playwright cleanup failed after OS exit`)
        );
      return;
    }
    await app.close();
    await waitForExit(main, state, phase);
    state?.processTimeline?.checkpoint('after-close', state.observation.launch);
  } finally {
    if (background) state?.retireEvidence();
    state?.protocol.dispose();
  }
}

const observations = new WeakMap();

/** Read only sandbox-matched process identities; never export other command lines. */
export function sandboxProcesses(sandbox) {
  try {
    const windows = process.platform === 'win32';
    const result = windows
      ? spawnSync(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            '$root=$env:RECOVERY_SANDBOX; @(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($root) } | Select-Object ProcessId,ParentProcessId,Name) | ConvertTo-Json -Compress',
          ],
          { encoding: 'utf8', timeout: 2000 }
        )
      : spawnSync('ps', ['-axo', 'pid=,ppid=,args='], { encoding: 'utf8', timeout: 2000 });
    if (result.error || result.status !== 0) return { status: 'unavailable' };
    if (windows) {
      const value = JSON.parse(result.stdout || '[]');
      return {
        status: 'observed',
        processes: (Array.isArray(value) ? value : [value]).filter(Boolean).map((row) => ({
          pid: row.ProcessId,
          parentPid: row.ParentProcessId,
          executable: row.Name,
        })),
      };
    }
    return {
      status: 'observed',
      processes: result.stdout.split('\n').flatMap((line) => {
        const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
        return match && match[3].includes(sandbox)
          ? [{ pid: Number(match[1]), parentPid: Number(match[2]), sandboxMatched: true }]
          : [];
      }),
    };
  } catch {
    return { status: 'unavailable' };
  }
}

/** Log the state before smoke requests shutdown, including a naturally observed exit. */
export function recordLaunchFailure(app, error) {
  const state = observations.get(app);
  if (!state || state.observation.error) return;
  state.observeExit();
  state.observation.error = String(error);
  state.record({ ...state.observation, status: 'failed' });
  const value = state.observation;
  console.error(
    `Studio launch #${value.launch} FAILED: naturalExit=${value.naturalExit} exitCode=${value.exitCode} signal=${value.signal} exitObservedAt=${value.exitObservedAt}; ${error}`
  );
}

function readMainIdentity() {
  return {
    pid: process.pid,
    backendOverride: process.env.AIONUI_BACKEND_BIN,
    resourcesPath: process.resourcesPath,
  };
}

async function evaluateIdentity(app, protocol) {
  const token = randomUUID();
  const finish = protocol.trackIdentityEvaluation(token);
  let result;
  try {
    const identity = await app.evaluate(readMainIdentity, token);
    result = { identity };
  } catch (error) {
    result = { failedAt: new Date().toISOString(), error };
  }
  const protocolError = finish();
  return { ...result, protocolError };
}

function inspectorPromiseCollected(error) {
  // Playwright rewrites this V8 inspector error as a destroyed context.
  return error?.code === -32000 && error.messageRedacted === false && error.message === 'Promise was collected';
}

/** Verify that an installed app did not use the development backend override. */
export function verifyInstalledBackend(identity) {
  assert.equal(identity.backendOverride, undefined);
}

/** Share the launch timeout with first-window readiness before evaluating identity. */
export async function launchWithIdentity(
  launch,
  { launchNumber, record, remainingProcesses, processTimeline, launchTimeoutMs = 60000 }
) {
  const write = record;
  let lastStatus = 'launching';
  let recording = true;
  record = (value) => {
    if (!recording) return;
    lastStatus = value.status ?? lastStatus;
    try {
      return write(value);
    } catch {
      /* diagnostic persistence must not change the smoke outcome */
    }
  };
  const observation = {
    launch: launchNumber,
    startedAt: new Date().toISOString(),
    remainingProcesses,
    pid: null,
    exitCode: null,
    signal: null,
    exitObservedAt: null,
    closeRequestedAt: null,
    naturalExit: null,
    stdout: '',
    stderr: '',
    waits: [],
  };
  const diagnostic = () => {
    try {
      record({ ...observation, status: lastStatus });
    } catch {
      /* observation only */
    }
  };
  record({ ...observation, status: 'launching' });
  const protocol = installProtocolDiagnostics((value) => {
    observation.protocol = value;
    diagnostic();
  });
  observation.protocol = protocol.snapshot();
  let app;
  try {
    const deadline = performance.now() + launchTimeoutMs;
    app = await launch(launchTimeoutMs);
    try {
      protocol.restore();
      const main = app.process();
      observation.pid = main.pid;
      let rejectFirstWindowOnExit;
      const firstWindowExitError = () => {
        const reason = main.exitCode !== null ? `code ${main.exitCode}` : `signal ${main.signalCode}`;
        return new Error(`Studio launch #${launchNumber}: application exited with ${reason} before the first window`);
      };
      const observeExit = () => {
        if (exited(main) && !observation.exitObservedAt) {
          observation.exitCode = main.exitCode;
          observation.signal = main.signalCode;
          observation.exitObservedAt = new Date().toISOString();
          observation.naturalExit = observation.closeRequestedAt === null;
        }
      };
      observations.set(app, {
        observation,
        record,
        observeExit,
        protocol,
        diagnostic,
        processTimeline,
        retireEvidence: () => {
          recording = false;
        },
      });
      processTimeline?.addMain(main.pid, launchNumber);
      main.on('exit', () => {
        observeExit();
        rejectFirstWindowOnExit?.(firstWindowExitError());
        processTimeline?.mainExit(main.pid);
        record({ ...observation, status: 'exited' });
      });
      for (const stream of ['stdout', 'stderr'])
        main[stream]?.on('data', (chunk) => {
          observation[stream] = (observation[stream] + chunk.toString()).slice(-65536);
          record({ ...observation, status: 'output' });
        });
      const startedAt = new Date().toISOString();
      observation.firstWindowWait = { startedAt, outcome: 'pending' };
      diagnostic();
      processTimeline?.checkpoint('first-window-wait', launchNumber);
      let outcome = 'failed';
      try {
        if (exited(main)) throw firstWindowExitError();
        const remaining = deadline - performance.now();
        if (remaining > 0) {
          // Playwright's close event can wait for descendants to release inherited pipes.
          const osExit = new Promise((_, reject) => {
            rejectFirstWindowOnExit = reject;
          });
          await Promise.race([osExit, app.firstWindow({ timeout: remaining })]);
        }
        if (exited(main)) throw firstWindowExitError();
        if (performance.now() >= deadline)
          throw new Error(
            `Studio launch #${launchNumber}: first window exceeded the ${launchTimeoutMs}ms launch timeout`
          );
        outcome = 'passed';
      } finally {
        rejectFirstWindowOnExit = undefined;
        observation.firstWindowWait = { startedAt, finishedAt: new Date().toISOString(), outcome };
        diagnostic();
      }
      processTimeline?.beginIdentity();
      observation.identityStartedAt = new Date().toISOString();
      const result = await evaluateIdentity(app, protocol);
      let identity = result.identity;
      if (result.failedAt) {
        observation.identityFailedAt = result.failedAt;
        observation.identityProtocol = observation.protocol = protocol.snapshot();
        diagnostic();
        const remaining = deadline - performance.now();
        if (
          !inspectorPromiseCollected(result.protocolError) ||
          !protocol.evaluateMainSynchronously ||
          exited(main) ||
          app.process() !== main ||
          remaining <= 0
        ) {
          throw result.error;
        }
        const retry = {
          startedAt: new Date().toISOString(),
          firstProtocolError: result.protocolError,
          method: 'synchronous-inspector',
          outcome: 'pending',
        };
        observation.identityRetry = retry;
        console.log(
          `Studio launch #${launchNumber}: retrying identity without awaiting a promise (Promise was collected)`
        );
        diagnostic();
        try {
          if (exited(main) || app.process() !== main) throw new Error('Studio app changed during identity retry');
          const timeoutMs = deadline - performance.now();
          if (timeoutMs <= 0) throw result.error;
          identity = await boundedWait(
            protocol.evaluateMainSynchronously(app, readMainIdentity),
            'electron-identity-retry-response',
            {
              timeoutMs,
              launch: launchNumber,
              pid: main.pid,
              phase: 'identity',
            }
          );
          if (exited(main) || app.process() !== main) throw new Error('Studio app changed during identity retry');
          // Windows can use a launcher whose PID differs from the Electron PID.
          const pid = identity?.pid;
          if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Studio identity retry returned an invalid PID');
          retry.outcome = 'passed';
        } finally {
          if (retry.outcome === 'pending') retry.outcome = 'failed';
          retry.finishedAt = new Date().toISOString();
          diagnostic();
        }
      }
      if (exited(main))
        throw new Error(`Studio launch #${launchNumber}: application exited during identity evaluation`);
      observation.identifiedAt = new Date().toISOString();
      record({ ...observation, status: 'identified' });
      return { app, identity };
    } finally {
      if (observation.identityStartedAt)
        processTimeline?.endIdentity(observation.identifiedAt ? 'after-identity' : 'identity-failed', launchNumber);
    }
  } catch (error) {
    if (app) {
      const windowFailed = observation.firstWindowWait?.outcome === 'failed';
      // The extra exit observation belongs to failures during evaluation.
      if (!windowFailed)
        await waitForExit(app.process(), observations.get(app), 'identity-failure-exit-observation').catch(() => {});
      recordLaunchFailure(app, error);
      await closeElectron(app, {
        phase: windowFailed ? 'first-window-failure-cleanup' : 'identity-failure-cleanup',
        backgroundAfterExit: windowFailed,
      });
    } else {
      record({ ...observation, status: 'failed', error: String(error) });
      console.error(`Studio launch #${launchNumber} FAILED before process handle: ${error}`);
      protocol.dispose();
    }
    throw error;
  } finally {
    protocol.restore();
  }
}
