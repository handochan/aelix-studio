import { once } from 'node:events';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer as httpServer, type RequestListener } from 'node:http';
import { createServer as tcpServer, type AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildWheel } from '../../../tests/fixtures/extensionWheels';
import { runToExit, spawnChild } from '../process';
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

  it('isolates online tools from ambient config, credentials and proxy discovery', () => {
    const online = { indexUrl: 'https://mirror.invalid/simple/', home: '/data/installer-home', work: '/data/work' };
    const environment = managementEnvironment(baseEnvironment(SHELL, 'darwin'), 'darwin', {
      ...management,
      online,
    });
    expect(environment).toMatchObject({
      HOME: online.home,
      XDG_CONFIG_HOME: online.home,
      TMPDIR: online.work,
      PIP_INDEX_URL: online.indexUrl,
      PIP_CONFIG_FILE: '/dev/null',
      PIP_KEYRING_PROVIDER: 'disabled',
      NETRC: '/dev/null',
      no_proxy: '*',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_KEY_0: 'credential.helper',
      GIT_CONFIG_VALUE_0: '',
      GIT_CONFIG_KEY_1: 'http.proxy',
      GIT_CONFIG_VALUE_1: '',
    });
    expect(environment.GIT_SSH_COMMAND).toContain('/usr/bin/ssh -F /dev/null');
    expect(environment).not.toHaveProperty('PIP_NO_INPUT');
    expect(environment).not.toHaveProperty('HTTPS_PROXY');
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

// Run against a relocatable Preview bundle assembled by packaging/bundle.py.
// The usual unit suite needs neither Git, Python nor a prepared bundle.
const testBundle = process.env.AELIX_EXTENSION_TEST_BUNDLE;
describe.skipIf(!testBundle || process.platform === 'win32')('bundled pip and Git installer isolation', () => {
  let root = '';
  let python = '';
  let work = '';
  let ambientHome = '';
  let installHome = '';
  let constraintsUrl = '';
  const port = async (server: ReturnType<typeof tcpServer>): Promise<number> => {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return (server.address() as AddressInfo).port;
  };
  const serve = async (handler: RequestListener) => {
    const server = httpServer(handler);
    const address = 'http://127.0.0.1:' + (await port(server));
    return {
      address,
      close: () => {
        server.closeAllConnections();
        server.close();
      },
    };
  };

  const environment = (indexUrl: string, extra: NodeJS.ProcessEnv = {}): Record<string, string> =>
    managementEnvironment(
      baseEnvironment({ HOME: ambientHome, PATH: '/usr/bin:/bin', ...extra }, process.platform),
      process.platform,
      {
        agentDirectory: path.join(root, 'agent'),
        nativeSite: path.join(testBundle ?? '', 'native-site'),
        constraintsUrl,
        online: { indexUrl, home: installHome, work },
      }
    );
  const run = (args: string[], env: Record<string, string>, command = python) =>
    runToExit(spawnChild, { command, args, env, cwd: work }, { timeoutMs: 30_000, tailLimit: 32_000 });

  beforeAll(async () => {
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'studio-extension-tools-')));
    work = path.join(root, 'work');
    ambientHome = path.join(root, 'user-home');
    installHome = path.join(root, 'install-home');
    await Promise.all([mkdir(work), mkdir(ambientHome), mkdir(installHome)]);
    const constraints = path.join(root, 'constraints.txt');
    await writeFile(constraints, '');
    constraintsUrl = pathToFileURL(constraints).href;
    const venv = path.join(root, 'venv');
    const bundled = path.resolve(testBundle ?? '', 'python', 'bin', 'python3');
    const created = await run(['-I', '-B', '-m', 'venv', venv], baseEnvironment({}, process.platform), bundled);
    if (created.code !== 0) throw new Error(created.output);
    python = path.join(venv, 'bin', 'python');
  }, 40_000);
  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('uses the selected index with no ambient proxy, pip config or netrc credentials', async () => {
    const wheel = buildWheel({ name: 'studio-probe', extension: false });
    const received: { url?: string; auth?: string }[] = [];
    let unexpected = 0;
    const index = await serve((request, response) => {
      received.push({ url: request.url, auth: request.headers.authorization });
      if (request.url === '/simple/studio-probe/')
        response.writeHead(200, { 'content-type': 'text/html' }).end(`<a href="/${wheel.filename}">wheel</a>`);
      else if (request.url === '/' + wheel.filename) response.writeHead(200).end(wheel.data);
      else response.writeHead(404).end();
    });
    const trap = await serve((_request, response) => {
      unexpected += 1;
      response.writeHead(502).end();
    });
    try {
      const config = path.join(ambientHome, 'pip.conf');
      const netrc = path.join(ambientHome, '.netrc');
      await writeFile(
        config,
        `[global]
index-url = ${trap.address}/simple/
`
      );
      await writeFile(netrc, 'machine 127.0.0.1 login synthetic password synthetic\n', { mode: 0o600 });
      const env = environment(index.address + '/simple/', {
        PIP_CONFIG_FILE: config,
        PIP_EXTRA_INDEX_URL: trap.address + '/simple/',
        HTTP_PROXY: trap.address,
        NETRC: netrc,
      });

      // Inject just the system proxy API result on macOS, without changing machine preferences.
      // The rest of proxy resolution and the requests run inside the bundled pip.
      const pip = `import runpy, sys, urllib.request as request
if sys.platform == "darwin":
    request.getproxies_macosx_sysconf = lambda: {"http": sys.argv[1]}
    request.proxy_bypass_macosx_sysconf = lambda host: False
sys.argv = ["pip", "install", "--retries", "0", "studio-probe"]
runpy.run_module("pip", run_name="__main__")`;
      const result = await run(['-P', '-B', '-c', pip, trap.address], env);
      expect(result.code, result.output).toBe(0);
      expect(received).toEqual([
        { url: '/simple/studio-probe/', auth: undefined },
        { url: '/' + wheel.filename, auth: undefined },
      ]);
      expect(unexpected).toBe(0);
    } finally {
      index.close();
      trap.close();
    }
  }, 40_000);

  it('keeps the isolated SSH command when bundled pip invokes real Git', async () => {
    let connections = 0;
    const listener = tcpServer((socket) => {
      connections += 1;
      socket.destroy();
    });
    const sshPort = await port(listener);
    try {
      const gitconfig = path.join(ambientHome, '.gitconfig');
      await writeFile(gitconfig, '[alias]\nambient = status\n');
      const env = environment('http://127.0.0.1:9/simple/', {
        GIT_CONFIG_GLOBAL: gitconfig,
        GIT_SSH_COMMAND: '/usr/bin/false',
        PIP_NO_INPUT: '1',
      });
      const config = await run(['config', '--get', 'alias.ambient'], env, '/usr/bin/git');
      expect(config.code).toBe(1);
      const result = await run(['-P', '-B', '-m', 'pip', 'install', `git+ssh://git@127.0.0.1:${sshPort}/probe.git`], {
        ...env,
        GIT_TRACE: '1',
      });
      expect(result.code, result.output).toBe(1);
      expect(result.output).toContain('/usr/bin/ssh -F /dev/null -o BatchMode=yes -o StrictHostKeyChecking=yes');
      expect(connections).toBeGreaterThan(0);
    } finally {
      listener.close();
    }
  }, 40_000);
});
