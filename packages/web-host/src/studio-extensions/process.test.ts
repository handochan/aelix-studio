import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { scriptedSpawn } from '../../tests/fixtures/extensionRuntime';
import { OutputTail, runToExit, spawnChild } from './process';

const SPEC = { command: 'python', args: ['-I'], env: {} };

describe('output tail', () => {
  it('keeps only the end of what was pushed', () => {
    const tail = new OutputTail(5);
    tail.push('abc');
    tail.push('defgh');
    expect(tail.toString()).toBe('defgh');
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
