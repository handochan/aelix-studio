import { randomBytes } from 'node:crypto';
import { constants, lstat, open } from 'node:fs/promises';
import path from 'node:path';
import { writeTemporary, type Layout } from '../../store/layout.js';
import type { StateWriter } from '../../store/lock.js';
import { ExtensionFailure, type ProxyCredentialMode, type ProxyCredentials } from '../../types.js';

/**
 * Proxy credentials (Studio #32, after 1b): a user name and password for the proxy of the
 * extension settings.
 *
 * Only the Electron main process can keep them: it has `safeStorage`, which encrypts with the
 * OS keychain. The helper runs in web-host and does not import Electron, so the host hands it
 * a vault. With a `keychain` vault the credentials are sealed and stored in
 * `<root>/proxy-credentials.json`, next to `settings.json` and written the same way: a flushed
 * temporary file the lock holder renames, under the mutation lock. With a `memory-only` vault
 * (the standalone WebUI, a Linux desktop without a secret store) nothing is stored: each
 * online install brings them and they last as long as that change.
 *
 * The plain credentials are never written anywhere: not to `settings.json` (which holds only
 * an id that ties the sealed file to the current proxy), not to a generation record, a reply,
 * a log or an error. pip and Git get them in the environment only, inside the proxy URL.
 */

/** What the host offers for keeping proxy credentials. */
export type ProxyCredentialVault =
  | {
      mode: 'keychain';
      /** Encrypt for this user and app (Electron `safeStorage.encryptString`). */
      seal(text: string): Buffer;
      /** Decrypt what `seal` produced (Electron `safeStorage.decryptString`); throws when it cannot. */
      open(sealed: Buffer): string;
    }
  | { mode: 'memory-only' };

export const MEMORY_ONLY_VAULT: ProxyCredentialVault = Object.freeze({ mode: 'memory-only' as const });

export const credentialMode = (vault: ProxyCredentialVault): ProxyCredentialMode => vault.mode;

const SCHEMA = 'aelix.studio.extensions.proxy-credentials/1';
const SIZE_LIMIT = 16 * 1024;
const CREDENTIAL_ID = /^[0-9a-f]{32}$/;

/** A new id for saved credentials. Settings hold it; the sealed file must carry the same one. */
export const newCredentialId = (): string => randomBytes(16).toString('hex');

export const isCredentialId = (value: unknown): value is string =>
  typeof value === 'string' && CREDENTIAL_ID.test(value);

/**
 * Printable ASCII only. pip (requests) encodes proxy credentials as Latin-1 and fails on
 * anything outside it, while Git (curl) sends UTF-8: past ASCII the same password reaches the
 * proxy as different bytes, or not at all. Refusing it at entry is clearer than a 407 later.
 */
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

/**
 * A `%` and two hex digits. Git decodes the user part of a proxy URL once and curl decodes it
 * again, so a password holding `%41` reaches the proxy from Git as `A` (seen with Git 2.54 and
 * curl 8.7.1), while pip decodes once. How often depends on the versions, so the value is
 * kept free of what a second decode would change: then once and twice give the same text.
 */
const PERCENT_ESCAPE = /%[0-9A-Fa-f]{2}/;

const acceptable = (text: string): boolean => PRINTABLE_ASCII.test(text) && !PERCENT_ESCAPE.test(text);

/**
 * Check credentials from a request or a typed proxy address. They are kept as typed (decoded);
 * `proxyWithCredentials` encodes them. Nothing of them appears in a failure.
 *
 * @throws ExtensionFailure `INVALID_INPUT`
 */
export function parseProxyCredentials(value: unknown): ProxyCredentials {
  const invalid = (): ExtensionFailure =>
    new ExtensionFailure('INVALID_INPUT', [
      'proxy credentials need a user name, both in printable ASCII and without a % followed by two hex digits',
    ]);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalid();
  const { username, password, ...rest } = value as Record<string, unknown>;
  if (Object.keys(rest).length > 0) throw invalid();
  if (typeof username !== 'string' || username.length === 0 || username.length > 256 || !acceptable(username))
    throw invalid();
  if (typeof password !== 'string' || password.length > 1024 || !acceptable(password)) throw invalid();
  return { username, password };
}

