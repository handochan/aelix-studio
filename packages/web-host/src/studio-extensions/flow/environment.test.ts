import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer as httpServer, type RequestListener } from 'node:http';
import { createServer as tlsServer } from 'node:tls';
import { createServer as tcpServer, type AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildWheel } from '../../../tests/fixtures/extensionWheels';
import { redactUrlCredentials, runToExit, spawnChild } from '../process';
import { baseEnvironment, loadEnvironment, managementEnvironment } from './environment';
import { startProxyRelay } from './online/proxy/relay';

/**
 * A password with the characters a proxy URL must carry encoded. `%41` reaches the proxy as
 * typed: the relay builds the Basic value, and Git never decodes it.
 */
const PROXY_LOGIN = { username: 'ops@corp', password: "p@ss:w/rd%41%zz#?& !*'()100%" };
const basic = (credentials: { username: string; password: string }): string =>
  'Basic ' + Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64');
/** Pieces of the user's credentials that must stay with the relay. */
const SECRET_PIECES = ['p@ss', 'w/rd', encodeURIComponent(PROXY_LOGIN.password), 'ops@corp', 'ops%40corp'];

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

  it('supplies an isolated Git reflog identity so local operations need no hostname lookup', () => {
    const online = { indexUrl: 'https://mirror.invalid/simple/', home: '/data/installer-home', work: '/data/work' };
    const base = baseEnvironment({ GIT_COMMITTER_EMAIL: 'ambient@example.invalid' }, 'linux');
    expect(managementEnvironment(base, 'linux', { ...management, online })).toMatchObject({
      GIT_COMMITTER_NAME: 'Aelix Studio extension installer',
      GIT_COMMITTER_EMAIL: 'extensions@studio.invalid',
    });
    expect(managementEnvironment(base, 'linux', management)).not.toHaveProperty('GIT_COMMITTER_EMAIL');
  });

  const online = { indexUrl: 'https://mirror.invalid/simple/', home: '/data/installer-home', work: '/data/work' };
  const proxy = 'http://proxy.corp.example:3128';

  it('sends every request of pip and Git through the proxy the user typed, and through no other', () => {
    const environment = managementEnvironment(baseEnvironment(SHELL, 'darwin'), 'darwin', {
      ...management,
      online: { ...online, access: { proxy } },
    });
    expect(environment).toMatchObject({
      PIP_PROXY: proxy,
      http_proxy: proxy,
      https_proxy: proxy,
      HTTP_PROXY: proxy,
      HTTPS_PROXY: proxy,
      no_proxy: '',
      NO_PROXY: '',
      GIT_CONFIG_COUNT: '7',
      GIT_CONFIG_KEY_1: 'http.proxy',
      GIT_CONFIG_VALUE_1: proxy,
    });
    // No other proxy name: the ambient ones never reach a child.
    expect(Object.values(environment).filter((value) => value.includes('proxy.example'))).toEqual([]);
    expect(environment).not.toHaveProperty('ALL_PROXY');
    expect(environment).not.toHaveProperty('all_proxy');
  });

  it('spells each proxy variable once on Windows, where names ignore case', () => {
    const environment = managementEnvironment({ SystemRoot: 'C:\\Windows' }, 'win32', {
      ...management,
      online: { ...online, home: 'C:\\data\\home', work: 'C:\\data\\work', access: { proxy } },
    });
    expect(environment).toMatchObject({ PIP_PROXY: proxy, http_proxy: proxy, https_proxy: proxy, no_proxy: '' });
    const names = Object.keys(environment).map((name) => name.toUpperCase());
    expect(names.length).toBe(new Set(names).size);
  });

  it('keeps a file import behind the dead proxy and refuses to mix it with online settings', () => {
    expect(() =>
      managementEnvironment(baseEnvironment(SHELL, 'darwin'), 'darwin', {
        ...management,
        offlineLinksUrl: 'file:///data/artifacts/0123456789abcdef',
        online: { ...online, access: { proxy } },
      })
    ).toThrow();
  });

  it('isolates Git and SSH completely while private Git is off, even when the shell has an agent', () => {
    const environment = managementEnvironment(
      baseEnvironment({ ...SHELL, SSH_AUTH_SOCK: '/tmp/agent.sock' }, 'darwin'),
      'darwin',
      { ...management, online }
    );
    expect(environment).not.toHaveProperty('SSH_AUTH_SOCK');
    expect(environment).not.toHaveProperty('GCM_INTERACTIVE');
    expect(environment.GIT_SSH_COMMAND).toContain('-F /dev/null');
    expect(environment.GIT_SSH_COMMAND).toContain('-o IdentityAgent=none');
  });

  it('with private Git, passes the agent and the user credential helpers and nothing else of Git or SSH', () => {
    const environment = managementEnvironment(baseEnvironment(SHELL, 'darwin'), 'darwin', {
      ...management,
      online: {
        ...online,
        access: {
          proxy,
          privateGit: {
            sshAuthSock: '/tmp/agent.sock',
            credentials: [
              ['credential.helper', 'osxkeychain'],
              ['credential.https://git.example.com.username', 'someone'],
            ],
          },
        },
      },
    });
    expect(environment).toMatchObject({
      SSH_AUTH_SOCK: '/tmp/agent.sock',
      GCM_INTERACTIVE: 'never',
      GIT_SSH_COMMAND: '/usr/bin/ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o UpdateHostKeys=no',
      // The user's configuration files stay out; only the copied entries apply, after the reset.
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_COUNT: '9',
      GIT_CONFIG_KEY_0: 'credential.helper',
      GIT_CONFIG_VALUE_0: '',
      GIT_CONFIG_KEY_1: 'http.proxy',
      GIT_CONFIG_VALUE_1: proxy,
      GIT_CONFIG_KEY_4: 'protocol.ssh.allow',
      GIT_CONFIG_VALUE_4: 'always',
      GIT_CONFIG_KEY_7: 'credential.helper',
      GIT_CONFIG_VALUE_7: 'osxkeychain',
      GIT_CONFIG_KEY_8: 'credential.https://git.example.com.username',
      GIT_CONFIG_VALUE_8: 'someone',
      HOME: online.home,
      NETRC: '/dev/null',
      PIP_CONFIG_FILE: '/dev/null',
      PIP_KEYRING_PROVIDER: 'disabled',
    });
    expect(environment).not.toHaveProperty('DBUS_SESSION_BUS_ADDRESS');
  });

  it('lets submodules use HTTPS only, and SSH only with private Git; the requested repository any taken scheme', () => {
    const policy = (privateGit: boolean) => {
      const environment = managementEnvironment(baseEnvironment(SHELL, 'darwin'), 'darwin', {
        ...management,
        online: { ...online, access: privateGit ? { privateGit: { credentials: [] } } : {} },
      });
      const entries: Record<string, string> = {};
      for (let index = 0; index < Number(environment.GIT_CONFIG_COUNT); index += 1)
        entries[environment[`GIT_CONFIG_KEY_${index}`]] = environment[`GIT_CONFIG_VALUE_${index}`];
      return entries;
    };
    const transports = {
      'protocol.allow': 'never',
      'protocol.https.allow': 'always',
      'protocol.git.allow': 'user',
      'protocol.file.allow': 'user',
    };
    expect(policy(false)).toMatchObject({ ...transports, 'protocol.ssh.allow': 'user' });
    expect(policy(true)).toMatchObject({ ...transports, 'protocol.ssh.allow': 'always' });
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

const port = async (server: ReturnType<typeof tcpServer>): Promise<number> => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return (server.address() as AddressInfo).port;
};
const serve = async (handler: RequestListener) => {
  const server = httpServer(handler);
  // A proxy is asked for HTTPS by CONNECT: record the tunnel and refuse it.
  const tunnels: string[] = [];
  server.on('connect', (request, socket) => {
    tunnels.push(String(request.url));
    socket.destroy();
  });
  const address = 'http://127.0.0.1:' + (await port(server));
  return {
    address,
    tunnels,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
};

// Git is not offered on Windows. These need only the system Git, not a bundle.
describe.skipIf(process.platform === 'win32')('Git behind the proxy of the extension settings', () => {
  let root = '';
  beforeAll(async () => {
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'studio-git-proxy-')));
    await Promise.all(['work', 'home', 'agent'].map((name) => mkdir(path.join(root, name))));
  });
  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });
  const environment = (proxy?: string, privateGit: boolean | [string, string][] = false): Record<string, string> =>
    managementEnvironment(baseEnvironment({ PATH: '/usr/bin:/bin' }, process.platform), process.platform, {
      agentDirectory: path.join(root, 'agent'),
      nativeSite: '/bundle/native-site',
      constraintsUrl: 'file:///constraints.txt',
      online: {
        indexUrl: 'https://index.invalid/simple/',
        home: path.join(root, 'home'),
        work: path.join(root, 'work'),
        access: {
          ...(proxy ? { proxy } : {}),
          ...(privateGit ? { privateGit: { credentials: privateGit === true ? [] : privateGit } } : {}),
        },
      },
    });
  const git = (args: string[], env: Record<string, string>, cwd = path.join(root, 'work')) =>
    runToExit(spawnChild, { command: 'git', args, env, cwd }, { timeoutMs: 20_000, tailLimit: 16_000 });

  it('sends Git over HTTPS to the proxy the user typed', async () => {
    const proxy = await serve((_request, response) => response.writeHead(404).end());
    try {
      const result = await git(['ls-remote', 'https://repo.invalid/owner/demo.git'], environment(proxy.address));
      expect(result.code).not.toBe(0);
      expect(proxy.tunnels).toContain('repo.invalid:443');
    } finally {
      proxy.close();
    }
  }, 30_000);

  it('signs in to the proxy through the relay, with the credentials exactly as typed', async () => {
    const server = httpServer();
    const seen: (string | undefined)[] = [];
    server.on('connect', (request, socket) => {
      seen.push(request.headers['proxy-authorization']);
      socket.destroy();
    });
    const address = 'http://127.0.0.1:' + String(await port(server as unknown as ReturnType<typeof tcpServer>));
    const relay = await startProxyRelay(address, PROXY_LOGIN);
    try {
      const env = environment(relay.url);
      // Git gets the relay and its token; the user's credentials are nowhere in its environment.
      for (const value of Object.values(env)) for (const piece of SECRET_PIECES) expect(value).not.toContain(piece);
      const result = await runToExit(
        spawnChild,
        {
          command: 'git',
          args: ['ls-remote', 'https://repo.invalid/owner/demo.git'],
          env,
          cwd: path.join(root, 'work'),
        },
        { timeoutMs: 20_000, redact: true }
      );
      expect(result.code).not.toBe(0);
      // Git asks the relay without the token first (curl's default); only a signed-in tunnel reaches the proxy.
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.every((header) => header === basic(PROXY_LOGIN))).toBe(true);
      expect(result.output).not.toContain(new URL(relay.url).password);
      for (const piece of SECRET_PIECES) expect(result.output).not.toContain(piece);
    } finally {
      await relay.close();
      server.closeAllConnections();
      server.close();
    }
  }, 30_000);

  it('gets the relay answer alone when the proxy refuses the sign-in', async () => {
    const server = httpServer();
    server.on('connect', (request, socket) => {
      const echo = `refused ${String(request.headers['proxy-authorization'])}`;
      socket.end(
        `HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: NTLM\r\nContent-Length: ${String(echo.length)}\r\n\r\n${echo}`
      );
    });
    const address = 'http://127.0.0.1:' + String(await port(server as unknown as ReturnType<typeof tcpServer>));
    const relay = await startProxyRelay(address, PROXY_LOGIN);
    try {
      const result = await runToExit(
        spawnChild,
        {
          command: 'git',
          args: ['ls-remote', 'https://repo.invalid/owner/demo.git'],
          env: { ...environment(relay.url), GIT_CURL_VERBOSE: '1' },
          cwd: path.join(root, 'work'),
        },
        { timeoutMs: 20_000, redact: true, secrets: relay.secrets }
      );
      expect(result.code).not.toBe(0);
      expect(relay.credentialsRejected()).toBe(true);
      expect(result.output).toMatch(/502/);
      expect(result.output).not.toMatch(/NTLM|refused Basic/);
      expect(result.output).not.toContain(basic(PROXY_LOGIN).slice('Basic '.length));
    } finally {
      await relay.close();
      server.closeAllConnections();
      server.close();
    }
  }, 30_000);

  // A certificate for 127.0.0.1 needs openssl, which CI's Linux and macOS runners have.
  it.skipIf(spawnSync('openssl', ['version']).status !== 0)(
    'reaches nothing through an https proxy whose certificate is not trusted, even with NODE_TLS_REJECT_UNAUTHORIZED=0',
    async () => {
      const [key, cert] = [path.join(root, 'proxy-key.pem'), path.join(root, 'proxy-cert.pem')];
      const made = spawnSync(
        'openssl',
        ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1'].concat([
          '-subj',
          '/CN=127.0.0.1',
          '-addext',
          'subjectAltName=IP:127.0.0.1',
        ]),
        { encoding: 'utf8' }
      );
      expect(made.status, made.stderr).toBe(0);
      const received: string[] = [];
      const server = tlsServer({ key: await readFile(key), cert: await readFile(cert) }, (socket) => {
        socket.on('error', () => socket.destroy());
        socket.on('data', (chunk: Buffer) => received.push(chunk.toString('latin1')));
      });
      server.on('tlsClientError', () => {});
      const address = 'https://127.0.0.1:' + String(await port(server as unknown as ReturnType<typeof tcpServer>));
      const before = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
      const relay = await startProxyRelay(address, PROXY_LOGIN);
      try {
        const result = await runToExit(
          spawnChild,
          {
            command: 'git',
            args: ['ls-remote', 'https://repo.invalid/owner/demo.git'],
            env: environment(relay.url),
            cwd: path.join(root, 'work'),
          },
          { timeoutMs: 20_000, redact: true, secrets: relay.secrets }
        );
        expect(result.code).not.toBe(0);
        // The handshake failed before a byte of the request, sign-in included, was sent.
        expect(received).toEqual([]);
      } finally {
        if (before === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
        else process.env.NODE_TLS_REJECT_UNAUTHORIZED = before;
        await relay.close();
        server.close();
        await rm(key, { force: true });
        await rm(cert, { force: true });
      }
    },
    30_000
  );

  it('keeps the relay token from the credential helpers of private Git', async () => {
    // The user's proxy answers a plain-HTTP repository with 200, after which Git hands the
    // proxy's credentials to the helpers (credential_approve).
    let answered = 0;
    const server = httpServer((request, response) => {
      if (request.headers['proxy-authorization'] !== basic(PROXY_LOGIN)) return void response.writeHead(407).end();
      answered += 1;
      response.writeHead(200, { 'content-type': 'text/plain' }).end('0000000000000000000000000000000000000000 HEAD\n');
    });
    const address = 'http://127.0.0.1:' + String(await port(server as unknown as ReturnType<typeof tcpServer>));
    const relay = await startProxyRelay(address, PROXY_LOGIN);
    const store = path.join(root, 'stored-credentials');
    const fetch = (env: Record<string, string>) =>
      runToExit(
        spawnChild,
        {
          command: 'git',
          // Plain HTTP only so the fake proxy can answer without TLS; Studio's own policy refuses it.
          args: ['-c', 'protocol.http.allow=always', 'ls-remote', 'http://repo.invalid/owner/demo.git'],
          env,
          cwd: path.join(root, 'work'),
        },
        { timeoutMs: 20_000, redact: true }
      );
    try {
      const env = environment(relay.url, [['credential.helper', `store --file ${store}`]]);
      await fetch(env);
      expect(answered).toBeGreaterThan(0);
      expect(await readFile(store, 'utf8').catch(() => '')).toBe('');
      // The control: without the empty helper for the relay, the user's helper stores the token.
      const unscoped = { ...env };
      const index = Object.entries(unscoped).find(([, value]) => value.startsWith('credential.http://127.0.0.1:'))?.[0];
      expect(index).toBeDefined();
      unscoped[String(index)] = 'aelix.unused';
      await fetch(unscoped);
      expect(await readFile(store, 'utf8')).toContain('run:');
    } finally {
      await rm(store, { force: true });
      await relay.close();
      server.closeAllConnections();
      server.close();
    }
  }, 30_000);

  it('ignores a proxy variable that reached Git anyway when the user set no proxy', async () => {
    let contacted = 0;
    const trap = await serve((_request, response) => {
      contacted += 1;
      response.writeHead(502).end();
    });
    try {
      const env = {
        ...environment(),
        http_proxy: trap.address,
        https_proxy: trap.address,
        HTTPS_PROXY: trap.address,
        ALL_PROXY: trap.address,
      };
      expect((await git(['ls-remote', 'https://repo.invalid/owner/demo.git'], env)).code).not.toBe(0);
      expect(contacted + trap.tunnels.length).toBe(0);
    } finally {
      trap.close();
    }
  }, 30_000);

  it('never lets Git use plain HTTP, which the request parser does not take either', async () => {
    const proxy = await serve((_request, response) => response.writeHead(404).end());
    try {
      const result = await git(['ls-remote', 'http://repo.invalid/owner/demo.git'], environment(proxy.address));
      expect(result.code).not.toBe(0);
      expect(result.output).toMatch(/transport 'http' not allowed/);
      expect(proxy.tunnels).toEqual([]);
    } finally {
      proxy.close();
    }
  }, 30_000);

  describe('submodule transports', () => {
    let made = 0;
    const listeners: { count: () => number; close: () => void; port: number }[] = [];
    const listen = async () => {
      let connections = 0;
      const server = tcpServer((socket) => {
        connections += 1;
        socket.destroy();
      });
      const entry = { count: () => connections, close: () => server.close(), port: await port(server) };
      listeners.push(entry);
      return entry;
    };
    afterAll(() => {
      for (const listener of listeners) listener.close();
    });
    /** A repository that declares one submodule at `url`; nothing needs to answer there to make it. */
    const declare = async (url: string): Promise<string> => {
      made += 1;
      const parent = path.join(root, 'parent-' + String(made));
      const plain = { PATH: '/usr/bin:/bin', HOME: path.join(root, 'home'), GIT_CONFIG_NOSYSTEM: '1' };
      const run = (args: string[]) =>
        runToExit(spawnChild, { command: 'git', args, env: plain, cwd: parent }, { timeoutMs: 20_000 });
      await mkdir(parent);
      await run(['init', '--quiet']);
      await writeFile(
        path.join(parent, '.gitmodules'),
        `[submodule "vendor"]
	path = vendor
	url = ${url}
`
      );
      await run(['update-index', '--add', '--cacheinfo', '160000,' + 'a'.repeat(40) + ',vendor']);
      await run(['add', '.gitmodules']);
      await run(['-c', 'user.name=t', '-c', 'user.email=t@t.invalid', 'commit', '--quiet', '-m', 'parent']);
      return parent;
    };
    const update = async (url: string, privateGit: boolean) => {
      const repository = await declare(url);
      const clone = repository + '-clone';
      const env = environment(undefined, privateGit);
      expect((await git(['clone', '--quiet', pathToFileURL(repository).href, clone], env)).code).toBe(0);
      return git(['submodule', 'update', '--init', '--quiet'], env, clone);
    };

    it('refuses an SSH submodule without private Git, before any connection', async () => {
      const ssh = await listen();
      const result = await update(`ssh://git@127.0.0.1:${ssh.port}/owner/vendor.git`, false);
      expect(result.code).not.toBe(0);
      expect(result.output).toMatch(/transport 'ssh' not allowed/);
      expect(ssh.count()).toBe(0);
    }, 30_000);

    it('lets private Git reach an SSH submodule', async () => {
      const ssh = await listen();
      expect((await update(`ssh://git@127.0.0.1:${ssh.port}/owner/vendor.git`, true)).code).not.toBe(0);
      expect(ssh.count()).toBeGreaterThan(0);
    }, 30_000);

    it('refuses git:// and local submodules even with private Git', async () => {
      const daemon = await listen();
      const viaGit = await update(`git://127.0.0.1:${daemon.port}/owner/vendor.git`, true);
      expect(viaGit.output).toMatch(/transport 'git' not allowed/);
      expect(daemon.count()).toBe(0);
      const local = await update(pathToFileURL(path.join(root, 'work')).href, true);
      expect(local.output).toMatch(/transport 'file' not allowed/);
    }, 30_000);
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

  const environment = (indexUrl: string, extra: NodeJS.ProcessEnv = {}, proxy?: string): Record<string, string> =>
    managementEnvironment(
      baseEnvironment({ HOME: ambientHome, PATH: '/usr/bin:/bin', ...extra }, process.platform),
      process.platform,
      {
        agentDirectory: path.join(root, 'agent'),
        nativeSite: path.join(testBundle ?? '', 'native-site'),
        constraintsUrl,
        online: { indexUrl, home: installHome, work, access: proxy ? { proxy } : {} },
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

  it('sends every pip request through the proxy the user typed, not the ambient or system one', async () => {
    const wheel = buildWheel({ name: 'studio-proxied', extension: false });
    const received: string[] = [];
    const proxy = await serve((request, response) => {
      received.push(String(request.url));
      // The origin is a loopback port nothing listens on (pip trusts plain HTTP only for loopback):
      // only the proxy can have served pip.
      if (request.url === 'http://127.0.0.1:9/simple/studio-proxied/')
        response
          .writeHead(200, { 'content-type': 'text/html' })
          .end(`<a href="http://127.0.0.1:9/${wheel.filename}">wheel</a>`);
      else if (request.url === 'http://127.0.0.1:9/' + wheel.filename) response.writeHead(200).end(wheel.data);
      else response.writeHead(404).end();
    });
    let unexpected = 0;
    const trap = await serve((_request, response) => {
      unexpected += 1;
      response.writeHead(502).end();
    });
    try {
      const env = environment('http://127.0.0.1:9/simple/', { HTTP_PROXY: trap.address }, proxy.address);
      const pip = `import runpy, sys, urllib.request as request
if sys.platform == "darwin":
    request.getproxies_macosx_sysconf = lambda: {"http": sys.argv[1], "https": sys.argv[1]}
    request.proxy_bypass_macosx_sysconf = lambda host: False
sys.argv = ["pip", "install", "--retries", "0", "studio-proxied"]
runpy.run_module("pip", run_name="__main__")`;
      const result = await run(['-P', '-B', '-c', pip, trap.address], env);
      expect(result.code, result.output).toBe(0);
      expect(received).toEqual(['http://127.0.0.1:9/simple/studio-proxied/', 'http://127.0.0.1:9/' + wheel.filename]);
      expect(unexpected).toBe(0);
    } finally {
      proxy.close();
      trap.close();
    }
  }, 40_000);

  it('signs pip in to the proxy through the relay, with the credentials exactly as typed', async () => {
    const wheel = buildWheel({ name: 'studio-signed-in', extension: false });
    const seen: (string | undefined)[] = [];
    const proxy = await serve((request, response) => {
      seen.push(request.headers['proxy-authorization']);
      if (request.headers['proxy-authorization'] !== basic(PROXY_LOGIN))
        return response.writeHead(407, { 'proxy-authenticate': 'Basic realm="corp"' }).end();
      if (request.url === 'http://127.0.0.1:9/simple/studio-signed-in/')
        response
          .writeHead(200, { 'content-type': 'text/html' })
          .end(`<a href="http://127.0.0.1:9/${wheel.filename}">wheel</a>`);
      else if (request.url === 'http://127.0.0.1:9/' + wheel.filename) response.writeHead(200).end(wheel.data);
      else response.writeHead(404).end();
    });
    const relay = await startProxyRelay(proxy.address, PROXY_LOGIN);
    try {
      const env = environment('http://127.0.0.1:9/simple/', {}, relay.url);
      for (const value of Object.values(env)) for (const piece of SECRET_PIECES) expect(value).not.toContain(piece);
      const result = await run(['-P', '-B', '-m', 'pip', 'install', '--retries', '0', 'studio-signed-in'], env);
      expect(result.code, redactUrlCredentials(result.output)).toBe(0);
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.every((header) => header === basic(PROXY_LOGIN))).toBe(true);
    } finally {
      await relay.close();
      proxy.close();
    }
  }, 40_000);

  it('gets the relay answer alone when the proxy refuses pip the sign-in', async () => {
    const proxy = await serve((request, response) =>
      response
        .writeHead(407, { 'proxy-authenticate': 'NTLM', 'x-upstream-only': 'kept' })
        .end(`refused ${String(request.headers['proxy-authorization'])}`)
    );
    const relay = await startProxyRelay(proxy.address, PROXY_LOGIN);
    try {
      const env = environment('http://127.0.0.1:9/simple/', {}, relay.url);
      const result = await run(['-P', '-B', '-m', 'pip', 'install', '--retries', '0', 'studio-refused'], env);
      expect(result.code).not.toBe(0);
      expect(relay.credentialsRejected()).toBe(true);
      expect(result.output).not.toMatch(/NTLM|refused Basic|x-upstream-only/i);
      expect(result.output).not.toContain(basic(PROXY_LOGIN).slice('Basic '.length));
    } finally {
      await relay.close();
      proxy.close();
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
