import { describe, expect, it } from 'vitest';
import { parseRequirement } from './requirement';

describe('PEP 508 requirements', () => {
  it('reads a name with version clauses, extras and a marker', () => {
    expect(parseRequirement('Demo_Lib[fast, extra] >=1.0, <2 ; python_version >= "3.11"')).toEqual({
      name: 'demo-lib',
      extras: ['fast', 'extra'],
      specifier: '>=1.0, <2',
      marker: 'python_version >= "3.11"',
    });
  });

  it('reads a bare name and the parenthesized clauses of older metadata', () => {
    expect(parseRequirement('demo')).toEqual({ name: 'demo', extras: [], specifier: '' });
    expect(parseRequirement('demo (>=1.0)')?.specifier).toBe('>=1.0');
  });

  it.each([
    ['demo @ http://127.0.0.1:9/demo.whl', 'http://127.0.0.1:9/demo.whl'],
    // No space anywhere: a search for " @ " let this through and pip ran git clone.
    ['studio32_dep@git+ssh://example.invalid/studio32-dep.git', 'git+ssh://example.invalid/studio32-dep.git'],
    ['demo[extra]@file:///tmp/demo.whl', 'file:///tmp/demo.whl'],
    ['demo\n  @ http://127.0.0.1/x.whl', 'http://127.0.0.1/x.whl'],
    ['demo @ http://127.0.0.1/x;y.whl', 'http://127.0.0.1/x;y.whl'],
  ])('recognizes the direct reference in %j', (text, url) => {
    expect(parseRequirement(text)?.url).toBe(url);
  });

  it('separates the marker of a direct reference at whitespace followed by a semicolon', () => {
    expect(parseRequirement('demo @ http://127.0.0.1/x.whl ; os_name == "nt"')).toMatchObject({
      url: 'http://127.0.0.1/x.whl',
      marker: 'os_name == "nt"',
    });
  });

  it.each([
    '',
    '@ http://127.0.0.1/',
    '-demo',
    'demo @',
    'demo [unclosed',
    'demo [bad extra!]',
    'demo >=',
    'demo >=1.0 <2',
    'demo (>=1.0',
    'demo ;',
    'demo.@x',
  ])('does not accept %j as a requirement', (text) => {
    expect(parseRequirement(text)).toBeUndefined();
  });
});
