import { describe, expect, it } from 'vitest';
import { baseEnvironment, loadEnvironment, managementEnvironment } from './environment';

/** What a user's shell might export. Only the first block may reach a child. */
const SHELL: NodeJS.ProcessEnv = {
  PATH: '/usr/bin:/bin',
  HOME: '/Users/someone',
  TMPDIR: '/tmp/x',
  LANG: 'ko_KR.UTF-8',
  LC_ALL: 'C',

  PYTHONPATH: '/elsewhere/site',
  PYTHONHOME: '/elsewhere',
  PYTHONSTARTUP: '/elsewhere/startup.py',
  PYTHONUSERBASE: '/elsewhere/user',
  PYTHONDONTWRITEBYTECODE: '',
  VIRTUAL_ENV: '/elsewhere/venv',
  PIP_TARGET: '/elsewhere/target',
  PIP_INDEX_URL: 'https://mirror.example/simple',
  PIP_EXTRA_INDEX_URL: 'https://other.example/simple',
  PIP_CONFIG_FILE: '/elsewhere/pip.conf',
  PIP_BREAK_SYSTEM_PACKAGES: '1',
  PIP_CONSTRAINT: '/elsewhere/constraints.txt',
  UV_INDEX_URL: 'https://mirror.example/simple',
  HTTP_PROXY: 'http://proxy.example:8080',
  https_proxy: 'http://proxy.example:8080',
  NO_PROXY: '*',
  SSL_CERT_FILE: '/elsewhere/ca.pem',
  AELIX_SETTINGS_PATH: '/elsewhere/settings.json',
  AELIX_AUTH_PATH: '/elsewhere/auth.json',
  AELIX_CODING_AGENT_DIR: '/Users/someone/.aelix/agent',
  AELIX_CODING_AGENT_SESSION_DIR: '/elsewhere/sessions',
  AELIX_MCP_CONFIG: '/elsewhere/mcp.json',
  AELIX_PROJECT_DIR: '/elsewhere/project',
  AELIX_DEFAULT_CATALOG: 'https://catalog.example/catalog.json',
  AELIX_MODEL_CATALOG_URL: 'https://catalog.example/models.json',
  XDG_CONFIG_HOME: '/elsewhere/config',
  GIT_SSH_COMMAND: 'ssh -i /elsewhere/key',
  ANTHROPIC_API_KEY: 'secret',
};

describe('the environment of helper children', () => {
  it('passes only the allowed variables and turns bytecode writing off', () => {
    expect(baseEnvironment(SHELL, 'darwin')).toEqual({
      PATH: '/usr/bin:/bin',
      HOME: '/Users/someone',
      TMPDIR: '/tmp/x',
      LANG: 'ko_KR.UTF-8',
      LC_ALL: 'C',
      PYTHONDONTWRITEBYTECODE: '1',
    });
  });

  it('leaves out allowed variables the source does not set', () => {
    expect(baseEnvironment({ PATH: '/bin' }, 'linux')).toEqual({ PATH: '/bin', PYTHONDONTWRITEBYTECODE: '1' });
  });

  it('matches Windows variable names without regard to case', () => {
    const environment = baseEnvironment(
      {
        Path: 'C:\\Windows',
        SystemRoot: 'C:\\Windows',
        TEMP: 'C:\\Temp',
        UserProfile: 'C:\\Users\\x',
        PIP_TARGET: 'x',
        HOME: 'x',
      },
      'win32'
    );
    expect(environment).toEqual({
      Path: 'C:\\Windows',
      SystemRoot: 'C:\\Windows',
      TEMP: 'C:\\Temp',
      UserProfile: 'C:\\Users\\x',
      PYTHONDONTWRITEBYTECODE: '1',
    });
  });

  const management = {
    agentDirectory: '/data/generations/g1/agent',
    nativeSite: '/bundle/native-site',
    constraintsUrl: 'file:///data/Application%20Support/constraints.txt',
  };

  it('points native and pip at the generation and the bundle, and away from the user configuration', () => {
    const environment = managementEnvironment(baseEnvironment(SHELL, 'darwin'), 'darwin', management);
    expect(environment).toMatchObject({
      AELIX_CODING_AGENT_DIR: '/data/generations/g1/agent',
      PYTHONPATH: '/bundle/native-site',
      PIP_CONSTRAINT: 'file:///data/Application%20Support/constraints.txt',
      PIP_CONFIG_FILE: '/dev/null',
      PIP_DISABLE_PIP_VERSION_CHECK: '1',
      PIP_NO_INPUT: '1',
      PIP_NO_CACHE_DIR: '1',
      PYTHONDONTWRITEBYTECODE: '1',
    });
    expect(
      Object.keys(environment).filter((name) => /proxy|INDEX|FIND_LINKS|TARGET|AELIX_SETTINGS|XDG/i.test(name))
    ).toEqual([]);
  });

  it('names the null device the way pip compares it on Windows', () => {
    expect(managementEnvironment({}, 'win32', management).PIP_CONFIG_FILE).toBe('nul');
  });

  it('confines a file import to the stored wheels and gives the installer a dead proxy', () => {
    const environment = managementEnvironment(baseEnvironment(SHELL, 'darwin'), 'darwin', {
      ...management,
      offlineLinksUrl: 'file:///data/artifacts/0123456789abcdef',
    });
    expect(environment).toMatchObject({
      PIP_NO_INDEX: '1',
      PIP_FIND_LINKS: 'file:///data/artifacts/0123456789abcdef',
      HTTP_PROXY: 'http://127.0.0.1:9',
      HTTPS_PROXY: 'http://127.0.0.1:9',
      ALL_PROXY: 'http://127.0.0.1:9',
      NO_PROXY: '',
      https_proxy: 'http://127.0.0.1:9',
      no_proxy: '',
    });
    expect(environment.PIP_INDEX_URL).toBeUndefined();
  });

  it('gives the load check the candidate agent directory and no installer settings', () => {
    const environment = loadEnvironment(baseEnvironment(SHELL, 'darwin'), '/data/generations/g1/agent');
    expect(environment).toEqual({
      PATH: '/usr/bin:/bin',
      HOME: '/Users/someone',
      TMPDIR: '/tmp/x',
      LANG: 'ko_KR.UTF-8',
      LC_ALL: 'C',
      PYTHONDONTWRITEBYTECODE: '1',
      AELIX_CODING_AGENT_DIR: '/data/generations/g1/agent',
    });
  });
});
