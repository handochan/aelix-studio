import os from 'node:os';
import path from 'node:path';
import type { TerminalCliEnvironment, TerminalCliFoundBy, TerminalCliListing } from '../types.js';
import { createScan, listDirectory, lstatOf, realpathOf, ScanStopped, statOf, type Scan } from './files.js';
import { readGlobalExtensions } from './globalDirectory.js';
import { launcherInterpreter } from './launcher.js';
import { searchLocations, type ToolRoot } from './locations.js';
import { holdsCli, readCliVenv } from './venv.js';

/** The most environments read; more are `truncated`. */
export const ENVIRONMENT_LIMIT = 16;
/** The most tool environments of one uv or pipx directory looked at. */
export const TOOL_ENTRY_LIMIT = 256;
/** The most `~/Library/Python/<version>` directories looked at on macOS. */
export const USER_SCHEME_LIMIT = 16;
/** The time a listing may take: it answers with what it read by then and the scan stops. */
export const LISTING_DEADLINE_MS = 5000;

const FOUND_BY_ORDER: TerminalCliFoundBy[] = ['uv_tool', 'pipx', 'launcher'];

export type TerminalListingOptions = {
  env?: NodeJS.ProcessEnv;
  home?: string;
  platform?: NodeJS.Platform;
  /** The user name to hide (`os.userInfo().username` by default). */
  username?: string;
  deadlineMs?: number;
};

/** What replies hide: the home directory (as written and as its real path) and the user name. */
export type Masks = { homes: string[]; username?: string; platform: NodeJS.Platform };

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Hide the home directory and the user name in any text of a reply: a home directory wherever
 * it starts a path in the text (`/home/alice/x`, `file:///home/alice/x`) becomes `~`, and the
 * user name wherever it stands as a word of its own (in a path, a package name, a reference)
 * becomes `<user>`. Case is ignored for both on macOS and Windows, and for the user name
 * everywhere.
 */
