import type { RelayFailure } from '../RunningInput/transport';
import type {
  GlobalSelections,
  ProfileCatalog,
  ResourceFailure,
  ResourceMismatch,
  ResourceResult,
  SessionSelections,
  WriteReport,
} from './types';

export const RELAY_REQUEST_BYTES = 64 * 1024;
export const RELAY_RESPONSE_BYTES = 256 * 1024;
export const HELPER_FRAME_BYTES = 60_000;
const encoder = new TextEncoder();

export function byteLength(value: string): number {
  return encoder.encode(value).length;
}

export function failure(
  status: ResourceFailure['status'],
  reason: string,
  action: ResourceFailure['action'] = 'refresh'
): ResourceFailure {
  return { status, reason, action, retryWrite: false };
}

export function invalidReply(writing: boolean, global = false): ResourceFailure {
  return writing
    ? failure('unknown', 'invalid-response', global ? 'refresh-and-choose' : 'lookup-and-refresh')
    : failure('invalid-response', 'invalid-response');
}

export function invalidInput(): ResourceFailure {
  return failure('invalid-input', 'invalid-input');
}

export function staleBinding(): ResourceFailure {
  return failure('stale', 'EXT_STALE_BINDING', 'rediscover');
}

export function stalePage(): ResourceFailure {
  return failure('stale', 'cursor-stale');
}

export function unsupported(reason = 'unsupported'): ResourceFailure {
  return failure('unsupported', reason, 'disable-control');
}

export function success<T>(data: T): ResourceResult<T> {
  return { status: 'success', data };
}

export function rpcFailure(code: number, writing: boolean): ResourceFailure {
  if (code === -32601) return unsupported('rpc/-32601');
  if (code === -32602 || code === -33102) return failure('refused', 'rpc/' + code);
  if (code === -33100) return failure('unknown', 'EXT_OUTCOME_UNKNOWN', 'lookup-and-refresh');
  return writing ? failure('unknown', 'rpc/' + code, 'lookup-and-refresh') : failure('error', 'rpc/' + code);
}

export function transportFailure(
  { status, code, rpcCode, reportedCode, emptyBody }: RelayFailure,
  writing: boolean
): ResourceFailure {
  if (status === 401 && code === 'AUTH_REQUIRED') return failure('unauthenticated', code, 'sign-in-and-read');
  if (status === 409 && code === 'EXT_NO_LIVE_TASK') return failure('detached', code, 'rediscover-on-attach');
  if (status === 409 && code === 'EXT_STALE_BINDING') return staleBinding();
  if (status === 409 && code === 'EXT_UNAVAILABLE') return unsupported(code);
  if (status === 404 && emptyBody && !writing) return unsupported();
  if (status === 422 && code === 'EXT_AGENT_ERROR' && rpcCode !== undefined) return rpcFailure(rpcCode, writing);
  if (status === 409 || status === 502 || status === 504) {
    if (code === 'EXT_OUTCOME_UNKNOWN') return failure('unknown', code, 'lookup-and-refresh');
  }
  const reason = code ?? reportedCode ?? (status === 0 ? 'no-reply' : 'http/' + status);
  if (!writing && status >= 200 && status < 400) return invalidReply(false);
  if (
    (status === 403 && (code === 'SOURCE_FORBIDDEN' || code === 'CSRF_INVALID' || code === 'EXT_METHOD_DENIED')) ||
    (status === 404 && code === 'CONVERSATION_NOT_FOUND') ||
    (status === 400 && code === 'EXT_INVALID') ||
    (status === 413 && code === 'EXT_TOO_LARGE') ||
    (status === 415 && code === 'EXT_MEDIA_TYPE') ||
    (status === 429 && code === 'EXT_RATE_LIMITED')
  ) {
    return code === 'EXT_METHOD_DENIED' ? unsupported(code) : failure('refused', reason);
  }
  if (writing && status >= 200 && status < 400) return invalidReply(true);
  return writing ? failure('unknown', reason, 'lookup-and-refresh') : failure('error', reason);
}

export type Receipt<T> = {
  status: NonNullable<WriteReport<T, unknown>['receipt']>;
  outcome?: ResourceResult<T>;
};

/** A current-state read helps reconciliation. Only a valid receipt can settle an ambiguous dispatch. */
export async function reconcileWrite<T, State>(
  outcome: ResourceResult<T>,
  requestId: string,
  lookup: (() => Promise<Receipt<T>>) | undefined,
  refresh: (outcome: ResourceResult<T>) => Promise<ResourceResult<State>>
): Promise<WriteReport<T, State>> {
  const receipt = outcome.status === 'unknown' && lookup ? await lookup() : undefined;
  const settled = receipt?.outcome ?? outcome;
  return {
    outcome: settled,
    requestId,
    ...(receipt ? { receipt: receipt.status } : {}),
    refresh: await refresh(settled),
  };
}

type Page = ProfileCatalog | GlobalSelections | SessionSelections;
type PageInput = { limit?: number } | { cursor: string };

