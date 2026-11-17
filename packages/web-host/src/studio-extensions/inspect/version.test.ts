import { describe, expect, it } from 'vitest';
import { compareVersions, parseVersion, specifierExcludes } from './version';

const order = (left: string, right: string): number => {
  const [a, b] = [parseVersion(left), parseVersion(right)];
  if (!a || !b) throw new Error('not a version');
  return Math.sign(compareVersions(a, b));
};

describe('PEP 440 versions', () => {
  it('reads every segment and the alternative spellings', () => {
    expect(parseVersion('1!2.3rc1.post2.dev3+Local.1')).toEqual({
      epoch: 1,
      release: [2, 3],
      pre: [2, 1],
      post: 2,
      dev: 3,
      local: 'local.1',
    });
    expect(parseVersion('v1.0-alpha')?.pre).toEqual([0, 0]);
    expect(parseVersion('1.0-1')?.post).toBe(1);
    expect(parseVersion(' 1.0.REV2 ')?.post).toBe(2);
  });

  it('does not read text that is not a version', () => {
    expect(['', 'abc', '1.0.x', '1..0', '1.0+'].map(parseVersion)).toEqual(Array(5).fill(undefined));
  });

  it('orders the release stages the way PEP 440 lists them', () => {
    const ascending = [
      '1.0.dev1',
      '1.0a1',
      '1.0a2.dev1',
      '1.0a2',
      '1.0b1',
      '1.0rc1',
      '1.0',
      '1.0.post1.dev1',
      '1.0.post1',
      '1.1.dev1',
      '1!0.1',
    ];
    for (let index = 1; index < ascending.length; index += 1)
      expect([ascending[index - 1], ascending[index], order(ascending[index - 1], ascending[index])]).toEqual([
        ascending[index - 1],
        ascending[index],
        -1,
      ]);
  });

  it('treats trailing zeros and spelling variants as the same version', () => {
    expect([order('1.0', '1.0.0'), order('1.0rc1', '1.0c1'), order('1.0.post1', '1.0-1')]).toEqual([0, 0, 0]);
  });
});

describe('certain exclusion by a version specifier', () => {
  it.each([
    ['<24', '26.3', true],
    ['>=20', '26.3', false],
    ['>=20,<24', '26.3', true],
    ['==26.3', '26.3.0', false],
    ['==26.*', '26.3', false],
    ['==25.*', '26.3', true],
    ['==1.0.*', '1', false],
    ['!=26.3', '26.3', true],
    ['!=26.*', '26.3', true],
    ['~=26.0', '26.3', false],
    ['~=25.1', '26.3', true],
    ['~=26.4', '26.3', true],
    ['<=26.3', '26.3', false],
    ['>26.3', '26.3', true],
    // The bundle ships a pre-release of native: it is below its own final release.
    ['>=0.1.0', '0.1.0b2', true],
    ['>=0.1.0b1', '0.1.0b2', false],
    ['<0.1.0', '0.1.0b2', true],
    ['<0.2', '0.1.0b2', false],
    ['>1.0', '1.0.post1', true],
    ['>1.0.post0', '1.0.post1', false],
    ['', '26.3', false],
  ])('%j against %s is %s', (specifier, installed, excluded) => {
    expect(specifierExcludes(specifier, installed)).toBe(excluded);
  });

  it('leaves what it cannot decide to the installer', () => {
    expect(specifierExcludes('===1.0', '2.0')).toBe(false);
    expect(specifierExcludes('>=not-a-version', '2.0')).toBe(false);
    expect(specifierExcludes('==1.0+local', '2.0')).toBe(false);
    expect(specifierExcludes('<1.0', '2.0+local')).toBe(false);
    expect(specifierExcludes('<1.0', 'not-a-version')).toBe(false);
    expect(specifierExcludes('~=1', '2.0')).toBe(false);
    expect(specifierExcludes('>=1.*', '0.5')).toBe(false);
  });
});
