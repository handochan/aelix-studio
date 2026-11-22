/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { wsEmitter } from '@/common/adapter/httpBridge';
import { Message } from '@arco-design/web-react';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { useLatestRef } from '@/renderer/hooks/ui/useLatestRef';
import {
  createRunningInputClient,
  resolveRunningInputReferences,
  type RunningImageBatch,
  type RunningImageState,
  type RunningImageSubmission,
  type RunningInputReceipt,
  type RunningInputReferences,
  type RunningInputMode,
  type RunningInputSnapshot,
} from '@/renderer/services/runtime/RunningInput';
import { createRequestId } from '@/renderer/services/runtime/RunningInput/transport';
import { decideSend, type HostTurnState, type StopState } from '@/renderer/services/runtime/RunningInput/decideSend';
import type { ComposerDraft } from '@/renderer/components/chat/SendBox';
import { emitter } from '@/renderer/utils/emitter';
import {
  attributeStop,
  buildRunningInputNotices,
  phaseOf,
  turnKey,
  type RunningInputChannel,
  type RunningInputNotice,
  type RunningInputStopPhases,
  type RunningInputTurnPhase,
} from './notices';

type Session = {
  client: ReturnType<typeof createRunningInputClient>;
  stopRevision: number;
  stop: StopState;
  conversationId: string;
  disposed: boolean;
  preparation?: AbortController;
  imageDraft?: boolean;
};

/**
 * `ordinary`: the composer keeps its existing send path. `sent`: the native queue
 * accepted the text for the current binding and turn before a Stop, so the draft is cleared.
 * `kept`: the composer preserves the draft.
 */
export type RunningInputRoute = 'ordinary' | 'sent' | 'kept';

export type UseRunningInputOptions = {
  conversationId: string;
  /** False keeps today's composer exactly (no discovery, no relay). */
  enabled: boolean;
  /** Part 2/2 opts in when the composer can show the image states and actions. */
  enablePixels?: boolean;
  /** Most recent host turn observation. */
  host: HostTurnState;
  hostTurnId: string | null;
  refreshHost: () => Promise<{ host: HostTurnState; hostTurnId: string | null }>;
  /** The host is cancelling the turn. */
  stopping: boolean;
  /** Sending is held elsewhere (session check, manual compaction). */
  paused: boolean;
  /** Changes when the composer replaces or edits the input being prepared. */
  draftVersion?: object;
  /** A local model change can cancel preparation before the next ACP state read. */
  modelVersion?: string;
};

type Submit = (message: string, references: RunningInputReferences, draft: ComposerDraft) => Promise<RunningInputRoute>;

/** State consumed by the S-1b composer and its notices. All strings are wire values or i18n reason keys. */
export type RunningImageController = {
  modes: readonly RunningInputMode[];
  state?: RunningImageState;
  submission?: RunningImageSubmission;
  receipts: readonly {
    receipt: RunningInputReceipt & { pixels: RunningImageBatch };
    phase: RunningInputTurnPhase;
    /** Lookup is available only on the receipt's original live binding. */
    canLookup: boolean;
  }[];
  /** Only queued receipts can expose a URL. Render icon + sent dimensions when absent. */
  preview: (requestId: string, sha256: string) => string | undefined;
  dismissSubmission: () => void;
  cancelPreparation: () => void;
  /** Call on a new explicit path-only click using the current composer draft and original refs. */
  submitPaths: Submit;
};

export type RunningInputController = {
  /** The running turn can take steer/follow-up input now. */
  available: boolean;
  /** Hold the draft during discovery and for negotiated submissions. */
  handlesSubmit: boolean;
  modes: readonly RunningInputMode[];
  mode: RunningInputMode;
  setMode: (mode: RunningInputMode) => void;
  notices: RunningInputNotice[];
  images: RunningImageController;
  submit: Submit;
  /** Record a Stop so late acceptances for the stopped turn say so. */
  beginStop: (hostTurnId?: string | null) => (outcome: 'failed' | 'done') => void;
  dismiss: (requestIds?: readonly string[]) => void;
  check: (requestId: string) => Promise<void>;
};

