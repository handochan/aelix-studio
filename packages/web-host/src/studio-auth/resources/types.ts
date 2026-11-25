export type ResourceKind = 'tool' | 'skill' | 'mcp';

export type PageRequest = { limit?: number; cursor?: never } | { limit?: never; cursor: string };

export type NativeResourcesCommand =
  | ({ action: 'profiles/list' } & PageRequest)
  | { action: 'profiles/show'; name: string }
  | ({ action: 'selections/list'; scope: 'global'; kind: ResourceKind } & PageRequest)
  | {
      action: 'selections/set';
      scope: 'global';
      kind: ResourceKind;
      expectedRevision: string;
      changes: { key: string; on: boolean }[];
      requestId: string;
    };

export const RESOURCE_ERROR_STATUS = {
  FORBIDDEN: 403,
  UNAUTHENTICATED: 401,
  FRAME_LIMIT: 413,
  INVALID_INPUT: 400,
  SCOPE_DENIED: 403,
  CURSOR_STALE: 409,
  PROFILE_UNAVAILABLE: 404,
  REVISION_CONFLICT: 409,
  SELECTION_MISSING: 422,
  SELECTION_LOCKED: 422,
  SCOPE_READONLY: 422,
  STORE_UNREADABLE: 422,
  BUSY: 409,
  REQUEST_ID_CONFLICT: 409,
  DEDUP_CAPACITY: 429,
  RUNTIME_UNAVAILABLE: 503,
  RESULT_TOO_LARGE: 413,
  SAVE_FAILED: 500,
  HELPER_UNAVAILABLE: 503,
  OUTCOME_UNKNOWN: 503,
} as const;

type ErrorCode = keyof typeof RESOURCE_ERROR_STATUS;

export type NativeResourcesError =
  | { ok: false; code: 'REVISION_CONFLICT'; currentRevision: string }
  | { ok: false; code: 'SELECTION_MISSING' | 'SELECTION_LOCKED'; key: string }
  | { ok: false; code: 'OUTCOME_UNKNOWN'; retryable: false }
  | {
      ok: false;
      code: Exclude<ErrorCode, 'REVISION_CONFLICT' | 'SELECTION_MISSING' | 'SELECTION_LOCKED' | 'OUTCOME_UNKNOWN'>;
    };

export type NativeResourcesReply = { ok: true; data: Record<string, unknown> } | NativeResourcesError;
