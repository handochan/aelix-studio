import type { TFunction } from 'i18next';
import { BackendConnectionError, isBackendHttpError } from '@/common/adapter/httpBridge';
import { AelixInitialModelUnconfirmed } from '@/renderer/services/runtime/aelixInitialModel';

const INIT_FAILURE_PREFIX = /^(?:Bad request:\s*)?acp_init_failed(?:\s*:\s*|$)/i;
const SESSION_NEW_SOCKET_ERROR_PREFIX = 'ACP session/new failed: Agent protocol error (code -33004): ';
const ACP_SOCKET_ERROR_MESSAGE =
  /^Could not create a session directory for a Unix socket within the \d+-byte AF_UNIX limit \(including the terminating NUL\)\. Set TMPDIR to a shorter, writable directory\. \(/;

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

// Older Host probes append ACP's JSON data to the session/new error.
function serializedSessionNewKind(reason: string): unknown {
  if (!reason.startsWith(SESSION_NEW_SOCKET_ERROR_PREFIX) || !reason.endsWith('})')) return undefined;
  const text = reason.slice(SESSION_NEW_SOCKET_ERROR_PREFIX.length);
  const message = ACP_SOCKET_ERROR_MESSAGE.exec(text)?.[0];
  if (!message) return undefined;
  try {
    return field(JSON.parse(text.slice(message.length, -1)), 'kind');
  } catch {
    return undefined;
  }
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

    const prefix = INIT_FAILURE_PREFIX.exec(message);
    const reason = message.slice(prefix?.[0].length ?? 0);
    const kind = [
      field(field(details, 'data'), 'kind'),
      field(details, 'kind'),
      field(field(body, 'data'), 'kind'),
      field(field(field(body, 'error'), 'data'), 'kind'),
      field(body, 'kind'),
    ].find((value): value is string => typeof value === 'string' && value.length > 0);
    const probeKind =
      kind === undefined && prefix && failure.status === 400 && failure.code === 'BAD_REQUEST'
        ? serializedSessionNewKind(reason)
        : undefined;
    if ((kind ?? probeKind) === 'socket_path_too_long') {
      return t('settings.nativeAuth.agentStartFailedWithReason', {
        reason: t('settings.nativeAuth.socketPathTooLong'),
      });
    }

    if (prefix || failure.code.toLowerCase() === 'acp_init_failed') {
      const safeReason = safeInitReason(reason);
      return safeReason
        ? t('settings.nativeAuth.agentStartFailedWithReason', { reason: safeReason })
        : t('settings.nativeAuth.agentStartFailed');
    }

    // The pinned Host maps ACP startup errors to this generic HTTP envelope.
    if (startingRuntime && failure.status === 502 && failure.code === 'BAD_GATEWAY') {
      return t('settings.nativeAuth.agentStartFailed');
    }
  }

  return modelError ? t('agent.model.switchFailed') : t('conversation.createFailed');
}
