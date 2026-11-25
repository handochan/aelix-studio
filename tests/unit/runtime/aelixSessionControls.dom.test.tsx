/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { useTranslation } from 'react-i18next';
import MobileActionSheet from '@/renderer/components/chat/MobileActionSheet';
import {
  AelixSessionDrawer,
  AelixSessionPills,
  aelixSheetEntries,
  useAelixSessionControls,
} from '@/renderer/pages/conversation/runtime/AelixSessionControls';
import type { HostTurnState } from '@/renderer/services/runtime/RunningInput/decideSend';
import fixtures from '@/renderer/services/runtime/NativeResources/studio-7-d16-v1.json';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => (options ? `${key} ${JSON.stringify(options)}` : key),
    i18n: { language: 'en-US' },
  }),
}));

vi.mock('@/common/adapter/httpBridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/common/adapter/httpBridge')>()),
  getBaseUrl: () => '',
  resolveCoreCsrfToken: () => 'csrf',
  wsEmitter: () => ({ on: () => () => {}, emit: () => {} }),
}));

// ---- D16 fixtures ---------------------------------------------------------------------------

type Json = Record<string, unknown>;
const cases = new Map<string, unknown>();
function pointer(value: unknown, path: string): unknown {
  return path
    .split('/')
    .slice(1)
    .reduce<unknown>((node, key) => (Array.isArray(node) ? node[Number(key)] : (node as Json)[key]), value);
}
function expand(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(expand);
  if (!value || typeof value !== 'object') return value;
  const row = value as Json;
  if (typeof row.$fixture === 'string') {
    const [id, path] = row.$fixture.split('#');
    return structuredClone(pointer(cases.get(id), path));
  }
  return Object.fromEntries(Object.entries(row).map(([key, entry]) => [key, expand(entry)]));
}
for (const example of fixtures as Json[]) cases.set(String(example.id), expand(example));
const fixture = <T = Json>(id: string, path = ''): T => structuredClone(pointer(cases.get(id), path)) as T;

type Ref = { name: string; scope: string; revision: string };
const QUIET = fixture<Ref>('profile-ref', '/vectors/0/ref');
const QUIET_PROJECT = fixture<Ref>('profile-ref', '/vectors/1/ref');
const WRITER = fixture<Ref>('profile-ref', '/vectors/4/ref');

const P = '_aelix/session/';
const LIST = P + 'profiles/list';
const SHOW = P + 'profiles/show';
const USE = P + 'profiles/use';
const SET_TOOLS = P + 'tools/set-active';
const SELECTIONS = P + 'selections/list';
const LOOKUP = P + 'requests/lookup';

// ---- Fake host relay ------------------------------------------------------------------------

type Post = { bindingId: string; method: string; payload: Json };
type Reply = (payload: Json) => Response | Promise<Response>;

const relay = (result: unknown) => Response.json({ success: true, data: { result } });
const failure = (status: number, code: string) => Response.json({ success: false, code, error: 'x' }, { status });

const state = {
  activeRef: QUIET as Ref | null,
  activeAgent: 'quiet' as string | null,
  toolOverride: null as string[] | null,
  activeTools: ['read'],
};
let discovery: () => Response;
const replies = new Map<string, Reply>();
const posts: Post[] = [];
const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>();
const postsOf = (method: string) => posts.filter((post) => post.method === method);

function writerPreview() {
  const preview = fixture<Json>('profiles-show', '/result');
  const profile = preview.profile as Json;
  return {
    profile: {
      ...profile,
      ref: WRITER,
      source: 'user:agents/writer.md',
      description: 'Write notes',
      promptPreview: 'Write notes.',
      tools: ['write'],
    },
  };
}

