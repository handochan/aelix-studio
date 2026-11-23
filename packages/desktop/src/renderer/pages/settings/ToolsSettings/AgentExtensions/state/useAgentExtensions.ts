/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  ExtensionEntry,
  ExtensionListing,
  ExtensionSettings,
  ExtensionSettingsState,
  ExtensionSource,
  ProxyCredentials,
  StudioExtensionsReply,
  StudioExtensionsRequest,
  TerminalCliListing,
} from '@aionui/web-host';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CredentialsReason } from '../dialogs/CredentialsPrompt';
import { failureCode, useExtensionsChannel, type SendResult } from './channel';
import { createFlow, runFlow, type Flow, type Sender } from './flow';
import {
  changeHasSecret,
  isCurrent,
  isLatestChange,
  isOperation,
  nextChangeRequest,
  sessionEpoch,
  useOperation,
  type Change,
} from './operation';

/** What the page asks the user through its dialogs; each resolves when the user answers. */
export type Asks = {
  /** A secret would cross the network unencrypted: go on? */
  confirmInsecure: () => Promise<boolean>;
  credentials: (
    reason: CredentialsReason,
    proxy: string
  ) => Promise<{ credentials: ProxyCredentials; save: boolean } | undefined>;
  /** A legacy package source lost its version constraint: upgrade without one? */
  confirmUnpin: (entry: ExtensionEntry) => Promise<boolean>;
  /** The version is pinned; resolves true to install another version by name. */
  pinned: (entry: ExtensionEntry) => Promise<boolean>;
  /** Show the text for the failure code of a request that ended at once. */
  failure: (code: string) => void;
  /** Open the install dialog on the name tab, prefilled (after a pinned upgrade). */
  installByName: (name: string) => void;
};

export type Load<T> = { data?: T; failure?: { code: string; detail?: string[] }; loading: boolean };

const failureOf = (reply: StudioExtensionsReply): { code: string; detail?: string[] } | undefined => {
  const code = failureCode(reply);
  if (code === undefined) return undefined;
  const detail = (reply as { detail?: string[] }).detail;
  return { code, ...(detail ? { detail } : {}) };
};

export type { Change } from './operation';

/** Refusals about the proxy's credentials, and what the user is asked after each. */
const PROXY_REASONS: Record<string, CredentialsReason> = {
  PROXY_CREDENTIALS_REQUIRED: 'required',
  PROXY_CREDENTIALS_REJECTED: 'rejected',
  PROXY_CHANGED: 'changed',
};

/** A flow of the screen, and for a change, its request (0 for other flows). */
type ScreenFlow = Flow & { request: number };

/**
 * The state and actions of the agent extensions screen for `owner` (the signed-in user, `local`
 * in the desktop app). Reads the settings first (their reply says the transport before any
 * secret is sent), then the list and the terminal CLI.
 *
 * Every action runs as a flow (`flow.ts`) captured when it starts: the owner, the sign-in
 * (`sessionEpoch`), this screen, and, for changes, its change request (`nextChangeRequest`).
 * Every await goes through the flow's gates: nothing is asked or sent for a screen that was
 * left, a user who signed out, or a change asked for again since; an answer is taken only for
 * the same owner and sign-in and the latest change request.
 */
