/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  RunningInputMode,
  RunningInputReceipt,
  RunningInputSnapshot,
  RunningInputTarget,
} from '@/renderer/services/runtime/RunningInput';

/** A discovered channel. The composer keeps the last one while a refresh is in flight. */
export type RunningInputChannel = Extract<RunningInputSnapshot['channel'], { status: 'ready' }>;

/** Where the turn that accepted an input stands now. */
type StopPhase = 'stopped' | 'stop-unconfirmed';
export type RunningInputTurnPhase = 'active' | 'ended' | StopPhase;
export type RunningInputStopPhases = ReadonlyMap<string, StopPhase>;

export type RunningInputRejectReason =
  | 'stale-turn'
  | 'dedup-capacity'
  | 'rate-limited'
  | 'too-large'
  | 'session-changed'
  | 'failed';

/**
 * One row of the composer notice. Queued inputs are grouped by the turn that accepted
 * them and never carry a count or a consumption claim. Other states stay per request.
 */
export type RunningInputNotice =
  | { kind: 'queued'; key: string; requestIds: string[]; modes: RunningInputMode[]; phase: RunningInputTurnPhase }
  | { kind: 'pending' | 'unknown'; key: string; requestIds: string[]; mode: RunningInputMode }
  | { kind: 'rejected'; key: string; requestIds: string[]; mode: RunningInputMode; reason: RunningInputRejectReason };

/** Identify a turn on its binding. A new binding never continues an old turn. */
export const turnKey = (bindingId: string, turnId: string): string => JSON.stringify([bindingId, turnId]);

/** Attribute one Host Stop to the receipts visible when it was requested. */
export function attributeStop(
  receipts: readonly RunningInputReceipt[],
  previous: RunningInputStopPhases,
  hostTurnId: string,
  target?: RunningInputTarget
): RunningInputStopPhases {
  const phases = new Map<string, StopPhase>();
  for (const receipt of receipts) {
    const previousPhase = previous.get(receipt.requestId);
    if (previousPhase) phases.set(receipt.requestId, previousPhase);
    if (previousPhase === 'stopped') continue;
    if (receipt.hostTurnId != null && receipt.hostTurnId !== hostTurnId) continue;

    const sameNativeTurn = target?.bindingId === receipt.bindingId && target.turnId === receipt.turnId;
    if (target && !sameNativeTurn) continue;
    // When the receipt has no Host ID, only an overlapping write or the
    // matching native tuple is evidence of a possible relationship.
    if (receipt.hostTurnId == null && receipt.status !== 'pending' && !sameNativeTurn) continue;
    phases.set(receipt.requestId, sameNativeTurn && receipt.hostTurnId === hostTurnId ? 'stopped' : 'stop-unconfirmed');
  }
  return phases;
}

export function phaseOf(
  receipt: RunningInputReceipt,
  channel: RunningInputChannel | undefined,
  stopPhases: RunningInputStopPhases
): RunningInputTurnPhase {
  const stop = stopPhases.get(receipt.requestId);
  if (stop) return stop;
  if (channel?.hostTurnId != null && receipt.hostTurnId != null && channel.hostTurnId !== receipt.hostTurnId) {
    return 'ended';
  }
  const { turn } = channel ?? {};
  if (channel?.bindingId === receipt.bindingId && turn?.active && turn.turnId === receipt.turnId) return 'active';
  return 'ended';
}

export function rejectReason(receipt: Extract<RunningInputReceipt, { status: 'rejected' }>): RunningInputRejectReason {
  if ('reason' in receipt) {
    if (receipt.reason === 'stale-turn' || receipt.reason === 'dedup-capacity') return receipt.reason;
    if (receipt.reason === 'native-line-limit' || receipt.reason === 'image-bytes') return 'too-large';
    return 'failed';
  }
  const { status, code } = receipt.failure;
  if (status === 429 || code === 'EXT_RATE_LIMITED') return 'rate-limited';
  if (status === 413 || code === 'EXT_TOO_LARGE') return 'too-large';
  if (code === 'EXT_STALE_BINDING' || code === 'EXT_NO_LIVE_TASK' || code === 'EXT_UNAVAILABLE') {
    return 'session-changed';
  }
  return 'failed';
}

/**
 * Build the notice rows in receipt order. A receipt stays with the turn it was sent to:
 * a late acceptance after that turn ended or was stopped is shown as such, and never as
 * part of a newer turn. Pixel receipts have their own rows with image details.
 */
export function buildRunningInputNotices(
  receipts: readonly RunningInputReceipt[],
  channel: RunningInputChannel | undefined,
  stopPhases: RunningInputStopPhases
): RunningInputNotice[] {
  const notices: RunningInputNotice[] = [];
  const turns = new Map<string, Extract<RunningInputNotice, { kind: 'queued' }>>();
  for (const receipt of receipts) {
    const { requestId, mode } = receipt;
    if (receipt.pixels) continue;
    if (receipt.status === 'queued') {
      const phase = phaseOf(receipt, channel, stopPhases);
      const key = turnKey(receipt.bindingId, receipt.turnId) + ':' + phase;
      const group = turns.get(key);
      if (group) {
        group.requestIds.push(requestId);
        if (!group.modes.includes(mode)) group.modes.push(mode);
        continue;
      }
      const notice = {
        kind: 'queued' as const,
        key: 'turn:' + key,
        requestIds: [requestId],
        modes: [mode],
        phase,
      };
      turns.set(key, notice);
      notices.push(notice);
    } else if (receipt.status === 'rejected') {
      notices.push({ kind: 'rejected', key: requestId, requestIds: [requestId], mode, reason: rejectReason(receipt) });
    } else {
      notices.push({ kind: receipt.status, key: requestId, requestIds: [requestId], mode });
    }
  }
  return notices;
}
