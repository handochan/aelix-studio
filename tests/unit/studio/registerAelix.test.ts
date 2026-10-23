import { describe, expect, it, vi } from 'vitest';
import { registerAelix, type StudioApi } from '@/process/studio/registerAelix';

function api(agents: Awaited<ReturnType<StudioApi['listAgents']>> = []): StudioApi {
  return {
    listAgents: vi.fn().mockResolvedValue(agents),
    createAgent: vi.fn().mockResolvedValue({ id: 'owned-agent' }),
    updateAgent: vi.fn().mockResolvedValue(undefined),
  };
}

describe('Aelix Studio default registration', () => {
  it('does not hijack a user agent with the same display name', async () => {
    const client = api([{ id: 'user-agent', name: 'Aelix', agent_source: 'custom' }]);
    await registerAelix(client, { command: 'node', args: ['/new app/launch.cjs', 'acp'] }, '/data/acp');
    expect(client.updateAgent).not.toHaveBeenCalled();
    expect(client.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'node',
        args: ['/new app/launch.cjs', 'acp', '--profile', 'coding', '--state-dir', '/data/acp'],
      })
    );
  });
  it.each(['Aelix Coding · Aelix Studio', 'aelix-studio:bundled-coding:v1'])(
    'refreshes relocated paths on the existing engine (%s)',
    async (description) => {
      const client = api([{ id: 'owned-agent', name: 'Aelix', agent_source: 'custom', description }]);
      await registerAelix(client, { command: 'node', args: ['/moved app/launch.cjs', 'acp'] }, '/data/acp');
      expect(client.updateAgent).toHaveBeenCalledWith(
        'owned-agent',
        expect.objectContaining({
          command: 'node',
          args: ['/moved app/launch.cjs', 'acp', '--profile', 'coding', '--state-dir', '/data/acp'],
        })
      );
      expect(client.createAgent).toHaveBeenCalledTimes(1);
      expect(client.createAgent).toHaveBeenCalledWith(expect.objectContaining({ name: 'Aelix Analytics' }));
    }
  );
  it('propagates backend failure and does not mutate another engine', async () => {
    const client = api();
    vi.mocked(client.createAgent).mockRejectedValue(new Error('backend unavailable'));
    await expect(
      registerAelix(client, { command: '/app/python/bin/python3', args: ['/app/launch.cjs', 'acp'] }, '/data/acp')
    ).rejects.toThrow('backend unavailable');
    expect(client.updateAgent).not.toHaveBeenCalled();
  });
  it('registers a Windows command and argument array preserving spaces and non-ASCII paths', async () => {
    const client = api();
    await registerAelix(
      client,
      { command: 'node', args: ['C:\\Aelix Studio\\launch.cjs', 'acp'] },
      'C:\\Users\\사용자\\Studio data'
    );
    expect(client.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'node',
        args: [
          'C:\\Aelix Studio\\launch.cjs',
          'acp',
          '--profile',
          'coding',
          '--state-dir',
          'C:\\Users\\사용자\\Studio data',
        ],
      })
    );
  });

  it('enables Coding and Analytics for the inherited team engine with separate state', async () => {
    const client = api();
    await registerAelix(client, { command: 'node', args: ['/app/launch.cjs', 'acp'] }, '/data/acp');
    expect(client.createAgent).toHaveBeenCalledTimes(2);
    expect(client.createAgent).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        name: 'Aelix Analytics',
        args: ['/app/launch.cjs', 'acp', '--profile', 'analytics', '--state-dir', '/data/acp/analytics'],
        advanced: expect.objectContaining({ behavior_policy: { supports_team: true } }),
      })
    );
  });

  it('does not rewrite unchanged owned engines on every startup', async () => {
    const client = api([
      {
        id: 'coding',
        name: 'Aelix',
        agent_source: 'custom',
        command: 'node',
        args: ['/app/launch.cjs', 'acp', '--profile', 'coding', '--state-dir', '/data/acp'],
        description: 'Aelix Coding · Aelix Studio',
        behavior_policy: { supports_team: true },
      },
      {
        id: 'analytics',
        name: 'Aelix Analytics',
        agent_source: 'custom',
        command: 'node',
        args: ['/app/launch.cjs', 'acp', '--profile', 'analytics', '--state-dir', '/data/acp/analytics'],
        description: 'Aelix Analytics · Aelix Studio',
        behavior_policy: { supports_team: true },
      },
    ]);
    await registerAelix(client, { command: 'node', args: ['/app/launch.cjs', 'acp'] }, '/data/acp');
    expect(client.updateAgent).not.toHaveBeenCalled();
    expect(client.createAgent).not.toHaveBeenCalled();
  });

  it('preserves user arguments, environment and advanced settings when relocating an engine', async () => {
    const client = api([
      {
        id: 'coding',
        name: 'My Aelix',
        agent_source: 'custom',
        command: '/old/python',
        args: [
          '-I',
          '/old/launch.py',
          'acp',
          '--profile',
          'coding',
          '--state-dir',
          '/old/state',
          '--provider',
          'internal',
        ],
        env: [{ name: 'HTTPS_PROXY', value: 'http://internal-proxy' }],
        icon: '🔧',
        native_skills_dirs: ['/skills'],
        yolo_id: 'default',
        description: 'Aelix Coding · Aelix Studio',
        behavior_policy: { supports_side_question: true },
      },
    ]);
    await registerAelix(client, { command: 'node', args: ['/new/launch.cjs', 'acp'] }, '/data/acp');
    expect(client.updateAgent).toHaveBeenCalledWith('coding', {
      name: 'My Aelix',
      command: 'node',
      args: ['/new/launch.cjs', 'acp', '--profile', 'coding', '--state-dir', '/data/acp', '--provider', 'internal'],
      env: [{ name: 'HTTPS_PROXY', value: 'http://internal-proxy' }],
      icon: '🔧',
      advanced: {
        description: 'Aelix Coding · Aelix Studio',
        native_skills_dirs: ['/skills'],
        yolo_id: 'default',
        behavior_policy: { supports_side_question: true, supports_team: true },
      },
    });
  });

  it('migrates the original shell launcher without duplicating its managed arguments', async () => {
    const client = api([
      {
        id: 'coding',
        name: 'Aelix',
        agent_source: 'custom',
        command: '/bin/sh',
        args: ['/old/bin/aelix-acp', '--profile', 'coding', '--state-dir', '/old/state', '--model', 'local'],
        description: 'aelix-studio:bundled-coding:v1',
      },
    ]);
    await registerAelix(client, { command: 'node', args: ['/new/launch.cjs', 'acp'] }, '/data/acp');
    expect(client.updateAgent).toHaveBeenCalledWith(
      'coding',
      expect.objectContaining({
        args: ['/new/launch.cjs', 'acp', '--profile', 'coding', '--state-dir', '/data/acp', '--model', 'local'],
      })
    );
  });
});
