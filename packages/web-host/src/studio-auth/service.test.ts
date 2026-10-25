import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NativeAuthService } from './service';

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), existsSync: vi.fn(() => true) }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
vi.mock('node:fs', () => ({ existsSync: mocks.existsSync }));

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
  let service: NativeAuthService;
  let helper: Helper;
  beforeEach(() => {
    mocks.existsSync.mockReturnValue(true);
    helper = new Helper();
    mocks.spawn.mockReturnValue(helper);
    service = new NativeAuthService({ runtime: '/verified', timeoutMs: 20, loginTimeoutMs: 3000 });
  });
  afterEach(() => {
    service.dispose();
    vi.clearAllMocks();
  });

  it('fails without an installed runtime instead of discovering a different Python', async () => {
    mocks.existsSync.mockReturnValue(false);
    expect(await service.request('one', { action: 'catalog' })).toEqual({ ok: false, code: 'RUNTIME_UNAVAILABLE' });
    expect(mocks.spawn).not.toHaveBeenCalled();
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

  it('selects a native launch without requiring credentials in the agent database', async () => {
    const pending = service.request('one', { action: 'select', provider: 'openai', model: 'model-one' });
    helper.frame({ result: { root: '/cli-root' } });
    helper.emit('close', 0);
    expect(await pending).toEqual({
      ok: true,
      data: {
        root: '/cli-root',
        command: '/verified/adapter/bin/aelix-acp',
        args: [
          '--aelix',
          '/verified/native/bin/aelix',
          '--profile',
          'coding',
          '--provider',
          'openai',
          '--model',
          'model-one',
        ],
        env: [{ name: 'AELIX_CODING_AGENT_DIR', value: '/cli-root' }],
      },
    });
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
