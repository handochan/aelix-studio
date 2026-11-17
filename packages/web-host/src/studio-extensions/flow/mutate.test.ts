import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createFakeHelper,
  directWriter,
  installWheel,
  scriptedSpawn,
  type FakeHelper,
} from '../../../tests/fixtures/extensionRuntime';
import { writeWheel, type WheelSpec } from '../../../tests/fixtures/extensionWheels';
import { generationPaths, resolveBundle } from '../store/layout';
import { newPointer, readGenerationRecord, readPointer, switchPointer } from '../store/pointer';
import { ExtensionFailure, type ExtensionSource } from '../types';
import { describe as describeInstalled, mutate, rollback, type MutationHooks } from './mutate';

describe('changing what is installed', () => {
  let scratch = '';
  let helper: FakeHelper;
  let phases: string[] = [];
  let made = 0;
  const hooks: MutationHooks = {
    progress: (phase) => phases.push(phase),
    suffix: () => String((made += 1)).padStart(4, '0'),
    now: () => new Date('2026-11-17T00:00:00.000Z'),
  };
  beforeEach(async () => {
    scratch = await realpath(await mkdtemp(path.join(os.tmpdir(), 'studio-mutate-')));
    helper = await createFakeHelper(scratch);
    phases = [];
    made = 0;
  });
  afterEach(() => rm(scratch, { recursive: true, force: true }));

  const source = async (spec: WheelSpec, folder = 'wheels'): Promise<ExtensionSource> => ({
    kind: 'file',
    path: await writeWheel(path.join(scratch, folder), spec),
  });
  const install = async (spec: WheelSpec) =>
    mutate(helper.context, { action: 'install', source: await source(spec) }, hooks);
  const failure = async (work: Promise<unknown>): Promise<ExtensionFailure> => {
    const error = await work.catch((caught: unknown) => caught);
    if (!(error instanceof ExtensionFailure)) throw new Error(`expected a failure, got ${String(error)}`);
    return error;
  };
  const generations = async (): Promise<string[]> => (await readdir(helper.context.layout.generations)).toSorted();
  const current = async () => (await readPointer(helper.context.layout)).pointer;
  const extensionNames = async (): Promise<string[]> =>
    (await describeInstalled(helper.context)).extensions.map((extension) => extension.name);
  /** What another process holding the lock would do to the state directory. */
  const elsewhere = () => directWriter(helper.context.layout.root);
  /** The lock holder of the change that is running. */
  const holder = () => helper.spawn.children[helper.spawn.calls.findLastIndex((call) => call.args.includes('hold'))];
  /** A failed change must leave no candidate behind and the pointer where it was. */
  const expectUntouched = async (pointer: Awaited<ReturnType<typeof current>>, directories: string[]) => {
    expect(await current()).toEqual(pointer);
    expect(await generations()).toEqual(directories);
  };

  describe('install', () => {
    it('goes through every phase and makes the new generation current', async () => {
      const outcome = await install({ name: 'demo-one' });
      expect(outcome).toEqual({ generation: 'g00000001-0001', revision: 1 });
      expect(phases).toEqual(['checking', 'preparing', 'installing', 'verifying']);
      expect(await current()).toMatchObject({ generation: 'g00000001-0001', previous: null, revision: 1 });
    });

    it('installs from the stored copy, offline, in the candidate environment', async () => {
      const request = await source({ name: 'demo-one' });
      await mutate(helper.context, { action: 'install', source: request }, hooks);
      const [set] = await readdir(helper.context.layout.artifacts);
      const stored = path.join(helper.context.layout.artifacts, set, path.basename(request.path));
      expect(helper.nativeRuns()).toEqual([
        ['--offline', 'extension', 'install', stored, '--yes'],
        ['extension', 'verify'],
      ]);
      const installer = helper.spawn.calls.find((call) => call.args.includes('install'));
      const candidate = path.join(helper.context.layout.generations, 'g00000001-0001');
      expect(installer?.command).toBe(
        path.join(candidate, 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
      );
      expect(installer?.args.slice(0, 6)).toEqual(['-I', '-B', '-X', 'utf8', helper.context.bundle.launcher, 'native']);
      expect(installer?.env).toMatchObject({
        AELIX_CODING_AGENT_DIR: path.join(candidate, 'agent'),
        PYTHONPATH: helper.context.bundle.nativeSite,
        PIP_NO_INDEX: '1',
        PIP_FIND_LINKS: pathToFileURL(path.join(helper.context.layout.artifacts, set)).href,
      });
      expect(installer?.env.PIP_CONSTRAINT).toMatch(/^file:\/\/.*Application%20Support.*constraints-/);
      expect(installer?.env.PIP_TARGET).toBeUndefined();
    });

    it('records what the generation holds and where each distribution came from', async () => {
      await writeWheel(path.join(scratch, 'set'), { name: 'demo-lib', extension: false });
      const request = await source({ name: 'demo-one' }, 'set');
      helper.runtime.install = async (venv, wheel) => {
        await installWheel(venv, wheel);
        await installWheel(venv, path.join(path.dirname(wheel), 'demo_lib-0.1.0-py3-none-any.whl'));
        return 0;
      };
      await mutate(
        helper.context,
        { action: 'install', source: { ...request, folder: path.join(scratch, 'set') } },
        hooks
      );
      const record = await readGenerationRecord(helper.context.layout, 'g00000001-0001');
      const [set] = await readdir(helper.context.layout.artifacts);
      expect(record).toMatchObject({
        parent: null,
        createdAt: '2026-11-17T00:00:00.000Z',
        binding: helper.context.bundle.binding,
        operation: { action: 'install', target: 'demo-one' },
        extensions: { 'demo-one': { reference: 'demo_one:setup', distribution: 'demo-one', manifestBound: true } },
      });
      expect(Object.keys(record?.distributions ?? {}).toSorted()).toEqual(['demo-lib', 'demo-one']);
      expect(record?.distributions['demo-lib'].origin).toMatchObject({
        kind: 'file',
        artifact: set,
        wheel: 'demo_lib-0.1.0-py3-none-any.whl',
      });
      expect((await readdir(path.join(helper.context.layout.artifacts, set))).toSorted()).toEqual([
        'demo_lib-0.1.0-py3-none-any.whl',
        'demo_one-0.1.0-py3-none-any.whl',
        'sha256.json',
      ]);
    });

    it('refuses an import set before a candidate exists and stores nothing', async () => {
      const error = await failure(install({ name: 'demo-plain', extension: false }));
      expect([error.code, error.detail]).toEqual([
        'NOT_AN_EXTENSION',
        ['demo_plain-0.1.0-py3-none-any.whl: provides no aelix.extensions entry point'],
      ]);
      expect(helper.spawn.calls.some((call) => call.args.includes('venv'))).toBe(false);
      expect(await readdir(helper.context.layout.artifacts)).toEqual([]);
      await expectUntouched(null, []);
    });

    it.each([
      [1, 'INSTALLER_FAILED'],
      [2, 'INSTALLER_NOT_RUN'],
      [70, 'INSTALLER_FAILED'],
    ])('discards the candidate when native exits with %i and reports %s with its output', async (exit, code) => {
      await install({ name: 'demo-one' });
      const [pointer, directories] = [await current(), await generations()];
      helper.runtime.install = () => Promise.resolve(exit);
      helper.runtime.nativeOutput = 'ERROR: ResolutionImpossible\n';
      const error = await failure(install({ name: 'demo-two' }));
      expect([error.code, error.output]).toEqual([code, 'ERROR: ResolutionImpossible\n']);
      await expectUntouched(pointer, directories);
    });

    it('never starts the candidate again once the installer left startup code in it', async () => {
      helper.runtime.install = async (venv, wheel) => {
        await installWheel(venv, wheel);
        await writeFile(path.join(venv.site, 'demo.pth'), 'import os\n');
        return 0;
      };
      const error = await failure(install({ name: 'demo-one' }));
      expect(error.code).toBe('STARTUP_CODE');
      expect(helper.nativeRuns().map((run) => run.filter((arg) => arg !== '--offline')[1])).toEqual(['install']);
      expect(helper.spawn.calls.some((call) => call.args.includes('--no-extensions'))).toBe(false);
      await expectUntouched(null, []);
    });

    it('refuses a candidate in which the installer shadowed a library of the bundle', async () => {
      helper.runtime.install = async (venv, wheel) => {
        await installWheel(venv, wheel);
        await mkdir(path.join(venv.site, 'packaging'));
        return 0;
      };
      expect((await failure(install({ name: 'demo-one' }))).code).toBe('BUNDLE_OVERLAP');
    });

    // Review finding 1.
    it('refuses a change in which the installer replaced an entry of the environment, and leaves the bundle alone', async () => {
      const name = process.platform === 'win32' ? 'pythonw.exe' : 'python3.12';
      const interpreter = await readFile(helper.context.bundle.python, 'utf8');
      const library = await writeWheel(path.join(scratch, 'interp'), {
        name: 'demo-interplib',
        extension: false,
        files: { [`demo_interplib-0.1.0.data/scripts/${name}`]: '#!/bin/sh\necho hijacked\n' },
      });
      helper.runtime.install = async (venv, wheel) => {
        await installWheel(venv, wheel);
        await installWheel(venv, library);
        return 0;
      };
      const request = await source({ name: 'demo-one', requires: ['demo-interplib'] }, 'interp');
      const error = await failure(
        mutate(
          helper.context,
          { action: 'install', source: { ...request, folder: path.join(scratch, 'interp') } },
          hooks
        )
      );
      expect(error.code).toBe('GENERATION_MODIFIED');
      expect(await readFile(helper.context.bundle.python, 'utf8')).toBe(interpreter);
      await expectUntouched(null, []);
    });

    it('refuses the requested wheel before any installer when it ships a script named like the interpreter', async () => {
      const error = await failure(
        install({ name: 'demo-interp', files: { 'demo_interp-0.1.0.data/scripts/python3.12': '#!/bin/sh\n' } })
      );
      expect(error.code).toBe('BUNDLE_OVERLAP');
      expect(helper.spawn.calls.some((call) => call.args.includes('venv'))).toBe(false);
    });

    // Review finding 2.
    it('refuses a candidate in which an installed distribution declares a direct reference', async () => {
      helper.runtime.install = async (venv, wheel) => {
        await installWheel(venv, wheel);
        await writeFile(
          path.join(venv.site, 'demo_one-0.1.0.dist-info', 'METADATA'),
          'Metadata-Version: 2.1\nName: demo-one\nVersion: 0.1.0\nRequires-Dist: hidden @ file:///elsewhere/hidden.whl\n'
        );
        return 0;
      };
      const error = await failure(install({ name: 'demo-one' }));
      expect([error.code, error.detail]).toEqual([
        'DIRECT_REFERENCE',
        ['demo-one requires hidden @ file:///elsewhere/hidden.whl'],
      ]);
      expect(helper.nativeRuns()).toHaveLength(1);
      await expectUntouched(null, []);
    });

    // Review finding 3.
    it('refuses to work in a state directory whose generations directory leads somewhere else', async () => {
      const outside = path.join(scratch, 'valuable');
      await mkdir(path.join(outside, 'keep'), { recursive: true });
      await rm(helper.context.layout.generations, { recursive: true });
      await symlink(outside, helper.context.layout.generations, 'junction');
      expect((await failure(install({ name: 'demo-one' }))).code).toBe('UNSAFE_ROOT');
      expect((await failure(rollback(helper.context))).code).toBe('UNSAFE_ROOT');
      expect((await failure(describeInstalled(helper.context))).code).toBe('UNSAFE_ROOT');
      expect(await readdir(outside)).toEqual(['keep']);
    });

    it('reports no change when the installer exits 0 without installing anything', async () => {
      await install({ name: 'demo-one' });
      const [pointer, directories] = [await current(), await generations()];
      helper.runtime.install = () => Promise.resolve(0);
      expect((await failure(install({ name: 'demo-one' }))).code).toBe('NO_CHANGE');
      await expectUntouched(pointer, directories);
    });

    it('refuses a result that is not what was asked for', async () => {
      const other = await writeWheel(path.join(scratch, 'other'), { name: 'demo-other' });
      helper.runtime.install = async (venv) => {
        await installWheel(venv, other);
        return 0;
      };
      const error = await failure(install({ name: 'demo-one' }));
      expect([error.code, error.detail]).toEqual([
        'REQUEST_MISMATCH',
        expect.arrayContaining(['the requested distribution demo-one is not in the candidate']),
      ]);
      await expectUntouched(null, []);
    });

    it('refuses an extension that does not load and keeps the current generation', async () => {
      await install({ name: 'demo-one' });
      const [pointer, directories] = [await current(), await generations()];
      helper.runtime.loadErrors = { 'demo_two:setup': 'setup() of demo-two fails' };
      const stored = await readdir(helper.context.layout.artifacts);
      const error = await failure(install({ name: 'demo-two' }));
      expect([error.code, error.detail]).toEqual([
        'LOAD_ERROR',
        ['load error demo_two:setup: setup() of demo-two fails'],
      ]);
      await expectUntouched(pointer, directories);
      // The wheels of the refused import do not stay in the store.
      expect(await readdir(helper.context.layout.artifacts)).toEqual(stored);
    });

    it('loads every extension of the candidate, not only the new one', async () => {
      await install({ name: 'demo-one' });
      await install({ name: 'demo-two' });
      const load = helper.spawn.calls.findLast((call) => call.args.includes('--no-extensions'));
      expect(load?.args.slice(load.args.indexOf('--no-extensions') + 1)).toEqual([
        '-e',
        'demo_one:setup',
        '-e',
        'demo_two:setup',
      ]);
    });

    it('fails verification when native does not answer the load check', async () => {
      helper.runtime.beforeLoad = (child) => {
        child.exit(1);
        return false;
      };
      expect((await failure(install({ name: 'demo-one' }))).code).toBe('VERIFICATION_FAILED');
      await expectUntouched(null, []);
    });

    it('records an unbound manifest for the list instead of failing the install', async () => {
      await install({ name: 'demo-one' });
      helper.runtime.unbound = ['demo-two'];
      await install({ name: 'demo-two' });
      const record = await readGenerationRecord(helper.context.layout, 'g00000002-0002');
      expect([record?.extensions['demo-one'].manifestBound, record?.extensions['demo-two'].manifestBound]).toEqual([
        true,
        false,
      ]);
      expect(helper.nativeRuns().slice(-3)).toEqual([
        ['extension', 'verify'],
        ['extension', 'verify', 'demo-one'],
        ['extension', 'verify', 'demo-two'],
      ]);
    });

    describe('a pack whose manifest does not bind', () => {
      /** native installs such a pack and exits with 3. */
      const installerSaysNotBound = (): void => {
        helper.runtime.install = async (venv, wheel) => {
          await installWheel(venv, wheel);
          return 3;
        };
      };
      const statuses = async (): Promise<[string, string][]> =>
        (await describeInstalled(helper.context)).extensions.map((extension) => [extension.name, extension.status]);

      it('is installed and listed as manifest_unbound next to a ready one', async () => {
        await install({ name: 'demo-one' });
        installerSaysNotBound();
        helper.runtime.unbound = ['demo-legacy'];
        const outcome = await install({ name: 'demo-legacy', manifest: false });
        expect(outcome).toEqual({ generation: 'g00000002-0002', revision: 2 });
        expect(await statuses()).toEqual([
          ['demo-legacy', 'manifest_unbound'],
          ['demo-one', 'load_verified'],
        ]);
      });

      it('is listed as manifest_unbound on the word of the installer, even when verify does not repeat it', async () => {
        await install({ name: 'demo-one' });
        installerSaysNotBound();
        await install({ name: 'demo-legacy', manifest: false });
        expect(await statuses()).toEqual([
          ['demo-legacy', 'manifest_unbound'],
          ['demo-one', 'load_verified'],
        ]);
      });

      it('is refused like any other pack when it does not load', async () => {
        await install({ name: 'demo-one' });
        const [pointer, directories] = [await current(), await generations()];
        installerSaysNotBound();
        helper.runtime.unbound = ['demo-legacy'];
        helper.runtime.loadErrors = { 'demo_legacy:setup': 'setup() of demo-legacy fails' };
        const error = await failure(install({ name: 'demo-legacy', manifest: false }));
        expect([error.code, error.detail]).toEqual([
          'LOAD_ERROR',
          ['load error demo_legacy:setup: setup() of demo-legacy fails'],
        ]);
        await expectUntouched(pointer, directories);
      });

      it('is scanned like any other pack before its candidate is started again', async () => {
        helper.runtime.install = async (venv, wheel) => {
          await installWheel(venv, wheel);
          await writeFile(path.join(venv.site, 'demo.pth'), 'import os\n');
          return 3;
        };
        expect((await failure(install({ name: 'demo-legacy', manifest: false }))).code).toBe('STARTUP_CODE');
        expect(helper.nativeRuns()).toHaveLength(1);
        await expectUntouched(null, []);
      });

      it('is still compared with the request: exit code 3 without the pack is not an install', async () => {
        helper.runtime.install = () => Promise.resolve(3);
        expect((await failure(install({ name: 'demo-legacy', manifest: false }))).code).toBe('NO_CHANGE');
      });

      it('is not what exit code 3 means for a removal, where native hands through the code of pip', async () => {
        await install({ name: 'demo-one' });
        const [pointer, directories] = [await current(), await generations()];
        helper.runtime.remove = () => Promise.resolve(3);
        const error = await failure(mutate(helper.context, { action: 'remove', name: 'demo-one' }, hooks));
        expect(error.code).toBe('INSTALLER_FAILED');
        await expectUntouched(pointer, directories);
      });
    });

    it('does not switch when the pointer moved while the candidate was prepared', async () => {
      await install({ name: 'demo-one' });
      const base = await current();
      if (!base) throw new Error('no pointer');
      const moved = newPointer(base.generation, null, 7, base.binding);
      helper.runtime.beforeLoad = () => switchPointer(helper.context.layout, moved, base, elsewhere());
      expect((await failure(install({ name: 'demo-two' }))).code).toBe('CONFLICT');
      await expectUntouched(moved, [base.generation]);
    });

    // Review finding 7: shared state is written by the lock holder, so nothing of it changes
    // once the holder is gone, and what was running under the lock is stopped at once.
    it('does not switch when the lock was lost on the way, and removes nothing without it', async () => {
      await install({ name: 'demo-one' });
      const pointer = await current();
      helper.runtime.beforeLoad = () => holder().exit(null, 'SIGKILL');
      expect((await failure(install({ name: 'demo-two' }))).code).toBe('CONFLICT');
      expect(await current()).toEqual(pointer);
      // The candidate cannot be removed without the lock; the next change, under its own lock, removes it.
      expect(await generations()).toEqual(['g00000001-0001', 'g00000002-0002']);
      helper.runtime.beforeLoad = undefined;
      await install({ name: 'demo-three' });
      expect(await generations()).toEqual(['g00000001-0001', 'g00000002-0003']);
    });

    it('stops the installer the moment the lock is lost', async () => {
      helper.runtime.install = () => {
        holder().exit(null, 'SIGKILL');
        return new Promise<number>(() => {});
      };
      expect((await failure(install({ name: 'demo-one' }))).code).toBe('CONFLICT');
      const installer = helper.spawn.children[helper.spawn.calls.findIndex((call) => call.args.includes('install'))];
      expect(installer.signals).toEqual(['SIGTERM']);
      expect(await current()).toBeNull();
    });

    it('does not move the pointer when the lock holder is gone at the moment of the switch', async () => {
      await install({ name: 'demo-one' });
      const pointer = await current();
      const real = helper.context.spawn;
      // The holder of this change dies on the first request to rename a pointer file.
      helper.context.spawn = (spec) => {
        const child = real(spec);
        if (!spec.args.includes('hold')) return child;
        return {
          ...child,
          onStdout: (listener) => child.onStdout(listener),
          onStderr: (listener) => child.onStderr(listener),
          end: () => child.end(),
          kill: (signal) => child.kill(signal),
          exited: child.exited,
          write: (text) => (text.includes('"replace"') ? holder().exit(null, 'SIGKILL') : child.write(text)),
        };
      };
      expect((await failure(install({ name: 'demo-two' }))).code).toBe('CONFLICT');
      expect(await current()).toEqual(pointer);
      expect(JSON.parse(await readFile(helper.context.layout.pointer, 'utf8'))).toMatchObject({ revision: 1 });
    });

    it('removes what was built when the candidate cannot be created', async () => {
      await install({ name: 'demo-one' });
      const [pointer, directories] = [await current(), await generations()];
      const real = helper.context.spawn;
      // venv writes part of an environment, then fails.
      const failing = scriptedSpawn((spec, child) => {
        void mkdir(path.join(spec.args.at(-1) ?? '', 'bin'), { recursive: true }).then(() => child.exit(1));
      });
      helper.context.spawn = (spec) => (spec.args.includes('venv') ? failing(spec) : real(spec));
      expect((await failure(install({ name: 'demo-two' }))).code).toBe('RUNTIME_UNAVAILABLE');
      await expectUntouched(pointer, directories);
    });

    it('stops and discards the candidate when cancelled during the installer', async () => {
      const controller = new AbortController();
      helper.context.signal = controller.signal;
      helper.runtime.install = () => {
        controller.abort();
        return new Promise<number>(() => {});
      };
      expect((await failure(install({ name: 'demo-one' }))).code).toBe('CANCELLED');
      await expectUntouched(null, []);
      expect(helper.spawn.children[0].ended).toBe(true);
    });

    it('gives up with BUSY when another process holds the lock', async () => {
      helper.runtime.lock = (child) => {
        child.print('busy\n');
        child.exit(3);
      };
      expect((await failure(install({ name: 'demo-one' }))).code).toBe('BUSY');
      expect(helper.spawn.calls).toHaveLength(1);
    });

    it('removes a candidate an interrupted change left behind, even when the new change is refused', async () => {
      await mkdir(path.join(helper.context.layout.generations, 'g00000009-dead', 'venv'), { recursive: true });
      expect((await failure(install({ name: 'demo-plain', extension: false }))).code).toBe('NOT_AN_EXTENSION');
      expect(await generations()).toEqual([]);
    });

    it('does not run the installer in a candidate whose inherited content fails the scan', async () => {
      await install({ name: 'demo-one' });
      const [pointer, directories] = [await current(), await generations()];
      const { site } = generationPaths(helper.context.layout, 'g00000001-0001', '3.12', helper.context.platform);
      // The current generation was changed behind the helper's back: a recorded startup file.
      await writeFile(path.join(site, 'demo.pth'), 'import os\n');
      await writeFile(path.join(site, 'demo_one-0.1.0.dist-info', 'RECORD'), 'demo.pth,,\n', { flag: 'a' });
      const runs = helper.nativeRuns().length;
      expect((await failure(install({ name: 'demo-two' }))).code).toBe('STARTUP_CODE');
      expect(helper.nativeRuns()).toHaveLength(runs);
      await expectUntouched(pointer, directories);
    });

    it('builds on the current generation and keeps only it and the previous one', async () => {
      await install({ name: 'demo-one' });
      await install({ name: 'demo-two' });
      await install({ name: 'demo-three' });
      expect(await extensionNames()).toEqual(['demo-one', 'demo-three', 'demo-two']);
      expect(await generations()).toEqual(['g00000002-0002', 'g00000003-0003']);
      expect(await current()).toMatchObject({ generation: 'g00000003-0003', previous: 'g00000002-0002', revision: 3 });
    });

    it('keeps an older generation while a running launcher holds it', async () => {
      await install({ name: 'demo-one' });
      await writeFile(path.join(helper.context.layout.leases, 'g00000001-0001.4711'), '');
      helper.runtime.heldLeases = ['g00000001-0001.4711'];
      await install({ name: 'demo-two' });
      await install({ name: 'demo-three' });
      expect(await generations()).toEqual(['g00000001-0001', 'g00000002-0002', 'g00000003-0003']);
    });
  });

  describe('update', () => {
    const update = async (name: string, spec: WheelSpec) =>
      mutate(helper.context, { action: 'update', name, source: await source(spec, 'newer') }, hooks);

    it('replaces the installed distribution with the wheel it was given', async () => {
      await install({ name: 'demo-one' });
      expect(await update('demo-one', { name: 'demo-one', version: '0.2.0' })).toMatchObject({ revision: 2 });
      const listing = await describeInstalled(helper.context);
      expect(listing.extensions).toEqual([
        expect.objectContaining({
          name: 'demo-one',
          version: '0.2.0',
          origin: expect.objectContaining({ wheel: 'demo_one-0.2.0-py3-none-any.whl' }),
        }),
      ]);
      expect((await readGenerationRecord(helper.context.layout, 'g00000002-0002'))?.operation).toEqual({
        action: 'update',
        target: 'demo-one',
      });
    });

    it('refuses a wheel of another distribution before a candidate exists', async () => {
      await install({ name: 'demo-one' });
      const [pointer, directories] = [await current(), await generations()];
      const before = helper.spawn.calls.length;
      const error = await failure(update('demo-one', { name: 'demo-two' }));
      expect(error.code).toBe('REQUEST_MISMATCH');
      expect(helper.spawn.calls.slice(before).some((call) => call.args.includes('venv'))).toBe(false);
      await expectUntouched(pointer, directories);
    });

    it('refuses to update what is not installed', async () => {
      expect((await failure(update('demo-one', { name: 'demo-one' }))).code).toBe('NOT_INSTALLED');
    });
  });

  describe('remove', () => {
    const remove = (name: string) => mutate(helper.context, { action: 'remove', name }, hooks);

    it('removes by entry name through native and expects the others to stay', async () => {
      await install({ name: 'demo-one' });
      await install({ name: 'demo-two' });
      await remove('Demo_One');
      expect(helper.nativeRuns().findLast((run) => run.includes('remove'))).toEqual([
        'extension',
        'remove',
        'demo-one',
        '--yes',
      ]);
      const removal = helper.spawn.calls.findLast((call) => call.args.includes('remove'));
      expect([removal?.env.PIP_NO_INDEX, removal?.env.PIP_FIND_LINKS]).toEqual([undefined, undefined]);
      expect(await extensionNames()).toEqual(['demo-two']);
      expect((await readGenerationRecord(helper.context.layout, 'g00000003-0003'))?.operation).toEqual({
        action: 'remove',
        target: 'Demo_One',
      });
    });

    // Review finding 4: native does not read a dot as a hyphen, so these are two extensions.
    it('removes the extension that was named, not one whose name only looks alike', async () => {
      await install({ name: 'alpha-pack', entry: 'sample.one' });
      await install({ name: 'beta-pack', entry: 'sample-one' });
      await remove('sample-one');
      expect(await extensionNames()).toEqual(['sample.one']);
      expect(helper.nativeRuns().findLast((run) => run.includes('remove'))).toEqual([
        'extension',
        'remove',
        'sample-one',
        '--yes',
      ]);
    });

    it('refuses a name that fits more than one extension the way native compares names', async () => {
      await install({ name: 'alpha-pack', entry: 'sample_one' });
      await install({ name: 'beta-pack', entry: 'sample-one' });
      const [pointer, directories] = [await current(), await generations()];
      expect((await failure(remove('Sample-One'))).code).toBe('AMBIGUOUS_NAME');
      await expectUntouched(pointer, directories);
    });

    it('hands native a name it cannot confuse when the exact name is not one', async () => {
      await install({ name: 'alpha-pack', entry: 'sample_one' });
      await install({ name: 'beta-pack', entry: 'sample-one' });
      await remove('sample-one');
      expect(await extensionNames()).toEqual(['sample_one']);
      expect(helper.nativeRuns().findLast((run) => run.includes('remove'))).toEqual([
        'extension',
        'remove',
        'beta-pack',
        '--yes',
      ]);
    });

    // Review finding 11: `extension remove` hands through pip's exit code, so 2 is not "did not run".
    it.each([1, 2, 3])('reports exit code %i of a removal as a plain failure', async (exit) => {
      await install({ name: 'demo-one' });
      const [pointer, directories] = [await current(), await generations()];
      helper.runtime.remove = () => Promise.resolve(exit);
      expect((await failure(remove('demo-one'))).code).toBe('INSTALLER_FAILED');
      await expectUntouched(pointer, directories);
    });

    it('leaves a generation without extensions when the last one is removed', async () => {
      await install({ name: 'demo-one' });
      await remove('demo-one');
      expect(await describeInstalled(helper.context)).toMatchObject({
        current: 'g00000002-0002',
        previous: 'g00000001-0001',
        extensions: [],
        rollbackAvailable: true,
      });
      const load = helper.spawn.calls.findLast((call) => call.args.includes('--no-extensions'));
      expect(load?.args.at(-1)).toBe('--no-extensions');
    });

    it('refuses to remove what is not installed, without a candidate', async () => {
      await install({ name: 'demo-one' });
      const [pointer, directories] = [await current(), await generations()];
      expect((await failure(remove('demo-absent'))).code).toBe('NOT_INSTALLED');
      await expectUntouched(pointer, directories);
    });

    it('refuses a removal that native reports as done but that left the distribution in place', async () => {
      await install({ name: 'demo-one' });
      await install({ name: 'demo-two' });
      const [pointer, directories] = [await current(), await generations()];
      helper.runtime.remove = async (venv) => {
        await rm(path.join(venv.site, 'demo_two-0.1.0.dist-info'), { recursive: true });
        return 0;
      };
      const error = await failure(remove('demo-one'));
      expect(error.code).toBe('REQUEST_MISMATCH');
      expect(error.detail).toEqual(
        expect.arrayContaining(['demo-one is still installed', 'distribution demo-two disappeared'])
      );
      await expectUntouched(pointer, directories);
    });
  });

  describe('rollback and listing', () => {
    it('lists nothing before the first install and creates nothing by listing', async () => {
      expect(await describeInstalled(helper.context)).toEqual({
        current: null,
        previous: null,
        revision: 0,
        appliesAt: 'new_session',
        rollbackAvailable: false,
        extensions: [],
      });
    });

    it('goes back one step and forward again', async () => {
      await install({ name: 'demo-one' });
      await install({ name: 'demo-two' });
      expect(await rollback(helper.context)).toEqual({
        current: 'g00000001-0001',
        previous: 'g00000002-0002',
        revision: 3,
      });
      expect(await extensionNames()).toEqual(['demo-one']);
      expect(await rollback(helper.context)).toEqual({
        current: 'g00000002-0002',
        previous: 'g00000001-0001',
        revision: 4,
      });
      expect(await extensionNames()).toEqual(['demo-one', 'demo-two']);
      expect(await generations()).toEqual(['g00000001-0001', 'g00000002-0002']);
    });

    it('has nothing to go back to before a second generation exists', async () => {
      expect((await failure(rollback(helper.context))).code).toBe('NOTHING_TO_ROLL_BACK');
      await install({ name: 'demo-one' });
      expect((await failure(rollback(helper.context))).code).toBe('NOTHING_TO_ROLL_BACK');
      expect((await describeInstalled(helper.context)).rollbackAvailable).toBe(false);
    });

    it('acts on the pointer as it is once the lock is held, not as it was before', async () => {
      await install({ name: 'demo-one' });
      await install({ name: 'demo-two' });
      await install({ name: 'demo-three' });
      const base = await current();
      if (!base) throw new Error('no pointer');
      // Another process rolls back while this one waits for the lock.
      helper.runtime.lock = (child) => {
        void switchPointer(
          helper.context.layout,
          newPointer('g00000002-0002', 'g00000003-0003', 4, base.binding),
          base,
          elsewhere()
        ).then(() => {
          child.onEnd = () => child.exit(0);
          child.print('held\n');
        });
      };
      expect(await rollback(helper.context)).toEqual({
        current: 'g00000003-0003',
        previous: 'g00000002-0002',
        revision: 5,
      });
    });

    it('marks extensions for reinstall and refuses changes when the bundle is another one', async () => {
      await install({ name: 'demo-one' });
      await install({ name: 'demo-two' });
      const manifest = path.join(helper.context.bundle.root, 'manifest.json');
      await writeFile(manifest, (await readFile(manifest, 'utf8')).replace('a'.repeat(64), 'b'.repeat(64)));
      const updated = await resolveBundle(helper.context.bundle.root);
      if (!updated) throw new Error('the changed bundle did not resolve');
      helper.context.bundle = updated;
      const listing = await describeInstalled(helper.context);
      expect(listing.extensions.map((extension) => extension.status)).toEqual(['reinstall_needed', 'reinstall_needed']);
      expect(listing.rollbackAvailable).toBe(false);
      const [pointer, directories] = [await current(), await generations()];
      expect((await failure(install({ name: 'demo-three' }))).code).toBe('BUNDLE_CHANGED');
      expect((await failure(rollback(helper.context))).code).toBe('BUNDLE_CHANGED');
      await expectUntouched(pointer, directories);
    });

    it('lists the binding verdict and the origin of each extension', async () => {
      helper.runtime.unbound = ['demo-one'];
      await install({ name: 'demo-one' });
      expect((await describeInstalled(helper.context)).extensions).toEqual([
        {
          name: 'demo-one',
          distribution: 'demo-one',
          version: '0.1.0',
          reference: 'demo_one:setup',
          origin: expect.objectContaining({ kind: 'file', wheel: 'demo_one-0.1.0-py3-none-any.whl' }),
          status: 'manifest_unbound',
        },
      ]);
    });
  });
});
