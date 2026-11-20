/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { Message } from '@arco-design/web-react';
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { useLatestRef } from '@/renderer/hooks/ui/useLatestRef';
import {
  createRunningInputClient,
  type RunningInputMode,
  type RunningInputSnapshot,
} from '@/renderer/services/runtime/RunningInput';
import { emitter } from '@/renderer/utils/emitter';
import { buildRunningInputNotices, turnKey, type RunningInputChannel, type RunningInputNotice } from './notices';

type Session = Readonly<{ client: ReturnType<typeof createRunningInputClient>; refreshSoon: () => void }>;

/**
 * `ordinary`: the composer keeps its existing send path. `sent`: the native queue
 * accepted the text for the current binding and turn, so the draft is cleared.
 * `kept`: nothing was accepted (or the result is unclear), so the draft goes back.
 */
export type RunningInputRoute = 'ordinary' | 'sent' | 'kept';

export type UseRunningInputOptions = {
  conversationId: string;
  /** False keeps today's composer exactly (no discovery, no relay). */
  enabled: boolean;
  /** The host turn is open, so an ordinary send would be refused. */
  hostBusy: boolean;
  hostTurnId: string | null;
  /** The host is cancelling the turn. */
  stopping: boolean;
  /** Sending is held elsewhere (session check, manual compaction). */
  paused: boolean;
};

export type RunningInputController = {
  /** The running turn can take steer/follow-up input now. */
  available: boolean;
  /** This session negotiated the relay, so an ordinary send that loses the turn keeps its draft. */
  supported: boolean;
  modes: readonly RunningInputMode[];
  mode: RunningInputMode;
  setMode: (mode: RunningInputMode) => void;
  notices: RunningInputNotice[];
  submit: (message: string, hasAttachments: boolean) => Promise<RunningInputRoute>;
  /** Record a Stop so late acceptances for the stopped turn say so. */
  markStopped: () => void;
  dismiss: (requestIds?: readonly string[]) => void;
  check: (requestId: string) => Promise<void>;
};

/** Follow-up leaves the running work as it is; steer is one click away. */
export const DEFAULT_RUNNING_INPUT_MODE: RunningInputMode = 'follow-up';

const NO_SNAPSHOT: RunningInputSnapshot = { channel: { status: 'unsupported' }, receipts: [], sending: false };
const NO_TURNS: ReadonlySet<string> = new Set();
const subscribeNothing = () => () => {};
const readNothing = () => NO_SNAPSHOT;

function openSession(conversationId: string): Session {
  const client = createRunningInputClient(conversationId);
  let running = false;
  let again = false;
  // H1 sends no turn notifications, so every trigger gets a state read that starts after it.
  const refreshSoon = () => {
    if (running) {
      again = true;
      return;
    }
    running = true;
    void (async () => {
      try {
        do {
          again = false;
          // eslint-disable-next-line no-await-in-loop -- each read must start after the previous one
          await client.refresh();
        } while (again);
      } catch {
        // The snapshot carries discovery failures.
      } finally {
        running = false;
      }
    })();
  };
  return { client, refreshSoon };
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
  hostBusy,
  hostTurnId,
  stopping,
  paused,
}: UseRunningInputOptions): RunningInputController {
  const { t } = useTranslation();
  const [session, setSession] = useState<Session | null>(null);
  const [lastReady, setLastReady] = useState<RunningInputChannel>();
  const [stoppedTurns, setStoppedTurns] = useState<ReadonlySet<string>>(NO_TURNS);
  const [mode, setMode] = useState<RunningInputMode>(DEFAULT_RUNNING_INPUT_MODE);

  useEffect(() => {
    if (!enabled) return;
    const next = openSession(conversationId);
    setSession(next);
    return () => {
      next.client.dispose();
      setSession((current) => (current === next ? null : current));
      setLastReady(undefined);
      setStoppedTurns(NO_TURNS);
    };
  }, [conversationId, enabled]);

  const client = session?.client;
  const snapshot = useSyncExternalStore(client?.subscribe ?? subscribeNothing, client?.getSnapshot ?? readNothing);
  const { channel, receipts } = snapshot;

  useEffect(() => {
    if (channel.status === 'ready') setLastReady(channel);
    else if (channel.status !== 'checking') setLastReady(undefined);
  }, [channel]);

  // Keep the last discovered channel while a refresh runs so the composer does not flicker.
  const known = channel.status === 'ready' ? channel : channel.status === 'checking' ? lastReady : undefined;

  useEffect(() => {
    session?.refreshSoon();
  }, [session, hostBusy, hostTurnId]);

  const latest = useLatestRef({ session, known, receipts, hostBusy, stopping, paused, mode });

  const markStopped = useCallback(() => {
    const { known: current, receipts: sent } = latest.current;
    const keys = sent.filter((receipt) => receipt.status === 'pending').map((r) => turnKey(r.bindingId, r.turnId));
    if (current?.turn.active) keys.push(turnKey(current.bindingId, current.turn.turnId));
    if (keys.length === 0) return;
    setStoppedTurns((previous) => {
      if (keys.every((key) => previous.has(key))) return previous;
      return new Set([...previous, ...keys]);
    });
  }, [latest]);

  useEffect(() => {
    if (stopping) markStopped();
  }, [stopping, markStopped]);

  const submit = useCallback(
    async (message: string, hasAttachments: boolean): Promise<RunningInputRoute> => {
      const state = latest.current;
      if (!state.session || !state.known || state.paused || state.stopping) return 'ordinary';
      const { client: relay, refreshSoon } = state.session;
      let target = activeTarget(relay.getSnapshot());
      if (!target && !state.hostBusy) return 'ordinary';
      if (!target || !state.hostBusy) {
        // An ordinary send needs both turns idle; the relay needs the native turn the adapter sees now.
        await relay.refresh();
        target = activeTarget(relay.getSnapshot());
      }
      // Commands never reach a running turn as text, as in the native composer.
      if (!target || message.trimStart().startsWith('/')) return 'ordinary';
      if (hasAttachments) {
        Message.warning(t('acp.runningInput.attachmentsKept'));
        return 'kept';
      }
      if (relay.getSnapshot().sending) {
        Message.info(t('acp.runningInput.previousSending'));
        return 'kept';
      }

      const chosen = target.modes.includes(latest.current.mode) ? latest.current.mode : target.modes[0];
      const result = await relay.send(chosen, { bindingId: target.bindingId, turnId: target.turnId }, message);
      if (result.status === 'skipped') {
        if (result.reason === 'invalid-text') Message.warning(t('acp.runningInput.invalidText'));
        else if (result.reason === 'busy') Message.info(t('acp.runningInput.previousSending'));
        else Message.warning(t('conversation.commandQueue.midturnBlocked'));
        return 'kept';
      }
      if (result.receipt.status !== 'queued') refreshSoon();
      // Clear the composer only for an acceptance the client attributes to the current binding and turn.
      return !result.preserveDraft && result.receipt.status === 'queued' ? 'sent' : 'kept';
    },
    [latest, t]
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
      session.refreshSoon();
      Message.info(t('acp.runningInput.checkUnconfirmed'));
    },
    [session, t]
  );

  const notices = useMemo(
    () => buildRunningInputNotices(receipts, known, stoppedTurns),
    [receipts, known, stoppedTurns]
  );
  const modes = known?.modes ?? [];
  const supported = Boolean(session && known);

  return {
    available: supported && hostBusy && !stopping && !paused && modes.length > 0,
    supported,
    modes,
    mode,
    setMode,
    notices,
    submit,
    markStopped,
    dismiss,
    check,
  };
}
