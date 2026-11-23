/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, render, waitFor } from '@testing-library/react';
import React from 'react';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

// The WebUI, where users sign in: the auth context reads this when it loads.
const desktop = vi.hoisted(() => {
  const api = (window as { electronAPI?: unknown }).electronAPI;
  delete (window as { electronAPI?: unknown }).electronAPI;
  return api;
});
vi.mock('@/common/adapter/sessionRefresh', () => ({ refreshSession: vi.fn(async () => false) }));

import { AuthProvider, onUserChange, useAuth } from '@/renderer/hooks/context/AuthContext';

type Auth = ReturnType<typeof useAuth>;

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(() => {
  (window as { electronAPI?: unknown }).electronAPI = desktop;
});

/**
 * The screen keeps a change across visits for the signed-in user and drops it when that user
 * signs out or another signs in (`onUserChange(forgetOwners)`): when the auth context tells.
 */
describe('the signed-in user, as the screen hears of it', () => {
  it('is told when the user signs out or another signs in, and only then', async () => {
    let signedIn = { id: 'alice', username: 'alice' };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/api/auth/user') return json({ success: true, user: signedIn });
        if (url === '/login') return json({ success: true, user: { id: 'bob', username: 'bob' } });
        return json({ success: true });
      })
    );
    const changed = vi.fn();
    const stop = onUserChange(changed);
    let auth: Auth | undefined;
    const Probe: React.FC = () => {
      auth = useAuth();
      return null;
    };
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>
    );
    await waitFor(() => expect(auth?.user?.id).toBe('alice'));
    // The first user to sign in replaces nobody.
    expect(changed).not.toHaveBeenCalled();

    await act(async () => {
      await auth?.refresh();
    });
    expect(changed).not.toHaveBeenCalled();

    await act(async () => {
      await auth?.login({ username: 'bob', password: 'x' });
    });
    expect(auth?.user?.id).toBe('bob');
    expect(changed).toHaveBeenCalledTimes(1);

    await act(async () => {
      await auth?.logout();
    });
    expect(changed).toHaveBeenCalledTimes(2);

    // Another user found by a later check (signed in elsewhere in this browser).
    signedIn = { id: 'carol', username: 'carol' };
    await act(async () => {
      await auth?.refresh();
    });
    expect(changed).toHaveBeenCalledTimes(2);
    signedIn = { id: 'dave', username: 'dave' };
    await act(async () => {
      await auth?.refresh();
    });
    expect(changed).toHaveBeenCalledTimes(3);
    stop();
  });
});
