/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ExtensionEntry, ExtensionOrigin, ExtensionStatus } from '@aionui/web-host';
import { Button, Popconfirm, Tag, Tooltip } from '@arco-design/web-react';
import { Delete, Refresh, Upload } from '@icon-park/react';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { upgradeOf } from '../state/upgrade';

const STATUS_COLOR: Record<ExtensionStatus, string> = {
  ready: 'green',
  manifest_unbound: 'orangered',
  reinstall_needed: 'red',
};

/** The host of a URL, or the text itself when it is not one. */
const hostOf = (url: string): string => {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
};

/** Where an entry came from, short: the package index host, the Git repository (and path), the file. */
function originDetail(origin: ExtensionOrigin | null): string | undefined {
  if (!origin) return undefined;
  if (origin.kind === 'file') return origin.wheel;
  const host = hostOf;
  if (origin.kind === 'index') return host(origin.indexUrl);
  return origin.subdirectory ? `${host(origin.url)} · ${origin.subdirectory}` : host(origin.url);
}

type Props = {
  extensions: ExtensionEntry[];
  /** A change is running: no other can start. */
  busy: boolean;
  onUpgrade: (entry: ExtensionEntry) => void;
  onUpdateFromFile: (entry: ExtensionEntry) => void;
  onRemove: (entry: ExtensionEntry) => void;
};

/** The extensions Studio installed, with what can be done to each. */
const ExtensionList: React.FC<Props> = ({ extensions, busy, onUpgrade, onUpdateFromFile, onRemove }) => {
  const { t } = useTranslation();
  if (extensions.length === 0) {
    return (
      <div
        data-testid='agent-extensions-empty'
        className='py-24px text-center text-t-secondary text-14px border border-dashed border-border-2 rd-12px'
      >
        {t('settings.agentExtensions.empty')}
      </div>
    );
  }
  return (
    <div className='flex flex-col gap-12px' data-testid='agent-extensions-list'>
      {extensions.map((entry) => {
        const upgrade = upgradeOf(entry);
        const detail = originDetail(entry.origin);
        return (
          <div
            key={entry.name}
            data-testid={`agent-extension-${entry.name}`}
            className='flex flex-col gap-8px md:flex-row md:items-center md:justify-between px-16px py-12px bg-2 rd-12px border border-border-2'
          >
            <div className='flex min-w-0 flex-col gap-4px'>
              <div className='flex flex-wrap items-center gap-8px'>
                <span className='text-14px font-medium text-t-primary break-all'>{entry.name}</span>
                <span className='text-12px text-t-secondary'>{entry.version}</span>
                <Tooltip
                  disabled={entry.status === 'ready'}
                  content={t(`settings.agentExtensions.statusHint.${entry.status}`)}
                >
                  <Tag size='small' color={STATUS_COLOR[entry.status]} data-testid='agent-extension-status'>
                    {t(`settings.agentExtensions.status.${entry.status}`)}
                  </Tag>
                </Tooltip>
              </div>
              <div className='flex flex-wrap items-center gap-6px text-12px text-t-secondary'>
                {entry.distribution !== entry.name && <span className='break-all'>{entry.distribution}</span>}
                <Tag size='small' bordered>
                  {t(`settings.agentExtensions.origin.${entry.origin?.kind ?? 'unknown'}`)}
                </Tag>
                {detail && <span className='break-all'>{detail}</span>}
              </div>
            </div>
            <div className='flex shrink-0 flex-wrap items-center gap-8px'>
              {upgrade && (
                <Button
                  size='small'
                  icon={<Refresh theme='outline' size='14' />}
                  disabled={busy}
                  onClick={() => onUpgrade(entry)}
                  data-testid='agent-extension-upgrade'
                >
                  {t('settings.agentExtensions.actions.upgrade')}
                </Button>
              )}
              {entry.origin?.kind === 'file' && (
                <Button
                  size='small'
                  icon={<Upload theme='outline' size='14' />}
                  disabled={busy}
                  onClick={() => onUpdateFromFile(entry)}
                  data-testid='agent-extension-update'
                >
                  {t('settings.agentExtensions.actions.updateFromFile')}
                </Button>
              )}
              <Popconfirm
                title={t('settings.agentExtensions.remove.title', { name: entry.name })}
                content={t('settings.agentExtensions.remove.body')}
                okText={t('settings.agentExtensions.actions.remove')}
                cancelText={t('settings.agentExtensions.actions.cancel')}
                okButtonProps={{ status: 'danger' }}
                disabled={busy}
                onOk={() => onRemove(entry)}
              >
                <Button
                  size='small'
                  status='danger'
                  icon={<Delete theme='outline' size='14' />}
                  disabled={busy}
                  data-testid='agent-extension-remove'
                >
                  {t('settings.agentExtensions.actions.remove')}
                </Button>
              </Popconfirm>
            </div>
          </div>
        );
      })}
    </div>
  );
};

export default ExtensionList;
