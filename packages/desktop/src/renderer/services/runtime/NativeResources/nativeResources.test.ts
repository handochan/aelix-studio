import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  createNativeResources,
  parseProfileLoadRecovery,
  type ProfileDifference,
  type ProfileRef,
  type ResourceChange,
  type ResourceKind,
  type ResourceResult,
} from './index';
import fixtures from './studio-7-d16-v1.json';

vi.mock('@/common/adapter/httpBridge', () => ({
  getBaseUrl: () => '',
  resolveCoreCsrfToken: () => 'fixture-csrf',
}));

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a fixture object');
  return value as Record<string, unknown>;
}

function pointer(value: unknown, path: string): unknown {
  return path
    .split('/')
    .slice(1)
    .reduce<unknown>((node, segment) => {
      const key = segment.replace(/~1/g, '/').replace(/~0/g, '~');
      return Array.isArray(node) ? node[Number(key)] : object(node)[key];
    }, value);
}

const cases = new Map<string, unknown>();
function resolveFixture(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(resolveFixture);
  if (!value || typeof value !== 'object') return value;
  const row = object(value);
  if (typeof row.$fixture === 'string') {
    const [id, path] = row.$fixture.split('#');
    if (!cases.has(id)) throw new Error('Fixture reference must name an earlier case');
    const target = pointer(cases.get(id), path);
    if (target === undefined) throw new Error('Missing fixture pointer');
    return structuredClone(target);
  }
  return Object.fromEntries(Object.entries(row).map(([key, entry]) => [key, resolveFixture(entry)]));
}

for (const example of fixtures) cases.set(example.id, resolveFixture(example));
const fixture = (id: string, path = '') => pointer(cases.get(id), path);
const valueOf = <T>(reply: ResourceResult<T>): T => {
  if (reply.status !== 'success') throw new Error(JSON.stringify(reply));
  return reply.data;
};

function response(body: unknown, status = 200): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), { status });
}

function http(example: unknown): Response {
  const { body, status } = object(example);
  if (typeof status !== 'number') throw new Error('Missing HTTP status');
  return response(body, status);
}

function relay(result: unknown): Response {
  return response({ success: true, data: { result } });
}

function discovery(bindingId = 'b-21', requests?: readonly string[]): Response {
  const data = object(fixture('relay-discovery', '/response/body/data'));
  return response({ success: true, data: { ...data, bindingId, ...(requests ? { requests } : {}) } });
}

const fetcher = vi.fn<(path: string, init: RequestInit) => Promise<Response>>();
let owner: ReturnType<typeof createNativeResources>;
const session = () => owner.session('c-17');
const globalResources = () => owner.global;

function enqueue(reply: Response): void {
  fetcher.mockResolvedValueOnce(reply);
}

function sessionCase(id: string): void {
  enqueue(relay(fixture(id, '/result')));
}

function helperCase(id: string): void {
  enqueue(response(fixture(id, '/reply')));
}

function sent(index: number): Record<string, unknown> {
  const body = fetcher.mock.calls[index][1].body;
  if (typeof body !== 'string') throw new Error('Expected a JSON request');
  return object(JSON.parse(body) as unknown);
}

function sentMutation(index: number, id: string, global = false): string {
  const actual = sent(index);
  const expected = object(fixture(id, global ? '/command' : '/post'));
  const payload = global ? actual : object(actual.payload);
  expect(payload.requestId).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  if (global) expect(actual).toEqual({ ...expected, requestId: payload.requestId });
  else expect(actual).toEqual({ ...expected, payload: { ...object(expected.payload), requestId: payload.requestId } });
  return String(payload.requestId);
}

async function attach() {
  enqueue(discovery());
  return valueOf(await session().discover());
}

beforeEach(() => {
  fetcher.mockReset();
  fetcher.mockRejectedValue(new Error('Unexpected fetch'));
  vi.stubGlobal('fetch', fetcher);
  vi.stubGlobal('window', {});
  owner = createNativeResources();
});

afterEach(() => {
  owner.dispose();
  vi.unstubAllGlobals();
});

