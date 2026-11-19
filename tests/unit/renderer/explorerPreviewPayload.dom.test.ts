/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

// Coverage for the Explorer file-open payload builder. Every explorer file maps
// to a Project ChatFileRef and goes through the shared resolvePreviewPayload
// gate: one metadata call yields size (the ceiling check) and lastModified (the
// save-time If-Match), then text/image read content over /api/fs/content
// (utf8/dataurl) while pdf/office read none. Oversized files are never read. No
// WS fs/resolve, no file_path/workspace exposed.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { Message } from '@arco-design/web-react';
import { BackendHttpError } from '@/common/adapter/httpBridge';

// Record ipcBridge.fs calls + script their returns per test.
const h = vi.hoisted(() => ({
  readContent: vi.fn(),
  getContentMetadata: vi.fn(),
  resolveRef: vi.fn(),
  openPreview: vi.fn(),
}));

// Isolate the container module from React/UI + WS/IPC side effects; the builder
// under test is a pure async fn needing only fs.readContent + fs.getContentMetadata.
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock('@/renderer/pages/conversation/Preview', () => ({ usePreviewContext: () => ({ openPreview: h.openPreview }) }));
vi.mock('@/renderer/pages/conversation/Preview/context/PreviewContext', () => ({
  usePreviewContext: () => ({ openPreview: h.openPreview }),
}));
vi.mock('@/renderer/pages/conversation/explorer/currentProjectStore', () => ({
  getCurrentProject: () => 'projectA',
}));
vi.mock('@/renderer/hooks/context/ConversationContext', () => ({
  useConversationContextSafe: () => ({ workspace: '/project' }),
}));
vi.mock('@/common', () => ({
  ipcBridge: {
    project: { get: { invoke: () => Promise.resolve() }, resolveRef: { invoke: h.resolveRef } },
    fs: { readContent: { invoke: h.readContent }, getContentMetadata: { invoke: h.getContentMetadata } },
  },
}));
vi.mock('@/renderer/pages/conversation/explorer/monitorTransport', () => ({ initExplorerRuntime: () => ({}) }));

import { buildExplorerPreviewPayload } from '@/renderer/pages/conversation/explorer/ExplorerContainer';
import { usePreviewLauncher } from '@/renderer/hooks/file/usePreviewLauncher';
import { useLocalFilePreview } from '@/renderer/pages/conversation/Preview/hooks/useLocalFilePreview';
import { resolveAnalyticsFilePreview } from '@/renderer/utils/file/previewPayload';

const TEXT_CEILING = 1024 * 1024;
const IMAGE_CEILING = 20 * 1024 * 1024;

/** Backend metadata shape (already camelCased by the ipcBridge response map). */
const meta = (size: number, lastModified = 1_700_000_000_000) => ({
  name: 'x',
  path: '/abs/x',
  size,
  type: 'file',
  lastModified,
});

