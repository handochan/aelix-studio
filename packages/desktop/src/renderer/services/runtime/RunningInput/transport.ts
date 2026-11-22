import { fetchFromDesktopOrBrowser } from '@/common/adapter/desktopBackendFetch';
import { getBaseUrl, resolveCoreCsrfToken } from '@/common/adapter/httpBridge';

export const INPUT_METHODS = {
  state: '_aelix/session/input/state',
  steer: '_aelix/session/input/steer',
  'follow-up': '_aelix/session/input/follow-up',
  lookup: '_aelix/session/requests/lookup',
  imageState: '_aelix/session/input/image-state',
  steerImages: '_aelix/session/input/steer-images',
  followUpImages: '_aelix/session/input/follow-up-images',
} as const;

const RELAY_CODES = [
  'AUTH_REQUIRED',
  'CONVERSATION_NOT_FOUND',
  'CSRF_INVALID',
  'EXT_AGENT_ERROR',
  'EXT_INVALID',
  'EXT_MEDIA_TYPE',
  'EXT_METHOD_DENIED',
  'EXT_NO_LIVE_TASK',
  'EXT_OUTCOME_UNKNOWN',
  'EXT_RATE_LIMITED',
  'EXT_STALE_BINDING',
  'EXT_TOO_LARGE',
  'EXT_UNAVAILABLE',
  'SOURCE_FORBIDDEN',
] as const;

export type RelayFailure = Readonly<{
  status: number;
  code?: (typeof RELAY_CODES)[number];
  rpcCode?: number;
}>;

type RelayReply = { kind: 'success'; data: unknown } | { kind: 'failure'; failure: RelayFailure };
export type RelayCall = {
  bindingId: string;
  method: (typeof INPUT_METHODS)[keyof typeof INPUT_METHODS];
  payload: Record<string, string | readonly string[]>;
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Use the normal desktop credential or WebUI cookie without the generic bridge's logging and replay. */
export async function requestRelay(path: string, body?: string, lifetime?: AbortSignal): Promise<RelayReply> {
  const headers: Record<string, string> = {};
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    const csrf = resolveCoreCsrfToken();
    if (csrf) headers['x-csrf-token'] = csrf;
  }

  try {
    const response = await fetchFromDesktopOrBrowser(getBaseUrl() + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers,
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      body,
      signal: lifetime ? AbortSignal.any([lifetime, AbortSignal.timeout(125_000)]) : AbortSignal.timeout(125_000),
    });
    const responseBody: unknown = await response.json().catch((): undefined => undefined);
    if (response.ok && isRecord(responseBody) && responseBody.success === true) {
      return { kind: 'success', data: responseBody.data };
    }
    const code = isRecord(responseBody) ? RELAY_CODES.find((known) => known === responseBody.code) : undefined;
    const details = isRecord(responseBody) ? responseBody.details : undefined;
    const rpcCode = code === 'EXT_AGENT_ERROR' && isRecord(details) ? details.rpcCode : undefined;
    return {
      kind: 'failure',
      failure: {
        status: response.status,
        code,
        rpcCode: typeof rpcCode === 'number' && Number.isSafeInteger(rpcCode) ? rpcCode : undefined,
      },
    };
  } catch {
    return { kind: 'failure', failure: { status: 0 } };
  }
}

/** Encode a 48-bit Unix epoch with RFC 9562 version and variant bits and 74 random bits. */
export function createRequestId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const view = new DataView(bytes.buffer);
  const now = Date.now();
  view.setUint16(0, Math.floor(now / 2 ** 32));
  view.setUint32(2, now);
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}
