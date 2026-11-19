/**
 * New conversations get the extensions the Studio helper installed (Studio #32, launcher piece).
 *
 * Same requirements as studioExtensions.test.ts: AELIX_STUDIO_EXTENSION_BUNDLE names a COPY of
 * a bundled runtime, which gets this branch's launch.py, and AELIX_STUDIO_EXTENSION_SCRATCH a
 * directory for everything else. The adapter is started the way the host starts it
 * (`node <bundle>/launch.cjs --profile coding …`) and spoken to over ACP. No model is called:
 * only extension commands are used.
 *
 *   AELIX_STUDIO_EXTENSION_BUNDLE=<bundle copy> AELIX_STUDIO_EXTENSION_SCRATCH=<dir> \
 *     bunx vitest run tests/integration/studioExtensionLaunch.test.ts
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, truncate, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ExtensionService,
  STATE_ENVIRONMENT,
  type ExtensionListing,
  type ExtensionOperation,
  type ExtensionReply,
} from '../../packages/web-host/src/studio-extensions/index';
import { bundleDifferences, useBranchLauncher } from '../../packages/web-host/tests/fixtures/bundleCopy';
import { writeWheel, type WheelSpec } from '../../packages/web-host/tests/fixtures/extensionWheels';

const BUNDLE = process.env.AELIX_STUDIO_EXTENSION_BUNDLE;
const OWNER = 'integration';

type Message = { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown };
type Turn = { text: string; error?: { code?: number; message?: string } };

/** A minimal ACP client: answers every consent request with "allow once" and records it. */
class Conversation {
  readonly consents: string[] = [];
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly waiting = new Map<number, (message: Message) => void>();
  private chunks: string[] = [];
  private counter = 0;
  private buffer = '';
  stderr = '';

