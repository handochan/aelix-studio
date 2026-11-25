export type SubagentState = 'starting' | 'running' | 'done' | 'error' | 'stopped' | 'unknown' | 'ended';

export type SubagentChild = {
  id: string;
  profile?: string;
  state: SubagentState;
  currentTool?: string;
  elapsedMs?: number;
  tokens?: number;
  cost?: number;
};

export type SubagentProgress = { version: 1; children: SubagentChild[]; hasDiscardedChildren: boolean };

export type SubagentParentStatus = 'pending' | 'running' | 'completed' | 'error' | 'canceled';
export type SubagentPresentation = {
  progress: SubagentProgress;
  parentStatus: SubagentParentStatus;
  /** The call's own reported status, before any projection from child states. */
  callStatus: SubagentParentStatus;
  interrupted: boolean;
};

/** One submitted position of a cancelled batch, in native's own task/step order. */
export type CancelReportEntry =
  | { position: number; kind: 'ran'; text: string }
  | { position: number; kind: 'lost' | 'idle' };

/**
 * What a cancelled `agent` call reported about its children (aelix-ai #800).
 * `single` is the one child of a single-mode call; `batch` is keyed by the
 * submitted position native addressed, never by a progress-row ID.
 */
export type CancelReport =
  | { kind: 'single'; text: string }
  | { kind: 'batch'; noun: 'task' | 'step'; total: number; entries: CancelReportEntry[] };

/** The report section's state for one cancelled parent call. */
export type CancelReportView = CancelReport | { kind: 'missing' } | { kind: 'unreadable' } | { kind: 'loadFailed' };
