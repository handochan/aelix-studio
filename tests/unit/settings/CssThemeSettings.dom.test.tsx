/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Theme } from '@/common/theme/types';
import { DEFAULT_THEME_ID } from '@/common/theme/constants';
import CssThemeSettings from '@/renderer/pages/settings/AppearanceSettings/CssThemeSettings';

const mocks = vi.hoisted(() => ({
  activeId: 'user-sepia',
  selectTheme: vi.fn(),
  configSet: vi.fn(),
}));

const sepia: Theme = {
  id: 'user-sepia',
  name: 'Sepia',
  appearance: 'light',
  css: ':root { --bg-base: #f4ecd8; }',
  builtin: false,
  created_at: 1,
  updated_at: 1,
};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@renderer/hooks/context/ThemeContext', () => ({
  useThemeContext: () => ({
    theme: 'light',
    activeTheme: sepia,
    activeId: mocks.activeId,
    selectTheme: mocks.selectTheme,
  }),
}));

vi.mock('@/common/config/configService', () => ({
  configService: {
    get: (key: string) => (key === 'theme.userThemes' ? [sepia] : undefined),
    set: mocks.configSet,
  },
}));

vi.mock('@/common', () => ({
  ipcBridge: { extensions: { getThemes: { invoke: vi.fn().mockRejectedValue(new Error('no extensions')) } } },
}));

// The editor itself is out of scope: expose only its delete action.
vi.mock('@/renderer/pages/settings/AppearanceSettings/CssThemeModal', () => ({
  default: ({ visible, onDelete }: { visible: boolean; onDelete?: () => void }) =>
    visible && onDelete ? <div data-testid='delete-theme' onClick={onDelete} /> : null,
}));

vi.mock('@arco-design/web-react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@arco-design/web-react')>();
  return {
    ...actual,
    Message: { success: vi.fn(), error: vi.fn() },
    Modal: Object.assign(() => null, {
      confirm: ({ onOk }: { onOk?: () => Promise<void> | void }) => void onOk?.(),
    }),
  };
});

describe('CssThemeSettings', () => {
  beforeEach(() => {
    mocks.selectTheme.mockReset().mockResolvedValue(undefined);
    mocks.configSet.mockReset().mockResolvedValue(undefined);
  });

  it('falls back to the default selection when the active theme is deleted', async () => {
    render(<CssThemeSettings />);

    const card = await screen.findByTestId('theme-card-user-sepia');
    fireEvent.mouseEnter(card);
    const editButton = card.querySelector<HTMLElement>('.i-icon-edit-two')?.parentElement;
    expect(editButton).toBeTruthy();
    fireEvent.click(editButton!);
    fireEvent.click(await screen.findByTestId('delete-theme'));

    await waitFor(() => expect(mocks.selectTheme).toHaveBeenCalledWith(DEFAULT_THEME_ID));
    expect(mocks.configSet).toHaveBeenCalledWith('theme.userThemes', []);
  });
});
