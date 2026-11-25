import { createRequestId, isRecord, requestRelay } from '../RunningInput/transport';
import {
  decode,
  names,
  pageLimit,
  profileApplied,
  profileName,
  profilePreview,
  profileRef,
  projectWrite,
  relayRefusal,
  resourceKind,
  selectionChanges,
  sessionProfiles,
  sessionSelections,
  token,
  toolsApplied,
} from './parse';
import {
  byteLength,
  createPages,
  createProfilePages,
  failure,
  invalidInput,
  invalidReply,
  reconcileWrite,
  RELAY_REQUEST_BYTES,
  RELAY_RESPONSE_BYTES,
  rpcFailure,
  staleBinding,
  stalePage,
  success,
  transportFailure,
  unsupported,
  type Receipt,
} from './recovery';
import type {
  ProfileRef,
  ResourceChange,
  ResourceKind,
  ResourceMismatch,
  ResourceResult,
  SessionCapabilities,
  SessionProfiles,
  SessionSelections,
  SessionSource,
  WriteReport,
} from './types';

const methods = {
  profilesList: '_aelix/session/profiles/list',
  profilesShow: '_aelix/session/profiles/show',
  profilesUse: '_aelix/session/profiles/use',
  setActiveTools: '_aelix/session/tools/set-active',
  selectionsList: '_aelix/session/selections/list',
  selectionsSet: '_aelix/session/selections/set',
  lookup: '_aelix/session/requests/lookup',
} as const;

const kinds = ['tool', 'skill', 'mcp'] as const;
type Method = keyof typeof methods;
type Binding = {
  source: SessionSource;
  capabilities: SessionCapabilities;
  lifetime: AbortController;
};

function capabilities(value: unknown): SessionCapabilities | undefined {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !Array.isArray(value.requests) ||
    !Array.isArray(value.notifications)
  ) {
    return undefined;
  }
  const bindingId = decode(token, value.bindingId);
  const requests = decode(names, value.requests);
  if (!bindingId || !requests || value.notifications.length !== 0) return undefined;
  return Object.freeze({
    bindingId,
    profilesList: requests.includes(methods.profilesList),
    profilesShow: requests.includes(methods.profilesShow),
    profilesUse: requests.includes(methods.profilesUse),
    setActiveTools: requests.includes(methods.setActiveTools),
    selectionsList: requests.includes(methods.selectionsList),
    selectionsSet: requests.includes(methods.selectionsSet),
    lookup: requests.includes(methods.lookup),
  });
}

function result<T>(value: unknown, parse: (value: unknown) => T, writing: boolean): ResourceResult<T> {
  if (isRecord(value) && value.accepted === false) {
    return decode((reply) => relayRefusal(reply, writing), value) ?? invalidReply(writing);
  }
  const data = decode(parse, value);
  return data === undefined ? invalidReply(writing) : success(data);
}

function writeMismatches(outcome: ResourceResult<{ mismatches: readonly ResourceMismatch[] }>) {
  return outcome.status === 'success' ? outcome.data.mismatches : outcome.mismatches;
}

