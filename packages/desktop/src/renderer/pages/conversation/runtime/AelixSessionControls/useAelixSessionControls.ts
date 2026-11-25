/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { wsEmitter } from '@/common/adapter/httpBridge';
import {
  createNativeResources,
  type NativeSessionResources,
  type ProfileCatalogView,
  type ProfilePreview,
  type ProfileRef,
  type ResourceFailure,
  type ResourceResult,
  type SessionCapabilities,
  type SessionProfiles,
  type SessionSelections,
  type WriteReport,
} from '@/renderer/services/runtime/NativeResources';
import type { HostTurnState } from '@/renderer/services/runtime/RunningInput/decideSend';
import { useLatestRef } from '@/renderer/hooks/ui/useLatestRef';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { sameRef } from './labels';

/** Upper bound on continuation reads for one list, so a misbehaving cursor chain cannot spin. */
const PAGE_LIMIT = 25;

export type Availability =
  | { kind: 'checking' }
  | { kind: 'detached' }
  | { kind: 'update-required' }
  | { kind: 'sign-in' }
  | { kind: 'error' }
  | { kind: 'ready'; capabilities: SessionCapabilities };

export type ControlsPanel = 'profile' | 'tools';
export type WriteTarget = 'profile' | 'tools' | 'restore';
export type ControlsNotice = {
  tone: 'success' | 'info' | 'warning' | 'error';
  /** Key under `conversation.aelixControls.notice`. */
  key: string;
  values?: Record<string, string | number>;
};

/** What the user last confirmed before a write, kept so recovery can restore only picked items. */
export type Baseline = {
  profile: ProfileRef | null;
  activeAgent: string | null;
  /** `undefined` when the tool override was never read; `null` means inherit; `[]` means no tools. */
  toolOverride: readonly string[] | null | undefined;
};

export type RecoveryState = { failure: ResourceFailure; baseline: Baseline };
export type RestoreChoice = { profile: boolean; tools: boolean };

export type AelixSessionControlsOptions = {
  conversationId: string;
  /** Builtin Aelix conversation outside Team mode. Other agents never mount the controls. */
  enabled: boolean;
  hostState: HostTurnState;
  /** Existing model controls own their refresh; this asks them to read again after a profile change. */
  onProfileApplied?: () => void;
};

export type AelixSessionControls = {
  conversationId: string;
  enabled: boolean;
  availability: Availability;
  profiles?: ProfileCatalogView<SessionProfiles>;
  profilesFailure?: ResourceFailure;
  tools?: SessionSelections;
  toolsFailure?: ResourceFailure;
  skills?: SessionSelections;
  preview?: ProfilePreview;
  previewName: string | null;
  previewFailure?: ResourceFailure;
  writing: WriteTarget | null;
  /** Writes only run while the conversation is idle and attached. */
  writeBlocked: 'busy' | 'not-idle' | null;
  notice?: ControlsNotice;
  conflict?: ResourceFailure;
  recovery?: RecoveryState;
  panel: ControlsPanel | null;
  openPanel: (panel: ControlsPanel | null) => void;
  refresh: () => Promise<void>;
  inspect: (name: string) => Promise<void>;
  /**
   * `inheritTools` marks a profile write made to return this conversation's tools to inherited.
   * Resolves true only when the runtime accepted the profile.
   */
  applyProfile: (ref: ProfileRef | null, options?: { inheritTools?: boolean }) => Promise<boolean>;
  /** Resolves true only when the runtime accepted the selection. */
  saveTools: (names: readonly string[]) => Promise<boolean>;
  reselect: () => Promise<void>;
  keepCurrent: () => void;
  restore: (choice: RestoreChoice) => Promise<void>;
  dismissNotice: () => void;
  dismissRecovery: () => void;
};

type State = Omit<
  AelixSessionControls,
  | 'conversationId'
  | 'enabled'
  | 'writeBlocked'
  | 'panel'
  | 'openPanel'
  | 'refresh'
  | 'inspect'
  | 'applyProfile'
  | 'saveTools'
  | 'reselect'
  | 'keepCurrent'
  | 'restore'
  | 'dismissNotice'
  | 'dismissRecovery'
> & { conflictBaseline?: Baseline };

const INITIAL: State = {
  availability: { kind: 'checking' },
  previewName: null,
  writing: null,
};

