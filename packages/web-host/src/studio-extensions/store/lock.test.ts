import { describe, expect, it } from 'vitest';
import { scriptedSpawn, type ScriptedChild } from '../../../tests/fixtures/extensionRuntime';
import { ExtensionFailure } from '../types';
import type { Bundle } from './layout';
import { layoutOf } from './layout';
import { acquireMutationLock, probeLeases, removeFromState } from './lock';

const bundle = { python: '/bundle/python/bin/python3' } as Bundle;
const layout = layoutOf('/data/aelix-runtime');
const request = (spawn: ReturnType<typeof scriptedSpawn>, signal?: AbortSignal) => ({
  bundle,
  layout,
  spawn,
  env: { PATH: '/usr/bin' },
  waitMs: 2500,
  signal,
});
const code = (failure: unknown): string | undefined => (failure instanceof ExtensionFailure ? failure.code : undefined);
const caught = (work: Promise<unknown>): Promise<unknown> => work.catch((error: unknown) => error);
/**
 * A holder that answers `held`, answers every request with `answer` and ends when its
 * input closes, like the real one.
 */
const holder = (
  child: ScriptedChild,
  answer: (request: Record<string, string>) => string = () => '{"ok": true}'
): void => {
  child.onEnd = () => child.exit(0);
  child.onInput = (text) => {
    for (const line of text.split('\n').filter(Boolean)) child.print(answer(JSON.parse(line)) + '\n');
  };
  child.print('held\n');
};

describe('the mutation lock', () => {
  it('is taken by the bundled interpreter, isolated, on the lock file, with the wait it was given', async () => {
    const spawn = scriptedSpawn((_spec, child) => holder(child));
    const lock = await acquireMutationLock(request(spawn));
    const { command, args, env } = spawn.calls[0];
    expect(command).toBe('/bundle/python/bin/python3');
    expect(args.slice(0, 6)).toEqual(['-I', '-S', '-B', '-X', 'utf8', '-c']);
    expect(args.slice(7)).toEqual(['hold', layout.lock, '2.5']);
    expect(env).toEqual({ PATH: '/usr/bin' });
    await lock.release();
  });

  it('is held until released, and releasing closes the holder and waits for it', async () => {
    const spawn = scriptedSpawn((_spec, child) => holder(child));
    const lock = await acquireMutationLock(request(spawn));
    expect(spawn.children[0].ended).toBe(false);
    expect([lock.lost(), lock.loss.aborted]).toEqual([false, false]);
    await lock.release();
    expect(spawn.children[0].ended).toBe(true);
    expect([lock.lost(), lock.loss.aborted]).toEqual([false, false]);
  });

  it('reports the lock as lost, and says so at once, when the holder ends on its own', async () => {
    const spawn = scriptedSpawn((_spec, child) => holder(child));
    const lock = await acquireMutationLock(request(spawn));
    const noticed = new Promise((resolve) => lock.loss.addEventListener('abort', resolve));
    spawn.children[0].exit(null, 'SIGKILL');
    await noticed;
    expect(lock.lost()).toBe(true);
  });

  it('gives up with BUSY when another holder kept the lock for the whole wait', async () => {
    const spawn = scriptedSpawn((_spec, child) => {
      child.print('busy\n');
      child.exit(3);
    });
    expect(code(await caught(acquireMutationLock(request(spawn))))).toBe('BUSY');
  });

  it('refuses a lock file that is a link', async () => {
    const spawn = scriptedSpawn((_spec, child) => {
      child.print('unsafe\n');
      child.exit(4);
    });
    expect(code(await caught(acquireMutationLock(request(spawn))))).toBe('UNSAFE_ROOT');
  });

  it('reports the runtime as unavailable when the holder ends without an answer', async () => {
    const spawn = scriptedSpawn((_spec, child) => child.exit(1));
    expect(code(await caught(acquireMutationLock(request(spawn))))).toBe('RUNTIME_UNAVAILABLE');
  });

  it('stops waiting when the caller cancels', async () => {
    const controller = new AbortController();
    const spawn = scriptedSpawn(() => controller.abort());
    expect(code(await caught(acquireMutationLock(request(spawn, controller.signal))))).toBe('CANCELLED');
    expect(spawn.children[0].signals).toEqual(['SIGTERM']);
  });

  it('starts no holder for a caller that already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const spawn = scriptedSpawn(() => {});
    expect(code(await caught(acquireMutationLock(request(spawn, controller.signal))))).toBe('CANCELLED');
    expect(spawn.calls).toEqual([]);
  });
});

