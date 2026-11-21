import { constants, lstat, open } from 'node:fs/promises';
import path from 'node:path';
import { writeTemporary, type Layout } from '../../store/layout.js';
import type { StateWriter } from '../../store/lock.js';
import { ExtensionFailure, type ExtensionSettings } from '../../types.js';

/**
 * The user's extension settings (Studio #32 1b, ADR 5.10): whether online installs are on,
 * the one proxy they use and whether git installs may use the user's own Git and SSH access.
 *
 * They live in `<root>/settings.json`. Like the pointer, the file is only ever replaced whole:
 * the new content is flushed to a temporary file and the lock holder renames it into place,
 * under the mutation lock. A reader therefore sees one complete version or the other, and a
 * change, which reads the settings once after taking the lock, keeps that version to its end.
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
});

/** What applies while the stored file cannot be read: nothing online, nothing private. */
const CLOSED_SETTINGS: Readonly<ExtensionSettings> = Object.freeze({
  onlineInstall: false,
  proxy: null,
  privateGit: false,
});

export type StoredSettings = { settings: ExtensionSettings; unreadable: boolean };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The proxy in the one form Studio stores and hands to pip and Git: `<scheme>//<host>[:port]`.
 *
 * Only `http:` and `https:` proxies of a host and an optional port are taken. Credentials are
 * refused, and nothing of the address the user typed appears in the failure, so a password
 * typed by mistake never reaches a reply, a log or the settings file.
 *
 * @throws ExtensionFailure `INVALID_PROXY` or `PROXY_CREDENTIALS_UNSUPPORTED`
 */
export function normalizeProxy(value: unknown): string {
  const invalid = (): ExtensionFailure =>
    new ExtensionFailure('INVALID_PROXY', ['the proxy must be an http:// or https:// address of a host and a port']);
  // oxlint-disable-next-line no-control-regex -- reject characters URL parsing can silently discard.
  if (typeof value !== 'string' || value.length > 2048 || /[\s\\\x00-\x1f\x7f]/.test(value)) throw invalid();
  const credentials = (): ExtensionFailure =>
    new ExtensionFailure('PROXY_CREDENTIALS_UNSUPPORTED', [
      'a proxy address with a user name or password cannot be stored yet',
    ]);
  const scheme = /^(https?):\/\//i.exec(value);
  if (!scheme) throw invalid();
  // Look at the authority as typed, before URL parsing: it drops an empty user part such as
  // `http://@host` and skips extra slashes, so `http:///user:pass@host` would lose the
  // credentials without a trace. Only a plain host and port are taken; nothing is repaired.
  const authority = value.slice(scheme[0].length).split(/[/?#]/, 1)[0];
  if (authority.includes('@')) throw credentials();
  const typed = PROXY_AUTHORITY.exec(authority);
  if (!typed) throw invalid();
  if (typed[1] !== undefined && (Number(typed[1]) < 1 || Number(typed[1]) > 65535)) throw invalid();
  const url = URL.parse(value);
  if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname) throw invalid();
  if (url.username || url.password) throw credentials();
  if ((url.pathname !== '' && url.pathname !== '/') || url.search || url.hash) throw invalid();
  return `${url.protocol}//${url.host}`;
}

function parseStored(text: string): ExtensionSettings | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isObject(value) || value.schema !== SETTINGS_SCHEMA) return undefined;
  const { onlineInstall, proxy, privateGit } = value;
  if (typeof onlineInstall !== 'boolean' || typeof privateGit !== 'boolean') return undefined;
  if (proxy !== null) {
    try {
      // A stored proxy is in the normalized form; anything else was not written by Studio.
      if (normalizeProxy(proxy) !== proxy) return undefined;
    } catch {
      return undefined;
    }
  }
  return { onlineInstall, proxy: proxy as string | null, privateGit };
}

/**
 * Read the stored settings. A missing file means the defaults. A file that cannot be read or
 * was not written by Studio means the closed settings, flagged `unreadable`: a damaged file
 * must not turn online installs back on, nor send them past a proxy the user chose.
 *
 * Reads only; nothing is created. Safe without the lock: the file is replaced whole.
 */
export async function readSettings(layout: Layout): Promise<StoredSettings> {
  const closed = (): StoredSettings => ({ settings: { ...CLOSED_SETTINGS }, unreadable: true });
  // Only a missing name means the defaults. Studio writes a regular file; a link (even one
  // whose target is gone), a directory or anything else under that name is not its file.
  const entry = await lstat(layout.settings).catch((error: unknown): null | undefined =>
    (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : undefined
  );
  if (entry === null) return { settings: { ...DEFAULT_SETTINGS }, unreadable: false };
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
  const settings = Buffer.byteLength(text) <= SIZE_LIMIT ? parseStored(text) : undefined;
  return settings ? { settings, unreadable: false } : closed();
}

/**
 * Check a settings change from a request: only the known fields, each of its own type. The
 * proxy is normalized here, before any lock is taken or anything is written.
 *
 * @throws ExtensionFailure `INVALID_INPUT`, `INVALID_PROXY` or `PROXY_CREDENTIALS_UNSUPPORTED`
 */
export function parseSettingsChange(value: unknown): Partial<ExtensionSettings> {
  if (!isObject(value)) throw new ExtensionFailure('INVALID_INPUT');
  const known = new Set(['onlineInstall', 'proxy', 'privateGit']);
  if (Object.keys(value).some((name) => !known.has(name)) || Object.keys(value).length === 0)
    throw new ExtensionFailure('INVALID_INPUT');
  const change: Partial<ExtensionSettings> = {};
  for (const name of ['onlineInstall', 'privateGit'] as const) {
    if (!Object.hasOwn(value, name)) continue;
    if (typeof value[name] !== 'boolean') throw new ExtensionFailure('INVALID_INPUT');
    change[name] = value[name];
  }
  if (Object.hasOwn(value, 'proxy')) change.proxy = value.proxy === null ? null : normalizeProxy(value.proxy);
  return change;
}

/**
 * Replace the stored settings. Call under the mutation lock with its holder as `writer`: the
 * holder renames the flushed temporary file over `settings.json`, so the file cannot change
 * once the lock is gone. A temporary file left by an interruption is removed by recovery.
 */
export async function writeSettings(layout: Layout, settings: ExtensionSettings, writer: StateWriter): Promise<void> {
  const content: Record<string, unknown> = { schema: SETTINGS_SCHEMA, ...settings };
  const temporary = await writeTemporary(layout.settings, JSON.stringify(content, null, 2) + '\n');
  await writer.replace(path.basename(temporary), path.basename(layout.settings));
}
