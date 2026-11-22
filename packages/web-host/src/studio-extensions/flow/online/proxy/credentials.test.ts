/**
 * Proxy credentials: the sealed store, and online installs through the helper service with a
 * keychain vault (the desktop) and a memory-only one (the standalone WebUI, Linux without a
 * secret store). The vault is fake here: `seal` reverses and tags the text, so a test can
 * tell sealed bytes from plain ones. The desktop's `safeStorage` vault has tests of its own.
 *
 * The installer of these tests asks a stand-in for the user's proxy through the proxy it was
 * given, the way pip would: so they see which credentials reached the user's proxy, through
 * the relay of the change.
 */
import { once } from 'node:events';
import { writeFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createFakeBundle,
  directWriter,
  fakeRuntime,
  installWheel,
  type FakeRuntimeOptions,
} from '../../../../../tests/fixtures/extensionRuntime';
import { writeWheel } from '../../../../../tests/fixtures/extensionWheels';
import { redactUrlCredentials, type Spawn } from '../../../process';
import { ExtensionService, type ExtensionServiceOptions } from '../../../service';
import { layoutOf, type Layout } from '../../../store/layout';
import {
  ExtensionFailure,
  type ExtensionOperation,
  type ExtensionReply,
  type ExtensionSettingsState,
} from '../../../types';
import {
  dropProxyCredentials,
  hasSavedCredentials,
  MEMORY_ONLY_VAULT,
  newCredentialId,
  openSavedCredentials,
  parseProxyCredentials,
  saveProxyCredentials,
  type ProxyCredentialVault,
} from './credentials';

const STORE_PROXY = 'http://proxy.corp.example:3128';
/** A password with every character that has a meaning in a URL, and a user name with an @. */
const CREDENTIALS = { username: 'ops@corp', password: "p@ss:w/rd%zz#?& !*'()100%" };
/** Pieces that must never appear outside the sealed file and the relay. */
const SECRETS = ['p@ss:w/rd', 'w/rd%zz', encodeURIComponent(CREDENTIALS.password), 'ops@corp', 'ops%40corp'];
const SEALED = /^proxy-credentials-[0-9a-f]{32}\.json$/;
const basic = (credentials: { username: string; password: string }): string =>
  'Basic ' + Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64');
/** A proxy address typed with credentials, percent-encoded as a user would. */
const typedWith = (proxy: string, credentials: { username: string; password: string }): string =>
  proxy.replace('//', `//${encodeURIComponent(credentials.username)}:${encodeURIComponent(credentials.password)}@`);

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
    expect(parseProxyCredentials(CREDENTIALS)).toEqual(CREDENTIALS);
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
      // Basic authentication splits at the first colon (RFC 7617).
      { username: 'ali:ce', password: 'secret' },
    ]) {
      const failure = await failureOf(() => parseProxyCredentials(value));
      expect(failure.code).toBe('INVALID_INPUT');
      expect([failure.message, ...failure.detail].join(' ')).not.toMatch(/secret|alice|ali:ce/);
    }
  });
});

