import { constants, lstat, open } from 'node:fs/promises';
import path from 'node:path';
import { writeTemporary, type Layout } from '../../store/layout.js';
import type { StateWriter } from '../../store/lock.js';
import { ExtensionFailure, type ExtensionSettings, type ProxyCredentials } from '../../types.js';
import { invalidCredentials, isCredentialId, parseProxyCredentials } from './proxy/credentials.js';

/**
 * The user's extension settings (Studio #32 1b, ADR 5.10): whether online installs are on,
 * the one proxy they use and whether git installs may use the user's own Git and SSH access.
 *
 * They live in `<root>/settings.json`. Like the pointer, the file is only ever replaced whole:
 * the new content is flushed to a temporary file and the lock holder renames it into place,
 * under the mutation lock. A reader therefore sees one complete version or the other, and a
 * change, which reads the settings once after taking the lock, keeps that version to its end.
 *
 * Proxy credentials are not settings: `settings.json` holds only `proxyAuthentication` (the
 * proxy asks for them) and the id of the sealed copy, if the desktop saved one
 * (`proxy/credentials.ts`). A file written before credentials existed has neither and reads as
 * a proxy without authentication.
 */

const SETTINGS_SCHEMA = 'aelix.studio.extensions.settings/1';
const SIZE_LIMIT = 64 * 1024;

/** The authority of a proxy as typed: a host name or a bracketed IPv6 address, and an optional port. */
const PROXY_AUTHORITY = /^(?:\[[0-9a-f:.]+\]|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::(\d{1,5}))?$/i;

/** What applies until the user changes anything. */
export const DEFAULT_SETTINGS: Readonly<ExtensionSettings> = Object.freeze({
  onlineInstall: true,
  proxy: null,
  privateGit: false,
  proxyAuthentication: false,
});

/** What applies while the stored file cannot be read: nothing online, nothing private. */
const CLOSED_SETTINGS: Readonly<ExtensionSettings> = Object.freeze({
  onlineInstall: false,
  proxy: null,
  privateGit: false,
  proxyAuthentication: false,
});

export type StoredSettings = {
  settings: ExtensionSettings;
  unreadable: boolean;
  /** The id of the sealed proxy credentials these settings refer to, or null. Never sent to a screen. */
  credentialId: string | null;
};

/** A settings change from a request, with credentials split off a typed proxy address. */
export type SettingsChange = { settings: Partial<ExtensionSettings>; credentials?: ProxyCredentials };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const invalidProxy = (): ExtensionFailure =>
  new ExtensionFailure('INVALID_PROXY', ['the proxy must be an http:// or https:// address of a host and a port']);

/**
 * A proxy address as typed: the stored form `<scheme>//<host>[:port]`, and the credentials of
 * a `user:password@` part, percent-decoded. Only `http:` and `https:` proxies of a host and an
 * optional port are taken. Nothing of the address appears in a failure, so a password never
 * reaches a reply or a log.
 *
 * @throws ExtensionFailure `INVALID_PROXY`, or `INVALID_INPUT` for credentials that cannot be used
 */