type Session = { conversationId: string; resources: NativeSessionResources };

function availabilityFor(failure: ResourceFailure): Availability | undefined {
  switch (failure.status) {
    case 'detached':
      return { kind: 'detached' };
    case 'unsupported':
      return { kind: 'update-required' };
    case 'unauthenticated':
      return { kind: 'sign-in' };
    case 'stale':
      // A newer discovery superseded this one, or the client was disposed.
      return undefined;
    default:
      return { kind: 'error' };
  }
}

async function completeProfiles(
  resources: NativeSessionResources,
  first: ResourceResult<SessionProfiles>
): Promise<ResourceResult<SessionProfiles>> {
  let page = first;
  for (let read = 0; page.status === 'success' && !page.data.complete && read < PAGE_LIMIT; read++) {
    // oxlint-disable-next-line no-await-in-loop -- each continuation needs the previous page's cursor
    page = await resources.nextProfiles(page.data);
  }
  return page;
}

async function completeSelections(
  resources: NativeSessionResources,
  first: ResourceResult<SessionSelections> | undefined
): Promise<ResourceResult<SessionSelections> | undefined> {
  let page = first;
  for (let read = 0; page?.status === 'success' && !page.data.complete && read < PAGE_LIMIT; read++) {
    // oxlint-disable-next-line no-await-in-loop -- each continuation needs the previous page's cursor
    page = await resources.nextSelections(page.data);
  }
  return page;
}

function refusalNotice(failure: ResourceFailure, target: WriteTarget): ControlsNotice {
  if (failure.status === 'unknown') return { tone: 'warning', key: 'outcomeUnknown' };
  if (failure.status === 'detached') return { tone: 'info', key: 'openFirst' };
  if (failure.status === 'stale') return { tone: 'warning', key: 'stale' };
  if (failure.status === 'unauthenticated') return { tone: 'warning', key: 'signIn' };
  if (failure.status === 'unsupported') return { tone: 'warning', key: 'updateRequired' };
  switch (failure.reason) {
    case 'busy':
      return { tone: 'warning', key: 'busy' };
    case 'tool-locked':
      return { tone: 'error', key: 'toolLocked', values: { name: failure.key ?? '' } };
    case 'tool-unavailable':
      return { tone: 'error', key: 'toolUnavailable', values: { name: failure.key ?? '' } };
    case 'profile-unavailable':
      return { tone: 'error', key: 'profileUnavailable', values: { name: failure.name ?? '' } };
    case 'profile-refused':
      return { tone: 'error', key: 'profileRefused' };
    case 'write-failed':
      return { tone: 'error', key: 'writeFailed' };
    default:
      return { tone: 'error', key: target === 'tools' ? 'toolsFailed' : 'profileFailed' };
  }
}

/**
 * Conversation-side state for the builtin Aelix profile and per-conversation tool controls.
 * It discovers the host relay without creating a turn, re-reads after attach, writes only on
 * an explicit choice while idle, and never re-sends a write or a prompt by itself.
 */
