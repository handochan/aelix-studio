import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFakeHelper, scriptedSpawn, type FakeHelper } from '../../../tests/fixtures/extensionRuntime';
import type { SiteSnapshot } from '../inspect/site';
import { createCandidate } from './candidate';
import { checkLoaded, compareRequest, nativeHandle, resolveDistribution, runLoadCheck } from './gate';

type Installed = [name: string, version: string, extensions?: Record<string, string>, record?: string];

/** A snapshot holding the given distributions; `record` stands for the RECORD hash. */
const site = (...installed: Installed[]): SiteSnapshot => {
  const snapshot: SiteSnapshot = {
    distributions: new Map([
      [
        'pip',
        {
          name: 'pip',
          declaredName: 'pip',
          version: '26.0',
          requires: [],
          recordSha256: 'pip',
          info: 'pip',
          files: [],
        },
      ],
    ]),
    extensions: new Map(),
    topLevel: new Set(),
    startup: [],
    problems: [],
  };
  for (const [name, version, extensions = {}, record = `${name}-${version}`] of installed) {
    snapshot.distributions.set(name, {
      name,
      declaredName: name,
      version,
      requires: [],
      recordSha256: record,
      info: `${name}.dist-info`,
      files: [],
    });
    for (const [entry, reference] of Object.entries(extensions))
      snapshot.extensions.set(entry, { reference, distribution: name });
  }
  return snapshot;
};
const ALPHA: Installed = ['alpha-ext', '1.0', { alpha: 'alpha:setup' }];
const BETA: Installed = ['beta-ext', '1.0', { beta: 'beta:setup', 'beta-two': 'beta.two:setup' }];
const LIB: Installed = ['lib', '2.0'];

describe('finding the distribution a name refers to', () => {
  const snapshot = site(ALPHA, BETA, LIB);
  // Review finding 4: three extensions whose names differ only in the separator.
  const alike = site(
    ['dot-pack', '1.0', { 'sample.one': 'dot:setup' }],
    ['hyphen-pack', '1.0', { 'sample-one': 'hyphen:setup' }],
    ['underscore-pack', '1.0', { sample_one: 'underscore:setup' }]
  );

  it('takes an exact entry name, then a name native would read as the same, then a distribution name', () => {
    expect(resolveDistribution(snapshot, 'beta-two')).toEqual({ distribution: 'beta-ext' });
    expect(resolveDistribution(snapshot, 'Beta_Two')).toEqual({ distribution: 'beta-ext' });
    expect(resolveDistribution(snapshot, 'Alpha_Ext')).toEqual({ distribution: 'alpha-ext' });
  });

  it('finds nothing for a library, the installer or an unknown name', () => {
    expect(['lib', 'pip', 'absent'].map((name) => resolveDistribution(snapshot, name))).toEqual(
      Array(3).fill(undefined)
    );
  });

  it('does not read a dot as a hyphen: native does not either', () => {
    expect(resolveDistribution(alike, 'sample.one')).toEqual({ distribution: 'dot-pack' });
    expect(resolveDistribution(site(ALPHA), 'alpha.ext')).toBeUndefined();
  });

  it('prefers the exact name over one that only looks alike', () => {
    expect(resolveDistribution(alike, 'sample-one')).toEqual({ distribution: 'hyphen-pack' });
    expect(resolveDistribution(alike, 'sample_one')).toEqual({ distribution: 'underscore-pack' });
  });

  it('calls a name ambiguous when native would read it as more than one extension', () => {
    expect(resolveDistribution(alike, 'Sample-One')).toEqual({ ambiguous: ['sample-one', 'sample_one'] });
  });

  it('hands native an entry name only this distribution has', () => {
    expect(nativeHandle(snapshot, 'beta-ext')).toBe('beta');
    expect(nativeHandle(alike, 'dot-pack')).toBe('sample.one');
  });

  it('hands native the distribution name when every entry name could mean another extension', () => {
    expect(nativeHandle(alike, 'hyphen-pack')).toBe('hyphen-pack');
  });

  it('has no name to hand over when the distribution name is also an entry of another extension', () => {
    const tangled = site(
      ['first', '1.0', { shared_name: 'first:setup' }],
      ['second', '1.0', { 'shared-name': 'second:setup', other: 'second:other' }],
      ['third', '1.0', { Other: 'third:setup', first: 'third:first' }]
    );
    // `first`: its entry reads like one of `second`, and its own name is an entry of `third`.
    expect(nativeHandle(tangled, 'first')).toBeUndefined();
    expect(nativeHandle(tangled, 'second')).toBe('second');
    expect(nativeHandle(tangled, 'third')).toBe('first');
  });

  it('skips an entry name native would read as an option', () => {
    expect(nativeHandle(site(['odd-pack', '1.0', { '--yes': 'odd:setup' }]), 'odd-pack')).toBe('odd-pack');
  });
});