function toolList() {
  const first = fixture<Json>('selections-list-tool-first', '/result');
  const next = fixture<Json>('selections-list-tool-next', '/result');
  return {
    ...first,
    items: [...(first.items as Json[]), ...(next.items as Json[])],
    toolOverride: state.toolOverride,
    activeTools: state.toolOverride ?? state.activeTools,
    nextCursor: null,
  };
}

function defaults() {
  replies.clear();
  replies.set(LIST, () =>
    relay({
      profiles: [
        { ref: QUIET, description: 'Review only' },
        { ref: WRITER, description: 'Write notes' },
      ],
      activeAgent: state.activeAgent,
      activeRef: state.activeRef,
      diagnostics: [],
      nextCursor: null,
    })
  );
  replies.set(SHOW, ({ name }) => relay(name === 'writer' ? writerPreview() : fixture('profiles-show', '/result')));
  replies.set(SELECTIONS, ({ kind }) =>
    relay(kind === 'tool' ? toolList() : fixture('selections-list-skill', '/result'))
  );
  replies.set(USE, ({ profile }) => {
    const ref = profile as Ref | null;
    state.activeRef = ref;
    state.activeAgent = ref?.name ?? null;
    state.toolOverride = null;
    return relay({ accepted: true, activeAgent: state.activeAgent, activeRef: ref, toolOverride: null });
  });
  replies.set(SET_TOOLS, ({ names }) => {
    state.toolOverride = [...(names as string[])];
    return relay({ accepted: true, toolOverride: names, activeTools: names });
  });
}

const discovered = () => Response.json(fixture('relay-discovery', '/response/body'));

// ---- Harness --------------------------------------------------------------------------------

const Harness: React.FC<{ hostState?: HostTurnState; mobile?: boolean; onProfileApplied?: () => void }> = ({
  hostState = 'idle',
  mobile = false,
  onProfileApplied,
}) => {
  const controls = useAelixSessionControls({ conversationId: 'c-17', enabled: true, hostState, onProfileApplied });
  const { t } = useTranslation();
  if (!mobile) return <AelixSessionPills controls={controls} />;
  return (
    <>
      <MobileActionSheet open onClose={() => {}} entries={aelixSheetEntries(t, controls)} />
      <AelixSessionDrawer controls={controls} />
    </>
  );
};

