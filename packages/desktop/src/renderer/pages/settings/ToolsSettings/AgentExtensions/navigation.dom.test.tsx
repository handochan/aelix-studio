/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { render } from '@testing-library/react';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/renderer/hooks/system/useExtensionSettingsTabs', () => ({
  useExtensionSettingsTabs: (): unknown[] => [],
}));
vi.mock('@/renderer/hooks/system/useExtI18n', () => ({
  useExtI18n: () => ({ resolveExtTabName: (tab: { name: string }) => tab.name }),
}));
vi.mock('@/renderer/utils/platform', () => ({
  isElectronDesktop: () => true,
  resolveExtensionAssetUrl: (url: string) => url,
}));

import SettingsSider, { isSiderItemSelected } from '../../components/SettingsSider';

/** The sider items shown as the current page at `pathname`. */
const selectedAt = (pathname: string): string[] => {
  const view = render(
    <MemoryRouter initialEntries={[pathname]}>
      <SettingsSider />
    </MemoryRouter>
  );
  const selected = [...view.container.querySelectorAll('[data-settings-id]')]
    .filter((item) => item.className.includes('!bg-fill-3'))
    .map((item) => item.getAttribute('data-settings-id') ?? '');
  view.unmount();
  return selected;
};

describe('the settings sider', () => {
  it('shows only Agent Extensions as the page on its route, not Agents as well', () => {
    expect(selectedAt('/settings/agent-extensions')).toEqual(['agent-extensions']);
    expect(selectedAt('/settings/agent')).toEqual(['agent']);
  });

  it('keeps an item shown as the page on the pages under it', () => {
    expect(selectedAt('/settings/agent/claude/repair')).toEqual(['agent']);
    expect(selectedAt('/settings/skills/detail/demo')).toEqual(['skills']);
  });

  it('matches a whole route part, never the start of a longer one', () => {
    expect(isSiderItemSelected('/settings/agent-extensions', 'agent')).toBe(false);
    expect(isSiderItemSelected('/settings/agent-extensions', 'agent-extensions')).toBe(true);
    expect(isSiderItemSelected('/settings/ext/demo', 'ext/demo')).toBe(true);
    expect(isSiderItemSelected('/settings/ext/demo-two', 'ext/demo')).toBe(false);
  });
});
