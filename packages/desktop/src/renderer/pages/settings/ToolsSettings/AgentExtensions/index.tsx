/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Agent Extensions (Studio #32, 1b): the Python extensions Studio installs for Aelix agents, in
 * Settings › AI core below Tools. It talks to the Studio extension helper through its own channel
 * (`client.ts`): the desktop window's IPC channel or the WebUI route.
 */

import { ipcBridge } from '@/common';
import { onUserChange, useAuth } from '@/renderer/hooks/context/AuthContext';
import type { ExtensionEntry, ProxyCredentials } from '@aionui/web-host';
import { Alert, Button, Collapse, Message, Modal, Popconfirm, Spin } from '@arco-design/web-react';
import { Plus, Return } from '@icon-park/react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import SettingsPageHeader from '../../components/SettingsPageHeader';
import SettingsPageWrapper from '../../components/SettingsPageWrapper';
import CredentialsPrompt, { type CredentialsReason } from './dialogs/CredentialsPrompt';
import InstallModal, { type InstallPreset } from './dialogs/InstallModal';
import OperationView from './dialogs/OperationView';
import InstallSettings from './InstallSettings';
import ExtensionList from './list/ExtensionList';
import TerminalSection from './list/TerminalSection';
import { failureKey } from './messages';
import { forgetOwners, isFinished } from './state/operation';
import { useAgentExtensions, type Asks } from './state/useAgentExtensions';

type CredentialsAsk = {
  reason: CredentialsReason;
  proxy: string;
  resolve: (answer?: { credentials: ProxyCredentials; save: boolean }) => void;
};
type EntryAsk = { entry: ExtensionEntry; resolve: (yes: boolean) => void };

/**
 * Choose a wheel on the host: the OS dialog in the app, the host file picker in the WebUI.
 * `filterName` names the wheel filter in the dialog.
 */
async function pickWheelOnHost(filterName: string): Promise<string | undefined> {
  try {
    const files = await ipcBridge.dialog.showOpen.invoke({
      properties: ['openFile'],
      filters: [{ name: filterName, extensions: ['whl'] }],
    });
    return files?.[0];
  } catch {
    return undefined;
  }
}

// What the screen keeps across visits belongs to the signed-in user: dropped when they sign out
// or another user signs in.
onUserChange(forgetOwners);

const PROXY_CODES = new Set(['PROXY_CREDENTIALS_REJECTED', 'PROXY_CREDENTIALS_REQUIRED', 'PROXY_CHANGED']);

/** Hosts Studio runs on that are known not to be Windows. */
const NOT_WINDOWS = new Set(['darwin', 'linux']);

/** The host is Windows (true), known not to be (false), or not known (undefined: Git stays off). */
const platformIsWindows = (platform: unknown): boolean | undefined =>
  platform === 'win32' ? true : typeof platform === 'string' && NOT_WINDOWS.has(platform) ? false : undefined;

/** The screen of one owner: another signed-in user gets a new one, with nothing of this one's. */
const AgentExtensionsSettings: React.FC = () => {
  const { user } = useAuth();
  const owner = user?.id ?? 'local';
  return <AgentExtensionsScreen key={owner} owner={owner} />;
};

const AgentExtensionsScreen: React.FC<{ owner: string }> = ({ owner }) => {
  const { t } = useTranslation();
  const [insecureAsk, setInsecureAsk] = useState<(yes: boolean) => void>();
  const [credentialsAsk, setCredentialsAsk] = useState<CredentialsAsk>();
  const [unpinAsk, setUnpinAsk] = useState<EntryAsk>();
  const [pinnedAsk, setPinnedAsk] = useState<EntryAsk>();
  const [install, setInstall] = useState<InstallPreset>();
  /** The host is Windows; undefined until that is known (Git stays off until then). */
  const [windows, setWindows] = useState<boolean | undefined>(undefined);
  const pickWheel = useCallback(() => pickWheelOnHost(t('settings.agentExtensions.install.wheelFilter')), [t]);

  const asks = useMemo<Asks>(
    () => ({
      confirmInsecure: () => new Promise<boolean>((resolve) => setInsecureAsk(() => resolve)),
      credentials: (reason, proxy) => new Promise((resolve) => setCredentialsAsk({ reason, proxy, resolve })),
      confirmUnpin: (entry) => new Promise<boolean>((resolve) => setUnpinAsk({ entry, resolve })),
      pinned: (entry) => new Promise<boolean>((resolve) => setPinnedAsk({ entry, resolve })),
      failure: (code) => void Message.error(t(failureKey(code))),
      installByName: (name) => setInstall({ tab: 'index', name }),
    }),
    [t]
  );
  const { transport, list, settings, terminal, operation, savingSettings, lastChange, lastRetried, actions } =
    useAgentExtensions(asks, owner);

  // Leaving the screen answers what it still asks with "no": no request waits on a closed
  // dialog, and typed credentials go with the dialog's state.
  const open = useRef({ insecureAsk, credentialsAsk, unpinAsk, pinnedAsk });
  open.current = { insecureAsk, credentialsAsk, unpinAsk, pinnedAsk };
  useEffect(
    () => () => {
      open.current.insecureAsk?.(false);
      open.current.credentialsAsk?.resolve(undefined);
      open.current.unpinAsk?.resolve(false);
      open.current.pinnedAsk?.resolve(false);
    },
    []
  );

  useEffect(() => {
    // The host's platform (the backend runs there, in the app and the WebUI alike).
    void ipcBridge.application.systemInfo
      .invoke()
      .then((info) => setWindows(platformIsWindows(info.platform)))
      .catch((): void => {});
  }, []);

  const answer = useCallback(<T,>(clear: () => void, resolve: ((value: T) => void) | undefined, value: T) => {
    clear();
    resolve?.(value);
  }, []);

  const busy = operation !== undefined && !isFinished(operation);
  const listing = list.data;
  const runtimeUnavailable = list.failure?.code === 'RUNTIME_UNAVAILABLE';
  const reinstallNeeded = listing?.extensions.some((entry) => entry.status === 'reinstall_needed') ?? false;
  const state = settings.data;
  const onlineAllowed = Boolean(
    state && state.settings.onlineInstall && !state.onlineInstallLocked && !state.unreadable
  );

  const followUps = (() => {
    if (!operation || operation.phase !== 'failed') return null;
    // Codes of the upgrade (#121) are compared as text until its types are merged.
    const code: string | undefined = operation.code;
    const retry = (label: string) => (
      <Button
        onClick={() => {
          actions.dismiss();
          if (code) void actions.retryAfter(code);
        }}
        data-testid='operation-retry'
      >
        {label}
      </Button>
    );
    // One retry per change: a change already sent again ends with its failure.
    if (lastChange && code && PROXY_CODES.has(code))
      return lastRetried ? null : retry(t('settings.agentExtensions.actions.enterCredentials'));
    if (lastChange?.action === 'upgrade' && (code === 'PIN_UNKNOWN' || code === 'PINNED'))
      return retry(t('settings.agentExtensions.actions.continue'));
    if (code === 'BUNDLE_CHANGED')
      return (
        <>
          <Button
            onClick={() => {
              actions.dismiss();
              void actions.reconcile();
            }}
          >
            {t('settings.agentExtensions.actions.reconcile')}
          </Button>
          {lastChange?.action === 'install' && (
            <Popconfirm
              title={t('settings.agentExtensions.replace.title')}
              content={t('settings.agentExtensions.replace.body')}
              okText={t('settings.agentExtensions.actions.install')}
              cancelText={t('settings.agentExtensions.actions.cancel')}
              onOk={() => {
                actions.dismiss();
                void actions.installReplacing();
              }}
            >
              <Button status='warning'>{t('settings.agentExtensions.actions.replaceAndInstall')}</Button>
            </Popconfirm>
          )}
        </>
      );
    return null;
  })();

  return (
    <SettingsPageWrapper contentClassName='max-w-1200px'>
      <div className='flex flex-col gap-16px' data-testid='agent-extensions-page'>
        <SettingsPageHeader
          data-testid='agent-extensions-header'
          title={t('settings.agentExtensions.title')}
          description={t('settings.agentExtensions.description')}
          actions={
            <div className='flex items-center gap-8px'>
              {listing?.rollbackAvailable && (
                <Popconfirm
                  title={t('settings.agentExtensions.rollback.title')}
                  content={t('settings.agentExtensions.rollback.body')}
                  okText={t('settings.agentExtensions.actions.rollback')}
                  cancelText={t('settings.agentExtensions.actions.cancel')}
                  disabled={busy}
                  onOk={() => void actions.rollback()}
                >
                  <Button
                    icon={<Return theme='outline' size='14' />}
                    disabled={busy}
                    data-testid='agent-extensions-rollback'
                  >
                    {t('settings.agentExtensions.actions.rollback')}
                  </Button>
                </Popconfirm>
              )}
              <Button
                type='primary'
                icon={<Plus theme='outline' size='14' />}
                disabled={busy || runtimeUnavailable || !listing}
                onClick={() => setInstall({ tab: onlineAllowed ? 'index' : 'file' })}
                data-testid='agent-extensions-install'
              >
                {t('settings.agentExtensions.actions.install')}
              </Button>
            </div>
          }
        />
        {/* Until the first reply the channel is not known: warned about as insecure. */}
        {transport !== 'secure' && (
          <Alert
            type='warning'
            content={t('settings.agentExtensions.insecure.banner')}
            data-testid='agent-extensions-insecure'
          />
        )}
        {runtimeUnavailable ? (
          <Alert
            type='warning'
            title={t('settings.agentExtensions.runtime.title')}
            data-testid='agent-extensions-runtime-unavailable'
            content={
              <div className='flex flex-col gap-6px'>
                <span>{t('settings.agentExtensions.runtime.body')}</span>
                {list.failure?.detail && list.failure.detail.length > 0 && (
                  <Collapse bordered={false}>
                    <Collapse.Item name='detail' header={t('settings.agentExtensions.runtime.details')}>
                      <pre className='m-0 whitespace-pre-wrap break-all text-12px'>
                        {list.failure.detail.join('\n')}
                      </pre>
                    </Collapse.Item>
                  </Collapse>
                )}
              </div>
            }
          />
        ) : (
          <section className='flex flex-col gap-12px px-[12px] md:px-[32px] py-[24px] bg-2 rd-12px md:rd-16px border border-border-2'>
            <Alert type='info' content={t('settings.agentExtensions.appliesAt')} />
            {reinstallNeeded && (
              <Alert
                type='warning'
                data-testid='agent-extensions-reconcile'
                content={t('settings.agentExtensions.reconcileBanner')}
                action={
                  <Button size='small' disabled={busy} onClick={() => void actions.reconcile()}>
                    {t('settings.agentExtensions.actions.reconcile')}
                  </Button>
                }
              />
            )}
            {list.failure && <Alert type='error' content={t(failureKey(list.failure.code))} />}
            {!listing && list.loading && <Spin className='self-center' />}
            {listing && (
              <ExtensionList
                extensions={listing.extensions}
                busy={busy}
                onlineAllowed={onlineAllowed}
                onUpgrade={(entry) => void actions.upgrade(entry)}
                onUpdateFromFile={(entry) =>
                  void pickWheel().then((path) => path && actions.updateFromFile(entry, path))
                }
                onRemove={(entry) => void actions.remove(entry)}
                onToggleDefault={(entry, enabled) => void actions.setDefault(entry, enabled)}
              />
            )}
          </section>
        )}
        {state && (
          <InstallSettings
            state={state}
            windows={windows !== false}
            saving={savingSettings}
            onSave={(next) => void actions.saveSettings(next)}
            onSaveCredentials={() => void actions.saveCredentials()}
            onClearCredentials={() => void actions.clearCredentials()}
          />
        )}
        {settings.failure && <Alert type='error' content={t(failureKey(settings.failure.code))} />}
        <TerminalSection
          listing={terminal.data}
          loading={terminal.loading}
          failure={terminal.failure?.code}
          onRefresh={() => void actions.refreshTerminal()}
        />
      </div>

      <InstallModal
        visible={install !== undefined}
        preset={install}
        onlineAllowed={onlineAllowed}
        windows={windows}
        proxy={state?.settings.proxy ?? null}
        pickWheel={pickWheel}
        onCancel={() => setInstall(undefined)}
        onSubmit={(source) => {
          setInstall(undefined);
          void actions.install(source);
        }}
      />
      <OperationView
        operation={operation}
        followUps={followUps}
        onCancel={() => void actions.cancel()}
        onClose={actions.dismiss}
      />
      <CredentialsPrompt
        visible={credentialsAsk !== undefined}
        reason={credentialsAsk?.reason ?? 'required'}
        proxy={credentialsAsk?.proxy ?? ''}
        mode={state?.credentialMode ?? 'memory-only'}
        onDone={(result) => answer(() => setCredentialsAsk(undefined), credentialsAsk?.resolve, result)}
      />
      <Modal
        unmountOnExit
        visible={insecureAsk !== undefined}
        title={t('settings.agentExtensions.insecure.title')}
        okText={t('settings.agentExtensions.insecure.confirm')}
        cancelText={t('settings.agentExtensions.actions.cancel')}
        okButtonProps={{ status: 'warning' }}
        onOk={() => answer(() => setInsecureAsk(undefined), insecureAsk, true)}
        onCancel={() => answer(() => setInsecureAsk(undefined), insecureAsk, false)}
        data-testid='agent-extensions-insecure-confirm'
      >
        {t('settings.agentExtensions.insecure.body')}
      </Modal>
      <Modal
        unmountOnExit
        visible={unpinAsk !== undefined}
        title={t('settings.agentExtensions.upgrade.unpinTitle')}
        okText={t('settings.agentExtensions.upgrade.unpinConfirm')}
        cancelText={t('settings.agentExtensions.actions.cancel')}
        onOk={() => answer(() => setUnpinAsk(undefined), unpinAsk?.resolve, true)}
        onCancel={() => answer(() => setUnpinAsk(undefined), unpinAsk?.resolve, false)}
      >
        {t('settings.agentExtensions.upgrade.unpinBody', { name: unpinAsk?.entry.name ?? '' })}
      </Modal>
      <Modal
        unmountOnExit
        visible={pinnedAsk !== undefined}
        title={t('settings.agentExtensions.upgrade.pinnedTitle')}
        okText={t('settings.agentExtensions.upgrade.installOther')}
        cancelText={t('settings.agentExtensions.actions.close')}
        onOk={() => answer(() => setPinnedAsk(undefined), pinnedAsk?.resolve, true)}
        onCancel={() => answer(() => setPinnedAsk(undefined), pinnedAsk?.resolve, false)}
      >
        {t('settings.agentExtensions.upgrade.pinnedBody', { name: pinnedAsk?.entry.name ?? '' })}
      </Modal>
    </SettingsPageWrapper>
  );
};

export default AgentExtensionsSettings;
