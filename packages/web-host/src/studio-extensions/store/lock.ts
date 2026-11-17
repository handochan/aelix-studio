import { ExtensionFailure } from '../types.js';
import { runToExit, type Spawn } from '../process.js';
import type { Bundle, Layout } from './layout.js';

/**
 * Cross-process locks (D04 ADR 5.6).
 *
 * Node has no advisory file lock, so the lock is taken by a small child on the bundled
 * interpreter and lasts as long as that child: `flock` on POSIX, `msvcrt.locking` on byte 0
 * on Windows. The operating system drops it when the child ends, and the child ends when
 * its input closes, which also happens when this process dies.
 *
 * Contract for a launcher (it is not built in this module):
 * 1. take the mutation lock (`<root>/lock`) with the same primitive;
 * 2. read `current.json` and choose the generation;
 * 3. create `<root>/leases/<generation>.<anything>` and lock it for the launcher's lifetime;
 * 4. release the mutation lock.
 * Clean-up runs under the mutation lock and keeps every generation that has a locked lease.
 */
const LOCK_SOURCE = `
import json, os, sys, time

def try_lock(fd):
    try:
        if os.name == 'nt':
            import msvcrt
            os.lseek(fd, 0, os.SEEK_SET)
            msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return True
    except OSError:
        return False

mode, target = sys.argv[1], sys.argv[2]
if mode == 'hold':
    deadline = time.monotonic() + float(sys.argv[3])
    fd = os.open(target, os.O_RDWR | os.O_CREAT, 0o600)
    while not try_lock(fd):
        if time.monotonic() >= deadline:
            print('busy', flush=True)
            sys.exit(3)
        time.sleep(0.05)
    print('held', flush=True)
    sys.stdin.buffer.read()
else:
    live, stale = [], []
    for name in sorted(os.listdir(target)):
        try:
            fd = os.open(os.path.join(target, name), os.O_RDWR)
        except OSError:
            continue
        (stale if try_lock(fd) else live).append(name)
        os.close(fd)
    print(json.dumps({'live': live, 'stale': stale}), flush=True)
`;

const interpreterArguments = (mode: string, ...rest: string[]): string[] => [
  '-I',
  '-S',
  '-B',
  '-X',
  'utf8',
  '-c',
  LOCK_SOURCE,
  mode,
  ...rest,
];

export type LockRequest = {
  bundle: Bundle;
  layout: Layout;
  spawn: Spawn;
  env: Record<string, string>;
  /** How long to wait for another holder before giving up with `BUSY`. */
  waitMs: number;
  signal?: AbortSignal;
};

export type MutationLock = {
  /** True once the holder ended for any reason other than `release`: the lock may be gone. */
  lost(): boolean;
  release(): Promise<void>;
};

/**
 * Take the mutation lock. Install, update, remove, rollback and clean-up all run under it.
 *
 * @throws ExtensionFailure `BUSY` when another holder kept it for `waitMs`, `CANCELLED`
 * when aborted, `RUNTIME_UNAVAILABLE` when the bundled interpreter could not take it.
 */
export async function acquireMutationLock(request: LockRequest): Promise<MutationLock> {
  if (request.signal?.aborted) throw new ExtensionFailure('CANCELLED');
  const child = request.spawn({
    command: request.bundle.python,
    args: interpreterArguments('hold', request.layout.lock, String(request.waitMs / 1000)),
    env: request.env,
  });
  let ended = false;
  let released = false;
  const exited = child.exited.then((exit) => {
    ended = true;
    return exit;
  });
  const abort = (): void => {
    child.end();
    child.kill('SIGTERM');
  };
  request.signal?.addEventListener('abort', abort, { once: true });
  try {
    const answer = await new Promise<string>((resolve) => {
      let pending = '';
      child.onStdout((chunk) => {
        pending += chunk;
        const end = pending.indexOf('\n');
        if (end >= 0) resolve(pending.slice(0, end).trim());
      });
      void exited.then(() => resolve(''));
    });
    if (answer !== 'held') {
      child.end();
      await exited;
      if (request.signal?.aborted) throw new ExtensionFailure('CANCELLED');
      if (answer === 'busy') throw new ExtensionFailure('BUSY', ['another process is changing extensions']);
      throw new ExtensionFailure('RUNTIME_UNAVAILABLE', ['the bundled interpreter could not take the lock']);
    }
  } finally {
    request.signal?.removeEventListener('abort', abort);
  }
  return {
    lost: () => ended && !released,
    release: async () => {
      released = true;
      child.end();
      const forced = setTimeout(() => child.kill('SIGKILL'), 2000);
      try {
        await exited;
      } finally {
        clearTimeout(forced);
      }
    },
  };
}

const textValues = (values: unknown[]): string[] => values.filter((value) => typeof value === 'string');

export type LeaseReport = {
  /** Generations a running launcher holds. */
  held: Set<string>;
  /** Lease files nobody holds any more. */
  stale: string[];
};

/**
 * Find out which lease files are held. Call it under the mutation lock: a launcher
 * creates and locks its lease under that lock too, so a lease cannot appear in between.
 *
 * Returns undefined when the probe could not run; the caller must then delete nothing.
 */
export async function probeLeases(request: Omit<LockRequest, 'waitMs' | 'signal'>): Promise<LeaseReport | undefined> {
  const result = await runToExit(
    request.spawn,
    { command: request.bundle.python, args: interpreterArguments('probe', request.layout.leases), env: request.env },
    { timeoutMs: 30_000, tailLimit: 1024 * 1024 }
  );
  if (result.code !== 0) return undefined;
  try {
    const line = result.output.split('\n').findLast((candidate) => candidate.startsWith('{'));
    const report = JSON.parse(line ?? '') as { live?: unknown; stale?: unknown };
    if (!Array.isArray(report.live) || !Array.isArray(report.stale)) return undefined;
    return {
      held: new Set(textValues(report.live).map((name) => name.split('.')[0])),
      stale: textValues(report.stale),
    };
  } catch {
    return undefined;
  }
}
