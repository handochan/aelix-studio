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
export async function closeElectron(app) {
  if (!app) return;
  const main = app.process();
  await app.close();
  await waitForExit(main);
}

/** One startup-only mitigation for an observed clean early exit after a restart.
 * The cause of the historical exit is unknown. This can mask a product self-quit
 * before identity evaluation, so each attempt is retained and no check is retried.
 */
export async function launchWithIdentity(launch, { restarting, record }) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const app = await launch();
    const main = app.process();
    const observation = { attempt, pid: main.pid, restarting, exitCode: main.exitCode, signal: main.signalCode };
    try {
      const identity = await app.evaluate(() => ({
        pid: process.pid,
        backendOverride: process.env.AIONUI_BACKEND_BIN,
        resourcesPath: process.resourcesPath,
      }));
      record({ ...observation, status: 'identified' });
      return { app, identity };
    } catch (error) {
      // Await natural exit before deciding; never manufacture a clean exit by
      // closing the application and then using that code to authorize retry.
      let exitObserved = false;
      try {
        await waitForExit(main);
        exitObserved = true;
      } catch {
        // A live process or missing exit evidence is a failure, not retryable.
      }
      const retry =
        attempt === 1 &&
        restarting &&
        exitObserved &&
        main.exitCode === 0 &&
        main.signalCode === null &&
        /Execution context was destroyed/.test(String(error));
      record({
        ...observation,
        exitCode: main.exitCode,
        signal: main.signalCode,
        status: 'failed',
        retry,
        error: String(error),
      });
      await closeElectron(app);
      if (!retry) throw error;
    }
  }
  throw new Error('Electron startup attempts exhausted');
}
