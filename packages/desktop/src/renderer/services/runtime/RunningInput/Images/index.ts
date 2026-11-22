import type { ChatFileRef } from '@/common/types/chatFile';
import { createRequestId } from '../transport';
import { base64Bytes, nativeLineBytes, nextImageByteLimit } from './budget';
import { displayDimensions } from './headers';
import { readReferencedImage, uploadPreparedImage } from './transfer';
import {
  BATCH_CODEC_MS,
  IMAGE_CODEC_MS,
  ImagePreparationError,
  MAX_BATCH_BYTES,
  MAX_FILE_BYTES,
  MAX_FILE_EDGE,
  MAX_IMAGES,
  MAX_LINE_BYTES,
  MAX_SOURCE_BYTES,
  PASSTHROUGH_PREVIEW_MS,
  PASSTHROUGH_PREVIEW_PIXELS,
  RECIPE_VERSION,
  type CodecResult,
  type Dimensions,
  type ImageHeader,
  type ImageMime,
  type ImageProgress,
  type Preview,
  type WorkerRequest,
} from './types';
import { runImageWorker } from './workerClient';

export { nativeLineBytes, nativeLineFits } from './budget';
export { ImagePreparationError } from './types';
export type { ImageFailureCode, ImageMime, Preview } from './types';

type ImageSource = ({ ref: ChatFileRef; blob?: Blob } | { blob: Blob; ref?: undefined }) & { preview?: Preview };

type ImageModelLimits = {
  supported: boolean;
  maxImages?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
  maxEdge?: number;
  maxLineBytes?: number;
};

/** Bounded measurements are available progressively, including on pre-dispatch failure. */
export type ImagePreparationMeasurements = Readonly<{
  originals: readonly (Readonly<Partial<Dimensions> & { bytes: number }> | undefined)[];
  originalLineBytes?: number;
}>;

export type ImagePreparationOptions = {
  /** Must describe the current turn and model. Abort on Stop, draft/model or turn replacement. */
  signal: AbortSignal;
  conversationId: string;
  /** The composer allocates this at click time and uses it for both H-1 and A-1. */
  requestId?: string;
  sources: readonly ImageSource[];
  model: ImageModelLimits;
  /** UTF-8 JSONL template with IDs, text/caption, identified MIME types, empty base64 slots and final newline. */
  emptyNativeLine: (requestId: string, mimeTypes: readonly ImageMime[]) => string;
  onProgress?: (index: number, progress: ImageProgress) => void;
  onMeasurements?: (measurements: ImagePreparationMeasurements) => void;
  /** Acceptance can exercise the HTTP implementation on a secure origin as well. */
  forceJsHash?: boolean;
};

export type PreparedImage = {
  originalRef?: ChatFileRef;
  ref: ChatFileRef;
  original: Dimensions & { bytes: number; digest: CodecResult['originalDigest'] };
  sent: Dimensions & { bytes: number; digest: CodecResult['outputDigest']; mime: ImageMime };
  preview: { kind: 'icon'; dimensions: Dimensions } | { kind: 'thumbnail'; value: Preview };
  changed: boolean;
  orientationOnly: boolean;
  secureContext: boolean;
  plannedBytes: number;
  codecMs: number;
};

export type PreparedImages = {
  prepareId: string;
  requestId: string;
  recipeVersion: typeof RECIPE_VERSION;
  images: readonly PreparedImage[];
  estimatedLineBytes: number;
  codecMs: number;
};

type Grant = { byteLength: number; sha256: string };

/** Confirm ordered grant identity before allowing the caller to issue an image write. */
export function verifyImageGrants<T extends Grant>(prepared: PreparedImages, grants: readonly T[]): readonly T[] {
  if (
    grants.length !== prepared.images.length ||
    prepared.images.some(({ sent }, index) => {
      const grant = grants[index];
      return grant?.byteLength !== sent.bytes || grant.sha256 !== sent.digest.sha256;
    })
  ) {
    throw new ImagePreparationError('grant-mismatch');
  }
  return grants;
}

function bounded(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) throw new ImagePreparationError('limits');
  return Math.min(value, fallback);
}

type InspectedSource = { index: number; blob: Blob; header: ImageHeader };

