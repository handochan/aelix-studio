import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createFakeHelper,
  installWheel,
  scriptedSpawn,
  type FakeHelper,
} from '../../../tests/fixtures/extensionRuntime';
import { writeWheel, type WheelSpec } from '../../../tests/fixtures/extensionWheels';
import { createCandidate, type Candidate } from '../flow/candidate';
import { readSite } from '../inspect/site';
import { STATE_ENVIRONMENT } from '../store/layout';
import { newGenerationRecord, newPointer } from '../store/pointer';
import { ExtensionFailure } from '../types';
import {
  chooseForms,
  conversationReference,
  launchArguments,
  launchFormOf,
  loadedNames,
  manifestOf,
  PACKS_DIRECTORY,
  writePacks,
  type ExtensionForm,
} from './form';

describe('the form of each extension, without files', () => {
  it('finds the manifest native binds: the deepest one on the entry module path that the distribution records', () => {
    const recorded = ['demo/__init__.py', 'demo/aelix-plugin.toml', 'demo/sub/aelix-plugin.toml', 'demo/sub/mod.py'];
    expect(manifestOf('demo.sub.mod:setup', recorded)).toBe('demo/sub/aelix-plugin.toml');
    expect(manifestOf('demo.other:setup', recorded)).toBe('demo/aelix-plugin.toml');
    expect(manifestOf('demo', ['demo\\aelix-plugin.toml'])).toBe('demo/aelix-plugin.toml');
    expect(manifestOf('elsewhere:setup', recorded)).toBeUndefined();
    // A manifest at the top of site-packages is no package's.
    expect(manifestOf('demo:setup', ['aelix-plugin.toml'])).toBeUndefined();
  });

  const expected = new Map([
    ['beta', 'beta:setup'],
    ['alpha', 'alpha.pack:setup'],
    ['gamma', 'gamma:setup'],
  ]);
  const forms = new Map<string, ExtensionForm>([
    ['alpha', { form: 'pack', plugin: 'alpha-plugin', directory: 'alpha/pack' }],
    ['beta', { form: 'module' }],
    ['gamma', { form: 'module' }],
  ]);

  it('passes the packs first, as one directory, then every other extension by reference in name order', () => {
    const form = launchFormOf(expected, forms);
    expect(form).toEqual({ packs: true, modules: ['beta:setup', 'gamma:setup'] });
    expect(launchArguments('/state/generations/g00000002-abcd', form)).toEqual([
      path.join('/state/generations/g00000002-abcd', PACKS_DIRECTORY),
      'beta:setup',
      'gamma:setup',
    ]);
    expect(launchArguments('/g', { packs: false, modules: [] })).toEqual([]);
  });

  // Review of the launcher piece, should-fix 2: the adapter takes a bare `demo` for a path when
  // the conversation's directory holds one, and then starts no session at all.
  it('gives a bare module as its setup, which is what native loads for it', () => {
    expect(['demo', 'demo.pack', 'demo:main', 'demo.pack:setup'].map(conversationReference)).toEqual([
      'demo:setup',
      'demo.pack:setup',
      'demo:main',
      'demo.pack:setup',
    ]);
    const bare = new Map([['tools', 'tools']]);
    const module = new Map<string, ExtensionForm>([['tools', { form: 'module' }]]);
    expect(launchFormOf(bare, module)).toEqual({ packs: false, modules: ['tools:setup'] });
    expect([...loadedNames(bare, module)]).toEqual([['tools', 'tools:setup']]);
  });

  it('expects a pack under its plugin id and everything else under its reference', () => {
    expect([...loadedNames(expected, forms)]).toEqual([
      ['beta', 'beta:setup'],
      ['alpha', 'alpha-plugin'],
      ['gamma', 'gamma:setup'],
    ]);
  });
});