function compareUtf8(left: string, right: string): number {
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

function keys(page: Page): string[] {
  return 'profiles' in page ? page.profiles.map(({ ref }) => ref.name) : page.items.map(({ key }) => key);
}

function header(page: Page): string {
  const { complete: _complete, nextCursor: _cursor, diagnostics: _diagnostics, ...fields } = page;
  if ('profiles' in fields) {
    const { profiles: _profiles, inspected: _inspected, ...rest } = fields;
    return JSON.stringify(rest);
  }
  const { items: _items, mismatches: _mismatches, ...rest } = fields;
  return JSON.stringify(rest);
}

function combine<T extends Page>(previous: T | undefined, next: T, issues: readonly ResourceMismatch[]): T {
  if ('profiles' in next) {
    return { ...next, profiles: [...(previous && 'profiles' in previous ? previous.profiles : []), ...next.profiles] };
  }
  const byKey = new Map<string, ResourceMismatch[]>();
  for (const issue of issues) {
    if (issue.key === null) continue;
    const entries = byKey.get(issue.key) ?? [];
    entries.push(issue);
    byKey.set(issue.key, entries);
  }
  return {
    ...next,
    items: [
      ...(previous && 'items' in previous ? previous.items : []),
      ...next.items.map((item) => ({ ...item, mismatches: byKey.get(item.key) ?? [] })),
    ],
    mismatches: issues,
  };
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Maintain one validated snapshot and its opaque cursor chain inside a single owner/selector context. */
export function createPages<T extends Page>() {
  let current: T | undefined;
  let lastKey: string | undefined;
  let generation = 0;
  let requestedLimit: number | undefined;
  let issues: ((page: T) => readonly ResourceMismatch[]) | undefined;
  const cursors = new Set<string>();

  function clear(): void {
    generation++;
    current = undefined;
    lastKey = undefined;
    issues = undefined;
    cursors.clear();
  }

  async function load(
    fetchPage: (page: PageInput) => Promise<ResourceResult<T>>,
    input: PageInput,
    mismatches?: (page: T) => readonly ResourceMismatch[]
  ): Promise<ResourceResult<T>> {
    const continuing = 'cursor' in input;
    if (!continuing) {
      clear();
      requestedLimit = input.limit;
      issues = mismatches;
    }
    const run = ++generation;
    const reply = await fetchPage(input);
    if (run !== generation) return reply.status === 'success' ? stalePage() : reply;

    if (reply.status !== 'success') {
      if (continuing && (reply.reason === 'cursor-stale' || reply.reason === 'CURSOR_STALE')) {
        return load(fetchPage, requestedLimit === undefined ? {} : { limit: requestedLimit }, issues);
      }
      if (reply.status === 'invalid-response') clear();
      return reply;
    }

    const page = reply.data;
    const pageKeys = keys(page);
    const limit = requestedLimit ?? 40;
    const invalidKeys = pageKeys.some((key, index) => {
      const previous = index === 0 ? lastKey : pageKeys[index - 1];
      return previous !== undefined && compareUtf8(previous, key) >= 0;
    });
    if (
      invalidKeys ||
      pageKeys.length > limit ||
      (page.nextCursor !== null && cursors.has(page.nextCursor)) ||
      (current && header(page) !== header(current))
    ) {
      clear();
      return invalidReply(false);
    }
    if (page.nextCursor !== null) cursors.add(page.nextCursor);
    lastKey = pageKeys.at(-1) ?? lastKey;
    const diagnostics = [...(current?.diagnostics ?? []), ...page.diagnostics];
    const unique = new Map(diagnostics.map((entry) => [JSON.stringify(entry), entry]));
    current = freeze({ ...combine(current, page, issues?.(page) ?? []), diagnostics: [...unique.values()] });
    return success(current);
  }

  return {
    clear,
    peek: () => current,
    first: (
      fetchPage: (page: PageInput) => Promise<ResourceResult<T>>,
      limit?: number,
      mismatches?: (page: T) => readonly ResourceMismatch[]
    ) => load(fetchPage, limit === undefined ? {} : { limit }, mismatches),
    next: (fetchPage: (page: PageInput) => Promise<ResourceResult<T>>, previous: T) => {
      if (previous !== current || previous.nextCursor === null) return Promise.resolve(stalePage());
      return load(fetchPage, { cursor: previous.nextCursor });
    },
  };
}

export function createProfilePages<T extends ProfileCatalog>() {
  const pages = createPages<T>();
  let inspected: T['inspected'] = null;
  let ticket = 0;

  return {
    ...pages,
    clear() {
      pages.clear();
      inspected = null;
      ticket++;
    },
    view() {
      const snapshot = pages.peek();
      return snapshot && freeze({ ...snapshot, inspected });
    },
    async inspect(read: () => Promise<ResourceResult<NonNullable<T['inspected']>>>) {
      const run = ++ticket;
      inspected = null;
      const reply = await read();
      if (run !== ticket && reply.status === 'success') return stalePage();
      if (reply.status === 'success') inspected = freeze(reply.data);
      return reply;
    },
  };
}
