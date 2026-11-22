import { hashImage } from './digest';
import { displayDimensions, readImageHeader } from './headers';
import { PNG_INFLATE_WORKSPACE_BYTES, verifyPngData } from './Png';
import {
  ImagePreparationError,
  MAX_PLANNED_BYTES,
  MAX_RASTER_EDGE,
  MAX_RASTER_PIXELS,
  MIB,
  PASSTHROUGH_PREVIEW_PIXELS,
  type CodecResult,
  type Dimensions,
  type HashProgress,
  type ImageHeader,
  type Preview,
  type WorkerRequest,
} from './types';

const INITIAL_EDGE = 2048;
const THUMBNAIL_EDGE = 256;
const JPEG_QUALITIES = [0.85, 0.75, 0.65];
const CODEC_HEADROOM_BYTES = 20 * MIB;
type EncodeRequest = Extract<WorkerRequest, { kind: 'encode' }>;
type Decoded = ImageBitmap | VideoFrame;
type JpegDecoder = {
  decode(options: { completeFramesOnly: true }): Promise<{ image: VideoFrame; complete: boolean }>;
  close(): void;
};
type DecoderConstructor = {
  new (init: {
    data: ReadableStream<Uint8Array>;
    type: 'image/jpeg';
    desiredWidth: number;
    desiredHeight: number;
  }): JpegDecoder;
  isTypeSupported(type: string): Promise<boolean>;
};

