import { ImagePreparationError, MIB, type ImageHeader } from './types';

export const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const IHDR = 0x49484452;
const PLTE = 0x504c5445;
const IDAT = 0x49444154;
const IEND = 0x49454e44;
const ACTL = 0x6163544c;
const ANCILLARY_CHUNK_BIT = 0x20000000;
const COLOR_TYPES = {
  0: { samples: 1, depths: [1, 2, 4, 8, 16] },
  2: { samples: 3, depths: [8, 16] },
  3: { samples: 1, depths: [1, 2, 4, 8] },
  4: { samples: 2, depths: [8, 16] },
  6: { samples: 4, depths: [8, 16] },
};
const ADAM7 = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
];

// Bound a single inflater write to about 4 MiB even at DEFLATE's maximum expansion.
const INFLATE_INPUT_BYTES = 4 * 1024;
export const PNG_INFLATE_WORKSPACE_BYTES = 12 * MIB;
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  return value;
});

function invalid(): never {
  throw new ImagePreparationError('invalid-image');
}

/** Validate the chunk envelope and locate the consecutive IDAT run without retaining per-chunk state. */
export function readPng(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 33 || view.getUint32(8) !== 13 || view.getUint32(12) !== IHDR) invalid();
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (!width || !height || Math.max(width, height) > 0x7fffffff) invalid();
  const depth = bytes[24];
  const colorType = bytes[25];
  const color = COLOR_TYPES[colorType as keyof typeof COLOR_TYPES];
  const interlaced = bytes[28] === 1;
  if (!color?.depths.includes(depth) || bytes[26] || bytes[27] || bytes[28] > 1) invalid();

  let dataStart = 0;
  let dataEnd = 0;
  let compressedSize = 0;
  let hasPalette = false;
  for (let offset = 8; offset + 12 <= bytes.length; ) {
    const length = view.getUint32(offset);
    const start = offset + 4;
    const end = offset + 8 + length;
    const next = end + 4;
    if (next > bytes.length) invalid();
    const type = view.getUint32(start);
    if (type === ACTL) throw new ImagePreparationError('unsupported-format');
    let crc = 0xffffffff;
    for (let i = start; i < end; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ bytes[i]) & 0xff];
    if (~crc >>> 0 !== view.getUint32(end)) invalid();
    if (type === IDAT) {
      if (dataEnd && dataEnd !== offset) invalid();
      dataStart ||= offset;
      dataEnd = next;
      compressedSize += length;
    } else if (type === PLTE) {
      const maxEntries = colorType === 3 ? 2 ** depth : 256;
      if (
        dataStart ||
        hasPalette ||
        colorType === 0 ||
        colorType === 4 ||
        !length ||
        length % 3 ||
        length > 3 * maxEntries
      )
        invalid();
      hasPalette = true;
    } else if (type === IEND) {
      if (length || next !== bytes.length || !compressedSize || (colorType === 3 && !hasPalette)) invalid();
      const header: ImageHeader = { mime: 'image/png', width, height, orientation: 1, highBitDepth: depth === 16 };
      return { header, dataStart, dataEnd, interlaced, bitsPerPixel: color.samples * depth };
    } else if ((type & ANCILLARY_CHUNK_BIT) === 0 && offset !== 8) {
      invalid();
    }
    offset = next;
  }
  return invalid();
}

function* idatSlices(bytes: Uint8Array<ArrayBuffer>, start: number, end: number) {
  const view = new DataView(bytes.buffer);
  for (let offset = start; offset < end; ) {
    const length = view.getUint32(offset);
    const payloadEnd = offset + 8 + length;
    for (let cursor = offset + 8; cursor < payloadEnd; cursor += INFLATE_INPUT_BYTES) {
      yield bytes.subarray(cursor, Math.min(cursor + INFLATE_INPUT_BYTES, payloadEnd));
    }
    offset = payloadEnd + 4;
  }
}

/** Check zlib integrity, scanline lengths and filter bytes, without reconstructing pixels. */
export async function verifyPngData(blob: Blob): Promise<void> {
  if (typeof DecompressionStream !== 'function') throw new ImagePreparationError('codec-unavailable');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const { header, dataStart, dataEnd, interlaced, bitsPerPixel } = readPng(bytes);
  const passes = (interlaced ? ADAM7 : [[0, 0, 1, 1]])
    .map(([x, y, stepX, stepY]) => {
      const columns = Math.ceil((header.width - x) / stepX);
      const rows = Math.ceil((header.height - y) / stepY);
      return { rowBytes: 1 + Math.ceil((columns * bitsPerPixel) / 8), rows, columns };
    })
    .filter(({ rows, columns }) => rows > 0 && columns > 0);
  const slices = idatSlices(bytes, dataStart, dataEnd);
  const compressed = new ReadableStream<Uint8Array<ArrayBuffer>>({
    pull(controller) {
      const item = slices.next();
      if (item.done === true) controller.close();
      else controller.enqueue(item.value);
    },
  });
  const reader = compressed.pipeThrough(new DecompressionStream('deflate')).getReader();
  let pass = 0;
  let row = 0;
  let rowOffset = 0;
  try {
    for (;;) {
      // eslint-disable-next-line no-await-in-loop -- consume the ordered stream with backpressure
      const { done, value } = await reader.read();
      if (done) break;
      for (let offset = 0; offset < value.length; ) {
        const layout = passes[pass];
        if (!layout || (rowOffset === 0 && value[offset] > 4)) invalid();
        const length = Math.min(layout.rowBytes - rowOffset, value.length - offset);
        offset += length;
        rowOffset += length;
        if (rowOffset === layout.rowBytes) {
          rowOffset = 0;
          if (++row === layout.rows) {
            row = 0;
            pass++;
          }
        }
      }
    }
    if (pass !== passes.length) invalid();
  } catch {
    await reader.cancel().catch(() => {});
    invalid();
  } finally {
    reader.releaseLock();
  }
}
