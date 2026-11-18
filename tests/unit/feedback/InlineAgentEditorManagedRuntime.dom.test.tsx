/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConfigProvider } from '@arco-design/web-react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'en' } }),
}));

vi.mock('@/renderer/hooks/context/ThemeContext', () => ({
  useThemeContext: () => ({ theme: 'light' }),
}));

vi.mock('@/renderer/components/chat/EmojiPicker', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('@uiw/react-codemirror', () => ({
  default: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => (
    <textarea aria-label='Advanced JSON' value={value} onChange={(event) => onChange(event.target.value)} />
  ),
}));

const testCustomAgentMock = vi.fn();
vi.mock('@/common/adapter/ipcBridge', () => ({
  assistants: { list: { invoke: vi.fn().mockResolvedValue([]) } },
  acpConversation: {
    testCustomAgent: { invoke: (...args: unknown[]) => testCustomAgentMock(...args) },
  },
}));

import InlineAgentEditor from '@/renderer/pages/settings/AgentSettings/InlineAgentEditor';

const renderEditor = (onSave = vi.fn()) =>
  render(
    <ConfigProvider>
      <InlineAgentEditor onSave={onSave} onCancel={vi.fn()} />
    </ConfigProvider>
  );

const fillCommandAndTest = async (user: ReturnType<typeof userEvent.setup>, command: string) => {
  const commandInput = document.querySelectorAll('.arco-input')[1] as HTMLInputElement;
  await act(async () => {
    await user.type(commandInput, command);
  });
  const testBtn = screen.getByRole('button', { name: /testConnectionBtn/i });
  await act(async () => {
    await user.click(testBtn);
  });
};

describe('InlineAgentEditor managed runtime feedback', () => {
  beforeEach(() => {
    testCustomAgentMock.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it('shows fail_cli details returned by the backend', async () => {
    testCustomAgentMock.mockResolvedValue({
      step: 'fail_cli',
      error: 'managed node runtime unsupported on linux/x86',
    });
    const user = userEvent.setup();
    renderEditor();

    await fillCommandAndTest(user, 'npx @acme/agent');

    await waitFor(() => {
      expect(screen.getByText('settings.testConnectionFailCli')).toBeInTheDocument();
    });
    expect(screen.getByText(/managed node runtime unsupported/i)).toBeInTheDocument();
  });

  it('shows fail_acp details returned by the backend', async () => {
    testCustomAgentMock.mockResolvedValue({
      step: 'fail_acp',
      error: 'CLI exited before ACP initialize completed (status=1)',
    });
    const user = userEvent.setup();
    renderEditor();

    await fillCommandAndTest(user, 'npx @acme/agent');

    await waitFor(() => {
      expect(screen.getByText('settings.testConnectionFailAcp')).toBeInTheDocument();
    });
    expect(screen.getByText(/CLI exited before ACP initialize completed/i)).toBeInTheDocument();
  });

  it.each([
    { setting: true, policy: { supports_side_question: true, supports_team: true } },
    { setting: false, policy: { supports_side_question: true, supports_team: false } },
    { setting: 'true', policy: { supports_side_question: true } },
  ])('saves only boolean Team settings from Advanced JSON ($setting)', async ({ setting, policy }) => {
    const save = vi.fn();
    const user = userEvent.setup();
    renderEditor(save);

    const [name, command] = screen.getAllByRole('textbox');
    await user.type(name, 'Aelix');
    await user.type(command, 'aelix-acp');
    await user.click(screen.getByText('settings.advancedMode'));
    fireEvent.change(screen.getByRole('textbox', { name: 'Advanced JSON' }), {
      target: { value: JSON.stringify({ behavior_policy: { supports_side_question: true, supports_team: setting } }) },
    });
    await user.click(screen.getByRole('button', { name: 'common.save' }));

    expect(save).toHaveBeenCalledWith(expect.objectContaining({ advanced: { behavior_policy: policy } }));
  });
});