function fit({ width, height }: Dimensions, edge: number): Dimensions {
  const scale = Math.min(1, edge / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

function fullRasterAllowed({ width, height }: Dimensions): boolean {
  return Math.max(width, height) <= MAX_RASTER_EDGE && width * height <= MAX_RASTER_PIXELS;
}

function canvas2d({ width, height }: Dimensions) {
  if (typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap !== 'function') {
    throw new ImagePreparationError('codec-unavailable');
  }
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { alpha: true, colorSpace: 'srgb' });
  if (!ctx || typeof canvas.convertToBlob !== 'function') throw new ImagePreparationError('codec-unavailable');
  ctx.imageSmoothingQuality = 'high';
  return { canvas, ctx };
}

async function decodeScaledJpeg(blob: Blob, header: ImageHeader, target: Dimensions): Promise<VideoFrame> {
  const Decoder = (globalThis as typeof globalThis & { ImageDecoder?: DecoderConstructor }).ImageDecoder;
  // The requested size must reach the JPEG decoder before raster allocation. This is
  // qualified on Blink and also checked against the returned coded dimensions.
  if (
    !/\b(?:Chrome|Chromium)\/\d+/.test(navigator.userAgent) ||
    !Decoder ||
    !(await Decoder.isTypeSupported('image/jpeg'))
  ) {
    throw new ImagePreparationError('codec-unavailable');
  }
  const { width: desiredWidth, height: desiredHeight } = fit(header, Math.max(target.width, target.height));
  // libjpeg can reduce by at most 8x. Reject before decode if even that frame exceeds the plan.
  if (Math.ceil(header.width / 8) > desiredWidth || Math.ceil(header.height / 8) > desiredHeight) {
    throw new ImagePreparationError('decode-limit');
  }
  const decoder = new Decoder({ data: blob.stream(), type: 'image/jpeg', desiredWidth, desiredHeight });
  try {
    const { image, complete } = await decoder.decode({ completeFramesOnly: true });
    const { codedWidth: width, codedHeight: height } = image;
    if (
      !complete ||
      !width ||
      !height ||
      width > desiredWidth ||
      height > desiredHeight ||
      image.displayWidth !== width ||
      image.displayHeight !== height
    ) {
      image.close();
      throw new ImagePreparationError('codec-unavailable');
    }
    return image;
  } finally {
    decoder.close();
  }
}

function drawOriented(
  ctx: OffscreenCanvasRenderingContext2D,
  bitmap: Decoded,
  { width, height }: Dimensions,
  orientation: number
): void {
  // Decode the coded axes with EXIF stripped, then apply the TIFF transform once.
  const transforms: [number, number, number, number, number, number][] = [
    [1, 0, 0, 1, 0, 0],
    [-1, 0, 0, 1, width, 0],
    [-1, 0, 0, -1, width, height],
    [1, 0, 0, -1, 0, height],
    [0, 1, 1, 0, 0, 0],
    [0, 1, -1, 0, width, 0],
    [0, -1, -1, 0, width, height],
    [0, -1, 1, 0, 0, height],
  ];
  ctx.setTransform(...transforms[orientation - 1]);
  ctx.drawImage(bitmap, 0, 0, orientation >= 5 ? height : width, orientation >= 5 ? width : height);
}

function fitsFile(source: Blob, header: ImageHeader, byteLimit: number, edgeLimit: number): boolean {
  return source.size <= byteLimit && Math.max(header.width, header.height) <= edgeLimit;
}

function withoutExif(source: Blob, header: ImageHeader): Blob {
  if (!header.exifSegments?.length) return source.slice(0, source.size, header.mime);
  const parts: Blob[] = [];
  let offset = 0;
  for (const { start, end } of header.exifSegments) {
    parts.push(source.slice(offset, start));
    offset = end;
  }
  parts.push(source.slice(offset));
  return new Blob(parts, { type: header.mime });
}

async function encodeDerivative(request: EncodeRequest, display: Dimensions) {
  const { source, header, byteLimit, edgeLimit, residentBytes } = request;
  const full = fullRasterAllowed(header);
  if (!full) {
    if (header.mime !== 'image/jpeg') throw new ImagePreparationError('decode-limit');
    if (!globalThis.isSecureContext) throw new ImagePreparationError('secure-context-required');
  }

  // Budget both the four-channel decoder surface and its converted RGBA surface for CMYK/YCCK.
  const extraColorBytesPerPixel = header.jpegComponents === 4 ? 4 : 0;
  const rasterBytes = full ? header.width * header.height * (header.highBitDepth ? 8 : 4 + extraColorBytesPerPixel) : 0;
  const decoderBytes = rasterBytes + (header.jpegCoefficientBytes ?? 0);
  const baseBytes = residentBytes + CODEC_HEADROOM_BYTES + decoderBytes + (full ? 0 : source.size);
  const edge = Math.max(display.width, display.height);
  const orientationOnly = full && fitsFile(source, header, byteLimit, edgeLimit);
  const targetEdge =
    orientationOnly && baseBytes + display.width * display.height * 4 <= MAX_PLANNED_BYTES
      ? edge
      : Math.min(edgeLimit, INITIAL_EDGE, edge);
  const target = fit(display, targetEdge);
  // A scaled JPEG frame is no larger than the requested canvas on the verified path.
  const plannedBytes = Math.max(
    baseBytes + target.width * target.height * (full ? 4 : 8 + extraColorBytesPerPixel),
    header.mime === 'image/png' ? residentBytes + source.size + PNG_INFLATE_WORKSPACE_BYTES : 0
  );
  if (plannedBytes > MAX_PLANNED_BYTES) throw new ImagePreparationError('decode-limit');

  if (header.mime === 'image/png') await verifyPngData(source);
  const { canvas, ctx } = canvas2d(target);
  const decodeSource = withoutExif(source, header);
  const bitmap = full ? await createImageBitmap(decodeSource) : await decodeScaledJpeg(decodeSource, header, target);
  try {
    if (
      full &&
      (!(bitmap instanceof ImageBitmap) || bitmap.width !== header.width || bitmap.height !== header.height)
    ) {
      throw new ImagePreparationError('invalid-image');
    }
    for (let attempt = 0, currentEdge = targetEdge; attempt < 4; attempt++) {
      const dimensions = fit(display, currentEdge);
      canvas.width = dimensions.width;
      canvas.height = dimensions.height;
      ctx.imageSmoothingQuality = 'high';
      drawOriented(ctx, bitmap, dimensions, header.orientation);
      for (const quality of header.mime === 'image/jpeg' ? JPEG_QUALITIES : [undefined]) {
        // eslint-disable-next-line no-await-in-loop -- the next quality/size depends on this encoded Blob
        const output = await canvas.convertToBlob({ type: header.mime, quality });
        if (output.type !== header.mime) throw new ImagePreparationError('codec-unavailable');
        if (output.size <= byteLimit) {
          // Safari's JPEG encoder can add an EXIF block of its own. Strip all EXIF from the derivative.
          // eslint-disable-next-line no-await-in-loop -- only inspect the accepted candidate
          const sanitized = header.mime === 'image/jpeg' ? withoutExif(output, await readImageHeader(output)) : output;
          return { output: sanitized, dimensions, plannedBytes };
        }
      }
      const smaller = Math.max(1, Math.min(INITIAL_EDGE, Math.round(currentEdge * 0.75)));
      if (smaller === currentEdge) break;
      currentEdge = smaller;
    }
    throw new ImagePreparationError('limits');
  } finally {
    bitmap.close();
    canvas.width = canvas.height = 1;
  }
}

/** Draw a decoded image into a PNG no larger than THUMBNAIL_EDGE. Returns undefined on any canvas failure. */
async function thumbnailOf(bitmap: ImageBitmap, dimensions: Dimensions): Promise<Blob | undefined> {
  const thumbnailSize = fit(dimensions, THUMBNAIL_EDGE);
  try {
    const { canvas, ctx } = canvas2d(thumbnailSize);
    try {
      ctx.drawImage(bitmap, 0, 0, thumbnailSize.width, thumbnailSize.height);
      const thumbnail = await canvas.convertToBlob({ type: 'image/png' });
      return thumbnail.type === 'image/png' ? thumbnail : undefined;
    } finally {
      canvas.width = canvas.height = 1;
    }
  } catch {
    return undefined;
  }
}

/** Whether a pass-through image may spend one extra decode on its receipt thumbnail. */
export function passthroughPreviewAllowed(header: ImageHeader, residentBytes: number): boolean {
  const pixels = header.width * header.height;
  const rasterBytes = pixels * (header.highBitDepth ? 8 : 4 + (header.jpegComponents === 4 ? 4 : 0));
  const planned =
    residentBytes +
    CODEC_HEADROOM_BYTES +
    rasterBytes +
    (header.jpegCoefficientBytes ?? 0) +
    (header.mime === 'image/png' ? PNG_INFLATE_WORKSPACE_BYTES : 0);
  return (
    header.orientation === 1 &&
    pixels <= PASSTHROUGH_PREVIEW_PIXELS &&
    fullRasterAllowed(header) &&
    planned <= MAX_PLANNED_BYTES
  );
}

/**
 * Thumbnail for a pass-through image. The caller passes the transmitted Blob and the
 * SHA-256 the encode step computed for it; Blobs are immutable, so the preview shows those
 * exact bytes. Never throws: a missing thumbnail falls back to icon + W×H.
 */
export async function previewPassthrough(
  source: Blob,
  header: ImageHeader,
  sha256: string,
  residentBytes: number
): Promise<Preview | undefined> {
  if (!passthroughPreviewAllowed(header, residentBytes)) return undefined;
  let bitmap: ImageBitmap | undefined;
  try {
    bitmap = await createImageBitmap(source);
    if (bitmap.width !== header.width || bitmap.height !== header.height) return undefined;
    const thumbnail = await thumbnailOf(bitmap, header);
    return thumbnail && thumbnail.size <= 512 * 1024 ? { blob: thumbnail, forSha256: sha256 } : undefined;
  } catch {
    return undefined;
  } finally {
    bitmap?.close();
  }
}

async function verifyOutput(output: Blob, dimensions: Dimensions): Promise<Blob | undefined> {
  const header = await readImageHeader(output);
  if (
    header.mime !== output.type ||
    header.orientation !== 1 ||
    header.exifSegments?.length ||
    header.width !== dimensions.width ||
    header.height !== dimensions.height
  ) {
    throw new ImagePreparationError('invalid-image');
  }
  const bitmap = await createImageBitmap(output);
  try {
    if (bitmap.width !== dimensions.width || bitmap.height !== dimensions.height) {
      throw new ImagePreparationError('invalid-image');
    }
    return await thumbnailOf(bitmap, dimensions);
  } finally {
    bitmap.close();
  }
}

async function boundPreview(preview: Preview | undefined, sha256: string): Promise<Preview | undefined> {
  if (!preview || preview.forSha256 !== sha256 || preview.blob.type !== 'image/png' || preview.blob.size > 512 * 1024) {
    return undefined;
  }
  try {
    const header = await readImageHeader(preview.blob);
    if (header.mime === 'image/png' && Math.max(header.width, header.height) <= THUMBNAIL_EDGE) {
      await verifyPngData(preview.blob);
      return preview;
    }
  } catch {
    // A missing or invalid thumbnail does not prevent a safe image from being sent.
  }
  return undefined;
}

/** Encode and hash one image inside a dedicated worker. Pass-through never opens a raster. */
export async function encodeImage(
  request: EncodeRequest,
  report: (progress: HashProgress) => void
): Promise<CodecResult> {
  const { source, header, byteLimit, edgeLimit, residentBytes, forceJs } = request;
  const display = displayDimensions(header);
  const changed = header.orientation !== 1 || !fitsFile(source, header, byteLimit, edgeLimit);
  const pngPassThrough = !changed && header.mime === 'image/png';
  if (pngPassThrough) await verifyPngData(source);
  const { output, dimensions, plannedBytes } = changed
    ? await encodeDerivative(request, display)
    : {
        output: source.slice(0, source.size, header.mime),
        dimensions: display,
        plannedBytes: residentBytes + source.size + (pngPassThrough ? PNG_INFLATE_WORKSPACE_BYTES : 0),
      };
  const thumbnail = changed ? await verifyOutput(output, dimensions) : undefined;
  const originalDigest = await hashImage(source, 'hash-original', report, forceJs);
  const outputDigest = changed ? await hashImage(output, 'hash-output', report, forceJs) : originalDigest;
  return {
    output,
    originalDigest,
    outputDigest,
    dimensions,
    changed,
    secureContext: globalThis.isSecureContext,
    plannedBytes,
    preview: thumbnail
      ? { blob: thumbnail, forSha256: outputDigest.sha256 }
      : await boundPreview(request.safePreview, outputDigest.sha256),
  };
}
