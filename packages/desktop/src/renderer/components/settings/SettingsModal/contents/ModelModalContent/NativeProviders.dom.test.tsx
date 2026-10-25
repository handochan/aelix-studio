import React from 'react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import NativeProviders from './NativeProviders';
import type { NativeAuthCatalog } from '@aionui/web-host';
import english from '@/renderer/services/i18n/locales/en-US/settings.json';

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  navigate: vi.fn(),
  agents: vi.fn(),
  createAgent: vi.fn(),
  assistants: vi.fn(),
  createConversation: vi.fn(),
}));
vi.mock('./nativeAuth', () => ({ requestNativeAuth: mocks.request }));
vi.mock('react-router-dom', () => ({ useNavigate: () => mocks.navigate }));
vi.mock('@/common', () => ({
  ipcBridge: {
    acpConversation: { getManagedAgents: { invoke: mocks.agents }, createCustomAgent: { invoke: mocks.createAgent } },
    assistants: { list: { invoke: mocks.assistants } },
    conversation: { create: { invoke: mocks.createConversation } },
  },
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const name = key.replace('settings.nativeAuth.', '') as keyof typeof english.nativeAuth;
      return english.nativeAuth[name] ?? key;
    },
  }),
}));

const catalog: NativeAuthCatalog = {
  root: '/explicit/cli',
  authPath: '/explicit/cli/auth.json',
  modelsPath: '/explicit/cli/models.json',
  revision: 'one',
  concurrentLegacyMutation: false,
  appliesAt: 'new_session',
  providers: [
    {
      id: 'anthropic',
      name: 'Anthropic',
      configured: false,
      source: null,
      oauth: true,
      models: [{ id: 'test-model', name: 'Test model', endpoint: 'https://api.example', api: 'anthropic-messages' }],
    },
  ],
};

