/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * DOM tests for the read-only Aelix profile list shown under the builtin Aelix agent card.
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';

const helper = vi.hoisted(() => vi.fn<(command: { action: string; name?: string }) => Promise<unknown>>());

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values ? `${key}(${Object.values(values).map(String).join('|')})` : key,
  }),
}));

vi.mock('@/common', () => ({ ipcBridge: { conversation: { get: { invoke: vi.fn() } } } }));

const userChange = vi.hoisted(() => new Set<() => void>());
vi.mock('@/renderer/hooks/context/AuthContext', () => ({
  onUserChange: (handler: () => void) => {
    userChange.add(handler);
    return () => userChange.delete(handler);
  },
}));

import { AelixProfiles } from '@/renderer/pages/settings/ToolsSettings/AelixNative';

const QUIET = {
  name: 'quiet',
  scope: 'user',
  revision: 'sha256:1db1f5963ef9139b31457b3d0d9ca7cf56ccda47688c029724745b86195f0c2a',
};
const WRITER = {
  name: 'writer',
  scope: 'bundled',
  revision: 'sha256:87ea6ee724da21b23c6523cee102159d26bcb75958919731d5596d32bfe669f7',
};

const preview = (ref: typeof QUIET) => ({
  ok: true,
  data: {
    profile: {
      ref,
      source: `${ref.scope}:agents/${ref.name}.md`,
      description: 'Review only',
      promptMode: 'append',
      promptPreview: 'Review only.',
      promptTruncated: false,
      provider: null,
      model: null,
      tools: [],
      skills: null,
      approvalMode: 'inherit',
      policy: {
        builtinTools: true,
        excludeTools: [],
        inheritSkills: true,
        extensions: [],
        inheritExtensions: false,
        contextFiles: true,
        thinking: null,
        role: 'leaf',
        outputCap: 51200,
        timeoutMs: null,
        agents: null,
      },
    },
  },
});

let showReply: unknown;

beforeEach(() => {
  showReply = preview(QUIET);
  helper.mockReset().mockImplementation(async (command) => {
    if (command.action === 'profiles/list') {
      return {
        ok: true,
        data: {
          profiles: [
            { ref: QUIET, description: 'Review only' },
            { ref: WRITER, description: 'Write notes' },
          ],
          diagnostics: [{ code: 'invalid-profile', key: null, source: 'user:agents/broken.md' }],
          nextCursor: null,
        },
      };
    }
    if (command.action === 'profiles/show') return showReply;
    throw new Error('unexpected helper action');
  });
  window.__studioNativeResources = { request: (command) => helper(command as { action: string }) };
});

afterEach(() => {
  cleanup();
  delete window.__studioNativeResources;
});

describe('Aelix profiles on the builtin Aelix card', () => {
  it('stays collapsed without reading the helper until the user opens it', async () => {
    render(<AelixProfiles />);
    expect(screen.getByTestId('aelix-profiles')).toBeInTheDocument();
    expect(helper).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('aelix-profiles-toggle'));
    expect(await screen.findByTestId('aelix-profile-quiet')).toHaveTextContent(
      'settings.aelixNative.profiles.scope.user'
    );
    expect(screen.getByTestId('aelix-profile-writer')).toHaveTextContent('settings.aelixNative.profiles.scope.bundled');
    expect(screen.getByTestId('aelix-profiles-diagnostics')).toHaveTextContent(
      'settings.aelixNative.diagnostics.invalidProfile · user:agents/broken.md'
    );
    expect(helper).toHaveBeenCalledWith({ action: 'profiles/list' });
  });

  it('previews the resolved profile from a deep link without offering edits', async () => {
    render(<AelixProfiles defaultExpanded focusProfile='quiet' />);

    const detail = await screen.findByTestId('aelix-profile-preview-quiet');
    expect(detail).toHaveTextContent('user:agents/quiet.md');
    expect(detail).toHaveTextContent('Review only.');
    // An empty tool list is shown as "none", an absent skill list as inherited.
    expect(detail).toHaveTextContent('settings.aelixNative.profiles.none');
    expect(detail).toHaveTextContent('settings.aelixNative.profiles.inherit');
    expect(helper).toHaveBeenCalledWith({ action: 'profiles/show', name: 'quiet' });
    expect(within(screen.getByTestId('aelix-profiles')).queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('reports a profile that changed since the list was read instead of showing the new file', async () => {
    showReply = preview({
      ...QUIET,
      revision: 'sha256:ddb033f0cfc401c0b8f636362dca06c135657ecdb9f5afbbed93d7d351694da0',
    });
    render(<AelixProfiles defaultExpanded />);

    const row = await screen.findByTestId('aelix-profile-quiet');
    fireEvent.click(within(row).getByText('settings.aelixNative.profiles.preview'));

    expect(await within(row).findByText('settings.aelixNative.profiles.changed')).toBeInTheDocument();
    expect(screen.queryByTestId('aelix-profile-preview-quiet')).not.toBeInTheDocument();
  });

  it('tells the user when global profile discovery is unavailable', async () => {
    delete window.__studioNativeResources;
    window.__backendPort = 1;
    try {
      render(<AelixProfiles defaultExpanded />);
      expect(await screen.findByTestId('aelix-profiles-failure')).toHaveTextContent(
        'settings.aelixNative.failure.unsupported'
      );
    } finally {
      delete window.__backendPort;
    }
  });
  it('keeps only the latest preview when replies arrive out of order', async () => {
    let releaseQuiet: (value: unknown) => void = () => {};
    helper.mockImplementation(async (command) => {
      if (command.action === 'profiles/list') {
        return {
          ok: true,
          data: {
            profiles: [
              { ref: QUIET, description: 'Review only' },
              { ref: WRITER, description: 'Write notes' },
            ],
            diagnostics: [],
            nextCursor: null,
          },
        };
      }
      if (command.name === 'quiet') return new Promise((resolve) => (releaseQuiet = resolve));
      return preview(WRITER);
    });
    render(<AelixProfiles defaultExpanded />);

    fireEvent.click(await screen.findByRole('button', { name: 'settings.aelixNative.profiles.previewNamed(quiet)' }));
    fireEvent.click(screen.getByRole('button', { name: 'settings.aelixNative.profiles.previewNamed(writer)' }));
    expect(await screen.findByTestId('aelix-profile-preview-writer')).toHaveTextContent(
      'settings.aelixNative.profiles.promptModes.append'
    );
    await act(async () => releaseQuiet(preview(QUIET)));

    expect(screen.queryByTestId('aelix-profile-preview-quiet')).not.toBeInTheDocument();
    expect(screen.getByTestId('aelix-profile-preview-writer')).toBeInTheDocument();
    expect(screen.getByTestId('aelix-profiles-toggle')).toHaveAttribute('aria-expanded', 'true');
  });
  it("clears the previous user's profiles and preview as soon as the user changes", async () => {
    render(<AelixProfiles defaultExpanded focusProfile='quiet' />);
    await screen.findByTestId('aelix-profile-preview-quiet');

    // The new user's list is still loading, so nothing from the previous user may remain.
    helper.mockImplementation(() => new Promise(() => {}));
    act(() => userChange.forEach((handler) => handler()));

    expect(screen.queryByTestId('aelix-profile-quiet')).not.toBeInTheDocument();
    expect(screen.queryByTestId('aelix-profile-preview-quiet')).not.toBeInTheDocument();
    expect(screen.queryByTestId('aelix-profiles-diagnostics')).not.toBeInTheDocument();
  });
});