export function parseProxyInput(value: unknown): { proxy: string; credentials?: ProxyCredentials } {
  if (typeof value !== 'string' || value.length > 2048) throw invalidProxy();
  const scheme = /^(https?):\/\//i.exec(value);
  if (!scheme) throw invalidProxy();
  // Look at the authority as typed, before URL parsing: it drops an empty user part such as
  // `http://@host` and skips extra slashes, so `http:///user:pass@host` would lose the
  // credentials without a trace. Only a plain host and port are taken; nothing is repaired.
  const authority = value.slice(scheme[0].length).split(/[/?#]/, 1)[0];
  const at = authority.lastIndexOf('@');
  // The user part is checked as credentials below; the rest as an address.
  // oxlint-disable-next-line no-control-regex -- reject characters URL parsing can silently discard.
  if (/[\s\\\x00-\x1f\x7f]/.test(value.slice(0, scheme[0].length) + value.slice(scheme[0].length + at + 1)))
    throw invalidProxy();
  const typed = PROXY_AUTHORITY.exec(authority.slice(at + 1));
  if (!typed) throw invalidProxy();
  if (typed[1] !== undefined && (Number(typed[1]) < 1 || Number(typed[1]) > 65535)) throw invalidProxy();
  const rest = value.slice(scheme[0].length + authority.length);
  const url = URL.parse(`${scheme[0]}${authority.slice(at + 1)}${rest}`);
  if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname) throw invalidProxy();
  if ((url.pathname !== '' && url.pathname !== '/') || url.search || url.hash) throw invalidProxy();
  const proxy = `${url.protocol}//${url.host}`;
  return at < 0 ? { proxy } : { proxy, credentials: parseUserPart(authority.slice(0, at)) };
}

/**
 * The `user:password` part of a typed proxy address, decoded. What breaks the credentials
 * rule (past printable ASCII, typed as is or percent-encoded) is answered as credentials,
 * `INVALID_INPUT`, like everywhere else; what breaks the address (an empty user name, a
 * space or backslash typed as is, a `%` without two hex digits) as `INVALID_PROXY`.
 */
function parseUserPart(user: string): ProxyCredentials {
  if (user === '' || user.startsWith(':')) throw invalidProxy();
  if (!/^[\x20-\x7e]*$/.test(user)) throw invalidCredentials();
  if (/[ \\]/.test(user)) throw invalidProxy();
  const colon = user.indexOf(':');
  return parseProxyCredentials({
    username: percentDecoded(colon < 0 ? user : user.slice(0, colon)),
    password: colon < 0 ? '' : percentDecoded(user.slice(colon + 1)),
  });
}

/** Percent-decode byte by byte: an encoded byte past printable ASCII is refused as credentials. */
function percentDecoded(text: string): string {
  let decoded = '';
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== '%') {
      decoded += text[index];
      continue;
    }
    const hex = text.slice(index + 1, index + 3);
    if (!/^[0-9A-Fa-f]{2}$/.test(hex)) throw invalidProxy();
    const byte = Number.parseInt(hex, 16);
    if (byte < 0x20 || byte > 0x7e) throw invalidCredentials();
    decoded += String.fromCharCode(byte);
    index += 2;
  }
  return decoded;
}

/**
 * The proxy in the one form Studio stores: `<scheme>//<host>[:port]`, with no user part.
 *
 * @throws ExtensionFailure `INVALID_PROXY`
 */
export function normalizeProxy(value: unknown): string {
  const parsed = parseProxyInput(value);
  if (parsed.credentials) throw invalidProxy();
  return parsed.proxy;
}

function parseStored(text: string): { settings: ExtensionSettings; credentialId: string | null } | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isObject(value) || value.schema !== SETTINGS_SCHEMA) return undefined;
  const { onlineInstall, proxy, privateGit } = value;
  if (typeof onlineInstall !== 'boolean' || typeof privateGit !== 'boolean') return undefined;
  // Settings from before proxy credentials have neither field: a proxy without authentication.
  const proxyAuthentication = value.proxyAuthentication ?? false;
  const credentialId = value.proxyCredentialId ?? null;
  if (typeof proxyAuthentication !== 'boolean' || (credentialId !== null && !isCredentialId(credentialId)))
    return undefined;
  if (proxy === null && (proxyAuthentication || credentialId !== null)) return undefined;
  if (proxy !== null) {
    try {
      // A stored proxy is in the normalized form; anything else was not written by Studio.
      if (normalizeProxy(proxy) !== proxy) return undefined;
    } catch {
      return undefined;
    }
  }
  return {
    settings: { onlineInstall, proxy: proxy as string | null, privateGit, proxyAuthentication },
    credentialId: credentialId as string | null,
  };
}

