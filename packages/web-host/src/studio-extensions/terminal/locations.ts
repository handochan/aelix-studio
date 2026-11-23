import path from 'node:path';
import { isUncOrDevice } from './files.js';

/** How a terminal CLI environment was found. */
export type FoundBy = 'uv_tool' | 'pipx' | 'launcher';

/** A directory whose subdirectories are tool environments (`<root>/<tool>`). */
export type ToolRoot = { directory: string; foundBy: 'uv_tool' | 'pipx' };

export type SearchLocations = {
  toolRoots: ToolRoot[];
  /** Directories that may hold an `aelix` launcher. Not used on Windows. */
  launcherDirectories: string[];
  /**
   * The terminal CLI's agent directory (its global extensions are in `extensions`); undefined
   * when `AELIX_CODING_AGENT_DIR` is set to something Studio cannot place (relative, UNC).
   */
  agentDirectory?: string;
  /** Studio's own `PATH` had more entries than `PATH_ENTRY_LIMIT`: the rest were not looked in. */
  truncated: boolean;
};

/** The most entries of Studio's own `PATH` this looks at. */
export const PATH_ENTRY_LIMIT = 64;

/**
 * Locations from Studio's environment, all from here: `~` and `~/…` expanded where the tool
 * expands them, relative values ignored (uv and pipx take them from their own working
 * directory, which Studio does not know), and Windows UNC and device paths refused.
 */
function location(platform: NodeJS.Platform, home: string) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const usable = (value: string | undefined): string | undefined =>
    value && paths.isAbsolute(value) && !isUncOrDevice(value, platform) ? paths.normalize(value) : undefined;
  const expanded = (value: string | undefined): string | undefined => {
    if (!value) return undefined;
    if (value === '~') return usable(home);
    if (value.startsWith('~/') || (platform === 'win32' && value.startsWith('~\\')))
      return usable(paths.join(home, value.slice(2)));
    return usable(value);
  };
  return { paths, usable, expanded };
}

const unique = (values: (string | undefined)[]): string[] => [
  ...new Set(values.filter((value): value is string => Boolean(value))),
];

/**
 * Where the terminal CLI can be, from Studio's own environment, the home directory and the
 * platform. Nothing is read here. Studio sees its own environment, not the user's shell's: a
 * variable set only in a shell profile is not seen.
 *
 * - uv tools (uv 0.13.9 `uv tool dir`): `UV_TOOL_DIR`; else `$XDG_DATA_HOME/uv/tools` or
 *   `~/.local/share/uv/tools`, and the older macOS `~/Library/Application Support/uv/tools`; on
 *   Windows `%APPDATA%\uv\data\tools` and `%APPDATA%\uv\tools`.
 * - pipx (pipx 1.19.0 `paths.py`, platformdirs 4.14.8): `PIPX_HOME` (with `~`); else the user
 *   data directory (`$XDG_DATA_HOME/pipx`, `~/.local/share/pipx` on Linux,
 *   `~/Library/Application Support/pipx` on macOS, `%LOCALAPPDATA%\pipx\pipx` on Windows) and
 *   the older `~/.local/pipx` (and `~\pipx` on Windows); each `<home>/venvs`.
 * - On Windows without `APPDATA` or `LOCALAPPDATA`, the usual `~\AppData\Roaming` and
 *   `~\AppData\Local`: uv and platformdirs ask Windows for the known folder, which Studio does
 *   not (no API call or command).
 * - Launchers (not on Windows, where they are binary): `UV_TOOL_BIN_DIR`, `XDG_BIN_HOME`,
 *   `$XDG_DATA_HOME/../bin`, `PIPX_BIN_DIR`, `~/.local/bin`, Homebrew's and the system's bin
 *   directories, and Studio's own `PATH` (at most `PATH_ENTRY_LIMIT` entries, `truncated` past).
 * - The agent directory: `AELIX_CODING_AGENT_DIR` (with `~` expanded, as native does), else
 *   `~/.aelix/agent`.
 *
 * Every existing candidate is searched, since which one a given uv or pipx version uses depends
 * on its version and on what already exists.
 */
export function searchLocations(env: NodeJS.ProcessEnv, home: string, platform: NodeJS.Platform): SearchLocations {
  const { paths, usable, expanded } = location(platform, home);
  const homeDirectory = usable(home);
  const at = (...parts: string[]): string | undefined => homeDirectory && paths.join(homeDirectory, ...parts);
  const xdgData = platform === 'win32' ? undefined : usable(env.XDG_DATA_HOME);
  const appData = usable(env.APPDATA) ?? at('AppData', 'Roaming');
  const localAppData = usable(env.LOCALAPPDATA) ?? at('AppData', 'Local');

  const uv =
    platform === 'win32'
      ? unique([
          usable(env.UV_TOOL_DIR),
          appData && paths.join(appData, 'uv', 'data', 'tools'),
          appData && paths.join(appData, 'uv', 'tools'),
        ])
      : unique([
          usable(env.UV_TOOL_DIR),
          xdgData && paths.join(xdgData, 'uv', 'tools'),
          at('.local', 'share', 'uv', 'tools'),
          platform === 'darwin' ? at('Library', 'Application Support', 'uv', 'tools') : undefined,
        ]);
  const pipx = unique([
    expanded(env.PIPX_HOME),
    xdgData && paths.join(xdgData, 'pipx'),
    platform === 'darwin' ? at('Library', 'Application Support', 'pipx') : undefined,
    platform === 'win32'
      ? localAppData && paths.join(localAppData, 'pipx', 'pipx')
      : platform === 'darwin'
        ? undefined
        : at('.local', 'share', 'pipx'),
    at('.local', 'pipx'),
    platform === 'win32' ? at('pipx') : undefined,
  ]).map((directory) => paths.join(directory, 'venvs'));

  const pathEntries = (env.PATH ?? '').split(':').filter(Boolean);
  const launcherDirectories =
    platform === 'win32'
      ? []
      : unique([
          usable(env.UV_TOOL_BIN_DIR),
          usable(env.XDG_BIN_HOME),
          xdgData && paths.normalize(paths.join(xdgData, '..', 'bin')),
          expanded(env.PIPX_BIN_DIR),
          at('.local', 'bin'),
          ...(platform === 'darwin' ? ['/opt/homebrew/bin'] : ['/home/linuxbrew/.linuxbrew/bin']),
          '/usr/local/bin',
          '/usr/bin',
          ...pathEntries.slice(0, PATH_ENTRY_LIMIT).map(usable),
        ]);

  return {
    toolRoots: [
      ...uv.map((directory): ToolRoot => ({ directory, foundBy: 'uv_tool' })),
      ...pipx.map((directory): ToolRoot => ({ directory, foundBy: 'pipx' })),
    ],
    launcherDirectories,
    agentDirectory: env.AELIX_CODING_AGENT_DIR ? expanded(env.AELIX_CODING_AGENT_DIR) : at('.aelix', 'agent'),
    truncated: platform !== 'win32' && pathEntries.length > PATH_ENTRY_LIMIT,
  };
}
