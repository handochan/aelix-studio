/** Exercise the extension helper and pinned ACP launcher against an installed Preview payload. */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ExtensionService, STATE_ENVIRONMENT, type ProxyCredentialVault } from '../src/studio-extensions';
import { baseEnvironment } from '../src/studio-extensions/flow/environment';
import { runToExit, spawnChild, windowsChildSpawn, type Child, type Spawn } from '../src/studio-extensions/process';
import { generationPaths, locateLayout, resolveBundle } from '../src/studio-extensions/store/layout';
import { acquireMutationLock } from '../src/studio-extensions/store/lock';
import { readPointer, type GenerationRecord } from '../src/studio-extensions/store/pointer';
import type {
  ExtensionCommand,
  ExtensionListing,
  ExtensionOperation,
  ExtensionReply,
  ExtensionSettingsState,
} from '../src/studio-extensions/types';
import { buildWheel, writeWheel } from './fixtures/extensionWheels';

type Message = {
  id?: number;
  error?: unknown;
  result?: { sessionId?: string; _meta?: Record<string, unknown>; generation?: string; extensions?: unknown };
  params?: { sessionId?: string; update?: { sessionUpdate?: string; availableCommands?: { name: string }[] } };
};

type Evidence = {
  checks: string[];
  phaseDurationsMs: Record<string, number>;
  windowsPathLengths?: { dataFilePathUtf16Units: number; consoleExePathUtf16Units: number; shebangUtf8Bytes: number };
};

const windows = process.platform === 'win32';
const localName = 'studio-os-import';
const onlineName = 'studio-os-index';
const launcherArgs = ['-I', '-S', '-B', '-X', 'utf8'];

async function until<T>(description: string, check: () => T | undefined | Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 90_000;
  do {
    /* oxlint-disable no-await-in-loop -- a bounded observation of an asynchronous child */
    const value = await check();
    if (value !== undefined) return value;
    await delay(40);
    /* oxlint-enable no-await-in-loop */
  } while (Date.now() < deadline);
  throw new Error('Timed out waiting for ' + description);
}

async function close(child: Child): Promise<void> {
  child.end();
  const timer = setTimeout(() => child.kill('SIGKILL'), 8000);
  try {
    await child.exited;
  } finally {
    clearTimeout(timer);
  }
}

