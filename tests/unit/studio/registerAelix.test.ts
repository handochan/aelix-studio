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
    await registerAelix(
      client,
      { command: '/new app/python/bin/python3', args: ['-I', '/new app/launch.py', 'acp'] },
      '/data/acp'
    );
    expect(client.updateAgent).not.toHaveBeenCalled();
    expect(client.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        command: '/new app/python/bin/python3',
        args: ['-I', '/new app/launch.py', 'acp', '--profile', 'coding', '--state-dir', '/data/acp'],
      })
    );
  });
  it.each(['Aelix Coding · Aelix Studio', 'aelix-studio:bundled-coding:v1'])(
    'refreshes relocated paths on the existing engine (%s)',
    async (description) => {
      const client = api([{ id: 'owned-agent', name: 'Aelix', agent_source: 'custom', description }]);
      await registerAelix(
        client,
        { command: '/moved app/python/bin/python3', args: ['-I', '/moved app/launch.py', 'acp'] },
        '/data/acp'
      );
      expect(client.updateAgent).toHaveBeenCalledWith(
        'owned-agent',
        expect.objectContaining({
          command: '/moved app/python/bin/python3',
          args: ['-I', '/moved app/launch.py', 'acp', '--profile', 'coding', '--state-dir', '/data/acp'],
        })
      );
      expect(client.createAgent).not.toHaveBeenCalled();
    }
  );
  it('propagates backend failure and does not mutate another engine', async () => {
    const client = api();
    vi.mocked(client.createAgent).mockRejectedValue(new Error('backend unavailable'));
    await expect(
      registerAelix(client, { command: '/app/python/bin/python3', args: ['-I', '/app/launch.py', 'acp'] }, '/data/acp')
    ).rejects.toThrow('backend unavailable');
    expect(client.updateAgent).not.toHaveBeenCalled();
  });
  it('launches Windows Python directly with separate arguments for spaces and non-ASCII paths', async () => {
    const client = api();
    await registerAelix(
      client,
      { command: 'C:\\Aelix Studio\\python\\python.exe', args: ['-I', 'C:\\Aelix Studio\\launch.py', 'acp'] },
      'C:\\Users\\사용자\\Studio data'
    );
    expect(client.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'C:\\Aelix Studio\\python\\python.exe',
        args: [
          '-I',
          'C:\\Aelix Studio\\launch.py',
          'acp',
          '--profile',
          'coding',
          '--state-dir',
          'C:\\Users\\사용자\\Studio data',
        ],
      })
    );
  });
});
