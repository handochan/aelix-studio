/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import type { Assistant } from '@/common/types/agent/assistantTypes';
import AssistantAvatar from '@/renderer/pages/settings/AssistantSettings/AssistantAvatar';
import { AELIX_MARK_DATA_URL } from '@/renderer/utils/model/agentLogo';

vi.mock('@/renderer/utils/platform', () => ({
  resolveExtensionAssetUrl: vi.fn(() => null),
  resolveBackendAssetUrl: (url: string) => url,
}));

vi.mock('@/renderer/utils/model/agentLogo', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/renderer/utils/model/agentLogo')>();
  // The host keeps the native Aelix agent's data URL icon on the agent row only.
  return { ...actual, useAgentLogos: () => ({ 'native-aelix': actual.AELIX_MARK_DATA_URL }) };
});

function assistant(overrides: Partial<Assistant>): Assistant {
  return {
    id: 'aelix',
    source: 'generated',
    name: 'Aelix',
    name_i18n: {},
    description_i18n: {},
    enabled: true,
    sort_order: 1,
    agent_id: 'native-aelix',
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
    ...overrides,
  } as Assistant;
}

describe('AssistantAvatar', () => {
  it("shows a generated assistant's agent icon when it has no avatar", () => {
    const { container } = render(<AssistantAvatar assistant={assistant({ avatar: '' })} />);
    expect(container.querySelector('img')?.getAttribute('src')).toBe(AELIX_MARK_DATA_URL);
  });

  it('keeps an emoji avatar over the agent icon', () => {
    const { container } = render(<AssistantAvatar assistant={assistant({ avatar: '🧬' })} />);
    expect(container).toHaveTextContent('🧬');
    expect(container.querySelector('img')).toBeNull();
  });

  it("keeps the fallback icon for a user's assistant on the same agent", () => {
    const { container } = render(<AssistantAvatar assistant={assistant({ source: 'user', avatar: '' })} />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('.i-icon-robot')).not.toBeNull();
  });
});
