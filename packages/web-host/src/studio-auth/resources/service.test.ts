import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NativeResourcesService } from './service.js';
import fixture from './studio-7-d16-v1.json';

const cases = new Map(fixture.map((entry) => [entry.id, entry]));
function resolveRefs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(resolveRefs);
  if (value === null || typeof value !== 'object') return value;
  if ('$fixture' in value && typeof value.$fixture === 'string') {
    const [id, pointer] = value.$fixture.split('#');
    let target: unknown = cases.get(id);
    for (const part of pointer.slice(1).split('/')) {
      target = (target as Record<string, unknown>)[part.replaceAll('~1', '/').replaceAll('~0', '~')];
    }
    return resolveRefs(target);
  }
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, resolveRefs(entry)]));
}
const command = (id: string) => resolveRefs(cases.get(id)!.command) as Record<string, unknown>;
const reply = (id: string) => resolveRefs(cases.get(id)!.reply) as { ok: boolean; data?: Record<string, unknown> };
const mockSpawn = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      const implementation = mockSpawn.getMockImplementation();
      return implementation ? mockSpawn(...args) : actual.spawn(...args);
    },
  };
});

async function preparedRuntime(root: string, native?: string): Promise<string> {
  const runtime = path.join(root, 'runtime');
  await mkdir(runtime);
  await writeFile(path.join(runtime, 'launch.cjs'), '');
  const bin = process.platform === 'win32' ? 'Scripts' : 'bin';
  const python = process.platform === 'win32' ? 'python.exe' : 'python';
  await mkdir(path.join(runtime, 'adapter', bin), { recursive: true });
  await writeFile(path.join(runtime, 'adapter', bin, python), '');
  if (native) {
    await symlink(native, path.join(runtime, 'native'), 'junction');
  } else {
    await mkdir(path.join(runtime, 'native', bin), { recursive: true });
    await writeFile(path.join(runtime, 'native', bin, python), '');
  }
  return runtime;
}

function serve(result: (input: Record<string, unknown>) => unknown | Promise<unknown>): void {
  mockSpawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      kill: () => queueMicrotask(() => child.emit('close', null)),
    });
    let line = '';
    child.stdin.on('data', (chunk) => {
      line += String(chunk);
    });
    child.stdin.on('end', () => {
      void Promise.resolve(result(JSON.parse(line))).then((data) => {
        if (data !== undefined) child.stdout.write(JSON.stringify(data) + '\n');
        child.emit('close', data === undefined ? 1 : 0);
      });
    });
    queueMicrotask(() => child.emit('spawn'));
    return child;
  });
}

