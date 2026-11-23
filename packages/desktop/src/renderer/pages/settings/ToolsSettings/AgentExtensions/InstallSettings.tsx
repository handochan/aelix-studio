/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ExtensionSettings, ExtensionSettingsState } from '@aionui/web-host';
import { Alert, Button, Input, Switch } from '@arco-design/web-react';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

type Props = {
  state: ExtensionSettingsState;
  /** The host is Windows, where Git installs (and so private Git) are not offered yet. */
  windows: boolean;
  saving: boolean;
  onSave: (settings: ExtensionSettings) => void;
  onSaveCredentials: () => void;
  onClearCredentials: () => void;
};

const Row: React.FC<{ label: string; hint?: React.ReactNode; children: React.ReactNode }> = ({
  label,
  hint,
  children,
}) => (
  <div className='flex flex-col gap-6px md:flex-row md:items-start md:justify-between md:gap-24px'>
    <div className='flex min-w-0 flex-col gap-2px'>
      <span className='text-13px text-t-primary'>{label}</span>
      {hint && <span className='text-12px text-t-secondary'>{hint}</span>}
    </div>
    <div className='shrink-0 md:w-360px md:flex md:justify-end'>{children}</div>
  </div>
);

/**
 * Settings for name and Git installs: online installs on or off, the one proxy they use and its
 * credentials, and private Git. Every field is sent on save (the contract asks for all of them
 * after `unreadable`). A proxy address typed with a user name and password is split by the
 * helper; the page treats such an address as a secret.
 */
const InstallSettings: React.FC<Props> = ({
  state,
  windows,
  saving,
  onSave,
  onSaveCredentials,
  onClearCredentials,
}) => {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<ExtensionSettings>(state.settings);
  const [proxy, setProxy] = useState(state.settings.proxy ?? '');
  useEffect(() => {
    setDraft(state.settings);
    setProxy(state.settings.proxy ?? '');
  }, [state.settings]);

  const hasProxy = proxy.trim() !== '';
  const settings: ExtensionSettings = {
    ...draft,
    proxy: hasProxy ? proxy.trim() : null,
    proxyAuthentication: hasProxy && draft.proxyAuthentication,
  };
  const changed = JSON.stringify(settings) !== JSON.stringify(state.settings) || state.unreadable;
  const sameProxy = (state.settings.proxy ?? '') === proxy.trim();

  return (
    <section
      className='flex flex-col gap-16px px-[12px] md:px-[32px] py-[24px] bg-2 rd-12px md:rd-16px border border-border-2'
      data-testid='install-settings'
    >
      <span className='text-14px font-medium text-t-primary'>{t('settings.agentExtensions.settings.title')}</span>
      {state.unreadable && <Alert type='warning' content={t('settings.agentExtensions.settings.unreadable')} />}
      <Row
        label={t('settings.agentExtensions.settings.onlineInstall')}
        hint={
          state.onlineInstallLocked
            ? t('settings.agentExtensions.settings.onlineInstallLocked')
            : t('settings.agentExtensions.settings.onlineInstallHint')
        }
      >
        <Switch
          checked={draft.onlineInstall && !state.onlineInstallLocked}
          disabled={state.onlineInstallLocked}
          onChange={(onlineInstall) => setDraft({ ...draft, onlineInstall })}
          data-testid='settings-online'
        />
      </Row>
      <Row label={t('settings.agentExtensions.settings.proxy')} hint={t('settings.agentExtensions.settings.proxyHint')}>
        <Input
          value={proxy}
          onChange={setProxy}
          placeholder='http://proxy.example:3128'
          aria-label={t('settings.agentExtensions.settings.proxy')}
          data-testid='settings-proxy'
        />
      </Row>
      <Row
        label={t('settings.agentExtensions.settings.proxyAuthentication')}
        hint={
          state.credentialMode === 'keychain'
            ? t('settings.agentExtensions.settings.keychainHint')
            : t('settings.agentExtensions.settings.memoryOnlyHint')
        }
      >
        <div className='flex flex-col items-end gap-8px'>
          <Switch
            checked={settings.proxyAuthentication}
            disabled={!hasProxy}
            onChange={(proxyAuthentication) => setDraft({ ...draft, proxyAuthentication })}
            data-testid='settings-proxy-auth'
          />
          {state.credentialMode === 'keychain' && state.settings.proxyAuthentication && sameProxy && (
            <div className='flex items-center gap-8px'>
              <span className='text-12px text-t-secondary'>
                {state.hasSavedCredentials
                  ? t('settings.agentExtensions.settings.credentialsSaved')
                  : t('settings.agentExtensions.settings.credentialsNotSaved')}
              </span>
              <Button size='mini' onClick={onSaveCredentials} data-testid='settings-save-credentials'>
                {state.hasSavedCredentials
                  ? t('settings.agentExtensions.settings.changeCredentials')
                  : t('settings.agentExtensions.settings.addCredentials')}
              </Button>
              {state.hasSavedCredentials && (
                <Button
                  size='mini'
                  status='danger'
                  onClick={onClearCredentials}
                  data-testid='settings-clear-credentials'
                >
                  {t('settings.agentExtensions.settings.clearCredentials')}
                </Button>
              )}
            </div>
          )}
        </div>
      </Row>
      {!windows && (
        <Row
          label={t('settings.agentExtensions.settings.privateGit')}
          hint={t('settings.agentExtensions.settings.privateGitHint')}
        >
          <Switch
            checked={draft.privateGit}
            onChange={(privateGit) => setDraft({ ...draft, privateGit })}
            data-testid='settings-private-git'
          />
        </Row>
      )}
      <div className='flex justify-end'>
        <Button
          type='primary'
          loading={saving}
          disabled={!changed}
          onClick={() => onSave(settings)}
          data-testid='settings-save'
        >
          {t('settings.agentExtensions.actions.save')}
        </Button>
      </div>
    </section>
  );
};

export default InstallSettings;
