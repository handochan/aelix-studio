/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  runUpdateCheck: vi.fn(() =>
    Promise.resolve({ kind: 'upToDate', currentVersion: '1.0.0', updateInfo: null, releasePageUrl: '' })
  ),
  getIncludePrerelease: vi.fn(() => false),
  isElectronDesktop: vi.fn(() => true),
  openExternalUrl: vi.fn(() => Promise.resolve()),
}));

vi.mock('@/renderer/components/settings/checkForUpdatesShared', () => ({
  runUpdateCheck: mocks.runUpdateCheck,
  getIncludePrerelease: mocks.getIncludePrerelease,
}));

vi.mock('@/renderer/utils/platform', () => ({
  isElectronDesktop: mocks.isElectronDesktop,
  openExternalUrl: mocks.openExternalUrl,
}));

// Force discontinued mode for this suite.
vi.mock('@/renderer/utils/discontinuedBuild', () => ({ IS_DISCONTINUED_BUILD: true }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

// AboutModalContent pulls in several context/hooks; mock the heavy ones so the
// component renders in isolation. Keep only what the check-update button needs.
vi.mock('@/renderer/components/settings/SettingsModal/settingsViewContext', () => ({
  useSettingsViewMode: () => 'modal',
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    systemSettings: {
      getOfflineMode: { invoke: vi.fn().mockResolvedValue(false) },
      offlineModeChanged: { on: vi.fn(() => () => {}) },
      getAutoUpdateEnabled: { invoke: vi.fn().mockResolvedValue(true) },
      setAutoUpdateEnabled: { invoke: vi.fn().mockResolvedValue(undefined) },
    },
    shell: { openFile: { invoke: vi.fn() } },
    autoUpdate: { quitAndInstall: { invoke: vi.fn(() => Promise.resolve()) } },
  },
}));

vi.mock('@/renderer/components/settings/updateReadyState', () => ({
  getUpdateReadyState: () => ({ ready: false, version: '', preparing: false }),
  setUpdateReadyState: vi.fn(),
  subscribeUpdateReadyState: () => () => {},
}));

vi.mock('@/renderer/components/settings/useUpdateNotificationController', () => ({
  UPDATE_AVAILABLE_EVENT: 'aionui-update-available',
}));

vi.mock('@/renderer/components/settings/SettingsModal/contents/FeedbackReportModal', () => ({ default: () => null }));

import { OPEN_MIGRATION_DIALOG_EVENT } from '@/renderer/components/settings/UpdateMigrationDialog';
import AboutModalContent from '@/renderer/components/settings/SettingsModal/contents/AboutModalContent';

describe('About panel check-update in discontinued build', () => {
  beforeEach(() => {
    vi.stubGlobal('__APP_VERSION__', '2.1.40');
  });

  afterEach(() => {
    cleanup();
    mocks.runUpdateCheck.mockClear();
    vi.unstubAllGlobals();
  });

  it('dispatches migration event and skips version detection', async () => {
    const listener = vi.fn();
    window.addEventListener(OPEN_MIGRATION_DIALOG_EVENT, listener);

    render(<AboutModalContent />);
    const check = screen.getByRole('button', { name: 'settings.checkForUpdates' });
    await waitFor(() => expect(check).toBeEnabled());
    fireEvent.click(check);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(mocks.runUpdateCheck).not.toHaveBeenCalled();

    window.removeEventListener(OPEN_MIGRATION_DIALOG_EVENT, listener);
  });
});
