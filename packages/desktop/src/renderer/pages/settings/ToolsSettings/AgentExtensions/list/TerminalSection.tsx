/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TerminalCliEnvironment, TerminalCliListing } from '@aionui/web-host';
import { Alert, Button, Collapse, Spin, Tag } from '@arco-design/web-react';
import { Refresh } from '@icon-park/react';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { failureKey } from '../messages';

const STATUS_COLOR: Record<TerminalCliEnvironment['status'], string> = {
  listed: 'green',
  not_a_venv: 'gray',
  unresolved_launcher: 'gray',
  no_cli: 'gray',
  unreadable: 'orangered',
};

type Props = {
  listing?: TerminalCliListing;
  loading: boolean;
  /** The code of a failed read, if the last one failed. */
  failure?: string;
  onRefresh: () => void;
};

const Environment: React.FC<{ environment: TerminalCliEnvironment }> = ({ environment }) => {
  const { t } = useTranslation();
  return (
    <div
      className='flex flex-col gap-8px px-16px py-12px bg-1 rd-8px border border-border-2'
      data-testid='terminal-environment'
    >
      <div className='flex flex-wrap items-center gap-8px'>
        <span className='text-13px font-mono text-t-primary break-all'>{environment.location}</span>
        <Tag size='small' color={STATUS_COLOR[environment.status]}>
          {t(`settings.agentExtensions.terminal.status.${environment.status}`)}
        </Tag>
        {environment.foundBy.map((by) => (
          <Tag key={by} size='small' bordered>
            {t(`settings.agentExtensions.terminal.foundBy.${by}`)}
          </Tag>
        ))}
        {environment.nativeVersion && (
          <span className='text-12px text-t-secondary'>
            {t('settings.agentExtensions.terminal.nativeVersion', { version: environment.nativeVersion })}
          </span>
        )}
      </div>
      {environment.launchers.length > 0 && (
        <div className='text-12px text-t-secondary break-all'>
          {t('settings.agentExtensions.terminal.launchers', { launchers: environment.launchers.join(', ') })}
        </div>
      )}
      {environment.status === 'listed' &&
        (environment.extensions.length === 0 ? (
          <div className='text-12px text-t-secondary'>{t('settings.agentExtensions.terminal.noExtensions')}</div>
        ) : (
          <ul className='m-0 flex flex-col gap-4px ps-0 list-none'>
            {environment.extensions.map((extension) => (
              <li
                key={`${extension.name}:${extension.distribution}`}
                className='flex flex-wrap items-center gap-8px text-13px'
              >
                <span className='text-t-primary'>{extension.name}</span>
                <span className='text-12px text-t-secondary'>
                  {extension.distribution} {extension.version}
                </span>
              </li>
            ))}
          </ul>
        ))}
      {(environment.issues.length > 0 || environment.truncated) && (
        <div className='flex flex-wrap gap-6px'>
          {environment.issues.map((issue) => (
            <Tag key={issue} size='small' color='orange'>
              {t(`settings.agentExtensions.terminal.issues.${issue}`)}
            </Tag>
          ))}
          {environment.truncated && (
            <Tag size='small' color='orange'>
              {t('settings.agentExtensions.terminal.truncatedDistributions')}
            </Tag>
          )}
        </div>
      )}
    </div>
  );
};

/**
 * The extensions of the user's terminal `aelix`, read only (2026-11-22 user decision 4). Studio
 * reads them from files; it cannot install, remove or check them, and Studio conversations do
 * not use them.
 */
const TerminalSection: React.FC<Props> = ({ listing, loading, failure, onRefresh }) => {
  const { t } = useTranslation();
  const global = listing?.globalExtensions;
  return (
    <section
      className='flex flex-col gap-12px px-[12px] md:px-[32px] py-[24px] bg-2 rd-12px md:rd-16px border border-border-2'
      data-testid='terminal-section'
    >
      <div className='flex items-start justify-between gap-12px'>
        <div className='flex min-w-0 flex-col gap-4px'>
          <span className='text-14px font-medium text-t-primary'>{t('settings.agentExtensions.terminal.title')}</span>
          <span className='text-12px text-t-secondary'>{t('settings.agentExtensions.terminal.description')}</span>
        </div>
        <Button
          size='small'
          icon={<Refresh theme='outline' size='14' />}
          loading={loading}
          onClick={onRefresh}
          data-testid='terminal-refresh'
        >
          {t('settings.agentExtensions.actions.refresh')}
        </Button>
      </div>
      {failure && <Alert type='warning' content={t(failureKey(failure))} />}
      {!listing && loading && <Spin className='self-center' />}
      {listing && (
        <>
          {(listing.timedOut || listing.truncated) && (
            <Alert
              type='info'
              content={t(
                listing.timedOut
                  ? 'settings.agentExtensions.terminal.timedOut'
                  : 'settings.agentExtensions.terminal.truncated'
              )}
            />
          )}
          {listing.environments.length === 0 ? (
            <div className='text-13px text-t-secondary' data-testid='terminal-none'>
              {t('settings.agentExtensions.terminal.none')}
            </div>
          ) : (
            listing.environments.map((environment) => (
              <Environment key={environment.location} environment={environment} />
            ))
          )}
          <div className='flex flex-col gap-6px' data-testid='terminal-global'>
            <span className='text-13px text-t-primary'>
              {t('settings.agentExtensions.terminal.globalTitle', { location: global?.location ?? '' })}
            </span>
            {global?.status !== 'listed' || global.extensions.length === 0 ? (
              <span className='text-12px text-t-secondary'>{t('settings.agentExtensions.terminal.globalEmpty')}</span>
            ) : (
              <div className='flex flex-wrap gap-6px'>
                {global.extensions.map((extension) => (
                  <Tag key={extension.name} size='small' bordered>
                    {extension.name} · {t(`settings.agentExtensions.terminal.kinds.${extension.kind}`)}
                  </Tag>
                ))}
              </div>
            )}
            {global?.truncated && (
              <span className='text-12px text-t-secondary'>
                {t('settings.agentExtensions.terminal.truncatedGlobal')}
              </span>
            )}
          </div>
          <Collapse
            bordered={false}
            defaultActiveKey={listing.environments.length === 0 ? ['searched'] : []}
            data-testid='terminal-searched'
          >
            <Collapse.Item name='searched' header={t('settings.agentExtensions.terminal.searched')}>
              <ul className='m-0 ps-16px text-12px font-mono text-t-secondary'>
                {listing.searched.map((place) => (
                  <li key={place} className='break-all'>
                    {place}
                  </li>
                ))}
              </ul>
            </Collapse.Item>
          </Collapse>
        </>
      )}
    </section>
  );
};

export default TerminalSection;
