import React from 'react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import NativeProviders from './NativeProviders';
import type { NativeAuthCatalog } from '@aionui/web-host';
import english from '@/renderer/services/i18n/locales/en-US/settings.json';
import agentEnglish from '@/renderer/services/i18n/locales/en-US/agent.json';

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  navigate: vi.fn(),
  agents: vi.fn(),
  checkAgentHealth: vi.fn(),
  createAgent: vi.fn(),
  assistants: vi.fn(),
  createConversation: vi.fn(),
  ensureRuntime: vi.fn(),
  setConfigOption: vi.fn(),
}));
vi.mock('@/renderer/services/runtime/nativeAuth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/renderer/services/runtime/nativeAuth')>()),
  requestNativeAuth: mocks.request,
}));
vi.mock('react-router-dom', () => ({ useNavigate: () => mocks.navigate }));
vi.mock('@/common', () => ({
  ipcBridge: {
    acpConversation: {
      getManagedAgents: { invoke: mocks.agents },
      checkManagedAgentHealthById: { invoke: mocks.checkAgentHealth },
      createCustomAgent: { invoke: mocks.createAgent },
      setConfigOption: { invoke: mocks.setConfigOption },
    },
    assistants: { list: { invoke: mocks.assistants } },
    conversation: { create: { invoke: mocks.createConversation }, ensureRuntime: { invoke: mocks.ensureRuntime } },
  },
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      if (key === 'agent.model.switchFailed') return agentEnglish.model.switchFailed;
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
      models: [
        {
          id: 'test-model',
          name: 'Test model',
          endpoint: 'https://api.example',
          api: 'anthropic-messages',
          available: false,
        },
      ],
    },
  ],
};

const configured = { ...catalog, providers: [{ ...catalog.providers[0], configured: true, source: 'stored' }] };
const modelOption = (current: string) => ({
  id: 'runtime-model',
  category: 'model',
  type: 'select',
  current_value: current,
  options: [{ value: 'anthropic/fallback' }, { value: 'anthropic/test-model' }],
});