/**
 * The proxy URL pip and Git get: the stored `<scheme>//<host>[:port]` with the credentials as
 * its user part, each percent-encoded (`encodeURIComponent`), so `:`, `@`, `%`, `/` and the
 * rest of a password reach the proxy as typed. pip (requests) and Git (curl) decode it.
 */
export function proxyWithCredentials(proxy: string, credentials: ProxyCredentials): string {
  const at = proxy.indexOf('//') + 2;
  const user = `${encodeURIComponent(credentials.username)}:${encodeURIComponent(credentials.password)}`;
  return `${proxy.slice(0, at)}${user}@${proxy.slice(at)}`;
}

type SealedFile = { id: string; proxy: string; sealed: Buffer };

/** Read the sealed file without following a link; undefined when it is missing or not Studio's. */
async function readSealed(layout: Layout): Promise<SealedFile | undefined> {
  try {
    if (!(await lstat(layout.proxyCredentials)).isFile()) return undefined;
    const handle = await open(layout.proxyCredentials, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let text: string;
    try {
      const stats = await handle.stat();
      if (!stats.isFile() || stats.size > SIZE_LIMIT) return undefined;
      text = await handle.readFile('utf8');
    } finally {
      await handle.close();
    }
    const value = JSON.parse(text) as Record<string, unknown>;
    if (value?.schema !== SCHEMA || !isCredentialId(value.id) || typeof value.proxy !== 'string') return undefined;
    if (typeof value.sealed !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.sealed)) return undefined;
    return { id: value.id, proxy: value.proxy, sealed: Buffer.from(value.sealed, 'base64') };
  } catch {
    return undefined;
  }
}

/** Whether sealed credentials exist for this proxy and this settings id. Reads the file only; decrypts nothing. */
export async function hasSavedCredentials(
  layout: Layout,
  vault: ProxyCredentialVault,
  proxy: string | null,
  id: string | null
): Promise<boolean> {
  if (vault.mode !== 'keychain' || proxy === null || id === null) return false;
  const sealed = await readSealed(layout);
  return sealed?.id === id && sealed.proxy === proxy;
}

/**
 * Open saved credentials for this proxy and settings id. Undefined when there are none, they
 * belong to another proxy or another save, or the keychain cannot open them (a changed
 * keychain, say): then the user is asked again.
 */
export async function openSavedCredentials(
  layout: Layout,
  vault: ProxyCredentialVault,
  proxy: string | null,
  id: string | null
): Promise<ProxyCredentials | undefined> {
  if (vault.mode !== 'keychain' || proxy === null || id === null) return undefined;
  const sealed = await readSealed(layout);
  if (sealed?.id !== id || sealed.proxy !== proxy) return undefined;
  try {
    return parseProxyCredentials(JSON.parse(vault.open(sealed.sealed)));
  } catch {
    return undefined;
  }
}

/**
 * Seal and store credentials for `proxy` under a new id, which the caller then writes into the
 * settings. Call under the mutation lock with its holder as `writer`.
 *
 * @throws ExtensionFailure `PROXY_CREDENTIALS_NOT_STORED` for a memory-only vault
 */
export async function saveProxyCredentials(
  layout: Layout,
  vault: ProxyCredentialVault,
  proxy: string,
  credentials: ProxyCredentials,
  writer: StateWriter
): Promise<string> {
  if (vault.mode !== 'keychain')
    throw new ExtensionFailure('PROXY_CREDENTIALS_NOT_STORED', ['proxy credentials are not kept here']);
  const id = newCredentialId();
  const sealed = vault.seal(JSON.stringify(credentials)).toString('base64');
  const content = JSON.stringify({ schema: SCHEMA, id, proxy, sealed }, null, 2) + '\n';
  const temporary = await writeTemporary(layout.proxyCredentials, content);
  await writer.replace(path.basename(temporary), path.basename(layout.proxyCredentials));
  return id;
}

/** Remove stored credentials, if any. Call under the mutation lock with its holder as `writer`. */
export async function dropProxyCredentials(layout: Layout, writer: StateWriter): Promise<void> {
  await writer.remove(path.basename(layout.proxyCredentials));
}
