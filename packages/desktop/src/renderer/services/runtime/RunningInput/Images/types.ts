export const MIB = 1024 * 1024;
export const MAX_SOURCE_BYTES = 16 * MIB;
export const MAX_RASTER_PIXELS = 16 * MIB;
export const MAX_RASTER_EDGE = 16_384;
export const MAX_PLANNED_BYTES = 160 * MIB;
export const MAX_FILE_BYTES = 3_750_000;
export const MAX_FILE_EDGE = 8_000;
export const MAX_BATCH_BYTES = 6 * MIB;
export const MAX_LINE_BYTES = 8 * MIB;
export const MAX_IMAGES = 4;
export const IMAGE_CODEC_MS = 5_000;
export const BATCH_CODEC_MS = 15_000;
export const NETWORK_IDLE_MS = 30_000;
export const RECIPE_VERSION = 1;

export type ImageMime = 'image/png' | 'image/jpeg';
export type Dimensions = { width: number; height: number };
export type ImageHeader = Dimensions & {
  mime: ImageMime;
  orientation: number;
  jpegCoefficientBytes?: number;
  jpegComponents?: number;
  highBitDepth?: boolean;
  exifSegments?: { start: number; end: number }[];
};

export type ImageFailureCode =
  | 'cancelled'
  | 'invalid-image'
  | 'unsupported-format'
  | 'unsupported-model'
  | 'source-too-large'
  | 'source-unavailable'
  | 'source-changed'
  | 'limits'
  | 'decode-limit'
  | 'secure-context-required'
  | 'codec-unavailable'
  | 'codec-timeout'
  | 'worker-failed'
  | 'network-idle'
  | 'upload-outcome-unknown'
  | 'grant-mismatch';

/** Fixed codes for the composer to localize without exposing paths or bytes. */
export class ImagePreparationError extends Error {
  constructor(readonly code: ImageFailureCode) {
    super(code);
    this.name = 'ImagePreparationError';
  }
}

export type HashProgress = {
  stage: 'hash-original' | 'hash-output';
  loaded: number;
  total: number;
};

export type ImageProgress =
  | HashProgress
  | {
      stage: 'metadata' | 'download-response' | 'download' | 'upload' | 'upload-response';
      loaded: number;
      total?: number;
    };

export type Digest = { sha256: string; elapsedMs: number; algorithm: 'web-crypto' | 'js' };
export type Preview = { blob: Blob; forSha256: string };
export type CodecResult = {
  output: Blob;
  originalDigest: Digest;
  outputDigest: Digest;
  dimensions: Dimensions;
  preview?: Preview;
  changed: boolean;
  secureContext: boolean;
  plannedBytes: number;
};

export type WorkerRequest =
  | { kind: 'inspect'; source: Blob }
  | {
      kind: 'encode';
      source: Blob;
      header: ImageHeader;
      byteLimit: number;
      edgeLimit: number;
      residentBytes: number;
      forceJs?: boolean;
      safePreview?: Preview;
    };

export type WorkerReply =
  | { kind: 'inspected'; header: ImageHeader }
  | { kind: 'encoded'; result: CodecResult }
  | { kind: 'progress'; progress: HashProgress }
  | { kind: 'error'; code: ImageFailureCode };
