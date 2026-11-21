import { ImagePreparationError, MAX_SOURCE_BYTES, type Dimensions, type ImageHeader } from './types';

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const IHDR = 0x49484452;
const IDAT = 0x49444154;
const IEND = 0x49454e44;
const ACTL = 0x6163544c;

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  return value;
});

function invalid(): never {
  throw new ImagePreparationError('invalid-image');
}

function pngHeader(bytes: Uint8Array, view: DataView): ImageHeader {
  if (bytes.length < 33 || view.getUint32(8) !== 13 || view.getUint32(12) !== IHDR) invalid();
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (!width || !height || Math.max(width, height) > 0x7fffffff) invalid();
  const depth = bytes[24];
  const colorType = bytes[25];
  const depths: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
  if (!depths[colorType]?.includes(depth) || bytes[26] || bytes[27] || bytes[28] > 1) invalid();
  let hasData = false;
  for (let offset = 8; offset + 12 <= bytes.length; ) {
    const length = view.getUint32(offset);
    const start = offset + 4;
    const end = offset + 8 + length;
    if (end + 4 > bytes.length) invalid();
    const type = view.getUint32(start);
    if (type === ACTL) throw new ImagePreparationError('unsupported-format');
    if (type === IHDR && offset !== 8) invalid();
    let crc = 0xffffffff;
    for (let i = start; i < end; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ bytes[i]) & 0xff];
    if (~crc >>> 0 !== view.getUint32(end)) invalid();
    if (type === IDAT && length > 0) hasData = true;
    if (type === IEND) {
      if (length !== 0 || end + 4 !== bytes.length || !hasData) invalid();
      return { mime: 'image/png', width, height, orientation: 1, highBitDepth: depth === 16 };
    }
    offset = end + 4;
  }
  return invalid();
}

function exifOrientation(bytes: Uint8Array, start: number, end: number): number | undefined {
  const tiff = new DataView(bytes.buffer, bytes.byteOffset + start + 6, end - start - 6);
  if (tiff.byteLength < 8) invalid();
  const order = tiff.getUint16(0);
  if (order !== 0x4949 && order !== 0x4d4d) invalid();
  const little = order === 0x4949;
  if (tiff.getUint16(2, little) !== 42) invalid();
  const ifd = tiff.getUint32(4, little);
  if (ifd < 8 || ifd + 2 > tiff.byteLength) invalid();
  const count = tiff.getUint16(ifd, little);
  if (ifd + 2 + 12 * count + 4 > tiff.byteLength) invalid();
  let found: number | undefined;
  for (let entry = ifd + 2; entry < ifd + 2 + 12 * count; entry += 12) {
    if (tiff.getUint16(entry, little) !== 0x112) continue;
    if (found || tiff.getUint16(entry + 2, little) !== 3 || tiff.getUint32(entry + 4, little) !== 1) invalid();
    found = tiff.getUint16(entry + 8, little);
    if (found < 1 || found > 8) invalid();
  }
  return found;
}

function jpegFrame(bytes: Uint8Array, view: DataView, start: number, end: number) {
  if (end - start < 6 || bytes[start] !== 8) invalid();
  const height = view.getUint16(start + 1);
  const width = view.getUint16(start + 3);
  const components = bytes[start + 5];
  if (!height || !width || ![1, 3].includes(components) || end - start !== 6 + 3 * components) invalid();
  const sampling = Array.from({ length: components }, (_, index) => {
    const entry = bytes[start + 7 + index * 3];
    const x = entry >> 4;
    const y = entry & 15;
    if (!x || !y || x > 4 || y > 4) invalid();
    return { x, y };
  });
  const maxX = Math.max(...sampling.map(({ x }) => x));
  const maxY = Math.max(...sampling.map(({ y }) => y));
  const blocks = sampling.reduce((sum, { x, y }) => sum + x * y, 0);
  if (blocks > 10) invalid();
  // JPEG stores whole MCU rows/columns and signed 16-bit DCT coefficients.
  const coefficientBytes = Math.ceil(width / (8 * maxX)) * Math.ceil(height / (8 * maxY)) * blocks * 128;
  return { width, height, coefficientBytes, components };
}

function jpegHeader(bytes: Uint8Array, view: DataView): ImageHeader {
  let frame: ReturnType<typeof jpegFrame> | undefined;
  let orientation: number | undefined;
  const exifSegments: ImageHeader['exifSegments'] = [];
  let progressive = false;
  let scans = 0;
  let entropy = false;
  for (let offset = 2; offset < bytes.length; ) {
    if (entropy) {
      offset = bytes.indexOf(0xff, offset);
      if (offset < 0) invalid();
    }
    const markerStart = offset;
    if (bytes[offset++] !== 0xff) invalid();
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (entropy && (marker === 0 || (marker >= 0xd0 && marker <= 0xd7))) continue;
    entropy = false;
    if (marker === 0xd9) {
      if (!frame || !scans) invalid();
      return {
        mime: 'image/jpeg',
        width: frame.width,
        height: frame.height,
        orientation: orientation ?? 1,
        exifSegments,
        jpegCoefficientBytes: progressive || scans > 1 ? frame.coefficientBytes : 0,
      };
    }
    if (marker === 0 || marker === 0xd8 || offset + 2 > bytes.length) invalid();
    const length = view.getUint16(offset);
    const end = offset + length;
    const start = offset + 2;
    if (length < 2 || end > bytes.length) invalid();
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      if (frame) invalid();
      frame = jpegFrame(bytes, view, start, end);
      progressive = marker === 0xc2;
    } else if (
      marker === 0xe1 &&
      end - start >= 6 &&
      String.fromCharCode(...bytes.subarray(start, start + 6)) === 'Exif\0\0'
    ) {
      if (exifSegments.length >= 8) invalid();
      exifSegments.push({ start: markerStart, end });
      const found = exifOrientation(bytes, start, end);
      if (found !== undefined && orientation !== undefined) invalid();
      orientation ??= found;
    } else if (marker === 0xda) {
      if (!frame || length < 6 || length !== 6 + 2 * bytes[start]) invalid();
      if (!bytes[start] || bytes[start] > frame.components) invalid();
      scans++;
      entropy = true;
      // A non-interleaved first scan also needs the coefficient buffer.
      progressive ||= bytes[start] !== frame.components;
    }
    offset = end;
  }
  return invalid();
}

/** Inspect bounded container bytes before opening a raster. */
export async function readImageHeader(blob: Blob): Promise<ImageHeader> {
  if (blob.size > MAX_SOURCE_BYTES) throw new ImagePreparationError('source-too-large');
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  if (PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)) return pngHeader(bytes, view);
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return jpegHeader(bytes, view);
  throw new ImagePreparationError('unsupported-format');
}

export function displayDimensions(header: ImageHeader): Dimensions {
  const { width, height } = header;
  return header.orientation >= 5 ? { width: height, height: width } : { width, height };
}
