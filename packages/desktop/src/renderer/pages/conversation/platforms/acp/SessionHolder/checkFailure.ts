/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { isBackendHttpError } from '@/common/adapter/httpBridge';
import { normalizeAgentErrorResolution, type AgentErrorResolutionKind } from '@/common/chat/chatLib';

/**
 * Why a holder check ended without a lock result. It decides which existing guidance
 * the blocked notice shows; it never unblocks sending.
 * - `agent`: the host returned a structured agent error (e.g. `USER_AGENT_AUTH_REQUIRED`).
 * - `upstream`: the host answered a plain `BAD_GATEWAY`; the agent could not start, which
 *   includes agents that need a login (the host does not structure that on ensure).
 * - `unknown`: a transport failure or any other error.
 */
export type CheckFailure =
  | { kind: 'agent'; code: string; resolutions: AgentErrorResolutionKind[]; detail?: string }
  | { kind: 'upstream'; resolutions: AgentErrorResolutionKind[]; detail?: string }
  | { kind: 'unknown'; detail?: string };

/** Fallback guidance for agent codes whose payload carries no resolution. */
const DEFAULT_RESOLUTIONS: Record<string, AgentErrorResolutionKind> = {
  USER_AGENT_AUTH_REQUIRED: 'check_agent_login',
};

const UPSTREAM_RESOLUTIONS: AgentErrorResolutionKind[] = ['check_agent_login', 'check_agent_installation'];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const trimmed = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

export const classifyCheckFailure = (error: unknown): CheckFailure => {
  if (!isBackendHttpError(error)) {
    return { kind: 'unknown', detail: error instanceof Error ? trimmed(error.message) : undefined };
  }
  const details = isRecord(error.details) ? error.details : {};
  const detail = trimmed(details.detail) ?? trimmed(details.message) ?? trimmed(error.backendMessage);
  if (error.code.startsWith('USER_AGENT_')) {
    const resolution = normalizeAgentErrorResolution(details.resolution)?.kind ?? DEFAULT_RESOLUTIONS[error.code];
    return { kind: 'agent', code: error.code, resolutions: resolution ? [resolution] : [], detail };
  }
  if (error.code === 'BAD_GATEWAY') {
    return { kind: 'upstream', resolutions: UPSTREAM_RESOLUTIONS, detail };
  }
  return { kind: 'unknown', detail };
};
