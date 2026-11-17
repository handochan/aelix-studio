import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeWheel, type WheelSpec } from '../../../tests/fixtures/extensionWheels';
import type { BundleFacts } from '../store/layout';
import { checkImport } from './importCheck';

const BUNDLE: BundleFacts = {
  distributions: new Map([
    ['packaging', '26.3'],
    ['aelix-coding-agent', '0.1.0b2'],
    ['typing-extensions', '4.15.0'],
  ]),
  topLevel: new Set(['packaging', 'aelix_coding_agent', 'typing_extensions', 'google']),
};

describe('checking an import set before any installer runs', () => {
  let directory = '';
  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'studio-import-'));
  });
  afterEach(() => rm(directory, { recursive: true, force: true }));
  const check = async (target: WheelSpec, ...siblings: WheelSpec[]) => {
    const files = [await writeWheel(directory, target)];
    for (const sibling of siblings) files.push(await writeWheel(directory, sibling));
    return checkImport(files[0], files, BUNDLE);
  };
  const codes = async (target: WheelSpec, ...siblings: WheelSpec[]): Promise<string[]> =>
    (await check(target, ...siblings)).problems.map((problem) => problem.code);

  it('accepts an extension whose requirements fit what Studio ships', async () => {
    const result = await check(
      {
        name: 'demo-pack',
        requires: [
          'demo-lib>=1',
          'packaging>=24',
          'aelix-coding-agent>=0.1.0b1',
          'typing-extensions>=4; python_version < "3.13"',
          'pytest; extra == "test"',
        ],
      },
      { name: 'demo-lib', version: '1.0', extension: false }
    );
    expect(result.problems).toEqual([]);
    expect(result.target?.name).toBe('demo-pack');
    expect(result.wheels.map((wheel) => wheel.name)).toEqual(['demo-pack', 'demo-lib']);
  });

  it.each<[string, WheelSpec]>([
    ['DIRECT_REFERENCE', { name: 'demo', requires: ['dep @ http://127.0.0.1:9/dep.whl'] }],
    ['DIRECT_REFERENCE', { name: 'demo', requires: ['dep@git+ssh://example.invalid/dep.git'] }],
    ['DIRECT_REFERENCE', { name: 'demo', requires: ['dep @ file:///tmp/dep.whl ; extra == "never"'] }],
    ['INVALID_WHEEL', { name: 'demo', requires: ['dep >= '] }],
    ['NOT_AN_EXTENSION', { name: 'demo', extension: false }],
    [
      'INVALID_WHEEL',
      {
        name: 'demo',
        extension: false,
        files: { 'demo-0.1.0.dist-info/entry_points.txt': '[aelix.extensions]\n--yes = demo:setup\n' },
      },
    ],
    [
      'INVALID_WHEEL',
      {
        name: 'demo',
        extension: false,
        files: { 'demo-0.1.0.dist-info/entry_points.txt': '[aelix.extensions]\ndemo = --help\n' },
      },
    ],
    ['STARTUP_CODE', { name: 'demo', files: { 'demo.pth': 'import os\n' } }],
    ['STARTUP_CODE', { name: 'demo', files: { 'sitecustomize.py': '' } }],
    ['STARTUP_CODE', { name: 'demo', files: { 'demo-0.1.0.data/purelib/usercustomize.py': '' } }],
    ['BUNDLE_OVERLAP', { name: 'demo', files: { 'packaging/__init__.py': '' } }],
    ['BUNDLE_OVERLAP', { name: 'demo', files: { 'Packaging/__init__.py': '' } }],
    // Sharing a namespace package with the bundle would add modules to it.
    ['BUNDLE_OVERLAP', { name: 'demo', files: { 'google/demo/__init__.py': '' } }],
    ['BUNDLE_OVERLAP', { name: 'demo', files: { 'pip/__init__.py': '' } }],
    ['BUNDLE_VERSION_CONFLICT', { name: 'demo', requires: ['packaging<24'] }],
    ['BUNDLE_VERSION_CONFLICT', { name: 'demo', requires: ['Aelix_Coding_Agent>=0.1.0'] }],
  ])('refuses the requested wheel with %s for %j', async (code, spec) => {
    expect(await codes(spec)).toContain(code);
  });

  it('refuses a wheel that replaces a distribution Studio ships', async () => {
    expect(await codes({ name: 'packaging', module: 'demo_packaging' })).toEqual(['BUNDLE_OVERLAP']);
    expect(await codes({ name: 'pip', module: 'demo_pip' })).toEqual(['BUNDLE_OVERLAP']);
  });

  it('refuses the whole set for a direct reference in any wheel of it', async () => {
    const result = await check(
      { name: 'demo', requires: ['demo-lib'] },
      { name: 'demo-lib', extension: false, requires: ['hidden@git+ssh://example.invalid/hidden.git'] }
    );
    expect(result.problems).toEqual([
      {
        code: 'DIRECT_REFERENCE',
        message:
          'demo_lib-0.1.0-py3-none-any.whl: direct-reference dependency hidden@git+ssh://example.invalid/hidden.git',
      },
    ]);
  });

  it('refuses the set when any wheel of it hides a second METADATA behind another spelling of its path', async () => {
    const result = await check(
      { name: 'demo', requires: ['demo-lib'] },
      {
        name: 'demo-lib',
        extension: false,
        tail: [
          [
            './demo_lib-0.1.0.dist-info/METADATA',
            'Name: demo-lib\nVersion: 0.1.0\nRequires-Dist: x @ http://127.0.0.1/x.whl\n',
          ],
        ],
      }
    );
    expect(result.problems.map((problem) => problem.code)).toEqual(['INVALID_WHEEL']);
  });

  it('refuses the set when a wheel of it cannot be read', async () => {
    const target = await writeWheel(directory, { name: 'demo' });
    const broken = path.join(directory, 'broken-1.0-py3-none-any.whl');
    await writeFile(broken, 'not an archive');
    expect((await checkImport(target, [target, broken], BUNDLE)).problems.map((problem) => problem.code)).toEqual([
      'INVALID_WHEEL',
    ]);
  });

  it('leaves what a dependency wheel would install to the scan after the installer', async () => {
    // Whether a sibling gets installed is the installer's decision, so its content is not judged here.
    const result = await check(
      { name: 'demo', requires: ['demo-lib'] },
      {
        name: 'demo-lib',
        extension: false,
        requires: ['packaging<24'],
        files: { 'demo_lib.pth': '', 'packaging/x.py': '' },
      }
    );
    expect(result.problems).toEqual([]);
  });

  it('does not judge a conditional requirement; the installer does, under the bundle constraints', async () => {
    expect(await codes({ name: 'demo', requires: ['packaging<24; python_version >= "3.8"'] })).toEqual([]);
  });

  it('reports a requested wheel that is not part of the set', async () => {
    const other = await writeWheel(directory, { name: 'other' });
    const result = await checkImport(path.join(directory, 'demo-1.0-py3-none-any.whl'), [other], BUNDLE);
    expect(result.problems.map((problem) => problem.code)).toEqual(['NOT_A_WHEEL']);
    expect(result.target).toBeUndefined();
  });
});
