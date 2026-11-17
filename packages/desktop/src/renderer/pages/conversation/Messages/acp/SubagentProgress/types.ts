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
export type SubagentTurnSignal = { known: boolean; isProcessing: boolean };
export type SubagentPresentation = {
  progress: SubagentProgress;
  parentStatus: SubagentParentStatus;
  interrupted: boolean;
};
