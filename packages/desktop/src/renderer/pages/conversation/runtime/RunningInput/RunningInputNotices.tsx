/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { Button } from '@arco-design/web-react';
import { Attention, CheckOne, CloseSmall, Help, Loading } from '@icon-park/react';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { RunningInputNotice, RunningInputRejectReason } from './notices';
import { RUNNING_INPUT_MODE_KEY } from './RunningInputModeSwitch';
import {
  currentLimits,
  RunningImageReceiptNotice,
  RunningImageSubmissionNotice,
  RunningImageWindowNotice,
  windowSampleKey,
} from './RunningImages';
import type { RunningImageController } from './useRunningInput';

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
  /** Pixel submission state and receipts. Omitted when the composer does not send pixels. */
  images?: RunningImageController;
  /** Path-only delivery of the blocked draft, when the composer still holds it. */
  onSendPaths?: () => void;
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
const RunningInputNotices: React.FC<RunningInputNoticesProps> = ({
  notices,
  onDismiss,
  onCheck,
  images,
  onSendPaths,
}) => {
  const { t } = useTranslation();
  const submission = images?.submission;
  // A pre-write ACP limit rejection becomes a blocked submission for the same click. Show it once.
  const superseded = submission?.status === 'blocked' ? submission.requestId : undefined;
  const imageReceipts = (images?.receipts ?? []).filter(
    ({ receipt }) => receipt.status !== 'rejected' || receipt.requestId !== superseded
  );
  const hasSuperseded = imageReceipts.length !== (images?.receipts.length ?? 0);
  const [dismissedWindow, setDismissedWindow] = useState<string>();
  const sample = images?.state?.window;
  const providerWindow =
    sample && sample.omittedCount > 0 && windowSampleKey(sample) !== dismissedWindow ? sample : undefined;
  const limits = currentLimits(images?.state);
  const receiptCount = notices.length + imageReceipts.length;
  const modeLabel = (mode: keyof typeof RUNNING_INPUT_MODE_KEY) =>
    t(`acp.runningInput.mode.${RUNNING_INPUT_MODE_KEY[mode]}`);

  const describe = (notice: RunningInputNotice): string => {
    switch (notice.kind) {
      case 'queued':
        return notice.phase === 'active'
          ? t('acp.runningInput.queued', { modes: notice.modes.map(modeLabel).join(', ') })
          : t(notice.phase === 'ended' ? 'acp.runningInput.queuedEnded' : 'acp.runningInput.queuedStopped');
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
      {(receiptCount > 0 || submission || providerWindow) && (
        <div className='mb-6px flex flex-col gap-2px rd-8px px-10px py-6px text-12px leading-18px bg-fill-2 text-t-secondary'>
          {images && submission && (
            <RunningImageSubmissionNotice
              submission={submission}
              limits={limits}
              canSendPaths={!!onSendPaths && submission.status === 'blocked' && submission.allowPathOnly}
              onSendPaths={() => onSendPaths?.()}
              onCancel={images.cancelPreparation}
              onDismiss={() => {
                images.dismissSubmission();
                if (hasSuperseded && superseded) onDismiss([superseded]);
              }}
            />
          )}
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
          {images &&
            imageReceipts.map((entry) => (
              <RunningImageReceiptNotice
                key={entry.receipt.requestId}
                entry={entry}
                limits={limits}
                preview={images.preview}
                onDismiss={onDismiss}
                onCheck={onCheck}
              />
            ))}
          {providerWindow && (
            <RunningImageWindowNotice
              sample={providerWindow}
              onDismiss={() => setDismissedWindow(windowSampleKey(providerWindow))}
            />
          )}
          {receiptCount > 1 && (
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
