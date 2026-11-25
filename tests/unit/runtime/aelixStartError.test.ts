import { beforeAll, describe, expect, it } from 'vitest';
import { createInstance } from 'i18next';
import { BackendConnectionError, BackendHttpError } from '@/common/adapter/httpBridge';
import settings from '@/renderer/services/i18n/locales/en-US/settings.json';
import agent from '@/renderer/services/i18n/locales/en-US/agent.json';
import conversation from '@/renderer/services/i18n/locales/en-US/conversation.json';
import { AelixInitialModelUnconfirmed } from '@/renderer/services/runtime/aelixInitialModel';
import { getAelixStartErrorMessage } from '@/renderer/components/settings/SettingsModal/contents/ModelModalContent/aelixStartError';

const i18n = createInstance();

function hostError(body: unknown, status = 400): BackendHttpError {
  return new BackendHttpError({ method: 'POST', path: '/api/conversations', status, body });
}

function messageFor(error: unknown): string {
  return getAelixStartErrorMessage(error, i18n.t);
}

describe('Aelix conversation start errors', () => {
  beforeAll(async () => {
    await i18n.init({
      lng: 'en',
      resources: { en: { translation: { settings, agent, conversation } } },
    });
  });

  const expectedSocketHint = settings.nativeAuth.agentStartFailedWithReason.replace(
    '{{reason}}',
    settings.nativeAuth.socketPathTooLong
  );

  it.each([
    { code: 'acp_init_failed', kind: 'socket_path_too_long' },
    { code: 'acp_init_failed', details: { kind: 'socket_path_too_long' } },
    { code: 'acp_init_failed', details: { data: { kind: 'socket_path_too_long' } } },
    { code: 'acp_init_failed', data: { kind: 'socket_path_too_long' } },
    { error: { code: -33004, data: { kind: 'socket_path_too_long' } } },
  ])('shows the TMPDIR hint for a structured socket kind (%j)', (body) => {
    expect(messageFor(hostError(body))).toBe(expectedSocketHint);
  });

  const probeError =
    'acp_init_failed: ACP session/new failed: Agent protocol error (code -33004): ' +
    'Could not create a session directory for a Unix socket within the 104-byte AF_UNIX limit ' +
    '(including the terminating NUL). Set TMPDIR to a shorter, writable directory.';

  it('reads the kind from the ACP data serialized by the custom registration probe', () => {
    const error = new BackendHttpError({
      method: 'POST',
      path: '/api/agents/custom',
      status: 400,
      body: {
        success: false,
        code: 'BAD_REQUEST',
        error: probeError + ' ({"kind":"socket_path_too_long","limitBytes":104,"retryable":false})',
      },
    });
    expect(messageFor(error)).toBe(expectedSocketHint);
  });

  it.each([
    'CLI exited before ACP initialize completed (status=1): stderr mentions socket_path_too_long ({"kind":"socket_path_too_long"})',
    'ACP initialize failed: file C:\\tmp\\a.socket_path_too_long.exe does not exist',
    'ACP session/new failed: Agent protocol error (code -33004): stderr mentions socket_path_too_long',
    'ACP session/new failed: Agent protocol error (code -33004): arbitrary agent text ({"kind":"socket_path_too_long"})',
  ])('uses the generic failure when only free text carries the socket kind', (reason) => {
    expect(messageFor(hostError({ code: 'BAD_REQUEST', error: `acp_init_failed: ${reason}` }))).toBe(
      settings.nativeAuth.agentStartFailed
    );
  });

  it.each(['{"detail":{"kind":"socket_path_too_long"}}', '{"kind":"socket_path_too_long",}'])(
    'requires a valid top-level kind in serialized ACP data (%s)',
    (json) => {
      expect(messageFor(hostError({ code: 'BAD_REQUEST', error: `${probeError} (${json})` }))).toBe(
        settings.nativeAuth.agentStartFailed
      );
    }
  );

  it('does not treat the socket token in an unrelated HTTP error as an ACP failure', () => {
    expect(
      messageFor(
        hostError(
          {
            code: 'INTERNAL_ERROR',
            error: 'Service failed: socket_path_too_long',
            details: { detail: '{"kind":"socket_path_too_long"}' },
          },
          500
        )
      )
    ).toBe(conversation.createFailed);
  });

  it('prefers an explicitly structured kind over the serialized probe data', () => {
    expect(
      messageFor(
        hostError({
          code: 'BAD_REQUEST',
          error: probeError + ' ({"kind":"socket_path_too_long"})',
          details: { kind: 'different_failure' },
        })
      )
    ).toBe(settings.nativeAuth.agentStartFailed);
  });

  it('appends a known safe reason', () => {
    expect(messageFor(hostError({ code: 'acp_init_failed', error: 'Initialize handshake timed out.' }))).toBe(
      'Aelix agent could not start. Initialize handshake timed out.'
    );
  });

  it.each([
    'Failed to spawn agent process: /Users/tester/private directory/agent auth=fixture-secret',
    'Failed to spawn agent process (C:\\Users\\tester\\private directory\\agent.exe); Bearer fixture-secret',
    'Failed to spawn agent process at \\\\server\\share\\private directory ' + 'x'.repeat(250),
  ])('limits the shown reason to a known safe prefix', (reason) => {
    expect(messageFor(hostError({ error: `acp_init_failed: ${reason}` }))).toBe(
      'Aelix agent could not start. Failed to spawn agent process…'
    );
  });

  it('omits an unrecognized reason entirely', () => {
    expect(
      messageFor(hostError({ error: 'acp_init_failed: arbitrary diagnostic, fixture-secret at /tmp/private' }))
    ).toBe(settings.nativeAuth.agentStartFailed);
  });

  it('preserves the connection failure classification through model confirmation', () => {
    const cause = new BackendConnectionError(new TypeError('Failed to fetch'));

    expect(messageFor(new AelixInitialModelUnconfirmed('unconfirmed', { cause }))).toBe(
      settings.nativeAuth.failed.replace('{{code}}', 'CONNECTION_LOST')
    );
  });

  it('does not classify a local TypeError as connection loss', () => {
    expect(messageFor(new TypeError('Cannot read conversation id'))).toBe(conversation.createFailed);
  });
});
