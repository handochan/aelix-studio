import { spawn as nodeSpawn } from 'node:child_process';

export type SpawnSpec = { command: string; args: string[]; env: Record<string, string>; cwd?: string };

export type ChildExit = { code: number | null; signal: NodeJS.Signals | null; failedToStart: boolean };

/** The part of a child process the helper uses. Tests supply their own. */
export type Child = {
  onStdout(listener: (chunk: string) => void): void;
  onStderr(listener: (chunk: string) => void): void;
  write(text: string): void;
  end(): void;
  kill(signal: NodeJS.Signals): void;
  exited: Promise<ChildExit>;
};

export type Spawn = (spec: SpawnSpec) => Child;

/**
 * Start a process from an argument vector, never through a shell.
 *
 * On POSIX the child leads its own process group, so stopping it also stops what it
 * started (native starts pip). Windows stops the direct child only.
 */
export const spawnChild: Spawn = (spec) => {
  const grouped = process.platform !== 'win32';
  const child = nodeSpawn(spec.command, spec.args, {
    env: spec.env,
    cwd: spec.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
    windowsHide: true,
    detached: grouped,
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdin.on('error', () => {});
  let failedToStart = false;
  const exited = new Promise<ChildExit>((resolve) => {
    child.once('error', () => {
      failedToStart = true;
      if (child.pid === undefined) resolve({ code: null, signal: null, failedToStart });
    });
    child.once('close', (code, signal) => resolve({ code, signal, failedToStart }));
  });
  return {
    onStdout: (listener) => child.stdout.on('data', listener),
    onStderr: (listener) => child.stderr.on('data', listener),
    write: (text) => {
      if (child.stdin.writable) child.stdin.write(text);
    },
    end: () => child.stdin.end(),
    kill: (signal) => {
      if (grouped && child.pid !== undefined) {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch {
          // The group is already gone; fall through to the direct child.
        }
      }
      child.kill(signal);
    },
    exited,
  };
};

/** The installed Windows launcher holds a job for the child and all of its descendants. */
export function windowsChildSpawn(python: string, launcher: string): Spawn {
  return (spec) =>
    spawnChild({
      ...spec,
      command: python,
      args: ['-I', '-S', '-B', '-X', 'utf8', launcher, 'windows-child', spec.command, ...spec.args],
    });
}

/** Keeps the end of a stream of text, cut at a character boundary. */
export class OutputTail {
  private text = '';
  constructor(private readonly limit: number) {}
  push(chunk: string): void {
    this.text = (this.text + chunk).slice(-this.limit);
  }
  toString(): string {
    return this.text;
  }
}

export type RunOptions = {
  timeoutMs: number;
  signal?: AbortSignal;
  /** How much of the combined output to keep. */
  tailLimit?: number;
  /** Written to the child once it has started. The input stays open until `closeInput` says so. */
  input?: string;
  /** Called per complete stdout line; return true to close the input and let the child finish. */
  closeInput?: (line: string) => boolean;
  /** How long a stopped child gets before it is killed. */
  graceMs?: number;
  /** Longest stdout line `closeInput` waits for; a child that exceeds it is stopped. */
  lineLimit?: number;
};

export type RunResult = {
  code: number | null;
  /** The end of stdout and stderr, in arrival order. */
  output: string;
  timedOut: boolean;
  cancelled: boolean;
  failedToStart: boolean;
};

/**
 * Run a child to its end. A timeout or an abort stops it (SIGTERM, then SIGKILL) and
 * still waits for the exit, so nothing is left writing when the caller cleans up.
 */
export async function runToExit(spawn: Spawn, spec: SpawnSpec, options: RunOptions): Promise<RunResult> {
  const tail = new OutputTail(options.tailLimit ?? 4096);
  if (options.signal?.aborted)
    return { code: null, output: '', timedOut: false, cancelled: true, failedToStart: false };
  const child = spawn(spec);
  let timedOut = false;
  let cancelled = false;
  let killer: ReturnType<typeof setTimeout> | undefined;
  const stop = (): void => {
    child.end();
    child.kill('SIGTERM');
    killer ??= setTimeout(() => child.kill('SIGKILL'), options.graceMs ?? 2000);
  };
  const deadline = setTimeout(() => {
    timedOut = true;
    stop();
  }, options.timeoutMs);
  const abort = (): void => {
    cancelled = true;
    stop();
  };
  options.signal?.addEventListener('abort', abort, { once: true });
  let pending = '';
  let inputOpen = true;
  child.onStdout((chunk) => {
    tail.push(chunk);
    if (!options.closeInput || !inputOpen) return;
    pending += chunk;
    let end: number;
    while (inputOpen && (end = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, end);
      pending = pending.slice(end + 1);
      if (options.closeInput(line)) {
        inputOpen = false;
        child.end();
      }
    }
    if (inputOpen && pending.length > (options.lineLimit ?? 8 * 1024 * 1024)) {
      // No answer is this long: stop listening and stop the child.
      inputOpen = false;
      pending = '';
      stop();
    }
  });
  child.onStderr((chunk) => tail.push(chunk));
  if (options.input !== undefined) child.write(options.input);
  if (!options.closeInput) child.end();
  try {
    const exit = await child.exited;
    return { code: exit.code, output: tail.toString(), timedOut, cancelled, failedToStart: exit.failedToStart };
  } finally {
    clearTimeout(deadline);
    if (killer) clearTimeout(killer);
    options.signal?.removeEventListener('abort', abort);
  }
}
