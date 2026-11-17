import { describe, expect, it } from 'vitest';
import {
  canonicalName,
  isEntryName,
  isObjectReference,
  nativeName,
  parseExtensionEntries,
  parseHeaders,
  parseRecordPaths,
  parseScriptNames,
  readIdentity,
} from './metadata';

describe('distribution names', () => {
  it('treats case and runs of separators as the same name', () => {
    expect(['Fixture_Good', 'fixture.good', 'FIXTURE--good', ' fixture-good '].map(canonicalName)).toEqual(
      Array(4).fill('fixture-good')
    );
  });
});

describe('METADATA headers', () => {
  it('collects repeated headers in order and stops at the blank line before the description', () => {
    const headers = parseHeaders(
      'Name: demo\r\nRequires-Dist: a\r\nRequires-Dist: b\r\n\r\nRequires-Dist: c @ http://in.the.description/\r\n'
    );
    expect(headers.get('requires-dist')).toEqual(['a', 'b']);
  });

  it('joins a continuation line to the header it continues', () => {
    expect(parseHeaders('Requires-Dist: demo\n  @ http://127.0.0.1/x.whl\n').get('requires-dist')).toEqual([
      'demo\n  @ http://127.0.0.1/x.whl',
    ]);
  });

  it('stops at the first line that is not a header', () => {
    expect([...parseHeaders('Name: demo\nnot a header\nVersion: 1\n').keys()]).toEqual(['name']);
  });

  it('still sees headers after lines the installer skips', () => {
    // Python's parser drops a header with an empty name, a misplaced "From " line and a
    // leading continuation, and goes on. Stopping there would hide a later Requires-Dist.
    const headers = parseHeaders(
      ' leading continuation\nName: demo\n: no name\nFrom nowhere\nRequires-Dist: demo @ http://127.0.0.1/\n'
    );
    expect(headers.get('requires-dist')).toEqual(['demo @ http://127.0.0.1/']);
    expect(headers.get('name')).toEqual(['demo']);
  });

  it('reads name, version and requirements, and nothing when a field is missing', () => {
    expect(readIdentity('Name: Demo_Pack\nVersion: 1.2\nRequires-Dist: x>=1\n')).toEqual({
      name: 'demo-pack',
      declaredName: 'Demo_Pack',
      version: '1.2',
      requires: ['x>=1'],
    });
    expect(readIdentity('Name: demo\n')).toBeUndefined();
    expect(readIdentity('﻿Name: demo\nVersion: 1\n')).toBeUndefined();
  });
});

describe('extension entry points', () => {
  it('returns only the aelix.extensions group, without extras or spaces', () => {
    const entries = parseExtensionEntries(
      [
        '# comment',
        '[console_scripts]',
        'tool = demo:main',
        '[ aelix.extensions ]',
        'demo = demo.pack : setup [extra]',
        'other=other:setup',
        '; comment',
        '[aelix.other]',
        'ignored = x:y',
      ].join('\n')
    );
    expect([...entries]).toEqual([
      ['demo', 'demo.pack:setup'],
      ['other', 'other:setup'],
    ]);
  });

  it('returns nothing for a file without the group', () => {
    expect(parseExtensionEntries('[console_scripts]\ntool = demo:main\n').size).toBe(0);
  });

  it('lists the scripts the installer would write for console and gui entry points', () => {
    const text = '[console_scripts]\ntool = demo:main\npython3.12 = demo:main\n[gui_scripts]\nwindow = demo:gui\n';
    expect(parseScriptNames(text)).toEqual(['tool', 'python3.12', 'window']);
    expect(parseScriptNames('[aelix.extensions]\ndemo = demo:setup\n')).toEqual([]);
  });

  it('compares names the way native does: case and underscores fold, a dot does not', () => {
    expect(['Sample_One', ' sample-one ', 'SAMPLE-ONE'].map(nativeName)).toEqual(Array(3).fill('sample-one'));
    expect(nativeName('sample.one')).toBe('sample.one');
  });

  it('accepts module and module:attribute references and nothing that could be read as an option', () => {
    expect(['demo', 'demo.pack:setup', '확장:설정'].map(isObjectReference)).toEqual([true, true, true]);
    expect(['', '-e', '--flag', 'a b', 'demo:', 'a:b:c', 'demo/pack'].map(isObjectReference)).toEqual(
      Array(7).fill(false)
    );
  });

  it('accepts entry names native can take as an argument and none that reads as an option', () => {
    expect(['demo', 'demo-ext', 'demo.ext_2', '확장'].map(isEntryName)).toEqual(Array(4).fill(true));
    expect(['', '-demo', '--yes', '--trust-extension-path=x', 'a b', 'a/b'].map(isEntryName)).toEqual(
      Array(6).fill(false)
    );
  });
});

describe('RECORD paths', () => {
  it('reads plain and quoted paths and ignores the hash and size columns', () => {
    expect(
      parseRecordPaths(
        [
          'demo/__init__.py,sha256=abc,12',
          '../../../bin/demo,sha256=def,3',
          '"demo/a,b ""c"".py",sha256=ghi,4',
          'demo-1.dist-info/RECORD,,',
          '',
        ].join('\n')
      )
    ).toEqual(['demo/__init__.py', '../../../bin/demo', 'demo/a,b "c".py', 'demo-1.dist-info/RECORD']);
  });

  it('returns nothing for an empty file', () => {
    expect(parseRecordPaths('')).toEqual([]);
  });
});
