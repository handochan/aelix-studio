import { MAX_LINE_BYTES } from './types';

/** Byte length of JSONL with base64 contents omitted from their JSON string slots. */
export function nativeLineBytes(emptyNativeLine: string, imageSizes: readonly number[]): number {
  return (
    new TextEncoder().encode(emptyNativeLine).length + imageSizes.reduce((sum, bytes) => sum + base64Bytes(bytes), 0)
  );
}

export function base64Bytes(bytes: number): number {
  return 4 * Math.ceil(bytes / 3);
}

/** Allocate both raw and base64 budgets, accounting for each file's padding independently. */
export function nextImageByteLimit(raw: number, encoded: number, remaining: number, fileLimit: number): number {
  return Math.min(fileLimit, Math.floor(raw / remaining), 3 * Math.floor(encoded / (4 * remaining)));
}

/** Final size guard for a serialized line with all fields, padding and newline present. */
export function nativeLineFits(line: string): boolean {
  return new TextEncoder().encode(line).length <= MAX_LINE_BYTES;
}
