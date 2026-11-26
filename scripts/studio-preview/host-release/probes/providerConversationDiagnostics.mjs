import { boundedWait } from '../verification.mjs';

const codes = new Set([
  'AUTH_REQUIRED',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'BAD_REQUEST',
  'NOT_FOUND',
  'CONFLICT',
  'UNPROCESSABLE_ENTITY',
  'RATE_LIMITED',
  'INTERNAL_ERROR',
  'BACKEND_UNREACHABLE',
  'BAD_GATEWAY',
  'GATEWAY_TIMEOUT',
  'TIMEOUT',
  'WORKSPACE_PATH_UNAVAILABLE',
  'WORKSPACE_PATH_RUNTIME_UNAVAILABLE',
  'runtime_restarting',
  'acp_init_failed',
  'USER_AGENT_SESSION_LOCKED',
  'USER_AGENT_TURN_FAILED_AFTER_DISPATCH',
]);
const kinds = new Set(['socket_path_too_long', 'session_locked', 'turn_failed_after_dispatch']);

function routeType(request, backendOrigin) {
  if (request.method() !== 'POST') return null;
  const url = URL.parse(request.url());
  if (url?.origin !== backendOrigin) return null;
  if (url.pathname === '/api/conversations') return 'conversation_create';
  if (/^\/api\/conversations\/[^/]+\/runtime\/ensure$/.test(url.pathname)) return 'runtime_ensure';
  return null;
}

/** Track only the two Desktop start requests made while the smoke opens a conversation. */
export function observeProviderConversationStart(page, backendPort) {
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const requests = new Map();
  const onRequest = (request) => {
    const route = routeType(request, backendOrigin);
    if (!route) return;
    requests.set(request, {
      response: null,
      finished: false,
      fields: { route, status: null, code: null, detailsKind: null, endedWithoutResponse: false },
    });
  };
  const onResponse = (response) => {
    const entry = requests.get(response.request());
    if (!entry) return;
    entry.response = response;
    entry.fields.status = response.status();
  };
  const onFinished = (request) => {
    const entry = requests.get(request);
    if (entry) entry.finished = true;
  };
  const onFailed = (request) => {
    const entry = requests.get(request);
    if (entry) entry.fields.endedWithoutResponse = entry.response === null;
  };
  const listeners = [
    ['request', onRequest],
    ['response', onResponse],
    ['requestfinished', onFinished],
    ['requestfailed', onFailed],
  ];
  for (const [event, listener] of listeners) page.on(event, listener);
  const dispose = () => {
    for (const [event, listener] of listeners) page.off(event, listener);
  };

  return {
    dispose,
    async failureReceipt() {
      dispose();
      const entries = [...requests.values()];
      const reads = entries
        .filter(({ finished, response }) => finished && response)
        .map(async ({ response, fields }) => {
          try {
            const payload = await response.json();
            if (codes.has(payload?.code)) fields.code = payload.code;
            fields.detailsKind =
              [payload?.details?.kind, payload?.details?.data?.kind].find((kind) => kinds.has(kind)) ?? null;
          } catch {
            // The HTTP status is still evidence if the body cannot be read or parsed.
          }
        });
      if (reads.length) {
        await boundedWait(Promise.all(reads), 'provider-start-failure-receipt', { timeoutMs: 1500 }).catch(() => {});
      }
      return entries.map(({ fields }) => ({ ...fields }));
    },
  };
}