/** Match the native composer's default for input during a running turn. */
export const DEFAULT_RUNNING_INPUT_MODE: RunningInputMode = 'steer';

const NO_SNAPSHOT: RunningInputSnapshot = {
  channel: { status: 'unknown' },
  negotiated: false,
  receipts: [],
  sending: false,
};
const NO_STOPS: RunningInputStopPhases = new Map();
const subscribeNothing = () => () => {};
const readNothing = () => NO_SNAPSHOT;

function openSession(conversationId: string, getHostTurnId: () => string | null, enablePixels?: boolean): Session {
  const client = createRunningInputClient(conversationId, { getHostTurnId, enablePixels });
  return { client, stopRevision: 0, stop: { status: 'none' }, conversationId, disposed: false };
}

function activeTarget({ channel }: RunningInputSnapshot) {
  if (channel.status !== 'ready' || !channel.turn.active) return undefined;
  return { bindingId: channel.bindingId, turnId: channel.turn.turnId, modes: channel.modes };
}

/**
 * Composer side of Aelix running input (D20). Owns one relay client per conversation,
 * re-reads the native turn when the host turn changes, routes a send to steer/follow-up
 * while a turn runs, and turns receipts into notices tied to their original turn.
 * It does not write to the conversation store and never re-sends a draft by itself.
 */
