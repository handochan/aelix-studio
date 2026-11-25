import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { link, lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { promisify } from 'node:util';
import { gunzipSync, gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NativeResourcesService } from './service.js';
import fixture from './studio-7-d16-v1.json';
import baseline from '../../../../../scripts/studio-preview/baseline.json';

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

const manifestProbe = vi.hoisted(() => ({
  path: undefined as string | undefined,
  open: undefined as ((stage: 'before' | 'after') => void) | undefined,
  bounded: 0,
  unbounded: 0,
}));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      if (args[0] !== manifestProbe.path) return actual.openSync(...args);
      manifestProbe.bounded++;
      manifestProbe.open?.('before');
      const fd = actual.openSync(...args);
      manifestProbe.open?.('after');
      return fd;
    },
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
      if (args[0] === manifestProbe.path) {
        manifestProbe.unbounded++;
        manifestProbe.open?.('before');
        // A regression must fail the assertion without blocking on a FIFO.
        throw new Error('Unbounded manifest read');
      }
      return actual.readFileSync(...args);
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

// Decode the launch payload so the same seam can reproduce a bug in the raw-argv helper.
function injectNative(real: typeof import('node:child_process'), edit: (source: string) => string): void {
  mockSpawn.mockImplementation((file: string, args: string[], options: { cwd: string }) => {
    const bootstrap = args.at(-1)!;
    const encoded = /b64decode\('([a-z0-9+/=]+)'\)/i.exec(bootstrap)?.[1];
    const source = encoded ? gunzipSync(Buffer.from(encoded, 'base64')).toString('utf8') : bootstrap;
    const updated = edit(source);
    const payload = encoded ? bootstrap.replace(encoded, gzipSync(updated).toString('base64')) : updated;
    return real.spawn(file, [...args.slice(0, -1), payload], options);
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
    Object.assign(manifestProbe, { path: undefined, open: undefined, bounded: 0, unbounded: 0 });
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

  it('returns BUSY before spawning more than four fresh helpers and recovers when they exit', async () => {
    let unblock!: (reply: unknown) => void;
    const held = new Promise((resolve) => {
      unblock = resolve;
    });
    serve(() => held);
    const requests = Array.from({ length: 5 }, () => service.request('owner', command('helper-skills')));
    try {
      await expect(
        Promise.race([requests[4], new Promise((resolve) => setTimeout(resolve, 500, 'blocked'))])
      ).resolves.toEqual(reply('helper-error-busy'));
    } finally {
      unblock(reply('helper-skills'));
      await Promise.all(requests);
    }
    expect(mockSpawn).toHaveBeenCalledTimes(4);
    expect(await service.request('owner', command('helper-skills'))).toEqual(reply('helper-skills'));
  });

  it('keeps in-flight profile pages across a settings save and invalidates both settings catalogs', async () => {
    const toolFirst = reply('helper-tools-first').data!;
    const skillFirst = reply('helper-skills').data!;
    const profileFirst = reply('helper-profiles-first').data!;
    let unblock!: () => void;
    const held = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    serve(async (input) => {
      if (input.action === 'profiles/list') {
        await held;
        return {
          ok: true,
          data: {
            ...profileFirst,
            profiles: [
              ...(profileFirst.profiles as unknown[]),
              ...(reply('helper-profiles-next').data!.profiles as unknown[]),
            ],
          },
        };
      }
      if (input.action === 'selections/set') return reply('helper-set-tool');
      const data = input.kind === 'tool' ? toolFirst : skillFirst;
      const items = data.items as { key: string }[];
      return { ok: true, data: { ...data, items: [...items, { ...items[0], key: 'zz' }] } };
    });
    const toolPage = await service.request('owner', command('helper-tools-first'));
    const skillPage = await service.request('owner', { ...command('helper-skills'), limit: 1 });
    const profiles = service.request('owner', command('helper-profiles-first'));
    try {
      expect(await service.request('owner', command('helper-set-tool'))).toEqual(reply('helper-set-tool'));
    } finally {
      unblock();
    }
    const profilePage = await profiles;
    expect(profilePage).toMatchObject({ ok: true, data: { nextCursor: expect.any(String) } });
    for (const [kind, page] of [
      ['tool', toolPage],
      ['skill', skillPage],
    ] as const) {
      if (page.ok === false) throw new Error(page.code);
      expect(
        await service.request('owner', {
          action: 'selections/list',
          scope: 'global',
          kind,
          cursor: page.data.nextCursor,
        })
      ).toEqual(reply('helper-error-cursor_stale'));
    }
  });

  it.each(['receipt.json', 'launch.cjs', 'manifest.json'])(
    'invalidates cached pages and the revision seed when runtime %s changes in place',
    async (file) => {
      if (file === 'manifest.json') {
        const bin = process.platform === 'win32' ? 'python' : 'python/bin';
        await mkdir(path.join(runtime, bin), { recursive: true });
        await writeFile(path.join(runtime, bin, process.platform === 'win32' ? 'python.exe' : 'python3'), '');
        await writeFile(path.join(runtime, 'launch.py'), '# launcher');
      }
      const digest = (text: string) => createHash('sha256').update(text).digest('hex');
      const metadata = {
        schema: 'aelix.studio-preview.runtime/1',
        target: `${process.platform}-${process.arch}`,
        launcherSha256: digest(''),
        recipeSha256: { 'launch.cjs': digest(''), 'launch.py': digest('# launcher') },
      };
      await writeFile(path.join(runtime, file), JSON.stringify({ ...metadata, generation: 1 }));
      const first = reply('helper-tools-first').data!;
      const next = reply('helper-tools-next').data!;
      const seeds: string[] = [];
      serve(() => {
        seeds.push(mockSpawn.mock.lastCall![2].env.STUDIO_RESOURCES_REVISION_KEY);
        return { ok: true, data: { ...first, items: [...(first.items as unknown[]), ...(next.items as unknown[])] } };
      });
      const page = await service.request('owner', command('helper-tools-first'));
      if (page.ok === false) throw new Error(page.code);
      await writeFile(path.join(runtime, file), JSON.stringify({ ...metadata, generation: 2 }));
      expect(await service.request('owner', { ...command('helper-tools-next'), cursor: page.data.nextCursor })).toEqual(
        reply('helper-error-cursor_stale')
      );
      expect(mockSpawn).toHaveBeenCalledTimes(1);
      expect(await service.request('owner', command('helper-tools-first'))).toMatchObject({ ok: true });
      expect(seeds[1]).not.toBe(seeds[0]);
    }
  );

  it.skipIf(process.platform === 'win32')(
    'invalidates the receipt-bound page when a prepared venv is replaced with the same base Python',
    async () => {
      const native = path.join(runtime, 'native');
      const sharedPython = path.join(root, 'python');
      const replacement = path.join(root, 'replacement');
      await writeFile(sharedPython, '');
      await rm(path.join(native, 'bin', 'python'));
      await symlink(sharedPython, path.join(native, 'bin', 'python'));
      await mkdir(path.join(replacement, 'bin'), { recursive: true });
      await symlink(sharedPython, path.join(replacement, 'bin', 'python'));
      await writeFile(
        path.join(runtime, 'receipt.json'),
        JSON.stringify({
          target: `${process.platform}-${process.arch}`,
          launcherSha256: createHash('sha256').update('').digest('hex'),
        })
      );
      const first = reply('helper-tools-first').data!;
      const next = reply('helper-tools-next').data!;
      serve(() => ({
        ok: true,
        data: { ...first, items: [...(first.items as unknown[]), ...(next.items as unknown[])] },
      }));
      const page = await service.request('owner', command('helper-tools-first'));
      if (page.ok === false) throw new Error(page.code);
      await rm(native, { recursive: true });
      await symlink(replacement, native, 'junction');
      expect(await service.request('owner', { ...command('helper-tools-next'), cursor: page.data.nextCursor })).toEqual(
        reply('helper-error-cursor_stale')
      );
    }
  );

  it('invalidates a prepared cursor and revision seed after a package-only update', async () => {
    const site = path.join(runtime, 'native', process.platform === 'win32' ? 'Lib' : 'lib/python3.12', 'site-packages');
    const dist = path.join(site, 'aelix_coding_agent-0.1.dist-info');
    await mkdir(dist, { recursive: true });
    const record = path.join(dist, 'RECORD');
    await writeFile(record, 'aelix_coding_agent/__init__.py,sha256=old,12\n');
    await writeFile(
      path.join(runtime, 'receipt.json'),
      JSON.stringify({
        target: `${process.platform}-${process.arch}`,
        launcherSha256: createHash('sha256').update('').digest('hex'),
      })
    );
    const first = reply('helper-tools-first').data!;
    const next = reply('helper-tools-next').data!;
    const seeds: string[] = [];
    serve(() => {
      seeds.push(mockSpawn.mock.lastCall![2].env.STUDIO_RESOURCES_REVISION_KEY);
      return { ok: true, data: { ...first, items: [...(first.items as unknown[]), ...(next.items as unknown[])] } };
    });
    const page = await service.request('owner', command('helper-tools-first'));
    if (page.ok === false) throw new Error(page.code);
    await writeFile(record, 'aelix_coding_agent/__init__.py,sha256=new,12\n');
    expect(await service.request('owner', { ...command('helper-tools-next'), cursor: page.data.nextCursor })).toEqual(
      reply('helper-error-cursor_stale')
    );
    expect(await service.request('owner', command('helper-tools-first'))).toMatchObject({ ok: true });
    expect(seeds[1]).not.toBe(seeds[0]);
  });

  it.each(['oversized', 'FIFO'])('rejects a manifest swapped for a %s file at open time', async (kind) => {
    if (kind === 'FIFO' && process.platform === 'win32') return;
    const manifest = path.join(runtime, 'manifest.json');
    const replacement = path.join(runtime, 'replacement');
    await writeFile(manifest, '{}');
    if (kind === 'FIFO') {
      await exec('mkfifo', [replacement]);
    } else {
      await writeFile(replacement, '{}');
      await truncate(replacement, 1024 * 1024 + 1);
    }
    const fs = await vi.importActual<typeof import('node:fs')>('node:fs');
    manifestProbe.path = manifest;
    manifestProbe.open = (stage) => {
      if (stage === 'before') fs.renameSync(replacement, manifest);
    };
    serve(() => reply('helper-skills'));
    expect(await service.request('owner', command('helper-skills'))).toEqual(reply('helper-error-runtime_unavailable'));
    expect({ bounded: manifestProbe.bounded, unbounded: manifestProbe.unbounded }).toEqual({
      bounded: 1,
      unbounded: 0,
    });
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === 'win32')('selects and seals a cached page from the same open manifest', async () => {
    const manifest = path.join(runtime, 'manifest.json');
    const replacement = path.join(runtime, 'replacement');
    const bin = path.join(runtime, 'python', 'bin');
    await mkdir(bin, { recursive: true });
    await writeFile(path.join(bin, 'python3'), '');
    await writeFile(path.join(runtime, 'launch.py'), '# launcher');
    const digest = (value: string) => createHash('sha256').update(value).digest('hex');
    await writeFile(
      manifest,
      JSON.stringify({
        schema: 'aelix.studio-preview.runtime/1',
        target: `${process.platform}-${process.arch}`,
        recipeSha256: { 'launch.cjs': digest(''), 'launch.py': digest('# launcher') },
      })
    );
    await writeFile(replacement, '{}');
    const first = reply('helper-tools-first').data!;
    const next = reply('helper-tools-next').data!;
    serve(() => ({
      ok: true,
      data: { ...first, items: [...(first.items as unknown[]), ...(next.items as unknown[])] },
    }));
    const page = await service.request('owner', command('helper-tools-first'));
    if (page.ok === false) throw new Error(page.code);
    const follow = { ...command('helper-tools-next'), cursor: page.data.nextCursor };
    const fs = await vi.importActual<typeof import('node:fs')>('node:fs');
    manifestProbe.path = manifest;
    manifestProbe.open = (stage) => {
      if (stage === 'after') fs.renameSync(replacement, manifest);
    };
    expect(await service.request('owner', follow)).toEqual({ ok: true, data: next });
    expect({ bounded: manifestProbe.bounded, unbounded: manifestProbe.unbounded }).toEqual({
      bounded: 1,
      unbounded: 0,
    });
    manifestProbe.open = undefined;
    expect(await service.request('owner', follow)).toEqual(reply('helper-error-cursor_stale'));
  });

  it.each([
    [{ USERPROFILE: 'C:\\Native', HOMEDRIVE: 'Z:', HOMEPATH: '\\Fallback' }, '~/mcp.json', 'C:\\Native\\mcp.json'],
    [{ HOMEDRIVE: 'Z:', HOMEPATH: '\\Fallback' }, '~/mcp.json', 'Z:\\Fallback\\mcp.json'],
    [{ USERPROFILE: 'C:\\Native' }, '~\\mcp.json', 'C:\\Native\\mcp.json'],
  ] as const)(
    'expands Windows MCP home from %j and %s while ignoring HOME',
    async (windowsEnv, configured, expected) => {
      await mkdir(path.join(runtime, 'native', 'Scripts'), { recursive: true });
      await mkdir(path.join(runtime, 'adapter', 'Scripts'), { recursive: true });
      await writeFile(path.join(runtime, 'native', 'Scripts', 'python.exe'), '');
      await writeFile(path.join(runtime, 'adapter', 'Scripts', 'python.exe'), '');
      const target = Object.getOwnPropertyDescriptor(process, 'platform')!;
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      const windows = new NativeResourcesService({
        runtime,
        env: { HOME: 'C:\\Wrong', AELIX_CODING_AGENT_DIR: 'C:\\Agent', AELIX_MCP_CONFIG: configured, ...windowsEnv },
      });
      try {
        serve(() => reply('helper-global-readonly'));
        expect(await windows.request('owner', command('helper-mcp'))).toEqual(reply('helper-global-readonly'));
        expect(mockSpawn.mock.lastCall![2].env.AELIX_MCP_CONFIG).toBe(expected);
      } finally {
        windows.dispose();
        Object.defineProperty(process, 'platform', target);
      }
    }
  );

  it('keeps the spawned helper command line within the Windows limit', async () => {
    serve(() => reply('helper-skills'));
    await service.request('owner', command('helper-skills'));
    const [file, args] = mockSpawn.mock.lastCall! as [string, string[]];
    // CreateProcess counts the program, separators and quoting toward 32767 characters.
    const line = [file, ...args].map((arg) => '"' + arg.replace(/"/g, '\\"') + '"').join(' ');
    expect(line.length).toBeLessThan(32767);
  });

  it('refuses an installed launcher that differs from its receipt before spawning', async () => {
    await writeFile(
      path.join(runtime, 'receipt.json'),
      JSON.stringify({
        target: `${process.platform}-${process.arch}`,
        launcherSha256: createHash('sha256').update('sealed launcher').digest('hex'),
      })
    );
    serve(() => reply('helper-skills'));
    expect(await service.request('owner', command('helper-skills'))).toEqual(reply('helper-error-runtime_unavailable'));
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('refuses oversized runtime metadata before starting a helper', async () => {
    const receipt = path.join(runtime, 'receipt.json');
    await writeFile(
      receipt,
      JSON.stringify({
        target: `${process.platform}-${process.arch}`,
        launcherSha256: createHash('sha256').update('').digest('hex'),
        padding: ' '.repeat(1024 * 1024),
      })
    );
    serve(() => reply('helper-skills'));
    expect(await service.request('owner', command('helper-skills'))).toEqual(reply('helper-error-runtime_unavailable'));
    expect(mockSpawn).not.toHaveBeenCalled();
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
const pin = baseline.native.sourceTag.commit;

async function waitForFile(file: string): Promise<void> {
  for (let attempt = 0; attempt < 800; attempt++) {
    if ((await readFile(file, 'utf8').catch(() => '')) === 'ready') return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Native lock probe did not reach its barrier');
}

const onWindows = process.platform === 'win32';

/** Give another principal write access: POSIX mode bits, or a Windows ACE for Users or Everyone. */
async function openToOthers(directory: string, mode: '0775' | '0770' | '0757'): Promise<void> {
  if (!onWindows) {
    await exec('chmod', [mode, directory]);
    return;
  }
  // BUILTIN\Users for group write, Everyone for world write.
  const principal = mode === '0757' ? '*S-1-1-0' : '*S-1-5-32-545';
  await exec('icacls', [directory, '/grant', `${principal}:(OI)(CI)M`]);
}

describe.skipIf(!nativeSource)('isolated pinned native end-to-end', () => {
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
    python = onWindows ? path.join(venv, 'Scripts', 'python.exe') : path.join(venv, 'bin', 'python');
    runtime = await preparedRuntime(root, venv);
    env = {
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: path.join(home, '.config'),
      AELIX_CODING_AGENT_DIR: agent,
      PATH: process.env.PATH,
      PI_OFFLINE: '1',
      // Windows Python needs these for Winsock, randomness and temporary files.
      ...(onWindows
        ? {
            SYSTEMROOT: process.env.SYSTEMROOT,
            WINDIR: process.env.WINDIR,
            TEMP: process.env.TEMP,
            TMP: process.env.TMP,
          }
        : {}),
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

    const skillChanges = [
      { key: 'extending-aelix', on: false },
      { key: 'review', on: false },
    ];
    for (const [id, list] of [
      ['helper-set-tool', tool],
      ['helper-set-skill', skill],
    ] as const) {
      const changes = id === 'helper-set-skill' ? skillChanges : command(id).changes;
      const edited = await current({ ...command(id), changes, expectedRevision: (await current(list)).revision });
      expect(edited).toMatchObject({ scope: 'global', kind: list.kind, saved: true, revision: expect.any(String) });
      if (id === 'helper-set-skill') {
        expect(edited.changed).toEqual(expect.arrayContaining(skillChanges.map(({ key }) => ({ key, saved: false }))));
      } else {
        expect(edited).toEqual({ ...reply(id).data, revision: expect.any(String) });
      }
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
            params: { kind, scope: 'global', changes: kind === 'skill' ? skillChanges : command(id).changes },
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
  }, 90000);

  it.each(['tool', 'linked tool', 'mcp'])(
    'rejects a stale %s write after an already-held CLI lock lets its owner commit',
    async (scenario) => {
      const kind = scenario === 'mcp' ? 'mcp' : 'tool';
      const targetDir = path.join(agent, 'relocated');
      if (scenario === 'linked tool') {
        await mkdir(targetDir);
        await writeFile(path.join(targetDir, 'other.json'), initialSettings);
        await rm(settingsPath());
        await symlink(path.join(targetDir, 'other.json'), settingsPath());
      }
      const list = kind === 'tool' ? tool : mcp;
      const id = kind === 'tool' ? 'helper-set-tool' : 'helper-set-mcp';
      const initialMcp =
        '{ "mcpServers": { "local-docs": {"command":"unused","enabled":true}, "other": {"command":"unused","enabled":true} } }\n';
      await writeFile(mcpPath(), initialMcp);
      const old = await current(list);
      const locked = path.join(root, 'cli-locked');
      const waiting = path.join(root, 'helper-waiting');
      const release = path.join(root, 'release');
      const sidecar = path.join(root, 'helper-sidecar');
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
        timeout: 60000,
      });
      void writer.catch(() => {}); // Await and surface the result after releasing the barrier.
      const real = await vi.importActual<typeof import('node:child_process')>('node:child_process');
      const seam =
        kind === 'tool'
          ? `original_sidecar = FileSettingsStorage._sidecar_lock
def traced_sidecar(self, target):
    Path(${JSON.stringify(sidecar)}).write_text(str(self._sidecar_path(target).parent.resolve()))
    return original_sidecar(self, target)
FileSettingsStorage._sidecar_lock = traced_sidecar
original_lock = FileSettingsStorage._lock_fd
def traced_lock(fd, label):
    Path(${JSON.stringify(waiting)}).write_text("ready")
    return original_lock(fd, label)
FileSettingsStorage._lock_fd = staticmethod(traced_lock)`
          : `original_lock = mcp_writer._platform_lock
def traced_lock(*args):
    Path(${JSON.stringify(waiting)}).write_text("ready")
    return original_lock(*args)
mcp_writer._platform_lock = traced_lock`;
      injectNative(real, (source) => source.replace('def diagnostic(', seam + '\n\ndef diagnostic('));
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
      if (scenario === 'linked tool') {
        const configuredLocks = (
          await exec(
            python,
            [
              '-I',
              '-B',
              '-c',
              'from pathlib import Path; import sys; print(Path(sys.argv[1]).resolve())',
              path.join(agent, 'locks'),
            ],
            { env }
          )
        ).stdout.trim();
        expect(await readFile(sidecar, 'utf8')).toBe(configuredLocks);
        expect((await lstat(settingsPath())).isSymbolicLink()).toBe(true);
      }
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
    90000
  );

  it.each(['dangling link', 'outside link', 'credential hard link'])(
    'refuses a settings %s before reading or locking it',
    async (scenario) => {
      const old = await current(tool);
      const target = path.join(root, 'outside.json');
      await rm(settingsPath());
      if (scenario === 'credential hard link') {
        const credential = path.join(agent, 'auth.json');
        await writeFile(credential, '{"synthetic-credential":"may not be copied"}', { mode: 0o600 });
        await link(credential, settingsPath());
      } else {
        if (scenario === 'outside link') await writeFile(target, initialSettings);
        await symlink(target, settingsPath());
      }
      expect(await service.request(owner, tool)).toEqual(reply('helper-error-store_unreadable'));
      expect(await service.request(owner, { ...command('helper-set-tool'), expectedRevision: old.revision })).toEqual(
        reply('helper-error-store_unreadable')
      );
      await expect(lstat(path.join(agent, 'locks'))).rejects.toMatchObject({ code: 'ENOENT' });
      if (scenario === 'dangling link') await expect(lstat(target)).rejects.toMatchObject({ code: 'ENOENT' });
      if (scenario === 'outside link') expect(await readFile(target, 'utf8')).toBe(initialSettings);
    },
    90000
  );

  it.each(['group-writable lock', 'linked lock', 'group-writable settings ancestor', 'world-writable agent root'])(
    'reports and refuses a %s directory before writing',
    async (kind) => {
      const sidecar = path.join(agent, 'locks');
      const relocated = path.join(agent, 'relocated');
      const target =
        kind === 'group-writable settings ancestor' ? path.join(relocated, 'settings.json') : settingsPath();
      if (kind === 'group-writable lock') {
        await mkdir(sidecar);
        await openToOthers(sidecar, '0775');
      } else if (kind === 'linked lock') {
        const outside = path.join(root, 'redirect');
        await mkdir(outside);
        await symlink(outside, sidecar, 'dir');
      } else if (kind === 'group-writable settings ancestor') {
        await mkdir(relocated, { mode: 0o700 });
        await rename(settingsPath(), target);
        await symlink(target, settingsPath());
        await openToOthers(relocated, '0770');
      } else {
        await openToOthers(agent, '0757');
      }
      const old = await current(tool);
      expect(old).toMatchObject({ writable: false, reason: 'read-only' });
      expect(await service.request(owner, { ...command('helper-set-tool'), expectedRevision: old.revision })).toEqual(
        reply('helper-error-scope_readonly')
      );
      expect(await readFile(target, 'utf8')).toBe(initialSettings);
      if (kind !== 'linked lock' && kind !== 'group-writable lock') {
        await expect(lstat(sidecar)).rejects.toMatchObject({ code: 'ENOENT' });
      }
    },
    90000
  );

  // The user-private-group rule reads POSIX NSS; Windows uses owner and DACL checks instead.
  it.skipIf(onWindows).each([
    ['private group', {}, true],
    ['private group across an NSS miss after the replacement', { nssDownAfterReplace: true }, true],
    ['shared group', { members: ['other'] }, false],
    ['differently named group', { name: 'staff' }, false],
    ["group that is another account's primary group", { others: ['other'] }, false],
    ['group missing from NSS', { missing: true }, false],
    ['private group with a POSIX ACL', { acl: true }, false],
  ] as const)(
    'applies the user-private-group rule to a group-writable lock directory (%s)',
    async (_label, overrides, allowed) => {
      const sidecar = path.join(agent, 'locks');
      await mkdir(sidecar);
      await exec('chmod', ['0775', sidecar]);
      const config = {
        lock: sidecar,
        name: 'studio',
        members: [] as readonly string[],
        others: [] as readonly string[],
        missing: false,
        acl: false,
        nssDownAfterReplace: false,
        ...overrides,
      };
      // Present the lock directory's group as the user's primary group, then vary NSS and ACL answers.
      const seam = `import grp, pwd
from types import SimpleNamespace
from aelix_ai.settings import storage as seam_storage
config = json.loads(${JSON.stringify(JSON.stringify(config))})
lock_gid = os.stat(config["lock"]).st_gid
uid = os.geteuid()
nss = dict(down=False)
user = SimpleNamespace(pw_name="studio", pw_uid=uid, pw_gid=lock_gid)
real_getpwuid, real_getgrgid, real_replace = pwd.getpwuid, grp.getgrgid, seam_storage._replace
def fake_group(gid):
    if gid != lock_gid:
        return real_getgrgid(gid)
    if config["missing"] or nss["down"]:
        raise KeyError(gid)
    return SimpleNamespace(gr_name=config["name"], gr_mem=config["members"])
def replace_then_lose_nss(src, dst):
    real_replace(src, dst)
    nss["down"] = config["nssDownAfterReplace"]
pwd.getpwuid = lambda value: user if value == uid else real_getpwuid(value)
pwd.getpwall = lambda: [user] + [SimpleNamespace(pw_name=name, pw_uid=uid + 1 + index, pw_gid=lock_gid)
    for index, name in enumerate(config["others"])]
grp.getgrgid = fake_group
seam_storage._replace = replace_then_lose_nss
if config["acl"]:
    os.listxattr = lambda path, *args, **kwargs: ["user.note", "system.posix_acl_access"]`;
      const real = await vi.importActual<typeof import('node:child_process')>('node:child_process');
      injectNative(real, (source) => source.replace('def diagnostic(', seam + '\n\ndef diagnostic('));
      const old = await current(tool);
      expect(old).toMatchObject(allowed ? { writable: true, reason: null } : { writable: false, reason: 'read-only' });
      const result = await service.request(owner, { ...command('helper-set-tool'), expectedRevision: old.revision });
      if (allowed) {
        expect(result).toMatchObject({ ok: true, data: { saved: true } });
        expect(JSON.parse(await readFile(settingsPath(), 'utf8'))).toMatchObject({ unrelated: { keep: true } });
        expect(await readFile(settingsPath(), 'utf8')).not.toBe(initialSettings);
      } else {
        expect(result).toEqual(reply('helper-error-scope_readonly'));
        expect(await readFile(settingsPath(), 'utf8')).toBe(initialSettings);
      }
    },
    90000
  );

  it.each(['dotfile-style symlinked agent root', 'linked settings directory inside a symlinked agent root'])(
    'resolves a %s before applying the directory policy',
    async (scenario) => {
      const dotfiles = path.join(root, 'dotfiles');
      const realAgent = path.join(dotfiles, 'agent');
      await mkdir(dotfiles, { mode: 0o700 });
      await rename(agent, realAgent);
      await symlink(realAgent, agent, 'dir');
      let target = path.join(realAgent, 'settings.json');
      let linked = service;
      if (scenario !== 'dotfile-style symlinked agent root') {
        await mkdir(path.join(realAgent, 'conf-real'), { mode: 0o700 });
        target = path.join(realAgent, 'conf-real', 'settings.json');
        await writeFile(target, initialSettings);
        await symlink(path.join(realAgent, 'conf-real'), path.join(realAgent, 'conf'), 'dir');
        linked = new NativeResourcesService({
          runtime,
          env: { ...env, AELIX_SETTINGS_PATH: path.join(agent, 'conf', 'settings.json') },
        });
      }
      try {
        const old = await linked.request(owner, tool);
        if (old.ok === false) throw new Error(old.code);
        const result = await linked.request(owner, {
          ...command('helper-set-tool'),
          expectedRevision: old.data.revision,
        });
        if (scenario === 'dotfile-style symlinked agent root') {
          expect(old.data).toMatchObject({ writable: true, reason: null });
          expect(result).toMatchObject({ ok: true, data: { saved: true } });
          expect(await readFile(target, 'utf8')).not.toBe(initialSettings);
          expect((await lstat(path.join(realAgent, 'locks'))).isDirectory()).toBe(true);
          expect((await lstat(agent)).isSymbolicLink()).toBe(true);
        } else {
          expect(old.data).toMatchObject({ writable: false, reason: 'read-only' });
          expect(result).toEqual(reply('helper-error-scope_readonly'));
          expect(await readFile(target, 'utf8')).toBe(initialSettings);
        }
      } finally {
        if (linked !== service) linked.dispose();
      }
    },
    90000
  );

  it('creates a missing agent root privately on the first write', async () => {
    await rm(agent, { recursive: true });
    const old = await current(tool);
    expect(old).toMatchObject({ exists: false, writable: true });
    await current({ ...command('helper-set-tool'), expectedRevision: old.revision });
    expect(JSON.parse(await readFile(settingsPath(), 'utf8'))).toEqual({ defaultTools: ['-read'] });
    if (!onWindows) {
      expect((await lstat(agent)).mode & 0o777).toBe(0o700);
      expect((await lstat(path.join(agent, 'locks'))).mode & 0o777).toBe(0o700);
    }
  }, 90000);

  it.each(['lock-open', 'lock-leaf', 'settings-ancestor', 'after-replace', 'same-bytes substitution'])(
    'detects a same-user swap at the %s boundary',
    async (boundary) => {
      const targetDir = path.join(agent, 'relocated');
      const target = path.join(targetDir, 'settings.json');
      await mkdir(targetDir);
      await rename(settingsPath(), target);
      await symlink(target, settingsPath());
      const old = await current(tool);
      const directory = path.join(agent, 'locks');
      const real = await vi.importActual<typeof import('node:child_process')>('node:child_process');
      const lockSwap = `original_open = os.open
def swap_at_open(file, flags, *args, **kwargs):
    lock_dir = Path(${JSON.stringify(directory)})
    if isinstance(file, (str, Path)) and Path(file).parent == lock_dir and flags & os.O_CREAT:
        lock_dir.rename(lock_dir.with_name("moved-locks"))
        lock_dir.mkdir(mode=0o700)
    return original_open(file, flags, *args, **kwargs)
os.open = swap_at_open`;
      const leafSwap = `original_lock = FileSettingsStorage._lock_fd
def swap_after_lock(fd, label):
    original_lock(fd, label)
    lock_dir = Path(${JSON.stringify(directory)})
    for entry in lock_dir.glob("*.lock"):
        if entry.stat().st_ino == os.fstat(fd).st_ino:
            entry.rename(entry.with_suffix(".saved"))
            entry.touch()
FileSettingsStorage._lock_fd = staticmethod(swap_after_lock)`;
      const replaceSwap = `from aelix_ai.settings import storage
original_replace = storage._replace
def swap_at_replace(src, dst):
    delivery = ${JSON.stringify(boundary)}
    if delivery == "settings-ancestor":
        parent = dst.parent
        parked = parent.with_name("parked")
        parent.rename(parked)
        parent.mkdir(mode=0o700)
        (parent / dst.name).write_bytes((parked / dst.name).read_bytes())
        (parent / src.name).write_bytes((parked / src.name).read_bytes())
    original_replace(src, dst)
    if delivery == "after-replace":
        parent = dst.parent
        parked = parent.with_name("parked")
        parent.rename(parked)
        parent.mkdir(mode=0o700)
        (parent / dst.name).write_bytes((parked / dst.name).read_bytes())
    if delivery == "same-bytes substitution":
        foreign = dst.with_suffix(".foreign")
        foreign.write_bytes(dst.read_bytes())
        os.replace(foreign, dst)
storage._replace = swap_at_replace`;
      const seam = { 'lock-open': lockSwap, 'lock-leaf': leafSwap }[boundary] ?? replaceSwap;
      injectNative(real, (source) => source.replace('def diagnostic(', seam + '\n\ndef diagnostic('));
      const result = await service.request(owner, { ...command('helper-set-tool'), expectedRevision: old.revision });
      expect(result).toEqual(
        reply(boundary.startsWith('lock') ? 'helper-error-store_unreadable' : 'helper-error-outcome_unknown')
      );
      if (boundary.startsWith('lock')) expect(await readFile(target, 'utf8')).toBe(initialSettings);
    },
    90000
  );

  it('refuses a write if the acquired lock has no verifiable file ID', async () => {
    const old = await current(tool);
    const real = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    const seam = `from types import SimpleNamespace
unsafe_fd = None
original_lock = FileSettingsStorage._lock_fd
original_fstat = os.fstat
def lock_without_identity(fd, path):
    global unsafe_fd
    original_lock(fd, path)
    if unsafe_fd is None:
        unsafe_fd = fd
def unverified_fstat(fd):
    return SimpleNamespace(st_dev=0, st_ino=0) if fd == unsafe_fd else original_fstat(fd)
FileSettingsStorage._lock_fd = staticmethod(lock_without_identity)
os.fstat = unverified_fstat`;
    injectNative(real, (source) => source.replace('def diagnostic(', seam + '\n\ndef diagnostic('));
    expect(await service.request(owner, { ...command('helper-set-tool'), expectedRevision: old.revision })).toEqual(
      reply('helper-error-store_unreadable')
    );
    expect(await readFile(settingsPath(), 'utf8')).toBe(initialSettings);
  }, 90000);

  it('refuses an MCP link retargeted outside the admitted root during native discovery', async () => {
    const outside = path.join(root, 'outside-mcp.json');
    const inside = path.join(agent, 'inside-mcp.json');
    const config = '{"mcpServers":{}}';
    await writeFile(outside, config);
    await writeFile(inside, config);
    await symlink(inside, mcpPath());
    const real = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    const seam = `original_load = McpSelection._load
def retarget_then_load(self):
    entry = Path(${JSON.stringify(mcpPath())})
    entry.unlink()
    entry.symlink_to(${JSON.stringify(outside)})
    return original_load(self)
McpSelection._load = retarget_then_load
`;
    injectNative(real, (source) => source.replace('def diagnostic(', seam + '\ndef diagnostic('));
    expect(await service.request(owner, mcp)).toEqual(reply('helper-error-store_unreadable'));
  }, 90000);

  it('creates an authorized regular settings entry at the configured missing path', async () => {
    await rm(settingsPath());
    const old = await current(tool);
    expect(old.exists).toBe(false);
    await current({ ...command('helper-set-tool'), expectedRevision: old.revision });
    expect(JSON.parse(await readFile(settingsPath(), 'utf8'))).toEqual({ defaultTools: ['-read'] });
  }, 90000);

  it.each(['settings', 'mcp', 'markdown', 'discovery'])(
    'refuses oversized %s work before native parsing or reply construction',
    async (input) => {
      let request = tool;
      if (input === 'settings' || input === 'mcp') {
        const target = input === 'settings' ? settingsPath() : mcpPath();
        await writeFile(target, '{}');
        await truncate(target, 2 * 1024 * 1024);
        if (input === 'mcp') request = mcp;
      } else {
        request = { action: 'profiles/list' };
        const profiles = path.join(agent, 'agents');
        if (input === 'markdown') {
          const target = path.join(profiles, 'giant.md');
          await writeFile(target, '---\nname: giant\ndescription: Example\n---\nBody\n');
          await truncate(target, 256 * 1024);
        } else {
          for (let i = 0; i < 2300; i++) await mkdir(path.join(profiles, String(i)));
        }
      }
      expect(await service.request(owner, request)).toEqual(reply('helper-error-result_too_large'));
    },
    90000
  );

  it.each([
    ['connect', 'tool list', 'main', 'helper_unavailable'],
    ['connect', 'tool write', 'main', 'helper_unavailable'],
    ['swallowed lookup', 'tool list', 'main', 'helper_unavailable'],
    ['swallowed lookup', 'tool write', 'build', 'helper_unavailable'],
    ['swallowed lookup', 'MCP write', 'build', 'helper_unavailable'],
    ['swallowed lookup', 'tool write', 'after commit', 'outcome_unknown'],
  ] as const)(
    'fails closed on a helper network %s during a %s (%s)',
    async (attempt, action, stage, code) => {
      let connections = 0;
      const listener = createServer((_req, res) => res.writeHead(500).end());
      listener.on('connection', () => connections++);
      await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
      const port = (listener.address() as AddressInfo).port;
      const initialMcp = '{ "mcpServers": { "local-docs": {"command":"unused","enabled":true} } }\n';
      await writeFile(mcpPath(), initialMcp);
      try {
        const kind = action === 'MCP write' ? mcp : tool;
        const target = action === 'MCP write' ? mcpPath() : settingsPath();
        const before = await readFile(target, 'utf8');
        const old = await current(kind);
        const probe =
          attempt === 'connect'
            ? [`socket.create_connection(("127.0.0.1", ${port}), timeout=5).close()`]
            : ['try:', `    socket.getaddrinfo("localhost", ${port})`, 'except Exception:', '    pass'];
        // Insert lines before an anchor line, at its indentation.
        const insertBefore = (source: string, anchor: string, lines: string[]) => {
          const at = source.indexOf(anchor);
          if (at < 0 || source.indexOf(anchor, at + 1) >= 0) throw new Error('Seam anchor is not unique: ' + anchor);
          const start = source.lastIndexOf('\n', at) + 1;
          const indent = source.slice(start, at);
          return source.slice(0, start) + lines.map((line) => indent + line + '\n').join('') + source.slice(start);
        };
        // Fault-inject native network use; the audit hook must refuse it even when native code swallows the error.
        const real = await vi.importActual<typeof import('node:child_process')>('node:child_process');
        injectNative(real, (source) => {
          if (stage === 'main') {
            return insertBefore(source, 'if command["action"].startswith("profiles/"):', ['import socket', ...probe]);
          }
          if (stage === 'build') {
            const anchor =
              action === 'MCP write' ? 'new = mcp_writer.edit_enabled(data, wanted)' : 'for name, want in wanted:';
            return insertBefore(source, anchor, ['import socket', ...probe]);
          }
          return insertBefore(source, 'def diagnostic(', [
            'import socket',
            'from aelix_ai.settings import storage as seam_storage',
            'real_replace = seam_storage._replace',
            'def replace_then_lookup(src, dst):',
            '    real_replace(src, dst)',
            ...probe.map((line) => '    ' + line),
            'seam_storage._replace = replace_then_lookup',
          ]);
        });
        const request =
          action === 'tool list'
            ? tool
            : {
                ...command(action === 'MCP write' ? 'helper-set-mcp' : 'helper-set-tool'),
                expectedRevision: old.revision,
              };
        expect(await service.request(owner, request)).toEqual(reply('helper-error-' + code));
        // A refusal before the commit writes nothing; only a post-commit attempt leaves the landed write.
        if (stage === 'after commit') expect(await readFile(target, 'utf8')).not.toBe(before);
        else expect(await readFile(target, 'utf8')).toBe(before);
        expect(connections).toBe(0);
      } finally {
        listener.closeAllConnections();
        await new Promise<void>((resolve) => listener.close(() => resolve()));
      }
    },
    90000
  );

  it('reads and writes global resources without model requests, HTTP MCP, stdio MCP, or credential reads', async () => {
    let modelRequests = 0;
    let mcpConnections = 0;
    const listener = createServer((req, res) => {
      if (req.url?.startsWith('/model')) modelRequests++;
      res.writeHead(500).end();
    });
    listener.on('connection', () => mcpConnections++);
    await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
    const url = 'http://127.0.0.1:' + (listener.address() as AddressInfo).port;
    delete env.PI_OFFLINE;
    env.AELIX_MODEL_CATALOG_URL = url + '/catalog';
    env.AELIX_DEFAULT_CATALOG = url + '/extensions/catalog.json';
    const launchMarker = path.join(root, 'stdio-mcp-started');
    const sentinel = [
      '-I',
      '-B',
      '-c',
      'from pathlib import Path; import sys; Path(sys.argv[1]).touch()',
      launchMarker,
    ];
    try {
      await exec(
        python,
        [
          '-I',
          '-B',
          '-c',
          `
from urllib.request import urlopen
from urllib.error import HTTPError
from aelix_coding_agent.hosted_catalog_source import catalog_base_url, index_url
from aelix_coding_agent.model_refresh import startup_refresh_allowed
assert startup_refresh_allowed()
try:
    urlopen(index_url(catalog_base_url()), timeout=5)
except HTTPError as error:
    assert error.code == 500
`,
        ],
        { env, cwd: root }
      );
      expect(mcpConnections).toBe(1);
      mcpConnections = 0;
      await exec(python, sentinel, { env, cwd: root });
      expect((await lstat(launchMarker)).isFile()).toBe(true);
      await rm(launchMarker);
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
            'stdio-probe': { command: python, args: sentinel },
          },
        })
      );
      const auth = path.join(agent, 'auth.json');
      await writeFile(auth, '---\nname: secret-test\ndescription: synthetic-secret\n---\nsecret test\n');
      await link(auth, path.join(agent, 'agents', 'secret-test.md'));
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
      expect(outputs[3].items).toEqual(
        expect.arrayContaining([
          ...(reply('helper-mcp').data!.items as unknown[]),
          expect.objectContaining({ key: 'stdio-probe', saved: true }),
        ])
      );
      for (const [id, list] of [
        ['helper-set-tool', tool],
        ['helper-set-skill', skill],
        ['helper-set-mcp', mcp],
      ] as const) {
        const data = await current({ ...command(id), expectedRevision: (await current(list)).revision });
        expect(data.saved).toBe(true);
      }
      await expect(lstat(launchMarker)).rejects.toMatchObject({ code: 'ENOENT' });
      // Fault-inject a native spawn in both paths. A working sentinel would create the marker.
      const real = await vi.importActual<typeof import('node:child_process')>('node:child_process');
      const injection = `import subprocess\n        subprocess.run(${JSON.stringify([python, ...sentinel])}, check=True)\n        `;
      injectNative(real, (source) =>
        source.replace(
          'if command["action"].startswith("profiles/"):',
          injection + 'if command["action"].startswith("profiles/"):'
        )
      );
      expect(await service.request(owner, tool)).toEqual(reply('helper-error-helper_unavailable'));
      expect(
        await service.request(owner, {
          ...command('helper-set-tool'),
          expectedRevision: outputs[1].revision,
          requestId: '019aa123-0001-7000-8000-000000000099',
        })
      ).toEqual(reply('helper-error-helper_unavailable'));
      await expect(lstat(launchMarker)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(JSON.stringify(outputs)).not.toContain('synthetic-secret');
      expect({ modelRequests, mcpConnections }).toEqual({ modelRequests: 0, mcpConnections: 0 });
    } finally {
      listener.closeAllConnections();
      await new Promise<void>((resolve) => listener.close(() => resolve()));
    }
  }, 90000);
});
