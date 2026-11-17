import { describe, expect, it } from 'vitest';
import { scriptedSpawn, type ScriptedChild } from '../../../tests/fixtures/extensionRuntime';
import { ExtensionFailure } from '../types';
import type { Bundle } from './layout';
import { layoutOf } from './layout';
import { acquireMutationLock, probeLeases } from './lock';

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
/** A holder that answers `held` and ends when its input closes, like the real one. */
const holder = (child: ScriptedChild): void => {
  child.onEnd = () => child.exit(0);
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
    expect(lock.lost()).toBe(false);
    await lock.release();
    expect(spawn.children[0].ended).toBe(true);
    expect(lock.lost()).toBe(false);
  });

  it('reports the lock as lost when the holder ends on its own', async () => {
    const spawn = scriptedSpawn((_spec, child) => holder(child));
    const lock = await acquireMutationLock(request(spawn));
    spawn.children[0].exit(null, 'SIGKILL');
    await spawn.children[0].exited;
    await Promise.resolve();
    expect(lock.lost()).toBe(true);
  });

  it('gives up with BUSY when another holder kept the lock for the whole wait', async () => {
    const spawn = scriptedSpawn((_spec, child) => {
      child.print('busy\n');
      child.exit(3);
    });
    expect(code(await acquireMutationLock(request(spawn)).catch((error: unknown) => error))).toBe('BUSY');
  });

  it('reports the runtime as unavailable when the holder ends without an answer', async () => {
    const spawn = scriptedSpawn((_spec, child) => child.exit(1));
    expect(code(await acquireMutationLock(request(spawn)).catch((error: unknown) => error))).toBe(
      'RUNTIME_UNAVAILABLE'
    );
  });

  it('stops waiting when the caller cancels', async () => {
    const controller = new AbortController();
    const spawn = scriptedSpawn(() => controller.abort());
    const failure = await acquireMutationLock(request(spawn, controller.signal)).catch((error: unknown) => error);
    expect(code(failure)).toBe('CANCELLED');
    expect(spawn.children[0].signals).toEqual(['SIGTERM']);
  });

  it('starts no holder for a caller that already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const spawn = scriptedSpawn(() => {});
    expect(code(await acquireMutationLock(request(spawn, controller.signal)).catch((error: unknown) => error))).toBe(
      'CANCELLED'
    );
    expect(spawn.calls).toEqual([]);
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