describe('project document preview entry points', () => {
  const fileRef = { kind: 'project', pe_id: 'peA', relative_path: 'workspace/index.html' };

  afterEach(() => {
    h.openPreview.mockReset();
    vi.unstubAllGlobals();
  });

  it('waits for classification before mounting a tracked HTML file or its fallback', async () => {
    let classifyAsSource!: (mode: string) => void;
    const classify = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          classifyAsSource = resolve;
        })
    );
    vi.stubGlobal('electronAPI', { analyticsPreview: { classify } });
    h.resolveRef.mockResolvedValue({ file: fileRef });
    h.getContentMetadata.mockReset().mockResolvedValue(meta(60));
    h.readContent.mockReset().mockResolvedValue('<script>document.title = "from disk";</script>');
    const hook = renderHook(() => usePreviewLauncher());
    await act(async () => {
      const pending = hook.result.current.launchPreview({
        relativePath: fileRef.relative_path,
        contentType: 'html',
        editable: true,
        fallbackContent: '<script>document.title = "fallback";</script>',
      });
      await vi.waitFor(() => expect(classify).toHaveBeenCalled());
      expect(h.openPreview).not.toHaveBeenCalled();
      classifyAsSource('source-only');
      await pending;
    });
    expect(h.openPreview).toHaveBeenCalledExactlyOnceWith(
      '<script>document.title = "from disk";</script>',
      'code',
      expect.objectContaining({ sourceOnly: true, editable: false })
    );
    expect(h.openPreview.mock.calls[0][2]).not.toHaveProperty('file_path');
  });

  it('does not open a file link or offer a raw URL after Analytics rejects classification', async () => {
    const classify = vi.fn().mockRejectedValue(new Error('Analytics project marker is unavailable'));
    vi.stubGlobal('electronAPI', { analyticsPreview: { classify } });
    h.resolveRef.mockResolvedValue({ file: fileRef });
    const failure = vi.spyOn(Message, 'error').mockImplementation(() => '' as never);
    try {
      const hook = renderHook(() => useLocalFilePreview('/project'));
      await act(async () => {
        await hook.result.current('/project/workspace/index.html');
      });
      expect(classify).toHaveBeenCalledWith({ projectId: 'projectA', file: fileRef });
      expect(h.openPreview).not.toHaveBeenCalled();
      expect(failure).toHaveBeenCalled();
    } finally {
      failure.mockRestore();
    }
  });

  it('uses source-only when a desktop file has no project classifier', async () => {
    const classify = vi.fn();
    vi.stubGlobal('electronAPI', { analyticsPreview: { classify } });
    h.getContentMetadata.mockReset().mockResolvedValue(meta(40));
    h.readContent.mockReset().mockResolvedValue('<script>document.title = "local";</script>');
    const document = await resolveAnalyticsFilePreview({
      fileRef: { kind: 'local', path: '/project/workspace/index.html' },
      contentType: 'html',
    });
    expect(document).toMatchObject({ contentType: 'code', metadata: { sourceOnly: true, editable: false } });
    expect(classify).not.toHaveBeenCalled();
  });

  it('does not treat an ordinary SVG classification as permission to mount an HTML renderer', async () => {
    const classify = vi.fn().mockResolvedValue('ordinary');
    vi.stubGlobal('electronAPI', { analyticsPreview: { classify } });
    h.getContentMetadata.mockReset().mockResolvedValue(meta(40));
    h.readContent.mockReset().mockResolvedValue('<svg><script>document.title = "svg";</script></svg>');
    const document = await resolveAnalyticsFilePreview({
      projectId: 'projectA',
      fileRef: { ...fileRef, relative_path: 'workspace/chart.svg' },
      contentType: 'html',
    });
    expect(classify).toHaveBeenCalled();
    expect(document).toMatchObject({ contentType: 'code', metadata: { sourceOnly: true } });
  });

  it('does not promote an inert diff request for HTML into an executable preview', async () => {
    const classify = vi.fn().mockResolvedValue('isolated');
    vi.stubGlobal('electronAPI', { analyticsPreview: { classify } });
    expect(await resolveAnalyticsFilePreview({ projectId: 'projectA', fileRef, contentType: 'diff' })).toBeUndefined();
    expect(classify).not.toHaveBeenCalled();
  });

  const missingFile = () =>
    new BackendHttpError({
      method: 'POST',
      path: '/api/fs/content/metadata',
      status: 404,
      body: { code: 'FILE_NOT_FOUND' },
    });

  it.each(['/project/workspace/index.html', 'C:\\project\\workspace\\index.html'])(
    'uses the real absolute diff path to confirm a missing file at %s',
    async (filename) => {
      const local = { kind: 'local', path: filename };
      const classify = vi.fn().mockResolvedValue('missing');
      vi.stubGlobal('electronAPI', { analyticsPreview: { classify } });
      h.resolveRef.mockResolvedValue({ file: local });
      h.getContentMetadata.mockReset().mockRejectedValue(missingFile());
      h.readContent.mockReset();
      const captured = '<script>document.title = "captured";</script>';
      const hook = renderHook(() => usePreviewLauncher());
      await act(async () => {
        await hook.result.current.launchPreview({
          relativePath: local.path,
          contentType: 'html',
          editable: true,
          fallbackContent: captured,
        });
      });
      expect(h.resolveRef).toHaveBeenLastCalledWith({ project_id: 'projectA', file: local });
      expect(classify).toHaveBeenCalledWith({ projectId: 'projectA', file: local });
      expect(h.openPreview).toHaveBeenCalledExactlyOnceWith(
        captured,
        'code',
        expect.objectContaining({ sourceOnly: true, editable: false, fileRef: undefined })
      );
      expect(h.openPreview.mock.calls[0][2]).not.toHaveProperty('file_path');
      expect(h.readContent).not.toHaveBeenCalled();
    }
  );

  it('refuses parent traversal instead of checking a rewritten path for the fallback', async () => {
    const classify = vi.fn().mockResolvedValue('missing');
    vi.stubGlobal('electronAPI', { analyticsPreview: { classify } });
    h.resolveRef.mockClear();
    const hook = renderHook(() => usePreviewLauncher());
    await act(async () => {
      await hook.result.current.launchPreview({
        relativePath: '../outside.html',
        contentType: 'html',
        editable: true,
        fallbackContent: '<h1>Captured</h1>',
      });
    });
    expect(hook.result.current.errorKind).toBe('sandbox');
    expect(h.resolveRef).not.toHaveBeenCalled();
    expect(classify).not.toHaveBeenCalled();
    expect(h.openPreview).not.toHaveBeenCalled();
  });

  it('keeps the fallback inert when a previously ordinary file disappears before its read', async () => {
    const classify = vi.fn().mockResolvedValueOnce('ordinary').mockResolvedValueOnce('missing');
    vi.stubGlobal('electronAPI', { analyticsPreview: { classify } });
    h.resolveRef.mockResolvedValue({ file: fileRef });
    h.getContentMetadata.mockReset().mockResolvedValue(meta(60));
    h.readContent.mockReset().mockRejectedValue(missingFile());
    const captured = '<script>document.title = "captured";</script>';
    const hook = renderHook(() => usePreviewLauncher());
    await act(async () => {
      await hook.result.current.launchPreview({
        relativePath: fileRef.relative_path,
        contentType: 'html',
        editable: true,
        fallbackContent: captured,
      });
    });
    expect(classify).toHaveBeenCalledTimes(2);
    expect(h.openPreview).toHaveBeenCalledExactlyOnceWith(
      captured,
      'code',
      expect.objectContaining({ sourceOnly: true, editable: false, fileRef: undefined })
    );
  });

  it.each(['opaque 404', 'explicit refusal'])('does not show the captured HTML after %s', async (failure) => {
    const classify = vi.fn().mockResolvedValue('ordinary');
    if (failure === 'opaque 404') classify.mockResolvedValueOnce('ordinary').mockResolvedValueOnce('source-only');
    else classify.mockRejectedValue(new Error('Analytics preview file refused'));
    vi.stubGlobal('electronAPI', { analyticsPreview: { classify } });
    h.resolveRef.mockResolvedValue({ file: fileRef });
    h.getContentMetadata.mockReset().mockRejectedValue(missingFile());
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const hook = renderHook(() => usePreviewLauncher());
      await act(async () => {
        await hook.result.current.launchPreview({
          relativePath: fileRef.relative_path,
          contentType: 'html',
          editable: true,
          fallbackContent: '<script>document.title = "captured";</script>',
        });
      });
      expect(h.openPreview).not.toHaveBeenCalled();
      expect(hook.result.current.errorKind).not.toBeNull();
    } finally {
      log.mockRestore();
    }
  });
});

