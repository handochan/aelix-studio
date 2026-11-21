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

/** A character that ends an authority: a URI delimiter, or one that can never appear in a URI. */
// oxlint-disable-next-line no-control-regex -- control characters never occur in a URI.
const AUTHORITY_END = /[\s/?#"<>\\^`{|}\x00-\x1f\x7f]/;
const SCHEME_CHARACTER = /[a-z0-9+.-]/i;
const LETTER = /[a-z]/i;

/**
 * Hide credentials in URLs inside tool output before it reaches a reply: Git prints remote
 * and submodule addresses as the repository wrote them, and those can carry a token.
 *
 * No list of allowed characters decides where a user part ends: RFC 3986 allows quotes,
 * parentheses and the other sub-delimiters in it. After `scheme://`, the authority runs to the
 * first `/`, `?`, `#`, whitespace or character no URI holds (`"`, `<`, `>`, `\`, `^`, a
 * backtick, `{`, `|`, `}`, a control character), or to the next URL, or the end; everything
 * before its last `@` is the user part. That is masked whole, except that a plain SSH account
 * name without a password (`ssh://git@host`) stays, since it says which account was used.
 *
 * Linear in the text: each `://` is found once, its scheme is read backwards no further than
 * the previous one, and each authority is read forwards once.
 */
export function redactUrlCredentials(text: string): string {
  const urls: { scheme: number; from: number }[] = [];
  for (let mark = text.indexOf('://'); mark >= 0; mark = text.indexOf('://', mark + 3)) {
    const floor = urls.length > 0 ? urls[urls.length - 1].from : 0;
    let scheme = mark;
    while (scheme > floor && SCHEME_CHARACTER.test(text[scheme - 1])) scheme -= 1;
    // A scheme starts with a letter.
    while (scheme < mark && !LETTER.test(text[scheme])) scheme += 1;
    if (scheme < mark) urls.push({ scheme, from: mark + 3 });
  }
  let masked = '';
  let cursor = 0;
  for (const [index, url] of urls.entries()) {
    if (url.scheme < cursor) continue;
    const bound = urls[index + 1]?.scheme ?? text.length;
    let end = url.from;
    while (end < bound && !AUTHORITY_END.test(text[end])) end += 1;
    const authority = text.slice(url.from, end);
    const at = authority.lastIndexOf('@');
    const keep = /^(?:git\+)?ssh$/i.test(text.slice(url.scheme, url.from - 3)) && !authority.slice(0, at).includes(':');
    masked += text.slice(cursor, url.from) + (at < 0 || keep ? authority : '***' + authority.slice(at));
    cursor = end;
  }
  return masked + text.slice(cursor);
}

/** Whitespace as `\s` matches it, by character code. */
function isWhitespace(code: number): boolean {
  return (
    (code >= 0x09 && code <= 0x0d) ||
    code === 0x20 ||
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 ||
    code === 0xfeff
  );
}

/** Index of the last whitespace in `text`, or -1; scans backwards once. */
function lastWhitespace(text: string): number {
  for (let index = text.length - 1; index >= 0; index -= 1) if (isWhitespace(text.charCodeAt(index))) return index;
  return -1;
}

/** One stream feeding an `OutputTail`. */
export type TailStream = { push(chunk: string): void };

/**
 * Keeps the end of a stream of text, cut at a character boundary.
 *
 * With `redact`, text is masked before anything of it is cut, so a cut can never leave the
 * rest of a secret that no longer looks like one. A URL holds no whitespace, so each stream
 * keeps its text after the last whitespace open until more arrives: a URL split across
 * chunks, or by another stream's output between them, is masked whole. A run without any
 * whitespace longer than `window` is not kept, however the chunks fall: it is replaced by
 * one marker. Work is linear in what is pushed: only new text is searched for whitespace, and
 * runs are measured in one pass.
 */
export class OutputTail {
  private text = '';
  private readonly streams: { open: string; dropping: boolean }[] = [];
  private readonly fallback: TailStream;
  constructor(
    private readonly limit: number,
    private readonly redact?: (text: string) => string,
    private readonly window = 64 * 1024
  ) {
    this.fallback = this.stream();
  }

  /** A stream of its own: its open end is never mixed with another stream's. */
  stream(): TailStream {
    const state = { open: '', dropping: false };
    this.streams.push(state);
    return {
      push: (chunk) => {
        if (!this.redact) {
          this.keep(chunk);
          return;
        }
        let rest = chunk;
        if (state.dropping) {
          const boundary = rest.search(/\s/);
          if (boundary < 0) return;
          state.dropping = false;
          rest = rest.slice(boundary);
        }
        // The last whitespace of the new text: what ends there is complete, since no URL goes on
        // across it. Only the new text is searched, never what is held back again.
        const last = lastWhitespace(rest);
        if (last < 0) state.open += rest;
        else {
          this.keep(this.redact(this.capped(state.open + rest.slice(0, last + 1))));
          state.open = rest.slice(last + 1);
        }
        if (state.open.length > this.window) {
          this.keep('[…]');
          state.open = '';
          state.dropping = true;
        }
      },
    };
  }

  push(chunk: string): void {
    this.fallback.push(chunk);
  }

  /** Every run without whitespace longer than the window, as one marker. One pass, no regex. */
  private capped(text: string): string {
    let result = '';
    let run = 0;
    for (let index = 0; index <= text.length; index += 1) {
      if (index < text.length && !isWhitespace(text.charCodeAt(index))) continue;
      result += index - run > this.window ? '[…]' : text.slice(run, index);
      if (index < text.length) result += text[index];
      run = index + 1;
    }
    return result;
  }

  private keep(text: string): void {
    this.text = (this.text + text).slice(-this.limit);
  }

  toString(): string {
    if (!this.redact) return this.text;
    const open = this.streams.map((state) => this.redact?.(this.capped(state.open)) ?? '').join('');
    return (this.text + open).slice(-this.limit);
  }
}

export type RunOptions = {
  timeoutMs: number;
  signal?: AbortSignal;
  /** How much of the combined output to keep. */
  tailLimit?: number;
  /** Mask credentials in URLs (`redactUrlCredentials`) before the output is cut to its tail. */
  redact?: boolean;
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
  /** The end of stdout alone, for answers a warning on stderr must not change. */
  stdout: string;
  timedOut: boolean;
  cancelled: boolean;
  failedToStart: boolean;
};

/**
 * Run a child to its end. A timeout or an abort stops it (SIGTERM, then SIGKILL) and
 * still waits for the exit, so nothing is left writing when the caller cleans up.
 */
export async function runToExit(spawn: Spawn, spec: SpawnSpec, options: RunOptions): Promise<RunResult> {
  const redact = options.redact ? redactUrlCredentials : undefined;
  const tail = new OutputTail(options.tailLimit ?? 4096, redact);
  const answer = new OutputTail(options.tailLimit ?? 4096, redact);
  const [stdout, stderr] = [tail.stream(), tail.stream()];
  if (options.signal?.aborted)
    return { code: null, output: '', stdout: '', timedOut: false, cancelled: true, failedToStart: false };
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
    stdout.push(chunk);
    answer.push(chunk);
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
  child.onStderr((chunk) => stderr.push(chunk));
  if (options.input !== undefined) child.write(options.input);
  if (!options.closeInput) child.end();
  try {
    const exit = await child.exited;
    return {
      code: exit.code,
      output: tail.toString(),
      stdout: answer.toString(),
      timedOut,
      cancelled,
      failedToStart: exit.failedToStart,
    };
  } finally {
    clearTimeout(deadline);
    if (killer) clearTimeout(killer);
    options.signal?.removeEventListener('abort', abort);
  }
}
