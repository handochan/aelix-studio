/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Regression tests for the Tools and Skills settings pages after adding the native Aelix
 * defaults: the Aion MCP list and skill library (including #32 extension-provided rows) keep
 * their own data source, and native defaults never write through the Aion catalog.
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const fake = vi.hoisted(() => ({
  relay: vi.fn<(path: string, body?: string) => Promise<unknown>>(),
  helper: vi.fn<(command: { action: string; kind?: string }) => Promise<unknown>>(),
  mcpItems: [] as { name: string; readOnly: boolean }[],
  saveMcpServers: vi.fn(),
  mcpToggle: vi.fn(),
  mcpUpdate: vi.fn(),
  fs: {
    listAvailableSkills: vi.fn(),
    listSkillImportHistory: vi.fn(),
    getSkillImportLimits: vi.fn(),
    importSkills: vi.fn(),
    deleteSkill: vi.fn(),
  },
}));

vi.mock('react-i18next', () => {
  // A stable translator, as in the app, so pages that depend on `t` do not refetch per render.
  const translation = {
    t: (key: string, values?: Record<string, unknown>) =>
      values && !('defaultValue' in values) ? `${key}(${Object.values(values).map(String).join('|')})` : key,
    i18n: { language: 'en' },
  };
  return { useTranslation: () => translation };
});

vi.mock('@/renderer/services/runtime/RunningInput/transport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/renderer/services/runtime/RunningInput/transport')>();
  return { ...actual, requestRelay: fake.relay };
});

vi.mock('@/common', () => ({
  ipcBridge: {
    conversation: {
      get: { invoke: vi.fn().mockResolvedValue({ id: 'c-17', extra: { workspace: '/work/demo' } }) },
    },
    fs: Object.fromEntries(Object.entries(fake.fs).map(([name, invoke]) => [name, { invoke }])),
    dialog: { showOpen: { invoke: vi.fn() } },
    assistants: { list: { invoke: vi.fn().mockResolvedValue([]) } },
  },
}));

vi.mock('@/common/adapter/ipcBridge', () => ({
  mcpService: { toggleServer: { invoke: fake.mcpToggle }, updateServer: { invoke: fake.mcpUpdate } },
}));

vi.mock('@/renderer/pages/settings/components/SettingsPageWrapper', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/renderer/components/base/AionScrollArea', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/renderer/components/base/AionSelect', () => {
  const Select = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  return { default: Object.assign(Select, { OptGroup: Select, Option: Select }) };
});
vi.mock('@/renderer/components/base/TalkToButlerButton', () => ({
  default: () => <div>TalkToButlerButton</div>,
}));
vi.mock('@/renderer/pages/settings/components/AddMcpServerModal', () => ({ default: () => null }));
vi.mock('@/renderer/pages/settings/ToolsSettings/McpServerItem', () => ({
  default: ({ server, isReadOnly }: { server: { name: string }; isReadOnly?: boolean }) => (
    <div data-testid={`aion-mcp-${server.name}`}>{isReadOnly ? 'read-only' : 'editable'}</div>
  ),
}));
vi.mock('@/renderer/hooks/agent/useConfigModelListWithImage', () => ({ default: () => ({ modelListWithImage: [] }) }));
vi.mock('@/renderer/hooks/mcp', () => ({
  useMcpServers: () => ({
    mcpServers: [{ id: 'aion-1', name: 'aion-docs', enabled: true, transport: { type: 'stdio', command: 'x' } }],
    extensionMcpServers: [
      { id: 'ext-1', name: 'ext-search', enabled: true, transport: { type: 'stdio', command: 'y' } },
    ],
    saveMcpServers: fake.saveMcpServers,
    setMcpServers: vi.fn(),
    isMcpServersLoading: false,
  }),
  useMcpConnection: () => ({ testingServers: {}, handleTestMcpConnection: vi.fn(), handleTestMcpConnections: vi.fn() }),
  useMcpModal: () => ({
    showMcpModal: false,
    editingMcpServer: undefined,
    deleteConfirmVisible: false,
    serverToDelete: undefined,
    mcpCollapseKey: {},
    showAddMcpModal: vi.fn(),
    showEditMcpModal: vi.fn(),
    hideMcpModal: vi.fn(),
    showDeleteConfirm: vi.fn(),
    hideDeleteConfirm: vi.fn(),
    toggleServerCollapse: vi.fn(),
  }),
  useMcpServerCRUD: () => ({
    handleAddMcpServer: vi.fn(),
    handleBatchImportMcpServers: vi.fn(),
    handleEditMcpServer: vi.fn(),
    handleDeleteMcpServer: vi.fn(),
  }),
  useMcpOAuth: () => ({
    oauthStatus: {},
    loggingIn: {},
    checkOAuthStatus: vi.fn(),
    markLoginRequired: vi.fn(),
    clearLoginRequired: vi.fn(),
    login: vi.fn(),
  }),
  useMountedMessage: (message: unknown) => message,
}));
vi.mock('@/renderer/services/clientBusinessSettings', () => ({
  getClientBusinessSetting: vi.fn(() => Promise.resolve(undefined)),
  setClientBusinessSetting: vi.fn(() => Promise.resolve()),
  removeClientBusinessSetting: vi.fn(() => Promise.resolve()),
}));

