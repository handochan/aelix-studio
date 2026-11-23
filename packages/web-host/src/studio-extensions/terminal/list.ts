import os from 'node:os';
import path from 'node:path';
import type { TerminalCliEnvironment, TerminalCliFoundBy, TerminalCliListing } from '../types.js';
import { listDirectory, lstatOf, realpathOf, statOf } from './files.js';
import { readGlobalExtensions } from './globalDirectory.js';
import { launcherInterpreter } from './launcher.js';
import { searchLocations, type ToolRoot } from './locations.js';
import { holdsCli, readCliVenv } from './venv.js';

/** The most environments read; more are `truncated`. */
export const ENVIRONMENT_LIMIT = 16;
/** The most tool environments of one uv or pipx directory looked at. */
export const TOOL_ENTRY_LIMIT = 256;
/** The time the whole listing may take; then it answers with what it read (`timedOut`). */
export const LISTING_DEADLINE_MS = 5000;

const FOUND_BY_ORDER: TerminalCliFoundBy[] = ['uv_tool', 'pipx', 'launcher'];

export type TerminalListingOptions = {
  env?: NodeJS.ProcessEnv;
  home?: string;
  platform?: NodeJS.Platform;
  /** The user name to hide in paths (`os.userInfo().username` by default). */
  username?: string;
  deadlineMs?: number;
};

/**
 * Write a path for a reply: the home directory as `~`, the user name as `<user>` where it is a
 * whole path segment. Other absolute paths stay as they are.
 */
export function labelPath(
  target: string,
  homes: string[],
  username: string | undefined,
  platform: NodeJS.Platform
): string {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const fold = (value: string): string => (platform === 'win32' || platform === 'darwin' ? value.toLowerCase() : value);
  let labelled = target;
  // A home of `/` (or none) would label every path.
  for (const home of homes.filter((value) => value.length > 1).toSorted((a, b) => b.length - a.length)) {
    const prefix = home.endsWith(paths.sep) ? home : home + paths.sep;
    if (fold(target) === fold(home)) {
      labelled = '~';
      break;
    }
    if (fold(target).startsWith(fold(prefix))) {
      labelled = '~' + paths.sep + target.slice(prefix.length);
      break;
    }
  }
  if (!username) return labelled;
  return labelled
    .split(paths.sep)
    .map((segment) => (fold(segment) === fold(username) ? '<user>' : segment))
    .join(paths.sep);
}

type Found = {
  status: TerminalCliEnvironment['status'];
  /** Unlabelled location: the real environment directory, an interpreter or a launcher. */
  location: string;
  foundBy: Set<TerminalCliFoundBy>;
  launchers: Set<string>;
};

/** What a launcher leads to: an environment directory, an interpreter outside one, or nothing. */
async function followLauncher(
  launcher: string
): Promise<{ venv: string } | { interpreter: string } | { unresolved: true } | undefined> {
  const real = await realpathOf(launcher);
  if (!real) return undefined;
  // uv and pipx link `~/.local/bin/aelix` to `<environment>/bin/aelix`.
  const parent = path.dirname(real);
  if (path.basename(parent) === 'bin' && (await statOf(path.join(path.dirname(parent), 'pyvenv.cfg')))?.isFile())
    return { venv: path.dirname(parent) };
  const interpreter = await launcherInterpreter(real);
  if (!interpreter) return { unresolved: true };
  // The interpreter of an environment is `<environment>/bin/python`, often a link out of it:
  // the environment is found from the path as written, not from where the link goes.
  const root = path.dirname(path.dirname(interpreter));
  if ((await statOf(path.join(root, 'pyvenv.cfg')))?.isFile()) return { venv: root };
  return { interpreter };
}

/**
 * List the extensions of the user's terminal `aelix` from files only (ADR 9, 2026-11-22 user
 * decision 4): no `aelix`, Python or shell is run, no child process is started, nothing is
 * written and no network is used. Each environment is read on its own: one that fails is
 * `unreadable` and the others are still read. Needs neither the Studio runtime nor the change
 * lock. Answers within `LISTING_DEADLINE_MS` with what it read by then (`timedOut`).
 */
