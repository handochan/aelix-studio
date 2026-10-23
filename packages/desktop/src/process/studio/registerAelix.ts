import path from 'node:path';
import { STUDIO_AGENT_PROFILES } from '@/common/config/constants';

type Agent = {
  id: string;
  name: string;
  command?: string;
  args?: string[];
  env?: { name: string; value: string; description?: string }[];
  icon?: string;
  description?: string;
  behavior_policy?: Record<string, unknown>;
  native_skills_dirs?: string[];
  yolo_id?: string;
  agent_source: string;
};
type AgentRequest = {
  name: string;
  command: string;
  args: string[];
  env: NonNullable<Agent['env']>;
  icon: string;
  advanced: {
    description: string;
    behavior_policy: Record<string, unknown>;
    native_skills_dirs?: string[];
    yolo_id?: string;
  };
};
export type StudioApi = {
  listAgents: () => Promise<Agent[]>;
  createAgent: (body: AgentRequest) => Promise<Agent>;
  updateAgent: (id: string, body: AgentRequest) => Promise<unknown>;
};
export type StudioCommand = { command: string; args: string[] };

function userArguments(args: string[]): string[] {
  let remaining = args;
  if (args[0] === '-I' && args[2] === 'acp') remaining = args.slice(3);
  else if (args[1] === 'acp' && /(?:^|[/\\])launch\.cjs$/.test(args[0])) remaining = args.slice(2);
  else if (args[0] && /(?:^|[/\\])aelix-acp(?:\.cmd)?$/.test(args[0])) remaining = args.slice(1);
  const result: string[] = [];
  for (let i = 0; i < remaining.length; i++) {
    if (remaining[i] === '--profile' || remaining[i] === '--state-dir') i++;
    else if (!/^--(?:profile|state-dir)=/.test(remaining[i])) result.push(remaining[i]);
  }
  return result;
}

/** Seed owned profiles, retaining user arguments, advanced fields and upstream environment overrides. */
export async function registerAelix(api: StudioApi, launch: StudioCommand, stateDir: string): Promise<void> {
  const agents = await api.listAgents();
  const paths = /^(?:[a-z]:[/\\]|\\\\)/i.test(stateDir) ? path.win32 : path.posix;
  for (const profile of STUDIO_AGENT_PROFILES) {
    const existing = agents.find(
      (agent) =>
        agent.agent_source === 'custom' &&
        (agent.description === profile.description ||
          (profile.profile === 'coding' && agent.description === 'aelix-studio:bundled-coding:v1'))
    );
    const args = [
      ...launch.args,
      '--profile',
      profile.profile,
      '--state-dir',
      profile.profile === 'coding' ? stateDir : paths.join(stateDir, 'analytics'),
      ...userArguments(existing?.args ?? []),
    ];
    if (
      existing?.command === launch.command &&
      JSON.stringify(existing.args ?? []) === JSON.stringify(args) &&
      existing.description === profile.description &&
      existing.behavior_policy?.supports_team === true
    ) {
      continue;
    }
    const body: AgentRequest = {
      name: existing?.name ?? profile.name,
      command: launch.command,
      args,
      env: existing?.env ?? [],
      icon: existing?.icon ?? '🧬',
      advanced: {
        description: profile.description,
        behavior_policy: { ...existing?.behavior_policy, supports_team: true },
        ...(existing?.native_skills_dirs ? { native_skills_dirs: existing.native_skills_dirs } : {}),
        ...(existing?.yolo_id ? { yolo_id: existing.yolo_id } : {}),
      },
    };
    if (existing) await api.updateAgent(existing.id, body);
    else await api.createAgent(body);
  }
}
