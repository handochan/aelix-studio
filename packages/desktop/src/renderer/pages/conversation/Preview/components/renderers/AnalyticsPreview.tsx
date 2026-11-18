/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Button } from '@arco-design/web-react';
import { Left, Right } from '@icon-park/react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AnalyticsPreviewHandle, AnalyticsPreviewRequest } from '@/common/utils/analyticsPreview';
import { usePreviewToolbarExtras } from '../../context/PreviewToolbarExtrasContext';
import { registerTabReloader } from '../../context/tabReloaderRegistry';

type Props = AnalyticsPreviewRequest & { tabId: string };

/** Render an Explorer-approved Analytics file in the existing preview pane. */
export default function AnalyticsPreview({ projectId, file, tabId }: Props) {
  const { t } = useTranslation();
  const extras = usePreviewToolbarExtras();
  const guest = useRef<Electron.WebviewTag | null>(null);
  const guestReady = useRef(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [handle, setHandle] = useState<AnalyticsPreviewHandle | null>(null);
  const [error, setError] = useState(false);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const { pe_id, relative_path } = file;

  useEffect(() => {
    const bridge = window.electronAPI?.analyticsPreview;
    let cancelled = false;
    let url: string | undefined;
    const close = () => {
      if (url) void bridge?.close(url).catch(() => {});
    };
    setHandle(null);
    setError(false);
    setCanGoBack(false);
    setCanGoForward(false);
    void (async () => {
      try {
        const opened = await bridge?.open({ projectId, file: { kind: 'project', pe_id, relative_path } });
        url = opened?.url;
        if (cancelled) {
          close();
        } else if (opened) {
          setHandle(opened);
        } else {
          setError(true);
        }
      } catch {
        if (!cancelled) setError(true);
      }
    })();
    return () => {
      cancelled = true;
      close();
    };
  }, [projectId, pe_id, relative_path, loadAttempt]);

  useEffect(
    () =>
      registerTabReloader(tabId, () => {
        // Opening/attaching a new grant is asynchronous. Retry from the entry after a failure.
        if (!guest.current || !guestReady.current || error) setLoadAttempt((attempt) => attempt + 1);
        else guest.current.reload();
      }),
    [tabId, error]
  );

  const attachGuest = useCallback(
    (element: HTMLElement | null) => {
      const webview = element as Electron.WebviewTag | null;
      guest.current = webview;
      guestReady.current = false;
      if (!webview) return;
      const updateHistory = () => {
        setCanGoBack(webview.canGoBack());
        setCanGoForward(webview.canGoForward());
      };
      const showFailure = (event: Electron.DidFailLoadEvent) => {
        if (event.isMainFrame && event.errorCode !== -3) setError(true);
      };
      const showNavigationResult = (event: Electron.DidFrameNavigateEvent) => {
        if (!event.isMainFrame) return;
        setError(event.httpResponseCode >= 400);
        updateHistory();
      };
      const ready = () => {
        guestReady.current = true;
        updateHistory();
      };
      webview.addEventListener('did-fail-load', showFailure);
      webview.addEventListener('did-frame-navigate', showNavigationResult);
      webview.addEventListener('did-navigate-in-page', updateHistory);
      webview.addEventListener('dom-ready', ready);
      // Electron forwards target=_blank through the main-process handler only
      // when this attribute is present. The handler never creates a new window.
      if (handle) {
        webview.setAttribute('allowpopups', '');
        webview.setAttribute('src', handle.url);
      }
      return () => {
        guest.current = null;
        guestReady.current = false;
        webview.removeEventListener('did-fail-load', showFailure);
        webview.removeEventListener('did-frame-navigate', showNavigationResult);
        webview.removeEventListener('did-navigate-in-page', updateHistory);
        webview.removeEventListener('dom-ready', ready);
      };
    },
    [handle]
  );

  useEffect(() => {
    if (!extras || !handle) return;
    extras.setExtras({
      left: (
        <div className='flex items-center gap-4px'>
          <Button
            size='mini'
            type='text'
            aria-label={t('common.goBack')}
            icon={<Left />}
            disabled={!canGoBack}
            onClick={() => guest.current?.goBack()}
          />
          <Button
            size='mini'
            type='text'
            aria-label={t('common.forward')}
            icon={<Right />}
            disabled={!canGoForward}
            onClick={() => guest.current?.goForward()}
          />
        </div>
      ),
    });
    return () => extras.setExtras(null);
  }, [extras, handle, canGoBack, canGoForward, t]);

  return (
    <div className='flex flex-col flex-1 min-h-0 overflow-hidden'>
      {(!handle || error) && (
        <div role='status' className='flex flex-1 items-center justify-center px-16px text-t-secondary'>
          {t(error ? 'preview.analyticsUnavailable' : 'preview.loading')}
        </div>
      )}
      {handle && (
        <webview
          key={handle.url}
          ref={attachGuest}
          partition={handle.partition}
          data-testid='analytics-preview'
          className={error ? 'hidden' : 'flex flex-1 w-full min-h-0 border-0'}
        />
      )}
    </div>
  );
}
