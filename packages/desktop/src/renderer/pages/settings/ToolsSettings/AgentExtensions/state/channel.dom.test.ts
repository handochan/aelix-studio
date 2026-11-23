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

/** The desktop channel answering every request with `transport` (or none). */
function channel(transport: 'secure' | 'insecure' | undefined, refuse?: string) {
  const request = vi.fn(async (command: StudioExtensionsRequest): Promise<StudioExtensionsReply> => {
    const flagged = (command as { acknowledgeInsecureTransport?: boolean }).acknowledgeInsecureTransport;
    const body =
      refuse && !flagged ? { ok: false as const, code: refuse } : { ok: true as const, data: { settings: {} } };
    return { ...body, ...(transport ? { transport } : {}) } as StudioExtensionsReply;
  });
  window.__studioExtensions = { request };
  return request;
}

afterEach(() => {
  delete window.__studioExtensions;
});

describe('the screen channel', () => {
  it('counts the time before the first reply as insecure: a first secret is asked about', async () => {
    const request = channel('secure');
    const confirm = vi.fn(async () => false);
    const { result } = renderHook(() => useExtensionsChannel(confirm));
    let reply: unknown;
    await act(async () => {
      reply = await result.current.send(secret, { secret: true });
    });
    expect(reply).toBe('declined');
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(request).not.toHaveBeenCalled();
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
    expect(request.mock.calls.map(([command]) => command)).toEqual([
      secret,
      { ...secret, acknowledgeInsecureTransport: true },
    ]);
    expect(reply).toMatchObject({ ok: true });
  });
});
