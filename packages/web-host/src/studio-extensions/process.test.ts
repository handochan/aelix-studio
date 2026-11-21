import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { scriptedSpawn } from '../../tests/fixtures/extensionRuntime';
import { OutputTail, redactUrlCredentials, runToExit, spawnChild } from './process';

const SPEC = { command: 'python', args: ['-I'], env: {} };

describe('output tail', () => {
  it('keeps only the end of what was pushed', () => {
    const tail = new OutputTail(5);
    tail.push('abc');
    tail.push('defgh');
    expect(tail.toString()).toBe('defgh');
  });
});

describe('masking credentials in output', () => {
  const URL_TEXT = 'https://alice-user:S3CRETPW@git.example.com/o/r.git';
  const SECRETS = ['alice-user', 'S3CRETPW'];
  /** No piece of a secret three characters or longer may survive. */
  const leaks = (text: string): string[] =>
    SECRETS.flatMap((secret) =>
      Array.from({ length: secret.length - 2 }, (_, start) => secret.slice(start, start + 3)).filter((piece) =>
        text.includes(piece)
      )
    );
  const before = 'fatal: unable to access ';
  const after = ': Could not resolve host\n';
  const whole = before + "'" + URL_TEXT + "'" + after;
  const urlStart = before.length + 1;

  it('masks the whole user part, and keeps only an SSH account name without a password', () => {
    expect(redactUrlCredentials(whole)).toBe(before + "'https://***@git.example.com/o/r.git'" + after);
    expect(redactUrlCredentials('ssh://git@host/x ssh://git:pw@host/y git+https://t@h/z')).toBe(
      'ssh://git@host/x ssh://***@host/y git+https://***@h/z'
    );
  });

  // RFC 3986 3.2.1: userinfo = *( unreserved / pct-encoded / sub-delims / ":" )
  const SUB_DELIMS = [..."!$&'()*+,;="];
  const userinfoCases: [string, string, string][] = [
    ...SUB_DELIMS.map((mark): [string, string, string] => [
      `the sub-delimiter ${mark}`,
      `fatal: 'https://alice-user:S3C${mark}RETPW@git.example.com/o/r.git' failed`,
      "fatal: 'https://***@git.example.com/o/r.git' failed",
    ]),
    [
      'a percent-encoded @',
      'remote: https://alice-user:S3C%40RETPW@git.example.com/x',
      'remote: https://***@git.example.com/x',
    ],
    [
      'a quote in a URL without a path',
      "fatal: 'https://alice-user:S3C'RETPW@git.example.com'",
      "fatal: 'https://***@git.example.com'",
    ],
    ...['"', '\\'].flatMap((mark): [string, string, string][] => [
      [
        `a raw ${mark} in a quoted URL`,
        `fatal: clone of 'https://alice-user:S3C${mark}RETPW@git.example.com/o/r.git' failed`,
        "fatal: clone of 'https://***@git.example.com/o/r.git' failed",
      ],
      [
        `a raw ${mark} in an unquoted URL`,
        `fatal: clone of https://alice-user:S3C${mark}RETPW@git.example.com/o/r.git failed`,
        'fatal: clone of https://***@git.example.com/o/r.git failed',
      ],
      [
        `a raw ${mark} in a URL without a path`,
        `remote https://alice-user:S3C${mark}RETPW@git.example.com`,
        'remote https://***@git.example.com',
      ],
    ]),
    [
      'two URLs without whitespace between them',
      'a=https://alice-user:S3CRETPW@h1,b=ssh://alice-user:S3CRETPW@h2/x',
      'a=https://***@h1,b=ssh://***@h2/x',
    ],
  ];

  it('masks an ambiguous span rather than leak: JSON after a URL may be masked with it', () => {
    // Fail-safe: plain output does not say where a URL ends.
    const plain = JSON.stringify({ endpoint: 'https://packages.example.invalid', contact: 'ops@example.invalid' });
    expect(redactUrlCredentials(plain)).toBe('{"endpoint":"https://***@example.invalid"}');
    const secret = JSON.stringify({ remote: 'https://u:S3CRETPW@host.example', note: 'a@b' });
    expect(leaks(redactUrlCredentials(secret))).toEqual([]);
    expect(redactUrlCredentials(secret)).toBe('{"remote":"https://***@b"}');
  });

  it.each(userinfoCases)('masks a user part with %s', (_case, text, expected) => {
    expect(redactUrlCredentials(text)).toBe(expected);
  });

  it.each(userinfoCases)('masks a user part with %s split across chunks at any point', (_case, text, expected) => {
    for (let split = 0; split <= text.length; split += 1) {
      const tail = new OutputTail(4096, redactUrlCredentials);
      tail.push(text.slice(0, split));
      tail.push(text.slice(split));
      expect([split, tail.toString()]).toEqual([split, expected]);
      expect(leaks(tail.toString())).toEqual([]);
    }
  });

  it('masks before cutting, wherever the cut lands inside the address', () => {
    for (let offset = 0; offset <= URL_TEXT.length; offset += 1) {
      const tail = new OutputTail(whole.length - (urlStart + offset), redactUrlCredentials);
      tail.push(whole);
      expect([offset, leaks(tail.toString())]).toEqual([offset, []]);
    }
  });

  it('masks an address split across chunks at any point, with any cut', () => {
    for (let split = urlStart; split <= urlStart + URL_TEXT.length; split += 1)
      for (const limit of [8, 20, 40, whole.length]) {
        const tail = new OutputTail(limit, redactUrlCredentials);
        tail.push(whole.slice(0, split));
        tail.push(whole.slice(split));
        expect([split, limit, leaks(tail.toString())]).toEqual([split, limit, []]);
      }
  });

  it('masks an address that another stream interrupts', () => {
    const tail = new OutputTail(4096, redactUrlCredentials);
    const [stdout, stderr] = [tail.stream(), tail.stream()];
    stdout.push('clone of ' + URL_TEXT.slice(0, 22));
    stderr.push('warning: interleaved\n');
    stdout.push(URL_TEXT.slice(22) + ' failed\n');
    expect(leaks(tail.toString())).toEqual([]);
    expect(tail.toString()).toContain('https://***@git.example.com/o/r.git failed');
  });

  it('drops a run without whitespace longer than its window up to the run end', () => {
    const tail = new OutputTail(4096, redactUrlCredentials, 16);
    tail.push('start ' + 'x'.repeat(20) + URL_TEXT.slice(0, 10));
    tail.push(URL_TEXT.slice(10) + ' end');
    expect(leaks(tail.toString())).toEqual([]);
    expect(tail.toString()).toBe('start […] end');
  });

  it('caps an over-long run the same way however the chunks fall', () => {
    const text = 'start ' + 'x'.repeat(30) + URL_TEXT + ' middle ' + 'y'.repeat(17) + ' end';
    const expected = 'start […] middle […] end';
    const pushed = (chunks: string[]): string => {
      const tail = new OutputTail(4096, redactUrlCredentials, 16);
      for (const chunk of chunks) tail.push(chunk);
      return tail.toString();
    };
    // One chunk, which also puts the delimiter in the same chunk as the long run.
    expect(pushed([text])).toBe(expected);
    // Every character on its own.
    expect(pushed([...text])).toBe(expected);
    // Every two-way split.
    for (let split = 0; split <= text.length; split += 1)
      expect([split, pushed([text.slice(0, split), text.slice(split)])]).toEqual([split, expected]);
    // A run exactly as long as the window stays.
    expect(pushed(['a ' + 'z'.repeat(16) + ' b'])).toBe('a ' + 'z'.repeat(16) + ' b');
  });

  /** Wall-clock time of `work`, in milliseconds. */
  const elapsed = (work: () => void): number => {
    const start = performance.now();
    work();
    return performance.now() - start;
  };
  /**
   * Linear-time checks without a tight clock: on a 1 MiB input, rescanning or backtracking per
   * position takes minutes, a linear pass milliseconds. A 2-second bound tells them apart with
   * room for a loaded CI runner.
   */
  const BOUND_MS = 2000;
  const MIB = 1024 * 1024;

  it.each([65_536, 65_537])('keeps a %i-character token by the cap, whole or split', (length) => {
    const text = 'start ' + 'x'.repeat(length) + ' end\n';
    const expected = length > 65_536 ? 'start […] end\n' : text;
    for (const chunks of [[text], [text.slice(0, 40_000), text.slice(40_000)]]) {
      const tail = new OutputTail(70_000, redactUrlCredentials);
      for (const chunk of chunks) tail.push(chunk);
      expect(tail.toString() === expected).toBe(true);
    }
  });

  it('masks and caps a 1 MiB token in linear time, in one chunk, split, and in small pieces', () => {
    const text = 'start ' + 'x'.repeat(MIB) + ' end\n';
    const pieces = Array.from({ length: Math.ceil(text.length / 4096) }, (_, i) =>
      text.slice(i * 4096, (i + 1) * 4096)
    );
    const splittings: [string, string[]][] = [
      ['one chunk', [text]],
      ['two chunks', [text.slice(0, MIB / 2), text.slice(MIB / 2)]],
      ['4 KiB chunks', pieces],
    ];
    for (const [name, chunks] of splittings) {
      let result = '';
      const time = elapsed(() => {
        const tail = new OutputTail(4096, redactUrlCredentials);
        for (const chunk of chunks) tail.push(chunk);
        result = tail.toString();
      });
      expect([name, result]).toEqual([name, 'start […] end\n']);
      expect([name, time < BOUND_MS]).toEqual([name, true]);
    }
  });

  it('keeps a character-by-character stream linear', () => {
    const text = 'x'.repeat(256 * 1024) + ' done';
    const time = elapsed(() => {
      const tail = new OutputTail(4096, redactUrlCredentials);
      for (const character of text) tail.push(character);
      tail.toString();
    });
    expect(time).toBeLessThan(BOUND_MS);
  });

  it.each([
    ['dense scheme characters', 'a.'.repeat(MIB / 2)],
    ['dense separators', 'a://'.repeat(MIB / 4)],
    ['many addresses', 'https://u:p@h/ '.repeat(MIB / 16)],
    ['one long authority', 'https://' + 'u'.repeat(MIB) + '@h'],
  ])('masks %s of 1 MiB in linear time', (_case, text) => {
    expect(elapsed(() => redactUrlCredentials(text))).toBeLessThan(BOUND_MS);
  });

  it('masks what a real child prints in pieces before the result is cut', async () => {
    const script =
      'const [a, b] = [process.argv[1].slice(0, 30), process.argv[1].slice(30)];' +
      'process.stderr.write("fatal: " + a); setTimeout(() => process.stderr.write(b + " end\\n"), 50);';
    const result = await runToExit(
      spawnChild,
      { command: process.execPath, args: ['-e', script, URL_TEXT], env: {} },
      { timeoutMs: 10_000, tailLimit: 30, redact: true }
    );
    expect(leaks(result.output)).toEqual([]);
    expect(result.output).toBe('*@git.example.com/o/r.git end\n');
  });
});

