const OWNER_MARKER = 'Aelix Coding · Aelix Studio';

type Agent = { id: string; name: string; command?: string; description?: string; agent_source: string };
type AgentRequest = { name: string; command: string; args: string[]; icon: string; advanced: { description: string } };
export type StudioApi = {
  listAgents: () => Promise<Agent[]>;
  createAgent: (body: AgentRequest) => Promise<Agent>;
  updateAgent: (id: string, body: AgentRequest) => Promise<unknown>;
};

/** Register the owned engine; AionCore generates its assistant; refresh install paths after moves/upgrades, preserving user preferences. */
export async function registerAelix(api: StudioApi, command: string, stateDir: string): Promise<void> {
  const agents = await api.listAgents();
  const existing = agents.find(
    (agent) =>
      agent.agent_source === 'custom' &&
      [OWNER_MARKER, 'aelix-studio:bundled-coding:v1'].includes(agent.description ?? '')
  );
  const body: AgentRequest = {
    name: 'Aelix',
    command: '/bin/sh',
    args: [command, '--profile', 'coding', '--state-dir', stateDir],
    icon: '🧬',
    advanced: { description: OWNER_MARKER },
  };
  if (existing) await api.updateAgent(existing.id, body);
  else await api.createAgent(body);
}
