import path from 'node:path';
import { runToExit } from '../../process.js';
import { ExtensionFailure } from '../../types.js';
import type { FlowContext } from '../candidate.js';

/**
 * What private Git (Studio #32 1b, off by default) lets a git install use, and nothing more:
 *
 * - the user's SSH agent (`SSH_AUTH_SOCK`) and the user's own SSH configuration and keys, which
 *   OpenSSH finds through the account database whatever `HOME` says;
 * - the Git credential helpers the user configured (`credential.*` of the user's system and
 *   global Git configuration, copied one by one; no other Git setting is taken);
 * - on Linux, the session bus (`DBUS_SESSION_BUS_ADDRESS`) that secret-service helpers talk to.
 *
 * The installer keeps its private `HOME`, so `~/.netrc`, `~/.gitconfig` as a whole, pip's
 * configuration and the user's build configuration stay out. A helper that finds its store
 * through `HOME` (`store` or `cache` without an explicit file or socket) therefore finds nothing.
 */
export type PrivateGitAccess = {
  sshAuthSock?: string;
  dbusSessionBusAddress?: string;
  /** `credential.*` entries in the order Git read them: name, value. */
  credentials: [string, string][];
};

/** The only variables of the user's environment the helper keeps for private Git. */
const PRIVATE_GIT_VARIABLES = ['HOME', 'XDG_CONFIG_HOME', 'SSH_AUTH_SOCK', 'DBUS_SESSION_BUS_ADDRESS'] as const;

const ENTRY_LIMIT = 64;
const OUTPUT_LIMIT = 256 * 1024;

/**
 * Pick the variables private Git may use from the user's environment. Windows gets none:
 * git installs are not offered there yet.
 */
export function privateGitEnvironment(source: NodeJS.ProcessEnv, platform: NodeJS.Platform): Record<string, string> {
  const picked: Record<string, string> = {};
  if (platform === 'win32') return picked;
  for (const name of PRIVATE_GIT_VARIABLES) {
    const value = source[name];
    if (typeof value === 'string' && value !== '' && !value.includes('\0')) picked[name] = value;
  }
  // macOS keychain helpers need no bus; only Linux secret-service helpers do.
  if (platform !== 'linux') delete picked.DBUS_SESSION_BUS_ADDRESS;
  return picked;
}

/**
 * Parse `git config --null --get-regexp` output: `name\nvalue\0`, or `name\0` for a name
 * written without a value, which Git reads as true.
 */
export function parseCredentialEntries(output: string): [string, string][] {
  const entries: [string, string][] = [];
  for (const record of output.split('\0')) {
    if (record === '') continue;
    const end = record.indexOf('\n');
    const name = end < 0 ? record : record.slice(0, end);
    const value = end < 0 ? 'true' : record.slice(end + 1);
    if (!/^credential\.[^\n]+$/i.test(name) || name.length > 1024 || value.length > 4096) continue;
    entries.push([name, value]);
    if (entries.length === ENTRY_LIMIT) break;
  }
  return entries;
}

/**
 * Read the user's credential configuration as the Git pip runs (`git` on `/usr/bin:/bin`)
 * sees it, with the user's `HOME`, from a directory of the candidate where no repository is
 * found: the system and global files and what they include, never a repository's.
 *
 * Git is asked for values only; no helper runs. A Git that cannot answer leaves no helper.
 */
export async function privateGitAccess(
  context: Pick<FlowContext, 'spawn' | 'signal' | 'user'>,
  cwd: string,
  timeoutMs: number
): Promise<PrivateGitAccess> {
  const user = context.user ?? {};
  const access: PrivateGitAccess = { credentials: [] };
  if (user.SSH_AUTH_SOCK) access.sshAuthSock = user.SSH_AUTH_SOCK;
  if (user.DBUS_SESSION_BUS_ADDRESS) access.dbusSessionBusAddress = user.DBUS_SESSION_BUS_ADDRESS;
  if (!user.HOME) return access;
  const env: Record<string, string> = {
    PATH: '/usr/bin:/bin',
    HOME: user.HOME,
    LC_ALL: 'C',
    GIT_CEILING_DIRECTORIES: path.dirname(cwd),
    GIT_TERMINAL_PROMPT: '0',
  };
  if (user.XDG_CONFIG_HOME) env.XDG_CONFIG_HOME = user.XDG_CONFIG_HOME;
  const result = await runToExit(
    context.spawn,
    { command: 'git', args: ['config', '--null', '--get-regexp', '^credential\\.'], env, cwd },
    { timeoutMs, signal: context.signal, tailLimit: OUTPUT_LIMIT }
  );
  if (result.cancelled) throw new ExtensionFailure('CANCELLED');
  // Exit 1 means no entry; anything else, or output that may have been cut, means none is used.
  if (result.code === 0 && result.output.length < OUTPUT_LIMIT)
    access.credentials = parseCredentialEntries(result.output);
  return access;
}
