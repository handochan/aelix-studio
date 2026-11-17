/**
 * The Studio extension helper against a real bundled runtime (Studio #32, D04 ADR).
 *
 * Skipped unless AELIX_STUDIO_EXTENSION_BUNDLE names a COPY of a bundled runtime (the
 * directory with manifest.json). Everything is written under AELIX_STUDIO_EXTENSION_SCRATCH
 * (default: the system temporary directory); the bundle copy must come out unchanged.
 * It assumes the POSIX layout of a bundle and a venv; Windows is checked in stage 1a'.
 *
 *   AELIX_STUDIO_EXTENSION_BUNDLE=<bundle copy> AELIX_STUDIO_EXTENSION_SCRATCH=<dir> \
 *     bunx vitest run tests/integration/studioExtensions.test.ts
 */
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readdir, readFile, readlink, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ExtensionService,
  type ExtensionListing,
  type ExtensionOperation,
  type ExtensionReply,
  type ExtensionRollback,
} from '../../packages/web-host/src/studio-extensions/index';
import { baseEnvironment } from '../../packages/web-host/src/studio-extensions/flow/environment';
import { spawnChild } from '../../packages/web-host/src/studio-extensions/process';
import { locateLayout, resolveBundle } from '../../packages/web-host/src/studio-extensions/store/layout';
import { acquireMutationLock } from '../../packages/web-host/src/studio-extensions/store/lock';
import { writeWheel, type WheelSpec } from '../../packages/web-host/tests/fixtures/extensionWheels';

const BUNDLE = process.env.AELIX_STUDIO_EXTENSION_BUNDLE;
const run = promisify(execFile);
const OWNER = 'integration';

/** Compare every file of the bundle with its own checksums.json. */
async function bundleDifferences(root: string): Promise<string[]> {
  const expected = JSON.parse(await readFile(path.join(root, 'checksums.json'), 'utf8')) as Record<string, string>;
  const actual: Record<string, string> = {};
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      const key = path.relative(root, file).split(path.sep).join('/');
      if (entry.isSymbolicLink()) actual[key] = `symlink:${await readlink(file)}`;
      else if (entry.isDirectory()) await walk(file);
      else if (key !== 'checksums.json')
        actual[key] = createHash('sha256')
          .update(await readFile(file))
          .digest('hex');
    }
  };
  await walk(root);
  delete expected['checksums.json'];
  return [...new Set([...Object.keys(expected), ...Object.keys(actual)])].filter(
    (key) => expected[key] !== actual[key]
  );
}

