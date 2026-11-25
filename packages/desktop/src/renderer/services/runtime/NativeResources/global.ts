import { createRequestId, isRecord, requestJson } from '../RunningInput/transport';
import {
  code,
  decode,
  globalProfiles,
  globalSelections,
  globalWrite,
  pageLimit,
  profileName,
  profilePreview,
  resourceKind,
  selectionChanges,
  token,
} from './parse';
import {
  byteLength,
  createPages,
  createProfilePages,
  failure,
  HELPER_FRAME_BYTES,
  invalidInput,
  invalidReply,
  reconcileWrite,
  RELAY_RESPONSE_BYTES,
  stalePage,
  success,
  unsupported,
} from './recovery';
import type {
  GlobalProfiles,
  GlobalSelections,
  GlobalWrite,
  ResourceChange,
  ResourceFailure,
  ResourceKind,
  ResourceMismatch,
  ResourceResult,
  WriteReport,
} from './types';

type Command =
  | { action: 'profiles/list'; limit?: number; cursor?: string }
  | { action: 'profiles/show'; name: string }
  | { action: 'selections/list'; scope: 'global'; kind: ResourceKind; limit?: number; cursor?: string }
  | {
      action: 'selections/set';
      scope: 'global';
      kind: ResourceKind;
      expectedRevision: string;
      changes: readonly ResourceChange[];
      requestId: string;
    };

declare global {
  interface Window {
    __studioNativeResources?: { request: (command: Command) => Promise<unknown> };
  }
}

const helperStatuses = {
  FORBIDDEN: 403,
  UNAUTHENTICATED: 401,
  FRAME_LIMIT: 413,
  INVALID_INPUT: 400,
  SCOPE_DENIED: 403,
  CURSOR_STALE: 409,
  PROFILE_UNAVAILABLE: 404,
  REVISION_CONFLICT: 409,
  SELECTION_MISSING: 422,
  SELECTION_LOCKED: 422,
  SCOPE_READONLY: 422,
  STORE_UNREADABLE: 422,
  BUSY: 409,
  REQUEST_ID_CONFLICT: 409,
  DEDUP_CAPACITY: 429,
  RUNTIME_UNAVAILABLE: 503,
  RESULT_TOO_LARGE: 413,
  SAVE_FAILED: 500,
  HELPER_UNAVAILABLE: 503,
  OUTCOME_UNKNOWN: 503,
} as const;

function helperFailure(body: Record<string, unknown>, status: number | undefined, writing: boolean): ResourceFailure {
  const reason = decode(code, body.code);
  if (!reason) return invalidReply(writing, true);
  const expected = Object.entries(helperStatuses).find(([known]) => known === reason)?.[1];
  if (expected === undefined) {
    return writing ? failure('unknown', reason, 'refresh-and-choose') : failure('error', reason);
  }
  if (status !== undefined && status !== expected) return invalidReply(writing, true);

  switch (reason) {
    case 'UNAUTHENTICATED':
      return failure('unauthenticated', reason, 'sign-in-and-read');
    case 'OUTCOME_UNKNOWN':
      return failure('unknown', reason, 'refresh-and-choose');
    case 'CURSOR_STALE':
      return failure('stale', reason);
    case 'REVISION_CONFLICT': {
      const currentRevision = decode(token, body.currentRevision);
      if (currentRevision === undefined) return invalidReply(writing, true);
      return { ...failure('conflict', reason, 'refresh-and-choose'), currentRevision };
    }
    case 'SELECTION_MISSING':
    case 'SELECTION_LOCKED': {
      const key = decode(token, body.key);
      if (key === undefined) return invalidReply(writing, true);
      return { ...failure('refused', reason), key };
    }
    case 'BUSY':
      return failure('refused', reason, 'wait-idle');
    case 'RUNTIME_UNAVAILABLE':
      return unsupported(reason);
    case 'HELPER_UNAVAILABLE':
      return writing ? failure('unknown', reason, 'refresh-and-choose') : failure('error', reason);
    default:
      return failure('refused', reason);
  }
}

async function send(
  command: Command,
  encoded: string,
  signal: AbortSignal
): Promise<{ body: unknown; status: number | undefined; empty: boolean }> {
  if (typeof window !== 'undefined' && window.__studioNativeResources) {
    try {
      return { body: await window.__studioNativeResources.request(command), status: undefined, empty: false };
    } catch {
      return { body: undefined, status: 0, empty: false };
    }
  }
  if (typeof window !== 'undefined' && window.__backendPort !== undefined) {
    return { body: undefined, status: 404, empty: true };
  }
  return requestJson(
    '/api/studio/native-resources',
    { method: 'POST', headers: { 'content-type': 'application/json', 'x-studio-resources': '1' }, body: encoded },
    signal,
    125_000,
    RELAY_RESPONSE_BYTES
  );
}