describe('buildExplorerPreviewPayload', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('opens a recognized Analytics HTML file without using the editor read gate', async () => {
    const classify = vi.fn().mockResolvedValue('isolated');
    vi.stubGlobal('electronAPI', { analyticsPreview: { classify } });
    h.getContentMetadata.mockClear();
    h.readContent.mockClear();

    const out = await buildExplorerPreviewPayload('peA', '분석 project/workspace/index.html', 'projectA');

    expect(out.metadata).toMatchObject({ analyticsProjectId: 'projectA', editable: false });
    expect(out.content).toBe('');
    expect(classify).toHaveBeenCalledWith({ projectId: 'projectA', file: out.metadata.fileRef });
    expect(h.getContentMetadata).not.toHaveBeenCalled();
    expect(h.readContent).not.toHaveBeenCalled();
  });

  it('keeps the editor size gate for non-Analytics HTML in an ordinary workspace folder', async () => {
    vi.stubGlobal('electronAPI', { analyticsPreview: { classify: vi.fn().mockResolvedValue('ordinary') } });
    h.getContentMetadata.mockReset().mockResolvedValue(meta(TEXT_CEILING + 1));
    h.readContent.mockReset();

    const out = await buildExplorerPreviewPayload('peA', 'workspace/index.html', 'projectA');

    expect(out.metadata.analyticsProjectId).toBeUndefined();
    expect(out.metadata.oversized).toBe(true);
    expect(h.readContent).not.toHaveBeenCalled();
  });

  it.each(['workspace/index.html', 'artifacts/reports/monthly/rev/content/chart.svg'])(
    'reads an unclassified document as read-only source for %s',
    async (file) => {
      vi.stubGlobal('electronAPI', { analyticsPreview: { classify: vi.fn().mockResolvedValue('source-only') } });
      const content = '<script>document.body.textContent = "rendered";</script>';
      h.getContentMetadata.mockReset().mockResolvedValue(meta(content.length));
      h.readContent.mockReset().mockResolvedValue(content);

      const out = await buildExplorerPreviewPayload('peA', file, 'projectA');
      expect(out).toMatchObject({ contentType: 'code', content, metadata: { editable: false, sourceOnly: true } });
      expect(out.metadata).not.toHaveProperty('analyticsProjectId');
      expect(h.readContent).toHaveBeenCalledWith({ file: out.metadata.fileRef, encoding: 'utf8' });
    }
  );

  it('uses the text limit for an unclassified SVG', async () => {
    vi.stubGlobal('electronAPI', { analyticsPreview: { classify: vi.fn().mockResolvedValue('source-only') } });
    h.getContentMetadata.mockReset().mockResolvedValue(meta(TEXT_CEILING + 1));
    h.readContent.mockReset();

    const out = await buildExplorerPreviewPayload('peA', 'workspace/logo.svg', 'projectA');
    expect(out).toMatchObject({ content: '', metadata: { oversized: true, sourceOnly: true, editable: false } });
    expect(h.readContent).not.toHaveBeenCalled();
  });
  it('image: reads dataurl content over /content, carries a Project ref, no file_path', async () => {
    h.getContentMetadata.mockReset().mockResolvedValue(meta(1234));
    h.readContent.mockReset().mockResolvedValue('data:image/png;base64,QUJD');
    const out = await buildExplorerPreviewPayload('peA', 'pics/logo.png');

    // Content read by ChatFileRef identity (backend prepends the data-URL prefix).
    expect(h.readContent).toHaveBeenCalledWith({
      file: { kind: 'project', pe_id: 'peA', relative_path: 'pics/logo.png' },
      encoding: 'dataurl',
    });
    expect(out.contentType).toBe('image');
    expect(out.content).toBe('data:image/png;base64,QUJD');
    expect(out.metadata.fileRef).toEqual({ kind: 'project', pe_id: 'peA', relative_path: 'pics/logo.png' });
    expect(out.metadata.editable).toBe(false);
    expect(out.metadata.oversized).toBe(false);
  });

  it('image: empty content stays empty (backend decides encoding/prefix)', async () => {
    h.getContentMetadata.mockReset().mockResolvedValue(meta(10));
    h.readContent.mockReset().mockResolvedValue('');
    const out = await buildExplorerPreviewPayload('peA', 'x.png');
    expect(out.content).toBe('');
  });

  it.each(['reports/q2.pdf', 'r.docx', 's.xlsx', 'd.pptx'])(
    'pdf/office: no content read and no fs/resolve — rendered from the Project ref: %s',
    async (rel) => {
      h.getContentMetadata.mockReset().mockResolvedValue(meta(500));
      h.readContent.mockReset();
      const out = await buildExplorerPreviewPayload('peA', rel);

      expect(h.readContent).not.toHaveBeenCalled(); // never reads content for these
      expect(out.content).toBe('');
      expect(out.metadata.fileRef).toEqual({ kind: 'project', pe_id: 'peA', relative_path: rel });
    }
  );

  // pdf/office carry no size ceiling (nothing is read into an editor), but they
  // still fetch metadata: it is what keeps the missing-file check working and
  // supplies the save-time timestamp.
  it('pdf/office still fetch metadata and carry no threshold', async () => {
    h.getContentMetadata.mockReset().mockResolvedValue(meta(900 * 1024 * 1024));
    h.readContent.mockReset();
    const out = await buildExplorerPreviewPayload('peA', 'huge.pdf');

    expect(h.getContentMetadata).toHaveBeenCalledTimes(1);
    expect(out.metadata.oversized).toBe(false); // no ceiling applies
    expect(out.metadata.thresholdBytes).toBeUndefined();
  });

  it('text: reads utf8 content over /content', async () => {
    h.getContentMetadata.mockReset().mockResolvedValue(meta(7));
    h.readContent.mockReset().mockResolvedValue('# hello');
    const out = await buildExplorerPreviewPayload('peA', 'notes/readme.md');

    expect(h.readContent).toHaveBeenCalledWith({
      file: { kind: 'project', pe_id: 'peA', relative_path: 'notes/readme.md' },
      encoding: 'utf8',
    });
    expect(out.contentType).toBe('markdown');
    expect(out.content).toBe('# hello');
    expect(out.metadata.fileRef).toEqual({ kind: 'project', pe_id: 'peA', relative_path: 'notes/readme.md' });
    // Editable like any other text. It was marked read-only here for a while, which was
    // wrong: markdown is what the panel's editor was built for. Now stated explicitly
    // rather than left undefined, because the value comes from the type table instead of
    // being inferred here.
    expect(out.metadata.editable).toBe(true);
  });

  it('code: reads utf8 and stays editable', async () => {
    h.getContentMetadata.mockReset().mockResolvedValue(meta(3));
    h.readContent.mockReset().mockResolvedValue('x=1');
    const out = await buildExplorerPreviewPayload('peA', 'main.py');
    expect(out.contentType).toBe('code');
    expect(out.content).toBe('x=1');
    expect(out.metadata.editable).toBe(true);
  });

  it('uses the file basename for title/file_name/language', async () => {
    h.getContentMetadata.mockReset().mockResolvedValue(meta(1));
    h.readContent.mockReset();
    const out = await buildExplorerPreviewPayload('peA', 'deep/dir/report.pdf');
    expect(out.metadata.title).toBe('report.pdf');
    expect(out.metadata.file_name).toBe('report.pdf');
    expect(out.metadata.language).toBe('pdf');
  });

  // The size gate. Reading part of an oversized file and letting it reach a
  // saveable editor is what previously destroyed the unread remainder.
  it('oversized text: reads no content and marks the tab read-only', async () => {
    h.getContentMetadata.mockReset().mockResolvedValue(meta(TEXT_CEILING + 1));
    h.readContent.mockReset();
    const out = await buildExplorerPreviewPayload('peA', 'logs/huge.log');

    expect(h.readContent).not.toHaveBeenCalled();
    expect(out.content).toBe('');
    expect(out.metadata.oversized).toBe(true);
    expect(out.metadata.sizeBytes).toBe(TEXT_CEILING + 1);
    expect(out.metadata.thresholdBytes).toBe(TEXT_CEILING);
    expect(out.metadata.editable).toBe(false);
  });

  it('text at exactly the ceiling is not oversized (boundary is >, not >=)', async () => {
    h.getContentMetadata.mockReset().mockResolvedValue(meta(TEXT_CEILING));
    h.readContent.mockReset().mockResolvedValue('x');
    const out = await buildExplorerPreviewPayload('peA', 'logs/exact.log');

    expect(h.readContent).toHaveBeenCalled();
    expect(out.metadata.oversized).toBe(false);
  });

  // Images get a much higher ceiling: 1MB is small for a photo, while a data URL
  // still loads the whole file into memory, so some ceiling is still needed.
  it('image uses the 20MB ceiling, not the 1MB text one', async () => {
    h.getContentMetadata.mockReset().mockResolvedValue(meta(5 * 1024 * 1024));
    h.readContent.mockReset().mockResolvedValue('data:image/png;base64,QQ==');
    const out = await buildExplorerPreviewPayload('peA', 'pics/photo.png');

    expect(h.readContent).toHaveBeenCalled(); // a 5MB image is fine
    expect(out.metadata.oversized).toBe(false);
    expect(out.metadata.thresholdBytes).toBe(IMAGE_CEILING);
  });

  it('oversized image: reads no content', async () => {
    h.getContentMetadata.mockReset().mockResolvedValue(meta(IMAGE_CEILING + 1));
    h.readContent.mockReset();
    const out = await buildExplorerPreviewPayload('peA', 'pics/huge.png');

    expect(h.readContent).not.toHaveBeenCalled();
    expect(out.metadata.oversized).toBe(true);
  });

  // The mtime rides along so the tab's first save carries an If-Match; without it
  // the backend skips conflict detection and silently overwrites.
  it('carries lastModified from the same metadata call that decided the size', async () => {
    h.getContentMetadata.mockReset().mockResolvedValue(meta(12, 1_777_000_000_123));
    h.readContent.mockReset().mockResolvedValue('body');
    const out = await buildExplorerPreviewPayload('peA', 'notes/a.txt');

    expect(out.metadata.lastModified).toBe(1_777_000_000_123);
    expect(h.getContentMetadata).toHaveBeenCalledTimes(1); // one round trip, not two
  });
});
