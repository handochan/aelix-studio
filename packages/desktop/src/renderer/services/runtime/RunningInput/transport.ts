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
  'INTERNAL_ERROR',
  'SOURCE_FORBIDDEN',
] as const;

export type RelayFailure = Readonly<{
  status: number;
  code?: (typeof RELAY_CODES)[number];
  rpcCode?: number;
  reportedCode?: string;
  emptyBody?: boolean;
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

type JsonBody = { body: unknown; empty: boolean };

/** Send one JSON request and preserve the status of replies with malformed or empty bodies. */
export async function requestJson(
  url: string,
  init: RequestInit,
  lifetime: AbortSignal | undefined,
  timeoutMs: number,
  maxResponseBytes?: number
): Promise<JsonBody & { status: number }> {
  try {
    const timeout = AbortSignal.timeout(timeoutMs);
    const response = await fetchFromDesktopOrBrowser(url, {
      ...init,
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      signal: lifetime ? AbortSignal.any([lifetime, timeout]) : timeout,
    });
    try {
      const parsed =
        maxResponseBytes === undefined
          ? { body: (await response.json()) as unknown, empty: false }
          : await readBoundedJson(response, maxResponseBytes);
      return { status: response.status, ...parsed };
    } catch {
      // The caller classifies a missing or invalid envelope using the HTTP status.
      return { status: response.status, body: undefined, empty: false };
    }
  } catch {
    return { status: 0, body: undefined, empty: false };
  }
}

async function readBoundedJson(response: Response, limit: number): Promise<JsonBody> {
  const reader = response.body?.getReader();
  if (!reader) return { body: undefined, empty: true };
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0;
  let text = '';
  try {
    for (;;) {
      // Read in order and cancel as soon as the envelope exceeds the limit.
      // oxlint-disable-next-line no-await-in-loop
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) return { body: undefined, empty: false };
      text += decoder.decode(value, { stream: true });
    }
    if (size === 0) return { body: undefined, empty: true };
    const body: unknown = JSON.parse(text + decoder.decode());
    return { body, empty: body === null };
  } finally {
    void reader.cancel().catch((): undefined => undefined);
    reader.releaseLock();
  }
}

/** Use the normal desktop credential or WebUI cookie without the generic bridge's logging and replay. */
export async function requestRelay(
  path: string,
  body?: string,
  lifetime?: AbortSignal,
  maxResponseBytes?: number
): Promise<RelayReply> {
  const headers: Record<string, string> = {};
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    const csrf = resolveCoreCsrfToken();
    if (csrf) headers['x-csrf-token'] = csrf;
  }

  const {
    status,
    body: responseBody,
    empty,
  } = await requestJson(
    getBaseUrl() + path,
    {
      method: body === undefined ? 'GET' : 'POST',
      headers,
      body,
    },
    lifetime,
    125_000,
    maxResponseBytes
  );
  const ok = maxResponseBytes === undefined ? status >= 200 && status <= 299 : status === 200;
  if (ok && isRecord(responseBody) && responseBody.success === true) {
    return { kind: 'success', data: responseBody.data };
  }
  const code = isRecord(responseBody) ? RELAY_CODES.find((known) => known === responseBody.code) : undefined;
  const rawCode = isRecord(responseBody) ? responseBody.code : undefined;
  const reportedCode =
    typeof rawCode === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(rawCode) ? rawCode : undefined;
  const details = isRecord(responseBody) ? responseBody.details : undefined;
  const rpcCode = code === 'EXT_AGENT_ERROR' && isRecord(details) ? details.rpcCode : undefined;
  return {
    kind: 'failure',
    failure: {
      status,
      code,
      rpcCode: typeof rpcCode === 'number' && Number.isSafeInteger(rpcCode) ? rpcCode : undefined,
      ...(maxResponseBytes === undefined ? {} : { reportedCode, emptyBody: empty }),
    },
  };
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
