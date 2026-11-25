import { beforeAll, describe, expect, it } from 'vitest';
import { createInstance } from 'i18next';
import { BackendConnectionError, BackendHttpError } from '@/common/adapter/httpBridge';
import settings from '@/renderer/services/i18n/locales/en-US/settings.json';
import agent from '@/renderer/services/i18n/locales/en-US/agent.json';
import conversation from '@/renderer/services/i18n/locales/en-US/conversation.json';
import { AelixInitialModelUnconfirmed } from '@/renderer/services/runtime/aelixInitialModel';
import { getAelixStartErrorMessage } from '@/renderer/components/settings/SettingsModal/contents/ModelModalContent/aelixStartError';

const i18n = createInstance();

function hostError(body: unknown): BackendHttpError {
  return new BackendHttpError({ method: 'POST', path: '/api/conversations', status: 400, body });
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

  it.each([
    { code: 'acp_init_failed', details: { kind: 'socket_path_too_long' } },
    { code: 'acp_init_failed', details: { data: { kind: 'socket_path_too_long' } } },
    { code: 'acp_init_failed', data: { kind: 'socket_path_too_long' } },
    { code: 'BAD_REQUEST', error: 'acp_init_failed: Agent protocol error (-33004) ({"kind":"socket_path_too_long"})' },
    { code: 'BAD_GATEWAY', details: { detail: 'Agent protocol error (-33004) ({"kind":"socket_path_too_long"})' } },
  ])('shows only the localized path guidance for a recognized socket error (%j)', (body) => {
    expect(messageFor(hostError(body))).toBe(
      settings.nativeAuth.agentStartFailedWithReason.replace('{{reason}}', settings.nativeAuth.socketPathTooLong)
    );
  });

  it.each(['socket_path_too_longer', 'other-socket_path_too_long', '/tmp/socket_path_too_long'])(
    'ignores the socket kind embedded in %s',
    (token) => {
      expect(messageFor(hostError({ error: `acp_init_failed: ${token}` }))).toBe(settings.nativeAuth.agentStartFailed);
    }
  );

  it('prefers the structured kind over a socket token in the error string', () => {
    expect(
      messageFor(
        hostError({ code: 'acp_init_failed', error: 'socket_path_too_long', details: { kind: 'different_failure' } })
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
