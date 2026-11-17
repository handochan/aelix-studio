import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createFakeHelper,
  installWheel,
  scriptedSpawn,
  type FakeHelper,
} from '../../../tests/fixtures/extensionRuntime';
import { writeWheel, type WheelSpec } from '../../../tests/fixtures/extensionWheels';
import type { Child, SpawnSpec } from '../process';
import { readBundleFacts, type BundleFacts } from '../store/layout';
import { newGenerationRecord, writeGenerationRecord, type GenerationRecord } from '../store/pointer';
import { ExtensionFailure } from '../types';
import { createCandidate, discardCandidate, rewriteScriptHeader, scanGeneration, type Candidate } from './candidate';

const [PARENT, CHILD] = ['g00000001-aaaa', 'g00000002-bbbb'];

describe('console script headers', () => {
  const [from, to] = ['/data/Application Support/g1/venv/bin/python', '/data/Application Support/g2/venv/bin/python'];
  const rewrite = (text: string): string | undefined => rewriteScriptHeader(Buffer.from(text), from, to)?.toString();

  it('points the first line at the new interpreter', () => {
    expect(rewrite(`#!${from}\nimport sys\nprint("${from}")\n`)).toBe(`#!${to}\nimport sys\nprint("${from}")\n`);
  });

  it('points the /bin/sh form pip writes for paths with spaces at the new interpreter', () => {
    const script = (python: string): string => `#!/bin/sh\n'''exec' "${python}" "$0" "$@"\n' '''\nimport sys\n`;
    expect(rewrite(script(from))).toBe(script(to));
  });

  it('leaves alone what is not a script for the old interpreter', () => {
    expect(rewrite(`#!/usr/bin/env python3\nprint("${from}")\n`)).toBeUndefined();
    expect(rewrite(`#!/bin/sh\necho "${from}"\n`)).toBeUndefined();
    expect(rewrite(`print("${from}")\n`)).toBeUndefined();
    expect(rewrite(`#!${from}`)).toBeUndefined();
    expect(rewriteScriptHeader(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x0a]), from, to)).toBeUndefined();
  });
});

