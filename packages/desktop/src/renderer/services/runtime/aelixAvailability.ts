import { mutate } from 'swr';
import { ipcBridge } from '@/common';
import { BUILTIN_AELIX_AGENT_ID } from '@/common/types/agent/assistantTypes';
import { MANAGED_AGENTS_SWR_KEY } from '@/renderer/utils/model/agentTypes';

/** The host records this code when a real turn fails provider authentication. */
const AUTH_FAILURE_CODE = 'auth_required';

let recheck: Promise<boolean> | undefined;

async function recheckOnce(): Promise<boolean> {
  const agents = await ipcBridge.acpConversation.getManagedAgents.invoke();
  const agent = agents.find((row) => row.id === BUILTIN_AELIX_AGENT_ID);
  if (!agent || agent.enabled === false) return false;
  if (agent.status !== 'offline' || agent.last_check_error_code !== AUTH_FAILURE_CODE) return false;
  await ipcBridge.acpConversation.checkManagedAgentHealthById.invoke({ id: BUILTIN_AELIX_AGENT_ID });
  // Pickers read availability through these caches.
  void mutate('assistants.list');
  void mutate(MANAGED_AGENTS_SWR_KEY);
  return true;
}

/**
 * Probe builtin Aelix again when the host marked it offline because a provider
 * rejected its credentials. Other offline causes keep the host's verdict.
 * Resolves to whether a probe ran.
 */
export function recheckAelixAfterAuthFailure(): Promise<boolean> {
  recheck ??= recheckOnce().finally(() => {
    recheck = undefined;
  });
  return recheck;
}
