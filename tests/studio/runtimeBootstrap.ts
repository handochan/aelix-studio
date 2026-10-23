import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { bootstrapStudioRuntime } from '../../packages/desktop/src/process/studio/runtime';

type Agent = {
  id: string;
  name: string;
  description?: string;
  command: string;
  args: string[];
  env: { name: string; value: string }[];
  icon?: string;
  behavior_policy?: Record<string, unknown>;
};
type Assistant = { id: string; name: string; team_selectable: boolean };
const [port, resources, data] = process.argv.slice(2);
const base = `http://127.0.0.1:${port}`;
const originalFetch = globalThis.fetch;
let updates = 0;
globalThis.fetch = async (input, options) => {
  if (options?.method === 'PUT') updates++;
  const response = await originalFetch(input, options);
  if (!response.ok) console.error('Isolated backend contract failure:', await response.clone().text());
  return response;
};

async function api<T>(route: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await originalFetch(base + route, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(60_000),
  });
  assert.ok(response.ok, `${route}: ${response.status} ${response.ok ? '' : await response.text()}`);
  const value = (await response.json()) as { data?: T };
  return ('data' in value ? value.data : value) as T;
}

async function main(): Promise<void> {
  await bootstrapStudioRuntime(Number(port), resources, data);
  const owned = (await api<Agent[]>('/api/agents/management')).filter((a) => a.description?.endsWith('· Aelix Studio'));
  assert.equal(owned.length, 2);
  const assistants = (await api<Assistant[]>('/api/assistants')).filter((a) =>
    ['Aelix', 'Aelix Analytics'].includes(a.name)
  );
  assert.equal(assistants.length, 2);
  assert.ok(assistants.every((a) => a.team_selectable));
  await bootstrapStudioRuntime(Number(port), resources, data);
  assert.equal(updates, 0, 'unchanged startup must not replace user settings');

  const coding = owned.find((a) => a.name === 'Aelix');
  assert.ok(coding);
  await api(`/api/agents/custom/${coding.id}`, 'PUT', {
    name: coding.name,
    command: coding.command,
    args: [...coding.args, '--provider', 'openai'],
    env: [],
    advanced: { description: coding.description, behavior_policy: { supports_team: true } },
  });
  // Management intentionally redacts env; use the same protected overrides API as Agent Settings.
  await api(`/api/agents/${coding.id}/overrides`, 'PUT', {
    env_override: [{ name: 'STUDIO_TEST_SETTING', value: 'preserved' }],
  });
  const moved = path.join(data, 'Aelix Studio 한글 resources');
  fs.symlinkSync(resources, moved, process.platform === 'win32' ? 'junction' : 'dir');
  await bootstrapStudioRuntime(Number(port), moved, data);
  const refreshed = (await api<Agent[]>('/api/agents/management')).find((a) => a.id === coding.id);
  assert.ok(refreshed?.args.includes('--provider'));
  const overrides = await api<{ env_override: { name: string; value: string }[] }>(
    `/api/agents/${coding.id}/overrides`
  );
  assert.ok(overrides.env_override.some((item) => item.name === 'STUDIO_TEST_SETTING' && item.value === 'preserved'));
  assert.equal(updates, 2, 'relocation refreshes both owned engines exactly once');

  const workspace = path.join(data, 'team-workspace');
  fs.mkdirSync(workspace);
  const team = await api<{ id: string; assistants: { slot_id: string; role: string }[] }>('/api/teams', 'POST', {
    name: 'Studio runtime integration',
    workspace,
    agents: assistants.map((a) => ({
      assistant_id: a.id,
      name: a.name,
      role: a.name === 'Aelix' ? 'lead' : 'teammate',
      model: 'default',
    })),
  });
  assert.ok(team.id);
  try {
    assert.equal(team.assistants.length, 2);
    await api(`/api/teams/${team.id}/session`, 'POST');
    const teammate = team.assistants.find((a) => a.role === 'teammate');
    assert.ok(teammate);
    await api(`/api/teams/${team.id}/agents/${teammate.slot_id}/attach`, 'POST');
    console.log(
      JSON.stringify({
        profiles: 2,
        teamSelectable: true,
        unchangedUpdates: 0,
        settingsPreservedAfterMove: true,
        teamCreated: true,
        teamSessionInitialized: true,
        analyticsTeammateAttached: true,
        evidence: 'real local backend and bundled agents; no model/provider call',
      })
    );
  } finally {
    await api(`/api/teams/${team.id}/session`, 'DELETE');
    await api(`/api/teams/${team.id}`, 'DELETE');
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
