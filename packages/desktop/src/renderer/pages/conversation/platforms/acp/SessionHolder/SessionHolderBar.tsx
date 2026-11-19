/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { Button, Tag } from '@arco-design/web-react';
import { Lock, Terminal } from '@icon-park/react';
import { getChatSurfaceWidthClass } from '@/renderer/pages/conversation/utils/chatSurfaceWidth';
import React from 'react';
import { useTranslation } from 'react-i18next';
import type { SessionHolder } from './sessionHolder';

type SessionHolderBarProps = {
  holder: SessionHolder;
  checking: boolean;
  stillHeld: boolean;
  onRecheck: () => void;
};

/**
 * Read-only notice shown in place of the send box while another writer holds the
 * session. It names the holder and offers a manual recheck.
 */
const SessionHolderBar: React.FC<SessionHolderBarProps> = ({ holder, checking, stillHeld, onRecheck }) => {
  const { t } = useTranslation();
  const HolderIcon = holder.kind === 'native' ? Terminal : Lock;

  return (
    <div className={`${getChatSurfaceWidthClass()} flex flex-col mt-auto mb-16px`}>
      <div
        role='status'
        aria-live='polite'
        data-testid='session-holder-bar'
        data-holder-kind={holder.kind}
        className='flex flex-wrap items-center gap-12px p-16px b b-solid border-3 rd-20px bg-dialog-fill-0'
      >
        <HolderIcon theme='outline' size='20' className='flex shrink-0 text-warning' />
        <div className='flex-1 min-w-200px flex flex-col gap-4px'>
          <div className='flex flex-wrap items-center gap-8px'>
            <span className='text-14px font-medium text-t-primary'>
              {t(`conversation.sessionHolder.${holder.kind}.title`)}
            </span>
            <Tag size='small' color='orange'>
              {t('conversation.sessionHolder.readOnly')}
            </Tag>
          </div>
          <span className='text-13px leading-20px text-t-secondary'>
            {t(`conversation.sessionHolder.${holder.kind}.body`)}
          </span>
          {stillHeld && (
            <span className='text-12px leading-18px text-t-secondary'>{t('conversation.sessionHolder.stillHeld')}</span>
          )}
        </div>
        <Button size='small' className='ml-auto' loading={checking} onClick={onRecheck}>
          {t('conversation.sessionHolder.recheck')}
        </Button>
      </div>
    </div>
  );
};

export default SessionHolderBar;
