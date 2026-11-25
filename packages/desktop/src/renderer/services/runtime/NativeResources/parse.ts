import { isRecord } from '../RunningInput/transport';
import type {
  Diagnostic,
  GlobalProfiles,
  GlobalSelections,
  GlobalWrite,
  ProfileCatalog,
  ProfileApplied,
  ProfileDifference,
  ProfilePreview,
  ProfileRecovery,
  ProfileRef,
  ProjectWrite,
  ResourceChange,
  ResourceEffect,
  ResourceFailure,
  ResourceKind,
  ResourceMismatch,
  ResourceRow,
  ScopeStatus,
  SessionCapabilities,
  SessionProfiles,
  SessionSelections,
  SessionSource,
  ToolsApplied,
} from './types';

type Decoder<T> = (value: unknown) => T;
const invalid = Symbol('Invalid native resources value');

function requireValid(condition: unknown): asserts condition {
  if (!condition) throw invalid;
}

export function decode<T>(parse: Decoder<T>, value: unknown): T | undefined {
  try {
    return parse(value);
  } catch (error) {
    if (error === invalid) return undefined;
    throw error;
  }
}

export function record(value: unknown): Record<string, unknown> {
  requireValid(isRecord(value));
  return value;
}

function text(value: unknown): string {
  requireValid(typeof value === 'string');
  return value;
}

export function token(value: unknown): string {
  const result = text(value);
  // Reject control bytes in identifiers used in requests and display labels.
  // oxlint-disable-next-line no-control-regex
  requireValid(result.length > 0 && !/[\u0000-\u001f\u007f]/u.test(result));
  return result;
}

export function code(value: unknown): string {
  const result = text(value);
  requireValid(/^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/.test(result));
  return result;
}

function boolean(value: unknown): boolean {
  requireValid(typeof value === 'boolean');
  return value;
}

function integer(value: unknown): number {
  requireValid(typeof value === 'number' && Number.isSafeInteger(value));
  return value;
}

function natural(value: unknown): number {
  const result = integer(value);
  requireValid(result >= 0);
  return result;
}

function oneOf<const T extends string>(value: unknown, ...values: T[]): T {
  const result = values.find((candidate) => candidate === value);
  requireValid(result !== undefined);
  return result;
}

function nullable<T>(value: unknown, parse: Decoder<T>): T | null {
  return value === null ? null : parse(value);
}

function list<T>(value: unknown, parse: Decoder<T>): T[] {
  requireValid(Array.isArray(value));
  return Array.from(value, parse);
}

export function names(value: unknown): string[] {
  const result = list(value, token);
  requireValid(new Set(result).size === result.length);
  return result;
}

export function pageLimit(value: unknown): number {
  const result = natural(value);
  requireValid(result >= 1 && result <= 100);
  return result;
}

function relativeDisplay(value: unknown): string {
  const result = token(value);
  requireValid(!/[:\\]/u.test(result) && result.split('/').every((part) => part && part !== '.' && part !== '..'));
  return result;
}

function sourceDisplay(value: unknown): string {
  const result = token(value);
  const separator = result.indexOf(':');
  if (separator !== -1) {
    oneOf(result.slice(0, separator), 'bundled', 'user', 'project', 'global');
    relativeDisplay(result.slice(separator + 1));
  } else {
    relativeDisplay(result);
  }
  return result;
}

function profilePathLabel(value: unknown): string {
  const label = token(value);
  if (/^external:[^/:\\]+ \(sha256:[0-9a-f]{64}\)$/u.test(label)) return label;
  return sourceDisplay(label);
}

function boundedPrompt(value: unknown): string[] {
  // Retain horizontal tab and line break from the Markdown preview.
  // oxlint-disable-next-line no-control-regex
  return [...text(value).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/gu, '')];
}

export function profileName(value: unknown): string {
  const name = token(value);
  requireValid([...name].length <= 256 && name !== '--none' && name !== '.' && name !== '..' && !/[/:\\]/u.test(name));
  return name;
}

function profileScope(value: unknown): ProfileRef['scope'] {
  return oneOf(value, 'bundled', 'user', 'project');
}

