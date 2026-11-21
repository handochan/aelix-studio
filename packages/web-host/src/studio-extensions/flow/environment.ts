import path from 'node:path';
import type { PrivateGitAccess } from './online/credentials.js';

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
  /** Studio's only online index and a private directory for installer configuration and temporary files. */
  online?: { indexUrl: string; home: string; work: string; access?: OnlineAccess };
};

/** What the user configured for online installs in Studio's extension settings. */
export type OnlineAccess = {
  /**
   * The proxy the user typed (normalized `http(s)://host[:port]`). pip gets it as its own
   * `--proxy` (`PIP_PROXY`), which also keeps pip from reading environment proxies and netrc;
   * Git and anything else that reads the standard variables get it there and as `http.proxy`.
   */
  proxy?: string;
  /** Present when the user turned private Git on. */
  privateGit?: PrivateGitAccess;
};

/** The isolated SSH command: no user configuration, keys or agent; known hosts still checked. */
const ISOLATED_SSH =
  '/usr/bin/ssh -F /dev/null -o BatchMode=yes -o StrictHostKeyChecking=yes -o UpdateHostKeys=no' +
  ' -o IdentityFile=none -o IdentityAgent=none -o CertificateFile=none';

/**
 * The SSH command with private Git: the user's SSH configuration, keys and agent apply, but
 * never a prompt, and only hosts already in the user's known hosts (command-line options take
 * precedence over the configuration).
 */
const PRIVATE_SSH = '/usr/bin/ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o UpdateHostKeys=no';

/** The proxy variables every proxy-aware tool reads, and the one that keeps pip to its own. */
function proxyVariables(proxy: string | undefined, platform: NodeJS.Platform): Record<string, string> {
  // Without a proxy, a nonempty bypass-all keeps urllib and requests from discovering a system
  // proxy (macOS preferences, Windows registry) and Git's curl from using an environment one.
  if (proxy === undefined) return { no_proxy: '*' };
  // Windows treats names without regard to case: one spelling each.
  const variables: Record<string, string> = { PIP_PROXY: proxy, http_proxy: proxy, https_proxy: proxy, no_proxy: '' };
  return platform === 'win32' ? variables : { ...variables, HTTP_PROXY: proxy, HTTPS_PROXY: proxy, NO_PROXY: '' };
}

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
  // A file import runs behind the dead proxy below; nothing of the online settings may reopen it.
  if (options.offlineLinksUrl !== undefined && options.online)
    throw new Error('an offline import has no online installer settings');
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
  if (options.online) {
    const { home, work, indexUrl, access } = options.online;
    const proxy = proxyVariables(access?.proxy, platform);
    // pip 26 overwrites GIT_SSH_COMMAND when PIP_NO_INPUT is present. Keep the
    // custom SSH command and use closed stdin, disabled keyring and askpass instead.
    if (platform === 'win32') {
      // Keep the interpreter's Windows system utilities and use no ambient Git,
      // proxy, credential store, or per-user installation configuration.
      for (const name of Object.keys(environment))
        if (
          ['PATH', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH'].includes(
            name.toUpperCase()
          )
        )
          delete environment[name];
      const system = Object.entries(base).find(([name]) => name.toUpperCase() === 'SYSTEMROOT')?.[1] ?? 'C:\\Windows';
      Object.assign(environment, {
        PATH: path.win32.join(system, 'System32'),
        HOME: home,
        USERPROFILE: home,
        APPDATA: home,
        LOCALAPPDATA: home,
        XDG_CONFIG_HOME: home,
        TMP: work,
        TEMP: work,
        PIP_INDEX_URL: indexUrl,
        PIP_KEYRING_PROVIDER: 'disabled',
        NETRC: nullDevice(platform),
        ...proxy,
      });
      return environment;
    }
    delete environment.PIP_NO_INPUT;
    const privateGit = access?.privateGit;
    // The helper is reset first; with private Git the user's credential entries follow in order.
    const gitConfig: [string, string][] = [
      ['credential.helper', ''],
      ['http.proxy', access?.proxy ?? ''],
      // Transports. `user` allows one only for what the user asked for (the repository of the
      // request), never for a submodule a repository declares: Git marks submodule commands as
      // not from the user. Submodules may use HTTPS, which goes through the proxy, and SSH only
      // with private Git; `git://`, plain HTTP, local paths and helpers are never theirs.
      ['protocol.allow', 'never'],
      ['protocol.https.allow', 'always'],
      ['protocol.ssh.allow', privateGit ? 'always' : 'user'],
      ['protocol.git.allow', 'user'],
      ['protocol.file.allow', 'user'],
      ...(privateGit?.credentials ?? []),
    ];
    Object.assign(environment, {
      HOME: home,
      XDG_CONFIG_HOME: home,
      TMPDIR: work,
      PATH: '/usr/bin:/bin',
      PIP_INDEX_URL: indexUrl,
      PIP_KEYRING_PROVIDER: 'disabled',
      NETRC: nullDevice(platform),
      ...proxy,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: nullDevice(platform),
      GIT_CEILING_DIRECTORIES: path.dirname(work),
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: '/usr/bin/false',
      GIT_CONFIG_COUNT: String(gitConfig.length),
      ...Object.fromEntries(
        gitConfig.flatMap(([name, value], index) => [
          [`GIT_CONFIG_KEY_${index}`, name],
          [`GIT_CONFIG_VALUE_${index}`, value],
        ])
      ),
      // OpenSSH resolves its default key locations through the account database,
      // even when HOME is private. Without private Git: host verification only, no ambient keys.
      GIT_SSH_COMMAND: privateGit ? PRIVATE_SSH : ISOLATED_SSH,
    });
    if (privateGit) {
      // A credential manager must fail rather than open a window behind the installer.
      environment.GCM_INTERACTIVE = 'never';
      if (privateGit.sshAuthSock) environment.SSH_AUTH_SOCK = privateGit.sshAuthSock;
      if (privateGit.dbusSessionBusAddress) environment.DBUS_SESSION_BUS_ADDRESS = privateGit.dbusSessionBusAddress;
    }
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
