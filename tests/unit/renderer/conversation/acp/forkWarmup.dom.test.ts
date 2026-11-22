import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BackendHttpError } from '@/common/adapter/httpBridge';

const mocks = vi.hoisted(() => ({
  fork: vi.fn(),
  ensure: vi.fn(),
  navigate: vi.fn(),
  error: vi.fn(),
}));
vi.mock('@/common', () => ({
  ipcBridge: {
    conversation: {
      fork: { invoke: mocks.fork },
      ensureRuntime: { invoke: mocks.ensure },
    },
  },
}));
vi.mock('@arco-design/web-react', () => ({ Message: { error: mocks.error } }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (value: string) => value }) }));
vi.mock('react-router-dom', () => ({ useNavigate: () => mocks.navigate }));

import { useForkConversation } from '@/renderer/hooks/chat/useForkConversation';

describe('ACP fork runtime preparation', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it.each(['acp', 'antigravity'])('lets the mounted %s destination warm its runtime', async (type) => {
    mocks.fork.mockResolvedValue({ id: 'child', type });
    const hook = renderHook(() => useForkConversation('parent'));
    await act(() => hook.result.current('message'));
    expect(mocks.navigate).toHaveBeenCalledWith('/conversation/child');
    expect(mocks.ensure).not.toHaveBeenCalled();
  });

  it.each([
    ['legacy message', new Error('FORK_HEAD_CHANGED')],
    [
      'structured code',
      new BackendHttpError({ method: 'POST', path: '/api/fork', status: 409, body: { code: 'FORK_HEAD_CHANGED' } }),
    ],
  ])('surfaces a guarded fork materialization failure from a %s before navigating', async (_kind, failure) => {
    mocks.fork.mockResolvedValue({ id: 'child', type: 'acp' });
    mocks.ensure.mockRejectedValue(failure);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const hook = renderHook(() => useForkConversation('parent', true));
      await act(() => hook.result.current('message', 'native-head'));
      expect(mocks.ensure).toHaveBeenCalledWith({ conversation_id: 'child' });
      expect(mocks.navigate).not.toHaveBeenCalled();
      expect(mocks.error).toHaveBeenCalledWith('messages.fork.errorHeadChanged');
    } finally {
      log.mockRestore();
    }
  });
});
