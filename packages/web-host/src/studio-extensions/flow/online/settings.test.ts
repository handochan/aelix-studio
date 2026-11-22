import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { directWriter } from '../../../../tests/fixtures/extensionRuntime';
import { layoutOf, type Layout } from '../../store/layout';
import { ExtensionFailure } from '../../types';
import {
  DEFAULT_SETTINGS,
  normalizeProxy,
  parseProxyInput,
  parseSettingsChange,
  readSettings,
  writeSettings,
} from './settings';

const failureOf = (work: () => unknown): ExtensionFailure => {
  try {
    work();
  } catch (error) {
    if (error instanceof ExtensionFailure) return error;
    throw error;
  }
  throw new Error('expected a failure');
};

describe('the proxy the user types', () => {
  it.each([
    ['http://proxy.corp.example:3128', 'http://proxy.corp.example:3128'],
    ['HTTP://Proxy.Corp.Example:3128/', 'http://proxy.corp.example:3128'],
    ['https://proxy.corp.example:8443', 'https://proxy.corp.example:8443'],
    ['http://proxy.corp.example', 'http://proxy.corp.example'],
    ['http://proxy.corp.example:80', 'http://proxy.corp.example'],
    ['http://10.0.0.7:8080', 'http://10.0.0.7:8080'],
    ['http://[::1]:3128', 'http://[::1]:3128'],
  ])('keeps %s as %s', (typed, stored) => {
    expect(normalizeProxy(typed)).toBe(stored);
  });

  it.each([
    'proxy.corp.example:3128',
    'socks5://proxy.corp.example:1080',
    'ftp://proxy.corp.example',
    'http://',
    'http://-proxy',
    'http://proxy.corp.example:3128/path',
    'http://proxy.corp.example:3128/?q=1',
    'http://proxy.corp.example:3128/#frag',
    'http://proxy.corp.example:99999',
    'http://proxy corp.example',
    'http://proxy.corp.example\\x',
    'http://proxy.corp.example\n',
    'http:///proxy.corp.example:3128',
    'http:////proxy.corp.example',
    'http://proxy.corp.example:0',
    'http://proxy.corp.example:00',
    'http://proxy.corp.example:',
    'http://pro%78y.corp.example',
    'http://proxy_corp.example',
    '',
    'x'.repeat(3000),
    42,
    null,
  ])('refuses %j as an invalid proxy', (typed) => {
    expect(failureOf(() => normalizeProxy(typed)).code).toBe('INVALID_PROXY');
  });

  it.each<[string, string, { username: string; password: string }]>([
    [
      'http://alice:secret-password@proxy.corp.example:3128',
      'http://proxy.corp.example:3128',
      { username: 'alice', password: 'secret-password' },
    ],
    ['http://alice@proxy.corp.example:3128', 'http://proxy.corp.example:3128', { username: 'alice', password: '' }],
    [
      'https://alice%40corp:p%3Ass%2Fw%25rd%40x@proxy.corp.example',
      'https://proxy.corp.example',
      { username: 'alice@corp', password: 'p:ss/w%rd@x' },
    ],
    ['http://alice:p@ss@proxy.corp.example', 'http://proxy.corp.example', { username: 'alice', password: 'p@ss' }],
  ])('splits the credentials off %s and decodes them', (typed, proxy, credentials) => {
    expect(parseProxyInput(typed)).toEqual({ proxy, credentials });
  });

  it.each([
    'http://:secret-password@proxy.corp.example',
    'http://@proxy.corp.example',
    'http://alice:secret%ZZ@proxy.corp.example',
  ])('refuses the user part of %s without repeating any of the address', (typed) => {
    const failure = failureOf(() => parseProxyInput(typed));
    expect(failure.code).toBe('INVALID_PROXY');
    const reported = [failure.message, ...failure.detail].join('\n');
    for (const part of ['secret', 'alice', 'proxy.corp.example']) expect(reported).not.toContain(part);
  });

  it.each([
    'http://ops:p%C3%A4ss@proxy.corp.example',
    'http://ops:pässwört@proxy.corp.example',
    'http://ops:p%E4ss@proxy.corp.example',
    'http://ops:pa\u00a0ss@proxy.corp.example',
    'http://ops:%00secret@proxy.corp.example',
    'http://op%3As:secret@proxy.corp.example',
    'http://ops:secret%2541@proxy.corp.example',
  ])('refuses %s as credentials, with the fixed answer of every entry point', (typed) => {
    const failure = failureOf(() => parseProxyInput(typed));
    expect(failure.code).toBe('INVALID_INPUT');
    expect(failure.detail).toEqual([
      'proxy credentials need a user name without a colon, both in printable ASCII and without a % followed by two hex digits',
    ]);
  });

  it('refuses credentials typed with authentication turned off in the same change', () => {
    const failure = failureOf(() =>
      parseSettingsChange({ proxy: 'http://ops:secret@proxy.corp.example', proxyAuthentication: false })
    );
    expect(failure.code).toBe('INVALID_INPUT');
    expect([failure.message, ...failure.detail].join(' ')).not.toMatch(/ops|secret/);
  });

  it('keeps the stored form free of credentials', () => {
    expect(failureOf(() => normalizeProxy('http://alice:secret@proxy.corp.example')).code).toBe('INVALID_PROXY');
  });

  it('refuses extra slashes before a user part instead of storing the address without it', () => {
    for (const typed of [
      'http:///alice:secret-password@proxy.corp.example',
      'http:////alice@proxy.corp.example:3128',
    ]) {
      const failure = failureOf(() => normalizeProxy(typed));
      expect(failure.code).toBe('INVALID_PROXY');
      expect([failure.message, ...failure.detail].join('\n')).not.toMatch(/secret-password|alice|corp\.example/);
    }
  });
});

