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
import type { CheckFailure } from './checkFailure';
import type { SessionHolder } from './sessionHolder';
import type { SessionRecheckState } from './useSessionHolder';

export type HolderNotice = {
  variant: 'native' | 'other' | 'unconfirmed' | 'agent';
  title: string;
  body: string;
  /** Existing agent-error suggestions (e.g. log in to the agent) for a failed check. */
  hints: string[];
};

/**
 * Text for the blocked notice. A known holder names the holder; a failed check reuses
 * the existing agent-error guidance (title, body, suggestions) when the host gave a
 * structured agent error, and the login/installation suggestions for a plain upstream
 * failure, so an agent that needs a login still says so while sending stays paused.
 */
export const useHolderNotice = (holder: SessionHolder | null, failure?: CheckFailure): HolderNotice => {
  const { t } = useTranslation();
  if (holder) {
    return {
      variant: holder.kind,
      title: t(`conversation.sessionHolder.${holder.kind}.title`),
      body: t(`conversation.sessionHolder.${holder.kind}.body`),
      hints: [],
    };
  }
  const hints =
    failure && failure.kind !== 'unknown'
      ? failure.resolutions.map(
          (kind) => `${t('conversation.agentError.resolutionPrefix')}${t(`conversation.agentError.resolution.${kind}`)}`
        )
      : [];
  if (failure?.kind === 'agent') {
    return {
      variant: 'agent',
      title: t(`conversation.agentError.codes.${failure.code}.title`, {
        defaultValue: t('conversation.agentError.fallbackTitle'),
      }),
      body: t(`conversation.agentError.codes.${failure.code}.body`, {
        defaultValue: failure.detail ?? t('conversation.sessionHolder.unconfirmed.body'),
      }),
      hints,
    };
  }
  return {
    variant: 'unconfirmed',
    title: t('conversation.sessionHolder.unconfirmed.title'),
    body: t('conversation.sessionHolder.unconfirmed.body'),
    hints,
  };
};

type SessionHolderBarProps = {
  /** `null` when no check has confirmed or excluded a lock yet (unconfirmed). */
  holder: SessionHolder | null;
  recheckState: SessionRecheckState;
  failure?: CheckFailure;
  onRecheck: () => void;
};

/**
 * Read-only notice shown in place of the send box while another writer holds the
 * session, or while no check has confirmed that none does. It names the holder when
 * known, explains a failed check with the existing agent guidance, and offers a manual
 * recheck. Announcements come from the gate's persistent status region, so this notice
 * has no live role of its own.
 */
const SessionHolderBar: React.FC<SessionHolderBarProps> = ({ holder, recheckState, failure, onRecheck }) => {
  const { t } = useTranslation();
  const notice = useHolderNotice(holder, failure);
  const HolderIcon = notice.variant === 'native' ? Terminal : notice.variant === 'other' ? Lock : Caution;
  const detail = recheckState === 'failed' ? failure?.detail : undefined;

  return (
    <div className={`${getChatSurfaceWidthClass()} flex flex-col mt-auto mb-16px`}>
      <div
        data-testid='session-holder-bar'
        data-holder-kind={notice.variant}
        className='flex flex-wrap items-center gap-12px p-16px b b-solid border-3 rd-20px bg-dialog-fill-0'
      >
        <HolderIcon theme='outline' size='20' className='flex shrink-0 text-warning' />
        <div className='flex-1 min-w-200px flex flex-col gap-4px'>
          <div className='flex flex-wrap items-center gap-8px'>
            <span className='text-14px font-medium text-t-primary'>{notice.title}</span>
            <Tag size='small' color='orange'>
              {t('conversation.sessionHolder.readOnly')}
            </Tag>
          </div>
          <span className='text-13px leading-20px text-t-secondary'>{notice.body}</span>
          {notice.hints.map((hint) => (
            <span key={hint} className='text-12px leading-18px text-t-secondary'>
              {hint}
            </span>
          ))}
          {notice.variant === 'agent' && (
            <span className='text-12px leading-18px text-t-secondary'>{t('conversation.sessionHolder.paused')}</span>
          )}
          {recheckState === 'stillHeld' && (
            <span className='text-12px leading-18px text-t-secondary'>{t('conversation.sessionHolder.stillHeld')}</span>
          )}
          {recheckState === 'failed' && holder && (
            <span className='text-12px leading-18px text-danger'>{t('conversation.sessionHolder.checkFailed')}</span>
          )}
          {detail && <span className='text-12px leading-18px text-t-secondary line-clamp-2 break-words'>{detail}</span>}
        </div>
        <Button size='small' className='ml-auto' loading={recheckState === 'checking'} onClick={onRecheck}>
          {t('conversation.sessionHolder.recheck')}
        </Button>
      </div>
    </div>
  );
};

export default SessionHolderBar;