describe('running a child to its end', () => {
  it('returns the exit code and the combined end of both streams', async () => {
    const spawn = scriptedSpawn((_spec, child) => {
      child.print('out ');
      child.complain('err');
      child.exit(3);
    });
    expect(await runToExit(spawn, SPEC, { timeoutMs: 1000 })).toEqual({
      code: 3,
      output: 'out err',
      stdout: 'out ',
      timedOut: false,
      cancelled: false,
      failedToStart: false,
    });
    expect(spawn.children[0].ended).toBe(true);
  });

  it('stops a child that outlives its timeout and escalates when it ignores the first signal', async () => {
    const spawn = scriptedSpawn((_spec, child) => {
      child.onKill = (signal) => {
        if (signal === 'SIGKILL') child.exit(null, signal);
      };
    });
    const result = await runToExit(spawn, SPEC, { timeoutMs: 10, graceMs: 10 });
    expect(result).toMatchObject({ code: null, timedOut: true, cancelled: false });
    expect(spawn.children[0].signals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('stops the child when the caller aborts', async () => {
    const controller = new AbortController();
    const spawn = scriptedSpawn(() => controller.abort());
    const result = await runToExit(spawn, SPEC, { timeoutMs: 1000, signal: controller.signal });
    expect(result).toMatchObject({ cancelled: true, timedOut: false });
    expect(spawn.children[0].signals).toEqual(['SIGTERM']);
  });

  it('starts nothing when the caller already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const spawn = scriptedSpawn(() => {});
    expect(await runToExit(spawn, SPEC, { timeoutMs: 1000, signal: controller.signal })).toMatchObject({
      cancelled: true,
    });
    expect(spawn.calls).toEqual([]);
  });

  it('keeps the input open until a line says the conversation is over', async () => {
    const spawn = scriptedSpawn((_spec, child) => {
      child.onEnd = () => child.exit(0);
      child.onInput = () => {
        child.print('first li');
        child.print('ne\nanswer\ntrailing\n');
      };
    });
    const seen: string[] = [];
    const result = await runToExit(spawn, SPEC, {
      timeoutMs: 1000,
      input: 'question\n',
      closeInput: (line) => {
        seen.push(line);
        return line === 'answer';
      },
    });
    expect(result.code).toBe(0);
    expect(spawn.children[0].written).toEqual(['question\n']);
    expect(seen).toEqual(['first line', 'answer']);
  });

  it('stops a child that floods its output without ever ending a line', async () => {
    const spawn = scriptedSpawn((_spec, child) => {
      child.print('x'.repeat(40));
      child.print('x'.repeat(40));
    });
    const result = await runToExit(spawn, SPEC, { timeoutMs: 1000, closeInput: () => true, lineLimit: 64 });
    expect(result).toMatchObject({ code: null, timedOut: false, cancelled: false });
    expect(spawn.children[0].signals).toEqual(['SIGTERM']);
  });

  it('reports a command that could not be started', async () => {
    const spawn = scriptedSpawn((_spec, child) => child.exit(null, null, true));
    expect(await runToExit(spawn, SPEC, { timeoutMs: 1000 })).toMatchObject({ code: null, failedToStart: true });
  });
});

describe('starting a real process', () => {
  // Windows cannot start a process without these; nothing else of this process is passed on.
  const SYSTEM = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        /^(SystemRoot|SystemDrive|windir)$/i.test(entry[0]) && entry[1] !== undefined
    )
  );
  const node = (script: string, ...rest: string[]) => ({
    command: process.execPath,
    args: ['-e', script, ...rest],
    env: SYSTEM,
  });

  it('passes arguments without a shell and returns output and exit code', async () => {
    const result = await runToExit(spawnChild, node('console.log(process.argv[1]); process.exit(4)', '$HOME; echo x'), {
      timeoutMs: 20_000,
    });
    expect(result).toMatchObject({ code: 4, output: '$HOME; echo x\n' });
  });

  it('gives the child only the environment it was handed', async () => {
    process.env.STUDIO_EXTENSION_HELPER_TEST = 'inherited';
    try {
      const spec = node('console.log([process.env.STUDIO_EXTENSION_HELPER_TEST, process.env.ONLY].join())');
      const result = await runToExit(spawnChild, { ...spec, env: { ...SYSTEM, ONLY: 'given' } }, { timeoutMs: 20_000 });
      expect(result.output).toBe(',given\n');
    } finally {
      delete process.env.STUDIO_EXTENSION_HELPER_TEST;
    }
  });

  it('feeds input and lets the child end when its input closes', async () => {
    const result = await runToExit(
      spawnChild,
      node('process.stdin.on("data", (chunk) => process.stdout.write(String(chunk).toUpperCase()))'),
      { timeoutMs: 20_000, input: 'ping\n', closeInput: (line) => line === 'PING' }
    );
    expect(result).toMatchObject({ code: 0, output: 'PING\n' });
  });

  it('stops a process that would run forever', async () => {
    const result = await runToExit(spawnChild, node('setInterval(() => {}, 1000)'), { timeoutMs: 300, graceMs: 300 });
    expect(result).toMatchObject({ timedOut: true, cancelled: false });
    expect(result.code).not.toBe(0);
  });

  it('reports a missing executable instead of throwing', async () => {
    const result = await runToExit(
      spawnChild,
      { command: path.join(os.tmpdir(), 'studio-extension-helper-absent', 'python'), args: [], env: {} },
      { timeoutMs: 20_000 }
    );
    expect(result).toMatchObject({ failedToStart: true });
  });
});
