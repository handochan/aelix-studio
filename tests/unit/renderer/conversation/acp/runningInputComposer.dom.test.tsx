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

const success = (data: unknown) => Response.json({ success: true, data });
const result = (value: unknown) => success({ result: value });
const failure = (status: number, code: string) => Response.json({ success: false, code, error: 'x' }, { status });
const accepted = (turnId: string) => result({ turnId, accepted: true, delivery: 'native-queue' });

type Turn = { active: true; turnId: string } | { active: false; turnId: null };
type Write = { method: string; payload: Record<string, string> };

const server = {
  discovery: (): Response => success({ version: 1, bindingId: 'binding-1', notifications: [], requests: ALL_METHODS }),
  turn: { active: true, turnId: 'turn-1' } as Turn,
  write: vi.fn<(call: Write) => Response | Promise<Response>>(),
};
const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>();
const writes = () => server.write.mock.calls.map(([call]) => call.method);

let controller: RunningInputController;
const BASE: UseRunningInputOptions = {
  conversationId: 'conv-1',
  enabled: true,
  hostBusy: true,
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

async function submit(message: string, hasAttachments = false): Promise<RunningInputRoute> {
  let route: RunningInputRoute = 'ordinary';
  await act(async () => {
    route = await controller.submit(message, hasAttachments);
  });
  return route;
}

const notices = () => screen.queryAllByTestId('running-input-notice');

describe('running input in the composer', () => {
  beforeEach(() => {
    server.turn = { active: true, turnId: 'turn-1' };
    server.discovery = () => success({ version: 1, bindingId: 'binding-1', notifications: [], requests: ALL_METHODS });
    server.write.mockReset();
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (_url, init) => {
      if (init.method === 'GET') return server.discovery();
      const call = JSON.parse(String(init.body)) as Write;
      return call.method === STATE ? result(server.turn) : server.write(call);
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
    await mount();

    expect(controller).toMatchObject({ supported: false, available: false });
    expect(screen.queryByTestId('running-input-mode')).toBeNull();
    expect(await submit('hello')).toBe('ordinary');
    expect(fetchMock.mock.calls.every(([, init]) => init.method === 'GET')).toBe(true);
  });

  it('defaults to follow-up, clears the draft only on queue acceptance, and groups the turn without counts', async () => {
    server.write.mockImplementation(({ payload }) => accepted(payload.turnId));
    await mount();
    expect(screen.getByTestId('running-input-mode')).toBeInTheDocument();

    expect(await submit('first')).toBe('sent');
    fireEvent.click(screen.getByText('acp.runningInput.mode.steer'));
    expect(await submit('second')).toBe('sent');

    expect(writes()).toEqual([FOLLOW_UP, STEER]);
    expect(notices()).toHaveLength(1);
    expect(notices()[0]).toHaveTextContent(
      'acp.runningInput.queued {"modes":"acp.runningInput.mode.followUp, acp.runningInput.mode.steer"}'
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

  it('leaves preflight sends to the existing busy path when the native turn is still idle', async () => {
    server.turn = { active: false, turnId: null };
    await mount();
    expect(await submit('hello')).toBe('ordinary');
    expect(server.write).not.toHaveBeenCalled();
  });

  it('keeps the draft with a short reason when the turn already ended, then re-reads the state', async () => {
    server.write.mockImplementation(() => result({ accepted: false, reason: 'stale-turn' }));
    await mount();
    const reads = fetchMock.mock.calls.length;

    expect(await submit('late')).toBe('kept');
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
    expect(writes()).toEqual([FOLLOW_UP]);
  });

  it('keeps drafts with attachments and slash commands out of the relay', async () => {
    await mount();

    expect(await submit('with file', true)).toBe('kept');
    expect(Message.warning).toHaveBeenCalledWith('acp.runningInput.attachmentsKept');
    expect(await submit('/compact')).toBe('ordinary');
    expect(server.write).not.toHaveBeenCalled();
  });

  it('keeps a late acceptance on its original turn after that turn ends', async () => {
    const held = hold();
    server.write.mockReturnValueOnce(held.pending);
    const view = await mount();

    let route: Promise<RunningInputRoute> | undefined;
    act(() => {
      route = controller.submit('late', false);
    });
    await waitFor(() => expect(notices()[0]).toHaveAttribute('data-kind', 'pending'));

    server.turn = { active: false, turnId: null };
    view.rerender(<Harness hostBusy={false} hostTurnId={null} />);
    await waitFor(() => expect(controller.available).toBe(false));
    await act(async () => {
      held.reply(accepted('turn-1'));
      await route;
    });

    expect(notices()).toHaveLength(1);
    expect(notices()[0]).toHaveTextContent('acp.runningInput.queuedEnded');
  });

  it('says processing after Stop is unconfirmed for an acceptance that arrives after Stop', async () => {
    const held = hold();
    server.write.mockReturnValueOnce(held.pending);
    const view = await mount();

    let route: Promise<RunningInputRoute> | undefined;
    act(() => {
      route = controller.submit('withdrawn', false);
    });
    await waitFor(() => expect(notices()[0]).toHaveAttribute('data-kind', 'pending'));
    act(() => controller.markStopped());

    server.turn = { active: true, turnId: 'turn-2' };
    view.rerender(<Harness hostTurnId='host-turn-2' />);
    await act(async () => {
      held.reply(accepted('turn-1'));
      await route;
    });

    expect(notices()[0]).toHaveTextContent('acp.runningInput.queuedStopped');
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
    expect(controller.supported).toBe(false);

    view.rerender(<Harness paused />);
    await waitFor(() => expect(controller.supported).toBe(true));
    expect(controller.available).toBe(false);
    expect(await submit('hello')).toBe('ordinary');
  });
});
