import {
  ImagePreparationError,
  createImagePreparation,
  verifyImageGrants,
  type ImagePreparationOptions,
} from './Images';
import { createRunningImagePreviews, describeRunningImages } from './imagePreviews';
import {
  emptyNativeImageLine,
  IMAGE_REJECTIONS,
  parseImageGrants,
  parseImageState,
  RUNNING_IMAGE_LIMITS,
} from './imageProtocol';
import { wsEmitter } from '@/common/adapter/httpBridge';
import { refreshSession } from '@/common/adapter/sessionRefresh';
import { createRequestId, INPUT_METHODS, isRecord, requestRelay, type RelayCall, type RelayFailure } from './transport';
import type {
  ImageSubmissionIdentity,
  RunningImageBlockReason,
  RunningImageSubmission,
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
export { prepareRunningInputMessage, resolveRunningInputReferences, type RunningInputReferences } from './references';
export { IMAGE_ONLY_CAPTION, RUNNING_IMAGE_LIMITS, type RunningImageState } from './imageProtocol';

const MAX_RELAY_BODY_BYTES = 65_536;
const MAX_VISIBLE_RECEIPTS = 256;
const MODES = ['steer', 'follow-up'] as const;
const IMAGE_METHODS = { steer: INPUT_METHODS.steerImages, 'follow-up': INPUT_METHODS.followUpImages } as const;

type PixelSubmission = RunningInputTarget & {
  hostTurnId?: string | null;
  mode: RunningInputMode;
  requestId: string;
  message: string;
  sources: ImagePreparationOptions['sources'];
  signal: AbortSignal;
  /** The composer also fences its host turn, local Stop and conversation lifetime. */
  isCurrent: () => boolean;
  unsupportedFormat?: boolean;
};

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

function parseOutcome(value: unknown, original: RunningInputReceipt): RunningInputOutcome {
  if (!isRecord(value)) return { status: 'unknown' };
  if (value.accepted === true && value.delivery === 'native-queue' && value.turnId === original.turnId) {
    if (!original.pixels) return { status: 'queued' };
    if (value.inputKind === 'pixels' && typeof value.captionAdded === 'boolean') {
      return { status: 'queued', captionAdded: value.captionAdded };
    }
  }
  if (value.accepted === false) {
    const reason = IMAGE_REJECTIONS.find((known) => known === value.reason);
    if (reason && (original.pixels || reason === 'stale-turn' || reason === 'dedup-capacity')) {
      return { status: 'rejected', reason };
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
export function createRunningInputClient(
  conversationId: string,
  {
    getHostTurnId = () => null,
    enablePixels = false,
  }: { getHostTurnId?: () => string | null; enablePixels?: boolean } = {}
) {
  const scope = '/api/conversations/' + encodeURIComponent(conversationId);
  const path = scope + '/acp-extensions';
  const previews = createRunningImagePreviews();
  const lifetime = new AbortController();
  const listeners = new Set<() => void>();
  let snapshot: RunningInputSnapshot = {
    channel: { status: 'unknown' },
    negotiated: false,
    receipts: [],
    sending: false,
  };
  let binding: string | undefined;
  let discovery: { done: Promise<void>; finish: () => void; run: number } | undefined;
  let inFlightReceipt: RunningInputReceipt | undefined;
  let generation = 0;
  let imageObservation = 0;
  let disposed = false;

  function update(change: Partial<RunningInputSnapshot>): void {
    if (disposed) return;
    if (change.receipts) previews.prune(change.receipts);
    snapshot = { ...snapshot, ...change };
    for (const listener of listeners) listener();
  }

  function setBinding(next?: string): void {
    if (binding === next) return;
    binding = next;
    // Keep this conversation's pixel receipts tied to their original binding,
    // including pending writes whose result can no longer be looked up.
    update({
      receipts: snapshot.receipts.filter((receipt) => receipt.pixels),
      imageState: undefined,
      imageSubmission: undefined,
    });
  }

  function observeMissingTask(failure: RelayFailure): boolean {
    if (failure.status !== 409 || failure.code !== 'EXT_NO_LIVE_TASK') return false;
    setBinding();
    update({ channel: { status: 'no-live-task' } });
    return true;
  }

  async function discover(current: number): Promise<void> {
    const hostTurnId = getHostTurnId();
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
      if (observeMissingTask(reply.failure)) return;
      if (status === 404 || (status === 409 && code === 'EXT_UNAVAILABLE')) {
        setBinding();
        update({ channel: { status: 'unsupported' }, negotiated: false });
      } else {
        if (code === 'EXT_STALE_BINDING') setBinding();
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
      update({ channel: { status: 'unsupported' }, negotiated: false });
      return;
    }
    const { bindingId } = data;
    const requests: unknown[] = data.requests;
    const modes = MODES.filter((mode) => requests.includes(INPUT_METHODS[mode]));
    if (!requests.includes(INPUT_METHODS.state) || modes.length === 0) {
      setBinding();
      update({ channel: { status: 'unsupported' }, negotiated: false });
      return;
    }

    setBinding(bindingId);
    if (!snapshot.negotiated) update({ negotiated: true });
    // H1 advertises requests only. The snapshot is read after discovery, without a socket subscription.
    const state = await requestRelay(
      path,
      JSON.stringify({ bindingId, method: INPUT_METHODS.state, payload: {} } satisfies RelayCall)
    );
    if (!isCurrent()) return;
    if (state.kind === 'failure' && observeMissingTask(state.failure)) return;
    const turn = state.kind === 'success' && isRecord(state.data) ? parseTurn(state.data.result) : undefined;
    if (turn) {
      const pixelModes =
        enablePixels &&
        data.hostBytes === true &&
        requests.includes(INPUT_METHODS.imageState) &&
        requests.includes(INPUT_METHODS.lookup)
          ? modes.filter((mode) => requests.includes(IMAGE_METHODS[mode]))
          : [];
      update({
        imageState: snapshot.imageState?.turnId === turn.turnId ? snapshot.imageState : undefined,
        channel: {
          status: 'ready',
          bindingId,
          hostTurnId: getHostTurnId() === hostTurnId ? hostTurnId : null,
          turn,
          modes,
          canLookup: requests.includes(INPUT_METHODS.lookup),
          ...(pixelModes.length ? { pixelModes } : {}),
        },
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

    const { requestId, bindingId, turnId, mode, hostTurnId, pixels } = original;
    const visible = snapshot.receipts.find((entry) => entry.requestId === requestId);
    const inFlight = inFlightReceipt?.requestId === requestId ? inFlightReceipt : undefined;
    const current = inFlight ?? visible ?? original;
    // A definitive lookup result survives transport uncertainty and dismissal of the notice.
    if (current.status === 'queued' || current.status === 'rejected') return current;

    const receipt = { requestId, bindingId, turnId, mode, hostTurnId, ...(pixels && { pixels }), ...outcome };
    if (inFlight) inFlightReceipt = receipt;
    if (visible && (pixels || binding === bindingId)) {
      update({ receipts: snapshot.receipts.map((entry) => (entry.requestId === requestId ? receipt : entry)) });
    }
    return receipt;
  }

  async function dispatch(
    pending: RunningInputReceipt,
    body: string,
    stillCurrent = () => true
  ): Promise<RunningInputSendResult> {
    const { bindingId, turnId } = pending;
    inFlightReceipt = pending;
    update({
      sending: true,
      imageSubmission: undefined,
      receipts: [...snapshot.receipts.slice(1 - MAX_VISIBLE_RECEIPTS), pending],
    });
    const reply = await requestRelay(path, body);
    const outcome =
      reply.kind === 'success'
        ? parseOutcome(isRecord(reply.data) ? reply.data.result : undefined, pending)
        : failureOutcome(reply.failure);
    const staleTurn = outcome.status === 'rejected' && 'reason' in outcome && outcome.reason === 'stale-turn';
    if (staleTurn || (reply.kind === 'failure' && (reply.failure.status === 401 || reply.failure.status === 409))) {
      await refresh();
    }
    const receipt = await settleReceipt(pending, outcome);
    inFlightReceipt = undefined;
    const current = snapshot.channel;
    const confirmed =
      receipt.status === 'queued' &&
      stillCurrent() &&
      current.status === 'ready' &&
      current.bindingId === bindingId &&
      current.turn.active &&
      current.turn.turnId === turnId;
    update({ sending: false });
    return { status: 'sent', receipt, preserveDraft: !confirmed };
  }

  function currentTarget(target: RunningInputTarget) {
    const { channel } = snapshot;
    return !disposed &&
      channel.status === 'ready' &&
      channel.bindingId === target.bindingId &&
      channel.turn.active &&
      channel.turn.turnId === target.turnId
      ? channel
      : undefined;
  }

  async function readImageState(target: { bindingId: string; turnId: string | null }, signal = lifetime.signal) {
    const observation = ++imageObservation;
    const reply = await requestRelay(
      path,
      JSON.stringify({
        bindingId: target.bindingId,
        method: INPUT_METHODS.imageState,
        payload: {},
      } satisfies RelayCall),
      signal
    );
    const state = parseImageState(
      reply.kind === 'success' && isRecord(reply.data) ? reply.data.result : undefined,
      target.turnId
    );
    const { channel } = snapshot;
    if (
      observation === imageObservation &&
      !signal.aborted &&
      channel.status === 'ready' &&
      channel.pixelModes?.length &&
      channel.bindingId === target.bindingId &&
      channel.turn.turnId === target.turnId
    ) {
      update({ imageState: state });
    }
    return state;
  }

  async function submitImages({
    bindingId,
    turnId,
    hostTurnId,
    mode,
    requestId,
    message,
    sources,
    signal: composerSignal,
    isCurrent,
    unsupportedFormat,
  }: PixelSubmission): Promise<RunningInputSendResult> {
    if (snapshot.sending || snapshot.imageSubmission?.status === 'preparing') {
      return { status: 'skipped', reason: 'busy', preserveDraft: true };
    }
    const identity = { bindingId, turnId, requestId, mode };
    sources = sources.map((source) =>
      source.ref ? { ...source, ref: { ...source.ref } } : { ...source, ref: undefined }
    );
    const signal = AbortSignal.any([composerSignal, lifetime.signal]);
    const current = () => !signal.aborted && isCurrent() && currentTarget(identity)?.pixelModes?.includes(mode);
    let batch: RunningImageSubmission['batch'];
    let measurements: RunningImageSubmission['measurements'];
    const blocked = (reason: RunningImageBlockReason): RunningInputSendResult => {
      if (binding === bindingId) {
        update({
          imageSubmission: {
            ...identity,
            status: 'blocked',
            reason,
            batch,
            measurements,
            allowPathOnly:
              !!currentTarget(identity)?.modes.includes(mode) &&
              isCurrent() &&
              !signal.aborted &&
              reason !== 'cancelled',
          },
        });
      }
      return { status: 'blocked', preserveDraft: true };
    };
    const interrupted = () => blocked(signal.aborted ? 'cancelled' : 'turn-changed');
    if (!isCurrent() || signal.aborted) return interrupted();
    if (!currentTarget(identity)?.pixelModes?.includes(mode)) return blocked('contract-unavailable');
    if (unsupportedFormat) return blocked('unsupported-format');
    if (message.includes('\0') || /\p{Surrogate}/u.test(message)) return blocked('invalid-text');
    // Opaque grant IDs fit within 128 bytes each. Check before any worker or grant work.
    const makeBody = (grants: readonly string[]) =>
      JSON.stringify({
        bindingId,
        method: IMAGE_METHODS[mode],
        payload: { turnId, requestId, message, grants },
      } satisfies RelayCall);
    if (sources.length > RUNNING_IMAGE_LIMITS.maxImages) return blocked('image-count');
    if (new TextEncoder().encode(makeBody(sources.map(() => 'x'.repeat(128)))).length > MAX_RELAY_BODY_BYTES) {
      return blocked('invalid-text');
    }

    const preparing = (progress?: Extract<RunningImageSubmission, { stage: 'images' }>['progress']) =>
      update({
        imageSubmission: {
          ...identity,
          status: 'preparing',
          stage: 'images',
          imageCount: sources.length,
          progress,
          batch,
          measurements,
        },
      });
    preparing();
    try {
      const initial = await readImageState(identity, signal);
      if (!current()) return interrupted();
      if (initial.available === false)
        return blocked(initial.reason === 'no-active-turn' ? 'turn-changed' : initial.reason);
      if (sources.length > initial.limits.maxImages) return blocked('image-count');

      const preparation = createImagePreparation({
        conversationId,
        requestId,
        sources,
        signal,
        model: { supported: true, ...initial.limits },
        emptyNativeLine: (_id, mimes) => emptyNativeImageLine(mode, message, mimes),
        onProgress(index, image) {
          if (!signal.aborted) preparing({ index, image });
        },
        onMeasurements(observed) {
          measurements = observed;
          if (!signal.aborted) preparing();
        },
      });
      try {
        const prepared = await preparation.prepare();
        if (!current()) return interrupted();
        batch = { images: describeRunningImages(prepared.images), estimatedLineBytes: prepared.estimatedLineBytes };
        preparing();
        const body = JSON.stringify({ prepareId: requestId, bindingId, refs: prepared.images.map(({ ref }) => ref) });
        const authorize = () =>
          requestRelay(scope + '/byte-grants', body, AbortSignal.any([signal, AbortSignal.timeout(35_000)]));
        let reply = await authorize();
        if (
          current() &&
          reply.kind === 'failure' &&
          (reply.failure.status === 0 || (reply.failure.status >= 200 && reply.failure.status < 300))
        )
          reply = await authorize();
        if (!current()) return interrupted();
        const grants = reply.kind === 'success' ? parseImageGrants(reply.data) : undefined;
        if (!grants) return blocked('grant-unavailable');
        const verified = verifyImageGrants(prepared, grants);

        // State may have changed during worker, upload or byte-grant preparation.
        const live = await readImageState(identity, signal);
        if (!current()) return interrupted();
        if (live.available === false && live.reason === 'no-active-turn') return blocked('turn-changed');
        if (live.available === false)
          return blocked(live.reason === 'state-unavailable' ? live.reason : 'model-changed');
        if (
          live.model !== initial.model ||
          Object.keys(live.limits).some((key) => {
            const limit = key as keyof typeof live.limits;
            return live.limits[limit] !== initial.limits[limit];
          })
        )
          return blocked('model-changed');

        previews.retain(identity, requestId, prepared.images);
        return dispatch(
          { ...identity, hostTurnId, status: 'pending', pixels: batch },
          makeBody(verified.map(({ id }) => id)),
          () => !signal.aborted && isCurrent()
        );
      } finally {
        preparation.dispose();
      }
    } catch (error) {
      if (signal.aborted || !isCurrent()) return blocked('cancelled');
      return blocked(error instanceof ImagePreparationError ? error.code : 'state-unavailable');
    }
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

    /** Publish private reference verification as part of the same click's preparation. */
    beginImageReferences(identity: ImageSubmissionIdentity, fileCount: number) {
      update({ imageSubmission: { ...identity, status: 'preparing', stage: 'references', fileCount } });
      return (reason?: 'cancelled' | 'references-unverified' | 'turn-changed') => {
        const current = snapshot.imageSubmission;
        if (
          current?.status !== 'preparing' ||
          current.stage !== 'references' ||
          current.requestId !== identity.requestId
        )
          return;
        update({
          imageSubmission: reason ? { ...identity, status: 'blocked', reason, allowPathOnly: false } : undefined,
        });
      };
    },

    submitImages,

    /** Poll only on a negotiated active turn. Keep provider window observations separate from queue ACKs. */
    async refreshImageState(): Promise<void> {
      const { channel } = snapshot;
      if (channel.status === 'ready' && channel.pixelModes?.length) {
        await readImageState({ bindingId: channel.bindingId, turnId: channel.turn.turnId });
      }
    },

    /** Read the thumbnail for a visible queued receipt, or use an icon and its sent dimensions. */
    getImagePreview(requestId: string, digest: string): string | undefined {
      const receipt = snapshot.receipts.find((entry) => entry.requestId === requestId);
      return receipt && previews.read(receipt, digest);
    },

    /** Leave a blocked card in place until it is dismissed or another explicit submission starts. */
    dismissImageSubmission(): void {
      if (snapshot.imageSubmission?.status === 'blocked') update({ imageSubmission: undefined });
    },

    /** Rediscover the binding and read input/state after the refresh signal, without reopening a turn. */
    refresh: () => refresh(),

    /**
     * Submit text for the captured binding and turn. Leave attachments in the composer.
     * Clear the submitted draft only if it still matches the composer and preserveDraft is false.
     */
    async send(
      mode: RunningInputMode,
      target: RunningInputTarget,
      message: string,
      { requestId, hostTurnId }: { requestId?: string; hostTurnId?: string | null } = {}
    ): Promise<RunningInputSendResult> {
      if (snapshot.sending || snapshot.imageSubmission?.status === 'preparing')
        return { status: 'skipped', reason: 'busy', preserveDraft: true };
      const { channel } = snapshot;
      if (
        disposed ||
        channel.status !== 'ready' ||
        target.bindingId !== channel.bindingId ||
        !channel.modes.includes(mode)
      ) {
        return { status: 'skipped', reason: 'unavailable', preserveDraft: true };
      }
      if (!message.trim() || message.includes('\0')) {
        return { status: 'skipped', reason: 'invalid-text', preserveDraft: true };
      }
      const { bindingId, turnId } = target;
      requestId ??= createRequestId();
      const body = JSON.stringify({
        bindingId,
        method: INPUT_METHODS[mode],
        payload: { requestId, turnId, message },
      } satisfies RelayCall);
      if (new TextEncoder().encode(body).length > MAX_RELAY_BODY_BYTES) {
        return { status: 'skipped', reason: 'too-large', preserveDraft: true };
      }
      return dispatch({ bindingId, turnId, requestId, mode, hostTurnId, status: 'pending' }, body);
    },

    /** Recheck one receipt on its original binding. A refreshHistory result asks the UI to refresh its existing history. */
    async lookup(requestId: string): Promise<RunningInputLookupResult> {
      const original = snapshot.receipts.find((entry) => entry.requestId === requestId);
      const { channel } = snapshot;
      if (disposed || !original || original.bindingId !== binding) {
        return { status: 'binding-changed', refreshHistory: true };
      }
      if (channel.status === 'ready' && channel.canLookup) {
        const reply = await requestRelay(
          path,
          JSON.stringify({
            bindingId: original.bindingId,
            method: INPUT_METHODS.lookup,
            payload: { requestId },
          } satisfies RelayCall)
        );
        if (disposed || binding !== original.bindingId) return { status: 'binding-changed', refreshHistory: true };
        const result = reply.kind === 'success' && isRecord(reply.data) ? reply.data.result : undefined;
        if (isRecord(result)) {
          if (result.status === 'completed') {
            const outcome =
              typeof result.rpcCode === 'number' && Number.isSafeInteger(result.rpcCode)
                ? failureOutcome({ status: 422, code: 'EXT_AGENT_ERROR', rpcCode: result.rpcCode })
                : parseOutcome(result.result, original);
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
      lifetime.abort();
      previews.prune([]);
      generation++;
      discovery?.finish();
      discovery = undefined;
      inFlightReceipt = undefined;
      binding = undefined;
      snapshot = { channel: { status: 'unavailable' }, negotiated: false, receipts: [], sending: false };
      listeners.clear();
      unsubscribeReconnect();
    },
  };
}