describe('changing shared state through the lock holder', () => {
  it('asks the holder to rename and to remove, one request at a time, in order', async () => {
    const spawn = scriptedSpawn((_spec, child) => holder(child));
    const lock = await acquireMutationLock(request(spawn));
    await Promise.all([
      lock.replace('current.json.1a2b.tmp', 'current.json'),
      lock.remove('generations/g00000001-aaaa'),
      removeFromState(layout, lock, layout.lock + '.tmp'),
    ]);
    expect(spawn.children[0].written.map((line) => JSON.parse(line))).toEqual([
      { op: 'replace', from: 'current.json.1a2b.tmp', to: 'current.json' },
      { op: 'remove', path: 'generations/g00000001-aaaa' },
      { op: 'remove', path: 'lock.tmp' },
    ]);
    await lock.release();
  });

  it('never asks the holder to remove something that is not directly in the state directory', async () => {
    const spawn = scriptedSpawn((_spec, child) => holder(child));
    const lock = await acquireMutationLock(request(spawn));
    for (const target of ['/data/elsewhere', '/data/aelix-runtime/generations/g1/venv', '/data/aelix-runtime/other/x'])
      expect(code(await caught(Promise.resolve().then(() => removeFromState(layout, lock, target))))).toBe(
        'UNSAFE_ROOT'
      );
    expect(spawn.children[0].written).toEqual([]);
    await lock.release();
  });

  it('reports a path the holder refuses as an unsafe state directory', async () => {
    const spawn = scriptedSpawn((_spec, child) => holder(child, () => '{"ok": false, "refused": true}'));
    const lock = await acquireMutationLock(request(spawn));
    expect(code(await caught(lock.remove('generations/g00000001-aaaa')))).toBe('UNSAFE_ROOT');
    await lock.release();
  });

  it('reports a failure of the holder without passing on what it printed', async () => {
    const spawn = scriptedSpawn((_spec, child) => holder(child, () => '{"ok": false, "error": "PermissionError"}'));
    const lock = await acquireMutationLock(request(spawn));
    const failure = await caught(lock.remove('generations/g00000001-aaaa'));
    expect(failure).toBeInstanceOf(Error);
    expect(code(failure)).toBeUndefined();
    await lock.release();
  });

  it('changes nothing once the holder is gone, whether it ended before or during the request', async () => {
    const spawn = scriptedSpawn((_spec, child) => {
      child.onInput = () => child.exit(null, 'SIGKILL');
      child.print('held\n');
    });
    const lock = await acquireMutationLock(request(spawn));
    expect(code(await caught(lock.replace('current.json.1a2b.tmp', 'current.json')))).toBe('CONFLICT');
    expect(code(await caught(lock.remove('generations/g00000001-aaaa')))).toBe('CONFLICT');
    expect(spawn.children[0].written).toHaveLength(1);
  });

  it('changes nothing after it was released', async () => {
    const spawn = scriptedSpawn((_spec, child) => holder(child));
    const lock = await acquireMutationLock(request(spawn));
    await lock.release();
    expect(code(await caught(lock.remove('generations/g00000001-aaaa')))).toBe('CONFLICT');
    expect(spawn.children[0].written).toEqual([]);
  });
});

describe('the lease probe', () => {
  const probe = (output: string, exit = 0) =>
    scriptedSpawn((_spec, child) => {
      child.print(output);
      child.exit(exit);
    });

  it('maps held lease files to the generations they protect', async () => {
    const spawn = probe(
      JSON.stringify({ live: ['g00000002-bbbb.4711', 'g00000002-bbbb.4712', 'g00000005-eeee.1'], stale: ['old.9'] }) +
        '\n'
    );
    const report = await probeLeases(request(spawn));
    expect([...(report?.held ?? [])]).toEqual(['g00000002-bbbb', 'g00000005-eeee']);
    expect(report?.stale).toEqual(['old.9']);
    expect(spawn.calls[0].args.slice(7)).toEqual(['probe', layout.leases]);
  });

  it.each([
    ['the probe failed', probe('', 1)],
    ['the probe printed no report', probe('Traceback\n')],
    ['the report has another shape', probe('{"live": "all"}\n')],
  ])('gives no report when %s, so that nothing gets removed', async (_what, spawn) => {
    expect(await probeLeases(request(spawn))).toBeUndefined();
  });
});
