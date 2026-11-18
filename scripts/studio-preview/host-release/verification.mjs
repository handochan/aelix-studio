import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { installProtocolDiagnostics } from './probes/protocolDiagnostics.mjs';

/** Merge diagnostics into the already uploaded result and the existing event journal. */
export function recordLaunchEvidence(output, patch, event) {
  const file = path.join(output, 'renderer-result.json');
  const previous = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...previous, ...patch }, null, 2) + '\n');
  appendFileSync(path.join(output, 'startup-lifecycle.jsonl'), JSON.stringify(event) + '\n');
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
export async function closeElectron(app, { phase = 'cleanup-main-exit' } = {}) {
  if (!app) return;
  const main = app.process();
  const state = observations.get(app);
  if (state) {
    state.observeExit();
    state.observation.closeRequestedAt ??= new Date().toISOString();
    state.record({ ...state.observation, status: 'closing' });
  }
  try {
    await app.close();
    await waitForExit(main, state, phase);
  } finally {
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

/** Launch exactly once. A naturally exiting product must fail the original smoke. */
export async function launchWithIdentity(launch, { launchNumber, record, remainingProcesses, processTimeline }) {
  const write = record;
  let lastStatus = 'launching';
  record = (value) => {
    lastStatus = value.status ?? lastStatus;
    return write(value);
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
    app = await launch();
    protocol.restore();
    const main = app.process();
    observation.pid = main.pid;
    const observeExit = () => {
      if (exited(main) && !observation.exitObservedAt) {
        observation.exitCode = main.exitCode;
        observation.signal = main.signalCode;
        observation.exitObservedAt = new Date().toISOString();
        observation.naturalExit = observation.closeRequestedAt === null;
      }
    };
    observations.set(app, { observation, record, observeExit, protocol, diagnostic });
    processTimeline?.addMain(main.pid, launchNumber);
    main.on('exit', () => {
      observeExit();
      processTimeline?.mainExit(main.pid);
      record({ ...observation, status: 'exited' });
    });
    for (const stream of ['stdout', 'stderr'])
      main[stream]?.on('data', (chunk) => {
        observation[stream] = (observation[stream] + chunk.toString()).slice(-65536);
        record({ ...observation, status: 'output' });
      });
    observation.identityStartedAt = new Date().toISOString();
    let identity;
    try {
      identity = await app.evaluate(() => ({
        pid: process.pid,
        backendOverride: process.env.AIONUI_BACKEND_BIN,
        resourcesPath: process.resourcesPath,
      }));
    } catch (error) {
      observation.identityFailedAt = new Date().toISOString();
      observation.protocol = protocol.snapshot();
      observation.identityProtocol = protocol.snapshot();
      diagnostic();
      processTimeline?.checkpoint('identity-failed', launchNumber);
      throw error;
    }
    record({ ...observation, status: 'identified', identifiedAt: new Date().toISOString() });
    return { app, identity };
  } catch (error) {
    if (app) {
      // Preserve the existing bounded observation before any smoke shutdown.
      await waitForExit(app.process(), observations.get(app), 'identity-failure-exit-observation').catch(() => {});
      recordLaunchFailure(app, error);
      await closeElectron(app, { phase: 'identity-failure-cleanup' });
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
