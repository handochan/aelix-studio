/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ExtensionSource } from '@aionui/web-host';
import { Alert, Button, Checkbox, Input, Modal, Tabs, Tooltip } from '@arco-design/web-react';
import { FolderOpen } from '@icon-park/react';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { failureKey } from '../messages';

export type InstallTab = 'index' | 'git' | 'file';

/** What the dialog opens with: a tab, and a package name for "install another version". */
export type InstallPreset = { tab: InstallTab; name?: string };

type Props = {
  visible: boolean;
  preset?: InstallPreset;
  /** Name and Git installs are allowed (settings and Studio policy). */
  onlineAllowed: boolean;
  /** The host is Windows, where Git installs are not offered yet: the Git tab is off. */
  windows: boolean;
  /** The proxy online installs use, or null for a direct connection. */
  proxy: string | null;
  /** Choose a wheel on the host: the OS dialog in the app, the host file picker in the WebUI. */
  pickWheel: () => Promise<string | undefined>;
  onCancel: () => void;
  onSubmit: (source: ExtensionSource) => void;
};

/** The directory of a host path, whichever separator the host uses. */
const directoryOf = (file: string): string => file.replace(/[\\/][^\\/]*$/, '');

/** The install dialog: by name from a package index, from Git, or from a wheel file on the host. */
const InstallModal: React.FC<Props> = ({
  visible,
  preset,
  onlineAllowed,
  windows,
  proxy,
  pickWheel,
  onCancel,
  onSubmit,
}) => {
  const { t } = useTranslation();
  const [tab, setTab] = useState<InstallTab>('index');
  const [name, setName] = useState('');
  const [version, setVersion] = useState('');
  const [indexUrl, setIndexUrl] = useState('');
  const [gitUrl, setGitUrl] = useState('');
  const [subdirectory, setSubdirectory] = useState('');
  const [wheel, setWheel] = useState('');
  const [useFolder, setUseFolder] = useState(false);

  useEffect(() => {
    if (!visible) return;
    const first: InstallTab = preset?.tab ?? (onlineAllowed ? 'index' : 'file');
    setTab(first === 'git' && windows ? 'index' : first);
    setName(preset?.name ?? '');
    setVersion('');
  }, [visible, preset, onlineAllowed, windows]);

  const gitBlocked = windows || !onlineAllowed;
  const source = ((): ExtensionSource | undefined => {
    const index = indexUrl.trim() ? { indexUrl: indexUrl.trim() } : {};
    if (tab === 'index' && onlineAllowed && name.trim())
      return { kind: 'index', name: name.trim(), ...(version.trim() ? { version: version.trim() } : {}), ...index };
    if (tab === 'git' && !gitBlocked && gitUrl.trim())
      return {
        kind: 'git',
        url: gitUrl.trim(),
        ...(subdirectory.trim() ? { subdirectory: subdirectory.trim() } : {}),
        ...index,
      };
    if (tab === 'file' && wheel.trim())
      return { kind: 'file', path: wheel.trim(), ...(useFolder ? { folder: directoryOf(wheel.trim()) } : {}) };
    return undefined;
  })();

  const onlineNotice = (
    <Alert
      type='info'
      content={
        <div className='flex flex-col gap-4px'>
          <span>{t('settings.agentExtensions.install.onlineNotice')}</span>
          <span>
            {proxy
              ? t('settings.agentExtensions.install.proxyNotice', { proxy })
              : t('settings.agentExtensions.install.directNotice')}
          </span>
        </div>
      }
    />
  );
  const offline = !onlineAllowed && (
    <Alert type='warning' content={t('settings.agentExtensions.install.onlineDisabled')} />
  );
  const indexField = (
    <Input
      value={indexUrl}
      onChange={setIndexUrl}
      placeholder={t('settings.agentExtensions.install.indexUrlPlaceholder')}
      aria-label={t('settings.agentExtensions.install.indexUrl')}
    />
  );

  return (
    <Modal
      visible={visible}
      title={t('settings.agentExtensions.install.title')}
      onCancel={onCancel}
      unmountOnExit
      footer={
        <>
          <Button onClick={onCancel}>{t('settings.agentExtensions.actions.cancel')}</Button>
          <Button
            type='primary'
            disabled={!source}
            onClick={() => source && onSubmit(source)}
            data-testid='install-submit'
          >
            {t('settings.agentExtensions.actions.install')}
          </Button>
        </>
      }
    >
      <Tabs activeTab={tab} onChange={(key) => setTab(key as InstallTab)}>
        <Tabs.TabPane key='index' title={t('settings.agentExtensions.install.tabs.index')}>
          <div className='flex flex-col gap-12px pt-8px'>
            {offline || onlineNotice}
            <Input
              value={name}
              onChange={setName}
              disabled={!onlineAllowed}
              placeholder={t('settings.agentExtensions.install.namePlaceholder')}
              aria-label={t('settings.agentExtensions.install.name')}
              data-testid='install-name'
            />
            <Input
              value={version}
              onChange={setVersion}
              disabled={!onlineAllowed}
              placeholder={t('settings.agentExtensions.install.versionPlaceholder')}
              aria-label={t('settings.agentExtensions.install.version')}
            />
            {onlineAllowed && indexField}
          </div>
        </Tabs.TabPane>
        <Tabs.TabPane
          key='git'
          disabled={windows}
          title={
            windows ? (
              // The helper's own refusal on this platform, said before it is asked.
              <Tooltip content={t(failureKey('UNSUPPORTED_PLATFORM'))}>
                <span data-testid='install-git-tab'>{t('settings.agentExtensions.install.tabs.git')}</span>
              </Tooltip>
            ) : (
              <span data-testid='install-git-tab'>{t('settings.agentExtensions.install.tabs.git')}</span>
            )
          }
        >
          <div className='flex flex-col gap-12px pt-8px'>
            {offline || onlineNotice}
            <Input
              value={gitUrl}
              onChange={setGitUrl}
              disabled={gitBlocked}
              placeholder={t('settings.agentExtensions.install.gitUrlPlaceholder')}
              aria-label={t('settings.agentExtensions.install.gitUrl')}
              data-testid='install-git-url'
            />
            <Input
              value={subdirectory}
              onChange={setSubdirectory}
              disabled={gitBlocked}
              placeholder={t('settings.agentExtensions.install.subdirectoryPlaceholder')}
              aria-label={t('settings.agentExtensions.install.subdirectory')}
            />
            {!gitBlocked && indexField}
          </div>
        </Tabs.TabPane>
        <Tabs.TabPane key='file' title={t('settings.agentExtensions.install.tabs.file')}>
          <div className='flex flex-col gap-12px pt-8px'>
            <Alert type='info' content={t('settings.agentExtensions.install.fileNotice')} />
            <div className='flex gap-8px'>
              <Input
                value={wheel}
                onChange={setWheel}
                placeholder={t('settings.agentExtensions.install.wheelPlaceholder')}
                aria-label={t('settings.agentExtensions.install.wheel')}
                data-testid='install-wheel'
              />
              <Button
                icon={<FolderOpen theme='outline' size='14' />}
                onClick={() => void pickWheel().then((picked) => picked && setWheel(picked))}
                data-testid='install-pick-wheel'
              >
                {t('settings.agentExtensions.install.choose')}
              </Button>
            </div>
            <Checkbox checked={useFolder} onChange={setUseFolder}>
              {t('settings.agentExtensions.install.folderOption')}
            </Checkbox>
          </div>
        </Tabs.TabPane>
      </Tabs>
    </Modal>
  );
};

export default InstallModal;