function profileRevision(value: unknown): string {
  const revision = text(value);
  requireValid(/^sha256:[0-9a-f]{64}$/.test(revision));
  return revision;
}

export function profileRef(value: unknown): ProfileRef {
  const { name, scope, revision } = record(value);
  return { name: profileName(name), scope: profileScope(scope), revision: profileRevision(revision) };
}

export function sameProfile(a: ProfileRef | null, b: ProfileRef | null): boolean {
  if (!a || !b) return a === b;
  return a.name === b.name && a.scope === b.scope && a.revision === b.revision;
}

export function profilePreview(value: unknown, name: string, global: boolean): ProfilePreview {
  const profile = record(record(value).profile);
  const ref = profileRef(profile.ref);
  requireValid(ref.name === name && (!global || ref.scope !== 'project'));
  const source = sourceDisplay(profile.source);
  requireValid(source.startsWith(ref.scope + ':'));
  const prompt = boundedPrompt(profile.promptPreview);
  const policy = record(profile.policy);
  return {
    ref,
    source,
    description: text(profile.description),
    promptMode: oneOf(profile.promptMode, 'append', 'replace'),
    promptPreview: prompt.slice(0, 512).join(''),
    promptTruncated: boolean(profile.promptTruncated) || prompt.length > 512,
    provider: nullable(profile.provider, token),
    model: nullable(profile.model, token),
    tools: nullable(profile.tools, names),
    skills: nullable(profile.skills, (skills) => list(skills, profilePathLabel)),
    approvalMode: code(profile.approvalMode),
    policy: {
      builtinTools: boolean(policy.builtinTools),
      excludeTools: list(policy.excludeTools, token),
      inheritSkills: boolean(policy.inheritSkills),
      extensions: list(policy.extensions, profilePathLabel),
      inheritExtensions: boolean(policy.inheritExtensions),
      contextFiles: boolean(policy.contextFiles),
      thinking: nullable(policy.thinking, code),
      role: oneOf(policy.role, 'leaf', 'orchestrator'),
      outputCap: nullable(policy.outputCap, natural),
      timeoutMs: nullable(policy.timeoutMs, natural),
      agents: nullable(policy.agents, names),
    },
  };
}

function diagnostic(value: unknown): Diagnostic {
  const row = record(value);
  return { code: code(row.code), key: nullable(row.key, token), source: nullable(row.source, sourceDisplay) };
}

function matrix(value: unknown): ScopeStatus {
  const scope = record(value);
  return { writable: boolean(scope.writable), reason: nullable(scope.reason, code), exists: boolean(scope.exists) };
}

export function mismatches(value: unknown): ResourceMismatch[] {
  return list(value, (row) => {
    if (typeof row === 'string') return { key: null, reason: 'native-mismatch' };
    const mismatch = record(row);
    return { key: nullable(mismatch.key, token), reason: code(mismatch.reason) };
  });
}

function lock(value: unknown): NonNullable<ResourceRow['lock']> {
  const row = record(value);
  return { kind: code(row.kind), value: boolean(row.value), reason: code(row.reason) };
}

function resourceRow(value: unknown, global: boolean): ResourceRow {
  const row = record(value);
  const decidedBy = nullable(row.decidedBy, (scope) => oneOf(scope, 'global', 'project'));
  requireValid(!global || decidedBy !== 'project');
  return {
    key: token(row.key),
    label: text(row.label),
    role: oneOf(row.role, 'item', 'placeholder', 'info'),
    loaded: global ? null : nullable(row.loaded, boolean),
    saved: nullable(row.saved, boolean),
    decidedBy,
    applied: global ? null : nullable(row.applied, boolean),
    inForce: global ? null : nullable(row.inForce, boolean),
    live: global ? null : nullable(row.live, boolean),
    pending: global ? null : nullable(row.pending, boolean),
    lock: nullable(row.lock, lock),
    problem: nullable(row.problem, code),
    mismatches: [],
  };
}

function pageStatus(value: unknown) {
  const nextCursor = nullable(value, token);
  return { nextCursor, complete: nextCursor === null };
}

function activeProfile(row: Record<string, unknown>) {
  const activeAgent = nullable(row.activeAgent, profileName);
  const activeRef = nullable(row.activeRef, profileRef);
  // Legacy name-only selections may have no recorded ref.
  requireValid(!activeRef || activeRef.name === activeAgent);
  return { activeAgent, activeRef };
}

