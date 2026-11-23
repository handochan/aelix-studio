import { randomBytes } from 'node:crypto';
import { constants, lstat, open, readdir } from 'node:fs/promises';
import path from 'node:path';
import { writeTemporary, type Layout } from '../../../store/layout.js';
import type { StateWriter } from '../../../store/lock.js';
import { ExtensionFailure, type ProxyCredentialMode, type ProxyCredentials } from '../../../types.js';

/**
 * Proxy credentials (Studio #32, after 1b): a user name and password for the proxy of the
 * extension settings.
 *
 * Only the Electron main process can keep them: it has `safeStorage`, which encrypts with the
 * OS keychain. The helper runs in web-host and does not import Electron, so the host hands it
 * a vault. With a `keychain` vault the credentials are sealed and stored in
 * `<root>/proxy-credentials-<id>.json`, next to `settings.json` and written the same way: a
 * flushed owner-only temporary file the lock holder renames, under the mutation lock. With a
 * `memory-only` vault (the standalone WebUI, a Linux desktop without a secret store) nothing
 * is stored: each online install brings them and they last as long as that change.
 *
 * The plain credentials are never written anywhere: not to `settings.json` (which holds only
 * the id of the sealed file), not to a generation record, a reply, a log or an error. No
 * installer sees them either: the change relays its installers through a loopback proxy of
 * its own (`relay.ts`), which signs in to the user's proxy.
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

const SCHEMA = 'aelix.studio.extensions.proxy-credentials/2';
const SIZE_LIMIT = 16 * 1024;
const CREDENTIAL_ID = /^[0-9a-f]{32}$/;
/** One sealed file per save, named by its id, so a new save never overwrites the one in use. */
const SEALED_NAME = /^proxy-credentials-([0-9a-f]{32})\.json$/;

/** A new id for saved credentials. Settings hold it; the sealed file is named by it and carries it inside. */
export const newCredentialId = (): string => randomBytes(16).toString('hex');

export const isCredentialId = (value: unknown): value is string =>
  typeof value === 'string' && CREDENTIAL_ID.test(value);

const sealedFile = (layout: Layout, id: string): string => path.join(layout.root, `proxy-credentials-${id}.json`);

/**
 * Printable ASCII only (2026-11-22 user decision). The relay sends the credentials as they
 * were entered in the Basic value. RFC 7617 leaves the default encoding unspecified, beyond
 * being compatible with ASCII, and defines only `UTF-8` as a value of its optional `charset`
 * parameter (section 2.1): past ASCII, proxies read the same bytes differently. Refusing the
 * rest at entry is clearer than a 407 later.
 */
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

const acceptable = (text: string): boolean => PRINTABLE_ASCII.test(text);

/** The one answer to unusable credentials, wherever they come from. It never repeats them. */
export const invalidCredentials = (): ExtensionFailure =>
  new ExtensionFailure('INVALID_INPUT', [
    'proxy credentials need a user name without a colon, and both in printable ASCII',
  ]);

/**
 * Check credentials from a request (taken as they are) or a typed proxy address (decoded
 * once, as a URL's user part).
 * The user name may not hold a colon: Basic authentication splits at the first one (RFC 7617
 * section 2). Nothing of them appears in a failure.
 *
 * @throws ExtensionFailure `INVALID_INPUT`
 */
export function parseProxyCredentials(value: unknown): ProxyCredentials {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalidCredentials();
  const { username, password, ...rest } = value as Record<string, unknown>;
  if (Object.keys(rest).length > 0) throw invalidCredentials();
  if (
    typeof username !== 'string' ||
    username.length === 0 ||
    username.length > 256 ||
    username.includes(':') ||
    !acceptable(username)
  )
    throw invalidCredentials();
  if (typeof password !== 'string' || password.length > 1024 || !acceptable(password)) throw invalidCredentials();
  return { username, password };
}

type SealedFile = { proxy: string; sealed: Buffer };

/**
 * Read the sealed file of `id` without following a link; undefined when it is missing, not
 * Studio's, or open to anyone but its owner (on POSIX: no group or other permission bits, and
 * owned by this user). Such a file is not used, and the user is asked again.
 */
async function readSealed(layout: Layout, id: string): Promise<SealedFile | undefined> {
  const file = sealedFile(layout, id);
  try {
    if (!(await lstat(file)).isFile()) return undefined;
    const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let text: string;
    try {
      const stats = await handle.stat();
      if (!stats.isFile() || stats.size > SIZE_LIMIT) return undefined;
      if (process.platform !== 'win32' && ((stats.mode & 0o077) !== 0 || stats.uid !== process.getuid?.()))
        return undefined;
      text = await handle.readFile('utf8');
    } finally {
      await handle.close();
    }
    const value = JSON.parse(text) as Record<string, unknown>;
    if (value?.schema !== SCHEMA || value.id !== id || typeof value.proxy !== 'string') return undefined;
    if (typeof value.sealed !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.sealed)) return undefined;
    return { proxy: value.proxy, sealed: Buffer.from(value.sealed, 'base64') };
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
  return (await readSealed(layout, id))?.proxy === proxy;
}

/**
 * Open saved credentials for this proxy and settings id. The id and the proxy are inside the
 * sealed text too and must match there, so a file renamed or edited around its sealed bytes
 * is not used. Undefined when there are none, they belong to another proxy or another save,
 * or the keychain cannot open them (a changed keychain, say): then the user is asked again.
 */
export async function openSavedCredentials(
  layout: Layout,
  vault: ProxyCredentialVault,
  proxy: string | null,
  id: string | null
): Promise<ProxyCredentials | undefined> {
  if (vault.mode !== 'keychain' || proxy === null || id === null) return undefined;
  const sealed = await readSealed(layout, id);
  if (sealed?.proxy !== proxy) return undefined;
  try {
    const inner = JSON.parse(vault.open(sealed.sealed)) as Record<string, unknown>;
    if (inner?.id !== id || inner.proxy !== proxy) return undefined;
    return parseProxyCredentials({ username: inner.username, password: inner.password });
  } catch {
    return undefined;
  }
}

/**
 * Seal and store credentials for `proxy` under a new id, in a file of their own, and return
 * the id. The caller writes the id into the settings and only after that drops the older
 * sealed files, so an interruption in between leaves settings that name a file that opens.
 * Call under the mutation lock with its holder as `writer`.
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
  let sealed: string;
  try {
    sealed = vault.seal(JSON.stringify({ id, proxy, ...credentials })).toString('base64');
  } catch {
    // The OS keychain refused (access denied, locked, unavailable): nothing is kept.
    throw new ExtensionFailure('PROXY_CREDENTIALS_NOT_STORED', ['the keychain did not keep the credentials']);
  }
  const file = sealedFile(layout, id);
  const temporary = await writeTemporary(file, JSON.stringify({ schema: SCHEMA, id, proxy, sealed }, null, 2) + '\n');
  await writer.replace(path.basename(temporary), path.basename(file));
  return id;
}

/**
 * Remove every sealed file but the one of `keep` (all of them for null). Runs after the
 * settings are written, and at the start of every change for what an interruption left: there
 * `keep` is the id the stored settings name. Call under the mutation lock with its holder as
 * `writer`.
 */
export async function dropProxyCredentials(layout: Layout, writer: StateWriter, keep: string | null): Promise<void> {
  const entries = await readdir(layout.root).catch(() => [] as string[]);
  for (const entry of entries) {
    const id = SEALED_NAME.exec(entry)?.[1];
    // oxlint-disable-next-line no-await-in-loop -- the lock holder removes one entry at a time
    if (id !== undefined && id !== keep) await writer.remove(entry);
  }
}
