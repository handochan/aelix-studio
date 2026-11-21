import { fetchFromDesktopOrBrowser } from '@/common/adapter/desktopBackendFetch';
import { httpRequest, resolveCoreCsrfToken } from '@/common/adapter/httpBridge';
import type { ChatFileRef } from '@/common/types/chatFile';
import { uploadFileViaHttp } from '@renderer/services/FileService';
import { buildFileStreamUrl } from '@renderer/utils/file/fileUrls';
import { ImagePreparationError, MAX_SOURCE_BYTES, NETWORK_IDLE_MS, type ImageProgress } from './types';

type Report = (progress: ImageProgress) => void;

async function withNetworkDeadline<T>(
  lifetime: AbortSignal,
  initial: ImageProgress,
  report: Report,
  operation: (signal: AbortSignal, advance: Report) => Promise<T>
): Promise<T> {
  const controller = new AbortController();
  const signal = AbortSignal.any([lifetime, controller.signal]);
  let timer: ReturnType<typeof setTimeout>;
  let previous: ImageProgress | undefined;
  const advance: Report = (progress) => {
    if (previous?.stage !== progress.stage || progress.loaded > previous.loaded) {
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort(new ImagePreparationError('network-idle')), NETWORK_IDLE_MS);
      previous = progress;
      report(progress);
    }
    signal.throwIfAborted();
  };
  try {
    advance(initial);
    const value = await operation(signal, advance);
    signal.throwIfAborted();
    return value;
  } catch (error) {
    signal.throwIfAborted();
    throw error;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

type Metadata = { size: number; path: string; last_modified: number; is_directory?: boolean };

async function metadata(ref: ChatFileRef, lifetime: AbortSignal, report: Report): Promise<Metadata> {
  return withNetworkDeadline(lifetime, { stage: 'metadata', loaded: 0 }, report, async (signal) => {
    const csrf = resolveCoreCsrfToken();
    const result = await httpRequest<Metadata>(
      'POST',
      '/api/fs/content/metadata',
      { file: ref },
      {
        omitDiagnostics: true,
        refreshAuth: false,
        signal,
        headers: csrf ? { 'x-csrf-token': csrf } : undefined,
      }
    );
    if (
      !result ||
      !result.path ||
      result.is_directory ||
      !Number.isSafeInteger(result.size) ||
      result.size <= 0 ||
      !Number.isFinite(result.last_modified)
    ) {
      throw new ImagePreparationError('source-unavailable');
    }
    if (result.size > MAX_SOURCE_BYTES) throw new ImagePreparationError('source-too-large');
    return result;
  });
}

/** Read only an existing typed reference via the authenticated file API. */
export async function readReferencedImage(ref: ChatFileRef, signal: AbortSignal, report: Report): Promise<Blob> {
  try {
    const before = await metadata(ref, signal, report);
    const blob = await withNetworkDeadline(
      signal,
      { stage: 'download-response', loaded: 0, total: before.size },
      report,
      async (downloadSignal, advance) => {
        const response = await fetchFromDesktopOrBrowser(buildFileStreamUrl(ref), {
          credentials: 'same-origin',
          cache: 'no-store',
          redirect: 'error',
          signal: downloadSignal,
        });
        if (response.status !== 200 || !response.body) throw new ImagePreparationError('source-unavailable');
        const claimedSize = response.headers.get('content-length');
        if (claimedSize !== null && Number(claimedSize) !== before.size)
          throw new ImagePreparationError('source-changed');
        advance({ stage: 'download', loaded: 0, total: before.size });
        const reader = response.body.getReader();
        // Allocate once using checked metadata. Never retain arbitrarily many small stream chunks.
        const bytes = new Uint8Array(before.size);
        let offset = 0;
        try {
          for (;;) {
            // eslint-disable-next-line no-await-in-loop -- streams deliver ordered chunks
            const { done, value } = await reader.read();
            if (done) break;
            if (offset + value.length > MAX_SOURCE_BYTES) throw new ImagePreparationError('source-too-large');
            if (offset + value.length > before.size) throw new ImagePreparationError('source-changed');
            bytes.set(value, offset);
            offset += value.length;
            advance({ stage: 'download', loaded: offset, total: before.size });
          }
        } finally {
          reader.releaseLock();
        }
        if (offset !== before.size) throw new ImagePreparationError('source-changed');
        return new Blob([bytes]);
      }
    );
    const after = await metadata(ref, signal, report);
    if (before.path !== after.path || before.size !== after.size || before.last_modified !== after.last_modified) {
      throw new ImagePreparationError('source-changed');
    }
    return blob;
  } catch (error) {
    if (error instanceof ImagePreparationError) throw error;
    signal.throwIfAborted();
    throw new ImagePreparationError('source-unavailable');
  }
}

/** Use the normal conversation-bound multipart route once. An ambiguous response is terminal for this preparation. */
export async function uploadPreparedImage(
  output: Blob,
  conversationId: string,
  signal: AbortSignal,
  report: Report
): Promise<Extract<ChatFileRef, { kind: 'upload' }>> {
  const random = crypto.getRandomValues(new Uint8Array(16));
  const name = Array.from(random, (byte) => byte.toString(16).padStart(2, '0')).join('');
  const file = new File([output], name + (output.type === 'image/jpeg' ? '.jpg' : '.png'), { type: output.type });
  try {
    const path = await withNetworkDeadline(signal, { stage: 'upload', loaded: 0 }, report, (uploadSignal, advance) =>
      uploadFileViaHttp(file, conversationId, undefined, undefined, {
        signal: uploadSignal,
        csrf: true,
        onTransfer: (stage, loaded, total) => {
          if (!uploadSignal.aborted) advance({ stage, loaded, total });
        },
      })
    );
    return { kind: 'upload', path };
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof ImagePreparationError) throw error;
    throw new ImagePreparationError('upload-outcome-unknown');
  }
}
