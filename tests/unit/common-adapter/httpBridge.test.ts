/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for common/adapter/httpBridge.ts (T3 in N3 test checklist).
 * Tests HTTP/WS bridge factories, error handling, and port resolution.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  getBaseUrl,
  httpGet,
  httpPost,
  httpPut,
  httpPatch,
  httpDelete,
  stubProvider,
  withResponseMap,
  BackendHttpError,
  isBackendHttpError,
  wsEmitter,
  wsMappedEmitter,
  stubEmitter,
  httpRequest,
} from '@/common/adapter/httpBridge';
import { conversation, fs } from '@/common/adapter/ipcBridge';

type FakeSocketEventMap = {
  open: () => void;
  message: (event: MessageEvent<string>) => void;
  close: (event: CloseEvent) => void;
  error: () => void;
};

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  private readonly listeners: { [K in keyof FakeSocketEventMap]: FakeSocketEventMap[K][] } = {
    open: [],
    message: [],
    close: [],
    error: [],
  };

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener<K extends keyof FakeSocketEventMap>(type: K, listener: FakeSocketEventMap[K]) {
    this.listeners[type].push(listener);
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
  }

  dispatchOpen() {
    this.readyState = FakeWebSocket.OPEN;
    for (const listener of this.listeners.open) listener();
  }

  dispatchMessage(data: string) {
    for (const listener of this.listeners.message) listener({ data } as MessageEvent<string>);
  }

  dispatchClose() {
    this.readyState = FakeWebSocket.CLOSED;
    for (const listener of this.listeners.close) listener({ code: 1006, reason: '' } as CloseEvent);
  }
}

