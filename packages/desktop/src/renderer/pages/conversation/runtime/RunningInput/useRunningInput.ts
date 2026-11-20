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
  prepareRunningInputMessage,
  type RunningInputReferences,
  type RunningInputMode,
  type RunningInputSnapshot,
} from '@/renderer/services/runtime/RunningInput';
import { decideSend, type HostTurnState, type StopState } from '@/renderer/services/runtime/RunningInput/decideSend';
import type { ComposerDraft } from '@/renderer/components/chat/SendBox';
import { emitter } from '@/renderer/utils/emitter';
import { buildRunningInputNotices, turnKey, type RunningInputChannel, type RunningInputNotice } from './notices';

type Session = {
  client: ReturnType<typeof createRunningInputClient>;
  stopRevision: number;
  stop: StopState;
  conversationId: string;
  disposed: boolean;
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
  /** Most recent host turn observation. */
  host: HostTurnState;
  hostTurnId: string | null;
  refreshHost: () => Promise<{ host: HostTurnState; hostTurnId: string | null }>;
  /** The host is cancelling the turn. */
  stopping: boolean;
  /** Sending is held elsewhere (session check, manual compaction). */
  paused: boolean;
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
  submit: (message: string, references: RunningInputReferences, draft: ComposerDraft) => Promise<RunningInputRoute>;
  /** Record a Stop so late acceptances for the stopped turn say so. */
  beginStop: () => (outcome: 'failed' | 'done') => void;
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
const NO_RECEIPTS: ReadonlySet<string> = new Set();
const subscribeNothing = () => () => {};
const readNothing = () => NO_SNAPSHOT;

function openSession(conversationId: string): Session {
  const client = createRunningInputClient(conversationId);
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
  host,
  hostTurnId,
  refreshHost,
  stopping,
  paused,
}: UseRunningInputOptions): RunningInputController {
  const { t } = useTranslation();
  const [session, setSession] = useState<Session | null>(null);
  const [lastReady, setLastReady] = useState<RunningInputChannel>();
  const [stoppedRequests, setStoppedRequests] = useState<ReadonlySet<string>>(NO_RECEIPTS);
  const [requestedMode, setMode] = useState<RunningInputMode>(DEFAULT_RUNNING_INPUT_MODE);
  const preparing = useRef<Session | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const next = openSession(conversationId);
    setSession(next);
    return () => {
      next.disposed = true;
      next.client.dispose();
      setSession((current) => (current === next ? null : current));
      setLastReady(undefined);
      setStoppedRequests(NO_RECEIPTS);
    };
  }, [conversationId, enabled]);

  const client = session?.client;
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
  });

  const beginStop = useCallback(() => {
    const { session: currentSession, known, hostTurnId } = latest.current;
    if (!currentSession) return () => {};
    const revision = ++currentSession.stopRevision;
    const { channel, receipts } = currentSession.client.getSnapshot();
    const active = channel.status === 'checking' ? known : channel.status === 'ready' ? channel : undefined;
    const key = active?.turn.active ? turnKey(active.bindingId, active.turn.turnId) : null;
    currentSession.stop = { status: 'pending', turnKey: key, hostTurnId };
    // Attribute the Stop to submissions already made. A new send after a failed Stop
    // can reach the same turn without inheriting the old submission's notice.
    setStoppedRequests(
      (previous) =>
        new Set(
          receipts
            .filter(
              (receipt) =>
                previous.has(receipt.requestId) ||
                receipt.status === 'pending' ||
                turnKey(receipt.bindingId, receipt.turnId) === key
            )
            .map((receipt) => receipt.requestId)
        )
    );
    return (status: 'failed' | 'done') => {
      if (currentSession.stopRevision === revision) currentSession.stop = { status, turnKey: key, hostTurnId };
    };
  }, [latest]);

  useEffect(() => {
    // A host cancellation can originate in another window. A local Stop already
    // has a completion handler for its own request.
    if (stopping && session && session.stop.status !== 'pending') beginStop()('done');
  }, [session, stopping, beginStop]);

  const submit = useCallback(
    async (message: string, references: RunningInputReferences, draft: ComposerDraft): Promise<RunningInputRoute> => {
      const initial = latest.current;
      const currentSession = initial.session;
      if (!currentSession) return 'kept';
      const { client: relay, stopRevision } = currentSession;
      const interrupted = () => {
        const current = latest.current;
        return (
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
          inFlight: sending || preparing.current === currentSession,
          refreshed,
          negotiated: observation.negotiated,
          draft: { ...draft, files: references.files.length > 0, sessions: references.sessions.length > 0 },
          mode: chosen,
        });
      };

      let decision = decide(false);
      if (decision.reason === 'refresh-host') {
        const recovered = await initial.refreshHost();
        if (recovered.host !== 'unknown') await relay.refresh();
        decision = decide(true, latest.current.host === 'unknown' ? recovered : latest.current);
      } else if (decision.reason === 'refresh') {
        await relay.refresh();
        decision = decide(true);
      }
      if (decision.route === 'ordinary') return 'ordinary';
      if (decision.route === 'keep') {
        if (decision.reason === 'in-flight') Message.info(t('acp.runningInput.previousSending'));
        else if (decision.reason !== 'interrupted') Message.warning(t('conversation.commandQueue.midturnBlocked'));
        return 'kept';
      }

      const target = activeTarget(relay.getSnapshot());
      if (!target) return 'kept';
      let prepared = { text: message, hasImage: false };
      if (decision.reason === 'references') {
        preparing.current = currentSession;
        try {
          prepared = await prepareRunningInputMessage(conversationId, message, references);
          await relay.refresh();
        } catch {
          Message.warning(t('acp.runningInput.referencesUnverified'));
          return 'kept';
        } finally {
          if (preparing.current === currentSession) preparing.current = null;
        }
        const active = activeTarget(relay.getSnapshot());
        if (
          active?.bindingId !== target.bindingId ||
          active.turnId !== target.turnId ||
          decide(true).route !== decision.route
        ) {
          Message.warning(t('acp.runningInput.preparationChanged'));
          return 'kept';
        }
      }
      const chosen = decision.route === 'relay-steer' ? 'steer' : 'follow-up';
      const result = await relay.send(chosen, target, prepared.text);
      if (result.status === 'skipped') {
        if (result.reason === 'invalid-text') Message.warning(t('acp.runningInput.invalidText'));
        else if (result.reason === 'too-large') Message.warning(t('acp.runningInput.inputTooLarge'));
        else if (result.reason === 'busy') Message.info(t('acp.runningInput.previousSending'));
        else Message.warning(t('conversation.commandQueue.midturnBlocked'));
        return 'kept';
      }
      if (result.receipt.status !== 'queued') void relay.refresh();
      else if (prepared.hasImage) Message.info(t('acp.runningInput.imagesAsPaths'));
      // A receipt can reach the original turn while the host is still cancelling it.
      return result.receipt.status === 'queued' && !result.preserveDraft && !interrupted() ? 'sent' : 'kept';
    },
    [conversationId, latest, t]
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

  const notices = useMemo(
    () => buildRunningInputNotices(receipts, known, stoppedRequests),
    [receipts, known, stoppedRequests]
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
    submit,
    beginStop,
    dismiss,
    check,
  };
}
