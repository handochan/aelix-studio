import { afterEach, describe, expect, it, vi } from 'vitest';
import { STUDIO_NETWORK_POLICY } from '@/common/config/constants';
import { submitFeedbackReport } from '@/renderer/services/feedback/submitFeedbackReport';

afterEach(() => vi.unstubAllGlobals());

describe('self-hosted diagnostics policy', () => {
  it('disables automatic release checks and telemetry', () => {
    expect(STUDIO_NETWORK_POLICY).toEqual({ telemetry: false, automaticUpdates: false });
  });

  it('rejects online reports before collecting local logs or diagnostics', async () => {
    const collectFeedbackLogs = vi.fn();
    vi.stubGlobal('window', { electronAPI: { collectFeedbackLogs } });
    await expect(
      submitFeedbackReport({
        module: 'other',
        moduleLabel: 'Other',
        description: 'Local incident',
        collectLogs: true,
      })
    ).rejects.toThrow('Online feedback is disabled');
    expect(collectFeedbackLogs).not.toHaveBeenCalled();
  });
});
