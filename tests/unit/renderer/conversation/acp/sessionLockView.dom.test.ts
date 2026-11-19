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
      renewViewLease: { invoke: renew },
    },
  },
}));

import { useSessionLockView } from '@/renderer/pages/conversation/platforms/acp/SessionHolder/useSessionLockView';
import { resetEnsureConversationRuntimeStateForTests } from '@/renderer/pages/conversation/utils/ensureConversationRuntime';

const flush = () => act(async () => {});
const mount = (id = 'conversation') => renderHook(() => useSessionLockView(id));
const triggerEnsure = async (view: ReturnType<typeof mount>) => view.result.current();
const dispatchPageHide = (persisted: boolean) => {
  const event = Object.assign(new Event('pagehide'), { persisted });
  window.dispatchEvent(event);
};

beforeEach(() => {
  vi.useFakeTimers();
  resetEnsureConversationRuntimeStateForTests();
  ensure.mockReset().mockResolvedValue({ config_options: [] });
  renew.mockReset().mockResolvedValue(undefined);
  release.mockReset().mockResolvedValue({ outcome: 'released' });
});

afterEach(() => vi.useRealTimers());

describe('Studio conversation lock lifecycle', () => {
  it('uses the same view identity to ensure, renew and depart', async () => {
    const view = mount();
    await triggerEnsure(view);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(renew).toHaveBeenCalledWith(ensure.mock.calls[0][0]);
    view.unmount();
    expect(release).toHaveBeenCalledWith(ensure.mock.calls[0][0]);
  });

  it('sends a keepalive departure on page close even with a heartbeat in flight', async () => {
    renew.mockReturnValueOnce(new Promise(() => {}));
    release.mockResolvedValueOnce({ outcome: 'deferred' });
    const view = mount();
    await triggerEnsure(view);
    await vi.advanceTimersByTimeAsync(30_000);
    dispatchPageHide(false);
    await flush();
    expect(release).toHaveBeenCalledWith(renew.mock.calls[0][0]);
    view.unmount();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(release).toHaveBeenCalledTimes(1);
    expect(renew).toHaveBeenCalledTimes(1);
  });

  it('keeps a back-forward cache view open', async () => {
    const view = mount();
    dispatchPageHide(true);
    expect(release).not.toHaveBeenCalled();
    view.unmount();
  });

  it('reopens with a fresh identity while earlier heartbeat and departure responses are stalled', async () => {
    renew.mockReturnValueOnce(new Promise(() => {}));
    release.mockReturnValueOnce(new Promise(() => {}));
    const old = mount();
    await triggerEnsure(old);
    await vi.advanceTimersByTimeAsync(30_000);
    old.unmount();

    const reopened = mount();
    await triggerEnsure(reopened);
    expect(release).toHaveBeenCalledWith(ensure.mock.calls[0][0]);
    expect(ensure.mock.calls[1][0].view_id).not.toBe(ensure.mock.calls[0][0].view_id);
    reopened.unmount();
  });

  it('does not defer departure behind the initial runtime response', async () => {
    ensure.mockReturnValueOnce(new Promise(() => {}));
    const view = mount();
    void triggerEnsure(view);
    view.unmount();
    expect(release).toHaveBeenCalledWith(ensure.mock.calls[0][0]);
  });

  it('leaves a failed departure to the host fallback and permits a fresh ensure', async () => {
    release.mockRejectedValueOnce(new Error('connection lost'));
    mount().unmount();
    await flush();
    const reopened = mount();
    await triggerEnsure(reopened);
    expect(ensure).toHaveBeenCalledTimes(1);
    reopened.unmount();
  });
});
