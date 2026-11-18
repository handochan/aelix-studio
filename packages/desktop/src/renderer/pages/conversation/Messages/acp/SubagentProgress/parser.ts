import type { SubagentProgress, SubagentState } from './types';

const MAX_CHILDREN = 32;
const STATES: ReadonlySet<string> = new Set(['starting', 'running', 'done', 'error', 'stopped']);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string | undefined =>
  typeof value === 'string'
    ? value
        .replace(/\p{Cc}/gu, ' ')
        .slice(0, 256)
        .trim() || undefined
    : undefined;
const count = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER
    ? value
    : undefined;

/** Parse only the versioned metadata value; malformed/future contracts keep the generic tool view. */
export const parseSubagentProgress = (value: unknown): SubagentProgress | null => {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.children)) return null;
  const children: SubagentProgress['children'] = [];
  let hasDiscardedChildren = value.children.length > MAX_CHILDREN;
  const ids = new Set<string>();
  for (const entry of value.children.slice(0, MAX_CHILDREN)) {
    if (!isRecord(entry)) {
      hasDiscardedChildren = true;
      continue;
    }
    const id = text(entry.id);
    if (!id || ids.has(id)) {
      hasDiscardedChildren = true;
      continue;
    }
    ids.add(id);
    const tokens = count(entry.tokens);
    children.push({
      id,
      profile: text(entry.profile),
      state: typeof entry.state === 'string' && STATES.has(entry.state) ? (entry.state as SubagentState) : 'unknown',
      currentTool: text(entry.currentTool),
      elapsedMs: count(entry.elapsedMs),
      tokens: tokens === undefined ? undefined : Math.floor(tokens),
      cost: count(entry.cost),
    });
  }
  return children.length ? { version: 1, children, hasDiscardedChildren } : null;
};
