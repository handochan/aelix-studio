import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as httpBridge from '@/common/adapter/httpBridge';
import { createRunningInputClient } from '@/renderer/services/runtime/RunningInput';

const PREFIX = '_aelix/session/';
const methods = ['input/state', 'input/steer', 'input/follow-up', 'requests/lookup'].map((method) => PREFIX + method);
const secret = 'marker for relay content';
const target = { bindingId: 'first-binding', turnId: 'turn-1' };
const accepted = { turnId: target.turnId, accepted: true, delivery: 'native-queue' };
const success = (data: unknown) => Response.json({ success: true, data });
const result = (value: unknown) => success({ result: value });
const unavailable = (status: number, code: string) =>
  Response.json({ success: false, code, error: secret }, { status });
const discovery = (bindingId = target.bindingId, requests = methods) =>
  success({ version: 1, bindingId, notifications: [], requests });
const active = (turnId = target.turnId) => result({ active: true, turnId });

function holdReply() {
  let reply!: (value: Response) => void;
  const pending = new Promise<Response>((resolve) => {
    reply = resolve;
  });
  return { pending, reply };
}

describe('running input renderer client', () => {
  const unsubscribe = vi.fn();
  const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>();
  let reconnect: (() => void) | undefined;
  let client: ReturnType<typeof createRunningInputClient>;

  function offer(bindingId = target.bindingId, turnId = target.turnId): void {
    fetchMock.mockResolvedValueOnce(discovery(bindingId)).mockResolvedValueOnce(active(turnId));
  }

  function calls(): string[] {
    return fetchMock.mock.calls.map(([url, init]) =>
      init.body ? JSON.parse(String(init.body)).method : init.method === 'GET' ? 'discover' : url
    );
  }

  beforeEach(() => {
    fetchMock.mockReset();
    unsubscribe.mockClear();
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(httpBridge, 'wsEmitter').mockImplementation(() => ({
      on: (handler) => {
        reconnect = handler as () => void;
        return unsubscribe;
      },
      emit: () => {},
    }));
    client = createRunningInputClient('space / id');
  });

  afterEach(() => {
    client.dispose();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    document.cookie = 'aelix-studio-csrf-token=; Max-Age=0; Path=/';
  });

  it('discovers an encoded conversation, sends text once with the CSRF token, and records the native receipt', async () => {
    document.cookie = 'aelix-studio-csrf-token=fixture-csrf; Path=/';
    offer();
    fetchMock.mockResolvedValueOnce(result(accepted));
    await client.refresh();

    const send = await client.send('steer', target, secret);
    const [path, init] = fetchMock.mock.calls[2];
    expect(path).toBe('/api/conversations/space%20%2F%20id/acp-extensions');
    expect(init).toMatchObject({
      method: 'POST',
      credentials: 'same-origin',
      redirect: 'error',
      headers: { 'x-csrf-token': 'fixture-csrf' },
    });
    expect(JSON.parse(String(init.body))).toEqual({
      bindingId: target.bindingId,
      method: PREFIX + 'input/steer',
      payload: {
        turnId: target.turnId,
        message: secret,
        requestId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
      },
    });
    expect(send).toMatchObject({ status: 'sent', preserveDraft: false, receipt: { ...target, status: 'queued' } });
  });

  it('keeps the draft and sends nothing to an unadvertised mode', async () => {
    fetchMock.mockResolvedValueOnce(discovery(target.bindingId, methods.slice(0, 2))).mockResolvedValueOnce(active());
    await client.refresh();
    expect(await client.send('follow-up', target, secret)).toMatchObject({ status: 'skipped', preserveDraft: true });
    expect(calls()).toEqual(['discover', methods[0]]);
  });

  it('treats a pre-relay host as unsupported', async () => {
    fetchMock.mockResolvedValueOnce(unavailable(404, 'CONVERSATION_NOT_FOUND'));
    await client.refresh();
    expect(client.getSnapshot().channel).toEqual({ status: 'unsupported' });
    expect(calls()).toEqual(['discover']);
  });

  it('preserves the draft on stale turn and never falls back to ordinary send', async () => {
    offer();
    fetchMock.mockResolvedValueOnce(result({ accepted: false, reason: 'stale-turn' }));
    await client.refresh();
    expect(await client.send('follow-up', target, secret)).toMatchObject({
      preserveDraft: true,
      receipt: { ...target, status: 'rejected', reason: 'stale-turn' },
    });
    expect(calls()).toEqual(['discover', methods[0], methods[2]]);
  });

  it('recovers auth and rediscovers without replaying the original POST', async () => {
    offer();
    fetchMock
      .mockResolvedValueOnce(unavailable(401, 'AUTH_REQUIRED'))
      .mockResolvedValueOnce(unavailable(401, 'AUTH_REQUIRED'))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    offer();
    await client.refresh();

    expect(await client.send('steer', target, secret)).toMatchObject({
      preserveDraft: true,
      receipt: { status: 'rejected', failure: { status: 401 } },
    });
    expect(calls()).toEqual([
      'discover',
      methods[0],
      methods[1],
      'discover',
      '/api/auth/refresh',
      'discover',
      methods[0],
    ]);
  });

  it.each([
    ['EXT_STALE_BINDING', 'rejected'],
    ['EXT_OUTCOME_UNKNOWN', 'unknown'],
  ])('preserves the draft on 409 %s and rediscovers the binding', async (code, status) => {
    offer();
    fetchMock.mockResolvedValueOnce(unavailable(409, code));
    offer();
    await client.refresh();
    expect(await client.send('steer', target, secret)).toMatchObject({ preserveDraft: true, receipt: { status } });
    expect(calls()).toEqual(['discover', methods[0], methods[1], 'discover', methods[0]]);
  });

  it('checks an ambiguous result with lookup on the original key and omits opaque bodies from diagnostics', async () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    offer();
    fetchMock
      .mockRejectedValueOnce(new Error(secret))
      .mockResolvedValueOnce(result({ status: 'completed', result: accepted }));
    await client.refresh();
    const send = await client.send('steer', target, secret);
    expect(send).toMatchObject({ status: 'sent', preserveDraft: true, receipt: { status: 'unknown' } });
    if (send.status !== 'sent') throw new Error('Expected a dispatched request');
    const { requestId } = send.receipt;
    expect(await client.lookup(requestId)).toMatchObject({
      status: 'completed',
      receipt: { requestId, ...target, status: 'queued' },
    });
    expect(JSON.parse(String(fetchMock.mock.calls[3][1].body)).payload).toEqual({ requestId });
    expect(calls()).toEqual(['discover', methods[0], methods[1], methods[3]]);
    expect([...debug.mock.calls, ...errors.mock.calls]).toEqual([]);
  });

  it('requests state and history refresh when the original result has expired', async () => {
    offer();
    fetchMock.mockRejectedValueOnce(new Error(secret)).mockResolvedValueOnce(result({ status: 'unavailable' }));
    offer();
    await client.refresh();
    const send = await client.send('steer', target, secret);
    if (send.status !== 'sent') throw new Error('Expected a dispatched request');
    expect(await client.lookup(send.receipt.requestId)).toEqual({ status: 'unavailable', refreshHistory: true });
    expect(calls()).toEqual(['discover', methods[0], methods[1], methods[3], 'discover', methods[0]]);
    expect(client.getSnapshot().receipts[0].status).toBe('unknown');
  });

  it('serializes writes and attributes a late receipt to its original turn after a same-binding reconnect', async () => {
    offer();
    const held = holdReply();
    fetchMock.mockReturnValueOnce(held.pending);
    offer(target.bindingId, 'turn-2');
    await client.refresh();

    const pending = client.send('steer', target, secret);
    expect(await client.send('follow-up', target, secret)).toEqual({
      status: 'skipped',
      reason: 'busy',
      preserveDraft: true,
    });
    reconnect?.();
    await client.refresh();
    held.reply(result(accepted));
    await pending;
    expect(client.getSnapshot()).toMatchObject({
      channel: { status: 'ready', turn: { turnId: 'turn-2' } },
      receipts: [{ ...target, status: 'queued' }],
      sending: false,
    });
    expect(calls()).toEqual(['discover', methods[0], methods[1], 'discover', methods[0]]);
  });

  it('ignores late receipts on a replaced binding and never looks them up on the new binding', async () => {
    offer();
    const held = holdReply();
    fetchMock.mockReturnValueOnce(held.pending);
    offer('new-binding', 'turn-2');
    await client.refresh();

    const pending = client.send('steer', target, secret);
    const { requestId } = client.getSnapshot().receipts[0];
    reconnect?.();
    await client.refresh();
    held.reply(result(accepted));
    expect(await pending).toMatchObject({ preserveDraft: true });
    expect(client.getSnapshot().receipts).toEqual([]);
    expect(await client.lookup(requestId)).toEqual({ status: 'binding-changed', refreshHistory: true });
  });

  it('discards a discovery response superseded by a reconnect', async () => {
    const held = holdReply();
    fetchMock.mockReturnValueOnce(held.pending);
    offer('new-binding', 'turn-2');
    const first = client.refresh();
    reconnect?.();
    await client.refresh();
    held.reply(discovery());
    await first;
    expect(client.getSnapshot().channel).toMatchObject({ status: 'ready', bindingId: 'new-binding' });
    expect(calls()).toEqual(['discover', 'discover', methods[0]]);
  });
});