describe('choosing forms and writing the links of a candidate', () => {
  let scratch = '';
  let helper: FakeHelper;
  let candidate: Candidate;
  beforeEach(async () => {
    scratch = await realpath(await mkdtemp(path.join(os.tmpdir(), 'studio-form-')));
    helper = await createFakeHelper(scratch);
    candidate = await createCandidate(helper.context, 'g00000001-aaaa', null);
  });
  afterEach(() => rm(scratch, { recursive: true, force: true }));

  const install = async (...specs: WheelSpec[]): Promise<Map<string, string>> => {
    for (const spec of specs)
      await installWheel(
        {
          root: candidate.paths.venv,
          site: candidate.paths.site,
          scripts: candidate.paths.scripts,
          python: candidate.paths.python,
        },
        await writeWheel(path.join(scratch, 'wheels'), spec)
      );
    const snapshot = await readSite(candidate.paths.site);
    return new Map([...snapshot.extensions].map(([name, extension]) => [name, extension.reference]));
  };
  const choose = async (expected: Map<string, string>, unbound: string[] = []) =>
    chooseForms(
      helper.context,
      candidate,
      await readSite(candidate.paths.site),
      expected,
      new Map([...expected.keys()].map((name) => [name, !unbound.includes(name)]))
    );
  const manifest = (id: string, python: string): string =>
    `[plugin]\nid = "${id}"\n[plugin.entry]\npython = "${python}"\n`;

  it('makes a pack of an extension whose manifest names its entry point, and links it under its name', async () => {
    const expected = await install({ name: 'demo-one' }, { name: 'demo-two', manifest: false });
    const forms = await choose(expected);
    expect([...forms]).toEqual([
      ['demo-one', { form: 'pack', plugin: 'demo-one', directory: 'demo_one' }],
      ['demo-two', { form: 'module' }],
    ]);
    // The manifest reader is the bundled interpreter, isolated, reading files only.
    const reader = helper.spawn.calls.at(-1);
    expect(reader?.command).toBe(helper.context.bundle.python);
    expect(reader?.args.slice(0, 6)).toEqual(['-I', '-S', '-B', '-X', 'utf8', '-c']);
    await writePacks(candidate, forms);
    const packs = path.join(candidate.paths.directory, PACKS_DIRECTORY);
    expect(await readdir(packs)).toEqual(['000-demo-one']);
    const link = path.join(packs, '000-demo-one');
    const target = path.join(candidate.paths.site, 'demo_one');
    if (process.platform !== 'win32') expect(await readlink(link)).toBe(path.relative(packs, target));
    expect(await realpath(link)).toBe(await realpath(target));
  });

  it('makes a pack of a bare module entry whose manifest names that module setup', async () => {
    const forms = await choose(await install({ name: 'demo-one', reference: 'demo_one' }));
    expect(forms.get('demo-one')).toEqual({ form: 'pack', plugin: 'demo-one', directory: 'demo_one' });
  });

  it.each<[string, WheelSpec, string[]?]>([
    ['native does not bind its manifest', { name: 'demo-one' }, ['demo-one']],
    [
      'its manifest names another callable',
      {
        name: 'demo-one',
        manifest: false,
        files: { 'demo_one/aelix-plugin.toml': manifest('demo-one', 'demo_one:main') },
      },
    ],
    [
      'its manifest has no plugin id',
      {
        name: 'demo-one',
        manifest: false,
        files: { 'demo_one/aelix-plugin.toml': '[plugin.entry]\npython = "demo_one:setup"\n' },
      },
    ],
  ])('passes an extension by reference when %s', async (_what, spec, unbound) => {
    const forms = await choose(await install(spec), unbound);
    expect(forms.get('demo-one')).toEqual({ form: 'module' });
  });

  it('passes by reference two packs that claim one plugin id', async () => {
    const forms = await choose(
      await install(
        {
          name: 'demo-one',
          manifest: false,
          files: { 'demo_one/aelix-plugin.toml': manifest('shared', 'demo_one:setup') },
        },
        {
          name: 'demo-two',
          manifest: false,
          files: { 'demo_two/aelix-plugin.toml': manifest('shared', 'demo_two:setup') },
        }
      )
    );
    expect([...forms.values()]).toEqual([{ form: 'module' }, { form: 'module' }]);
  });

  it('passes by reference a pack whose package directory is a link', async () => {
    const expected = await install({ name: 'demo-one' });
    await rename(path.join(candidate.paths.site, 'demo_one'), path.join(scratch, 'moved'));
    await symlink(path.join(scratch, 'moved'), path.join(candidate.paths.site, 'demo_one'));
    expect((await choose(expected)).get('demo-one')).toEqual({ form: 'module' });
  });

  it('starts no reader when no extension could be a pack, and writes no links directory', async () => {
    const expected = await install({ name: 'demo-two', manifest: false });
    const before = helper.spawn.calls.length;
    const forms = await choose(expected);
    expect(helper.spawn.calls).toHaveLength(before);
    await writePacks(candidate, forms);
    await expect(readdir(path.join(candidate.paths.directory, PACKS_DIRECTORY))).rejects.toThrow();
  });

  it('fails verification when the manifests cannot be read', async () => {
    const expected = await install({ name: 'demo-one' });
    const broken = { ...helper.context, spawn: scriptedSpawn((_spec, child) => child.exit(1)) };
    const failure = await chooseForms(
      broken,
      candidate,
      await readSite(candidate.paths.site),
      expected,
      new Map([['demo-one', true]])
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ExtensionFailure);
    expect((failure as ExtensionFailure).code).toBe('VERIFICATION_FAILED');
  });

  it('never links outside the candidate', async () => {
    await mkdir(path.join(candidate.paths.site, 'demo_one'));
    await writeFile(
      path.join(candidate.paths.site, 'demo_one', 'aelix-plugin.toml'),
      manifest('demo-one', 'demo_one:setup')
    );
    await writePacks(
      candidate,
      new Map<string, ExtensionForm>([['demo-one', { form: 'pack', plugin: 'demo-one', directory: 'demo_one' }]])
    );
    const link = path.join(candidate.paths.directory, PACKS_DIRECTORY, '000-demo-one');
    expect(await realpath(link)).toBe(path.join(candidate.paths.site, 'demo_one'));
  });
});

// launch.py and the helper meet only through files and these names; a mismatch would load nothing.
describe('the contract with the bundled launcher', () => {
  const launcher = fileURLToPath(new URL('../../../../../scripts/studio-preview/packaging/launch.py', import.meta.url));

  it('reads the state directory, the record and the pointer the helper writes, by the same names', async () => {
    const source = await readFile(launcher, 'utf8');
    const binding = { bundle: '/b', target: 't', pythonMinor: '3.12', dependencyLockSha256: 'l', nativeCommit: 'c' };
    const record = newGenerationRecord({
      generation: 'g00000001-aaaa',
      parent: null,
      createdAt: 'now',
      binding,
      operation: { action: 'install', target: 'demo' },
      distributions: {},
      extensions: {},
      launch: { packs: false, modules: [] },
    });
    expect(source).toContain(`EXTENSION_STATE = '${STATE_ENVIRONMENT}'`);
    expect(source).toContain(`'${record.schema}'`);
    expect(source).toContain(`'${newPointer('g00000001-aaaa', null, 1, binding).schema}'`);
    expect(source).toContain(`directory / '${PACKS_DIRECTORY}'`);
    expect(source).toContain("'native-generation'");
  });
});