describe('building and scanning a candidate generation', () => {
  let scratch = '';
  let helper: FakeHelper;
  let facts: BundleFacts;
  beforeEach(async () => {
    scratch = await realpath(await mkdtemp(path.join(os.tmpdir(), 'studio-candidate-')));
    helper = await createFakeHelper(scratch);
    facts = await readBundleFacts(helper.context.bundle);
  });
  afterEach(() => rm(scratch, { recursive: true, force: true }));
  const failure = async (work: Promise<unknown>): Promise<ExtensionFailure> => {
    const error = await work.catch((caught: unknown) => caught);
    if (!(error instanceof ExtensionFailure)) throw new Error(`expected a failure, got ${String(error)}`);
    return error;
  };
  const venvOf = (candidate: Candidate) => ({
    root: candidate.paths.venv,
    site: candidate.paths.site,
    scripts: candidate.paths.scripts,
    python: candidate.paths.python,
  });
  const install = async (candidate: Candidate, spec: WheelSpec): Promise<void> =>
    installWheel(venvOf(candidate), await writeWheel(path.join(scratch, 'wheels'), spec));
  const finished = async (candidate: Candidate): Promise<GenerationRecord> => {
    const record = newGenerationRecord({
      generation: candidate.id,
      parent: null,
      createdAt: '2026-11-17T00:00:00.000Z',
      binding: helper.context.bundle.binding,
      operation: { action: 'install', target: 'demo' },
      distributions: {},
      extensions: {},
    });
    await writeGenerationRecord(helper.context.layout, record);
    return record;
  };
  const problems = async (candidate: Candidate): Promise<string[]> =>
    (await scanGeneration(helper.context, candidate, facts)).problems.map(
      (problem) => `${problem.code}: ${problem.message}`
    );

  it('creates the environment with the bundled interpreter and the allow-listed environment', async () => {
    const candidate = await createCandidate(helper.context, PARENT, null);
    const { command, args, env } = helper.spawn.calls[0];
    expect(command).toBe(helper.context.bundle.python);
    expect(args).toEqual(['-I', '-B', '-m', 'venv', candidate.paths.venv]);
    expect(env).toEqual(helper.context.base);
    expect(env.PIP_TARGET).toBeUndefined();
    expect((await lstat(candidate.paths.agent)).isDirectory()).toBe(true);
    expect(await problems(candidate)).toEqual([]);
  });

  it('fails when the bundled interpreter cannot create the environment', async () => {
    const broken = {
      ...helper.context,
      spawn: scriptedSpawn((_spec, child) => {
        child.complain('Error: no space left on device');
        child.exit(1);
      }),
    };
    const error = await failure(createCandidate(broken, PARENT, null));
    expect([error.code, error.output]).toEqual(['RUNTIME_UNAVAILABLE', 'Error: no space left on device']);
    expect(await readdir(helper.context.layout.generations)).toEqual([]);
  });

  it('does not accept an environment that is not on the bundled interpreter', async () => {
    const real = helper.context.spawn;
    const foreign = {
      ...helper.context,
      spawn: (spec: SpawnSpec): Child => {
        const child = real(spec);
        return {
          onStdout: (listener) => child.onStdout(listener),
          onStderr: (listener) => child.onStderr(listener),
          write: (text) => child.write(text),
          end: () => child.end(),
          kill: (signal) => child.kill(signal),
          exited: child.exited.then(async (exit) => {
            await writeFile(path.join(spec.args.at(-1) ?? '', 'pyvenv.cfg'), 'home = /usr/bin\n');
            return exit;
          }),
        };
      },
    };
    expect((await failure(createCandidate(foreign, PARENT, null))).code).toBe('RUNTIME_UNAVAILABLE');
  });

  it('reports cancellation instead of building on', async () => {
    const controller = new AbortController();
    controller.abort();
    const cancelled = { ...helper.context, signal: controller.signal };
    expect((await failure(createCandidate(cancelled, PARENT, null))).code).toBe('CANCELLED');
  });

  it('carries over what the parent installed, scripts and data files included, but not the installer', async () => {
    const parent = await createCandidate(helper.context, PARENT, null);
    await install(parent, {
      name: 'demo-tool',
      scripts: ['demo-tool = demo_tool:main'],
      files: { 'demo_tool-0.1.0.data/data/share/demo/info.txt': 'data\n' },
    });
    await writeFile(path.join(parent.paths.site, 'demo_tool', 'cached.pyc'), 'bytecode');
    await writeFile(path.join(parent.paths.site, 'demo_tool-0.1.0.dist-info', 'RECORD'), 'demo_tool/cached.pyc,,\n', {
      flag: 'a',
    });
    await writeFile(path.join(parent.paths.site, 'not-recorded.txt'), 'left behind');
    await writeFile(path.join(parent.paths.agent, 'settings.json'), '{"extensionSources":[]}');
    await writeFile(path.join(parent.paths.site, 'pip', '__init__.py'), 'changed in the parent');
    const child = await createCandidate(helper.context, CHILD, await finished(parent));

    expect((await readdir(path.join(child.paths.site, 'demo_tool'))).toSorted()).toEqual([
      '__init__.py',
      'aelix-plugin.toml',
    ]);
    expect(await readFile(path.join(child.paths.venv, 'share', 'demo', 'info.txt'), 'utf8')).toBe('data\n');
    expect(await readFile(path.join(child.paths.agent, 'settings.json'), 'utf8')).toBe('{"extensionSources":[]}');
    expect(await readdir(child.paths.site)).not.toContain('not-recorded.txt');
    expect(await readFile(path.join(child.paths.site, 'pip', '__init__.py'), 'utf8')).toBe('');
    expect(await problems(child)).toEqual([]);
    if (process.platform !== 'win32')
      expect((await readFile(path.join(child.paths.scripts, 'demo-tool'), 'utf8')).split('\n')[0]).toBe(
        `#!${child.paths.python}`
      );
  });

  it('refuses to build on a parent whose records point outside it', async () => {
    const parent = await createCandidate(helper.context, PARENT, null);
    await install(parent, { name: 'demo' });
    const escape = path.relative(parent.paths.site, path.join(scratch, 'outside.txt')).split(path.sep).join('/');
    await writeFile(path.join(scratch, 'outside.txt'), 'outside');
    await writeFile(path.join(parent.paths.site, 'demo-0.1.0.dist-info', 'RECORD'), `${escape},,\n`);
    expect((await failure(createCandidate(helper.context, CHILD, await finished(parent)))).code).toBe(
      'GENERATION_MODIFIED'
    );
    // What was half built is removed; only the parent remains.
    expect(await readdir(helper.context.layout.generations)).toEqual([PARENT]);
  });

  it('refuses to build on a parent whose metadata is damaged', async () => {
    const parent = await createCandidate(helper.context, PARENT, null);
    await install(parent, { name: 'demo' });
    await rm(path.join(parent.paths.site, 'demo-0.1.0.dist-info', 'METADATA'));
    expect((await failure(createCandidate(helper.context, CHILD, await finished(parent)))).detail.join(' ')).toContain(
      'no readable METADATA'
    );
  });

  it.each<[string, (candidate: Candidate) => Promise<void>, RegExp]>([
    ['a .pth file', (c) => writeFile(path.join(c.paths.site, 'demo.pth'), 'import os\n'), /^STARTUP_CODE: demo\.pth/],
    ['a sitecustomize package', (c) => mkdir(path.join(c.paths.site, 'sitecustomize')), /^STARTUP_CODE: sitecustomize/],
    [
      'a usercustomize module',
      (c) => writeFile(path.join(c.paths.site, 'usercustomize.py'), ''),
      /^STARTUP_CODE: usercustomize\.py/,
    ],
    [
      'a replaced pyvenv.cfg',
      (c) => writeFile(c.paths.configuration, 'home = /usr/bin\ninclude-system-site-packages = true\n'),
      /^GENERATION_MODIFIED: pyvenv\.cfg/,
    ],
    [
      'a replaced interpreter',
      async (c) => {
        await unlink(c.paths.python);
        await writeFile(c.paths.python, '#!/bin/sh\n', { mode: 0o755 });
      },
      /^GENERATION_MODIFIED: the interpreter/,
    ],
    [
      'a changed installer',
      (c) => writeFile(path.join(c.paths.site, 'pip-26.0.dist-info', 'RECORD'), 'pip/other.py,,\n'),
      /^GENERATION_MODIFIED: the installer/,
    ],
    [
      'a top-level package the bundle ships',
      (c) => mkdir(path.join(c.paths.site, 'Packaging')),
      /^BUNDLE_OVERLAP: top-level module packaging/,
    ],
  ])('finds %s', async (_what, damage, expected) => {
    const candidate = await createCandidate(helper.context, PARENT, null);
    await damage(candidate);
    expect(await problems(candidate)).toEqual([expect.stringMatching(expected)]);
  });

  it('finds a distribution the bundle ships and one that installs files of the installer', async () => {
    const candidate = await createCandidate(helper.context, PARENT, null);
    await install(candidate, { name: 'packaging', module: 'demo_packaging', extension: false });
    await install(candidate, { name: 'demo-sneaky', extension: false, files: { 'pip/_internal/patch.py': '' } });
    expect((await problems(candidate)).toSorted()).toEqual([
      'BUNDLE_OVERLAP: distribution packaging 0.1.0 is shipped with Studio (26.3)',
      'GENERATION_MODIFIED: demo-sneaky installs files of the installer',
    ]);
  });

  it('never builds into a generation directory that already exists', async () => {
    const candidate = await createCandidate(helper.context, PARENT, null);
    await expect(createCandidate(helper.context, PARENT, null)).rejects.toThrow(/EEXIST/);
    expect(await problems(candidate)).toEqual([]);
  });

  it('removes a discarded candidate completely', async () => {
    const candidate = await createCandidate(helper.context, PARENT, null);
    await discardCandidate(candidate);
    expect(await readdir(helper.context.layout.generations)).toEqual([]);
  });
});
