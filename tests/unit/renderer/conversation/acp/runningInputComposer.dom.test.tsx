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
import type { UseRunningInputOptions } from '@/renderer/pages/conversation/runtime/RunningInput/useRunningInput';
import { emitter } from '@/renderer/utils/emitter';
import type { RunningInputReferences } from '@/renderer/services/runtime/RunningInput';
import referencesFixture from './runningInputReferences.fixture.json';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, string>) => (options ? `${key} ${JSON.stringify(options)}` : key),
  }),
}));

const PREFIX = '_aelix/session/';
const STATE = PREFIX + 'input/state';
const STEER = PREFIX + 'input/steer';
const FOLLOW_UP = PREFIX + 'input/follow-up';
const LOOKUP = PREFIX + 'requests/lookup';
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
  discovery: (): Response => success({ version: 1, bindingId: 'binding-1', notifications: [], requests: ALL_METHODS }),
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
      />
    </>
  );
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
