import { mutate } from 'swr';
import { ipcBridge } from '@/common';
import { BUILTIN_AELIX_AGENT_ID } from '@/common/types/agent/assistantTypes';
import { MANAGED_AGENTS_SWR_KEY } from '@/renderer/utils/model/agentTypes';

let recheck: Promise<boolean> | undefined;

async function recheckOnce(): Promise<boolean> {
  const agents = await ipcBridge.acpConversation.getManagedAgents.invoke();
  const agent = agents.find((row) => row.id === BUILTIN_AELIX_AGENT_ID);
  if (!agent || agent.enabled === false) return false;
  // A real turn failed (`auth_required`, or `session_send_failed` for a provider rejection).
  // Probe verdicts (startup, scheduled, manual) are left as the host reported them.
  if (agent.status !== 'offline' || agent.last_check_kind !== 'session') return false;
  await ipcBridge.acpConversation.checkManagedAgentHealthById.invoke({ id: BUILTIN_AELIX_AGENT_ID });
  // Pickers read availability through these caches.
  void mutate('assistants.list');
  void mutate(MANAGED_AGENTS_SWR_KEY);
  return true;
}

/**
 * Probe builtin Aelix again when the host marked it offline after a session failed,
 * such as a provider rejecting its credentials. Resolves to whether a probe ran.
 */
export function recheckAelixAfterSessionFailure(): Promise<boolean> {
  recheck ??= recheckOnce().finally(() => {
    recheck = undefined;
  });
  return recheck;
}