function profilePage(
  row: Record<string, unknown>,
  global: boolean
): Pick<ProfileCatalog, 'profiles' | 'inspected' | 'diagnostics' | 'nextCursor' | 'complete'> {
  return {
    profiles: list(row.profiles, (value) => {
      const entry = record(value);
      const ref = profileRef(entry.ref);
      requireValid(!global || ref.scope !== 'project');
      return { ref, description: text(entry.description) };
    }),
    inspected: null,
    diagnostics: list(row.diagnostics, diagnostic),
    ...pageStatus(row.nextCursor),
  };
}

export function sessionProfiles(value: unknown, source: SessionSource): SessionProfiles {
  const row = record(value);
  return { ...source, ...activeProfile(row), ...profilePage(row, false) };
}

export function globalProfiles(value: unknown): GlobalProfiles {
  return { source: 'global', activeAgent: null, activeRef: null, ...profilePage(record(value), true) };
}

export function resourceKind(value: unknown): ResourceKind {
  return oneOf(value, 'tool', 'skill', 'mcp');
}

function effect(value: unknown, kind: ResourceKind): ResourceEffect {
  const expected = kind === 'mcp' ? 'restart' : 'next_request';
  requireValid(value === expected);
  return expected;
}

function selectionPage(
  row: Record<string, unknown>,
  kind: ResourceKind,
  global: boolean
): Pick<SessionSelections, 'kind' | 'items' | 'diagnostics' | 'mismatches' | 'nextCursor' | 'complete'> {
  requireValid(row.kind === kind);
  return {
    kind,
    items: list(row.items, (entry) => resourceRow(entry, global)),
    diagnostics: list(row.diagnostics, diagnostic),
    mismatches: [],
    ...pageStatus(row.nextCursor),
  };
}

export function sessionSelections(value: unknown, source: SessionSource, kind: ResourceKind): SessionSelections {
  const row = record(value);
  const scopes = record(row.scopes);
  const global = matrix(scopes.global);
  const toolOverride = nullable(row.toolOverride, names);
  const activeTools = nullable(row.activeTools, names);
  requireValid(!global.writable && global.reason === 'management-helper');
  requireValid(kind === 'tool' || (toolOverride === null && activeTools === null));
  return {
    ...source,
    ...selectionPage(row, kind, false),
    effect: effect(row.effect, kind),
    scopes: { global, project: matrix(scopes.project) },
    policyPending: boolean(row.policyPending),
    toolOverride,
    activeTools,
  };
}

export function globalSelections(value: unknown, kind: ResourceKind): GlobalSelections {
  const row = record(value);
  requireValid(row.scope === 'global');
  effect(row.effect, kind);
  return {
    source: 'global',
    ...selectionPage(row, kind, true),
    revision: token(row.revision),
    effect: 'next_worker',
    scopes: { global: matrix(row) },
    policyPending: null,
    toolOverride: null,
    activeTools: null,
  };
}

export function profileApplied(value: unknown, profile: ProfileRef | null): ProfileApplied {
  const row = record(value);
  const active = activeProfile(row);
  requireValid(row.accepted === true && row.toolOverride === null);
  requireValid(sameProfile(active.activeRef, profile) && active.activeAgent === (profile?.name ?? null));
  return { accepted: true, ...active, toolOverride: null };
}

export function toolsApplied(value: unknown, requested: readonly string[]): ToolsApplied {
  const row = record(value);
  requireValid(row.accepted === true);
  const toolOverride = names(row.toolOverride);
  const requestedNames = new Set(requested);
  requireValid(toolOverride.length === requested.length && toolOverride.every((name) => requestedNames.has(name)));
  return { accepted: true, toolOverride, activeTools: names(row.activeTools) };
}

function savedChanges(value: unknown) {
  return list(value, (entry) => {
    const row = record(entry);
    return { key: token(row.key), saved: boolean(row.saved) };
  });
}

