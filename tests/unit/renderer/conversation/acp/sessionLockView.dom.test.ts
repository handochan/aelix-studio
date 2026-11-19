import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { ensure, release, renew } = vi.hoisted(() => ({
  ensure: vi.fn(),
  release: vi.fn(),
  renew: vi.fn(),
}));
vi.mock('@/common', () => ({
  ipcBridge: {
    conversation: {
      ensureRuntime: { invoke: ensure },
      releaseRuntime: { invoke: release },
      activeLease: { invoke: renew },
    },
  },
}));

import { useSessionLockView } from '@/renderer/pages/conversation/platforms/acp/SessionHolder/useSessionLockView';
import {
  ensureConversationRuntime,
  resetEnsureConversationRuntimeStateForTests,
} from '@/renderer/pages/conversation/utils/ensureConversationRuntime';

const flush = () => act(async () => {});
const mount = (id = 'conversation') => renderHook(() => useSessionLockView(id));
const releaseReply = (outcome: string) => ({ outcome });

beforeEach(() => {
  vi.useFakeTimers();
  resetEnsureConversationRuntimeStateForTests();
  ensure.mockReset().mockResolvedValue({ config_options: [] });
  renew.mockReset().mockResolvedValue(undefined);
  release.mockReset().mockResolvedValue(releaseReply('released'));
});

afterEach(() => vi.useRealTimers());

describe('Studio conversation lock lifecycle', () => {
  it('renews the open view and retires only its own lease on departure', async () => {
    const view = mount();
    await flush();
    expect(release).not.toHaveBeenCalled();
    view.unmount();
    await flush();
    expect(release).toHaveBeenCalledWith(renew.mock.calls[0][0]);
  });

  it('retries a deferred release while the view has left', async () => {
    release.mockResolvedValueOnce(releaseReply('busy'));
    mount().unmount();
    await flush();
    expect(release).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(release).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(release).toHaveBeenCalledTimes(2);
  });

  it('cancels deferred retries when the conversation returns', async () => {
    release.mockResolvedValueOnce(releaseReply('busy'));
    mount().unmount();
    await flush();
    const reopened = mount();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(release).toHaveBeenCalledTimes(1);
    reopened.unmount();
    await flush();
  });

  it('waits for an in-flight warmup before requesting release', async () => {
    let finish = () => {};
    ensure.mockImplementationOnce(() => new Promise<void>((resolve) => (finish = resolve)));
    const view = mount();
    void ensureConversationRuntime('conversation');
    view.unmount();
    await flush();
    expect(release).not.toHaveBeenCalled();
    finish();
    await flush();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('waits for an in-flight release before warming the conversation again', async () => {
    let finish = (_value: unknown) => {};
    release.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    mount().unmount();
    await flush();
    const reopened = mount();
    const warmup = ensureConversationRuntime('conversation');
    expect(ensureConversationRuntime('conversation')).toBe(warmup);
    expect(ensure).not.toHaveBeenCalled();
    finish(releaseReply('released'));
    await warmup;
    expect(ensure).toHaveBeenCalledTimes(1);
    reopened.unmount();
    await flush();
  });

  it('leaves transport failures to the host idle fallback', async () => {
    release.mockRejectedValueOnce(new Error('connection lost'));
    mount().unmount();
    await flush();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('requests release on page close without relying on React cleanup', async () => {
    const view = mount();
    window.dispatchEvent(new Event('pagehide'));
    view.unmount();
    await flush();
    expect(release).toHaveBeenCalledTimes(1);
  });
});
