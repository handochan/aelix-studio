export type AcpCompaction = {
  reason: 'manual' | 'threshold' | 'overflow';
  state: 'running' | 'completed' | 'failed' | 'aborted';
  tokensBefore?: number;
};

/** Read a compaction update forwarded by the host on an ACP tool call. */
export function readAcpCompaction(meta: unknown): AcpCompaction | null {
  if (typeof meta !== 'object' || !meta || !('aelix/compaction' in meta)) return null;
  const details = meta['aelix/compaction'];
  if (typeof details !== 'object' || !details || !('reason' in details) || !('state' in details)) return null;
  const { reason, state } = details;
  if (reason !== 'manual' && reason !== 'threshold' && reason !== 'overflow') return null;
  if (state !== 'running' && state !== 'completed' && state !== 'failed' && state !== 'aborted') return null;
  const tokensBefore = 'tokensBefore' in details ? details.tokensBefore : undefined;
  return {
    reason,
    state,
    ...(typeof tokensBefore === 'number' && Number.isSafeInteger(tokensBefore) && tokensBefore >= 0
      ? { tokensBefore }
      : {}),
  };
}
