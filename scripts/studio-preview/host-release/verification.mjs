import { spawnSync } from 'node:child_process';

/** Wait for a fixture result with a finite, logged harness deadline. */
export async function boundedWait(work, label, { timeoutMs = 20000, log = console.log } = {}) {
  const started = performance.now();
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
    log(JSON.stringify({ wait: label, elapsedMs: Math.round(performance.now() - started), timeoutMs, status }));
  }
}

function exited(main) {
  return main.exitCode !== null || main.signalCode !== null;
}

async function waitForExit(main) {
  if (exited(main)) return;
  let listener;
  try {
    await boundedWait(new Promise((resolve) => main.once('exit', (listener = resolve))), 'electron-main-exit');
  } finally {
    main.removeListener('exit', listener);
  }
}

/** Close the old main process before reusing its user root, including disconnect paths. */
export async function closeElectron(app, { waitForMainExit = true } = {}) {
  if (!app) return;
  const main = app.process();
  const state = observations.get(app);
  if (state) {
    state.observeExit();
    state.observation.closeRequestedAt ??= new Date().toISOString();
    state.record({ ...state.observation, status: 'closing' });
  }
  await app.close();
  // Investigation branch: ablate the OS wait while preserving shutdown intent.
  if (waitForMainExit) await waitForExit(main);
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
export async function launchWithIdentity(launch, { launchNumber, record, remainingProcesses }) {
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
  };
  record({ ...observation, status: 'launching' });
  let app;
  try {
    app = await launch();
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
    observations.set(app, { observation, record, observeExit });
    main.on('exit', () => {
      observeExit();
      record({ ...observation, status: 'exited' });
    });
    for (const stream of ['stdout', 'stderr'])
      main[stream]?.on('data', (chunk) => {
        observation[stream] = (observation[stream] + chunk.toString()).slice(-65536);
        record({ ...observation, status: 'output' });
      });
    const identity = await app.evaluate(() => ({
      pid: process.pid,
      backendOverride: process.env.AIONUI_BACKEND_BIN,
      resourcesPath: process.resourcesPath,
    }));
    record({ ...observation, status: 'identified', identifiedAt: new Date().toISOString() });
    return { app, identity };
  } catch (error) {
    if (app) {
      // Preserve the existing bounded observation before any smoke shutdown.
      await waitForExit(app.process()).catch(() => {});
      recordLaunchFailure(app, error);
      await closeElectron(app);
    } else {
      record({ ...observation, status: 'failed', error: String(error) });
      console.error(`Studio launch #${launchNumber} FAILED before process handle: ${error}`);
    }
    throw error;
  }
}