export async function listTerminalCli(options: TerminalListingOptions = {}): Promise<TerminalCliListing> {
  const env = options.env ?? process.env;
  const home = options.home ?? os.homedir();
  const platform = options.platform ?? process.platform;
  const username = options.username ?? safeUsername();
  const realHome = (await realpathOf(home)) ?? home;
  const label = (target: string): string => labelPath(target, [home, realHome], username, platform);
  const locations = searchLocations(env, home, platform);

  const globalDirectory = path.join(locations.agentDirectory, 'extensions');
  const listing: TerminalCliListing = {
    environments: [],
    globalExtensions: { location: label(globalDirectory), status: 'absent', extensions: [], truncated: false },
    searched: [
      ...locations.toolRoots.map((root) => label(root.directory)),
      ...locations.launcherDirectories.map(label),
      label(globalDirectory),
    ],
    truncated: false,
    timedOut: false,
  };

  const found = new Map<string, Found>();
  const add = (key: string, entry: Omit<Found, 'foundBy' | 'launchers'>, by: TerminalCliFoundBy, launcher?: string) => {
    let current = found.get(key);
    if (!current) {
      if (found.size >= ENVIRONMENT_LIMIT) {
        listing.truncated = true;
        return;
      }
      current = { ...entry, foundBy: new Set(), launchers: new Set() };
      found.set(key, current);
    }
    current.foundBy.add(by);
    if (launcher) current.launchers.add(launcher);
  };

  const work = async (): Promise<void> => {
    // The global directory first: one cheap read, answered even when the environments take long.
    const globals = await readGlobalExtensions((await realpathOf(globalDirectory)) ?? globalDirectory);
    if (globals !== 'absent') listing.globalExtensions = { ...listing.globalExtensions, status: 'listed', ...globals };
    for (const root of locations.toolRoots) {
      // eslint-disable-next-line no-await-in-loop -- in order, so the limit keeps the same environments
      await scanToolRoot(root);
    }
    const userScheme = await userSchemeDirectories();
    listing.searched.splice(listing.searched.length - 1, 0, ...userScheme.map(label));
    for (const directory of [...locations.launcherDirectories, ...userScheme]) {
      // eslint-disable-next-line no-await-in-loop -- one directory after another, deduplicated in order
      await scanLauncher(path.join(directory, 'aelix'));
    }
    await Promise.all(
      [...found.values()].map(async (entry) => {
        const environment = await readEnvironment(entry);
        listing.environments.push(environment);
      })
    );
  };

  const scanToolRoot = async (root: ToolRoot): Promise<void> => {
    const children = await listDirectory(root.directory, TOOL_ENTRY_LIMIT);
    if (!children) return;
    if (children.truncated) listing.truncated = true;
    for (const name of children.names) {
      const candidate = path.join(root.directory, name);
      // eslint-disable-next-line no-await-in-loop -- in a stable order, so the limit keeps the same ones
      if (!(await holdsCli(candidate, platform))) continue;
      // eslint-disable-next-line no-await-in-loop -- as above
      const real = await realpathOf(candidate);
      if (real) add(real, { status: 'listed', location: real }, root.foundBy);
    }
  };

  /** `pip install --user` on macOS puts launchers in `~/Library/Python/<version>/bin`. */
  const userSchemeDirectories = async (): Promise<string[]> => {
    if (platform !== 'darwin') return [];
    const user = path.join(home, 'Library', 'Python');
    const versions = (await listDirectory(user, 16))?.names ?? [];
    return versions.map((version) => path.join(user, version, 'bin'));
  };

  const scanLauncher = async (launcher: string): Promise<void> => {
    // `lstat`: a link that goes nowhere or loops is still a launcher found, and reported.
    if (!(await lstatOf(launcher))) return;
    const shown = label(launcher);
    const target = await followLauncher(launcher);
    if (!target) {
      add(`launcher:${launcher}`, { status: 'unreadable', location: launcher }, 'launcher', shown);
      return;
    }
    if ('venv' in target) {
      const real = (await realpathOf(target.venv)) ?? target.venv;
      add(real, { status: 'listed', location: real }, 'launcher', shown);
    } else if ('interpreter' in target) {
      add(`python:${target.interpreter}`, { status: 'not_a_venv', location: target.interpreter }, 'launcher', shown);
    } else {
      const real = (await realpathOf(launcher)) ?? launcher;
      add(`launcher:${real}`, { status: 'unresolved_launcher', location: launcher }, 'launcher', shown);
    }
  };

  const readEnvironment = async (entry: Found): Promise<TerminalCliEnvironment> => {
    const base: TerminalCliEnvironment = {
      status: entry.status,
      location: label(entry.location),
      foundBy: FOUND_BY_ORDER.filter((by) => entry.foundBy.has(by)),
      launchers: [...entry.launchers].toSorted(),
      extensions: [],
      issues: [],
      truncated: false,
    };
    if (entry.status !== 'listed') return base;
    try {
      const venv = await readCliVenv(entry.location, platform);
      if (venv === 'not_a_venv' || venv === 'no_cli') return { ...base, status: 'no_cli' };
      return { ...base, ...venv };
    } catch {
      // Nothing of the error: its text can hold paths and file names.
      return { ...base, status: 'unreadable' };
    }
  };

  let timer: NodeJS.Timeout | undefined;
  const finished = await Promise.race([
    work().then(
      () => true,
      () => true
    ),
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), options.deadlineMs ?? LISTING_DEADLINE_MS);
    }),
  ]);
  clearTimeout(timer);
  // A copy: reading that goes on after the deadline must not change the answer.
  const result = structuredClone(listing);
  result.timedOut = !finished;
  result.environments.sort(
    (a, b) =>
      FOUND_BY_ORDER.indexOf(a.foundBy[0]) - FOUND_BY_ORDER.indexOf(b.foundBy[0]) ||
      a.location.localeCompare(b.location)
  );
  return result;
}

function safeUsername(): string | undefined {
  try {
    return os.userInfo().username;
  } catch {
    return undefined;
  }
}
