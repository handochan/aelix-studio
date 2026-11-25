/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * DOM tests for the settings-side "Aelix global defaults" panel (#7 unit F). The panel runs on
 * the real NativeResources client; only the helper bridge and the conversation relay are faked.
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

type Row = { saved: boolean; lock: { kind: string; value: boolean; reason: string } | null };
type Kind = 'tool' | 'skill' | 'mcp';
type Command = {
  action: string;
  kind: Kind;
  scope?: string;
  expectedRevision?: string;
  changes?: { key: string; on: boolean }[];
};

const fake = vi.hoisted(() => ({
  helper: vi.fn<(command: Command) => Promise<unknown>>(),
  relay: vi.fn<(path: string, body?: string) => Promise<unknown>>(),
  conversationGet: vi.fn(),
  userChange: new Set<() => void>(),
}));

/** Simulate sign-out or another user's sign-in. */
const changeUser = () => fake.userChange.forEach((handler) => handler());

vi.mock('@/renderer/hooks/context/AuthContext', () => ({
  onUserChange: (handler: () => void) => {
    fake.userChange.add(handler);
    return () => fake.userChange.delete(handler);
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values ? `${key}(${Object.values(values).map(String).join('|')})` : key,
  }),
}));

vi.mock('@/common', () => ({
  ipcBridge: { conversation: { get: { invoke: fake.conversationGet } } },
}));

vi.mock('@/renderer/services/runtime/RunningInput/transport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/renderer/services/runtime/RunningInput/transport')>();
  return { ...actual, requestRelay: fake.relay };
});

import { AelixDefaultsPanel, resetRecoveryForRuntimeChange } from '@/renderer/pages/settings/ToolsSettings/AelixNative';

// ---------------------------------------------------------------------------
// Global helper fake: one store per kind with a revision guarded like the native writer.

type Store = { revision: number; writable: boolean; reason: string | null; rows: Record<string, Row> };
let stores: Record<Kind, Store>;
/** When set, the next global write commits nothing and reports no changed rows. */
let helperNoop: boolean;

const globalRow = (key: string, row: Row) => ({
  key,
  label: key,
  role: 'item',
  saved: row.saved,
  decidedBy: 'global',
  lock: row.lock,
  problem: null,
});

function helperReply(command: Command): unknown {
  const store = stores[command.kind];
  const revision = `g.${command.kind}.${store.revision}`;
  if (command.action === 'selections/list') {
    return {
      ok: true,
      data: {
        scope: 'global',
        kind: command.kind,
        revision,
        effect: command.kind === 'mcp' ? 'restart' : 'next_request',
        writable: store.writable,
        reason: store.reason,
        exists: true,
        items: Object.entries(store.rows).map(([key, row]) => globalRow(key, row)),
        diagnostics: [],
        nextCursor: null,
      },
    };
  }
  if (command.action === 'selections/set') {
    if (command.expectedRevision !== revision)
      return { ok: false, code: 'REVISION_CONFLICT', currentRevision: revision };
    if (helperNoop) {
      return {
        ok: true,
        data: {
          scope: 'global',
          kind: command.kind,
          revision,
          saved: true,
          changed: [],
          mismatches: [],
          appliesAt: 'next_worker',
        },
      };
    }
    for (const change of command.changes ?? []) store.rows[change.key].saved = change.on;
    store.revision++;
    return {
      ok: true,
      data: {
        scope: 'global',
        kind: command.kind,
        revision: `g.${command.kind}.${store.revision}`,
        saved: true,
        changed: (command.changes ?? []).map(({ key, on }) => ({ key, saved: on })),
        mismatches: [],
        appliesAt: 'next_worker',
      },
    };
  }
  throw new Error('unexpected helper action ' + command.action);
}

/** Simulate the Aelix CLI writing the global store outside Studio. */
function cliWrite(kind: Kind, key: string, on: boolean) {
  stores[kind].rows[key].saved = on;
  stores[kind].revision++;
}

const helperWrites = () =>
  fake.helper.mock.calls.map(([command]) => command).filter((c) => c.action === 'selections/set');

// ---------------------------------------------------------------------------
// Conversation relay fake: discovery plus session selections for c-17.

