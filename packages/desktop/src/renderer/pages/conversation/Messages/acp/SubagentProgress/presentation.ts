import { parseSubagentProgress } from './parser';
import type { SubagentParentStatus, SubagentPresentation, SubagentTurnSignal } from './types';

/**
 * Adapt the extension once at the narrow boundary; no store access or subscriptions.
 * A known idle conversation ends its calls. During a new active turn, old calls
 * cannot be reconciled safely without a per-call ended signal or a host turn ID.
 * backend_turn_id is a provider fork anchor, not the host runtime turn ID.
 * Before the first extension frame there is no subagent identity to reconcile;
 * generic tool states remain unchanged even when the conversation is idle.
 * A stopped child followed by a new child is unreachable in the pinned native;
 * future S3 needs an explicit lifecycle contract rather than this projection.
 */
export const presentSubagentTool = (
  metadata: unknown,
  parentStatus: SubagentParentStatus,
  turn?: SubagentTurnSignal
): SubagentPresentation | null => {
  if (typeof metadata !== 'object' || metadata === null || !('aelix/subagents' in metadata)) return null;
  const progress = parseSubagentProgress(metadata['aelix/subagents']);
  if (!progress) return null;
  const turnEnded = turn?.known === true && !turn.isProcessing;
  const terminal = progress.children.every(
    (child) => child.state === 'done' || child.state === 'error' || child.state === 'stopped'
  );
  const stopped = terminal && progress.children.some((child) => child.state === 'stopped');
  // Never infer an entire call's outcome from a filtered/incomplete child list.
  const projectParent =
    !progress.hasDiscardedChildren &&
    (parentStatus === 'running' || parentStatus === 'pending') &&
    (turnEnded || stopped);
  const children = turnEnded
    ? progress.children.map((child) =>
        child.state === 'starting' || child.state === 'running' ? { ...child, state: 'ended' as const } : child
      )
    : progress.children;
  return {
    progress: { ...progress, children },
    parentStatus: projectParent ? 'canceled' : parentStatus,
    interrupted: children.some(
      (child) => child.state === 'stopped' || child.state === 'error' || child.state === 'ended'
    ),
  };
};
