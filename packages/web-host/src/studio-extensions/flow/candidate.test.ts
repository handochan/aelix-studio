import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
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
import {
  createCandidate,
  rewriteScriptHeader,
  rewriteWindowsLauncher,
  scanGeneration,
  type Candidate,
} from './candidate';

const [PARENT, CHILD] = ['g00000001-aaaa', 'g00000002-bbbb'];

/** Whether the temporary directory ignores case in names, as macOS and Windows do by default. */
function ignoresCase(): boolean {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'studio-case-'));
  try {
    writeFileSync(path.join(directory, 'probe'), '');
    return existsSync(path.join(directory, 'PROBE'));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
const IGNORES_CASE = ignoresCase();

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

describe('Windows distlib console launchers', () => {
  const from = 'C:\\user data\\g00000001-aaaa\\venv\\Scripts\\python.exe';
  const to = 'C:\\user data\\g00000002-bbbb\\venv\\Scripts\\python.exe';
  const zip = Buffer.concat([Buffer.from([0x50, 0x4b, 3, 4]), Buffer.alloc(26), Buffer.from('__main__.py')]);
  const stub = Buffer.from('MZfixture');
  const launcher = (interpreter: string): Buffer =>
    Buffer.concat([stub, Buffer.from('#!"' + interpreter + '"\r\n'), zip]);

  it('preserves the PE stub and ZIP while pointing the shebang at the new interpreter', () => {
    expect(rewriteWindowsLauncher(launcher(from), from, to)).toEqual(launcher(to));
  });

  it('preserves the namespace prefix when the old shebang uses it', () => {
    expect(rewriteWindowsLauncher(launcher(path.win32.toNamespacedPath(from)), from, to)).toEqual(
      launcher(path.win32.toNamespacedPath(to))
    );
  });

  it('ignores an executable that has no distlib ZIP or belongs to another interpreter', () => {
    expect(rewriteWindowsLauncher(Buffer.from('MZ#!' + from), from, to)).toBeUndefined();
    expect(rewriteWindowsLauncher(launcher(to), from, to)).toBeUndefined();
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
      launch: { packs: false, modules: [] },
    });
    await writeGenerationRecord(helper.context.layout, record);
    return record;
  };
  const problems = async (candidate: Candidate): Promise<string[]> =>
    (await scanGeneration(candidate, facts)).problems.map((problem) => `${problem.code}: ${problem.message}`);

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

  it('does not accept an environment venv reported as made but did not make', async () => {
    const empty = { ...helper.context, spawn: scriptedSpawn((_spec, child) => child.exit(0)) };
    expect((await failure(createCandidate(empty, PARENT, null))).code).toBe('RUNTIME_UNAVAILABLE');
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
    expect(await readFile(path.join(scratch, 'outside.txt'), 'utf8')).toBe('outside');
  });

  it('refuses to build on a parent whose recorded file leaves the generation through a linked directory', async () => {
    const parent = await createCandidate(helper.context, PARENT, null);
    await install(parent, { name: 'demo' });
    const outside = path.join(scratch, 'outside');
    await mkdir(outside);
    await writeFile(path.join(outside, 'secret.txt'), 'outside');
    await symlink(outside, path.join(parent.paths.site, 'demo', 'linked'), 'junction');
    await writeFile(path.join(parent.paths.site, 'demo-0.1.0.dist-info', 'RECORD'), 'demo/linked/secret.txt,,\n', {
      flag: 'a',
    });
    const error = await failure(createCandidate(helper.context, CHILD, await finished(parent)));
    expect([error.code, error.detail]).toEqual([
      'GENERATION_MODIFIED',
      ['demo lists a file that leaves its generation through a link'],
    ]);
  });

  it('copies a file two distributions list only once, and leaves links in the agent directory behind', async () => {
    const parent = await createCandidate(helper.context, PARENT, null);
    await install(parent, { name: 'demo-one', extension: false, files: { 'shared/__init__.py': 'shared' } });
    await install(parent, { name: 'demo-two', extension: false, files: { 'shared/__init__.py': 'shared' } });
    await writeFile(path.join(parent.paths.agent, 'settings.json'), '{}');
    await writeFile(path.join(scratch, 'elsewhere.json'), 'elsewhere');
    await symlink(path.join(scratch, 'elsewhere.json'), path.join(parent.paths.agent, 'auth.json'));
    const child = await createCandidate(helper.context, CHILD, await finished(parent));
    expect(await readFile(path.join(child.paths.site, 'shared', '__init__.py'), 'utf8')).toBe('shared');
    expect(await readdir(child.paths.agent)).toEqual(['settings.json']);
  });

  // Second review: where the file system ignores case (macOS and Windows by default), two
  // distributions can list one file under two spellings. The second spelling then meets the
  // file this carry-over just made, which is not an entry of the new environment.
  it.runIf(IGNORES_CASE)('carries over one file that two distributions list in different cases', async () => {
    const parent = await createCandidate(helper.context, PARENT, null);
    await install(parent, { name: 'demo-upper', extension: false, files: { 'casepkg/Mod.py': 'X = 1\n' } });
    await install(parent, { name: 'demo-lower', extension: false, files: { 'casepkg/mod.py': 'X = 2\n' } });
    const child = await createCandidate(helper.context, CHILD, await finished(parent));
    expect(await readdir(path.join(child.paths.site, 'casepkg'))).toEqual(['mod.py']);
    expect(await readFile(path.join(child.paths.site, 'casepkg', 'Mod.py'), 'utf8')).toBe('X = 2\n');
    expect(await problems(child)).toEqual([]);
  });

  it.skipIf(IGNORES_CASE)('carries over both files when the file system tells the two cases apart', async () => {
    const parent = await createCandidate(helper.context, PARENT, null);
    await install(parent, { name: 'demo-upper', extension: false, files: { 'casepkg/Mod.py': 'X = 1\n' } });
    await install(parent, { name: 'demo-lower', extension: false, files: { 'casepkg/mod.py': 'X = 2\n' } });
    const child = await createCandidate(helper.context, CHILD, await finished(parent));
    expect((await readdir(path.join(child.paths.site, 'casepkg'))).toSorted()).toEqual(['Mod.py', 'mod.py']);
  });

  it.runIf(IGNORES_CASE)(
    'still never writes through an entry of the new environment spelled in another case',
    async () => {
      const parent = await createCandidate(helper.context, PARENT, null);
      await install(parent, { name: 'demo' });
      const entry = path.join(parent.paths.scripts, OTHER_INTERPRETER);
      await rm(entry);
      await writeFile(entry, 'not an interpreter');
      const listed = path
        .relative(parent.paths.site, path.join(parent.paths.scripts, OTHER_INTERPRETER.toUpperCase()))
        .split(path.sep)
        .join('/');
      await writeFile(path.join(parent.paths.site, 'demo-0.1.0.dist-info', 'RECORD'), `${listed},,\n`, { flag: 'a' });
      const interpreter = await readFile(helper.context.bundle.python, 'utf8');
      const error = await createCandidate(helper.context, CHILD, await finished(parent)).then(
        () => undefined,
        (caught: unknown) => caught
      );
      expect(await readFile(helper.context.bundle.python, 'utf8')).toBe(interpreter);
      expect([(error as ExtensionFailure).code, (error as ExtensionFailure).detail]).toEqual([
        'GENERATION_MODIFIED',
        [
          `demo lists ${OTHER_INTERPRETER.toUpperCase()}, which the new environment already has and this change did not copy`,
        ],
      ]);
    }
  );

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
      /^GENERATION_MODIFIED: python(\.exe)? of the environment/,
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

  // Review finding 1. `python -m venv` puts more than one interpreter name next to each other;
  // on POSIX they are links that end at the bundled interpreter.
  const OTHER_INTERPRETER = process.platform === 'win32' ? 'pythonw.exe' : 'python3.12';

  it('finds a replaced entry of the environment that is not the interpreter the helper starts', async () => {
    const candidate = await createCandidate(helper.context, PARENT, null);
    const entry = path.join(candidate.paths.scripts, OTHER_INTERPRETER);
    await rm(entry);
    await writeFile(entry, '#!/bin/sh\necho hijacked\n');
    expect(await problems(candidate)).toEqual([
      expect.stringMatching(/^GENERATION_MODIFIED: .*(python3\.12|pythonw\.exe)/),
    ]);
  });

  it('never writes through an entry of the new environment when it carries files over', async () => {
    const parent = await createCandidate(helper.context, PARENT, null);
    await install(parent, { name: 'demo' });
    // A generation as one written before those entries were protected could look.
    const entry = path.join(parent.paths.scripts, OTHER_INTERPRETER);
    await rm(entry);
    await writeFile(entry, 'not an interpreter');
    const listed = path.relative(parent.paths.site, entry).split(path.sep).join('/');
    await writeFile(path.join(parent.paths.site, 'demo-0.1.0.dist-info', 'RECORD'), `${listed},,\n`, { flag: 'a' });
    const interpreter = await readFile(helper.context.bundle.python, 'utf8');
    const outcome = createCandidate(helper.context, CHILD, await finished(parent));
    const error = await outcome.then(
      () => undefined,
      (caught: unknown) => caught
    );
    // The bundled interpreter first: copying onto the link used to overwrite it.
    expect(await readFile(helper.context.bundle.python, 'utf8')).toBe(interpreter);
    expect(error).toBeInstanceOf(ExtensionFailure);
    expect((error as ExtensionFailure).code).toBe('GENERATION_MODIFIED');
  });

  // Review finding 2: what counts is the metadata that ended up installed.
  it('finds a direct reference in the metadata of an installed distribution', async () => {
    const candidate = await createCandidate(helper.context, PARENT, null);
    await install(candidate, { name: 'demo', extension: false });
    await writeFile(
      path.join(candidate.paths.site, 'demo-0.1.0.dist-info', 'METADATA'),
      'Metadata-Version: 2.1\nName: demo\nVersion: 0.1.0\nRequires-Dist: hidden@git+ssh://example.invalid/hidden.git\n'
    );
    expect(await problems(candidate)).toEqual([
      'DIRECT_REFERENCE: demo requires hidden@git+ssh://example.invalid/hidden.git',
    ]);
  });

  it('never builds into a generation directory that already exists', async () => {
    const candidate = await createCandidate(helper.context, PARENT, null);
    await expect(createCandidate(helper.context, PARENT, null)).rejects.toThrow(/EEXIST/);
    expect(await problems(candidate)).toEqual([]);
  });
});