describe('a settings change from a request', () => {
  it('takes only the fields it was given, and normalizes the proxy', () => {
    expect(parseSettingsChange({ privateGit: true })).toEqual({ settings: { privateGit: true } });
    expect(parseSettingsChange({ proxy: 'HTTP://Proxy.Example:3128/', onlineInstall: false })).toEqual({
      settings: { proxy: 'http://proxy.example:3128', onlineInstall: false },
    });
    expect(parseSettingsChange({ proxy: null, proxyAuthentication: false })).toEqual({
      settings: { proxy: null, proxyAuthentication: false },
    });
  });

  it('splits credentials typed into the proxy off the stored address', () => {
    expect(parseSettingsChange({ proxy: 'http://alice:s3cret@proxy.example:3128' })).toEqual({
      settings: { proxy: 'http://proxy.example:3128' },
      credentials: { username: 'alice', password: 's3cret' },
    });
  });

  it.each([
    [null],
    [[]],
    [{}],
    [{ onlineInstall: 'yes' }],
    [{ privateGit: 1 }],
    [{ proxyUrl: 'http://proxy.example' }],
    [{ onlineInstall: true, extra: true }],
    [{ proxyAuthentication: 'yes' }],
    [{ proxyCredentialId: 'a'.repeat(32) }],
  ])('refuses %j as invalid input', (change) => {
    expect(failureOf(() => parseSettingsChange(change)).code).toBe('INVALID_INPUT');
  });

  it('reports a bad proxy by its own code', () => {
    expect(failureOf(() => parseSettingsChange({ proxy: 'proxy.example:3128' })).code).toBe('INVALID_PROXY');
    expect(failureOf(() => parseSettingsChange({ proxy: 'http://@proxy.example' })).code).toBe('INVALID_PROXY');
  });
});