function applyStatus(value: unknown) {
  const row = record(value);
  const applied = boolean(row.applied);
  const deferred = boolean(row.deferred);
  requireValid(!(applied && deferred));
  return {
    applied,
    deferred,
    turnedOn: names(row.turnedOn),
    turnedOff: names(row.turnedOff),
    warning: nullable(row.warning, code),
  };
}

export function projectWrite(value: unknown, kind: ResourceKind): ProjectWrite {
  const row = record(value);
  requireValid(row.accepted === true && row.scope === 'project' && row.kind === kind);
  requireValid((kind === 'mcp') === (row.apply === null));
  return {
    accepted: true,
    scope: 'project',
    kind,
    effect: effect(row.effect, kind),
    written: list(row.written, relativeDisplay),
    changed: savedChanges(row.changed),
    mismatches: mismatches(row.mismatches),
    apply: nullable(row.apply, applyStatus),
  };
}

export function globalWrite(value: unknown, kind: ResourceKind): GlobalWrite {
  const row = record(value);
  requireValid(row.saved === true && row.scope === 'global' && row.kind === kind && row.appliesAt === 'next_worker');
  return {
    scope: 'global',
    kind,
    revision: token(row.revision),
    saved: true,
    changed: savedChanges(row.changed),
    mismatches: mismatches(row.mismatches),
    appliesAt: 'next_worker',
  };
}

export function selectionChanges(value: unknown, snapshot: { items: readonly ResourceRow[] }): ResourceChange[] {
  const changes = list(value, (entry) => {
    const row = record(entry);
    return { key: token(row.key), on: boolean(row.on) };
  });
  requireValid(changes.length >= 1 && changes.length <= 1024);
  const knownKeys = new Set(snapshot.items.filter(({ role }) => role === 'item').map(({ key }) => key));
  for (const { key } of changes) requireValid(knownKeys.delete(key));
  return changes;
}

function profileRecovery(value: unknown): ProfileRecovery {
  const row = record(value);
  return { action: oneOf(row.action, 'restore-original-and-reopen'), original: nullable(row.original, profileRef) };
}

const profileDifferenceFields = {
  source(value) {
    const source = token(value);
    const separator = source.indexOf(':');
    // ACP can report just the scope when the earlier preview is missing.
    if (separator === -1) return profileScope(source);
    profileScope(source.slice(0, separator));
    relativeDisplay(source.slice(separator + 1));
    return source;
  },
  revision: profileRevision,
  description: text,
  promptMode: (value) => oneOf(value, 'append', 'replace'),
  promptPreview(value) {
    const prompt = text(value);
    const safe = boundedPrompt(prompt);
    requireValid(safe.length <= 512 && safe.join('') === prompt);
    return prompt;
  },
  promptTruncated: boolean,
  omittedPrompt: (value) =>
    nullable(value, (entry) => {
      const digest = text(entry);
      requireValid(/^[0-9a-f]{64}$/.test(digest));
      return digest;
    }),
  provider: (value) => nullable(value, token),
  model: (value) => nullable(value, token),
  tools: (value) => nullable(value, (entry) => list(entry, token)),
  skills: (value) => list(value, profilePathLabel),
  approvalMode: (value) => oneOf(value, 'inherit', 'ask', 'auto', 'deny'),
  builtinTools: boolean,
  excludeTools: (value) => list(value, token),
  inheritSkills: boolean,
  extensions: (value) => list(value, profilePathLabel),
  inheritExtensions: boolean,
  contextFiles: boolean,
  thinking: (value) => nullable(value, code),
  role: (value) => oneOf(value, 'leaf', 'orchestrator'),
  outputCap(value) {
    const bytes = integer(value);
    requireValid(bytes > 0);
    return bytes;
  },
  // Native retains signed legacy timeout metadata for display.
  timeoutMs: (value) => nullable(value, integer),
  agents: (value) => nullable(value, (entry) => names(entry).map(profileName)),
} satisfies Record<string, Decoder<ProfileDifference['before']>>;

function profileDifference(entry: unknown): ProfileDifference {
  const row = record(entry);
  requireValid(typeof row.field === 'string' && Object.hasOwn(profileDifferenceFields, row.field));
  const field = row.field as keyof typeof profileDifferenceFields;
  const difference = profileDifferenceFields[field];
  return { field, before: difference(row.before), after: difference(row.after) };
}

