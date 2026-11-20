import { wsEmitter } from '@/common/adapter/httpBridge';
import { refreshSession } from '@/common/adapter/sessionRefresh';
import { createRequestId, INPUT_METHODS, isRecord, requestRelay, type RelayFailure } from './transport';
import type {
  RunningInputLookupResult,
  RunningInputMode,
  RunningInputOutcome,
  RunningInputReceipt,
  RunningInputSendResult,
  RunningInputSnapshot,
  RunningInputTarget,
  RunningInputTurn,
} from './types';

export type * from './types';

const MAX_TEXT_BYTES = 64 * 1024;
const MAX_VISIBLE_RECEIPTS = 256;
const MODES = ['steer', 'follow-up'] as const;

function parseTurn(value: unknown): RunningInputTurn | undefined {
  if (!isRecord(value)) return undefined;
  if (value.active === false && value.turnId === null) return { active: false, turnId: null };
  if (
    value.active === true &&
    typeof value.turnId === 'string' &&
    value.turnId.length > 0 &&
    value.turnId.length <= 128
  ) {
    return { active: true, turnId: value.turnId };
  }
  return undefined;
}

function parseOutcome(value: unknown, turnId: string): RunningInputOutcome {
  if (isRecord(value)) {
    if (value.accepted === true && value.delivery === 'native-queue' && value.turnId === turnId)
      return { status: 'queued' };
    if (value.accepted === false && (value.reason === 'stale-turn' || value.reason === 'dedup-capacity')) {
      return { status: 'rejected', reason: value.reason };
    }
  }
  return { status: 'unknown' };
}

function failureOutcome(failure: RelayFailure): RunningInputOutcome {
  const { status, code } = failure;
  if (code === 'EXT_OUTCOME_UNKNOWN' || status === 0 || status >= 500 || (status >= 200 && status < 400)) {
    return { status: 'unknown', failure };
  }
  if (status === 409 && code !== 'EXT_STALE_BINDING' && code !== 'EXT_UNAVAILABLE' && code !== 'EXT_NO_LIVE_TASK') {
    return { status: 'unknown', failure };
  }
  return { status: 'rejected', failure };
}

/**
 * Own one client per mounted conversation. Refresh after standard host turn changes and dispose on exit.
 * Ordinary sends still require both the host turn and the native turn to be idle.
 */
