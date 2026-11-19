import React, { useMemo } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TeamAssistant } from '@/common/types/team/teamTypes';

type Emitter = { on: (listener: (payload: unknown) => void) => () => void; emit: (payload: unknown) => void };

const ipcMocks = vi.hoisted(() => {
  const emitters: Record<string, Emitter> = {};
  const emitter = (name: string): Emitter => {
    const listeners = new Set<(payload: unknown) => void>();
    emitters[name] = {
      on: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      emit: (payload) => listeners.forEach((listener) => listener(payload)),
    };
    return emitters[name];
  };
  return { list: vi.fn(), emitters, emitter };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options && 'name' in options
        ? `${key}|${String(options.name)}|${String(options.pending)}`
        : String(options?.defaultValue ?? key),
  }),
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    conversation: {
      responseStream: ipcMocks.emitter('stream'),
      turnCompleted: ipcMocks.emitter('turnCompleted'),
      confirmation: {
        list: { invoke: (...args: unknown[]) => ipcMocks.list(...args) },
        remove: ipcMocks.emitter('remove'),
      },
    },
    realtime: { reconnected: ipcMocks.emitter('reconnected') },
  },
}));

vi.mock('@/renderer/pages/team/components/AgentStatusBadge', () => ({
  default: ({ testId }: { testId: string }) => <span data-testid={testId} />,
}));

vi.mock('@/renderer/pages/team/components/TeamAgentIdentity', () => ({
  default: ({ assistant_name, nameTestId }: { assistant_name: string; nameTestId?: string }) => (
    <span data-testid={nameTestId}>{assistant_name}</span>
  ),
}));

vi.mock('@/renderer/pages/team/components/memberPicker/TeamAddMemberPopover', () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import TeamTabs from '@/renderer/pages/team/components/TeamTabs';
import { TeamTabsProvider } from '@/renderer/pages/team/hooks/TeamTabsContext';
import {
  createSeedJournal,
  mergeSeedSnapshot,
  useTeamPendingPermissions,
} from '@/renderer/pages/team/hooks/useTeamPendingPermissions';

const renameAssistantMock = vi.fn();

const assistants: TeamAssistant[] = [
  {
    slot_id: 'lead-slot',
    conversation_id: 'lead-conv',
    role: 'leader',
    assistant_backend: 'claude',
    assistant_name: 'Lead',
    status: 'idle',
  },
  {
    slot_id: 'worker-slot',
    conversation_id: 'worker-conv',
    role: 'teammate',
    assistant_backend: 'claude',
    assistant_name: 'Worker',
    status: 'idle',
  },
];

const renderTabs = (warmingUp: boolean) =>
  render(
    <TeamTabsProvider
      assistants={assistants}
      statusMap={new Map()}
      defaultActiveSlotId='lead-slot'
      team_id='team-1'
      renameAssistant={renameAssistantMock}
    >
      <TeamTabs warmingUp={warmingUp} />
    </TeamTabsProvider>
  );

describe('TeamTabs', () => {
  beforeEach(() => {
    renameAssistantMock.mockReset();
    localStorage.clear();
  });

  it('does not allow tab rename while the team is still warming up', () => {
    renderTabs(true);

    fireEvent.doubleClick(screen.getByTestId('team-tab-worker-slot'));

    expect(screen.queryByTestId('team-tab-edit-worker-slot')).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue('Worker')).not.toBeInTheDocument();
    expect(renameAssistantMock).not.toHaveBeenCalled();
  });

  it('allows member ops once warmup has ended (ready or failed)', () => {
    renderTabs(false);

    // hover reveals the rename affordance and double-click enters edit mode
    fireEvent.mouseEnter(screen.getByTestId('team-tab-worker-slot'));
    fireEvent.doubleClick(screen.getByTestId('team-tab-worker-slot'));

    expect(screen.getByDisplayValue('Worker')).toBeInTheDocument();
  });

  it('reveals a drag handle on teammate hover but never on the leader', () => {
    renderTabs(false);

    fireEvent.mouseEnter(screen.getByTestId('team-tab-worker-slot'));
    expect(screen.getByTestId('team-tab-drag-worker-slot')).toBeInTheDocument();

    fireEvent.mouseEnter(screen.getByTestId('team-tab-lead-slot'));
    expect(screen.queryByTestId('team-tab-drag-lead-slot')).not.toBeInTheDocument();
  });

  it('does not switch tabs when the drag handle is clicked', () => {
    renderTabs(false);

    // Active tab starts as the leader
    expect(screen.getByTestId('team-tab-lead-slot')).toHaveAttribute('data-active', 'true');

    fireEvent.mouseEnter(screen.getByTestId('team-tab-worker-slot'));
    fireEvent.click(screen.getByTestId('team-tab-drag-worker-slot'));

    expect(screen.getByTestId('team-tab-lead-slot')).toHaveAttribute('data-active', 'true');
    expect(screen.getByTestId('team-tab-worker-slot')).toHaveAttribute('data-active', 'false');
  });
});