describe.skipIf(!BUNDLE || process.platform === 'win32')('Studio extension helper against a bundled runtime', () => {
  const bundle = BUNDLE ?? '';
  let sandbox = '';
  let root = '';
  let wheels = '';
  let outside = '';
  let service: ExtensionService;
  let environment: NodeJS.ProcessEnv;

  const wheel = (spec: WheelSpec, folder = 'single'): Promise<string> => writeWheel(path.join(wheels, folder), spec);
  const data = <T>(reply: ExtensionReply): T => {
    if (reply.ok === false) throw new Error(`request failed: ${reply.code} ${(reply.detail ?? []).join('; ')}`);
    return reply.data as T;
  };
  const list = async (target = service): Promise<ExtensionListing> =>
    data<ExtensionListing>(await target.request(OWNER, { action: 'list' }));
  const finish = async (reply: ExtensionReply, target = service): Promise<ExtensionOperation> => {
    let state = data<ExtensionOperation>(reply);
    while (!['switched', 'failed', 'cancelled'].includes(state.phase)) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      state = data<ExtensionOperation>(await target.request(OWNER, { action: 'poll', operationId: state.operationId }));
    }
    return state;
  };
  const install = async (file: string, folder?: string, target = service): Promise<ExtensionOperation> =>
    finish(
      await target.request(OWNER, {
        action: 'install',
        source: { kind: 'file', path: file, ...(folder ? { folder } : {}) },
      }),
      target
    );
  const generations = async (): Promise<string[]> => (await readdir(path.join(root, 'generations'))).toSorted();
  const names = (listing: ExtensionListing): string[] => listing.extensions.map((extension) => extension.name);
  const generationFile = (generation: string, ...parts: string[]): string =>
    path.join(root, 'generations', generation, ...parts);
  /** A refused change must leave the pointer, the generations and the current content as they were. */
  const expectUntouched = async (before: ExtensionListing, directories: string[]): Promise<void> => {
    expect(await list()).toEqual(before);
    expect(await generations()).toEqual(directories);
  };

  beforeAll(async () => {
    const scratch = process.env.AELIX_STUDIO_EXTENSION_SCRATCH ?? os.tmpdir();
    await mkdir(scratch, { recursive: true });
    sandbox = await mkdtemp(path.join(scratch, 'studio-extensions-'));
    root = path.join(sandbox, 'Application Support', '스튜디오 데이터', 'aelix-runtime');
    wheels = path.join(sandbox, 'wheels');
    outside = path.join(sandbox, 'outside');
    await Promise.all(
      ['home', 'tmp', 'outside/target', 'outside/site'].map((name) =>
        mkdir(path.join(sandbox, name), { recursive: true })
      )
    );
    await writeFile(
      path.join(outside, 'pip.conf'),
      `[install]\ntarget = ${path.join(outside, 'target')}\n[global]\nindex-url = http://127.0.0.1:9/simple/\n`
    );
    // Everything below the first four is what a user's shell might export. None of it may
    // reach native or pip: the helper builds their environment from an allow-list.
    environment = {
      PATH: '/usr/bin:/bin',
      HOME: path.join(sandbox, 'home'),
      TMPDIR: path.join(sandbox, 'tmp'),
      LANG: 'en_US.UTF-8',
      PIP_CONFIG_FILE: path.join(outside, 'pip.conf'),
      PIP_TARGET: path.join(outside, 'target'),
      PIP_INDEX_URL: 'http://127.0.0.1:9/simple/',
      PIP_BREAK_SYSTEM_PACKAGES: '1',
      PYTHONPATH: path.join(outside, 'site'),
      PYTHONUSERBASE: path.join(outside, 'site'),
      VIRTUAL_ENV: path.join(outside, 'site'),
      AELIX_SETTINGS_PATH: path.join(outside, 'settings.json'),
      AELIX_AUTH_PATH: path.join(outside, 'auth.json'),
      AELIX_CODING_AGENT_DIR: path.join(outside, 'agent'),
      XDG_CONFIG_HOME: path.join(outside, 'xdg'),
    };
    service = new ExtensionService({ runtime: bundle, root, env: environment });
  });

  afterAll(async () => {
    // Wait for a change a failed test may have left running before its files are removed.
    await service?.dispose();
    if (sandbox && !process.env.AELIX_STUDIO_EXTENSION_KEEP) await rm(sandbox, { recursive: true, force: true });
  });

  it('starts with nothing installed and creates nothing by listing', async () => {
    expect(await list()).toEqual({
      current: null,
      previous: null,
      revision: 0,
      appliesAt: 'new_session',
      rollbackAvailable: false,
      extensions: [],
    });
    await expect(readdir(root)).rejects.toThrow();
  });

  it('installs a wheel, verifies it by loading it and switches', async () => {
    const result = await install(await wheel({ name: 'fixture-good' }));
    expect(result).toMatchObject({ phase: 'switched', action: 'install' });
    const listing = await list();
    expect(listing).toMatchObject({ current: result.generation, previous: null, revision: 1 });
    expect(listing.extensions).toEqual([
      expect.objectContaining({
        name: 'fixture-good',
        distribution: 'fixture-good',
        version: '0.1.0',
        reference: 'fixture_good:setup',
        status: 'load_verified',
        origin: expect.objectContaining({ kind: 'file', wheel: 'fixture_good-0.1.0-py3-none-any.whl' }),
      }),
    ]);
    expect(await generations()).toEqual([result.generation]);
  }, 120_000);

  it('refuses an import set before any installer runs and leaves the current generation untouched', async () => {
    const before = await list();
    const directories = await generations();
    const stored = await readdir(path.join(root, 'artifacts'));
    const refused: [string, WheelSpec][] = [
      ['DIRECT_REFERENCE', { name: 'fixture-direct', requires: ['fixture_dep@git+ssh://example.invalid/dep.git'] }],
      ['DIRECT_REFERENCE', { name: 'fixture-url', requires: ['fixture-dep @ http://127.0.0.1:9/dep.whl'] }],
      ['NOT_AN_EXTENSION', { name: 'fixture-plain', extension: false }],
      ['STARTUP_CODE', { name: 'fixture-startup', files: { 'sitecustomize.py': 'import os\n' } }],
      ['STARTUP_CODE', { name: 'fixture-pth', files: { 'fixture_pth.pth': 'import os\n' } }],
      ['BUNDLE_OVERLAP', { name: 'fixture-shadow', files: { 'packaging/__init__.py': '' } }],
      ['BUNDLE_VERSION_CONFLICT', { name: 'fixture-conflict', requires: ['packaging<24'] }],
    ];
    for (const [code, spec] of refused) {
      const result = await install(await wheel(spec, 'refused'));
      expect([spec.name, result.phase, result.code]).toEqual([spec.name, 'failed', code]);
    }
    const archive = path.join(wheels, 'refused', 'fixture_source-0.1.0.tar.gz');
    await writeFile(archive, 'not a wheel');
    expect(await install(archive)).toMatchObject({ phase: 'failed', code: 'NOT_A_WHEEL' });
    await expectUntouched(before, directories);
    expect(await readdir(path.join(root, 'artifacts'))).toEqual(stored);
  }, 120_000);

  it('refuses what only shows after the installer ran and leaves the current generation untouched', async () => {
    const before = await list();
    const directories = await generations();
    const cases: [string, string, WheelSpec, WheelSpec?][] = [
      [
        'STARTUP_CODE',
        'pth',
        { name: 'fixture-pthuser', requires: ['fixture-pthlib'] },
        { name: 'fixture-pthlib', extension: false, files: { 'fixture_pthlib.pth': 'import os\n' } },
      ],
      [
        'BUNDLE_OVERLAP',
        'shadow',
        { name: 'fixture-shadowuser', requires: ['fixture-shadowlib'] },
        { name: 'fixture-shadowlib', extension: false, files: { 'packaging/__init__.py': '' } },
      ],
      // A marker hides the conflict from the static check; pip, held to the bundle's versions, refuses.
      ['INSTALLER_FAILED', 'marker', { name: 'fixture-marker', requires: ['packaging<24; python_version >= "3.8"'] }],
      ['INSTALLER_FAILED', 'missing', { name: 'fixture-missing', requires: ['fixture-not-in-the-folder'] }],
      ['LOAD_ERROR', 'setup', { name: 'fixture-setupfails', setup: 'raise RuntimeError("setup fails")' }],
      ['LOAD_ERROR', 'import', { name: 'fixture-importfails', prelude: 'import fixture_module_that_does_not_exist' }],
    ];
    const stored = await readdir(path.join(root, 'artifacts'));
    for (const [code, folder, spec, dependency] of cases) {
      if (dependency) await wheel(dependency, folder);
      const result = await install(await wheel(spec, folder), path.join(wheels, folder));
      expect([spec.name, result.phase, result.code]).toEqual([spec.name, 'failed', code]);
      if (code === 'INSTALLER_FAILED') expect(result.output).toBeTruthy();
      await expectUntouched(before, directories);
      expect(await readdir(path.join(root, 'artifacts'))).toEqual(stored);
    }
  }, 300_000);

  it('installs a pack without a manifest as manifest_unbound and refuses one that does not load', async () => {
    // native exits with 3 for such a pack: installed, but its manifest will not bind.
    const legacy = await install(await wheel({ name: 'fixture-legacy', manifest: false }));
    expect(legacy).toMatchObject({ phase: 'switched', action: 'install' });
    const listing = await list();
    expect(listing.extensions.map((extension) => [extension.name, extension.status])).toEqual([
      ['fixture-good', 'load_verified'],
      ['fixture-legacy', 'manifest_unbound'],
    ]);
    const directories = await generations();
    const broken = await install(
      await wheel({ name: 'fixture-legacy-broken', manifest: false, setup: 'raise RuntimeError("setup fails")' })
    );
    expect(broken).toMatchObject({ phase: 'failed', code: 'LOAD_ERROR' });
    await expectUntouched(listing, directories);
    const removed = await finish(await service.request(OWNER, { action: 'remove', name: 'fixture-legacy' }));
    expect(removed.phase).toBe('switched');
    expect(names(await list())).toEqual(['fixture-good']);
  }, 180_000);

  it('installs dependencies from the same folder and keeps scripts and data files across generations', async () => {
    await wheel({ name: 'fixture-lib', extension: false }, 'tool');
    const tool = await wheel(
      {
        name: 'fixture-tool',
        requires: ['fixture-lib>=0.1'],
        prelude: 'import fixture_lib',
        scripts: ['fixture-tool = fixture_tool:main'],
        files: { 'fixture_tool-0.1.0.data/data/share/fixture/info.txt': 'data file\n' },
      },
      'tool'
    );
    const first = await install(tool, path.join(wheels, 'tool'));
    expect(first.phase).toBe('switched');
    const second = await install(await wheel({ name: 'fixture-second' }));
    expect(second.phase).toBe('switched');
    expect(names(await list())).toEqual(['fixture-good', 'fixture-second', 'fixture-tool']);
    const generation = second.generation ?? '';
    const script = generationFile(generation, 'venv', 'bin', 'fixture-tool');
    expect(await readFile(script, 'utf8')).toContain(generationFile(generation, 'venv', 'bin', 'python'));
    expect(await readFile(generationFile(generation, 'venv', 'share', 'fixture', 'info.txt'), 'utf8')).toBe(
      'data file\n'
    );
    const { stdout } = await run(script, [], { env: { ...environment, PYTHONDONTWRITEBYTECODE: '1' } });
    expect(stdout.trim()).toBe('fixture-tool console script ran');
  }, 180_000);

  it('updates from a newer wheel and reports no change for the same one', async () => {
    const newer = await wheel({ name: 'fixture-good', version: '0.2.0' });
    const update = (name: string, file: string): Promise<ExtensionReply> =>
      service.request(OWNER, { action: 'update', name, source: { kind: 'file', path: file } });
    expect(await finish(await update('fixture-good', newer))).toMatchObject({ phase: 'switched', action: 'update' });
    const listing = await list();
    expect(listing.extensions.find((extension) => extension.name === 'fixture-good')?.version).toBe('0.2.0');
    const directories = await generations();
    expect(await finish(await update('fixture-good', newer))).toMatchObject({ phase: 'failed', code: 'NO_CHANGE' });
    expect(await finish(await update('fixture-second', newer))).toMatchObject({
      phase: 'failed',
      code: 'REQUEST_MISMATCH',
    });
    expect(await finish(await update('fixture-absent', newer))).toMatchObject({
      phase: 'failed',
      code: 'NOT_INSTALLED',
    });
    await expectUntouched(listing, directories);
  }, 180_000);

  it('removes an extension and goes back one step on rollback', async () => {
    const before = await list();
    const removed = await finish(await service.request(OWNER, { action: 'remove', name: 'fixture-second' }));
    expect(removed).toMatchObject({ phase: 'switched', action: 'remove' });
    expect(names(await list())).toEqual(['fixture-good', 'fixture-tool']);
    expect(await finish(await service.request(OWNER, { action: 'remove', name: 'fixture-absent' }))).toMatchObject({
      phase: 'failed',
      code: 'NOT_INSTALLED',
    });
    const back = data<ExtensionRollback>(await service.request(OWNER, { action: 'rollback' }));
    expect(back).toEqual({ current: before.current, previous: removed.generation, revision: before.revision + 2 });
    expect(names(await list())).toEqual(['fixture-good', 'fixture-second', 'fixture-tool']);
    const again = data<ExtensionRollback>(await service.request(OWNER, { action: 'rollback' }));
    expect(again.current).toBe(removed.generation);
    expect(names(await list())).toEqual(['fixture-good', 'fixture-tool']);
  }, 180_000);

  it('keeps a generation a running launcher holds and removes it once released', async () => {
    const leased = (await list()).current ?? '';
    const lease = path.join(root, 'leases', `${leased}.${process.pid}`);
    const holder: ChildProcessWithoutNullStreams = spawn(
      path.join(bundle, 'python', 'bin', 'python3'),
      [
        '-I',
        '-S',
        '-B',
        '-c',
        'import fcntl, os, sys\nfd = os.open(sys.argv[1], os.O_RDWR | os.O_CREAT, 0o600)\nfcntl.flock(fd, fcntl.LOCK_EX)\nprint("held", flush=True)\nsys.stdin.read()',
        lease,
      ],
      { env: { PYTHONDONTWRITEBYTECODE: '1' } }
    );
    await new Promise((resolve) => holder.stdout.once('data', resolve));
    // Review finding 5: a second lease on the same generation that cannot even be opened.
    const unreadable = path.join(root, 'leases', `${leased}.unreadable`);
    await writeFile(unreadable, '');
    await chmod(unreadable, 0o000);
    try {
      expect((await install(await wheel({ name: 'fixture-third' }))).phase).toBe('switched');
      expect((await install(await wheel({ name: 'fixture-fourth' }))).phase).toBe('switched');
      const listing = await list();
      expect([listing.current, listing.previous]).not.toContain(leased);
      expect(await generations()).toContain(leased);
    } finally {
      holder.stdin.end();
      await new Promise((resolve) => holder.once('close', resolve));
    }
    // The launcher is gone, but whether the other lease is held cannot be told: the generation stays.
    const kept = await finish(await service.request(OWNER, { action: 'remove', name: 'fixture-fourth' }));
    expect(kept.phase).toBe('switched');
    expect(await generations()).toContain(leased);
    await chmod(unreadable, 0o600);
    const removal = await finish(await service.request(OWNER, { action: 'remove', name: 'fixture-third' }));
    expect(removal.phase).toBe('switched');
    const listing = await list();
    expect((await generations()).toSorted()).toEqual([listing.previous, listing.current].toSorted());
    expect(await readdir(path.join(root, 'leases'))).toEqual([]);
  }, 300_000);

  it('serializes two helper processes worth of changes through the lock', async () => {
    const other = new ExtensionService({ runtime: bundle, root, env: environment });
    const before = await list();
    const [first, second] = await Promise.all([
      install(await wheel({ name: 'fixture-left' })),
      install(await wheel({ name: 'fixture-right' }), undefined, other),
    ]);
    expect([first.phase, second.phase]).toEqual(['switched', 'switched']);
    const listing = await list();
    expect(listing.revision).toBe(before.revision + 2);
    expect(names(listing)).toEqual(expect.arrayContaining(['fixture-left', 'fixture-right']));
  }, 240_000);

  it('falls back to the pointer before the last switch and removes an unfinished candidate', async () => {
    const before = await list();
    const previousPointer = JSON.parse(await readFile(path.join(root, 'current.previous.json'), 'utf8')) as {
      generation: string;
      revision: number;
    };
    await mkdir(generationFile('g99999999-dead', 'venv'), { recursive: true });
    await truncate(path.join(root, 'current.json'), 20);
    const recovered = await list();
    expect(recovered).toMatchObject({ current: previousPointer.generation, revision: previousPointer.revision });
    expect(recovered.current).toBe(before.previous);
    const result = await install(await wheel({ name: 'fixture-after-recovery' }));
    expect(result.phase).toBe('switched');
    expect(await generations()).not.toContain('g99999999-dead');
    expect(await list()).toMatchObject({ current: result.generation, revision: previousPointer.revision + 1 });
  }, 180_000);

  it('cancels a change in progress and leaves the current generation untouched', async () => {
    const before = await list();
    const directories = await generations();
    const slow = await wheel({ name: 'fixture-slow', prelude: 'import time', setup: 'time.sleep(20)' });
    const started = data<ExtensionOperation>(
      await service.request(OWNER, { action: 'install', source: { kind: 'file', path: slow } })
    );
    let state = started;
    while (state.phase !== 'verifying') {
      await new Promise((resolve) => setTimeout(resolve, 100));
      state = data<ExtensionOperation>(
        await service.request(OWNER, { action: 'poll', operationId: started.operationId })
      );
      expect(['checking', 'preparing', 'installing', 'verifying']).toContain(state.phase);
    }
    await service.request(OWNER, { action: 'cancel', operationId: started.operationId });
    expect(await finish({ ok: true, data: state })).toMatchObject({ phase: 'cancelled', code: 'CANCELLED' });
    await expectUntouched(before, directories);
  }, 180_000);

  // Review finding 1: a script named like one of the interpreter links of a venv. The next
  // candidate was built by copying that file onto the link, which ends at the bundled interpreter.
  it('never lets a wheel replace an interpreter name, and never writes through the links of a new environment', async () => {
    const manifest = JSON.parse(await readFile(path.join(bundle, 'manifest.json'), 'utf8')) as { python: string };
    const interpreter = `python${manifest.python.split('.').slice(0, 2).join('.')}`;
    const isolated = new ExtensionService({
      runtime: bundle,
      root: path.join(sandbox, 'interpreter names', 'aelix-runtime'),
      env: environment,
    });
    const script = (name: string): Record<string, string> => ({
      [`${name}-0.1.0.data/scripts/${interpreter}`]: '#!/bin/sh\necho hijacked\n',
    });
    const requested = await install(
      await wheel({ name: 'fixture-interp', files: script('fixture_interp') }, 'interp'),
      undefined,
      isolated
    );
    expect(requested).toMatchObject({ phase: 'failed', code: 'BUNDLE_OVERLAP' });
    // As a dependency the script is only seen after the installer wrote it.
    await wheel({ name: 'fixture-interplib', extension: false, files: script('fixture_interplib') }, 'interp');
    const dependent = await install(
      await wheel({ name: 'fixture-interpuser', requires: ['fixture-interplib'] }, 'interp'),
      path.join(wheels, 'interp'),
      isolated
    );
    expect(dependent).toMatchObject({ phase: 'failed', code: 'GENERATION_MODIFIED' });
    expect(await bundleDifferences(bundle)).toEqual([]);

    // A generation that already holds such a file, as one written before this was checked.
    const base = await install(await wheel({ name: 'fixture-base' }), undefined, isolated);
    expect(base.phase).toBe('switched');
    const venv = path.join(sandbox, 'interpreter names', 'aelix-runtime', 'generations', base.generation ?? '', 'venv');
    await rm(path.join(venv, 'bin', interpreter));
    await writeFile(path.join(venv, 'bin', interpreter), 'not an interpreter');
    const site = path.join(venv, 'lib', interpreter, 'site-packages');
    await writeFile(path.join(site, 'fixture_base-0.1.0.dist-info', 'RECORD'), `../../../bin/${interpreter},,\n`, {
      flag: 'a',
    });
    const next = await install(await wheel({ name: 'fixture-next' }), undefined, isolated);
    expect(next).toMatchObject({ phase: 'failed', code: 'GENERATION_MODIFIED' });
    expect(await bundleDifferences(bundle)).toEqual([]);
    await isolated.dispose();
  }, 240_000);

  // Review finding 2: the installer normalizes member names, so `./x.dist-info/METADATA` overwrites
  // the METADATA that was checked, and a later install follows the direct reference it declares.
  it('refuses a wheel that hides a second METADATA behind another spelling of its path', async () => {
    const isolated = new ExtensionService({
      runtime: bundle,
      root: path.join(sandbox, 'path alias', 'aelix-runtime'),
      env: environment,
    });
    const hidden = await writeWheel(path.join(sandbox, 'elsewhere'), { name: 'fixture-hidden', extension: false });
    const alias = (name: string): [string, string][] => [
      [
        `./${name}-0.1.0.dist-info/METADATA`,
        `Metadata-Version: 2.1\nName: ${name.replace('_', '-')}\nVersion: 0.1.0\nRequires-Dist: fixture-hidden @ ${pathToFileURL(hidden).href}\n`,
      ],
    ];
    const requested = await install(
      await wheel({ name: 'fixture-alias', tail: alias('fixture_alias') }, 'alias'),
      undefined,
      isolated
    );
    expect(requested).toMatchObject({ phase: 'failed', code: 'INVALID_WHEEL' });
    await wheel({ name: 'fixture-aliaslib', extension: false, tail: alias('fixture_aliaslib') }, 'alias');
    for (const name of ['fixture-aliasuser', 'fixture-aliasuser2']) {
      const dependent = await install(
        await wheel({ name, requires: ['fixture-aliaslib'] }, 'alias'),
        path.join(wheels, 'alias'),
        isolated
      );
      expect([name, dependent.phase, dependent.code]).toEqual([name, 'failed', 'INVALID_WHEEL']);
    }
    expect(await list(isolated)).toMatchObject({ current: null, extensions: [] });

    // What counts is the metadata that ended up installed: a generation whose METADATA gained a
    // direct reference after the check is refused before the installer runs in it again.
    const base = await install(await wheel({ name: 'fixture-metabase' }, 'alias-base'), undefined, isolated);
    expect(base.phase).toBe('switched');
    const manifest = JSON.parse(await readFile(path.join(bundle, 'manifest.json'), 'utf8')) as { python: string };
    const generationsOf = path.join(sandbox, 'path alias', 'aelix-runtime', 'generations');
    const site = (generation: string): string =>
      path.join(
        generationsOf,
        generation,
        'venv',
        'lib',
        `python${manifest.python.split('.').slice(0, 2).join('.')}`,
        'site-packages'
      );
    const metadata = path.join(site(base.generation ?? ''), 'fixture_metabase-0.1.0.dist-info', 'METADATA');
    await writeFile(
      metadata,
      `${await readFile(metadata, 'utf8')}Requires-Dist: fixture-hidden @ ${pathToFileURL(hidden).href}\n`
    );
    const next = await install(await wheel({ name: 'fixture-metanext' }, 'alias-base'), undefined, isolated);
    // Refused by the scan of what the candidate inherited, before the installer ever ran in it.
    expect(next).toMatchObject({ phase: 'failed', code: 'DIRECT_REFERENCE' });
    expect(next.output).toBeUndefined();
    for (const generation of await readdir(generationsOf))
      expect((await readdir(site(generation))).filter((entry) => entry.startsWith('fixture_hidden'))).toEqual([]);
    expect(await list(isolated)).toMatchObject({ current: base.generation });
    expect(await bundleDifferences(bundle)).toEqual([]);
    await isolated.dispose();
  }, 240_000);

  // Second review: on a file system that ignores case, pip leaves one file that two
  // distributions record in different cases. Carrying it over must not block every later change.
  it('keeps changing a generation in which two distributions record one file in different cases', async (context) => {
    const probe = path.join(sandbox, 'case probe');
    await writeFile(probe, '');
    const ignoresCase = await readFile(path.join(sandbox, 'CASE PROBE')).then(
      () => true,
      () => false
    );
    if (!ignoresCase) context.skip();
    const isolated = new ExtensionService({
      runtime: bundle,
      root: path.join(sandbox, 'case', 'aelix-runtime'),
      env: environment,
    });
    const upper = await install(
      await wheel({ name: 'fixture-upper', files: { 'casepkg/Mod.py': 'X = 1\n' } }, 'case'),
      undefined,
      isolated
    );
    const lower = await install(
      await wheel({ name: 'fixture-lower', files: { 'casepkg/mod.py': 'X = 2\n' } }, 'case'),
      undefined,
      isolated
    );
    const next = await install(await wheel({ name: 'fixture-casenext' }, 'case'), undefined, isolated);
    const removed = await finish(await isolated.request(OWNER, { action: 'remove', name: 'fixture-lower' }), isolated);
    expect([upper.phase, lower.phase, next.phase, removed.phase]).toEqual([
      'switched',
      'switched',
      'switched',
      'switched',
    ]);
    expect(names(await list(isolated))).toEqual(['fixture-casenext', 'fixture-upper']);
    expect(await bundleDifferences(bundle)).toEqual([]);
    await isolated.dispose();
  }, 300_000);

  // Review findings 3 and 7, at the level of the real lock holder: it is the only writer of
  // shared state, removes only entries of directories that are really the helper's own, and
  // writes nothing once it is gone.
  it('has the lock holder remove only entries of directories that are its own, and nothing once released', async () => {
    const runtime = await resolveBundle(bundle);
    if (!runtime) throw new Error('the bundle copy did not resolve');
    const valuable = path.join(sandbox, 'lock holder', 'valuable');
    await mkdir(path.join(valuable, 'keep'), { recursive: true });
    const layout = await locateLayout(path.join(sandbox, 'lock holder', 'aelix-runtime'));
    await mkdir(layout.leases, { recursive: true });
    await mkdir(layout.artifacts, { recursive: true });
    await symlink(valuable, layout.generations);
    await mkdir(path.join(layout.artifacts, 'stale'));
    await writeFile(path.join(layout.root, 'current.json.0001.tmp'), '{}\n');
    const lock = await acquireMutationLock({
      bundle: runtime,
      layout,
      spawn: spawnChild,
      env: baseEnvironment(environment, process.platform),
      waitMs: 5000,
    });
    const code = (work: Promise<unknown>): Promise<unknown> =>
      work.then(
        () => 'done',
        (error: unknown) => (error as { code?: unknown }).code
      );
    try {
      expect(await code(lock.remove('generations/keep'))).toBe('UNSAFE_ROOT');
      for (const relative of ['..', 'generations/../..', 'other/keep', 'artifacts/a/b', '/etc', 'artifacts/..'])
        expect([relative, await code(lock.remove(relative))]).toEqual([relative, 'UNSAFE_ROOT']);
      expect(await code(lock.replace('current.json.0001.tmp', 'lock'))).toBe('UNSAFE_ROOT');
      expect(await readdir(valuable)).toEqual(['keep']);
      // A link among the entries of the root is removed as a link; what it points at stays.
      expect(await code(lock.remove('generations'))).toBe('done');
      expect(await readdir(valuable)).toEqual(['keep']);
      expect(await code(lock.remove('artifacts/stale'))).toBe('done');
      expect(await readdir(layout.artifacts)).toEqual([]);
      expect(await code(lock.replace('current.json.0001.tmp', 'current.json'))).toBe('done');
      expect(await readFile(layout.pointer, 'utf8')).toBe('{}\n');
    } finally {
      await lock.release();
    }
    await mkdir(path.join(layout.artifacts, 'after'));
    expect(await code(lock.remove('artifacts/after'))).toBe('CONFLICT');
    expect(await readdir(layout.artifacts)).toEqual(['after']);
    // The lock file itself must not be a link: the holder would lock whatever it points at.
    const linked = await locateLayout(path.join(sandbox, 'lock holder', 'linked-lock'));
    await mkdir(linked.root, { recursive: true });
    await symlink(path.join(valuable, 'keep', 'lock'), linked.lock);
    expect(
      await code(
        acquireMutationLock({ bundle: runtime, layout: linked, spawn: spawnChild, env: {}, waitMs: 1000 }).then(
          (held) => held.release()
        )
      )
    ).toBe('UNSAFE_ROOT');
    expect(await readdir(path.join(valuable, 'keep'))).toEqual([]);
  }, 60_000);

  it('wrote nothing outside its root and left the bundle as it was', async () => {
    for (const name of ['target', 'site']) expect(await readdir(path.join(outside, name))).toEqual([]);
    expect((await readdir(outside)).toSorted()).toEqual(['pip.conf', 'site', 'target']);
    expect(await readdir(path.join(sandbox, 'home'))).toEqual([]);
    expect(await bundleDifferences(bundle)).toEqual([]);
  }, 120_000);
});
