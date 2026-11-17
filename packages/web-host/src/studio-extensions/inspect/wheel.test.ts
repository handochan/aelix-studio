import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildWheel, writeWheel, zip } from '../../../tests/fixtures/extensionWheels';
import { isStartupEntry, readWheel, topLevelName, WheelError } from './wheel';

describe('reading a wheel without running anything in it', () => {
  let directory = '';
  beforeAll(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'studio-wheel-'));
  });
  afterAll(() => rm(directory, { recursive: true, force: true }));
  const raw = async (name: string, data: Buffer | string): Promise<string> => {
    const file = path.join(directory, name);
    await writeFile(file, data);
    return file;
  };

  it('reads identity, requirements, extension entries and top-level names', async () => {
    const file = await writeWheel(directory, {
      name: 'Demo.Pack',
      version: '1.2.0',
      requires: ['demo-lib>=1', 'other @ http://127.0.0.1/x.whl'],
      files: { 'helper.py': '', 'Demo_Pack.libs/x.so': '' },
    });
    expect(await readWheel(file)).toMatchObject({
      filename: 'Demo_Pack-1.2.0-py3-none-any.whl',
      name: 'demo-pack',
      version: '1.2.0',
      requires: ['demo-lib>=1', 'other @ http://127.0.0.1/x.whl'],
      topLevel: ['demo_pack', 'helper'],
      startupFiles: [],
    });
    expect([...(await readWheel(file)).extensions]).toEqual([['Demo.Pack', 'Demo_Pack:setup']]);
  });

  it('reads a deflated wheel the same way', async () => {
    const file = await writeWheel(directory, { name: 'demo-deflated', requires: ['x>=1'], deflate: true });
    expect(await readWheel(file)).toMatchObject({ name: 'demo-deflated', requires: ['x>=1'] });
  });

  it('finds startup files wherever the wheel would put them into site-packages', async () => {
    const file = await writeWheel(directory, {
      name: 'demo-startup',
      files: {
        'demo_startup.pth': 'import os\n',
        'demo_startup-0.1.0.data/purelib/sitecustomize.py': '',
        'demo_startup-0.1.0.data/data/lib/python3.12/site-packages/usercustomize/__init__.py': '',
        'demo_startup-0.1.0.data/data/share/readme.pth': 'not in site-packages',
        'demo_startup-0.1.0.data/scripts/tool': '#!python\n',
      },
    });
    const facts = await readWheel(file);
    expect(facts.startupFiles).toEqual([
      'demo_startup-0.1.0.data/data/lib/python3.12/site-packages/usercustomize/__init__.py',
      'demo_startup-0.1.0.data/purelib/sitecustomize.py',
      'demo_startup.pth',
    ]);
    expect(facts.topLevel).toEqual(['demo_startup', 'sitecustomize', 'usercustomize']);
  });

  it('names top-level entries by what Python would import, in lower case', () => {
    expect(['Packaging', 'six.py', '_cffi.cpython-312-darwin.so'].map(topLevelName)).toEqual([
      'packaging',
      'six',
      '_cffi',
    ]);
    expect(['x.pth', 'X.PTH', 'sitecustomize.py', 'usercustomize', 'sitecustom.py'].map(isStartupEntry)).toEqual([
      true,
      true,
      true,
      true,
      false,
    ]);
  });

  it.each<[string, () => Promise<string>, RegExp]>([
    ['a file that is not an archive', () => raw('plain-1.0-py3-none-any.whl', 'not a zip archive at all'), /not a zip/],
    ['an empty file', () => raw('empty-1.0-py3-none-any.whl', ''), /not a zip/],
    ['a source archive name', () => raw('demo-1.0.tar.gz', 'x'), /file name/],
    ['a wheel name without tags', () => raw('demo-1.0.whl', zip([])), /file name/],
    [
      'a wheel without METADATA',
      () => raw('nometa-1.0-py3-none-any.whl', zip([['nometa/__init__.py', '']])),
      /METADATA/,
    ],
    [
      'a wheel with two dist-info directories',
      () =>
        raw(
          'twice-1.0-py3-none-any.whl',
          zip([
            ['twice-1.0.dist-info/METADATA', 'Name: twice\nVersion: 1.0\n'],
            ['other-1.0.dist-info/METADATA', 'Name: other\nVersion: 1.0\n'],
          ])
        ),
      /exactly one/,
    ],
    [
      'METADATA without a version',
      () => raw('nover-1.0-py3-none-any.whl', zip([['nover-1.0.dist-info/METADATA', 'Name: nover\n']])),
      /Name or Version/,
    ],
    [
      'a file name that names another distribution',
      async () => raw('other-0.1.0-py3-none-any.whl', buildWheel({ name: 'demo-real' }).data),
      /does not match/,
    ],
    [
      'a file name that names another version',
      async () => raw('demo_real-9.9-py3-none-any.whl', buildWheel({ name: 'demo-real' }).data),
      /does not match/,
    ],
    [
      'two members of the same name',
      () =>
        raw(
          'dup-1.0-py3-none-any.whl',
          zip([
            ['dup-1.0.dist-info/METADATA', 'Name: dup\nVersion: 1.0\n'],
            ['dup-1.0.dist-info/entry_points.txt', ''],
            ['dup-1.0.dist-info/entry_points.txt', '[aelix.extensions]\ndup = dup:setup\n'],
          ])
        ),
      /same name/,
    ],
    [
      'a truncated archive',
      async () => raw('cut-0.1.0-py3-none-any.whl', buildWheel({ name: 'cut' }).data.subarray(40)),
      /out of range|damaged|truncated/,
    ],
    [
      'a zip64 archive',
      async () => {
        const data = Buffer.from(buildWheel({ name: 'big' }).data);
        data.writeUInt32LE(0xffffffff, data.length - 22 + 16);
        return raw('big-0.1.0-py3-none-any.whl', data);
      },
      /zip64/,
    ],
    ['a missing file', async () => path.join(directory, 'absent-1.0-py3-none-any.whl'), /cannot be opened/],
  ])('refuses %s', async (_what, make, reason) => {
    const failure = await readWheel(await make()).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(WheelError);
    expect((failure as WheelError).message).toMatch(reason);
  });

  it('accepts a file name whose version is spelled differently but is the same version', async () => {
    const file = await raw('demo_real-0.1-py3-none-any.whl', buildWheel({ name: 'demo-real' }).data);
    expect((await readWheel(file)).version).toBe('0.1.0');
  });
});