async function qualify(payload: string, scratch: string, evidence: Evidence): Promise<void> {
  const { checks } = evidence;
  const bundle = await resolveBundle(payload);
  assert(bundle, 'installed Preview bundle did not resolve');
  const root = path.join(scratch, 'user data 한글', 'studio-managed-extensions');
  const env = { ...baseEnvironment(process.env, process.platform), HOME: scratch, USERPROFILE: scratch };
  const service = new ExtensionService({ runtime: payload, root, env });
  const contender = new ExtensionService({ runtime: payload, root, env, timeouts: { lockMs: 250 } });
  const owner = 'installer-qualification';
  const layout = await locateLayout(root);
  const conversations = new Set<Child>();
  let sequence = 0;
  const dist = buildWheel({ name: onlineName });
  const urls: string[] = [];
  const server = createServer((request, response) => {
    urls.push(request.url ?? '');
    if (request.url === '/simple/' + onlineName + '/') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<a href="/' + dist.filename + '">' + dist.filename + '</a>');
    } else if (request.url === '/' + dist.filename) response.writeHead(200).end(dist.data);
    else response.writeHead(404).end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const indexUrl = 'http://127.0.0.1:' + (server.address() as AddressInfo).port + '/simple/';

  const change = async (command: ExtensionCommand, client = service): Promise<ExtensionOperation> => {
    const started = await client.request(owner, command);
    assert(started.ok && 'operationId' in started.data, JSON.stringify(started));
    const operationId = started.data.operationId;
    return until(command.action, async () => {
      const reply = await client.request(owner, { action: 'poll', operationId });
      assert(reply.ok && 'phase' in reply.data, JSON.stringify(reply));
      return ['switched', 'failed', 'cancelled'].includes(reply.data.phase) ? reply.data : undefined;
    });
  };
  const applied = async (command: ExtensionCommand): Promise<string> => {
    const operation = await change(command);
    assert(operation.phase === 'switched' && operation.generation, JSON.stringify(operation));
    return operation.generation;
  };
  const current = async (): Promise<ExtensionListing> => {
    const reply = await service.request(owner, { action: 'list' });
    assert(reply.ok && 'extensions' in reply.data, JSON.stringify(reply));
    return reply.data;
  };

  const worker = async (
    expected: string[],
    { keep = false, managed = true }: { keep?: boolean; managed?: boolean } = {}
  ): Promise<Child> => {
    const state = path.join(scratch, 'acp-' + ++sequence);
    const child = spawnChild({
      command: bundle.python,
      args: [...launcherArgs, bundle.launcher, 'acp', '--offline', '--state-dir', state],
      env: { ...env, AELIX_CODING_AGENT_DIR: path.join(state, 'agent'), [STATE_ENVIRONMENT]: root },
      cwd: scratch,
    });
    conversations.add(child);
    const messages: Message[] = [];
    let line = '';
    let errors = '';
    let exited = false;
    void child.exited.then(() => {
      exited = true;
    });
    child.onStderr((chunk) => {
      errors = (errors + chunk).slice(-8192);
    });
    child.onStdout((chunk) => {
      line += chunk;
      const lines = line.split('\n');
      line = lines.pop() ?? '';
      for (const item of lines) {
        if (!item.trim()) continue;
        try {
          messages.push(JSON.parse(item) as Message);
        } catch {
          errors += '\nInvalid ACP frame: ' + item;
          child.kill('SIGKILL');
        }
      }
    });
    const request = async (id: number, method: string, params: object) => {
      child.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      const reply = await until(method, () => {
        assert(!exited, errors);
        return messages.find((message) => message.id === id);
      });
      assert(!reply.error && reply.result, JSON.stringify(reply.error) + '\n' + errors);
      return reply.result;
    };
    const initialized = await request(1, 'initialize', { protocolVersion: 1, clientCapabilities: {} });
    assert.deepEqual(initialized._meta?.['aelix/extensionOverrides'], managed ? { version: 1 } : undefined);
    const { sessionId } = await request(2, 'session/new', { cwd: scratch, mcpServers: [] });
    assert(sessionId);
    if (managed) {
      const status = await request(3, '_aelix/manage', {
        sessionId,
        action: 'extensions/overrides/list',
        arguments: {},
      });
      assert.equal(status.generation, (await current()).current);
      if (expected.length === 0) assert.deepEqual(status.extensions, []);
    }
    const commands = await until('the ACP extension command catalogue', () => {
      assert(!exited, errors);
      return messages.find(
        ({ params }) => params?.sessionId === sessionId && params.update?.sessionUpdate === 'available_commands_update'
      )?.params?.update?.availableCommands;
    });
    assert.deepEqual(
      commands
        .map(({ name }) => name)
        .filter((name) => [localName + '-cmd', onlineName + '-cmd'].includes(name))
        .toSorted(),
      expected.map((name) => name + '-cmd').toSorted()
    );
    if (!keep) {
      await close(child);
      conversations.delete(child);
    }
    return child;
  };

  try {
    if (windows) {
      const abort = new AbortController();
      const nested =
        'import subprocess,sys; subprocess.call([sys.executable,"-I","-B","-c",' +
        '"import time; print(chr(111)+chr(107), flush=True); time.sleep(60)"], stdin=sys.stdin, stdout=sys.stdout, stderr=sys.stderr)';
      const result = await runToExit(
        windowsChildSpawn(bundle.python, bundle.launcher),
        {
          command: bundle.python,
          args: ['-I', '-B', '-c', nested],
          env,
          cwd: scratch,
        },
        {
          timeoutMs: 15_000,
          signal: abort.signal,
          closeInput: (line) => {
            if (line.trim() === 'ok') abort.abort();
            return false;
          },
        }
      );
      assert(result.cancelled && !result.timedOut, result.output);
      checks.push('Windows job cancellation drained a live descendant pipe');
    }

    const longFile =
      'studio_os_import/' +
      Array(5)
        .fill('nested-' + 'long-path-'.repeat(5))
        .join('/') +
      '/receipt.txt';
    const wheel = await writeWheel(path.join(scratch, 'imports'), {
      name: localName,
      scripts: ['studio-os-console = studio_os_import.console:main'],
      files: {
        [longFile]: 'long path verified',
        'studio_os_import/console.py':
          'import json,sys\n\ndef main():\n    print(json.dumps(sys.executable), flush=True)\n    if "--hold" in sys.argv:\n        sys.stdin.readline()\n',
      },
    });
    const first = await applied({ action: 'install', source: { kind: 'file', path: wheel } });
    const paths = (generation: string) => generationPaths(layout, generation, bundle.binding.pythonMinor);
    assert.equal(await readFile(path.join(paths(first).site, longFile), 'utf8'), 'long path verified');
    assert(await realpath(paths(first).python));
    checks.push('file import with installed Python and long Unicode state paths');

    const lock = await acquireMutationLock({ bundle, layout, spawn: spawnChild, env, waitMs: 2000 });
    try {
      assert.equal((await change({ action: 'remove', name: localName }, contender)).code, 'BUSY');
      await worker([localName]);
    } finally {
      await lock.release();
    }
    checks.push('OS lock contention, launcher lease and managed ACP snapshot in a new conversation');

    const second = await applied({ action: 'install', source: { kind: 'index', name: onlineName, indexUrl } });
    assert.deepEqual(urls, ['/simple/' + onlineName + '/', '/' + dist.filename]);
    assert((await current()).extensions.every((extension) => extension.status === 'ready'));
    const packs = path.join(paths(second).directory, 'packs');
    const name = (await readdir(packs)).find((entry) => entry.endsWith(localName));
    assert(name);
    const link = path.join(packs, name);
    assert((await lstat(link)).isSymbolicLink());
    assert.equal(await realpath(link), await realpath(path.join(paths(second).site, 'studio_os_import')));
    checks.push(windows ? 'Windows pack junction and loopback index' : 'pack symlink and loopback index');

    const script = path.join(paths(second).scripts, 'studio-os-console' + (windows ? '.exe' : ''));
    const consoleResult = await runToExit(
      spawnChild,
      { command: script, args: [], env, cwd: scratch },
      { timeoutMs: 15_000 }
    );
    assert.equal(consoleResult.code, 0, consoleResult.output);
    // realpath would collapse a POSIX venv symlink to the bundle. Compare interpreter spellings.
    const pathKey = (value: string) => (windows ? value.replace(/^\\\\\?\\/, '').toLowerCase() : value);
    assert.equal(pathKey(JSON.parse(consoleResult.output.trim()) as string), pathKey(paths(second).python));
    const dataFile = path.join(paths(second).site, longFile);
    assert.equal(await readFile(dataFile, 'utf8'), 'long path verified');
    if (windows) {
      const shim = await readFile(script);
      const zip = shim.lastIndexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
      const shebang = shim.lastIndexOf('#!', zip);
      assert(zip > shebang && shebang >= 0);
      evidence.windowsPathLengths = {
        dataFilePathUtf16Units: dataFile.length,
        consoleExePathUtf16Units: script.length,
        shebangUtf8Bytes: zip - shebang,
      };
      assert(dataFile.length > 260, 'Windows long data path did not exceed MAX_PATH');
    }
    checks.push('console script names the copied generation interpreter');

    const held = await worker([localName, onlineName], { keep: true });
    // Change only the stored lock hash. Keep the installed app and Python minor intact
    // so removing the launcher's binding check would load these extensions.
    const generationRecord = paths(second).record;
    const originalRecord = await readFile(generationRecord);
    const alteredRecord = JSON.parse(originalRecord.toString('utf8')) as GenerationRecord;
    alteredRecord.binding.dependencyLockSha256 = '0'.repeat(64);
    assert.notEqual(alteredRecord.binding.dependencyLockSha256, bundle.binding.dependencyLockSha256);
    await writeFile(generationRecord, JSON.stringify(alteredRecord));
    try {
      await worker([], { managed: false });
    } finally {
      await writeFile(generationRecord, originalRecord);
    }
    checks.push('same Python minor with mismatched lock hash starts bare');

    const alternate = path.join(scratch, 'replacement');
    await mkdir(alternate);
    for (const directory of ['python', 'native-site', 'adapter-site']) {
      /* oxlint-disable-next-line no-await-in-loop -- three fixture links, each to the immutable installation */
      await symlink(path.join(bundle.root, directory), path.join(alternate, directory), windows ? 'junction' : 'dir');
    }
    await copyFile(bundle.launcher, path.join(alternate, 'launch.py'));
    const manifest = JSON.parse(await readFile(path.join(bundle.root, 'manifest.json'), 'utf8'));
    manifest.python = Number(bundle.binding.pythonMinor.split('.')[0]) + 1 + '.0.0';
    await writeFile(path.join(alternate, 'manifest.json'), JSON.stringify(manifest));
    const replacement = await resolveBundle(alternate);
    assert(replacement);
    const before = await readPointer(layout);
    const incompatible = new ExtensionService({ runtime: alternate, root, env });
    try {
      const result = await incompatible.request(owner, { action: 'reconcile_bundle' });
      assert(result.ok && 'extensions' in result.data, JSON.stringify(result));
      assert.equal(result.data.extensions.length, 2);
      assert(result.data.extensions.every(({ status }) => status === 'reinstall_needed'));
      assert.deepEqual((await readPointer(layout)).pointer, before.pointer);
    } finally {
      await incompatible.dispose();
    }
    checks.push('incompatible bundle preserves reinstall_needed and the pointer');

    const rolled = await service.request(owner, { action: 'rollback' });
    assert(rolled.ok && 'current' in rolled.data && rolled.data.current === first, JSON.stringify(rolled));
    await worker([localName]);
    await applied({ action: 'remove', name: localName });
    await worker([]);
    assert((await readdir(layout.generations)).includes(second), 'active ACP lease lost its generation');
    const consoleHolding = windows ? spawnChild({ command: script, args: ['--hold'], env, cwd: scratch }) : undefined;
    if (consoleHolding) {
      conversations.add(consoleHolding);
      let running = '';
      consoleHolding.onStdout((chunk) => {
        running += chunk;
      });
      await until('the running Windows console launcher', () => (running.includes('\n') ? true : undefined));
    }
    await close(held);
    conversations.delete(held);
    const restored = await service.request(owner, { action: 'rollback' });
    assert(restored.ok && 'current' in restored.data && restored.data.current === first, JSON.stringify(restored));
    if (consoleHolding) {
      assert((await lstat(script)).isFile(), 'Windows retired a still running executable');
      assert(
        (await lstat(path.join(layout.generations, '.retired-' + second))).isFile(),
        'partial cleanup did not record retirement'
      );
      await applied({ action: 'remove', name: localName });
      const whileLocked = await service.request(owner, { action: 'rollback' });
      assert(
        whileLocked.ok && 'current' in whileLocked.data && whileLocked.data.current === first,
        JSON.stringify(whileLocked)
      );
      assert((await lstat(script)).isFile(), 'Windows lost the running executable during the next change');
      await close(consoleHolding);
      conversations.delete(consoleHolding);
      const sweep = await service.request(owner, { action: 'rollback' });
      assert(sweep.ok, JSON.stringify(sweep));
      checks.push('Windows locked executable permits changes and rollback and is collected after exit');
    }
    const remaining = await readdir(layout.generations);
    assert(!remaining.includes(second), 'released generation was not collected');
    assert(!remaining.includes('.retired-' + second), 'released generation still has a retirement record');
    checks.push('rollback, remove, and live then released ACP lease');
  } finally {
    await Promise.all([...conversations].map(close));
    await Promise.all([service.dispose(), contender.dispose()]);
    server.closeAllConnections();
    server.close();
  }
}

/**
 * Online installs through a proxy that asks for a user name and password (Studio #32), with
 * the installed Python and the real lock holder: credentials given per install (memory-only),
 * then saved sealed and dropped again (keychain, with a stand-in for Electron `safeStorage`).
 * pip reaches the proxy through the change's loopback relay, which signs in: the credentials
 * are never in an argument, an environment, a reply or a file.
 */
async function qualifyProxyCredentials(
  payload: string,
  scratch: string,
  checks: string[],
  checkpoint: (phase: string) => void
): Promise<void> {
  const bundle = await resolveBundle(payload);
  assert(bundle, 'installed Preview bundle did not resolve');
  const env = { ...baseEnvironment(process.env, process.platform), HOME: scratch, USERPROFILE: scratch };
  const login = { username: 'ops@corp', password: "p@ss:w/rd%zz#?& !*'()100%" };
  const secrets = ['p@ss:w/rd', encodeURIComponent(login.password), 'ops@corp', 'ops%40corp'];
  const signedIn = 'Basic ' + Buffer.from(login.username + ':' + login.password).toString('base64');
  const index = 'http://127.0.0.1:9/simple/';
  const wheels = new Map(
    ['studio-os-proxied-memory', 'studio-os-proxied-keychain'].map((name) => [name, buildWheel({ name })])
  );
  const headers: (string | undefined)[] = [];
  // pip asks a plain HTTP proxy for the absolute index URL; the proxy answers it itself.
  const proxy = createServer((request, response) => {
    headers.push(request.headers['proxy-authorization']);
    if (request.headers['proxy-authorization'] !== signedIn)
      return void response.writeHead(407, { 'proxy-authenticate': 'Basic realm="corp"' }).end();
    for (const [name, wheel] of wheels) {
      if (request.url === index + name + '/')
        return void response
          .writeHead(200, { 'content-type': 'text/html' })
          .end('<a href="http://127.0.0.1:9/' + wheel.filename + '">' + wheel.filename + '</a>');
      if (request.url === 'http://127.0.0.1:9/' + wheel.filename) return void response.writeHead(200).end(wheel.data);
    }
    response.writeHead(404).end();
  });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  const address = 'http://127.0.0.1:' + (proxy.address() as AddressInfo).port;
  const typed =
    'http://' + encodeURIComponent(login.username) + ':' + encodeURIComponent(login.password) + '@127.0.0.1:';
  const argv: string[] = [];
  const relays = new Set<string>();
  const base = windows ? windowsChildSpawn(bundle.python, bundle.launcher) : spawnChild;
  const spawn: Spawn = (spec) => {
    argv.push([spec.command, ...spec.args, ...Object.values(spec.env)].join(' '));
    if (spec.env.PIP_PROXY) relays.add(spec.env.PIP_PROXY);
    return base(spec);
  };
  const vault: ProxyCredentialVault = {
    mode: 'keychain',
    seal: (text) => Buffer.from([...text].reverse().join(''), 'utf8'),
    open: (sealed) => [...sealed.toString('utf8')].reverse().join(''),
  };
  const roots = [path.join(scratch, 'proxy memory'), path.join(scratch, 'proxy keychain')];
  const memory = new ExtensionService({ runtime: payload, root: roots[0], env, spawn });
  const keychain = new ExtensionService({ runtime: payload, root: roots[1], env, spawn, proxyVault: vault });
  const owner = 'installer-qualification';
  const replies: ExtensionReply[] = [];
  const ask = async (service: ExtensionService, command: ExtensionCommand): Promise<ExtensionReply> => {
    const reply = await service.request(owner, command);
    replies.push(reply);
    return reply;
  };
  const settings = async (service: ExtensionService, command: ExtensionCommand): Promise<ExtensionSettingsState> => {
    const reply = await ask(service, command);
    assert(reply.ok && 'credentialMode' in reply.data, JSON.stringify(reply));
    return reply.data;
  };
  const install = async (service: ExtensionService, command: ExtensionCommand): Promise<void> => {
    const started = await ask(service, command);
    assert(started.ok && 'operationId' in started.data, JSON.stringify(started));
    const operationId = started.data.operationId;
    const done = await until('proxied install', async () => {
      const reply = await ask(service, { action: 'poll', operationId });
      assert(reply.ok && 'phase' in reply.data, JSON.stringify(reply));
      return ['switched', 'failed', 'cancelled'].includes(reply.data.phase) ? reply.data : undefined;
    });
    assert.equal(done.phase, 'switched', JSON.stringify(done));
  };
  const files = async (directory: string): Promise<string[]> => {
    const found: string[] = [];
    for (const entry of await readdir(directory, { withFileTypes: true, recursive: true }))
      if (entry.isFile()) found.push(await readFile(path.join(entry.parentPath, entry.name), 'latin1'));
    return found;
  };
  try {
    const memorySettings = await settings(memory, {
      action: 'set_settings',
      settings: { proxy: address, proxyAuthentication: true },
    });
    assert.equal(memorySettings.credentialMode, 'memory-only');
    const asked = await ask(memory, {
      action: 'install',
      source: { kind: 'index', name: 'studio-os-proxied-memory', indexUrl: index },
    });
    assert.deepEqual(asked, { ok: false, code: 'PROXY_CREDENTIALS_REQUIRED' });
    checkpoint('proxy-memory-setup');
    await install(memory, {
      action: 'install',
      source: { kind: 'index', name: 'studio-os-proxied-memory', indexUrl: index },
      proxyCredentials: login,
    });
    assert(headers.includes(signedIn), 'pip never signed in to the proxy');
    checkpoint('proxy-memory-install');

    const port = (proxy.address() as AddressInfo).port;
    const saved = await settings(keychain, { action: 'set_settings', settings: { proxy: typed + port } });
    assert.equal(saved.settings.proxy, address);
    assert(saved.settings.proxyAuthentication && saved.hasSavedCredentials, JSON.stringify(saved));
    const sealedFiles = async (): Promise<string[]> =>
      (await readdir(roots[1])).filter((name) => /^proxy-credentials-[0-9a-f]{32}\.json$/.test(name));
    assert.equal((await sealedFiles()).length, 1);
    assert((await lstat(path.join(roots[1], (await sealedFiles())[0]))).isFile());
    const before = headers.length;
    checkpoint('proxy-keychain-save');
    await install(keychain, {
      action: 'install',
      source: { kind: 'index', name: 'studio-os-proxied-keychain', indexUrl: index },
    });
    assert(headers.slice(before).includes(signedIn), 'pip did not sign in with the saved credentials');
    checkpoint('proxy-keychain-install');
    for (const text of [...(await files(roots[0])), ...(await files(roots[1])), JSON.stringify(replies), ...argv])
      for (const secret of secrets) assert(!text.includes(secret), 'a proxy credential left the environment');
    checkpoint('proxy-secret-scan');
    const dropped = await settings(keychain, { action: 'set_settings', settings: { proxy: null } });
    assert(!dropped.hasSavedCredentials && !dropped.settings.proxyAuthentication, JSON.stringify(dropped));
    assert.deepEqual(await sealedFiles(), [], 'the lock holder kept dropped credentials');
    // Every installer had a relay of its own change, never the user's proxy itself.
    assert(relays.size >= 2, 'the installers had no relay');
    for (const relay of relays) assert.match(relay, /^http:\/\/run:[0-9a-f]{64}@127\.0\.0\.1:[0-9]+$/);
    checks.push('proxy credentials: per install, sealed and dropped by the lock holder, through the relay only');
  } finally {
    await Promise.all([memory.dispose(), keychain.dispose()]);
    proxy.closeAllConnections();
    proxy.close();
  }
}

const [payload, report] = process.argv.slice(2);
assert(payload && report, 'usage: extensionInstallerQualification.ts INSTALLED_PAYLOAD REPORT');
const scratch = await realpath(await mkdtemp(path.join(windows ? os.tmpdir() : '/tmp', 'studio-ext-')));
const evidence: Evidence = { checks: [], phaseDurationsMs: {} };
let phaseStarted = performance.now();
const checkpoint = (phase: string) => {
  const now = performance.now();
  const elapsedMs = Math.round(now - phaseStarted);
  phaseStarted = now;
  evidence.phaseDurationsMs[phase] = elapsedMs;
  // Print only a fixed label and a duration so completed phases survive a qualifier timeout.
  console.log('Extension qualification timing', JSON.stringify({ phase, elapsedMs }));
};
try {
  await qualify(payload, scratch, evidence);
  checkpoint('installed-runtime-checks');
  await qualifyProxyCredentials(payload, scratch, evidence.checks, checkpoint);
  checkpoint('proxy-keychain-drop-and-cleanup');
  await writeFile(report, JSON.stringify({ status: 'passed', ...evidence }, null, 2) + '\n');
} catch (error) {
  await writeFile(report, JSON.stringify({ status: 'failed', ...evidence, error: String(error) }, null, 2) + '\n');
  throw error;
} finally {
  await rm(scratch, { recursive: true, force: true });
}
