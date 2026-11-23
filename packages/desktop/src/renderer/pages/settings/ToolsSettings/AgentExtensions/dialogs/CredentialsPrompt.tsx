/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ProxyCredentialMode, ProxyCredentials } from '@aionui/web-host';
import { Alert, Button, Checkbox, Input, Modal } from '@arco-design/web-react';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

/** Why the prompt is shown: asked before an install, refused by the proxy, or the proxy changed. */
export type CredentialsReason = 'required' | 'rejected' | 'changed' | 'save';

/** Printable ASCII, the helper's rule; a user name without `:`. */
const PRINTABLE = /^[\x20-\x7e]*$/;

export const credentialsProblem = (username: string, password: string): 'empty' | 'charset' | 'colon' | undefined => {
  if (!username || !password) return 'empty';
  if (!PRINTABLE.test(username) || !PRINTABLE.test(password)) return 'charset';
  if (username.includes(':')) return 'colon';
  return undefined;
};

type Props = {
  visible: boolean;
  reason: CredentialsReason;
  proxy: string;
  mode: ProxyCredentialMode;
  /** Resolves with the credentials and whether to keep them, or undefined when cancelled. */
  onDone: (result?: { credentials: ProxyCredentials; save: boolean }) => void;
};

/**
 * Asks for the proxy's user name and password. They live only in this dialog's state until sent,
 * and are cleared when it closes. "Keep in the keychain" shows only where Studio can keep them.
 */
const CredentialsPrompt: React.FC<Props> = ({ visible, reason, proxy, mode, onDone }) => {
  const { t } = useTranslation();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [save, setSave] = useState(reason === 'save');

  useEffect(() => {
    if (visible) return;
    setUsername('');
    setPassword('');
  }, [visible]);
  useEffect(() => setSave(reason === 'save'), [reason, visible]);

  const problem = credentialsProblem(username, password);
  const close = (result?: { credentials: ProxyCredentials; save: boolean }): void => {
    setUsername('');
    setPassword('');
    onDone(result);
  };

  return (
    <Modal
      visible={visible}
      title={t('settings.agentExtensions.credentials.title')}
      onCancel={() => close()}
      unmountOnExit
      footer={
        <>
          <Button onClick={() => close()}>{t('settings.agentExtensions.actions.cancel')}</Button>
          <Button
            type='primary'
            disabled={problem !== undefined}
            onClick={() => close({ credentials: { username, password }, save: mode === 'keychain' && save })}
            data-testid='credentials-submit'
          >
            {t('settings.agentExtensions.actions.continue')}
          </Button>
        </>
      }
    >
      <div className='flex flex-col gap-12px' data-testid='credentials-prompt'>
        <span className='text-13px text-t-primary'>{t('settings.agentExtensions.credentials.body', { proxy })}</span>
        {reason === 'rejected' && <Alert type='error' content={t('settings.agentExtensions.credentials.rejected')} />}
        {reason === 'changed' && <Alert type='warning' content={t('settings.agentExtensions.credentials.changed')} />}
        <Input
          value={username}
          onChange={setUsername}
          autoComplete='off'
          placeholder={t('settings.agentExtensions.credentials.username')}
          aria-label={t('settings.agentExtensions.credentials.username')}
          data-testid='credentials-username'
        />
        <Input.Password
          value={password}
          onChange={setPassword}
          autoComplete='off'
          placeholder={t('settings.agentExtensions.credentials.password')}
          aria-label={t('settings.agentExtensions.credentials.password')}
          data-testid='credentials-password'
        />
        <span
          className={
            problem === 'charset' || problem === 'colon' ? 'text-12px text-danger' : 'text-12px text-t-secondary'
          }
        >
          {t('settings.agentExtensions.credentials.rule')}
        </span>
        {mode === 'keychain' ? (
          <Checkbox checked={save} onChange={setSave} disabled={reason === 'save'}>
            {t('settings.agentExtensions.credentials.save')}
          </Checkbox>
        ) : (
          <span className='text-12px text-t-secondary'>{t('settings.agentExtensions.credentials.memoryOnly')}</span>
        )}
      </div>
    </Modal>
  );
};

export default CredentialsPrompt;