export function maskText(text: string, masks: Masks): string {
  let masked = text;
  const fold = masks.platform === 'darwin' || masks.platform === 'win32' ? 'gi' : 'g';
  // Longest first, so a real path that extends the written one is not cut.
  for (const home of masks.homes.filter((value) => value.length > 1).toSorted((a, b) => b.length - a.length)) {
    const trimmed = home.replace(/[\\/]+$/, '');
    masked = masked.replace(new RegExp(`${escapeRegExp(trimmed)}(?=$|[\\\\/])`, fold), '~');
  }
  if (masks.username)
    masked = masked.replace(
      new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(masks.username)}(?![\\p{L}\\p{N}])`, 'giu'),
      '<user>'
    );
  return masked;
}

/** A path for a reply: normalized, then masked. */
export function labelPath(target: string, masks: Masks): string {
  const paths = masks.platform === 'win32' ? path.win32 : path.posix;
  return maskText(paths.normalize(target), masks);
}

/** Every string of a reply, masked: the last step before it leaves, whatever field holds it. */
function sanitize<T>(value: T, masks: Masks): T {
  if (typeof value === 'string') return maskText(value, masks) as T;
  if (Array.isArray(value)) return value.map((item) => sanitize(item, masks)) as T;
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitize(item, masks)])) as T;
  return value;
}

type Found = {
  status: TerminalCliEnvironment['status'];
  /** The location before masking: the real environment directory, an interpreter or a launcher. */
  location: string;
  foundBy: Set<TerminalCliFoundBy>;
  launchers: Set<string>;
};

/** What a launcher leads to: an environment directory, an interpreter outside one, or nothing. */
async function followLauncher(
  scan: Scan,
  launcher: string
): Promise<{ venv: string } | { interpreter: string } | { unresolved: true } | undefined> {
  const real = await realpathOf(scan, launcher);
  if (!real) return undefined;
  // uv and pipx link `~/.local/bin/aelix` to `<environment>/bin/aelix`.
  const parent = path.dirname(real);
  if (path.basename(parent) === 'bin' && (await statOf(scan, path.join(path.dirname(parent), 'pyvenv.cfg')))?.isFile())
    return { venv: path.dirname(parent) };
  const interpreter = await launcherInterpreter(scan, real);
  if (!interpreter) return { unresolved: true };
  // The interpreter of an environment is `<environment>/bin/python`, often a link out of it:
  // the environment is found from the path as written (normalized), not from where it links.
  const written = path.posix.normalize(interpreter);
  const root = path.posix.dirname(path.posix.dirname(written));
  if ((await statOf(scan, path.join(root, 'pyvenv.cfg')))?.isFile()) return { venv: root };
  return { interpreter: written };
}

/** The listing as it stood when the time ran out, or when the scan ended. */
async function scanListing(
  scan: Scan,
  listing: TerminalCliListing,
  env: NodeJS.ProcessEnv,
  home: string,
  masksReady: (masks: Masks) => void,
  username: string | undefined
): Promise<void> {
  const { platform } = scan;
  const realHome = (await realpathOf(scan, home)) ?? home;
  const masks: Masks = { homes: [home, realHome], username, platform };
  masksReady(masks);
  const locations = searchLocations(env, home, platform);
  if (locations.truncated) listing.truncated = true;
  const globalDirectory = locations.agentDirectory && path.join(locations.agentDirectory, 'extensions');
  listing.searched = [
    ...locations.toolRoots.map((root) => root.directory),
    ...locations.launcherDirectories,
    ...(globalDirectory ? [globalDirectory] : []),
  ];

  // The global directory first: a few reads, answered even when the environments take long.
  if (globalDirectory) {
    listing.globalExtensions.location = globalDirectory;
    const globals = await readGlobalExtensions(scan, (await realpathOf(scan, globalDirectory)) ?? globalDirectory);
    if (typeof globals === 'string') listing.globalExtensions.status = globals;
    else listing.globalExtensions = { location: globalDirectory, status: 'listed', ...globals };
  }

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

  const scanToolRoot = async (root: ToolRoot): Promise<void> => {
    const children = await listDirectory(scan, root.directory, TOOL_ENTRY_LIMIT);
    if (children === 'absent') return;
    if (children === 'unreadable') {
      add(`root:${root.directory}`, { status: 'unreadable', location: root.directory }, root.foundBy);
      return;
    }
    if (children.truncated) listing.truncated = true;
    for (const name of children.names) {
      const candidate = path.join(root.directory, name);
      // eslint-disable-next-line no-await-in-loop -- in a stable order, so the limit keeps the same ones
      const real = await realpathOf(scan, candidate);
      if (!real) continue;
      // eslint-disable-next-line no-await-in-loop -- as above
      const held = await holdsCli(scan, real);
      if (held === 'yes') add(real, { status: 'listed', location: real }, root.foundBy);
      else if (held === 'unreadable') add(real, { status: 'unreadable', location: real }, root.foundBy);
    }
  };

  const userSchemeDirectories = async (): Promise<string[]> => {
    if (platform !== 'darwin') return [];
    // `pip install --user` on macOS puts launchers in `~/Library/Python/<version>/bin`.
    const user = path.join(home, 'Library', 'Python');
    const versions = await listDirectory(scan, user, USER_SCHEME_LIMIT);
    if (typeof versions === 'string') return [];
    if (versions.truncated) listing.truncated = true;
    return versions.names.map((version) => path.join(user, version, 'bin'));
  };

  const scanLauncher = async (launcher: string): Promise<void> => {
    // `lstat`: a link that goes nowhere or loops is still a launcher found, and reported.
    if (!(await lstatOf(scan, launcher))) return;
    const target = await followLauncher(scan, launcher);
    if (!target) {
      add(`launcher:${launcher}`, { status: 'unreadable', location: launcher }, 'launcher', launcher);
      return;
    }
    if ('venv' in target) {
      const real = (await realpathOf(scan, target.venv)) ?? target.venv;
      add(real, { status: 'listed', location: real }, 'launcher', launcher);
    } else if ('interpreter' in target) {
      add(`python:${target.interpreter}`, { status: 'not_a_venv', location: target.interpreter }, 'launcher', launcher);
    } else {
      add(`launcher:${launcher}`, { status: 'unresolved_launcher', location: launcher }, 'launcher', launcher);
    }
  };

  const readEnvironment = async (entry: Found): Promise<TerminalCliEnvironment> => {
    const base: TerminalCliEnvironment = {
      status: entry.status,
      location: entry.location,
      foundBy: FOUND_BY_ORDER.filter((by) => entry.foundBy.has(by)),
      launchers: [...entry.launchers].toSorted(),
      extensions: [],
      issues: [],
      truncated: false,
    };
    if (entry.status !== 'listed') return base;
    try {
      const venv = await readCliVenv(scan, entry.location);
      if (typeof venv === 'string') return { ...base, status: venv === 'unreadable' ? 'unreadable' : 'no_cli' };
      return { ...base, ...venv };
    } catch (error) {
      if (error instanceof ScanStopped) throw error;
      // Nothing of the error: its text can hold paths and file names.
      return { ...base, status: 'unreadable' };
    }
  };

  for (const root of locations.toolRoots) {
    // eslint-disable-next-line no-await-in-loop -- in order, so the limit keeps the same environments
    await scanToolRoot(root);
  }
  const userScheme = await userSchemeDirectories();
  listing.searched.splice(listing.searched.length - (globalDirectory ? 1 : 0), 0, ...userScheme);
  for (const directory of [...locations.launcherDirectories, ...userScheme]) {
    // eslint-disable-next-line no-await-in-loop -- one directory after another, deduplicated in order
    await scanLauncher(path.join(directory, 'aelix'));
  }
  for (const entry of found.values()) {
    // eslint-disable-next-line no-await-in-loop -- one environment at a time; the cap is per file call
    listing.environments.push(await readEnvironment(entry));
  }
}

/** The scan in progress, shared by everyone who asks until it has ended (not just answered). */
let current: { answer: Promise<TerminalCliListing>; ended: Promise<void> } | undefined;

/**
 * List the extensions of the user's terminal `aelix` from files only (ADR 9, 2026-11-22 user
 * decision 4): no `aelix`, Python or shell is run, no child process is started, nothing is
 * written and no network is used. Each environment is read on its own: one that fails is
 * `unreadable` and the others are still read. Needs neither the Studio runtime nor the change
 * lock.
 *
 * One scan at a time for the whole process: callers while it runs, and after it answered but
 * before it ended, share its answer. Its clock starts before its first file system call; at
 * `LISTING_DEADLINE_MS` it answers with what it read (`timedOut`) and stops reading. Every
 * string of the answer has the home directory and the user name hidden.
 */
export function listTerminalCli(options: TerminalListingOptions = {}): Promise<TerminalCliListing> {
  if (current) return current.answer;
  const deadline = Date.now() + (options.deadlineMs ?? LISTING_DEADLINE_MS);
  const env = options.env ?? process.env;
  const home = options.home ?? os.homedir();
  const platform = options.platform ?? process.platform;
  const username = options.username ?? safeUsername();
  const scan = createScan(deadline, platform);
  const listing: TerminalCliListing = {
    environments: [],
    globalExtensions: { location: '', status: 'absent', extensions: [], truncated: false },
    searched: [],
    truncated: false,
    timedOut: false,
  };
  let masks: Masks = { homes: [home], username, platform };
  const work = scanListing(scan, listing, env, home, (ready) => (masks = ready), username).then(
    () => true,
    (error: unknown) => {
      if (!(error instanceof ScanStopped)) listing.truncated = true;
      return !(error instanceof ScanStopped);
    }
  );
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), Math.max(0, deadline - Date.now()));
  });
  const answer = Promise.race([work, timeout]).then((finished) => {
    clearTimeout(timer);
    // A copy: reading that goes on until the scan stops must not change the answer.
    const result = structuredClone(listing);
    result.timedOut = !finished;
    const environments = result.environments
      .map((environment) => ({
        ...environment,
        location: labelPath(environment.location, masks),
        launchers: environment.launchers.map((launcher) => labelPath(launcher, masks)),
      }))
      .toSorted(
        (a, b) =>
          FOUND_BY_ORDER.indexOf(a.foundBy[0]) - FOUND_BY_ORDER.indexOf(b.foundBy[0]) ||
          a.location.localeCompare(b.location)
      );
    return sanitize(
      {
        ...result,
        environments,
        searched: result.searched.map((place) => labelPath(place, masks)),
        globalExtensions: {
          ...result.globalExtensions,
          location: result.globalExtensions.location && labelPath(result.globalExtensions.location, masks),
        },
      },
      masks
    );
  });
  const ended = work.then(() => {
    clearTimeout(timer);
    current = undefined;
  });
  current = { answer, ended };
  return answer;
}

/** For tests: wait until the scan in progress, if any, has ended. */
export async function terminalScanEnded(): Promise<void> {
  await current?.ended;
}

function safeUsername(): string | undefined {
  try {
    return os.userInfo().username;
  } catch {
    return undefined;
  }
}
