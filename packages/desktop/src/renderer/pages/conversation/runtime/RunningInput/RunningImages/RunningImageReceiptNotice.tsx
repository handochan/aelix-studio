/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { Button } from '@arco-design/web-react';
import { Attention, CheckOne, CloseSmall, Help, Loading } from '@icon-park/react';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { IMAGE_ONLY_CAPTION } from '@/renderer/services/runtime/RunningInput';
import type { RunningImageController } from '../useRunningInput';
import { RUNNING_INPUT_MODE_KEY } from '../RunningInputModeSwitch';
import { rejectReason, type RunningInputRejectReason } from '../notices';
import RunningImageTile from './RunningImageTile';
import { describeImage, formatLimitBytes, formatMeasuredBytes, REJECTION_KEY, type ImageLimits } from './format';

type Entry = RunningImageController['receipts'][number];

const RELAY_REASON_KEY = {
  'stale-turn': 'acp.runningInput.reason.staleTurn',
  'dedup-capacity': 'acp.runningInput.reason.dedupCapacity',
  'rate-limited': 'acp.runningInput.reason.rateLimited',
  'too-large': 'acp.runningInput.reason.tooLarge',
  'session-changed': 'acp.runningInput.reason.sessionChanged',
  failed: 'acp.runningInput.reason.failed',
} as const satisfies Record<RunningInputRejectReason, string>;

type RunningImageReceiptNoticeProps = {
  entry: Entry;
  limits: ImageLimits;
  preview: RunningImageController['preview'];
  onDismiss: (requestIds: readonly string[]) => void;
  onCheck: (requestId: string) => void;
};

const StatusIcon: React.FC<{ status: Entry['receipt']['status'] }> = ({ status }) => {
  const className = 'flex shrink-0 mt-2px';
  if (status === 'queued') return <CheckOne theme='outline' size='14' className={`${className} text-success`} />;
  if (status === 'pending') return <Loading theme='outline' size='14' className={`${className} animate-spin`} />;
  if (status === 'rejected') return <Attention theme='outline' size='14' className={`${className} text-warning`} />;
  return <Help theme='outline' size='14' className={`${className} text-warning`} />;
};

/**
 * Receipt for one pixel submission on its original binding, turn and request ID.
 * It reports native queue acceptance only and never claims consumption. The
 * thumbnails are local previews of the transmitted bytes, not history rows.
 */
const RunningImageReceiptNotice: React.FC<RunningImageReceiptNoticeProps> = ({
  entry,
  limits,
  preview,
  onDismiss,
  onCheck,
}) => {
  const { t, i18n } = useTranslation();
  const { receipt, phase } = entry;
  const mode = t(`acp.runningInput.mode.${RUNNING_INPUT_MODE_KEY[receipt.mode]}`);

  const describe = (): string => {
    switch (receipt.status) {
      case 'pending':
        return t('acp.runningInput.images.pending', { mode });
      case 'queued':
        if (phase === 'active') return t('acp.runningInput.images.queued', { mode });
        return t(phase === 'ended' ? 'acp.runningInput.images.queuedEnded' : 'acp.runningInput.images.queuedStopped');
      case 'unknown':
        return t('acp.runningInput.images.unknown', { mode });
      case 'rejected': {
        const key = 'reason' in receipt ? REJECTION_KEY[receipt.reason] : RELAY_REASON_KEY[rejectReason(receipt)];
        return t('acp.runningInput.images.rejected', { mode, reason: t(key, { max: limits.maxImages }) });
      }
    }
  };

  const captionAdded = receipt.status === 'queued' && receipt.captionAdded === true;
  const { images, estimatedLineBytes } = receipt.pixels;

  return (
    <div
      className='flex items-start gap-6px min-w-0'
      data-testid='running-input-notice'
      data-kind={receipt.status}
      data-images='true'
    >
      <StatusIcon status={receipt.status} />
      <div className='flex-1 min-w-0 flex flex-col gap-4px'>
        <span className='break-words'>{describe()}</span>
        {captionAdded && (
          <span className='break-words text-t-tertiary' data-testid='running-image-caption'>
            {t('acp.runningInput.images.caption')} <q className='text-t-secondary'>{IMAGE_ONLY_CAPTION}</q>
          </span>
        )}
        <div className='flex flex-wrap gap-x-12px gap-y-4px min-w-0'>
          {images.map((image, index) => {
            const original = formatMeasuredBytes(image.original.bytes, i18n.language);
            const sent = formatMeasuredBytes(image.sent.bytes, i18n.language);
            return (
              <RunningImageTile
                key={image.sent.sha256 + ':' + index}
                index={index + 1}
                size={image.sent}
                url={receipt.status === 'queued' ? preview(receipt.requestId, image.sent.sha256) : undefined}
                description={describeImage(t, image, i18n.language)}
                detail={
                  image.downscaled || image.orientationOnly
                    ? t('acp.runningInput.images.bytesChange', { from: original.exact, to: sent.exact })
                    : sent.exact
                }
              />
            );
          })}
        </div>
        {(receipt.status === 'pending' || receipt.status === 'queued') && (
          <span className='text-11px text-t-tertiary'>
            {t('acp.runningInput.images.line', {
              size: formatMeasuredBytes(estimatedLineBytes, i18n.language).text,
              limit: formatLimitBytes(limits.maxLineBytes, i18n.language),
            })}
          </span>
        )}
      </div>
      {receipt.status === 'unknown' && (
        <Button size='mini' type='text' className='shrink-0' onClick={() => onCheck(receipt.requestId)}>
          {t('acp.runningInput.images.checkResult')}
        </Button>
      )}
      {receipt.status !== 'pending' && (
        <Button
          size='mini'
          type='text'
          className='shrink-0'
          icon={<CloseSmall theme='outline' size='14' />}
          aria-label={t('acp.runningInput.dismiss')}
          onClick={() => onDismiss([receipt.requestId])}
        />
      )}
    </div>
  );
};

export default RunningImageReceiptNotice;
