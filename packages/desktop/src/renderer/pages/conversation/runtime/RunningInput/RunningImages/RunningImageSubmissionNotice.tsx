/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { Button } from '@arco-design/web-react';
import { Attention, CloseSmall, Loading } from '@icon-park/react';
import React from 'react';
import { useTranslation } from 'react-i18next';
import type { RunningImageSubmission } from '@/renderer/services/runtime/RunningInput';
import { RUNNING_INPUT_MODE_KEY } from '../RunningInputModeSwitch';
import RunningImageTile from './RunningImageTile';
import {
  BLOCK_REASON_KEY,
  conversionLimits,
  describeAgainst,
  describeImage,
  describeOriginal,
  describeProgress,
  exactImageBytes,
  formatBytes,
  formatExactBytes,
  formatLimitBytes,
  formatLimits,
  showsLimits,
  type ImageLimits,
} from './format';

type RunningImageSubmissionNoticeProps = {
  submission: RunningImageSubmission;
  limits: ImageLimits;
  /** The blocked submission allows it and the composer draft is unchanged since that click. */
  canSendPaths: boolean;
  onSendPaths: () => void;
  onCancel: () => void;
  onDismiss: () => void;
};

/**
 * Sizes known so far, kept apart: measured originals, transmitted images after preparation,
 * and the estimated serialized native line for whichever of the two would be sent.
 */
const Measurements: React.FC<{ submission: RunningImageSubmission; limits: ImageLimits }> = ({
  submission,
  limits,
}) => {
  const { t, i18n } = useTranslation();
  const { language } = i18n;
  const { batch, measurements } = submission;
  const originals = (measurements?.originals ?? []).flatMap((original) => (original ? [original] : []));
  const tiles = batch
    ? batch.images.map((image, index) => (
        <RunningImageTile
          key={index}
          index={index + 1}
          size={image.sent}
          description={describeImage(t, image, limits.maxFileBytes, language)}
          detail={exactImageBytes(t, image, language)}
        />
      ))
    : (measurements?.originals ?? []).flatMap((original, index) =>
        original
          ? [
              <RunningImageTile
                key={index}
                index={index + 1}
                size={original}
                description={describeOriginal(t, original, limits.maxFileBytes, language)}
                detail={formatExactBytes(original.bytes, language)}
              />,
            ]
          : []
      );
  const lines: string[] = [];
  if (originals.length) {
    const total = originals.reduce((sum, { bytes }) => sum + bytes, 0);
    lines.push(t('acp.runningInput.images.sizes.originals', { size: formatBytes(total, language) }));
  }
  if (batch) {
    const sent = batch.images.reduce((sum, { sent: { bytes } }) => sum + bytes, 0);
    lines.push(describeAgainst(t, 'acp.runningInput.images.sizes.sent', sent, limits.maxTotalBytes, language));
    lines.push(
      describeAgainst(
        t,
        'acp.runningInput.images.sizes.lineSent',
        batch.estimatedLineBytes,
        limits.maxLineBytes,
        language
      )
    );
  } else if (measurements?.originalLineBytes !== undefined) {
    lines.push(
      describeAgainst(
        t,
        'acp.runningInput.images.sizes.lineOriginal',
        measurements.originalLineBytes,
        limits.maxLineBytes,
        language
      )
    );
  }
  if (!tiles.length && !lines.length) return null;
  return (
    <>
      {tiles.length > 0 && <div className='flex flex-wrap gap-x-12px gap-y-4px min-w-0'>{tiles}</div>}
      {lines.map((line) => (
        <span key={line} className='text-11px text-t-tertiary' data-testid='running-image-size'>
          {line}
        </span>
      ))}
    </>
  );
};

/**
 * Composer-local state of the latest image click before any write: local
 * preparation, or a block that kept the draft and every original attachment.
 */
const RunningImageSubmissionNotice: React.FC<RunningImageSubmissionNoticeProps> = ({
  submission,
  limits,
  canSendPaths,
  onSendPaths,
  onCancel,
  onDismiss,
}) => {
  const { t, i18n } = useTranslation();
  const mode = t(`acp.runningInput.mode.${RUNNING_INPUT_MODE_KEY[submission.mode]}`);

  if (submission.status === 'preparing') {
    const text =
      submission.stage === 'references'
        ? t('acp.runningInput.images.preparingReferences', { total: submission.fileCount })
        : t('acp.runningInput.images.preparing', { total: submission.imageCount, mode });
    const progress =
      submission.stage === 'images' && submission.progress
        ? describeProgress(t, submission.progress, submission.imageCount, i18n.language)
        : undefined;
    return (
      <div className='flex items-start gap-6px min-w-0' data-testid='running-image-submission' data-status='preparing'>
        <Loading theme='outline' size='14' className='flex shrink-0 mt-2px animate-spin' />
        <div className='flex-1 min-w-0 flex flex-col gap-4px'>
          <span className='break-words'>{text}</span>
          {progress && <span className='text-11px text-t-tertiary'>{progress}</span>}
          <Measurements submission={submission} limits={limits} />
        </div>
        <Button size='mini' type='text' className='shrink-0' onClick={onCancel}>
          {t('acp.runningInput.images.cancel')}
        </Button>
      </div>
    );
  }

  const reason = t(BLOCK_REASON_KEY[submission.reason], {
    max: limits.maxImages,
    lineLimit: formatLimitBytes(limits.maxLineBytes, i18n.language),
    ...conversionLimits(i18n.language),
  });
  return (
    <div
      className='flex items-start gap-6px min-w-0'
      data-testid='running-image-submission'
      data-status='blocked'
      data-reason={submission.reason}
    >
      <Attention theme='outline' size='14' className='flex shrink-0 mt-2px text-warning' />
      <div className='flex-1 min-w-0 flex flex-col gap-4px'>
        <span className='break-words'>{t('acp.runningInput.images.blocked', { reason })}</span>
        {showsLimits(submission.reason) && (
          <span className='text-11px text-t-tertiary'>{formatLimits(t, limits, i18n.language)}</span>
        )}
        <Measurements submission={submission} limits={limits} />
      </div>
      {canSendPaths && (
        <Button size='mini' type='outline' className='shrink-0' onClick={onSendPaths}>
          {t('acp.runningInput.images.sendPaths')}
        </Button>
      )}
      <Button
        size='mini'
        type='text'
        className='shrink-0'
        icon={<CloseSmall theme='outline' size='14' />}
        aria-label={t('acp.runningInput.dismiss')}
        onClick={onDismiss}
      />
    </div>
  );
};

export default RunningImageSubmissionNotice;
