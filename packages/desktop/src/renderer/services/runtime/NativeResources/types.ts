export type ResourceKind = 'tool' | 'skill' | 'mcp';
export type ResourceEffect = 'next_request' | 'restart';
export type ProfileScope = 'bundled' | 'user' | 'project';
export type ProfileRef = { name: string; scope: ProfileScope; revision: string };

export type ProfilePolicy = {
  builtinTools: boolean;
  excludeTools: readonly string[];
  inheritSkills: boolean;
  extensions: readonly string[];
  inheritExtensions: boolean;
  contextFiles: boolean;
  thinking: string | null;
  role: string;
  outputCap: number | null;
  timeoutMs: number | null;
  agents: readonly string[] | null;
};

export type ProfilePreview = {
  ref: ProfileRef;
  source: string;
  description: string;
  promptMode: string;
  promptPreview: string;
  promptTruncated: boolean;
  provider: string | null;
  model: string | null;
  tools: readonly string[] | null;
  skills: readonly string[] | null;
  approvalMode: string;
  policy: ProfilePolicy;
};

export type Diagnostic = { code: string; key: string | null; source: string | null };
export type ScopeStatus = { writable: boolean; reason: string | null; exists: boolean };
export type ResourceMismatch = { key: string | null; reason: string };
export type ResourceChange = { key: string; on: boolean };
export type ResourceRow = {
  key: string;
  label: string;
  role: 'item' | 'placeholder' | 'info';
  loaded: boolean | null;
  saved: boolean | null;
  decidedBy: 'global' | 'project' | null;
  applied: boolean | null;
  inForce: boolean | null;
  live: boolean | null;
  pending: boolean | null;
  lock: { kind: string; value: boolean; reason: string } | null;
  problem: string | null;
  mismatches: readonly ResourceMismatch[];
};

export type PageStatus = { complete: boolean; nextCursor: string | null };
export type SessionSource = { source: 'session'; conversationId: string; bindingId: string };
type GlobalSource = { source: 'global' };
type SelectionList = PageStatus & {
  kind: ResourceKind;
  items: readonly ResourceRow[];
  diagnostics: readonly Diagnostic[];
  mismatches: readonly ResourceMismatch[];
};
export type SessionSelections = SessionSource &
  SelectionList & {
    effect: ResourceEffect;
    scopes: { global: ScopeStatus; project: ScopeStatus };
    policyPending: boolean;
    toolOverride: readonly string[] | null;
    activeTools: readonly string[] | null;
  };
export type GlobalSelections = GlobalSource &
  SelectionList & {
    revision: string;
    effect: 'next_worker';
    scopes: { global: ScopeStatus };
    policyPending: null;
    toolOverride: null;
    activeTools: null;
  };
export type ProfileCatalog = PageStatus & {
  activeAgent: string | null;
  activeRef: ProfileRef | null;
  inspected: ProfilePreview | null;
  profiles: readonly { ref: ProfileRef; description: string }[];
  diagnostics: readonly Diagnostic[];
};
export type SessionProfiles = SessionSource & ProfileCatalog;
export type GlobalProfiles = GlobalSource & ProfileCatalog;
export type SessionCapabilities = {
  bindingId: string;
  profilesList: boolean;
  profilesShow: boolean;
  profilesUse: boolean;
  setActiveTools: boolean;
  selectionsList: boolean;
  selectionsSet: boolean;
  lookup: boolean;
};

export type ProfileRecovery = { action: 'restore-original-and-reopen'; original: ProfileRef | null };
export type ProfileDifference = {
  field: string;
  before: string | number | boolean | null | readonly string[];
  after: string | number | boolean | null | readonly string[];
};
export type ResourceFailure = {
  status:
    | 'detached'
    | 'stale'
    | 'refused'
    | 'conflict'
    | 'unauthenticated'
    | 'unknown'
    | 'unsupported'
    | 'invalid-response'
    | 'recovery-required'
    | 'error'
    | 'invalid-input';
  reason: string;
  action:
    | 'rediscover-on-attach'
    | 'rediscover'
    | 'wait-idle'
    | 'refresh-and-choose'
    | 'sign-in-and-read'
    | 'lookup-and-refresh'
    | 'disable-control'
    | 'refresh'
    | 'restore-original-and-reopen';
  retryWrite: false;
  original?: ProfileRef | null;
  recovery?: ProfileRecovery;
  recorded?: ProfileRef;
  candidate?: ProfileRef | null;
  differences?: readonly ProfileDifference[];
  currentRevision?: string;
  key?: string;
  name?: string;
  cause?: string;
  scope?: 'project';
  written?: readonly string[];
  mismatches?: readonly ResourceMismatch[];
};
export type ResourceResult<T> = { status: 'success'; data: T } | ResourceFailure;

export type ProfileApplied = {
  accepted: true;
  activeAgent: string | null;
  activeRef: ProfileRef | null;
  toolOverride: null;
};
export type ToolsApplied = { accepted: true; toolOverride: readonly string[]; activeTools: readonly string[] };
type SavedChange = { key: string; saved: boolean };
export type ProjectWrite = {
  accepted: true;
  scope: 'project';
  kind: ResourceKind;
  effect: ResourceEffect;
  written: readonly string[];
  changed: readonly SavedChange[];
  mismatches: readonly ResourceMismatch[];
  apply: {
    applied: boolean;
    deferred: boolean;
    turnedOn: readonly string[];
    turnedOff: readonly string[];
    warning: string | null;
  } | null;
};
export type GlobalWrite = {
  scope: 'global';
  kind: ResourceKind;
  revision: string;
  saved: true;
  changed: readonly SavedChange[];
  mismatches: readonly ResourceMismatch[];
  appliesAt: 'next_worker';
};
export type WriteReport<T, State> = {
  outcome: ResourceResult<T>;
  requestId?: string;
  receipt?: 'completed' | 'pending' | 'unknown' | 'unavailable';
  refresh?: ResourceResult<State>;
};
