/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import type { TChatConversation } from '@/common/config/storage';
import ConversationSkillsIndicator from '@/renderer/pages/conversation/components/ConversationSkillsIndicator';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en-US' } }),
}));

vi.mock('@/common', () => ({
  ipcBridge: { fs: { listAvailableSkills: { invoke: vi.fn().mockResolvedValue([]) } } },
}));

const LocationProbe = () => {
  const location = useLocation();
  return <output data-testid='location'>{location.pathname + location.search}</output>;
};

function conversation(backend: string): TChatConversation {
  return { id: 'c 18&x=1', type: 'acp', extra: { backend, skills: ['review'] } } as unknown as TChatConversation;
}

async function openSkill(backend: string) {
  render(
    <MemoryRouter initialEntries={['/conversation/c-18']}>
      <ConversationSkillsIndicator conversation={conversation(backend)} />
      <LocationProbe />
    </MemoryRouter>
  );
  fireEvent.click(screen.getByTestId('skills-indicator'));
  fireEvent.click(await screen.findByText('review'));
  return screen.getByTestId('location');
}

describe('ConversationSkillsIndicator settings link', () => {
  it('opens skills settings scoped to a builtin Aelix conversation', async () => {
    expect((await openSkill('aelix')).textContent).toBe(
      '/settings/skills?highlight=review&conversation=c%2018%26x%3D1'
    );
  });

  it('keeps the plain skills link for other agents', async () => {
    const location = await openSkill('claude');
    expect(location).toHaveTextContent('/settings/skills?highlight=review');
    expect(location).not.toHaveTextContent('conversation=');
  });
});
