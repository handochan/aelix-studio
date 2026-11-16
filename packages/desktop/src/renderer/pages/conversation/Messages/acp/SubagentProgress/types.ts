export type SubagentState = 'starting' | 'running' | 'done' | 'error' | 'stopped' | 'unknown';

export type SubagentChild = {
  id: string;
  profile?: string;
  state: SubagentState;
  currentTool?: string;
  elapsedMs?: number;
  tokens?: number;
  cost?: number;
};

export type SubagentProgress = { version: 1; children: SubagentChild[] };
