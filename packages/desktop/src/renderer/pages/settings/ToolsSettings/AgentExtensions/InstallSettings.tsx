/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ExtensionSettings, ExtensionSettingsState } from '@aionui/web-host';
import { Alert, Button, Input, Switch } from '@arco-design/web-react';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { hasUserPart, withoutUserPart } from './state/secrets';

/**
 * A switch that is off and cannot be turned on shows its track a step darker than the section
 * behind it (Arco's disabled track is the section's own fill): its shape stays visible.
 */
export const offAndLocked = (checked: boolean, disabled: boolean): string | undefined =>
  disabled && !checked ? '!bg-fill-3' : undefined;

type Props = {
  state: ExtensionSettingsState;
  /**
   * Git installs (and so private Git) are not offered: the host is Windows, or that is not known
   * yet.
   */
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
 * helper; the page treats such an address as a secret. It is kept only while typed: once sent,
 * the field holds the address without them whatever the answer (saved, refused, or the send
 * declined), so the password stays nowhere on the page. The helper refuses such an address
 * with proxy authentication off, so saving waits until it is on.
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
  const [readSettings, setReadSettings] = useState(state.settings);
  if (readSettings !== state.settings) {
    // Settings read again replace the draft in this same render. An effect would do it a frame
    // late, and on the first frame it would undo what was typed before it ran.
    setReadSettings(state.settings);
    setDraft(state.settings);
    setProxy(state.settings.proxy ?? '');
  }

  const hasProxy = proxy.trim() !== '';
  const settings: ExtensionSettings = {
    ...draft,
    proxy: hasProxy ? proxy.trim() : null,
    proxyAuthentication: hasProxy && draft.proxyAuthentication,
  };
  const changed = JSON.stringify(settings) !== JSON.stringify(state.settings) || state.unreadable;
  const sameProxy = (state.settings.proxy ?? '') === proxy.trim();
  const typedCredentials = hasUserPart(proxy);
  const needsAuthentication = typedCredentials && !settings.proxyAuthentication;

  const save = (): void => {
    onSave(settings);
    if (typedCredentials) setProxy(withoutUserPart(proxy.trim()));
  };

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
          className={offAndLocked(draft.onlineInstall && !state.onlineInstallLocked, state.onlineInstallLocked)}
          onChange={(onlineInstall) => setDraft({ ...draft, onlineInstall })}
          data-testid='settings-online'
        />
      </Row>
      <Row label={t('settings.agentExtensions.settings.proxy')} hint={t('settings.agentExtensions.settings.proxyHint')}>
        <div className='flex w-full flex-col gap-6px'>
          <Input
            value={proxy}
            onChange={setProxy}
            placeholder='http://proxy.example:3128'
            aria-label={t('settings.agentExtensions.settings.proxy')}
            data-testid='settings-proxy'
          />
          {needsAuthentication && (
            <span className='text-12px text-warning' data-testid='settings-proxy-needs-auth'>
              {t('settings.agentExtensions.settings.credentialsNeedAuthentication')}
            </span>
          )}
        </div>
      </Row>
      <Row
        label={t('settings.agentExtensions.settings.proxyAuthentication')}
        hint={
          // Why it cannot be turned on yet, while there is no proxy to sign in to.
          !hasProxy
            ? t('settings.agentExtensions.settings.proxyAuthenticationNeedsProxy')
            : state.credentialMode === 'keychain'
              ? t('settings.agentExtensions.settings.keychainHint')
              : t('settings.agentExtensions.settings.memoryOnlyHint')
        }
      >
        <div className='flex flex-col items-end gap-8px'>
          <Switch
            checked={settings.proxyAuthentication}
            disabled={!hasProxy}
            className={offAndLocked(settings.proxyAuthentication, !hasProxy)}
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
          disabled={!changed || needsAuthentication}
          onClick={save}
          data-testid='settings-save'
        >
          {t('settings.agentExtensions.actions.save')}
        </Button>
      </div>
    </section>
  );
};

export default InstallSettings;
