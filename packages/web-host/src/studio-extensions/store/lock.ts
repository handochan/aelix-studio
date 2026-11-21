import { ExtensionFailure } from '../types.js';
import { runToExit, type Child, type Spawn } from '../process.js';
import { stateRelative, type Bundle, type Layout } from './layout.js';

/**
 * Cross-process locks (D04 ADR 5.6).
 *
 * Node has no advisory file lock, so the lock is taken by a small child on the bundled
 * interpreter and lasts as long as that child: `flock` on POSIX, `msvcrt.locking` on byte 0
 * on Windows. The operating system drops it when the child ends, and the child ends when
 * its input closes, which also happens when this process dies.
 *
 * The same child also performs every change to state that other processes share: it renames
 * the pointer files, the settings file and the sealed proxy credentials, and it removes generations, stored wheels and leases. It can only do so
 * while it is alive, which is exactly while the lock is held, so nothing shared is written
 * or removed after the lock is gone. It removes only entries that sit directly in the root
 * or in one of the dedicated directories, and only when that directory really is the
 * helper's own (not a link, not somewhere else).
 *
 * Contract for a launcher (it is not built in this module):
 * 1. take the mutation lock (`<root>/lock`) with the same primitive;
 * 2. read `current.json` and choose the generation;
 * 3. create `<root>/leases/<generation>.<anything>` and lock it for the launcher's lifetime;
 * 4. release the mutation lock.
 * Clean-up runs under the mutation lock and keeps every generation that has a lease which
 * is locked or cannot be checked.
 */
