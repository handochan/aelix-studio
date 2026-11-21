/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, it, expect, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import React from 'react';

const writeRendererLogInvoke = vi.hoisted(() => vi.fn(() => Promise.resolve()));

vi.mock('@/common', () => ({
  ipcBridge: {
    fs: {
      getImageBase64: { invoke: vi.fn(() => Promise.resolve('')) },
      readFile: { invoke: vi.fn(() => Promise.resolve('')) },
    },
    application: {
      writeRendererLog: { invoke: writeRendererLogInvoke },
    },
  },
}));

vi.mock('@/renderer/pages/conversation/Preview/components/editors/OfflineMonacoEditor', () => ({
  default: ({ value }: { value: string }) => <div data-testid='monaco-editor'>{value}</div>,
}));

vi.mock('@arco-design/web-react', () => ({
  Message: {
    useMessage: () => [{ info: vi.fn(), success: vi.fn(), error: vi.fn() }, null],
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

import HTMLViewer from '@/renderer/pages/conversation/Preview/components/viewers/HTMLViewer';
import HTMLRenderer from '@/renderer/pages/conversation/Preview/components/renderers/HTMLRenderer';
import WebviewHost from '@/renderer/components/media/WebviewHost';

function createConsoleMessageEvent({
  level,
  line,
  message,
  sourceId,
}: {
  level: number;
  line: number;
  message: string;
  sourceId: string;
}): Event {
  const event = new Event('console-message');
  Object.defineProperties(event, {
    level: { value: level },
    line: { value: line },
    message: { value: message },
    sourceId: { value: sourceId },
  });
  return event;
}

describe('HTMLViewer', () => {
  it('renders iframe with HTML content', () => {
    const { container } = render(<HTMLViewer content='<h1>Test</h1>' />);
    const iframe = container.querySelector('iframe');
    expect(iframe).toBeInTheDocument();
  });

  it('hides toolbar when hideToolbar is true', () => {
    const { container } = render(<HTMLViewer content='<h1>Test</h1>' hideToolbar />);
    expect(container.querySelector('[class*="toolbar"]')).not.toBeInTheDocument();
  });

  it('accepts file_path prop', () => {
    const { container } = render(<HTMLViewer content='<h1>Test</h1>' file_path='/test/index.html' />);
    expect(container.querySelector('iframe')).toBeInTheDocument();
  });
});

it('navigates with a URL retrieved from the webview instead of the console signal', async () => {
  const targetUrl = 'https://example.test/private-preview?grant=private-token';
  const { container } = render(<WebviewHost url='https://example.test/' />);
  const webview = container.querySelector('webview');
  const executeJavaScript = vi.fn().mockResolvedValue(targetUrl);
  Object.defineProperty(webview, 'executeJavaScript', { value: executeJavaScript });

  webview?.dispatchEvent(
    createConsoleMessageEvent({ level: 1, line: 0, message: '__WEBVIEW_HOST_NAVIGATE__:1', sourceId: 'private' })
  );

  expect(executeJavaScript).toHaveBeenCalledExactlyOnceWith('window.__aionuiTakeNavigationUrl?.(1)');
  await waitFor(() => expect(webview).toHaveAttribute('src', targetUrl));
});

describe('HTMLRenderer', () => {
  const electronAPI = {};

  afterEach(() => {
    Reflect.deleteProperty(window, 'electronAPI');
    vi.clearAllMocks();
  });

  it('loads clean local HTML files through file URL in Electron', () => {
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: electronAPI,
    });

    const { container } = render(
      <HTMLRenderer
        content='<script src="https://cdn.example.com/app.js"></script><script>localStorage.getItem("theme")</script>'
        file_path='/workspace/financial-wechat-miniapp.html'
      />
    );

    const webview = container.querySelector('webview');
    expect(webview).toBeInTheDocument();
    expect(webview?.getAttribute('src')).toBe('file:///workspace/financial-wechat-miniapp.html');
  });

  it('keeps dirty local HTML content in memory in Electron', () => {
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: electronAPI,
    });

    const dirtyProps = {
      content: '<h1>Unsaved edit</h1>',
      file_path: '/workspace/index.html',
      isDirty: true,
    } as React.ComponentProps<typeof HTMLRenderer> & { isDirty: boolean };

    const { container } = render(<HTMLRenderer {...dirtyProps} />);

    const webview = container.querySelector('webview');
    expect(webview).toBeInTheDocument();
    expect(webview?.getAttribute('src')).toContain('data:text/html');
    expect(webview?.getAttribute('src')).toContain('Unsaved%20edit');
  });

  it('writes preview source selection to the renderer log bridge', async () => {
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: electronAPI,
    });

    render(<HTMLRenderer content='<h1>Test</h1>' file_path='/workspace/financial-wechat-miniapp.html' />);

    await waitFor(() =>
      expect(writeRendererLogInvoke).toHaveBeenCalledWith({
        level: 'info',
        tag: 'HTMLRenderer',
        message: 'html_preview_source_selected',
        data: {
          source: 'file',
          reason: 'clean-local-file',
          hasFilePath: true,
          isDirty: false,
          contentLength: 13,
        },
      })
    );
  });

  it('writes only metadata for level 2 preview console warnings', async () => {
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: electronAPI,
    });

    const { container } = render(<HTMLRenderer content='<h1>Test</h1>' file_path='/workspace/index.html' />);
    const webview = container.querySelector('webview');

    await waitFor(() => expect(writeRendererLogInvoke).toHaveBeenCalled());
    vi.clearAllMocks();

    const marker = 'C:\\workspace\\private-preview "body"';
    webview?.dispatchEvent(
      createConsoleMessageEvent({
        level: 2,
        line: 64,
        message: marker,
        sourceId: 'file:///private/workspace/index.html',
      })
    );

    await waitFor(() =>
      expect(writeRendererLogInvoke).toHaveBeenCalledWith({
        level: 'warn',
        tag: 'HTMLRenderer',
        message: 'html_preview_console_warning',
        data: {
          level: 2,
          line: 64,
          messageLength: marker.length,
        },
      })
    );
  });

  it('retrieves inspected HTML by numeric signal without logging the selected HTML', async () => {
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: electronAPI });
    const onElementSelected = vi.fn();
    const { container } = render(<HTMLRenderer content='<p>Example</p>' onElementSelected={onElementSelected} />);
    const webview = container.querySelector('webview');
    const element = { html: '<img src="/workspace/private-image.png">', tag: 'img' };
    const executeJavaScript = vi.fn().mockResolvedValue(element);
    Object.defineProperty(webview, 'executeJavaScript', { value: executeJavaScript });

    webview?.dispatchEvent(
      createConsoleMessageEvent({ level: 1, line: 0, message: '__INSPECT_ELEMENT__1', sourceId: 'private' })
    );

    expect(executeJavaScript).toHaveBeenCalledExactlyOnceWith('window.__aionuiTakeInspectedElement?.(1)');
    await waitFor(() => expect(onElementSelected).toHaveBeenCalledExactlyOnceWith(element));
  });
});