export function createGlobalResources(owner: AbortSignal) {
  const profiles = createProfilePages<GlobalProfiles>();
  const selections = {
    tool: createPages<GlobalSelections>(),
    skill: createPages<GlobalSelections>(),
    mcp: createPages<GlobalSelections>(),
  };
  let context = new AbortController();
  let mutationInFlight = false;

  function invalidate() {
    context.abort();
    context = new AbortController();
    profiles.clear();
    selections.tool.clear();
    selections.skill.clear();
    selections.mcp.clear();
  }

  owner.addEventListener('abort', invalidate, { once: true });

  async function request<T>(command: Command, parse: (value: unknown) => T): Promise<ResourceResult<T>> {
    if (owner.aborted) return stalePage();
    const writing = command.action === 'selections/set';
    const encoded = JSON.stringify(command);
    if (byteLength(encoded) > HELPER_FRAME_BYTES) return failure('invalid-input', 'FRAME_LIMIT');
    const signal = context.signal;
    const { body, status, empty } = await send(command, encoded, signal);
    if (signal.aborted) {
      return writing && !owner.aborted ? failure('unknown', 'context-changed', 'refresh-and-choose') : stalePage();
    }
    if (isRecord(body)) {
      if (body.ok === true && (status === undefined || status === 200)) {
        const data = decode(parse, body.data);
        return data === undefined ? invalidReply(writing, true) : success(data);
      }
      if (body.ok === false) {
        const outcome = helperFailure(body, status, writing);
        if (outcome.status === 'unauthenticated') invalidate();
        return outcome;
      }
    }
    if (status === 0) {
      return writing ? failure('unknown', 'no-reply', 'refresh-and-choose') : failure('error', 'no-reply');
    }
    if (status === 404 && empty && !writing) return unsupported();
    return invalidReply(writing, true);
  }

  function listProfiles(limit?: number) {
    if (limit !== undefined && decode(pageLimit, limit) === undefined) return Promise.resolve(invalidInput());
    return profiles.first((page) => request({ action: 'profiles/list', ...page }, globalProfiles), limit);
  }

  function listSelections(
    kind: ResourceKind,
    limit?: number,
    mismatches?: (page: GlobalSelections) => readonly ResourceMismatch[]
  ) {
    if (!decode(resourceKind, kind) || (limit !== undefined && decode(pageLimit, limit) === undefined)) {
      return Promise.resolve(invalidInput());
    }
    return selections[kind].first(
      (page) =>
        request({ action: 'selections/list', scope: 'global', kind, ...page }, (value) =>
          globalSelections(value, kind)
        ),
      limit,
      mismatches
    );
  }

  return {
    invalidate,
    listProfiles,
    nextProfiles: (previous: GlobalProfiles) =>
      profiles.next((page) => request({ action: 'profiles/list', ...page }, globalProfiles), previous),
    showProfile(name: string) {
      if (!decode(profileName, name)) return Promise.resolve(invalidInput());
      return profiles.inspect(() =>
        request({ action: 'profiles/show', name }, (value) => profilePreview(value, name, true))
      );
    },
    profileView: profiles.view,
    listSelections: (kind: ResourceKind, limit?: number) => listSelections(kind, limit),
    nextSelections(previous: GlobalSelections) {
      const { kind } = previous;
      if (!decode(resourceKind, kind)) return Promise.resolve(invalidInput());
      return selections[kind].next(
        (page) =>
          request({ action: 'selections/list', scope: 'global', kind, ...page }, (value) =>
            globalSelections(value, kind)
          ),
        previous
      );
    },
    peekSelections: (kind: ResourceKind) => selections[kind].peek(),
    async setSelections(
      snapshot: GlobalSelections,
      changes: readonly ResourceChange[]
    ): Promise<WriteReport<GlobalWrite, GlobalSelections>> {
      const { kind, revision } = snapshot;
      if (!decode(resourceKind, kind)) return { outcome: invalidInput() };
      if (snapshot !== selections[kind].peek()) return { outcome: stalePage() };
      if (!snapshot.scopes.global.writable) return { outcome: failure('refused', 'SCOPE_READONLY') };
      const selected = decode((value) => selectionChanges(value, snapshot), changes);
      if (!selected) return { outcome: invalidInput() };
      if (mutationInFlight) return { outcome: failure('refused', 'BUSY', 'wait-idle') };

      mutationInFlight = true;
      try {
        selections[kind].clear();
        const requestId = createRequestId();
        const started = context;
        const outcome = await request(
          { action: 'selections/set', scope: 'global', kind, expectedRevision: revision, changes: selected, requestId },
          (value) => globalWrite(value, kind)
        );
        if (owner.aborted) return { outcome: stalePage() };
        if (outcome.status === 'invalid-input') return { outcome };
        if (outcome.status === 'unauthenticated') return { outcome, requestId };
        const retired = () => ({
          outcome: failure('unknown', 'context-changed', 'refresh-and-choose'),
          requestId,
        });
        if (context !== started) return retired();
        const report = await reconcileWrite(outcome, requestId, undefined, (settled) =>
          listSelections(kind, undefined, (page) =>
            settled.status === 'success' && context === started && page.revision === settled.data.revision
              ? settled.data.mismatches
              : []
          )
        );
        if (owner.aborted) return { outcome: stalePage() };
        return context === started ? report : retired();
      } finally {
        mutationInFlight = false;
      }
    },
  };
}
