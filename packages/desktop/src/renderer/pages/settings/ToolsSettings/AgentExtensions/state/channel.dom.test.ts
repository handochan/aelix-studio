/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { StudioExtensionsReply, StudioExtensionsRequest } from '@aionui/web-host';
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useExtensionsChannel } from './channel';

const secret = {
  action: 'set_proxy_credentials',
  credentials: { username: 'ops', password: 'sentinel-secret' },
} as const;

/** The desktop channel answering every request with `transport` (or none); `refuse` answers secrets sent unflagged. */
function channel(transport: 'secure' | 'insecure' | undefined, refuse?: string) {
  const request = vi.fn(async (command: StudioExtensionsRequest): Promise<StudioExtensionsReply> => {
    const flagged = (command as { acknowledgeInsecureTransport?: boolean }).acknowledgeInsecureTransport;
    const body =
      refuse && !flagged && command.action !== 'get_settings'
        ? { ok: false as const, code: refuse }
        : { ok: true as const, data: { settings: {} } };
    return { ...body, ...(transport ? { transport } : {}) } as StudioExtensionsReply;
  });
  window.__studioExtensions = { request };
  return request;
}

/** What was sent, in order. */
const commands = (request: ReturnType<typeof vi.fn>) => request.mock.calls.map(([command]) => command);

afterEach(() => {
  delete window.__studioExtensions;
});

