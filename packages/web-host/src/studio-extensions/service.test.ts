import { mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFakeBundle, fakeRuntime, type FakeRuntimeOptions } from '../../tests/fixtures/extensionRuntime';
import { writeWheel, type WheelSpec } from '../../tests/fixtures/extensionWheels';
import { ExtensionService } from './service';
import type { ExtensionListing, ExtensionOperation, ExtensionReply } from './types';

describe('the extension helper service', () => {
  let scratch = '';
  let root = '';
  let runtime: FakeRuntimeOptions;
  let spawn: ReturnType<typeof fakeRuntime>;
  let service: ExtensionService;
  beforeEach(async () => {
    scratch = await realpath(await mkdtemp(path.join(os.tmpdir(), 'studio-service-')));
    root = path.join(scratch, 'user data', 'aelix-runtime');
    runtime = { bundle: await createFakeBundle(path.join(scratch, 'bundle')) };
    spawn = fakeRuntime(runtime);
    service = new ExtensionService({ runtime: runtime.bundle, root, spawn, env: { PATH: '/usr/bin' } });
  });
  afterEach(async () => {
    service.dispose();
    await rm(scratch, { recursive: true, force: true });
  });

  const wheel = (spec: WheelSpec): Promise<string> => writeWheel(path.join(scratch, 'wheels'), spec);
  const installRequest = async (spec: WheelSpec) => ({
    action: 'install',
    source: { kind: 'file', path: await wheel(spec) },
  });
  const operation = (reply: ExtensionReply): ExtensionOperation => {
    if (reply.ok === false) throw new Error(`request failed: ${reply.code}`);
    return reply.data as ExtensionOperation;
  };
  const settle = async (reply: ExtensionReply, owner = 'window:1'): Promise<ExtensionOperation> => {
    let state = operation(reply);
    for (let round = 0; round < 500 && !['switched', 'failed', 'cancelled'].includes(state.phase); round += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      state = operation(await service.request(owner, { action: 'poll', operationId: state.operationId }));
    }
    return state;
  };
  const listing = async (): Promise<ExtensionListing> => {
    const reply = await service.request('window:1', { action: 'list' });
    if (reply.ok === false) throw new Error(`list failed: ${reply.code}`);
    return reply.data as ExtensionListing;
  };
  /** Holds the installer until released, so a change stays in progress. */
  const holdInstaller = (): (() => void) => {
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    runtime.install = async () => {
      await gate;
      return 1;
    };
    return release;
  };

  it('answers an install with an operation and reports the switch when the change is over', async () => {
    const started = await service.request('window:1', await installRequest({ name: 'demo-one' }));
    expect(started).toMatchObject({ ok: true, data: { action: 'install', phase: 'checking' } });
    const done = await settle(started);
    expect(done).toMatchObject({ phase: 'switched', generation: (await listing()).current });
    expect((await listing()).extensions.map((extension) => extension.name)).toEqual(['demo-one']);
    // "switched" means idle again: the next change is accepted at once.
    expect((await service.request('window:1', await installRequest({ name: 'demo-two' }))).ok).toBe(true);
  });

  it.each<[string, unknown]>([
    ['INVALID_INPUT', null],
    ['INVALID_INPUT', 'install'],
    ['INVALID_INPUT', ['install']],
    ['INVALID_INPUT', { action: 'install', source: { kind: 'file', path: 'x'.repeat(30_000) } }],
    ['UNSUPPORTED', { action: 'discover' }],
    ['UNSUPPORTED', {}],
    ['INVALID_INPUT', { action: 'install' }],
    ['INVALID_INPUT', { action: 'install', source: { kind: 'file', path: 'relative/demo.whl' } }],
    ['INVALID_INPUT', { action: 'install', source: { kind: 'index', name: 'demo' } }],
    ['INVALID_INPUT', { action: 'install', source: { kind: 'file', path: '/tmp/demo.whl', folder: 'relative' } }],
    ['INVALID_INPUT', { action: 'install', source: { kind: 'file', path: '/tmp/de\0mo.whl' } }],
    ['INVALID_INPUT', { action: 'update', source: { kind: 'file', path: '/tmp/demo.whl' } }],
    ['INVALID_INPUT', { action: 'update', name: '  ', source: { kind: 'file', path: '/tmp/demo.whl' } }],
    ['INVALID_INPUT', { action: 'remove' }],
    ['INVALID_INPUT', { action: 'remove', name: 7 }],
    ['NOT_FOUND', { action: 'poll', operationId: 'unknown' }],
  ])('answers %s to %j without starting anything', async (code, input) => {
    expect(await service.request('window:1', input)).toEqual({ ok: false, code });
    expect(spawn.calls).toEqual([]);
  });

  it('reports the runtime as unavailable when there is no bundle, for every kind of request', async () => {
    const missing = new ExtensionService({ runtime: path.join(scratch, 'absent'), root, spawn });
    expect(await missing.request('window:1', { action: 'list' })).toEqual({ ok: false, code: 'RUNTIME_UNAVAILABLE' });
    expect(await missing.request('window:1', { action: 'rollback' })).toEqual({
      ok: false,
      code: 'RUNTIME_UNAVAILABLE',
    });
    const install = await installRequest({ name: 'demo-one' });
    expect(await missing.request('window:1', install)).toEqual({ ok: false, code: 'RUNTIME_UNAVAILABLE' });
    // A refused start is not a running change: the next request is not answered with BUSY.
    expect(await missing.request('window:1', install)).toEqual({ ok: false, code: 'RUNTIME_UNAVAILABLE' });
    expect(spawn.calls).toEqual([]);
  });

  it('runs one change at a time and still lists while it runs', async () => {
    const release = holdInstaller();
    const started = await service.request('window:1', await installRequest({ name: 'demo-one' }));
    expect(await service.request('window:2', await installRequest({ name: 'demo-two' }))).toEqual({
      ok: false,
      code: 'BUSY',
    });
    expect(await service.request('window:1', { action: 'remove', name: 'demo-one' })).toEqual({
      ok: false,
      code: 'BUSY',
    });
    expect(await service.request('window:1', { action: 'rollback' })).toEqual({ ok: false, code: 'BUSY' });
    expect((await listing()).current).toBeNull();
    release();
    expect((await settle(started)).phase).toBe('failed');
    expect((await service.request('window:1', { action: 'rollback' })).ok).toBe(false);
  });

  it('shows an operation only to the caller that started it', async () => {
    const started = operation(await service.request('window:1', await installRequest({ name: 'demo-one' })));
    const poll = { action: 'poll', operationId: started.operationId };
    expect(await service.request('window:2', poll)).toEqual({ ok: false, code: 'NOT_FOUND' });
    expect(await service.request('window:2', { ...poll, action: 'cancel' })).toEqual({ ok: false, code: 'NOT_FOUND' });
    expect((await settle({ ok: true, data: started })).phase).toBe('switched');
  });

  it('reports a failed change with its code, its reasons and the end of the installer output', async () => {
    runtime.install = () => Promise.resolve(1);
    runtime.nativeOutput = 'ERROR: ResolutionImpossible\n';
    const done = await settle(await service.request('window:1', await installRequest({ name: 'demo-one' })));
    expect(done).toEqual({
      operationId: done.operationId,
      action: 'install',
      phase: 'failed',
      code: 'INSTALLER_FAILED',
      detail: ['the installer ended with exit code 1'],
      output: 'ERROR: ResolutionImpossible\n',
    });
    expect((await listing()).current).toBeNull();
  });

  it('reports a refused import with the reason for each wheel', async () => {
    const done = await settle(
      await service.request(
        'window:1',
        await installRequest({ name: 'demo-one', requires: ['dep@git+ssh://example.invalid/dep.git'] })
      )
    );
    expect(done).toMatchObject({
      phase: 'failed',
      code: 'DIRECT_REFERENCE',
      detail: ['demo_one-0.1.0-py3-none-any.whl: direct-reference dependency dep@git+ssh://example.invalid/dep.git'],
    });
  });

  it('reports an unexpected error as INTERNAL and accepts the next change', async () => {
    const broken = new ExtensionService({
      runtime: runtime.bundle,
      root,
      env: {},
      spawn: () => {
        throw new Error('cannot start processes');
      },
    });
    const failed = operation(await broken.request('window:1', await installRequest({ name: 'demo-two' })));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const state = operation(await broken.request('window:1', { action: 'poll', operationId: failed.operationId }));
    expect(state).toMatchObject({ phase: 'failed', code: 'INTERNAL', detail: ['cannot start processes'] });
    expect((await broken.request('window:1', await installRequest({ name: 'demo-two' }))).ok).toBe(true);
  });

  it('cancels a running change, removes its candidate and stays as it was', async () => {
    holdInstaller();
    const started = operation(await service.request('window:1', await installRequest({ name: 'demo-one' })));
    while (!spawn.calls.some((call) => call.args.includes('install')))
      await new Promise((resolve) => setTimeout(resolve, 5));
    const cancel = await service.request('window:1', { action: 'cancel', operationId: started.operationId });
    expect(cancel.ok).toBe(true);
    expect(await settle({ ok: true, data: started })).toMatchObject({ phase: 'cancelled', code: 'CANCELLED' });
    expect(await readdir(path.join(root, 'generations'))).toEqual([]);
    expect((await listing()).current).toBeNull();
  });

  it('does not undo a change that already switched when asked to cancel it', async () => {
    const done = await settle(await service.request('window:1', await installRequest({ name: 'demo-one' })));
    const cancel = await service.request('window:1', { action: 'cancel', operationId: done.operationId });
    expect(operation(cancel).phase).toBe('switched');
    expect((await listing()).current).toBe(done.generation);
  });

  it('cancels the change of a caller whose window or session closed', async () => {
    holdInstaller();
    const started = operation(await service.request('web:user-1', await installRequest({ name: 'demo-one' })));
    while (!spawn.calls.some((call) => call.args.includes('install')))
      await new Promise((resolve) => setTimeout(resolve, 5));
    service.cancelOwner('window:1');
    expect(
      operation(await service.request('web:user-1', { action: 'poll', operationId: started.operationId })).phase
    ).toBe('installing');
    service.cancelOwner('web:', true);
    expect((await settle({ ok: true, data: started }, 'web:user-1')).phase).toBe('cancelled');
  });

  it('stops a running change when disposed', async () => {
    holdInstaller();
    const started = operation(await service.request('window:1', await installRequest({ name: 'demo-one' })));
    while (!spawn.calls.some((call) => call.args.includes('install')))
      await new Promise((resolve) => setTimeout(resolve, 5));
    service.dispose();
    expect((await settle({ ok: true, data: started })).phase).toBe('cancelled');
  });

  it('rolls back directly and answers with the generation that is current now', async () => {
    const first = await settle(await service.request('window:1', await installRequest({ name: 'demo-one' })));
    const second = await settle(await service.request('window:1', await installRequest({ name: 'demo-two' })));
    expect(await service.request('window:1', { action: 'rollback' })).toEqual({
      ok: true,
      data: { current: first.generation, previous: second.generation, revision: 3 },
    });
    expect(await service.request('window:1', { action: 'rollback' })).toMatchObject({ ok: true });
  });

  it('answers a rollback with nothing to go back to as a failure with its code', async () => {
    expect(await service.request('window:1', { action: 'rollback' })).toEqual({
      ok: false,
      code: 'NOTHING_TO_ROLL_BACK',
      detail: ['there is no previous generation'],
    });
  });

  it('gives the processes it starts only the allow-listed environment', async () => {
    const hostile = new ExtensionService({
      runtime: runtime.bundle,
      root,
      spawn,
      env: {
        PATH: '/usr/bin',
        PIP_TARGET: '/elsewhere',
        AELIX_SETTINGS_PATH: '/elsewhere/settings.json',
        PYTHONPATH: '/x',
      },
    });
    const started = operation(await hostile.request('window:1', await installRequest({ name: 'demo-one' })));
    for (let round = 0; round < 500; round += 1) {
      const state = operation(await hostile.request('window:1', { action: 'poll', operationId: started.operationId }));
      if (state.phase === 'switched') break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(spawn.calls.length).toBeGreaterThan(4);
    for (const call of spawn.calls) {
      expect(call.env.PIP_TARGET).toBeUndefined();
      expect(call.env.AELIX_SETTINGS_PATH).toBeUndefined();
      expect([undefined, runtime.bundle + path.sep + 'native-site']).toContain(call.env.PYTHONPATH);
    }
  });
});
