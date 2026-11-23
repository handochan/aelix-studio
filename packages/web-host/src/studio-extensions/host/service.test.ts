import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createFakeBundle,
  fakeRuntime,
  installWheel,
  type FakeRuntimeOptions,
} from '../../../tests/fixtures/extensionRuntime';
import { writeWheel, type WheelSpec } from '../../../tests/fixtures/extensionWheels';
import { ExtensionService } from './service';
import type { ExtensionListing, ExtensionOperation, ExtensionReply } from '../types';

// These fixtures assert POSIX paths and installer environment. Preview installer CI runs real Windows.
describe.skipIf(process.platform === 'win32')('the extension helper service', () => {
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
    await service.dispose();
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

  it('persists an app default without switching generations and carries it through an update', async () => {
    await settle(await service.request('window:1', await installRequest({ name: 'demo-one' })));
    const { current } = await listing();
    const extensionId = 'demo-one:pack:demo-one';
    expect(await service.request('window:1', { action: 'set_default', extensionId, enabled: false })).toMatchObject({
      ok: true,
      data: { current, extensions: [{ managedId: extensionId, defaultEnabled: false }] },
    });
    const update = await service.request('window:1', {
      action: 'update',
      name: 'demo-one',
      source: { kind: 'file', path: await wheel({ name: 'demo-one', version: '0.2.0' }) },
    });
    expect(await settle(update)).toMatchObject({ phase: 'switched' });
    expect((await listing()).extensions).toMatchObject([{ managedId: extensionId, defaultEnabled: false }]);
  });

  it.each(
    ['__proto__', 'constructor', 'toString'].flatMap((entry) => [
      { entry, form: 'module', manifest: false },
      { entry, form: 'pack', manifest: true },
    ])
  )('preserves a disabled $form with the entry name $entry on update', async ({ entry, manifest }) => {
    const spec = { name: 'demo-one', entry, manifest };
    const extensionId = manifest ? 'demo-one:pack:demo-one' : `demo-one:${entry}`;
    expect(await settle(await service.request('window:1', await installRequest(spec)))).toMatchObject({
      phase: 'switched',
    });
    expect(await service.request('window:1', { action: 'set_default', extensionId, enabled: false })).toMatchObject({
      ok: true,
    });
    const update = await service.request('window:1', {
      action: 'update',
      name: spec.name,
      source: { kind: 'file', path: await wheel({ ...spec, version: '0.2.0' }) },
    });
    expect(await settle(update)).toMatchObject({ phase: 'switched' });
    expect(JSON.parse(await readFile(path.join(root, 'current.json'), 'utf8')).defaults).toEqual({
      [extensionId]: false,
    });
    expect((await listing()).extensions).toMatchObject([
      { name: entry, managedId: extensionId, defaultEnabled: false },
    ]);
  });

  it('does not write defaults for IDs outside the managed generation', async () => {
    await settle(await service.request('window:1', await installRequest({ name: 'demo-one' })));
    expect(
      await service.request('window:1', { action: 'set_default', extensionId: 'missing:entry', enabled: false })
    ).toMatchObject({ ok: false, code: 'NOT_INSTALLED' });
  });

  it.each([
    { before: 'module', manifest: false, beforeId: 'demo-one:demo-one', afterId: 'demo-one:pack:demo-one' },
    { before: 'pack', manifest: true, beforeId: 'demo-one:pack:demo-one', afterId: 'demo-one:demo-one' },
  ])('retains disabled defaults when a $before changes launch form', async ({ manifest, beforeId, afterId }) => {
    await settle(await service.request('window:1', await installRequest({ name: 'demo-one', manifest })));
    expect(
      await service.request('window:1', { action: 'set_default', extensionId: beforeId, enabled: false })
    ).toMatchObject({ ok: true });
    const update = await service.request('window:1', {
      action: 'update',
      name: 'demo-one',
      source: { kind: 'file', path: await wheel({ name: 'demo-one', version: '0.2.0', manifest: !manifest }) },
    });
    expect(await settle(update)).toMatchObject({ phase: 'switched' });
    expect((await listing()).extensions).toMatchObject([{ managedId: afterId, defaultEnabled: false }]);
    expect(JSON.parse(await readFile(path.join(root, 'current.json'), 'utf8')).defaults).toEqual({
      [afterId]: false,
    });
    expect(await service.request('window:1', { action: 'rollback' })).toMatchObject({ ok: true });
    expect((await listing()).extensions).toMatchObject([{ managedId: beforeId, defaultEnabled: false }]);
  });

  it('starts with a fresh default after renaming the only entry of a pack', async () => {
    await settle(await service.request('window:1', await installRequest({ name: 'demo-one', entry: 'old-name' })));
    const extensionId = 'demo-one:pack:demo-one';
    await service.request('window:1', { action: 'set_default', extensionId, enabled: false });
    const update = await service.request('window:1', {
      action: 'update',
      name: 'demo-one',
      source: { kind: 'file', path: await wheel({ name: 'demo-one', version: '0.2.0', entry: 'new-name' }) },
    });
    expect(await settle(update)).toMatchObject({ phase: 'switched' });
    expect((await listing()).extensions).toMatchObject([
      { name: 'new-name', managedId: extensionId, defaultEnabled: true },
    ]);
  });

  it('keeps a pack disabled when its previously separate entries disagree', async () => {
    await settle(
      await service.request(
        'window:1',
        await installRequest({ name: 'demo-one', manifest: false, aliases: { alias: 'demo_one:other' } })
      )
    );
    await service.request('window:1', { action: 'set_default', extensionId: 'demo-one:demo-one', enabled: false });
    await service.request('window:1', { action: 'set_default', extensionId: 'demo-one:demo-one', enabled: true });
    await service.request('window:1', { action: 'set_default', extensionId: 'demo-one:alias', enabled: false });
    const update = await service.request('window:1', {
      action: 'update',
      name: 'demo-one',
      source: {
        kind: 'file',
        path: await wheel({ name: 'demo-one', version: '0.2.0', aliases: { alias: 'demo_one:setup' } }),
      },
    });
    expect(await settle(update)).toMatchObject({ phase: 'switched' });
    expect((await listing()).extensions).toMatchObject([
      { name: 'alias', managedId: 'demo-one:pack:demo-one', defaultEnabled: false },
      { name: 'demo-one', managedId: 'demo-one:pack:demo-one', defaultEnabled: false },
    ]);
  });

  it.each([
    { kind: 'Unicode', entry: '확장' },
    { kind: 'overlong ASCII', entry: 'a'.repeat(260) },
  ])('uses one stable ASCII ID and preserves the default for a $kind entry point', async ({ entry }) => {
    const spec = { name: 'demo-one', manifest: false, entry };
    expect(await settle(await service.request('window:1', await installRequest(spec)))).toMatchObject({
      phase: 'switched',
    });
    const extensionId = (await listing()).extensions[0]?.managedId;
    expect(extensionId).toMatch(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/);
    await service.request('window:1', { action: 'set_default', extensionId, enabled: false });
    const update = await service.request('window:1', {
      action: 'update',
      name: 'demo-one',
      source: { kind: 'file', path: await wheel({ ...spec, version: '0.2.0' }) },
    });
    expect(await settle(update)).toMatchObject({ phase: 'switched' });
    expect((await listing()).extensions).toMatchObject([
      { name: entry, managedId: extensionId, defaultEnabled: false },
    ]);
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
    ['INVALID_INPUT', { action: 'install', source: { kind: 'index', name: '--extra-index-url' } }],
    ['INVALID_INPUT', { action: 'install', source: { kind: 'index', name: 'demo @ https://other.invalid/' } }],
    ['INVALID_INPUT', { action: 'install', source: { kind: 'index', name: 'demo', indexUrl: 'file:///wheels' } }],
    [
      'INVALID_INPUT',
      { action: 'install', source: { kind: 'index', name: 'demo', indexUrl: 'https://user:pass@mirror.invalid/' } },
    ],
    ['INVALID_INPUT', { action: 'install', source: { kind: 'git', url: 'git+ext::other' } }],
    ['INVALID_INPUT', { action: 'install', source: { kind: 'file', path: '/tmp/demo.whl', folder: 'relative' } }],
    ['INVALID_INPUT', { action: 'install', source: { kind: 'file', path: '/tmp/de\0mo.whl' } }],
    ['INVALID_INPUT', { action: 'update', source: { kind: 'file', path: '/tmp/demo.whl' } }],
    ['INVALID_INPUT', { action: 'update', name: '  ', source: { kind: 'file', path: '/tmp/demo.whl' } }],
    ['INVALID_INPUT', { action: 'remove' }],
    ['INVALID_INPUT', { action: 'remove', name: 7 }],
    ['INVALID_INPUT', { action: 'set_default', extensionId: 'demo:entry', enabled: 'off' }],
    ['NOT_FOUND', { action: 'poll', operationId: 'unknown' }],
  ])('answers %s to %j without starting anything', async (code, input) => {
    expect(await service.request('window:1', input)).toEqual({ ok: false, code });
    expect(spawn.calls).toEqual([]);
  });

  it.each([
    'git+ssh://git.invalid',
    'git+ssh://git.invalid/',
    'git+git://git.invalid',
    'git+git://git.invalid/',
    'git+https://git.invalid/demo.git@--upload-pack=other',
    'git+https://git.invalid/demo.git@%2Doption',
    'git+https://git.invalid/demo.git@%00',
    'git+https://git.invalid/demo.git@',
    'git+https://git.invalid/demo.git@heads//stable',
    'git+https://git.invalid/demo.git@branch/%2e%2e/stable',
    'git+file:///local/repo%40%2Doption',
    'git+file:///local/repo@%252Doption',
    'git+file:///local/repo%23subdirectory=outside',
    'git+file:///local/repo%00',
    'git+file:///local/repo%5cother',
    'git+https://git.invalid/demo.git#subdirectory=../outside',
    'git+https://git.invalid/demo.git#subdirectory=%2e%2e%2foutside',
    'git+https://git.invalid/demo.git#subdirectory=/outside',
    'git+https://git.invalid/demo.git#subdirectory=C:%5coutside',
    'git+https://git.invalid/demo.git#subdirectory=possible-link',
  ])('refuses an unsafe Git URL before spawning anything (%s)', async (url) => {
    const source = { kind: 'git', url };
    expect(await service.request('window:1', { action: 'install', source })).toEqual({
      ok: false,
      code: 'INVALID_INPUT',
    });
    expect(spawn.calls).toEqual([]);
  });

  it('refuses both online sources before spawning anything when Studio settings turn them off', async () => {
    let enabled = false;
    service = new ExtensionService({
      runtime: runtime.bundle,
      root,
      spawn,
      onlineInstallEnabled: () => enabled,
    });
    const named = { action: 'install', source: { kind: 'index', name: 'demo-one' } };
    const git = { action: 'install', source: { kind: 'git', url: 'git+https://git.invalid/owner/demo.git' } };
    for (const request of [named, git])
      expect(await service.request('window:1', request)).toEqual({ ok: false, code: 'ONLINE_INSTALL_DISABLED' });
    expect(spawn.calls).toEqual([]);
    expect(await readdir(scratch)).not.toContain('user data');

    const file = await installRequest({ name: 'demo-one' });
    expect(await settle(await service.request('window:1', file))).toMatchObject({ phase: 'switched' });
    enabled = true;
    runtime.install = async () => 1;
    expect(await settle(await service.request('window:1', named))).toMatchObject({ code: 'INSTALLER_FAILED' });
  });

  it.each([
    [undefined, 'https://pypi.org/simple/'],
    ['http://127.0.0.1:8042/simple/', 'http://127.0.0.1:8042/simple/'],
  ])('uses exactly one configured index (%s) even with ambient installer settings', async (indexUrl, selected) => {
    service = new ExtensionService({
      runtime: runtime.bundle,
      root,
      spawn,
      onlineInstallEnabled: true,
      env: {
        PIP_INDEX_URL: 'https://ambient.invalid/',
        PIP_EXTRA_INDEX_URL: 'https://extra.invalid/',
        PIP_FIND_LINKS: 'https://links.invalid/',
        PIP_CONFIG_FILE: '/home/user/pip.conf',
        HTTPS_PROXY: 'http://proxy.invalid/',
        GIT_CONFIG_GLOBAL: '/home/user/.gitconfig',
      },
    });
    const artifact = await wheel({ name: 'demo-one', version: '1.0.0' });
    runtime.install = async (venv) => {
      await installWheel(venv, artifact);
      return 0;
    };
    const request = { action: 'install', source: { kind: 'index', name: 'Demo.One', version: '1.0', indexUrl } };
    expect(await settle(await service.request('window:1', request))).toMatchObject({ phase: 'switched' });
    const installer = spawn.calls.find((call) => call.args.includes('install'));
    expect(installer?.args.slice(-5)).toEqual(['install', 'demo-one==1.0', '--index-url', selected, '--yes']);
    expect(installer?.env).toMatchObject({
      PIP_INDEX_URL: selected,
      PIP_CONFIG_FILE: '/dev/null',
      PIP_DISABLE_PIP_VERSION_CHECK: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
    });
    expect(installer?.env).not.toHaveProperty('PIP_EXTRA_INDEX_URL');
    expect(installer?.env).not.toHaveProperty('PIP_FIND_LINKS');
    expect(installer?.env).not.toHaveProperty('HTTPS_PROXY');
    expect((await listing()).extensions[0]).toMatchObject({
      version: '1.0.0',
      origin: { kind: 'index', indexUrl: selected },
    });
    expect(await readdir(path.join(root, 'artifacts'))).toEqual([]);
  });

  it('installs a git source against the selected build index and records the resolved commit', async () => {
    const url = 'https://git.invalid/owner/demo.git';
    const commit = '2'.repeat(40);
    const indexUrl = 'https://mirror.invalid/simple/';
    const artifact = await wheel({ name: 'demo-one' });
    runtime.install = async (venv) => {
      await installWheel(venv, artifact);
      await writeFile(
        path.join(venv.site, 'demo_one-0.1.0.dist-info', 'direct_url.json'),
        JSON.stringify({ url, vcs_info: { vcs: 'git', requested_revision: 'stable', commit_id: commit } })
      );
      return 0;
    };
    const source = { kind: 'git', url: 'git+' + url + '@stable', indexUrl };
    expect(await settle(await service.request('window:1', { action: 'install', source }))).toMatchObject({
      phase: 'switched',
    });
    const installer = spawn.calls.find((call) => call.args.includes('install'));
    expect(installer?.args.slice(-3)).toEqual(['install', source.url, '--yes']);
    expect(installer?.env?.PIP_INDEX_URL).toBe(indexUrl);
    expect((await listing()).extensions[0].origin).toEqual({ ...source, commit });
  });

  it.each([
    { scenario: 'no provenance' },
    { scenario: 'wrong repository URL', recordedUrl: 'https://git.invalid/owner/another.git' },
    { scenario: 'wrong commit', recordedUrl: 'https://git.invalid/owner/demo.git', requestedRef: '@' + 'A'.repeat(40) },
  ])('keeps the old generation if Git provenance differs ($scenario)', async ({ recordedUrl, requestedRef }) => {
    const before = await settle(await service.request('window:1', await installRequest({ name: 'kept' })));
    const unrelated = await wheel({ name: 'other' });
    runtime.install = async (venv) => {
      await installWheel(venv, unrelated);
      if (recordedUrl)
        await writeFile(
          path.join(venv.site, 'other-0.1.0.dist-info', 'direct_url.json'),
          JSON.stringify({ url: recordedUrl, vcs_info: { vcs: 'git', commit_id: '2'.repeat(40) } })
        );
      return 0;
    };
    const url = 'git+https://git.invalid/owner/demo.git' + (requestedRef ?? '');
    const request = { action: 'install', source: { kind: 'git', url } };
    expect(await settle(await service.request('window:1', request))).toMatchObject({
      phase: 'failed',
      code: 'REQUEST_MISMATCH',
    });
    expect((await listing()).current).toBe(before.generation);
    expect(await readdir(path.join(root, 'generations'))).toEqual([before.generation]);
  });

  it('waits for an in-flight bundle reconcile to cancel when the helper is disposed', async () => {
    const before = await settle(await service.request('window:1', await installRequest({ name: 'kept' })));
    const manifest = path.join(runtime.bundle, 'manifest.json');
    const changed = await readFile(manifest, 'utf8');
    await writeFile(manifest, changed.replace('a'.repeat(64), 'b'.repeat(64)));
    runtime.beforeLoad = () => false;
    const pending = service.request('window:1', { action: 'reconcile_bundle' });
    await vi.waitFor(() =>
      expect(spawn.calls.filter((call) => call.args.includes('native-generation'))).toHaveLength(3)
    );
    await service.dispose();
    expect(await pending).toEqual({ ok: false, code: 'CANCELLED' });
    expect((await listing()).current).toBe(before.generation);
    expect(await readdir(path.join(root, 'generations'))).toEqual([before.generation]);
  });

  it('reports the runtime as unavailable when there is no bundle, for every kind of request, with the fix', async () => {
    const missing = new ExtensionService({ runtime: path.join(scratch, 'absent'), root, spawn });
    const unavailable = {
      ok: false,
      code: 'RUNTIME_UNAVAILABLE',
      detail: ['the Studio runtime was not found; set AELIX_STUDIO_RUNTIME to a prepared runtime'],
    };
    expect(await missing.request('window:1', { action: 'list' })).toEqual(unavailable);
    expect(await missing.request('window:1', { action: 'rollback' })).toEqual(unavailable);
    const install = await installRequest({ name: 'demo-one' });
    expect(await missing.request('window:1', install)).toEqual(unavailable);
    // A refused start is not a running change: the next request is not answered with BUSY.
    expect(await missing.request('window:1', install)).toEqual(unavailable);
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

  // Review finding 12: the text of an unexpected error can hold absolute paths.
  it('reports an unexpected error as INTERNAL with nothing of its text, logs it, and accepts the next change', async () => {
    const logged: unknown[] = [];
    const broken = new ExtensionService({
      runtime: runtime.bundle,
      root,
      env: {},
      log: (_message, error) => logged.push(error),
      spawn: () => {
        throw new Error(`ENOTDIR: not a directory, open '${path.join(root, 'generations')}'`);
      },
    });
    const failed = operation(await broken.request('window:1', await installRequest({ name: 'demo-two' })));
    // Polled, not disposed: disposing cancels the change before it meets the error.
    let state = failed;
    for (let round = 0; round < 500 && !['switched', 'failed', 'cancelled'].includes(state.phase); round += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      state = operation(await broken.request('window:1', { action: 'poll', operationId: failed.operationId }));
    }
    expect(state).toEqual({ operationId: failed.operationId, action: 'install', phase: 'failed', code: 'INTERNAL' });
    expect(logged.map((error) => (error as Error).message)).toEqual([
      `ENOTDIR: not a directory, open '${path.join(root, 'generations')}'`,
    ]);
    expect((await broken.request('window:1', await installRequest({ name: 'demo-two' }))).ok).toBe(true);
    await broken.dispose();
  });

  it('answers an unexpected error of a direct request the same way', async () => {
    const logged: unknown[] = [];
    const broken = new ExtensionService({
      runtime: runtime.bundle,
      root,
      env: {},
      log: (_message, error) => logged.push(error),
      spawn: () => {
        throw new Error(`EACCES: permission denied, open '${root}'`);
      },
    });
    expect(await broken.request('window:1', { action: 'rollback' })).toEqual({ ok: false, code: 'INTERNAL' });
    expect(logged).toHaveLength(1);
  });

  // Review finding 3, seen from a caller.
  it('refuses to list or change a state directory that is not its own', async () => {
    const outside = path.join(scratch, 'valuable');
    await mkdir(path.join(outside, 'keep'), { recursive: true });
    await mkdir(root, { recursive: true });
    await symlink(outside, path.join(root, 'generations'), 'junction');
    expect(await service.request('window:1', { action: 'list' })).toMatchObject({ ok: false, code: 'UNSAFE_ROOT' });
    expect(await service.request('window:1', { action: 'rollback' })).toMatchObject({ ok: false, code: 'UNSAFE_ROOT' });
    const done = await settle(await service.request('window:1', await installRequest({ name: 'demo-one' })));
    expect(done).toMatchObject({ phase: 'failed', code: 'UNSAFE_ROOT' });
    expect(await readdir(outside)).toEqual(['keep']);
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

  it.each([
    ['its window closes', 'desktop:7', 'desktop:7', false],
    ['the WebUI listener stops', 'web:operator', 'web:', true],
  ] as const)(
    'ends a change asked for while %s before it starts, even while the bundle is still being found',
    async (_case, owner, cancelled, prefix) => {
      const request = await installRequest({ name: 'demo-one' });
      // No await between the request and the cancel: it lands while the change finds its bundle.
      const pending = service.request(owner, request);
      service.cancelOwner(cancelled, prefix);
      expect(await pending).toEqual({ ok: false, code: 'CANCELLED' });
      expect(spawn.calls.filter((call) => call.args.includes('hold'))).toEqual([]);
      expect((await listing()).current).toBeNull();
      // Nothing is left marked as running: the next change starts.
      expect((await settle(await service.request(owner, request), owner)).phase).toBe('switched');
    }
  );

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
    await service.dispose();
    // Disposing waits for the change to end: its final state is there without polling for it.
    const state = operation(await service.request('window:1', { action: 'poll', operationId: started.operationId }));
    expect(state.phase).toBe('cancelled');
    expect(await readdir(path.join(root, 'generations'))).toEqual([]);
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

describe('the extension helper service on Windows', () => {
  let scratch = '';
  let spawn: ReturnType<typeof fakeRuntime>;
  let service: ExtensionService;
  beforeEach(async () => {
    scratch = await realpath(await mkdtemp(path.join(os.tmpdir(), 'studio-service-win-')));
    const bundle = await createFakeBundle(path.join(scratch, 'bundle'), { platform: 'win32', arch: 'x64' });
    spawn = fakeRuntime({ bundle, platform: 'win32' });
    service = new ExtensionService({
      runtime: bundle,
      root: path.join(scratch, 'aelix-runtime'),
      spawn,
      env: {},
      platform: 'win32',
      arch: 'x64',
    });
  });
  afterEach(() => rm(scratch, { recursive: true, force: true }));

  it('refuses a Git install until the Windows Git and SSH toolchain is qualified', async () => {
    const command = { action: 'install', source: { kind: 'git', url: 'git+https://git.invalid/demo.git' } };
    expect(await service.request('window:1', command)).toEqual({ ok: false, code: 'UNSUPPORTED_PLATFORM' });
    expect(spawn.calls).toEqual([]);
  });

  it('still lists, which only reads files', async () => {
    expect(await service.request('window:1', { action: 'list' })).toMatchObject({
      ok: true,
      data: { current: null, extensions: [] },
    });
  });

  it('still answers a request it would not take anywhere with the reason for that', async () => {
    expect(await service.request('window:1', { action: 'remove' })).toEqual({ ok: false, code: 'INVALID_INPUT' });
  });
});
