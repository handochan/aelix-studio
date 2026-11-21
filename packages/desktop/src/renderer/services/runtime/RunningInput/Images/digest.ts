import { Sha256 } from '@aws-crypto/sha256-js';
import type { Digest, HashProgress } from './types';

const HASH_CHUNK_BYTES = 256 * 1024;

/** Hash exactly the Blob bytes. The renderer cancels both implementations by terminating the worker. */
export async function hashImage(
  blob: Blob,
  stage: HashProgress['stage'],
  progress: (progress: HashProgress) => void,
  forceJs = false
): Promise<Digest> {
  const started = performance.now();
  const report = (loaded: number) => progress({ stage, loaded, total: blob.size });
  const subtle = forceJs ? undefined : globalThis.crypto?.subtle;
  report(0);
  let digest: Uint8Array;
  if (subtle) {
    digest = new Uint8Array(await subtle.digest('SHA-256', await blob.arrayBuffer()));
    report(blob.size);
  } else {
    const hash = new Sha256();
    for (let offset = 0; offset < blob.size; offset += HASH_CHUNK_BYTES) {
      const end = Math.min(offset + HASH_CHUNK_BYTES, blob.size);
      // eslint-disable-next-line no-await-in-loop -- hash ordered chunks with bounded memory and progress
      hash.update(new Uint8Array(await blob.slice(offset, end).arrayBuffer()));
      report(end);
    }
    digest = hash.digestSync();
  }
  return {
    sha256: Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join(''),
    elapsedMs: performance.now() - started,
    algorithm: subtle ? 'web-crypto' : 'js',
  };
}