describe('the stored settings', () => {
  let scratch = '';
  let layout: Layout;
  beforeEach(async () => {
    scratch = await realpath(await mkdtemp(path.join(os.tmpdir(), 'studio-settings-')));
    layout = layoutOf(path.join(scratch, 'aelix-runtime'));
    await mkdir(layout.root);
  });
  afterEach(() => rm(scratch, { recursive: true, force: true }));

  it('are the defaults while nothing was saved, and reading creates nothing', async () => {
    const absent = layoutOf(path.join(scratch, 'absent'));
    expect(await readSettings(absent)).toEqual({ settings: DEFAULT_SETTINGS, unreadable: false, credentialId: null });
    expect(await readdir(scratch)).toEqual(['aelix-runtime']);
    expect(DEFAULT_SETTINGS).toEqual({
      onlineInstall: true,
      proxy: null,
      privateGit: false,
      proxyAuthentication: false,
    });
  });

  it('are written whole through the lock holder and read back, with the id of sealed credentials only', async () => {
    const settings = {
      onlineInstall: false,
      proxy: 'http://proxy.example:3128',
      privateGit: true,
      proxyAuthentication: true,
    };
    const credentialId = 'c'.repeat(32);
    await writeSettings(layout, settings, credentialId, directWriter(layout.root));
    expect(await readSettings(layout)).toEqual({ settings, unreadable: false, credentialId });
    expect(await readdir(layout.root)).toEqual(['settings.json']);
    expect(JSON.parse(await readFile(layout.settings, 'utf8'))).toEqual({
      schema: 'aelix.studio.extensions.settings/1',
      ...settings,
      proxyCredentialId: credentialId,
    });
  });

  it('read settings written before proxy credentials as a proxy without authentication', async () => {
    // What PR #97 wrote: no proxyAuthentication, no proxyCredentialId.
    await writeFile(
      layout.settings,
      JSON.stringify({
        schema: 'aelix.studio.extensions.settings/1',
        onlineInstall: true,
        proxy: 'http://proxy.example:3128',
        privateGit: false,
      })
    );
    expect(await readSettings(layout)).toEqual({
      settings: {
        onlineInstall: true,
        proxy: 'http://proxy.example:3128',
        privateGit: false,
        proxyAuthentication: false,
      },
      unreadable: false,
      credentialId: null,
    });
  });

  it('stay as they were when the lock holder refuses the rename, leaving only a temporary file', async () => {
    const refusing = { ...directWriter(layout.root), replace: () => Promise.reject(new ExtensionFailure('CONFLICT')) };
    await expect(
      writeSettings(layout, { ...DEFAULT_SETTINGS, privateGit: true }, null, refusing)
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await readSettings(layout)).toEqual({ settings: DEFAULT_SETTINGS, unreadable: false, credentialId: null });
    expect((await readdir(layout.root)).every((name) => name.endsWith('.tmp'))).toBe(true);
  });

  it.each([
    ['not JSON', '{'],
    ['another schema', JSON.stringify({ schema: 'other/1', onlineInstall: true, proxy: null, privateGit: false })],
    [
      'a field of the wrong type',
      JSON.stringify({
        schema: 'aelix.studio.extensions.settings/1',
        onlineInstall: 'yes',
        proxy: null,
        privateGit: false,
      }),
    ],
    [
      'a proxy Studio would not have written',
      JSON.stringify({
        schema: 'aelix.studio.extensions.settings/1',
        onlineInstall: true,
        proxy: 'http://user:pass@proxy.example',
        privateGit: false,
      }),
    ],
    ['an oversized file', ' '.repeat(70 * 1024)],
    [
      'a credential id that is not one',
      JSON.stringify({
        schema: 'aelix.studio.extensions.settings/1',
        onlineInstall: true,
        proxy: 'http://proxy.example',
        privateGit: false,
        proxyAuthentication: true,
        proxyCredentialId: '../outside',
      }),
    ],
    [
      'proxy authentication without a proxy',
      JSON.stringify({
        schema: 'aelix.studio.extensions.settings/1',
        onlineInstall: true,
        proxy: null,
        privateGit: false,
        proxyAuthentication: true,
      }),
    ],
  ])('fall back to the closed settings, flagged unreadable, for %s', async (_case, content) => {
    await writeFile(layout.settings, content);
    expect(await readSettings(layout)).toEqual({
      settings: { onlineInstall: false, proxy: null, privateGit: false, proxyAuthentication: false },
      unreadable: true,
      credentialId: null,
    });
  });

  it('are unreadable, not the defaults, when the file is a directory', async () => {
    await mkdir(layout.settings);
    expect((await readSettings(layout)).unreadable).toBe(true);
  });

  // Windows file links need a privilege CI does not have; the check is the same lstat there.
  it.skipIf(process.platform === 'win32')(
    'are unreadable, not the defaults, when the name is a link, even one whose target is gone',
    async () => {
      await symlink(path.join(scratch, 'gone.json'), layout.settings);
      expect(await readSettings(layout)).toEqual({
        settings: { onlineInstall: false, proxy: null, privateGit: false, proxyAuthentication: false },
        unreadable: true,
        credentialId: null,
      });
      await rm(layout.settings);
      const elsewhere = path.join(scratch, 'elsewhere.json');
      await writeFile(
        elsewhere,
        JSON.stringify({
          schema: 'aelix.studio.extensions.settings/1',
          onlineInstall: true,
          proxy: null,
          privateGit: true,
        })
      );
      await symlink(elsewhere, layout.settings);
      expect((await readSettings(layout)).unreadable).toBe(true);
    }
  );
});
