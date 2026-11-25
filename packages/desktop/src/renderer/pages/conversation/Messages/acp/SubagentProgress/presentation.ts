import { parseSubagentProgress } from './parser';
import type { SubagentParentStatus, SubagentPresentation } from './types';

/**
 * Adapt the extension once at the narrow boundary; no store access or subscriptions.
 * Only an explicitly terminal parent ends unreported child states. Conversation
 * idle is not a call-ended signal: Team, cron and other clients can start live
 * turns without updating this renderer's runtime view. Even the first frame
 * must keep its reported state; waiting for a second frame would flash "ended".
 * Reopened in-progress calls without terminal children retain their spinner.
 * Reconciliation needs a per-call ended signal or a matching host turn ID.
 * backend_turn_id is a provider fork anchor, not the host runtime turn ID.
 * Before the first extension frame there is no subagent identity to reconcile;
 * generic tool states remain unchanged.
 * A stopped child followed by a new child is unreachable in the pinned native;
 * future S3 needs an explicit lifecycle contract rather than this projection.
 */
export const presentSubagentTool = (
  metadata: unknown,
  parentStatus: SubagentParentStatus
): SubagentPresentation | null => {
  if (typeof metadata !== 'object' || metadata === null || !('aelix/subagents' in metadata)) return null;
  const progress = parseSubagentProgress(metadata['aelix/subagents']);
  if (!progress) return null;
  const parentEnded = parentStatus === 'completed' || parentStatus === 'error' || parentStatus === 'canceled';
  const terminal = progress.children.every(
    (child) => child.state === 'done' || child.state === 'error' || child.state === 'stopped'
  );
  const stopped = terminal && progress.children.some((child) => child.state === 'stopped');
  // Never infer an entire call's outcome from a filtered/incomplete child list.
  const projectParent =
    !progress.hasDiscardedChildren && (parentStatus === 'running' || parentStatus === 'pending') && stopped;
  const children = parentEnded
    ? progress.children.map((child) =>
        child.state === 'starting' || child.state === 'running' ? { ...child, state: 'ended' as const } : child
      )
    : progress.children;
  return {
    progress: { ...progress, children },
    parentStatus: projectParent ? 'canceled' : parentStatus,
    callStatus: parentStatus,
    interrupted: children.some(
      (child) => child.state === 'stopped' || child.state === 'error' || child.state === 'ended'
    ),
  };
};