export function useRunningInput({
  conversationId,
  enabled,
  enablePixels,
  host,
  hostTurnId,
  refreshHost,
  stopping,
  paused,
  draftVersion,
  modelVersion,
}: UseRunningInputOptions): RunningInputController {
  const { t } = useTranslation();
  const [session, setSession] = useState<Session | null>(null);
  const [lastReady, setLastReady] = useState<RunningInputChannel>();
  const [stopPhases, setStopPhases] = useState<RunningInputStopPhases>(NO_STOPS);
  const observedHostTurnId = useLatestRef(hostTurnId);
  const [requestedMode, setMode] = useState<RunningInputMode>(DEFAULT_RUNNING_INPUT_MODE);
  const submitting = useRef<Session | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const next = openSession(conversationId, () => observedHostTurnId.current, enablePixels);
    setSession(next);
    return () => {
      next.disposed = true;
      next.preparation?.abort();
      next.client.dispose();
      setSession((current) => (current === next ? null : current));
      setLastReady(undefined);
      setStopPhases(NO_STOPS);
    };
  }, [conversationId, enabled, enablePixels, observedHostTurnId]);

  const client = session?.conversationId === conversationId ? session.client : undefined;
  const snapshot = useSyncExternalStore(client?.subscribe ?? subscribeNothing, client?.getSnapshot ?? readNothing);
  const { channel, receipts } = snapshot;

  useEffect(() => {
    if (channel.status === 'ready') setLastReady(channel);
    else if (channel.status === 'unsupported') setLastReady(undefined);
  }, [channel]);

  // Keep the last discovered channel while a refresh runs so the composer does not flicker.
  const known = channel.status === 'ready' ? channel : channel.status === 'checking' ? lastReady : undefined;

  useEffect(() => {
    void session?.client.refresh();
  }, [session, host, hostTurnId]);

  const imageBinding = channel.status === 'ready' && channel.pixelModes?.length ? channel.bindingId : undefined;
  const imageTurn = channel.status === 'ready' ? channel.turn.turnId : null;
  useEffect(() => {
    if (!client || !imageBinding) return;
    let reading = false;
    async function observe() {
      if (reading) return;
      reading = true;
      try {
        await client?.refreshImageState();
      } finally {
        reading = false;
      }
    }
    void observe();
    if (imageTurn === null) return;
    const timer = setInterval(() => void observe(), 2_000);
    return () => clearInterval(timer);
  }, [client, imageBinding, imageTurn]);

  useEffect(() => {
    return () => session?.preparation?.abort();
  }, [session, hostTurnId, paused]);

  const cancelPreparation = useCallback(() => {
    if (session?.imageDraft && !session.client.getSnapshot().sending) session.preparation?.abort();
  }, [session]);

  useEffect(() => {
    return cancelPreparation;
  }, [cancelPreparation, draftVersion, modelVersion]);

  useEffect(() => {
    if (!enabled || host !== 'unknown') return;
    return wsEmitter('realtime.reconnected').on(() => void refreshHost());
  }, [enabled, host, refreshHost]);

  const modes = known?.modes ?? [];
  const mode = modes.includes(requestedMode) ? requestedMode : (modes[0] ?? requestedMode);
  const latest = useLatestRef({
    session,
    conversationId,
    enabled,
    known,
    host,
    hostTurnId,
    refreshHost,
    stopping,
    paused,
    mode,
    draftVersion,
    modelVersion,
  });

  const beginStop = useCallback(
    (hostTurnId = latest.current.hostTurnId) => {
      const { session: currentSession } = latest.current;
      if (!currentSession) return () => {};
      const revision = ++currentSession.stopRevision;
      currentSession.preparation?.abort();
      const observation = currentSession.client.getSnapshot();
      const { channel, receipts } = observation;
      // Cached discovery is useful for rendering controls. Stop attribution
      // requires a successful observation for the exact Host cancellation ID.
      const target =
        hostTurnId !== null && channel.status === 'ready' && channel.hostTurnId === hostTurnId
          ? activeTarget(observation)
          : undefined;
      const key = target ? turnKey(target.bindingId, target.turnId) : null;
      currentSession.stop = { status: 'pending', turnKey: key, hostTurnId };
      if (hostTurnId !== null) setStopPhases((previous) => attributeStop(receipts, previous, hostTurnId, target));
      return (status: 'failed' | 'done') => {
        if (currentSession.stopRevision === revision) currentSession.stop = { status, turnKey: key, hostTurnId };
      };
    },
    [latest]
  );

  useEffect(() => {
    // A host cancellation can originate in another window. A local Stop already
    // has a completion handler for its own request.
    if (stopping && session && session.stop.status !== 'pending') beginStop()('done');
  }, [session, stopping, beginStop]);

  const submitDraft = useCallback(
    async (
      message: string,
      references: RunningInputReferences,
      draft: ComposerDraft,
      pathOnly: boolean
    ): Promise<RunningInputRoute> => {
      const initial = latest.current;
      const currentSession = initial.session;
      if (!currentSession || currentSession.disposed || !initial.enabled) return 'kept';
      if (submitting.current === currentSession) {
        Message.info(t('acp.runningInput.previousSending'));
        return 'kept';
      }
      // Take ownership before any discovery or reference I/O. The current composer may continue editing.
      references = {
        files: references.files.map((file) => ({ ...file })),
        sessions: references.sessions.map((ref) => ({ ...ref })),
      };
      draft = { ...draft };
      const clicked = initial.known;
      let requestId: string;
      try {
        requestId = createRequestId();
      } catch {
        Message.warning(t('acp.runningInput.invalidText'));
        return 'kept';
      }
      const controller = new AbortController();
      currentSession.preparation = controller;
      currentSession.imageDraft = references.files.length > 0 && (pathOnly || !!clicked?.pixelModes?.length);
      submitting.current = currentSession;
      const { client: relay, stopRevision } = currentSession;
      relay.dismissImageSubmission();
      const decorations = currentSession.imageDraft ? draft.decorationSignal : undefined;
      const cancelDecorations = () => {
        if (!relay.getSnapshot().sending) controller.abort();
      };
      decorations?.addEventListener('abort', cancelDecorations);
      if (decorations?.aborted) cancelDecorations();
      const interrupted = () => {
        const current = latest.current;
        return (
          controller.signal.aborted ||
          currentSession.disposed ||
          !current.enabled ||
          currentSession.conversationId !== current.conversationId ||
          currentSession.stopRevision !== stopRevision ||
          current.session !== currentSession ||
          current.hostTurnId !== initial.hostTurnId ||
          current.stopping ||
          current.paused
        );
      };
      const decide = (
        refreshed: boolean,
        observationHost: Pick<UseRunningInputOptions, 'host' | 'hostTurnId'> = latest.current
      ) => {
        const { host, hostTurnId } = observationHost;
        const observation = relay.getSnapshot();
        const { channel, sending } = observation;
        const target = activeTarget(observation);
        const chosen = target?.modes.includes(initial.mode) ? initial.mode : (target?.modes[0] ?? initial.mode);
        return decideSend({
          host,
          hostTurnId,
          channel: channel.status === 'ready' ? 'available' : channel.status,
          native: channel.status === 'ready' ? (channel.turn.active ? 'active' : 'idle') : 'unknown',
          turnKey: target ? turnKey(target.bindingId, target.turnId) : null,
          stop: currentSession.stop,
          interrupted: interrupted() || hostTurnId !== initial.hostTurnId,
          inFlight: sending,
          refreshed,
          negotiated: observation.negotiated,
          draft: { ...draft, files: references.files.length > 0, sessions: references.sessions.length > 0 },
          mode: chosen,
        });
      };

      try {
        let decision = decide(false);
        if (decision.reason === 'refresh-host') {
          const recovered = await initial.refreshHost();
          if (recovered.host !== 'unknown') await relay.refresh();
          decision = decide(true, latest.current.host === 'unknown' ? recovered : latest.current);
        } else if (decision.reason === 'refresh') {
          await relay.refresh();
          decision = decide(true);
        }
        if (decision.route === 'ordinary') return pathOnly ? 'kept' : 'ordinary';
        if (decision.route === 'keep') {
          if (decision.reason === 'in-flight') Message.info(t('acp.runningInput.previousSending'));
          else if (decision.reason !== 'interrupted') Message.warning(t('conversation.commandQueue.midturnBlocked'));
          return 'kept';
        }

        const target = activeTarget(relay.getSnapshot());
        if (!target) return 'kept';
        const chosen = decision.route === 'relay-steer' ? 'steer' : 'follow-up';
        const matchesClick =
          clicked?.turn.active &&
          clicked.bindingId === target.bindingId &&
          clicked.turn.turnId === target.turnId &&
          initial.mode === chosen;
        if ((pathOnly || currentSession.imageDraft) && !matchesClick) return 'kept';

        let prepared = { text: message, hasImage: false };
        if (decision.reason === 'references') {
          let resolved: Awaited<ReturnType<typeof resolveRunningInputReferences>>;
          const imageDraft = currentSession.imageDraft;
          const finishReferences = imageDraft
            ? relay.beginImageReferences(
                { bindingId: target.bindingId, turnId: target.turnId, mode: chosen, requestId },
                references.files.length
              )
            : undefined;
          try {
            resolved = await resolveRunningInputReferences(
              conversationId,
              message,
              references,
              imageDraft ? controller.signal : undefined
            );
            if (!imageDraft || !interrupted()) await relay.refresh();
          } catch {
            const cancelled = imageDraft && interrupted();
            finishReferences?.(cancelled ? 'cancelled' : 'references-unverified');
            if (!cancelled) Message.warning(t('acp.runningInput.referencesUnverified'));
            return 'kept';
          }
          const active = activeTarget(relay.getSnapshot());
          if (
            active?.bindingId !== target.bindingId ||
            active.turnId !== target.turnId ||
            decide(true).route !== decision.route
          ) {
            const cancelled = imageDraft && interrupted();
            finishReferences?.(cancelled ? 'cancelled' : 'turn-changed');
            if (!cancelled) Message.warning(t('acp.runningInput.preparationChanged'));
            return 'kept';
          }
          finishReferences?.();
          const images = resolved.files.filter(({ kind }) => kind !== 'file');
          const currentChannel = relay.getSnapshot().channel;
          const pixelContract =
            !!clicked?.pixelModes?.length || (currentChannel.status === 'ready' && !!currentChannel.pixelModes?.length);
          if (!pathOnly && images.length > 0 && pixelContract) {
            if (
              !matchesClick ||
              latest.current.draftVersion !== initial.draftVersion ||
              latest.current.modelVersion !== initial.modelVersion
            ) {
              Message.warning(t('acp.runningInput.preparationChanged'));
              return 'kept';
            }
            const result = await relay.submitImages({
              ...target,
              mode: chosen,
              hostTurnId: initial.hostTurnId,
              requestId,
              message: resolved.format(({ kind }) => kind === 'file'),
              sources: images.map(({ ref }) => ({ ref })),
              unsupportedFormat: images.some(({ kind }) => kind === 'unsupported-image'),
              signal: controller.signal,
              isCurrent: () =>
                !interrupted() &&
                (relay.getSnapshot().sending ||
                  (latest.current.draftVersion === initial.draftVersion &&
                    latest.current.modelVersion === initial.modelVersion)),
            });
            // The S-1b visual pass renders blocked/preparing details and path-only actions from images.
            return result.status === 'sent' &&
              result.receipt.status === 'queued' &&
              !result.preserveDraft &&
              !interrupted()
              ? 'sent'
              : 'kept';
          }
          prepared = { text: resolved.format(), hasImage: resolved.hasImage };
        }
        const result = await relay.send(chosen, target, prepared.text, { requestId, hostTurnId: initial.hostTurnId });
        if (result.status === 'skipped') {
          if (result.reason === 'invalid-text') Message.warning(t('acp.runningInput.invalidText'));
          else if (result.reason === 'too-large') Message.warning(t('acp.runningInput.inputTooLarge'));
          else if (result.reason === 'busy') Message.info(t('acp.runningInput.previousSending'));
          else Message.warning(t('conversation.commandQueue.midturnBlocked'));
          return 'kept';
        }
        if (result.status === 'blocked') return 'kept';
        if (result.receipt.status !== 'queued') void relay.refresh();
        else if (prepared.hasImage) Message.info(t('acp.runningInput.imagesAsPaths'));
        return result.receipt.status === 'queued' && !result.preserveDraft && !interrupted() ? 'sent' : 'kept';
      } finally {
        decorations?.removeEventListener('abort', cancelDecorations);
        if (submitting.current === currentSession) submitting.current = null;
        if (currentSession.preparation === controller) {
          currentSession.preparation = undefined;
          currentSession.imageDraft = false;
        }
      }
    },
    [conversationId, latest, t]
  );

  const submit: Submit = useCallback(
    (message, references, draft) => submitDraft(message, references, draft, false),
    [submitDraft]
  );
  const submitPaths: Submit = useCallback(
    (message, references, draft) => submitDraft(message, references, draft, true),
    [submitDraft]
  );

  const dismiss = useCallback(
    (requestIds?: readonly string[]) => {
      if (!session) return;
      if (!requestIds) session.client.dismiss();
      else for (const requestId of requestIds) session.client.dismiss(requestId);
    },
    [session]
  );

  const check = useCallback(
    async (requestId: string) => {
      if (!session) return;
      const result = await session.client.lookup(requestId);
      if (result.status === 'completed') return;
      if (result.status === 'pending') {
        Message.info(t('acp.runningInput.checkPending'));
        return;
      }
      // The original result is gone or unclear: read the current state and the existing history instead.
      emitter.emit('chat.history.refresh');
      void session.client.refresh();
      Message.info(t('acp.runningInput.checkUnconfirmed'));
    },
    [session, t]
  );

  const receiptChannel = known?.hostTurnId === hostTurnId ? known : undefined;
  const notices = useMemo(
    () => buildRunningInputNotices(receipts, receiptChannel, stopPhases),
    [receipts, receiptChannel, stopPhases]
  );
  const handlesSubmit =
    enabled &&
    channel.status !== 'unsupported' &&
    (host === 'unknown' || channel.status !== 'unavailable' || snapshot.negotiated);

  return {
    available: enabled && snapshot.negotiated && host === 'busy' && !stopping && !paused && modes.length > 0,
    handlesSubmit,
    modes,
    mode,
    setMode,
    notices,
    images: {
      modes: known?.pixelModes ?? [],
      state: snapshot.imageState,
      submission: snapshot.imageSubmission,
      receipts: receipts.flatMap((receipt) =>
        receipt.pixels
          ? [
              {
                receipt: { ...receipt, pixels: receipt.pixels },
                phase: phaseOf(receipt, receiptChannel, stopPhases),
                canLookup: channel.status === 'ready' && channel.canLookup && channel.bindingId === receipt.bindingId,
              },
            ]
          : []
      ),
      preview: client?.getImagePreview ?? (() => undefined),
      dismissSubmission: client?.dismissImageSubmission ?? (() => {}),
      cancelPreparation,
      submitPaths,
    },
    submit,
    beginStop,
    dismiss,
    check,
  };
}
