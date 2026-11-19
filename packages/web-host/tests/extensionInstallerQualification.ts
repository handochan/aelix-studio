/** Exercise the extension helper and pinned ACP launcher against an installed Preview payload. */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ExtensionService, STATE_ENVIRONMENT } from '../src/studio-extensions';
import { baseEnvironment } from '../src/studio-extensions/flow/environment';
import { runToExit, spawnChild, windowsChildSpawn, type Child } from '../src/studio-extensions/process';
import { generationPaths, locateLayout, resolveBundle } from '../src/studio-extensions/store/layout';
import { acquireMutationLock } from '../src/studio-extensions/store/lock';
import { readPointer } from '../src/studio-extensions/store/pointer';
import type { ExtensionCommand, ExtensionListing, ExtensionOperation } from '../src/studio-extensions/types';
import { buildWheel, writeWheel } from './fixtures/extensionWheels';

type Message = {
  id?: number;
  error?: unknown;
  result?: { sessionId?: string };
  params?: { sessionId?: string; update?: { sessionUpdate?: string; availableCommands?: { name: string }[] } };
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

async function qualify(payload: string, scratch: string, checks: string[]): Promise<void> {
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

  const worker = async (expected: string[], binding = bundle, keep = false): Promise<Child> => {
    const state = path.join(scratch, 'acp-' + ++sequence);
    const child = spawnChild({
      command: binding.python,
      args: [...launcherArgs, binding.launcher, 'acp', '--offline', '--state-dir', state],
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
    await request(1, 'initialize', { protocolVersion: 1, clientCapabilities: {} });
    const { sessionId } = await request(2, 'session/new', { cwd: scratch, mcpServers: [] });
    assert(sessionId);
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
    checks.push('OS lock contention, launcher lease and new ACP conversation');

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
    assert.equal(await readFile(path.join(paths(second).site, longFile), 'utf8'), 'long path verified');
    checks.push('console script names the copied generation interpreter');

    const held = await worker([localName, onlineName], bundle, true);
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
    await worker([], replacement);
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
    checks.push('incompatible bundle starts bare and preserves reinstall_needed');

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
      await close(consoleHolding);
      conversations.delete(consoleHolding);
      const sweep = await service.request(owner, { action: 'rollback' });
      assert(sweep.ok, JSON.stringify(sweep));
      checks.push('Windows running executable is retained and collected after exit');
    }
    assert(!(await readdir(layout.generations)).includes(second), 'released generation was not collected');
    checks.push('rollback, remove, and live then released ACP lease');
  } finally {
    await Promise.all([...conversations].map(close));
    await Promise.all([service.dispose(), contender.dispose()]);
    server.closeAllConnections();
    server.close();
  }
}

const [payload, report] = process.argv.slice(2);
assert(payload && report, 'usage: extensionInstallerQualification.ts INSTALLED_PAYLOAD REPORT');
const scratch = await realpath(await mkdtemp(path.join(windows ? os.tmpdir() : '/tmp', 'studio-ext-')));
const checks: string[] = [];
try {
  await qualify(payload, scratch, checks);
  await writeFile(report, JSON.stringify({ status: 'passed', checks }, null, 2) + '\n');
} catch (error) {
  await writeFile(report, JSON.stringify({ status: 'failed', checks, error: String(error) }, null, 2) + '\n');
  throw error;
} finally {
  await rm(scratch, { recursive: true, force: true });
}
