/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { Message } from '@arco-design/web-react';
import * as httpBridge from '@/common/adapter/httpBridge';
import {
  RunningInputModeSwitch,
  RunningInputNotices,
  useRunningInput,
  type RunningInputController,
  type RunningInputRoute,
} from '@/renderer/pages/conversation/runtime/RunningInput';
import { useConversationRuntimeView } from '@/renderer/pages/conversation/runtime/useConversationRuntimeView';
import {
  getConversationRuntimeViewSnapshot,
  hydrateSucceeded,
  resetConversationRuntimeViewStoreForTest,
  type ConversationRuntimeView,
} from '@/renderer/pages/conversation/runtime/conversationRuntimeViewStore';
import type { TConversationRuntimeSummary } from '@/common/config/storage';
import type { UseRunningInputOptions } from '@/renderer/pages/conversation/runtime/RunningInput/useRunningInput';
import { emitter } from '@/renderer/utils/emitter';
import type { RunningInputReferences } from '@/renderer/services/runtime/RunningInput';
import * as runningImages from '@/renderer/services/runtime/RunningInput/Images';
import * as imageBudget from '@/renderer/services/runtime/RunningInput/Images/budget';
import * as imageTransfer from '@/renderer/services/runtime/RunningInput/Images/transfer';
import * as imageWorker from '@/renderer/services/runtime/RunningInput/Images/workerClient';
import referencesFixture from './runningInputReferences.fixture.json';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, string>) => (options ? `${key} ${JSON.stringify(options)}` : key),
    i18n: { language: 'en-US' },
  }),
}));

const PREFIX = '_aelix/session/';
const STATE = PREFIX + 'input/state';
const STEER = PREFIX + 'input/steer';
const FOLLOW_UP = PREFIX + 'input/follow-up';
const LOOKUP = PREFIX + 'requests/lookup';
const IMAGE_STATE = PREFIX + 'input/image-state';
const STEER_IMAGES = PREFIX + 'input/steer-images';
const ALL_METHODS = [STATE, STEER, FOLLOW_UP, LOOKUP];
const TEXT_DRAFT = { slashCommand: false, hasQuote: false };
const NO_REFERENCES: RunningInputReferences = { files: [], sessions: [] };
const IMAGE_REFERENCE: RunningInputReferences = {
  files: [{ kind: 'upload', path: '/client/input.png' }],
  sessions: [],
};
const CONFIRMED_IMAGE = '/host/private/image.png';

const success = (data: unknown) => Response.json({ success: true, data });
const result = (value: unknown) => success({ result: value });
const failure = (status: number, code: string) => Response.json({ success: false, code, error: 'x' }, { status });
const accepted = (turnId: string) => result({ turnId, accepted: true, delivery: 'native-queue' });

type Turn = { active: true; turnId: string } | { active: false; turnId: null };
type Write = { method: string; payload: Record<string, string> };

const server = {
  discovery: (): Response | Promise<Response> =>
    success({ version: 1, bindingId: 'binding-1', notifications: [], requests: ALL_METHODS }),
  turn: { active: true, turnId: 'turn-1' } as Turn,
  readState: vi.fn<() => Response | Promise<Response>>(),
  write: vi.fn<(call: Write) => Response | Promise<Response>>(),
  metadata: vi.fn<(file: { path?: string; relative_path?: string }) => Response | Promise<Response>>(),
  mentionable: vi.fn<(id: string) => Response | Promise<Response>>(),
  conversation: vi.fn<(id: string) => Response | Promise<Response>>(),
};
const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>();
const writes = () => server.write.mock.calls.map(([call]) => call.method);

let controller: RunningInputController;
const BASE: UseRunningInputOptions = {
  conversationId: 'conv-1',
  enabled: true,
  host: 'busy',
  refreshHost: async () => ({ host: 'unknown', hostTurnId: null }),
  hostTurnId: 'host-turn-1',
  stopping: false,
  paused: false,
};

const Harness: React.FC<Partial<UseRunningInputOptions>> = (props) => {
  controller = useRunningInput({ ...BASE, ...props });
  return (
    <>
      {controller.available && (
        <RunningInputModeSwitch modes={controller.modes} value={controller.mode} onChange={controller.setMode} />
      )}
      <RunningInputNotices
        notices={controller.notices}
        onDismiss={controller.dismiss}
        onCheck={(requestId) => void controller.check(requestId)}
        images={controller.images}
      />
    </>
  );
};

const IDLE_RUNTIME: TConversationRuntimeSummary = {
  state: 'idle',
  can_send_message: true,
  has_task: false,
  is_processing: false,
  turn_id: null,
  pending_confirmations: 0,
};

const RecoveringComposer = () => {
  const { view, refreshMissingRuntime } = useConversationRuntimeView(BASE.conversationId);
  const observe = (value: ConversationRuntimeView): Pick<UseRunningInputOptions, 'host' | 'hostTurnId'> => ({
    host: value.isProcessing ? 'busy' : value.hydrated && value.hasBackendRuntime ? 'idle' : 'unknown',
    hostTurnId: value.activeTurnId,
  });
  return <Harness {...observe(view)} refreshHost={async () => observe(await refreshMissingRuntime())} />;
};

const RuntimeObserver = () => {
  useConversationRuntimeView(BASE.conversationId);
  return null;
};

function hold() {
  let reply!: (value: Response) => void;
  const pending = new Promise<Response>((resolve) => {
    reply = resolve;
  });
  return { pending, reply };
}

