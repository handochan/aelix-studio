import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getStatus: vi.fn(),
  start: vi.fn(),
  openExternal: vi.fn(),
  writeText: vi.fn(),
}));

vi.mock('@arco-design/web-react', async (importOriginal) => {
  const arco = await importOriginal<typeof import('@arco-design/web-react')>();
  return { ...arco, Message: { success: vi.fn(), error: vi.fn() } };
});

vi.mock('@/common/adapter/ipcBridge', () => ({
  webui: {
    getStatus: { invoke: mocks.getStatus },
    start: { invoke: mocks.start },
    statusChanged: { on: () => () => {} },
  },
  shell: { openExternal: { invoke: mocks.openExternal } },
}));
vi.mock('@/common/config/configService', () => ({
  configService: { get: () => false, set: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('@/renderer/utils/platform', () => ({ isElectronDesktop: () => true }));
vi.mock('@/renderer/hooks/assistant/useTalkToButler', () => ({ useTalkToButler: () => vi.fn() }));
vi.mock('@/renderer/components/base/AionModal', () => ({ default: () => null }));
vi.mock('@/renderer/components/base/AionScrollArea', () => ({
  default: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
}));
vi.mock('@/renderer/components/settings/SettingsModal/settingsViewContext', () => ({
  useSettingsViewMode: () => 'page',
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en-US' } }),
}));

import WebuiModalContent from '@/renderer/components/settings/SettingsModal/contents/WebuiModalContent';

describe('Desktop WebUI access link', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.openExternal.mockResolvedValue(undefined);
    mocks.writeText.mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: mocks.writeText } });
  });

  afterEach(() => vi.unstubAllGlobals());

  it('copies and opens the exact address from IPC on the first request', async () => {
    const localUrl = 'http://[::1]:28982';
    mocks.getStatus.mockResolvedValue({
      running: true,
      port: 28982,
      allowRemote: false,
      localUrl,
      adminUsername: 'admin',
    });
    render(<WebuiModalContent />);

    fireEvent.click(await screen.findByRole('button', { name: localUrl }));
    fireEvent.click(screen.getByRole('button', { name: 'common.copy' }));

    expect(mocks.openExternal).toHaveBeenCalledExactlyOnceWith(localUrl);
    expect(mocks.writeText).toHaveBeenCalledExactlyOnceWith(localUrl);
  });

  it('waits for the listener before exposing the IPv4 fallback reported by start', async () => {
    const localUrl = 'http://127.0.0.1:28983';
    mocks.getStatus.mockResolvedValue({
      running: false,
      port: 25982,
      allowRemote: false,
      localUrl: 'http://[::1]:25982',
      adminUsername: 'admin',
    });
    let finishStart: (value: { localUrl: string; port: number; allowRemote: boolean }) => void = () => {};
    mocks.start.mockReturnValue(
      new Promise((resolve) => {
        finishStart = resolve;
      })
    );
    render(<WebuiModalContent />);

    await waitFor(() => expect(mocks.getStatus).toHaveBeenCalled());
    fireEvent.click(await screen.findAllByRole('switch').then((switches) => switches[0]));
    expect(screen.queryByRole('button', { name: /http:/ })).toBeNull();

    finishStart({ localUrl, port: 28983, allowRemote: false });
    fireEvent.click(await screen.findByRole('button', { name: localUrl }));
    expect(mocks.openExternal).toHaveBeenCalledExactlyOnceWith(localUrl);
  });
});