describe('native provider settings', () => {
  beforeEach(() => {
    mocks.request.mockResolvedValue({ ok: true, data: catalog });
    mocks.agents.mockResolvedValue([]);
    mocks.createAgent.mockResolvedValue({ id: 'native-agent' });
    mocks.assistants.mockResolvedValue([
      { id: 'legacy-aelix', agent_id: 'native-agent', source: 'generated' },
      { id: 'bare:builtin-aelix', agent_id: 'builtin-aelix', source: 'generated', name: 'Aelix', enabled: true },
    ]);
    mocks.createConversation.mockResolvedValue({ id: 'native-conversation' });
    mocks.ensureRuntime.mockResolvedValue({ config_options: [modelOption('anthropic/fallback')] });
    mocks.setConfigOption.mockResolvedValue({
      confirmation: 'observed',
      config_options: [modelOption('anthropic/test-model')],
    });
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

  it('starts a builtin Aelix conversation with the provider-qualified model override', async () => {
    mocks.request.mockResolvedValue({ ok: true, data: configured });
    const opened = vi.fn();
    render(<NativeProviders onOpenConversation={opened} />);
    const start = await screen.findByRole('button', { name: english.nativeAuth.startConversation });
    await waitFor(() => expect(start).toBeEnabled());
    fireEvent.click(start);
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith('/conversation/native-conversation'));
    expect(mocks.setConfigOption).toHaveBeenCalledWith({
      conversation_id: 'native-conversation',
      option_id: 'runtime-model',
      value: 'anthropic/test-model',
    });
    expect(mocks.createConversation).toHaveBeenCalledWith({
      name: 'Aelix',
      assistant: { id: 'bare:builtin-aelix', conversation_overrides: { model: 'anthropic/test-model' } },
      extra: { studio_initial_model: 'anthropic/test-model' },
    });
    expect(mocks.createAgent).not.toHaveBeenCalled();
    expect(opened).toHaveBeenCalledTimes(1);
  });

  it('shows a localized error and keeps Settings open after an unobserved model change', async () => {
    mocks.request.mockResolvedValue({ ok: true, data: configured });
    mocks.setConfigOption.mockResolvedValue({
      confirmation: 'command_ack',
      config_options: [modelOption('anthropic/test-model')],
    });
    render(<NativeProviders />);
    fireEvent.click(await screen.findByRole('button', { name: english.nativeAuth.startConversation }));
    expect(await screen.findByText(agentEnglish.model.switchFailed)).toBeVisible();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it('reports unavailable when only legacy custom Aelix agents exist', async () => {
    mocks.request.mockResolvedValue({ ok: true, data: configured });
    mocks.assistants.mockResolvedValue([{ id: 'legacy-aelix', agent_id: 'native-agent', source: 'generated' }]);
    render(<NativeProviders />);
    fireEvent.click(await screen.findByRole('button', { name: english.nativeAuth.startConversation }));
    expect(await screen.findByText(english.nativeAuth.unavailable)).toBeVisible();
    expect(mocks.createConversation).not.toHaveBeenCalled();
  });

  it('opens another builtin conversation after replacing a key the provider rejected', async () => {
    const assistant = {
      id: 'bare:builtin-aelix',
      agent_id: 'builtin-aelix',
      source: 'generated',
      name: 'Aelix',
      enabled: true,
      agent_status: 'online',
    };
    let agentStatus = 'online';
    mocks.assistants.mockImplementation(async () => [{ ...assistant, agent_status: agentStatus }]);
    mocks.request.mockResolvedValue({ ok: true, data: configured });
    mocks.createConversation
      .mockResolvedValueOnce({ id: 'rejected-chat' })
      .mockResolvedValueOnce({ id: 'repaired-chat' });
    mocks.agents.mockResolvedValue([
      {
        id: 'builtin-aelix',
        installed: true,
        enabled: true,
        status: 'offline',
        last_check_kind: 'session',
        last_check_error_code: 'session_send_failed',
      },
    ]);
    mocks.checkAgentHealth.mockImplementation(async () => {
      agentStatus = 'online';
      return { id: 'builtin-aelix', status: 'online' };
    });
    render(<NativeProviders />);
    const start = await screen.findByRole('button', { name: english.nativeAuth.startConversation });
    fireEvent.click(start);
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith('/conversation/rejected-chat'));
    // The host records the first turn's provider rejection in its availability snapshot.
    agentStatus = 'offline';
    fireEvent.click(screen.getByText(english.nativeAuth.exclusive));
    const key = screen.getByLabelText(english.nativeAuth.key);
    fireEvent.change(key, { target: { value: 'corrected-fixture-key' } });
    fireEvent.click(screen.getByRole('button', { name: english.nativeAuth.saveKey }));
    // Saving the key re-probes the host, so every picker sees Aelix again.
    await waitFor(() => expect(mocks.checkAgentHealth).toHaveBeenCalledExactlyOnceWith({ id: 'builtin-aelix' }));
    await waitFor(() => expect(start).toBeEnabled());
    fireEvent.click(start);
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith('/conversation/repaired-chat'));
    expect(mocks.checkAgentHealth).toHaveBeenCalledOnce();
  });

  it('re-probes an Aelix the host marked offline after a failed session before starting', async () => {
    let agentStatus = 'offline';
    mocks.assistants.mockImplementation(async () => [
      {
        id: 'bare:builtin-aelix',
        agent_id: 'builtin-aelix',
        source: 'generated',
        name: 'Aelix',
        enabled: true,
        agent_status: agentStatus,
      },
    ]);
    mocks.request.mockResolvedValue({ ok: true, data: configured });
    mocks.agents.mockResolvedValue([
      {
        id: 'builtin-aelix',
        enabled: true,
        status: 'offline',
        last_check_kind: 'session',
        last_check_error_code: 'auth_required',
      },
    ]);
    mocks.checkAgentHealth.mockImplementation(async () => {
      agentStatus = 'online';
      return { id: 'builtin-aelix', status: 'online' };
    });
    render(<NativeProviders />);
    fireEvent.click(await screen.findByRole('button', { name: english.nativeAuth.startConversation }));
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith('/conversation/native-conversation'));
    expect(mocks.checkAgentHealth).toHaveBeenCalledExactlyOnceWith({ id: 'builtin-aelix' });
  });

  it('keeps an Aelix that a probe marked offline unavailable without probing it again', async () => {
    mocks.assistants.mockResolvedValue([
      {
        id: 'bare:builtin-aelix',
        agent_id: 'builtin-aelix',
        source: 'generated',
        name: 'Aelix',
        enabled: true,
        agent_status: 'offline',
      },
    ]);
    mocks.request.mockResolvedValue({ ok: true, data: configured });
    mocks.agents.mockResolvedValue([
      {
        id: 'builtin-aelix',
        enabled: true,
        status: 'offline',
        last_check_kind: 'manual',
        last_check_error_code: 'acp_init_failed',
      },
    ]);
    render(<NativeProviders />);
    fireEvent.click(await screen.findByRole('button', { name: english.nativeAuth.startConversation }));
    expect(await screen.findByText(english.nativeAuth.unavailable)).toBeVisible();
    expect(mocks.checkAgentHealth).not.toHaveBeenCalled();
    expect(mocks.createConversation).not.toHaveBeenCalled();
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
