/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { StudioExtensionsReply, StudioExtensionsRequest } from '@aionui/web-host';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetShownOperation } from './operation';
import { useAgentExtensions, type Asks } from './useAgentExtensions';

afterEach(() => {
  resetShownOperation();
  delete window.__studioExtensions;
});

describe('flows of the screen', () => {
  it('sends only the newest of two changes asked for while the first still waited', async () => {
    const requests: StudioExtensionsRequest[] = [];
    window.__studioExtensions = {
      request: vi.fn(async (command: StudioExtensionsRequest): Promise<StudioExtensionsReply> => {
        requests.push(command);
        const data: unknown =
          command.action === 'get_settings'
            ? {
                settings: { onlineInstall: true, proxy: null, proxyAuthentication: false, privateGit: false },
                credentialMode: 'keychain',
                hasSavedCredentials: false,
                unreadable: false,
                onlineInstallLocked: false,
              }
            : command.action === 'install'
              ? { operationId: 'op-1', action: 'install', phase: 'switched' }
              : { current: 'g1', previous: null, revision: 1, extensions: [], rollbackAvailable: false };
        return { ok: true, data, transport: 'insecure' } as unknown as StudioExtensionsReply;
      }),
    };
    const answers: ((yes: boolean) => void)[] = [];
    const asks: Asks = {
      confirmInsecure: () => new Promise<boolean>((resolve) => answers.push(resolve)),
      credentials: vi.fn(async () => undefined),
      confirmUnpin: vi.fn(async () => false),
      pinned: vi.fn(async () => false),
      failure: vi.fn(),
      installByName: vi.fn(),
    };
    const { result } = renderHook(() => useAgentExtensions(asks, 'local'));
    await waitFor(() => expect(result.current.settings.data).toBeDefined());
    // Both carry a Git address with a password: secrets, asked about over this insecure channel.
    const first = { kind: 'git', url: 'https://ops:one@git.example/first.git' } as const;
    const second = { kind: 'git', url: 'https://ops:two@git.example/second.git' } as const;
    await act(async () => {
      void result.current.actions.install(first);
      await waitFor(() => expect(answers).toHaveLength(1));
      void result.current.actions.install(second);
    });
    // The user says yes to the first question: that change was replaced meanwhile.
    await act(async () => {
      answers[0](true);
      await waitFor(() => expect(answers).toHaveLength(2));
      answers[1](true);
    });
    await waitFor(() => expect(requests.filter((request) => request.action === 'install')).toHaveLength(1));
    expect(requests.filter((request) => request.action === 'install')).toEqual([
      { action: 'install', source: second, acknowledgeInsecureTransport: true },
    ]);
  });
});
