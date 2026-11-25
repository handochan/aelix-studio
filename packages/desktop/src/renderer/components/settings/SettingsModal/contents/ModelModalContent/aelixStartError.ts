import type { TFunction } from 'i18next';
import { BackendConnectionError, isBackendHttpError } from '@/common/adapter/httpBridge';
import { AelixInitialModelUnconfirmed } from '@/renderer/services/runtime/aelixInitialModel';

const INIT_FAILURE_PREFIX = /^(?:Bad request:\s*)?acp_init_failed(?:\s*:\s*|$)/i;
const SOCKET_PATH_TOKEN = /(?<![\p{L}\p{N}_/\\-])socket_path_too_long(?![\p{L}\p{N}_/\\-])/u;

// Only display recognized diagnostic text. The rest may contain an arbitrary
// path, credential, or agent output, so drop it in full even if it contains spaces.
const SAFE_INIT_REASONS = [
  'Agent process exited before initialize handshake completed',
  'Agent initialization timed out',
  'Authentication required',
  'Builtin Aelix did not complete the ACP connection check',
  'Failed to spawn agent process',
  'Initialize handshake timed out',
  'Permission denied',
] as const;

function safeInitReason(reason: string): string | undefined {
  const text = reason.trimStart();
  const normalized = text.toLowerCase();
  const safe = SAFE_INIT_REASONS.find((prefix) => {
    const head = prefix.toLowerCase();
    return normalized.startsWith(head) && /^(?:[.:(]|\s|$)/.test(text.slice(head.length));
  });
  if (!safe) return undefined;

  const prefix = text.slice(0, safe.length);
  const suffix = text.slice(safe.length).trim();
  if (suffix === '.') return `${prefix}.`;
  return suffix ? `${prefix}…` : prefix;
}

function field(value: unknown, key: string): unknown {
  return value && typeof value === 'object' && key in value ? (value as Record<string, unknown>)[key] : undefined;
}

/** Select the localized error for a failed attempt to start an Aelix conversation. */
export function getAelixStartErrorMessage(error: unknown, t: TFunction, startingRuntime = false): string {
  const modelError = error instanceof AelixInitialModelUnconfirmed;
  const failure = modelError ? error.cause : error;
  if (failure instanceof BackendConnectionError) {
    return t('settings.nativeAuth.failed', { code: 'CONNECTION_LOST' });
  }

  if (isBackendHttpError(failure)) {
    const { backendMessage, details, body } = failure;
    const message = backendMessage ?? '';
    if (failure.status === 502 && message === 'BACKEND_UNREACHABLE') {
      return t('settings.nativeAuth.failed', { code: 'CONNECTION_LOST' });
    }

    const detail = field(details, 'detail');
    const kind = [
      field(field(details, 'data'), 'kind'),
      field(details, 'kind'),
      field(field(body, 'data'), 'kind'),
      field(field(field(body, 'error'), 'data'), 'kind'),
    ].find((value): value is string => typeof value === 'string' && value.length > 0);
    const socketPathTooLong =
      kind === undefined
        ? SOCKET_PATH_TOKEN.test(message) || (typeof detail === 'string' && SOCKET_PATH_TOKEN.test(detail))
        : kind === 'socket_path_too_long';
    if (socketPathTooLong) {
      return t('settings.nativeAuth.agentStartFailedWithReason', {
        reason: t('settings.nativeAuth.socketPathTooLong'),
      });
    }

    const prefix = INIT_FAILURE_PREFIX.exec(message);
    if (prefix || failure.code.toLowerCase() === 'acp_init_failed') {
      const reason = safeInitReason(message.slice(prefix?.[0].length ?? 0));
      return reason
        ? t('settings.nativeAuth.agentStartFailedWithReason', { reason })
        : t('settings.nativeAuth.agentStartFailed');
    }

    // The pinned Host maps ACP startup errors to this generic HTTP envelope.
    if (startingRuntime && failure.status === 502 && failure.code === 'BAD_GATEWAY') {
      return t('settings.nativeAuth.agentStartFailed');
    }
  }

  return modelError ? t('agent.model.switchFailed') : t('conversation.createFailed');
}
