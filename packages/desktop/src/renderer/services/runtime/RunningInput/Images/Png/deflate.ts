import { ImagePreparationError } from '../types';

const END_OF_BLOCK = 256;
const MAX_CODE_BITS = 15;
const CODE_LENGTH_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

function invalid(): never {
  throw new ImagePreparationError('invalid-image');
}

/** Read little-endian fields across IDAT chunks and track the logical zlib byte offset. */
class DeflateBits {
  private chunk = new Uint8Array(0);
  private offset = 0;
  private buffer = 0;
  private available = 0;
  position = 0;

  constructor(private readonly chunks: Iterator<Uint8Array<ArrayBuffer>, void>) {}

  private ensureChunk(): void {
    if (this.offset < this.chunk.length) return;
    const next = this.chunks.next();
    if (next.done === true) invalid();
    this.chunk = next.value;
    this.offset = 0;
  }

  read(width: number): number {
    while (this.available < width) {
      this.ensureChunk();
      this.buffer |= this.chunk[this.offset++] << this.available;
      this.available += 8;
      this.position++;
    }
    const value = this.buffer & ((1 << width) - 1);
    this.buffer >>>= width;
    this.available -= width;
    return value;
  }

  align(): void {
    this.buffer = this.available = 0;
  }

  skipBytes(count: number): void {
    while (count > 0) {
      this.ensureChunk();
      const length = Math.min(count, this.chunk.length - this.offset);
      this.offset += length;
      this.position += length;
      count -= length;
    }
  }
}

type Huffman = { counts: Uint16Array; symbols: Uint16Array; maxWidth: number };

function huffman(lengths: Uint8Array): Huffman {
  const counts = new Uint16Array(MAX_CODE_BITS + 1);
  let maxWidth = 0;
  for (const width of lengths) {
    if (!width) continue;
    counts[width]++;
    maxWidth = Math.max(maxWidth, width);
  }
  const offsets = new Uint16Array(counts.length);
  let available = 1;
  for (let width = 1; width <= maxWidth; width++) {
    available = 2 * available - counts[width];
    if (available < 0) invalid();
    offsets[width] = offsets[width - 1] + counts[width - 1];
  }
  const symbols = new Uint16Array(lengths.length);
  lengths.forEach((width, symbol) => {
    if (width) symbols[offsets[width]++] = symbol;
  });
  return { counts, symbols, maxWidth };
}

function readSymbol(bits: DeflateBits, tree: Huffman): number {
  // Canonical Huffman codes are sent most-significant bit first (RFC 1951 §3.2.2).
  let code = 0;
  let first = 0;
  let offset = 0;
  for (let width = 1; width <= tree.maxWidth; width++) {
    code = (code << 1) | bits.read(1);
    const count = tree.counts[width];
    if (code >= first && code < first + count) return tree.symbols[offset + code - first];
    offset += count;
    first = (first + count) << 1;
  }
  return invalid();
}

type BlockTrees = { literal: Huffman; distance: Huffman };
let fixedTrees: BlockTrees | undefined;

function fixedBlock(): BlockTrees {
  return (fixedTrees ??= {
    literal: huffman(new Uint8Array(288).fill(8, 0, 144).fill(9, 144, 256).fill(7, 256, 280).fill(8, 280)),
    distance: huffman(new Uint8Array(32).fill(5)),
  });
}

function dynamicBlock(bits: DeflateBits): BlockTrees {
  const literalCount = bits.read(5) + 257;
  const distanceCount = bits.read(5) + 1;
  const codeCount = bits.read(4) + 4;
  if (literalCount > 286) invalid();
  const codes = new Uint8Array(19);
  for (const symbol of CODE_LENGTH_ORDER.slice(0, codeCount)) codes[symbol] = bits.read(3);
  const codeTree = huffman(codes);
  const lengths = new Uint8Array(literalCount + distanceCount);
  for (let offset = 0; offset < lengths.length; ) {
    const value = readSymbol(bits, codeTree);
    if (value <= 15) {
      lengths[offset++] = value;
      continue;
    }
    if (value === 16 && offset === 0) invalid();
    const repeatWidths = [2, 3, 7];
    const minimum = value === 18 ? 11 : 3;
    const count = minimum + bits.read(repeatWidths[value - 16]);
    if (offset + count > lengths.length) invalid();
    if (value === 16) lengths.fill(lengths[offset - 1], offset, offset + count);
    offset += count;
  }
  if (!lengths[END_OF_BLOCK]) invalid();
  return { literal: huffman(lengths.subarray(0, literalCount)), distance: huffman(lengths.subarray(literalCount)) };
}

function backReferenceLength(bits: DeflateBits, symbol: number): number {
  if (symbol < 265) return symbol - 254;
  if (symbol === 285) return 258;
  if (symbol > 285) return invalid();
  const extraBits = ((symbol - 257) >>> 2) - 1;
  return ((4 + ((symbol - 257) & 3)) << extraBits) + 3 + bits.read(extraBits);
}

function compressedBlock(bits: DeflateBits, trees: BlockTrees, size: number, limit: number): number {
  for (;;) {
    const symbol = readSymbol(bits, trees.literal);
    if (symbol === END_OF_BLOCK) return size;
    if (symbol < END_OF_BLOCK) {
      size++;
    } else {
      const length = backReferenceLength(bits, symbol);
      const distance = readSymbol(bits, trees.distance);
      if (distance > 29) invalid();
      if (distance >= 4) bits.read((distance >>> 1) - 1);
      size += length;
    }
    if (size > limit) invalid();
  }
}

/** Locate BFINAL and its zlib trailer. The browser inflater still checks history, checksum and output bytes. */
export function findZlibEnd(chunks: Iterator<Uint8Array<ArrayBuffer>, void>, expectedBytes: number): number {
  const bits = new DeflateBits(chunks);
  const cmf = bits.read(8);
  const flg = bits.read(8);
  if ((cmf & 15) !== 8 || cmf >>> 4 > 7 || flg & 32 || ((cmf << 8) + flg) % 31) invalid();

  let size = 0;
  let final: number;
  do {
    final = bits.read(1);
    const kind = bits.read(2);
    switch (kind) {
      case 0: {
        bits.align();
        const length = bits.read(16);
        if ((length ^ bits.read(16)) !== 0xffff) invalid();
        bits.skipBytes(length);
        size += length;
        if (size > expectedBytes) invalid();
        break;
      }
      case 1:
      case 2:
        size = compressedBlock(bits, kind === 1 ? fixedBlock() : dynamicBlock(bits), size, expectedBytes);
        break;
      default:
        invalid();
    }
  } while (!final);

  if (size !== expectedBytes) invalid();
  bits.align();
  bits.skipBytes(4); // Adler-32, which DecompressionStream verifies on the trimmed stream.
  return bits.position;
}