export function useAelixSessionControls({
  conversationId,
  enabled,
  hostState,
  onProfileApplied,
}: AelixSessionControlsOptions): AelixSessionControls {
  const [session, setSession] = useState<Session | null>(null);
  const [state, setState] = useState<State>(INITIAL);
  const [panel, setPanel] = useState<ControlsPanel | null>(null);
  const sessionRef = useLatestRef(session);
  const stateRef = useLatestRef(state);
  const hostRef = useLatestRef(hostState);
  const appliedRef = useLatestRef(onProfileApplied);
  const readRun = useRef(0);
  const writingRef = useRef(false);

  useEffect(() => {
    setState(INITIAL);
    setPanel(null);
    if (!enabled) return;
    const client = createNativeResources();
    let next: Session;
    try {
      next = { conversationId, resources: client.session(conversationId) };
    } catch {
      client.dispose();
      setState({ ...INITIAL, availability: { kind: 'error' } });
      return;
    }
    setSession(next);
    return () => {
      readRun.current++;
      client.dispose();
      setSession((current) => (current === next ? null : current));
    };
  }, [conversationId, enabled]);

  const current = useCallback((target: Session) => sessionRef.current === target, [sessionRef]);

  const patch = useCallback(
    (target: Session, update: Partial<State> | ((previous: State) => Partial<State>)) => {
      if (!current(target)) return;
      setState((previous) => ({ ...previous, ...(typeof update === 'function' ? update(previous) : update) }));
    },
    [current]
  );

  /** Read profiles, tools, and skills to completion. Lists the runtime does not offer stay empty. */
  const readLists = useCallback(
    async (target: Session, capabilities: SessionCapabilities, run: number) => {
      const { resources } = target;
      const profiles = capabilities.profilesList
        ? resources.listProfiles().then((first) => completeProfiles(resources, first))
        : undefined;
      const tools = capabilities.selectionsList
        ? resources.listSelections('tool').then((first) => completeSelections(resources, first))
        : undefined;
      const skills = capabilities.selectionsList
        ? resources.listSelections('skill').then((first) => completeSelections(resources, first))
        : undefined;
      const [profileList, toolList, skillList] = await Promise.all([profiles, tools, skills]);
      if (readRun.current !== run) return;
      patch(target, (previous) => ({
        profiles: profileList?.status === 'success' ? resources.profileView() : undefined,
        profilesFailure: profileList && profileList.status !== 'success' ? profileList : undefined,
        tools: toolList?.status === 'success' ? toolList.data : undefined,
        toolsFailure: toolList && toolList.status !== 'success' ? toolList : undefined,
        skills: skillList?.status === 'success' ? skillList.data : previous.skills,
      }));
      const name = stateRef.current.previewName;
      if (name && capabilities.profilesShow && profileList?.status === 'success') {
        const shown = await resources.showProfile(name);
        // The user may have picked another profile while this re-read was in flight.
        if (readRun.current !== run || stateRef.current.previewName !== name) return;
        patch(target, {
          preview: shown.status === 'success' ? shown.data : undefined,
          previewFailure: shown.status === 'success' ? undefined : shown,
        });
      }
    },
    [patch, stateRef]
  );

  const refresh = useCallback(async () => {
    const target = sessionRef.current;
    if (!target || writingRef.current) return;
    const run = ++readRun.current;
    patch(target, (previous) =>
      previous.availability.kind === 'ready' ? {} : { availability: { kind: 'checking' } as const }
    );
    const found = await target.resources.discover();
    if (readRun.current !== run || !current(target)) return;
    if (found.status !== 'success') {
      const availability = availabilityFor(found);
      if (!availability) return;
      patch(target, {
        availability,
        profiles: undefined,
        tools: undefined,
        skills: undefined,
        preview: undefined,
        profilesFailure: undefined,
        toolsFailure: undefined,
      });
      return;
    }
    patch(target, { availability: { kind: 'ready', capabilities: found.data } });
    await readLists(target, found.data, run);
  }, [current, patch, readLists, sessionRef]);

  // Discover on mount and again whenever the host turn state moves, which covers the first
  // attach after `EXT_NO_LIVE_TASK`. Discovery is a GET and never starts a turn.
  const lastHost = useRef<{ session: Session; host: HostTurnState } | null>(null);
  useEffect(() => {
    if (!session) return;
    const previous = lastHost.current?.session === session ? lastHost.current.host : null;
    lastHost.current = { session, host: hostState };
    if (previous !== null) {
      if (previous === hostState) return;
      const ready = stateRef.current.availability.kind === 'ready';
      if (ready && hostState !== 'unknown') return;
      if (hostState === 'unknown' && !writingRef.current) session.resources.invalidate();
    }
    void refresh();
  }, [session, hostState, refresh, stateRef]);

  useEffect(() => {
    if (!session) return;
    return wsEmitter('realtime.reconnected').on(() => {
      if (writingRef.current) return;
      session.resources.invalidate();
      void refresh();
    });
  }, [session, refresh]);

  const openPanel = useCallback(
    (next: ControlsPanel | null) => {
      setPanel(next);
      // Re-list on screen return so changes made by the CLI or another tab show up.
      if (next) void refresh();
    },
    [refresh]
  );

  const inspect = useCallback(
    async (name: string) => {
      const target = sessionRef.current;
      if (!target) return;
      patch(target, { previewName: name, preview: undefined, previewFailure: undefined });
      const shown = await target.resources.showProfile(name);
      if (stateRef.current.previewName !== name) return;
      patch(target, {
        preview: shown.status === 'success' ? shown.data : undefined,
        previewFailure: shown.status === 'success' ? undefined : shown,
      });
    },
    [patch, sessionRef, stateRef]
  );

  const baseline = useCallback((): Baseline => {
    const { profiles, tools } = stateRef.current;
    return {
      profile: profiles?.activeRef ?? null,
      activeAgent: profiles?.activeAgent ?? null,
      toolOverride: tools ? tools.toolOverride : undefined,
    };
  }, [stateRef]);

  const writable = useCallback(() => {
    const { availability } = stateRef.current;
    if (availability.kind !== 'ready' || writingRef.current || hostRef.current !== 'idle') return undefined;
    return availability.capabilities;
  }, [hostRef, stateRef]);

  /** Show the lists the write reported, finishing pagination from the exact DTO it returned. */
  const settleLists = useCallback(
    async (target: Session, profileRefresh?: ResourceResult<SessionProfiles>) => {
      const { resources } = target;
      const run = ++readRun.current;
      const [profileList, toolList, skillList] = await Promise.all([
        profileRefresh ? completeProfiles(resources, profileRefresh) : undefined,
        completeSelections(resources, peek(resources, 'tool')),
        completeSelections(resources, peek(resources, 'skill')),
      ]);
      if (readRun.current !== run) return;
      patch(target, (previous) => ({
        profiles: profileList?.status === 'success' ? resources.profileView() : previous.profiles,
        tools: toolList?.status === 'success' ? toolList.data : previous.tools,
        skills: skillList?.status === 'success' ? skillList.data : previous.skills,
      }));
    },
    [patch]
  );

  const runWrite = useCallback(
    async <T, S>(
      target: Session,
      kind: WriteTarget,
      write: () => Promise<WriteReport<T, S>>
    ): Promise<WriteReport<T, S> | undefined> => {
      writingRef.current = true;
      patch(target, { writing: kind, notice: undefined });
      try {
        return await write();
      } finally {
        writingRef.current = false;
        patch(target, { writing: null });
      }
    },
    [patch]
  );

  /** Turn a write outcome into what the user sees. Never retries the write. */
  const settle = useCallback(
    async (
      target: Session,
      kind: WriteTarget,
      outcome: ResourceFailure | { status: 'success' },
      before: Baseline,
      done: ControlsNotice,
      reselected = false
    ) => {
      if (outcome.status === 'success') {
        patch(target, { notice: done, conflict: undefined, conflictBaseline: undefined });
        return;
      }
      if (outcome.status === 'conflict' && outcome.reason === 'profile-changed') {
        if (reselected) {
          // Decision 2 allows one reselection. A second change ends in recovery, not another offer.
          const failure: ResourceFailure = {
            ...outcome,
            status: 'recovery-required',
            reason: 'changed-again',
            action: 'restore-original-and-reopen',
            // An explicit `original: null` from the runtime means no profile; keep it.
            original: outcome.recovery ? outcome.recovery.original : before.profile,
          };
          patch(target, {
            conflict: undefined,
            conflictBaseline: undefined,
            recovery: { failure, baseline: before },
          });
          return;
        }
        patch(target, { conflict: outcome, conflictBaseline: before, recovery: undefined });
        return;
      }
      if (outcome.status === 'recovery-required' || outcome.status === 'unknown') {
        patch(target, {
          recovery: { failure: outcome, baseline: before },
          conflict: undefined,
          notice: outcome.status === 'unknown' ? refusalNotice(outcome, kind) : undefined,
        });
        return;
      }
      // A one-off `unsupported` refusal is reported, but only a missing capability disables the control.
      patch(target, { notice: refusalNotice(outcome, kind) });
      const availability = availabilityFor(outcome);
      if (outcome.status === 'detached' || outcome.status === 'unauthenticated') {
        if (availability) patch(target, { availability });
      }
      if (outcome.status === 'stale') await refresh();
    },
    [patch, refresh]
  );

  const applyProfileWith = useCallback(
    async (ref: ProfileRef | null, before: Baseline, reselected = false, done?: ControlsNotice): Promise<boolean> => {
      const target = sessionRef.current;
      const capabilities = writable();
      if (!target || !capabilities) return false;
      const report = await runWrite(target, 'profile', () => target.resources.useProfile(capabilities.bindingId, ref));
      if (!report || !current(target)) return false;
      await settleLists(target, report.refresh);
      if (report.outcome.status === 'success' || report.outcome.status === 'unknown') appliedRef.current?.();
      await settle(
        target,
        'profile',
        report.outcome,
        before,
        done ??
          (ref
            ? { tone: 'success', key: 'profileApplied', values: { name: ref.name } }
            : { tone: 'success', key: 'profileCleared' }),
        reselected
      );
      if (report.outcome.status !== 'success') return false;
      patch(target, { preview: undefined, previewName: null });
      return true;
    },
    [appliedRef, current, patch, runWrite, sessionRef, settle, settleLists, writable]
  );

  const applyProfile = useCallback(
    (ref: ProfileRef | null, options?: { inheritTools?: boolean }) =>
      applyProfileWith(
        ref,
        baseline(),
        false,
        options?.inheritTools ? { tone: 'success', key: 'toolsInherited' } : undefined
      ),
    [applyProfileWith, baseline]
  );

  const saveTools = useCallback(
    async (names: readonly string[]) => {
      const target = sessionRef.current;
      const capabilities = writable();
      if (!target || !capabilities) return false;
      const before = baseline();
      const report = await runWrite(target, 'tools', () =>
        target.resources.setActiveTools(capabilities.bindingId, names)
      );
      if (!report || !current(target)) return false;
      await settleLists(target);
      await settle(
        target,
        'tools',
        report.outcome,
        before,
        names.length === 0
          ? { tone: 'success', key: 'toolsSavedEmpty' }
          : { tone: 'success', key: 'toolsSaved', values: { count: names.length } }
      );
      return report.outcome.status === 'success';
    },
    [baseline, current, runWrite, sessionRef, settle, settleLists, writable]
  );

  const reselect = useCallback(async () => {
    const { conflict, conflictBaseline } = stateRef.current;
    const candidate = conflict?.candidate;
    if (!candidate) return;
    // One explicit choice; the runtime asks for the single standard approval in the conversation.
    await applyProfileWith(candidate, conflictBaseline ?? baseline(), true);
  }, [applyProfileWith, baseline, stateRef]);

  const keepCurrent = useCallback(() => {
    const target = sessionRef.current;
    const { conflict, conflictBaseline } = stateRef.current;
    if (!target || !conflict) return;
    patch(target, {
      conflict: undefined,
      conflictBaseline: undefined,
      recovery: { failure: conflict, baseline: conflictBaseline ?? baseline() },
    });
  }, [baseline, patch, sessionRef, stateRef]);

  const restore = useCallback(
    async (choice: RestoreChoice) => {
      const target = sessionRef.current;
      const capabilities = writable();
      const { recovery, profiles } = stateRef.current;
      if (!target || !capabilities || !recovery) return;
      const plan = withToolState(restorePlan(recovery, profiles), stateRef.current.tools);
      const profileStep = choice.profile && plan.profile.restorable ? plan.profile : undefined;
      const toolStep = choice.tools && plan.tools.restorable ? plan.tools : undefined;
      if (!profileStep && !toolStep) return;
      writingRef.current = true;
      patch(target, { writing: 'restore', notice: undefined });
      let failure: ResourceFailure | undefined;
      try {
        if (profileStep) {
          const report = await target.resources.useProfile(capabilities.bindingId, profileStep.ref);
          if (report.outcome.status !== 'success') failure = report.outcome;
          else appliedRef.current?.();
        }
        if (!failure && toolStep?.names) {
          const report = await target.resources.setActiveTools(capabilities.bindingId, toolStep.names);
          if (report.outcome.status !== 'success') failure = report.outcome;
        }
      } finally {
        writingRef.current = false;
        patch(target, { writing: null });
      }
      if (!current(target)) return;
      await refresh();
      patch(target, (previous) =>
        failure
          ? { notice: refusalNotice(failure, 'restore') }
          : { notice: { tone: 'success', key: 'restored' }, recovery: undefined, conflict: previous.conflict }
      );
    },
    [appliedRef, current, patch, refresh, sessionRef, stateRef, writable]
  );

  const dismissNotice = useCallback(() => {
    const target = sessionRef.current;
    if (target) patch(target, { notice: undefined });
  }, [patch, sessionRef]);

  const dismissRecovery = useCallback(() => {
    const target = sessionRef.current;
    if (target) patch(target, { recovery: undefined });
  }, [patch, sessionRef]);

  const writeBlocked = hostState === 'busy' ? 'busy' : hostState === 'idle' ? null : 'not-idle';

  return useMemo(
    () => ({
      conversationId,
      enabled,
      ...state,
      writeBlocked,
      panel,
      openPanel,
      refresh,
      inspect,
      applyProfile,
      saveTools,
      reselect,
      keepCurrent,
      restore,
      dismissNotice,
      dismissRecovery,
    }),
    [
      conversationId,
      enabled,
      state,
      writeBlocked,
      panel,
      openPanel,
      refresh,
      inspect,
      applyProfile,
      saveTools,
      reselect,
      keepCurrent,
      restore,
      dismissNotice,
      dismissRecovery,
    ]
  );
}

