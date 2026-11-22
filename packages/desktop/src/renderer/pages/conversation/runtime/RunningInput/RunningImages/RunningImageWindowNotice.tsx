/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { Button } from '@arco-design/web-react';
import { CloseSmall, Info } from '@icon-park/react';
import React from 'react';
import { useTranslation } from 'react-i18next';
import type { RunningImageState } from '@/renderer/services/runtime/RunningInput';
import { formatBytes } from './format';

export type RunningImageWindow = NonNullable<RunningImageState['window']>;
type WindowReason = keyof RunningImageWindow['reasons'];

const WINDOW_REASON_KEY = {
  image_count: 'acp.runningInput.images.windowReason.count',
  raw_bytes: 'acp.runningInput.images.windowReason.bytes',
  'model-unverified': 'acp.runningInput.images.windowReason.unsupported',
  'image-bytes': 'acp.runningInput.images.windowReason.unsupported',
  'image-dimensions': 'acp.runningInput.images.windowReason.unsupported',
  'image-mime': 'acp.runningInput.images.windowReason.unsupported',
  'invalid-image-header': 'acp.runningInput.images.windowReason.unsupported',
  'animated-image': 'acp.runningInput.images.windowReason.unsupported',
  'unsupported-image': 'acp.runningInput.images.windowReason.unsupported',
} as const satisfies Record<WindowReason, string>;

/**
 * The latest provider request replaced earlier images with placeholders. This
 * describes the model request only; history and queue receipts are unchanged.
 */
const RunningImageWindowNotice: React.FC<{ sample: RunningImageWindow; onDismiss: () => void }> = ({
  sample,
  onDismiss,
}) => {
  const { t, i18n } = useTranslation();

  const counts = new Map<string, number>();
  for (const [reason, count] of Object.entries(sample.reasons) as [WindowReason, number][]) {
    const key = WINDOW_REASON_KEY[reason];
    counts.set(key, (counts.get(key) ?? 0) + count);
  }
  const reasons = Array.from(counts, ([key, count]) =>
    t('acp.runningInput.images.windowReasonCount', { reason: t(key), total: count })
  ).join(t('acp.runningInput.images.listSeparator'));

  return (
    <div className='flex items-start gap-6px min-w-0' data-testid='running-image-window'>
      <Info theme='outline' size='14' className='flex shrink-0 mt-2px' />
      <div className='flex-1 min-w-0 flex flex-col gap-2px'>
        <span className='break-words'>
          {t('acp.runningInput.images.window', {
            omitted: sample.omittedCount,
            kept: sample.keptCount,
            bytes: formatBytes(sample.keptRawBytes, i18n.language),
          })}
        </span>
        {reasons && (
          <span className='text-11px text-t-tertiary'>{t('acp.runningInput.images.windowReasons', { reasons })}</span>
        )}
      </div>
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

export default RunningImageWindowNotice;
