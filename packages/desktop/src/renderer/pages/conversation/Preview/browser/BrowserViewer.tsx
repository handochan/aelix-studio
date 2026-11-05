/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { Modal, Message } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import React, { useCallback, useEffect, useRef } from 'react';
import WebviewHost from '@/renderer/components/media/WebviewHost';
import {
  BROWSER_BLANK_URL,
  BROWSER_SESSION_PARTITION,
  browserTabLabelFromUrl,
  resolveAddressBarDestination,
} from './constants';

export interface BrowserViewerProps {
  /** 该 tab 当前地址 / Current address of this tab */
  url: string;
  /** 所属 preview tab 的 id / Id of the owning preview tab */
  tabId: string;
  /** 地址变化时回写 tab（用于持久化）/ Persist the new address back onto the tab */
  onUrlChange: (tabId: string, url: string) => void;
  /** 页面标题变化时回写 tab / Persist the page title back onto the tab */
  onTitleChange: (tabId: string, title: string) => void;
  /** 站点图标变化时回写 tab / Persist the site favicon back onto the tab */
  onFaviconChange: (tabId: string, favicon: string) => void;
}

/**
 * 应用内浏览器视图 / In-app browser view.
 *
 * 与 URLViewer 的区别在三点，也正是它单独存在的理由：
 * 1. 使用共享的持久化 partition，登录态跨 tab / 跨项目保留；
 * 2. 地址栏支持「输入关键词直接搜索」，不只是补 https://；
 * 3. 把地址 / 标题 / 图标回写给 tab，使会话重启后能恢复。
 *
 * Differs from URLViewer in exactly the three ways that justify a separate
 * component: a shared persistent partition (sign-in survives), keyword search in
 * the address bar, and writing address/title/favicon back onto the owning tab so
 * the browser can be restored after a restart.
 */
const BrowserViewer: React.FC<BrowserViewerProps> = ({ url, tabId, onUrlChange, onTitleChange, onFaviconChange }) => {
  const { t } = useTranslation();
  const intent = useRef(0);
  const granted = useRef(false);
  useEffect(() => {
    intent.current++;
    return () => {
      intent.current++;
    };
  }, [url]);
  const handleUrlChange = useCallback((next: string) => onUrlChange(tabId, next), [tabId, onUrlChange]);

  const resolveInput = useCallback(
    (raw: string): string | null => {
      const request = ++intent.current;
      const destination = resolveAddressBarDestination(raw);
      if (!destination || !destination.search) return destination?.url ?? null;
      try {
        granted.current ||= localStorage.getItem('studio.bingSearchConsent') === '1';
      } catch {
        /* Ask when storage is unavailable. */
      }
      if (granted.current) return destination.url;
      Modal.confirm({
        title: t('preview.browser.searchConsentTitle'),
        content: t('preview.browser.searchConsentDescription', { host: 'www.bing.com' }),
        okText: t('common.confirm'),
        cancelText: t('common.cancel'),
        onOk: () => {
          granted.current = true;
          try {
            localStorage.setItem('studio.bingSearchConsent', '1');
          } catch {
            /* Consent remains scoped to this view. */
          }
          if (request === intent.current) handleUrlChange(destination.url);
        },
        onCancel: () => {
          Message.info(t('preview.browser.searchDeclined'));
        },
      });
      return null;
    },
    [handleUrlChange, t]
  );

  const handleTitleChange = useCallback(
    (title: string) => {
      const trimmed = title.trim();
      if (trimmed) onTitleChange(tabId, trimmed);
    },
    [tabId, onTitleChange]
  );

  const handleFaviconChange = useCallback(
    (favicon: string) => onFaviconChange(tabId, favicon),
    [tabId, onFaviconChange]
  );

  /**
   * about:blank 不会触发 page-title-updated，所以空白页的标题在这里兜底，
   * 否则新建 tab 会一直显示上一次的标题。
   * about:blank fires no title event, so derive the label here — otherwise a
   * fresh tab would keep showing the previous page's title.
   */
  const handleDidFinishLoad = useCallback(() => {
    if (url === BROWSER_BLANK_URL) onTitleChange(tabId, browserTabLabelFromUrl(url));
  }, [url, tabId, onTitleChange]);

  return (
    <WebviewHost
      url={url || BROWSER_BLANK_URL}
      partition={BROWSER_SESSION_PARTITION}
      showNavBar
      className='bg-bg-1'
      resolveUrlInput={resolveInput}
      onUrlChange={handleUrlChange}
      onTitleChange={handleTitleChange}
      onFaviconChange={handleFaviconChange}
      onDidFinishLoad={handleDidFinishLoad}
    />
  );
};

export default BrowserViewer;
