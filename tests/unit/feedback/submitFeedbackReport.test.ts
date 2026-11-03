import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { submitFeedbackReport } from '@/renderer/services/feedback/submitFeedbackReport';
import { downloadTextContent } from '@/renderer/utils/file/download';

vi.mock('@/renderer/utils/file/download', () => ({ downloadTextContent: vi.fn() }));
vi.mock('@/common/adapter/httpBridge', () => ({ httpRequest: vi.fn() }));

describe('local feedback export', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('window', { electronAPI: undefined });
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('downloads a self-contained report with lossless attachments without contacting a report server', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await submitFeedbackReport({
      description: ' A local problem ',
      module: 'chat',
      moduleLabel: 'Chat',
      attachments: [{ filename: 'screenshot.png', contentType: 'image/png', data: new Uint8Array([0, 128, 255]) }],
      tags: { source: 'manual' },
      extra: { local: true },
    });
    const report = JSON.parse(vi.mocked(downloadTextContent).mock.calls[0][0]);
    expect(report).toMatchObject({
      schema: 'aelix-studio.feedback/1',
      description: 'A local problem',
      tags: { source: 'manual' },
    });
    expect(report.attachments[0]).toEqual({
      filename: 'screenshot.png',
      contentType: 'image/png',
      encoding: 'base64',
      data: 'AID/',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('includes explicitly collected local logs and their collection status', async () => {
    vi.stubGlobal('window', {
      electronAPI: { collectFeedbackLogs: vi.fn().mockResolvedValue({ filename: 'logs.gz', data: [1, 2, 3] }) },
    });
    await submitFeedbackReport({
      description: 'startup failed',
      module: 'installation',
      moduleLabel: 'Installation',
      collectLogs: true,
    });
    const report = JSON.parse(vi.mocked(downloadTextContent).mock.calls[0][0]);
    expect(report.collection.logs).toBe('collected');
    expect(report.attachments[0]).toMatchObject({ filename: 'logs.gz', data: 'AQID' });
  });

  it('records collection failure in the local report instead of dropping the report', async () => {
    vi.stubGlobal('window', {
      electronAPI: { collectFeedbackLogs: vi.fn().mockRejectedValue(new Error('unavailable')) },
    });
    await submitFeedbackReport({ description: 'problem', module: 'chat', moduleLabel: 'Chat', collectLogs: true });
    expect(JSON.parse(vi.mocked(downloadTextContent).mock.calls[0][0]).collection.logs).toBe('failed');
  });

  it('reports a local download failure to the caller', async () => {
    vi.mocked(downloadTextContent).mockImplementationOnce(() => {
      throw new Error('disk unavailable');
    });
    await expect(submitFeedbackReport({ description: 'problem', module: 'chat', moduleLabel: 'Chat' })).rejects.toThrow(
      'disk unavailable'
    );
  });
});