type SessionRow = Row & {
  applied: boolean;
  inForce: boolean;
  live: boolean | null;
  pending: boolean;
  decidedBy?: 'global' | 'project';
};
let session: Record<Kind, Record<string, SessionRow>>;
/** When set, the next project write's outcome is lost and its binding is replaced. */
let loseNextWrite: boolean;
/** Set after a lost write: the next list finds the conversation detached. */
let detachNextList = false;
let applyMode: 'applied' | 'deferred';
let writeMismatches: { key: string; reason: string }[];

const DISCOVERY = {
  version: 1,
  bindingId: 'b-21',
  requests: [
    '_aelix/session/requests/lookup',
    '_aelix/session/profiles/list',
    '_aelix/session/selections/list',
    '_aelix/session/selections/set',
  ],
  notifications: [],
};

function sessionList(kind: Kind) {
  return {
    kind,
    effect: kind === 'mcp' ? 'restart' : 'next_request',
    scopes: {
      global: { writable: false, reason: 'management-helper', exists: true },
      project: { writable: true, reason: null, exists: true },
    },
    items: Object.entries(session[kind]).map(([key, row]) => ({
      key,
      label: key,
      role: 'item',
      loaded: true,
      saved: row.saved,
      decidedBy: row.decidedBy ?? 'project',
      applied: row.applied,
      inForce: row.inForce,
      live: row.live,
      pending: row.pending,
      lock: row.lock,
      problem: null,
    })),
    policyPending: false,
    diagnostics: [],
    toolOverride: null,
    activeTools: kind === 'tool' ? Object.keys(session.tool).filter((key) => session.tool[key].inForce) : null,
    nextCursor: null,
  };
}

function relayReply(path: string, body?: string): unknown {
  if (!/^\/api\/conversations\/c-1[78]\/acp-extensions$/.test(path)) throw new Error('unexpected relay path ' + path);
  if (body === undefined) return { kind: 'success', data: DISCOVERY };
  const { method, payload } = JSON.parse(body) as { method: string; payload: Command & { requestId?: string } };
  if (method === '_aelix/session/requests/lookup') {
    return { kind: 'failure', failure: { status: 409, code: 'EXT_STALE_BINDING' } };
  }
  if (method === '_aelix/session/selections/list' && detachNextList) {
    detachNextList = false;
    return { kind: 'failure', failure: { status: 409, code: 'EXT_NO_LIVE_TASK' } };
  }
  if (method === '_aelix/session/selections/set' && loseNextWrite) {
    loseNextWrite = false;
    detachNextList = true;
    return { kind: 'failure', failure: { status: 502, code: 'EXT_OUTCOME_UNKNOWN' } };
  }
  if (method === '_aelix/session/selections/list')
    return { kind: 'success', data: { result: sessionList(payload.kind) } };
  if (method === '_aelix/session/selections/set') {
    for (const change of payload.changes ?? []) {
      const row = session[payload.kind][change.key];
      row.saved = change.on;
      row.pending = true;
    }
    const mcp = payload.kind === 'mcp';
    return {
      kind: 'success',
      data: {
        result: {
          accepted: true,
          scope: 'project',
          kind: payload.kind,
          effect: mcp ? 'restart' : 'next_request',
          written: [mcp ? '.aelix/mcp.json' : '.aelix/settings.json'],
          changed: (payload.changes ?? []).map(({ key, on }) => ({ key, saved: on })),
          mismatches: writeMismatches,
          apply: mcp
            ? null
            : {
                applied: applyMode === 'applied',
                deferred: applyMode === 'deferred',
                turnedOn: [],
                turnedOff: [],
                warning: null,
              },
        },
      },
    };
  }
  throw new Error('unexpected relay method ' + method);
}

const relayWrites = () =>
  fake.relay.mock.calls
    .filter(([, body]) => body !== undefined)
    .map(([, body]) => JSON.parse(body ?? '{}') as { method: string; payload: Command })
    .filter(({ method }) => method === '_aelix/session/selections/set');