async function prepareImages(
  options: ImagePreparationOptions,
  signal: AbortSignal,
  ids: Pick<PreparedImages, 'prepareId' | 'requestId'>
): Promise<PreparedImages> {
  signal.throwIfAborted();
  const { conversationId, model, sources, onProgress, onMeasurements, forceJsHash } = options;
  if (!model.supported) throw new ImagePreparationError('unsupported-model');
  if (!conversationId || sources.length === 0 || sources.length > bounded(model.maxImages, MAX_IMAGES)) {
    throw new ImagePreparationError('limits');
  }

  const lineLimit = bounded(model.maxLineBytes, MAX_LINE_BYTES);
  const fileLimit = bounded(model.maxFileBytes, MAX_FILE_BYTES);
  const edgeLimit = bounded(model.maxEdge, MAX_FILE_EDGE);
  let raw = bounded(model.maxTotalBytes, MAX_BATCH_BYTES);
  const perImage = sources.map(() => 0);
  let codecMs = 0;
  const report = (index: number) => (progress: ImageProgress) => onProgress?.(index, progress);

  async function work(index: number, request: WorkerRequest) {
    const remaining = Math.min(IMAGE_CODEC_MS - perImage[index], BATCH_CODEC_MS - codecMs);
    const { result, elapsedMs } = await runImageWorker(request, signal, remaining, report(index));
    perImage[index] += elapsedMs;
    codecMs += elapsedMs;
    return result;
  }

  if (raw < sources.length || lineLimit < 4 * sources.length) throw new ImagePreparationError('limits');
  const inputs: InspectedSource[] = [];
  const originals: (Partial<Dimensions> & { bytes: number })[] = [];
  for (const [index, source] of sources.entries()) {
    if (!source.blob && !source.ref) throw new ImagePreparationError('source-unavailable');
    // eslint-disable-next-line no-await-in-loop -- download and inspect one bounded original at a time
    const blob = source.blob ?? (await readReferencedImage(source.ref, signal, report(index)));
    originals[index] = { bytes: blob.size };
    onMeasurements?.({ originals: [...originals] });
    if (blob.size > MAX_SOURCE_BYTES) throw new ImagePreparationError('source-too-large');
    // eslint-disable-next-line no-await-in-loop -- accumulate the shared codec budget serially
    const result = await work(index, { kind: 'inspect', source: blob });
    if (result.kind !== 'inspected') throw new ImagePreparationError('worker-failed');
    inputs.push({ index, blob, header: result.header });
    originals[index] = { bytes: blob.size, ...displayDimensions(result.header) };
    onMeasurements?.({ originals: [...originals] });
  }

  const emptyNativeLine = options.emptyNativeLine(
    ids.requestId,
    inputs.map(({ header }) => header.mime)
  );
  onMeasurements?.({
    originals,
    originalLineBytes: nativeLineBytes(
      emptyNativeLine,
      originals.map(({ bytes }) => bytes)
    ),
  });
  let encoded = lineLimit - nativeLineBytes(emptyNativeLine, []);
  if (encoded < 4 * sources.length) throw new ImagePreparationError('limits');

  const passthroughSize = ({ blob, header }: InspectedSource) =>
    header.orientation === 1 && Math.max(header.width, header.height) <= edgeLimit && blob.size <= fileLimit
      ? blob.size
      : Infinity;
  inputs.sort((a, b) => passthroughSize(a) - passthroughSize(b) || a.index - b.index);

  const images: Omit<PreparedImage, 'ref'>[] = [];
  const outputs: Blob[] = [];
  let residentBytes = inputs.reduce((sum, { blob }) => sum + blob.size, 0);
  let previewBudget = PASSTHROUGH_PREVIEW_MS;

  /** Best-effort receipt thumbnail for unchanged bytes. Outside the codec budgets; never fails the send. */
  async function passthroughPreview(output: Blob, header: ImageHeader, sha256: string): Promise<Preview | undefined> {
    if (header.orientation !== 1 || header.width * header.height > PASSTHROUGH_PREVIEW_PIXELS || previewBudget <= 0) {
      return undefined;
    }
    const started = performance.now();
    try {
      const { result } = await runImageWorker(
        { kind: 'preview', source: output, header, sha256, residentBytes },
        signal,
        previewBudget,
        () => {}
      );
      return result.kind === 'previewed' && result.preview?.forSha256 === sha256 ? result.preview : undefined;
    } catch {
      signal.throwIfAborted();
      return undefined;
    } finally {
      previewBudget -= performance.now() - started;
    }
  }

  for (const [position, { index, blob, header }] of inputs.entries()) {
    const byteLimit = nextImageByteLimit(raw, encoded, inputs.length - position, fileLimit);
    // eslint-disable-next-line no-await-in-loop -- each output consumes the remaining shared raw/base64 budget
    const response = await work(index, {
      kind: 'encode',
      source: blob,
      header,
      byteLimit,
      edgeLimit,
      residentBytes,
      forceJs: forceJsHash,
      safePreview: sources[index].preview,
    });
    if (response.kind !== 'encoded') throw new ImagePreparationError('worker-failed');
    const { output, originalDigest, outputDigest, dimensions, changed, secureContext, plannedBytes } = response.result;
    const source = sources[index];
    const preview =
      response.result.preview ??
      (changed
        ? undefined
        : // eslint-disable-next-line no-await-in-loop -- bounded by the shared preview budget
          await passthroughPreview(output, header, outputDigest.sha256));
    raw -= output.size;
    encoded -= base64Bytes(output.size);
    residentBytes += (changed ? output.size : 0) + (preview?.blob.size ?? 0);
    outputs[index] = output;
    const originalDimensions = displayDimensions(header);
    images[index] = {
      originalRef: source.ref,
      original: { ...originalDimensions, bytes: blob.size, digest: originalDigest },
      sent: { ...dimensions, bytes: output.size, digest: outputDigest, mime: header.mime },
      preview: preview ? { kind: 'thumbnail', value: preview } : { kind: 'icon', dimensions },
      changed,
      orientationOnly:
        header.orientation !== 1 &&
        dimensions.width === originalDimensions.width &&
        dimensions.height === originalDimensions.height,
      secureContext,
      plannedBytes,
      codecMs: perImage[index],
    };
  }

  const estimatedLineBytes = nativeLineBytes(
    emptyNativeLine,
    images.map(({ sent }) => sent.bytes)
  );
  if (raw < 0 || encoded < 0 || estimatedLineBytes > lineLimit) throw new ImagePreparationError('limits');
  const prepared: PreparedImage[] = [];
  for (const [index, image] of images.entries()) {
    let ref = image.originalRef;
    if (image.changed || !ref) {
      // eslint-disable-next-line no-await-in-loop -- stop at the first ambiguous upload response
      ref = await uploadPreparedImage(outputs[index], conversationId, signal, report(index));
    }
    signal.throwIfAborted();
    prepared.push({ ...image, ref });
  }
  return { ...ids, recipeVersion: RECIPE_VERSION, images: prepared, estimatedLineBytes, codecMs };
}

