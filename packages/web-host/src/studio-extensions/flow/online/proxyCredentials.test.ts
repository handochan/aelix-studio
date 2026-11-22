/**
 * Proxy credentials: the sealed store, and online installs through the helper service with a
 * keychain vault (the desktop) and a memory-only one (the standalone WebUI, Linux without a
 * secret store). The vault is fake here: `seal` reverses and tags the text, so a test can
 * tell sealed bytes from plain ones. The desktop's `safeStorage` vault has tests of its own.
 */
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createFakeBundle,
  directWriter,
  fakeRuntime,
  installWheel,
  type FakeRuntimeOptions,
} from '../../../../tests/fixtures/extensionRuntime';
import { writeWheel } from '../../../../tests/fixtures/extensionWheels';
import { redactUrlCredentials } from '../../process';
import { ExtensionService, type ExtensionServiceOptions } from '../../service';
import { layoutOf, type Layout } from '../../store/layout';
import {
  ExtensionFailure,
  type ExtensionOperation,
  type ExtensionReply,
  type ExtensionSettingsState,
} from '../../types';
import {
  dropProxyCredentials,
  hasSavedCredentials,
  MEMORY_ONLY_VAULT,
  openSavedCredentials,
  parseProxyCredentials,
  proxyWithCredentials,
  saveProxyCredentials,
  type ProxyCredentialVault,
} from './proxyCredentials';

const PROXY = 'http://proxy.corp.example:3128';
/** A password with every character that has a meaning in a URL, and a user name with an @. */
const CREDENTIALS = { username: 'ops@corp', password: "p@ss:w/rd%zz#?& !*'()100%" };
/** Pieces that must never appear outside the sealed file or the installer environment. */
const SECRETS = ['p@ss:w/rd', 'w/rd%zz', encodeURIComponent(CREDENTIALS.password), 'ops@corp', 'ops%40corp'];

const fakeKeychain = (): ProxyCredentialVault & { opened: number; broken: boolean } => {
  const vault = {
    mode: 'keychain' as const,
    opened: 0,
    broken: false,
    seal: (text: string) => Buffer.from('SEALED:' + [...text].reverse().join('')),
    open: (sealed: Buffer) => {
      vault.opened += 1;
      if (vault.broken) throw new Error('the keychain refused');
      const text = sealed.toString();
      if (!text.startsWith('SEALED:')) throw new Error('not sealed');
      return Array.from(text.slice('SEALED:'.length)).reverse().join('');
    },
  };
  return vault;
};

const failureOf = async (work: Promise<unknown> | (() => unknown)): Promise<ExtensionFailure> => {
  try {
    await (typeof work === 'function' ? work() : work);
  } catch (error) {
    if (error instanceof ExtensionFailure) return error;
    throw error;
  }
  throw new Error('expected a failure');
};

describe('proxy credentials from a request', () => {
  it('keeps them as typed, and refuses what cannot be a user name and password without repeating it', async () => {
    expect(parseProxyCredentials({ username: 'alice', password: '' })).toEqual({ username: 'alice', password: '' });
    for (const value of [
      null,
      'alice:secret',
      { username: '', password: 'secret' },
      { username: 'alice' },
      { username: 'alice', password: 'sec\nret' },
      { username: 'al\u0000ice', password: 'secret' },
      { username: 'alice', password: 'secret', extra: 1 },
      { username: 'a'.repeat(300), password: 'secret' },
      // pip sends Latin-1 and Git UTF-8: past ASCII they disagree, so it is refused at entry.
      { username: 'alice', password: 'secrét' },
      { username: 'alice', password: '비밀secret' },
      // Git decodes a proxy's user part twice and pip once: %41 would reach them differently.
      { username: 'alice', password: 'secret%41' },
      { username: 'al%2Fice', password: 'secret' },
    ]) {
      const failure = await failureOf(() => parseProxyCredentials(value));
      expect(failure.code).toBe('INVALID_INPUT');
      expect([failure.message, ...failure.detail].join(' ')).not.toMatch(/secret|alice/);
    }
  });

  it('percent-encodes them into the proxy URL so a URL parser gives them back exactly', () => {
    const url = new URL(proxyWithCredentials(PROXY, CREDENTIALS));
    expect([decodeURIComponent(url.username), decodeURIComponent(url.password)]).toEqual([
      CREDENTIALS.username,
      CREDENTIALS.password,
    ]);
    expect(`${url.protocol}//${url.host}`).toBe(PROXY);
    expect(proxyWithCredentials('https://[::1]:8443', { username: 'u', password: 'p' })).toBe('https://u:p@[::1]:8443');
  });
});