export function createSessionResources(conversationId: string, owner: AbortSignal) {
  const path = '/api/conversations/' + encodeURIComponent(conversationId) + '/acp-extensions';
  const profiles = createProfilePages<SessionProfiles>();
  const selections = {
    tool: createPages<SessionSelections>(),
    skill: createPages<SessionSelections>(),
    mcp: createPages<SessionSelections>(),
  };
  let binding: Binding | undefined;
  let discovery = 0;
  let writing = false;

  function clearPages(): void {
    profiles.clear();
    for (const kind of kinds) selections[kind].clear();
  }

  function clearBinding(): void {
    binding?.lifetime.abort();
    binding = undefined;
    clearPages();
  }

  function invalidate(): void {
    discovery++;
    clearBinding();
  }

  owner.addEventListener('abort', invalidate, { once: true });

  async function discover(): Promise<ResourceResult<SessionCapabilities>> {
    if (owner.aborted) return staleBinding();
    const run = ++discovery;
    const reply = await requestRelay(path, undefined, owner, RELAY_RESPONSE_BYTES);
    if (owner.aborted || run !== discovery) return staleBinding();
    if (reply.kind === 'failure') {
      clearBinding();
      return transportFailure(reply.failure, false);
    }
    const next = capabilities(reply.data);
    if (!next) {
      clearBinding();
      return invalidReply(false);
    }
    if (JSON.stringify(next) !== JSON.stringify(binding?.capabilities)) {
      clearBinding();
      binding = {
        source: { source: 'session', conversationId, bindingId: next.bindingId },
        capabilities: next,
        lifetime: new AbortController(),
      };
    }
    if (
      !next.profilesList &&
      !next.profilesShow &&
      !next.profilesUse &&
      !next.setActiveTools &&
      !next.selectionsList &&
      !next.selectionsSet
    )
      return unsupported();
    return success(next);
  }

  function check(context: Binding | undefined, method: Method, expectedBinding?: string) {
    if (owner.aborted || context !== binding) return staleBinding();
    if (!context) return expectedBinding === undefined ? unsupported() : staleBinding();
    if (expectedBinding !== undefined && expectedBinding !== context.source.bindingId) return staleBinding();
    if (!context.capabilities[method]) return unsupported();
    return undefined;
  }

  async function call<T>(
    context: Binding,
    method: Method,
    payload: Record<string, unknown>,
    parse: (value: unknown) => T,
    mutation = false
  ): Promise<ResourceResult<T>> {
    const unavailable = check(context, method);
    if (unavailable) return unavailable;
    const body = JSON.stringify({ bindingId: context.source.bindingId, method: methods[method], payload });
    if (byteLength(body) > RELAY_REQUEST_BYTES) return failure('invalid-input', 'EXT_TOO_LARGE');
    const reply = await requestRelay(path, body, context.lifetime.signal, RELAY_RESPONSE_BYTES);
    if (context !== binding || owner.aborted) {
      return mutation ? failure('unknown', 'EXT_STALE_BINDING', 'lookup-and-refresh') : staleBinding();
    }
    if (reply.kind === 'success') {
      return result(isRecord(reply.data) ? reply.data.result : undefined, parse, mutation);
    }
    const outcome = transportFailure(reply.failure, mutation);
    if (
      outcome.status === 'detached' ||
      outcome.status === 'unauthenticated' ||
      outcome.reason === 'EXT_STALE_BINDING'
    ) {
      invalidate();
    }
    return outcome;
  }

  async function listProfiles(limit?: number): Promise<ResourceResult<SessionProfiles>> {
    if (limit !== undefined && decode(pageLimit, limit) === undefined) return invalidInput();
    const context = binding;
    if (!context) return check(context, 'profilesList') ?? unsupported();
    return profiles.first(
      (page) => call(context, 'profilesList', page, (value) => sessionProfiles(value, context.source)),
      limit
    );
  }

  async function nextProfiles(previous: SessionProfiles): Promise<ResourceResult<SessionProfiles>> {
    const context = binding;
    if (!context || previous.bindingId !== context.source.bindingId) return staleBinding();
    return profiles.next(
      (page) => call(context, 'profilesList', page, (value) => sessionProfiles(value, context.source)),
      previous
    );
  }

  async function showProfile(name: string) {
    if (!decode(profileName, name)) return invalidInput();
    const context = binding;
    if (!context) return check(context, 'profilesShow') ?? unsupported();
    return profiles.inspect(() =>
      call(context, 'profilesShow', { name }, (value) => profilePreview(value, name, false))
    );
  }

  async function listSelections(kind: ResourceKind, limit?: number, mismatches?: readonly ResourceMismatch[]) {
    if (!decode(resourceKind, kind) || (limit !== undefined && decode(pageLimit, limit) === undefined))
      return invalidInput();
    const context = binding;
    if (!context) return check(context, 'selectionsList') ?? unsupported();
    return selections[kind].first(
      (page) =>
        call(context, 'selectionsList', { kind, ...page }, (value) => sessionSelections(value, context.source, kind)),
      limit,
      mismatches && (() => mismatches)
    );
  }

  async function nextSelections(previous: SessionSelections) {
    const context = binding;
    if (!context || previous.bindingId !== context.source.bindingId) return staleBinding();
    if (!decode(resourceKind, previous.kind)) return invalidInput();
    return selections[previous.kind].next(
      (page) =>
        call(context, 'selectionsList', { kind: previous.kind, ...page }, (value) =>
          sessionSelections(value, context.source, previous.kind)
        ),
      previous
    );
  }

  async function lookup<T>(context: Binding, requestId: string, parse: (value: unknown) => T): Promise<Receipt<T>> {
    const reply = await call(context, 'lookup', { requestId }, (value): Receipt<T> => {
      if (!isRecord(value)) return { status: 'unavailable' };
      if (value.status === 'pending' || value.status === 'unknown' || value.status === 'unavailable') {
        return { status: value.status };
      }
      if (value.status === 'completed') {
        if ('result' in value && !('rpcCode' in value)) {
          return { status: 'completed', outcome: result(value.result, parse, true) };
        }
        if (!('result' in value) && typeof value.rpcCode === 'number' && Number.isSafeInteger(value.rpcCode)) {
          return { status: 'completed', outcome: rpcFailure(value.rpcCode, true) };
        }
      }
      return { status: 'unavailable' };
    });
    return reply.status === 'success' ? reply.data : { status: 'unavailable' };
  }

  async function mutate<T, State>(
    context: Binding | undefined,
    method: 'profilesUse' | 'setActiveTools' | 'selectionsSet',
    expectedBinding: string,
    payload: Record<string, unknown>,
    parse: (value: unknown) => T,
    refresh: (outcome: ResourceResult<T>) => Promise<ResourceResult<State>>
  ): Promise<WriteReport<T, State>> {
    const unavailable = check(context, method, expectedBinding);
    if (unavailable || !context) return { outcome: unavailable ?? staleBinding() };
    if (writing) return { outcome: failure('refused', 'busy', 'wait-idle') };
    writing = true;
    try {
      clearPages();
      const requestId = createRequestId();
      const outcome = await call(context, method, { ...payload, requestId }, parse, true);
      if (owner.aborted) return { outcome: staleBinding() };
      if (outcome.status === 'invalid-input') return { outcome };
      if (outcome.status === 'unauthenticated') return { outcome, requestId };
      let refreshedBinding: Binding | undefined;
      const report = await reconcileWrite(
        outcome,
        requestId,
        binding === context && context.capabilities.lookup ? () => lookup(context, requestId, parse) : undefined,
        async (settled) => {
          if (owner.aborted) return staleBinding();
          if (!binding) {
            const discovered = await discover();
            if (discovered.status !== 'success') return discovered;
          }
          // A retired binding's differences must not be attributed to its replacement.
          refreshedBinding = binding;
          return refresh(context === binding ? settled : staleBinding());
        }
      );
      if (owner.aborted) return { outcome: staleBinding() };
      const fresh =
        report.refresh?.status === 'success' && refreshedBinding !== binding ? staleBinding() : report.refresh;
      if (binding !== context && outcome.status !== 'stale' && outcome.status !== 'detached') {
        return {
          outcome: failure('unknown', 'EXT_STALE_BINDING', 'lookup-and-refresh'),
          requestId,
          refresh: fresh,
        };
      }
      return { ...report, refresh: fresh };
    } finally {
      writing = false;
    }
  }

  return {
    discover,
    invalidate,
    listProfiles,
    nextProfiles,
    showProfile,
    profileView: profiles.view,
    listSelections: (kind: ResourceKind, limit?: number) => listSelections(kind, limit),
    nextSelections,
    peekSelections: (kind: ResourceKind) => selections[kind].peek(),
    async useProfile(bindingId: string, profile: ProfileRef | null) {
      const ref = profile === null ? null : decode(profileRef, profile);
      if (ref === undefined) return { outcome: invalidInput() };
      return mutate(
        binding,
        'profilesUse',
        bindingId,
        { profile: ref },
        (value) => profileApplied(value, ref),
        async () => {
          const [fresh] = await Promise.all([
            listProfiles(),
            ...(binding?.capabilities.selectionsList ? [listSelections('tool'), listSelections('skill')] : []),
          ]);
          return fresh;
        }
      );
    },
    async setActiveTools(bindingId: string, namesToSet: readonly string[]) {
      const selected = decode(names, namesToSet);
      if (!selected) return { outcome: invalidInput() };
      return mutate(
        binding,
        'setActiveTools',
        bindingId,
        { names: selected },
        (value) => toolsApplied(value, selected),
        () => listSelections('tool')
      );
    },
    async setProjectSelections(snapshot: SessionSelections, changes: readonly ResourceChange[]) {
      if (!decode(resourceKind, snapshot.kind)) return { outcome: invalidInput() };
      if (snapshot.bindingId !== binding?.source.bindingId) return { outcome: staleBinding() };
      if (snapshot !== selections[snapshot.kind].peek()) return { outcome: stalePage() };
      if (!snapshot.scopes.project.writable) return { outcome: failure('refused', 'scope-readonly') };
      const selected = decode((value) => selectionChanges(value, snapshot), changes);
      if (!selected) return { outcome: invalidInput() };
      const { bindingId, kind } = snapshot;
      return mutate(
        binding,
        'selectionsSet',
        bindingId,
        { scope: 'project', kind, changes: selected },
        (value) => projectWrite(value, kind),
        (outcome) => listSelections(kind, undefined, writeMismatches(outcome))
      );
    },
  };
}
