/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TFunction } from 'i18next';
import {
  RUNNING_IMAGE_LIMITS,
  type RunningImageBlockReason,
  type RunningImageDetails,
  type RunningImageState,
} from '@/renderer/services/runtime/RunningInput';
import type { RunningImageRejection } from '@/renderer/services/runtime/RunningInput/imageProtocol';
import type { ImageProgress } from '@/renderer/services/runtime/RunningInput/Images/types';
import { formatByteSize, formatNumber } from '@/renderer/services/i18n/format';

const MIB = 1024 * 1024;
const REASON = 'acp.runningInput.images.reason.';

/** One literal key per block reason so the i18n check validates every message. */
export const BLOCK_REASON_KEY = {
  cancelled: `${REASON}cancelled`,
  'invalid-image': `${REASON}invalidImage`,
  'unsupported-format': `${REASON}unsupportedFormat`,
  'unsupported-model': `${REASON}textOnlyModel`,
  'model-text-only': `${REASON}textOnlyModel`,
  'model-unverified': `${REASON}modelUnverified`,
  'source-too-large': `${REASON}sourceTooLarge`,
  'source-unavailable': `${REASON}sourceUnavailable`,
  'references-unverified': `${REASON}sourceUnavailable`,
  'source-changed': `${REASON}sourceChanged`,
  limits: `${REASON}limits`,
  'image-count': `${REASON}imageCount`,
  'decode-limit': `${REASON}decodeLimit`,
  'secure-context-required': `${REASON}secureContext`,
  'codec-unavailable': `${REASON}codecFailed`,
  'worker-failed': `${REASON}codecFailed`,
  'codec-timeout': `${REASON}codecTimeout`,
  'network-idle': `${REASON}transferFailed`,
  'upload-outcome-unknown': `${REASON}transferFailed`,
  'grant-mismatch': `${REASON}grantFailed`,
  'grant-unavailable': `${REASON}grantFailed`,
  'contract-unavailable': `${REASON}contractUnavailable`,
  'state-unavailable': `${REASON}stateUnavailable`,
  'model-changed': `${REASON}modelChanged`,
  'turn-changed': `${REASON}turnChanged`,
  'invalid-text': `${REASON}invalidText`,
} as const satisfies Record<RunningImageBlockReason, string>;

/** ACP rejections of a pixel write, grouped into the same user-facing causes. */
export const REJECTION_KEY = {
  'stale-turn': 'acp.runningInput.reason.staleTurn',
  'dedup-capacity': 'acp.runningInput.reason.dedupCapacity',
  cancelled: `${REASON}cancelled`,
  'source-timeout': `${REASON}transferFailed`,
  'preflight-unavailable': `${REASON}stateUnavailable`,
  'model-unverified': `${REASON}modelUnverified`,
  'image-acquisition-busy': `${REASON}busy`,
  'image-count': `${REASON}imageCount`,
  'image-bytes': `${REASON}limits`,
  'image-dimensions': `${REASON}limits`,
  'native-line-limit': `${REASON}limits`,
  'provider-body-limit': `${REASON}limits`,
  'invalid-image-header': `${REASON}invalidImage`,
  'animated-image': `${REASON}unsupportedFormat`,
  'unsupported-image': `${REASON}unsupportedFormat`,
  'provider-context-limit': `${REASON}contextFull`,
  'grant-unavailable': `${REASON}grantFailed`,
  'invalid-grant': `${REASON}grantFailed`,
} as const satisfies Record<RunningImageRejection, string>;

/** Reasons whose message benefits from the actual numeric limits. */
const LIMIT_REASONS: ReadonlySet<RunningImageBlockReason> = new Set(['limits', 'image-count']);
export const showsLimits = (reason: RunningImageBlockReason): boolean => LIMIT_REASONS.has(reason);

export type ImageLimits = { [Key in keyof typeof RUNNING_IMAGE_LIMITS]: number };