beforeEach(() => {
  changeUser();
  helperNoop = false;
  loseNextWrite = false;
  stores = {
    tool: {
      revision: 1,
      writable: true,
      reason: null,
      rows: {
        bash: { saved: true, lock: { kind: 'cli', value: false, reason: 'launch-locked' } },
        read: { saved: true, lock: null },
        write: { saved: false, lock: null },
      },
    },
    skill: { revision: 1, writable: true, reason: null, rows: { review: { saved: true, lock: null } } },
    mcp: { revision: 1, writable: true, reason: null, rows: { 'local-docs': { saved: true, lock: null } } },
  };
  session = {
    tool: { read: { saved: true, lock: null, applied: true, inForce: true, live: true, pending: false } },
    skill: { review: { saved: true, lock: null, applied: true, inForce: true, live: null, pending: false } },
    mcp: { 'local-docs': { saved: true, lock: null, applied: true, inForce: true, live: true, pending: false } },
  };
  applyMode = 'deferred';
  writeMismatches = [];
  fake.helper.mockReset().mockImplementation(async (command) => helperReply(command));
  fake.relay.mockReset().mockImplementation(async (path, body) => relayReply(path, body));
  fake.conversationGet.mockReset().mockResolvedValue({ id: 'c-17', name: 'Demo', extra: { workspace: '/work/demo' } });
  window.__studioNativeResources = { request: (command) => fake.helper(command as Command) };
});

afterEach(() => {
  cleanup();
  delete window.__studioNativeResources;
});

const switchOf = (key: string) => within(screen.getByTestId(`aelix-row-${key}`)).getByRole('switch');

