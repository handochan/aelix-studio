import path from 'node:path';

/** How a terminal CLI environment was found. */
export type FoundBy = 'uv_tool' | 'pipx' | 'launcher';

/** A directory whose subdirectories are tool environments (`<root>/<tool>`). */
export type ToolRoot = { directory: string; foundBy: 'uv_tool' | 'pipx' };

export type SearchLocations = {
  toolRoots: ToolRoot[];
  /** Directories that may hold an `aelix` launcher. Not used on Windows. */
  launcherDirectories: string[];
  /** The terminal CLI's agent directory (its global extensions are in `extensions`). */
  agentDirectory: string;
};

/** The most entries of Studio's own `PATH` this looks at. */
export const PATH_ENTRY_LIMIT = 64;

/** An absolute path from an environment variable; undefined when unset, empty or relative. */
const absolute = (value: string | undefined, platform: NodeJS.Platform): string | undefined => {
  if (!value) return undefined;
  const paths = platform === 'win32' ? path.win32 : path.posix;
  return paths.isAbsolute(value) ? paths.normalize(value) : undefined;
};

/** `~` and `~/…` as native's `expand_tilde_path` reads them. */
const expandTilde = (value: string, home: string, platform: NodeJS.Platform): string => {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  if (value === '~') return home;
  if (value.startsWith('~/') || (platform === 'win32' && value.startsWith('~\\')))
    return paths.join(home, value.slice(2));
  return value;
};

const unique = (values: (string | undefined)[]): string[] => [
  ...new Set(values.filter((value): value is string => Boolean(value))),
];

/**
 * Where the terminal CLI can be, from Studio's own environment, the home directory and the
 * platform. Nothing is read here. Studio sees its own environment, not the user's shell's:
 * a variable set only in a shell profile is not seen.
 *
 * - uv tools (uv 0.13.9 `uv tool dir`): `UV_TOOL_DIR`; else `$XDG_DATA_HOME/uv/tools` or
 *   `~/.local/share/uv/tools`, and the older macOS `~/Library/Application Support/uv/tools`;
 *   on Windows `%APPDATA%\uv\data\tools` and `%APPDATA%\uv\tools`.
 * - pipx (pipx 1.19.0 `paths.py`, platformdirs 4.14.8): `PIPX_HOME`; else the user data
 *   directory (`$XDG_DATA_HOME/pipx`, `~/.local/share/pipx` on Linux,
 *   `~/Library/Application Support/pipx` on macOS, `%LOCALAPPDATA%\pipx\pipx` on Windows) and
 *   the older `~/.local/pipx` (and `~\pipx` on Windows); each `<home>/venvs`.
 * - Launchers (not on Windows, where they are binary): `UV_TOOL_BIN_DIR`, `XDG_BIN_HOME`,
 *   `$XDG_DATA_HOME/../bin`, `PIPX_BIN_DIR`, `~/.local/bin`, Homebrew's and the system's bin
 *   directories, and Studio's own `PATH` (at most `PATH_ENTRY_LIMIT` entries).
 * - The agent directory: `AELIX_CODING_AGENT_DIR` (with `~` expanded, as native does), else
 *   `~/.aelix/agent`.
 *
 * Every existing candidate is searched, since which one a given uv or pipx version uses depends
 * on its version and on what already exists.
 */
export function searchLocations(env: NodeJS.ProcessEnv, home: string, platform: NodeJS.Platform): SearchLocations {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const at = (...parts: string[]): string => paths.join(home, ...parts);
  const xdgData = platform === 'win32' ? undefined : absolute(env.XDG_DATA_HOME, platform);
  const uvToolDir = env.UV_TOOL_DIR ? paths.resolve(home, env.UV_TOOL_DIR) : undefined;
  const pipxHome = env.PIPX_HOME ? paths.resolve(home, expandTilde(env.PIPX_HOME, home, platform)) : undefined;

  const uv =
    platform === 'win32'
      ? unique([
          uvToolDir,
          ...(env.APPDATA && paths.isAbsolute(env.APPDATA)
            ? [paths.join(env.APPDATA, 'uv', 'data', 'tools'), paths.join(env.APPDATA, 'uv', 'tools')]
            : []),
        ])
      : unique([
          uvToolDir,
          xdgData && paths.join(xdgData, 'uv', 'tools'),
          at('.local', 'share', 'uv', 'tools'),
          platform === 'darwin' ? at('Library', 'Application Support', 'uv', 'tools') : undefined,
        ]);
  const pipx = unique([
    pipxHome,
    xdgData && paths.join(xdgData, 'pipx'),
    platform === 'darwin' ? at('Library', 'Application Support', 'pipx') : undefined,
    platform === 'win32'
      ? env.LOCALAPPDATA && paths.isAbsolute(env.LOCALAPPDATA)
        ? paths.join(env.LOCALAPPDATA, 'pipx', 'pipx')
        : undefined
      : platform === 'darwin'
        ? undefined
        : at('.local', 'share', 'pipx'),
    at('.local', 'pipx'),
    platform === 'win32' ? at('pipx') : undefined,
  ]).map((directory) => paths.join(directory, 'venvs'));

  const launcherDirectories =
    platform === 'win32'
      ? []
      : unique([
          absolute(env.UV_TOOL_BIN_DIR, platform),
          absolute(env.XDG_BIN_HOME, platform),
          xdgData && paths.normalize(paths.join(xdgData, '..', 'bin')),
          absolute(env.PIPX_BIN_DIR && expandTilde(env.PIPX_BIN_DIR, home, platform), platform),
          at('.local', 'bin'),
          ...(platform === 'darwin' ? ['/opt/homebrew/bin'] : ['/home/linuxbrew/.linuxbrew/bin']),
          '/usr/local/bin',
          '/usr/bin',
          ...(env.PATH ?? '')
            .split(':')
            .slice(0, PATH_ENTRY_LIMIT)
            .map((entry) => absolute(entry, platform)),
        ]);

  const agent = env.AELIX_CODING_AGENT_DIR
    ? expandTilde(env.AELIX_CODING_AGENT_DIR, home, platform)
    : at('.aelix', 'agent');
  return {
    toolRoots: [
      ...uv.map((directory): ToolRoot => ({ directory, foundBy: 'uv_tool' })),
      ...pipx.map((directory): ToolRoot => ({ directory, foundBy: 'pipx' })),
    ],
    launcherDirectories,
    agentDirectory: paths.resolve(home, agent),
  };
}