const LiveBadgeHarness: React.FC = () => {
  const { pendingCounts } = useTeamPendingPermissions('team-1', ['lead-conv', 'worker-conv']);
  const slotCounts = useMemo(
    () => new Map(assistants.map((assistant) => [assistant.slot_id, pendingCounts[assistant.conversation_id] ?? 0])),
    [pendingCounts]
  );
  return (
    <TeamTabsProvider
      assistants={assistants}
      statusMap={new Map()}
      defaultActiveSlotId='lead-slot'
      team_id='team-1'
      renameAssistant={renameAssistantMock}
    >
      <TeamTabs pendingCounts={slotCounts} />
    </TeamTabsProvider>
  );
};

const emit = async (name: string, payload: unknown) => {
  await act(async () => {
    ipcMocks.emitters[name].emit(payload);
  });
};

const renderLive = async () => {
  render(<LiveBadgeHarness />);
  await act(async () => {});
};

const deferred = () => {
  let resolve: (value: unknown) => void = () => {};
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve: (value: unknown) => resolve(value) };
};

const workerBadge = () => screen.queryByTestId('team-tab-pending-worker-slot');
const leadBadge = () => screen.queryByTestId('team-tab-pending-lead-slot');

describe('TeamTabs live approval badge', () => {
  beforeEach(() => {
    localStorage.clear();
    ipcMocks.list.mockReset();
    ipcMocks.list.mockResolvedValue([]);
  });

  it('marks only the waiting member and clears when the request is answered', async () => {
    await renderLive();
    expect(workerBadge()).not.toBeInTheDocument();

    await emit('stream', {
      type: 'acp_permission',
      conversation_id: 'worker-conv',
      msg_id: 'm1',
      data: { tool_call: { tool_call_id: 'call-1' } },
    });

    expect(workerBadge()).toBeInTheDocument();
    expect(workerBadge()).toHaveAttribute('title', 'team.pendingApproval.label|Worker|1');
    expect(screen.getByTestId('team-tab-pending-status-worker-slot')).toHaveTextContent(
      'team.pendingApproval.label|Worker|1'
    );
    expect(leadBadge()).not.toBeInTheDocument();

    await emit('remove', { conversation_id: 'worker-conv', id: 'call-1' });

    expect(workerBadge()).not.toBeInTheDocument();
    expect(screen.getByTestId('team-tab-pending-status-worker-slot')).toHaveTextContent('');
  });

  it('shows the count for several requests and clears when the run ends or is cancelled', async () => {
    await renderLive();

    await emit('stream', { type: 'permission', conversation_id: 'lead-conv', msg_id: 'm1', data: { call_id: 'a' } });
    await emit('stream', { type: 'ask', conversation_id: 'lead-conv', msg_id: 'm2', data: { request_id: 'b' } });
    expect(leadBadge()).toHaveTextContent('2');

    await emit('stream', { type: 'finish', conversation_id: 'lead-conv', msg_id: 'm3', data: null });
    expect(leadBadge()).not.toBeInTheDocument();
  });

  it('seeds from the backend and reseeds after a realtime reconnect', async () => {
    ipcMocks.list.mockImplementation(async ({ conversation_id }: { conversation_id: string }) =>
      conversation_id === 'worker-conv' ? [{ id: 'conf-9', call_id: 'call-9' }] : []
    );
    await renderLive();
    expect(workerBadge()).toBeInTheDocument();

    ipcMocks.list.mockResolvedValue([]);
    await emit('reconnected', { timestamp: 1 });
    expect(workerBadge()).not.toBeInTheDocument();
  });

  it('clears a seeded request removed by its confirmation id', async () => {
    ipcMocks.list.mockImplementation(async ({ conversation_id }: { conversation_id: string }) =>
      conversation_id === 'worker-conv' ? [{ id: 'conf-9', call_id: 'call-9' }] : []
    );
    await renderLive();
    expect(workerBadge()).toBeInTheDocument();

    await emit('remove', { conversation_id: 'worker-conv', id: 'conf-9' });
    expect(workerBadge()).not.toBeInTheDocument();
  });

  it('does not resurrect a request answered while the backend snapshot was in flight', async () => {
    await renderLive();
    await emit('stream', {
      type: 'acp_permission',
      conversation_id: 'worker-conv',
      msg_id: 'm1',
      data: { tool_call: { tool_call_id: 'call-1' } },
    });

    const snapshot = deferred();
    ipcMocks.list.mockImplementation(() => snapshot.promise);
    await emit('turnCompleted', { session_id: 'worker-conv', turn_id: 't1', status: 'finished', state: 'stopped' });
    await emit('remove', { conversation_id: 'worker-conv', id: 'call-1' });
    await emit('stream', {
      type: 'acp_permission',
      conversation_id: 'worker-conv',
      msg_id: 'm2',
      data: { tool_call: { tool_call_id: 'call-2' } },
    });
    await act(async () => {
      snapshot.resolve([{ id: 'call-1', call_id: 'call-1' }]);
    });

    expect(workerBadge()).toBeInTheDocument();
    expect(workerBadge()).not.toHaveTextContent('2');
  });

  it('marks a built-in Aionrs member from its flat acp_permission payload', async () => {
    await renderLive();

    await emit('stream', {
      type: 'acp_permission',
      conversation_id: 'worker-conv',
      msg_id: 'm1',
      data: { id: 'conf-7', call_id: 'call-7', title: 'Run tool', description: '', options: [] },
    });
    expect(workerBadge()).toBeInTheDocument();

    // The answer may carry either id; the confirmation id must clear the call-id badge.
    await emit('remove', { conversation_id: 'worker-conv', id: 'conf-7' });
    expect(workerBadge()).not.toBeInTheDocument();
    expect(ipcMocks.list).toHaveBeenCalledTimes(2);
  });

  it('clears a request answered by confirmation id before the first snapshot returns', async () => {
    const firstSnapshot = deferred();
    ipcMocks.list.mockImplementation(({ conversation_id }: { conversation_id: string }) =>
      conversation_id === 'worker-conv' ? firstSnapshot.promise : Promise.resolve([])
    );
    await renderLive();
    await emit('stream', {
      type: 'acp_permission',
      conversation_id: 'worker-conv',
      msg_id: 'm1',
      data: { tool_call: { tool_call_id: 'call-1' } },
    });
    expect(workerBadge()).toBeInTheDocument();

    ipcMocks.list.mockResolvedValue([]);
    await emit('remove', { conversation_id: 'worker-conv', id: 'conf-1' });
    await act(async () => {
      firstSnapshot.resolve([{ id: 'conf-1', call_id: 'call-1' }]);
    });

    expect(workerBadge()).not.toBeInTheDocument();
  });

  it('keeps clear records for the first snapshot when the refetch after a restore fails', async () => {
    localStorage.setItem('team-pending-permissions-team-1', JSON.stringify({ 'worker-conv': ['call-1'] }));
    const firstSnapshot = deferred();
    ipcMocks.list.mockImplementation(({ conversation_id }: { conversation_id: string }) =>
      conversation_id === 'worker-conv' ? firstSnapshot.promise : Promise.resolve([])
    );
    await renderLive();
    expect(workerBadge()).toBeInTheDocument();

    ipcMocks.list.mockRejectedValue(new Error('backend unavailable'));
    await emit('remove', { conversation_id: 'worker-conv', id: 'conf-1' });
    await act(async () => {
      firstSnapshot.resolve([{ id: 'conf-1', call_id: 'call-1' }]);
    });

    expect(ipcMocks.list).toHaveBeenCalledTimes(3);
    expect(workerBadge()).not.toBeInTheDocument();
  });
});

describe('mergeSeedSnapshot', () => {
  it('drops a live mark whose request was removed by its other id while the snapshot was in flight', () => {
    const journal = createSeedJournal();
    journal.marked.add('call-1');
    journal.removed.add('conf-1');

    expect(mergeSeedSnapshot([{ key: 'call-1', ids: ['call-1', 'conf-1'] }], journal)).toEqual([]);
  });

  it('keeps unanswered snapshot entries and new live marks', () => {
    const journal = createSeedJournal();
    journal.marked.add('call-3');

    expect(mergeSeedSnapshot([{ key: 'call-2', ids: ['call-2', 'conf-2'] }], journal)).toEqual(['call-2', 'call-3']);
  });
});