describe('Aelix global defaults panel', () => {
  it('lists global tool defaults with lock reasons and the sessionless effective-state note', async () => {
    render(<AelixDefaultsPanel kinds={['tool', 'mcp']} />);

    await screen.findByTestId('aelix-row-read');
    expect(screen.queryByTestId('aelix-scope')).not.toBeInTheDocument();
    expect(screen.getByTestId('aelix-effective-unknown')).toHaveTextContent('settings.aelixNative.effectiveUnknown');
    expect(screen.getByTestId('aelix-lock-bash')).toHaveTextContent(
      'settings.aelixNative.lock.title(settings.aelixNative.off|settings.aelixNative.lock.reason.launchLocked)'
    );
    expect(switchOf('bash')).toBeDisabled();
    expect(switchOf('read')).not.toBeDisabled();
    expect(fake.helper).toHaveBeenCalledWith({ action: 'selections/list', scope: 'global', kind: 'tool' });
    expect(fake.relay).not.toHaveBeenCalled();
  });

  it('shows a read-only scope reason and disables every switch', async () => {
    stores.mcp.writable = false;
    stores.mcp.reason = 'env-config';
    render(<AelixDefaultsPanel kinds={['mcp']} />);

    await screen.findByTestId('aelix-row-local-docs');
    expect(screen.getByTestId('aelix-scope-readonly')).toHaveTextContent('settings.aelixNative.scopeReason.envConfig');
    expect(switchOf('local-docs')).toBeDisabled();
  });

  it('saves a global change with the listed revision and reports when it applies', async () => {
    render(<AelixDefaultsPanel kinds={['tool', 'mcp']} />);

    fireEvent.click(await waitFor(() => switchOf('write')));
    fireEvent.click(screen.getByTestId('aelix-save'));

    expect(await screen.findByTestId('aelix-save-notice')).toHaveTextContent('settings.aelixNative.saved.nextWorker');
    expect(helperWrites()).toEqual([
      expect.objectContaining({ kind: 'tool', expectedRevision: 'g.tool.1', changes: [{ key: 'write', on: true }] }),
    ]);
    expect(stores.tool.rows.write.saved).toBe(true);
    expect(switchOf('write')).toBeChecked();
  });

  it('reports a saved global MCP change as applying at the next worker start', async () => {
    render(<AelixDefaultsPanel kinds={['tool', 'mcp']} />);
    await screen.findByTestId('aelix-row-read');

    fireEvent.click(screen.getByText('settings.aelixNative.kind.mcp'));
    fireEvent.click(await waitFor(() => switchOf('local-docs')));
    fireEvent.click(screen.getByTestId('aelix-save'));

    expect(await screen.findByTestId('aelix-save-notice')).toHaveTextContent('settings.aelixNative.saved.nextWorker');
  });

  it('shows the current value after a CLI conflict and writes again only when the user re-applies', async () => {
    render(<AelixDefaultsPanel kinds={['tool']} />);
    fireEvent.click(await waitFor(() => switchOf('read')));
    // The CLI changes another key after Studio listed the store.
    cliWrite('tool', 'write', true);
    fireEvent.click(screen.getByTestId('aelix-save'));

    const retry = await screen.findByTestId('aelix-retry-conflict');
    expect(within(retry).getByTestId('aelix-retry-row-read')).toHaveTextContent(
      'settings.aelixNative.retry.current(settings.aelixNative.on)'
    );
    expect(within(retry).getByTestId('aelix-retry-row-read')).toHaveTextContent(
      'settings.aelixNative.retry.choice(settings.aelixNative.off)'
    );
    // The fresh list shows the CLI's value; nothing was overwritten or retried silently.
    expect(switchOf('write')).toBeChecked();
    expect(helperWrites()).toHaveLength(1);
    expect(stores.tool.rows.read.saved).toBe(true);

    fireEvent.click(within(retry).getByTestId('aelix-reapply'));
    await screen.findByTestId('aelix-save-notice');
    expect(helperWrites()).toHaveLength(2);
    expect(helperWrites()[1]).toMatchObject({ expectedRevision: 'g.tool.2', changes: [{ key: 'read', on: false }] });
    expect(stores.tool.rows).toMatchObject({ read: { saved: false }, write: { saved: true } });
  });

  it('restores only the picked items to the original scope and flags later CLI changes', async () => {
    render(<AelixDefaultsPanel kinds={['tool']} />);
    fireEvent.click(await waitFor(() => switchOf('read')));
    fireEvent.click(switchOf('write'));
    fireEvent.click(screen.getByTestId('aelix-save'));
    await screen.findByTestId('aelix-save-notice');
    expect(stores.tool.rows).toMatchObject({ read: { saved: false }, write: { saved: true } });

    // The CLI changes the store afterwards; reload to observe it.
    cliWrite('tool', 'write', true);
    fireEvent.click(screen.getByText('settings.aelixNative.reload'));
    await waitFor(() => expect(fake.helper).toHaveBeenCalledTimes(4));

    fireEvent.click(await screen.findByTestId('aelix-recovery-open'));
    const modal = await screen.findByTestId('aelix-recovery-modal');
    expect(modal).toHaveTextContent('settings.aelixNative.recovery.changedElsewhere');
    const readRow = within(modal).getByTestId('aelix-recovery-row-read');
    expect(readRow).toHaveTextContent('settings.aelixNative.recovery.previous(settings.aelixNative.on)');
    expect(readRow).toHaveTextContent('settings.aelixNative.recovery.current(settings.aelixNative.off)');
    expect(screen.getByTestId('aelix-recovery-restore')).toBeDisabled();

    fireEvent.click(within(readRow).getByRole('checkbox'));
    fireEvent.click(screen.getByTestId('aelix-recovery-restore'));

    await screen.findByText(/settings\.aelixNative\.recovery\.restored/);
    expect(helperWrites()).toHaveLength(2);
    expect(helperWrites()[1]).toMatchObject({
      scope: 'global',
      kind: 'tool',
      expectedRevision: 'g.tool.3',
      changes: [{ key: 'read', on: true }],
    });
    expect(stores.tool.rows).toMatchObject({ read: { saved: true }, write: { saved: true } });
    // The unpicked item stays available for a later restore.
    fireEvent.click(screen.getByTestId('aelix-recovery-open'));
    const remaining = await screen.findByTestId('aelix-recovery-modal');
    expect(within(remaining).queryByTestId('aelix-recovery-row-read')).not.toBeInTheDocument();
    expect(within(remaining).getByTestId('aelix-recovery-row-write')).toBeInTheDocument();
  });

  it('opens on "This project" from a conversation, shows the workspace and switches scopes', async () => {
    render(<AelixDefaultsPanel kinds={['skill']} conversationId='c-17' />);

    expect(await screen.findByTestId('aelix-workspace')).toHaveTextContent(
      'settings.aelixNative.workspace(/work/demo)'
    );
    expect(screen.getByTestId('aelix-project-impact')).toHaveTextContent('settings.aelixNative.projectImpact');
    expect(screen.getByTestId('aelix-project-impact')).toHaveTextContent('settings.aelixNative.noConversationOverride');
    expect(await screen.findByTestId('aelix-effective-review')).toHaveTextContent(
      'settings.aelixNative.state.applied · settings.aelixNative.state.inForce · settings.aelixNative.state.liveUnknown'
    );
    expect(fake.helper).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('settings.aelixNative.scope.global'));
    await screen.findByTestId('aelix-effective-unknown');
    expect(screen.queryByTestId('aelix-project-impact')).not.toBeInTheDocument();
    expect(fake.helper).toHaveBeenCalledWith({ action: 'selections/list', scope: 'global', kind: 'skill' });

    fireEvent.click(screen.getByText('settings.aelixNative.scope.project'));
    await screen.findByTestId('aelix-effective-review');
    const lists = fake.relay.mock.calls.filter(([, body]) => body?.includes('selections/list'));
    const discoveries = fake.relay.mock.calls.filter(([, body]) => body === undefined);
    expect(lists).toHaveLength(2);
    expect(discoveries).toHaveLength(2);
  });

  it('marks a project skill save as pending until the next request', async () => {
    render(<AelixDefaultsPanel kinds={['skill']} conversationId='c-17' />);
    fireEvent.click(await waitFor(() => switchOf('review')));
    fireEvent.click(screen.getByTestId('aelix-save'));

    expect(await screen.findByTestId('aelix-save-notice')).toHaveTextContent('settings.aelixNative.saved.deferred');
    expect(screen.getByTestId('aelix-pending-review')).toHaveTextContent(
      'settings.aelixNative.state.pendingNextRequest'
    );
    expect(relayWrites()).toEqual([
      expect.objectContaining({
        method: '_aelix/session/selections/set',
        payload: expect.objectContaining({ scope: 'project', kind: 'skill', changes: [{ key: 'review', on: false }] }),
      }),
    ]);
    expect(fake.helper).not.toHaveBeenCalled();
  });

  it('attaches a reported mismatch to the saved row after a project save', async () => {
    applyMode = 'applied';
    writeMismatches = [{ key: 'review', reason: 'saved-value-differs' }];
    render(<AelixDefaultsPanel kinds={['skill']} conversationId='c-17' />);
    fireEvent.click(await waitFor(() => switchOf('review')));
    fireEvent.click(screen.getByTestId('aelix-save'));

    expect(await screen.findByTestId('aelix-save-notice')).toHaveTextContent('settings.aelixNative.saved.applied');
    expect(screen.getByTestId('aelix-mismatch-review')).toHaveTextContent(
      'settings.aelixNative.mismatch(settings.aelixNative.mismatchReason.savedValueDiffers)'
    );
    expect(screen.getByTestId('aelix-save-notice')).toHaveTextContent('settings.aelixNative.saved.mismatch');
  });

  it('marks a project MCP save as restart pending', async () => {
    render(<AelixDefaultsPanel kinds={['tool', 'mcp']} conversationId='c-17' />);
    await screen.findByTestId('aelix-row-read');
    expect(screen.getByTestId('aelix-project-impact')).toHaveTextContent('settings.aelixNative.toolOverrideHint');

    fireEvent.click(screen.getByText('settings.aelixNative.kind.mcp'));
    fireEvent.click(await waitFor(() => switchOf('local-docs')));
    fireEvent.click(screen.getByTestId('aelix-save'));

    expect(await screen.findByTestId('aelix-save-notice')).toHaveTextContent('settings.aelixNative.saved.restart');
    expect(screen.getByTestId('aelix-pending-local-docs')).toHaveTextContent(
      'settings.aelixNative.state.pendingRestart'
    );
  });

  it('asks to open the conversation when it has no live session', async () => {
    fake.relay.mockImplementation(async () => ({
      kind: 'failure',
      failure: { status: 409, code: 'EXT_NO_LIVE_TASK' },
    }));
    render(<AelixDefaultsPanel kinds={['skill']} conversationId='c-17' />);

    expect(await screen.findByTestId('aelix-project-failure')).toHaveTextContent(
      'settings.aelixNative.failure.detached'
    );
    expect(fake.helper).not.toHaveBeenCalled();
  });
  it('drops restore records when the signed-in user changes or the runtime changes', async () => {
    const saveRead = async () => {
      fireEvent.click(await waitFor(() => switchOf('read')));
      fireEvent.click(screen.getByTestId('aelix-save'));
      await screen.findByTestId('aelix-save-notice');
      expect(screen.getByTestId('aelix-recovery-open')).toBeInTheDocument();
    };
    const first = render(<AelixDefaultsPanel kinds={['tool']} />);
    await saveRead();
    first.unmount();

    changeUser();
    const second = render(<AelixDefaultsPanel kinds={['tool']} />);
    await screen.findByTestId('aelix-row-read');
    expect(screen.queryByTestId('aelix-recovery-open')).not.toBeInTheDocument();
    await saveRead();
    second.unmount();

    resetRecoveryForRuntimeChange();
    render(<AelixDefaultsPanel kinds={['tool']} />);
    await screen.findByTestId('aelix-row-read');
    expect(screen.queryByTestId('aelix-recovery-open')).not.toBeInTheDocument();
  });

  it('labels a restore of an inherited project value as an explicit project value', async () => {
    session.skill.review.decidedBy = 'global';
    applyMode = 'applied';
    render(<AelixDefaultsPanel kinds={['skill']} conversationId='c-17' />);
    fireEvent.click(await waitFor(() => switchOf('review')));
    fireEvent.click(screen.getByTestId('aelix-save'));
    await screen.findByTestId('aelix-save-notice');

    fireEvent.click(screen.getByTestId('aelix-recovery-open'));
    const modal = await screen.findByTestId('aelix-recovery-modal');
    expect(within(modal).getByTestId('aelix-recovery-explicit-review')).toHaveTextContent(
      'settings.aelixNative.recovery.explicitProject'
    );
    fireEvent.click(within(within(modal).getByTestId('aelix-recovery-row-review')).getByRole('checkbox'));
    fireEvent.click(screen.getByTestId('aelix-recovery-restore'));
    await screen.findByText(/settings\.aelixNative\.recovery\.restored/);
    expect(relayWrites()[1].payload).toMatchObject({ scope: 'project', changes: [{ key: 'review', on: true }] });
  });

  it('warns and keeps nothing to restore when the store reports no saved change', async () => {
    helperNoop = true;
    render(<AelixDefaultsPanel kinds={['tool']} />);
    fireEvent.click(await waitFor(() => switchOf('write')));
    fireEvent.click(screen.getByTestId('aelix-save'));

    expect(await screen.findByTestId('aelix-save-notice')).toHaveTextContent('settings.aelixNative.saved.noChange');
    expect(screen.queryByTestId('aelix-recovery-open')).not.toBeInTheDocument();
  });

  it('does not report its own restore as a change made elsewhere', async () => {
    render(<AelixDefaultsPanel kinds={['tool']} />);
    fireEvent.click(await waitFor(() => switchOf('read')));
    fireEvent.click(switchOf('write'));
    fireEvent.click(screen.getByTestId('aelix-save'));
    await screen.findByTestId('aelix-save-notice');

    fireEvent.click(screen.getByTestId('aelix-recovery-open'));
    let modal = await screen.findByTestId('aelix-recovery-modal');
    expect(modal).not.toHaveTextContent('settings.aelixNative.recovery.changedElsewhere');
    fireEvent.click(within(within(modal).getByTestId('aelix-recovery-row-read')).getByRole('checkbox'));
    fireEvent.click(screen.getByTestId('aelix-recovery-restore'));
    await screen.findByText(/settings\.aelixNative\.recovery\.restored/);

    fireEvent.click(screen.getByTestId('aelix-recovery-open'));
    modal = await screen.findByTestId('aelix-recovery-modal');
    expect(within(modal).getByTestId('aelix-recovery-row-write')).toBeInTheDocument();
    expect(modal).not.toHaveTextContent('settings.aelixNative.recovery.changedElsewhere');
  });

  it('says so when re-applying finds every value already matching', async () => {
    render(<AelixDefaultsPanel kinds={['tool']} />);
    fireEvent.click(await waitFor(() => switchOf('read')));
    cliWrite('tool', 'read', false);
    fireEvent.click(screen.getByTestId('aelix-save'));

    fireEvent.click(within(await screen.findByTestId('aelix-retry-conflict')).getByTestId('aelix-reapply'));
    expect(await screen.findByTestId('aelix-nothing-to-apply')).toHaveTextContent(
      'settings.aelixNative.nothingToApply'
    );
    expect(helperWrites()).toHaveLength(1);
  });

  it('keeps a pending re-apply visible across a rediscovered conversation binding', async () => {
    render(<AelixDefaultsPanel kinds={['skill']} conversationId='c-17' />);
    fireEvent.click(await waitFor(() => switchOf('review')));
    loseNextWrite = true;
    fireEvent.click(screen.getByTestId('aelix-save'));

    // The write's outcome is unknown and the conversation detached, so the list cannot be read yet.
    const failure = await screen.findByTestId('aelix-list-failure');
    expect(screen.getByTestId('aelix-retry-unknown')).toBeInTheDocument();
    fireEvent.click(within(failure).getByText('settings.aelixNative.reload'));

    await screen.findByTestId('aelix-row-review');
    const retry = screen.getByTestId('aelix-retry-unknown');
    expect(within(retry).getByTestId('aelix-reapply')).not.toBeDisabled();
    expect(relayWrites()).toHaveLength(1);
  });

  it('titles the panel by scope, retries a failed discovery and passes an abort signal to the workspace read', async () => {
    let live = false;
    fake.relay.mockImplementation(async (path, body) =>
      live ? relayReply(path, body) : { kind: 'failure', failure: { status: 409, code: 'EXT_NO_LIVE_TASK' } }
    );
    render(<AelixDefaultsPanel kinds={['skill']} conversationId='c-17' />);

    expect(screen.getByTestId('aelix-defaults-title')).toHaveTextContent('settings.aelixNative.titleProject');
    expect(screen.getByRole('radiogroup', { name: 'settings.aelixNative.scope.label' })).toBeInTheDocument();
    expect(fake.conversationGet).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'c-17', signal: expect.any(AbortSignal) })
    );
    live = true;
    fireEvent.click(await screen.findByTestId('aelix-project-retry'));
    await screen.findByTestId('aelix-row-review');

    fireEvent.click(screen.getByText('settings.aelixNative.scope.global'));
    expect(screen.getByTestId('aelix-defaults-title')).toHaveTextContent('settings.aelixNative.title');
  });

  it('switches to the new project when the conversation changes', async () => {
    const view = render(<AelixDefaultsPanel kinds={['skill']} conversationId='c-17' />);
    await screen.findByTestId('aelix-row-review');
    fake.conversationGet.mockResolvedValue({ id: 'c-18', extra: { workspace: '/work/other' } });

    view.rerender(<AelixDefaultsPanel kinds={['skill']} conversationId='c-18' />);
    expect(await screen.findByText('settings.aelixNative.workspace(/work/other)')).toBeInTheDocument();
    await waitFor(() =>
      expect(fake.relay.mock.calls.some(([path]) => path === '/api/conversations/c-18/acp-extensions')).toBe(true)
    );
    await screen.findByTestId('aelix-row-review');
  });

  it('waits to read global defaults until a deferred panel is on screen', async () => {
    const observers: ((entries: { isIntersecting: boolean }[]) => void)[] = [];
    const original = window.IntersectionObserver;
    window.IntersectionObserver = class {
      constructor(callback: (entries: { isIntersecting: boolean }[]) => void) {
        observers.push(callback);
      }
      observe() {}
      disconnect() {}
    } as unknown as typeof IntersectionObserver;
    try {
      render(<AelixDefaultsPanel kinds={['tool', 'mcp']} deferUntilVisible />);
      await waitFor(() => expect(observers).toHaveLength(1));
      expect(fake.helper).not.toHaveBeenCalled();

      act(() => observers[0]([{ isIntersecting: true }]));
      await screen.findByTestId('aelix-row-read');
      expect(fake.helper).toHaveBeenCalledTimes(1);
    } finally {
      window.IntersectionObserver = original;
    }
  });
});