describe('the sealed credential store', () => {
  let scratch = '';
  let layout: Layout;
  const sealedOf = (id: string): string => path.join(layout.root, `proxy-credentials-${id}.json`);
  beforeEach(async () => {
    scratch = await realpath(await mkdtemp(path.join(os.tmpdir(), 'studio-proxy-credentials-')));
    layout = layoutOf(path.join(scratch, 'aelix-runtime'));
    await mkdir(layout.root);
  });
  afterEach(() => rm(scratch, { recursive: true, force: true }));

  it('stores only sealed bytes, one owner-only file per save, tied to one proxy and one id', async () => {
    const vault = fakeKeychain();
    const writer = directWriter(layout.root);
    const id = await saveProxyCredentials(layout, vault, STORE_PROXY, CREDENTIALS, writer);
    const stored = await readFile(sealedOf(id), 'utf8');
    for (const secret of SECRETS) expect(stored).not.toContain(secret);
    expect(JSON.parse(stored)).toMatchObject({
      schema: 'aelix.studio.extensions.proxy-credentials/2',
      id,
      proxy: STORE_PROXY,
    });
    expect(await readdir(layout.root)).toEqual([`proxy-credentials-${id}.json`]);
    if (process.platform !== 'win32') expect((await stat(sealedOf(id))).mode & 0o777).toBe(0o600);

    expect(await hasSavedCredentials(layout, vault, STORE_PROXY, id)).toBe(true);
    expect(vault.opened).toBe(0);
    expect(await openSavedCredentials(layout, vault, STORE_PROXY, id)).toEqual(CREDENTIALS);
    // Another proxy, another save, or no keychain: none.
    expect(await openSavedCredentials(layout, vault, 'http://other.example:3128', id)).toBeUndefined();
    expect(await openSavedCredentials(layout, vault, STORE_PROXY, 'f'.repeat(32))).toBeUndefined();
    expect(await hasSavedCredentials(layout, MEMORY_ONLY_VAULT, STORE_PROXY, id)).toBe(false);
    // A keychain that can no longer open them: none, and the user is asked again.
    vault.broken = true;
    expect(await openSavedCredentials(layout, vault, STORE_PROXY, id)).toBeUndefined();

    // A new save is a new file; the older one goes only when it is dropped.
    const next = await saveProxyCredentials(layout, fakeKeychain(), STORE_PROXY, CREDENTIALS, writer);
    expect((await readdir(layout.root)).sort()).toEqual(
      [`proxy-credentials-${id}.json`, `proxy-credentials-${next}.json`].sort()
    );
    await dropProxyCredentials(layout, writer, next);
    expect(await readdir(layout.root)).toEqual([`proxy-credentials-${next}.json`]);
    await dropProxyCredentials(layout, writer, null);
    expect(await readdir(layout.root)).toEqual([]);
  });

  it('stores nothing without a keychain', async () => {
    const failure = await failureOf(
      saveProxyCredentials(layout, MEMORY_ONLY_VAULT, STORE_PROXY, CREDENTIALS, directWriter(layout.root))
    );
    expect(failure.code).toBe('PROXY_CREDENTIALS_NOT_STORED');
    expect(await readdir(layout.root)).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('does not use a sealed file others may read', async () => {
    const vault = fakeKeychain();
    const id = await saveProxyCredentials(layout, vault, STORE_PROXY, CREDENTIALS, directWriter(layout.root));
    for (const mode of [0o644, 0o640, 0o604, 0o660]) {
      await chmod(sealedOf(id), mode);
      expect(await hasSavedCredentials(layout, vault, STORE_PROXY, id)).toBe(false);
      expect(await openSavedCredentials(layout, vault, STORE_PROXY, id)).toBeUndefined();
    }
    await chmod(sealedOf(id), 0o400);
    expect(await openSavedCredentials(layout, vault, STORE_PROXY, id)).toEqual(CREDENTIALS);
  });

  it('does not open a sealed file renamed to another id or relabelled for another proxy', async () => {
    const vault = fakeKeychain();
    const id = await saveProxyCredentials(layout, vault, STORE_PROXY, CREDENTIALS, directWriter(layout.root));
    const outer = JSON.parse(await readFile(sealedOf(id), 'utf8')) as Record<string, unknown>;
    // The id and the proxy outside the sealed bytes agree; the ones inside do not.
    const other = newCredentialId();
    await writeFile(sealedOf(other), JSON.stringify({ ...outer, id: other }), { mode: 0o600 });
    expect(await hasSavedCredentials(layout, vault, STORE_PROXY, other)).toBe(true);
    expect(await openSavedCredentials(layout, vault, STORE_PROXY, other)).toBeUndefined();
    await writeFile(sealedOf(id), JSON.stringify({ ...outer, proxy: 'http://other.example:3128' }));
    expect(await openSavedCredentials(layout, vault, 'http://other.example:3128', id)).toBeUndefined();
  });

  it.skipIf(process.platform === 'win32')('does not read through a link in place of the file', async () => {
    const vault = fakeKeychain();
    const id = await saveProxyCredentials(layout, vault, STORE_PROXY, CREDENTIALS, directWriter(layout.root));
    const elsewhere = path.join(scratch, 'elsewhere.json');
    await writeFile(elsewhere, await readFile(sealedOf(id)), { mode: 0o600 });
    await rm(sealedOf(id));
    await symlink(elsewhere, sealedOf(id));
    expect(await hasSavedCredentials(layout, vault, STORE_PROXY, id)).toBe(false);
    expect(await openSavedCredentials(layout, vault, STORE_PROXY, id)).toBeUndefined();
  });
});

describe('masking proxy URLs in installer output', () => {
  const relay = `http://run:${'0123456789abcdef'.repeat(4)}@127.0.0.1:50123`;
  it.each([
    [
      'pip',
      `WARNING: Retrying (Retry(total=0)) after connection broken by 'ProxyError('Unable to connect to proxy', ` +
        `NewConnectionError('<urllib3.connection.HTTPConnection object>: Failed to establish a new connection'))': ` +
        `${relay}/simple/demo/\n`,
    ],
    ['pip, quoted', `ERROR: Could not install: proxy '${relay}' refused the connection\n`],
    ['Git', `fatal: unable to access 'https://git.example.com/o/r.git/': Received HTTP code 407 from proxy ${relay}\n`],
    ['curl verbose', `* Uses proxy env variable https_proxy == '${relay}'\n`],
  ])('hides the relay token in %s output', (_tool, output) => {
    const masked = redactUrlCredentials(output);
    expect(masked).not.toContain('0123456789abcdef');
    expect(masked).toContain('http://***@127.0.0.1:50123');
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
  /** The user's proxy: the Basic value of each request that reached it. */
  let proxy = '';
  let signIns: (string | undefined)[] = [];
  let closeProxy = (): void => {};
  /** Runs once, just before the next change takes the lock: another Studio process, say. */
  let beforeLock: (() => void) | undefined;
  const interleaved: Spawn = (spec) => {
    const run = spec.args.includes('hold') ? beforeLock : undefined;
    if (run) {
      beforeLock = undefined;
      run();
    }
    return spawn(spec);
  };
  const start = (options: Partial<ExtensionServiceOptions> = {}): ExtensionService =>
    new ExtensionService({
      runtime: runtime.bundle,
      root,
      spawn: interleaved,
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
    signIns = [];
    beforeLock = undefined;
    const server = createServer((request, response) => {
      signIns.push(request.headers['proxy-authorization']);
      response.writeHead(200).end('index');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    proxy = 'http://127.0.0.1:' + String((server.address() as AddressInfo).port);
    closeProxy = () => {
      server.closeAllConnections();
      server.close();
    };
  });
  afterEach(async () => {
    await service?.dispose();
    closeProxy();
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
  const seals = async (): Promise<string[]> =>
    (await readdir(root).catch(() => [])).filter((name) => SEALED.test(name));
  /** What pip does first: ask the index through the proxy it was given, signed in as its URL says. */
  const throughProxy = (env: Record<string, string>): Promise<void> => {
    if (!env.PIP_PROXY) return Promise.resolve();
    const url = new URL(env.PIP_PROXY);
    const user = url.username ? `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}` : '';
    return new Promise((resolve, reject) => {
      const outgoing = httpRequest(
        {
          host: url.hostname,
          port: Number(url.port),
          method: 'GET',
          path: 'http://index.example/simple/',
          headers: user ? { 'proxy-authorization': 'Basic ' + Buffer.from(user).toString('base64') } : {},
          agent: false,
        },
        (response) => {
          response.resume();
          response.on('end', () => resolve());
        }
      );
      outgoing.on('error', reject);
      outgoing.end();
    });
  };
  let installs = 0;
  /** A name install of a package of its own, so each one changes something. */
  const nameInstall = async (extra: Record<string, unknown> = {}): Promise<ExtensionReply> => {
    installs += 1;
    const name = `demo-${String(installs)}`;
    const wheel = await writeWheel(path.join(scratch, 'wheels'), { name });
    runtime.install = async (venv, _wheel, spec) => {
      await throughProxy(spec.env);
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
  /** The credentials stay with the relay: never in an argument, an environment, a reply or a log. */
  const expectNowhere = (replies: unknown[]): void => {
    for (const call of spawn.calls)
      for (const secret of SECRETS) {
        expect(call.args.join(' ')).not.toContain(secret);
        expect(Object.values(call.env).join(' ')).not.toContain(secret);
      }
    const seen = JSON.stringify([replies, logged]);
    for (const secret of SECRETS) expect(seen).not.toContain(secret);
  };
  const refusedConnection = async (url: string): Promise<boolean> => {
    const socket = connect({ host: '127.0.0.1', port: Number(new URL(url).port) });
    const [outcome] = await Promise.race([once(socket, 'connect').then(() => ['open']), once(socket, 'error')]);
    socket.destroy();
    return outcome !== 'open';
  };

  describe('with a keychain', () => {
    let vault: ReturnType<typeof fakeKeychain>;
    beforeEach(() => {
      vault = fakeKeychain();
      service = start({ proxyVault: vault });
    });

    it('saves credentials typed into the proxy, sealed, and signs in through the relay only', async () => {
      const saved = data<ExtensionSettingsState>(
        await request({ action: 'set_settings', settings: { proxy: typedWith(proxy, CREDENTIALS) } })
      );
      expect(saved).toMatchObject({
        settings: { proxy, proxyAuthentication: true },
        credentialMode: 'keychain',
        hasSavedCredentials: true,
      });
      const stored = JSON.parse(await readFile(path.join(root, 'settings.json'), 'utf8')) as Record<string, unknown>;
      expect(stored.proxy).toBe(proxy);
      expect(stored.proxyCredentialId).toMatch(/^[0-9a-f]{32}$/);
      expect(await seals()).toEqual([`proxy-credentials-${String(stored.proxyCredentialId)}.json`]);

      const state = await settle(await nameInstall());
      expect(state).toMatchObject({ phase: 'switched' });
      expect(signIns).toEqual([basic(CREDENTIALS)]);
      // The installer had the relay and its token, for pip and for Git, and a helper reset for it.
      const env = installer()?.env ?? {};
      expect(env.PIP_PROXY).toMatch(/^http:\/\/run:[0-9a-f]{64}@127\.0\.0\.1:[0-9]+$/);
      for (const name of ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'GIT_CONFIG_VALUE_1'])
        expect(env[name]).toBe(env.PIP_PROXY);
      const last = String(Number(env.GIT_CONFIG_COUNT) - 1);
      expect(env[`GIT_CONFIG_KEY_${last}`]).toBe(`credential.http://${new URL(env.PIP_PROXY).host}.helper`);
      expect(env[`GIT_CONFIG_VALUE_${last}`]).toBe('');
      // The relay ended with the change.
      expect(await refusedConnection(env.PIP_PROXY)).toBe(true);
      expectNowhere([saved, state, await settings(), await request({ action: 'list' })]);
      expect(await writtenLeaks()).toEqual([]);
    });

    it('drops saved credentials when the proxy is turned off or changes scheme, host or port', async () => {
      const port = new URL(proxy).port;
      for (const change of [
        { proxy: null },
        { proxy: `http://127.0.0.1:${String(Number(port) === 65535 ? 1 : Number(port) + 1)}` },
        { proxy: `http://localhost:${port}` },
        { proxy: `https://127.0.0.1:${port}` },
      ]) {
        data(await request({ action: 'set_settings', settings: { proxy } }));
        data(await request({ action: 'set_proxy_credentials', credentials: CREDENTIALS }));
        expect(await settings()).toMatchObject({ hasSavedCredentials: true, settings: { proxyAuthentication: true } });
        const after = data<ExtensionSettingsState>(await request({ action: 'set_settings', settings: change }));
        expect(after).toMatchObject({ hasSavedCredentials: false, settings: { proxyAuthentication: false } });
        expect(await seals()).toEqual([]);
      }
      // The same proxy again keeps them; turning authentication off drops them.
      data(await request({ action: 'set_settings', settings: { proxy } }));
      data(await request({ action: 'set_proxy_credentials', credentials: CREDENTIALS }));
      expect(
        data<ExtensionSettingsState>(await request({ action: 'set_settings', settings: { proxy } }))
      ).toMatchObject({ hasSavedCredentials: true });
      expect(
        data<ExtensionSettingsState>(
          await request({ action: 'set_settings', settings: { proxyAuthentication: false } })
        )
      ).toMatchObject({ hasSavedCredentials: false });
      expect(await seals()).toEqual([]);
    });

    it('refuses typed credentials with authentication turned off in the same change', async () => {
      const reply = await request({
        action: 'set_settings',
        settings: { proxy: typedWith(proxy, CREDENTIALS), proxyAuthentication: false },
      });
      expect(reply).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
      expectNowhere([reply]);
      expect(await seals()).toEqual([]);
    });

    it('refuses to save credentials without a proxy or readable settings, and removes a stray sealed file', async () => {
      expect(await request({ action: 'set_proxy_credentials', credentials: CREDENTIALS })).toMatchObject({
        ok: false,
        code: 'INVALID_INPUT',
      });
      data(await request({ action: 'set_settings', settings: { proxy } }));
      data(await request({ action: 'set_proxy_credentials', credentials: CREDENTIALS }));
      expect(await seals()).toHaveLength(1);
      await writeFile(path.join(root, 'settings.json'), '{ not json');
      // Unreadable settings name no sealed file: the next change removes it, then refuses.
      expect(await request({ action: 'set_proxy_credentials', credentials: CREDENTIALS })).toMatchObject({
        ok: false,
        code: 'SETTINGS_UNREADABLE',
      });
      expect(await seals()).toEqual([]);
      data(await request({ action: 'set_settings', settings: { onlineInstall: true, proxy, privateGit: false } }));
      expect(await settings()).toMatchObject({ hasSavedCredentials: false, settings: { proxyAuthentication: false } });
    });

    it('clears saved credentials and then asks for them, before anything starts', async () => {
      data(await request({ action: 'set_settings', settings: { proxy } }));
      data(await request({ action: 'set_proxy_credentials', credentials: CREDENTIALS }));
      const cleared = data<ExtensionSettingsState>(await request({ action: 'clear_proxy_credentials' }));
      expect(cleared).toMatchObject({ hasSavedCredentials: false, settings: { proxyAuthentication: true } });
      expect(await seals()).toEqual([]);
      const calls = spawn.calls.length;
      expect(await nameInstall()).toEqual({ ok: false, code: 'PROXY_CREDENTIALS_REQUIRED' });
      expect(spawn.calls.length).toBe(calls);
    });

    it('takes credentials of the request over saved ones, for that install only', async () => {
      const kept = { username: 'saved', password: 'saved-pass' };
      data(await request({ action: 'set_settings', settings: { proxy } }));
      data(await request({ action: 'set_proxy_credentials', credentials: kept }));
      expect(await settle(await nameInstall({ proxyCredentials: CREDENTIALS }))).toMatchObject({ phase: 'switched' });
      expect(signIns).toEqual([basic(CREDENTIALS)]);
      expect(vault.opened).toBe(0);
      // The saved ones are untouched and used next time.
      expect(await settle(await nameInstall())).toMatchObject({ phase: 'switched' });
      expect(signIns).toEqual([basic(CREDENTIALS), basic(kept)]);
    });

    it('asks again when the keychain can no longer open what it sealed', async () => {
      data(await request({ action: 'set_settings', settings: { proxy } }));
      data(await request({ action: 'set_proxy_credentials', credentials: CREDENTIALS }));
      vault.broken = true;
      const state = await settle(await nameInstall());
      expect(state).toMatchObject({ phase: 'failed', code: 'PROXY_CREDENTIALS_REQUIRED' });
      expect(installer()).toBeUndefined();
      expect(signIns).toEqual([]);
      expectNowhere([state]);
    });

    it('keeps working credentials when a save is interrupted before the settings name the new file', async () => {
      const old = { username: 'old', password: 'old-pass' };
      data(await request({ action: 'set_settings', settings: { proxy } }));
      data(await request({ action: 'set_proxy_credentials', credentials: old }));
      runtime.holderFails = (holder) => holder.op === 'replace' && holder.to === 'settings.json';
      expect((await request({ action: 'set_proxy_credentials', credentials: CREDENTIALS })).ok).toBe(false);
      runtime.holderFails = undefined;
      expect(await seals()).toHaveLength(2);
      expect(await settings()).toMatchObject({ hasSavedCredentials: true });
      // The next change removes the file nothing names, and signs in with the old credentials.
      expect(await settle(await nameInstall())).toMatchObject({ phase: 'switched' });
      expect(signIns).toEqual([basic(old)]);
      expect(await seals()).toHaveLength(1);
    });

    it('removes the older file at the next change when a save is interrupted after the settings', async () => {
      data(await request({ action: 'set_settings', settings: { proxy } }));
      data(await request({ action: 'set_proxy_credentials', credentials: { username: 'old', password: 'old-pass' } }));
      runtime.holderFails = (holder) => holder.op === 'remove' && SEALED.test(String(holder.path));
      expect((await request({ action: 'set_proxy_credentials', credentials: CREDENTIALS })).ok).toBe(false);
      runtime.holderFails = undefined;
      expect(await seals()).toHaveLength(2);
      expect(await settle(await nameInstall())).toMatchObject({ phase: 'switched' });
      expect(signIns).toEqual([basic(CREDENTIALS)]);
      const named = JSON.parse(await readFile(path.join(root, 'settings.json'), 'utf8')) as {
        proxyCredentialId: string;
      };
      expect(await seals()).toEqual([`proxy-credentials-${named.proxyCredentialId}.json`]);
    });
  });

  describe('without a keychain', () => {
    beforeEach(() => {
      service = start();
    });

    it('refuses to save credentials, and turns authentication on without keeping those typed into the proxy', async () => {
      data(await request({ action: 'set_settings', settings: { proxy } }));
      expect(await request({ action: 'set_proxy_credentials', credentials: CREDENTIALS })).toEqual({
        ok: false,
        code: 'PROXY_CREDENTIALS_NOT_STORED',
      });
      const typed = data<ExtensionSettingsState>(
        await request({ action: 'set_settings', settings: { proxy: typedWith(proxy, CREDENTIALS) } })
      );
      expect(typed).toMatchObject({
        settings: { proxy, proxyAuthentication: true },
        credentialMode: 'memory-only',
        hasSavedCredentials: false,
      });
      expect(await seals()).toEqual([]);
      expect(await writtenLeaks()).toEqual([]);
    });

    it('answers a missing credential with a code the screen can ask on, before anything starts', async () => {
      data(await request({ action: 'set_settings', settings: { proxy, proxyAuthentication: true } }));
      const calls = spawn.calls.length;
      expect(await nameInstall()).toEqual({ ok: false, code: 'PROXY_CREDENTIALS_REQUIRED' });
      expect(spawn.calls.length).toBe(calls);
    });

    it('signs in with credentials of the request through the relay and keeps nothing of them', async () => {
      data(await request({ action: 'set_settings', settings: { proxy, proxyAuthentication: true } }));
      const state = await settle(await nameInstall({ proxyCredentials: CREDENTIALS }));
      expect(state).toMatchObject({ phase: 'switched' });
      expect(signIns).toEqual([basic(CREDENTIALS)]);
      expectNowhere([state, await settings(), await request({ action: 'list' })]);
      expect(await writtenLeaks()).toEqual([]);
      // The next install asks again.
      expect(await nameInstall()).toEqual({ ok: false, code: 'PROXY_CREDENTIALS_REQUIRED' });
    });

    it('sends credentials of the request nowhere when the proxy changed before the change began', async () => {
      data(await request({ action: 'set_settings', settings: { proxy, proxyAuthentication: true } }));
      // Another Studio process saves another proxy between the early check and the lock.
      beforeLock = () =>
        writeFileSync(
          path.join(root, 'settings.json'),
          JSON.stringify({
            schema: 'aelix.studio.extensions.settings/1',
            onlineInstall: true,
            proxy: 'http://127.0.0.1:9',
            privateGit: false,
            proxyAuthentication: true,
            proxyCredentialId: null,
          })
        );
      const reply = await nameInstall({ proxyCredentials: CREDENTIALS });
      const state = await settle(reply);
      expect(state).toMatchObject({ phase: 'failed', code: 'PROXY_CHANGED' });
      expect(installer()).toBeUndefined();
      expect(signIns).toEqual([]);
      expectNowhere([reply, state]);
    });

    it('drops what a keychain saved for the proxy when credentials are typed or sent here', async () => {
      const keychain = start({ proxyVault: fakeKeychain() });
      const old = { username: 'old', password: 'old-pass' };
      try {
        data(await keychain.request('window:1', { action: 'set_settings', settings: { proxy } }));
        data(await keychain.request('window:1', { action: 'set_proxy_credentials', credentials: old }));
        expect(await seals()).toHaveLength(1);
        // Typed into the address of the same proxy.
        data(await request({ action: 'set_settings', settings: { proxy: typedWith(proxy, CREDENTIALS) } }));
        expect(await seals()).toEqual([]);
        // Sent with an install.
        data(await keychain.request('window:1', { action: 'set_proxy_credentials', credentials: old }));
        expect(await seals()).toHaveLength(1);
        expect(await settle(await nameInstall({ proxyCredentials: CREDENTIALS }))).toMatchObject({ phase: 'switched' });
        expect(signIns).toEqual([basic(CREDENTIALS)]);
        expect(await seals()).toEqual([]);
        expect(
          data<ExtensionSettingsState>(await keychain.request('window:1', { action: 'get_settings' }))
        ).toMatchObject({ hasSavedCredentials: false, settings: { proxyAuthentication: true } });
      } finally {
        await keychain.dispose();
      }
    });

    it('refuses credentials past printable ASCII, typed, saved or sent, without repeating them', async () => {
      // pip sends proxy Basic auth as Latin-1 and fails past it; Git sends UTF-8 (user decision 2026-11-22).
      const keychain = start({ proxyVault: fakeKeychain() });
      try {
        data(await keychain.request('window:1', { action: 'set_settings', settings: { proxy } }));
        data(await request({ action: 'set_settings', settings: { proxy, proxyAuthentication: true } }));
        const address = proxy.replace('http://', '');
        const refused = [
          ...(await Promise.all(
            [
              `http://ops:p%C3%A4ssw%C3%B6rt@${address}`,
              `http://ops:pässwört@${address}`,
              `http://ops:p%E4ssw%F6rt@${address}`,
              `http://ops:pa ss@${address}`,
              `http://op%3As:secret@${address}`,
            ].map((typed) => keychain.request('window:1', { action: 'set_settings', settings: { proxy: typed } }))
          )),
          await keychain.request('window:1', {
            action: 'set_proxy_credentials',
            credentials: { username: 'ops', password: 'pässwört' },
          }),
          await nameInstall({ proxyCredentials: { username: 'ops', password: '비밀번호' } }),
          await nameInstall({ proxyCredentials: { username: 'öps', password: 'secret' } }),
          await nameInstall({ proxyCredentials: { username: 'op:s', password: 'secret' } }),
        ];
        for (const reply of refused)
          expect(reply).toEqual({ ok: false, code: 'INVALID_INPUT', detail: expect.any(Array) });
        expect(JSON.stringify(refused)).not.toMatch(/ops|op:s|pässwört|p%C3%A4ssw|p%E4ss|비밀번호|öps|secret/);
        expect(await seals()).toEqual([]);
        expect(installer()).toBeUndefined();
      } finally {
        await keychain.dispose();
      }
    });

    it('refuses credentials sent without a proxy, with a file import or with an update', async () => {
      const noProxy = await nameInstall({ proxyCredentials: CREDENTIALS });
      expect(noProxy).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
      data(await request({ action: 'set_settings', settings: { proxy } }));
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
      expectNowhere([noProxy, file, update]);
    });

    it('keeps a proxy without authentication working as before, and no proxy isolated as before', async () => {
      data(await request({ action: 'set_settings', settings: { proxy } }));
      expect(await settle(await nameInstall())).toMatchObject({ phase: 'switched' });
      expect(installer()?.env.PIP_PROXY).toBe(proxy);
      expect(signIns).toEqual([undefined]);
      expect(Object.values(installer()?.env ?? {})).not.toContain(`credential.${proxy}.helper`);
      data(await request({ action: 'set_settings', settings: { proxy: null } }));
      expect(await settle(await nameInstall())).toMatchObject({ phase: 'switched' });
      expect(installer()?.env).not.toHaveProperty('PIP_PROXY');
      expect(installer()?.env.no_proxy).toBe('*');
    });
  });
});
