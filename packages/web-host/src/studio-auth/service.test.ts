import { EventEmitter } from 'node:events';
import { realpath } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NativeAuthService } from './service';
import { buildStudioAelixLaunch } from './runtime';

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  existsSync: vi.fn(() => true),
  readFileSync: vi.fn(),
  statSync: vi.fn(() => ({ isFile: () => true })),
  accessSync: vi.fn(),
}));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
vi.mock('node:fs', () => ({
  existsSync: mocks.existsSync,
  readFileSync: mocks.readFileSync,
  statSync: mocks.statSync,
  accessSync: mocks.accessSync,
  constants: { X_OK: 1 },
}));

class Helper extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  writes: string[] = [];
  constructor() {
    super();
    this.stdin.on('data', (chunk) => this.writes.push(String(chunk)));
  }
  kill = vi.fn(() => {
    queueMicrotask(() => this.emit('close', null));
    return true;
  });
  frame(value: unknown): void {
    this.stdout.write(JSON.stringify(value) + '\n');
  }
}

describe('sessionless native auth ownership and lifecycle', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const runtime = path.resolve('/verified');
  let service: NativeAuthService;
  let helper: Helper;
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    mocks.existsSync.mockImplementation((file) => !String(file).endsWith('manifest.json'));
    helper = new Helper();
    mocks.spawn.mockReturnValue(helper);
    service = new NativeAuthService({ runtime, timeoutMs: 20, loginTimeoutMs: 3000 });
  });
  afterEach(() => {
    Object.defineProperty(process, 'platform', platform);
    service.dispose();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it('passes the same absolute Windows backslash-tilde agent root to ACP and to the helper', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    vi.stubEnv('AELIX_STUDIO_RUNTIME', runtime);
    vi.stubEnv('USERPROFILE', 'C:\\Users\\Studio');
    vi.stubEnv('AELIX_CODING_AGENT_DIR', '~\\Studio\\agent');
    mocks.existsSync.mockReturnValue(true);
    mocks.readFileSync.mockReturnValue(
      JSON.stringify({ schema: 'aelix.studio-preview.runtime/1', target: `win32-${process.arch}` })
    );

    const descriptor = JSON.parse(buildStudioAelixLaunch(runtime)!);
    const pending = service.request('one', { action: 'catalog' });
    helper.frame({ result: { providers: [] } });
    helper.emit('close', 0);
    await pending;
    const helperRoot = mocks.spawn.mock.calls[0][2].env.AELIX_CODING_AGENT_DIR;
    expect(helperRoot).toBe('C:\\Users\\Studio\\Studio\\agent');
    expect(descriptor.env.AELIX_CODING_AGENT_DIR).toBe(helperRoot);
  });

  it('fails without an installed runtime instead of discovering a different Python', async () => {
    mocks.existsSync.mockReturnValue(false);
    expect(await service.request('one', { action: 'catalog' })).toEqual({ ok: false, code: 'RUNTIME_UNAVAILABLE' });
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('launches the selected Windows Python directly with pipe input', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    const pending = service.request('one', { action: 'catalog' });
    helper.frame({ result: { providers: [] } });
    helper.emit('close', 0);
    expect(mocks.spawn.mock.calls[0][0]).toBe(path.join(runtime, 'native', 'Scripts', 'python.exe'));
    expect(mocks.spawn.mock.calls[0][2].shell).toBe(false);
    expect(mocks.spawn.mock.calls[0][2].windowsHide).toBe(true);
    expect((await pending).ok).toBe(true);
  });

  it('passes credentials only through stdin, never argv or the result', async () => {
    const pending = service.request('one', {
      action: 'setKey',
      provider: 'openai',
      key: 'sentinel-secret',
      exclusive: true,
      revision: 'old',
    });
    helper.frame({ result: { providers: [], revision: 'new' } });
    helper.emit('close', 0);
    expect(JSON.stringify(mocks.spawn.mock.calls)).not.toContain('sentinel-secret');
    expect(helper.writes.join('')).toContain('sentinel-secret');
    expect(JSON.stringify(await pending)).not.toContain('sentinel-secret');
  });

  it('bounds a stalled helper and settles without echoing native diagnostics', async () => {
    const pending = service.request('one', { action: 'catalog' });
    helper.stderr.write('secret-token-and-private-url');
    await expect(pending).resolves.toEqual({ ok: false, code: 'TIMEOUT' });
    expect(helper.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('sanitizes native error text', async () => {
    const pending = service.request('one', { action: 'catalog' });
    helper.frame({ error: 'key=sentinel-secret' });
    helper.emit('close', 1);
    await expect(pending).resolves.toEqual({ ok: false, code: 'NATIVE_FAILED' });
  });

  it('rejects a second credential mutation while authorization is pending', async () => {
    await service.request('one', { action: 'login', provider: 'anthropic', revision: 'old', exclusive: true });
    expect(
      await service.request('one', { action: 'logout', provider: 'openai', revision: 'old', exclusive: true })
    ).toEqual({ ok: false, code: 'BUSY' });
  });

  it('does not disclose or cancel another authenticated user’s OAuth operation', async () => {
    const started = await service.request('one', {
      action: 'login',
      provider: 'anthropic',
      revision: 'old',
      exclusive: true,
    });
    if (!started.ok || !('operationId' in started.data)) throw new Error('No operation');
    helper.frame({ event: 'authorization', url: 'https://provider.example/authorize?state=sentinel' });
    expect(await service.request('two', { action: 'poll', operationId: started.data.operationId })).toEqual({
      ok: false,
      code: 'NOT_FOUND',
    });
    expect(await service.request('two', { action: 'cancel', operationId: started.data.operationId })).toEqual({
      ok: false,
      code: 'NOT_FOUND',
    });
    expect(helper.kill).not.toHaveBeenCalled();
  });

  it('rejects stale challenges and clears transient OAuth state on cancel', async () => {
    const started = await service.request('one', {
      action: 'login',
      provider: 'anthropic',
      revision: 'old',
      exclusive: true,
    });
    if (!started.ok || !('operationId' in started.data)) throw new Error('No operation');
    const operationId = started.data.operationId;
    helper.frame({ event: 'authorization', url: 'https://provider.example/authorize?state=sentinel' });
    helper.frame({ event: 'prompt', challengeId: 'fresh', message: 'Code', allowEmpty: false });
    expect(
      await service.request('one', { action: 'reply', operationId, challengeId: 'stale', value: 'secret-input' })
    ).toEqual({ ok: false, code: 'STALE_CHALLENGE' });
    const cancelled = await service.request('one', { action: 'cancel', operationId });
    expect(cancelled).toEqual({ ok: true, data: { operationId, phase: 'cancelled' } });
    expect(helper.stdin.writableEnded).toBe(true);
  });

  it('supports native allow-empty and selection callbacks without saving input in operation state', async () => {
    const started = await service.request('one', {
      action: 'login',
      provider: 'github-copilot',
      revision: 'old',
      exclusive: true,
    });
    if (!started.ok || !('operationId' in started.data)) throw new Error('No operation');
    helper.frame({ event: 'prompt', challengeId: 'enterprise', message: 'Host', allowEmpty: true });
    const reply = await service.request('one', {
      action: 'reply',
      operationId: started.data.operationId,
      challengeId: 'enterprise',
      value: '',
    });
    expect(reply).toEqual({ ok: true, data: { operationId: started.data.operationId, phase: 'pending' } });
    expect(helper.writes.at(-1)).toContain('"value":""');
  });

  it('marks a managed launch even without an extension state path or credentials in the agent database', async () => {
    const pending = service.request('one', { action: 'select', provider: 'openai', model: 'model-one' });
    helper.frame({ result: { root: '/cli-root' } });
    helper.emit('close', 0);
    expect(await pending).toEqual({
      ok: true,
      data: {
        root: '/cli-root',
        command: 'node',
        args: [path.join(runtime, 'launch.cjs'), '--profile', 'coding', '--provider=openai', '--model=model-one'],
        env: [
          { name: 'AELIX_CODING_AGENT_DIR', value: '/cli-root' },
          { name: 'AELIX_ACP_STUDIO_MANAGED', value: '1' },
        ],
      },
    });
  });

  it('puts the Studio state path with spaces and Unicode in the managed command environment', async () => {
    const userDataPath = path.join(await realpath(process.cwd()), 'Studio 사용자 데이터');
    const pending = service.request('one', { action: 'select', provider: 'openai', model: 'model-one' }, userDataPath);
    helper.frame({ result: { root: '/cli-root' } });
    helper.emit('close', 0);
    expect(await pending).toMatchObject({
      ok: true,
      data: {
        env: [
          { name: 'AELIX_CODING_AGENT_DIR', value: '/cli-root' },
          { name: 'AELIX_ACP_STUDIO_MANAGED', value: '1' },
          { name: 'AELIX_STUDIO_EXTENSION_STATE', value: path.join(userDataPath, 'aelix-runtime') },
        ],
      },
    });
    expect(mocks.spawn.mock.calls[0][2].env.AELIX_STUDIO_EXTENSION_STATE).toBe(
      process.env.AELIX_STUDIO_EXTENSION_STATE
    );
    expect(mocks.spawn.mock.calls[0][2].env.AELIX_ACP_STUDIO_MANAGED).toBe(process.env.AELIX_ACP_STUDIO_MANAGED);
  });

  it('refuses unknown methods and malformed inputs before spawning', async () => {
    expect(await service.request('one', null)).toEqual({ ok: false, code: 'INVALID_INPUT' });
    expect(await service.request('one', { action: 'runShell' })).toEqual({ ok: false, code: 'UNSUPPORTED' });
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('terminates oversized helper output without reflecting it', async () => {
    const pending = service.request('one', { action: 'catalog' });
    helper.stdout.write('x'.repeat(1024 * 1024 + 1));
    await expect(pending).resolves.toEqual({ ok: false, code: 'FRAME_LIMIT' });
    expect(helper.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('clears authorization URLs and prompts when native login terminates', async () => {
    const started = await service.request('one', {
      action: 'login',
      provider: 'anthropic',
      revision: 'old',
      exclusive: true,
    });
    if (!started.ok || !('operationId' in started.data)) throw new Error('No operation');
    helper.frame({ event: 'authorization', url: 'https://provider.example/authorize?state=sentinel' });
    helper.frame({ event: 'prompt', challengeId: 'fresh', message: '', kind: 'manual', allowEmpty: false });
    helper.frame({ result: { providers: [] } });
    helper.emit('close', 0);
    await Promise.resolve();
    await Promise.resolve();
    expect(await service.request('one', { action: 'poll', operationId: started.data.operationId })).toEqual({
      ok: true,
      data: { operationId: started.data.operationId, phase: 'complete' },
    });
  });
});