const LOCK_SOURCE = `
import errno, json, os, re, shutil, sys, time

NOFOLLOW = getattr(os, 'O_NOFOLLOW', 0)
DEDICATED = ('generations', 'artifacts', 'leases')
REPLACEABLE = ('current.json', 'current.previous.json', 'settings.json', 'proxy-credentials.json')

class Refused(Exception):
    pass

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

def plain(name):
    marks = ['/', os.sep, os.altsep or os.sep, chr(0)]
    return name not in ('', '.', '..') and not any(mark in name for mark in marks)

def own(directory):
    return not os.path.islink(directory) and os.path.normcase(os.path.realpath(directory)) == os.path.normcase(directory)

def confined(root, relative):
    parts = relative.split('/')
    if len(parts) not in (1, 2) or not all(plain(part) for part in parts):
        raise Refused()
    if len(parts) == 2 and parts[0] not in DEDICATED:
        raise Refused()
    parent = os.path.join(root, *parts[:-1])
    if not own(parent):
        raise Refused()
    return os.path.join(parent, parts[-1])

def remove_entry(target):
    if os.path.islink(target) or not os.path.isdir(target):
        try:
            os.unlink(target)
        except FileNotFoundError:
            pass
    else:
        shutil.rmtree(target)

def remove_generation(target):
    # Keep a retirement record outside the tree until its deletion completes.
    # A fallback pointer cannot select a generation after retirement, and
    # recovery can proceed even if a handle or interruption leaves part of it.
    record = os.path.join(target, 'generation.json')
    retired = os.path.join(os.path.dirname(target), '.retired-' + os.path.basename(target))
    try:
        os.replace(record, retired)
    except FileNotFoundError:
        pass
    shutil.rmtree(target)
    remove_entry(retired)

def remove(root, relative):
    target = confined(root, relative)
    if (os.name == 'nt' and relative.startswith('generations/')
            and re.fullmatch(r'g[0-9]{8}-[0-9a-f]{4}', os.path.basename(target))
            and os.path.isdir(target) and not os.path.islink(target) and not os.path.isjunction(target)):
        remove_generation(target)
    else:
        remove_entry(target)

def replace(root, source, target):
    if target not in REPLACEABLE or not plain(source) or not source.endswith('.tmp') or not own(root):
        raise Refused()
    os.replace(os.path.join(root, source), os.path.join(root, target))
    if os.name != 'nt':
        fd = os.open(root, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)

mode, target = sys.argv[1], sys.argv[2]
if mode == 'hold':
    deadline = time.monotonic() + float(sys.argv[3])
    try:
        if os.path.islink(target):
            raise OSError(errno.ELOOP, 'lock is a link')
        fd = os.open(target, os.O_RDWR | os.O_CREAT | NOFOLLOW, 0o600)
    except OSError as error:
        if error.errno != errno.ELOOP:
            raise
        print('unsafe', flush=True)
        sys.exit(4)
    while not try_lock(fd):
        if time.monotonic() >= deadline:
            print('busy', flush=True)
            sys.exit(3)
        time.sleep(0.05)
    print('held', flush=True)
    root = os.path.dirname(target)
    while True:
        line = sys.stdin.readline()
        if not line:
            break
        try:
            request = json.loads(line)
            if request['op'] == 'remove':
                remove(root, request['path'])
            elif request['op'] == 'replace':
                replace(root, request['from'], request['to'])
            else:
                raise Refused()
            answer = {'ok': True}
        except Refused:
            answer = {'ok': False, 'refused': True}
        except Exception as error:
            answer = {'ok': False, 'error': type(error).__name__}
        print(json.dumps(answer), flush=True)
else:
    live, stale = [], []
    for name in sorted(os.listdir(target)):
        # A snapshot is protected by its corresponding adapter lease.
        if name.endswith('.snapshot.json'):
            continue
        try:
            fd = os.open(os.path.join(target, name), os.O_RDWR | NOFOLLOW)
        except FileNotFoundError:
            continue
        except OSError:
            live.append(name)
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

/**
 * The only way shared state is changed. Both operations are carried out by the process
 * that holds the mutation lock.
 */
export type StateWriter = {
  /** Rename `<root>/<from>`, a temporary file, over a pointer, settings or proxy-credentials file `<root>/<to>`. */
  replace(from: string, to: string): Promise<void>;
  /**
   * Remove `<root>/<relative>`: a file, a link (never what it points at) or a directory
   * tree. `relative` is one name, or a dedicated directory and one name, joined by `/`.
   */
  remove(relative: string): Promise<void>;
};

/**
 * Remove something by its path under the state directory.
 *
 * @throws ExtensionFailure `UNSAFE_ROOT` for a path that is not directly in the root or in a dedicated directory.
 */
export function removeFromState(layout: Layout, writer: StateWriter, target: string): Promise<void> {
  const relative = stateRelative(layout, target);
  if (relative === undefined)
    throw new ExtensionFailure('UNSAFE_ROOT', ['refusing to remove something outside the state directory']);
  return writer.remove(relative);
}

export type LockRequest = {
  bundle: Bundle;
  layout: Layout;
  spawn: Spawn;
  env: Record<string, string>;
  /** How long to wait for another holder before giving up with `BUSY`. */
  waitMs: number;
  signal?: AbortSignal;
};

export type MutationLock = StateWriter & {
  /** True once the holder ended for any reason other than `release`: the lock is gone. */
  lost(): boolean;
  /** Aborts the moment the lock is lost, so work that relies on it stops at once. */
  loss: AbortSignal;
  release(): Promise<void>;
};

/** Complete lines of a child's output, in order; `undefined` once the child has ended. */
function lineReader(child: Child): { next(): Promise<string | undefined>; close(): void } {
  const ready: string[] = [];
  const waiting: ((line: string | undefined) => void)[] = [];
  let pending = '';
  let closed = false;
  child.onStdout((chunk) => {
    pending += chunk;
    let end: number;
    while ((end = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, end).trim();
      pending = pending.slice(end + 1);
      const waiter = waiting.shift();
      if (waiter) waiter(line);
      else ready.push(line);
    }
  });
  return {
    next: () =>
      new Promise((resolve) => {
        const line = ready.shift();
        if (line !== undefined) resolve(line);
        else if (closed) resolve(undefined);
        else waiting.push(resolve);
      }),
    close: () => {
      closed = true;
      for (const waiter of waiting.splice(0)) waiter(undefined);
    },
  };
}

/**
 * Take the mutation lock. Install, update, remove, rollback and clean-up all run under it.
 *
 * @throws ExtensionFailure `BUSY` when another holder kept it for `waitMs`, `CANCELLED`
 * when aborted, `UNSAFE_ROOT` when the lock file is a link, `RUNTIME_UNAVAILABLE` when the
 * bundled interpreter could not take it.
 */
export async function acquireMutationLock(request: LockRequest): Promise<MutationLock> {
  if (request.signal?.aborted) throw new ExtensionFailure('CANCELLED');
  const child = request.spawn({
    command: request.bundle.python,
    args: interpreterArguments('hold', request.layout.lock, String(request.waitMs / 1000)),
    env: request.env,
  });
  const lines = lineReader(child);
  const loss = new AbortController();
  let ended = false;
  let released = false;
  const exited = child.exited.then((exit) => {
    ended = true;
    lines.close();
    if (!released) loss.abort();
    return exit;
  });
  const abort = (): void => {
    child.end();
    child.kill('SIGTERM');
  };
  request.signal?.addEventListener('abort', abort, { once: true });
  try {
    const answer = await lines.next();
    if (answer !== 'held') {
      released = true;
      child.end();
      await exited;
      if (request.signal?.aborted) throw new ExtensionFailure('CANCELLED');
      if (answer === 'busy') throw new ExtensionFailure('BUSY', ['another process is changing extensions']);
      if (answer === 'unsafe') throw new ExtensionFailure('UNSAFE_ROOT', ['the lock file is a link']);
      throw new ExtensionFailure('RUNTIME_UNAVAILABLE', ['the bundled interpreter could not take the lock']);
    }
  } finally {
    request.signal?.removeEventListener('abort', abort);
  }
  // One request at a time: the holder answers in the order it was asked.
  let last: Promise<unknown> = Promise.resolve();
  const ask = (message: Record<string, string>): Promise<void> => {
    const result = last.then(async () => {
      if (ended || released) throw new ExtensionFailure('CONFLICT', ['the lock is no longer held']);
      child.write(JSON.stringify(message) + '\n');
      const line = await lines.next();
      if (line === undefined) throw new ExtensionFailure('CONFLICT', ['the lock was lost']);
      const reply = JSON.parse(line) as { ok?: unknown; refused?: unknown; error?: unknown };
      if (reply.ok === true) return;
      if (reply.refused === true)
        throw new ExtensionFailure('UNSAFE_ROOT', ['the state directory is not the one the helper created']);
      throw new Error(`the lock holder could not ${message.op}: ${String(reply.error)}`);
    });
    last = result.catch(() => {});
    return result;
  };
  return {
    lost: () => ended && !released,
    loss: loss.signal,
    replace: (from, to) => ask({ op: 'replace', from, to }),
    remove: (relative) => ask({ op: 'remove', path: relative }),
    release: async () => {
      await last;
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
  /** Generations a running launcher holds, or whose lease could not be checked. */
  held: Set<string>;
  /** Lease files nobody holds any more. */
  stale: string[];
};

/**
 * Find out which lease files are held. Call it under the mutation lock: a launcher
 * creates and locks its lease under that lock too, so a lease cannot appear in between.
 * A lease that cannot be opened counts as held: not being able to tell is no reason to
 * remove what it protects.
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