let preparationQueue = Promise.resolve();

function enqueuePreparation(signal: AbortSignal, prepare: () => Promise<PreparedImages>): Promise<PreparedImages> {
  const job = preparationQueue.then(prepare);
  preparationQueue = job.then(
    () => {},
    () => {}
  );
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    void job.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** Own one click's immutable request and preparation IDs. Repeated reads reuse its result, including failures. */
export function createImagePreparation(options: ImagePreparationOptions) {
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, options.signal]);
  let snapshot: ImagePreparationOptions | undefined = signal.aborted
    ? undefined
    : {
        ...options,
        model: { ...options.model },
        sources: options.sources.map((source) => ({ ...source, ref: source.ref && { ...source.ref } })),
      };
  const requestId = options.requestId ?? createRequestId();
  let pending: Promise<PreparedImages> | undefined;
  const cancelled = new ImagePreparationError('cancelled');
  signal.addEventListener(
    'abort',
    () => {
      snapshot = undefined;
      pending = undefined;
    },
    { once: true }
  );

  return {
    /** The same preparation never uploads twice, including after an unknown response. */
    prepare(): Promise<PreparedImages> {
      if (signal.aborted) return Promise.reject(cancelled);
      if (!pending && snapshot) {
        pending = enqueuePreparation(signal, () => {
          // Take ownership only when the job starts. Abort can clear all queued Blob references.
          const active = snapshot;
          snapshot = undefined;
          if (!active) throw cancelled;
          return prepareImages(active, signal, {
            prepareId: requestId,
            requestId,
          });
        }).catch((error: unknown) => {
          if (signal.aborted) throw cancelled;
          if (error instanceof ImagePreparationError) throw error;
          throw new ImagePreparationError('source-unavailable');
        });
      }
      return pending ?? Promise.reject(cancelled);
    },
    /** Releases renderer-owned preparation state and aborts any worker/fetch/XHR. */
    dispose(): void {
      controller.abort(cancelled);
    },
  };
}