describe('native provider settings', () => {
  beforeEach(() => {
    mocks.request.mockResolvedValue({ ok: true, data: catalog });
    mocks.agents.mockResolvedValue([]);
    mocks.createAgent.mockResolvedValue({ id: 'native-agent' });
    mocks.assistants.mockResolvedValue([{ id: 'native-assistant', agent_id: 'native-agent' }]);
    mocks.createConversation.mockResolvedValue({ id: 'native-conversation' });
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('shows the CLI store and requires exclusive use before registering a key', async () => {
    render(<NativeProviders />);
    expect(await screen.findByText('/explicit/cli/auth.json')).toBeVisible();
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'sentinel-key' } });
    expect(screen.getByRole('button', { name: 'Save native API key' })).toBeDisabled();
    fireEvent.click(screen.getByText(english.nativeAuth.exclusive));
    fireEvent.click(screen.getByRole('button', { name: 'Save native API key' }));
    await waitFor(() =>
      expect(mocks.request).toHaveBeenCalledWith({
        action: 'setKey',
        provider: 'anthropic',
        key: 'sentinel-key',
        revision: 'one',
        exclusive: true,
      })
    );
    expect(screen.getByLabelText('API key')).toHaveValue('');
  });

  it('keeps unconfigured providers from starting a conversation', async () => {
    render(<NativeProviders />);
    await screen.findByText('/explicit/cli/auth.json');
    expect(screen.getByRole('button', { name: 'Start a new Aelix conversation' })).toBeDisabled();
  });

  it('cancels OAuth when settings unmounts and does not send callback input to chat', async () => {
    mocks.request.mockImplementation(async (command) =>
      command.action === 'catalog'
        ? { ok: true, data: catalog }
        : { ok: true, data: { operationId: 'login-one', phase: 'pending' } }
    );
    const view = render(<NativeProviders />);
    await screen.findByText('/explicit/cli/auth.json');
    fireEvent.click(screen.getByText(english.nativeAuth.exclusive));
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with OAuth' }));
    await screen.findByText(english.nativeAuth.pending);
    view.unmount();
    expect(mocks.request).toHaveBeenCalledWith({ action: 'cancel', operationId: 'login-one' });
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it('reports stale configuration and refreshes without replaying the key', async () => {
    mocks.request.mockImplementation(async (command) =>
      command.action === 'setKey' ? { ok: false, code: 'CONFLICT' } : { ok: true, data: catalog }
    );
    render(<NativeProviders />);
    await screen.findByText('/explicit/cli/auth.json');
    fireEvent.click(screen.getByText(english.nativeAuth.exclusive));
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'sentinel-key' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save native API key' }));
    await screen.findByText(english.nativeAuth.conflict);
    expect(mocks.request.mock.calls.filter(([command]) => command.action === 'setKey')).toHaveLength(1);
    expect(screen.getByLabelText('API key')).toHaveValue('');
  });

  it('starts a fresh conversation with the selected native model and explicit CLI root', async () => {
    const configured = { ...catalog, providers: [{ ...catalog.providers[0], configured: true, source: 'stored' }] };
    const launch = {
      root: catalog.root,
      command: '/runtime/adapter/bin/aelix-acp',
      args: ['--provider', 'anthropic', '--model', 'test-model'],
      env: [{ name: 'AELIX_CODING_AGENT_DIR', value: catalog.root }],
    };
    mocks.request.mockImplementation(async (command) => ({
      ok: true,
      data: command.action === 'select' ? launch : configured,
    }));
    const opened = vi.fn();
    render(<NativeProviders onOpenConversation={opened} />);
    const start = await screen.findByRole('button', { name: english.nativeAuth.startConversation });
    await waitFor(() => expect(start).toBeEnabled());
    fireEvent.click(start);
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith('/conversation/native-conversation'));
    expect(mocks.createAgent).toHaveBeenCalledWith({
      name: 'Aelix · anthropic/test-model',
      command: launch.command,
      args: launch.args,
      env: launch.env,
    });
    expect(opened).toHaveBeenCalledTimes(1);
  });

  it('lets the user answer a localized manual callback and clears the transient input', async () => {
    const pending = {
      operationId: 'manual-login',
      phase: 'pending',
      authorization: { url: 'https://example.invalid/authorize', instructions: 'Device code' },
      prompt: { kind: 'manual', challengeId: 'challenge', message: '', allowEmpty: false },
    };
    mocks.request.mockImplementation(async (command) => ({
      ok: true,
      data:
        command.action === 'catalog'
          ? catalog
          : command.action === 'reply'
            ? { operationId: 'manual-login', phase: 'complete' }
            : pending,
    }));
    render(<NativeProviders />);
    await screen.findByText(catalog.authPath);
    fireEvent.click(screen.getByText(english.nativeAuth.exclusive));
    fireEvent.click(screen.getByRole('button', { name: english.nativeAuth.oauth }));
    await screen.findByText(english.nativeAuth.manualCallback);
    fireEvent.change(screen.getByLabelText(english.nativeAuth.callback), { target: { value: 'secret-callback-code' } });
    fireEvent.click(screen.getByRole('button', { name: english.nativeAuth.continue }));
    await waitFor(() => expect(screen.queryByLabelText(english.nativeAuth.callback)).not.toBeInTheDocument());
    expect(mocks.request).toHaveBeenCalledWith({
      action: 'reply',
      operationId: 'manual-login',
      challengeId: 'challenge',
      value: 'secret-callback-code',
    });
    expect(mocks.request.mock.calls.filter(([command]) => command.action === 'catalog')).toHaveLength(2);
  });

  it('refreshes native status after explicit cancellation instead of assuming no credential commit', async () => {
    mocks.request.mockImplementation(async (command) => ({
      ok: true,
      data:
        command.action === 'catalog'
          ? catalog
          : { operationId: 'cancel-login', phase: command.action === 'cancel' ? 'cancelled' : 'pending' },
    }));
    render(<NativeProviders />);
    await screen.findByText(catalog.authPath);
    fireEvent.click(screen.getByText(english.nativeAuth.exclusive));
    fireEvent.click(screen.getByRole('button', { name: english.nativeAuth.oauth }));
    await screen.findByText(english.nativeAuth.pending);
    fireEvent.click(screen.getByRole('button', { name: 'common.cancel' }));
    await waitFor(() =>
      expect(mocks.request.mock.calls.filter(([command]) => command.action === 'catalog')).toHaveLength(2)
    );
    expect(screen.queryByText(english.nativeAuth.pending)).not.toBeInTheDocument();
  });

  it('selects a newly configured endpoint provider before the user registers its key', async () => {
    const custom = { ...catalog.providers[0], id: 'custom', name: 'Custom' };
    mocks.request.mockImplementation(async (command) => ({
      ok: true,
      data: command.action === 'endpoint' ? { ...catalog, providers: [custom] } : catalog,
    }));
    render(<NativeProviders />);
    await screen.findByText(catalog.authPath);
    fireEvent.click(screen.getByText(english.nativeAuth.exclusive));
    fireEvent.click(screen.getByText(english.nativeAuth.customEndpoint));
    fireEvent.change(screen.getByLabelText(english.nativeAuth.providerId), { target: { value: 'custom' } });
    fireEvent.change(screen.getAllByLabelText(english.nativeAuth.model).at(-1)!, { target: { value: 'test-model' } });
    fireEvent.change(screen.getByLabelText(english.nativeAuth.endpoint), {
      target: { value: 'https://example.invalid/v1' },
    });
    fireEvent.click(screen.getByRole('button', { name: english.nativeAuth.saveEndpoint }));
    await screen.findByText('Custom');
    expect(mocks.request).toHaveBeenCalledWith({
      action: 'endpoint',
      provider: 'custom',
      model: 'test-model',
      endpoint: 'https://example.invalid/v1',
      api: 'openai-completions',
      revision: 'one',
      exclusive: true,
    });
  });

  it('lets the operator retry unavailable runtime discovery without replaying credentials', async () => {
    mocks.request.mockResolvedValueOnce({ ok: false, code: 'RUNTIME_UNAVAILABLE' });
    render(<NativeProviders />);
    await screen.findByText(english.nativeAuth.unavailable);
    fireEvent.click(screen.getByRole('button', { name: english.nativeAuth.refresh }));
    expect(await screen.findByText(catalog.authPath)).toBeVisible();
  });

  it('observes an OAuth failure, refreshes native state and does not retry login', async () => {
    mocks.request.mockImplementation(async (command) => ({
      ok: true,
      data:
        command.action === 'catalog'
          ? catalog
          : {
              operationId: 'failed-login',
              phase: command.action === 'poll' ? 'failed' : 'pending',
              code: 'NATIVE_FAILED',
            },
    }));
    render(<NativeProviders />);
    await screen.findByText(catalog.authPath);
    fireEvent.click(screen.getByText(english.nativeAuth.exclusive));
    fireEvent.click(screen.getByRole('button', { name: english.nativeAuth.oauth }));
    await screen.findByText(english.nativeAuth.failed);
    expect(mocks.request.mock.calls.filter(([command]) => command.action === 'login')).toHaveLength(1);
    expect(mocks.request.mock.calls.filter(([command]) => command.action === 'catalog')).toHaveLength(2);
  });
});
