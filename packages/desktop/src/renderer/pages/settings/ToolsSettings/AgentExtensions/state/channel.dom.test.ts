/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { StudioExtensionsReply, StudioExtensionsRequest } from '@aionui/web-host';
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useExtensionsChannel } from './channel';
import { createFlow, type Flow } from './flow';

const secret = {
  action: 'set_proxy_credentials',
  credentials: { username: 'ops', password: 'sentinel-secret' },
} as const;

/** A flow that may go on while `still()` says so. */
const flowWhile = (still: () => boolean = () => true): Flow =>
  createFlow({ owner: 'local', epoch: 0 }, { valid: still, current: still });
const open = flowWhile();

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
      await result.current.send({ action: 'get_settings' }, open);
    });
    // The last reply said secure; the channel has since become insecure.
    transport = 'insecure';
    request.mockClear();
    let reply: unknown;
    await act(async () => {
      reply = await result.current.send(secret, open);
    });
    expect(reply).toBe('declined');
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(commands(request)).toEqual([{ action: 'get_settings' }]);
  });

  it('takes a check without transport as insecure', async () => {
    const request = channel(undefined);
    const confirm = vi.fn(async () => true);
    const { result } = renderHook(() => useExtensionsChannel(confirm));
    await act(async () => {
      await result.current.send(secret, open);
    });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenLastCalledWith({ ...secret, acknowledgeInsecureTransport: true });
  });

  it('asks about every secret over an insecure channel: no yes is kept for the next one', async () => {
    let transport: 'secure' | 'insecure' = 'insecure';
    let confirmed: (() => void) | undefined;
    const request = vi.fn(
      async (): Promise<StudioExtensionsReply> =>
        ({ ok: true, data: { settings: {} }, transport }) as unknown as StudioExtensionsReply
    );
    window.__studioExtensions = { request };
    const confirm = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          confirmed = () => resolve(true);
        })
    );
    const { result } = renderHook(() => useExtensionsChannel(confirm));
    await act(async () => {
      const first = result.current.send(secret, open);
      await vi.waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
      // A secure answer while the question is open gives nothing to keep either.
      transport = 'secure';
      await result.current.send({ action: 'list' }, open);
      transport = 'insecure';
      confirmed?.();
      await first;
      const second = result.current.send(secret, open);
      await vi.waitFor(() => expect(confirm).toHaveBeenCalledTimes(2));
      confirmed?.();
      await second;
    });
    expect(commands(request).filter((command) => command.action === 'set_proxy_credentials')).toEqual([
      { ...secret, acknowledgeInsecureTransport: true },
      { ...secret, acknowledgeInsecureTransport: true },
    ]);
  });

  it('sends a secret on a secure channel without asking or flagging it', async () => {
    const request = channel('secure');
    const confirm = vi.fn(async () => true);
    const { result } = renderHook(() => useExtensionsChannel(confirm));
    await act(async () => {
      await result.current.send(secret, open);
    });
    expect(confirm).not.toHaveBeenCalled();
    expect(request).toHaveBeenLastCalledWith(secret);
  });

  it('checks the channel again, and asks, before sending again after INSECURE_TRANSPORT', async () => {
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
      reply = await result.current.send(secret, open);
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

  it('asks again before sending again when a confirmed secret is still refused, and sends nothing on no', async () => {
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
      reply = await result.current.send(secret, open);
    });
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(reply).toBe('declined');
    expect(commands(request)).toEqual([
      { action: 'get_settings' },
      { ...secret, acknowledgeInsecureTransport: true },
      { action: 'get_settings' },
    ]);
  });

  it('holds a second secret until the first one’s question is answered, then asks about it on its own', async () => {
    const request = channel('insecure');
    const answers: ((yes: boolean) => void)[] = [];
    const confirm = vi.fn(() => new Promise<boolean>((resolve) => answers.push(resolve)));
    const { result } = renderHook(() => useExtensionsChannel(confirm));
    const other = { ...secret, credentials: { username: 'ops', password: 'other' } };
    let first: Promise<unknown> | undefined;
    let second: Promise<unknown> | undefined;
    await act(async () => {
      first = result.current.send(secret, open);
      await vi.waitFor(() => expect(answers).toHaveLength(1));
      second = result.current.send(other, open);
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    // The second has not even been checked while the first question is open.
    expect(commands(request)).toEqual([{ action: 'get_settings' }]);
    await act(async () => {
      answers[0](false);
      expect(await first).toBe('declined');
      await vi.waitFor(() => expect(answers).toHaveLength(2));
      answers[1](true);
      await second;
    });
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(commands(request)).toEqual([
      { action: 'get_settings' },
      { action: 'get_settings' },
      { ...other, acknowledgeInsecureTransport: true },
    ]);
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
      const listing = result.current.send({ action: 'list' }, open);
      const sending = result.current.send(secret, open);
      await vi.waitFor(() => expect(releaseCheck).toBeDefined());
      releaseCheck?.();
      await Promise.all([listing, sending]);
    });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(commands(request).at(-1)).toEqual({ ...secret, acknowledgeInsecureTransport: true });
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
      'a Git URL written oddly',
      { action: 'install', source: { kind: 'git', url: 'https:///u:tok@git.example/x.git' } },
    ],
    ['an SSH Git address', { action: 'install', source: { kind: 'git', url: 'git@git.example:org/x.git' } }],
    [
      'an index URL with a password',
      { action: 'install', source: { kind: 'index', name: 'x', indexUrl: 'https://u:p@pypi.corp/simple' } },
    ],
    [
      'an index URL written oddly',
      { action: 'install', source: { kind: 'index', name: 'x', indexUrl: 'https:\\\\u:p@pypi.corp' } },
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
      reply = await result.current.send(command as StudioExtensionsRequest, open);
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
      await result.current.send(plain as unknown as StudioExtensionsRequest, open);
    });
    expect(confirm).not.toHaveBeenCalled();
    expect(commands(request)).toEqual([plain]);
  });

  it.each(['secure', 'insecure'] as const)(
    'sends no secret, and asks nothing, once its flow ended while the channel was being checked (%s)',
    async (transport) => {
      let answer: (() => void) | undefined;
      const request = vi.fn(async (command: StudioExtensionsRequest): Promise<StudioExtensionsReply> => {
        if (command.action === 'get_settings') await new Promise<void>((resolve) => (answer = resolve));
        return { ok: true, data: { settings: {} }, transport } as unknown as StudioExtensionsReply;
      });
      window.__studioExtensions = { request };
      const confirm = vi.fn(async () => true);
      const { result } = renderHook(() => useExtensionsChannel(confirm));
      let going = true;
      const sending = result.current.send(
        secret,
        flowWhile(() => going)
      );
      await vi.waitFor(() => expect(answer).toBeDefined());
      // The screen was left, the user signed out, or a newer change was asked for.
      going = false;
      answer?.();
      expect(await sending).toBe('declined');
      expect(confirm).not.toHaveBeenCalled();
      expect(commands(request)).toEqual([{ action: 'get_settings' }]);
    }
  );

  it('sends no secret once its flow ended while the user was being asked', async () => {
    const request = channel('insecure');
    let decide: ((yes: boolean) => void) | undefined;
    const confirm = vi.fn(() => new Promise<boolean>((resolve) => (decide = resolve)));
    const { result } = renderHook(() => useExtensionsChannel(confirm));
    let going = true;
    const sending = result.current.send(
      secret,
      flowWhile(() => going)
    );
    await vi.waitFor(() => expect(decide).toBeDefined());
    going = false;
    decide?.(true);
    expect(await sending).toBe('declined');
    expect(commands(request)).toEqual([{ action: 'get_settings' }]);
  });

  it('sends nothing for a flow that already ended', async () => {
    const request = channel('secure');
    const { result } = renderHook(() => useExtensionsChannel(vi.fn(async () => true)));
    const ended = flowWhile(() => false);
    await act(async () => {
      expect(await result.current.send(secret, ended)).toBe('declined');
      expect(await result.current.send({ action: 'remove', name: 'x' }, ended)).toBe('declined');
    });
    expect(request).not.toHaveBeenCalled();
  });

  it('checks its flow once more right before the secret leaves, with nothing awaited in between', async () => {
    // The flow ends right after the check passed: the step after the check is the last yes.
    let checked = false;
    let cut = false;
    const request = vi.fn(async (command: StudioExtensionsRequest): Promise<StudioExtensionsReply> => {
      if (command.action === 'get_settings') checked = true;
      return { ok: true, data: { settings: {} }, transport: 'secure' } as unknown as StudioExtensionsReply;
    });
    window.__studioExtensions = { request };
    const { result } = renderHook(() => useExtensionsChannel(vi.fn(async () => true)));
    // Only sending asks `valid`; the banner asks `current`, which stays true here.
    const flow = createFlow(
      { owner: 'local', epoch: 0 },
      {
        valid: () => {
          if (cut) return false;
          if (checked) cut = true;
          return true;
        },
        current: () => true,
      }
    );
    let reply: unknown;
    await act(async () => {
      reply = await result.current.send(secret, flow);
    });
    expect(reply).toBe('declined');
    expect(commands(request)).toEqual([{ action: 'get_settings' }]);
  });

  it('checks its flow right before checking again after INSECURE_TRANSPORT', async () => {
    let cut = false;
    const request = vi.fn(async (command: StudioExtensionsRequest): Promise<StudioExtensionsReply> => {
      const flagged = (command as { acknowledgeInsecureTransport?: boolean }).acknowledgeInsecureTransport;
      if (command.action !== 'get_settings' && !flagged) {
        // The flow ends with the refusal.
        cut = true;
        return { ok: false, code: 'INSECURE_TRANSPORT', transport: 'insecure' } as unknown as StudioExtensionsReply;
      }
      return { ok: true, data: { settings: {} }, transport: 'secure' } as unknown as StudioExtensionsReply;
    });
    window.__studioExtensions = { request };
    const { result } = renderHook(() => useExtensionsChannel(vi.fn(async () => true)));
    let reply: unknown;
    await act(async () => {
      reply = await result.current.send(
        secret,
        flowWhile(() => !cut)
      );
    });
    expect(reply).toBe('declined');
    expect(commands(request)).toEqual([{ action: 'get_settings' }, secret]);
  });
});
