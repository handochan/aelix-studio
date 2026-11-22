import type { PreparedImage } from './Images';
import type { RunningImageDetails, RunningInputReceipt, RunningInputTarget } from './types';

/** Own thumbnail URLs by transmitted digest and keep access scoped to each queued receipt. */
export function createRunningImagePreviews() {
  const entries = new Map<string, string>();
  const owners = new Map<string, RunningInputTarget & { digests: readonly string[] }>();

  return {
    retain(target: RunningInputTarget, requestId: string, images: readonly PreparedImage[]): void {
      const digests = [];
      for (const { sent, preview } of images) {
        const digest = sent.digest.sha256;
        if (preview.kind !== 'thumbnail' || preview.value.forSha256 !== digest) continue;
        if (!entries.has(digest)) {
          try {
            entries.set(digest, URL.createObjectURL(preview.value.blob));
          } catch {
            continue; // The UI renders the icon and the transmitted dimensions.
          }
        }
        digests.push(digest);
      }
      if (digests.length) owners.set(requestId, { ...target, digests });
    },

    read(receipt: RunningInputReceipt, digest: string): string | undefined {
      const owner = owners.get(receipt.requestId);
      if (
        receipt.status === 'queued' &&
        owner?.bindingId === receipt.bindingId &&
        owner.turnId === receipt.turnId &&
        owner.digests.includes(digest)
      )
        return entries.get(digest);
      return undefined;
    },

    prune(receipts: readonly RunningInputReceipt[]): void {
      const retained = new Set(
        receipts.filter(({ status }) => status !== 'rejected').map(({ requestId }) => requestId)
      );
      for (const requestId of owners.keys()) {
        if (!retained.has(requestId)) owners.delete(requestId);
      }
      const digests = new Set(Array.from(owners.values()).flatMap((owner) => owner.digests));
      for (const [digest, url] of entries) {
        if (digests.has(digest)) continue;
        URL.revokeObjectURL(url);
        entries.delete(digest);
      }
    },
  };
}

/** Copy only display metadata into the receipt. URLs, blobs, grants and refs stay out of state. */
export function describeRunningImages(images: readonly PreparedImage[]): readonly RunningImageDetails[] {
  return images.map(({ original, sent, changed, orientationOnly }) => ({
    original: { width: original.width, height: original.height, bytes: original.bytes },
    sent: { width: sent.width, height: sent.height, bytes: sent.bytes, sha256: sent.digest.sha256 },
    downscaled: changed && !orientationOnly,
    orientationOnly,
  }));
}
