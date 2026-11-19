/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { Button, Tag } from '@arco-design/web-react';
import { Caution, Lock, Terminal } from '@icon-park/react';
import { getChatSurfaceWidthClass } from '@/renderer/pages/conversation/utils/chatSurfaceWidth';
import React from 'react';
import { useTranslation } from 'react-i18next';
import type { SessionHolder } from './sessionHolder';
import type { SessionRecheckState } from './useSessionHolder';

type SessionHolderBarProps = {
  /** `null` when no check has confirmed or excluded a lock yet (unconfirmed). */
  holder: SessionHolder | null;
  recheckState: SessionRecheckState;
  errorDetail?: string;
  onRecheck: () => void;
};

/**
 * Read-only notice shown in place of the send box while another writer holds the
 * session, or while no check has confirmed that none does. It names the holder when
 * known and offers a manual recheck. Announcements come from the gate's persistent
 * status region, so this notice has no live role of its own.
 */
const SessionHolderBar: React.FC<SessionHolderBarProps> = ({ holder, recheckState, errorDetail, onRecheck }) => {
  const { t } = useTranslation();
  const variant = holder?.kind ?? 'unconfirmed';
  const HolderIcon = variant === 'native' ? Terminal : variant === 'other' ? Lock : Caution;

  return (
    <div className={`${getChatSurfaceWidthClass()} flex flex-col mt-auto mb-16px`}>
      <div
        data-testid='session-holder-bar'
        data-holder-kind={variant}
        className='flex flex-wrap items-center gap-12px p-16px b b-solid border-3 rd-20px bg-dialog-fill-0'
      >
        <HolderIcon theme='outline' size='20' className='flex shrink-0 text-warning' />
        <div className='flex-1 min-w-200px flex flex-col gap-4px'>
          <div className='flex flex-wrap items-center gap-8px'>
            <span className='text-14px font-medium text-t-primary'>
              {t(`conversation.sessionHolder.${variant}.title`)}
            </span>
            <Tag size='small' color='orange'>
              {t('conversation.sessionHolder.readOnly')}
            </Tag>
          </div>
          <span className='text-13px leading-20px text-t-secondary'>
            {t(`conversation.sessionHolder.${variant}.body`)}
          </span>
          {recheckState === 'stillHeld' && (
            <span className='text-12px leading-18px text-t-secondary'>{t('conversation.sessionHolder.stillHeld')}</span>
          )}
          {recheckState === 'failed' && holder && (
            <span className='text-12px leading-18px text-danger'>{t('conversation.sessionHolder.checkFailed')}</span>
          )}
          {recheckState === 'failed' && errorDetail && (
            <span className='text-12px leading-18px text-t-secondary line-clamp-2 break-words'>{errorDetail}</span>
          )}
        </div>
        <Button size='small' className='ml-auto' loading={recheckState === 'checking'} onClick={onRecheck}>
          {t('conversation.sessionHolder.recheck')}
        </Button>
      </div>
    </div>
  );
};

export default SessionHolderBar;
