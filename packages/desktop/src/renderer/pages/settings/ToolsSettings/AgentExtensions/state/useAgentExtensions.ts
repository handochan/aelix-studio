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
import { isOperation, useOperation } from './operation';
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

/** A change whose credentials the user may be asked for, kept to be sent again. */
export type Change =
  | { action: 'install'; source: ExtensionSource; replaceIncompatible?: boolean }
  | { action: 'upgrade'; entry: ExtensionEntry; allowUnpin?: boolean };

/** A proxy address typed with a user name and password. */
const PROXY_WITH_CREDENTIALS = /^[^:/?#]*:\/\/[^/?#]*@/;

/**
 * The state and actions of the agent extensions screen. Reads the settings first (their reply
 * says the transport before any secret is sent), then the list and the terminal CLI.
 */
export function useAgentExtensions(asks: Asks) {
  const asksRef = useRef(asks);
  asksRef.current = asks;
  const confirmInsecure = useCallback(() => asksRef.current.confirmInsecure(), []);
  const { send, transport } = useExtensionsChannel(confirmInsecure);
  const [list, setList] = useState<Load<ExtensionListing>>({ loading: true });
  const [settings, setSettings] = useState<Load<ExtensionSettingsState>>({ loading: true });
  const [terminal, setTerminal] = useState<Load<TerminalCliListing>>({ loading: true });
  const [savingSettings, setSavingSettings] = useState(false);
  const settingsRef = useRef<ExtensionSettingsState | undefined>(undefined);
  const [lastChange, setLastChange] = useState<Change | undefined>(undefined);

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

  const { operation, start, cancel, dismiss } = useOperation(send, () => void refreshList());

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
   * ones the helper uses), undefined when the user stopped. Asked before sending when nothing
   * is saved here (memory-only, or no saved credentials), and always for a `reason`.
   */
  const credentialsFor = async (reason?: CredentialsReason): Promise<ProxyCredentials | null | undefined> => {
    const state = settingsRef.current;
    const proxy = state?.settings.proxy;
    if (!state || !proxy || !state.settings.proxyAuthentication) return null;
    if (reason === undefined && state.credentialMode === 'keychain' && state.hasSavedCredentials) return null;
    const answer = await asksRef.current.credentials(reason ?? 'required', proxy);
    if (!answer) return undefined;
    if (!answer.save) return answer.credentials;
    // Kept in the keychain first; the change then uses the saved ones.
    const saved = await send({ action: 'set_proxy_credentials', credentials: answer.credentials }, { secret: true });
    return applySettings(saved) ? null : undefined;
  };

  const sendOnline = async (change: Change, reason?: CredentialsReason): Promise<void> => {
    setLastChange(change);
    const online = change.action === 'upgrade' || change.source.kind !== 'file';
    const credentials = online ? await credentialsFor(reason) : null;
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
        : upgradeRequest({
            action: 'upgrade',
            name: change.entry.name,
            ...(change.allowUnpin ? { allowUnpin: true } : {}),
            ...extra,
          });
    const reply = await send(command, { secret: credentials !== null });
    if (reply === 'declined') return;
    const code = failureCode(reply);
    if (code !== undefined) await followUp(code, change);
    else if (reply.ok && isOperation(reply.data)) start(reply.data);
  };

  /** What a failure code of a change leads to: asking again, confirming, or its text. */
  const followUp = async (code: string, change: Change): Promise<void> => {
    if (code === 'PROXY_CREDENTIALS_REQUIRED') return sendOnline(change, 'required');
    if (code === 'PROXY_CREDENTIALS_REJECTED') return sendOnline(change, 'rejected');
    if (code === 'PROXY_CHANGED') {
      await refreshSettings();
      return sendOnline(change, 'changed');
    }
    if (change.action === 'upgrade' && code === 'PIN_UNKNOWN') {
      if (await asksRef.current.confirmUnpin(change.entry)) await sendOnline({ ...change, allowUnpin: true });
      return;
    }
    if (change.action === 'upgrade' && code === 'PINNED') {
      if (await asksRef.current.pinned(change.entry)) asksRef.current.installByName(change.entry.distribution);
      return;
    }
    asksRef.current.failure(code);
  };

  /** An offline change (update from a file, remove): started, or its code told. */
  const sendChange = async (command: StudioExtensionsRequest): Promise<void> => {
    setLastChange(undefined);
    const reply = await send(command);
    if (reply === 'declined') return;
    const code = failureCode(reply);
    if (code !== undefined) asksRef.current.failure(code);
    else if (reply.ok && isOperation(reply.data)) start(reply.data);
  };

  /** A change answered at once (rollback, reconcile): its code told, the list read again. */
  const sendDirect = async (command: StudioExtensionsRequest): Promise<void> => {
    const reply = await send(command);
    if (reply === 'declined') return;
    const code = failureCode(reply);
    if (code !== undefined) asksRef.current.failure(code);
    await refreshList();
  };

  const actions = {
    install: (source: ExtensionSource) => sendOnline({ action: 'install', source }),
    /** After `BUNDLE_CHANGED` on an install: install anyway, replacing the other runtime's extensions. */
    installReplacing: async () => {
      if (lastChange?.action === 'install') await sendOnline({ ...lastChange, replaceIncompatible: true });
    },
    /**
     * After a change ended with a code that asks the user something (the proxy refused or
     * changed, a version constraint is unknown or pinned): ask, and send it again.
     */
    retryAfter: async (code: string) => {
      if (lastChange) await followUp(code, lastChange);
    },
    upgrade: async (entry: ExtensionEntry) => {
      const availability = upgradeOf(entry);
      if (availability === 'pinned') {
        if (await asksRef.current.pinned(entry)) asksRef.current.installByName(entry.distribution);
        return;
      }
      if (availability === 'confirmation_required') {
        if (await asksRef.current.confirmUnpin(entry)) await sendOnline({ action: 'upgrade', entry, allowUnpin: true });
        return;
      }
      await sendOnline({ action: 'upgrade', entry });
    },
    updateFromFile: (entry: ExtensionEntry, path: string) =>
      sendChange({ action: 'update', name: entry.name, source: { kind: 'file', path } }),
    remove: (entry: ExtensionEntry) => sendChange({ action: 'remove', name: entry.name }),
    rollback: () => sendDirect({ action: 'rollback' }),
    reconcile: () => sendDirect({ action: 'reconcile_bundle' }),
    saveSettings: async (next: ExtensionSettings) => {
      setSavingSettings(true);
      try {
        const secret = typeof next.proxy === 'string' && PROXY_WITH_CREDENTIALS.test(next.proxy);
        applySettings(await send({ action: 'set_settings', settings: next }, { secret }));
      } finally {
        setSavingSettings(false);
      }
    },
    saveCredentials: async () => {
      const proxy = settingsRef.current?.settings.proxy;
      if (!proxy) return;
      const answer = await asksRef.current.credentials('save', proxy);
      if (!answer) return;
      applySettings(await send({ action: 'set_proxy_credentials', credentials: answer.credentials }, { secret: true }));
    },
    clearCredentials: async () => {
      applySettings(await send({ action: 'clear_proxy_credentials' }));
    },
    refreshTerminal,
    cancel,
    dismiss,
  };

  return { transport, list, settings, terminal, operation, savingSettings, lastChange, actions };
}
