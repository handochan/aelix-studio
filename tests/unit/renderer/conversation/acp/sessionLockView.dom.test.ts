import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { ensure, release, releaseOnPageHide, renew } = vi.hoisted(() => ({
  ensure: vi.fn(),
  release: vi.fn(),
  releaseOnPageHide: vi.fn(),
  renew: vi.fn(),
}));
vi.mock('@/common', () => ({
  ipcBridge: {
    conversation: {
      ensureRuntime: { invoke: ensure },
      releaseRuntime: { invoke: release },
      releaseRuntimeOnPageHide: { invoke: releaseOnPageHide },
      renewViewLease: { invoke: renew },
    },
  },
}));

import { useSessionLockView } from '@/renderer/pages/conversation/platforms/acp/SessionHolder/useSessionLockView';
import { resetEnsureConversationRuntimeStateForTests } from '@/renderer/pages/conversation/utils/ensureConversationRuntime';

const flush = () => act(async () => {});
const mount = (id = 'conversation') => renderHook(() => useSessionLockView(id));
const triggerEnsure = async (view: ReturnType<typeof mount>) => view.result.current!.ensure();
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
  releaseOnPageHide.mockReset().mockResolvedValue({ outcome: 'released' });
});

afterEach(() => vi.useRealTimers());

describe('Studio conversation lock lifecycle', () => {
  it('uses the same view identity to ensure, renew and depart', async () => {
    const view = mount();
    await triggerEnsure(view);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(ensure.mock.calls[0][0]).toMatchObject(renew.mock.calls[0][0]);
    view.unmount();
    expect(ensure.mock.calls[0][0]).toMatchObject(release.mock.calls[0][0]);
  });

  it('sends a keepalive departure on page close even with a heartbeat in flight', async () => {
    renew.mockReturnValueOnce(new Promise(() => {}));
    releaseOnPageHide.mockResolvedValueOnce({ outcome: 'deferred' });
    const view = mount();
    await triggerEnsure(view);
    await vi.advanceTimersByTimeAsync(30_000);
    dispatchPageHide(false);
    await flush();
    expect(releaseOnPageHide).toHaveBeenCalledWith(renew.mock.calls[0][0]);
    view.unmount();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(releaseOnPageHide).toHaveBeenCalledTimes(1);
    expect(release).not.toHaveBeenCalled();
    expect(renew).toHaveBeenCalledTimes(1);
  });

  it('keeps a back-forward cache view open', async () => {
    const view = mount();
    dispatchPageHide(true);
    expect(releaseOnPageHide).not.toHaveBeenCalled();
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
    expect(ensure.mock.calls[0][0]).toMatchObject(release.mock.calls[0][0]);
    expect(ensure.mock.calls[1][0].view_id).not.toBe(ensure.mock.calls[0][0].view_id);
    reopened.unmount();
  });

  it('does not defer departure behind the initial runtime response', async () => {
    ensure.mockReturnValueOnce(new Promise(() => {}));
    const view = mount();
    void triggerEnsure(view).catch(() => {});
    view.unmount();
    expect(ensure.mock.calls[0][0]).toMatchObject(release.mock.calls[0][0]);
  });

  it('shares an in-flight preparation and refuses to prepare from a departed view', async () => {
    let finish = () => {};
    ensure.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    );
    const old = mount();
    const view = old.result.current!;
    const first = view.ensure();
    expect(view.ensure()).toBe(first);
    old.unmount();
    expect(ensure.mock.calls[0][0].signal.aborted).toBe(true);
    const current = mount();

    await expect(view.ensure()).rejects.toMatchObject({ name: 'AbortError' });
    finish();
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    expect(ensure).toHaveBeenCalledTimes(1);
    current.unmount();
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
