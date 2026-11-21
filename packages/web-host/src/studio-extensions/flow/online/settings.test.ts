import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { directWriter } from '../../../../tests/fixtures/extensionRuntime';
import { layoutOf, type Layout } from '../../store/layout';
import { ExtensionFailure } from '../../types';
import { DEFAULT_SETTINGS, normalizeProxy, parseSettingsChange, readSettings, writeSettings } from './settings';

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

  it.each([
    'http://alice:secret-password@proxy.corp.example:3128',
    'http://alice@proxy.corp.example:3128',
    'http://:secret-password@proxy.corp.example',
    'http://@proxy.corp.example',
    'https://alice%40corp:secret-password@proxy.corp.example',
  ])('refuses credentials in %s without repeating any of the address', (typed) => {
    const failure = failureOf(() => normalizeProxy(typed));
    expect(failure.code).toBe('PROXY_CREDENTIALS_UNSUPPORTED');
    const reported = [failure.message, ...failure.detail].join('\n');
    for (const part of ['secret-password', 'alice', 'proxy.corp.example']) expect(reported).not.toContain(part);
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
    expect(parseSettingsChange({ privateGit: true })).toEqual({ privateGit: true });
    expect(parseSettingsChange({ proxy: 'HTTP://Proxy.Example:3128/', onlineInstall: false })).toEqual({
      proxy: 'http://proxy.example:3128',
      onlineInstall: false,
    });
    expect(parseSettingsChange({ proxy: null })).toEqual({ proxy: null });
  });

  it.each([
    [null],
    [[]],
    [{}],
    [{ onlineInstall: 'yes' }],
    [{ privateGit: 1 }],
    [{ proxyUrl: 'http://proxy.example' }],
    [{ onlineInstall: true, extra: true }],
  ])('refuses %j as invalid input', (change) => {
    expect(failureOf(() => parseSettingsChange(change)).code).toBe('INVALID_INPUT');
  });

  it('reports a bad proxy by its own code', () => {
    expect(failureOf(() => parseSettingsChange({ proxy: 'proxy.example:3128' })).code).toBe('INVALID_PROXY');
    expect(failureOf(() => parseSettingsChange({ proxy: 'http://a:b@proxy.example' })).code).toBe(
      'PROXY_CREDENTIALS_UNSUPPORTED'
    );
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
    expect(await readSettings(absent)).toEqual({ settings: DEFAULT_SETTINGS, unreadable: false });
    expect(await readdir(scratch)).toEqual(['aelix-runtime']);
    expect(DEFAULT_SETTINGS).toEqual({ onlineInstall: true, proxy: null, privateGit: false });
  });

  it('are written whole through the lock holder and read back', async () => {
    const settings = { onlineInstall: false, proxy: 'http://proxy.example:3128', privateGit: true };
    await writeSettings(layout, settings, directWriter(layout.root));
    expect(await readSettings(layout)).toEqual({ settings, unreadable: false });
    expect(await readdir(layout.root)).toEqual(['settings.json']);
    expect(JSON.parse(await readFile(layout.settings, 'utf8'))).toEqual({
      schema: 'aelix.studio.extensions.settings/1',
      ...settings,
    });
  });

  it('stay as they were when the lock holder refuses the rename, leaving only a temporary file', async () => {
    const refusing = { ...directWriter(layout.root), replace: () => Promise.reject(new ExtensionFailure('CONFLICT')) };
    await expect(writeSettings(layout, { ...DEFAULT_SETTINGS, privateGit: true }, refusing)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(await readSettings(layout)).toEqual({ settings: DEFAULT_SETTINGS, unreadable: false });
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
  ])('fall back to the closed settings, flagged unreadable, for %s', async (_case, content) => {
    await writeFile(layout.settings, content);
    expect(await readSettings(layout)).toEqual({
      settings: { onlineInstall: false, proxy: null, privateGit: false },
      unreadable: true,
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
        settings: { onlineInstall: false, proxy: null, privateGit: false },
        unreadable: true,
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
