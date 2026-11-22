import type { ImageMime } from './Images';
import { MAX_BATCH_BYTES, MAX_FILE_BYTES, MAX_FILE_EDGE, MAX_IMAGES, MAX_LINE_BYTES } from './Images/types';
import { isRecord } from './transport';
import type { RunningInputMode } from './types';

// This is ACP A-1 wire text. The renderer sends the original text and displays this only upon captionAdded.
export const IMAGE_ONLY_CAPTION = 'The user attached one or more images.';

export const RUNNING_IMAGE_LIMITS = {
  maxImages: MAX_IMAGES,
  maxFileBytes: MAX_FILE_BYTES,
  maxTotalBytes: MAX_BATCH_BYTES,
  maxEdge: MAX_FILE_EDGE,
  maxLineBytes: MAX_LINE_BYTES,
} as const;

export const IMAGE_REJECTIONS = [
  'stale-turn',
  'dedup-capacity',
  'cancelled',
  'source-timeout',
  'preflight-unavailable',
  'model-unverified',
  'image-acquisition-busy',
  'image-count',
  'image-bytes',
  'image-dimensions',
  'invalid-image-header',
  'animated-image',
  'unsupported-image',
  'provider-body-limit',
  'provider-context-limit',
  'native-line-limit',
  'grant-unavailable',
  'invalid-grant',
] as const;

export type RunningImageRejection = (typeof IMAGE_REJECTIONS)[number];

const WINDOW_REASONS = [
  'image_count',
  'raw_bytes',
  'model-unverified',
  'image-bytes',
  'image-dimensions',
  'image-mime',
  'invalid-image-header',
  'animated-image',
  'unsupported-image',
] as const;

export type RunningImageWindow = Readonly<{
  requestTurnId: string;
  workerGeneration: string;
  requestSequence: number;
  keptCount: number;
  keptRawBytes: number;
  omittedCount: number;
  reasons: Readonly<Partial<Record<(typeof WINDOW_REASONS)[number], number>>>;
}>;

type ImageLimits = { [Key in keyof typeof RUNNING_IMAGE_LIMITS]: number };

export type RunningImageState = Readonly<
  { turnId: string | null; window?: RunningImageWindow } & (
    | { available: true; model: string; limits: Readonly<ImageLimits> }
    | { available: false; reason: 'model-text-only' | 'model-unverified' | 'no-active-turn' | 'state-unavailable' }
  )
>;

function uint(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function positive(value: unknown): value is number {
  return uint(value) && value > 0;
}

function parseWindow(value: Record<string, unknown>): RunningImageWindow | undefined {
  const { status, requestTurnId, workerGeneration, requestSequence, omittedCount, keptCount, keptRawBytes, reasons } =
    value;
  if (
    status !== 'available' ||
    typeof requestTurnId !== 'string' ||
    typeof workerGeneration !== 'string' ||
    !positive(requestSequence) ||
    !uint(omittedCount) ||
    !uint(keptCount) ||
    !uint(keptRawBytes) ||
    !isRecord(reasons)
  )
    return undefined;
  const counts: RunningImageWindow['reasons'] = Object.fromEntries(
    WINDOW_REASONS.flatMap((key) => (positive(reasons[key]) ? [[key, reasons[key]]] : []))
  );
  return { requestTurnId, workerGeneration, requestSequence, keptCount, keptRawBytes, omittedCount, reasons: counts };
}

/** Read current eligibility and the latest validated provider window as independent facts. */
export function parseImageState(value: unknown, turnId: string | null): RunningImageState {
  const unavailable = { available: false, turnId, reason: 'state-unavailable' } as const;
  if (!isRecord(value)) return unavailable;
  if (value.turnId !== turnId) {
    return value.turnId === null || typeof value.turnId === 'string'
      ? { ...unavailable, reason: 'no-active-turn' }
      : unavailable;
  }
  const { available, reason, model, remaining } = value;
  const window = parseWindow(value);
  if (
    available === false &&
    (reason === 'model-text-only' || reason === 'model-unverified' || reason === 'no-active-turn')
  ) {
    return { available: false, reason, turnId, window };
  }
  if (available !== true || typeof model !== 'string' || !model || !isRecord(remaining)) return unavailable;
  const { count, imageBytes, rawBytes, sidePixels, nativeLineBytes } = remaining;
  if (!uint(count) || !uint(imageBytes) || !uint(rawBytes) || !positive(sidePixels) || !positive(nativeLineBytes)) {
    return unavailable;
  }
  return {
    available: true,
    model,
    turnId,
    window,
    limits: {
      maxImages: Math.min(count, MAX_IMAGES),
      maxFileBytes: Math.min(imageBytes, MAX_FILE_BYTES),
      maxTotalBytes: Math.min(rawBytes, MAX_BATCH_BYTES),
      maxEdge: Math.min(sidePixels, MAX_FILE_EDGE),
      maxLineBytes: Math.min(nativeLineBytes, MAX_LINE_BYTES),
    },
  };
}

export type ImageGrant = { id: string; byteLength: number; sha256: string };

/** Parse only the fixed grant descriptors. An invalid or expired batch can never authorize a write. */
export function parseImageGrants(value: unknown): ImageGrant[] | undefined {
  if (!isRecord(value) || !positive(value.expiresInMs) || !Array.isArray(value.grants)) return undefined;
  const grants: ImageGrant[] = [];
  for (const grant of value.grants as unknown[]) {
    if (
      !isRecord(grant) ||
      typeof grant.id !== 'string' ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(grant.id) ||
      !positive(grant.byteLength) ||
      typeof grant.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(grant.sha256) ||
      grants.some(({ id }) => id === grant.id)
    )
      return undefined;
    grants.push({ id: grant.id, byteLength: grant.byteLength, sha256: grant.sha256 });
  }
  return grants;
}

/** ACP calls Python str.strip() to decide whether to supply its wire caption. */
export function hasImageCaption(message: string): boolean {
  // eslint-disable-next-line no-control-regex -- Python also strips ASCII file/group/record/unit separators.
  return /^[\p{White_Space}\u001c-\u001f]*$/u.test(message);
}

/** Mirror A-1's UTF-8 json.dumps with default separators, 32 hex ID characters, and the final newline. */
export function emptyNativeImageLine(mode: RunningInputMode, message: string, mimes: readonly ImageMime[]): string {
  const id = '0'.repeat(32);
  const type = mode === 'steer' ? 'steer' : 'follow_up';
  const text = JSON.stringify(hasImageCaption(message) ? IMAGE_ONLY_CAPTION : message);
  const images = mimes.map((mime) => `{"type": "image", "mimeType": "${mime}", "data": ""}`);
  return `{"id": "${id}", "type": "${type}", "message": ${text}, "images": [${images.join(', ')}]}\n`;
}
