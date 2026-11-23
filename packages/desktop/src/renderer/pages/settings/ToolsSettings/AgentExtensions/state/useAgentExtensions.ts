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
import { failureCode, useExtensionsChannel, type SendResult, type StillValid } from './channel';
import { isCurrent, isOperation, sessionEpoch, useOperation, type Change, type Sender } from './operation';
import { upgradeOf, upgradeRequest } from './upgrade';

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

/**
 * One flow of the screen (an install with its questions and retries, a settings save): who it
 * is for, and whether it may still go on. `valid` is passed to every send and asked after every
 * await; an answer is taken only while `sender` is current.
 */
type Flow = { sender: Sender; valid: StillValid };

/**
 * The state and actions of the agent extensions screen for `owner` (the signed-in user, `local`
 * in the desktop app). Reads the settings first (their reply says the transport before any
 * secret is sent), then the list and the terminal CLI.
 *
 * Every action is a flow captured when it starts: the owner, the sign-in (`sessionEpoch`), this
 * visit of the screen, and, for changes, its place among the changes asked for. After every
 * await (a dialog, a check, a reply) the flow goes on only while all of them still hold, so
 * nothing is sent for a screen that was left, a user who signed out, or a change asked for again
 * since. An answer that arrives later is taken only for the same owner and sign-in.
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
  /** The online change sent in this visit, as typed (the kept one leaves out a URL with a password). */
  const [visitChange, setVisitChange] = useState<Change | undefined>(undefined);
  /** Changes when the screen is left. */
  const visit = useRef(0);
  /** The latest change asked for: an older change flow stops where it is. */
  const latestChange = useRef(0);

  useEffect(
    () => () => {
      visit.current += 1;
    },
    []
  );

  /** Start a flow; `change` for a change, which takes the place of any earlier change flow. */
  const flow = (change = false): Flow => {
    const sender: Sender = { owner, epoch: sessionEpoch() };
    const atVisit = visit.current;
    const request = change ? (latestChange.current += 1) : 0;
    return {
      sender,
      valid: () => visit.current === atVisit && isCurrent(sender) && (!change || latestChange.current === request),
    };
  };

  const refreshList = useCallback(async (): Promise<void> => {
    setList((current) => ({ ...current, loading: true }));
    const reply = await send({ action: 'list' });
    if (reply === 'declined') return;
    setList(
      reply.ok
        ? { data: reply.data as ExtensionListing, loading: false }
        : { failure: failureOf(reply), loading: false }
    );
  }, [send]);

  const showSettings = useCallback((state: ExtensionSettingsState) => {
    settingsRef.current = state;
    setSettings({ data: state, loading: false });
  }, []);

  const refreshSettings = useCallback(async (): Promise<void> => {
    const reply = await send({ action: 'get_settings' });
    if (reply === 'declined') return;
    if (reply.ok) showSettings(reply.data as ExtensionSettingsState);
    else setSettings({ failure: failureOf(reply), loading: false });
  }, [send, showSettings]);

  const refreshTerminal = useCallback(async (): Promise<void> => {
    setTerminal((current) => ({ ...current, loading: true }));
    const reply = await send({ action: 'list_terminal' });
    if (reply === 'declined') return;
    setTerminal((current) =>
      reply.ok
        ? { data: reply.data as TerminalCliListing, loading: false }
        : { data: current.data, failure: failureOf(reply), loading: false }
    );
  }, [send]);

  useEffect(() => {
    void (async () => {
      // The settings first: their reply carries the transport the screen warns by.
      await refreshSettings();
      await Promise.all([refreshList(), refreshTerminal()]);
    })();
  }, [refreshSettings, refreshList, refreshTerminal]);

  const {
    operation,
    change: keptChange,
    retried: lastRetried,
    start,
    cancel,
    dismiss,
  } = useOperation(send, () => void refreshList(), owner);
  /** The change a follow-up sends again: this visit's, or the one kept from an earlier visit. */
  const lastChange = visitChange ?? keptChange;

  /** A settings reply for `sender`: shown, or its code told. Whether it was ok. */
  const applySettings = (reply: SendResult, sender: Sender): boolean => {
    if (reply === 'declined' || !isCurrent(sender)) return false;
    if (!reply.ok) {
      asksRef.current.failure(failureCode(reply) ?? 'UNKNOWN');
      return false;
    }
    showSettings(reply.data as ExtensionSettingsState);
    return true;
  };

  /**
   * The credentials an online change brings: null for none (no proxy authentication, or saved
   * ones the helper uses), undefined when the user stopped or the flow ended. Asked before
   * sending when nothing is saved here (memory-only, or no saved credentials), and always for a
   * `reason` (the host asked for them) while there is a proxy.
   */
  const credentialsFor = async (
    { sender, valid }: Flow,
    reason?: CredentialsReason
  ): Promise<ProxyCredentials | null | undefined> => {
    const state = settingsRef.current;
    const proxy = state?.settings.proxy;
    if (!state || !proxy) return null;
    if (reason === undefined && !state.settings.proxyAuthentication) return null;
    if (reason === undefined && state.credentialMode === 'keychain' && state.hasSavedCredentials) return null;
    const answer = await asksRef.current.credentials(reason ?? 'required', proxy);
    if (!answer || !valid()) return undefined;
    if (!answer.save) return answer.credentials;
    // Kept in the keychain first; the change then uses the saved ones.
    const saved = await send({ action: 'set_proxy_credentials', credentials: answer.credentials }, valid);
    return applySettings(saved, sender) && valid() ? null : undefined;
  };

  /** Send an online change in `current`; `retried` once it was sent again after a proxy refusal. */
  const sendOnline = async (
    current: Flow,
    change: Change,
    reason?: CredentialsReason,
    retried = false
  ): Promise<void> => {
    if (!current.valid()) return;
    setVisitChange(change);
    const online = change.action === 'upgrade' || change.source.kind !== 'file';
    const credentials = online ? await credentialsFor(current, reason) : null;
    if (credentials === undefined || !current.valid()) return;
    const extra = credentials ? { proxyCredentials: credentials } : {};
    const command: StudioExtensionsRequest =
      change.action === 'install'
        ? {
            action: 'install',
            source: change.source,
            ...(change.replaceIncompatible ? { replaceIncompatible: true } : {}),
            ...extra,
          }
        : upgradeRequest({
            action: 'upgrade',
            name: change.entry.name,
            ...(change.allowUnpin ? { allowUnpin: true } : {}),
            ...extra,
          });
    // The channel decides from the request whether it carries a secret.
    const reply = await send(command, current.valid);
    if (reply === 'declined' || !isCurrent(current.sender)) return;
    const code = failureCode(reply);
    if (code !== undefined) await followUp(current, code, change, retried);
    else if (reply.ok && isOperation(reply.data)) start(reply.data, { ...current.sender, change, retried });
  };

  /**
   * What a failure code of a change leads to: asking again, confirming, or its text. A proxy
   * refusal reads the settings again (they may be stale), asks once and sends once more; the
   * same kind of refusal after that, at once or from the change it started, is told, not sent
   * again: one retry per change. Questions and sends stay in the change's flow.
   */
  const followUp = async (current: Flow, code: string, change: Change, retried = false): Promise<void> => {
    if (!current.valid()) return;
    const reason = PROXY_REASONS[code];
    if (reason) {
      if (retried) return asksRef.current.failure(code);
      await refreshSettings();
      return sendOnline(current, change, reason, true);
    }
    if (change.action === 'upgrade' && code === 'PIN_UNKNOWN') {
      if (await asksRef.current.confirmUnpin(change.entry)) await sendOnline(current, { ...change, allowUnpin: true });
      return;
    }
    if (change.action === 'upgrade' && code === 'PINNED') {
      if ((await asksRef.current.pinned(change.entry)) && current.valid())
        asksRef.current.installByName(change.entry.distribution);
      return;
    }
    asksRef.current.failure(code);
  };

  /** An offline change (update from a file, remove): started, or its code told. */
  const sendChange = async (command: StudioExtensionsRequest): Promise<void> => {
    const current = flow(true);
    setVisitChange(undefined);
    const reply = await send(command, current.valid);
    if (reply === 'declined' || !isCurrent(current.sender)) return;
    const code = failureCode(reply);
    if (code !== undefined) asksRef.current.failure(code);
    else if (reply.ok && isOperation(reply.data)) start(reply.data, { ...current.sender, retried: false });
  };

  /** A change answered at once (rollback, reconcile): its code told, the list read again. */
  const sendDirect = async (command: StudioExtensionsRequest): Promise<void> => {
    const current = flow(true);
    const reply = await send(command, current.valid);
    if (reply === 'declined' || !isCurrent(current.sender)) return;
    const code = failureCode(reply);
    if (code !== undefined) asksRef.current.failure(code);
    await refreshList();
  };

  const actions = {
    install: (source: ExtensionSource) => sendOnline(flow(true), { action: 'install', source }),
    /** After `BUNDLE_CHANGED` on an install: install anyway, replacing the other runtime's extensions. */
    installReplacing: async () => {
      if (lastChange?.action === 'install') await sendOnline(flow(true), { ...lastChange, replaceIncompatible: true });
    },
    /**
     * After a change ended with a code that asks the user something (the proxy refused or
     * changed, a version constraint is unknown or pinned): ask, and send it again.
     */
    retryAfter: async (code: string) => {
      if (lastChange) await followUp(flow(true), code, lastChange, lastRetried);
    },
    upgrade: async (entry: ExtensionEntry) => {
      const current = flow(true);
      const availability = upgradeOf(entry);
      if (availability === 'pinned') {
        if ((await asksRef.current.pinned(entry)) && current.valid()) asksRef.current.installByName(entry.distribution);
        return;
      }
      if (availability === 'confirmation_required') {
        if (await asksRef.current.confirmUnpin(entry))
          await sendOnline(current, { action: 'upgrade', entry, allowUnpin: true });
        return;
      }
      await sendOnline(current, { action: 'upgrade', entry });
    },
    updateFromFile: (entry: ExtensionEntry, path: string) =>
      sendChange({ action: 'update', name: entry.name, source: { kind: 'file', path } }),
    remove: (entry: ExtensionEntry) => sendChange({ action: 'remove', name: entry.name }),
    /** The app-wide default for new conversations; the reply is the list with it changed. */
    setDefault: async (entry: ExtensionEntry, enabled: boolean) => {
      if (entry.managedId === undefined) return;
      const current = flow();
      const reply = await send({ action: 'set_default', extensionId: entry.managedId, enabled }, current.valid);
      if (reply === 'declined' || !isCurrent(current.sender)) return;
      if (reply.ok) setList({ data: reply.data as ExtensionListing, loading: false });
      else asksRef.current.failure(failureCode(reply) ?? 'UNKNOWN');
    },
    rollback: () => sendDirect({ action: 'rollback' }),
    reconcile: () => sendDirect({ action: 'reconcile_bundle' }),
    saveSettings: async (next: ExtensionSettings) => {
      const current = flow();
      setSavingSettings(true);
      try {
        // A proxy address with a user name and password makes this a secret request.
        applySettings(await send({ action: 'set_settings', settings: next }, current.valid), current.sender);
      } finally {
        setSavingSettings(false);
      }
    },
    saveCredentials: async () => {
      const current = flow();
      const proxy = settingsRef.current?.settings.proxy;
      if (!proxy) return;
      const answer = await asksRef.current.credentials('save', proxy);
      if (!answer || !current.valid()) return;
      applySettings(
        await send({ action: 'set_proxy_credentials', credentials: answer.credentials }, current.valid),
        current.sender
      );
    },
    clearCredentials: async () => {
      const current = flow();
      applySettings(await send({ action: 'clear_proxy_credentials' }, current.valid), current.sender);
    },
    refreshTerminal,
    cancel,
    dismiss,
  };

  return { transport, list, settings, terminal, operation, savingSettings, lastChange, lastRetried, actions };
}