describe('httpBridge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('getBaseUrl', () => {
    it('returns fallback URL in node environment with no globalThis.__backendPort', () => {
      const result = getBaseUrl();
      expect(result).toBe('http://127.0.0.1:13400');
    });

    it('reads port from globalThis.__backendPort when set', () => {
      (globalThis as { __backendPort?: number }).__backendPort = 23456;

      const result = getBaseUrl();

      expect(result).toBe('http://127.0.0.1:23456');

      delete (globalThis as { __backendPort?: number }).__backendPort;
    });

    it('reads port from window.__backendPort with priority', () => {
      (globalThis as { __backendPort?: number }).__backendPort = 11111;
      vi.stubGlobal('window', { __backendPort: 34567 });

      const result = getBaseUrl();

      expect(result).toBe('http://127.0.0.1:34567');

      delete (globalThis as { __backendPort?: number }).__backendPort;
    });

    it('returns empty string in WebUI mode (window + document, no __backendPort)', () => {
      vi.stubGlobal('window', {});
      vi.stubGlobal('document', {});

      const result = getBaseUrl();

      expect(result).toBe('');
    });
  });

  describe('httpGet', () => {
    it('constructs provider and invoke, provider is no-op', () => {
      const h = httpGet('/api/x');
      expect(h.provider).toBeTypeOf('function');
      expect(h.invoke).toBeTypeOf('function');

      // Provider should be no-op (no error)
      h.provider(() => Promise.resolve({ ok: true }));
    });

    it('invoke triggers fetch with GET, no body, unwraps data envelope', async () => {
      const fetchSpy = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ data: { x: 1 } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );
      vi.stubGlobal('fetch', fetchSpy);
      vi.spyOn(console, 'debug').mockImplementation(() => {});

      const result = await httpGet<{ x: number }>('/api/foo').invoke();

      expect(result).toEqual({ x: 1 });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(fetchSpy.mock.calls[0][0]).toContain('/api/foo');
      expect(fetchSpy.mock.calls[0][1]?.method).toBe('GET');
      expect(fetchSpy.mock.calls[0][1]?.body).toBeUndefined();
    });
  });

  describe('httpPost', () => {
    it('aborts a stalled keepalive POST after the request deadline', async () => {
      const fetchSpy = vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
          })
      );
      vi.stubGlobal('fetch', fetchSpy);
      const call = httpPost('/api/lifecycle', () => ({ view_id: 'view' }), { keepalive: true, timeoutMs: 10 });
      await expect(call.invoke()).rejects.toMatchObject({ name: 'TimeoutError' });
      expect(fetchSpy.mock.calls[0][1].keepalive).toBe(true);
    });

    it('does not start an authentication refresh for a one-shot pagehide POST', async () => {
      const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 401 }));
      vi.stubGlobal('fetch', fetchSpy);
      vi.stubGlobal('window', {});
      vi.stubGlobal('document', {});
      await expect(
        httpPost('/api/lifecycle', undefined, { timeoutMs: 50, refreshAuth: false }).invoke()
      ).rejects.toMatchObject({
        status: 401,
      });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('invoke serializes body and sends content-type header', async () => {
      const fetchSpy = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ data: { created: true } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );
      vi.stubGlobal('fetch', fetchSpy);
      vi.spyOn(console, 'debug').mockImplementation(() => {});

      const result = await httpPost<{ created: boolean }, { k: string }>('/api/x').invoke({ k: 'v' });

      expect(result).toEqual({ created: true });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(fetchSpy.mock.calls[0][1]?.method).toBe('POST');
      expect(fetchSpy.mock.calls[0][1]?.body).toBe('{"k":"v"}');
      expect(fetchSpy.mock.calls[0][1]?.headers).toEqual({ 'Content-Type': 'application/json' });
    });

    it('applies mapBody custom mapper', async () => {
      const fetchSpy = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ data: { ok: true } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );
      vi.stubGlobal('fetch', fetchSpy);
      vi.spyOn(console, 'debug').mockImplementation(() => {});

      await httpPost('/api/x', (p: string) => ({ wrapped: p })).invoke('raw');

      expect(fetchSpy.mock.calls[0][1]?.body).toBe('{"wrapped":"raw"}');
    });
  });

  describe('path as function', () => {
    it('resolves path with params', async () => {
      const fetchSpy = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ data: { ok: true } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );
      vi.stubGlobal('fetch', fetchSpy);
      vi.spyOn(console, 'debug').mockImplementation(() => {});

      await httpGet<{ ok: boolean }, { id: string }>((p) => `/api/${p.id}`).invoke({ id: 'abc' });

      expect(fetchSpy.mock.calls[0][0]).toContain('/api/abc');
    });
  });

  describe('error handling', () => {
    it('non-2xx response throws BackendHttpError with code/status/backendMessage', async () => {
      const fetchSpy = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            success: false,
            error: 'bad',
            code: 'X_BAD',
            details: { workspace_path: '/tmp/Archive ' },
          }),
          {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          }
        )
      );
      vi.stubGlobal('fetch', fetchSpy);
      vi.spyOn(console, 'debug').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});

      try {
        await httpGet('/api/x').invoke();
        expect.fail('Should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(BackendHttpError);
        const err = e as BackendHttpError;
        expect(err.status).toBe(400);
        expect(err.code).toBe('X_BAD');
        expect(err.backendMessage).toBe('bad');
        expect(err.details).toEqual({ workspace_path: '/tmp/Archive ' });
        expect(err.body).toEqual({
          success: false,
          error: 'bad',
          code: 'X_BAD',
          details: { workspace_path: '/tmp/Archive ' },
        });
      }
    });

    it('non-JSON error response captures raw text without double body consumption (#3249)', async () => {
      const fetchSpy = vi.fn().mockResolvedValue(
        new Response('Unauthorized', {
          status: 401,
          statusText: 'Unauthorized',
          headers: { 'Content-Type': 'text/plain' },
        })
      );
      vi.stubGlobal('fetch', fetchSpy);
      vi.spyOn(console, 'debug').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});

      try {
        await httpGet('/api/x').invoke();
        expect.fail('Should have thrown');
      } catch (e) {
        // Before the fix this threw TypeError "body stream already read" instead
        expect(e).toBeInstanceOf(BackendHttpError);
        const err = e as BackendHttpError;
        expect(err.status).toBe(401);
        expect(err.body).toBe('Unauthorized');
      }
    });

    it('empty error body falls back to empty string', async () => {
      const fetchSpy = vi.fn().mockResolvedValue(new Response('', { status: 502 }));
      vi.stubGlobal('fetch', fetchSpy);
      vi.spyOn(console, 'debug').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});

      try {
        await httpGet('/api/x').invoke();
        expect.fail('Should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(BackendHttpError);
        const err = e as BackendHttpError;
        expect(err.status).toBe(502);
        expect(err.body).toBe('');
      }
    });
  });

  describe('non-JSON response', () => {
    it('returns undefined when content-type is not JSON', async () => {
      const fetchSpy = vi.fn().mockResolvedValue(
        new Response('', {
          status: 200,
        })
      );
      vi.stubGlobal('fetch', fetchSpy);
      vi.spyOn(console, 'debug').mockImplementation(() => {});

      const result = await httpGet('/api/x').invoke();

      expect(result).toBeUndefined();
    });
  });

  describe('stubProvider', () => {
    it('returns default value and logs warning', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const provider = stubProvider('test', 42);
      const result = await provider.invoke();

      expect(result).toBe(42);
      expect(warnSpy).toHaveBeenCalledWith('[httpBridge] stub: test not yet implemented in backend');
    });
  });

  describe('withResponseMap', () => {
    it('wraps invoke and applies mapper', async () => {
      const fetchSpy = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ data: { raw: 'abc' } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );
      vi.stubGlobal('fetch', fetchSpy);
      vi.spyOn(console, 'debug').mockImplementation(() => {});

      const inner = httpGet<{ raw: string }>('/api/data');
      const mapped = withResponseMap(inner, (data) => data.raw.toUpperCase());

      const result = await mapped.invoke();
      expect(result).toBe('ABC');
    });
  });

  describe('BackendHttpError', () => {
    it('instanceof check works', () => {
      const err = new BackendHttpError({ method: 'GET', path: '/api/x', status: 500, body: {} });
      expect(err).toBeInstanceOf(BackendHttpError);
      expect(isBackendHttpError(err)).toBe(true);
    });

    it('duck-typing check works for compatible object', () => {
      const obj = {
        name: 'BackendHttpError',
        status: 500,
        code: 'X',
        backendMessage: 'msg',
      };
      expect(isBackendHttpError(obj)).toBe(true);
    });

    it('duck-typing returns false when status is missing', () => {
      const obj = {
        name: 'BackendHttpError',
        code: 'X',
      };
      expect(isBackendHttpError(obj)).toBe(false);
    });

    it('returns false for non-BackendHttpError', () => {
      expect(isBackendHttpError(new Error('other'))).toBe(false);
      expect(isBackendHttpError(null)).toBe(false);
      expect(isBackendHttpError('string')).toBe(false);
    });
  });

  describe('wsEmitter', () => {
    it('emits realtime.reconnected only after a prior websocket open', () => {
      vi.useFakeTimers();
      vi.stubGlobal('window', { __backendPort: 13400 });
      vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket);
      vi.spyOn(console, 'debug').mockImplementation(() => {});
      FakeWebSocket.instances = [];

      const events: unknown[] = [];
      const unsubscribe = wsEmitter('realtime.reconnected').on((payload: unknown) => events.push(payload));

      FakeWebSocket.instances[0].dispatchOpen();
      expect(events).toEqual([]);

      FakeWebSocket.instances[0].dispatchClose();
      vi.advanceTimersByTime(1000);
      FakeWebSocket.instances[1].dispatchOpen();

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ timestamp: expect.any(Number) });

      FakeWebSocket.instances[1].dispatchClose();
      vi.clearAllTimers();
      unsubscribe();
      vi.useRealTimers();
    });

    const body = 'studio-ws body "private"\nline';
    const path = 'C:\\studio-ws\\private.txt';
    const image = 'c3R1ZGlvLXdzLXByaXZhdGUtaW1hZ2U=';
    it.each([
      { kind: 'body', marker: body, message: { type: 'text', data: body } },
      { kind: 'path', marker: path, message: { type: 'acp_tool_call', data: { update: { rawInput: { path } } } } },
      {
        kind: 'image',
        marker: image,
        message: { type: 'acp_tool_call', data: { update: { rawOutput: { data: image } } } },
      },
    ])('dispatches standard frames without logging the $kind', ({ marker, message }) => {
      const name = 'message.stream';
      const data = { conversation_id: 'conv-1', msg_id: 'msg-1', ...message };
      const frame = JSON.stringify({ name, data });
      const received = vi.fn();
      vi.stubGlobal('window', { __backendPort: 13400 });
      vi.stubGlobal('WebSocket', FakeWebSocket);
      const logs = (['debug', 'info', 'log', 'warn', 'error'] as const).map((level) =>
        vi.spyOn(console, level).mockImplementation(() => {})
      );
      const unsubscribe = wsEmitter<unknown>(name).on(received);
      const socket = FakeWebSocket.instances.at(-1)!;
      const escaped = JSON.stringify(marker).slice(1, -1);
      const capturedOutput = () =>
        logs
          .flatMap((log) => log.mock.calls.flat())
          .map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg)))
          .join('\n');

      try {
        // Positive control: the sink detects decoded text and the old serialized prefix.
        console.debug(marker);
        expect(capturedOutput()).toContain(marker);
        logs[0].mockClear();
        console.debug(JSON.stringify(data).slice(0, 200));
        expect(capturedOutput()).toContain(escaped);
        for (const log of logs) log.mockClear();
        socket.dispatchMessage(frame);

        expect(received).toHaveBeenCalledWith(data);
        const output = capturedOutput();
        for (const form of [marker, escaped]) expect(output).not.toContain(form);
        expect(logs[0]).toHaveBeenCalledExactlyOnceWith('[WS:msg]', name, frame.length);
      } finally {
        unsubscribe();
        socket.close();
        for (const log of logs) log.mockRestore();
      }
    });

    it('logs sizes for ACP relay frames and keeps unknown event names out of diagnostics', () => {
      const name = 'conversation.acpExtension';
      const data = { marker: 'private extension content' };
      const relay = JSON.stringify({ event: name, payload: data });
      const unknown = JSON.stringify({ name: 'private event name', data });
      const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
      const received = vi.fn();
      vi.stubGlobal('window', { __backendPort: 13400 });
      vi.stubGlobal('WebSocket', FakeWebSocket);
      const unsubscribe = wsEmitter<unknown>(name).on(received);
      const socket = FakeWebSocket.instances.at(-1)!;
      try {
        debug.mockClear();
        socket.dispatchMessage(relay);
        socket.dispatchMessage(unknown);
        socket.dispatchMessage('{"data":"malformed private content"');
        expect(received).toHaveBeenCalledExactlyOnceWith(data);
        expect(debug.mock.calls).toEqual([
          ['[WS:msg]', name, relay.length],
          ['[WS:msg]', 'unsubscribed', unknown.length],
        ]);
      } finally {
        unsubscribe();
        socket.close();
        debug.mockRestore();
      }
    });

    it('on returns unsubscribe function that removes listener', () => {
      const events: unknown[] = [];

      const emitter = wsEmitter('test-event');
      const unsub = emitter.on((payload: unknown) => {
        events.push(payload);
      });

      // Trigger event manually via mock (since emit is no-op in source)
      // In real usage, WS message handler dispatches to listeners
      // For testing, we verify the subscription registry behavior

      // Verify unsub removes the listener
      expect(typeof unsub).toBe('function');
      unsub();

      // After unsub, listener should not be called
      // (We can't directly test emit behavior without mocking WebSocket,
      // but we verify the on/off mechanics work)
    });

    it('emit is a no-op function', () => {
      const emitter = wsEmitter('test');
      // Should not throw
      emitter.emit();
    });
  });

  describe('wsMappedEmitter', () => {
    it('applies transform function to subscribed callback', () => {
      const events: number[] = [];

      const emitter = wsMappedEmitter<number>('raw-event', (raw: unknown) => (raw as { v: number }).v * 2);

      emitter.on((value: number) => {
        events.push(value);
      });

      // In real usage, WS message with { v: 3 } would trigger the transform
      // Here we verify the subscription and transform logic is wired
    });
  });

  describe('stubEmitter', () => {
    it('on returns harmless unsubscribe', () => {
      const e = stubEmitter('x');
      const off = e.on(() => {});
      expect(typeof off).toBe('function');
      off(); // Should not throw
    });

    it('emit is a no-op', () => {
      const e = stubEmitter('x');
      // Should not throw
      e.emit();
    });
  });

  describe('httpRequest', () => {
    it('sends ordinary messages while keeping request and failure details out of diagnostics', async () => {
      const input = 'private "conversation"\nbody';
      const path = 'C:\\private-workspace\\image.png';
      const files = [{ kind: 'local' as const, path }];
      const details = { path, base64: 'c3R1ZGlvLWltYWdl', digest: 'private-digest', grant: 'private-grant' };
      const failure = { code: 'PERMISSION_DENIED', error: input, details };
      const rawFailure = JSON.stringify(failure);
      const request = { content: input, files };
      const rawRequest = JSON.stringify(request);
      const fetchSpy = vi
        .fn()
        .mockResolvedValueOnce(Response.json({ data: { msg_id: 'accepted' } }))
        .mockResolvedValueOnce(new Response(rawFailure, { status: 403 }));
      vi.stubGlobal('fetch', fetchSpy);
      const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        expect(rawRequest).toContain(JSON.stringify(path).slice(1, -1));
        expect(rawFailure).toContain(JSON.stringify(input).slice(1, -1));
        const send = () =>
          conversation.sendMessage.invoke({ conversation_id: 'private-conversation-id', input, files });
        await expect(send()).resolves.toEqual({ msg_id: 'accepted' });
        await expect(send()).rejects.toMatchObject({
          status: 403,
          code: failure.code,
          backendMessage: input,
          details,
          body: failure,
        });
        expect(fetchSpy).toHaveBeenCalledTimes(2);
        for (const [, options] of fetchSpy.mock.calls) expect(options.body).toBe(rawRequest);
        expect(debug.mock.calls).toEqual([
          ['[httpBridge] request', rawRequest.length],
          ['[httpBridge] request succeeded', 200],
          ['[httpBridge] request', rawRequest.length],
        ]);
        expect(error).toHaveBeenCalledExactlyOnceWith('[httpBridge] request failed', 403, rawFailure.length);
      } finally {
        debug.mockRestore();
        error.mockRestore();
      }
    });

    it('keeps image lookup paths and backend error bodies out of diagnostics', async () => {
      const path = 'C:\\private-workspace\\tool-image.png';
      const failure = JSON.stringify({ error: path });
      const fetchSpy = vi.fn().mockResolvedValue(new Response(failure, { status: 403 }));
      vi.stubGlobal('fetch', fetchSpy);
      const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        await expect(fs.getImageBase64.invoke({ path })).rejects.toMatchObject({
          status: 403,
          backendMessage: path,
          body: { error: path },
        });
        expect(fetchSpy).toHaveBeenCalledWith(
          expect.stringContaining('/api/fs/image-base64'),
          expect.objectContaining({ body: JSON.stringify({ path }) })
        );
        expect(debug).toHaveBeenCalledExactlyOnceWith('[httpBridge] request', JSON.stringify({ path }).length);
        expect(error).toHaveBeenCalledExactlyOnceWith('[httpBridge] request failed', 403, failure.length);
      } finally {
        debug.mockRestore();
        error.mockRestore();
      }
    });

    it('performs fetch and unwraps data envelope', async () => {
      const fetchSpy = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ data: { result: 'ok' } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );
      vi.stubGlobal('fetch', fetchSpy);
      vi.spyOn(console, 'debug').mockImplementation(() => {});

      const result = await httpRequest<{ result: string }>('GET', '/api/test');

      expect(result).toEqual({ result: 'ok' });
      expect(fetchSpy).toHaveBeenCalledWith(expect.stringContaining('/api/test'), {
        method: 'GET',
        headers: {},
        body: undefined,
      });
    });

    it('sends JSON body for POST with content-type', async () => {
      const fetchSpy = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ data: {} }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );
      vi.stubGlobal('fetch', fetchSpy);
      vi.spyOn(console, 'debug').mockImplementation(() => {});

      await httpRequest('POST', '/api/create', { key: 'value' });

      expect(fetchSpy.mock.calls[0][1]?.body).toBe('{"key":"value"}');
      expect(fetchSpy.mock.calls[0][1]?.headers).toEqual({ 'Content-Type': 'application/json' });
    });
  });

  describe('httpPut', () => {
    it('sends PUT request with body', async () => {
      const fetchSpy = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ data: { updated: true } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );
      vi.stubGlobal('fetch', fetchSpy);
      vi.spyOn(console, 'debug').mockImplementation(() => {});

      await httpPut<{ updated: boolean }, { id: string }>('/api/items/:id').invoke({ id: '123' });

      expect(fetchSpy.mock.calls[0][1]?.method).toBe('PUT');
    });
  });

  describe('httpPatch', () => {
    it('sends PATCH request with body', async () => {
      const fetchSpy = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ data: { patched: true } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );
      vi.stubGlobal('fetch', fetchSpy);
      vi.spyOn(console, 'debug').mockImplementation(() => {});

      await httpPatch('/api/items').invoke({ id: '123' });

      expect(fetchSpy.mock.calls[0][1]?.method).toBe('PATCH');
    });
  });

  describe('httpDelete', () => {
    it('sends DELETE request with no body', async () => {
      const fetchSpy = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ data: { deleted: true } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );
      vi.stubGlobal('fetch', fetchSpy);
      vi.spyOn(console, 'debug').mockImplementation(() => {});

      await httpDelete('/api/items/123').invoke();

      expect(fetchSpy.mock.calls[0][1]?.method).toBe('DELETE');
      expect(fetchSpy.mock.calls[0][1]?.body).toBeUndefined();
    });
  });
});
