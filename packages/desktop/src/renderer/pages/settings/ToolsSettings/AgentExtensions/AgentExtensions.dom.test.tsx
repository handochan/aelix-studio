/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  ExtensionEntry,
  ExtensionListing,
  ExtensionOperation,
  ExtensionSettingsState,
  StudioExtensionsReply,
  StudioExtensionsRequest,
  TerminalCliListing,
} from '@aionui/web-host';
import { Message } from '@arco-design/web-react';
import { cleanup, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const bridge = vi.hoisted(() => ({
  platform: 'darwin',
  /** Replaces the platform answer (one that never comes, or fails). */
  systemInfo: undefined as Promise<{ platform: string }> | undefined,
  picked: ['/host/wheels/demo-2.0-py3-none-any.whl'] as string[] | undefined,
  opened: [] as unknown[],
}));

/** The signed-in user (WebUI), and what is told when they sign out or change. */
const auth = vi.hoisted(() => ({
  user: null as { id: string; username: string } | null,
  onChange: [] as (() => void)[],
}));
vi.mock('@/renderer/hooks/context/AuthContext', () => ({
  useAuth: () => ({ user: auth.user }),
  onUserChange: (handler: () => void) => {
    auth.onChange.push(handler);
    return () => {};
  },
}));
/** Another user signs in on the same tab: what kept state for the last one is told. */
const switchUser = (id: string | null): void => {
  auth.user = id === null ? null : { id, username: id };
  for (const handler of auth.onChange) handler();
};

vi.mock('@/common', () => ({
  ipcBridge: {
    application: {
      systemInfo: { invoke: () => bridge.systemInfo ?? Promise.resolve({ platform: bridge.platform }) },
    },
    dialog: {
      showOpen: {
        invoke: (options: unknown) => {
          bridge.opened.push(options);
          return Promise.resolve(bridge.picked);
        },
      },
    },
  },
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => (options ? `${key} ${JSON.stringify(options)}` : key),
  }),
}));
vi.mock('../../components/SettingsPageWrapper', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import AgentExtensionsSettings from './index';

// The screen answers through several async steps (and dialog animations): room for a loaded
// runner. Tests with many steps get `LONG`; the rest keep the configured budget (longer on CI).
configure({ asyncUtilTimeout: 8000 });
const LONG = process.env.CI ? 60_000 : 30_000;
import { resetShownOperation } from './state/operation';

const entry = (name: string, extra: Partial<ExtensionEntry> = {}): ExtensionEntry => ({
  name,
  distribution: name,
  version: '1.0.0',
  reference: `${name.replaceAll('-', '_')}:setup`,
  origin: { kind: 'index', indexUrl: 'https://pypi.org/simple' },
  status: 'ready',
  ...extra,
});

type Host = {
  transport: 'secure' | 'insecure';
  settings: ExtensionSettingsState;
  listing: ExtensionListing | { code: string; detail?: string[] };
  terminal: TerminalCliListing;
  /** Replies for a change, in order; each an operation's phases or an immediate refusal code. */
  changes: Array<string[] | { code: string }>;
  requests: StudioExtensionsRequest[];
  /** A refusal code for `set_settings`. */
  settingsRefusal?: string;
  /** Held before a change is answered, until resolved. */
  gate?: Promise<void>;
};

let host: Host;

const settingsState = (overrides: Partial<ExtensionSettingsState['settings']> = {}): ExtensionSettingsState => ({
  settings: { onlineInstall: true, proxy: null, proxyAuthentication: false, privateGit: false, ...overrides },
  credentialMode: 'keychain',
  hasSavedCredentials: false,
  unreadable: false,
  onlineInstallLocked: false,
});

/** A fake helper behind the desktop channel: answers every request, polls walk the phases given. */
function fakeHelper(): void {
  const operations = new Map<string, { phases: string[]; at: number; action: ExtensionOperation['action'] }>();
  let next = 0;
  const reply = (body: { ok: boolean } & Record<string, unknown>): StudioExtensionsReply =>
    ({ ...body, transport: host.transport }) as unknown as StudioExtensionsReply;
  const operation = (id: string): ExtensionOperation => {
    const state = operations.get(id)!;
    const phase = state.phases[Math.min(state.at, state.phases.length - 1)];
    const [name, code] = phase.split(':');
    return {
      operationId: id,
      action: state.action,
      phase: name as ExtensionOperation['phase'],
      ...(code ? { code: code as ExtensionOperation['code'] } : {}),
    };
  };
  window.__studioExtensions = {
    request: vi.fn(async (command: StudioExtensionsRequest) => {
      host.requests.push(command);
      const action = command.action as string;
      if (action === 'get_settings') return reply({ ok: true, data: host.settings });
      if (action === 'list')
        return 'code' in host.listing
          ? reply({
              ok: false,
              code: host.listing.code,
              ...(host.listing.detail ? { detail: host.listing.detail } : {}),
            })
          : reply({ ok: true, data: host.listing });
      if (action === 'list_terminal') return reply({ ok: true, data: host.terminal });
      if (action === 'set_settings' && host.settingsRefusal) return reply({ ok: false, code: host.settingsRefusal });
      if (action === 'set_settings' || action === 'set_proxy_credentials' || action === 'clear_proxy_credentials')
        return reply({ ok: true, data: host.settings });
      if (action === 'cancel' && 'operationId' in command) {
        const state = operations.get(command.operationId)!;
        Object.assign(state, { phases: ['cancelled'], at: 0 });
        return reply({ ok: true, data: operation(command.operationId) });
      }
      if (action === 'poll' && 'operationId' in command) {
        const state = operations.get(command.operationId)!;
        state.at += 1;
        return reply({ ok: true, data: operation(command.operationId) });
      }
      if (action === 'set_default' && 'extensionId' in command) {
        const listing = host.listing as ExtensionListing;
        listing.extensions = listing.extensions.map((item) =>
          item.managedId === command.extensionId ? { ...item, defaultEnabled: command.enabled } : item
        );
        return reply({ ok: true, data: listing });
      }
      if (action === 'rollback' || action === 'reconcile_bundle')
        return reply({ ok: true, data: { current: 'g2', previous: null, revision: 2 } });
      if (host.gate) await host.gate;
      const change = host.changes.shift() ?? ['checking', 'switched'];
      if (!Array.isArray(change)) return reply({ ok: false, code: change.code });
      const id = `op-${(next += 1)}`;
      operations.set(id, { phases: change, at: 0, action: action as ExtensionOperation['action'] });
      return reply({ ok: true, data: operation(id) });
    }),
  };
}

const terminalListing = (overrides: Partial<TerminalCliListing> = {}): TerminalCliListing => ({
  environments: [
    {
      status: 'listed',
      location: '~/.local/share/uv/tools/aelix',
      foundBy: ['uv_tool', 'launcher'],
      launchers: ['~/.local/bin/aelix'],
      nativeVersion: '0.1.0b2',
      extensions: [{ name: 'memory', distribution: 'aelix-memory', version: '0.4.0', reference: 'aelix_memory:setup' }],
      issues: [],
      truncated: false,
    },
  ],
  globalExtensions: { location: '~/.aelix/agent/extensions', status: 'absent', extensions: [], truncated: false },
  searched: ['~/.local/share/uv/tools', '~/.local/bin'],
  truncated: false,
  timedOut: false,
  ...overrides,
});

const actionsOf = () => host.requests.map((request) => request.action as string);

/** Unfold the terminal section, folded under its summary line. */
const unfoldTerminal = async (): Promise<void> => {
  fireEvent.click(await screen.findByText(/settings\.agentExtensions\.terminal\.summary/));
};
const sent = (action: string) => host.requests.filter((request) => request.action === action);
/** The failure texts shown as messages. */
const errorsShown = () => vi.mocked(Message.error).mock.calls.map(([text]) => text);

beforeEach(() => {
  resetShownOperation();
  bridge.platform = 'darwin';
  bridge.systemInfo = undefined;
  bridge.opened = [];
  auth.user = null;
  // Arco's message box renders with an API this React no longer has: watched, not rendered.
  vi.spyOn(Message, 'error').mockImplementation(() => () => {});
  host = {
    transport: 'secure',
    settings: settingsState(),
    listing: {
      current: 'g1',
      previous: 'g0',
      revision: 1,
      appliesAt: 'next_adapter_start',
      rollbackAvailable: true,
      extensions: [
        entry('aelix-starter'),
        entry('local-demo', {
          status: 'manifest_unbound',
          origin: { kind: 'file', artifact: 'a', wheel: 'local_demo-0.2.0-py3-none-any.whl', sha256: 'x' },
        }),
      ],
    },
    terminal: terminalListing(),
    changes: [],
    requests: [],
  };
  fakeHelper();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete window.__studioExtensions;
});

describe('the agent extensions screen', () => {
  it('reads the settings first, then lists Studio and terminal extensions', async () => {
    render(<AgentExtensionsSettings />);
    expect(await screen.findByTestId('agent-extension-aelix-starter')).toBeInTheDocument();
    expect(actionsOf().slice(0, 1)).toEqual(['get_settings']);
    expect(actionsOf()).toEqual(expect.arrayContaining(['list', 'list_terminal']));
    const unbound = screen.getByTestId('agent-extension-local-demo');
    expect(within(unbound).getByText('settings.agentExtensions.status.manifest_unbound')).toBeInTheDocument();
    // Only a file import can be updated from a file; no upgrade before the host lists one (#121).
    expect(within(unbound).getByTestId('agent-extension-update')).toBeInTheDocument();
    expect(
      within(screen.getByTestId('agent-extension-aelix-starter')).queryByTestId('agent-extension-update')
    ).toBeNull();
    expect(screen.queryByTestId('agent-extension-upgrade')).toBeNull();
    // Folded under its summary until opened.
    expect(screen.queryByTestId('terminal-environment')).toBeNull();
    await unfoldTerminal();
    const terminal = await screen.findByTestId('terminal-environment');
    expect(within(terminal).getByText('~/.local/share/uv/tools/aelix')).toBeInTheDocument();
    expect(within(terminal).getByText('memory')).toBeInTheDocument();
    expect(screen.getByTestId('install-settings')).toBeInTheDocument();
    expect(screen.queryByTestId('agent-extensions-insecure')).toBeNull();
  });

  it('explains a missing runtime with its detail and still lists the terminal CLI', async () => {
    host.listing = { code: 'RUNTIME_UNAVAILABLE', detail: ['Agent Extensions need the bundle'] };
    render(<AgentExtensionsSettings />);
    expect(await screen.findByTestId('agent-extensions-runtime-unavailable')).toBeInTheDocument();
    expect(screen.getByTestId('agent-extensions-install')).toBeDisabled();
    fireEvent.click(screen.getByText('settings.agentExtensions.runtime.details'));
    expect(await screen.findByText('Agent Extensions need the bundle')).toBeInTheDocument();
    await unfoldTerminal();
    expect(await screen.findByTestId('terminal-environment')).toBeInTheDocument();
  });

  it(
    'installs by name and follows the change to its end, then lists again',
    async () => {
      host.changes.push(['checking', 'installing', 'switched']);
      render(<AgentExtensionsSettings />);
      fireEvent.click(await screen.findByTestId('agent-extensions-install'));
      fireEvent.change(await screen.findByTestId('install-name'), { target: { value: 'aelix-notes' } });
      fireEvent.click(screen.getByTestId('install-submit'));
      await waitFor(() =>
        expect(sent('install')).toEqual([{ action: 'install', source: { kind: 'index', name: 'aelix-notes' } }])
      );
      expect(await screen.findByTestId('operation-view')).toBeInTheDocument();
      await waitFor(() => expect(screen.getByTestId('operation-close')).toBeInTheDocument(), { timeout: 5000 });
      expect(screen.getByText('settings.agentExtensions.progress.switched')).toBeInTheDocument();
      expect(sent('poll').length).toBeGreaterThanOrEqual(2);
      expect(sent('list').length).toBeGreaterThanOrEqual(2);
    },
    LONG
  );

  it(
    'asks before the first secret over an insecure channel, and sends nothing on no',
    async () => {
      host.transport = 'insecure';
      host.settings = {
        ...settingsState({ proxy: 'http://proxy.corp:3128', proxyAuthentication: true }),
        credentialMode: 'memory-only',
      };
      render(<AgentExtensionsSettings />);
      expect(await screen.findByTestId('agent-extensions-insecure')).toBeInTheDocument();
      const install = async () => {
        fireEvent.click(await screen.findByTestId('agent-extensions-install'));
        fireEvent.change(await screen.findByTestId('install-name'), { target: { value: 'aelix-notes' } });
        fireEvent.click(screen.getByTestId('install-submit'));
        fireEvent.change(await screen.findByTestId('credentials-username'), { target: { value: 'ops' } });
        fireEvent.change(screen.getByTestId('credentials-password'), { target: { value: 'sentinel-secret' } });
        fireEvent.click(screen.getByTestId('credentials-submit'));
      };
      await install();
      fireEvent.click(await screen.findByText('settings.agentExtensions.actions.cancel', { selector: 'button span' }));
      // The dialog leaves after its exit animation, which can be slow on a busy runner.
      await waitFor(() => expect(screen.queryByText('settings.agentExtensions.insecure.body')).toBeNull(), {
        timeout: 4000,
      });
      expect(sent('install')).toEqual([]);

      await install();
      fireEvent.click(await screen.findByText('settings.agentExtensions.insecure.confirm'));
      await waitFor(() =>
        expect(sent('install')).toEqual([
          {
            action: 'install',
            source: { kind: 'index', name: 'aelix-notes' },
            proxyCredentials: { username: 'ops', password: 'sentinel-secret' },
            acknowledgeInsecureTransport: true,
          },
        ])
      );
    },
    LONG
  );

  it(
    'asks again for credentials the proxy refused, and sends the change again',
    async () => {
      host.settings = {
        ...settingsState({ proxy: 'http://proxy.corp:3128', proxyAuthentication: true }),
        credentialMode: 'memory-only',
      };
      host.changes.push(['checking', 'failed:PROXY_CREDENTIALS_REJECTED'], ['checking', 'switched']);
      render(<AgentExtensionsSettings />);
      fireEvent.click(await screen.findByTestId('agent-extensions-install'));
      fireEvent.change(await screen.findByTestId('install-name'), { target: { value: 'aelix-notes' } });
      fireEvent.click(screen.getByTestId('install-submit'));
      const enter = async (password: string) => {
        fireEvent.change(await screen.findByTestId('credentials-username'), { target: { value: 'ops' } });
        fireEvent.change(screen.getByTestId('credentials-password'), { target: { value: password } });
        fireEvent.click(screen.getByTestId('credentials-submit'));
      };
      await enter('wrong');
      expect(await screen.findByTestId('operation-failure', {}, { timeout: 4000 })).toHaveTextContent(
        'settings.agentExtensions.errors.PROXY_CREDENTIALS_REJECTED'
      );
      fireEvent.click(screen.getByTestId('operation-retry'));
      expect(await screen.findByText('settings.agentExtensions.credentials.rejected')).toBeInTheDocument();
      // What was typed before is gone once sent; the browser is told not to fill it in.
      const password = (await screen.findByTestId('credentials-password')) as HTMLInputElement;
      expect(password.value).toBe('');
      expect(password).toHaveAttribute('autocomplete', 'new-password');
      expect((screen.getByTestId('credentials-username') as HTMLInputElement).value).toBe('');
      await enter('right');
      await waitFor(() => expect(sent('install')).toHaveLength(2));
      expect(sent('install')[1]).toMatchObject({ proxyCredentials: { username: 'ops', password: 'right' } });
    },
    LONG
  );

  it('offers another version for a pinned upgrade, and confirms an unknown version limit', async () => {
    const listing = host.listing as ExtensionListing;
    listing.extensions = [
      { ...entry('pinned-one'), upgrade: 'pinned' } as ExtensionEntry,
      { ...entry('legacy-one'), upgrade: 'available' } as ExtensionEntry,
    ];
    host.changes.push({ code: 'PIN_UNKNOWN' }, ['checking', 'switched']);
    render(<AgentExtensionsSettings />);
    fireEvent.click(
      within(await screen.findByTestId('agent-extension-pinned-one')).getByTestId('agent-extension-upgrade')
    );
    fireEvent.click(await screen.findByText('settings.agentExtensions.upgrade.installOther'));
    expect(((await screen.findByTestId('install-name')) as HTMLInputElement).value).toBe('pinned-one');
    expect(sent('upgrade')).toEqual([]);
    fireEvent.click(screen.getByText('settings.agentExtensions.actions.cancel', { selector: 'button span' }));

    fireEvent.click(within(screen.getByTestId('agent-extension-legacy-one')).getByTestId('agent-extension-upgrade'));
    fireEvent.click(
      await screen.findByText('settings.agentExtensions.upgrade.unpinConfirm', { selector: 'button span' })
    );
    await waitFor(() => expect(sent('upgrade')).toHaveLength(2));
    expect(sent('upgrade')).toEqual([
      { action: 'upgrade', name: 'legacy-one' },
      { action: 'upgrade', name: 'legacy-one', allowUnpin: true },
    ]);
  });

  it(
    'removes after confirmation, and undoes the last change',
    async () => {
      render(<AgentExtensionsSettings />);
      fireEvent.click(
        within(await screen.findByTestId('agent-extension-aelix-starter')).getByTestId('agent-extension-remove')
      );
      fireEvent.click(
        await screen.findByText('settings.agentExtensions.actions.remove', { selector: '.arco-popconfirm button span' })
      );
      await waitFor(() => expect(sent('remove')).toEqual([{ action: 'remove', name: 'aelix-starter' }]));
      await waitFor(() => expect(screen.getByTestId('operation-close')).toBeInTheDocument(), { timeout: 4000 });
      fireEvent.click(screen.getByTestId('operation-close'));
      fireEvent.click(screen.getByTestId('agent-extensions-rollback'));
      fireEvent.click(
        await screen.findByText('settings.agentExtensions.actions.rollback', {
          selector: '.arco-popconfirm button span',
        })
      );
      await waitFor(() => expect(sent('rollback')).toHaveLength(1));
    },
    LONG
  );

  it('sets the app-wide default for new conversations, only for managed extensions', async () => {
    const listing = host.listing as ExtensionListing;
    listing.extensions = [
      entry('managed-one', { managedId: 'studio.managed-one', defaultEnabled: true }),
      entry('legacy'),
    ];
    render(<AgentExtensionsSettings />);
    const managed = await screen.findByTestId('agent-extension-managed-one');
    expect(within(screen.getByTestId('agent-extension-legacy')).queryByTestId('agent-extension-default')).toBeNull();
    fireEvent.click(within(managed).getByRole('switch'));
    await waitFor(() =>
      expect(sent('set_default')).toEqual([
        { action: 'set_default', extensionId: 'studio.managed-one', enabled: false },
      ])
    );
    await waitFor(() => expect(within(managed).getByRole('switch')).toHaveAttribute('aria-checked', 'false'));
  });

  it('answers a pending question with no when the screen closes, and sends nothing', async () => {
    host.settings = {
      ...settingsState({ proxy: 'http://proxy.corp:3128', proxyAuthentication: true }),
      credentialMode: 'memory-only',
    };
    const view = render(<AgentExtensionsSettings />);
    fireEvent.click(await screen.findByTestId('agent-extensions-install'));
    fireEvent.change(await screen.findByTestId('install-name'), { target: { value: 'aelix-notes' } });
    fireEvent.click(screen.getByTestId('install-submit'));
    fireEvent.change(await screen.findByTestId('credentials-password'), { target: { value: 'sentinel-secret' } });
    view.unmount();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sent('install')).toEqual([]);
    expect(document.body.textContent).not.toContain('sentinel-secret');
  });

  it('updates a file import from a wheel chosen on the host', async () => {
    render(<AgentExtensionsSettings />);
    fireEvent.click(
      within(await screen.findByTestId('agent-extension-local-demo')).getByTestId('agent-extension-update')
    );
    await waitFor(() =>
      expect(sent('update')).toEqual([
        {
          action: 'update',
          name: 'local-demo',
          source: { kind: 'file', path: '/host/wheels/demo-2.0-py3-none-any.whl' },
        },
      ])
    );
  });

  it('turns the Git tab off on a Windows host, and shows where it looked when no terminal CLI is found', async () => {
    bridge.platform = 'win32';
    host.terminal = terminalListing({ environments: [] });
    render(<AgentExtensionsSettings />);
    await unfoldTerminal();
    expect(await screen.findByTestId('terminal-none')).toBeInTheDocument();
    expect(screen.getByText('~/.local/share/uv/tools')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId('settings-private-git')).toBeNull());
    fireEvent.click(screen.getByTestId('agent-extensions-install'));
    const tab = await screen.findByTestId('install-git-tab');
    expect(tab.closest('[role="tab"]')).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(tab);
    expect(screen.queryByTestId('install-git-url')).toBeNull();
    // Said as the helper says it.
    fireEvent.mouseEnter(tab);
    expect(await screen.findByText('settings.agentExtensions.errors.UNSUPPORTED_PLATFORM')).toBeInTheDocument();
  });

  it('offers the Git tab elsewhere', async () => {
    render(<AgentExtensionsSettings />);
    await screen.findByTestId('agent-extension-aelix-starter');
    await waitFor(() => expect(screen.getByTestId('settings-private-git')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('agent-extensions-install'));
    fireEvent.click(await screen.findByTestId('install-git-tab'));
    expect(await screen.findByTestId('install-git-url')).not.toBeDisabled();
  });

  /** Type a proxy address with a user name and password, and turn on proxy authentication. */
  const typeProxyWithPassword = async (): Promise<HTMLInputElement> => {
    const input = (await screen.findByTestId('settings-proxy')) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'http://ops:sentinel-secret@proxy.corp:3128' } });
    fireEvent.click(screen.getByTestId('settings-proxy-auth'));
    return input;
  };

  it('saves settings with every field, and treats a proxy typed with a password as a secret', async () => {
    host.transport = 'insecure';
    render(<AgentExtensionsSettings />);
    const input = await typeProxyWithPassword();
    fireEvent.click(screen.getByTestId('settings-save'));
    fireEvent.click(await screen.findByText('settings.agentExtensions.insecure.confirm'));
    await waitFor(() =>
      expect(sent('set_settings')).toEqual([
        {
          action: 'set_settings',
          settings: {
            onlineInstall: true,
            proxy: 'http://ops:sentinel-secret@proxy.corp:3128',
            proxyAuthentication: true,
            privateGit: false,
          },
          acknowledgeInsecureTransport: true,
        },
      ])
    );
    expect(input.value).not.toContain('sentinel-secret');
  });

  it(
    'keeps no typed password in the address once the save was declined or refused',
    async () => {
      host.transport = 'insecure';
      render(<AgentExtensionsSettings />);
      const input = await typeProxyWithPassword();
      fireEvent.click(screen.getByTestId('settings-save'));
      fireEvent.click(await screen.findByText('settings.agentExtensions.actions.cancel', { selector: 'button span' }));
      await waitFor(() => expect(screen.queryByText('settings.agentExtensions.insecure.body')).toBeNull(), {
        timeout: 4000,
      });
      expect(sent('set_settings')).toEqual([]);
      expect(input.value).toBe('http://proxy.corp:3128');

      host.settingsRefusal = 'INVALID_INPUT';
      fireEvent.change(input, { target: { value: 'http://ops:sentinel-secret@proxy.corp:3128' } });
      fireEvent.click(screen.getByTestId('settings-save'));
      fireEvent.click(await screen.findByText('settings.agentExtensions.insecure.confirm'));
      await waitFor(() => expect(errorsShown()).toEqual(['settings.agentExtensions.errors.INVALID_INPUT']));
      expect(sent('set_settings')).toHaveLength(1);
      expect(input.value).toBe('http://proxy.corp:3128');
    },
    LONG
  );

  it('asks to turn on proxy authentication before saving an address with a password', async () => {
    render(<AgentExtensionsSettings />);
    fireEvent.change(await screen.findByTestId('settings-proxy'), {
      target: { value: 'http://ops:sentinel-secret@proxy.corp:3128' },
    });
    expect(screen.getByTestId('settings-proxy-needs-auth')).toHaveTextContent(
      'settings.agentExtensions.settings.credentialsNeedAuthentication'
    );
    expect(screen.getByTestId('settings-save')).toBeDisabled();
    fireEvent.click(screen.getByTestId('settings-proxy-auth'));
    expect(screen.queryByTestId('settings-proxy-needs-auth')).toBeNull();
    expect(screen.getByTestId('settings-save')).not.toBeDisabled();
  });

  it(
    'reads the settings again after a proxy refusal, asks once, and stops when refused again',
    async () => {
      host.changes.push({ code: 'PROXY_CREDENTIALS_REQUIRED' }, { code: 'PROXY_CREDENTIALS_REQUIRED' });
      render(<AgentExtensionsSettings />);
      await screen.findByTestId('agent-extension-aelix-starter');
      // Another window set a proxy with authentication: what the screen read is stale.
      host.settings = {
        ...settingsState({ proxy: 'http://proxy.corp:3128', proxyAuthentication: true }),
        credentialMode: 'memory-only',
      };
      fireEvent.click(screen.getByTestId('agent-extensions-install'));
      fireEvent.change(await screen.findByTestId('install-name'), { target: { value: 'aelix-notes' } });
      fireEvent.click(screen.getByTestId('install-submit'));
      fireEvent.change(await screen.findByTestId('credentials-username'), { target: { value: 'ops' } });
      fireEvent.change(screen.getByTestId('credentials-password'), { target: { value: 'right' } });
      fireEvent.click(screen.getByTestId('credentials-submit'));
      await waitFor(() =>
        expect(errorsShown()).toEqual(['settings.agentExtensions.errors.PROXY_CREDENTIALS_REQUIRED'])
      );
      expect(sent('install')).toEqual([
        { action: 'install', source: { kind: 'index', name: 'aelix-notes' } },
        {
          action: 'install',
          source: { kind: 'index', name: 'aelix-notes' },
          proxyCredentials: { username: 'ops', password: 'right' },
        },
      ]);
      // Asked once: the prompt leaves (after its exit animation) and does not come back.
      await waitFor(() => expect(screen.queryByTestId('credentials-password')).toBeNull(), { timeout: 4000 });
      expect(sent('install')).toHaveLength(2);
    },
    LONG
  );

  it('names the wheel filter of the file dialog in the screen language', async () => {
    render(<AgentExtensionsSettings />);
    fireEvent.click(
      within(await screen.findByTestId('agent-extension-local-demo')).getByTestId('agent-extension-update')
    );
    await waitFor(() => expect(bridge.opened).toHaveLength(1));
    expect(bridge.opened[0]).toMatchObject({
      filters: [{ name: 'settings.agentExtensions.install.wheelFilter', extensions: ['whl'] }],
    });
  });

  it('warns about the channel until the first reply says it is secure', async () => {
    render(<AgentExtensionsSettings />);
    expect(screen.getByTestId('agent-extensions-insecure')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId('agent-extensions-insecure')).toBeNull());
  });

  it('offers no update to the latest while online installs are off, and says why', async () => {
    host.settings = settingsState({ onlineInstall: false });
    const listing = host.listing as ExtensionListing;
    listing.extensions = [{ ...entry('legacy-one'), upgrade: 'available' } as ExtensionEntry];
    render(<AgentExtensionsSettings />);
    const row = await screen.findByTestId('agent-extension-legacy-one');
    await waitFor(() => expect(within(row).getByTestId('agent-extension-upgrade')).toBeDisabled());
    fireEvent.mouseEnter(within(row).getByTestId('agent-extension-upgrade-wrapper'));
    expect(await screen.findByText('settings.agentExtensions.upgrade.onlineDisabled')).toBeInTheDocument();
  });

  it('colors the status by meaning, from the theme', async () => {
    render(<AgentExtensionsSettings />);
    const [ready, unbound] = await screen.findAllByTestId('agent-extension-status');
    expect(ready).toHaveClass('!bg-success-light-1', '!text-success-6');
    expect(unbound).toHaveClass('!bg-warning-light-1', '!text-warning-6');
    expect(ready.getAttribute('style') ?? '').not.toContain('color');
  });

  describe('a change in progress', () => {
    const startInstall = async (): Promise<void> => {
      fireEvent.click(await screen.findByTestId('agent-extensions-install'));
      fireEvent.change(await screen.findByTestId('install-name'), { target: { value: 'aelix-notes' } });
      fireEvent.click(screen.getByTestId('install-submit'));
    };
    const long = ['checking', ...Array.from({ length: 30 }, () => 'installing')];

    it('is cancelled on request, and shows that it was', async () => {
      host.changes.push(long);
      render(<AgentExtensionsSettings />);
      await startInstall();
      fireEvent.click(await screen.findByTestId('operation-cancel'));
      await waitFor(() => expect(sent('cancel')).toEqual([{ action: 'cancel', operationId: 'op-1' }]));
      expect(await screen.findByText('settings.agentExtensions.progress.cancelled')).toBeInTheDocument();
    });

    it('is shown again and still followed when the screen is opened again', async () => {
      host.changes.push(long);
      const first = render(<AgentExtensionsSettings />);
      await startInstall();
      expect(await screen.findByTestId('operation-view')).toBeInTheDocument();
      first.unmount();
      const polled = sent('poll').length;
      render(<AgentExtensionsSettings />);
      expect(await screen.findByTestId('operation-view')).toBeInTheDocument();
      await waitFor(() => expect(sent('poll').length).toBeGreaterThan(polled), { timeout: 3000 });
    });

    it('is shown when its start answer arrives after the screen was left and opened again', async () => {
      host.changes.push(long);
      let open: (() => void) | undefined;
      host.gate = new Promise((resolve) => (open = resolve));
      const first = render(<AgentExtensionsSettings />);
      await startInstall();
      await waitFor(() => expect(sent('install')).toHaveLength(1));
      first.unmount();
      render(<AgentExtensionsSettings />);
      await screen.findByTestId('agent-extension-aelix-starter');
      expect(screen.queryByTestId('operation-view')).toBeNull();
      open?.();
      expect(await screen.findByTestId('operation-view')).toBeInTheDocument();
    });

    /** Proxy settings that ask for credentials on every online change (memory-only mode). */
    const proxyWithPassword = (): void => {
      host.settings = {
        ...settingsState({ proxy: 'http://proxy.corp:3128', proxyAuthentication: true }),
        credentialMode: 'memory-only',
      };
    };
    const enterCredentials = async (password: string): Promise<void> => {
      fireEvent.change(await screen.findByTestId('credentials-username'), { target: { value: 'ops' } });
      fireEvent.change(screen.getByTestId('credentials-password'), { target: { value: password } });
      fireEvent.click(screen.getByTestId('credentials-submit'));
    };

    it(
      'is sent again once after a proxy refusal, and then ends with the refusal',
      async () => {
        proxyWithPassword();
        host.changes.push(
          ['checking', 'failed:PROXY_CREDENTIALS_REJECTED'],
          ['checking', 'failed:PROXY_CREDENTIALS_REJECTED']
        );
        render(<AgentExtensionsSettings />);
        await startInstall();
        await enterCredentials('wrong');
        fireEvent.click(await screen.findByTestId('operation-retry'));
        await enterCredentials('still-wrong');
        await waitFor(() => expect(sent('install')).toHaveLength(2));
        await waitFor(() => expect(sent('poll').length).toBeGreaterThanOrEqual(2));
        expect(await screen.findByTestId('operation-failure')).toHaveTextContent(
          'settings.agentExtensions.errors.PROXY_CREDENTIALS_REJECTED'
        );
        // The retried change failed again: no third try is offered.
        await waitFor(() => expect(screen.getByTestId('operation-close')).toBeInTheDocument());
        expect(screen.queryByTestId('operation-retry')).toBeNull();
      },
      LONG
    );

    it(
      'can still be sent again after a proxy refusal when the screen is opened again',
      async () => {
        proxyWithPassword();
        host.changes.push(['checking', 'failed:PROXY_CREDENTIALS_REJECTED'], ['checking', 'switched']);
        const first = render(<AgentExtensionsSettings />);
        await startInstall();
        await enterCredentials('wrong');
        expect(await screen.findByTestId('operation-retry')).toBeInTheDocument();
        first.unmount();
        render(<AgentExtensionsSettings />);
        fireEvent.click(await screen.findByTestId('operation-retry'));
        await enterCredentials('right');
        await waitFor(() => expect(sent('install')).toHaveLength(2));
        expect(sent('install')[1]).toEqual({
          action: 'install',
          source: { kind: 'index', name: 'aelix-notes' },
          proxyCredentials: { username: 'ops', password: 'right' },
        });
      },
      LONG
    );

    it('is not shown to another user who signs in on the same tab', async () => {
      auth.user = { id: 'alice', username: 'alice' };
      host.changes.push(long);
      const first = render(<AgentExtensionsSettings />);
      await startInstall();
      expect(await screen.findByTestId('operation-view')).toBeInTheDocument();
      first.unmount();
      switchUser('bob');
      render(<AgentExtensionsSettings />);
      await screen.findByTestId('agent-extension-aelix-starter');
      expect(screen.queryByTestId('operation-view')).toBeNull();
    });

    it('is not shown to another user when its start answer arrives after they took the screen', async () => {
      auth.user = { id: 'alice', username: 'alice' };
      host.changes.push(long);
      let open: (() => void) | undefined;
      host.gate = new Promise((resolve) => (open = resolve));
      const first = render(<AgentExtensionsSettings />);
      await startInstall();
      await waitFor(() => expect(sent('install')).toHaveLength(1));
      first.unmount();
      // Another user on the same tab, without the first one signing out here.
      auth.user = { id: 'bob', username: 'bob' };
      render(<AgentExtensionsSettings />);
      await screen.findByTestId('agent-extension-aelix-starter');
      open?.();
      await waitFor(() => expect(sent('install')).toHaveLength(1));
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(screen.queryByTestId('operation-view')).toBeNull();
    });

    it(
      'keeps no Git address with a password across visits, so it is not offered again there',
      async () => {
        proxyWithPassword();
        host.changes.push(['checking', 'failed:PROXY_CREDENTIALS_REJECTED']);
        const first = render(<AgentExtensionsSettings />);
        fireEvent.click(await screen.findByTestId('agent-extensions-install'));
        fireEvent.click(await screen.findByTestId('install-git-tab'));
        fireEvent.change(await screen.findByTestId('install-git-url'), {
          target: { value: 'https://ops:git-token@git.example/pack.git' },
        });
        fireEvent.click(screen.getByTestId('install-submit'));
        await enterCredentials('wrong');
        // In this visit it can be sent again.
        expect(await screen.findByTestId('operation-retry')).toBeInTheDocument();
        first.unmount();
        render(<AgentExtensionsSettings />);
        expect(await screen.findByTestId('operation-failure')).toBeInTheDocument();
        expect(screen.queryByTestId('operation-retry')).toBeNull();
      },
      LONG
    );

    it('is dropped when another user takes the screen, even if the first comes back', async () => {
      auth.user = { id: 'alice', username: 'alice' };
      host.changes.push(long);
      const first = render(<AgentExtensionsSettings />);
      await startInstall();
      expect(await screen.findByTestId('operation-view')).toBeInTheDocument();
      first.unmount();
      auth.user = { id: 'bob', username: 'bob' };
      const second = render(<AgentExtensionsSettings />);
      await screen.findByTestId('agent-extension-aelix-starter');
      second.unmount();
      auth.user = { id: 'alice', username: 'alice' };
      render(<AgentExtensionsSettings />);
      await screen.findByTestId('agent-extension-aelix-starter');
      expect(screen.queryByTestId('operation-view')).toBeNull();
    });

    it('tells another user nothing of a refusal that arrives after they took the screen', async () => {
      auth.user = { id: 'alice', username: 'alice' };
      host.changes.push({ code: 'NO_CHANGE' });
      let open: (() => void) | undefined;
      host.gate = new Promise((resolve) => (open = resolve));
      const first = render(<AgentExtensionsSettings />);
      await startInstall();
      await waitFor(() => expect(sent('install')).toHaveLength(1));
      first.unmount();
      auth.user = { id: 'bob', username: 'bob' };
      render(<AgentExtensionsSettings />);
      await screen.findByTestId('agent-extension-aelix-starter');
      open?.();
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(errorsShown()).toEqual([]);
    });

    it('is forgotten when its user signs out', async () => {
      auth.user = { id: 'alice', username: 'alice' };
      host.changes.push(long);
      const first = render(<AgentExtensionsSettings />);
      await startInstall();
      expect(await screen.findByTestId('operation-view')).toBeInTheDocument();
      first.unmount();
      switchUser(null);
      auth.user = { id: 'alice', username: 'alice' };
      render(<AgentExtensionsSettings />);
      await screen.findByTestId('agent-extension-aelix-starter');
      expect(screen.queryByTestId('operation-view')).toBeNull();
    });
  });

  describe('the Git tab while the platform is not known', () => {
    const gitTab = async (): Promise<Element | null> => {
      fireEvent.click(await screen.findByTestId('agent-extensions-install'));
      return (await screen.findByTestId('install-git-tab')).closest('[role="tab"]');
    };

    it('stays off while the answer has not come', async () => {
      bridge.systemInfo = new Promise(() => {});
      render(<AgentExtensionsSettings />);
      await screen.findByTestId('agent-extension-aelix-starter');
      expect(await gitTab()).toHaveAttribute('aria-disabled', 'true');
      expect(screen.queryByTestId('settings-private-git')).toBeNull();
    });

    it('stays off when the platform cannot be read', async () => {
      bridge.systemInfo = Promise.reject(new Error('no answer'));
      render(<AgentExtensionsSettings />);
      await screen.findByTestId('agent-extension-aelix-starter');
      expect(await gitTab()).toHaveAttribute('aria-disabled', 'true');
    });
  });

  it('colors terminal statuses and warnings by meaning, from the theme', async () => {
    host.terminal = terminalListing();
    host.terminal.environments[0] = { ...host.terminal.environments[0], issues: ['DUPLICATE_ENTRY'], truncated: true };
    render(<AgentExtensionsSettings />);
    await unfoldTerminal();
    expect(await screen.findByTestId('terminal-status')).toHaveClass('!bg-success-light-1', '!text-success-6');
    const warnings = screen.getAllByTestId('terminal-warning');
    expect(warnings).toHaveLength(2);
    for (const warning of warnings) expect(warning).toHaveClass('!bg-warning-light-1', '!text-warning-6');
  });
});