describe('D16 screens', () => {
  it('loads all 137 contract examples and resolves their JSON Pointers', () => {
    expect(cases.size).toBe(137);
    expect(fixture('relay-envelope', '/httpRequest/body/payload/profile')).toEqual(
      fixture('profile-ref', '/vectors/0/ref')
    );
  });

  it('combines session tool pages with validated scope, active tools and an inherited override', async () => {
    await attach();
    sessionCase('selections-list-tool-first');
    sessionCase('selections-list-tool-next');
    const first = valueOf(await session().listSelections('tool', 1));
    expect(first).toMatchObject({ complete: false, toolOverride: null, nextCursor: 't.abc' });
    expect(valueOf(await session().nextSelections(first))).toEqual(fixture('view-session-tool', '/dto'));
    expect([sent(1), sent(2)]).toEqual([
      fixture('selections-list-tool-first', '/post'),
      fixture('selections-list-tool-next', '/post'),
    ]);
  });

  it.each([
    ['view-pending-mcp', 'selections-list-mcp', 'mcp'],
    ['view-unobservable', 'selections-list-skill', 'skill'],
  ] as const)('preserves observation and pending state in %s', async (view, input, kind) => {
    await attach();
    sessionCase(input);
    const state = valueOf(await session().listSelections(kind));
    expect(kind === 'mcp' ? state : state.items[0]).toEqual(fixture(view, kind === 'mcp' ? '/dto' : '/dtoRow'));
  });

  it.each(['view-effective-diff', 'view-locked'])('keeps the worker values and lock for %s', async (view) => {
    await attach();
    enqueue(
      relay({
        ...object(fixture('selections-list-tool-first', '/result')),
        items: [fixture(view, '/inputRow')],
        nextCursor: null,
      })
    );
    expect(valueOf(await session().listSelections('tool')).items[0]).toEqual(fixture(view, '/dtoRow'));
  });

  it('uses the identical scope-relative profile preview in session and global catalogs', async () => {
    await attach();
    sessionCase('profiles-list-page-1');
    sessionCase('profiles-list-page-2');
    sessionCase('profiles-show');
    const first = valueOf(await session().listProfiles(1));
    valueOf(await session().nextProfiles(first));
    valueOf(await session().showProfile('quiet'));
    expect(session().profileView()).toEqual(fixture('view-profile', '/dto'));

    helperCase('helper-profiles-first');
    helperCase('helper-profiles-next');
    helperCase('helper-profile-show');
    const globalFirst = valueOf(await globalResources().listProfiles(1));
    valueOf(await globalResources().nextProfiles(globalFirst));
    valueOf(await globalResources().showProfile('quiet'));
    expect(globalResources().profileView()).toEqual(fixture('view-global-profile', '/dto'));
  });

  it('records diagnostics when the result is a complete empty profile catalog', async () => {
    await attach();
    sessionCase('paging-diagnostic');
    expect(valueOf(await session().listProfiles())).toMatchObject({
      profiles: [],
      complete: true,
      diagnostics: fixture('paging-diagnostic', '/result/diagnostics'),
    });
  });

  it('projects global state as unobserved and does not expose extra helper data', async () => {
    const { data } = object(fixture('helper-tools-first', '/reply'));
    enqueue(
      response({
        ok: true,
        data: {
          ...object(data),
          items: [
            {
              ...object(pointer(data, '/items/0')),
              loaded: true,
              applied: true,
              live: false,
              env: { SECRET: 'fixture' },
              headers: { Authorization: 'fixture' },
              argv: ['fixture'],
            },
          ],
        },
      })
    );
    helperCase('helper-tools-next');
    const first = valueOf(await globalResources().listSelections('tool', 1));
    expect(first).toEqual(fixture('view-global', '/dto'));
    expect(valueOf(await globalResources().nextSelections(first))).toMatchObject({ complete: true, nextCursor: null });
    expect([sent(0), sent(1)]).toEqual([
      fixture('helper-tools-first', '/command'),
      fixture('helper-tools-next', '/command'),
    ]);
  });

  it('keeps a read-only helper scope and its diagnostic distinct from absence', async () => {
    helperCase('helper-global-readonly');
    expect(valueOf(await globalResources().listSelections('mcp'))).toMatchObject({
      items: [],
      complete: true,
      scopes: { global: { writable: false, exists: true, reason: 'env-config' } },
      diagnostics: [{ code: 'env-config', key: null, source: null }],
    });
  });

  it('sends the fixture helper envelope over WebUI and the restricted desktop bridge', async () => {
    helperCase('helper-skills');
    valueOf(await globalResources().listSelections('skill'));
    expect(fetcher).toHaveBeenCalledWith(
      fixture('helper-envelope', '/web/path'),
      expect.objectContaining({
        method: 'POST',
        credentials: 'same-origin',
        headers: fixture('helper-envelope', '/web/headers'),
      })
    );
    expect(sent(0)).toEqual(fixture('helper-envelope', '/web/body'));

    const request = vi.fn().mockResolvedValue(fixture('helper-envelope', '/stdio/stdout'));
    vi.stubGlobal('window', { __backendPort: 13400, __studioNativeResources: { request } });
    valueOf(await globalResources().listSelections('skill'));
    expect(request).toHaveBeenCalledExactlyOnceWith(fixture('helper-envelope', '/desktop/args/0'));
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe('capabilities and snapshot isolation', () => {
  it('disables global resources on an old desktop without probing the WebUI facade', async () => {
    vi.stubGlobal('window', { __backendPort: 0 });
    expect(await globalResources().listProfiles()).toMatchObject({ status: 'unsupported' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('makes no session POST when an old runtime advertises only the existing input methods', async () => {
    enqueue(discovery('b-21', ['_aelix/session/input/state', '_aelix/session/requests/lookup']));
    expect(await session().discover()).toMatchObject({ status: 'unsupported', retryWrite: false });
    expect((await session().setActiveTools('b-21', [])).outcome).toMatchObject({ status: 'unsupported' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('enables the available unit A operations while selections are absent', async () => {
    enqueue(discovery('b-21', ['_aelix/session/profiles/list', '_aelix/session/tools/set-active']));
    expect(valueOf(await session().discover())).toMatchObject({
      profilesList: true,
      setActiveTools: true,
      selectionsList: false,
    });
    expect(await session().listSelections('tool')).toMatchObject({ status: 'unsupported' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('rejects another tab’s page and a page of another conversation, even with the same binding', async () => {
    const tab = createNativeResources();
    await attach();
    sessionCase('selections-list-tool-first');
    const first = valueOf(await session().listSelections('tool', 1));
    enqueue(discovery());
    valueOf(await tab.session('c-17').discover());
    enqueue(discovery());
    valueOf(await owner.session('c-other').discover());
    expect(await tab.session('c-17').nextSelections(first)).toMatchObject({ status: 'stale' });
    expect(await owner.session('c-other').nextSelections(first)).toMatchObject({ status: 'stale' });
    expect(fetcher).toHaveBeenCalledTimes(4);
    tab.dispose();
  });

  it('discards a late read and an old write after binding replacement', async () => {
    await attach();
    sessionCase('selections-list-tool-first');
    const first = valueOf(await session().listSelections('tool', 1));
    let finish: ((reply: Response) => void) | undefined;
    fetcher.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const inFlight = session().nextSelections(first);
    enqueue(discovery('b-22'));
    expect(valueOf(await session().discover()).bindingId).toBe('b-22');
    finish?.(relay(fixture('selections-list-tool-next', '/result')));
    expect(await inFlight).toMatchObject({ status: 'stale', reason: 'EXT_STALE_BINDING' });
    expect(session().peekSelections('tool')).toBeUndefined();
    expect((await session().setActiveTools('b-21', [])).outcome).toMatchObject({ status: 'stale' });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('discards late IPC responses on logout, including a replacement owner with the same revision', async () => {
    let finish: ((reply: unknown) => void) | undefined;
    const command = vi.fn().mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    vi.stubGlobal('window', { __studioNativeResources: { request: command } });
    const inFlight = globalResources().listSelections('tool');
    owner.dispose();
    const replacement = createNativeResources();
    finish?.(fixture('helper-tools-first', '/reply'));
    expect(await inFlight).toMatchObject({ status: 'stale' });
    expect(globalResources().peekSelections('tool')).toBeUndefined();
    expect(replacement.global.peekSelections('tool')).toBeUndefined();
    replacement.dispose();
  });

  it.each(['session', 'global'] as const)('restarts %s reads from page one on a stale cursor', async (source) => {
    if (source === 'session') {
      await attach();
      sessionCase('profiles-list-page-1');
      const first = valueOf(await session().listProfiles(1));
      sessionCase('relay-error-stale-cursor');
      sessionCase('profiles-list-page-1');
      expect(valueOf(await session().nextProfiles(first))).toEqual(first);
      expect(sent(3)).toEqual(fixture('profiles-list-page-1', '/post'));
    } else {
      helperCase('helper-tools-first');
      const first = valueOf(await globalResources().listSelections('tool', 1));
      enqueue(response(fixture('helper-error-cursor_stale', '/reply'), 409));
      helperCase('helper-tools-first');
      expect(valueOf(await globalResources().nextSelections(first))).toEqual(first);
      expect(sent(2)).toEqual(fixture('helper-tools-first', '/command'));
    }
  });

  it.each([
    ['duplicate key', { items: fixture('helper-tools-first', '/reply/data/items') }],
    ['changed revision', { revision: 'g.tool.2' }],
    ['repeated cursor', { nextCursor: 'ht.abc' }],
  ] as const)('rejects pages with a %s', async (_label, change) => {
    helperCase('helper-tools-first');
    const first = valueOf(await globalResources().listSelections('tool', 1));
    enqueue(response({ ok: true, data: { ...object(fixture('helper-tools-next', '/reply/data')), ...change } }));
    expect(await globalResources().nextSelections(first)).toMatchObject({ status: 'invalid-response' });
    expect(globalResources().peekSelections('tool')).toBeUndefined();
  });
});

describe('explicit writes and reconciliation', () => {
  it.each(['profiles-use', 'profiles-clear', 'use-recorded-drift'] as const)(
    'validates %s and refreshes affected catalogs',
    async (id) => {
      const caps = await attach();
      sessionCase(id);
      sessionCase('profiles-list-page-1');
      sessionCase('selections-list-tool-first');
      sessionCase('selections-list-skill');
      const ref = fixture(id, '/post/payload/profile') as ProfileRef | null;
      const report = await session().useProfile(caps.bindingId, ref);
      expect(valueOf(report.outcome)).toEqual(fixture(id, '/result'));
      sentMutation(1, id);
      expect([sent(2).method, sent(3).method, sent(4).method]).toEqual([
        '_aelix/session/profiles/list',
        '_aelix/session/selections/list',
        '_aelix/session/selections/list',
      ]);
    }
  );

  it.each(['tools-set-active', 'tools-set-empty'])('preserves the explicit override in %s', async (id) => {
    const caps = await attach();
    sessionCase(id);
    sessionCase('selections-list-tool-first');
    const names = fixture(id, '/post/payload/names') as string[];
    expect(valueOf((await session().setActiveTools(caps.bindingId, names)).outcome)).toEqual(fixture(id, '/result'));
    sentMutation(1, id);
  });

  it.each([
    ['selections-set-tool', 'selections-list-tool-first', 'tool'],
    ['selections-set-skill', 'selections-list-skill', 'skill'],
    ['selections-set-mcp', 'selections-list-mcp', 'mcp'],
    ['selections-deferred', 'selections-list-skill', 'skill'],
    ['selections-saved-not-applied', 'selections-list-skill', 'skill'],
  ] as const)('preserves save and apply outcomes in %s', async (id, input, kind) => {
    await attach();
    sessionCase(input);
    const before = valueOf(await session().listSelections(kind));
    sessionCase(id);
    const after =
      id === 'selections-deferred'
        ? { ...object(fixture(input, '/result')), items: [fixture('view-deferred', '/rowAfterRead')] }
        : fixture(input, '/result');
    enqueue(relay(after));
    const report = await session().setProjectSelections(
      before,
      fixture(id, '/post/payload/changes') as ResourceChange[]
    );
    expect(valueOf(report.outcome)).toEqual(fixture(id, '/result'));
    sentMutation(2, id);
    if (id === 'selections-deferred') {
      if (!report.refresh) throw new Error('Missing deferred-write refresh');
      expect(valueOf(report.refresh).items[0]).toEqual(fixture('view-deferred', '/dtoRow'));
    }
  });

  it('joins write mismatches to fresh pages by key and keeps unkeyed mismatches at list level', async () => {
    await attach();
    sessionCase('selections-list-tool-first');
    const first = valueOf(await session().listSelections('tool', 1));
    const mismatch = object(fixture('selections-mismatch', '/result'));
    const unkeyed = fixture('unkeyed-mismatch', '/nativeFragments/mismatches/0');
    enqueue(relay({ ...mismatch, mismatches: [...(mismatch.mismatches as unknown[]), unkeyed] }));
    sessionCase('selections-list-tool-first');
    sessionCase('selections-list-tool-next');
    const report = await session().setProjectSelections(first, [{ key: 'read', on: false }]);
    if (!report.refresh) throw new Error('Missing refresh');
    const view = valueOf(await session().nextSelections(valueOf(report.refresh)));
    expect(view).toEqual({
      ...object(fixture('view-mismatches', '/dto')),
      mismatches: [fixture('view-mismatches', '/dto/mismatches/0'), fixture('unkeyed-mismatch', '/dto/mismatches/0')],
    });
    sentMutation(2, 'selections-mismatch');
  });

  it('classifies a declined one-time profile reselection as recovery required', async () => {
    const caps = await attach();
    sessionCase('use-permission-deny');
    sessionCase('profiles-list-page-1');
    sessionCase('selections-list-tool-first');
    sessionCase('selections-list-skill');
    const report = await session().useProfile(caps.bindingId, fixture('profile-ref', '/vectors/1/ref') as ProfileRef);
    expect(report.outcome).toEqual(fixture('view-refusal', '/dto'));
  });

  it.each(['use-stale-preview', 'use-changed-again'])(
    'keeps the recorded ref, candidate and differences in %s',
    async (id) => {
      const caps = await attach();
      sessionCase(id);
      sessionCase('profiles-list-page-1');
      sessionCase('selections-list-tool-first');
      sessionCase('selections-list-skill');
      const report = await session().useProfile(caps.bindingId, fixture('profile-ref', '/vectors/0/ref') as ProfileRef);
      const { accepted: _accepted, ...details } = object(fixture(id, '/result'));
      expect(report.outcome).toEqual({
        status: 'conflict',
        action: 'refresh-and-choose',
        retryWrite: false,
        ...details,
      });
    }
  );

  it.each([
    'load-drift-reject',
    'load-drift-cancel',
    'load-drift-silence',
    'load-drift-raced',
    'load-profile-missing',
    'load-bad-record',
    'load-guard-unavailable',
  ])('validates safe load recovery data for %s', (id) => {
    const error = fixture(id, '/response/error');
    const data = object(pointer(error, '/data'));
    expect(parseProfileLoadRecovery(error)).toMatchObject({
      status: 'recovery-required',
      reason: data.reason ?? 'profile-unavailable',
      action: 'restore-original-and-reopen',
      retryWrite: false,
    });
  });

  it.each(['lookup-done', 'lookup-error', 'lookup-pending', 'lookup-unknown', 'lookup-expired', 'lookup-large'])(
    'uses the original receipt then reads current state for %s without replay',
    async (id) => {
      const caps = await attach();
      fetcher.mockRejectedValueOnce(new Error('Lost write response'));
      sessionCase(id);
      enqueue(
        relay({
          ...object(fixture('selections-list-tool-first', '/result')),
          toolOverride: [],
          activeTools: [],
          nextCursor: null,
        })
      );
      const report = await session().setActiveTools(caps.bindingId, []);
      const requestId = sentMutation(1, 'tools-set-empty');
      expect(sent(2)).toEqual({
        ...object(fixture('lookup-done', '/post')),
        payload: { requestId },
      });
      expect(report).toMatchObject({
        requestId,
        receipt: fixture(id, '/result/status'),
        outcome: { status: id === 'lookup-done' ? 'success' : id === 'lookup-error' ? 'refused' : 'unknown' },
        refresh: { status: 'success', data: { toolOverride: [], activeTools: [] } },
      });
      expect(fetcher).toHaveBeenCalledTimes(4);
    }
  );

  it('reads the replacement binding without looking up or reissuing an old dispatch', async () => {
    const caps = await attach();
    let finish: ((reply: Response) => void) | undefined;
    fetcher.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const write = session().setActiveTools(caps.bindingId, []);
    enqueue(discovery('b-22'));
    valueOf(await session().discover());
    sessionCase('selections-list-tool-first');
    finish?.(http(fixture('transport-ext_outcome_unknown-502', '/http')));
    expect(await write).toMatchObject({
      outcome: { status: 'unknown', retryWrite: false },
      refresh: { status: 'success', data: { bindingId: 'b-22' } },
    });
    expect(sent(3)).toMatchObject({ bindingId: 'b-22', method: '_aelix/session/selections/list' });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('keeps both tabs’ revisions; a conflict refreshes and performs zero retries', async () => {
    const tab = createNativeResources();
    helperCase('helper-tools-first');
    helperCase('helper-tools-first');
    const first = valueOf(await globalResources().listSelections('tool'));
    const second = valueOf(await tab.global.listSelections('tool'));
    expect((await tab.global.setSelections(first, [{ key: 'read', on: false }])).outcome).toMatchObject({
      status: 'stale',
    });
    helperCase('helper-set-tool');
    const after = { ...object(fixture('helper-tools-first', '/reply/data')), revision: 'g.tool.2' };
    enqueue(response({ ok: true, data: after }));
    const committed = await globalResources().setSelections(first, [{ key: 'read', on: false }]);
    expect(valueOf(committed.outcome)).toEqual(fixture('helper-set-tool', '/reply/data'));
    enqueue(response(fixture('helper-error-revision_conflict', '/reply'), 409));
    enqueue(response({ ok: true, data: after }));
    const conflict = await tab.global.setSelections(second, [{ key: 'read', on: false }]);
    expect(conflict).toMatchObject({
      outcome: { status: 'conflict', reason: 'REVISION_CONFLICT', currentRevision: 'g.tool.2', retryWrite: false },
      refresh: { status: 'success', data: { revision: 'g.tool.2' } },
    });
    expect(sentMutation(2, 'helper-set-tool', true)).not.toBe(sentMutation(4, 'helper-set-tool', true));
    expect(fetcher).toHaveBeenCalledTimes(6);
    tab.dispose();
  });

  it.each([
    ['helper-set-skill', 'helper-skills', 'skill'],
    ['helper-set-mcp', 'helper-mcp', 'mcp'],
    ['helper-set-noop', 'helper-tools-first', 'tool'],
  ] as const)('validates %s without claiming worker effect', async (id, list, kind) => {
    const initial = object(fixture(list, '/reply/data'));
    enqueue(response({ ok: true, data: { ...initial, revision: fixture(id, '/command/expectedRevision') } }));
    const snapshot = valueOf(await globalResources().listSelections(kind));
    helperCase(id);
    helperCase(list);
    const report = await globalResources().setSelections(snapshot, fixture(id, '/command/changes') as ResourceChange[]);
    expect(valueOf(report.outcome)).toEqual(fixture(id, '/reply/data'));
    sentMutation(1, id, true);
    expect(report.refresh).toMatchObject({ status: 'success', data: { policyPending: null, effect: 'next_worker' } });
  });

  it('refreshes after global outcome unknown without lookup or replay', async () => {
    helperCase('helper-tools-first');
    const snapshot = valueOf(await globalResources().listSelections('tool'));
    enqueue(response(fixture('helper-error-outcome_unknown', '/reply'), 503));
    helperCase('helper-tools-first');
    const report = await globalResources().setSelections(snapshot, [{ key: 'read', on: false }]);
    expect(report).toMatchObject({
      outcome: { status: 'unknown', reason: 'OUTCOME_UNKNOWN', action: 'refresh-and-choose', retryWrite: false },
      refresh: { status: 'success' },
    });
    expect(sent(2)).toMatchObject({ action: 'selections/list' });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('does not send invalid and unlisted keys, inherit-as-write, or duplicate edits', async () => {
    const caps = await attach();
    sessionCase('selections-list-tool-first');
    const snapshot = valueOf(await session().listSelections('tool'));
    expect((await session().setActiveTools(caps.bindingId, null as unknown as string[])).outcome.status).toBe(
      'invalid-input'
    );
    expect((await session().setProjectSelections(snapshot, [{ key: 'missing', on: false }])).outcome.status).toBe(
      'invalid-input'
    );
    expect(
      (
        await session().setProjectSelections(snapshot, [
          { key: 'read', on: false },
          { key: 'read', on: true },
        ])
      ).outcome.status
    ).toBe('invalid-input');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

describe('validated error envelopes', () => {
  const examples = fixture('renderer-errors', '/examples') as { inputCase: string; dto: unknown }[];
  it.each(examples)('projects $inputCase to the renderer decision', async ({ inputCase: id, dto }) => {
    if (id === 'helper-error-revision_conflict' || id === 'helper-error-outcome_unknown') {
      helperCase('helper-tools-first');
      const first = valueOf(await globalResources().listSelections('tool'));
      enqueue(response(fixture(id, '/reply'), Number(fixture(id, '/httpStatus'))));
      helperCase('helper-tools-first');
      expect((await globalResources().setSelections(first, [{ key: 'read', on: false }])).outcome).toMatchObject(
        object(dto)
      );
      return;
    }
    if (id === 'transport-ext_no_live_task-409' || id === 'transport-auth_required-401') {
      enqueue(http(fixture(id, '/http')));
      expect(await session().discover()).toEqual(dto);
      return;
    }
    await attach();
    if (id === 'relay-error-busy') sessionCase(id);
    else enqueue(http(fixture(id, '/http')));
    expect((await session().setActiveTools('b-21', [])).outcome).toEqual(dto);
  });

  it('classifies malformed successful envelopes by operation without re-issuing', async () => {
    await attach();
    enqueue(response(fixture('renderer-errors', '/invalidReadReply/wire')));
    expect(await session().listSelections('tool')).toEqual(fixture('renderer-errors', '/invalidReadReply/dto'));

    enqueue(response(fixture('renderer-errors', '/invalidMutationReply/wire')));
    sessionCase('lookup-unknown');
    sessionCase('selections-list-tool-first');
    const report = await session().setActiveTools('b-21', []);
    expect(report.outcome).toEqual(fixture('renderer-errors', '/invalidMutationReply/dto'));
    expect(fetcher).toHaveBeenCalledTimes(5);
  });

  it('distinguishes an old route from the owner’s missing conversation', async () => {
    enqueue(http(fixture('transport-old-host', '/http')));
    enqueue(http(fixture('transport-conversation_not_found-404', '/http')));
    expect(await session().discover()).toMatchObject(object(fixture('transport-old-host', '/renderer')));
    expect(await session().discover()).toMatchObject({ status: 'refused', reason: 'CONVERSATION_NOT_FOUND' });
  });
});

describe('binding and revision changes during reconciliation', () => {
  it('keeps a definitive detached write result when discovery finds a new binding', async () => {
    const caps = await attach();
    enqueue(http(fixture('transport-ext_no_live_task-409', '/http')));
    enqueue(discovery('b-22'));
    sessionCase('selections-list-tool-first');
    const report = await session().setActiveTools(caps.bindingId, []);
    expect(report).toMatchObject({
      outcome: { status: 'detached', reason: 'EXT_NO_LIVE_TASK', retryWrite: false },
      refresh: { status: 'success', data: { bindingId: 'b-22' } },
    });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('drops the old profile catalog if the binding changes during the tool and skill reads', async () => {
    const caps = await attach();
    sessionCase('profiles-use');
    sessionCase('profiles-list-page-1');
    let start: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      start = resolve;
    });
    let finish: ((reply: Response) => void) | undefined;
    fetcher.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
          start?.();
        })
    );
    sessionCase('selections-list-skill');
    const pending = session().useProfile(caps.bindingId, fixture('profile-ref', '/vectors/0/ref') as ProfileRef);
    await started;
    enqueue(discovery('b-22'));
    valueOf(await session().discover());
    finish?.(relay(fixture('selections-list-tool-first', '/result')));
    expect(await pending).toMatchObject({ outcome: { status: 'unknown' }, refresh: { status: 'stale' } });
    expect(session().profileView()).toBeUndefined();
  });

  it('retains write mismatches in the receipt without attaching them to a newer global revision', async () => {
    helperCase('helper-tools-first');
    const initial = valueOf(await globalResources().listSelections('tool'));
    const mismatch = fixture('selections-mismatch', '/result/mismatches');
    enqueue(
      response({ ok: true, data: { ...object(fixture('helper-set-tool', '/reply/data')), mismatches: mismatch } })
    );
    enqueue(
      response({ ok: true, data: { ...object(fixture('helper-tools-first', '/reply/data')), revision: 'g.tool.3' } })
    );
    const report = await globalResources().setSelections(initial, [{ key: 'read', on: false }]);
    expect(valueOf(report.outcome)).toMatchObject({ revision: 'g.tool.2', mismatches: mismatch });
    expect(report.refresh).toMatchObject({
      status: 'success',
      data: { revision: 'g.tool.3', mismatches: [], items: [{ mismatches: [] }] },
    });
  });
});

describe('wire compatibility and limits', () => {
  it('keeps a safe unlisted 404 code and reports malformed 404 as invalid-response', async () => {
    enqueue(response({ success: false, code: 'CONVERSATION_ARCHIVED', error: 'private details' }, 404));
    enqueue(new Response('unexpected payload', { status: 404 }));
    expect(await session().discover()).toEqual({
      status: 'error',
      reason: 'CONVERSATION_ARCHIVED',
      action: 'refresh',
      retryWrite: false,
    });
    expect(await session().discover()).toEqual(fixture('renderer-errors', '/invalidReadReply/dto'));
  });

  it('limits the H1 response envelope by UTF-8 bytes before accepting it', async () => {
    await attach();
    enqueue(relay({ ...object(fixture('profiles-list-page-1', '/result')), unusedField: '한'.repeat(90_000) }));
    expect(await session().listProfiles()).toMatchObject({ status: 'invalid-response' });
  });

  it('rejects an oversized mutation before sending it', async () => {
    const { bindingId } = await attach();
    expect((await session().setActiveTools(bindingId, ['한'.repeat(22_000)])).outcome).toMatchObject({
      status: 'invalid-input',
      reason: 'EXT_TOO_LARGE',
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('accepts the ACP display-only external path label and clips the prompt by Unicode scalar', async () => {
    await attach();
    const label = 'external:review (sha256:' + 'a'.repeat(64) + ')';
    const profile = object(fixture('profiles-show', '/result/profile'));
    enqueue(relay({ profile: { ...profile, skills: [label], promptPreview: '😀'.repeat(513) } }));
    expect(valueOf(await session().showProfile('quiet'))).toMatchObject({
      skills: [label],
      promptPreview: '😀'.repeat(512),
      promptTruncated: true,
    });
    enqueue(relay({ profile: { ...profile, skills: ['external:/absolute (sha256:' + 'a'.repeat(64) + ')'] } }));
    expect(await session().showProfile('quiet')).toMatchObject({ status: 'invalid-response' });
  });

  const preview = object(fixture('profiles-show', '/result/profile'));
  it.each([
    ['signed legacy timeout', { policy: { ...object(preview.policy), timeoutMs: -5 } }],
    ['repeated tool names', { tools: ['read', 'read'] }],
  ] as const)('accepts %s in a native profile preview', async (_case, fields) => {
    await attach();
    enqueue(relay({ profile: { ...preview, ...fields } }));
    expect(await session().showProfile('quiet')).toMatchObject({ status: 'success', data: fields });
  });

  it('rejects repeated names in a tools/set-active request before dispatch', async () => {
    const { bindingId } = await attach();
    const report = await session().setActiveTools(bindingId, ['read', 'read']);
    expect(report.outcome).toMatchObject({ status: 'invalid-input' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('preserves an omitted prompt change and a disappeared candidate as structured recovery', async () => {
    const { bindingId } = await attach();
    const refusal = object(fixture('use-changed-again', '/result'));
    const diff = { field: 'omittedPrompt', before: 'a'.repeat(64), after: 'b'.repeat(64) };
    enqueue(relay({ ...refusal, differences: [diff] }));
    sessionCase('profiles-list-page-1');
    sessionCase('selections-list-tool-first');
    sessionCase('selections-list-skill');
    const original = fixture('profile-ref', '/vectors/0/ref') as ProfileRef;
    expect((await session().useProfile(bindingId, original)).outcome).toMatchObject({
      status: 'conflict',
      differences: [diff],
    });
    enqueue(relay({ ...refusal, candidate: null, differences: [] }));
    sessionCase('profiles-list-page-1');
    sessionCase('selections-list-tool-first');
    sessionCase('selections-list-skill');
    expect((await session().useProfile(bindingId, original)).outcome).toMatchObject({
      status: 'conflict',
      candidate: null,
      differences: [],
    });
  });

  it('preserves valid scope-only differences and legacy profile values', async () => {
    const { bindingId } = await attach();
    const differences: ProfileDifference[] = [
      { field: 'source', before: 'user', after: 'project' },
      { field: 'tools', before: null, after: ['read', 'read'] },
      { field: 'skills', before: [], after: ['user:skills/review'] },
      { field: 'timeoutMs', before: null, after: -5 },
      { field: 'omittedPrompt', before: null, after: 'b'.repeat(64) },
    ];
    enqueue(relay({ ...object(fixture('use-stale-preview', '/result')), differences }));
    sessionCase('profiles-list-page-1');
    sessionCase('selections-list-tool-first');
    sessionCase('selections-list-skill');
    const report = await session().useProfile(bindingId, fixture('profile-ref', '/vectors/0/ref') as ProfileRef);
    expect(report.outcome).toMatchObject({ status: 'conflict', differences });
    expect(report.receipt).toBeUndefined();
  });

  it('keeps the request ID and classifies a definitive helper save failure', async () => {
    helperCase('helper-tools-first');
    const initial = valueOf(await globalResources().listSelections('tool'));
    enqueue(response(fixture('helper-error-save_failed', '/reply'), 500));
    helperCase('helper-tools-first');
    const report = await globalResources().setSelections(initial, [{ key: 'read', on: false }]);
    expect(report).toMatchObject({
      requestId: sentMutation(1, 'helper-set-tool', true),
      outcome: { status: 'refused', reason: 'SAVE_FAILED', retryWrite: false },
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});

describe('review regressions', () => {
  const badDiffs: readonly [string, string, unknown, unknown][] = [
    ['non-string revision', 'revision', false, 42],
    ['invalid revision hash', 'revision', fixture('profile-ref', '/vectors/0/ref/revision'), 'sha256:bad'],
    ['invalid profile source', 'source', 'user:agents/quiet.md', 'global:agents/quiet.md'],
    ['invalid prompt mode', 'promptMode', 'append', 'merge'],
    ['oversized prompt diff', 'promptPreview', 'before', '😀'.repeat(513)],
    ['non-boolean policy flag', 'builtinTools', true, 'false'],
    ['invalid tool list', 'tools', null, ['read', 42]],
    ['invalid skill list', 'skills', [], 'review'],
    ['invalid extension label', 'extensions', [], ['../extension.js']],
    ['non-numeric output cap', 'outputCap', 51200, '4096'],
    ['zero output cap', 'outputCap', 51200, 0],
    ['invalid omitted prompt hash', 'omittedPrompt', null, 'b'.repeat(63)],
    ['non-nullable description', 'description', null, 'Review only'],
    ['invalid delegation approval mode', 'approvalMode', 'inherit', 'allow-all'],
    ['invalid delegation role', 'role', 'leaf', 'root'],
    ['invalid agent name', 'agents', [], ['agents/writer.md']],
  ];

  it.each([
    ['wrong-method refusal', { accepted: false, reason: 'cursor-stale' }, 200, 'tools'],
    ['tool refusal without key', { accepted: false, reason: 'tool-locked' }, 200, 'tools'],
    ['contradictory HTTP envelope', { success: true, code: 'EXT_METHOD_DENIED', error: 'fixture' }, 403, 'tools'],
    ['incomplete HTTP envelope', { success: false, code: 'EXT_METHOD_DENIED' }, 403, 'tools'],
    ...badDiffs.map(
      ([label, field, before, after]) =>
        [
          label,
          { ...object(fixture('use-stale-preview', '/result')), differences: [{ field, before, after }] },
          200,
          'profile',
        ] as const
    ),
  ] as const)('looks up a write receipt for %s', async (_example, body, status, target) => {
    const { bindingId } = await attach();
    enqueue(status === 200 ? relay(body) : response(body, status));
    sessionCase('lookup-unknown');
    if (target === 'profile') sessionCase('profiles-list-page-1');
    sessionCase('selections-list-tool-first');
    if (target === 'profile') sessionCase('selections-list-skill');
    const report =
      target === 'profile'
        ? await session().useProfile(bindingId, fixture('profile-ref', '/vectors/0/ref') as ProfileRef)
        : await session().setActiveTools(bindingId, []);
    expect(report).toMatchObject({
      outcome: { status: 'unknown', reason: 'invalid-response', retryWrite: false },
      receipt: 'unknown',
      refresh: { status: 'success' },
    });
    expect(sent(2)).toMatchObject({
      bindingId,
      method: '_aelix/session/requests/lookup',
      payload: { requestId: report.requestId },
    });
    expect(fetcher).toHaveBeenCalledTimes(target === 'profile' ? 6 : 4);
  });

  it.each(['discovery', 'list'])('reports a malformed H1 %s reply as invalid-response', async (operation) => {
    if (operation === 'list') await attach();
    enqueue(response({ success: true, code: 'EXT_METHOD_DENIED', error: 'fixture' }, 403));
    const result = operation === 'discovery' ? await session().discover() : await session().listProfiles();
    expect(result).toEqual(fixture('renderer-errors', '/invalidReadReply/dto'));
  });

  const agentError = object(fixture('relay-rpc-method', '/http/body'));
  const malformedRpcDetails = [
    ['missing rpcCode', {}],
    ['string rpcCode', { rpcCode: '-32601' }],
    ['fractional rpcCode', { rpcCode: -32601.5 }],
  ] as const;

  it.each(malformedRpcDetails)('reports invalid-response on reads with %s', async (_case, details) => {
    await attach();
    enqueue(response({ ...agentError, details }, 422));
    expect(await session().listProfiles()).toEqual(fixture('renderer-errors', '/invalidReadReply/dto'));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each(malformedRpcDetails)('looks up a write receipt on 422 with %s', async (_case, details) => {
    const { bindingId } = await attach();
    enqueue(response({ ...agentError, details }, 422));
    sessionCase('lookup-unknown');
    sessionCase('selections-list-tool-first');
    const report = await session().setActiveTools(bindingId, []);
    expect(report).toMatchObject({
      outcome: fixture('renderer-errors', '/invalidMutationReply/dto'),
      receipt: 'unknown',
      refresh: { status: 'success' },
    });
    expect(sent(2)).toMatchObject({
      bindingId,
      method: '_aelix/session/requests/lookup',
      payload: { requestId: report.requestId },
    });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('keeps the D16 result-too-large refusal out of profiles/use and its completed receipts', async () => {
    const { bindingId } = await attach();
    const oversized = fixture('relay-error-large-item', '/result');
    enqueue(relay(oversized));
    enqueue(relay({ status: 'completed', result: oversized }));
    sessionCase('profiles-list-page-1');
    sessionCase('selections-list-tool-first');
    sessionCase('selections-list-skill');
    const report = await session().useProfile(bindingId, fixture('profile-ref', '/vectors/0/ref') as ProfileRef);
    expect(report).toMatchObject({
      outcome: { status: 'unknown', reason: 'invalid-response', retryWrite: false },
      receipt: 'unavailable',
      refresh: { status: 'success' },
    });
    expect(sent(2)).toMatchObject({
      bindingId,
      method: '_aelix/session/requests/lookup',
      payload: { requestId: report.requestId },
    });
    expect(fetcher).toHaveBeenCalledTimes(6);
  });

  it('preserves the original binding for lookup when a stale-binding code has the wrong HTTP status', async () => {
    const { bindingId } = await attach();
    enqueue(response(fixture('transport-ext_stale_binding-409', '/http/body'), 502));
    sessionCase('lookup-unknown');
    sessionCase('selections-list-tool-first');
    const report = await session().setActiveTools(bindingId, []);
    expect(report).toMatchObject({
      outcome: { status: 'unknown' },
      receipt: 'unknown',
      refresh: { status: 'success' },
    });
    expect(sent(2)).toMatchObject({ bindingId, method: '_aelix/session/requests/lookup' });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('keeps a malformed completed receipt unavailable and still refreshes', async () => {
    const { bindingId } = await attach();
    fetcher.mockRejectedValueOnce(new Error('Lost write response'));
    enqueue(relay({ status: 'completed', result: { accepted: 'yes' } }));
    sessionCase('selections-list-tool-first');
    expect(await session().setActiveTools(bindingId, [])).toMatchObject({
      outcome: { status: 'unknown', reason: 'no-reply', retryWrite: false },
      receipt: 'unavailable',
      refresh: { status: 'success' },
    });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('leaves the replacement global page and cursor intact when a retired write resolves', async () => {
    helperCase('helper-tools-first');
    const old = valueOf(await globalResources().listSelections('tool'));
    let finish: ((reply: Response) => void) | undefined;
    fetcher.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const write = globalResources().setSelections(old, [{ key: 'read', on: false }]);

    globalResources().invalidate();
    helperCase('helper-tools-first');
    const current = valueOf(await globalResources().listSelections('tool', 1));
    helperCase('helper-tools-next');
    finish?.(response(fixture('helper-set-tool', '/reply')));

    const report = await write;
    expect(report).toMatchObject({ outcome: { status: 'unknown', reason: 'context-changed' } });
    expect(globalResources().peekSelections('tool')).toBe(current);
    expect(valueOf(await globalResources().nextSelections(current)).complete).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it.each(['explicit refresh', 'expired cursor'])('retires a pending profile preview on %s', async (reason) => {
    await attach();
    sessionCase('profiles-list-page-1');
    const first = valueOf(await session().listProfiles(1));
    let finish: ((reply: Response) => void) | undefined;
    fetcher.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const show = session().showProfile('quiet');

    if (reason === 'expired cursor') {
      sessionCase('relay-error-stale-cursor');
      sessionCase('profiles-list-page-1');
      valueOf(await session().nextProfiles(first));
    } else {
      sessionCase('profiles-list-page-1');
      valueOf(await session().listProfiles(1));
    }
    finish?.(relay(fixture('profiles-show', '/result')));
    expect(await show).toMatchObject({ status: 'stale' });
    expect(session().profileView()?.inspected).toBeNull();
  });

  it('clears a cached preview when restarting the catalog', async () => {
    helperCase('helper-profiles-first');
    valueOf(await globalResources().listProfiles(1));
    helperCase('helper-profile-show');
    valueOf(await globalResources().showProfile('quiet'));
    expect(globalResources().profileView()?.inspected).toBeTruthy();
    helperCase('helper-profiles-first');
    valueOf(await globalResources().listProfiles(1));
    expect(globalResources().profileView()?.inspected).toBeNull();
  });

  it.each(['scope', 'revision'])('pairs a profile preview only when the catalog ref has the same %s', async (field) => {
    const entry = object(fixture('helper-profiles-first', '/reply/data/profiles/0'));
    const ref = { ...object(entry.ref), [field]: field === 'scope' ? 'bundled' : 'sha256:' + '1'.repeat(64) };
    enqueue(
      response({
        ok: true,
        data: { ...object(fixture('helper-profiles-first', '/reply/data')), profiles: [{ ...entry, ref }] },
      })
    );
    valueOf(await globalResources().listProfiles(1));
    helperCase('helper-profile-show');
    valueOf(await globalResources().showProfile('quiet'));
    expect(globalResources().profileView()).toMatchObject({ inspected: null, profiles: [{ ref }] });
  });

  it('types the display view separately from the pageable profile DTO', async () => {
    helperCase('helper-profiles-first');
    const page = valueOf(await globalResources().listProfiles(1));
    const view = globalResources().profileView();
    expectTypeOf<NonNullable<typeof view>>().not.toMatchTypeOf<typeof page>();
    helperCase('helper-profiles-next');
    expect(valueOf(await globalResources().nextProfiles(page)).complete).toBe(true);
  });
});

describe('D16 behavioral fixture matrix', () => {
  // These examples specify native hashing/approval, persistence, or gateway deduplication.
  // Renderer-facing replies embedded in them are exercised through the cases that reference them.
  const otherUnits = {
    A: [
      'native-guard',
      'load-drift-open',
      'load-drift-allow',
      'load-legacy',
      'load-recorded-match',
      'reselection-same-source',
      'same-key-twice',
    ],
    B: ['project-file-consent'],
    C: ['helper-same-key-twice'],
  } as const;

  it('records ownership of the nine producer-only cases in the fixture', () => {
    const producerCases = Object.values(otherUnits).flat();
    expect(new Set(producerCases).size).toBe(9);
    expect([...cases.keys()].filter((id) => producerCases.some((producerCase) => producerCase === id))).toHaveLength(9);
  });

  it.each([
    ['relay-error-unsupported', 'selections', 'unsupported', 'disable-control'],
    ['relay-error-large-item', 'profiles', 'refused', 'refresh'],
    ['relay-error-profile-unavailable', 'preview', 'refused', 'refresh'],
    ['relay-error-unreadable', 'selections', 'refused', 'refresh'],
  ] as const)('preserves the typed read outcome for %s', async (id, operation, status, action) => {
    await attach();
    sessionCase(id);
    const { reason, ...details } = object(fixture(id, '/result'));
    const result =
      operation === 'profiles'
        ? await session().listProfiles()
        : operation === 'preview'
          ? await session().showProfile(String(details.name))
          : await session().listSelections(fixture(id, '/post/payload/kind') as ResourceKind);
    const { accepted: _accepted, ...dto } = details;
    expect(result).toEqual({ status, reason, action, retryWrite: false, ...dto });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each(['relay-error-unavailable-tool', 'relay-error-locked-tool'])('keeps the offending tool in %s', async (id) => {
    const { bindingId } = await attach();
    sessionCase(id);
    sessionCase('selections-list-tool-first');
    const report = await session().setActiveTools(bindingId, fixture(id, '/post/payload/names') as string[]);
    const { accepted: _accepted, ...details } = object(fixture(id, '/result'));
    expect(report.outcome).toEqual({ status: 'refused', action: 'refresh', retryWrite: false, ...details });
    expect(report.receipt).toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it.each(['relay-error-profile-refused', 'relay-error-dedup', 'use-permission-cancel', 'use-permission-timeout'])(
    'preserves the profile write refusal for %s',
    async (id) => {
      const { bindingId } = await attach();
      sessionCase(id);
      sessionCase('profiles-list-page-1');
      sessionCase('selections-list-tool-first');
      sessionCase('selections-list-skill');
      const ref = fixture('profile-ref', '/vectors/0/ref') as ProfileRef;
      const { cause, reason, recovery } = object(fixture(id, '/result'));
      const { outcome, receipt } = await session().useProfile(bindingId, ref);
      expect(outcome).toEqual(
        cause
          ? { status: 'recovery-required', reason: cause, ...object(recovery), retryWrite: false }
          : { status: 'refused', reason, action: 'refresh', retryWrite: false }
      );
      expect(receipt).toBeUndefined();
    }
  );

  it.each([
    'relay-error-unknown-row',
    'relay-error-locked-row',
    'relay-error-scope-readonly',
    'relay-error-write-failed',
    'project-permission-deny',
    'project-permission-cancel',
    'project-permission-timeout',
  ])('preserves project write scope and decision details for %s', async (id) => {
    await attach();
    sessionCase('selections-list-skill');
    const before = valueOf(await session().listSelections('skill'));
    sessionCase(id);
    sessionCase('selections-list-skill');
    const { accepted: _accepted, ...details } = object(fixture(id, '/result'));
    const changes = fixture('selections-set-skill', '/post/payload/changes') as ResourceChange[];
    const report = await session().setProjectSelections(before, changes);
    expect(report.outcome).toEqual({ status: 'refused', action: 'refresh', retryWrite: false, ...details });
    expect(report.refresh).toMatchObject({
      status: 'success',
      data: {
        items: [{ key: 'review', mismatches: details.mismatches ?? [] }],
      },
    });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it.each([
    ['helper-error-forbidden', 'refused', 'refresh'],
    ['helper-error-unauthenticated', 'unauthenticated', 'sign-in-and-read'],
    ['helper-error-frame_limit', 'refused', 'refresh'],
    ['helper-error-invalid_input', 'refused', 'refresh'],
    ['helper-error-scope_denied', 'refused', 'refresh'],
    ['helper-error-profile_unavailable', 'refused', 'refresh'],
    ['helper-error-selection_missing', 'refused', 'refresh'],
    ['helper-error-selection_locked', 'refused', 'refresh'],
    ['helper-error-scope_readonly', 'refused', 'refresh'],
    ['helper-error-store_unreadable', 'refused', 'refresh'],
    ['helper-error-busy', 'refused', 'wait-idle'],
    ['helper-error-request_id_conflict', 'refused', 'refresh'],
    ['helper-error-dedup_capacity', 'refused', 'refresh'],
    ['helper-error-runtime_unavailable', 'unsupported', 'disable-control'],
    ['helper-error-result_too_large', 'refused', 'refresh'],
    ['helper-error-helper_unavailable', 'error', 'refresh'],
  ] as const)('projects the helper error for %s', async (id, status, action) => {
    const { action: operation, kind, name } = object(fixture(id, '/command'));
    const { code, key } = object(fixture(id, '/reply'));
    const refusal = response(fixture(id, '/reply'), Number(fixture(id, '/httpStatus')));
    const global = globalResources();
    let outcome: ResourceResult<unknown>;
    if (operation === 'selections/set') {
      helperCase('helper-tools-first');
      const before = valueOf(await global.listSelections('tool'));
      enqueue(refusal);
      helperCase('helper-tools-first');
      outcome = (await global.setSelections(before, [{ key: 'read', on: false }])).outcome;
      expect(fetcher).toHaveBeenCalledTimes(3);
    } else {
      enqueue(refusal);
      if (operation === 'selections/list') outcome = await global.listSelections(kind as ResourceKind);
      else if (operation === 'profiles/show') outcome = await global.showProfile(String(name));
      else outcome = await global.listProfiles();
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
    expect(outcome).toEqual({ status, reason: code, action, retryWrite: false, ...(key === undefined ? {} : { key }) });
  });

  it.each([
    ['transport-source_forbidden-403', 'refused', 'refresh', 'SOURCE_FORBIDDEN'],
    ['transport-csrf_invalid-403', 'refused', 'refresh', 'CSRF_INVALID'],
    ['transport-ext_method_denied-403', 'unsupported', 'disable-control', 'EXT_METHOD_DENIED'],
    ['transport-ext_invalid-400', 'refused', 'refresh', 'EXT_INVALID'],
    ['transport-ext_too_large-413', 'refused', 'refresh', 'EXT_TOO_LARGE'],
    ['transport-ext_media_type-415', 'refused', 'refresh', 'EXT_MEDIA_TYPE'],
    ['transport-ext_rate_limited-429', 'refused', 'refresh', 'EXT_RATE_LIMITED'],
    ['relay-rpc-method', 'unsupported', 'disable-control', 'rpc/-32601'],
    ['relay-rpc-params', 'refused', 'refresh', 'rpc/-32602'],
    ['relay-rpc-id-conflict', 'refused', 'refresh', 'rpc/-32602'],
    ['relay-rpc-scope', 'refused', 'refresh', 'rpc/-33102'],
    ['relay-rpc-binding', 'refused', 'refresh', 'rpc/-33102'],
  ] as const)('treats the validated H1 envelope in %s as a definitive refusal', async (id, status, action, reason) => {
    const { bindingId } = await attach();
    enqueue(http(fixture(id, '/http')));
    sessionCase('selections-list-tool-first');
    const { outcome, receipt } = await session().setActiveTools(bindingId, []);
    expect({ outcome, receipt }).toEqual({
      outcome: { status, reason, action, retryWrite: false },
      receipt: undefined,
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it.each([
    ['transport-ext_unavailable-409', 'unsupported', 'EXT_UNAVAILABLE', 'disable-control'],
    ['transport-internal_error-500', 'error', 'INTERNAL_ERROR', 'refresh'],
    ['relay-rpc-internal', 'error', 'rpc/-32603', 'refresh'],
  ] as const)('classifies the H1 read failure in %s', async (id, status, reason, action) => {
    if (id === 'relay-rpc-internal') await attach();
    enqueue(http(fixture(id, '/http')));
    const outcome = id === 'relay-rpc-internal' ? await session().listProfiles() : await session().discover();
    expect(outcome).toEqual({ status, reason, action, retryWrite: false });
  });

  it.each([
    'relay-rpc-outcome',
    'transport-ext_outcome_unknown-409',
    'transport-ext_outcome_unknown-504',
    'transport-no-reply',
  ])('reconciles %s once, with the original binding and request ID', async (id) => {
    const { bindingId } = await attach();
    const frame = fixture(id, '/http');
    if (frame === null) fetcher.mockRejectedValueOnce(new Error('Lost write response'));
    else enqueue(http(frame));
    sessionCase('lookup-pending');
    sessionCase('selections-list-tool-first');
    const report = await session().setActiveTools(bindingId, []);
    const dto =
      frame === null
        ? fixture(id, '/renderer')
        : { status: 'unknown', reason: 'EXT_OUTCOME_UNKNOWN', action: 'lookup-and-refresh', retryWrite: false };
    expect(report).toMatchObject({ outcome: dto, receipt: 'pending', refresh: { status: 'success' } });
    expect(sent(2)).toMatchObject({
      bindingId,
      method: '_aelix/session/requests/lookup',
      payload: { requestId: report.requestId },
    });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
});