  constructor(command: string, args: string[], env: NodeJS.ProcessEnv) {
    this.child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      this.stderr += chunk;
    });
    this.child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      this.buffer += chunk;
      let end: number;
      while ((end = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, end).trim();
        this.buffer = this.buffer.slice(end + 1);
        if (line.startsWith('{')) this.receive(JSON.parse(line) as Message);
      }
    });
  }

  private receive(message: Message): void {
    if (message.method === 'session/request_permission') {
      const call = (message.params?.toolCall ?? {}) as { title?: string };
      this.consents.push(call.title ?? '');
      this.send({ id: message.id, result: { outcome: { outcome: 'selected', optionId: 'allow-once' } } });
      return;
    }
    if (message.method === 'session/update') {
      const update = (message.params?.update ?? {}) as { sessionUpdate?: string; content?: { text?: string } };
      if (update.sessionUpdate === 'agent_message_chunk' && update.content?.text) this.chunks.push(update.content.text);
      return;
    }
    if (message.id !== undefined && message.method === undefined) this.waiting.get(message.id)?.(message);
  }

  private send(message: Record<string, unknown>): void {
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  }

  request(method: string, params: Record<string, unknown>, timeoutMs = 120_000): Promise<Message> {
    const id = (this.counter += 1);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} timed out: ${this.stderr.slice(-2000)}`)), timeoutMs);
      this.waiting.set(id, (message) => {
        clearTimeout(timer);
        this.waiting.delete(id);
        resolve(message);
      });
      this.send({ id, method, params });
    });
  }

  async open(cwd: string): Promise<string> {
    const initialized = await this.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
    expect(initialized.error, this.stderr).toBeUndefined();
    const session = await this.request('session/new', { cwd, mcpServers: [] });
    expect(session.error, this.stderr).toBeUndefined();
    return (session.result as { sessionId: string }).sessionId;
  }

  async prompt(sessionId: string, text: string): Promise<Turn> {
    this.chunks = [];
    const reply = await this.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] });
    return { text: this.chunks.join(''), ...(reply.error ? { error: reply.error as Turn['error'] } : {}) };
  }

  async close(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    const exited = new Promise((resolve) => this.child.once('close', resolve));
    this.child.stdin.end();
    const forced = setTimeout(() => this.child.kill('SIGKILL'), 15_000);
    await exited;
    clearTimeout(forced);
  }
}

describe.skipIf(!BUNDLE || process.platform === 'win32')('conversations with installed extensions', () => {
  const bundle = BUNDLE ?? '';
  let sandbox = '';
  let root = '';
  let workspace = '';
  let replaced: Record<string, string> = {};
  let service: ExtensionService;
  let environment: NodeJS.ProcessEnv;
  const open: Conversation[] = [];

  const data = <T>(reply: ExtensionReply): T => {
    if (reply.ok === false) throw new Error(`request failed: ${reply.code} ${(reply.detail ?? []).join('; ')}`);
    return reply.data as T;
  };
  const list = async (): Promise<ExtensionListing> =>
    data<ExtensionListing>(await service.request(OWNER, { action: 'list' }));
  const install = async (spec: WheelSpec): Promise<ExtensionOperation> => {
    const file = await writeWheel(path.join(sandbox, 'wheels'), spec);
    let state = data<ExtensionOperation>(
      await service.request(OWNER, { action: 'install', source: { kind: 'file', path: file } })
    );
    while (!['switched', 'failed', 'cancelled'].includes(state.phase)) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      state = data<ExtensionOperation>(
        await service.request(OWNER, { action: 'poll', operationId: state.operationId })
      );
    }
    return state;
  };
  /** Start the adapter the way the host does, with or without Studio's state directory. */
  const conversation = (withState = true): Conversation => {
    const started = new Conversation(
      'node',
      [path.join(bundle, 'launch.cjs'), '--profile', 'coding', '--state-dir', path.join(sandbox, 'acp')],
      { ...environment, ...(withState ? { [STATE_ENVIRONMENT]: root } : {}) }
    );
    open.push(started);
    return started;
  };
  /** What installed: distributions in the current generation and the pointer, for "nothing changed" checks. */
  const installedState = async (): Promise<string> => {
    const pointer = await readFile(path.join(root, 'current.json'), 'utf8');
    const { generation } = JSON.parse(pointer) as { generation: string };
    const site = path.join(root, 'generations', generation, 'venv', 'lib', 'python3.12', 'site-packages');
    return JSON.stringify({ pointer, site: (await readdir(site)).toSorted() });
  };

  beforeAll(async () => {
    replaced = await useBranchLauncher(bundle);
    const scratch = process.env.AELIX_STUDIO_EXTENSION_SCRATCH ?? os.tmpdir();
    await mkdir(scratch, { recursive: true });
    sandbox = await mkdtemp(path.join(scratch, 'studio-launch-'));
    root = path.join(sandbox, 'User Data', 'aelix-runtime');
    workspace = path.join(sandbox, 'workspace');
    await Promise.all(['home', 'agent', 'workspace'].map((name) => mkdir(path.join(sandbox, name))));
    environment = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: path.join(sandbox, 'home'),
      // The adapter puts a Unix socket under it; a scratch path can be too long for one.
      TMPDIR: os.tmpdir(),
      LANG: 'en_US.UTF-8',
      AELIX_CODING_AGENT_DIR: path.join(sandbox, 'agent'),
      PYTHONDONTWRITEBYTECODE: '1',
    };
    service = new ExtensionService({ runtime: bundle, root, env: environment });
    expect((await install({ name: 'fixture-good' })).phase).toBe('switched');
    // A bare module entry point, passed by reference.
    expect((await install({ name: 'fixture-bare', reference: 'fixture_bare', manifest: false })).phase).toBe(
      'switched'
    );
    // No manifest: passed by module reference.
    expect((await install({ name: 'fixture-legacy', manifest: false })).phase).toBe('switched');
  }, 300_000);

  afterAll(async () => {
    await Promise.all(open.map((started) => started.close()));
    await service?.dispose();
    if (sandbox && !process.env.AELIX_STUDIO_EXTENSION_KEEP) await rm(sandbox, { recursive: true, force: true });
  });

  it('lists a pack as ready and an extension passed by reference as manifest_unbound', async () => {
    expect((await list()).extensions.map((extension) => [extension.name, extension.status])).toEqual([
      ['fixture-bare', 'manifest_unbound'],
      ['fixture-good', 'ready'],
      ['fixture-legacy', 'manifest_unbound'],
    ]);
  });

  // Review of the launcher piece, should-fix 2: given as `fixture_bare`, the adapter took the
  // entry for a project path and refused to open the session at all.
  it('opens a conversation in a directory that holds a folder named like a bare module entry', async () => {
    const project = path.join(sandbox, 'project');
    await mkdir(path.join(project, 'fixture_bare'), { recursive: true });
    const started = conversation();
    const session = await started.open(project);
    expect(await started.prompt(session, '/fixture-bare-cmd')).toMatchObject({
      text: expect.stringContaining('fixture-bare ran'),
    });
    await started.close();
  }, 180_000);

  it('runs the commands of both in a new conversation and keeps a lease while it runs', async () => {
    const started = conversation();
    const session = await started.open(workspace);
    expect(await started.prompt(session, '/fixture-good-cmd')).toMatchObject({
      text: expect.stringContaining('fixture-good ran'),
    });
    expect(await started.prompt(session, '/fixture-legacy-cmd')).toMatchObject({
      text: expect.stringContaining('fixture-legacy ran'),
    });
    const { current } = await list();
    expect((await readdir(path.join(root, 'leases'))).map((lease) => lease.split('.')[0])).toEqual([current]);
    await started.close();
  }, 180_000);

  it('has none of them when Studio gives no state directory', async () => {
    const started = conversation(false);
    const session = await started.open(workspace);
    const turn = await started.prompt(session, '/fixture-good-cmd');
    expect(turn.text).not.toContain('fixture-good ran');
    expect(turn.error?.message).toMatch(/unknown slash command/i);
    await started.close();
  }, 180_000);

  // Installing from a conversation is to be closed by ACP before the screen ships (ADR 7.3).
  // In this launch form it fails, and the generation conversations use stays as it is.
  it('leaves the generation alone when a conversation asks to install or remove', async () => {
    const before = await installedState();
    const wheel = await writeWheel(path.join(sandbox, 'wheels'), { name: 'fixture-chat', version: '0.1.0' });
    const started = conversation();
    const session = await started.open(workspace);
    const installTurn = await started.prompt(session, `/extension install ${wheel}`);
    const removeTurn = await started.prompt(session, '/extension remove fixture-good');
    expect(started.consents).toEqual(['install extension', 'remove extension']);
    expect(installTurn.error).toBeDefined();
    expect(await installedState()).toEqual(before);
    expect(await started.prompt(session, '/fixture-good-cmd')).toMatchObject({
      text: expect.stringContaining('fixture-good ran'),
    });
    // What `remove` answered is recorded for the report; the assertion is that nothing changed.
    await writeFile(
      path.join(sandbox, 'conversation-management.json'),
      JSON.stringify({ installTurn, removeTurn }, null, 2)
    );
    await started.close();
    expect(await bundleDifferences(bundle, replaced)).toEqual([]);
  }, 240_000);

  it('starts from the pointer before the last switch when current.json is damaged', async () => {
    const pointer = path.join(root, 'current.json');
    const saved = await readFile(pointer);
    await truncate(pointer, 15);
    try {
      const started = conversation();
      const session = await started.open(workspace);
      // The pointer before the last switch names the generation without fixture-legacy.
      expect(await started.prompt(session, '/fixture-good-cmd')).toMatchObject({
        text: expect.stringContaining('fixture-good ran'),
      });
      expect((await started.prompt(session, '/fixture-legacy-cmd')).error?.message).toMatch(/unknown slash command/i);
      await started.close();
    } finally {
      await writeFile(pointer, saved);
    }
  }, 180_000);

  it('starts with the bundle alone when the generations are gone', async () => {
    for (const generation of await readdir(path.join(root, 'generations')))
      await rm(path.join(root, 'generations', generation), { recursive: true, force: true });
    const started = conversation();
    const session = await started.open(workspace);
    expect((await started.prompt(session, '/fixture-good-cmd')).error?.message).toMatch(/unknown slash command/i);
    expect(started.stderr).not.toContain('installed extensions were not loaded');
    await started.close();
    expect(await list()).toMatchObject({ current: null, extensions: [] });
    expect(await bundleDifferences(bundle, replaced)).toEqual([]);
  }, 180_000);
});
