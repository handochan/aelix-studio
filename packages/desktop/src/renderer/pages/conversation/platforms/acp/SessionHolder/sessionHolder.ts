/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { isBackendHttpError } from '@/common/adapter/httpBridge';
import type { IResponseMessage } from '@/common/adapter/ipcBridge';

/** Host code for ACP `-33001`: another writer holds the native session lock. */
export const SESSION_LOCKED_CODE = 'USER_AGENT_SESSION_LOCKED';

/**
 * Who holds the session, as far as `data.lockedBy` can tell:
 * - `native`: the native writer lock (the CLI or another Aelix process)
 * - `other`: any other holder. `lockedBy: 'acp'` means another client holds the ACP
 *   lease, which can be another Studio window or a separate adapter process, so it
 *   gets neutral wording until the holder can be identified (request R7).
 */
export type SessionHolderKind = 'native' | 'other';

export type SessionHolder = {
  kind: SessionHolderKind;
  /** Verbatim `data.holder`. Always `null` until native exposes holder details (request R7). */
  holder: unknown;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const holderFromLockData = (data: unknown): SessionHolder => {
  const record = isRecord(data) ? data : {};
  return {
    kind: record.lockedBy === 'native' ? 'native' : 'other',
    holder: record.holder ?? null,
  };
};

/**
 * Reads a lock conflict from a failed host HTTP call such as `runtime/ensure`.
 * The host answers 502 with the host code at the top level and the ACP payload in `details.data`.
 */
export const sessionHolderFromError = (error: unknown): SessionHolder | null => {
  if (!isBackendHttpError(error) || error.code !== SESSION_LOCKED_CODE) return null;
  const details = isRecord(error.details) ? error.details : {};
  return holderFromLockData(details.data);
};

/**
 * Reads a lock conflict from a conversation stream event. Like the message list, it
 * prefers the structured payload in `data.error` and falls back to `data` itself;
 * only error tips and raw `error` events count.
 */
export const sessionHolderFromStreamMessage = (message: IResponseMessage): SessionHolder | null => {
  if (message.type !== 'tips' && message.type !== 'error') return null;
  const data = message.data;
  if (!isRecord(data) || (message.type === 'tips' && data.type !== 'error')) return null;
  const payload = isRecord(data.error) ? data.error : data;
  return payload.code === SESSION_LOCKED_CODE ? holderFromLockData(payload.data) : null;
};
