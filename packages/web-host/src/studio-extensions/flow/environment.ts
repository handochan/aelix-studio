/**
 * The environment of every process the helper starts (D04 ADR 5.4).
 *
 * It is built from an allow-list. Nothing the user's shell exported reaches native or pip
 * unless it is named here, so `PYTHON*`, `PIP_*`, `UV_*`, `VIRTUAL_ENV`, proxy variables and
 * the variables native uses to redirect its paths (`AELIX_SETTINGS_PATH`, `AELIX_AUTH_PATH`,
 * `AELIX_CODING_AGENT_DIR`, `AELIX_CODING_AGENT_SESSION_DIR`, `AELIX_MCP_CONFIG`,
 * `AELIX_PROJECT_DIR`, `AELIX_DEFAULT_CATALOG`, `AELIX_MODEL_CATALOG_URL`, `XDG_CONFIG_HOME`)
 * are all left out. The helper then sets its own values.
 */

const POSIX_ALLOWED = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'USER', 'LOGNAME', 'SHELL'];

/** Windows needs these to start Python and find the user's directories. Names are case-insensitive. */
const WINDOWS_ALLOWED = [
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'WINDIR',
  'COMSPEC',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'USERNAME',
  'USERDOMAIN',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
];

/** An address nothing listens on. HTTP(S) requests of the installer fail there; git and ssh ignore it. */
const DEAD_PROXY = 'http://127.0.0.1:9';

/** The null device as pip compares it (`os.devnull`), which makes pip load no configuration file. */
const nullDevice = (platform: NodeJS.Platform): string => (platform === 'win32' ? 'nul' : '/dev/null');

/**
 * The variables every helper child gets: the allowed ones copied from `source`, plus
 * `PYTHONDONTWRITEBYTECODE=1` so a child of the bundled interpreter never writes `.pyc`
 * files into the bundle.
 */
export function baseEnvironment(source: NodeJS.ProcessEnv, platform: NodeJS.Platform): Record<string, string> {
  const environment: Record<string, string> = {};
  if (platform === 'win32') {
    const allowed = new Set(WINDOWS_ALLOWED);
    for (const [name, value] of Object.entries(source))
      if (value !== undefined && allowed.has(name.toUpperCase())) environment[name] = value;
  } else {
    for (const name of POSIX_ALLOWED) {
      const value = source[name];
      if (value !== undefined) environment[name] = value;
    }
  }
  environment.PYTHONDONTWRITEBYTECODE = '1';
  return environment;
}

export type ManagementEnvironment = {
  /** The generation's own agent directory: install records never reach `~/.aelix/agent`. */
  agentDirectory: string;
  /** The bundle's `native-site`, so pip sees what the bundle already provides. */
  nativeSite: string;
  /** `file://` address of the constraints file: a different version of a bundled library fails the install. */
  constraintsUrl: string;
  /** Set for a file import: `file://` address of the stored wheel set, the only place pip may look. */
  offlineLinksUrl?: string;
  /** The only index configured by Studio, including for git build requirements. */
  onlineIndexUrl?: string;
};

/**
 * Environment of a management run (the generation's venv interpreter running the native CLI,
 * which starts pip). The interpreter itself runs with `-I` and ignores `PYTHON*`; pip, its
 * child, reads them.
 */
export function managementEnvironment(
  base: Record<string, string>,
  platform: NodeJS.Platform,
  options: ManagementEnvironment
): Record<string, string> {
  const environment: Record<string, string> = {
    ...base,
    AELIX_CODING_AGENT_DIR: options.agentDirectory,
    PYTHONPATH: options.nativeSite,
    PIP_CONSTRAINT: options.constraintsUrl,
    // The user's pip configuration must change neither where files go nor what is contacted.
    PIP_CONFIG_FILE: nullDevice(platform),
    PIP_DISABLE_PIP_VERSION_CHECK: '1',
    PIP_NO_INPUT: '1',
    // pip's cache is in the user's own directories; the helper writes only under its root.
    PIP_NO_CACHE_DIR: '1',
  };
  if (options.offlineLinksUrl !== undefined) {
    Object.assign(environment, {
      PIP_NO_INDEX: '1',
      PIP_FIND_LINKS: options.offlineLinksUrl,
      HTTP_PROXY: DEAD_PROXY,
      HTTPS_PROXY: DEAD_PROXY,
      ALL_PROXY: DEAD_PROXY,
      NO_PROXY: '',
      http_proxy: DEAD_PROXY,
      https_proxy: DEAD_PROXY,
      all_proxy: DEAD_PROXY,
      no_proxy: '',
    });
  }
  if (options.onlineIndexUrl !== undefined) {
    Object.assign(environment, {
      PIP_INDEX_URL: options.onlineIndexUrl,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: nullDevice(platform),
      GIT_TERMINAL_PROMPT: '0',
      GIT_SSH_COMMAND: 'ssh -F /dev/null -o BatchMode=yes',
    });
  }
  return environment;
}

/**
 * Environment of the load check (the bundled interpreter starting native the way a
 * conversation does). The candidate's agent directory is given, never the user's: with the
 * shared one native would create `~/.aelix/agent/auth.json`.
 */
export function loadEnvironment(base: Record<string, string>, agentDirectory: string): Record<string, string> {
  return { ...base, AELIX_CODING_AGENT_DIR: agentDirectory };
}
