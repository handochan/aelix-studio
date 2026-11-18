import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

let observing = false;

/** Observe this serial build phase's child handles, then require actual OS exit. */
export async function withBuildProcesses(work, stop, { timeoutMs = 20000, record = () => {} } = {}) {
  if (observing) throw new Error('Overlapping build process observation');
  observing = true;
  const spawn = childProcess.spawn;
  const helpers = [];
  let stopping = false;
  const errors = [];
  let value;
  childProcess.spawn = function (...args) {
    const child = spawn.apply(this, args);
    const helper = { pid: child.pid ?? null, exited: false, closed: false, exitCode: null, signal: null };
    const closed = new Promise((resolve) => {
      child.once('error', () => {
        helper.spawnFailed = true;
      });
      child.once('exit', (code, signal) => {
        Object.assign(helper, { exited: true, exitCode: code, signal, exitBeforeStop: !stopping });
      });
      child.once('close', () => {
        helper.closed = true;
        resolve();
      });
    });
    helpers.push({ helper, closed });
    return child;
  };
  // Vite and esbuild must be loaded inside work, after both CJS and ESM spawn
  // exports are observed. Async esbuild avoids an unobserved sync API worker.
  syncBuiltinESMExports();
  try {
    try {
      value = await work();
    } catch (error) {
      errors.push(error);
    }
    stopping = true;
    try {
      await stop();
    } catch (error) {
      errors.push(error);
    }
    let timer;
    try {
      await Promise.race([
        (async () => {
          for (const entry of helpers) await entry.closed;
        })(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Build helper OS exit timed out')), timeoutMs);
        }),
      ]);
      for (const { helper } of helpers) {
        if (
          helper.spawnFailed ||
          !helper.exited ||
          (helper.exitCode !== 0 && !(helper.signal === 'SIGTERM' && !helper.exitBeforeStop))
        )
          errors.push(new Error('Build helper exited unexpectedly'));
      }
      if (!helpers.length && !errors.length) errors.push(new Error('Build service process was not observed'));
    } catch (error) {
      errors.push(error);
    } finally {
      clearTimeout(timer);
    }
    record({ status: errors.length ? 'failed' : 'passed', helpers: helpers.map(({ helper }) => ({ ...helper })) });
    if (errors.length) throw new AggregateError(errors, 'Build or helper shutdown failed');
    return value;
  } finally {
    childProcess.spawn = spawn;
    syncBuiltinESMExports();
    observing = false;
  }
}