/**
 * Read the stored settings. A missing file means the defaults. A file that cannot be read or
 * was not written by Studio means the closed settings, flagged `unreadable`: a damaged file
 * must not turn online installs back on, nor send them past a proxy the user chose.
 *
 * Reads only; nothing is created. Safe without the lock: the file is replaced whole.
 */
export async function readSettings(layout: Layout): Promise<StoredSettings> {
  const closed = (): StoredSettings => ({ settings: { ...CLOSED_SETTINGS }, unreadable: true, credentialId: null });
  // Only a missing name means the defaults. Studio writes a regular file; a link (even one
  // whose target is gone), a directory or anything else under that name is not its file.
  const entry = await lstat(layout.settings).catch((error: unknown): null | undefined =>
    (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : undefined
  );
  if (entry === null) return { settings: { ...DEFAULT_SETTINGS }, unreadable: false, credentialId: null };
  if (!entry?.isFile()) return closed();
  let text: string;
  try {
    // Not through a link that took the file's place after the check.
    const handle = await open(layout.settings, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const stats = await handle.stat();
      if (!stats.isFile() || stats.size > SIZE_LIMIT) return closed();
      text = await handle.readFile('utf8');
    } finally {
      await handle.close();
    }
  } catch {
    return closed();
  }
  const stored = Buffer.byteLength(text) <= SIZE_LIMIT ? parseStored(text) : undefined;
  return stored ? { ...stored, unreadable: false } : closed();
}

/**
 * Check a settings change from a request: only the known fields, each of its own type. The
 * proxy is normalized here, before any lock is taken or anything is written, and credentials
 * typed into it are split off.
 *
 * @throws ExtensionFailure `INVALID_INPUT` or `INVALID_PROXY`
 */
export function parseSettingsChange(value: unknown): SettingsChange {
  if (!isObject(value)) throw new ExtensionFailure('INVALID_INPUT');
  const known = new Set(['onlineInstall', 'proxy', 'privateGit', 'proxyAuthentication']);
  if (Object.keys(value).some((name) => !known.has(name)) || Object.keys(value).length === 0)
    throw new ExtensionFailure('INVALID_INPUT');
  const change: SettingsChange = { settings: {} };
  for (const name of ['onlineInstall', 'privateGit', 'proxyAuthentication'] as const) {
    if (!Object.hasOwn(value, name)) continue;
    if (typeof value[name] !== 'boolean') throw new ExtensionFailure('INVALID_INPUT');
    change.settings[name] = value[name];
  }
  if (Object.hasOwn(value, 'proxy')) {
    if (value.proxy === null) change.settings.proxy = null;
    else {
      const { proxy, credentials } = parseProxyInput(value.proxy);
      change.settings.proxy = proxy;
      if (credentials) change.credentials = credentials;
    }
  }
  // Answered before any lock; a change that only turns authentication on is checked against the stored proxy.
  if (change.settings.proxy === null && change.settings.proxyAuthentication === true)
    throw new ExtensionFailure('INVALID_INPUT', ['proxy authentication needs a proxy']);
  if (change.credentials && change.settings.proxyAuthentication === false)
    throw new ExtensionFailure('INVALID_INPUT', ['a proxy typed with credentials needs proxy authentication on']);
  return change;
}

/**
 * Replace the stored settings. Call under the mutation lock with its holder as `writer`: the
 * holder renames the flushed temporary file over `settings.json`, so the file cannot change
 * once the lock is gone. A temporary file left by an interruption is removed by recovery.
 */
export async function writeSettings(
  layout: Layout,
  settings: ExtensionSettings,
  credentialId: string | null,
  writer: StateWriter
): Promise<void> {
  const content: Record<string, unknown> = { schema: SETTINGS_SCHEMA, ...settings, proxyCredentialId: credentialId };
  const temporary = await writeTemporary(layout.settings, JSON.stringify(content, null, 2) + '\n');
  await writer.replace(path.basename(temporary), path.basename(layout.settings));
}
