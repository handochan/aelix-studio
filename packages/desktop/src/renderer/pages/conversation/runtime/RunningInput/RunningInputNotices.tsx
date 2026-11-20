/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { Button } from '@arco-design/web-react';
import { Attention, CheckOne, CloseSmall, Help, Loading } from '@icon-park/react';
import React from 'react';
import { useTranslation } from 'react-i18next';
import type { RunningInputNotice, RunningInputRejectReason } from './notices';
import { RUNNING_INPUT_MODE_KEY } from './RunningInputModeSwitch';

const REASON_KEY = {
  'stale-turn': 'staleTurn',
  'dedup-capacity': 'dedupCapacity',
  'rate-limited': 'rateLimited',
  'too-large': 'tooLarge',
  'session-changed': 'sessionChanged',
  failed: 'failed',
} as const satisfies Record<RunningInputRejectReason, string>;

type RunningInputNoticesProps = {
  notices: readonly RunningInputNotice[];
  onDismiss: (requestIds?: readonly string[]) => void;
  onCheck: (requestId: string) => void;
};

const NoticeIcon: React.FC<{ kind: RunningInputNotice['kind'] }> = ({ kind }) => {
  const props = { theme: 'outline', size: '14', className: 'flex shrink-0 mt-2px' } as const;
  if (kind === 'queued') return <CheckOne {...props} className={`${props.className} text-success`} />;
  if (kind === 'pending') return <Loading {...props} className={`${props.className} animate-spin`} />;
  if (kind === 'rejected') return <Attention {...props} className={`${props.className} text-warning`} />;
  return <Help {...props} className={`${props.className} text-warning`} />;
};

/**
 * Compact, non-blocking receipts for input sent to a running turn. It reports queue
 * acceptance only: it neither shows the text as a history row nor claims consumption.
 */
const RunningInputNotices: React.FC<RunningInputNoticesProps> = ({ notices, onDismiss, onCheck }) => {
  const { t } = useTranslation();
  const modeLabel = (mode: keyof typeof RUNNING_INPUT_MODE_KEY) =>
    t(`acp.runningInput.mode.${RUNNING_INPUT_MODE_KEY[mode]}`);

  const describe = (notice: RunningInputNotice): string => {
    switch (notice.kind) {
      case 'queued':
        return notice.phase === 'active'
          ? t('acp.runningInput.queued', { modes: notice.modes.map(modeLabel).join(', ') })
          : t(notice.phase === 'stopped' ? 'acp.runningInput.queuedStopped' : 'acp.runningInput.queuedEnded');
      case 'pending':
        return t('acp.runningInput.pending', { mode: modeLabel(notice.mode) });
      case 'unknown':
        return t('acp.runningInput.unknown', { mode: modeLabel(notice.mode) });
      case 'rejected':
        return t('acp.runningInput.rejected', {
          mode: modeLabel(notice.mode),
          reason: t(`acp.runningInput.reason.${REASON_KEY[notice.reason]}`),
        });
    }
  };

  return (
    <div role='status' aria-live='polite' data-testid='running-input-notices'>
      {notices.length > 0 && (
        <div className='mb-6px flex flex-col gap-2px rd-8px px-10px py-6px text-12px leading-18px bg-fill-2 text-t-secondary'>
          {notices.map((notice) => (
            <div
              key={notice.key}
              className='flex items-start gap-6px min-w-0'
              data-testid='running-input-notice'
              data-kind={notice.kind}
            >
              <NoticeIcon kind={notice.kind} />
              <span className='flex-1 min-w-0 break-words'>{describe(notice)}</span>
              {notice.kind === 'unknown' && (
                <Button size='mini' type='text' className='shrink-0' onClick={() => onCheck(notice.requestIds[0])}>
                  {t('acp.runningInput.check')}
                </Button>
              )}
              {notice.kind !== 'pending' && (
                <Button
                  size='mini'
                  type='text'
                  className='shrink-0'
                  icon={<CloseSmall theme='outline' size='14' />}
                  aria-label={t('acp.runningInput.dismiss')}
                  onClick={() => onDismiss(notice.requestIds)}
                />
              )}
            </div>
          ))}
          {notices.length > 1 && (
            <Button size='mini' type='text' className='self-end' onClick={() => onDismiss()}>
              {t('acp.runningInput.dismissAll')}
            </Button>
          )}
        </div>
      )}
    </div>
  );
};

export default RunningInputNotices;
