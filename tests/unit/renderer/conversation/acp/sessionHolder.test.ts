/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { BackendHttpError } from '@/common/adapter/httpBridge';
import type { IResponseMessage } from '@/common/adapter/ipcBridge';
import {
  sessionHolderFromError,
  sessionHolderFromStreamMessage,
} from '@/renderer/pages/conversation/platforms/acp/SessionHolder/sessionHolder';
import { classifyCheckFailure } from '@/renderer/pages/conversation/platforms/acp/SessionHolder/checkFailure';

const ensureError = (code: string, details?: unknown) =>
  new BackendHttpError({
    method: 'POST',
    path: '/api/conversations/c1/runtime/ensure',
    status: 502,
    body: { code, error: 'upstream failure', details },
  });

const lockDetails = (lockedBy: unknown) => ({
  protocol_code: -33001,
  retryable: false,
  data: { kind: 'session_locked', sessionId: 's1', lockedBy, holder: null, retryable: false },
});

const streamMessage = (type: string, data: unknown): IResponseMessage =>
  ({ type, data, msg_id: 'm1', conversation_id: 'c1' }) as IResponseMessage;

describe('sessionHolderFromError', () => {
  it.each([
    ['native', 'native'],
    // An ACP lease can belong to another Studio window or a separate adapter process.
    ['acp', 'other'],
    ['someone-else', 'other'],
  ])('maps lockedBy=%s from the ensure 502 to %s', (lockedBy, kind) => {
    expect(sessionHolderFromError(ensureError('USER_AGENT_SESSION_LOCKED', lockDetails(lockedBy)))).toEqual({
      kind,
      holder: null,
    });
  });

  it('keeps a populated holder verbatim for a future holder contract', () => {
    const details = { data: { lockedBy: 'native', holder: { client: 'cli' } } };
    expect(sessionHolderFromError(ensureError('USER_AGENT_SESSION_LOCKED', details))?.holder).toEqual({
      client: 'cli',
    });
  });

  it('treats a lock error without details as another holder', () => {
    expect(sessionHolderFromError(ensureError('USER_AGENT_SESSION_LOCKED'))).toEqual({ kind: 'other', holder: null });
  });

  it.each([
    ['another host code', ensureError('USER_AGENT_BUSY', { protocol_code: -32000 })],
    ['a plain error', new Error('USER_AGENT_SESSION_LOCKED')],
    ['a non-error value', 'USER_AGENT_SESSION_LOCKED'],
  ])('ignores %s', (_label, error) => {
    expect(sessionHolderFromError(error)).toBeNull();
  });
});

describe('sessionHolderFromStreamMessage', () => {
  it('reads the lock payload from a streamed error tip', () => {
    const tip = streamMessage('tips', {
      type: 'error',
      content: 'locked',
      code: 'USER_AGENT_SESSION_LOCKED',
      error: {
        message: 'locked',
        code: 'USER_AGENT_SESSION_LOCKED',
        protocol_code: -33001,
        data: lockDetails('acp').data,
      },
    });
    expect(sessionHolderFromStreamMessage(tip)).toEqual({ kind: 'other', holder: null });
  });

  it('reads the lock payload from a raw error event', () => {
    const event = streamMessage('error', {
      message: 'locked',
      code: 'USER_AGENT_SESSION_LOCKED',
      data: lockDetails('native').data,
    });
    expect(sessionHolderFromStreamMessage(event)).toEqual({ kind: 'native', holder: null });
  });

  it('falls back to top-level fields of an error tip without a structured error', () => {
    const tip = streamMessage('tips', {
      type: 'error',
      code: 'USER_AGENT_SESSION_LOCKED',
      data: { lockedBy: 'native' },
    });
    expect(sessionHolderFromStreamMessage(tip)).toEqual({ kind: 'native', holder: null });
  });

  it.each([
    ['another error tip', streamMessage('tips', { type: 'error', error: { code: 'USER_AGENT_BUSY' } })],
    ['a tip without data', streamMessage('tips', null)],
    ['a non-error tip', streamMessage('tips', { type: 'warning', code: 'USER_AGENT_SESSION_LOCKED' })],
    ['an unrelated event type', streamMessage('content', { error: { code: 'USER_AGENT_SESSION_LOCKED' } })],
  ])('ignores %s', (_label, message) => {
    expect(sessionHolderFromStreamMessage(message)).toBeNull();
  });
});

describe('classifyCheckFailure', () => {
  it('keeps a structured agent error with its resolution', () => {
    const details = { message: 'auth', code: 'USER_AGENT_AUTH_REQUIRED', resolution: { kind: 'check_agent_login' } };
    expect(classifyCheckFailure(ensureError('USER_AGENT_AUTH_REQUIRED', details))).toEqual({
      kind: 'agent',
      code: 'USER_AGENT_AUTH_REQUIRED',
      resolutions: ['check_agent_login'],
      detail: 'auth',
    });
  });

  it('falls back to the login suggestion for an auth error without a resolution', () => {
    expect(classifyCheckFailure(ensureError('USER_AGENT_AUTH_REQUIRED'))).toMatchObject({
      kind: 'agent',
      resolutions: ['check_agent_login'],
    });
  });

  it('suggests agent login and installation for a plain upstream failure', () => {
    expect(classifyCheckFailure(ensureError('BAD_GATEWAY'))).toEqual({
      kind: 'upstream',
      resolutions: ['check_agent_login', 'check_agent_installation'],
      detail: 'upstream failure',
    });
  });

  it.each([
    ['a transport failure', new TypeError('Failed to fetch'), 'Failed to fetch'],
    ['another host error', ensureError('INTERNAL_ERROR'), 'upstream failure'],
    ['a non-error value', 'boom', undefined],
  ])('gives no agent guidance for %s', (_label, error, detail) => {
    expect(classifyCheckFailure(error)).toEqual({ kind: 'unknown', detail });
  });
});