import ToolsSettings from '@/renderer/pages/settings/ToolsSettings';
import SkillsHubSettings from '@/renderer/pages/settings/SkillsSettings/SkillsHubSettings';
import { clearRecovery } from '@/renderer/pages/settings/ToolsSettings/AelixNative';

const SCOPES = {
  global: { writable: false, reason: 'management-helper', exists: true },
  project: { writable: true, reason: null, exists: true },
};

function sessionList(kind: string, key: string) {
  return {
    kind,
    effect: kind === 'mcp' ? 'restart' : 'next_request',
    scopes: SCOPES,
    items: [
      {
        key,
        label: key,
        role: 'item',
        loaded: true,
        saved: true,
        decidedBy: 'project',
        applied: true,
        inForce: true,
        live: true,
        pending: false,
        lock: null,
        problem: null,
      },
    ],
    policyPending: false,
    diagnostics: [],
    toolOverride: null,
    activeTools: kind === 'tool' ? [key] : null,
    nextCursor: null,
  };
}

beforeEach(() => {
  clearRecovery();
  fake.relay.mockReset().mockImplementation(async (_path, body) => {
    if (body === undefined) {
      return {
        kind: 'success',
        data: {
          version: 1,
          bindingId: 'b-21',
          requests: ['_aelix/session/selections/list', '_aelix/session/selections/set'],
          notifications: [],
        },
      };
    }
    const { method, payload } = JSON.parse(body) as { method: string; payload: { kind: string } };
    const key = payload.kind === 'skill' ? 'review' : payload.kind === 'mcp' ? 'local-docs' : 'read';
    if (method === '_aelix/session/selections/list')
      return { kind: 'success', data: { result: sessionList(payload.kind, key) } };
    return {
      kind: 'success',
      data: {
        result: {
          accepted: true,
          scope: 'project',
          kind: payload.kind,
          effect: payload.kind === 'mcp' ? 'restart' : 'next_request',
          written: ['.aelix/settings.json'],
          changed: [{ key, saved: false }],
          mismatches: [],
          apply:
            payload.kind === 'mcp'
              ? null
              : { applied: true, deferred: false, turnedOn: [], turnedOff: [key], warning: null },
        },
      },
    };
  });
  fake.helper.mockReset().mockResolvedValue({ ok: false, code: 'HELPER_UNAVAILABLE' });
  window.__studioNativeResources = { request: (command) => fake.helper(command as { action: string }) };
  for (const mock of Object.values(fake.fs)) mock.mockReset();
  fake.fs.listAvailableSkills.mockResolvedValue([
    {
      name: 'my-skill',
      description: 'Mine',
      location: '/u/my-skill',
      is_auto_inject: false,
      is_custom: true,
      source: 'custom',
    },
    {
      name: 'ext-skill',
      description: 'From extension',
      location: '/e/ext',
      is_auto_inject: false,
      is_custom: false,
      source: 'extension',
    },
  ]);
  fake.fs.listSkillImportHistory.mockResolvedValue([]);
  fake.fs.getSkillImportLimits.mockResolvedValue({ max_file_bytes: 1, max_total_bytes: 1 });
  fake.saveMcpServers.mockReset();
  fake.mcpToggle.mockReset();
  fake.mcpUpdate.mockReset();
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

afterEach(() => {
  cleanup();
  delete window.__studioNativeResources;
});

const renderAt = (path: string, element: React.ReactElement, route: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path={route} element={element} />
      </Routes>
    </MemoryRouter>
  );

describe('Tools and Skills settings with native Aelix defaults', () => {
  it('keeps the Aion MCP list (with #32 extension rows) separate from project defaults opened from a conversation', async () => {
    renderAt('/settings/tools?conversation=c-17', <ToolsSettings />, '/settings/tools');

    expect(screen.getByTestId('aion-mcp-aion-docs')).toHaveTextContent('editable');
    expect(screen.getByTestId('aion-mcp-ext-search')).toHaveTextContent('read-only');
    const panel = screen.getByTestId('aelix-defaults-panel');
    expect(within(panel).queryByTestId('aion-mcp-aion-docs')).not.toBeInTheDocument();
    expect(await within(panel).findByTestId('aelix-workspace')).toHaveTextContent('/work/demo');

    fireEvent.click(await within(panel).findByRole('switch'));
    fireEvent.click(within(panel).getByTestId('aelix-save'));
    expect(await within(panel).findByTestId('aelix-save-notice')).toHaveTextContent(
      'settings.aelixNative.saved.applied'
    );

    // The native save went through the conversation relay only, never the Aion MCP catalog.
    expect(fake.relay.mock.calls.some(([, body]) => body?.includes('selections/set'))).toBe(true);
    expect(fake.saveMcpServers).not.toHaveBeenCalled();
    expect(fake.mcpToggle).not.toHaveBeenCalled();
    expect(fake.mcpUpdate).not.toHaveBeenCalled();
    expect(fake.helper).not.toHaveBeenCalled();
  });

  it('keeps the Aion skill tabs and adds native defaults as a separate tab', async () => {
    renderAt('/settings/skills', <SkillsHubSettings />, '/settings/skills');

    expect(await screen.findByTestId('my-skill-card-my-skill')).toBeInTheDocument();
    expect(screen.queryByTestId('aelix-defaults-panel')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('settings-tab-official'));
    expect(await screen.findByText('ext-skill')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('settings-tab-aelix'));
    const panel = await screen.findByTestId('aelix-defaults-panel');
    // Without a conversation only the global scope exists.
    expect(within(panel).queryByTestId('aelix-scope')).not.toBeInTheDocument();
    expect(await within(panel).findByTestId('aelix-list-failure')).toBeInTheDocument();
    expect(fake.helper).toHaveBeenCalledWith({ action: 'selections/list', scope: 'global', kind: 'skill' });
    expect(fake.fs.listAvailableSkills).toHaveBeenCalledTimes(1);
  });

  it('opens the native skill defaults on "This project" from a conversation link without touching the Aion library', async () => {
    renderAt('/settings/skills?conversation=c-17', <SkillsHubSettings />, '/settings/skills');

    const panel = await screen.findByTestId('aelix-defaults-panel');
    expect(await within(panel).findByTestId('aelix-workspace')).toHaveTextContent('/work/demo');
    expect(within(panel).getByTestId('aelix-project-impact')).toHaveTextContent(
      'settings.aelixNative.noConversationOverride'
    );
    fireEvent.click(await within(panel).findByRole('switch'));
    fireEvent.click(within(panel).getByTestId('aelix-save'));
    await within(panel).findByTestId('aelix-save-notice');

    await waitFor(() => expect(fake.fs.listAvailableSkills).toHaveBeenCalled());
    expect(fake.fs.importSkills).not.toHaveBeenCalled();
    expect(fake.fs.deleteSkill).not.toHaveBeenCalled();
  });
});