export function createRunningInputClient(conversationId: string) {
  const path = '/api/conversations/' + encodeURIComponent(conversationId) + '/acp-extensions';
  const listeners = new Set<() => void>();
  let snapshot: RunningInputSnapshot = { channel: { status: 'checking' }, receipts: [], sending: false };
  let binding: string | undefined;
  let discovery: { done: Promise<void>; finish: () => void; run: number } | undefined;
  let inFlightReceipt: RunningInputReceipt | undefined;
  let generation = 0;
  let disposed = false;

  function update(change: Partial<RunningInputSnapshot>): void {
    if (disposed) return;
    snapshot = { ...snapshot, ...change };
    for (const listener of listeners) listener();
  }

  function setBinding(next?: string): void {
    if (binding === next) return;
    binding = next;
    update({ receipts: [] });
  }

  async function discover(current: number): Promise<void> {
    const isCurrent = () => !disposed && current === generation;
    let reply = await requestRelay(path);
    if (
      isCurrent() &&
      reply.kind === 'failure' &&
      reply.failure.status === 401 &&
      (await refreshSession()) &&
      isCurrent()
    ) {
      reply = await requestRelay(path);
    }
    if (!isCurrent()) return;
    if (reply.kind === 'failure') {
      const { status, code } = reply.failure;
      if (status === 404 || code === 'EXT_UNAVAILABLE') {
        setBinding();
        update({ channel: { status: 'unsupported' } });
      } else {
        if (code === 'EXT_NO_LIVE_TASK' || code === 'EXT_STALE_BINDING') setBinding();
        update({ channel: { status: 'unavailable', failure: reply.failure } });
      }
      return;
    }

    const data = reply.data;
    if (
      !isRecord(data) ||
      data.version !== 1 ||
      typeof data.bindingId !== 'string' ||
      !data.bindingId ||
      !Array.isArray(data.requests)
    ) {
      setBinding();
      update({ channel: { status: 'unsupported' } });
      return;
    }
    const { bindingId } = data;
    const requests: unknown[] = data.requests;
    const modes = MODES.filter((mode) => requests.includes(INPUT_METHODS[mode]));
    if (!requests.includes(INPUT_METHODS.state) || modes.length === 0) {
      setBinding();
      update({ channel: { status: 'unsupported' } });
      return;
    }

    setBinding(bindingId);
    // H1 advertises requests only. The snapshot is read after discovery, without a socket subscription.
    const state = await requestRelay(path, { bindingId, method: INPUT_METHODS.state, payload: {} });
    if (!isCurrent()) return;
    const turn = state.kind === 'success' && isRecord(state.data) ? parseTurn(state.data.result) : undefined;
    if (turn) {
      update({
        channel: { status: 'ready', bindingId, turn, modes, canLookup: requests.includes(INPUT_METHODS.lookup) },
      });
    } else {
      update({ channel: { status: 'unavailable', failure: state.kind === 'success' ? undefined : state.failure } });
    }
  }

  function refresh(force = false): Promise<void> {
    if (disposed) return Promise.resolve();
    generation++;
    if (discovery && !force) {
      // The current observation is obsolete. A burst of signals shares one trailing read.
      if (snapshot.channel.status !== 'checking') update({ channel: { status: 'checking' } });
      return discovery.done;
    }

    // A reconnect starts a new read while existing waiters follow the latest result.
    let finish!: () => void;
    const pending = discovery ?? {
      done: new Promise<void>((resolve) => {
        finish = resolve;
      }),
      finish,
      run: 0,
    };
    discovery = pending;
    const run = ++pending.run;
    update({ channel: { status: 'checking' } });
    const isCurrentRun = () => discovery === pending && pending.run === run;
    void (async () => {
      try {
        while (isCurrentRun()) {
          const current = generation;
          // eslint-disable-next-line no-await-in-loop -- refresh signals during this read need a later observation
          await discover(current);
          if (current === generation) break;
        }
      } finally {
        if (isCurrentRun()) {
          discovery = undefined;
          pending.finish();
        }
      }
    })();
    return pending.done;
  }

  const unsubscribeReconnect = wsEmitter('realtime.reconnected').on(() => void refresh(true));

  async function settleReceipt(
    original: RunningInputReceipt,
    outcome: RunningInputOutcome
  ): Promise<RunningInputReceipt> {
    // Until discovery settles, the previous binding may still be cached but could already have been replaced.
    // eslint-disable-next-line no-await-in-loop -- a reconnect may supersede the operation being awaited
    while (discovery) await discovery.done;

    const { requestId, bindingId, turnId, mode } = original;
    const visible = snapshot.receipts.find((entry) => entry.requestId === requestId);
    const inFlight = inFlightReceipt?.requestId === requestId ? inFlightReceipt : undefined;
    const current = inFlight ?? visible ?? original;
    // A definitive lookup result survives transport uncertainty and dismissal of the notice.
    if (current.status === 'queued' || current.status === 'rejected') return current;

    const receipt = { requestId, bindingId, turnId, mode, ...outcome };
    if (inFlight) inFlightReceipt = receipt;
    if (binding === bindingId && visible) {
      update({ receipts: snapshot.receipts.map((entry) => (entry.requestId === requestId ? receipt : entry)) });
    }
    return receipt;
  }

  return {
    /** Read a stable snapshot for useSyncExternalStore. Receipts carry the binding and turn at dispatch. */
    getSnapshot: () => snapshot,

    /** Subscribe to channel, send and receipt changes. Returns an unsubscribe function. */
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    /** Rediscover the binding and read input/state after the refresh signal, without reopening a turn. */
    refresh: () => refresh(),

    /**
     * Submit text for the captured binding and turn. Leave attachments in the composer.
     * Clear the submitted draft only if it still matches the composer and preserveDraft is false.
     */
    async send(mode: RunningInputMode, target: RunningInputTarget, message: string): Promise<RunningInputSendResult> {
      if (snapshot.sending) return { status: 'skipped', reason: 'busy', preserveDraft: true };
      const { channel } = snapshot;
      if (
        disposed ||
        channel.status !== 'ready' ||
        target.bindingId !== channel.bindingId ||
        !channel.modes.includes(mode)
      ) {
        return { status: 'skipped', reason: 'unavailable', preserveDraft: true };
      }
      if (!message.trim() || new TextEncoder().encode(message).length > MAX_TEXT_BYTES) {
        return { status: 'skipped', reason: 'invalid-text', preserveDraft: true };
      }
      const { bindingId, turnId } = target;
      const requestId = createRequestId();
      const pending: RunningInputReceipt = { bindingId, turnId, requestId, mode, status: 'pending' };
      inFlightReceipt = pending;
      update({ sending: true, receipts: [...snapshot.receipts.slice(1 - MAX_VISIBLE_RECEIPTS), pending] });
      const reply = await requestRelay(path, {
        bindingId,
        method: INPUT_METHODS[mode],
        payload: { requestId, turnId, message },
      });
      const outcome =
        reply.kind === 'success'
          ? parseOutcome(isRecord(reply.data) ? reply.data.result : undefined, turnId)
          : failureOutcome(reply.failure);
      const staleTurn = outcome.status === 'rejected' && 'reason' in outcome && outcome.reason === 'stale-turn';
      if (staleTurn || (reply.kind === 'failure' && (reply.failure.status === 401 || reply.failure.status === 409))) {
        await refresh();
      }
      const receipt = await settleReceipt(pending, outcome);
      inFlightReceipt = undefined;
      update({ sending: false });
      const current = snapshot.channel;
      const confirmed =
        receipt.status === 'queued' &&
        current.status === 'ready' &&
        current.bindingId === bindingId &&
        current.turn.active &&
        current.turn.turnId === turnId;
      return { status: 'sent', receipt, preserveDraft: !confirmed };
    },

    /** Recheck one receipt on its original binding. A refreshHistory result asks the UI to refresh its existing history. */
    async lookup(requestId: string): Promise<RunningInputLookupResult> {
      const original = snapshot.receipts.find((entry) => entry.requestId === requestId);
      const { channel } = snapshot;
      if (disposed || !original || (channel.status === 'ready' && original.bindingId !== channel.bindingId)) {
        return { status: 'binding-changed', refreshHistory: true };
      }
      if (channel.status === 'ready' && channel.canLookup) {
        const reply = await requestRelay(path, {
          bindingId: original.bindingId,
          method: INPUT_METHODS.lookup,
          payload: { requestId },
        });
        if (disposed || binding !== original.bindingId) return { status: 'binding-changed', refreshHistory: true };
        const result = reply.kind === 'success' && isRecord(reply.data) ? reply.data.result : undefined;
        if (isRecord(result)) {
          if (result.status === 'completed') {
            const outcome =
              typeof result.rpcCode === 'number' && Number.isSafeInteger(result.rpcCode)
                ? failureOutcome({ status: 422, code: 'EXT_AGENT_ERROR', rpcCode: result.rpcCode })
                : parseOutcome(result.result, original.turnId);
            if (outcome.status !== 'unknown') {
              const receipt = await settleReceipt(original, outcome);
              if (disposed || binding !== original.bindingId)
                return { status: 'binding-changed', refreshHistory: true };
              return { status: 'completed', receipt };
            }
          }
          if (result.status === 'pending') return { status: 'pending' };
        }
        await refresh();
        if (binding !== original.bindingId) return { status: 'binding-changed', refreshHistory: true };
        return {
          status: isRecord(result) && result.status === 'unavailable' ? 'unavailable' : 'unknown',
          refreshHistory: true,
        };
      }
      await refresh();
      return { status: binding === original.bindingId ? 'unavailable' : 'binding-changed', refreshHistory: true };
    },

    /** Hide a receipt or clear all notices. An in-flight reply cannot recreate a dismissed receipt. */
    dismiss(requestId?: string): void {
      update({ receipts: requestId ? snapshot.receipts.filter((entry) => entry.requestId !== requestId) : [] });
    },

    /** Release the conversation client and its local receipt state. Outstanding writes remain owned by the host. */
    dispose(): void {
      disposed = true;
      generation++;
      discovery?.finish();
      discovery = undefined;
      inFlightReceipt = undefined;
      binding = undefined;
      snapshot = { channel: { status: 'unavailable' }, receipts: [], sending: false };
      listeners.clear();
      unsubscribeReconnect();
    },
  };
}
