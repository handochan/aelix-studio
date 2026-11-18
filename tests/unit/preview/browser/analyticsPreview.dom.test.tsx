/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AnalyticsPreviewHandle } from '@/common/utils/analyticsPreview';
import AnalyticsPreview from '@/renderer/pages/conversation/Preview/components/renderers/AnalyticsPreview';
import { reloadViaViewer } from '@/renderer/pages/conversation/Preview/context/tabReloaderRegistry';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const request = {
  projectId: 'analysis',
  file: { kind: 'project' as const, pe_id: 'root', relative_path: 'workspace/index.html' },
  tabId: 'analysis-tab',
};
const grant = {
  url: 'studio-analytics://01234567890123456789012345678901/workspace/index.html',
  partition: 'studio-analytics-preview',
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Analytics preview lifecycle', () => {
  it('releases a grant that arrives after the viewer has closed', async () => {
    let resolveGrant!: (value: AnalyticsPreviewHandle) => void;
    const open = vi.fn(
      () =>
        new Promise<AnalyticsPreviewHandle>((resolve) => {
          resolveGrant = resolve;
        })
    );
    const close = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('electronAPI', { analyticsPreview: { open, close } });
    const viewer = render(<AnalyticsPreview {...request} />);

    viewer.unmount();
    resolveGrant(grant);

    await waitFor(() => expect(close).toHaveBeenCalledWith(grant.url));
  });

  it('reopens a grant on refresh before the guest is ready and reloads a ready guest', async () => {
    const reopened = { ...grant, url: grant.url.replace('0123456789', '1234567890') };
    const open = vi.fn().mockResolvedValueOnce(grant).mockResolvedValue(reopened);
    const close = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('electronAPI', { analyticsPreview: { open, close } });
    render(<AnalyticsPreview {...request} />);

    await screen.findByTestId('analytics-preview');
    act(() => void reloadViaViewer(request.tabId));
    await waitFor(() => expect(screen.getByTestId('analytics-preview')).toHaveAttribute('src', reopened.url));

    const webview = screen.getByTestId('analytics-preview');
    const reload = vi.fn();
    Object.assign(webview, { canGoBack: () => false, canGoForward: () => false, reload });
    act(() => void webview.dispatchEvent(new Event('dom-ready')));
    act(() => void reloadViaViewer(request.tabId));

    expect(reload).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledTimes(2);
  });
});