async function settle() {
  for (let round = 0; round < 8; round++) {
    // oxlint-disable-next-line no-await-in-loop -- flush chained relay reads in order
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function openPanel(panel: 'profile' | 'tools') {
  fireEvent.click(screen.getByTestId(`aelix-${panel}-pill`));
  await settle();
  return within(await screen.findByTestId(`aelix-${panel}-popover`));
}

async function inspect(name: string) {
  fireEvent.click(within(screen.getByTestId('aelix-profile-list')).getByText(name));
  await settle();
  await screen.findByTestId('aelix-profile-preview');
}

const K = 'conversation.aelixControls';

beforeEach(() => {
  state.activeRef = QUIET;
  state.activeAgent = 'quiet';
  state.toolOverride = null;
  state.activeTools = ['read'];
  posts.length = 0;
  discovery = discovered;
  defaults();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url, init) => {
    expect(url).toBe('/api/conversations/c-17/acp-extensions');
    if (init.method === 'GET') return discovery();
    const post = JSON.parse(String(init.body)) as Post;
    posts.push(post);
    const reply = replies.get(post.method);
    if (!reply) throw new Error('Unexpected relay call ' + post.method);
    return reply(post.payload);
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Aelix conversation controls: attach and availability', () => {
  it('shows "use after opening" while no live task exists, then re-reads after attach without writing', async () => {
    discovery = () => failure(409, 'EXT_NO_LIVE_TASK');
    const view = render(<Harness hostState='unknown' />);
    await settle();
    expect(screen.getByTestId('aelix-profile-pill')).toHaveTextContent(`${K}.summary.openFirst`);
    const panel = await openPanel('profile');
    expect(panel.getByTestId('aelix-controls-detached')).toHaveTextContent(`${K}.status.openFirst`);
    // Discovery is a read and never creates a first turn.
    expect(fetchMock.mock.calls.every(([, init]) => init.method === 'GET')).toBe(true);

    discovery = discovered;
    view.rerender(<Harness hostState='idle' />);
    await settle();

    expect(await screen.findByTestId('aelix-profile-list')).toBeInTheDocument();
    expect(postsOf(USE).length + postsOf(SET_TOOLS).length).toBe(0);
  });

  it('shows an update-required state when the host does not offer the relay', async () => {
    discovery = () => new Response(null, { status: 404 });
    render(<Harness />);
    await settle();
    expect(screen.getByTestId('aelix-tools-pill')).toHaveTextContent(`${K}.summary.updateRequired`);
    const panel = await openPanel('tools');
    expect(panel.getByTestId('aelix-controls-update-required')).toBeInTheDocument();
  });

  it('shows selection as unavailable only when the runtime lacks profiles/use', async () => {
    const requests = fixture<string[]>('relay-discovery', '/response/body/data/requests').filter(
      (method) => method !== USE
    );
    discovery = () => {
      const body = fixture<Json>('relay-discovery', '/response/body');
      return Response.json({ ...body, data: { ...(body.data as Json), requests } });
    };
    render(<Harness />);
    await settle();
    await openPanel('profile');

    expect(screen.getByTestId('aelix-profile-apply-update-required')).toBeInTheDocument();
    expect(screen.queryByTestId('aelix-profile-apply')).toBeNull();
    expect(screen.getByTestId('aelix-profile-list')).toBeInTheDocument();
  });

  it('keeps selection available when a runtime refuses one apply as unsupported, without faking success', async () => {
    state.activeRef = WRITER;
    state.activeAgent = 'writer';
    replies.set(USE, () => relay({ accepted: false, reason: 'unsupported' }));
    render(<Harness />);
    await settle();
    await openPanel('profile');
    await inspect('quiet');
    fireEvent.click(screen.getByTestId('aelix-profile-apply'));
    await settle();

    expect(screen.getByTestId('aelix-controls-notice')).toHaveTextContent(`${K}.notice.updateRequired`);
    expect(screen.queryByTestId('aelix-profile-apply-update-required')).toBeNull();
    expect(screen.getByTestId('aelix-profile-current')).toHaveTextContent('writer');
  });
});

describe('Aelix conversation controls: profile', () => {
  it('previews source and tool restriction, applies while idle, and re-reads model, tools and skills', async () => {
    const applied = vi.fn();
    render(<Harness onProfileApplied={applied} />);
    await settle();
    expect(screen.getByTestId('aelix-profile-pill')).toHaveTextContent('quiet');
    await openPanel('profile');
    await inspect('writer');

    const shown = screen.getByTestId('aelix-profile-preview');
    expect(shown).toHaveTextContent('user:agents/writer.md');
    expect(shown).toHaveTextContent('write');

    const listsBefore = postsOf(SELECTIONS).length;
    fireEvent.click(screen.getByTestId('aelix-profile-apply'));
    await settle();

    expect(postsOf(USE).map((post) => post.payload.profile)).toEqual([WRITER]);
    expect(postsOf(SELECTIONS).length).toBeGreaterThanOrEqual(listsBefore + 2);
    expect(applied).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('aelix-controls-notice')).toHaveTextContent(`${K}.notice.profileApplied`);
  });

  it('keeps apply disabled while Aelix is busy and sends no write', async () => {
    render(<Harness hostState='busy' />);
    await settle();
    await openPanel('profile');
    await inspect('writer');

    expect(screen.getByTestId('aelix-profile-apply')).toBeDisabled();
    expect(screen.getByTestId('aelix-controls-blocked')).toHaveTextContent(`${K}.status.busy`);
    fireEvent.click(screen.getByTestId('aelix-profile-apply'));
    await settle();
    expect(postsOf(USE)).toHaveLength(0);
  });

  it('shows a busy refusal from the runtime without retrying', async () => {
    replies.set(USE, () => relay({ accepted: false, reason: 'busy' }));
    render(<Harness />);
    await settle();
    await openPanel('profile');
    await inspect('writer');
    fireEvent.click(screen.getByTestId('aelix-profile-apply'));
    await settle();

    expect(screen.getByTestId('aelix-controls-notice')).toHaveTextContent(`${K}.notice.busy`);
    expect(postsOf(USE)).toHaveLength(1);
  });
});

describe('Aelix conversation controls: tools', () => {
  it('saves an explicit empty selection distinctly from inherit', async () => {
    render(<Harness />);
    await settle();
    expect(screen.getByTestId('aelix-tools-pill')).toHaveTextContent(`${K}.tools.inherited`);
    await openPanel('tools');
    expect(screen.getByTestId('aelix-tools-mode')).toHaveTextContent(`${K}.tools.modeInherited`);

    fireEvent.click(screen.getByTestId('aelix-tools-none'));
    fireEvent.click(screen.getByTestId('aelix-tools-save'));
    await settle();

    expect(postsOf(SET_TOOLS).map((post) => post.payload.names)).toEqual([[]]);
    expect(screen.getByTestId('aelix-tools-mode')).toHaveTextContent(`${K}.tools.modeNone`);
    expect(screen.getByTestId('aelix-tools-pill')).toHaveTextContent(`${K}.tools.none`);
  });

  it('shows saved, applied and live state with lock reasons and pending rows', async () => {
    replies.set(SELECTIONS, ({ kind }) => {
      if (kind !== 'tool') return relay(fixture('selections-list-skill', '/result'));
      const list = toolList();
      const [read, write] = list.items as Json[];
      return relay({
        ...list,
        items: [
          { ...read, live: false, pending: true },
          { ...write, loaded: false, saved: true, lock: { kind: 'cli', value: false, reason: 'launch-locked' } },
        ],
      });
    });
    render(<Harness />);
    await settle();
    await openPanel('tools');

    const read = screen.getByTestId('aelix-tool-state-read');
    expect(read).toHaveTextContent(`${K}.row.live {"value":"${K}.row.off"}`);
    expect(read).toHaveTextContent(`${K}.row.pendingNext`);
    expect(screen.getByTestId('aelix-tool-lock-write')).toHaveTextContent(`${K}.lock.launch`);
    expect(within(screen.getByTestId('aelix-tool-write')).getByRole('checkbox')).toBeDisabled();
  });
});

describe('Aelix conversation controls: decision 2 and recovery', () => {
  beforeEach(() => {
    state.activeRef = WRITER;
    state.activeAgent = 'writer';
  });

  it('shows what changed and reselects the current candidate once', async () => {
    replies.set(USE, ({ profile }) => {
      const ref = profile as Ref;
      if (ref.revision === QUIET.revision) return relay(fixture('use-stale-preview', '/result'));
      state.activeRef = ref;
      return relay({ accepted: true, activeAgent: ref.name, activeRef: ref, toolOverride: null });
    });
    render(<Harness />);
    await settle();
    await openPanel('profile');
    await inspect('quiet');
    fireEvent.click(screen.getByTestId('aelix-profile-apply'));
    await settle();

    const card = screen.getByTestId('aelix-profile-change-card');
    expect(within(card).getByTestId('aelix-change-candidate')).toHaveTextContent(`${K}.scope.project`);
    expect(within(card).getByTestId('aelix-change-differences')).toHaveTextContent(`${K}.field.tools`);

    fireEvent.click(within(card).getByTestId('aelix-change-reselect'));
    await settle();

    expect(postsOf(USE).map((post) => post.payload.profile)).toEqual([QUIET, QUIET_PROJECT]);
    expect(screen.queryByTestId('aelix-profile-change-card')).toBeNull();
    expect(screen.getByTestId('aelix-controls-notice')).toHaveTextContent(`${K}.notice.profileApplied`);
  });

  it('offers recovery after the approval is declined and sends nothing more', async () => {
    replies.set(USE, ({ profile }) =>
      relay(
        (profile as Ref).revision === QUIET.revision
          ? fixture('use-stale-preview', '/result')
          : fixture('use-permission-deny', '/result')
      )
    );
    render(<Harness />);
    await settle();
    await openPanel('profile');
    await inspect('quiet');
    fireEvent.click(screen.getByTestId('aelix-profile-apply'));
    await settle();
    fireEvent.click(screen.getByTestId('aelix-change-reselect'));
    await settle();

    const card = screen.getByTestId('aelix-recovery-card');
    expect(card).toHaveTextContent(`${K}.recovery.cause.declined`);
    expect(card).toHaveTextContent(`${K}.recovery.noResend`);
    expect(within(card).getByTestId('aelix-recovery-original')).toHaveTextContent('quiet');
    expect(postsOf(USE)).toHaveLength(2);
  });

  it('restores only the items the user picks after an unknown outcome', async () => {
    state.activeRef = QUIET;
    state.activeAgent = 'quiet';
    state.toolOverride = ['read'];
    replies.set(USE, ({ profile }) => {
      const ref = profile as Ref;
      state.activeRef = ref;
      state.activeAgent = ref.name;
      state.toolOverride = null;
      if (ref.name === 'writer') return failure(502, 'EXT_OUTCOME_UNKNOWN');
      return relay({ accepted: true, activeAgent: ref.name, activeRef: ref, toolOverride: null });
    });
    replies.set(LOOKUP, () => relay({ status: 'unknown' }));
    render(<Harness />);
    await settle();
    await openPanel('profile');
    await inspect('writer');
    fireEvent.click(screen.getByTestId('aelix-profile-apply'));
    await settle();

    const card = screen.getByTestId('aelix-recovery-card');
    expect(card).toHaveTextContent(`${K}.recovery.cause.unknown`);
    expect(within(card).getByTestId('aelix-recovery-pick-tools')).toBeInTheDocument();
    fireEvent.click(within(within(card).getByTestId('aelix-recovery-pick-profile')).getByRole('checkbox'));
    expect(card).toHaveTextContent(`${K}.recovery.profileResetsTools`);
    fireEvent.click(within(card).getByTestId('aelix-recovery-restore'));
    await settle();

    expect(postsOf(USE).map((post) => post.payload.profile)).toEqual([WRITER, QUIET]);
    expect(postsOf(SET_TOOLS)).toHaveLength(0);
    await waitFor(() => expect(screen.queryByTestId('aelix-recovery-card')).toBeNull());
  });
});

describe('Aelix conversation controls: mobile composer', () => {
  it('opens the profile panel in a drawer from the action sheet', async () => {
    render(<Harness mobile />);
    await settle();
    expect(screen.queryByTestId('aelix-profile-pill')).toBeNull();

    fireEvent.click(screen.getByText(`${K}.profile.label`));
    await settle();

    const drawer = await screen.findByTestId('aelix-profile-drawer');
    expect(within(drawer).getByTestId('aelix-profile-list')).toHaveTextContent('writer');
  });

  it("opens this conversation's tools in a drawer and saves from it", async () => {
    render(<Harness mobile />);
    await settle();
    fireEvent.click(screen.getByText(`${K}.tools.title`));
    await settle();

    const drawer = await screen.findByTestId('aelix-tools-drawer');
    fireEvent.click(within(drawer).getByTestId('aelix-tools-none'));
    fireEvent.click(within(drawer).getByTestId('aelix-tools-save'));
    await settle();
    expect(postsOf(SET_TOOLS).map((post) => post.payload.names)).toEqual([[]]);
  });
});