describe('the screen channel', () => {
  it('counts the time before the first reply as insecure', () => {
    channel('secure');
    const { result } = renderHook(() => useExtensionsChannel(vi.fn(async () => true)));
    expect(result.current.transport).toBeUndefined();
  });

  it('reads the channel again, with nothing secret, right before every secret', async () => {
    let transport: 'secure' | 'insecure' = 'secure';
    const request = vi.fn(
      async (): Promise<StudioExtensionsReply> =>
        ({ ok: true, data: { settings: {} }, transport }) as unknown as StudioExtensionsReply
    );
    window.__studioExtensions = { request };
    const confirm = vi.fn(async () => false);
    const { result } = renderHook(() => useExtensionsChannel(confirm));
    await act(async () => {
      await result.current.send({ action: 'get_settings' });
    });
    // The last reply said secure; the channel has since become insecure.
    transport = 'insecure';
    request.mockClear();
    let reply: unknown;
    await act(async () => {
      reply = await result.current.send(secret);
    });
    expect(reply).toBe('declined');
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(commands(request)).toEqual([{ action: 'get_settings' }]);
  });

  it('takes a reply without transport as insecure, and asks once per visit', async () => {
    const request = channel(undefined);
    const confirm = vi.fn(async () => true);
    const { result } = renderHook(() => useExtensionsChannel(confirm));
    await act(async () => {
      await result.current.send({ action: 'get_settings' });
    });
    expect(result.current.transport).toBe('insecure');
    await act(async () => {
      await result.current.send(secret);
      await result.current.send(secret);
    });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenLastCalledWith({ ...secret, acknowledgeInsecureTransport: true });
  });

  it('asks again once the transport changed after a yes', async () => {
    let transport: 'secure' | 'insecure' = 'insecure';
    const request = vi.fn(
      async (): Promise<StudioExtensionsReply> =>
        ({ ok: true, data: { settings: {} }, transport }) as unknown as StudioExtensionsReply
    );
    window.__studioExtensions = { request };
    const confirm = vi.fn(async () => true);
    const { result } = renderHook(() => useExtensionsChannel(confirm));
    await act(async () => {
      await result.current.send({ action: 'get_settings' });
      await result.current.send(secret);
    });
    expect(confirm).toHaveBeenCalledTimes(1);
    transport = 'secure';
    await act(async () => {
      await result.current.send({ action: 'get_settings' });
    });
    transport = 'insecure';
    await act(async () => {
      await result.current.send({ action: 'get_settings' });
      await result.current.send(secret);
    });
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it('sends a secret on a secure channel without asking or flagging it', async () => {
    const request = channel('secure');
    const confirm = vi.fn(async () => true);
    const { result } = renderHook(() => useExtensionsChannel(confirm));
    await act(async () => {
      await result.current.send({ action: 'get_settings' });
      await result.current.send(secret);
    });
    expect(confirm).not.toHaveBeenCalled();
    expect(request).toHaveBeenLastCalledWith(secret);
  });

  it('checks the channel again before sending again, after the host answered INSECURE_TRANSPORT', async () => {
    // The channel said secure, then a secret was refused as insecure: it changed meanwhile.
    let transport: 'secure' | 'insecure' = 'secure';
    const request = vi.fn(async (command: StudioExtensionsRequest): Promise<StudioExtensionsReply> => {
      const flagged = (command as { acknowledgeInsecureTransport?: boolean }).acknowledgeInsecureTransport;
      if (command.action !== 'get_settings' && !flagged) {
        transport = 'insecure';
        return { ok: false, code: 'INSECURE_TRANSPORT', transport } as unknown as StudioExtensionsReply;
      }
      return { ok: true, data: { settings: {} }, transport } as unknown as StudioExtensionsReply;
    });
    window.__studioExtensions = { request };
    const confirm = vi.fn(async () => true);
    const { result } = renderHook(() => useExtensionsChannel(confirm));
    let reply: unknown;
    await act(async () => {
      reply = await result.current.send(secret);
    });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(commands(request)).toEqual([
      { action: 'get_settings' },
      secret,
      { action: 'get_settings' },
      { ...secret, acknowledgeInsecureTransport: true },
    ]);
    expect(reply).toMatchObject({ ok: true });
  });

  it.each(['secure', 'insecure'] as const)(
    'sends no secret, and asks nothing, once the screen was left while the channel was being checked (%s)',
    async (transport) => {
      let answer: (() => void) | undefined;
      const request = vi.fn(async (command: StudioExtensionsRequest): Promise<StudioExtensionsReply> => {
        if (command.action === 'get_settings') await new Promise<void>((resolve) => (answer = resolve));
        return { ok: true, data: { settings: {} }, transport } as unknown as StudioExtensionsReply;
      });
      window.__studioExtensions = { request };
      const confirm = vi.fn(async () => true);
      const { result, unmount } = renderHook(() => useExtensionsChannel(confirm));
      const sending = result.current.send(secret);
      await vi.waitFor(() => expect(answer).toBeDefined());
      unmount();
      answer?.();
      // Whatever the answer says: the screen that asked is gone.
      expect(await sending).toBe('declined');
      expect(confirm).not.toHaveBeenCalled();
      expect(commands(request)).toEqual([{ action: 'get_settings' }]);
    }
  );

  it('sends no secret once the screen was left while the user was being asked', async () => {
    const request = channel('insecure');
    let decide: ((yes: boolean) => void) | undefined;
    const confirm = vi.fn(() => new Promise<boolean>((resolve) => (decide = resolve)));
    const { result, unmount } = renderHook(() => useExtensionsChannel(confirm));
    const sending = result.current.send(secret);
    await vi.waitFor(() => expect(decide).toBeDefined());
    unmount();
    decide?.(true);
    expect(await sending).toBe('declined');
    expect(commands(request)).toEqual([{ action: 'get_settings' }]);
  });

  it('asks again before sending again when a secret it was told to send is still refused', async () => {
    let refusals = 1;
    const request = vi.fn(async (command: StudioExtensionsRequest): Promise<StudioExtensionsReply> => {
      const refused = command.action !== 'get_settings' && refusals > 0;
      if (refused) refusals -= 1;
      return (refused
        ? { ok: false, code: 'INSECURE_TRANSPORT', transport: 'insecure' }
        : { ok: true, data: { settings: {} }, transport: 'insecure' }) as unknown as StudioExtensionsReply;
    });
    window.__studioExtensions = { request };
    const confirm = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const { result } = renderHook(() => useExtensionsChannel(confirm));
    let reply: unknown;
    await act(async () => {
      reply = await result.current.send(secret);
    });
    // The same insecure verdict, already confirmed: still asked again, and not sent on no.
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(reply).toBe('declined');
    expect(commands(request)).toEqual([
      { action: 'get_settings' },
      { ...secret, acknowledgeInsecureTransport: true },
      { action: 'get_settings' },
    ]);
  });

  it.each([
    ['proxy credentials', { action: 'set_proxy_credentials', credentials: { username: 'u', password: 'p' } }],
    [
      'a Git URL with a password',
      { action: 'install', source: { kind: 'git', url: 'https://u:tok@git.example/x.git' } },
    ],
    [
      'a Git URL with a token as user',
      { action: 'install', source: { kind: 'git', url: 'https://tok@git.example/x.git' } },
    ],
    [
      'an index URL with a password',
      { action: 'install', source: { kind: 'index', name: 'x', indexUrl: 'https://u:p@pypi.corp/simple' } },
    ],
    ['a proxy address with a password', { action: 'set_settings', settings: { proxy: 'http://u:p@proxy:3128' } }],
    [
      'an upgrade with proxy credentials',
      { action: 'upgrade', name: 'x', proxyCredentials: { username: 'u', password: 'p' } },
    ],
  ])('takes %s as a secret: checked and asked about over an insecure channel', async (_, command) => {
    const request = channel('insecure');
    const confirm = vi.fn(async () => false);
    const { result } = renderHook(() => useExtensionsChannel(confirm));
    let reply: unknown;
    await act(async () => {
      reply = await result.current.send(command as StudioExtensionsRequest);
    });
    expect(reply).toBe('declined');
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(commands(request)).toEqual([{ action: 'get_settings' }]);
  });

  it('sends a request without a secret at once, with no check', async () => {
    const request = channel('insecure');
    const confirm = vi.fn(async () => true);
    const { result } = renderHook(() => useExtensionsChannel(confirm));
    const plain = { action: 'install', source: { kind: 'git', url: 'https://git.example/x.git' } } as const;
    await act(async () => {
      await result.current.send(plain as unknown as StudioExtensionsRequest);
    });
    expect(confirm).not.toHaveBeenCalled();
    expect(commands(request)).toEqual([plain]);
  });

  it('decides by its own check, not by a secure answer to another request that came last', async () => {
    let releaseCheck: (() => void) | undefined;
    let releaseList: (() => void) | undefined;
    const request = vi.fn(async (command: StudioExtensionsRequest): Promise<StudioExtensionsReply> => {
      if (command.action === 'list') {
        await new Promise<void>((resolve) => (releaseList = resolve));
        return { ok: true, data: { extensions: [] }, transport: 'secure' } as unknown as StudioExtensionsReply;
      }
      if (command.action === 'get_settings') {
        await new Promise<void>((resolve) => (releaseCheck = resolve));
        // The list answer lands right behind the check's own answer.
        releaseList?.();
      }
      return { ok: true, data: { settings: {} }, transport: 'insecure' } as unknown as StudioExtensionsReply;
    });
    window.__studioExtensions = { request };
    const confirm = vi.fn(async () => true);
    const { result } = renderHook(() => useExtensionsChannel(confirm));
    await act(async () => {
      const listing = result.current.send({ action: 'list' });
      const sending = result.current.send(secret);
      await vi.waitFor(() => expect(releaseCheck).toBeDefined());
      releaseCheck?.();
      await Promise.all([listing, sending]);
    });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(commands(request).at(-1)).toEqual({ ...secret, acknowledgeInsecureTransport: true });
  });

  it('sends no secret for a flow that ended while it waited, and asks nothing for it', async () => {
    let answer: (() => void) | undefined;
    const request = vi.fn(async (command: StudioExtensionsRequest): Promise<StudioExtensionsReply> => {
      if (command.action === 'get_settings') await new Promise<void>((resolve) => (answer = resolve));
      return { ok: true, data: { settings: {} }, transport: 'insecure' } as unknown as StudioExtensionsReply;
    });
    window.__studioExtensions = { request };
    const confirm = vi.fn(async () => true);
    const { result } = renderHook(() => useExtensionsChannel(confirm));
    let valid = true;
    const sending = result.current.send(secret, () => valid);
    await vi.waitFor(() => expect(answer).toBeDefined());
    // Signed out, or another change asked for, while the check was out.
    valid = false;
    answer?.();
    expect(await sending).toBe('declined');
    expect(confirm).not.toHaveBeenCalled();
    expect(commands(request)).toEqual([{ action: 'get_settings' }]);
  });

  it('sends nothing for a flow that already ended', async () => {
    const request = channel('secure');
    const { result } = renderHook(() => useExtensionsChannel(vi.fn(async () => true)));
    await act(async () => {
      expect(await result.current.send(secret, () => false)).toBe('declined');
      expect(await result.current.send({ action: 'remove', name: 'x' }, () => false)).toBe('declined');
    });
    expect(request).not.toHaveBeenCalled();
  });
});
