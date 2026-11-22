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
  let fail!: (error: Error) => void;
  const pending = new Promise<Response>((resolve, reject) => {
    reply = resolve;
    fail = reject;
  });
  return { pending, reply, fail };
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

  it('confirms the ACP mapping only for the Host turn observed throughout discovery', async () => {
    let hostTurnId = 'host-turn-1';
    client.dispose();
    client = createRunningInputClient('space / id', () => hostTurnId);
    const state = holdReply();
    fetchMock.mockResolvedValueOnce(discovery()).mockReturnValueOnce(state.pending);

    const reading = client.refresh();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    hostTurnId = 'host-turn-2';
    state.reply(active());
    await reading;
    expect(client.getSnapshot().channel).toMatchObject({ status: 'ready', hostTurnId: null });

    offer();
    await client.refresh();
    expect(client.getSnapshot().channel).toMatchObject({ status: 'ready', hostTurnId: 'host-turn-2' });
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

  it('counts the exact UTF-8 envelope including escaped quotes, newlines, and the request UUID', async () => {
    const bodyFor = (message: string) =>
      JSON.stringify({
        bindingId: target.bindingId,
        method: methods[1],
        payload: { requestId: '00000000-0000-7000-8000-000000000000', turnId: target.turnId, message },
      });
    const size = (text: string) => new TextEncoder().encode(text).length;
    const seed = '한"\n'.repeat(9000);
    const exact = seed + 'a'.repeat(65_536 - size(bodyFor(seed)));
    offer();
    fetchMock.mockResolvedValueOnce(result(accepted));
    await client.refresh();

    await expect(client.send('steer', target, exact + 'a')).resolves.toEqual({
      status: 'skipped',
      reason: 'too-large',
      preserveDraft: true,
    });
    expect(calls()).toEqual(['discover', methods[0]]);
    await expect(client.send('steer', target, exact)).resolves.toMatchObject({ preserveDraft: false });
    expect(size(String(fetchMock.mock.calls[2][1].body))).toBe(65_536);
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

  it('preserves the draft on HTTP 200 stale-turn and reads the new turn without replaying the write', async () => {
    offer();
    fetchMock.mockResolvedValueOnce(result({ accepted: false, reason: 'stale-turn' }));
    offer(target.bindingId, 'turn-2');
    await client.refresh();
    expect(await client.send('follow-up', target, secret)).toMatchObject({
      preserveDraft: true,
      receipt: { ...target, status: 'rejected', reason: 'stale-turn' },
    });
    expect(client.getSnapshot().channel).toMatchObject({ status: 'ready', turn: { turnId: 'turn-2' } });
    expect(calls()).toEqual(['discover', methods[0], methods[2], 'discover', methods[0]]);
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
    await vi.waitFor(() => expect(client.getSnapshot().channel.status).toBe('ready'));
    held.reply(result(accepted));
    expect(await pending).toMatchObject({ preserveDraft: true });
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
    await vi.waitFor(() => expect(client.getSnapshot().channel.status).toBe('ready'));
    held.reply(result(accepted));
    expect(await pending).toMatchObject({ preserveDraft: true });
    expect(client.getSnapshot().receipts).toEqual([]);
    expect(await client.lookup(requestId)).toEqual({ status: 'binding-changed', refreshHistory: true });
  });

  it('waits for rediscovery before clearing a draft or publishing a receipt from the old binding', async () => {
    offer();
    const write = holdReply();
    const rediscover = holdReply();
    fetchMock
      .mockReturnValueOnce(write.pending)
      .mockReturnValueOnce(rediscover.pending)
      .mockResolvedValueOnce(active('turn-2'));
    await client.refresh();

    const queuedBindings: string[] = [];
    const stop = client.subscribe(() => {
      for (const receipt of client.getSnapshot().receipts) {
        if (receipt.status === 'queued') queuedBindings.push(receipt.bindingId);
      }
    });
    const send = client.send('steer', target, secret);
    reconnect?.();
    await vi.waitFor(() => expect(calls()).toHaveLength(4));

    write.reply(result(accepted));
    // Let the receipt reach the client while the rediscovery GET is still held.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    rediscover.reply(discovery('new-binding'));

    expect(await send).toMatchObject({ preserveDraft: true });
    expect(queuedBindings).toEqual([]);
    expect(client.getSnapshot()).toMatchObject({
      channel: { status: 'ready', bindingId: 'new-binding' },
      receipts: [],
    });
    stop();
  });

  it('settles an acknowledged write after a second reconnect supersedes a stalled discovery', async () => {
    offer();
    const write = holdReply();
    const superseded = holdReply();
    fetchMock.mockReturnValueOnce(write.pending).mockReturnValueOnce(superseded.pending);
    offer('new-binding', 'turn-2');
    await client.refresh();

    const send = client.send('steer', target, secret);
    reconnect?.();
    write.reply(result(accepted));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    reconnect?.();

    await expect(send).resolves.toMatchObject({ preserveDraft: true });
    expect(client.getSnapshot()).toMatchObject({
      channel: { status: 'ready', bindingId: 'new-binding' },
      receipts: [],
    });
    superseded.reply(discovery());
  });

  it.each([false, true])(
    'keeps a lookup-confirmed receipt when the original response fails (dismissed: %s)',
    async (dismissed) => {
      offer();
      const write = holdReply();
      fetchMock
        .mockReturnValueOnce(write.pending)
        .mockResolvedValueOnce(result({ status: 'completed', result: accepted }));
      await client.refresh();

      const send = client.send('steer', target, secret);
      const { requestId } = client.getSnapshot().receipts[0];
      const lookup = await client.lookup(requestId);
      expect(lookup).toMatchObject({ status: 'completed', receipt: { requestId, status: 'queued' } });
      if (dismissed) client.dismiss(requestId);
      write.fail(new Error('connection lost after queue admission'));

      expect(await send).toMatchObject({ preserveDraft: false, receipt: { requestId, status: 'queued' } });
      expect(client.getSnapshot().receipts).toEqual(
        dismissed ? [] : [expect.objectContaining({ requestId, status: 'queued' })]
      );
      expect(calls()).toEqual(['discover', methods[0], methods[1], methods[3]]);
    }
  );

  it('uses a fresh turn read for a refresh requested during a delayed state response', async () => {
    const oldState = holdReply();
    fetchMock.mockResolvedValueOnce(discovery()).mockReturnValueOnce(oldState.pending);
    offer(target.bindingId, 'turn-2');
    const readyTurns: (string | null)[] = [];
    const stop = client.subscribe(() => {
      const { channel } = client.getSnapshot();
      if (channel.status === 'ready') readyTurns.push(channel.turn.turnId);
    });

    const first = client.refresh();
    await vi.waitFor(() => expect(calls()).toEqual(['discover', methods[0]]));
    const changed = client.refresh();
    const repeated = client.refresh();
    oldState.reply(active());

    await Promise.all([first, changed, repeated]);
    expect(readyTurns).toEqual(['turn-2']);
    expect(client.getSnapshot().channel).toMatchObject({ status: 'ready', turn: { turnId: 'turn-2' } });
    expect(calls()).toEqual(['discover', methods[0], 'discover', methods[0]]);
    stop();
  });

  it('discards a discovery response superseded by a reconnect', async () => {
    const held = holdReply();
    fetchMock.mockReturnValueOnce(held.pending);
    offer('new-binding', 'turn-2');
    const first = client.refresh();
    await vi.waitFor(() => expect(calls()).toEqual(['discover']));
    reconnect?.();
    await first;
    held.reply(discovery());
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(client.getSnapshot().channel).toMatchObject({ status: 'ready', bindingId: 'new-binding' });
    expect(calls()).toEqual(['discover', 'discover', methods[0]]);
  });
});