/** The latest snapshot as a list result, so pagination continues from the exact DTO. */
function peek(
  resources: NativeSessionResources,
  kind: 'tool' | 'skill'
): ResourceResult<SessionSelections> | undefined {
  const snapshot = resources.peekSelections(kind);
  return snapshot && { status: 'success', data: snapshot };
}

export type RestorePlan = {
  /** The profile the conversation used before; `null` means no profile. */
  profile: {
    differs: boolean;
    restorable: boolean;
    /** The catalog still offers this exact source and revision (always true for "no profile"). */
    offered: boolean;
    ref: ProfileRef | null;
    /** Set when the original was recorded by name only. */
    legacyName?: string;
    reason?: 'changed' | 'unknown';
  };
  tools: {
    differs: boolean;
    restorable: boolean;
    names?: readonly string[];
    before: readonly string[] | null | undefined;
    reason?: 'with-profile' | 'unknown';
  };
};

/**
 * Compare what the user had before the failed write with the current effective values.
 * Only items that differ are offered. A profile is restorable only when the catalog still
 * offers that exact source and revision; otherwise the user restores the file and reopens.
 */
export function restorePlan(
  recovery: RecoveryState,
  profiles: ProfileCatalogView<SessionProfiles> | undefined
): RestorePlan {
  const { failure, baseline } = recovery;
  const original =
    failure.original !== undefined ? failure.original : failure.recovery ? failure.recovery.original : baseline.profile;
  const currentRef = profiles?.activeRef ?? null;
  const currentAgent = profiles?.activeAgent ?? null;
  // A session recorded by name only has no ref; compare it by name. When the baseline had a ref,
  // a null original is the runtime saying "no profile", not a name-only record.
  const legacyName = original === null && baseline.profile === null ? baseline.activeAgent : null;
  const profileDiffers =
    legacyName !== null
      ? currentRef !== null || currentAgent !== legacyName
      : !sameRef(original, currentRef) || (original === null && currentAgent !== null);
  const offered =
    original === null ? legacyName === null : (profiles?.profiles.some(({ ref }) => sameRef(ref, original)) ?? false);
  const profile: RestorePlan['profile'] = {
    differs: profileDiffers,
    restorable: profileDiffers && offered,
    offered,
    ref: original,
    ...(legacyName !== null ? { legacyName } : {}),
    ...(profileDiffers && !offered
      ? { reason: legacyName !== null ? ('unknown' as const) : ('changed' as const) }
      : {}),
  };
  return { profile, tools: toolPlan(baseline.toolOverride) };
}

function toolPlan(before: readonly string[] | null | undefined): RestorePlan['tools'] {
  return { differs: false, restorable: false, before, ...(before === undefined ? { reason: 'unknown' as const } : {}) };
}

/** Attach the current tool state to a plan. Kept separate so the component can pass fresh rows. */
export function withToolState(plan: RestorePlan, tools: SessionSelections | undefined): RestorePlan {
  const { before } = plan.tools;
  if (before === undefined || !tools) return plan;
  const now = tools.toolOverride;
  const same =
    before === null || now === null
      ? before === now
      : before.length === now.length && before.every((name, index) => name === now[index]);
  if (same) return { ...plan, tools: { ...plan.tools, differs: false, restorable: false } };
  if (before === null) {
    // Inherit comes back only through a profile write, which resets the override.
    return { ...plan, tools: { ...plan.tools, differs: true, restorable: false, reason: 'with-profile' } };
  }
  const loaded = new Set(tools.items.filter((row) => row.loaded === true).map((row) => row.key));
  const restorable = before.every((name) => loaded.has(name));
  return { ...plan, tools: { ...plan.tools, differs: true, restorable, names: before } };
}
