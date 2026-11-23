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
      reply = await result.current.send(secret, { secret: true });
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
      await result.current.send(secret, { secret: true });
      await result.current.send(secret, { secret: true });
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
      await result.current.send(secret, { secret: true });
    });
    expect(confirm).toHaveBeenCalledTimes(1);
    transport = 'secure';
    await act(async () => {
      await result.current.send({ action: 'get_settings' });
    });
    transport = 'insecure';
    await act(async () => {
      await result.current.send({ action: 'get_settings' });
      await result.current.send(secret, { secret: true });
    });
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it('sends a secret on a secure channel without asking or flagging it', async () => {
    const request = channel('secure');
    const confirm = vi.fn(async () => true);
    const { result } = renderHook(() => useExtensionsChannel(confirm));
    await act(async () => {
      await result.current.send({ action: 'get_settings' });
      await result.current.send(secret, { secret: true });
    });
    expect(confirm).not.toHaveBeenCalled();
    expect(request).toHaveBeenLastCalledWith(secret);
  });

  it('asks and sends again once when the host still answers INSECURE_TRANSPORT', async () => {
    // The channel said secure, then a request was refused as insecure (it changed meanwhile).
    const request = channel('secure', 'INSECURE_TRANSPORT');
    const confirm = vi.fn(async () => true);
    const { result } = renderHook(() => useExtensionsChannel(confirm));
    await act(async () => {
      await result.current.send({ action: 'get_settings' });
    });
    request.mockClear();
    let reply: unknown;
    await act(async () => {
      reply = await result.current.send(secret, { secret: true });
    });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(commands(request)).toEqual([
      { action: 'get_settings' },
      secret,
      { ...secret, acknowledgeInsecureTransport: true },
    ]);
    expect(reply).toMatchObject({ ok: true });
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
      reply = await result.current.send(secret, { secret: true });
    });
    // The same insecure verdict, already confirmed: still asked again, and not sent on no.
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(reply).toBe('declined');
    expect(commands(request)).toEqual([{ action: 'get_settings' }, { ...secret, acknowledgeInsecureTransport: true }]);
  });
});