describe('comparing a request with its result', () => {
  const install = (distribution: string, version = '1.0') => ({ action: 'install' as const, distribution, version });

  it('accepts an install that added the requested extension and kept the others', () => {
    const result = compareRequest(install('beta-ext'), site(ALPHA), site(ALPHA, BETA, LIB));
    expect(result.problems).toEqual([]);
    expect(result.changed).toBe(true);
    expect([...result.expected].toSorted()).toEqual([
      ['alpha', 'alpha:setup'],
      ['beta', 'beta:setup'],
      ['beta-two', 'beta.two:setup'],
    ]);
  });

  it('accepts an update and takes the new entry points from the result', () => {
    const newer: Installed = ['alpha-ext', '2.0', { alpha: 'alpha.v2:setup' }];
    const result = compareRequest(
      { action: 'update', distribution: 'alpha-ext', version: '2.0' },
      site(ALPHA, BETA),
      site(newer, BETA)
    );
    expect(result.problems).toEqual([]);
    expect(result.expected.get('alpha')).toBe('alpha.v2:setup');
  });

  it('reports no change when the installer left every distribution as it was', () => {
    const result = compareRequest(
      { action: 'update', distribution: 'alpha-ext', version: '1.0' },
      site(ALPHA, LIB),
      site(ALPHA, LIB)
    );
    expect(result).toMatchObject({ changed: false, problems: [] });
  });

  it.each<[string, SiteSnapshot, SiteSnapshot, RegExp]>([
    ['was not installed', site(ALPHA), site(ALPHA, LIB), /beta-ext is not in the candidate/],
    ['has another version', site(ALPHA), site(ALPHA, ['beta-ext', '9.9', { beta: 'beta:setup' }]), /beta-ext is 9\.9/],
    // The installer exits 0 for a wheel without an entry point; without this an empty check passed.
    [
      'provides no extension',
      site(ALPHA),
      site(ALPHA, ['beta-ext', '1.0']),
      /provides no aelix\.extensions entry point/,
    ],
    ['made another distribution disappear', site(ALPHA, LIB), site(ALPHA, BETA), /distribution lib disappeared/],
    [
      'took an extension from an untouched distribution',
      site(ALPHA),
      site(['alpha-ext', '1.0', {}], BETA),
      /extension alpha is missing/,
    ],
    [
      'took an extension from a distribution it rewrote on the way',
      site(ALPHA),
      site(['alpha-ext', '2.0', {}], BETA),
      /extension alpha was lost/,
    ],
    [
      'added an extension to an untouched distribution',
      site(ALPHA),
      site(['alpha-ext', '1.0', { alpha: 'alpha:setup', extra: 'alpha:extra' }], BETA),
      /unexpected extension extra/,
    ],
    [
      'has an entry point whose reference cannot be passed to native',
      site(ALPHA),
      site(ALPHA, ['beta-ext', '1.0', { beta: '--trust-extension-path' }]),
      /extension beta has no usable name or object reference/,
    ],
    [
      'has an entry point whose name would be read as an option',
      site(ALPHA),
      site(ALPHA, ['beta-ext', '1.0', { '--yes': 'beta:setup' }]),
      /extension --yes has no usable name or object reference/,
    ],
  ])('refuses an install whose result %s', (_what, before, after, problem) => {
    expect(compareRequest(install('beta-ext'), before, after).problems.join('\n')).toMatch(problem);
  });

  it('refuses a result whose metadata cannot be trusted', () => {
    const after = site(ALPHA, BETA);
    after.problems.push('distribution beta-ext is recorded twice');
    expect(compareRequest(install('beta-ext'), site(ALPHA), after).problems).toContain(
      'distribution beta-ext is recorded twice'
    );
  });

  it('accepts a removal and expects exactly the extensions of the remaining distributions', () => {
    const result = compareRequest(
      { action: 'remove', distribution: 'beta-ext' },
      site(ALPHA, BETA, LIB),
      site(ALPHA, LIB)
    );
    expect(result.problems).toEqual([]);
    expect([...result.expected]).toEqual([['alpha', 'alpha:setup']]);
  });

  it('expects the empty set only after the last extension was removed', () => {
    const result = compareRequest({ action: 'remove', distribution: 'alpha-ext' }, site(ALPHA, LIB), site(LIB));
    expect([result.problems, result.expected.size, result.changed]).toEqual([[], 0, true]);
  });

  it.each<[string, SiteSnapshot, RegExp]>([
    ['left the distribution installed', site(ALPHA, BETA, LIB), /beta-ext is still installed/],
    ['removed another distribution too', site(ALPHA), /distribution lib disappeared/],
    ['changed another distribution', site(ALPHA, ['lib', '2.1']), /distribution lib was added or changed/],
    [
      'rewrote another distribution of the same version',
      site(ALPHA, ['lib', '2.0', {}, 'rewritten']),
      /distribution lib was added or changed/,
    ],
    ['dropped an extension that should remain', site(['alpha-ext', '1.0', {}], LIB), /extension alpha is missing/],
  ])('refuses a removal that %s', (_what, after, problem) => {
    const result = compareRequest({ action: 'remove', distribution: 'beta-ext' }, site(ALPHA, BETA, LIB), after);
    expect(result.problems.join('\n')).toMatch(problem);
  });
});

