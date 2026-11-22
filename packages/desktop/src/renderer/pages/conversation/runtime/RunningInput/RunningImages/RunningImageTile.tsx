/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { Pic } from '@icon-park/react';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatDimensions } from './format';

type RunningImageTileProps = {
  /** 1-based position in the submission, used for the accessible name. */
  index: number;
  /** Dimensions named by the icon fallback: the transmitted size when known. */
  size: { width?: number; height?: number };
  /** In-memory preview owned by the running input client. Read on every render, never stored. */
  url?: string;
  description: string;
  /** Exact byte counts for the tooltip. */
  detail?: string;
};

/**
 * One submitted image: the receipt-bound thumbnail, or an icon when no preview
 * exists, failed to render, or was released. The description beside it always
 * carries the transmitted W×H.
 */
const RunningImageTile: React.FC<RunningImageTileProps> = ({ index, size, url, description, detail }) => {
  const { t } = useTranslation();
  const [failedUrl, setFailedUrl] = useState<string>();
  const label = t('acp.runningInput.images.thumbnail', { index });
  const dimensions = formatDimensions(t, size);
  const thumbnail = url && url !== failedUrl ? url : undefined;

  return (
    <div className='flex items-center gap-6px min-w-0 max-w-full' data-testid='running-image-tile' title={detail}>
      {thumbnail ? (
        <img
          src={thumbnail}
          alt={label}
          className='size-40px shrink-0 rd-6px object-cover bg-fill-3'
          draggable={false}
          onError={() => setFailedUrl(thumbnail)}
          data-testid='running-image-thumbnail'
        />
      ) : (
        <div
          role='img'
          aria-label={dimensions ? `${label} ${dimensions}` : label}
          className='size-40px shrink-0 rd-6px bg-fill-3 text-t-tertiary flex items-center justify-center'
          data-testid='running-image-icon'
        >
          <Pic theme='outline' size='16' />
        </div>
      )}
      <span className='min-w-0 break-words text-11px leading-16px'>{description}</span>
    </div>
  );
};

export default RunningImageTile;