describe('the sealed credential store', () => {
  let scratch = '';
  let layout: Layout;
  beforeEach(async () => {
    scratch = await realpath(await mkdtemp(path.join(os.tmpdir(), 'studio-proxy-credentials-')));
    layout = layoutOf(path.join(scratch, 'aelix-runtime'));
    await mkdir(layout.root);
  });
  afterEach(() => rm(scratch, { recursive: true, force: true }));

  it('stores only sealed bytes, through the lock holder, tied to one proxy and one id', async () => {
    const vault = fakeKeychain();
    const id = await saveProxyCredentials(layout, vault, PROXY, CREDENTIALS, directWriter(layout.root));
    const stored = await readFile(layout.proxyCredentials, 'utf8');
    for (const secret of SECRETS) expect(stored).not.toContain(secret);
    expect(JSON.parse(stored)).toMatchObject({
      schema: 'aelix.studio.extensions.proxy-credentials/1',
      id,
      proxy: PROXY,
    });
    expect(await readdir(layout.root)).toEqual(['proxy-credentials.json']);

    expect(await hasSavedCredentials(layout, vault, PROXY, id)).toBe(true);
    expect(vault.opened).toBe(0);
    expect(await openSavedCredentials(layout, vault, PROXY, id)).toEqual(CREDENTIALS);
    // Another proxy, another save, or no keychain: none.
    expect(await openSavedCredentials(layout, vault, 'http://other.example:3128', id)).toBeUndefined();
    expect(await openSavedCredentials(layout, vault, PROXY, 'f'.repeat(32))).toBeUndefined();
    expect(await hasSavedCredentials(layout, MEMORY_ONLY_VAULT, PROXY, id)).toBe(false);
    // A keychain that can no longer open them: none, and the user is asked again.
    vault.broken = true;
    expect(await openSavedCredentials(layout, vault, PROXY, id)).toBeUndefined();

    await dropProxyCredentials(layout, directWriter(layout.root));
    expect(await readdir(layout.root)).toEqual([]);
    expect(await hasSavedCredentials(layout, fakeKeychain(), PROXY, id)).toBe(false);
  });

  it('stores nothing without a keychain', async () => {
    const failure = await failureOf(
      saveProxyCredentials(layout, MEMORY_ONLY_VAULT, PROXY, CREDENTIALS, directWriter(layout.root))
    );
    expect(failure.code).toBe('PROXY_CREDENTIALS_NOT_STORED');
    expect(await readdir(layout.root)).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('does not read through a link in place of the file', async () => {
    const vault = fakeKeychain();
    const id = await saveProxyCredentials(layout, vault, PROXY, CREDENTIALS, directWriter(layout.root));
    const elsewhere = path.join(scratch, 'elsewhere.json');
    await writeFile(elsewhere, await readFile(layout.proxyCredentials));
    await rm(layout.proxyCredentials);
    await symlink(elsewhere, layout.proxyCredentials);
    expect(await hasSavedCredentials(layout, vault, PROXY, id)).toBe(false);
    expect(await openSavedCredentials(layout, vault, PROXY, id)).toBeUndefined();
  });
});

describe('masking a credentialed proxy URL in installer output', () => {
  const composed = proxyWithCredentials(PROXY, CREDENTIALS);
  it.each([
    [
      'pip',
      `WARNING: Retrying (Retry(total=0)) after connection broken by 'ProxyError('Unable to connect to proxy', ` +
        `NewConnectionError('<urllib3.connection.HTTPConnection object>: Failed to establish a new connection'))': ` +
        `${composed}/simple/demo/\n`,
    ],
    ['pip, quoted', `ERROR: Could not install: proxy '${composed}' refused the connection\n`],
    [
      'Git',
      `fatal: unable to access 'https://git.example.com/o/r.git/': Received HTTP code 407 from proxy ${composed}\n`,
    ],
    ['curl verbose', `* Uses proxy env variable https_proxy == '${composed}'\n`],
  ])('hides the credentials in %s output', (_tool, output) => {
    const masked = redactUrlCredentials(output);
    for (const secret of SECRETS) expect(masked).not.toContain(secret);
    expect(masked).toContain('http://***@proxy.corp.example:3128');
  });
});

// POSIX paths and the fake runtime, as the other service tests.
describe.skipIf(process.platform === 'win32')('online installs with proxy credentials', () => {
  let scratch = '';
  let root = '';
  let runtime: FakeRuntimeOptions;
  let spawn: ReturnType<typeof fakeRuntime>;
  let service: ExtensionService;
  let logged: unknown[] = [];
  const start = (options: Partial<ExtensionServiceOptions> = {}): ExtensionService =>
    new ExtensionService({
      runtime: runtime.bundle,
      root,
      spawn,
      env: { PATH: '/usr/bin' },
      log: (...args) => logged.push(args),
      ...options,
    });
  beforeEach(async () => {
    scratch = await realpath(await mkdtemp(path.join(os.tmpdir(), 'studio-proxy-service-')));
    root = path.join(scratch, 'user data', 'aelix-runtime');
    runtime = { bundle: await createFakeBundle(path.join(scratch, 'bundle')) };
    spawn = fakeRuntime(runtime);
    logged = [];
  });
  afterEach(async () => {
    await service?.dispose();
    await rm(scratch, { recursive: true, force: true });
  });

  const data = <T>(reply: ExtensionReply): T => {
    if (reply.ok === false) throw new Error(`request failed: ${reply.code} ${(reply.detail ?? []).join('; ')}`);
    return reply.data as T;
  };
  const settings = async (): Promise<ExtensionSettingsState> =>
    data<ExtensionSettingsState>(await service.request('window:1', { action: 'get_settings' }));
  const request = (command: unknown): Promise<ExtensionReply> => service.request('window:1', command);
  const settle = async (reply: ExtensionReply): Promise<ExtensionOperation> => {
    let state = data<ExtensionOperation>(reply);
    for (let round = 0; round < 1000 && !['switched', 'failed', 'cancelled'].includes(state.phase); round += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      state = data<ExtensionOperation>(await request({ action: 'poll', operationId: state.operationId }));
    }
    return state;
  };
  const installer = () => spawn.calls.findLast((call) => call.args.includes('install') && call.args.includes('native'));
  let installs = 0;
  /** A name install of a package of its own, so each one changes something. */
  const nameInstall = async (extra: Record<string, unknown> = {}): Promise<ExtensionReply> => {
    installs += 1;
    const name = `demo-${String(installs)}`;
    const wheel = await writeWheel(path.join(scratch, 'wheels'), { name });
    runtime.install = async (venv) => {
      await installWheel(venv, wheel);
      return 0;
    };
    return request({ action: 'install', source: { kind: 'index', name }, ...extra });
  };
  /** Everything the helper wrote under its root, as text, and whether a secret shows in it. */
  const writtenLeaks = async (): Promise<string[]> => {
    const found: string[] = [];
    const walk = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) await walk(file);
        else if (entry.isFile()) {
          const text = await readFile(file, 'latin1');
          for (const secret of SECRETS)
            if (text.includes(secret)) found.push(`${path.relative(root, file)}: ${secret}`);
        }
      }
    };
    await walk(root).catch(() => {});
    return found;
  };
  /** Secrets may reach only the installer environment: never an argument, a reply or a log. */
  const expectOnlyInEnvironment = (replies: unknown[]): void => {
    for (const call of spawn.calls) for (const secret of SECRETS) expect(call.args.join(' ')).not.toContain(secret);
    const seen = JSON.stringify([replies, logged]);
    for (const secret of SECRETS) expect(seen).not.toContain(secret);
  };

  describe('with a keychain', () => {
    let vault: ReturnType<typeof fakeKeychain>;
    beforeEach(() => {
      vault = fakeKeychain();
      service = start({ proxyVault: vault });
    });

    it('saves credentials typed into the proxy, sealed, and uses them in the environment only', async () => {
      const saved = data<ExtensionSettingsState>(
        await request({
          action: 'set_settings',
          settings: {
            proxy: `http://${encodeURIComponent(CREDENTIALS.username)}:${encodeURIComponent(CREDENTIALS.password)}@proxy.corp.example:3128`,
          },
        })
      );
      expect(saved).toMatchObject({
        settings: { proxy: PROXY, proxyAuthentication: true },
        credentialMode: 'keychain',
        hasSavedCredentials: true,
      });
      const stored = JSON.parse(await readFile(path.join(root, 'settings.json'), 'utf8')) as Record<string, unknown>;
      expect(stored.proxy).toBe(PROXY);
      expect(stored.proxyCredentialId).toMatch(/^[0-9a-f]{32}$/);

      const state = await settle(await nameInstall());
      expect(state).toMatchObject({ phase: 'switched' });
      const composed = proxyWithCredentials(PROXY, CREDENTIALS);
      expect(installer()?.env).toMatchObject({
        PIP_PROXY: composed,
        http_proxy: composed,
        https_proxy: composed,
        HTTP_PROXY: composed,
        HTTPS_PROXY: composed,
        GIT_CONFIG_KEY_1: 'http.proxy',
        GIT_CONFIG_VALUE_1: composed,
      });
      expectOnlyInEnvironment([saved, state, await settings(), await request({ action: 'list' })]);
      expect(await writtenLeaks()).toEqual([]);
    });

    it('drops saved credentials when the proxy is turned off or moves to another host or port', async () => {
      for (const change of [
        { proxy: null },
        { proxy: 'http://proxy.corp.example:8080' },
        { proxy: 'http://other.example:3128' },
      ]) {
        data(await request({ action: 'set_settings', settings: { proxy: PROXY } }));
        data(await request({ action: 'set_proxy_credentials', credentials: CREDENTIALS }));
        expect(await settings()).toMatchObject({ hasSavedCredentials: true, settings: { proxyAuthentication: true } });
        const after = data<ExtensionSettingsState>(await request({ action: 'set_settings', settings: change }));
        expect(after).toMatchObject({ hasSavedCredentials: false, settings: { proxyAuthentication: false } });
        expect(await readdir(root)).not.toContain('proxy-credentials.json');
      }
      // The same proxy again keeps them; turning authentication off drops them.
      data(await request({ action: 'set_settings', settings: { proxy: PROXY } }));
      data(await request({ action: 'set_proxy_credentials', credentials: CREDENTIALS }));
      expect(
        data<ExtensionSettingsState>(await request({ action: 'set_settings', settings: { proxy: PROXY } }))
      ).toMatchObject({
        hasSavedCredentials: true,
      });
      expect(
        data<ExtensionSettingsState>(
          await request({ action: 'set_settings', settings: { proxyAuthentication: false } })
        )
      ).toMatchObject({ hasSavedCredentials: false });
      expect(await readdir(root)).not.toContain('proxy-credentials.json');
    });

    it('refuses to save credentials without a proxy or readable settings, and removes a stray sealed file', async () => {
      expect(await request({ action: 'set_proxy_credentials', credentials: CREDENTIALS })).toMatchObject({
        ok: false,
        code: 'INVALID_INPUT',
      });
      data(await request({ action: 'set_settings', settings: { proxy: PROXY } }));
      data(await request({ action: 'set_proxy_credentials', credentials: CREDENTIALS }));
      await writeFile(path.join(root, 'settings.json'), '{ not json');
      expect(await request({ action: 'set_proxy_credentials', credentials: CREDENTIALS })).toMatchObject({
        ok: false,
        code: 'SETTINGS_UNREADABLE',
      });
      // Saving again starts from the closed settings, whose proxy has no saved credentials.
      expect(await readdir(root)).toContain('proxy-credentials.json');
      data(
        await request({ action: 'set_settings', settings: { onlineInstall: true, proxy: PROXY, privateGit: false } })
      );
      expect(await readdir(root)).not.toContain('proxy-credentials.json');
      expect(await settings()).toMatchObject({ hasSavedCredentials: false, settings: { proxyAuthentication: false } });
    });

    it('clears saved credentials and then asks for them, before anything starts', async () => {
      data(await request({ action: 'set_settings', settings: { proxy: PROXY } }));
      data(await request({ action: 'set_proxy_credentials', credentials: CREDENTIALS }));
      const cleared = data<ExtensionSettingsState>(await request({ action: 'clear_proxy_credentials' }));
      expect(cleared).toMatchObject({ hasSavedCredentials: false, settings: { proxyAuthentication: true } });
      const calls = spawn.calls.length;
      expect(await nameInstall()).toEqual({ ok: false, code: 'PROXY_CREDENTIALS_REQUIRED' });
      expect(spawn.calls.length).toBe(calls);
    });

    it('takes credentials of the request over saved ones, for that install only', async () => {
      data(await request({ action: 'set_settings', settings: { proxy: PROXY } }));
      data(
        await request({ action: 'set_proxy_credentials', credentials: { username: 'saved', password: 'saved-pass' } })
      );
      const state = await settle(await nameInstall({ proxyCredentials: CREDENTIALS }));
      expect(state).toMatchObject({ phase: 'switched' });
      expect(installer()?.env.PIP_PROXY).toBe(proxyWithCredentials(PROXY, CREDENTIALS));
      expect(vault.opened).toBe(0);
      // The saved ones are untouched and used next time.
      await settle(await nameInstall());
      expect(installer()?.env.PIP_PROXY).toBe(
        proxyWithCredentials(PROXY, { username: 'saved', password: 'saved-pass' })
      );
    });

    it('asks again when the keychain can no longer open what it sealed', async () => {
      data(await request({ action: 'set_settings', settings: { proxy: PROXY } }));
      data(await request({ action: 'set_proxy_credentials', credentials: CREDENTIALS }));
      vault.broken = true;
      const state = await settle(await nameInstall());
      expect(state).toMatchObject({ phase: 'failed', code: 'PROXY_CREDENTIALS_REQUIRED' });
      expect(installer()).toBeUndefined();
      expectOnlyInEnvironment([state]);
    });

    it('hides the credentials in what the installer printed', async () => {
      data(await request({ action: 'set_settings', settings: { proxy: PROXY } }));
      data(await request({ action: 'set_proxy_credentials', credentials: CREDENTIALS }));
      runtime.nativeOutput = `ProxyError('Cannot connect to proxy.') via ${proxyWithCredentials(PROXY, CREDENTIALS)}\n`;
      runtime.install = async () => 1;
      const state = await settle(await request({ action: 'install', source: { kind: 'index', name: 'demo-one' } }));
      expect(state).toMatchObject({ phase: 'failed', code: 'INSTALLER_FAILED' });
      expect(state.output).toContain('http://***@proxy.corp.example:3128');
      expectOnlyInEnvironment([state]);
    });
  });

  describe('without a keychain', () => {
    beforeEach(() => {
      service = start();
    });

    it('refuses to save credentials, and turns authentication on without keeping those typed into the proxy', async () => {
      data(await request({ action: 'set_settings', settings: { proxy: PROXY } }));
      expect(await request({ action: 'set_proxy_credentials', credentials: CREDENTIALS })).toEqual({
        ok: false,
        code: 'PROXY_CREDENTIALS_NOT_STORED',
      });
      const typed = data<ExtensionSettingsState>(
        await request({ action: 'set_settings', settings: { proxy: 'http://ops:hunter2@proxy.corp.example:3128' } })
      );
      expect(typed).toMatchObject({
        settings: { proxy: PROXY, proxyAuthentication: true },
        credentialMode: 'memory-only',
        hasSavedCredentials: false,
      });
      expect(await readdir(root)).not.toContain('proxy-credentials.json');
      expect(await readFile(path.join(root, 'settings.json'), 'utf8')).not.toMatch(/hunter2|"ops/);
    });

    it('answers a missing credential with a code the screen can ask on, before anything starts', async () => {
      data(await request({ action: 'set_settings', settings: { proxy: PROXY, proxyAuthentication: true } }));
      const calls = spawn.calls.length;
      expect(await nameInstall()).toEqual({ ok: false, code: 'PROXY_CREDENTIALS_REQUIRED' });
      expect(spawn.calls.length).toBe(calls);
    });

    it('uses credentials of the request in the environment only and keeps nothing of them', async () => {
      data(await request({ action: 'set_settings', settings: { proxy: PROXY, proxyAuthentication: true } }));
      const state = await settle(await nameInstall({ proxyCredentials: CREDENTIALS }));
      expect(state).toMatchObject({ phase: 'switched' });
      expect(installer()?.env.PIP_PROXY).toBe(proxyWithCredentials(PROXY, CREDENTIALS));
      expectOnlyInEnvironment([state, await settings(), await request({ action: 'list' })]);
      expect(await writtenLeaks()).toEqual([]);
      // The next install asks again.
      expect(await nameInstall()).toEqual({ ok: false, code: 'PROXY_CREDENTIALS_REQUIRED' });
    });

    it('refuses credentials past printable ASCII, typed, saved or sent, without repeating them', async () => {
      // pip sends proxy Basic auth as Latin-1 and fails past it; Git sends UTF-8 (user decision 2026-11-22).
      const keychain = start({ proxyVault: fakeKeychain() });
      try {
        data(await keychain.request('window:1', { action: 'set_settings', settings: { proxy: PROXY } }));
        data(await request({ action: 'set_settings', settings: { proxy: PROXY, proxyAuthentication: true } }));
        const refused = [
          await keychain.request('window:1', {
            action: 'set_settings',
            settings: { proxy: 'http://ops:p%C3%A4ssw%C3%B6rt@proxy.corp.example:3128' },
          }),
          await keychain.request('window:1', {
            action: 'set_proxy_credentials',
            credentials: { username: 'ops', password: 'pässwört' },
          }),
          await nameInstall({ proxyCredentials: { username: 'ops', password: '비밀번호' } }),
          await nameInstall({ proxyCredentials: { username: 'öps', password: 'secret' } }),
        ];
        for (const reply of refused) expect(reply).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
        expect(JSON.stringify(refused)).not.toMatch(/ops|pässwört|p%C3%A4ssw|비밀번호|öps|secret/);
        expect(await readdir(root)).not.toContain('proxy-credentials.json');
        expect(installer()).toBeUndefined();
      } finally {
        await keychain.dispose();
      }
    });

    it('refuses credentials sent without a proxy, with a file import or with an update', async () => {
      const noProxy = await nameInstall({ proxyCredentials: CREDENTIALS });
      expect(noProxy).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
      data(await request({ action: 'set_settings', settings: { proxy: PROXY } }));
      const wheel = await writeWheel(path.join(scratch, 'files'), { name: 'demo-file' });
      const file = await request({
        action: 'install',
        source: { kind: 'file', path: wheel },
        proxyCredentials: CREDENTIALS,
      });
      expect(file).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
      const update = await request({
        action: 'update',
        name: 'demo-file',
        source: { kind: 'file', path: wheel },
        proxyCredentials: CREDENTIALS,
      });
      expect(update).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
      expectOnlyInEnvironment([noProxy, file, update]);
    });

    it('keeps a proxy without authentication working as before, and no proxy isolated as before', async () => {
      data(await request({ action: 'set_settings', settings: { proxy: PROXY } }));
      expect(await settle(await nameInstall())).toMatchObject({ phase: 'switched' });
      expect(installer()?.env.PIP_PROXY).toBe(PROXY);
      data(await request({ action: 'set_settings', settings: { proxy: null } }));
      expect(await settle(await nameInstall())).toMatchObject({ phase: 'switched' });
      expect(installer()?.env).not.toHaveProperty('PIP_PROXY');
      expect(installer()?.env.no_proxy).toBe('*');
    });
  });
});