export function useAgentExtensions(asks: Asks, owner: string) {
  const asksRef = useRef(asks);
  asksRef.current = asks;
  const confirmInsecure = useCallback(() => asksRef.current.confirmInsecure(), []);
  const { send, transport } = useExtensionsChannel(confirmInsecure);
  const [list, setList] = useState<Load<ExtensionListing>>({ loading: true });
  const [settings, setSettings] = useState<Load<ExtensionSettingsState>>({ loading: true });
  const [terminal, setTerminal] = useState<Load<TerminalCliListing>>({ loading: true });
  const [savingSettings, setSavingSettings] = useState(false);
  const settingsRef = useRef<ExtensionSettingsState | undefined>(undefined);
  /**
   * The online change sent in this visit, to send again after a refusal. Only one without a
   * secret: a change whose URL may carry a user part is sent once and kept nowhere.
   */
  const [visitChange, setVisitChange] = useState<Change | undefined>(undefined);
  /** The screen was left: its flows go no further. */
  const left = useRef(false);

  useEffect(() => {
    left.current = false;
    return () => {
      left.current = true;
    };
  }, []);

  /** Start a flow; `change` for a change request, which takes the place of earlier ones. */
  const startFlow = useCallback(
    (change = false): ScreenFlow => {
      const sender: Sender = { owner, epoch: sessionEpoch() };
      const request = change ? nextChangeRequest() : 0;
      const current = (): boolean => isCurrent(sender) && (!change || isLatestChange(request));
      return { ...createFlow(sender, { current, valid: () => !left.current && current() }), request };
    },
    [owner]
  );

  const refreshList = useCallback(
    async (flow: Flow): Promise<void> => {
      setList((current) => ({ ...current, loading: true }));
      const reply = await flow.step(send({ action: 'list' }, flow));
      if (reply === 'declined') return;
      setList(
        reply.ok
          ? { data: reply.data as ExtensionListing, loading: false }
          : { failure: failureOf(reply), loading: false }
      );
    },
    [send]
  );

  const showSettings = useCallback((state: ExtensionSettingsState) => {
    settingsRef.current = state;
    setSettings({ data: state, loading: false });
  }, []);

  const refreshSettings = useCallback(
    async (flow: Flow): Promise<void> => {
      const reply = await flow.step(send({ action: 'get_settings' }, flow));
      if (reply === 'declined') return;
      if (reply.ok) showSettings(reply.data as ExtensionSettingsState);
      else setSettings({ failure: failureOf(reply), loading: false });
    },
    [send, showSettings]
  );

  const refreshTerminal = useCallback(
    async (flow: Flow): Promise<void> => {
      setTerminal((current) => ({ ...current, loading: true }));
      const reply = await flow.step(send({ action: 'list_terminal' }, flow));
      if (reply === 'declined') return;
      setTerminal((current) =>
        reply.ok
          ? { data: reply.data as TerminalCliListing, loading: false }
          : { data: current.data, failure: failureOf(reply), loading: false }
      );
    },
    [send]
  );

  useEffect(() => {
    // The settings first: their reply carries the transport the screen warns by. Left before
    // they came, nothing more is asked for.
    const flow = startFlow();
    void runFlow(async () => {
      await refreshSettings(flow);
      await Promise.all([refreshList(flow), refreshTerminal(flow)]);
    });
  }, [startFlow, refreshSettings, refreshList, refreshTerminal]);

  const {
    operation,
    change: keptChange,
    retried: lastRetried,
    start,
    cancel,
    dismiss,
  } = useOperation(send, () => void runFlow(() => refreshList(startFlow())), owner);
  /** The change a follow-up sends again: this visit's, or the one kept from an earlier visit. */
  const lastChange = visitChange ?? keptChange;

  /** A settings reply: shown, or its code told. Whether it was ok. */
  const applySettings = (reply: SendResult): boolean => {
    if (reply === 'declined') return false;
    if (!reply.ok) {
      asksRef.current.failure(failureCode(reply) ?? 'UNKNOWN');
      return false;
    }
    showSettings(reply.data as ExtensionSettingsState);
    return true;
  };

  /**
   * The credentials an online change brings: null for none (no proxy authentication, or saved
   * ones the helper uses), undefined when the user stopped. Asked before sending when nothing is
   * saved here (memory-only, or no saved credentials), and always for a `reason` (the host asked
   * for them) while there is a proxy.
   */
  const credentialsFor = async (
    flow: Flow,
    reason?: CredentialsReason
  ): Promise<ProxyCredentials | null | undefined> => {
    const state = settingsRef.current;
    const proxy = state?.settings.proxy;
    if (!state || !proxy) return null;
    if (reason === undefined && !state.settings.proxyAuthentication) return null;
    if (reason === undefined && state.credentialMode === 'keychain' && state.hasSavedCredentials) return null;
    const answer = await flow.ask(() => asksRef.current.credentials(reason ?? 'required', proxy));
    if (!answer) return undefined;
    if (!answer.save) return answer.credentials;
    // Kept in the keychain first; the change then uses the saved ones.
    const saved = await flow.step(send({ action: 'set_proxy_credentials', credentials: answer.credentials }, flow));
    return applySettings(saved) ? null : undefined;
  };

  /** Send an online change in `flow`; `retried` once it was sent again after a proxy refusal. */
  const sendOnline = async (
    flow: ScreenFlow,
    change: Change,
    reason?: CredentialsReason,
    retried = false
  ): Promise<void> => {
    if (!flow.valid()) return;
    setVisitChange(changeHasSecret(change) ? undefined : change);
    const online = change.action === 'upgrade' || change.source.kind !== 'file';
    const credentials = online ? await credentialsFor(flow, reason) : null;
    if (credentials === undefined) return;
    const extra = credentials ? { proxyCredentials: credentials } : {};
    const command: StudioExtensionsRequest =
      change.action === 'install'
        ? {
            action: 'install',
            source: change.source,
            ...(change.replaceIncompatible ? { replaceIncompatible: true } : {}),
            ...extra,
          }
        : {
            action: 'upgrade',
            name: change.entry.name,
            ...(change.allowUnpin ? { allowUnpin: true } : {}),
            ...extra,
          };
    // The channel decides from the request whether it carries a secret.
    const reply = await flow.answer(send(command, flow));
    if (reply === 'declined') return;
    const code = failureCode(reply);
    if (code !== undefined) await followUp(flow, code, change, retried);
    else if (reply.ok && isOperation(reply.data))
      start(reply.data, { ...flow.sender, request: flow.request, change, retried });
  };

  /**
   * What a failure code of a change leads to: asking again, confirming, or its text. A proxy
   * refusal reads the settings again (they may be stale), asks once and sends once more; the
   * same kind of refusal after that, at once or from the change it started, is told, not sent
   * again: one retry per change. Questions and sends stay in the change's flow.
   */
  const followUp = async (flow: ScreenFlow, code: string, change: Change, retried = false): Promise<void> => {
    const reason = PROXY_REASONS[code];
    if (reason) {
      if (retried) return asksRef.current.failure(code);
      await refreshSettings(flow);
      return sendOnline(flow, change, reason, true);
    }
    if (change.action === 'upgrade' && code === 'PIN_UNKNOWN') {
      if (await flow.ask(() => asksRef.current.confirmUnpin(change.entry)))
        await sendOnline(flow, { ...change, allowUnpin: true });
      return;
    }
    if (change.action === 'upgrade' && code === 'PINNED') {
      if (await flow.ask(() => asksRef.current.pinned(change.entry)))
        asksRef.current.installByName(change.entry.distribution);
      return;
    }
    asksRef.current.failure(code);
  };

  /** An offline change (update from a file, remove) in `flow`: started, or its code told. */
  const sendChange = async (flow: ScreenFlow, command: StudioExtensionsRequest): Promise<void> => {
    setVisitChange(undefined);
    const reply = await flow.answer(send(command, flow));
    if (reply === 'declined') return;
    const code = failureCode(reply);
    if (code !== undefined) asksRef.current.failure(code);
    else if (reply.ok && isOperation(reply.data))
      start(reply.data, { ...flow.sender, request: flow.request, retried: false });
  };

  /** A change answered at once (rollback, reconcile): its code told, the list read again. */
  const sendDirect = (command: StudioExtensionsRequest): Promise<void> =>
    runFlow(async () => {
      const flow = startFlow(true);
      const reply = await flow.answer(send(command, flow));
      if (reply === 'declined') return;
      const code = failureCode(reply);
      if (code !== undefined) asksRef.current.failure(code);
      await refreshList(flow);
    });

  const actions = {
    install: (source: ExtensionSource) => runFlow(() => sendOnline(startFlow(true), { action: 'install', source })),
    /** After `BUNDLE_CHANGED` on an install: install anyway, replacing the other runtime's extensions. */
    installReplacing: () =>
      runFlow(async () => {
        if (lastChange?.action === 'install')
          await sendOnline(startFlow(true), { ...lastChange, replaceIncompatible: true });
      }),
    /**
     * After a change ended with a code that asks the user something (the proxy refused or
     * changed, a version constraint is unknown or pinned): ask, and send it again.
     */
    retryAfter: (code: string) =>
      runFlow(async () => {
        if (lastChange) await followUp(startFlow(true), code, lastChange, lastRetried);
      }),
    upgrade: (entry: ExtensionEntry) =>
      runFlow(async () => {
        const flow = startFlow(true);
        const availability = entry.upgrade;
        if (availability === 'pinned') {
          if (await flow.ask(() => asksRef.current.pinned(entry))) asksRef.current.installByName(entry.distribution);
          return;
        }
        if (availability === 'confirmation_required') {
          if (await flow.ask(() => asksRef.current.confirmUnpin(entry)))
            await sendOnline(flow, { action: 'upgrade', entry, allowUnpin: true });
          return;
        }
        await sendOnline(flow, { action: 'upgrade', entry });
      }),
    /** Update a file import from a wheel the user picks on the host (`pick`), in one flow. */
    updateFromFile: (entry: ExtensionEntry, pick: () => Promise<string | undefined>) =>
      runFlow(async () => {
        const flow = startFlow(true);
        const path = await flow.step(pick());
        if (!path) return;
        await sendChange(flow, { action: 'update', name: entry.name, source: { kind: 'file', path } });
      }),
    remove: (entry: ExtensionEntry) =>
      runFlow(() => sendChange(startFlow(true), { action: 'remove', name: entry.name })),
    /** The app-wide default for new conversations; the reply is the list with it changed. */
    setDefault: (entry: ExtensionEntry, enabled: boolean) =>
      runFlow(async () => {
        if (entry.managedId === undefined) return;
        const flow = startFlow();
        const reply = await flow.answer(send({ action: 'set_default', extensionId: entry.managedId, enabled }, flow));
        if (reply === 'declined') return;
        if (reply.ok) setList({ data: reply.data as ExtensionListing, loading: false });
        else asksRef.current.failure(failureCode(reply) ?? 'UNKNOWN');
      }),
    rollback: () => sendDirect({ action: 'rollback' }),
    reconcile: () => sendDirect({ action: 'reconcile_bundle' }),
    saveSettings: (next: ExtensionSettings) =>
      runFlow(async () => {
        const flow = startFlow();
        setSavingSettings(true);
        try {
          // A proxy address that may carry a user part makes this a secret request.
          applySettings(await flow.answer(send({ action: 'set_settings', settings: next }, flow)));
        } finally {
          setSavingSettings(false);
        }
      }),
    saveCredentials: () =>
      runFlow(async () => {
        const flow = startFlow();
        const proxy = settingsRef.current?.settings.proxy;
        if (!proxy) return;
        const answer = await flow.ask(() => asksRef.current.credentials('save', proxy));
        if (!answer) return;
        applySettings(
          await flow.answer(send({ action: 'set_proxy_credentials', credentials: answer.credentials }, flow))
        );
      }),
    clearCredentials: () =>
      runFlow(async () => {
        const flow = startFlow();
        applySettings(await flow.answer(send({ action: 'clear_proxy_credentials' }, flow)));
      }),
    refreshTerminal: () => runFlow(() => refreshTerminal(startFlow())),
    cancel,
    dismiss,
  };

  return { transport, list, settings, terminal, operation, savingSettings, lastChange, lastRetried, actions };
}