describe('D16 global resources service', () => {
  let root: string;
  let runtime: string;
  let service: NativeResourcesService;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'studio-resources-test-'));
    runtime = await preparedRuntime(root);
    service = new NativeResourcesService({ runtime, env: { AELIX_CODING_AGENT_DIR: root } });
  });
  afterEach(async () => {
    service.dispose();
    mockSpawn.mockReset();
    vi.useRealTimers();
    await rm(root, { recursive: true, force: true });
  });

  it('loads the pinned 137-example fixture byte for byte', async () => {
    const body = await readFile(new URL('./studio-7-d16-v1.json', import.meta.url));
    expect(fixture).toHaveLength(137);
    expect(createHash('sha256').update(body).digest('hex')).toBe(
      'c5341c0d677faa21ba8294ec3350edabc3a15942889529df4e8c6b4a00f53627'
    );
  });

  it.each([
    'helper-profile-show',
    'helper-skills',
    'helper-mcp',
    'helper-global-readonly',
    'helper-set-tool',
    'helper-set-skill',
    'helper-set-mcp',
    'helper-set-noop',
    'helper-error-profile_unavailable',
    'helper-error-revision_conflict',
    'helper-error-selection_missing',
    'helper-error-selection_locked',
    'helper-error-scope_readonly',
    'helper-error-store_unreadable',
    'helper-error-busy',
    'helper-error-save_failed',
    'helper-error-helper_unavailable',
  ])('uses the %s stdio example without exposing error detail', async (id) => {
    const expected = reply(id);
    serve((input) => {
      expect(input).toEqual(command(id));
      return expected.ok ? expected : { ...expected, message: 'private' };
    });
    expect(await service.request('web:test', command(id))).toEqual(expected);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  it.each(['helper-error-invalid_input', 'helper-error-scope_denied', 'helper-error-cursor_stale'])(
    'rejects %s before starting Python',
    async (id) => {
      expect(await service.request('web:test', command(id))).toEqual(reply(id));
      expect(mockSpawn).not.toHaveBeenCalled();
    }
  );

  it.each(['profiles', 'tools'])('pages, scopes, and expires the %s fixture snapshot', async (catalog) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const id = 'helper-' + catalog;
    const first = reply(id + '-first').data!;
    const next = reply(id + '-next').data!;
    const rows = catalog === 'profiles' ? 'profiles' : 'items';
    const all = [...(next[rows] as unknown[]), ...(first[rows] as unknown[])];
    serve(() => ({ ok: true, data: { ...first, [rows]: all, nextCursor: null } }));
    const actual = await service.request('web:test', command(id + '-first'));
    expect(actual).toEqual({ ok: true, data: { ...first, nextCursor: expect.any(String) } });
    if (actual.ok === false) throw new Error(actual.code);
    const cursor = actual.data.nextCursor;
    const follow = { ...command(id + '-next'), cursor };
    expect(await service.request('web:other', follow)).toEqual(reply('helper-error-cursor_stale'));
    expect(
      await service.request('web:test', { action: 'selections/list', scope: 'global', kind: 'skill', cursor })
    ).toEqual(reply('helper-error-cursor_stale'));
    expect(await service.request('web:test', follow)).toEqual({ ok: true, data: next });
    expect(await service.request('web:test', follow)).toEqual({ ok: true, data: next });
    vi.setSystemTime(Date.now() + 60000);
    expect(await service.request('web:test', follow)).toEqual(reply('helper-error-cursor_stale'));
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  it('fits UTF-8 rows within the complete envelope and rejects a row that cannot fit', async () => {
    const entry = (name: string, size: number) => ({
      ref: { name, scope: 'user', revision: 'sha256:' + '0'.repeat(64) },
      description: '界'.repeat(size),
    });
    serve(() => ({ ok: true, data: { profiles: [entry('a', 50000), entry('b', 50000)], diagnostics: [] } }));
    const first = await service.request('desktop:1', { action: 'profiles/list' });
    expect(first).toEqual({
      ok: true,
      data: { profiles: [entry('a', 50000)], diagnostics: [], nextCursor: expect.any(String) },
    });
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(256 * 1024);
    serve(() => ({ ok: true, data: { profiles: [entry('a', 90000)], diagnostics: [] } }));
    expect(await service.request('desktop:1', { action: 'profiles/list' })).toEqual(
      reply('helper-error-result_too_large')
    );
  });

  it('coalesces identical in-flight writes and rejects a reused id with another digest', async () => {
    serve(() => reply('helper-set-tool'));
    const original = command('helper-set-tool');
    const first = service.request('web:test', original);
    const second = service.request('web:test', { ...original, changes: [{ on: false, key: 'read' }] });
    expect(await service.request('web:test', command('helper-error-request_id_conflict'))).toEqual(
      reply('helper-error-request_id_conflict')
    );
    expect(await Promise.all([first, second])).toEqual([reply('helper-set-tool'), reply('helper-set-tool')]);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    await service.request('web:other', original);
    expect(mockSpawn).toHaveBeenCalledTimes(2);
  });

  it('keeps ambiguous dispatched writes in the receipt cache with no retry', async () => {
    serve(() => undefined);
    const input = command('helper-error-outcome_unknown');
    expect(await service.request('web:test', input)).toEqual(reply('helper-error-outcome_unknown'));
    expect(await service.request('web:test', input)).toEqual(reply('helper-error-outcome_unknown'));
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  it('limits receipts without evicting a live write and retires completed receipts at 600 seconds', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    serve(() => reply('helper-set-tool'));
    const saved = command('helper-set-tool');
    for (let i = 0; i < 256; i++) {
      await service.request('one', {
        ...saved,
        requestId: '019aa123-0001-7000-8000-' + i.toString(16).padStart(12, '0'),
      });
    }
    const input = { ...saved, requestId: '019aa123-0001-7000-8000-000000000100' };
    expect(await service.request('one', input)).toEqual(reply('helper-error-dedup_capacity'));
    vi.setSystemTime(Date.now() + 600000);
    expect(await service.request('one', input)).toEqual(reply('helper-set-tool'));
    expect(mockSpawn).toHaveBeenCalledTimes(257);
  });

  it('refuses a missing selected runtime', async () => {
    const unavailable = new NativeResourcesService({ runtime: path.join(root, 'missing') });
    expect(await unavailable.request('web:test', command('helper-error-runtime_unavailable'))).toEqual(
      reply('helper-error-runtime_unavailable')
    );
    expect(mockSpawn).not.toHaveBeenCalled();
  });
});

const exec = promisify(execFile);
const nativeSource = process.env.STUDIO_RESOURCES_NATIVE_SOURCE;
const pin = '83714045439478b17ab0c61248dc5c414435927a';

async function waitForFile(file: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt++) {
    if ((await readFile(file, 'utf8').catch(() => '')) === 'ready') return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Native lock probe did not reach its barrier');
}

describe.skipIf(!nativeSource || process.platform === 'win32')('isolated pinned native end-to-end', () => {
  let root: string;
  let agent: string;
  let env: NodeJS.ProcessEnv;
  let python: string;
  let runtime: string;
  let service: NativeResourcesService;
  const tool = command('helper-tools-first');
  const skill = command('helper-skills');
  const mcp = command('helper-mcp');
  const initialSettings = '{"defaultTools":["read"],"skills":["+review"],"unrelated":{"keep":true}}\n';
  const settingsPath = () => path.join(agent, 'settings.json');
  const mcpPath = () => path.join(agent, 'mcp.json');
  const owner = 'desktop:native-test';

  async function current(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const result = await service.request(owner, input);
    if (result.ok === false) throw new Error(result.code);
    return result.data;
  }

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'studio-resources-native-'));
    agent = path.join(root, 'agent');
    const home = path.join(root, 'home');
    for (const dir of [agent, home, path.join(agent, 'skills', 'review'), path.join(agent, 'agents')]) {
      await mkdir(dir, { recursive: true });
    }
    const source = path.resolve(nativeSource!);
    expect((await exec('git', ['-C', source, 'rev-parse', 'HEAD'])).stdout.trim()).toBe(pin);
    const venv = path.join(source, '.venv');
    python = path.join(venv, 'bin', 'python');
    runtime = await preparedRuntime(root, venv);
    env = {
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: path.join(home, '.config'),
      AELIX_CODING_AGENT_DIR: agent,
      PATH: process.env.PATH,
      PI_OFFLINE: '1',
    };
    service = new NativeResourcesService({ runtime, env });
    await writeFile(settingsPath(), initialSettings);
    await writeFile(
      path.join(agent, 'skills', 'review', 'SKILL.md'),
      '---\nname: review\ndescription: Review notes\n---\nReview only.\n'
    );
  });

  afterEach(async () => {
    service.dispose();
    mockSpawn.mockReset();
    await rm(root, { recursive: true, force: true });
  });

  it('matches fixture profile and selection data, then writes identical tool and skill settings bytes to the CLI', async () => {
    const vectors = resolveRefs(cases.get('profile-ref')!.vectors) as { rawUtf8: string }[];
    const profilePath = path.join(agent, 'agents', 'quiet.md');
    await writeFile(profilePath, vectors[0].rawUtf8);
    const data = await current(command('helper-profile-show'));
    // Different isolated root => a different source URI and ref; the remaining profile fields are literal examples.
    const expected = reply('helper-profile-show').data!.profile as Record<string, unknown>;
    const uri = (
      await exec(
        python,
        [
          '-I',
          '-B',
          '-c',
          'from pathlib import Path; import sys; print(Path(sys.argv[1]).resolve().as_uri())',
          profilePath,
        ],
        { env }
      )
    ).stdout.trim();
    const revision =
      'sha256:' +
      createHash('sha256')
        .update('studio-profile/1\0user\0' + uri + '\0')
        .update(vectors[0].rawUtf8)
        .digest('hex');
    expect(data.profile).toEqual({ ...expected, ref: { name: 'quiet', scope: 'user', revision } });
    const toolRows = await current({ ...tool, limit: 100 });
    expect(toolRows.items).toContainEqual((reply('helper-tools-first').data!.items as unknown[])[0]);
    const skillRows = await current(skill);
    expect(skillRows.items).toContainEqual((reply('helper-skills').data!.items as unknown[])[0]);

    for (const [id, list] of [
      ['helper-set-tool', tool],
      ['helper-set-skill', skill],
    ] as const) {
      const edited = await current({ ...command(id), expectedRevision: (await current(list)).revision });
      expect(edited).toEqual({ ...reply(id).data, revision: expect.any(String) });
      if (id === 'helper-set-tool') {
        const noop = await current({ ...command('helper-set-noop'), expectedRevision: edited.revision });
        expect(noop).toEqual({ ...reply('helper-set-noop').data, revision: edited.revision });
      }
    }
    const helperBytes = await readFile(settingsPath());
    await writeFile(settingsPath(), initialSettings);
    const child = spawn(
      python,
      [
        '-I',
        '-B',
        '-m',
        'aelix_coding_agent',
        '--mode',
        'rpc',
        '--offline',
        '--no-extensions',
        '--no-agents',
        '--no-session',
        '--no-approve',
        '--no-context-files',
      ],
      { env, cwd: root, stdio: ['pipe', 'pipe', 'ignore'] }
    );
    const wire = createInterface({ input: child.stdout });
    const responses = wire[Symbol.asyncIterator]();
    try {
      for (const [id, kind] of [
        ['helper-set-tool', 'tool'],
        ['helper-set-skill', 'skill'],
      ]) {
        child.stdin.write(
          JSON.stringify({
            type: 'aelix_control',
            id,
            method: 'selections/set',
            params: { kind, scope: 'global', changes: command(id).changes },
          }) + '\n'
        );
        let message: { id?: string; success?: boolean };
        do {
          const line = await responses.next();
          if (line.done) throw new Error('Pinned CLI exited before replying');
          message = JSON.parse(line.value);
        } while (message.id !== id);
        expect(message.success).toBe(true);
      }
      expect(await readFile(settingsPath())).toEqual(helperBytes);
    } finally {
      child.stdin.end();
      wire.close();
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) return resolve();
        child.once('close', () => resolve());
        child.kill('SIGKILL');
      });
    }
  }, 35000);

  it.each(['tool', 'mcp'])(
    'rejects a stale %s write after an already-held CLI lock lets its owner commit',
    async (kind) => {
      const list = kind === 'tool' ? tool : mcp;
      const id = kind === 'tool' ? 'helper-set-tool' : 'helper-set-mcp';
      const initialMcp =
        '{ "mcpServers": { "local-docs": {"command":"unused","enabled":true}, "other": {"command":"unused","enabled":true} } }\n';
      await writeFile(mcpPath(), initialMcp);
      const old = await current(list);
      const locked = path.join(root, 'cli-locked');
      const waiting = path.join(root, 'helper-waiting');
      const release = path.join(root, 'release');
      const cliWriter = `
import asyncio, os, sys, threading, time
from pathlib import Path
root, kind, locked, release = sys.argv[1:]
def barrier():
    Path(locked).write_text("ready")
    for _ in range(1000):
        if Path(release).exists(): return
        time.sleep(.02)
    raise RuntimeError("barrier expired")
if kind == "tool":
    from aelix_ai.settings import SettingsManager
    def edit(entries):
        barrier()
        return [*entries, "write"]
    asyncio.run(SettingsManager.create(os.getcwd(), root, project_trusted=False).edit_list("global", "defaultTools", edit, nullable=True))
else:
    from aelix_coding_agent.core.mcp_config_edit import write_enabled
    def authorize(real):
        barrier()
    assert write_enabled(Path(root) / "mcp.json", [("other", False)], authorize=authorize, abandoned=threading.Event()).status == "written"
`;
      const writer = exec(python, ['-I', '-B', '-c', cliWriter, agent, kind, locked, release], {
        env,
        cwd: root,
        timeout: 30000,
      });
      void writer.catch(() => {}); // Await and surface the result after releasing the barrier.
      const real = await vi.importActual<typeof import('node:child_process')>('node:child_process');
      const seam =
        kind === 'tool'
          ? `original_lock = FileSettingsStorage._lock_fd
def traced_lock(fd, label):
    Path(${JSON.stringify(waiting)}).write_text("ready")
    return original_lock(fd, label)
FileSettingsStorage._lock_fd = staticmethod(traced_lock)`
          : `original_lock = mcp_writer._platform_lock
def traced_lock(*args):
    Path(${JSON.stringify(waiting)}).write_text("ready")
    return original_lock(*args)
mcp_writer._platform_lock = traced_lock`;
      mockSpawn.mockImplementation((file: string, args: string[], options: object) => {
        const source = args.at(-1)!;
        const body = source.replace('class Refusal(Exception):', seam + '\n\nclass Refusal(Exception):');
        return real.spawn(file, [...args.slice(0, -1), body], options);
      });
      let pending: ReturnType<NativeResourcesService['request']> | undefined;
      try {
        await waitForFile(locked);
        pending = service.request(owner, { ...command(id), expectedRevision: old.revision });
        await waitForFile(waiting);
      } finally {
        await writeFile(release, 'release');
        await writer;
        mockSpawn.mockReset();
      }
      const refused = await pending;
      const fresh = await current(list);
      expect(refused).toEqual({ ...reply('helper-error-revision_conflict'), currentRevision: fresh.revision });
      const expected =
        kind === 'tool'
          ? { ...JSON.parse(initialSettings), defaultTools: ['read', 'write'] }
          : initialMcp.replace(
              '"other": {"command":"unused","enabled":true}',
              '"other": {"command":"unused","enabled":false}'
            );
      const target = kind === 'tool' ? settingsPath() : mcpPath();
      const bytes = await readFile(target, 'utf8');
      expect(kind === 'tool' ? JSON.parse(bytes) : bytes).toEqual(expected);
      if (kind === 'mcp') {
        const edited = await current({
          ...command(id),
          requestId: '019aa123-0001-7000-8000-000000000090',
          expectedRevision: fresh.revision,
        });
        expect(edited).toEqual({ ...reply(id).data, revision: expect.any(String) });
        expect(await readFile(target, 'utf8')).toBe(
          bytes.replace(
            '"local-docs": {"command":"unused","enabled":true}',
            '"local-docs": {"command":"unused","enabled":false}'
          )
        );
      }
    },
    35000
  );

  it('lists all global catalogs with zero model HTTP requests, MCP connections or credential reads', async () => {
    let modelRequests = 0;
    let mcpConnections = 0;
    const listener = createServer((req, res) => {
      if (req.url?.startsWith('/model')) modelRequests++;
      res.writeHead(500).end();
    });
    listener.on('connection', () => mcpConnections++);
    await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
    const url = 'http://127.0.0.1:' + (listener.address() as AddressInfo).port;
    try {
      await writeFile(
        path.join(agent, 'models.json'),
        JSON.stringify({
          providers: {
            probe: {
              baseUrl: url + '/model',
              api: 'openai-completions',
              apiKey: 'synthetic',
              models: [{ id: 'probe' }],
            },
          },
        })
      );
      await writeFile(
        mcpPath(),
        JSON.stringify({
          mcpServers: {
            'local-docs': {
              transport: 'http',
              url: url + '/mcp?token=synthetic-secret',
              headers: { Authorization: 'synthetic-secret' },
            },
          },
        })
      );
      const auth = path.join(agent, 'auth.json');
      await writeFile(auth, '---\nname: secret-test\ndescription: synthetic-secret\n---\nsecret test\n');
      await symlink(auth, path.join(agent, 'agents', 'secret-test.md'));
      const outputs = await Promise.all([
        current({ action: 'profiles/list' }),
        current(tool),
        current(skill),
        current(mcp),
      ]);
      expect(outputs[0].diagnostics).toContainEqual({
        code: 'invalid-profile',
        key: null,
        source: 'user:agents/secret-test.md',
      });
      expect(outputs[3].items).toEqual(reply('helper-mcp').data!.items);
      expect(JSON.stringify(outputs)).not.toContain('synthetic-secret');
      expect({ modelRequests, mcpConnections }).toEqual({ modelRequests: 0, mcpConnections: 0 });
    } finally {
      listener.closeAllConnections();
      await new Promise<void>((resolve) => listener.close(() => resolve()));
    }
  }, 25000);
});