describe('reading what native loaded', () => {
  const expected = new Map([
    ['alpha', 'alpha:setup'],
    ['beta', 'beta:setup'],
  ]);
  const reply = (extensions: string[], errors: [string, string][] = []) => ({
    success: true,
    data: {
      extensions: [{ name: 'GuardrailExtension' }, ...extensions.map((name) => ({ name }))],
      extensionErrors: errors.map(([source, message]) => ({ source, message })),
    },
  });

  it('passes when every expected extension loaded without an error', () => {
    expect(checkLoaded(expected, reply(['alpha:setup', 'beta:setup']))).toEqual([]);
    expect(checkLoaded(new Map(), reply([]))).toEqual([]);
  });

  it('reports a load error once, with the message native gave', () => {
    expect(checkLoaded(expected, reply(['alpha:setup'], [['beta:setup', "No module named 'gone'"]]))).toEqual([
      "load error beta:setup: No module named 'gone'",
    ]);
  });

  it('reports an expected extension that is neither loaded nor in error', () => {
    expect(checkLoaded(expected, reply(['alpha:setup']))).toEqual(['beta (beta:setup) is not in the loaded list']);
  });

  it('fails when native gave no usable answer', () => {
    const none = ['native did not answer resources/list'];
    expect(checkLoaded(expected, undefined)).toEqual(none);
    expect(checkLoaded(expected, { success: false })).toEqual(none);
    expect(checkLoaded(expected, { success: true })).toEqual(none);
  });
});

describe('the load check', () => {
  let scratch = '';
  let helper: FakeHelper;
  beforeEach(async () => {
    scratch = await realpath(await mkdtemp(path.join(os.tmpdir(), 'studio-gate-')));
    helper = await createFakeHelper(scratch);
  });
  afterEach(() => rm(scratch, { recursive: true, force: true }));
  const expected = new Map([
    ['alpha', 'alpha:setup'],
    ['beta', 'beta.pack:setup'],
  ]);

  it('starts native the way a conversation does, with the generation appended and each extension named', async () => {
    const candidate = await createCandidate(helper.context, 'g00000001-aaaa', null);
    const result = await runLoadCheck(helper.context, candidate, expected);
    expect(result).toEqual({ problems: [], answered: true, cancelled: false, timedOut: false });
    const { command, args, env, cwd } = helper.spawn.calls.at(-1) ?? { command: '', args: [], env: {}, cwd: '' };
    expect(command).toBe(helper.context.bundle.python);
    expect(args.slice(0, 6)).toEqual(['-I', '-S', '-B', '-X', 'utf8', '-c']);
    expect(args.slice(7)).toEqual([
      helper.context.bundle.launcher,
      candidate.paths.site,
      'native',
      '--offline',
      '--mode',
      'rpc',
      '--no-session',
      '--no-extensions',
      '-e',
      'alpha:setup',
      '-e',
      'beta.pack:setup',
    ]);
    expect(env).toEqual({ ...helper.context.base, AELIX_CODING_AGENT_DIR: candidate.paths.agent });
    expect(cwd).toBe(candidate.paths.directory);
    const request = JSON.parse(helper.spawn.children.at(-1)?.written[0] ?? '{}') as Record<string, unknown>;
    expect(request).toMatchObject({ type: 'aelix_control', method: 'resources/list' });
    expect(helper.spawn.children.at(-1)?.ended).toBe(true);
  });

  it('reports the extension whose import or setup failed', async () => {
    helper.runtime.loadErrors = { 'beta.pack:setup': 'setup() of beta fails' };
    const candidate = await createCandidate(helper.context, 'g00000001-aaaa', null);
    expect((await runLoadCheck(helper.context, candidate, expected)).problems).toEqual([
      'load error beta.pack:setup: setup() of beta fails',
    ]);
  });

  it('says so when native ends without answering', async () => {
    const candidate = await createCandidate(helper.context, 'g00000001-aaaa', null);
    const silent = { ...helper.context, spawn: scriptedSpawn((_spec, child) => child.exit(1)) };
    expect(await runLoadCheck(silent, candidate, expected)).toMatchObject({ answered: false, timedOut: false });
  });

  it('gives up on a native that never answers', async () => {
    const candidate = await createCandidate(helper.context, 'g00000001-aaaa', null);
    const hanging = {
      ...helper.context,
      spawn: scriptedSpawn(() => {}),
      timeouts: { ...helper.context.timeouts, verifyMs: 20 },
    };
    expect(await runLoadCheck(hanging, candidate, expected)).toMatchObject({ answered: false, timedOut: true });
  });
});