async function settle() {
  for (let round = 0; round < 5; round++) {
    // eslint-disable-next-line no-await-in-loop -- flush chained relay reads in order
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function mount(props: Partial<UseRunningInputOptions> = {}) {
  const view = render(<Harness {...props} />);
  await settle();
  return view;
}

async function submit(message: string, references = NO_REFERENCES): Promise<RunningInputRoute> {
  let route: RunningInputRoute = 'ordinary';
  await act(async () => {
    route = await controller.submit(message, references, {
      slashCommand: message.trimStart().startsWith('/'),
      hasQuote: false,
    });
  });
  return route;
}

const notices = () => screen.queryAllByTestId('running-input-notice');

describe('running input in the composer', () => {
  beforeEach(() => {
    server.turn = { active: true, turnId: 'turn-1' };
    server.discovery = () => success({ version: 1, bindingId: 'binding-1', notifications: [], requests: ALL_METHODS });
    server.write.mockReset();
    server.readState.mockReset().mockImplementation(() => result(server.turn));
    server.metadata.mockReset().mockImplementation(() => success({ path: CONFIRMED_IMAGE, type: 'image/png' }));
    server.mentionable.mockReset().mockImplementation((id) => {
      const titles: Record<string, string> = { same: 'Renamed target', other: 'Other\t\ntarget', unknown: 'Unbound' };
      return success({ items: [{ id, name: titles[id] }] });
    });
    server.conversation.mockReset();
    server.conversation.mockImplementation((id) =>
      success({
        id,
        extra: { workspace: id === 'other' ? ' /other root ' : id === 'unknown' ? undefined : '/same root' },
      })
    );
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (url, init) => {
      if (url === '/api/fs/content/metadata') return server.metadata(JSON.parse(String(init.body)).file);
      if (url.startsWith('/api/session-messages/mentionable?')) {
        const params = new URLSearchParams(url.split('?')[1]);
        expect(params.get('current_conversation_id')).toBe('conv-1');
        return server.mentionable(params.get('id') ?? '');
      }
      if (url.startsWith('/api/conversations/') && !url.endsWith('/acp-extensions')) {
        return server.conversation(url.split('/').at(-1) ?? '');
      }
      if (init.method === 'GET') return server.discovery();
      const call = JSON.parse(String(init.body)) as Write;
      return call.method === STATE ? server.readState() : server.write(call);
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(httpBridge, 'wsEmitter').mockImplementation(() => ({ on: () => () => {}, emit: () => {} }));
    vi.spyOn(Message, 'warning').mockImplementation(() => () => {});
    vi.spyOn(Message, 'info').mockImplementation(() => () => {});
    vi.spyOn(emitter, 'emit').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('keeps the ordinary composer when the host does not offer the relay', async () => {
    server.discovery = () => failure(404, 'CONVERSATION_NOT_FOUND');
    await mount({ host: 'idle', hostTurnId: null });

    expect(controller).toMatchObject({ handlesSubmit: false, available: false });
    expect(screen.queryByTestId('running-input-mode')).toBeNull();
    expect(await submit('hello')).toBe('ordinary');
    expect(fetchMock.mock.calls.every(([, init]) => init.method === 'GET')).toBe(true);
  });

  it('defaults to steer, clears the draft only on queue acceptance, and groups the turn without counts', async () => {
    server.write.mockImplementation(({ payload }) => accepted(payload.turnId));
    await mount();
    expect(screen.getByTestId('running-input-mode')).toBeInTheDocument();

    expect(await submit('first')).toBe('sent');
    fireEvent.click(screen.getByText('acp.runningInput.mode.followUp'));
    expect(await submit('second')).toBe('sent');

    expect(writes()).toEqual([STEER, FOLLOW_UP]);
    expect(notices()).toHaveLength(1);
    expect(notices()[0]).toHaveTextContent(
      'acp.runningInput.queued {"modes":"acp.runningInput.mode.steer, acp.runningInput.mode.followUp"}'
    );
  });

  it('reads the native turn again before relaying when the last state predates it', async () => {
    server.turn = { active: false, turnId: null };
    server.write.mockImplementation(({ payload }) => accepted(payload.turnId));
    await mount();
    expect(controller.available).toBe(true);

    server.turn = { active: true, turnId: 'turn-2' };
    expect(await submit('hello')).toBe('sent');
    expect(server.write.mock.calls[0][0].payload).toMatchObject({ turnId: 'turn-2', message: 'hello' });
  });

  it.each([true, false])(
    'waits for native state when the host is idle during rediscovery (active: %s)',
    async (active) => {
      const held = hold();
      server.write.mockImplementation(({ payload }) => accepted(payload.turnId));
      const view = await mount();
      const reads = server.readState.mock.calls.length;
      server.turn = active ? { active: true, turnId: 'turn-1' } : { active: false, turnId: null };
      server.readState.mockReturnValueOnce(held.pending);
      view.rerender(<Harness host='idle' hostTurnId={null} />);
      await waitFor(() => expect(server.readState).toHaveBeenCalledTimes(reads + 1));

      let route: Promise<RunningInputRoute> | undefined;
      act(() => {
        route = controller.submit('after the host went idle', NO_REFERENCES, TEXT_DRAFT);
      });
      await act(async () => {
        held.reply(result(server.turn));
        await route;
      });
      await expect(route).resolves.toBe(active ? 'sent' : 'ordinary');
      expect(writes()).toEqual(active ? [STEER] : []);
    }
  );

  it('keeps a negotiated draft when a transient state-read failure leaves native idle unconfirmed', async () => {
    const view = await mount();
    server.readState.mockImplementation(() => failure(502, 'EXT_OUTCOME_UNKNOWN'));
    view.rerender(<Harness host='idle' hostTurnId={null} />);
    await settle();

    expect(controller.handlesSubmit).toBe(true);
    expect(await submit('keep until the native state is known')).toBe('kept');
    expect(server.write).not.toHaveBeenCalled();
  });

  it.each([
    [409, 'EXT_NO_LIVE_TASK', 'ordinary'],
    [409, 'EXT_STALE_BINDING', 'kept'],
    [502, 'EXT_NO_LIVE_TASK', 'kept'],
  ] as const)('routes an idle host after discovery returns %i %s', async (status, code, expected) => {
    const view = await mount();
    server.discovery = () => failure(status, code);
    view.rerender(<Harness host='idle' hostTurnId={null} />);
    await settle();
    expect(controller.handlesSubmit).toBe(true);
    expect(await submit('reopen the task', IMAGE_REFERENCE)).toBe(expected);
    expect(server.metadata).not.toHaveBeenCalled();
    expect(server.write).not.toHaveBeenCalled();
  });

  it.each([
    ['send', 409],
    ['reconnect', 409],
    ['send', 503],
  ] as const)(
    'recovers a failed host GET on %s after discovery returned %s, in the same conversation',
    async (trigger, discoveryStatus) => {
      resetConversationRuntimeViewStoreForTest();
      const reconnect = new Set<() => void>();
      vi.mocked(httpBridge.wsEmitter).mockImplementation((event) => ({
        on: (listener: () => void) => {
          if (event === 'realtime.reconnected') reconnect.add(listener);
          return () => reconnect.delete(listener);
        },
        emit: () => {},
      }));
      server.conversation.mockImplementation(() => failure(503, 'TEMPORARY_FAILURE'));
      server.discovery = () =>
        failure(discoveryStatus, discoveryStatus === 409 ? 'EXT_NO_LIVE_TASK' : 'TEMPORARY_FAILURE');
      render(<RecoveringComposer />);
      await settle();
      expect(getConversationRuntimeViewSnapshot(BASE.conversationId)).toMatchObject({
        hydrated: true,
        hasBackendRuntime: false,
      });
      expect(server.conversation).toHaveBeenCalledTimes(1);
      expect(controller.handlesSubmit).toBe(true);
      expect(await submit('my draft')).toBe('kept');
      expect(server.conversation).toHaveBeenCalledTimes(2);

      server.discovery = () => failure(409, 'EXT_NO_LIVE_TASK');
      server.conversation.mockImplementation(() => success({ id: BASE.conversationId, runtime: IDLE_RUNTIME }));
      if (trigger === 'reconnect') {
        act(() => {
          for (const listener of reconnect) listener();
        });
        await waitFor(() =>
          expect(getConversationRuntimeViewSnapshot(BASE.conversationId).hasBackendRuntime).toBe(true)
        );
        expect(server.write).not.toHaveBeenCalled();
      }
      expect(await submit('my draft')).toBe('ordinary');
      expect(server.conversation).toHaveBeenCalledTimes(3);
      expect(server.write).not.toHaveBeenCalled();
    }
  );

  it.each(['initial', 'recovery'] as const)(
    'shares the %s GET and preserves a newer host turn over a late idle result',
    async (stage) => {
      resetConversationRuntimeViewStoreForTest();
      const held = hold();
      if (stage === 'recovery') server.conversation.mockReturnValueOnce(failure(503, 'TEMPORARY_FAILURE'));
      server.conversation.mockReturnValueOnce(held.pending);
      server.discovery = () => failure(409, 'EXT_NO_LIVE_TASK');
      render(
        <>
          <RuntimeObserver />
          <RecoveringComposer />
        </>
      );
      await settle();
      let pending!: Promise<RunningInputRoute>;
      act(() => {
        pending = controller.submit('my draft', NO_REFERENCES, TEXT_DRAFT);
      });
      await waitFor(() => expect(server.conversation).toHaveBeenCalledTimes(stage === 'initial' ? 1 : 2));
      act(() => {
        hydrateSucceeded(BASE.conversationId, {
          ...IDLE_RUNTIME,
          state: 'running',
          turn_id: 'new-turn',
          can_send_message: false,
          is_processing: true,
        });
      });
      await act(async () => {
        held.reply(success({ id: BASE.conversationId, runtime: IDLE_RUNTIME }));
        await pending;
      });
      await expect(pending).resolves.toBe('kept');
      expect(getConversationRuntimeViewSnapshot(BASE.conversationId).activeTurnId).toBe('new-turn');
      expect(server.write).not.toHaveBeenCalled();
    }
  );

  it('allows an ordinary send if the idle task disappears between discovery and the native state read', async () => {
    await mount({ host: 'idle', hostTurnId: null });
    server.readState.mockReturnValueOnce(failure(409, 'EXT_NO_LIVE_TASK'));
    expect(await submit('new ordinary prompt')).toBe('ordinary');
    expect(server.write).not.toHaveBeenCalled();
  });

  it('keeps the original draft on a relay write conflict even if rediscovery confirms the idle task is gone', async () => {
    await mount({ host: 'idle', hostTurnId: null });
    server.write.mockImplementation(() => {
      server.discovery = () => failure(409, 'EXT_NO_LIVE_TASK');
      return failure(409, 'EXT_NO_LIVE_TASK');
    });
    expect(await submit('lost turn')).toBe('kept');
    await settle();
    expect(await submit('fresh click')).toBe('ordinary');
    expect(writes()).toEqual([STEER]);
  });

  it('holds the first click during discovery and relays it only after the active native turn is confirmed', async () => {
    const held = hold();
    server.readState.mockReturnValueOnce(held.pending);
    server.write.mockImplementation(({ payload }) => accepted(payload.turnId));
    render(<Harness host='idle' hostTurnId={null} />);
    await waitFor(() => expect(server.readState).toHaveBeenCalledTimes(1));
    expect(controller.handlesSubmit).toBe(true);
    let pending!: Promise<RunningInputRoute>;
    act(() => {
      pending = controller.submit('first click', NO_REFERENCES, TEXT_DRAFT);
    });
    expect(server.write).not.toHaveBeenCalled();
    await act(async () => {
      held.reply(result(server.turn));
      await pending;
    });
    await expect(pending).resolves.toBe('sent');
    expect(writes()).toEqual([STEER]);
  });

  it('rechecks a successfully stopped turn on the next explicit click after the host goes idle', async () => {
    const view = await mount();
    act(() => controller.beginStop()('done'));
    view.rerender(<Harness host='idle' hostTurnId={null} />);
    await settle();
    expect(await submit('too early')).toBe('kept');
    server.turn = { active: false, turnId: null };
    expect(await submit('next prompt')).toBe('ordinary');
    expect(server.write).not.toHaveBeenCalled();
  });

  it('keeps a click when a different host turn starts during native preflight', async () => {
    const view = await mount({ host: 'idle', hostTurnId: null });
    const held = hold();
    server.readState.mockReturnValueOnce(held.pending);
    let submission!: Promise<RunningInputRoute>;
    act(() => {
      submission = controller.submit('from idle', NO_REFERENCES, TEXT_DRAFT);
    });
    await waitFor(() => expect(server.readState).toHaveBeenCalledTimes(2));
    server.turn = { active: false, turnId: null };
    view.rerender(<Harness host='busy' hostTurnId='next-host-turn' />);
    await act(async () => {
      held.reply(result(server.turn));
      await submission;
    });
    await expect(submission).resolves.toBe('kept');
    expect(server.write).not.toHaveBeenCalled();
  });

  it('keeps the send overlapping a failed Stop and accepts a fresh click on the same turn', async () => {
    const held = hold();
    server.write.mockReturnValueOnce(held.pending).mockImplementation(({ payload }) => accepted(payload.turnId));
    await mount();
    let first!: Promise<RunningInputRoute>;
    act(() => {
      first = controller.submit('first', NO_REFERENCES, TEXT_DRAFT);
    });
    await waitFor(() => expect(notices()[0]).toHaveAttribute('data-kind', 'pending'));
    let finishStop!: ReturnType<RunningInputController['beginStop']>;
    act(() => {
      finishStop = controller.beginStop();
    });
    expect(await submit('while pending')).toBe('kept');
    act(() => finishStop('failed'));
    await act(async () => {
      held.reply(accepted('turn-1'));
      await first;
    });
    await expect(first).resolves.toBe('kept');
    expect(notices()[0]).toHaveTextContent('acp.runningInput.queuedStopped');
    expect(await submit('new input')).toBe('sent');
    expect(notices()[1]).toHaveTextContent('acp.runningInput.queued ');
    expect(writes()).toEqual([STEER, STEER]);
  });

  it.each(['text', 'attachment'] as const)('keeps %s when Stop starts before the relay POST', async (kind) => {
    const held = hold();
    server.write.mockImplementation(({ payload }) => accepted(payload.turnId));
    await mount({
      host: kind === 'attachment' ? 'busy' : 'idle',
      hostTurnId: kind === 'attachment' ? 'host-turn-1' : null,
    });
    const reads = server.readState.mock.calls.length;
    if (kind === 'attachment') server.metadata.mockReturnValueOnce(held.pending);
    else server.readState.mockReturnValueOnce(held.pending);

    let route: Promise<RunningInputRoute> | undefined;
    act(() => {
      route = controller.submit(
        'under preparation',
        kind === 'attachment' ? IMAGE_REFERENCE : NO_REFERENCES,
        TEXT_DRAFT
      );
    });
    if (kind === 'attachment') await waitFor(() => expect(server.metadata).toHaveBeenCalledTimes(1));
    else await waitFor(() => expect(server.readState).toHaveBeenCalledTimes(reads + 1));
    act(() => {
      controller.beginStop();
    });
    await act(async () => {
      held.reply(kind === 'attachment' ? success({ path: CONFIRMED_IMAGE, type: 'image/png' }) : result(server.turn));
      await route;
    });
    await expect(route).resolves.toBe('kept');
    expect(server.write).not.toHaveBeenCalled();
  });

  it('keeps preflight sends while the host is busy and the native turn is still idle', async () => {
    server.turn = { active: false, turnId: null };
    await mount();
    expect(await submit('hello')).toBe('kept');
    expect(server.write).not.toHaveBeenCalled();
  });

  it('keeps the draft with a short reason when the turn already ended, then re-reads the state', async () => {
    server.write.mockImplementation(() => result({ accepted: false, reason: 'stale-turn' }));
    await mount();
    const reads = fetchMock.mock.calls.length;

    expect(await submit('late', IMAGE_REFERENCE)).toBe('kept');
    expect(notices()[0]).toHaveAttribute('data-kind', 'rejected');
    expect(notices()[0]).toHaveTextContent('acp.runningInput.reason.staleTurn');
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(reads + 1));
  });

  it('keeps the draft on a 409 binding conflict and never re-posts it', async () => {
    server.write.mockImplementation(() => failure(409, 'EXT_STALE_BINDING'));
    await mount();

    expect(await submit('hello')).toBe('kept');
    expect(notices()[0]).toHaveTextContent('acp.runningInput.reason.sessionChanged');
    await act(async () => {});
    expect(writes()).toEqual([STEER]);
  });

  it('uses follow-up when the host does not advertise steer', async () => {
    server.discovery = () => success({ version: 1, bindingId: 'binding-1', requests: [STATE, FOLLOW_UP] });
    server.write.mockImplementation(({ payload }) => accepted(payload.turnId));
    await mount();
    expect(controller.mode).toBe('follow-up');
    expect(await submit('use the advertised mode')).toBe('sent');
    expect(writes()).toEqual([FOLLOW_UP]);
  });

  it.each([
    { type: 'image/png', file: 'input.png', imageHint: true },
    { type: 'application/octet-stream', file: 'input.heic', imageHint: false },
  ])('keeps text and original path sends with the default gate for $file', async ({ type, file, imageHint }) => {
    server.discovery = () =>
      success({
        version: 1,
        bindingId: 'binding-1',
        hostBytes: true,
        requests: [...ALL_METHODS, IMAGE_STATE, STEER_IMAGES],
      });
    server.write.mockImplementation(({ method, payload }) =>
      method === IMAGE_STATE
        ? result({ status: 'unavailable', available: false, reason: 'model-unverified', turnId: 'turn-1' })
        : accepted(payload.turnId)
    );
    const original = { kind: 'upload', path: '/client/' + file } as const;
    const resolved = '/host/private/' + file;
    server.metadata.mockReturnValueOnce(success({ path: resolved, type }));
    const prepare = vi.spyOn(runningImages, 'createImagePreparation');
    await mount();

    expect(await submit('plain text')).toBe('sent');
    expect(await submit('', { files: [original], sessions: [] })).toBe('sent');
    expect(server.metadata).toHaveBeenCalledExactlyOnceWith(original);
    expect(server.write.mock.calls.map(([call]) => [call.method, call.payload.message])).toEqual([
      [STEER, 'plain text'],
      [STEER, '\n\n[[AION_FILES]]\n' + resolved],
    ]);
    expect(controller.images).toMatchObject({ modes: [], receipts: [] });
    expect(Message.info).toHaveBeenCalledTimes(imageHint ? 1 : 0);
    if (imageHint) expect(Message.info).toHaveBeenCalledWith('acp.runningInput.imagesAsPaths');
    expect(prepare).not.toHaveBeenCalled();
  });

  it('waits for explicit path-only input on a text-only model and resolves its original ref', async () => {
    server.discovery = () =>
      success({
        version: 1,
        bindingId: 'binding-1',
        hostBytes: true,
        requests: [...ALL_METHODS, IMAGE_STATE, STEER_IMAGES],
      });
    server.write.mockImplementation(({ method, payload }) =>
      method === IMAGE_STATE
        ? result({ status: 'unavailable', available: false, reason: 'model-text-only', turnId: 'turn-1' })
        : accepted(payload.turnId)
    );
    await mount({ enablePixels: true });
    expect(await submit('', IMAGE_REFERENCE)).toBe('kept');
    expect(controller.images.submission).toMatchObject({
      status: 'blocked',
      reason: 'model-text-only',
      allowPathOnly: true,
    });
    expect(writes().every((method) => method === IMAGE_STATE)).toBe(true);

    await act(async () => {
      expect(await controller.images.submitPaths('', IMAGE_REFERENCE, TEXT_DRAFT)).toBe('sent');
    });
    expect(server.metadata.mock.calls.map(([ref]) => ref)).toEqual([
      IMAGE_REFERENCE.files[0],
      IMAGE_REFERENCE.files[0],
    ]);
    expect(server.write.mock.calls.at(-1)?.[0]).toMatchObject({
      method: STEER,
      payload: { message: expect.stringContaining(CONFIRMED_IMAGE), turnId: 'turn-1' },
    });
  });

  /** A vision turn whose image write answer comes from `steerImages`. */
  function offerVisionTurn(
    steerImages: () => Response | Promise<Response>,
    { lookup, rawBytes = 6 << 20 }: { lookup?: () => Response; rawBytes?: number } = {}
  ) {
    server.discovery = () =>
      success({
        version: 1,
        bindingId: 'binding-1',
        hostBytes: true,
        requests: [...ALL_METHODS, IMAGE_STATE, STEER_IMAGES],
      });
    server.write.mockImplementation(({ method, payload }) => {
      if (method === IMAGE_STATE)
        return result({
          available: true,
          model: 'fixture/vision',
          turnId: server.turn.turnId,
          remaining: { count: 4, rawBytes, imageBytes: 3_750_000, sidePixels: 8000, nativeLineBytes: 8 << 20 },
        });
      if (method === STEER_IMAGES) return steerImages();
      if (method === LOOKUP && lookup) return lookup();
      return accepted(payload.turnId);
    });
  }

  async function mountVisionTurn(steerImages: () => Response | Promise<Response>, lookup?: () => Response) {
    offerVisionTurn(steerImages, { lookup });
    const digest = { sha256: 'b'.repeat(64), algorithm: 'js', elapsedMs: 0 } as const;
    const size = { width: 64, height: 1, bytes: 64, digest };
    vi.spyOn(runningImages, 'createImagePreparation').mockImplementation(({ requestId }) => ({
      prepare: async () => ({
        requestId: requestId!,
        prepareId: requestId!,
        recipeVersion: 1,
        images: [
          {
            ref: IMAGE_REFERENCE.files[0],
            original: size,
            sent: { ...size, mime: 'image/png' },
            preview: { kind: 'icon', dimensions: size },
            changed: false,
            orientationOnly: false,
            secureContext: false,
            plannedBytes: 64,
            codecMs: 0,
          },
        ],
        estimatedLineBytes: (8 << 20) + 1,
        codecMs: 0,
      }),
      dispose() {},
    }));
    const fetchHost = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url, init) =>
      url.endsWith('/byte-grants')
        ? Promise.resolve(
            success({ expiresInMs: 60_000, grants: [{ id: 'grant', byteLength: 64, sha256: digest.sha256 }] })
          )
        : fetchHost(url, init)
    );
    await mount({ enablePixels: true });
  }

  it.each([-1, 0, 1])('enforces the raw submission limit at 6 MiB with a %i-byte offset', async (offset) => {
    const totalBytes = 6 * 1024 * 1024 + offset;
    const sizes = [3_000_000, totalBytes - 3_000_000];
    const files = [
      { kind: 'upload', path: '/client/first.png' },
      { kind: 'upload', path: '/client/second.png' },
    ] as const;
    const header = { mime: 'image/png', width: 64, height: 1, orientation: 1 } as const;
    const digest = { sha256: 'b'.repeat(64), algorithm: 'js', elapsedMs: 0 } as const;

    // Price raw bytes 1:1 at both JSONL budget checks so only the raw total can bind.
    vi.spyOn(imageBudget, 'base64Bytes').mockImplementation((bytes) => bytes);
    vi.spyOn(imageBudget, 'nativeLineBytes').mockImplementation(
      (line, sizes) => new TextEncoder().encode(line).length + sizes.reduce((sum, bytes) => sum + bytes, 0)
    );
    const read = vi.spyOn(imageTransfer, 'readReferencedImage');
    for (const bytes of sizes) read.mockResolvedValueOnce(new Blob([new Uint8Array(bytes + 1)], { type: header.mime }));
    // Return both derivatives even when their combined size exceeds the preparation budget.
    vi.spyOn(imageWorker, 'runImageWorker').mockImplementation(async ({ kind, source }) => ({
      elapsedMs: 0,
      result:
        kind === 'inspect'
          ? { kind: 'inspected', header }
          : {
              kind: 'encoded',
              result: {
                output: source.slice(0, -1, header.mime),
                originalDigest: digest,
                outputDigest: digest,
                dimensions: header,
                changed: true,
                secureContext: false,
                plannedBytes: 64,
              },
            },
    }));
    const upload = vi
      .spyOn(imageTransfer, 'uploadPreparedImage')
      .mockResolvedValueOnce(files[0])
      .mockResolvedValueOnce(files[1]);
    const grant = vi.fn(() =>
      success({
        expiresInMs: 60_000,
        grants: sizes.map((byteLength, index) => ({
          id: `grant-${index}`,
          byteLength,
          sha256: digest.sha256,
        })),
      })
    );
    offerVisionTurn(
      () =>
        result({
          accepted: true,
          delivery: 'native-queue',
          turnId: 'turn-1',
          inputKind: 'pixels',
          captionAdded: false,
        }),
      { rawBytes: 7 << 20 }
    );
    const fetchHost = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url, init) => (url.endsWith('/byte-grants') ? grant() : fetchHost(url, init)));
    await mount({ enablePixels: true });

    const route = await submit('caption', { files, sessions: [] });
    if (offset > 0) {
      expect(route).toBe('kept');
      const notice = screen.getByTestId('running-image-submission');
      expect(notice.getAttribute('data-reason')).toBe('limits');
      expect(notice.textContent).toContain('acp.runningInput.images.reason.limits');
      expect(upload).not.toHaveBeenCalled();
      expect(grant).not.toHaveBeenCalled();
      expect(writes().filter((method) => method !== IMAGE_STATE)).toEqual([]);
    } else {
      expect(route).toBe('sent');
      expect(controller.images.receipts[0].receipt.pixels?.images.map(({ sent }) => sent.bytes)).toEqual(sizes);
      expect(writes().filter((method) => method !== IMAGE_STATE)).toEqual([STEER_IMAGES]);
    }
  });

  async function expectPathOnlyAfter(reason: string) {
    const [{ receipt }] = controller.images.receipts;
    expect(receipt).toMatchObject({ status: 'rejected', reason });
    expect(controller.images.submission).toMatchObject({
      requestId: receipt.requestId,
      status: 'blocked',
      reason,
      allowPathOnly: true,
      batch: { estimatedLineBytes: (8 << 20) + 1 },
    });
    await act(async () => {
      expect(await controller.images.submitPaths('caption', IMAGE_REFERENCE, TEXT_DRAFT)).toBe('sent');
    });
    expect(server.write.mock.calls.at(-1)?.[0]).toMatchObject({
      method: STEER,
      payload: { message: expect.stringContaining(CONFIRMED_IMAGE), turnId: 'turn-1' },
    });
    expect(writes().filter((method) => method === STEER_IMAGES)).toHaveLength(1);
  }

  it.each([
    ['native-line-limit', true],
    ['provider-body-limit', true],
    ['stale-turn', false],
  ] as const)('turns an ACP %s rejection into a path-only choice when it applies', async (reason, pathOnly) => {
    await mountVisionTurn(() => result({ accepted: false, reason }));
    expect(await submit('caption', IMAGE_REFERENCE)).toBe('kept');
    expect(writes().filter((method) => method !== IMAGE_STATE)).toEqual([STEER_IMAGES]);
    if (pathOnly) await expectPathOnlyAfter(reason);
    else {
      expect(controller.images.receipts[0].receipt).toMatchObject({ status: 'rejected', reason });
      expect(controller.images.submission).toBeUndefined();
    }
  });

  it('offers the same path-only choice when the original-key lookup confirms the rejection', async () => {
    await mountVisionTurn(
      () => {
        throw new DOMException('Timeout', 'TimeoutError');
      },
      () => result({ status: 'completed', result: { accepted: false, reason: 'native-line-limit' } })
    );
    expect(await submit('caption', IMAGE_REFERENCE)).toBe('kept');
    expect(controller.images.receipts[0].receipt.status).toBe('unknown');
    expect(controller.images.submission).toBeUndefined();
    await act(async () => {
      fireEvent.click(screen.getByText('acp.runningInput.images.checkResult'));
    });
    expect(writes().filter((method) => method !== IMAGE_STATE)).toEqual([STEER_IMAGES, LOOKUP]);
    await expectPathOnlyAfter('native-line-limit');
  });

  it('settles only the older receipt when its lookup lands after a newer unknown send', async () => {
    await mountVisionTurn(
      () => {
        throw new DOMException('Timeout', 'TimeoutError');
      },
      () => result({ status: 'completed', result: { accepted: false, reason: 'native-line-limit' } })
    );
    // A: the rejection reply is lost.
    expect(await submit('caption', IMAGE_REFERENCE)).toBe('kept');
    // B: the same draft again; the native queue takes it, but this reply is lost too.
    expect(await submit('caption', IMAGE_REFERENCE)).toBe('kept');
    const [older, newer] = controller.images.receipts.map(({ receipt }) => receipt);
    expect([older.status, newer.status]).toEqual(['unknown', 'unknown']);

    await act(async () => {
      await controller.check(older.requestId);
    });
    expect(controller.images.receipts.map(({ receipt }) => receipt)).toMatchObject([
      { requestId: older.requestId, status: 'rejected', reason: 'native-line-limit' },
      { requestId: newer.requestId, status: 'unknown' },
    ]);
    expect(controller.images.submission).toBeUndefined();
    expect(screen.queryByText('acp.runningInput.images.sendPaths')).toBeNull();
    expect(writes().filter((method) => method === STEER)).toEqual([]);
  });

  it.each(['dismiss-all', 'lookup-after-dismiss'] as const)(
    'does not resurrect a dismissed request when its rejection arrives (%s)',
    async (variant) => {
      const reply = hold();
      await mountVisionTurn(
        () => (variant === 'dismiss-all' ? reply.pending : Promise.reject(new DOMException('Timeout', 'TimeoutError'))),
        () => result({ status: 'completed', result: { accepted: false, reason: 'native-line-limit' } })
      );
      let route: Promise<RunningInputRoute> | undefined;
      act(() => {
        route = controller.submit('caption', IMAGE_REFERENCE, TEXT_DRAFT);
      });
      await waitFor(() =>
        expect(controller.images.receipts[0]?.receipt.status).toBe(variant === 'dismiss-all' ? 'pending' : 'unknown')
      );
      const { requestId } = controller.images.receipts[0].receipt;
      if (variant === 'dismiss-all') {
        // The pending row has no close button; "dismiss all" clears it.
        act(() => controller.dismiss());
        await act(async () => {
          reply.reply(result({ accepted: false, reason: 'native-line-limit' }));
          expect(await route).toBe('kept');
        });
      } else {
        await act(async () => {
          await route;
        });
        const check = controller.check;
        act(() => controller.dismiss([requestId]));
        await act(async () => {
          await check(requestId);
        });
      }
      expect(controller.images.receipts).toEqual([]);
      expect(controller.images.submission).toBeUndefined();
      expect(screen.queryByTestId('running-image-submission')).toBeNull();
    }
  );

  it.each(['binding', 'turn', 'mode'] as const)(
    'keeps a path-only click on its original target if reconnect changes the %s',
    async (change) => {
      const reconnect = new Set<() => void>();
      vi.mocked(httpBridge.wsEmitter).mockImplementation((event) => ({
        on(listener) {
          if (event === 'realtime.reconnected') reconnect.add(listener);
          return () => reconnect.delete(listener);
        },
        emit: () => {},
      }));
      const offer = (bindingId: string, requests: string[]) =>
        success({ version: 1, bindingId, hostBytes: true, requests });
      server.discovery = () => offer('binding-1', [...ALL_METHODS, IMAGE_STATE, STEER_IMAGES]);
      server.write.mockImplementation(({ method, payload }) =>
        method === IMAGE_STATE
          ? result({ status: 'unavailable', available: false, reason: 'model-text-only', turnId: server.turn.turnId })
          : accepted(payload.turnId)
      );
      await mount({ enablePixels: true });
      expect(await submit('', IMAGE_REFERENCE)).toBe('kept');

      const discovery = hold();
      server.discovery = () => discovery.pending;
      act(() => {
        for (const listener of reconnect) listener();
      });
      let pathOnly: Promise<RunningInputRoute> | undefined;
      act(() => {
        pathOnly = controller.images.submitPaths('', IMAGE_REFERENCE, TEXT_DRAFT);
      });
      if (change === 'turn') server.turn = { active: true, turnId: 'turn-2' };
      server.discovery = () =>
        offer(change === 'binding' ? 'binding-2' : 'binding-1', change === 'mode' ? [STATE, FOLLOW_UP] : ALL_METHODS);
      await act(async () => {
        discovery.reply(await server.discovery());
        expect(await pathOnly).toBe('kept');
      });
      expect(writes().every((method) => method === IMAGE_STATE)).toBe(true);
      expect(server.metadata).toHaveBeenCalledTimes(1);
    }
  );

  it('publishes reference preparation and aborts both pending private reads on cancel', async () => {
    server.discovery = () =>
      success({
        version: 1,
        bindingId: 'binding-1',
        hostBytes: true,
        requests: [...ALL_METHODS, IMAGE_STATE, STEER_IMAGES],
      });
    server.write.mockImplementation(() => result({ available: false, reason: 'model-text-only', turnId: 'turn-1' }));
    const dispatch = fetchMock.getMockImplementation()!;
    const signals = new Map<string, AbortSignal>();
    fetchMock.mockImplementation((url, init) => {
      if (url !== '/api/fs/content/metadata' && url !== '/api/conversations/same') return dispatch(url, init);
      const signal = init.signal!;
      signals.set(url, signal);
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    });
    await mount({ enablePixels: true });
    let click: Promise<RunningInputRoute> | undefined;
    act(() => {
      click = controller.submit('snapshot', { ...IMAGE_REFERENCE, sessions: [{ id: 'same' }] }, TEXT_DRAFT);
    });
    await waitFor(() => expect(signals.size).toBe(2));
    expect(controller.images.submission).toMatchObject({
      bindingId: 'binding-1',
      turnId: 'turn-1',
      mode: 'steer',
      status: 'preparing',
      stage: 'references',
      fileCount: 1,
    });
    await act(async () => {
      controller.images.cancelPreparation();
      expect(await click).toBe('kept');
    });
    expect([...signals.values()].every((signal) => signal.aborted)).toBe(true);
    expect(controller.images.submission).toMatchObject({ status: 'blocked', reason: 'cancelled' });
    expect(writes().every((method) => method === IMAGE_STATE)).toBe(true);
  });

  it.each(['cancel', 'replace-draft', 'decorations'] as const)(
    'aborts image reference preparation on %s before handoff',
    async (action) => {
      server.discovery = () =>
        success({
          version: 1,
          bindingId: 'binding-1',
          hostBytes: true,
          requests: [...ALL_METHODS, IMAGE_STATE, STEER_IMAGES],
        });
      server.write.mockImplementation(() =>
        result({
          status: 'unavailable',
          available: false,
          reason: 'model-unverified',
          turnId: 'turn-1',
        })
      );
      const firstDraft = {};
      const decorations = new AbortController();
      const view = await mount({ draftVersion: firstDraft, enablePixels: true });
      const metadata = hold();
      server.metadata.mockReturnValueOnce(metadata.pending);
      let submission: Promise<RunningInputRoute> | undefined;
      act(() => {
        submission = controller.submit('snapshot', IMAGE_REFERENCE, {
          ...TEXT_DRAFT,
          decorationSignal: decorations.signal,
        });
      });
      await waitFor(() => expect(server.metadata).toHaveBeenCalledTimes(1));
      if (action === 'cancel') act(() => controller.images.cancelPreparation());
      else if (action === 'replace-draft') view.rerender(<Harness draftVersion={{}} enablePixels />);
      else act(() => decorations.abort());
      await act(async () => {
        metadata.reply(success({ path: CONFIRMED_IMAGE, type: 'image/png' }));
        expect(await submission).toBe('kept');
      });
      expect(writes().every((method) => method === IMAGE_STATE)).toBe(true);
    }
  );

  it.each(referencesFixture)('matches the host text format for $name', async (fixture) => {
    for (const path of fixture.paths) {
      server.metadata.mockReturnValueOnce(success({ path, type: fixture.image ? 'image/png' : 'text/plain' }));
    }
    server.write.mockImplementation(({ payload }) => accepted(payload.turnId));
    await mount();

    const files: RunningInputReferences['files'] =
      fixture.paths.length === 2
        ? [
            { kind: 'project', pe_id: 'pe', relative_path: 'raw folder' },
            { kind: 'local', path: '/picked/file.txt' },
          ]
        : fixture.paths.map(() => ({ kind: 'upload', path: '/selected/upload.png' }));
    expect(await submit(fixture.message, { files, sessions: fixture.sessions.map((id) => ({ id })) })).toBe('sent');
    expect(server.write.mock.calls[0][0]).toMatchObject({ method: STEER, payload: { message: fixture.expected } });
    if (fixture.image) expect(Message.info).toHaveBeenCalledWith('acp.runningInput.imagesAsPaths');
  });

  it('keeps slash commands with references out of preparation and the relay', async () => {
    await mount();
    expect(
      await controller.submit('> quoted\n\n/compact', IMAGE_REFERENCE, { slashCommand: true, hasQuote: true })
    ).toBe('kept');
    expect(server.metadata).not.toHaveBeenCalled();
    expect(server.write).not.toHaveBeenCalled();
  });

  it.each([403, 404])('keeps every reference when one lookup is denied with %s', async (status) => {
    server.mentionable.mockReturnValueOnce(failure(status, 'NOT_FOUND'));
    await mount();

    expect(await submit('keep these', { ...IMAGE_REFERENCE, sessions: [{ id: 'same' }] })).toBe('kept');
    expect(server.metadata).toHaveBeenCalledTimes(1);
    expect(server.write).not.toHaveBeenCalled();
    expect(Message.warning).toHaveBeenCalledWith('acp.runningInput.referencesUnverified');
  });

  it('keeps the draft when a reference is no longer mentionable', async () => {
    server.mentionable.mockReturnValueOnce(success({ items: [] }));
    await mount();
    expect(await submit('', { files: [], sessions: [{ id: 'deleted' }] })).toBe('kept');
    expect(server.write).not.toHaveBeenCalled();
  });

  it('rejects an unrepresentable path from metadata rather than changing it into another file name', async () => {
    server.metadata.mockReturnValueOnce(success({ path: '/host/file\n/other', type: 'text/plain' }));
    await mount();
    expect(await submit('keep the file', IMAGE_REFERENCE)).toBe('kept');
    expect(server.write).not.toHaveBeenCalled();
  });

  it('keeps the draft when a metadata POST times out or would require reauthentication', async () => {
    server.metadata.mockImplementationOnce(() => {
      throw new DOMException('Private failure', 'TimeoutError');
    });
    server.metadata.mockReturnValueOnce(failure(401, 'AUTH_REQUIRED'));
    await mount();
    expect(await submit('', IMAGE_REFERENCE)).toBe('kept');
    expect(await submit('', IMAGE_REFERENCE)).toBe('kept');
    expect(server.metadata).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.some(([url]) => url === '/api/auth/refresh')).toBe(false);
    expect(server.write).not.toHaveBeenCalled();
  });

  it('omits private lookup bodies and errors from renderer diagnostics', async () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const secretPath = '/private/running-input-file.png';
    server.metadata.mockReturnValueOnce(Response.json({ error: secretPath }, { status: 404 }));
    await mount();
    expect(await submit('', { files: [{ kind: 'local', path: secretPath }], sessions: [] })).toBe('kept');
    expect(JSON.stringify([...debug.mock.calls, ...error.mock.calls])).not.toContain(secretPath);
    expect(server.write).not.toHaveBeenCalled();
  });

  it.each(['binding', 'turn'] as const)(
    'retains the draft if the %s changes during reference preparation',
    async (changed) => {
      const pending = hold();
      server.metadata.mockReturnValueOnce(pending.pending);
      await mount();
      let submission: Promise<RunningInputRoute> | undefined;
      act(() => {
        submission = controller.submit('original', IMAGE_REFERENCE, TEXT_DRAFT);
      });
      await waitFor(() => expect(server.metadata).toHaveBeenCalledTimes(1));
      if (changed === 'binding') {
        server.discovery = () => success({ version: 1, bindingId: 'binding-2', requests: ALL_METHODS });
      } else {
        server.turn = { active: true, turnId: 'turn-2' };
      }
      await act(async () => {
        pending.reply(success({ path: CONFIRMED_IMAGE, type: 'image/png' }));
        await submission;
      });
      await expect(submission).resolves.toBe('kept');
      expect(server.write).not.toHaveBeenCalled();
      expect(Message.warning).toHaveBeenCalledWith('acp.runningInput.preparationChanged');
    }
  );

  it('reports the serialized size limit before writing any input', async () => {
    await mount();
    expect(await submit('한'.repeat(22_000), IMAGE_REFERENCE)).toBe('kept');
    expect(server.write).not.toHaveBeenCalled();
    expect(Message.warning).toHaveBeenCalledWith('acp.runningInput.inputTooLarge');
  });

  it('checks for a lost attachment send on the original request with the draft intact', async () => {
    server.write.mockImplementation(({ method }) => {
      if (method === LOOKUP) return result({ status: 'unavailable' });
      throw new DOMException('Timeout', 'TimeoutError');
    });
    await mount();
    expect(await submit('with attachment', IMAGE_REFERENCE)).toBe('kept');
    expect(notices()[0]).toHaveAttribute('data-kind', 'unknown');
    await act(async () => {
      fireEvent.click(screen.getByText('acp.runningInput.check'));
    });
    expect(writes()).toEqual([STEER, LOOKUP]);
    expect(server.write.mock.calls[1][0].payload.requestId).toBe(server.write.mock.calls[0][0].payload.requestId);
  });

  it('keeps a late acceptance on its original turn after that turn ends', async () => {
    const held = hold();
    server.write.mockReturnValueOnce(held.pending);
    const view = await mount();

    let route: Promise<RunningInputRoute> | undefined;
    act(() => {
      route = controller.submit('late', NO_REFERENCES, TEXT_DRAFT);
    });
    await waitFor(() => expect(notices()[0]).toHaveAttribute('data-kind', 'pending'));

    server.turn = { active: false, turnId: null };
    view.rerender(<Harness host='idle' hostTurnId={null} />);
    await waitFor(() => expect(controller.available).toBe(false));
    await act(async () => {
      held.reply(accepted('turn-1'));
      await route;
    });

    expect(notices()).toHaveLength(1);
    await expect(route).resolves.toBe('kept');
    expect(notices()[0]).toHaveTextContent('acp.runningInput.queuedEnded');
  });

  it.each([
    {
      label: 'normal discovery on another ACP turn',
      discovery: 'ready',
      newHost: true,
      nextBinding: 'binding-1',
      nextTurn: 'turn-2',
      phase: 'ended',
    },
    {
      label: 'normal discovery on a new binding with a reused turn ID',
      discovery: 'ready',
      newHost: true,
      nextBinding: 'binding-2',
      nextTurn: 'turn-1',
      phase: 'ended',
    },
    {
      label: 'normal discovery on a new binding and turn',
      discovery: 'ready',
      newHost: true,
      nextBinding: 'binding-2',
      nextTurn: 'turn-2',
      phase: 'ended',
    },
    {
      label: 'normal discovery after a Host turn change with the same ACP tuple',
      discovery: 'ready',
      newHost: true,
      nextBinding: 'binding-1',
      nextTurn: 'turn-1',
      phase: 'ended',
    },
    {
      label: 'normal discovery on the original Host and ACP turn',
      discovery: 'ready',
      newHost: false,
      nextBinding: 'binding-1',
      nextTurn: 'turn-1',
      phase: 'stopped',
    },
    {
      label: 'pending discovery after a Host turn change',
      discovery: 'pending',
      newHost: true,
      nextBinding: 'binding-2',
      nextTurn: 'turn-2',
      phase: 'ended',
    },
    {
      label: 'pending discovery on the original Host turn',
      discovery: 'pending',
      newHost: false,
      nextBinding: 'binding-1',
      nextTurn: 'turn-1',
      phase: 'stop-unconfirmed',
    },
    {
      label: 'failed discovery on the original Host turn',
      discovery: 'failed',
      newHost: false,
      nextBinding: 'binding-1',
      nextTurn: 'turn-1',
      phase: 'stop-unconfirmed',
    },
  ])(
    'attributes Stop on a late image ACK with $label',
    async ({ discovery, newHost, nextBinding, nextTurn, phase }) => {
      const held = hold();
      const offer = (bindingId: string) =>
        success({ version: 1, bindingId, hostBytes: true, requests: [...ALL_METHODS, IMAGE_STATE, STEER_IMAGES] });
      server.discovery = () => offer('binding-1');
      server.write.mockImplementation(({ method }) =>
        method === IMAGE_STATE
          ? result({
              available: true,
              model: 'fixture/vision',
              turnId: server.turn.turnId,
              remaining: {
                count: 4,
                rawBytes: 6 << 20,
                imageBytes: 3_750_000,
                sidePixels: 8000,
                nativeLineBytes: 8 << 20,
              },
            })
          : held.pending
      );
      const digest = { sha256: 'a'.repeat(64), algorithm: 'js', elapsedMs: 0 } as const;
      const size = { width: 1, height: 1, bytes: 64, digest };
      vi.spyOn(runningImages, 'createImagePreparation').mockImplementation(({ requestId }) => ({
        prepare: async () => ({
          requestId: requestId!,
          prepareId: requestId!,
          recipeVersion: 1,
          images: [
            {
              ref: IMAGE_REFERENCE.files[0],
              original: size,
              sent: { ...size, mime: 'image/png' },
              preview: { kind: 'icon', dimensions: size },
              changed: false,
              orientationOnly: false,
              secureContext: false,
              plannedBytes: 64,
              codecMs: 0,
            },
          ],
          estimatedLineBytes: 256,
          codecMs: 0,
        }),
        dispose() {},
      }));
      const fetchHost = fetchMock.getMockImplementation()!;
      fetchMock.mockImplementation((url, init) =>
        url.endsWith('/byte-grants')
          ? Promise.resolve(
              success({ expiresInMs: 60_000, grants: [{ id: 'grant', byteLength: 64, sha256: digest.sha256 }] })
            )
          : fetchHost(url, init)
      );

      const reconnect = new Set<() => void>();
      vi.mocked(httpBridge.wsEmitter).mockImplementation((event) => ({
        on(listener) {
          if (event === 'realtime.reconnected') reconnect.add(listener);
          return () => reconnect.delete(listener);
        },
        emit: () => {},
      }));
      const view = await mount({ enablePixels: true });
      let route: Promise<RunningInputRoute> | undefined;
      act(() => {
        route = controller.submit('late pixels', IMAGE_REFERENCE, TEXT_DRAFT);
      });
      await waitFor(() => expect(controller.images.receipts[0]?.receipt.status).toBe('pending'));
      const { requestId, bindingId, turnId, hostTurnId } = controller.images.receipts[0].receipt;
      expect(hostTurnId).toBe('host-turn-1');

      const heldDiscovery = hold();
      const readDiscovery = vi.fn(() => {
        if (discovery === 'pending') return heldDiscovery.pending;
        return discovery === 'failed' ? failure(503, 'EXT_UNAVAILABLE') : offer(nextBinding);
      });
      server.discovery = readDiscovery;
      server.turn = { active: true, turnId: nextTurn };
      const stopHostTurnId = newHost ? 'host-turn-2' : 'host-turn-1';
      if (newHost) view.rerender(<Harness hostTurnId={stopHostTurnId} enablePixels />);
      else
        act(() => {
          for (const listener of reconnect) listener();
        });
      await waitFor(() => expect(readDiscovery).toHaveBeenCalled());
      if (discovery !== 'pending') await settle();

      act(() => controller.beginStop(stopHostTurnId)('done'));
      await act(async () => {
        held.reply(
          result({ accepted: true, delivery: 'native-queue', turnId, inputKind: 'pixels', captionAdded: false })
        );
      });
      if (discovery === 'pending') {
        expect(controller.images.receipts[0]?.receipt.status).toBe('pending');
        await act(async () => {
          heldDiscovery.reply(offer(nextBinding));
          await route;
        });
      } else {
        await expect(route).resolves.toBe('kept');
      }

      expect(controller.images.receipts).toMatchObject([
        { phase, receipt: { requestId, bindingId, turnId, hostTurnId, status: 'queued' } },
      ]);
      expect(notices()[0]).toHaveTextContent(
        phase === 'ended' ? 'acp.runningInput.images.queuedEnded' : 'acp.runningInput.images.queuedStopped'
      );
      expect(writes().filter((method) => method !== IMAGE_STATE)).toEqual([STEER_IMAGES]);
    }
  );

  it('keeps the submitted draft when Stop precedes the receipt and the native turn is still active', async () => {
    const held = hold();
    server.write.mockReturnValueOnce(held.pending);
    await mount();

    let route: Promise<RunningInputRoute> | undefined;
    act(() => {
      route = controller.submit('withdrawn', IMAGE_REFERENCE, TEXT_DRAFT);
    });
    await waitFor(() => expect(notices()[0]).toHaveAttribute('data-kind', 'pending'));
    act(() => {
      controller.beginStop();
    });

    await act(async () => {
      held.reply(accepted('turn-1'));
      await route;
    });

    await expect(route).resolves.toBe('kept');
    expect(notices()[0]).toHaveTextContent('acp.runningInput.queuedStopped');
    expect(writes()).toEqual([STEER]);
  });

  it('dismisses one notice or all notices', async () => {
    server.write
      .mockImplementationOnce(({ payload }) => accepted(payload.turnId))
      .mockImplementationOnce(() => result({ accepted: false, reason: 'dedup-capacity' }))
      .mockImplementationOnce(() => failure(429, 'EXT_RATE_LIMITED'));
    await mount();
    await submit('one');
    await submit('two');
    await submit('three');
    expect(notices()).toHaveLength(3);

    fireEvent.click(screen.getAllByLabelText('acp.runningInput.dismiss')[0]);
    expect(notices()).toHaveLength(2);
    fireEvent.click(screen.getByText('acp.runningInput.dismissAll'));
    expect(notices()).toHaveLength(0);
  });

  it('checks an unknown result on its original key and refreshes history when the result is gone', async () => {
    fetchMock.mockImplementation(async (_url, init) => {
      if (init.method === 'GET') return server.discovery();
      const call = JSON.parse(String(init.body)) as Write;
      if (call.method === STATE) return result(server.turn);
      if (call.method === LOOKUP) return result({ status: 'unavailable' });
      throw new Error('connection reset');
    });
    await mount();

    expect(await submit('hello')).toBe('kept');
    expect(notices()[0]).toHaveAttribute('data-kind', 'unknown');
    await act(async () => {
      fireEvent.click(screen.getByText('acp.runningInput.check'));
    });
    await waitFor(() => expect(emitter.emit).toHaveBeenCalledWith('chat.history.refresh'));
    expect(Message.info).toHaveBeenCalledWith('acp.runningInput.checkUnconfirmed');
    const posted = fetchMock.mock.calls.filter(([, init]) => init.method === 'POST');
    const methods = posted.map(([, init]) => (JSON.parse(String(init.body)) as Write).method);
    expect(methods.filter((method) => method === STEER || method === FOLLOW_UP)).toHaveLength(1);
  });

  it('stays off for disabled composers and while sending is paused', async () => {
    const view = await mount({ enabled: false });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(controller.handlesSubmit).toBe(false);

    view.rerender(<Harness paused />);
    await waitFor(() => expect(controller.handlesSubmit).toBe(true));
    expect(controller.available).toBe(false);
    expect(await submit('hello')).toBe('kept');
  });
});