type SessionMethod = Exclude<keyof SessionCapabilities, 'bindingId'>;
const mutations = ['profilesUse', 'setActiveTools', 'selectionsSet'] as const;
const lists = ['profilesList', 'selectionsList'] as const;
const refusalMethods = {
  busy: mutations,
  unsupported: [...lists, 'profilesShow', ...mutations],
  'cursor-stale': lists,
  // D16's relay-error-large-item case excludes profiles/use.
  'result-too-large': [...lists, 'profilesShow', 'setActiveTools'],
  'profile-unavailable': ['profilesShow', 'profilesUse'],
  'profile-refused': ['profilesUse'],
  'tool-unavailable': ['setActiveTools'],
  'tool-locked': ['setActiveTools'],
  'selection-missing': ['selectionsSet'],
  'selection-locked': ['selectionsSet'],
  'scope-readonly': ['selectionsSet'],
  unreadable: [...lists, 'selectionsSet'],
  'write-failed': mutations,
  'dedup-capacity': mutations,
  'profile-changed': ['profilesUse'],
  'consent-required': ['profilesUse', 'selectionsSet'],
} satisfies Record<string, readonly SessionMethod[]>;

export function relayRefusal(value: unknown, method: SessionMethod, writing: boolean): ResourceFailure {
  const row = record(value);
  requireValid(row.accepted === false);
  const reason = code(row.reason);
  if (!Object.hasOwn(refusalMethods, reason)) {
    requireValid(!writing);
    return { status: 'error', reason, action: 'refresh', retryWrite: false };
  }
  const allowed: readonly SessionMethod[] = refusalMethods[reason as keyof typeof refusalMethods];
  requireValid(allowed.includes(method));
  if (reason === 'profile-changed') {
    return {
      status: 'conflict',
      reason,
      action: 'refresh-and-choose',
      retryWrite: false,
      recorded: profileRef(row.recorded),
      candidate: nullable(row.candidate, profileRef),
      differences: list(row.differences, profileDifference),
      recovery: profileRecovery(row.recovery),
    };
  }
  if (reason === 'unsupported') return { status: 'unsupported', reason, action: 'disable-control', retryWrite: false };
  if (reason === 'cursor-stale') return { status: 'stale', reason, action: 'refresh', retryWrite: false };
  const refusal: ResourceFailure = {
    status: 'refused',
    reason,
    action: reason === 'busy' ? 'wait-idle' : 'refresh',
    retryWrite: false,
  };
  switch (reason) {
    case 'tool-locked':
    case 'tool-unavailable':
      return { ...refusal, key: token(row.key) };
    case 'profile-unavailable':
      return { ...refusal, name: profileName(row.name) };
    case 'selection-locked':
    case 'selection-missing':
      return {
        ...refusal,
        scope: oneOf(row.scope, 'project'),
        written: list(row.written, relativeDisplay),
        mismatches: mismatches(row.mismatches),
      };
    case 'scope-readonly':
      return { ...refusal, scope: oneOf(row.scope, 'project'), written: list(row.written, relativeDisplay) };
    case 'consent-required': {
      const cause = oneOf(row.cause, 'declined', 'cancelled', 'unanswered');
      if (method === 'profilesUse') {
        const recovery = profileRecovery(row.recovery);
        return { status: 'recovery-required', reason: cause, ...recovery, retryWrite: false };
      }
      return { ...refusal, cause, scope: oneOf(row.scope, 'project'), written: list(row.written, relativeDisplay) };
    }
    default:
      return refusal;
  }
}

/** Validate the safe error fragment when it is available from the existing session/load path. */
export function loadRecovery(value: unknown): ResourceFailure {
  const row = record(value);
  requireValid(row.code === -32004);
  const data = record(row.data);
  if (data.kind === 'profile_unavailable') {
    return {
      status: 'recovery-required',
      reason: 'profile-unavailable',
      name: profileName(data.profile),
      action: 'restore-original-and-reopen',
      retryWrite: false,
    };
  }
  requireValid(data.kind === 'profile_reselection_required');
  return {
    status: 'recovery-required',
    reason: code(data.reason),
    ...profileRecovery(data.recovery),
    retryWrite: false,
  };
}