/** The current model's remaining limits when known, otherwise the fixed Studio limits. */
export function currentLimits(state: RunningImageState | undefined): ImageLimits {
  return state?.available ? state.limits : RUNNING_IMAGE_LIMITS;
}

/** Identify one provider-window sample so a dismissal does not hide a newer one. */
export const windowSampleKey = (sample: { workerGeneration: string; requestSequence: number }): string =>
  `${sample.workerGeneration}:${sample.requestSequence}`;

/** Limits are user decisions in exact units: whole MiB values stay in MiB, others in grouped bytes. */
export function formatLimitBytes(bytes: number, language: string): string {
  return bytes % MIB === 0 ? `${formatNumber(bytes / MIB, language)} MiB` : `${formatNumber(bytes, language)} B`;
}

/** Measured sizes use the app's byte format; the exact count is available as a tooltip. */
export function formatMeasuredBytes(bytes: number, language: string): { text: string; exact: string } {
  return { text: formatByteSize(bytes, language), exact: `${formatNumber(bytes, language)} B` };
}

export function formatLimits(t: TFunction, limits: ImageLimits, language: string): string {
  return t('acp.runningInput.images.limits', {
    fileBytes: formatLimitBytes(limits.maxFileBytes, language),
    edge: formatNumber(limits.maxEdge, language),
    images: limits.maxImages,
    totalBytes: formatLimitBytes(limits.maxTotalBytes, language),
    lineBytes: formatLimitBytes(limits.maxLineBytes, language),
  });
}

export function formatDimensions(t: TFunction, size: { width?: number; height?: number }): string | undefined {
  if (!size.width || !size.height) return undefined;
  return t('acp.runningInput.images.dimensions', { width: size.width, height: size.height });
}

function formatSize(t: TFunction, size: { width?: number; height?: number; bytes: number }, language: string) {
  const bytes = formatByteSize(size.bytes, language);
  const dimensions = formatDimensions(t, size);
  return dimensions ? t('acp.runningInput.images.size', { dimensions, bytes }) : bytes;
}

/**
 * Describe what was transmitted. A downscaled image states both sizes, an
 * orientation-only normalization says so separately, and a passthrough has no label.
 */
export function describeImage(t: TFunction, image: RunningImageDetails, language: string): string {
  const from = formatSize(t, image.original, language);
  const to = formatSize(t, image.sent, language);
  if (image.downscaled) return t('acp.runningInput.images.downscaled', { from, to });
  if (image.orientationOnly) return t('acp.runningInput.images.orientation', { from, to });
  return to;
}

export function describeOriginal(
  t: TFunction,
  original: { width?: number; height?: number; bytes: number },
  language: string
): string {
  return formatSize(t, original, language);
}

const STAGE_KEY = {
  metadata: 'acp.runningInput.images.stage.reading',
  'download-response': 'acp.runningInput.images.stage.downloading',
  download: 'acp.runningInput.images.stage.downloading',
  upload: 'acp.runningInput.images.stage.uploading',
  'upload-response': 'acp.runningInput.images.stage.uploading',
  'hash-original': 'acp.runningInput.images.stage.verifying',
  'hash-output': 'acp.runningInput.images.stage.verifying',
} as const satisfies Record<ImageProgress['stage'], string>;

/** "Image 2/3 · uploading 40%". The percentage is omitted when the total is unknown. */
export function describeProgress(
  t: TFunction,
  progress: { index: number; image: ImageProgress },
  count: number,
  language: string
): string {
  const { loaded, total } = progress.image;
  const stage = t(STAGE_KEY[progress.image.stage]);
  const base = { index: progress.index + 1, total: count, stage };
  if (!total) return t('acp.runningInput.images.progress', base);
  const percent = formatNumber(Math.min(1, loaded / total), language, { style: 'percent', maximumFractionDigits: 0 });
  return t('acp.runningInput.images.progressPercent', { ...base, percent });
}
