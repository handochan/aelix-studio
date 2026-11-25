/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ConfigProvider } from '@arco-design/web-react';
import type { Assistant } from '@/common/types/agent/assistantTypes';
import AssistantSelectionArea from '@/renderer/pages/guid/components/AssistantSelectionArea';
import aelixMark from '@/renderer/assets/logo.svg';

const { runtimeCatalog } = vi.hoisted(() => ({
  runtimeCatalog: vi.fn((): unknown[] => [
    { id: 'agent-antigravity', name: 'Antigravity', backend: 'antigravity', command: 'agy' },
  ]),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, options?: { defaultValue?: string }) => options?.defaultValue || _key,
  }),
}));

vi.mock('@/renderer/utils/platform', () => ({
  resolveExtensionAssetUrl: vi.fn(() => null),
}));

vi.mock('@/renderer/hooks/agent/useManagedAgents', () => ({
  useManagedAgentRuntimeCatalog: runtimeCatalog,
}));

describe('AssistantSelectionArea', () => {
  it('puts the builtin first and keeps the previously selected assistant selected', () => {
    const aelix: Assistant = {
      ...overflowAssistant('bare:builtin-aelix', 'Aelix', 99),
      source: 'generated',
      agent_id: 'builtin-aelix',
      agent: { type: 'acp', source: 'builtin', acp_backend: 'aelix' },
    };
    vi.stubGlobal('innerWidth', 390);
    try {
      render(
        <AssistantSelectionArea
          selectedAssistantId='cowork'
          assistants={[...assistants(), aelix]}
          localeKey='en-US'
          onSelectAssistant={vi.fn()}
        />
      );

      const [first] = screen.getAllByTestId(/preset-pill-/);
      expect(first).toHaveAttribute('data-assistant-id', aelix.id);
      expect(first.querySelector('img')).toHaveAttribute('src', aelixMark);
      expect(screen.getByTestId('preset-pill-cowork')).toHaveAttribute('data-assistant-selected', 'true');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('shows the missing builtin as a disabled first entry without a generated assistant', () => {
    runtimeCatalog.withImplementation(
      () => [{ id: 'builtin-aelix', name: 'Aelix', backend: 'aelix', status: 'missing', enabled: true }],
      () => {
        render(<AssistantSelectionArea assistants={assistants()} localeKey='en-US' onSelectAssistant={vi.fn()} />);

        const [first] = screen.getAllByTestId(/preset-pill-/);
        expect(first).toHaveTextContent('Aelix · settings.agentManagement.filterUnavailable');
        expect(first).toBeDisabled();
      }
    );
  });

  it('returns the real assistant id when a pill is selected', () => {
    const onSelectAssistant = vi.fn();

    render(
      <ConfigProvider>
        <AssistantSelectionArea
          selectedAssistantId='cowork'
          assistants={assistants()}
          localeKey='en-US'
          onSelectAssistant={onSelectAssistant}
        />
      </ConfigProvider>
    );

    fireEvent.click(screen.getByTestId('preset-pill-writer'));

    expect(onSelectAssistant).toHaveBeenCalledWith('writer');
  });

  it('renders assistant pills in sort_order order', () => {
    render(
      <ConfigProvider>
        <AssistantSelectionArea
          selectedAssistantId='cowork'
          assistants={assistants()}
          localeKey='en-US'
          onSelectAssistant={vi.fn()}
        />
      </ConfigProvider>
    );

    const presetPills = screen
      .getAllByTestId(/preset-pill-/)
      .map((element) => element.getAttribute('data-testid')?.replace('preset-pill-', ''));

    expect(presetPills).toEqual(['writer', 'cowork']);
  });

  it('prefers localized assistant names for the active locale', () => {
    render(
      <ConfigProvider>
        <AssistantSelectionArea
          selectedAssistantId='academic-paper'
          assistants={[
            {
              id: 'academic-paper',
              source: 'builtin',
              name: 'Academic Paper',
              name_i18n: {
                'zh-CN': '学术论文助手',
              },
              description_i18n: {},
              enabled: true,
              sort_order: 1,
              preset_agent_type: 'claude',
              enabled_skills: [],
              custom_skill_names: [],
              disabled_builtin_skills: [],
              context_i18n: {},
              prompts: ['English prompt'],
              prompts_i18n: {
                'zh-CN': ['中文提示词'],
              },
              models: [],
              agent_status: 'online',
              team_selectable: true,
              deletable: false,
            },
          ]}
          localeKey='zh-CN'
          onSelectAssistant={vi.fn()}
        />
      </ConfigProvider>
    );

    expect(screen.getByText('学术论文助手')).toBeInTheDocument();
    expect(screen.queryByText('Academic Paper')).not.toBeInTheDocument();
  });

  it('finds an overflow assistant by its runtime agent command (ag → agy → Antigravity)', () => {
    // Sorted last so it lands in the overflow panel rather than a visible pill.
    const antigravity = overflowAssistant('antigravity', 'Antigravity', 99);
    const fillers = Array.from({ length: 25 }, (_, index) =>
      overflowAssistant(`filler-${index}`, `Filler ${index}`, index + 1)
    );

    render(
      <ConfigProvider>
        <AssistantSelectionArea
          selectedAssistantId={null}
          assistants={[...fillers, antigravity]}
          localeKey='en-US'
          onSelectAssistant={vi.fn()}
        />
      </ConfigProvider>
    );

    fireEvent.click(screen.getByTestId('assistant-more-btn'));
    expect(screen.getByTestId('assistant-overflow-filler-10')).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('Search'), { target: { value: 'ag' } });

    expect(screen.getByTestId('assistant-overflow-antigravity')).toBeInTheDocument();
    expect(screen.queryByTestId('assistant-overflow-filler-10')).not.toBeInTheDocument();
  });
});

function overflowAssistant(id: string, name: string, sortOrder: number): Assistant {
  return {
    id,
    source: 'builtin',
    name,
    name_i18n: {},
    description_i18n: {},
    enabled: true,
    sort_order: sortOrder,
    agent_id: `agent-${id}`,
    enabled_skills: [],
    custom_skill_names: [],
    disabled_builtin_skills: [],
    context_i18n: {},
    prompts: [],
    prompts_i18n: {},
    models: [],
    agent_status: 'online',
    team_selectable: true,
    deletable: false,
  } as Assistant;
}

function assistants(): Assistant[] {
  return [
    {
      id: 'cowork',
      source: 'builtin',
      name: 'Cowork',
      name_i18n: {},
      description_i18n: {},
      enabled: true,
      sort_order: 20,
      preset_agent_type: 'claude',
      enabled_skills: [],
      custom_skill_names: [],
      disabled_builtin_skills: [],
      context_i18n: {},
      prompts: [],
      prompts_i18n: {},
      models: [],
      agent_status: 'online',
      team_selectable: true,
      deletable: false,
    },
    {
      id: 'writer',
      source: 'user',
      name: 'Writer',
      name_i18n: {},
      description_i18n: {},
      enabled: true,
      sort_order: 10,
      preset_agent_type: 'claude',
      enabled_skills: [],
      custom_skill_names: [],
      disabled_builtin_skills: [],
      context_i18n: {},
      prompts: [],
      prompts_i18n: {},
      models: [],
      agent_status: 'online',
      team_selectable: true,
      deletable: true,
    },
  ];
}
